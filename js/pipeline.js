/* 图片 → "一笔一笔平涂" 的绘制脚本管线（纯 JS，无 DOM 依赖，可在 Worker / Node 里跑）
 *
 * 流程：
 *   颜色量化 → 连通分区 → 碎块吸收 → 分区笔刷（每笔一个纯色，可按段取局部色）
 *   → 深色细线（线稿）走骨架笔画 → 残差补笔修复（允许覆盖，越补越准）
 *
 * 输出的每一笔：rib 走廊多边形 + tp 笔尖轨迹 + 纯色 color + 裁剪组 c。
 */
(function (root) {
  'use strict';

  // 由 run() 从 opts 灌进来的开关（画笔形的工具函数在 run 外面，拿不到 opts）
  let CAPFIX = true;              // ribbonProf 两端圆头扫正前方（老代码扫侧后方 = 端头缺半个圆 + 啃笔身）
  let PROF_FLAT_SAMPLE = true;    // 细长层取色用"平头"变宽笔形（与 ribbon 的 noCap 一致）

  // ---------------- 基础工具 ----------------
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function luma(c) { return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]; }

  // 确定性伪随机：同一张图每次生成的手抖/弧度/宽窄完全一致（便于复现与测试）
  function rand01(a, b) {
    const x = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
    return x - Math.floor(x);
  }

  // 就近串联（贪心最近邻）：让笔画顺序"手走到哪画到哪"，而不是满画布乱跳
  function chainNN(items, posOf, sx, sy) {
    const n = items.length;
    const out = new Array(n);
    // 位置先算一次摊平存起来：原来在内层循环里每次调用 posOf（每次返回一个新数组），
    // 补笔一轮几千个补丁时这里就是最大的热点
    const xs = new Float64Array(n), ys = new Float64Array(n);
    for (let i = 0; i < n; i++) { const p = posOf(items[i]); xs[i] = p[0]; ys[i] = p[1]; }
    // 点数太多时不做"全对"最近邻（O(n²)），直接按行列扫——回放观感一样（笔尖都在这片地方点点）
    if (n > 64) {
      const idx = Array.from({ length: n }, (_, i) => i);
      idx.sort((a, b) => ys[a] - ys[b] || xs[a] - xs[b]);
      for (let k = 0; k < n; k++) out[k] = items[idx[k]];
      return out;
    }
    const used = new Uint8Array(n);
    let cx = sx, cy = sy;
    for (let k = 0; k < n; k++) {
      let best = -1, bd = Infinity;
      for (let i = 0; i < n; i++) {
        if (used[i]) continue;
        const dx = xs[i] - cx, dy = ys[i] - cy;
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = i; }
      }
      used[best] = 1;
      out[k] = items[best];
      cx = xs[best]; cy = ys[best];
    }
    return out;
  }

  // 希尔伯特曲线序号：把二维位置映射成一维，按它排序 ⇒ "序列上相邻"就是"画面上相邻"。
  // 补笔的几百上千个补丁笔如果按 (y,x) 排，同一个 y 带里 x 可以横跨整幅，笔尖就会来回横扫
  // （实测笔间移动 308 万 px、≥200px 跳 5668 次）；沿希尔伯特序走，笔尖是一片一片挪过去的。
  function hilbertIndex(x, y, bits) {
    const n = 1 << bits;
    let xx = Math.min(n - 1, Math.max(0, x | 0));
    let yy = Math.min(n - 1, Math.max(0, y | 0));
    let d = 0;
    for (let s2 = n >> 1; s2 > 0; s2 >>= 1) {
      const rx = (xx & s2) > 0 ? 1 : 0;
      const ry = (yy & s2) > 0 ? 1 : 0;
      d += s2 * s2 * ((3 * rx) ^ ry);
      if (ry === 0) {
        if (rx === 1) { xx = n - 1 - xx; yy = n - 1 - yy; }
        const t = xx; xx = yy; yy = t;
      }
    }
    return d;
  }

  // sRGB(0..255) → Lab
  // f 提到外面：原来它在函数里，每次调用都要新建一个闭包（全图百万像素 = 百万个闭包）
  const LABF = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  // 热循环用这个版本：结果写进调用方的 out，不返回新数组（少一次分配/像素）
  function srgb2labInto(r, g, b, out) {
    r /= 255; g /= 255; b /= 255;
    r = r > 0.04045 ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
    g = g > 0.04045 ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
    b = b > 0.04045 ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;
    let X = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
    let Y = (r * 0.2126 + g * 0.7152 + b * 0.0722);
    let Z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
    X = LABF(X); Y = LABF(Y); Z = LABF(Z);
    out[0] = 116 * Y - 16; out[1] = 500 * (X - Y); out[2] = 200 * (Y - Z);
    return out;
  }
  function srgb2lab(r, g, b) {
    return srgb2labInto(r, g, b, [0, 0, 0]);
  }

  // ---------------- 多边形扫描线填充（偶奇），写入 bbox 局部掩膜 ----------------
  // 从包围盒外洪泛，把所有到不了外部的空区视为当前色块内部孔洞并填满。
  // 这比“挑一个轮廓再 fillPoly”稳定：复杂轮廓/自交不会漏掉整块内部区域。
  function fillEnclosedHoles(src, w, h) {
    const out = new Uint8Array(w * h);
    if (!w || !h) return out;
    const outside = new Uint8Array(w * h);
    const q = new Int32Array(w * h);
    let head = 0, tail = 0;
    const push = (x, y) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = y * w + x;
      if (outside[i] || src[i]) return;
      outside[i] = 1; q[tail++] = i;
    };
    for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
    for (let y = 1; y + 1 < h; y++) { push(0, y); push(w - 1, y); }
    while (head < tail) {
      const i = q[head++], x = i % w, y = (i - x) / w;
      push(x - 1, y); push(x + 1, y); push(x, y - 1); push(x, y + 1);
    }
    for (let i = 0; i < out.length; i++) if (!outside[i]) out[i] = 1;
    return out;
  }

  function fillPoly(mask, mw, mh, pts) {
    const n = pts.length >> 1;
    if (n < 3) return;
    let ymin = Infinity, ymax = -Infinity;
    for (let i = 0; i < n; i++) {
      const y = pts[i * 2 + 1];
      if (y < ymin) ymin = y; if (y > ymax) ymax = y;
    }
    ymin = Math.max(0, Math.floor(ymin)); ymax = Math.min(mh - 1, Math.ceil(ymax));
    const xs = new Float64Array(n + 1);
    for (let y = ymin; y <= ymax; y++) {
      const yc = y + 0.5;
      let m = 0;
      for (let i = 0; i < n; i++) {
        const x0 = pts[i * 2], yy0 = pts[i * 2 + 1];
        const j = (i + 1) % n;
        const x1 = pts[j * 2], yy1 = pts[j * 2 + 1];
        if ((yy0 <= yc && yy1 > yc) || (yy1 <= yc && yy0 > yc)) {
          xs[m++] = x0 + (yc - yy0) / (yy1 - yy0) * (x1 - x0);
        }
      }
      if (m < 2) continue;
      const arr = xs.subarray(0, m);
      arr.sort();
      for (let k = 0; k + 1 < m; k += 2) {
        let xa = Math.ceil(arr[k] - 0.5), xb = Math.floor(arr[k + 1] - 0.5);
        if (xb < 0 || xa >= mw) continue;
        if (xa < 0) xa = 0; if (xb >= mw) xb = mw - 1;
        const row = y * mw;
        for (let x = xa; x <= xb; x++) mask[row + x] = 1;
      }
    }
  }

  // ---------------- 覆盖率光栅（非零环绕 + 亚扫描线 + x 向精确积分） ----------------
  // 网页端画的是"画布多边形（抗锯齿）∩ 1 位遮罩"：一个像素只被笔形斜斜擦过 20%，
  // 网页端看起来还是半白的。管线要用同一口径判断"这一笔画上了没有"——否则会出现
  // "管线以为画上了、网页端仍是白点"的错配（光栅用偶奇二值就漏掉这一类）。
  // 返回每个像素被盖住的比例 0..1（累加写进 out，调用方负责清零）。
  function fillPolyCov(out, mw, mh, pts, subY) {
    const n = pts.length >> 1;
    if (n < 3) return;
    let ymin = Infinity, ymax = -Infinity;
    for (let i = 0; i < n; i++) {
      const y = pts[i * 2 + 1];
      if (y < ymin) ymin = y; if (y > ymax) ymax = y;
    }
    ymin = Math.max(0, Math.floor(ymin)); ymax = Math.min(mh - 1, Math.ceil(ymax));
    const S = subY || 2;
    const wgt = 1 / S;
    const xs = new Float64Array(n + 1), dr = new Int8Array(n + 1), sub = new Int32Array(n + 1);
    for (let y = ymin; y <= ymax; y++) {
      const row = y * mw;
      for (let sy = 0; sy < S; sy++) {
        const yc = y + (sy + 0.5) / S;
        let m = 0;
        for (let i = 0; i < n; i++) {
          const x0 = pts[i * 2], yy0 = pts[i * 2 + 1];
          const j = (i + 1) % n;
          const x1 = pts[j * 2], yy1 = pts[j * 2 + 1];
          if ((yy0 <= yc && yy1 > yc) || (yy1 <= yc && yy0 > yc)) {
            xs[m] = x0 + (yc - yy0) / (yy1 - yy0) * (x1 - x0);
            dr[m] = yy1 > yy0 ? 1 : -1;
            m++;
          }
        }
        if (m < 2) continue;
        if (m === 2) {                       // 常见情形（扫描线只穿两条边）：连排序都省了
          if (xs[0] > xs[1]) {
            const tx = xs[0]; xs[0] = xs[1]; xs[1] = tx;
            const td = dr[0]; dr[0] = dr[1]; dr[1] = td;
          }
          sub[0] = 0; sub[1] = 1;
        } else {                             // 行内交点很少：插入排序，比 slice+sort 省掉每行一次的分配
          for (let k = 0; k < m; k++) {
            const v = xs[k];
            let j2 = k - 1;
            while (j2 >= 0 && xs[sub[j2]] > v) { sub[j2 + 1] = sub[j2]; j2--; }
            sub[j2 + 1] = k;
          }
        }
        let wind = 0, startX = 0;
        for (let k = 0; k < m; k++) {
          const kk = sub[k];
          const prev = wind;
          wind += dr[kk];
          if (prev === 0 && wind !== 0) startX = xs[kk];
          else if (prev !== 0 && wind === 0) {
            let xa = startX, xb = xs[kk];
            if (xb <= 0 || xa >= mw) continue;
            if (xa < 0) xa = 0;
            if (xb > mw) xb = mw;
            const ia = Math.floor(xa), ib = Math.floor(xb);
            if (ia === ib) { out[row + ia] += (xb - xa) * wgt; continue; }
            out[row + ia] += (ia + 1 - xa) * wgt;
            for (let x = ia + 1; x < ib; x++) out[row + x] += wgt;
            if (ib < mw) out[row + ib] += (xb - ib) * wgt;
          }
        }
      }
    }
  }

  // ---------------- 距离变换（3×4 chamfer，近似欧氏） ----------------
  function distanceTransform(bin, w, h) {
    const INF = 1e9;
    const d = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) d[i] = bin[i] ? INF : 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (d[i] === 0) continue;
        let v = d[i];
        if (x > 0) v = Math.min(v, d[i - 1] + 3);
        if (y > 0) v = Math.min(v, d[i - w] + 3);
        if (x > 0 && y > 0) v = Math.min(v, d[i - w - 1] + 4);
        if (x + 1 < w && y > 0) v = Math.min(v, d[i - w + 1] + 4);
        d[i] = v;
      }
    }
    for (let y = h - 1; y >= 0; y--) {
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        if (d[i] === 0) continue;
        let v = d[i];
        if (x + 1 < w) v = Math.min(v, d[i + 1] + 3);
        if (y + 1 < h) v = Math.min(v, d[i + w] + 3);
        if (x + 1 < w && y + 1 < h) v = Math.min(v, d[i + w + 1] + 4);
        if (x > 0 && y + 1 < h) v = Math.min(v, d[i + w - 1] + 4);
        d[i] = v;
      }
    }
    for (let i = 0; i < w * h; i++) d[i] /= 3;
    return d;
  }

  // ---------------- 形态学：膨胀（方形核） ----------------
  function dilate(bin, w, h, r) {
    if (r <= 0) return bin.slice();
    // 行列两次一维膨胀（方形核）
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let v = 0;
        for (let k = -r; k <= r && !v; k++) {
          const xx = x + k;
          if (xx >= 0 && xx < w && bin[row + xx]) v = 1;
        }
        tmp[row + x] = v;
      }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let v = 0;
        for (let k = -r; k <= r && !v; k++) {
          const yy = y + k;
          if (yy >= 0 && yy < h && tmp[yy * w + x]) v = 1;
        }
        out[y * w + x] = v;
      }
    }
    return out;
  }

  // ---------------- 腐蚀（膨胀的对偶） ----------------
  function erode(bin, w, h, r) {
    const inv = new Uint8Array(w * h);
    for (let i = 0; i < inv.length; i++) inv[i] = bin[i] ? 0 : 1;
    const d = dilate(inv, w, h, r);
    const out = new Uint8Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = d[i] ? 0 : 1;
    return out;
  }

  // ---------------- 折线简化（RDP）：把"几乎笔直"的中轴拉成真正的直线 ----------------
  // 细线的中轴是一像素一像素拐出来的，直接描出来就是坑坑洼洼的（飞机支柱、字母描边）。
  function rdpSimplify(pts, n, tol) {
    if (n < 3) return { pts: Float64Array.from(pts.slice(0, n * 2)), n };
    const keep = new Uint8Array(n);
    keep[0] = 1; keep[n - 1] = 1;
    const stack = [[0, n - 1]];
    const tol2 = tol * tol;
    while (stack.length) {
      const seg = stack.pop();
      const a = seg[0], b = seg[1];
      if (b - a < 2) continue;
      const ax = pts[a * 2], ay = pts[a * 2 + 1];
      const dx = pts[b * 2] - ax, dy = pts[b * 2 + 1] - ay;
      const L2 = dx * dx + dy * dy;
      let best = -1, bd = 0;
      for (let i = a + 1; i < b; i++) {
        const px = pts[i * 2], py = pts[i * 2 + 1];
        let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
        t = t < 0 ? 0 : (t > 1 ? 1 : t);
        const ex = px - (ax + dx * t), ey = py - (ay + dy * t);
        const d2 = ex * ex + ey * ey;
        if (d2 > bd) { bd = d2; best = i; }
      }
      if (bd > tol2 && best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
    }
    const o = [];
    for (let i = 0; i < n; i++) if (keep[i]) o.push(pts[i * 2], pts[i * 2 + 1]);
    return { pts: Float64Array.from(o), n: o.length >> 1 };
  }

  // ---------------- 形态学闭运算（先膨胀再腐蚀）：把"被上层盖住的缺口"接上 ----------------
  function closeMask(m, w, h, r) {
    if (r <= 0) return m.slice();
    return erode(dilate(m, w, h, r), w, h, r);
  }

  // 圆盘核闭运算（八边形近似，走距离变换）。图层"完整形状"必须用它：
  // 方形核在斜边和拐角处会推出方角小凸起，回放画到那一层时字/飞机边上就会露出
  // 几个方块"耳朵"（2026-10-18 用户点出的遗留）。同样的半径下圆盘是方形的子集，
  // 补出来的"被上层盖住的部分"更贴形状。
  function closeMaskDisk(m, w, h, r) {
    if (r <= 0) return m.slice();
    const n = w * h, R3 = 3 * r;          // 距离变换是 3-4 通道度量：正交一步 = 3
    const inv = new Uint8Array(n), dil = new Uint8Array(n), out = new Uint8Array(n);
    for (let i = 0; i < n; i++) inv[i] = m[i] ? 0 : 1;
    const dOut = distanceTransform(inv, w, h);      // 到最近"本层像素"的距离
    for (let i = 0; i < n; i++) dil[i] = dOut[i] <= R3 ? 1 : 0;
    const dIn = distanceTransform(dil, w, h);       // 到最近"膨胀后仍在外面"的距离
    for (let i = 0; i < n; i++) out[i] = dIn[i] > R3 ? 1 : 0;
    return out;
  }

  // ---------------- 连通域（给定标签图，4 连通，只保留"同标签"连通） ----------------
  function compsOfLabels(labels, W, H) {
    const compOf = new Int32Array(W * H).fill(-1);
    const pix = new Uint32Array(W * H);
    const comps = [];
    const q = new Int32Array(W * H);
    let np = 0;
    for (let s = 0; s < W * H; s++) {
      if (compOf[s] >= 0) continue;
      const lab = labels[s];
      const id = comps.length;
      let head = 0, tail = 0;
      q[tail++] = s; compOf[s] = id;
      const start = np;
      let x0 = W, y0 = H, x1 = -1, y1 = -1;
      while (head < tail) {
        const p = q[head++];
        pix[np++] = p;
        const x = p % W, y = (p - x) / W;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && compOf[p - 1] < 0 && labels[p - 1] === lab) { compOf[p - 1] = id; q[tail++] = p - 1; }
        if (x + 1 < W && compOf[p + 1] < 0 && labels[p + 1] === lab) { compOf[p + 1] = id; q[tail++] = p + 1; }
        if (y > 0 && compOf[p - W] < 0 && labels[p - W] === lab) { compOf[p - W] = id; q[tail++] = p - W; }
        if (y + 1 < H && compOf[p + W] < 0 && labels[p + W] === lab) { compOf[p + W] = id; q[tail++] = p + W; }
      }
      comps.push({ label: lab, start, count: np - start, x0, y0, x1, y1 });
    }
    return { compOf, pix, comps };
  }

  // ---------------- 细化（Zhang-Suen，4/8 连通骨架） ----------------
  // 大掩膜上很费时间（黑框的外框就是整幅），所以：① 每轮只扫"还有前景的行区间"；
  // ② A 的八邻域转折数用内联比较算（原来每个像素分配一个 9 元素数组，GC 就吃掉几十秒）。
  function thin(bin, w, h) {
    const im = bin.slice();
    const del = new Int32Array(w * h);
    let changedTotal = false;
    let ylo = 1, yhi = h - 2;
    const t0 = Date.now();
    let iters = 0, visits = 0;
    for (let iter = 0; iter < 100; iter++) {
      iters++;
      let changed = false;
      for (let step = 0; step < 2; step++) {
        let nd = 0;
        let nyLo = h, nyHi = 0;
        for (let y = ylo; y <= yhi; y++) {
          const row = y * w;
          let rowHit = 0;
          visits += w - 2;
          for (let x = 1; x < w - 1; x++) {
            const i = row + x;
            if (!im[i]) continue;
            const p2 = im[i - w], p3 = im[i - w + 1], p4 = im[i + 1], p5 = im[i + w + 1],
                  p6 = im[i + w], p7 = im[i + w - 1], p8 = im[i - 1], p9 = im[i - w - 1];
            const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
            if (B < 2 || B > 6) continue;
            const A = (p2 === 0 && p3 === 1 ? 1 : 0) + (p3 === 0 && p4 === 1 ? 1 : 0) +
                      (p4 === 0 && p5 === 1 ? 1 : 0) + (p5 === 0 && p6 === 1 ? 1 : 0) +
                      (p6 === 0 && p7 === 1 ? 1 : 0) + (p7 === 0 && p8 === 1 ? 1 : 0) +
                      (p8 === 0 && p9 === 1 ? 1 : 0) + (p9 === 0 && p2 === 1 ? 1 : 0);
            if (A !== 1) continue;
            if (step === 0) {
              if (p2 * p4 * p6 !== 0) continue;
              if (p4 * p6 * p8 !== 0) continue;
            } else {
              if (p2 * p4 * p8 !== 0) continue;
              if (p2 * p6 * p8 !== 0) continue;
            }
            del[nd++] = i;
            rowHit = 1;
          }
          if (rowHit) { if (y < nyLo) nyLo = y; if (y > nyHi) nyHi = y; }
        }
        if (nd) {
          for (let k = 0; k < nd; k++) im[del[k]] = 0;
          changed = true;
        }
        // 下一轮只需要扫"这一轮有删改的行 ±1"
        if (nyHi >= nyLo) { ylo = Math.max(1, nyLo - 1); yhi = Math.min(h - 2, nyHi + 1); }
      }
      if (changed) changedTotal = true; else break;
    }
    if (globalThis.__thinStats) {
      const g = globalThis.__thinStats;
      g.calls++; g.ms += Date.now() - t0; g.iters += iters; g.visits += visits;
      const tag = globalThis.__thinTag || '?';
      g.by = g.by || {};
      const b = g.by[tag] || (g.by[tag] = { calls: 0, ms: 0, visits: 0, iters: 0 });
      b.calls++; b.ms += Date.now() - t0; b.visits += visits; b.iters += iters;
      if (Date.now() - t0 > 300) g.big.push([w, h, iters, visits, Date.now() - t0]);
    }
    return { sk: im, changed: changedTotal };
  }

  // ---------------- 骨架最长路径（两次 BFS） ----------------
  function longestPath(sk, w, h) {
    const idx = [];
    for (let i = 0; i < w * h; i++) if (sk[i]) idx.push(i);
    if (!idx.length) return null;
    const dist = new Int32Array(w * h).fill(-1);
    const par = new Int32Array(w * h).fill(-1);
    const q = new Int32Array(idx.length);
    const bfs = (s) => {
      dist.fill(-1); par.fill(-1);
      let head = 0, tail = 0, far = s;
      q[tail++] = s; dist[s] = 0;
      while (head < tail) {
        const p = q[head++];
        const x = p % w, y = (p - x) / w;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const n = yy * w + xx;
            if (!sk[n] || dist[n] >= 0) continue;
            dist[n] = dist[p] + 1; par[n] = p;
            if (dist[n] > dist[far]) far = n;
            q[tail++] = n;
          }
        }
      }
      return far;
    };
    const a = bfs(idx[0]);
    const b = bfs(a);
    const path = [];
    let cur = b;
    while (cur >= 0) { path.push(cur); cur = par[cur]; }
    const pts = new Float64Array(path.length * 2);
    for (let i = 0; i < path.length; i++) {
      const p = path[path.length - 1 - i];
      pts[i * 2] = p % w; pts[i * 2 + 1] = (p - (p % w)) / w;
    }
    return { pts, len: path.length };
  }

  // ---------------- 走廊多边形（沿路径左右偏移） ----------------
  function ribbon(path, n, halfW, noCap) {
    // path: flat [x0,y0,...]（绝对坐标）, 返回 flat 多边形
    if (n === 1) {
      const out = [];
      for (let k = 0; k < 13; k++) {
        const a = k / 13 * Math.PI * 2;
        out.push(path[0] + halfW * Math.cos(a), path[1] + halfW * Math.sin(a));
      }
      return out;
    }
    const dir = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      // 相邻段拼接处会有重复点：直接用 (i-1,i+1) 求方向会得到 0 向量 ⇒ 那个顶点被掐细，
      // 光栅出来就是一个三角形缺口（就是"铺色中间那些白三角"的老根）。
      let a = i - 1 < 0 ? 0 : i - 1, b = i + 1 > n - 1 ? n - 1 : i + 1;
      const xi = path[i * 2], yi = path[i * 2 + 1];
      while (a > 0 && path[a * 2] === xi && path[a * 2 + 1] === yi) a--;
      while (b < n - 1 && path[b * 2] === xi && path[b * 2 + 1] === yi) b++;
      let dx = path[b * 2] - path[a * 2], dy = path[b * 2 + 1] - path[a * 2 + 1];
      if (dx === 0 && dy === 0) { dx = 1; dy = 0; }
      const ln = Math.hypot(dx, dy) || 1;
      dir[i * 2] = dx / ln; dir[i * 2 + 1] = dy / ln;
    }
    const left = [], right = [];
    for (let i = 0; i < n; i++) {
      const dx = dir[i * 2], dy = dir[i * 2 + 1];
      const nx = -dy, ny = dx;
      left.push(path[i * 2] + halfW * nx, path[i * 2 + 1] + halfW * ny);
      right.push(path[i * 2] - halfW * nx, path[i * 2 + 1] - halfW * ny);
    }
    const out = [];
    out.push(...left);
    if (noCap) {                        // 取色用的"平头"笔形：不含圆头，免得把两端的邻色平均进来
      for (let i = n - 1; i >= 0; i--) out.push(right[i * 2], right[i * 2 + 1]);
      return out;
    }
    // 末端圆头：从"左侧法线"绕过**正前方**扫到"右侧法线"（角度递减）。
    // ⚠️ 老代码是 `ea + πk/5`，扫的是**后半侧**——笔形在两端自己折回去，
    // 非零环绕在那个折角里正负相抵 ⇒ 绕数归零 ⇒ 画出来是个破洞。
    // 短笔（笔宽 > 长度）整个就是折角，"铺色中间那些白斑/白三角"的根就在这里。
    const ex = path[(n - 1) * 2], ey = path[(n - 1) * 2 + 1];
    const ea = Math.atan2(dir[(n - 1) * 2 + 1], dir[(n - 1) * 2]);
    for (let k = 1; k <= 4; k++) {
      const a = ea + Math.PI / 2 - Math.PI * k / 5;
      out.push(ex + halfW * Math.cos(a), ey + halfW * Math.sin(a));
    }
    for (let i = n - 1; i >= 0; i--) out.push(right[i * 2], right[i * 2 + 1]);
    // 起点圆头：从"右侧法线"绕过**正后方**扫到"左侧法线"
    const sa = Math.atan2(dir[1], dir[0]);
    for (let k = 1; k <= 4; k++) {
      const a = sa - Math.PI / 2 - Math.PI * k / 5;
      out.push(path[0] + halfW * Math.cos(a), path[1] + halfW * Math.sin(a));
    }
    return out;
  }

  // 变宽走廊：halfs[i] 是第 i 个点处的半宽（起笔细→中间粗→收笔细，像有笔压）
  // noCap：取色用的"平头"笔形（与 ribbon 的同名参数一致，免得把两端邻色平均进来）
  function ribbonProf(path, n, halfs, noCap) {
    if (n === 1) return ribbon(path, 1, halfs[0]);
    const dir = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      let a = i - 1 < 0 ? 0 : i - 1, b = i + 1 > n - 1 ? n - 1 : i + 1;
      const xi = path[i * 2], yi = path[i * 2 + 1];
      while (a > 0 && path[a * 2] === xi && path[a * 2 + 1] === yi) a--;
      while (b < n - 1 && path[b * 2] === xi && path[b * 2 + 1] === yi) b++;
      let dx = path[b * 2] - path[a * 2], dy = path[b * 2 + 1] - path[a * 2 + 1];
      if (dx === 0 && dy === 0) { dx = 1; dy = 0; }
      const ln = Math.hypot(dx, dy) || 1;
      dir[i * 2] = dx / ln; dir[i * 2 + 1] = dy / ln;
    }
    const left = [], right = [];
    for (let i = 0; i < n; i++) {
      const dx = dir[i * 2], dy = dir[i * 2 + 1];
      const nx = -dy, ny = dx, hw = halfs[i];
      left.push(path[i * 2] + hw * nx, path[i * 2 + 1] + hw * ny);
      right.push(path[i * 2] - hw * nx, path[i * 2 + 1] - hw * ny);
    }
    const out = [];
    out.push(...left);
    if (noCap) {                        // 取色用：不含圆头（平头），与 ribbon(path,n,halfW,true) 同式
      for (let i = n - 1; i >= 0; i--) out.push(right[i * 2], right[i * 2 + 1]);
      return out;
    }
    // 两端圆头：与 ribbon 完全同式（end 绕**正前方**、start 绕**正后方**）。
    // ⚠️ 老代码是 `ea + πk/5` / `sa - πk/5`：扫的是**侧后方**，端头前半球整块盖不住，
    // 还在笔身上啃出一个三角缺口——每一支细长层的笔两端各一个，接缝处两个缺口拼成一条
    // 带子（S 那一层 11 支笔漏 995px、飞机 16 支漏 3099px，全靠每层自检的矩形补丁兜底，
    // 回放里就是"没涂满 + 补丁乱飞"）。capFix=false 可以退回老行为做对照。
    const ex = path[(n - 1) * 2], ey = path[(n - 1) * 2 + 1], hw1 = halfs[n - 1];
    const ea = Math.atan2(dir[(n - 1) * 2 + 1], dir[(n - 1) * 2]);
    for (let k = 1; k <= 4; k++) {
      const a = CAPFIX ? ea + Math.PI / 2 - Math.PI * k / 5 : ea + Math.PI * k / 5;
      out.push(ex + hw1 * Math.cos(a), ey + hw1 * Math.sin(a));
    }
    for (let i = n - 1; i >= 0; i--) out.push(right[i * 2], right[i * 2 + 1]);
    const hw0 = halfs[0];
    const sa = Math.atan2(dir[1], dir[0]);
    for (let k = 1; k <= 4; k++) {
      const a = CAPFIX ? sa - Math.PI / 2 - Math.PI * k / 5 : sa - Math.PI * k / 5;
      out.push(path[0] + hw0 * Math.cos(a), path[1] + hw0 * Math.sin(a));
    }
    return out;
  }

  // 把同一区块来回的几档"并成一条连续走笔"：各档的走廊多边形并成一个非零环绕多边形。
  // 做法是"链式钥匙孔桥接"——每个环的入口取离上一个环入口最近的顶点（桥接边很短，就在
  // 拐弯那一头），进出各走一遍 ⇒ 环绕数相抵、桥接边不产生面积，填充结果就是各环的并集。
  // 两个坑：① 各环方向必须统一——方向相反的两环在重叠处环绕数相加会变成 0（挖洞），
  // 而同一区块相邻两档本来就重叠 38%；② 桥接只能连"相邻"的环，连到远处的锚点会在
  // 区块中间拉出一条 1.4px 的描边线（同色看不出来，但在渐变区块上会成一道痕）。
  function mergeLoops(loops) {
    const m = loops.length;
    const out = [];
    if (!m) return out;
    const rot = [];
    let sign = 0;
    for (let i = 0; i < m; i++) {
      const L = loops[i];
      const n = L.length >> 1;
      if (n < 3) continue;
      let a2 = 0;
      for (let k = 0; k < n; k++) {
        const j = (k + 1) % n;
        a2 += L[k * 2] * L[j * 2 + 1] - L[j * 2] * L[k * 2 + 1];
      }
      const s = a2 >= 0 ? 1 : -1;
      if (!sign) sign = s;
      const flip = s !== sign;
      const arr = new Float64Array(n * 2);
      for (let k = 0; k < n; k++) {
        const src = (flip ? n - 1 - k : k) * 2;
        arr[k * 2] = L[src]; arr[k * 2 + 1] = L[src + 1];
      }
      rot.push(arr);
    }
    if (!rot.length) return out;
    // 每个环的入口顶点 = 离上一个环入口最近的那个（把顶点数组旋转到从它开始）
    for (let i = 1; i < rot.length; i++) {
      const L = rot[i], n = L.length >> 1;
      const px = rot[i - 1][0], py = rot[i - 1][1];
      let bj = 0, bd = Infinity;
      for (let j = 0; j < n; j++) {
        const d = (L[j * 2] - px) * (L[j * 2] - px) + (L[j * 2 + 1] - py) * (L[j * 2 + 1] - py);
        if (d < bd) { bd = d; bj = j; }
      }
      if (bj) {
        const r = new Float64Array(n * 2);
        for (let j = 0; j < n; j++) {
          const k = (j + bj) % n;
          r[j * 2] = L[k * 2]; r[j * 2 + 1] = L[k * 2 + 1];
        }
        rot[i] = r;
      }
    }
    for (let i = 0; i < rot.length; i++) {
      const L = rot[i];
      if (i) out.push(L[0], L[1]);            // 桥入：上一个环的入口 → 本环入口
      for (let k = 0; k < L.length; k++) out.push(L[k]);
      out.push(L[0], L[1]);                   // 显式闭合本环
    }
    for (let i = rot.length - 2; i >= 0; i--) out.push(rot[i][0], rot[i][1]);   // 逐级桥回（与桥入正反相抵）
    return out;
  }

  // ---------------- 轻度平滑（仅用于分块：median3 + 两次 box3） ----------------
  function med3(src, w, h) {
    const out = new Uint8Array(src.length);
    const win = new Uint8Array(9);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          const row = yy * w;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            win[n++] = src[row + xx];
          }
        }
        // 9 元以内插入排序
        for (let i = 1; i < n; i++) {
          const v = win[i];
          let j = i - 1;
          while (j >= 0 && win[j] > v) { win[j + 1] = win[j]; j--; }
          win[j + 1] = v;
        }
        out[y * w + x] = win[n >> 1];
      }
    }
    return out;
  }

  function box3(src, w, h) {
    const out = new Uint8Array(src.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let acc = 0, cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          const row = yy * w;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            acc += src[row + xx]; cnt++;
          }
        }
        out[y * w + x] = (acc / cnt + 0.5) | 0;
      }
    }
    return out;
  }

  // ---------------- 1px 柔边（3×3 二项核，模拟画笔落笔边缘） ----------------
  function feather(m, w, h) {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          const wy = dy === 0 ? 2 : 1;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            if (m[yy * w + xx]) acc += wy * (dx === 0 ? 2 : 1);
          }
        }
        out[y * w + x] = acc / 16;
      }
    }
    return out;
  }

  // ---------------- k-means（Lab 空间） ----------------
  function kmeans(samples, K, iters, seed) {
    let s = seed >>> 0;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    const n = samples.length / 3;
    const cen = new Float64Array(K * 3);
    for (let k = 0; k < K; k++) {
      const i = Math.floor(rnd() * n) * 3;
      cen[k * 3] = samples[i]; cen[k * 3 + 1] = samples[i + 1]; cen[k * 3 + 2] = samples[i + 2];
    }
    const asg = new Int32Array(n);
    for (let it = 0; it < iters; it++) {
      let moved = 0;
      for (let i = 0, i3 = 0; i < n; i++, i3 += 3) {
        const L = samples[i3], A = samples[i3 + 1], B = samples[i3 + 2];
        let best = 0, bd = Infinity;
        for (let k = 0, k3 = 0; k < K; k++, k3 += 3) {
          const dL = L - cen[k3], dA = A - cen[k3 + 1], dB = B - cen[k3 + 2];
          const d = dL * dL + dA * dA + dB * dB;
          if (d < bd) { bd = d; best = k; }
        }
        if (asg[i] !== best) { asg[i] = best; moved++; }
      }
      const sum = new Float64Array(K * 3), cnt = new Int32Array(K);
      for (let i = 0; i < n; i++) {
        const k = asg[i];
        sum[k * 3] += samples[i * 3]; sum[k * 3 + 1] += samples[i * 3 + 1]; sum[k * 3 + 2] += samples[i * 3 + 2];
        cnt[k]++;
      }
      for (let k = 0; k < K; k++) {
        if (cnt[k] >= 4) {
          cen[k * 3] = sum[k * 3] / cnt[k];
          cen[k * 3 + 1] = sum[k * 3 + 1] / cnt[k];
          cen[k * 3 + 2] = sum[k * 3 + 2] / cnt[k];
        }
      }
      if (moved < n * 0.001) break;
    }
    return { cen, asg };
  }

  // ---------------- 主流程 ----------------
  const CFG = {
    // --- 图层栈（一个对象 = 一层）---
    objMergeCd: 70,         // 相邻且颜色差 < 它 ⇒ 同一层（蓝底的多条色带、黑框的四条边并成一整层）
    lineTol: 0.9,           // 细线中轴的拉直容差（像素）：直线段必须一笔到底、笔直
    layerCheck: true,       // 每一层刷完当场自检（不只底色层）：这一层自己有没有漏
    sweepSeal: true,        // 铺色"一次过"：落笔前先算这一层所有档的联合覆盖，缝就地加宽（不新增笔画）
    sealIter: 3,            // 加宽最多迭代几轮
    sealMin: 1200,          // 层外框小于它就不做（小层的缝交给每层自检，成本更省）
    lineSeal: true,         // 细长层同样"一次过"：中轴笔形没盖到的凸起就地加宽（不新增笔画）
    capFix: true,           // ribbonProf 端头扫正前方（见文件头 CAPFIX 注释）
    thinNoErode: true,      // 细长层取色不缩边（否则整层一个均值色，边界那圈刷平）
    rimPass: true,          // 每层画完，把自己那圈 1~2px 边界用**局部色**补一遍（治"边不像"）
    rimLinearOnly: true,    // 只对细长层做（大块平涂层的边由残差收拾，做了会多出几千笔）
    bleedOrder: true,       // 出界笔只许压在"已经画过"的对象上（否则那圈颜色留在别人身上）
    profFlatSample: true,   // 细长层取色用平头变宽笔形
    occlude: true,
  objGrowF: 0.55,      // 图层"完整形状"往外补的系数（见 closeMaskDisk 的注释；0.8 会伸出圆头小凸起）          // 每层补出"被上层盖住的部分"（形状闭合推断）；照片类纹理太碎时关掉更干净
    colorPass: true,        // 同色合并成"一趟"：互不遮挡的层之间顺序自由，优先挑"跟上一笔同色、
                            // 且离笔尖近"的那层——同一支笔一路把同色的东西画完（原来是按面积大小排，
                            // 笔尖在整幅上按"大块→小块"来回跳，一个字一层）
    colorPassTol: 36,       // "算同色"的色差上限（曼哈顿，约 12/通道）
    colorPassArea: 4,       // 同色还不够：面积也要在同一个量级（大/小之比 ≤ 它）才并进这一趟。
                            // 否则"整片蓝底"会把画面另一头的零星蓝点拉进同一趟，笔尖满屏飞
                            // （实测这一条同时把残差补笔的落点扰动压小）
    edgeSnap: false,        // 边界按颜色重判（**默认关**）：三张示例实测它净亏——照片可见差异
                            // 3.07% → 2.57%、AIR MAIL 5.23% → 2.46%，只有海报整幅靠"把背景纸纹
                            // 噪点刷成蓝底"赚回 0.1 个点。它当初是在替"调色板太小"擦屁股
                            // （色数提上去之后同样的问题不再出现），而它会把真的细描边啃掉一圈。
    edgeSnapTol: 6,         // 重判的容差（曼哈顿）：比本侧更近这么多才改判
    edgeSnapIter: 3,        // 重判最多剥几层（扫描件的过渡带可能有 2~3px 宽）
    edgeSnapBad: 40,        // 只修"真正的错分"：自己的区色离原图色 ≥ 它（曼哈顿）才允许改判。
                            // 抗锯齿过渡带的区色本来就是混色、已经贴近原图（实测海报上这类像素
                            // 有 1500+ 个），推成纯色反而把字的边推错——文字区可见差异 2.46% → 5.23%
    edgeSnapRatio: 0.62,    // 相对门槛：邻居的色距必须 ≤ 本侧的 62% 才改判（0 = 关，回到纯绝对容差）。
                            // 描边外缘那圈"深色/混色"像素离两侧都远，绝对距离常常"蓝底更近"⇒
                            // 判走之后红描边就被啃掉一圈（实测 AIR MAIL 里 2200 像素被翻）
    edgeSnapBand: 2,        // 边界带膨胀半径（越大越慢；3 会把更多过渡像素拉进重判）
    edgeRamp: true,         // 抗锯齿过渡带按两侧颜色并进去（不让它自己成层被涂成灰条）
    edgeRampR: 4,           // 过渡带判据的搜索半径（像素）
    maskMajority: 5,        // 掩膜边界去锯齿的窗口（5 = 5x5 多数表决；0 = 关）：
                            // 照片类靠它把边缘的锯齿抹平（可见差异 17.5% → 16.9%），海报类只改百来个像素
    maskMajThr: 17,         // 压倒性多数的门槛（25 格里的格数；越大越保守）
    maxSide: 1024,
    colors: 32,
    mergeThr: 9.0,          // Lab 距离，小于它合并（对渐变友好）
    minArea: 120,           // 小于它的小碎块并入邻块（越小分区越细，笔数越多）
    targetSec: 240,         // 回放总时长（1× 速度）
    bleedFirst: 0,          // 每个区块第一遍"铺底"允许外扩的像素（0 = 严格裁形，保真优先）
    resThick: 30,           // 补笔忽略"又大又厚"的错误块（那是平涂风格本身的平滑差异）。
                            // 门槛是**真实厚度**（2×最大内切半径，见 compThick）：8 的时候
                            // 连字母/飞机那圈深色描边（真厚 8~14px）都被当"大片"跳过，
                            // 边就一直差着；30 之后海报可见差异 2.01%→1.45%、明显误差 0.35%→0.04%。
    inkLuma: 195,
    coverOk: 0.86,
    residual: [30, 24, 18, 14, 11, 9, 7],
    absorbCd: 60,           // 碎块并入邻块的颜色阈值（Lab/RGB 距离）
    texMax: 1500,           // "纹理块"面积上限：小于它 + 弱对比 ⇒ 判为纸纹/噪点，并进邻块且不画
    texCd: 130,             // "纹理块"的对比上限（调色板距离）：超过它才当"真特征"保留
    inkMinCd: 100,          // 细线要画的对比下限：比它弱的"线"其实是纹理，不写
    resHalfA: 0.95, resHalfB: 0.7, resMin: 1.0,   // 补笔半宽 = dmed*A + B
    resSplit: 18,           // 补丁按颜色二分的停止阈值（越小补得越准、补丁越多）
    resPatchMax: 128,       // 小于这么多像素的错误块直接并进补丁笔（不走骨架笔）：
                            // 补丁笔的掩膜是 1 位硬遮罩、口径比骨架笔更准，而且能合并——实测比走骨架笔
                            // 笔数少 27%、可见差异还更低
    maxStrokes: 26000,      // 排定轮次的笔数上限（照片类纹理太碎时保护；尾巴轮另有倍数上限）
    returnKeys: true,       // 生成关键帧（网页端拖动进度用）
    keyFrames: 5,
    resStop: 0,             // 补笔收益阈值（0 = 不提前收手，把 7 轮补完）
    resTail: 20,            // 排定轮次之后的"自适应续补"轮数（按当前阈值一路补到收敛）
                            // 老版本是被固定档位+预算砍掉的：海报停在 20%、照片停在 29%，其实都没收敛
    resTailStep: 0.6,       // 续补每轮把阈值再降多少
    resTailMin: 3,          // 续补的阈值下限（再细下去补的是平涂风格本身，没意义）
    resTailStop: 0.25,      // 续补收益（可见差异百分点）低于它就收手
    resTailMax: 3,          // 续补最多把笔数预算用到排定轮的几倍
    exactRepair: 0,         // 最后一公里：全图精修的目标（每像素最大通道差；0 = 关）。
                            // 残差补笔每轮最多 6000 个补丁、收益一掉就收手，全图总有约 1% 的像素
                            // 停在"肉眼看得出来"的误差上；这一轮把剩下的错像素一次补到阈值以内。
    exactRepairCell: 128,   // 精修聚合格子（像素）：同格同色阶的错像素并成一条掩膜笔
    exactRepairShift: 1,    // 精修颜色桶位移（1 = 每通道 2 级）：越大笔越少、补完的色差越大
    exactRepairMax: 300000, // 精修最多撒多少个补丁（按组内最大误差从大到小，先补最刺眼的）
    localColor: true,       // 主笔触按段取局部纯色（更贴近原图渐变）
    segF: 3,                // 取色分段长 = 笔半宽 × 它（越小越贴局部色，笔数越多）
    segMin: 30,             // 取色分段长下限（像素）
    segJoinCd: 8,           // 相邻两段颜色差 < 它就连成一笔（曼哈顿）：越大笔越省、但会把渐变抹平
                            // 实测 42（≈14/通道）会把长笔跨过的渐变抹平——海报平坦区因此留下 ±8 的误差，
                            // 收到 8（≈3/通道）后主笔多 60%，可见差异直接降 5 个百分点
    dilMain: 3,             // 主笔允许溢出 3px（自然覆盖，后画的会盖住）
    dilInk: 0,              // 勾线层不向外扩边：它现在画在铺色之后，扩边会留下压不回去的深色描边
    // --- "像人在画"的相关参数 ---
    sketch: false,          // 起稿（默认关）：勾出来的灰线随即被铺色盖掉，对成品零贡献，
                            // 回放开头却是一段"乱线"——用户 2026-10-18 拍板删掉；要打形观感再打开
    sketchMax: 56,          // 起稿最多勾多少条轮廓
    sketchHalf: 1.5,        // 起稿线半宽（乘 strokeScale）
    sketchMix: 0.45,        // 起稿色 = 局部目标色 与 铅笔灰 的混合比例
    layerSketch: true,      // cover 模式"一层 = 先勾形再铺满"：每层铺色前先沿本层轮廓铅笔灰轻勾
                            // 一笔、勾完紧跟铺色盖掉。与 10-18 删掉的开头整段全局起稿不同——
                            // 那是长乱线开场，这里是嵌在每层里的节奏动作
    layerSketchMax: 2,      // 每层最多勾几条轮廓（只勾最大的主体层，每层最大的几圈）
    blockIn: true,          // 每层铺色前先用 1~4 档特宽笔"打形"（松色快笔），紧跟精确扫笔收拾
    bleedP: 0.22,           // 多少比例的铺色笔允许"画出界"，后面再被覆盖修回
    bleedR: 2,              // 出界的像素半径
    featherRaster: false,   // 光栅口径：false = 硬边（和网页端一致）；true = 羽化（只用于对比实验）
    organic: true,          // 单笔形态人性化：弧线 + 手抖 + 宽窄起伏
    holeFill: true,         // 收尾补漏：把"还是没画上"的小洞逐个补掉（残差补笔有"太小/太散不补"的门槛）
    holeT: 28,              // 补漏的判定阈值（单通道差）
    holeWhite: 244,         // "看着是白的"门槛（这一类补验：原图明显更深的）
    holePaper: 254,         // "纸面根本没涂上"门槛（三通道都 ≥ 它 = 那像素还是白纸），原图比它深 8 以上就补
    holeMax: 420,           // 只补这么大的洞（像素数）；更大的块属于平涂风格化，补了会花
    holeRounds: 3,          // 收尾补漏 B 类迭代几轮（每轮只补总误差量最大的那批）
    // --- 接缝修正（画布上"不该有的台阶"：两块各自差 5~7、加起来是一道肉眼可见的缝）---
    baseCheck: true,        // 底色层刷完当场自检：没盖到的楔形/边角立刻补上（底层一次铺满）
    seamFix: true,          // 开关
    seamT: 7,               // 画布这一步的台阶达到它就怀疑（单通道）
    seamSmooth: 6,          // 而原图这一步的台阶不超过它（= 原图这里本来是平滑的）
    seamR: 1,               // 沿缝两侧各看几像素
    seamE: 3,               // 缝带里"差得超过它"的像素才补（补上目标色，台阶就散成原图的渐变）
    dropDead: true,         // 收尾删掉"一笔都没留下"的笔（像素级不影响成品，回放里少一次多余动作）
    holeSeg: 48,            // 补漏一笔画多长（越长笔数越省）
    holeSplit: 18,          // 补漏的一块错误按颜色二分的停止阈值（0 = 不切）：
                            // 一块里深浅混着（渐变带、两条细线挨着）时，用一个均值色补会把浅的那半刷深
                            // （飞机边上那些"深色楔子"），而且下一轮又被判成错、再补一遍
    holeBatchMax: 200,      // 小于这么大的洞并进"补丁笔"（掩膜互不相交 ⇒ 合并像素等价，笔数省）
    patchShift: 3,          // 补笔合并的颜色分桶位移（3 = 每桶 8 个色阶）：同格同桶的散点合成一笔
    patchTol: 12,           // 自适应色差合并（0 = 关，按固定色桶并）：>0 时跟"组均值色"比，曼哈顿上限
                            // 固定色桶必须卡在可见阈值以内，合并比只有 1.7:1；改成跟组均值色比之后
                            // 同样的补笔轮次少用 37% 的笔数
    texResSkip: 0,          // 残差补笔跳过"纹理像素"（1 = 跳过；0 = 连纹理一起补）。                            // 主笔仍然不画纸纹（铺色干净），但残差补笔用细笔把颗粒/毛发点回来：
                            // 照片可见差异 25.5% → 19.6%，海报 12.4% → 10.3%
    resSkipInk: true,       // 残差不碰"细线像素"（它们留给最后的细线/题字阶段）
    inkGuard: 1,            // 非照片图：细线周围这么多像素内的小误差不再补。
                            // 细线主笔覆盖率通常已 ≥99.5%，再补只是追抗锯齿的亚可见色差
                            // （海报实测：红色描边主笔 769 支、补丁 4120 支）。
    inkGuardErr: 20,        // 保护带只挡"小误差"；大于它的真实缺口/白点仍然要补，否则线边会烂
    resSkipRamp: true,      // 残差不碰"抗锯齿斜坡像素"
    resRampSkip: false,     // 抗锯齿斜坡不补：目标色正好夹在相邻两个区块的纯色之间（渲染毛边，不是内容）。
                            // 补它 = 用一堆点去描毛边（插画 5000 笔里大半是这个），不补 = 干净的硬边
    rampTol: 30,            // 斜坡判据的容差（到"两色连线"的曼哈顿距离）
    resFlatTol: 0,          // 局部起伏 ≤ 它 = 平滑区（渐变/平色）
    resFlatErr: 26,         // 平滑区里误差 ≤ 它的不补：那是采样台阶，用点去描只会描出一片鬼影
    resSkipRampPhoto: false,// 照片类不启用斜坡判据（照片没有"纯色区块"，判不准）
    coverMin: 0.7,          // 光栅判"这一笔画上了"所需的覆盖率（网页端半透明毛边按没画上算）
    coverSubY: 2,           // 覆盖率用的亚扫描线数（1 = 只看像素中线，够抓白点且更快）
    patchCell: 2048,        // 补笔合并的空间格子（像素）；远大于图幅 = 不分格，只靠 patchShift/patchBox 控制
    patchBox: 128,          // 合并后一笔的外框上限（像素）：外框越大，网页端每笔要清/合的画布越大、内存越费
    patchFill: 0,           // 外框最小填充率（0 = 关，按"外框边长"卡）：>0 时改按密度卡，散点能并得更多
    // --- 交界过渡带（实测负收益，默认关；见 README 的坑 5）---
    edgeFill: false,        // 沿色块交界补"中间色"细笔：边界像素在目标图里大多本来就是纯色，补了反而更差
    edgeT: 10,              // 交界过渡带的阈值（单通道差）
    edgeCd: 60,             // 只补"两边颜色差得远"的交界（RGB 曼哈顿距离）
    edgeMax: 3200,          // 最多补多少处
    edgeSeg: 40,            // 过渡带一笔多长
    // --- 笔形/笔宽（风格预设会覆盖） ---
    bwF: 0.16, bwMin: 9, bwMax: 46, coverOv: 0.62,      // 笔宽 = 块厚×bwF，限幅；档间重叠 coverOv
    bwThickCap: 0,          // 照片小区域：笔宽最多是"真实厚度"的几倍（0=不限制）。
                            // 爪垫这种 3.7px 厚的纹理块原来用 12.8px 笔刷整块刷，细节被均值色抹平。
    bwThickArea: 4000,      // 只对可见面积小于它的照片区域收窄笔宽
    photoBlurPasses: 2,     // 照片分割前的 box3 次数（2=原来；1=保留更多细碎明暗，块更多、笔数更多）
    segSmallF: 2.5,         // 照片小区域的取色分段 = 厚度 × 它（下限 8px）：
                            // 原来 segMin=30 会把整块爪垫取成一个平均色，高光/阴影全丢
    joinPass: true,         // 同一区块来回的几档接成一条连续走笔（"像人一笔到底"，不是一档一笔）
    joinGap: 3,             // 连笔“接得上”的上限（像素）：两段之间跳得比它远就不能并
    joinCd: 18,             // 连笔的颜色上限（曼哈顿）：档间色差超过它就另起一笔。
                            // 实测 18（约 6 级/通道）是质量拐点：三张示例的成品指标都比不连笔更好；
                            // 24 以上开始把区块内的颜色变化抹平（海报可见差异 21.6% → 22.5%）
    taperLo: 0.86, taperAmp: 0.20, taperWob: 0.08,      // 笔压：两头细、中间粗、再抖一点
    // --- 起稿（"真起稿"会画得不准） ---
    sketchGrid: 6,          // 起稿路径按这个网格随手简化（越大越不准、越像真起稿）
    sketchOver: 5,          // 起稿两端的出锋（真起稿会画过头一点）
    // --- 自动/档位 ---
    autoColors: true,       // colors 为 0 时按纹理强度自动选色数（照片 32~36，插画 24）
    style: 'marker',        // 笔触风格：marker（平涂马克笔）/ pencil（铅笔速写）/ oil（油画厚涂）
    detail: 1,              // 老入参（兼容）：0/1/2 映射到 fidelity 1/3/5
    fidelity: 3,            // 还原程度 1 省笔 / 2 简洁 / 3 标准 / 4 精细 / 5 极致
    algo: 'layer',          // 算法：layer = 分层宽笔（API 默认）/ pyramid = 整幅逐级细化 / artist = 画家模式（网页端默认）
    // --- 精确颜色区覆盖（cover mode，默认开）---
    // 档位的含义从"补几轮"改成"颜色容差 + 笔数预算"：每个像素只属于一个颜色区，
    // 每个区一笔画完（矩形笔形 + 精确掩膜），最终逐像素误差 ≤ coverTMax。
    // 没有 residual / hole / seam / exactRepair 这些事后补笔。
    coverMode: true,
    coverT: 0,              // 0 = 按档位自动（8/6/4/2/1）：分组的色桶宽 = 2T+1
    coverTMax: 0,           // 0 = 按档位自动（20/16/12/8/2）：颜色容差硬上限；预算不够时 T 会往它靠
    coverBudget: 0,         // 0 = 按档位自动（[26k,45k,100k,175k,500k] 笔，绝对上限）
  };

  function regionMaskOf(compOf, W, compId, x0, y0, x1, y1) {
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const m = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) m[y * w + x] = compOf[(y + y0) * W + (x + x0)] === compId ? 1 : 0;
    }
    return { w, h, m };
  }

  // ================= cover mode：颜色超像素 + 分层宽笔扫 =================
  // 五档走同一条人画管线，精度由算法参数区分（不是像素级对齐开关）：
  //   1) 颜色盒中位切分 → 同叶 8 连通区（细颜色区）；
  //   2) 相邻区按"并完仍能用 ±visTol 的颜色画全"合并成超像素块，块面积上限按档位收紧；
  //   3) 相邻 + 颜色相近的块并成"层"（照片类层更细），像人一样从后往前一层层画：
  //      底色层先按"完整形状"刷满整幅（主体底下也有底色，主体随后盖上去），其它层沿
  //      自己的主轴一档档重叠扫（旧 paintSweep 笔形：手抖 + 弓弯 + 出锋 + 出界笔），
  //      层间按遮挡关系排序，同色层优先凑到笔尖跟前连着画；
  //   4) 每条扫带的落墨掩膜 = 笔形光栅 ∩ 块像素，颜色按块取——观感照旧版，成品逐像素仍 ≤ 档位容差；
  //   5) 细线/文字块走中轴笔，最后按行"题字落款"；
  //   6) 每层铺色前先沿本层轮廓铅笔灰轻勾一笔再铺满（"先画大概的轮廓、再补充细节"）；
  //      临时灰线只落在"后面必有笔重涂"的像素上，纸底永不沾墨，成品一位都不变。
  // 没有 residual / 补漏 / exactRepair / 白点补笔，也没有虚焦底图。
  async function runCoverMode(px, W, H, opts, onProgress) {
    const N = W * H;
    const prog = (p, msg) => { if (onProgress) onProgress(p, msg); };
    const yieldUI = () => new Promise((r) => setTimeout(r, 0));
    const R = new Uint8Array(N), G = new Uint8Array(N), B = new Uint8Array(N);
    for (let i = 0, p = 0; i < N; i++, p += 4) { R[i] = px[p]; G[i] = px[p + 1]; B[i] = px[p + 2]; }
    const fid = Math.max(1, Math.min(5, opts.fidelity | 0));
    // 档位 = 算法精度：调色板越细、单块越小、颜色容差越紧、笔越窄 → 细节越多。
    const LV = [
      { palT: 16, visTol: 24, maxBlob: 6000, brush: 1.40 },
      { palT: 14, visTol: 20, maxBlob: 4000, brush: 1.20 },
      { palT: 12, visTol: 16, maxBlob: 2500, brush: 1.00 },
      { palT: 10, visTol: 12, maxBlob: 1200, brush: 0.85 },
      { palT: 8,  visTol: 8,  maxBlob: 600,  brush: 0.70 },
    ][fid - 1];
    const styleW = opts.style === 'pencil' ? 0.78 : (opts.style === 'oil' ? 1.16 : 1);
    const t0 = Date.now();
    prog(0.04, '规划颜色块…');
    await yieldUI();

    const MAXMASK = 24 * 1024 * 1024;

    // 细颜色叶：颜色盒中位切分，叶内每通道跨度 ≤2*palT，叶色取约束中位色。
    function paletteSplit(palT) {
      const tol = Math.max(1, palT);
      const idx = new Int32Array(N), tmp = new Int32Array(N);
      for (let p = 0; p < N; p++) idx[p] = p;
      const leafOf = new Int32Array(N);
      const pr = [], pg = [], pb = [];
      const h = new Int32Array(256), h1 = new Int32Array(256), h2 = new Int32Array(256);
      const stack = [[0, N, 0]];
      while (stack.length) {
        const nd = stack.pop();
        const lo = nd[0], hi = nd[1], dep = nd[2];
        const n = hi - lo;
        if (n <= 0) continue;
        let mn0 = 255, mn1 = 255, mn2 = 255, mx0 = 0, mx1 = 0, mx2 = 0;
        for (let k = lo; k < hi; k++) {
          const p = idx[k], r = R[p], g = G[p], b = B[p];
          if (r < mn0) mn0 = r; if (r > mx0) mx0 = r;
          if (g < mn1) mn1 = g; if (g > mx1) mx1 = g;
          if (b < mn2) mn2 = b; if (b > mx2) mx2 = b;
        }
        if (n === 1 || (mx0 - mn0 <= 2 * tol && mx1 - mn1 <= 2 * tol && mx2 - mn2 <= 2 * tol)) {
          let c0, c1, c2;
          if (n === 1) {
            const p = idx[lo]; c0 = R[p]; c1 = G[p]; c2 = B[p];
          } else {
            h.fill(0); h1.fill(0); h2.fill(0);
            for (let k = lo; k < hi; k++) {
              const p = idx[k];
              h[R[p]]++; h1[G[p]]++; h2[B[p]]++;
            }
            const half = (n + 1) >> 1;
            let a0 = 0, a1 = 0, a2 = 0, m0 = 0, m1 = 0, m2 = 0;
            for (let v = 0; v < 256; v++) {
              a0 += h[v]; if (!m0 && a0 >= half) m0 = v;
              a1 += h1[v]; if (!m1 && a1 >= half) m1 = v;
              a2 += h2[v]; if (!m2 && a2 >= half) m2 = v;
            }
            c0 = clamp(m0, Math.max(0, mx0 - tol), Math.min(255, mn0 + tol));
            c1 = clamp(m1, Math.max(0, mx1 - tol), Math.min(255, mn1 + tol));
            c2 = clamp(m2, Math.max(0, mx2 - tol), Math.min(255, mn2 + tol));
          }
          const li = pr.length;
          pr.push(c0); pg.push(c1); pb.push(c2);
          for (let k = lo; k < hi; k++) leafOf[idx[k]] = li;
          continue;
        }
        if (dep >= 32) {
          const mr = Math.round((mn0 + mx0) / 2), mg = Math.round((mn1 + mx1) / 2), mb = Math.round((mn2 + mx2) / 2);
          const li = pr.length;
          pr.push(mr); pg.push(mg); pb.push(mb);
          for (let k = lo; k < hi; k++) leafOf[idx[k]] = li;
          continue;
        }
        let ch = 0, rng = mx0 - mn0;
        if (mx1 - mn1 > rng) { ch = 1; rng = mx1 - mn1; }
        if (mx2 - mn2 > rng) { ch = 2; rng = mx2 - mn2; }
        const arr = ch === 0 ? R : (ch === 1 ? G : B);
        h.fill(0);
        for (let k = lo; k < hi; k++) h[arr[idx[k]]]++;
        const half = (n + 1) >> 1;
        let acc = 0, splitVal = 255;
        for (let v = 0; v < 256; v++) { acc += h[v]; if (acc >= half) { splitVal = v; break; } }
        const leftMax = splitVal < mx0 && splitVal < 255 ? splitVal : splitVal - 1;
        let cut = 0;
        for (let k = lo; k < hi; k++) if (arr[idx[k]] <= leftMax) cut++;
        if (cut === 0 || cut === n) {
          cut = n >> 1;
          for (let k = 0; k < n; k++) tmp[k] = idx[lo + k];
        } else {
          let a = 0, b = cut;
          for (let k = lo; k < hi; k++) {
            const p = idx[k];
            if (arr[p] <= leftMax) tmp[a++] = p; else tmp[b++] = p;
          }
        }
        for (let k = 0; k < n; k++) idx[lo + k] = tmp[k];
        if (cut > 0) stack.push([lo, lo + cut, dep + 1]);
        if (cut < n) stack.push([lo + cut, hi, dep + 1]);
      }
      return { leafOf, pr, pg, pb };
    }

    function buildAt(palT) {
      const pal = paletteSplit(palT);
      const leafOf = pal.leafOf, pr = pal.pr, pg = pal.pg, pb = pal.pb;
      const VIS = LV.visTol;

      // 同叶 8 连通 → 颜色区
      const parent = new Int32Array(N);
      for (let p = 0; p < N; p++) parent[p] = p;
      const find = (a) => {
        while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
        return a;
      };
      const join = (a, b) => {
        const ra = find(a), rb = find(b);
        if (ra !== rb) parent[rb] = ra;
      };
      for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
          const p = row + x, bp = leafOf[p];
          if (x + 1 < W && leafOf[p + 1] === bp) join(p, p + 1);
          if (y + 1 < H) {
            const q = p + W;
            if (leafOf[q] === bp) join(p, q);
            if (x + 1 < W && leafOf[q + 1] === bp) join(p, q + 1);
            if (x > 0 && leafOf[q - 1] === bp) join(p, q - 1);
          }
        }
      }
      const rootIndex = new Int32Array(N).fill(-1);
      const rOf = new Int32Array(N);
      const rn = [], rx0 = [], ry0 = [], rx1 = [], ry1 = [];
      const rsr = [], rsg = [], rsb = [];
      const rsq0 = [], rsq1 = [], rsq2 = [];
      const rmn0 = [], rmn1 = [], rmn2 = [], rmx0 = [], rmx1 = [], rmx2 = [];
      const rsx = [], rsy = [], rsxx = [], rsxy = [], rsyy = [];
      for (let p = 0; p < N; p++) {
        const r = find(p);
        let ri = rootIndex[r];
        if (ri < 0) {
          ri = rn.length; rootIndex[r] = ri;
          rn.push(0); rx0.push(W); ry0.push(H); rx1.push(-1); ry1.push(-1);
          rsr.push(0); rsg.push(0); rsb.push(0);
          rsq0.push(0); rsq1.push(0); rsq2.push(0);
          rmn0.push(255); rmn1.push(255); rmn2.push(255);
          rmx0.push(0); rmx1.push(0); rmx2.push(0);
          rsx.push(0); rsy.push(0); rsxx.push(0); rsxy.push(0); rsyy.push(0);
        }
        rOf[p] = ri;
        const x = p % W, y = (p - x) / W;
        const rr = R[p], gg = G[p], bb = B[p];
        rn[ri]++;
        if (x < rx0[ri]) rx0[ri] = x;
        if (x > rx1[ri]) rx1[ri] = x;
        if (y < ry0[ri]) ry0[ri] = y;
        if (y > ry1[ri]) ry1[ri] = y;
        rsr[ri] += rr; rsg[ri] += gg; rsb[ri] += bb;
        rsq0[ri] += rr * rr; rsq1[ri] += gg * gg; rsq2[ri] += bb * bb;
        if (rr < rmn0[ri]) rmn0[ri] = rr;
        if (rr > rmx0[ri]) rmx0[ri] = rr;
        if (gg < rmn1[ri]) rmn1[ri] = gg;
        if (gg > rmx1[ri]) rmx1[ri] = gg;
        if (bb < rmn2[ri]) rmn2[ri] = bb;
        if (bb > rmx2[ri]) rmx2[ri] = bb;
        rsx[ri] += x; rsy[ri] += y;
        rsxx[ri] += x * x; rsxy[ri] += x * y; rsyy[ri] += y * y;
      }
      const G0 = rn.length;
      const offs0 = new Int32Array(G0 + 1);
      for (let i = 0; i < G0; i++) offs0[i + 1] = offs0[i] + rn[i];
      const pix0 = new Int32Array(N);
      const cur0 = offs0.slice(0, G0);
      for (let p = 0; p < N; p++) pix0[cur0[rOf[p]]++] = p;

      // 超像素块：并相邻区，条件只有"并完每通道跨度 ≤2*VIS"和面积上限。
      const par2 = new Int32Array(G0);
      for (let i = 0; i < G0; i++) par2[i] = i;
      const find2 = (a) => {
        while (par2[a] !== a) { par2[a] = par2[par2[a]]; a = par2[a]; }
        return a;
      };
      const aN = rn.slice(), aR0 = rx0.slice(), aR1 = rx1.slice(), aY0 = ry0.slice(), aY1 = ry1.slice();
      const aSr = rsr.slice(), aSg = rsg.slice(), aSb = rsb.slice();
      const aMn0 = rmn0.slice(), aMn1 = rmn1.slice(), aMn2 = rmn2.slice();
      const aMx0 = rmx0.slice(), aMx1 = rmx1.slice(), aMx2 = rmx2.slice();
      const unionB = (a, b) => {
        const ra = find2(a), rb = find2(b);
        if (ra === rb) return false;
        if (aN[ra] + aN[rb] > LV.maxBlob) return false;
        const mn0 = Math.min(aMn0[ra], aMn0[rb]), mx0 = Math.max(aMx0[ra], aMx0[rb]);
        const mn1 = Math.min(aMn1[ra], aMn1[rb]), mx1 = Math.max(aMx1[ra], aMx1[rb]);
        const mn2 = Math.min(aMn2[ra], aMn2[rb]), mx2 = Math.max(aMx2[ra], aMx2[rb]);
        if (mx0 - mn0 > 2 * VIS || mx1 - mn1 > 2 * VIS || mx2 - mn2 > 2 * VIS) return false;
        par2[rb] = ra;
        aN[ra] += aN[rb];
        aSr[ra] += aSr[rb]; aSg[ra] += aSg[rb]; aSb[ra] += aSb[rb];
        if (aR0[rb] < aR0[ra]) aR0[ra] = aR0[rb];
        if (aR1[rb] > aR1[ra]) aR1[ra] = aR1[rb];
        if (aY0[rb] < aY0[ra]) aY0[ra] = aY0[rb];
        if (aY1[rb] > aY1[ra]) aY1[ra] = aY1[rb];
        aMn0[ra] = mn0; aMn1[ra] = mn1; aMn2[ra] = mn2;
        aMx0[ra] = mx0; aMx1[ra] = mx1; aMx2[ra] = mx2;
        return true;
      };
      for (let pass = 0; pass < 6; pass++) {
        const em = new Map();
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const p = y * W + x;
            const a = find2(rOf[p]);
            if (x + 1 < W) {
              const b = find2(rOf[p + 1]);
              if (a !== b) { const lo = a < b ? a : b, hi = a < b ? b : a; em.set(lo * G0 + hi, [lo, hi]); }
            }
            if (y + 1 < H) {
              const b = find2(rOf[p + W]);
              if (a !== b) { const lo = a < b ? a : b, hi = a < b ? b : a; em.set(lo * G0 + hi, [lo, hi]); }
            }
          }
        }
        const cand = [];
        for (const [a, b] of em.values()) {
          const ra = find2(a), rb = find2(b);
          if (ra === rb) continue;
          const d = Math.max(
            Math.abs(aSr[ra] / aN[ra] - aSr[rb] / aN[rb]),
            Math.abs(aSg[ra] / aN[ra] - aSg[rb] / aN[rb]),
            Math.abs(aSb[ra] / aN[ra] - aSb[rb] / aN[rb]));
          cand.push([d, ra, rb]);
        }
        cand.sort((u, v) => u[0] - v[0]);
        let ng = 0;
        for (const c of cand) if (unionB(c[1], c[2])) ng++;
        if (!ng) break;
      }

      // 压紧
      const newOf = new Int32Array(G0).fill(-1);
      let GN = 0;
      for (let i = 0; i < G0; i++) if (find2(i) === i) newOf[i] = GN++;
      for (let i = 0; i < G0; i++) newOf[i] = newOf[find2(i)];
      const cN = new Int32Array(GN), cR0 = new Int32Array(GN).fill(W), cR1 = new Int32Array(GN).fill(-1);
      const cY0 = new Int32Array(GN).fill(H), cY1 = new Int32Array(GN).fill(-1);
      const cSr = new Float64Array(GN), cSg = new Float64Array(GN), cSb = new Float64Array(GN);
      const cMn0 = new Int32Array(GN).fill(255), cMn1 = new Int32Array(GN).fill(255), cMn2 = new Int32Array(GN).fill(255);
      const cMx0 = new Int32Array(GN), cMx1 = new Int32Array(GN), cMx2 = new Int32Array(GN);
      const cSx = new Float64Array(GN), cSy = new Float64Array(GN);
      const cSxx = new Float64Array(GN), cSxy = new Float64Array(GN), cSyy = new Float64Array(GN);
      const cOf = new Int32Array(N);
      for (let p = 0; p < N; p++) {
        const ri = newOf[rOf[p]];
        cOf[p] = ri;
        const x = p % W, y = (p - x) / W;
        const rr = R[p], gg = G[p], bb = B[p];
        cN[ri]++;
        if (x < cR0[ri]) cR0[ri] = x;
        if (x > cR1[ri]) cR1[ri] = x;
        if (y < cY0[ri]) cY0[ri] = y;
        if (y > cY1[ri]) cY1[ri] = y;
        cSr[ri] += rr; cSg[ri] += gg; cSb[ri] += bb;
        if (rr < cMn0[ri]) cMn0[ri] = rr;
        if (rr > cMx0[ri]) cMx0[ri] = rr;
        if (gg < cMn1[ri]) cMn1[ri] = gg;
        if (gg > cMx1[ri]) cMx1[ri] = gg;
        if (bb < cMn2[ri]) cMn2[ri] = bb;
        if (bb > cMx2[ri]) cMx2[ri] = bb;
        cSx[ri] += x; cSy[ri] += y;
        cSxx[ri] += x * x; cSxy[ri] += x * y; cSyy[ri] += y * y;
      }
      const offs = new Int32Array(GN + 1);
      for (let i = 0; i < GN; i++) offs[i + 1] = offs[i] + cN[i];
      const pix = new Int32Array(N);
      const cur = offs.slice(0, GN);
      for (let p = 0; p < N; p++) pix[cur[cOf[p]]++] = p;

      const colors = new Array(GN);
      const paper = new Uint8Array(GN);
      let paperPx = 0;
      for (let i = 0; i < GN; i++) {
        const n = cN[i];
        colors[i] = [
          clamp(Math.round(cSr[i] / n), Math.max(0, cMx0[i] - VIS), Math.min(255, cMn0[i] + VIS)),
          clamp(Math.round(cSg[i] / n), Math.max(0, cMx1[i] - VIS), Math.min(255, cMn1[i] + VIS)),
          clamp(Math.round(cSb[i] / n), Math.max(0, cMx2[i] - VIS), Math.min(255, cMn2[i] + VIS)),
        ];
        // 纯白纸底（贴边、面积大、最暗通道也 ≥248）：不画，回放保持白纸
        if (cN[i] > N * 0.01 && Math.min(cMn0[i], cMn1[i], cMn2[i]) >= 248 &&
            (cR0[i] === 0 || cY0[i] === 0 || cR1[i] === W - 1 || cY1[i] === H - 1)) {
          paper[i] = 1; paperPx += cN[i];
        }
      }

      let est = 0, maskBytes = 0;
      for (let i = 0; i < GN; i++) {
        if (paper[i]) continue;
        const w = cR1[i] - cR0[i] + 1, h = cY1[i] - cY0[i] + 1;
        maskBytes += w * h;
        const major = Math.max(w, h), minor = Math.min(w, h);
        const thick = cN[i] / Math.max(1, major);
        if (thick <= 3.5 || cN[i] <= 32) { est += 1; continue; }
        const bandSize = clamp(minor * 0.35 * LV.brush, 8, 48);
        let bands = Math.ceil(minor / Math.max(2, bandSize * 0.8));
        if (bands > 6) bands = 6;
        est += Math.max(1, bands);
      }
      return { palT, GN, rn: cN, rx0: cR0, ry0: cY0, rx1: cR1, ry1: cY1,
               rsr: cSr, rsg: cSg, rsb: cSb,
               rmn0: cMn0, rmn1: cMn1, rmn2: cMn2, rmx0: cMx0, rmx1: cMx1, rmx2: cMx2,
               rsx: cSx, rsy: cSy, rsxx: cSxx, rsxy: cSxy, rsyy: cSyy,
               offs, pix, colors, paper, paperPx, cOf, est, maskBytes };
    }

    const chosen = buildAt(LV.palT);
    const G_ = chosen.GN;
    const Tms = { build: Date.now() - t0 };
    const tL0 = Date.now();
    prog(0.28, '颜色块 ' + G_ + ' 个（' + ['①', '②', '③', '④', '⑤'][fid - 1] + ' 档精度）');
    await yieldUI();

    const strokes = [], clips = [];
    let maskPx = 0;
    const pushClip = (x, y, w, h, mask) => {
      maskPx += w * h;
      clips.push({ x, y, w, h, mask });
      return clips.length - 1;
    };
    let lastPenX = 0, lastPenY = 0;
    const emit = (rib, tp, halfW, color, pen, cIdx, ph, ly, fast) => {
      let len = 0;
      for (let i = 1; i < tp.length / 2; i++) {
        len += Math.hypot(tp[i * 2] - tp[(i - 1) * 2], tp[i * 2 + 1] - tp[(i - 1) * 2 + 1]);
      }
      // 节奏照旧版：铺底色轻快、铺色中等、收形慢、点睛最慢最细；短笔有起步价、
      // 每笔快慢有点起伏、白色一笔带过。总时长由收尾按 targetSec 归一。
      let weight;
      if (ph === 0) weight = 8 + len * 1.0;
      else if (ph === 3) weight = 26 + len * 2.6;
      else if (ph === 2) weight = 18 + len * 2.2;
      else weight = 12 + len * 1.8;
      weight *= 0.85 + 0.3 * rand01(len + strokes.length * 0.37, ph + 1.7);
      if (fast) weight *= 0.55;   // 勾轮廓是随手快笔，起形不磨蹭
      if (luma(color) > 238) weight *= 0.3;
      strokes.push({
        rib: Array.from(rib, (v) => Math.round(v * 10) / 10),
        tp: Array.from(tp, (v) => Math.round(v * 10) / 10),
        w: Math.round(halfW * 2 * 10) / 10,
        color: [color[0], color[1], color[2]],
        pen: pen ? 1 : 0,
        ms: weight, c: cIdx, r: -1, ph: ph, ly: ly === undefined ? -1 : ly,
      });
      lastPenX = tp[tp.length - 2]; lastPenY = tp[tp.length - 1];
    };

    // ============ 图层栈：相邻 + 颜色相近的块并成"层"，像人一样从后往前画 ============
    // 旧版三件套照搬：① 层并查集（挨着+色近）；② 底色层完整形状刷满整幅、其它层闭运算
    // 补"被上层盖住的部分"；③ 遮挡约束之上按"同色、离笔尖近"串层。深度序 = 面积从大到小。
    const strokeScale = Math.max(0.5, W / 1024);
    let mergeCd = opts.objMergeCd;
    if (mergeCd === CFG.objMergeCd) {
      // 纹理强的图（照片/扫描件）层要切细：合并门槛一大，整片岩石/毛发会被并成一层
      // 刷成均值色，远处暗部整片错（旧版实测拐点 25）。半分辨率 med3 差分（4× 便宜）。
      const hw = (W + 1) >> 1, hh = (H + 1) >> 1;
      const sR = new Uint8Array(hw * hh), sG = new Uint8Array(hw * hh), sB = new Uint8Array(hw * hh);
      for (let y = 0; y < hh; y++) {
        for (let x = 0; x < hw; x++) {
          const p = (y * 2) * W + x * 2, q = y * hw + x;
          sR[q] = R[p]; sG[q] = G[p]; sB[q] = B[p];
        }
      }
      const mR = med3(sR, hw, hh), mG = med3(sG, hw, hh), mB = med3(sB, hw, hh);
      let diff = 0;
      for (let i = 0; i < hw * hh; i++) {
        const d = Math.abs(mR[i] - sR[i]) + Math.abs(mG[i] - sG[i]) + Math.abs(mB[i] - sB[i]);
        if (d > 36) diff++;
      }
      mergeCd = diff / (hw * hh) > 0.06 ? 25 : 70;
      if (opts.debug) console.log('[cover] texHalf=' + (diff / (hw * hh)).toFixed(3) + ' mergeCd=' + mergeCd);
    }

    // 细长条（文字笔画、轮廓线、胡须）不进层：铺色时那里被底色铺满，最后按行"题字落款"。
    // 纯形状判据（长²/面积 ≥ 6 = 细长条），不管明暗——亮胡须、深文字都算。
    // 注意没有"小块=笔"这一条：噪点碎块（< minAbs）必须留在层里被扫笔认领，否则几十万块
    // 全变成最后的小笔（实测 s2/s3 有 3 万块 3px 的小笔占了 60% 时间轴）。
    const minAbs = Math.max(32, Math.round(96 * strokeScale));
    const isPenBlob = new Uint8Array(G_);
    for (let i = 0; i < G_; i++) {
      if (chosen.paper[i]) continue;
      const bw = chosen.rx1[i] - chosen.rx0[i] + 1, bh = chosen.ry1[i] - chosen.ry0[i] + 1;
      const elong = Math.max(bw, bh) * Math.max(bw, bh) / Math.max(1, chosen.rn[i]);
      if (chosen.rn[i] >= minAbs && elong >= 6) isPenBlob[i] = 1;
    }

    const lPar = new Int32Array(G_);
    const rootArea = new Float64Array(G_);
    for (let i = 0; i < G_; i++) { lPar[i] = i; rootArea[i] = chosen.rn[i]; }
    const lFind = (a) => { while (lPar[a] !== a) { lPar[a] = lPar[lPar[a]]; a = lPar[a]; } return a; };
    const lUnion = (ra, rb) => { lPar[rb] = ra; rootArea[ra] += rootArea[rb]; };
    const nearMerge = (ga, gb) => {
      if (ga === gb || chosen.paper[ga] || chosen.paper[gb] || isPenBlob[ga] || isPenBlob[gb]) return;
      const cd = Math.abs(chosen.rsr[ga] / chosen.rn[ga] - chosen.rsr[gb] / chosen.rn[gb]) +
                 Math.abs(chosen.rsg[ga] / chosen.rn[ga] - chosen.rsg[gb] / chosen.rn[gb]) +
                 Math.abs(chosen.rsb[ga] / chosen.rn[ga] - chosen.rsb[gb] / chosen.rn[gb]);
      if (cd > mergeCd) return;
      const ra = lFind(ga), rb = lFind(gb);
      if (ra !== rb) lUnion(ra, rb);
    };
    // 单趟扫描：边做"层并查集的相邻合并"，边收集"块邻接对"（并查集定型后映射成层邻接）
    const adjPairs = [];
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const p = row + x, ga = chosen.cOf[p];
        if (x + 1 < W) { const gb = chosen.cOf[p + 1]; if (gb !== ga) { nearMerge(ga, gb); adjPairs.push(ga, gb); } }
        if (y + 1 < H) { const gb = chosen.cOf[p + W]; if (gb !== ga) { nearMerge(ga, gb); adjPairs.push(ga, gb); } }
      }
    }

    // 碎块吸收（旧 minArea 的语义）：根面积 < minAbs 的层并进相邻更大层——不管 mergeCd，
    // 只挑颜色最近的邻居。吸收只决定"被哪层的扫笔认领/密封"，颜色仍由扫笔并段的
    // 范围约束逐像素保证；吸收不动的（周围全是纸底/文字）留成自己的小层，走中轴笔。
    {
      const minAbs = Math.max(32, Math.round(96 * strokeScale));
      const bestN = new Map();
      for (let i = 0; i < adjPairs.length; i += 2) {
        const ra = lFind(adjPairs[i]), rb = lFind(adjPairs[i + 1]);
        if (ra === rb) continue;
        let small = -1, big = -1;
        if (rootArea[ra] < minAbs && rootArea[rb] >= rootArea[ra]) { small = ra; big = rb; }
        else if (rootArea[rb] < minAbs && rootArea[ra] > rootArea[rb]) { small = rb; big = ra; }
        else continue;
        if (chosen.paper[big] || isPenBlob[big]) continue;
        const a = adjPairs[i], b = adjPairs[i + 1];
        const cd = Math.abs(chosen.rsr[a] / chosen.rn[a] - chosen.rsr[b] / chosen.rn[b]) +
                   Math.abs(chosen.rsg[a] / chosen.rn[a] - chosen.rsg[b] / chosen.rn[b]) +
                   Math.abs(chosen.rsb[a] / chosen.rn[a] - chosen.rsb[b] / chosen.rn[b]);
        const cur = bestN.get(small);
        if (!cur || cd < cur[0]) bestN.set(small, [cd, big]);
      }
      for (const [small, [, big]] of bestN) {
        const rs = lFind(small), rb2 = lFind(big);
        if (rs !== rb2) lUnion(rb2, rs);
      }
    }

    const lId = new Int32Array(G_).fill(-1);
    const nL0 = (() => { let c = 0; for (let i = 0; i < G_; i++) if (!chosen.paper[i] && !isPenBlob[i] && lFind(i) === i) c++; return c; })();
    let nL = 0;
    for (let i = 0; i < G_; i++) if (!chosen.paper[i] && !isPenBlob[i] && lFind(i) === i) lId[i] = nL++;
    for (let i = 0; i < G_; i++) if (!chosen.paper[i] && !isPenBlob[i]) lId[i] = lId[lFind(i)];

    const lMembers = [];
    for (let L = 0; L < nL; L++) lMembers.push([]);
    const lArea = new Float64Array(nL);
    const lX0 = new Int32Array(nL).fill(W), lX1 = new Int32Array(nL).fill(-1);
    const lY0 = new Int32Array(nL).fill(H), lY1 = new Int32Array(nL).fill(-1);
    const lSx = new Float64Array(nL), lSy = new Float64Array(nL);
    const lSxx = new Float64Array(nL), lSxy = new Float64Array(nL), lSyy = new Float64Array(nL);
    const lSr = new Float64Array(nL), lSg = new Float64Array(nL), lSb = new Float64Array(nL);
    for (let i = 0; i < G_; i++) {
      const L = lId[i];
      if (L < 0) continue;
      lMembers[L].push(i);
      lArea[L] += chosen.rn[i];
      if (chosen.rx0[i] < lX0[L]) lX0[L] = chosen.rx0[i];
      if (chosen.rx1[i] > lX1[L]) lX1[L] = chosen.rx1[i];
      if (chosen.ry0[i] < lY0[L]) lY0[L] = chosen.ry0[i];
      if (chosen.ry1[i] > lY1[L]) lY1[L] = chosen.ry1[i];
      lSx[L] += chosen.rsx[i]; lSy[L] += chosen.rsy[i];
      lSxx[L] += chosen.rsxx[i]; lSxy[L] += chosen.rsxy[i]; lSyy[L] += chosen.rsyy[i];
      lSr[L] += chosen.rsr[i]; lSg[L] += chosen.rsg[i]; lSb[L] += chosen.rsb[i];
    }

    // 深度序：面积从大到小 = 从后往前（rank 0 最靠后，最先画）
    const rank = new Int32Array(nL);
    {
      const ids = [];
      for (let L = 0; L < nL; L++) ids.push(L);
      ids.sort((a, b) => lArea[b] - lArea[a]);
      for (let k = 0; k < ids.length; k++) rank[ids[k]] = k;
    }
    let base = -1;
    for (let L = 0; L < nL; L++) if (rank[L] === 0) { base = L; break; }

    // 每层自己的像素（bbox 局部掩膜）
    const lOwn = new Array(nL);
    for (let L = 0; L < nL; L++) {
      const w = lX1[L] - lX0[L] + 1, h = lY1[L] - lY0[L] + 1;
      lOwn[L] = { x0: lX0[L], y0: lY0[L], w, h, m: new Uint8Array(w * h) };
    }
    for (let gi = 0; gi < G_; gi++) {
      const L = lId[gi];
      if (L < 0) continue;
      const own = lOwn[L];
      for (let k = chosen.offs[gi]; k < chosen.offs[gi + 1]; k++) {
        const p = chosen.pix[k], x = p % W, y = (p - x) / W;
        own.m[(y - own.y0) * own.w + (x - own.x0)] = 1;
      }
    }

    const spanOf = (mk, ax, ay, cx, cy) => {
      let tmin = Infinity, tmax = -Infinity, vmax = 0;
      for (let y = 0; y < mk.h; y++) {
        const row = y * mk.w;
        for (let x = 0; x < mk.w; x++) {
          if (!mk.m[row + x]) continue;
          const gx = x + mk.x0, gy = y + mk.y0;
          const t = (gx - cx) * ax + (gy - cy) * ay;
          const v = Math.abs(-(gx - cx) * ay + (gy - cy) * ax);
          if (t < tmin) tmin = t;
          if (t > tmax) tmax = t;
          if (v > vmax) vmax = v;
        }
      }
      if (!(tmax >= tmin)) tmin = tmax = 0;
      return { tmin, tmax, vmax };
    };

    // 层统计：主轴（PCA，各向同性退化成外框长边方向）、厚度（最大内切 ×2）、是否细长层
    const lAx = new Float64Array(nL), lAy = new Float64Array(nL);
    const lCx = new Float64Array(nL), lCy = new Float64Array(nL);
    const lHp = new Float64Array(nL), lLinear = new Uint8Array(nL);
    const lThick = [], lThin = [];
    for (let L = 0; L < nL; L++) {
      const n = Math.max(1, lArea[L]);
      const cx = lSx[L] / n, cy = lSy[L] / n;
      lCx[L] = cx; lCy[L] = cy;
      const vxx = Math.max(0, lSxx[L] / n - cx * cx), vyy = Math.max(0, lSyy[L] / n - cy * cy);
      const vxy = lSxy[L] / n - cx * cy;
      const w = lX1[L] - lX0[L] + 1, h = lY1[L] - lY0[L] + 1;
      if (vxx + vyy < 1e-6 || Math.abs(vxx - vyy) + 2 * Math.abs(vxy) < 1e-3 * (vxx + vyy)) {
        lAx[L] = w >= h ? 1 : 0; lAy[L] = w >= h ? 0 : 1;
      } else {
        const th = 0.5 * Math.atan2(2 * vxy, vxx - vyy);
        lAx[L] = Math.cos(th); lAy[L] = Math.sin(th);
      }
      const dt = distanceTransform(lOwn[L].m, w, h);
      let mx2 = 0;
      for (let i = 0; i < dt.length; i++) if (dt[i] > mx2) mx2 = dt[i];
      lHp[L] = mx2 * 2;
      const sp = spanOf(lOwn[L], lAx[L], lAy[L], cx, cy);
      const majorT = sp.tmax - sp.tmin;
      const med = lArea[L] / Math.max(1, majorT);
      lLinear[L] = (majorT / Math.max(1, med) >= 9 && med * 2 <= Math.max(12, 24 * strokeScale)) ? 1 : 0;
      const tk = [], tn = [];
      // 小碎块（< minAbs）不算"细线"：它们是噪点/纹理，让扫笔认领（seal 保证盖到、
      // 并段的范围约束保证颜色）——旧版 minArea=110 碎块吸收的等价物。吸收不掉的
      // （和邻居色差太远、并段不可行）自然成为自己的短笔。
      for (const gi of lMembers[L]) {
        const bw = chosen.rx1[gi] - chosen.rx0[gi] + 1, bh = chosen.ry1[gi] - chosen.ry0[gi] + 1;
        const thick = chosen.rn[gi] / Math.max(1, Math.max(bw, bh));
        if (chosen.rn[gi] >= minAbs && thick <= 3.5) tn.push(gi); else tk.push(gi);
      }
      lThick.push(tk); lThin.push(tn);
    }

    // ② 完整形状：底色层 = 整幅减纸底（主体底下也先铺上底色）；其它层 = 自己 ∪ 闭运算
    //    补出的"被上层盖住的部分"。外扩量 = 贴着的上层有多厚 × 0.55——补出来的形状只要
    //    盖到上层一半就够，再往外是上层自己的地盘（旧 objGrowF）。
    const paperLab = new Uint8Array(N);
    for (let p = 0; p < N; p++) if (chosen.paper[chosen.cOf[p]]) paperLab[p] = 1;
    const lAdj = [];
    for (let L = 0; L < nL; L++) lAdj.push([]);
    {
      const seen = new Set();
      for (let i = 0; i < adjPairs.length; i += 2) {
        const La = lId[adjPairs[i]], Lb = lId[adjPairs[i + 1]];
        if (La < 0 || Lb < 0 || La === Lb) continue;
        const lo = La < Lb ? La : Lb, hi = La < Lb ? Lb : La, key = lo * nL + hi;
        if (!seen.has(key)) { seen.add(key); lAdj[lo].push(hi); lAdj[hi].push(lo); }
      }
    }
    const lCovers = [];   // 每层的完整形状盖到了哪些层的像素 ⇒ 自己先画、对方后画盖回来
    const lFull = new Array(nL);
    for (let L = 0; L < nL; L++) {
      if (L === base) {
        const m = new Uint8Array(N);
        for (let p = 0; p < N; p++) if (!paperLab[p]) m[p] = 1;
        lFull[L] = { x0: 0, y0: 0, w: W, h: H, m };
        lCovers.push(null);
        continue;
      }
      const own = lOwn[L];
      let r = 0;
      for (const ob of lAdj[L]) if (rank[ob] > rank[L]) r = Math.max(r, lHp[ob] * 2);
      r = clamp(Math.round(r * 0.55), 3, 26);
      const covers = new Set();
      let full = own;
      if (r > 3) {
        const bx0 = Math.max(0, own.x0 - r), by0 = Math.max(0, own.y0 - r);
        const bx1 = Math.min(W - 1, own.x0 + own.w - 1 + r), by1 = Math.min(H - 1, own.y0 + own.h - 1 + r);
        const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
        const sub = new Uint8Array(bw * bh), above = new Uint8Array(bw * bh);
        let any = false;
        for (let y = 0; y < bh; y++) {
          const row = (y + by0) * W;
          for (let x = 0; x < bw; x++) {
            const Lb = lId[chosen.cOf[row + bx0 + x]];
            if (Lb === L) sub[y * bw + x] = 1;
            else if (Lb >= 0 && rank[Lb] > rank[L]) { above[y * bw + x] = 1; covers.add(Lb); any = true; }
          }
        }
        if (any) {
          const cl = closeMaskDisk(sub, bw, bh, r);
          const m = new Uint8Array(bw * bh);
          for (let i = 0; i < m.length; i++) if (sub[i] || (cl[i] && above[i])) m[i] = 1;
          full = { x0: bx0, y0: by0, w: bw, h: bh, m };
        }
      }
      lFull[L] = full;
      lCovers.push(covers);
    }
    if (base >= 0) {
      const all = new Set();
      for (let L = 0; L < nL; L++) if (L !== base) all.add(L);
      lCovers[base] = all;   // 底色层完整形状盖住一切 ⇒ 它最先画
    }

    // ③ 顺序：遮挡约束之上自由 —— 优先挑"跟上一笔同色、又离笔尖近"的层，
    //    同一支笔一路把同色的东西画完（一排橙字连着写完）；约束卡住时按面积大者优先。
    const paintOrder = (() => {
      const out = [];
      if (!nL) return out;
      // 层太多时贪心是 O(n²)：直接按深度序（面积从大到小）画——遮挡约束本来就沿着深度序
      if (nL > 2500) { const ids = []; for (let L = 0; L < nL; L++) ids.push(L); ids.sort((a, b) => rank[a] - rank[b]); return ids; }
      const need = new Map(), rel = new Map();
      const addEdge = (b, a) => {
        let s = need.get(a); if (!s) { s = new Set(); need.set(a, s); }
        if (s.has(b)) return;
        s.add(b);
        let t = rel.get(b); if (!t) { t = new Set(); rel.set(b, t); }
        t.add(a);
      };
      for (let L = 0; L < nL; L++) {
        const cs = lCovers[L];
        if (!cs) continue;
        for (const F of cs) addEdge(L, F);
      }
      const indeg = new Int32Array(nL);
      for (const [a, s] of need) indeg[a] = s.size;
      const done = new Uint8Array(nL);
      let pc = null, px0 = 0, py0 = 0, pa = 0;
      for (let k = 0; k < nL; k++) {
        let bestSame = -1, bdSame = Infinity, bestAny = -1, baAny = -1;
        for (let i = 0; i < nL; i++) {
          if (done[i] || indeg[i] > 0) continue;
          if (pc) {
            const cd = Math.abs(lSr[i] / lArea[i] - pc[0]) + Math.abs(lSg[i] / lArea[i] - pc[1]) +
                       Math.abs(lSb[i] / lArea[i] - pc[2]);
            const ar = Math.max(lArea[i], pa) / Math.max(1, Math.min(lArea[i], pa));
            if (cd <= 36 && ar <= 4) {
              const d = Math.hypot(lCx[i] - px0, lCy[i] - py0);
              if (d < bdSame) { bdSame = d; bestSame = i; }
              continue;
            }
          }
          if (lArea[i] > baAny) { baAny = lArea[i]; bestAny = i; }
        }
        let pick = bestSame >= 0 ? bestSame : bestAny;
        if (pick < 0) { for (let i = 0; i < nL; i++) if (!done[i]) { pick = i; break; } }
        done[pick] = 1; out.push(pick);
        pc = [lSr[pick] / lArea[pick], lSg[pick] / lArea[pick], lSb[pick] / lArea[pick]];
        px0 = lCx[pick]; py0 = lCy[pick]; pa = lArea[pick];
        const t = rel.get(pick);
        if (t) for (const a of t) indeg[a]--;
      }
      return out;
    })();
    // 阶段按"累计面积"分（旧版节奏）：底色层 = 铺底色(ph0)；其余层铺到 55% 面积 = 铺色(ph1)，
    // 之后 = 收形(ph2)；细长条 = 点睛/落款(ph3)。
    const lPh = new Int32Array(nL);
    {
      let totalA = 0;
      for (let L = 0; L < nL; L++) if (L !== base) totalA += lArea[L];
      let cum = 0;
      for (const L of paintOrder) {
        if (L === base) { lPh[L] = 0; continue; }
        lPh[L] = (base >= 0 ? cum : cum + lArea[L]) / Math.max(1, totalA) < 0.55 ? 1 : 2;
        cum += lArea[L];
      }
    }
    const posOf = new Int32Array(nL);
    for (let k = 0; k < paintOrder.length; k++) posOf[paintOrder[k]] = k;
    // 像素 → 所属层的画序（-1 = 纸底/文字块）。出界笔只许压在"排在自己后面"的层上。
    const cOfPos = new Int32Array(N).fill(-1);
    for (let p = 0; p < N; p++) {
      const L = lId[chosen.cOf[p]];
      cOfPos[p] = L >= 0 ? posOf[L] : -1;
    }
    const thickOfBlob = new Int32Array(G_).fill(-1);

    prog(0.45, '图层 ' + nL0 + ' 层…');
    await yieldUI();

    const maskOfRegion = (gi) => {
      const x0 = chosen.rx0[gi], y0 = chosen.ry0[gi];
      const w = chosen.rx1[gi] - x0 + 1, h = chosen.ry1[gi] - y0 + 1;
      const m = new Uint8Array(w * h);
      for (let k = chosen.offs[gi]; k < chosen.offs[gi + 1]; k++) {
        const p = chosen.pix[k], x = p % W, y = (p - x) / W;
        m[(y - y0) * w + (x - x0)] = 1;
      }
      return { x: x0, y: y0, w, h, m };
    };

    let thinCalls = 0;
    const skeletonStroke = (gi, ph, ly) => {
      // 细线/小点：中轴一笔（bbox 太大时退回主轴投影）
      const n = chosen.rn[gi], color = chosen.colors[gi];
      const x0 = chosen.rx0[gi], y0 = chosen.ry0[gi];
      const w = chosen.rx1[gi] - x0 + 1, h = chosen.ry1[gi] - y0 + 1;
      const major = Math.max(w, h), minor = Math.min(w, h);
      const thick = n / Math.max(1, major);
      const pen = isPenBlob[gi] ? 1 : 0;
      const mk = maskOfRegion(gi);
      let tp = null;
      if (w * h <= 50000) {
        const { sk } = thin(mk.m, w, h);
        thinCalls++;
        const lp = longestPath(sk, w, h);
        if (lp && lp.len >= 2) {
          const abs = new Float64Array(lp.len * 2);
          for (let i = 0; i < lp.len; i++) {
            abs[i * 2] = lp.pts[i * 2] + x0;
            abs[i * 2 + 1] = lp.pts[i * 2 + 1] + y0;
          }
          const sp = rdpSimplify(abs, lp.len, 1.2);
          if (sp.n >= 2) {
            tp = new Array(sp.n * 2);
            for (let i = 0; i < sp.n; i++) { tp[i * 2] = sp.pts[i * 2]; tp[i * 2 + 1] = sp.pts[i * 2 + 1]; }
          }
        }
      }
      if (!tp) {
        const mx = chosen.rsx[gi] / n, my = chosen.rsy[gi] / n;
        const vxx = Math.max(0, chosen.rsxx[gi] / n - mx * mx);
        const vyy = Math.max(0, chosen.rsyy[gi] / n - my * my);
        const vxy = chosen.rsxy[gi] / n - mx * my;
        const th = 0.5 * Math.atan2(2 * vxy, vxx - vyy);
        const ax = Math.cos(th), ay = Math.sin(th);
        let tmin = Infinity, tmax = -Infinity;
        for (let k = chosen.offs[gi]; k < chosen.offs[gi + 1]; k++) {
          const p = chosen.pix[k], x = p % W, y = (p - x) / W;
          const t = (x - mx) * ax + (y - my) * ay;
          if (t < tmin) tmin = t;
          if (t > tmax) tmax = t;
        }
        if (!(tmax > tmin)) { tmin = -1; tmax = 1; }
        const p0x = mx + tmin * ax, p0y = my + tmin * ay;
        const p1x = mx + tmax * ax, p1y = my + tmax * ay;
        tp = [p0x, p0y, (p0x + p1x) / 2, (p0y + p1y) / 2, p1x, p1y];
      }
      const halfW = clamp(thick * 0.75 + 0.9, 1.2, 6) * styleW;
      const rib = [x0, y0, x0 + w, y0, x0 + w, y0 + h, x0, y0 + h];
      const cIdx = pushClip(x0, y0, w, h, mk.m);
      emit(rib, tp, halfW, color, pen, cIdx, ph, ly);
    };

    // ============ 勾轮廓（旧版起稿笔触）：铅笔灰细线沿轮廓轻勾，勾完紧跟铺色盖掉 ============
    // 掩膜裁到 ok() 认可的像素上——只有"后面必有笔重涂"的地方才许沾墨（自己层的扫笔/
    // 中轴笔马上盖、后层的笔轮到时盖），纸底永远不落笔 ⇒ 临时灰线对成品零影响。
    const skHalf = Math.max(1.1, (opts.sketchHalf || 1.5) * strokeScale);
    const skMix = opts.sketchMix === undefined ? 0.45 : opts.sketchMix;
    const skPad = Math.max(1, Math.round(1.2 * strokeScale));
    const pencilAt = (x, y) => {
      const p = clamp(Math.round(y), 0, H - 1) * W + clamp(Math.round(x), 0, W - 1);
      // 起稿色：局部目标色往铅笔灰里压一点——有"铅笔线"的味道，又不会留下大片深色残迹
      return [
        Math.round(R[p] * (1 - skMix) + 74 * skMix),
        Math.round(G[p] * (1 - skMix) + 72 * skMix),
        Math.round(B[p] * (1 - skMix) + 76 * skMix),
      ];
    };
    // mk：轮廓环掩膜（bbox 局部，含 x0/y0）；ok(x,y)：绝对坐标像素可否落墨；capN：最多勾几条
    const sketchOn = (mk, ok, ph, capN) => {
      const cc = compsOfLabels(mk.m, mk.w, mk.h);
      const cand = [];
      for (let ci = 0; ci < cc.comps.length; ci++) {
        const c = cc.comps[ci];
        if (c.label === 1 && c.count >= 12) cand.push(ci);
      }
      if (!cand.length) return;
      cand.sort((a, b) => cc.comps[b].count - cc.comps[a].count);
      const items = cand.slice(0, capN).map((ci) => {
        const c = cc.comps[ci];
        return { ci, cx: (c.x0 + c.x1) / 2 + mk.x0, cy: (c.y0 + c.y1) / 2 + mk.y0 };
      });
      // 就近串成一条路线：从笔尖当前位置出发，不来回跳
      const seq = chainNN(items, (it) => [it.cx, it.cy], lastPenX, lastPenY);
      for (const it of seq) {
        const c = cc.comps[it.ci];
        const x = Math.max(0, c.x0 - skPad), y = Math.max(0, c.y0 - skPad);
        const x1 = Math.min(mk.w - 1, c.x1 + skPad), y1 = Math.min(mk.h - 1, c.y1 + skPad);
        const w = x1 - x + 1, h = y1 - y + 1;
        const cm = new Uint8Array(w * h);
        for (let k = c.start; k < c.start + c.count; k++) {
          const lp = cc.pix[k], lx = lp % mk.w, ly = (lp - lx) / mk.w;
          if (lx < x || ly < y || lx > x1 || ly > y1) continue;
          cm[(ly - y) * w + (lx - x)] = 1;
        }
        const dm = dilate(cm, w, h, skPad);
        let cnt = 0;
        for (let yy = 0; yy < h; yy++) {
          for (let xx = 0; xx < w; xx++) {
            const i = yy * w + xx;
            if (dm[i] && ok(mk.x0 + x + xx, mk.y0 + y + yy)) cnt++;
            else dm[i] = 0;
          }
        }
        if (cnt < 12) continue;
        const { sk } = thin(cm, w, h);
        const lp = longestPath(sk, w, h);
        if (!lp || lp.len < 4) continue;
        const abs = new Float64Array(lp.len * 2);
        for (let i = 0; i < lp.len; i++) {
          abs[i * 2] = lp.pts[i * 2] + mk.x0 + x;
          abs[i * 2 + 1] = lp.pts[i * 2 + 1] + mk.y0 + y;
        }
        const sp = rdpSimplify(abs, lp.len, 1.0);
        if (sp.n < 2) continue;
        const tp = new Array(sp.n * 2);
        for (let i = 0; i < sp.n; i++) { tp[i * 2] = sp.pts[i * 2]; tp[i * 2 + 1] = sp.pts[i * 2 + 1]; }
        const mi = sp.n >> 1;
        const col = pencilAt(tp[mi * 2], tp[mi * 2 + 1]);
        const rib = [mk.x0 + x, mk.y0 + y, mk.x0 + x + w, mk.y0 + y,
                     mk.x0 + x + w, mk.y0 + y + h, mk.x0 + x, mk.y0 + y + h];
        const cIdx = pushClip(mk.x0 + x, mk.y0 + y, w, h, dm);
        emit(rib, tp, skHalf, col, 1, cIdx, ph, -1, true);
      }
    };
    // 每层轮廓的落墨许可：自己层的像素（马上被本层扫笔/中轴笔盖）+ 排在自己后面的层
    //（轮到时盖）+ 文字笔画（ph3 题字时盖）。纸底和排在前面的层一律不沾。
    const layerSketchOK = (L) => {
      const curPos = posOf[L];
      return (x, y) => {
        const p = y * W + x;
        if (paperLab[p]) return false;
        const b = chosen.cOf[p];
        return lId[b] === L || isPenBlob[b] || cOfPos[p] > curPos;
      };
    };
    // 层完整形状的轮廓环（bbox 局部）：lFull 边缘 1px
    const ringOf = (f) => {
      const bnd = new Uint8Array(f.w * f.h);
      for (let y = 0; y < f.h; y++) {
        const row = y * f.w;
        for (let x = 0; x < f.w; x++) {
          const i = row + x;
          if (!f.m[i]) continue;
          if (x === 0 || y === 0 || x === f.w - 1 || y === f.h - 1 ||
              !f.m[i - 1] || !f.m[i + 1] || !f.m[i - f.w] || !f.m[i + f.w]) bnd[i] = 1;
        }
      }
      return bnd;
    };
    // ============ 打形粗笔（每层铺色前）：1~4 档特宽笔先把层的形状松松砸出来， ============
    // 松色（并段范围放到 4×容差、颜色取均值）、快笔；紧跟的精确扫笔把每个像素收拾到位。
    // 掩膜与勾形同一条许可（自己/后层/文字），对成品零影响——纯"先大概、再细节"的节奏。
    const blockInLayer = (L, ph) => {
      const f = lFull[L];
      const ax = lAx[L], ay = lAy[L], cx = lCx[L], cy = lCy[L];
      const span = spanOf(f, ax, ay, cx, cy);
      if (!(span.tmax > span.tmin) || !(span.vmax > 0)) return;
      const px2 = -ay, py2 = ax;
      const vHalf = Math.max(1, span.vmax);
      const ext0 = vHalf * 2;
      let bwid = clamp(ext0 * opts.bwF * 2.2,
                       opts.bwMin * strokeScale * 2, opts.bwMax * strokeScale * 1.6) * LV.brush;
      const ext = ext0 + bwid * 0.5;
      let nP = Math.max(1, Math.ceil(ext / (bwid * 0.8)));
      if (nP > 4) nP = 4;
      const tPen = (lastPenX - cx) * ax + (lastPenY - cy) * ay;
      const fromPlus = tPen > 0;
      const curPos = posOf[L];
      const okPx = layerSketchOK(L);
      const VIS = LV.visTol;
      const coverMin = opts.coverMin || 0.7;
      for (let k = 0; k < nP; k++) {
        const pi = fromPlus ? (nP - 1 - k) : k;
        const dir = ((k % 2 === 0) !== fromPlus) ? 1 : -1;
        const seed = L * 104729 + pi * 15485863 + k * 97;
        const v = -vHalf - bwid * 0.25 + (pi + 0.5) * (ext / nP);
        const e0 = (rand01(seed, 5) - 0.35) * 5, e1 = (rand01(seed, 7) - 0.35) * 5;
        const tA = dir > 0 ? span.tmin - 2 - e0 : span.tmax + 2 + e1;
        const tB = dir > 0 ? span.tmax + 2 + e1 : span.tmin - 2 - e0;
        const wobPh = rand01(seed, 1) * 6.283, bowP = bwid * 0.05 * (rand01(seed, 3) > 0.5 ? 1 : -1);
        const path = new Float64Array(12);
        for (let s = 0; s < 6; s++) {
          const fr = s / 5;
          const tt = tA + (tB - tA) * fr;
          const off = v + Math.sin(wobPh + fr * 2.4) * bwid * 0.04 + bowP * Math.sin(Math.PI * fr);
          path[s * 2] = cx + ax * tt + px2 * off;
          path[s * 2 + 1] = cy + ay * tt + py2 * off;
        }
        const rib = ribbon(path, 6, bwid / 2);
        let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
        for (let i = 0; i < rib.length; i += 2) {
          const x = rib[i], y = rib[i + 1];
          if (x < xmin) xmin = x; if (x > xmax) xmax = x;
          if (y < ymin) ymin = y; if (y > ymax) ymax = y;
        }
        const bx = Math.max(0, Math.floor(xmin)), by = Math.max(0, Math.floor(ymin));
        const ex = Math.min(W - 1, Math.ceil(xmax)), ey = Math.min(H - 1, Math.ceil(ymax));
        if (ex < bx || ey < by) continue;
        const w2 = ex - bx + 1, h2 = ey - by + 1;
        const cv = new Float32Array(w2 * h2);
        const pts = new Float64Array(rib.length);
        for (let i = 0; i < rib.length; i += 2) { pts[i] = rib[i] - bx; pts[i + 1] = rib[i + 1] - by; }
        fillPolyCov(cv, w2, h2, pts, opts.coverSubY || 1);
        // 认领：本档光栅 ∩ 许可像素，按 t 排队切段
        const px = [];
        for (let y = 0; y < h2; y++) {
          const rowC = y * w2;
          for (let x = 0; x < w2; x++) {
            if (cv[rowC + x] < coverMin) continue;
            const gx = bx + x, gy = by + y;
            if (!okPx(gx, gy)) continue;
            px.push((gx - cx) * ax + (gy - cy) * ay, gx, gy);
          }
        }
        if (!px.length) continue;
        const idx = [];
        for (let i = 0; i < px.length; i += 3) idx.push(i);
        idx.sort((u, w3) => px[u] - px[w3]);
        const joinT = bwid * 1.5;
        const runs = [];
        let seg = null;
        for (const i of idx) {
          const t = px[i], x = px[i + 1], y = px[i + 2], p = y * W + x;
          if (!seg || t - seg.t1 > joinT) {
            seg = { t0: t, t1: t, px: [], n: 0, sr: 0, sg: 0, sb: 0,
                    mn0: 255, mn1: 255, mn2: 255, mx0: 0, mx1: 0, mx2: 0 };
            runs.push(seg);
          } else seg.t1 = t;
          seg.px.push(x, y);
          seg.n++; seg.sr += R[p]; seg.sg += G[p]; seg.sb += B[p];
          const r0 = R[p], g0 = G[p], b0 = B[p];
          if (r0 < seg.mn0) seg.mn0 = r0; if (r0 > seg.mx0) seg.mx0 = r0;
          if (g0 < seg.mn1) seg.mn1 = g0; if (g0 > seg.mx1) seg.mx1 = g0;
          if (b0 < seg.mn2) seg.mn2 = b0; if (b0 > seg.mx2) seg.mx2 = b0;
        }
        // 松并段：范围 ≤ 4×容差就接着画（打形不抠细节），颜色取段均值
        const mergeR = 4 * VIS;
        for (let i = 1; i < runs.length; i++) {
          const A = runs[i - 1], Bc = runs[i];
          if (Bc.t0 - A.t1 > joinT) continue;
          if (Math.max(A.mx0, Bc.mx0) - Math.min(A.mn0, Bc.mn0) > mergeR) continue;
          if (Math.max(A.mx1, Bc.mx1) - Math.min(A.mn1, Bc.mn1) > mergeR) continue;
          if (Math.max(A.mx2, Bc.mx2) - Math.min(A.mn2, Bc.mn2) > mergeR) continue;
          for (let j = 0; j < Bc.px.length; j++) A.px.push(Bc.px[j]);
          A.t1 = Math.max(A.t1, Bc.t1);
          A.n += Bc.n; A.sr += Bc.sr; A.sg += Bc.sg; A.sb += Bc.sb;
          if (Bc.mn0 < A.mn0) A.mn0 = Bc.mn0; if (Bc.mx0 > A.mx0) A.mx0 = Bc.mx0;
          if (Bc.mn1 < A.mn1) A.mn1 = Bc.mn1; if (Bc.mx1 > A.mx1) A.mx1 = Bc.mx1;
          if (Bc.mn2 < A.mn2) A.mn2 = Bc.mn2; if (Bc.mx2 > A.mx2) A.mx2 = Bc.mx2;
          runs.splice(i, 1); i--;
        }
        const span2 = tB - tA;
        for (const run of runs) {
          if (!run.px.length) continue;
          let bx0 = W, by0 = H, bx1 = -1, by1 = -1;
          for (let i = 0; i < run.px.length; i += 2) {
            const x = run.px[i], y = run.px[i + 1];
            if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
            if (y < by0) by0 = y; if (y > by1) by1 = y;
          }
          const mw = bx1 - bx0 + 1, mh = by1 - by0 + 1;
          const mk = new Uint8Array(mw * mh);
          for (let i = 0; i < run.px.length; i += 2) mk[(run.px[i + 1] - by0) * mw + (run.px[i] - bx0)] = 1;
          const rrect = [bx0, by0, bx1 + 1, by0, bx1 + 1, by1 + 1, bx0, by1 + 1];
          const cIdx = pushClip(bx0, by0, mw, mh, mk);
          const col = [Math.round(run.sr / run.n), Math.round(run.sg / run.n), Math.round(run.sb / run.n)];
          const u0 = span2 > 0 ? clamp((run.t0 - 2 - tA) / span2, 0, 1) : 0;
          const u1 = span2 > 0 ? clamp((run.t1 + 2 - tA) / span2, 0, 1) : 1;
          const tp = new Array(12);
          for (let s = 0; s < 6; s++) {
            const fr = u0 + (u1 - u0) * (s / 5);
            const tt = tA + span2 * fr;
            const off = v + Math.sin(wobPh + fr * 2.4) * bwid * 0.04 + bowP * Math.sin(Math.PI * fr);
            tp[s * 2] = cx + ax * tt + px2 * off;
            tp[s * 2 + 1] = cy + ay * tt + py2 * off;
          }
          emit(rrect, tp, bwid / 2, col, 0, cIdx, ph, L, true);
        }
      }
    };

    // ============ 层内宽笔扫：旧 paintSweep 笔形（沿层主轴一档档重叠扫、手抖 + 弓弯 +
    // 出锋 + 出界笔 + 就近起笔），落墨掩膜 = 笔形光栅 ∩ 块像素，颜色 = 块色 ⇒ 观感照旧、成品精确。
    const sweepLayer = (L, ph) => {
      const isBase = L === base;
      const full = lFull[L];
      const ax = isBase ? (W >= H ? 1 : 0) : lAx[L];
      const ay = isBase ? (W >= H ? 0 : 1) : lAy[L];
      const cx = isBase ? W * 0.5 : lCx[L], cy = isBase ? H * 0.5 : lCy[L];
      const span = spanOf(full, ax, ay, cx, cy);
      const rtmin = span.tmin, rtmax = span.tmax;
      if (!(rtmax > rtmin) && !(span.vmax > 0)) {
        // 退化层（单像素/共线碎屑）：没有可扫的带宽，整层退回中轴笔
        for (const gi of lThick[L]) skeletonStroke(gi, ph, L);
        return;
      }
      const vHalf = Math.max(1, span.vmax);
      const ext0 = vHalf * 2;
      let bwid = clamp(ext0 * opts.bwF, opts.bwMin * strokeScale, opts.bwMax * strokeScale) * LV.brush;
      // 窄的一层不抖：宽度本来就窄，抖一点边就花了（黑框/细条带就是这么变坑洼的）
      const thinF = clamp(vHalf / 22, 0.25, 1);
      const wobA = (opts.organic ? Math.min(2.8, bwid * 0.13) : Math.min(2.6, bwid * 0.1)) * thinF;
      const bowA = (opts.organic ? Math.min(2.4, bwid * 0.11) : 0) * thinF;
      const dev = wobA + bowA;
      const ext = ext0 + 2 * dev;
      let nP = Math.max(1, Math.ceil(ext / (bwid * opts.coverOv)));
      if (nP > 24) { nP = 24; bwid = Math.max(bwid, ext / (nP * opts.coverOv)); }
      const px2 = -ay, py2 = ax;
      const wobPh = rand01(L * 7919 + 13, 1) * 6.283;
      const wobW = 2.2 + 2.6 * rand01(L * 7919 + 41, 9);
      const bowDir = rand01(L * 7919 + 29, 3) > 0.5 ? 1 : -1;
      // 起笔端跟着笔尖走：手在哪儿就从哪头下笔（就近串笔）
      const tPen = (lastPenX - cx) * ax + (lastPenY - cy) * ay;
      const fromPlus = tPen > 0;
      const bleedRad = Math.max(1, Math.round((opts.bleedR || 1) * strokeScale));
      const allowBleed = opts.bleedP > 0 && lArea[L] >= 1200 && !isBase;
      const curPos = posOf[L];
      const passes = [];
      for (let k = 0; k < nP; k++) {
        const pi = fromPlus ? (nP - 1 - k) : k;
        const dir = ((k % 2 === 0) !== fromPlus) ? 1 : -1;
        const seed = L * 7919 + pi * 104729 + k * 15485863;
        const v = -vHalf - dev + (pi + 0.5) * (ext / nP);
        const bwidP = opts.organic ? bwid * (0.9 + 0.2 * rand01(seed, 11)) : bwid;
        const wobPhP = wobPh + (rand01(seed, 1) - 0.5) * 0.7;
        const bowP = opts.organic ? bowA * bowDir * (0.7 + 0.6 * rand01(seed, 3)) : 0;
        // 两端出锋：真起收笔会扫出形状一点
        const e0 = opts.organic ? (rand01(seed, 5) - 0.35) * 5 : 3;
        const e1 = opts.organic ? (rand01(seed, 7) - 0.35) * 5 : 3;
        const tA = dir > 0 ? rtmin - 2 - e0 : rtmax + 2 + e1;
        const tB = dir > 0 ? rtmax + 2 + e1 : rtmin - 2 - e0;
        const nseg = 6;
        const path = new Float64Array(nseg * 2);
        for (let s = 0; s < nseg; s++) {
          const f = nseg > 1 ? s / (nseg - 1) : 0;
          const tt = tA + (tB - tA) * f;
          const off = v + wobA * Math.sin(wobPhP + f * wobW) + bowP * Math.sin(Math.PI * f);
          path[s * 2] = cx + ax * tt + px2 * off;
          path[s * 2 + 1] = cy + ay * tt + py2 * off;
        }
        passes.push({
          path, n: nseg, half: bwidP / 2, tA, tB, v, bwidP, wobPhP, bowP,
          bleed: allowBleed && rand01(seed, 13) < opts.bleedP, extra: null,
        });
      }

      const fx0 = full.x0, fy0 = full.y0, fw = full.w, fh = full.h;
      const coverMin = opts.coverMin || 0.7;
      const rasterPass = (ps, halfExt) => {
        const rib = ribbon(ps.path, ps.n, halfExt);
        let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
        for (let i = 0; i < rib.length; i += 2) {
          const x = rib[i], y = rib[i + 1];
          if (x < xmin) xmin = x; if (x > xmax) xmax = x;
          if (y < ymin) ymin = y; if (y > ymax) ymax = y;
        }
        const bx = Math.max(fx0, Math.floor(xmin)), by = Math.max(fy0, Math.floor(ymin));
        const ex = Math.min(fx0 + fw - 1, Math.ceil(xmax)), ey = Math.min(fy0 + fh - 1, Math.ceil(ymax));
        if (ex < bx || ey < by) return null;
        const w2 = ex - bx + 1, h2 = ey - by + 1;
        const cv = new Float32Array(w2 * h2);
        const pts = new Float64Array(rib.length);
        for (let i = 0; i < rib.length; i += 2) { pts[i] = rib[i] - bx; pts[i + 1] = rib[i + 1] - by; }
        fillPolyCov(cv, w2, h2, pts, opts.coverSubY || 1);
        return { bx, by, w2, h2, cv };
      };

      // 联合覆盖自检（旧 sweepSeal）：所有档合起来先光栅一遍，漏掉的像素就地加宽
      // 最近的档（不新增笔画）；加宽到底还漏的，落笔时并给最近的档。底色层要求盖满
      // 整幅非纸底；其它层只要求盖住自己的厚块像素（细块走中轴笔）。
      const coveredT = new Uint8Array(fw * fh);
      const markRaster = (r) => {
        if (!r) return;
        for (let y = 0; y < r.h2; y++) {
          const rowC = y * r.w2, rowT = (r.by + y - fy0) * fw;
          for (let x = 0; x < r.w2; x++) {
            if (r.cv[rowC + x] < coverMin) continue;
            coveredT[rowT + (r.bx + x - fx0)] = 1;
          }
        }
      };
      const isTarget = (p) => isBase ? !paperLab[p] : thickOfBlob[chosen.cOf[p]] === L;
      const scanGaps = (out) => {
        for (let y = 0; y < fh; y++) {
          const rowT = y * fw, rowP = (fy0 + y) * W + fx0;
          for (let x = 0; x < fw; x++) {
            if (coveredT[rowT + x]) continue;
            if (isTarget(rowP + x)) out.push(x, y);
          }
        }
      };
      const nearestPass = (gx, gy) => {
        let best = -1, bd = Infinity;
        for (let pi2 = 0; pi2 < passes.length; pi2++) {
          const ps = passes[pi2];
          for (let i = 0; i < ps.n; i++) {
            const dx = ps.path[i * 2] - gx, dy = ps.path[i * 2 + 1] - gy;
            const d = dx * dx + dy * dy;
            if (d < bd) { bd = d; best = pi2; }
          }
        }
        return { best, bd };
      };
      for (const ps of passes) markRaster(rasterPass(ps, ps.half));
      for (let it = 0; it < 3; it++) {
        const gaps = [];
        scanGaps(gaps);
        if (!gaps.length) break;
        const dirty = new Set();
        for (let gi2 = 0; gi2 < gaps.length; gi2 += 2) {
          const near = nearestPass(gaps[gi2] + fx0, gaps[gi2 + 1] + fy0);
          if (near.best < 0) continue;
          const ps = passes[near.best];
          const need = Math.sqrt(near.bd) + 0.9 * strokeScale;
          if (need > ps.half && need <= ext0 * 2.5) { ps.half = need; dirty.add(near.best); }
        }
        if (!dirty.size) break;
        for (const pi2 of dirty) markRaster(rasterPass(passes[pi2], passes[pi2].half));
      }
      {
        const gaps = [];
        scanGaps(gaps);
        for (let gi2 = 0; gi2 < gaps.length; gi2 += 2) {
          const near = nearestPass(gaps[gi2] + fx0, gaps[gi2 + 1] + fy0);
          if (near.best < 0) continue;
          const ps = passes[near.best];
          if (!ps.extra) ps.extra = [];
          ps.extra.push((fy0 + gaps[gi2 + 1]) * W + fx0 + gaps[gi2]);
        }
      }

      // 落笔：每档光栅 → 按"归属块"切段（颜色 = 块色），同色相邻段并成一条连续长笔；
      // 底色层的扫带把整幅非纸底都认下（主体底下的 under-coat 用邻近底色），非底色层
      // 的出界像素只压在"排在自己后面"的层上（它们稍后被自己的笔盖回来）。
      for (let pi2 = 0; pi2 < passes.length; pi2++) {
        const ps = passes[pi2];
        const rMain = rasterPass(ps, ps.half);
        const rBleed = ps.bleed ? rasterPass(ps, ps.half + bleedRad) : null;
        const tMin = rtmin - 8, nB = Math.max(1, Math.ceil((rtmax - rtmin + 16) / 8));
        const ownPx = new Map(), guestPx = new Map();
        const take = (x, y) => {
          const p = y * W + x;
          if (paperLab[p]) return;
          const t = (x - cx) * ax + (y - cy) * ay;
          const bk = clamp(((t - tMin) / 8) | 0, 0, nB - 1);
          const b = chosen.cOf[p];
          if (isBase ? lId[b] === L : thickOfBlob[b] === L) {
            let a = ownPx.get(b);
            if (!a) { a = []; ownPx.set(b, a); }
            a.push(t, x, y);
          } else if (isBase || (ps.bleed && cOfPos[p] > curPos)) {
            let a = guestPx.get(bk);
            if (!a) { a = []; guestPx.set(bk, a); }
            a.push(t, x, y);
          }
        };
        const grab = (r) => {
          if (!r) return;
          for (let y = 0; y < r.h2; y++) {
            const gy = r.by + y, rowC = y * r.w2;
            for (let x = 0; x < r.w2; x++) {
              if (r.cv[rowC + x] >= coverMin) take(r.bx + x, gy);
            }
          }
        };
        grab(rMain);
        grab(rBleed);
        if (ps.extra) for (const p of ps.extra) { const x = p % W, y = (p - x) / W; take(x, y); }
        if (!ownPx.size) continue;
        // 按 t 排序切段（跳得比一条笔宽远 = 另起一笔；底色层再按 ~56px 强制短分段，
        // 旧 segLenOverride：让渐变/暗角在铺底时就有局部色，不是整幅宽的平色条）。
        // 段颜色 = 段内**归属像素**的约束均值（clamp 进 [max-V, min+V]）：相邻段只在
        // "并完每通道范围 ≤ V" 时才并成一条长笔 —— 数学上保证段内每个像素 ≤ V。
        const segLen = Math.max(24, Math.round(56 * strokeScale));
        const runs = [];
        for (const [b, a] of ownPx) {
          const idx = [];
          for (let i = 0; i < a.length; i += 3) idx.push(i);
          idx.sort((u, w3) => a[u] - a[w3]);
          const joinT = ps.bwidP * 1.6;
          let seg = null;
          for (const i of idx) {
            const t = a[i], x = a[i + 1], y = a[i + 2], p = y * W + x;
            if (!seg || t - seg.t1 > joinT || (isBase && t - seg.t0 >= segLen)) {
              seg = { t0: t, t1: t, px: [], n: 0, sr: 0, sg: 0, sb: 0,
                      mn0: 255, mn1: 255, mn2: 255, mx0: 0, mx1: 0, mx2: 0 };
              runs.push(seg);
            } else seg.t1 = t;
            seg.px.push(x, y);
            seg.n++; seg.sr += R[p]; seg.sg += G[p]; seg.sb += B[p];
            const r0 = R[p], g0 = G[p], b0 = B[p];
            if (r0 < seg.mn0) seg.mn0 = r0; if (r0 > seg.mx0) seg.mx0 = r0;
            if (g0 < seg.mn1) seg.mn1 = g0; if (g0 > seg.mx1) seg.mx1 = g0;
            if (b0 < seg.mn2) seg.mn2 = b0; if (b0 > seg.mx2) seg.mx2 = b0;
          }
        }
        // 相邻段并长笔：t 接得上 且 并完每通道范围 ≤ 2V（可行域上限：并完的约束均值
        // clamp 进 [max-V, min+V] 后，段内每个像素仍然 ≤ V）。渐变/强噪处范围超了就自然
        // 分段——碎块能并则并，笔数才压得下来。
        runs.sort((u, w3) => u.t0 - w3.t0);
        const VIS = LV.visTol;
        const mergeR = 2 * VIS;
        for (let i = 1; i < runs.length; i++) {
          const A = runs[i - 1], Bc = runs[i];
          if (Bc.t0 - A.t1 > ps.bwidP * 1.6) continue;
          if (Math.max(A.mx0, Bc.mx0) - Math.min(A.mn0, Bc.mn0) > mergeR) continue;
          if (Math.max(A.mx1, Bc.mx1) - Math.min(A.mn1, Bc.mn1) > mergeR) continue;
          if (Math.max(A.mx2, Bc.mx2) - Math.min(A.mn2, Bc.mn2) > mergeR) continue;
          for (let j = 0; j < Bc.px.length; j++) A.px.push(Bc.px[j]);
          A.t1 = Math.max(A.t1, Bc.t1);
          A.n += Bc.n; A.sr += Bc.sr; A.sg += Bc.sg; A.sb += Bc.sb;
          if (Bc.mn0 < A.mn0) A.mn0 = Bc.mn0; if (Bc.mx0 > A.mx0) A.mx0 = Bc.mx0;
          if (Bc.mn1 < A.mn1) A.mn1 = Bc.mn1; if (Bc.mx1 > A.mx1) A.mx1 = Bc.mx1;
          if (Bc.mn2 < A.mn2) A.mn2 = Bc.mn2; if (Bc.mx2 > A.mx2) A.mx2 = Bc.mx2;
          runs.splice(i, 1); i--;
        }
        // guest（底色的 under-coat / 出界压色）寄给 t 区间盖住它的段；没盖住就寄最近段
        {
          const gi2 = new Int32Array(nB).fill(-1);
          let rp = 0;
          for (let bk = 0; bk < nB; bk++) {
            const bt = tMin + bk * 8 + 4;
            while (rp + 1 < runs.length && runs[rp + 1].t0 <= bt) rp++;
            let best = -1, bd = Infinity;
            for (let r3 = Math.max(0, rp - 1); r3 <= Math.min(runs.length - 1, rp + 1); r3++) {
              const d = bt < runs[r3].t0 ? runs[r3].t0 - bt : (bt > runs[r3].t1 ? bt - runs[r3].t1 : 0);
              if (d < bd) { bd = d; best = r3; }
            }
            gi2[bk] = best;
          }
          for (const [bk, a] of guestPx) {
            const r3 = runs[gi2[bk]];
            if (!r3) continue;
            for (let i = 0; i < a.length; i += 3) r3.px.push(a[i + 1], a[i + 2]);
          }
        }
        // 每段一笔：掩膜 = 段像素（bbox 局部 1 位），rib = 整数外框矩形，
        // tp = 沿档中心线取该段 t 范围的 6 点子路径（手抖/弓弯延续）。
        const span2 = ps.tB - ps.tA;
        for (const run of runs) {
          if (!run.px.length) continue;
          let bx0 = W, by0 = H, bx1 = -1, by1 = -1;
          for (let i = 0; i < run.px.length; i += 2) {
            const x = run.px[i], y = run.px[i + 1];
            if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
            if (y < by0) by0 = y; if (y > by1) by1 = y;
          }
          const mw = bx1 - bx0 + 1, mh = by1 - by0 + 1;
          const mk = new Uint8Array(mw * mh);
          for (let i = 0; i < run.px.length; i += 2) mk[(run.px[i + 1] - by0) * mw + (run.px[i] - bx0)] = 1;
          const rib = [bx0, by0, bx1 + 1, by0, bx1 + 1, by1 + 1, bx0, by1 + 1];
          const cIdx = pushClip(bx0, by0, mw, mh, mk);
          const col = [
            clamp(Math.round(run.sr / run.n), Math.max(0, run.mx0 - VIS), Math.min(255, run.mn0 + VIS)),
            clamp(Math.round(run.sg / run.n), Math.max(0, run.mx1 - VIS), Math.min(255, run.mn1 + VIS)),
            clamp(Math.round(run.sb / run.n), Math.max(0, run.mx2 - VIS), Math.min(255, run.mn2 + VIS)),
          ];
          const u0 = span2 > 0 ? clamp((run.t0 - 2 - ps.tA) / span2, 0, 1) : 0;
          const u1 = span2 > 0 ? clamp((run.t1 + 2 - ps.tA) / span2, 0, 1) : 1;
          const tp = new Array(12);
          for (let s = 0; s < 6; s++) {
            const f = u0 + (u1 - u0) * (s / 5);
            const tt = ps.tA + span2 * f;
            const off = ps.v + wobA * Math.sin(ps.wobPhP + f * wobW) + ps.bowP * Math.sin(Math.PI * f);
            tp[s * 2] = cx + ax * tt + px2 * off;
            tp[s * 2 + 1] = cy + ay * tt + py2 * off;
          }
          emit(rib, tp, ps.half, col, 0, cIdx, ph, L);
        }
      }
    };

    // ============ 逐层落笔：底色层(ph0) → 大层(ph1) → 小层(ph2)，每层"勾形 → 打形 → 收拾"，
    // 细长层整层走中轴笔 ============
    Tms.layers = Date.now() - tL0;
    const tS0 = Date.now();
    let sweepMs = 0;
    const layerSketchOn = opts.layerSketch !== false;
    // 勾形只给最大的几个主体层（人打形只勾主要轮廓，小碎层勾了就是碎屑线）
    const skLayers = new Set();
    if (layerSketchOn) {
      const big = [];
      for (let L = 0; L < nL; L++) {
        if (L === base || lLinear[L] || lArea[L] < 6 * minAbs) continue;
        const f = lFull[L];
        if (f.w * f.h > N * 0.5) continue;
        big.push(L);
      }
      big.sort((a, b) => lArea[b] - lArea[a]);
      for (let k = 0; k < Math.min(16, big.length); k++) skLayers.add(big[k]);
    }
    // 打形粗笔给够大的层：层太碎的图（照片）只给更大的层，小纹理层本身就是细节
    const biMinA = (nL > 600 ? 6 : 3) * minAbs;
    for (const L of paintOrder) {
      const ph = lPh[L];
      if (lLinear[L]) {
        for (const gi of lMembers[L]) skeletonStroke(gi, ph, L);
        continue;
      }
      if (skLayers.has(L)) {
        const f = lFull[L];
        sketchOn({ x0: f.x0, y0: f.y0, w: f.w, h: f.h, m: ringOf(f) },
                 layerSketchOK(L), ph, opts.layerSketchMax || 2);
      }
      if (L !== base && lArea[L] >= biMinA && opts.blockIn !== false) blockInLayer(L, ph);
      for (const gi of lThick[L]) thickOfBlob[gi] = L;
      if (lThick[L].length) { const s0 = Date.now(); sweepLayer(L, ph); sweepMs += Date.now() - s0; }
      for (const gi of lThin[L]) skeletonStroke(gi, ph, L);
    }

    // 点睛/落款：细线、文字块最后按行写（旧"题字落款"）
    {
      const pens = [];
      for (let gi = 0; gi < G_; gi++) if (isPenBlob[gi]) pens.push(gi);
      const rowH = Math.max(8, 24 * strokeScale);
      pens.sort((a, b) => {
        const ra = Math.floor(chosen.rsy[a] / chosen.rn[a] / rowH);
        const rb = Math.floor(chosen.rsy[b] / chosen.rn[b] / rowH);
        if (ra !== rb) return ra - rb;
        return (chosen.rsx[a] / chosen.rn[a]) - (chosen.rsx[b] / chosen.rn[b]);
      });
      for (const gi of pens) skeletonStroke(gi, 3, -1);
      if (pens.length && strokes.length) strokes[strokes.length - 1].fin = 1;
    }
    Tms.sweep = sweepMs;
    Tms.emit = Date.now() - tS0;

    const buildMs = Date.now() - t0;
    if (opts.debug) console.log('[cover-timing]', JSON.stringify(Tms));
    prog(0.66, '落笔… ' + strokes.length + ' 笔');
    await yieldUI();

    // 规划重放：纸底算已覆盖；其余逐笔落色，算 vis / 关键帧 / 质量
    const t1 = Date.now();
    const canvas = new Uint8Array(N * 3);
    canvas.fill(255);
    const covered = new Uint8Array(N);
    for (let p = 0; p < N; p++) if (chosen.paper[chosen.cOf[p]]) covered[p] = 1;
    const keysOut = [];
    const kEvery = Math.max(1, Math.ceil(strokes.length / (opts.keyFrames || 5)));
    let maxErr = 0, sumErr = 0, gt8 = 0, gt24 = 0, gt48 = 0;
    for (let si = 0; si < strokes.length; si++) {
      const st = strokes[si], cl = clips[st.c], m = cl.mask, col = st.color;
      let visSum = 0;
      for (let y = 0; y < cl.h; y++) {
        const row = (cl.y + y) * W + cl.x, mr = y * cl.w;
        for (let x = 0; x < cl.w; x++) {
          if (!m[mr + x]) continue;
          const p = row + x, q = p * 3;
          const dr = Math.abs(canvas[q] - col[0]);
          const dg = Math.abs(canvas[q + 1] - col[1]);
          const db = Math.abs(canvas[q + 2] - col[2]);
          const d = dr > dg ? (dr > db ? dr : db) : (dg > db ? dg : db);
          visSum += d;
          canvas[q] = col[0]; canvas[q + 1] = col[1]; canvas[q + 2] = col[2];
          covered[p] = 1;
        }
      }
      st.vis = visSum;
      if ((si + 1) % kEvery === 0) keysOut.push({ i: si + 1, rgb: canvas.slice(), cov: covered.slice() });
    }
    let uncovered = 0;
    for (let p = 0; p < N; p++) {
      if (!covered[p]) {
        uncovered++;
        if (opts.debug && uncovered <= 6) {
          const b = chosen.cOf[p];
          console.log('[unc]', p % W, (p - p % W) / W, 'blob', b, 'n', chosen.rn[b],
            'pen', isPenBlob[b], 'paper', chosen.paper[b], 'layer', lId[b],
            'lThickHas', lId[b] >= 0 ? lThick[lId[b]].includes(b) : '-',
            'lThinHas', lId[b] >= 0 ? lThin[lId[b]].includes(b) : '-',
            'lLinear', lId[b] >= 0 ? lLinear[lId[b]] : '-');
        }
      }
      const q = p * 3;
      const dr = Math.abs(canvas[q] - R[p]);
      const dg = Math.abs(canvas[q + 1] - G[p]);
      const db = Math.abs(canvas[q + 2] - B[p]);
      const d = dr > dg ? (dr > db ? dr : db) : (dg > db ? dg : db);
      sumErr += d;
      if (d > maxErr) maxErr = d;
      if (d > 8) gt8++;
      if (d > 24) gt24++;
      if (d > 48) gt48++;
    }
    if (!keysOut.length || keysOut[keysOut.length - 1].i !== strokes.length) {
      keysOut.push({ i: strokes.length, rgb: canvas.slice(), cov: covered.slice() });
    }
    const replayMs = Date.now() - t1;
    if (opts.debug) {
      let leakN = 0, leakSum = 0;
      for (let p = 0; p < N; p++) {
        const q = p * 3;
        const col = chosen.colors[chosen.cOf[p]];
        const d = Math.max(Math.abs(canvas[q] - col[0]), Math.abs(canvas[q + 1] - col[1]), Math.abs(canvas[q + 2] - col[2]));
        if (d > 0) { leakN++; leakSum += d; }
      }
      console.log('[cover-leak] final != own blob color: pixels', leakN, 'sum', leakSum);
    }

    let tot = 0;
    for (const st of strokes) tot += st.ms;
    const k = tot > 0 ? (opts.targetSec * 1000) / tot : 1;
    for (const st of strokes) st.ms = Math.round(Math.max(6, st.ms * k) * 10) / 10;

    const quality = {
      tolerance: LV.visTol, bucketT: chosen.palT, max: maxErr, mean: +(sumErr / N).toFixed(3),
      gt8: +(gt8 / N * 100).toFixed(3), gt24: +(gt24 / N * 100).toFixed(3),
      gt48: +(gt48 / N * 100).toFixed(3), uncovered,
      regions: G_, colorRegions: G_, inkRegions: 0,
    };
    const phases = [0, 1, 2, 3].map((ph) => strokes.filter((s) => s.ph === ph).length);
    const info = {
      mode: 'cover', level: fid, tolerance: LV.visTol, palT: chosen.palT,
      maxBlob: LV.maxBlob, brush: LV.brush, regions: G_, paperPx: chosen.paperPx,
      bands: strokes.length, maskBytes: maskPx, buildMs, replayMs,
      max: maxErr, mean: quality.mean, gt8: quality.gt8, gt24: quality.gt24,
      gt48: quality.gt48, uncovered, thinCalls, strokes: strokes.length,
    };
    if (opts.debug) console.log('[cover] L' + fid + ' palT=' + chosen.palT + ' blobs=' + G_ +
      ' strokes=' + strokes.length + ' max=' + maxErr + ' mean=' + quality.mean +
      ' >8=' + quality.gt8 + '% >24=' + quality.gt24 + '% uncovered=' + uncovered);
    prog(1.0, '完成');
    return {
      W, H, strokes, clips,
      canvasRgb: opts.returnCanvas ? canvas : undefined,
      keys: opts.returnKeys ? keysOut : undefined,
      palette: undefined,
      dbg: opts.debug ? { cover: info, marks: [{ tag: '颜色块', n: G_ }] } : undefined,
      probe: undefined,
      stats: {
        regions: G_, inkGroups: 0, strokes: strokes.length,
        totalMs: strokes.reduce((a, s) => a + s.ms, 0),
        phases, colors: opts.colors || 0, photo: false, style: opts.style,
        detail: opts.detail, fidelity: fid, quality,
      },
    };
  }
  // ================= pyramid mode：整幅逐级细化（16 → 8 → 4 → 2 → 1） =================
  // 与 cover mode 并列的第二种算法（opts.algo = 'pyramid'）：
  //   1) 第一级整幅画一张"宽笔 + 宽容差"的粗稿（16px）：不求像素准，只求大色块和画面完整；
  //   2) 之后每一级只把"当前画布与目标差 > 本级容差"的像素交给 8px/4px/2px/1px 的笔重画，
  //      平坦且已经够准的地方不重复落笔；
  //   3) 最后一级容差 = 档位容差 V，颜色区按"并完每通道跨度 ≤ 2V"构建、段色取约束均值，
  //      数学上保证每个非纸底像素误差 ≤ V；第一级已覆盖全部非纸底像素，uncovered 恒为 0。
  // 粗稿不是低分辨率马赛克：颜色区仍在原分辨率上按颜色生长，只是容差松、笔宽大；
  // 笔触的落墨形状随色区走，不会出现方格网格。
  async function runPyramidMode(px, W, H, opts, onProgress) {
    const N = W * H;
    const prog = (p, msg) => { if (onProgress) onProgress(p, msg); };
    const yieldUI = () => new Promise((r) => setTimeout(r, 0));
    const R = new Uint8Array(N), G = new Uint8Array(N), B = new Uint8Array(N);
    for (let i = 0, p = 0; i < N; i++, p += 4) { R[i] = px[p]; G[i] = px[p + 1]; B[i] = px[p + 2]; }
    const fid = Math.max(1, Math.min(5, opts.fidelity | 0));
    const LV = [
      { palT: 16, visTol: 24, maxBlob: 6000, brush: 1.40 },
      { palT: 14, visTol: 20, maxBlob: 4000, brush: 1.20 },
      { palT: 12, visTol: 16, maxBlob: 2500, brush: 1.00 },
      { palT: 10, visTol: 12, maxBlob: 1200, brush: 0.85 },
      { palT: 8,  visTol: 8,  maxBlob: 600,  brush: 0.70 },
    ][fid - 1];
    const V = LV.visTol;
    const styleW = opts.style === 'pencil' ? 0.82 : (opts.style === 'oil' ? 1.14 : 1);
    const t0 = Date.now();

    // 纸底：从四边泛洪"近白且连通到边"的像素；纸底不画，回放保持白纸（与 cover 口径一致）。
    const paper = new Uint8Array(N);
    let paperPx = 0;
    {
      const q = new Int32Array(N);
      let head = 0, tail = 0;
      const push = (p) => {
        if (paper[p]) return;
        if (R[p] < 248 || G[p] < 248 || B[p] < 248) return;
        paper[p] = 1; q[tail++] = p;
      };
      for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
      for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
      while (head < tail) {
        const p = q[head++]; paperPx++;
        const x = p % W, y = (p - x) / W;
        if (x > 0) push(p - 1);
        if (x + 1 < W) push(p + 1);
        if (y > 0) push(p - W);
        if (y + 1 < H) push(p + W);
      }
    }

    // 笔刷阶梯：每一级都把整幅重画一遍。起稿 64px 大刷（旧版铺底色约 68px，
    // 16px 在 1024 图上只有一根铅笔线宽），之后 16/8/4/2/1 逐级变小；
    // 档位决定停在哪一级（①停 16、②停 8、③停 4、④停 2、⑤停 1）。
    // 1024 级别按字面值，更大的图按短边同比放大。
    const brushSizes = [64, 16, 8, 4, 2, 1];
    const m = fid + 1;
    const scaleB = Math.max(1, Math.min(W, H) / 1024);
    const brushPx = (k) => Math.max(1, Math.round(brushSizes[k] * scaleB));
    const finalS = brushPx(m - 1);
    // 中间级容差从 48 线性降到 V（严格递减）：每一级都有活干，最后一级正好收到 V。
    const tolOf = (k) => {
      if (m <= 1) return V;
      const u = (m - 1 - k) / (m - 1);
      return Math.max(V, Math.round(V + (48 - V) * u));
    };

    const canvas = new Uint8Array(N * 3);
    canvas.fill(255);
    const strokes = [], clips = [];
    let maskPx = 0;
    const pushClip = (x, y, w, h, mask) => {
      maskPx += w * h;
      clips.push({ x, y, w, h, mask });
      return clips.length - 1;
    };
    const emit = (rib, tp, halfW, color, pen, cIdx, ph, fast) => {
      let len = 0;
      for (let i = 1; i < tp.length / 2; i++) {
        len += Math.hypot(tp[i * 2] - tp[(i - 1) * 2], tp[i * 2 + 1] - tp[(i - 1) * 2 + 1]);
      }
      // 节奏照旧版：第一级最轻快，越到后面越慢；每笔再有点起伏，白色一笔带过。
      let weight;
      if (ph === 0) weight = 8 + len * 1.0;
      else if (ph === 3) weight = 26 + len * 2.6;
      else if (ph === 2) weight = 18 + len * 2.2;
      else weight = 12 + len * 1.8;
      weight *= 0.85 + 0.3 * rand01(len + strokes.length * 0.37, ph + 1.7);
      if (fast) weight *= 0.55;
      if (luma(color) > 238) weight *= 0.3;
      strokes.push({
        rib: Array.from(rib, (v) => Math.round(v * 10) / 10),
        tp: Array.from(tp, (v) => Math.round(v * 10) / 10),
        w: Math.round(halfW * 2 * 10) / 10,
        color: [color[0], color[1], color[2]],
        pen: pen ? 1 : 0,
        ms: weight, c: cIdx, r: -1, ph: ph,
      });
      // 规划画布立即落色：下一级的误差图要用它（最终质检会从头重放，两者应逐像素一致）。
      const cl = clips[cIdx], mk = cl.mask;
      for (let y = 0; y < cl.h; y++) {
        const row = (cl.y + y) * W + cl.x, mr = y * cl.w;
        for (let x = 0; x < cl.w; x++) {
          if (!mk[mr + x]) continue;
          const p = row + x, q = p * 3;
          canvas[q] = color[0]; canvas[q + 1] = color[1]; canvas[q + 2] = color[2];
        }
      }
    };

    // ---- 颜色分区：只对 eligible 像素做中位切分 + 同叶 8 连通 + 相邻合并 ----
    // 合并条件与 cover 相同：并完每通道跨度 ≤ 2*tol、面积 ≤ maxArea；颜色取约束均值，
    // 于是区内每个像素与区色的差都 ≤ tol（最终 tol = V 时就是红线）。
    function buildRegions(elig, tol, maxArea) {
      const idxA = new Int32Array(N);
      let nE = 0;
      for (let p = 0; p < N; p++) if (elig[p]) idxA[nE++] = p;
      if (!nE) return null;
      const leafOf = new Int32Array(N).fill(-1);
      const h = new Int32Array(256);
      let leafN = 0;
      const tmpA = new Int32Array(nE);
      const stack = [[0, nE, 0]];
      while (stack.length) {
        const nd = stack.pop();
        const lo = nd[0], hi = nd[1], dep = nd[2];
        const n = hi - lo;
        if (n <= 0) continue;
        let mn0 = 255, mn1 = 255, mn2 = 255, mx0 = 0, mx1 = 0, mx2 = 0;
        for (let k = lo; k < hi; k++) {
          const p = idxA[k], r = R[p], g = G[p], b = B[p];
          if (r < mn0) mn0 = r; if (r > mx0) mx0 = r;
          if (g < mn1) mn1 = g; if (g > mx1) mx1 = g;
          if (b < mn2) mn2 = b; if (b > mx2) mx2 = b;
        }
        if (n === 1 || (mx0 - mn0 <= 2 * tol && mx1 - mn1 <= 2 * tol && mx2 - mn2 <= 2 * tol)) {
          const li = leafN++;
          for (let k = lo; k < hi; k++) leafOf[idxA[k]] = li;
          continue;
        }
        if (dep >= 32) {
          const li = leafN++;
          for (let k = lo; k < hi; k++) leafOf[idxA[k]] = li;
          continue;
        }
        let ch = 0, rng = mx0 - mn0;
        if (mx1 - mn1 > rng) { ch = 1; rng = mx1 - mn1; }
        if (mx2 - mn2 > rng) { ch = 2; rng = mx2 - mn2; }
        const arr = ch === 0 ? R : (ch === 1 ? G : B);
        h.fill(0);
        for (let k = lo; k < hi; k++) h[arr[idxA[k]]]++;
        const half = (n + 1) >> 1;
        let acc = 0, splitVal = 255;
        for (let v = 0; v < 256; v++) { acc += h[v]; if (acc >= half) { splitVal = v; break; } }
        const leftMax = splitVal < mx0 && splitVal < 255 ? splitVal : splitVal - 1;
        let cut = 0;
        for (let k = lo; k < hi; k++) if (arr[idxA[k]] <= leftMax) cut++;
        if (cut === 0 || cut === n) {
          cut = n >> 1;
          for (let k = 0; k < n; k++) tmpA[k] = idxA[lo + k];
        } else {
          let a = 0, b = cut;
          for (let k = lo; k < hi; k++) {
            const p = idxA[k];
            if (arr[p] <= leftMax) tmpA[a++] = p; else tmpA[b++] = p;
          }
        }
        for (let k = 0; k < n; k++) idxA[lo + k] = tmpA[k];
        if (cut > 0) stack.push([lo, lo + cut, dep + 1]);
        if (cut < n) stack.push([lo + cut, hi, dep + 1]);
      }

      // 同叶 8 连通
      const compOf = new Int32Array(N).fill(-1);
      const q = new Int32Array(N);
      const cn = [], cx0 = [], cy0 = [], cx1 = [], cy1 = [];
      const csr = [], csg = [], csb = [];
      const cmn0 = [], cmn1 = [], cmn2 = [], cmx0 = [], cmx1 = [], cmx2 = [];
      const csx = [], csy = [], csxx = [], csxy = [], csyy = [];
      for (let s = 0; s < N; s++) {
        if (!elig[s] || compOf[s] >= 0) continue;
        const lab = leafOf[s];
        const id = cn.length;
        let head = 0, tail = 0;
        q[tail++] = s; compOf[s] = id;
        let cnt = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
        let sr = 0, sg = 0, sb = 0;
        let mn0 = 255, mn1 = 255, mn2 = 255, mx0 = 0, mx1 = 0, mx2 = 0;
        let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
        while (head < tail) {
          const p = q[head++];
          const x = p % W, y = (p - x) / W;
          cnt++;
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
          const rr = R[p], gg = G[p], bb = B[p];
          sr += rr; sg += gg; sb += bb;
          if (rr < mn0) mn0 = rr; if (rr > mx0) mx0 = rr;
          if (gg < mn1) mn1 = gg; if (gg > mx1) mx1 = gg;
          if (bb < mn2) mn2 = bb; if (bb > mx2) mx2 = bb;
          sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y;
          if (x > 0 && elig[p - 1] && compOf[p - 1] < 0 && leafOf[p - 1] === lab) { compOf[p - 1] = id; q[tail++] = p - 1; }
          if (x + 1 < W && elig[p + 1] && compOf[p + 1] < 0 && leafOf[p + 1] === lab) { compOf[p + 1] = id; q[tail++] = p + 1; }
          if (y > 0) {
            const u = p - W;
            if (elig[u] && compOf[u] < 0 && leafOf[u] === lab) { compOf[u] = id; q[tail++] = u; }
            if (x > 0) { const v = u - 1; if (elig[v] && compOf[v] < 0 && leafOf[v] === lab) { compOf[v] = id; q[tail++] = v; } }
            if (x + 1 < W) { const v = u + 1; if (elig[v] && compOf[v] < 0 && leafOf[v] === lab) { compOf[v] = id; q[tail++] = v; } }
          }
          if (y + 1 < H) {
            const u = p + W;
            if (elig[u] && compOf[u] < 0 && leafOf[u] === lab) { compOf[u] = id; q[tail++] = u; }
            if (x > 0) { const v = u - 1; if (elig[v] && compOf[v] < 0 && leafOf[v] === lab) { compOf[v] = id; q[tail++] = v; } }
            if (x + 1 < W) { const v = u + 1; if (elig[v] && compOf[v] < 0 && leafOf[v] === lab) { compOf[v] = id; q[tail++] = v; } }
          }
        }
        cn.push(cnt); cx0.push(x0); cy0.push(y0); cx1.push(x1); cy1.push(y1);
        csr.push(sr); csg.push(sg); csb.push(sb);
        cmn0.push(mn0); cmn1.push(mn1); cmn2.push(mn2);
        cmx0.push(mx0); cmx1.push(mx1); cmx2.push(mx2);
        csx.push(sx); csy.push(sy); csxx.push(sxx); csxy.push(sxy); csyy.push(syy);
      }

      // 相邻区合并（3 轮，按颜色距离从近到远；并完跨度 ≤2*tol、面积 ≤maxArea）
      const Gc = cn.length;
      const par = new Int32Array(Gc);
      for (let i = 0; i < Gc; i++) par[i] = i;
      const find2 = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
      const aN = cn.slice(), aR0 = cx0.slice(), aR1 = cx1.slice(), aY0 = cy0.slice(), aY1 = cy1.slice();
      const aSr = csr.slice(), aSg = csg.slice(), aSb = csb.slice();
      const aMn0 = cmn0.slice(), aMn1 = cmn1.slice(), aMn2 = cmn2.slice();
      const aMx0 = cmx0.slice(), aMx1 = cmx1.slice(), aMx2 = cmx2.slice();
      const unionB = (a, b) => {
        const ra = find2(a), rb = find2(b);
        if (ra === rb) return false;
        if (aN[ra] + aN[rb] > maxArea) return false;
        const mn0 = Math.min(aMn0[ra], aMn0[rb]), mx0 = Math.max(aMx0[ra], aMx0[rb]);
        const mn1 = Math.min(aMn1[ra], aMn1[rb]), mx1 = Math.max(aMx1[ra], aMx1[rb]);
        const mn2 = Math.min(aMn2[ra], aMn2[rb]), mx2 = Math.max(aMx2[ra], aMx2[rb]);
        if (mx0 - mn0 > 2 * tol || mx1 - mn1 > 2 * tol || mx2 - mn2 > 2 * tol) return false;
        par[rb] = ra;
        aN[ra] += aN[rb];
        aSr[ra] += aSr[rb]; aSg[ra] += aSg[rb]; aSb[ra] += aSb[rb];
        if (aR0[rb] < aR0[ra]) aR0[ra] = aR0[rb];
        if (aR1[rb] > aR1[ra]) aR1[ra] = aR1[rb];
        if (aY0[rb] < aY0[ra]) aY0[ra] = aY0[rb];
        if (aY1[rb] > aY1[ra]) aY1[ra] = aY1[rb];
        aMn0[ra] = mn0; aMn1[ra] = mn1; aMn2[ra] = mn2;
        aMx0[ra] = mx0; aMx1[ra] = mx1; aMx2[ra] = mx2;
        return true;
      };
      for (let pass = 0; pass < 3; pass++) {
        const em = new Map();
        for (let y = 0; y < H; y++) {
          const row = y * W;
          for (let x = 0; x < W; x++) {
            const p = row + x;
            if (!elig[p]) continue;
            const a = find2(compOf[p]);
            if (x + 1 < W && elig[p + 1]) {
              const b = find2(compOf[p + 1]);
              if (a !== b) { const lo = a < b ? a : b, hi = a < b ? b : a; em.set(lo * Gc + hi, [lo, hi]); }
            }
            if (y + 1 < H) {
              if (x > 0 && elig[p + W - 1]) { const b = find2(compOf[p + W - 1]); if (a !== b) { const lo = a < b ? a : b, hi = a < b ? b : a; em.set(lo * Gc + hi, [lo, hi]); } }
              if (elig[p + W]) { const b = find2(compOf[p + W]); if (a !== b) { const lo = a < b ? a : b, hi = a < b ? b : a; em.set(lo * Gc + hi, [lo, hi]); } }
              if (x + 1 < W && elig[p + W + 1]) { const b = find2(compOf[p + W + 1]); if (a !== b) { const lo = a < b ? a : b, hi = a < b ? b : a; em.set(lo * Gc + hi, [lo, hi]); } }
            }
          }
        }
        const cand = [];
        for (const [lo, hi] of em.values()) {
          const ra = find2(lo), rb = find2(hi);
          if (ra === rb) continue;
          const d = Math.max(
            Math.abs(aSr[ra] / aN[ra] - aSr[rb] / aN[rb]),
            Math.abs(aSg[ra] / aN[ra] - aSg[rb] / aN[rb]),
            Math.abs(aSb[ra] / aN[ra] - aSb[rb] / aN[rb]));
          cand.push([d, ra, rb]);
        }
        cand.sort((u, v) => u[0] - v[0]);
        let ng = 0;
        for (const c of cand) if (unionB(c[1], c[2])) ng++;
        if (!ng) break;
      }

      // 压紧 + 最终统计
      const newOf = new Int32Array(Gc).fill(-1);
      let GN = 0;
      for (let i = 0; i < Gc; i++) if (find2(i) === i) newOf[i] = GN++;
      for (let i = 0; i < Gc; i++) newOf[i] = newOf[find2(i)];
      const cN = new Int32Array(GN), cR0 = new Int32Array(GN).fill(W), cR1 = new Int32Array(GN).fill(-1);
      const cY0 = new Int32Array(GN).fill(H), cY1 = new Int32Array(GN).fill(-1);
      const cSr = new Float64Array(GN), cSg = new Float64Array(GN), cSb = new Float64Array(GN);
      const cMn0 = new Int32Array(GN).fill(255), cMn1 = new Int32Array(GN).fill(255), cMn2 = new Int32Array(GN).fill(255);
      const cMx0 = new Int32Array(GN), cMx1 = new Int32Array(GN), cMx2 = new Int32Array(GN);
      const cSx = new Float64Array(GN), cSy = new Float64Array(GN);
      const cSxx = new Float64Array(GN), cSxy = new Float64Array(GN), cSyy = new Float64Array(GN);
      const cOf = new Int32Array(N).fill(-1);
      for (let p = 0; p < N; p++) {
        if (!elig[p]) continue;
        const ri = newOf[compOf[p]];
        cOf[p] = ri;
        const x = p % W, y = (p - x) / W;
        const rr = R[p], gg = G[p], bb = B[p];
        cN[ri]++;
        if (x < cR0[ri]) cR0[ri] = x;
        if (x > cR1[ri]) cR1[ri] = x;
        if (y < cY0[ri]) cY0[ri] = y;
        if (y > cY1[ri]) cY1[ri] = y;
        cSr[ri] += rr; cSg[ri] += gg; cSb[ri] += bb;
        if (rr < cMn0[ri]) cMn0[ri] = rr;
        if (rr > cMx0[ri]) cMx0[ri] = rr;
        if (gg < cMn1[ri]) cMn1[ri] = gg;
        if (gg > cMx1[ri]) cMx1[ri] = gg;
        if (bb < cMn2[ri]) cMn2[ri] = bb;
        if (bb > cMx2[ri]) cMx2[ri] = bb;
        cSx[ri] += x; cSy[ri] += y; cSxx[ri] += x * x; cSxy[ri] += x * y; cSyy[ri] += y * y;
      }
      const offs = new Int32Array(GN + 1);
      for (let i = 0; i < GN; i++) offs[i + 1] = offs[i] + cN[i];
      const pix = new Int32Array(nE);
      const cur = offs.slice(0, GN);
      for (let p = 0; p < N; p++) {
        if (!elig[p]) continue;
        pix[cur[cOf[p]]++] = p;
      }
      const colors = new Array(GN);
      for (let i = 0; i < GN; i++) {
        const n = cN[i];
        colors[i] = [
          clamp(Math.round(cSr[i] / n), Math.max(0, cMx0[i] - tol), Math.min(255, cMn0[i] + tol)),
          clamp(Math.round(cSg[i] / n), Math.max(0, cMx1[i] - tol), Math.min(255, cMn1[i] + tol)),
          clamp(Math.round(cSb[i] / n), Math.max(0, cMx2[i] - tol), Math.min(255, cMn2[i] + tol)),
        ];
      }
      return { GN, cN, cR0, cR1, cY0, cY1, cSx, cSy, cSxx, cSxy, cSyy, colors, cOf, offs, pix };
    }

    // ---- 画一个区：沿主方向一档档扫，落墨 = 区像素；色 = 段内约束均值 ----
    function paintRegion(reg, ri, S, T, ph, fast) {
      const area = reg.cN[ri];
      if (!area) return;
      const x0 = reg.cR0[ri], y0 = reg.cY0[ri];
      const w = reg.cR1[ri] - x0 + 1, h = reg.cY1[ri] - y0 + 1;
      const rm = new Uint8Array(w * h);
      for (let k = reg.offs[ri]; k < reg.offs[ri + 1]; k++) {
        const p = reg.pix[k], x = p % W, y = (p - x) / W;
        rm[(y - y0) * w + (x - x0)] = 1;
      }
      const col = reg.colors[ri];
      if (area <= 64) {
        // 小碎区一笔点掉：rib 是外框，掩膜把形状裁出来；笔尖落在质心。
        const cx = reg.cSx[ri] / area, cy = reg.cSy[ri] / area;
        const cIdx = pushClip(x0, y0, w, h, rm);
        const rib = [x0, y0, x0 + w, y0, x0 + w, y0 + h, x0, y0 + h];
        emit(rib, [cx, cy], Math.max(1, S * 0.5 * styleW), col, 0, cIdx, ph, fast);
        return;
      }
      const horiz = w >= h;
      const bandW = Math.max(1, S);
      const step = Math.max(1, Math.round(S * (opts.coverOv || 0.62)));
      const lo = horiz ? y0 : x0, hi = horiz ? y0 + h - 1 : x0 + w - 1;
      const span = horiz ? w : h;
      const proj = new Uint8Array(span);
      const sumPos = new Float64Array(span), cntPos = new Int32Array(span);
      const halfW = Math.max(1, S * 0.5 * styleW);
      let bandIdx = 0;
      for (let b0 = lo; b0 <= hi; b0 += step, bandIdx++) {
        const b1 = Math.min(hi, b0 + bandW - 1);
        // 投影：这条带里，扫描方向上每个位置有没有区像素
        proj.fill(0);
        if (horiz) {
          const ly0 = b0 - y0, ly1 = b1 - y0;
          for (let x = 0; x < w; x++) {
            for (let y = ly0; y <= ly1; y++) if (rm[y * w + x]) { proj[x] = 1; break; }
          }
        } else {
          const lx0 = b0 - x0, lx1 = b1 - x0;
          for (let y = 0; y < h; y++) {
            for (let x = lx0; x <= lx1; x++) if (rm[y * w + x]) { proj[y] = 1; break; }
          }
        }
        // 收集这条带里的 run（先收集再按蛇形顺序画，笔尖不用每条带都跳回左边）
        const runs = [];
        let u = 0;
        while (u < span) {
          if (!proj[u]) { u++; continue; }
          let v = u;
          while (v + 1 < span && proj[v + 1]) v++;
          runs.push([u, v]);
          u = v + 1;
        }
        if (!runs.length) continue;
        const rev = (bandIdx & 1) === 1;
        for (let rr2 = 0; rr2 < runs.length; rr2++) {
          const run = runs[rev ? runs.length - 1 - rr2 : rr2];
          const u0 = run[0], u1 = run[1];
          const len = u1 - u0 + 1;
          const clipW = horiz ? len : (b1 - b0 + 1);
          const clipH = horiz ? (b1 - b0 + 1) : len;
          const clipX = horiz ? (x0 + u0) : b0;
          const clipY = horiz ? b0 : (y0 + u0);
          const mk = new Uint8Array(clipW * clipH);
          let sr = 0, sg = 0, sb = 0, cnt = 0;
          let mn0 = 255, mn1 = 255, mn2 = 255, mx0 = 0, mx1 = 0, mx2 = 0;
          sumPos.fill(0, u0, u1 + 1);
          cntPos.fill(0, u0, u1 + 1);
          if (horiz) {
            for (let xi = u0; xi <= u1; xi++) {
              const x = x0 + xi;
              for (let y = b0; y <= b1; y++) {
                if (!rm[(y - y0) * w + xi]) continue;
                mk[(y - b0) * clipW + (xi - u0)] = 1;
                const p = y * W + x;
                const rr = R[p], gg = G[p], bb = B[p];
                sr += rr; sg += gg; sb += bb; cnt++;
                if (rr < mn0) mn0 = rr; if (rr > mx0) mx0 = rr;
                if (gg < mn1) mn1 = gg; if (gg > mx1) mx1 = gg;
                if (bb < mn2) mn2 = bb; if (bb > mx2) mx2 = bb;
                sumPos[xi] += y; cntPos[xi]++;
              }
            }
          } else {
            for (let yi = u0; yi <= u1; yi++) {
              const y = y0 + yi;
              for (let x = b0; x <= b1; x++) {
                if (!rm[yi * w + (x - x0)]) continue;
                mk[(yi - u0) * clipW + (x - b0)] = 1;
                const p = y * W + x;
                const rr = R[p], gg = G[p], bb = B[p];
                sr += rr; sg += gg; sb += bb; cnt++;
                if (rr < mn0) mn0 = rr; if (rr > mx0) mx0 = rr;
                if (gg < mn1) mn1 = gg; if (gg > mx1) mx1 = gg;
                if (bb < mn2) mn2 = bb; if (bb > mx2) mx2 = bb;
                sumPos[yi] += x; cntPos[yi]++;
              }
            }
          }
          if (!cnt) continue;
          const col2 = [
            clamp(Math.round(sr / cnt), Math.max(0, mx0 - T), Math.min(255, mn0 + T)),
            clamp(Math.round(sg / cnt), Math.max(0, mx1 - T), Math.min(255, mn1 + T)),
            clamp(Math.round(sb / cnt), Math.max(0, mx2 - T), Math.min(255, mn2 + T)),
          ];
          const nP = Math.max(2, Math.min(8, Math.round(len / 12)));
          const tp = [];
          const seed = ri * 17 + bandIdx * 3.7;
          const bow = (rand01(seed, 2.3) - 0.5) * S * 0.18;
          for (let s = 0; s < nP; s++) {
            const f = s / (nP - 1);
            const ui = rev ? (u1 - (u1 - u0) * f) : (u0 + (u1 - u0) * f);
            const iu = Math.max(u0, Math.min(u1, Math.round(ui)));
            const cc = cntPos[iu] || 0;
            const mean = cc ? sumPos[iu] / cc : (b0 + b1) / 2;
            const off = bow * Math.sin(Math.PI * f) + (rand01(seed + s, 7.7) - 0.5) * S * 0.08;
            if (horiz) tp.push(x0 + ui, clamp(mean + off, b0 - 0.5, b1 + 0.5));
            else tp.push(clamp(mean + off, b0 - 0.5, b1 + 0.5), y0 + ui);
          }
          const cIdx = pushClip(clipX, clipY, clipW, clipH, mk);
          const rib = [clipX, clipY, clipX + clipW, clipY, clipX + clipW, clipY + clipH, clipX, clipY + clipH];
          emit(rib, tp, halfW, col2, 0, cIdx, ph, fast);
        }
      }
    }

    // 矩形宽笔：掩膜 = 矩形 ∩ 非纸底；没有纸底的矩形共用全 1 掩膜。
    const onesCache = new Map();
    const onesMask = (len) => {
      let m = onesCache.get(len);
      if (!m) { m = new Uint8Array(len); m.fill(1); onesCache.set(len, m); }
      return m;
    };
    function strokeRect(x0, y0, x1, y1, S, color, ph, fast, nInk) {
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      let mk;
      if (nInk === w * h) {
        mk = onesMask(w * h);
      } else {
        mk = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
          const row = (y0 + y) * W + x0, mr = y * w;
          for (let x = 0; x < w; x++) if (!paper[row + x]) mk[mr + x] = 1;
        }
      }
      const cIdx = pushClip(x0, y0, w, h, mk);
      const rib = [x0, y0, x1 + 1, y0, x1 + 1, y1 + 1, x0, y1 + 1];
      const horiz = w >= h;
      const len = Math.max(1, horiz ? w : h);
      const nP = Math.max(2, Math.min(8, Math.round(len / 12)));
      const tp = [];
      const seed = x0 * 13.7 + y0 * 7.3 + S * 3.1;
      const bow = (rand01(seed, 2.3) - 0.5) * S * 0.18;
      const cx = (x0 + x1 + 1) * 0.5, cy = (y0 + y1 + 1) * 0.5;
      for (let s = 0; s < nP; s++) {
        const f = s / (nP - 1);
        const off = bow * Math.sin(Math.PI * f) + (rand01(seed + s, 7.7) - 0.5) * S * 0.08;
        if (horiz) tp.push(x0 + w * f, clamp(cy + off, y0, y1 + 1));
        else tp.push(clamp(cx + off, x0, x1 + 1), y0 + h * f);
      }
      const halfW = Math.max(2, Math.min(S, Math.min(w, h))) * styleW * 0.5;
      emit(rib, tp, halfW, color, 0, cIdx, ph, fast);
    }

    // ---- 粗级：整幅横扫。一条扫带横穿整幅，带内按“列均色”切成连续段 ----
    // 每段一笔，笔形 = 带高 × 段宽 的矩形；不按颜色区/图层分块，也不竖向细分。
    // 粗级只求“大笔刷把全图铺一遍”，细节留给后面的小笔刷；最后一级再精确收尾。
    const colN = new Int32Array(W), colSr = new Float64Array(W), colSg = new Float64Array(W), colSb = new Float64Array(W);
    const colMn0 = new Int32Array(W), colMn1 = new Int32Array(W), colMn2 = new Int32Array(W);
    const colMx0 = new Int32Array(W), colMx1 = new Int32Array(W), colMx2 = new Int32Array(W);
    function paintBandCoarse(y0, y1, S, T, ph, fast) {
      colN.fill(0); colSr.fill(0); colSg.fill(0); colSb.fill(0);
      colMn0.fill(255); colMn1.fill(255); colMn2.fill(255);
      colMx0.fill(0); colMx1.fill(0); colMx2.fill(0);
      for (let y = y0; y <= y1; y++) {
        let p = y * W;
        for (let x = 0; x < W; x++, p++) {
          if (paper[p]) continue;
          const r = R[p], g = G[p], b = B[p];
          colN[x]++; colSr[x] += r; colSg[x] += g; colSb[x] += b;
          if (r < colMn0[x]) colMn0[x] = r; if (r > colMx0[x]) colMx0[x] = r;
          if (g < colMn1[x]) colMn1[x] = g; if (g > colMx1[x]) colMx1[x] = g;
          if (b < colMn2[x]) colMn2[x] = b; if (b > colMx2[x]) colMx2[x] = b;
        }
      }
      let x0 = -1, cnt = 0, sr = 0, sg = 0, sb = 0;
      let bmn0 = 255, bmn1 = 255, bmn2 = 255, bmx0 = 0, bmx1 = 0, bmx2 = 0;
      const flush = (xe) => {
        if (x0 < 0) return;
        const col = [Math.round(sr / cnt), Math.round(sg / cnt), Math.round(sb / cnt)];
        strokeRect(x0, y0, xe, y1, S, col, ph, fast, cnt);
        x0 = -1;
      };
      for (let x = 0; x < W; x++) {
        const n = colN[x];
        if (!n) { flush(x - 1); continue; }
        const mr = colSr[x] / n, mg = colSg[x] / n, mb = colSb[x] / n;
        if (x0 >= 0) {
          const nmn0 = Math.min(bmn0, mr), nmx0 = Math.max(bmx0, mr);
          const nmn1 = Math.min(bmn1, mg), nmx1 = Math.max(bmx1, mg);
          const nmn2 = Math.min(bmn2, mb), nmx2 = Math.max(bmx2, mb);
          if (nmx0 - nmn0 > 2 * T || nmx1 - nmn1 > 2 * T || nmx2 - nmn2 > 2 * T) flush(x - 1);
        }
        if (x0 < 0) {
          x0 = x; cnt = 0; sr = sg = sb = 0;
          bmn0 = bmx0 = mr; bmn1 = bmx1 = mg; bmn2 = bmx2 = mb;
        } else {
          if (mr < bmn0) bmn0 = mr; if (mr > bmx0) bmx0 = mr;
          if (mg < bmn1) bmn1 = mg; if (mg > bmx1) bmx1 = mg;
          if (mb < bmn2) bmn2 = mb; if (mb > bmx2) bmx2 = mb;
        }
        cnt += n; sr += colSr[x]; sg += colSg[x]; sb += colSb[x];
      }
      flush(W - 1);
    }

    // ---- 逐级：粗级整幅横扫（全图重画），最后一级精确色区重画（保逐像素红线） ----
    const levelLog = [];
    let totalRegions = 0;
    for (let lev = 0; lev < m; lev++) {
      const S = brushPx(lev);
      const T = tolOf(lev);
      const ph = Math.min(lev, 3);
      const last = lev === m - 1;
      prog(0.05 + 0.6 * (lev / m), ['起稿', '铺色', '细化', '收形'][ph] + ' ' + S + 'px…');
      await yieldUI();
      const s0 = strokes.length;
      let rg = 0;
      if (!last) {
        const step = Math.max(1, Math.round(S * (opts.coverOv || 0.62)));
        for (let b0 = 0; b0 < H; b0 += step) {
          paintBandCoarse(b0, Math.min(H - 1, b0 + S - 1), S, T, ph, lev === 0);
        }
      } else {
        const elig = new Uint8Array(N);
        let nE = 0;
        for (let p = 0; p < N; p++) if (!paper[p]) { elig[p] = 1; nE++; }
        const reg = nE ? buildRegions(elig, T, Math.max(400, LV.maxBlob)) : null;
        if (reg && reg.GN) {
          rg = reg.GN;
          totalRegions = reg.GN;
          const order = new Array(reg.GN);
          for (let i = 0; i < reg.GN; i++) order[i] = i;
          order.sort((a, b) => (reg.cY0[a] - reg.cY0[b]) || (reg.cR0[a] - reg.cR0[b]));
          for (const ri of order) paintRegion(reg, ri, S, T, ph, false);
        }
      }
      let mxA = 0;
      for (let p = 0; p < N; p++) {
        if (paper[p]) continue;
        const q = p * 3;
        const dr = Math.abs(canvas[q] - R[p]), dg = Math.abs(canvas[q + 1] - G[p]), db = Math.abs(canvas[q + 2] - B[p]);
        const d = dr > dg ? (dr > db ? dr : db) : (dg > db ? dg : db);
        if (d > mxA) mxA = d;
      }
      levelLog.push({ lev, S, T, elig: N - paperPx, regions: rg, strokes: strokes.length - s0, maxErr: mxA, final: last });
      if (opts.debug) {
        console.log('[pyramid] lev' + lev + ' S=' + S + ' T=' + T + (last ? ' [final]' : '') +
          ' strokes=' + (strokes.length - s0) + ' max=' + mxA);
      }
      await yieldUI();
    }

    // ---- 重放质检：从白纸按笔序再走一遍，算 vis / 关键帧 / 最终红线 ----
    prog(0.72, '重放质检…');
    await yieldUI();
    const t1 = Date.now();
    const canvas2 = new Uint8Array(N * 3);
    canvas2.fill(255);
    const cov2 = new Uint8Array(N);
    for (let p = 0; p < N; p++) if (paper[p]) cov2[p] = 1;
    const keysOut = [];
    const wantKeys = opts.returnKeys !== false;
    const kEvery = Math.max(1, Math.ceil(strokes.length / (opts.keyFrames || 5)));
    for (let si = 0; si < strokes.length; si++) {
      const st = strokes[si], cl = clips[st.c], msk = cl.mask, col = st.color;
      let visSum = 0;
      for (let y = 0; y < cl.h; y++) {
        const row = (cl.y + y) * W + cl.x, mr = y * cl.w;
        for (let x = 0; x < cl.w; x++) {
          if (!msk[mr + x]) continue;
          const p = row + x, q = p * 3;
          const dr = Math.abs(canvas2[q] - col[0]);
          const dg = Math.abs(canvas2[q + 1] - col[1]);
          const db = Math.abs(canvas2[q + 2] - col[2]);
          const d = dr > dg ? (dr > db ? dr : db) : (dg > db ? dg : db);
          visSum += d;
          canvas2[q] = col[0]; canvas2[q + 1] = col[1]; canvas2[q + 2] = col[2];
          cov2[p] = 1;
        }
      }
      st.vis = visSum;
      if (wantKeys && (si + 1) % kEvery === 0) keysOut.push({ i: si + 1, rgb: canvas2.slice(), cov: cov2.slice() });
    }
    if (wantKeys && (!keysOut.length || keysOut[keysOut.length - 1].i !== strokes.length)) {
      keysOut.push({ i: strokes.length, rgb: canvas2.slice(), cov: cov2.slice() });
    }
    let uncovered = 0, maxErr = 0, sumErr = 0, gt8 = 0, gt24 = 0, gt48 = 0;
    for (let p = 0; p < N; p++) {
      if (!cov2[p]) uncovered++;
      const q = p * 3;
      const dr = Math.abs(canvas2[q] - R[p]), dg = Math.abs(canvas2[q + 1] - G[p]), db = Math.abs(canvas2[q + 2] - B[p]);
      const d = dr > dg ? (dr > db ? dr : db) : (dg > db ? dg : db);
      sumErr += d;
      if (d > maxErr) maxErr = d;
      if (d > 8) gt8++;
      if (d > 24) gt24++;
      if (d > 48) gt48++;
    }
    const replayMs = Date.now() - t1;
    // 时间按阶段分：粗级只有几十笔，按笔权重会被最后一级挤到 <2%，大笔刷一遍一闪就没了。
    // 先按重量算相对节奏，再把每个阶段的总时长拉到配比（空阶段按比例并给其它阶段）。
    const phaseShare = [0.18, 0.22, 0.26, 0.34];
    const phSum = [0, 0, 0, 0];
    for (const st of strokes) phSum[st.ph] += st.ms;
    let shareAll = 0;
    for (let p = 0; p < 4; p++) if (phSum[p] > 0) shareAll += phaseShare[p];
    for (const st of strokes) {
      const target = opts.targetSec * 1000 * (phaseShare[st.ph] / shareAll);
      st.ms = Math.round(Math.max(1, st.ms * (target / phSum[st.ph])) * 10) / 10;
    }
    const quality = {
      tolerance: V, bucketT: LV.palT, max: maxErr, mean: +(sumErr / N).toFixed(3),
      gt8: +(gt8 / N * 100).toFixed(3), gt24: +(gt24 / N * 100).toFixed(3),
      gt48: +(gt48 / N * 100).toFixed(3), uncovered,
      regions: totalRegions, colorRegions: totalRegions, inkRegions: 0,
    };
    const phases = [0, 1, 2, 3].map((ph) => strokes.filter((s) => s.ph === ph).length);
    const buildMs = Date.now() - t0;
    const info = {
      mode: 'pyramid', level: fid, tolerance: V, brushLadder: brushSizes.slice(0, m),
      levels: levelLog, paperPx, regions: totalRegions, strokes: strokes.length,
      maskBytes: maskPx, buildMs, replayMs, max: maxErr, mean: quality.mean,
      gt8: quality.gt8, gt24: quality.gt24, gt48: quality.gt48, uncovered,
    };
    if (opts.debug) {
      // 规划画布（逐级误差图用的）和重放画布应逐像素一致；不一致说明落色/掩膜有 bug。
      let diff = 0;
      for (let q = 0; q < N * 3; q++) if (canvas[q] !== canvas2[q]) diff++;
      console.log('[pyramid] L' + fid + ' strokes=' + strokes.length + ' max=' + maxErr +
        ' uncovered=' + uncovered + ' canvasDiff=' + diff + ' ms=' + buildMs + '+' + replayMs);
      if (diff) console.log('[pyramid] WARN 规划画布与重放画布不一致', diff);
    }
    prog(1.0, '完成');
    return {
      W, H, strokes, clips,
      canvasRgb: opts.returnCanvas ? canvas2 : undefined,
      keys: opts.returnKeys ? keysOut : undefined,
      palette: undefined,
      dbg: opts.debug ? {
        pyramid: info,
        marks: levelLog.map((l) => ({ tag: '第' + (l.lev + 1) + '级', n: l.strokes })),
      } : undefined,
      probe: undefined,
      stats: {
        regions: totalRegions, inkGroups: 0, strokes: strokes.length,
        totalMs: strokes.reduce((a, s) => a + s.ms, 0),
        phases, colors: 0, photo: false, style: opts.style,
        detail: opts.detail, fidelity: fid, quality, algo: 'pyramid',
      },
    };
  }

  // ================= artist mode：观察 → 概括 → 起形 → 分层落笔 =================
  // 第三种算法（opts.algo = 'artist'）。和 cover/pyramid 的"逐像素重建"不同，这里先把
  // 图像看成"几张色面 + 几条结构线"：量化到有限色板、按颜色/相邻关系并成画块，找出
  // 主体与视觉中心，再按人的作画顺序生成有限笔触：
  //   ph0 起形：构图线 + 主体长轮廓（长而慢，先立大形）
  //   ph1 铺大色：背景大色面 → 主体大色面（大笔，优先把大关系铺满，再补小块）
  //   ph2 塑形：只在高显著/主体区域加中间笔触，沿结构方向走
  //   ph3 点睛：只画视觉中心的小结构，最后主动停笔
  // 三种笔触不是同一套笔触换皮：
  //   pencil = 长线起形 + 单向排线 + 暗部交叉排线 + 少量重音（不铺彩色底）
  //   marker = 有限色板大平涂 + 少量叠色 + 轮廓概括（保留纸白高光）
  //   oil    = 大笔色面 + 顺形体笔触 + 中间调塑形 + 视觉中心厚涂小笔
  async function runArtistMode(px, W, H, opts, onProgress) {
    const N = W * H;
    const prog = (p, msg) => { if (onProgress) onProgress(p, msg); };
    const yieldUI = () => new Promise((r) => setTimeout(r, 0));
    const t0 = Date.now();
    const style = opts.style === 'pencil' ? 'pencil' : (opts.style === 'oil' ? 'oil' : 'marker');
    const fid = Math.max(1, Math.min(5, opts.fidelity | 0));
    const scaleB = Math.max(0.62, Math.min(W, H) / 1024);
    const clamp01 = (v) => v < 0 ? 0 : (v > 1 ? 1 : v);
    const mix = (a, b, t) => [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t),
    ];
    const colorDist2 = (a, b) => {
      const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
      return dr * dr * 2 + dg * dg * 4 + db * db * 3;
    };

    prog(0.03, '观察：明暗与结构…');
    const R = new Uint8Array(N), G = new Uint8Array(N), B = new Uint8Array(N), L = new Uint8Array(N);
    for (let i = 0, p = 0; i < N; i++, p += 4) {
      const r = px[p], g = px[p + 1], b = px[p + 2];
      R[i] = r; G[i] = g; B[i] = b;
      L[i] = (0.299 * r + 0.587 * g + 0.114 * b + 0.5) | 0;
    }

    // 纸白：只认"从四边连进来的近白"，主体内部的白（猫毛、字）仍然要画。
    const paper = new Uint8Array(N);
    let paperPx = 0;
    {
      const q = new Int32Array(N);
      let head = 0, tail = 0;
      const push = (p) => {
        if (paper[p]) return;
        if (R[p] < 248 || G[p] < 248 || B[p] < 248) return;
        paper[p] = 1; q[tail++] = p;
      };
      for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
      for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
      while (head < tail) {
        const p = q[head++]; paperPx++;
        const x = p % W, y = (p - x) / W;
        if (x > 0) push(p - 1);
        if (x + 1 < W) push(p + 1);
        if (y > 0) push(p - W);
        if (y + 1 < H) push(p + W);
      }
    }

    // 可分离滑动盒模糊：观察用的低频图/结构张量都比逐像素高斯便宜，1024 图不卡。
    function blurU8(src, r) {
      if (r <= 0) return src.slice();
      const tmp = new Float32Array(N), out = new Uint8Array(N);
      const win = r * 2 + 1;
      for (let y = 0; y < H; y++) {
        const row = y * W;
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += src[row + (k < 0 ? 0 : (k >= W ? W - 1 : k))];
        for (let x = 0; x < W; x++) {
          tmp[row + x] = sum / win;
          const add = x + 1 + r, sub = x - r;
          sum += src[row + (add >= W ? W - 1 : add)] - src[row + (sub < 0 ? 0 : sub)];
        }
      }
      for (let x = 0; x < W; x++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += tmp[(k < 0 ? 0 : (k >= H ? H - 1 : k)) * W + x];
        for (let y = 0; y < H; y++) {
          out[y * W + x] = (sum / win + 0.5) | 0;
          const add = y + 1 + r, sub = y - r;
          sum += tmp[(add >= H ? H - 1 : add) * W + x] - tmp[(sub < 0 ? 0 : sub) * W + x];
        }
      }
      return out;
    }
    function blurF(src, r) {
      if (r <= 0) return Float32Array.from(src);
      const tmp = new Float32Array(N), out = new Float32Array(N);
      const win = r * 2 + 1;
      for (let y = 0; y < H; y++) {
        const row = y * W;
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += src[row + (k < 0 ? 0 : (k >= W ? W - 1 : k))];
        for (let x = 0; x < W; x++) {
          tmp[row + x] = sum / win;
          const add = x + 1 + r, sub = x - r;
          sum += src[row + (add >= W ? W - 1 : add)] - src[row + (sub < 0 ? 0 : sub)];
        }
      }
      for (let x = 0; x < W; x++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += tmp[(k < 0 ? 0 : (k >= H ? H - 1 : k)) * W + x];
        for (let y = 0; y < H; y++) {
          out[y * W + x] = sum / win;
          const add = y + 1 + r, sub = y - r;
          sum += tmp[(add >= H ? H - 1 : add) * W + x] - tmp[(sub < 0 ? 0 : sub) * W + x];
        }
      }
      return out;
    }

    // ---- 结构张量：flow = 边缘切线方向（排线/色面顺着结构走，而不是横平竖直）----
    const Lb = blurU8(L, Math.max(1, Math.round(scaleB)));
    const gx = new Float32Array(N), gy = new Float32Array(N), edge = new Float32Array(N);
    for (let y = 1; y < H - 1; y++) {
      let p = y * W + 1;
      for (let x = 1; x < W - 1; x++, p++) {
        const ax = (Lb[p + 1] - Lb[p - 1]) * 0.5;
        const ay = (Lb[p + W] - Lb[p - W]) * 0.5;
        gx[p] = ax; gy[p] = ay;
        edge[p] = Math.sqrt(ax * ax + ay * ay);
      }
    }
    const jr = Math.max(2, Math.round(3 * scaleB));
    let Jxx = new Float32Array(N), Jyy = new Float32Array(N), Jxy = new Float32Array(N);
    for (let p = 0; p < N; p++) { const a = gx[p], b = gy[p]; Jxx[p] = a * a; Jyy[p] = b * b; Jxy[p] = a * b; }
    Jxx = blurF(Jxx, jr); Jyy = blurF(Jyy, jr); Jxy = blurF(Jxy, jr);
    const flowX = new Float32Array(N), flowY = new Float32Array(N), coh = new Float32Array(N);
    for (let p = 0; p < N; p++) {
      const a = Jxx[p], b = Jxy[p], c = Jyy[p];
      const ang = 0.5 * Math.atan2(2 * b, a - c) + Math.PI * 0.5;
      flowX[p] = Math.cos(2 * ang); flowY[p] = Math.sin(2 * ang);
      const tr = a + c, df = a - c;
      coh[p] = tr > 1e-5 ? Math.sqrt(df * df + 4 * b * b) / tr : 0;
    }

    // ---- 显著度：中心 + 边缘密度 + 局部对比 + 肤色（人像的脸更容易成为视觉中心）----
    const edgeDens = blurF(edge, Math.max(3, Math.round(7 * scaleB)));
    const contrast = new Float32Array(N);
    {
      const big = blurU8(Lb, Math.max(6, Math.round(12 * scaleB)));
      for (let p = 0; p < N; p++) contrast[p] = Math.abs(Lb[p] - big[p]) / 72;
    }
    const sal = new Float32Array(N);
    const maxD = Math.hypot(W * 0.5, H * 0.5) || 1;
    for (let y = 0; y < H; y++) {
      let p = y * W;
      const dy = (y - H * 0.5) / maxD;
      for (let x = 0; x < W; x++, p++) {
        const dx = (x - W * 0.5) / maxD;
        const center = 1 - Math.min(1, Math.sqrt(dx * dx + dy * dy) * 1.15);
        const r = R[p], g = G[p], b = B[p];
        const skin = (r > 92 && g > 38 && b > 20 && r > g + 12 && r > b + 16 && r - g < 120) ? 1 : 0;
        sal[p] = 0.42 * clamp01(edgeDens[p] / 20) + 0.24 * clamp01(contrast[p]) +
                 0.26 * center + 0.10 * skin;
      }
    }
    {
      const hist = new Int32Array(64);
      let np = 0;
      for (let p = 0; p < N; p += 5) {
        if (paper[p]) continue;
        hist[Math.min(63, (sal[p] * 50) | 0)]++; np++;
      }
      let cum = 0, p90 = 1;
      for (let i = 0; i < 64; i++) { cum += hist[i]; if (cum >= np * 0.9) { p90 = (i + 1) / 50; break; } }
      p90 = Math.max(0.25, p90);
      for (let p = 0; p < N; p++) sal[p] = clamp01(sal[p] / p90);
    }

    // ---- 色板：颜色直方图 + 加权最远点。平涂图用众数色，浅橘/奶白不会被均值混成灰泥 ----
    // 铅笔的色板只用来分区，最终都转灰：色块少一点反而更像"概括过的形"；
    // 分得太碎时，暗部会碎成一堆小斑，猫的整块剪影就散了。
    const K = (style === 'marker' ? [8, 9, 10, 12, 14] : style === 'oil' ? [8, 10, 12, 14, 16] : [6, 7, 8, 9, 11])[fid - 1];
    const stS = Math.max(2, Math.round(Math.sqrt(N / 70000)));
    const BINS = 16, binN = BINS * BINS * BINS;
    const bCnt = new Int32Array(binN), bR = new Float64Array(binN), bG = new Float64Array(binN), bB = new Float64Array(binN);
    let sampleN = 0;
    for (let y = 0; y < H; y += stS) {
      let p = y * W;
      for (let x = 0; x < W; x += stS, p += stS) {
        if (paper[p]) continue;
        const r = R[p], g = G[p], b = B[p];
        const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
        bCnt[key]++; bR[key] += r; bG[key] += g; bB[key] += b; sampleN++;
      }
    }
    const minBin = Math.max(2, Math.round(sampleN * 0.00008));
    const cands = [];
    for (let k = 0; k < binN; k++) {
      if (bCnt[k] < minBin) continue;
      cands.push({
        rgb: [Math.round(bR[k] / bCnt[k]), Math.round(bG[k] / bCnt[k]), Math.round(bB[k] / bCnt[k])],
        n: bCnt[k], used: 0,
      });
    }
    cands.sort((a, b) => b.n - a.n);
    const palette = [];
    if (cands.length) {
      palette.push(cands[0].rgb); cands[0].used = 1;
      while (palette.length < K) {
        let best = -1, bs = -1;
        for (let i = 0; i < cands.length; i++) {
          if (cands[i].used) continue;
          let bd = Infinity;
          for (const c of palette) {
            const d = colorDist2(cands[i].rgb, c);
            if (d < bd) bd = d;
          }
          const sc = Math.sqrt(cands[i].n) * bd;
          if (sc > bs) { bs = sc; best = i; }
        }
        if (best < 0) break;
        cands[best].used = 1;
        if (bs > 80) palette.push(cands[best].rgb);
      }
    }
    if (!palette.length) palette = [[128, 128, 128]];
    // 舌头/内耳/腮红这类"小面积但决定身份"的粉红色，直方图里占比太低，
    // 最远点选色常常轮不到；照片类单独补一个平均粉，色板仍然有限。
    {
      let pr = 0, pg = 0, pb = 0, pn = 0;
      for (let p = 0; p < N; p += 2) {
        if (paper[p]) continue;
        const r = R[p], g = G[p], b = B[p];
        const rg = r - g, gb = g - b;
        if (r < 80 || rg < 30 || rg > 110 || gb > 28) continue;
        const w = rg - 24;
        pr += r * w; pg += g * w; pb += b * w; pn += w;
      }
      if (pn > N * 0.0002) {
        const pc = [Math.round(pr / pn), Math.round(pg / pn), Math.round(pb / pn)];
        let bd = Infinity;
        for (const c of palette) bd = Math.min(bd, colorDist2(c, pc));
        if (bd > 260) palette.push(pc);
      }
    }
    palette.sort((a, b) => luma(a) - luma(b));
    const nearestPalette = (c) => {
      let best = palette[0], bd = Infinity;
      for (let i = 0; i < palette.length; i++) {
        const d = colorDist2(palette[i], c);
        if (d < bd) { bd = d; best = palette[i]; }
      }
      return best;
    };
    // 马克笔的"暗一档"必须还在同一色系里。色板只有十来支，暗奶油（233,227,181）
    // 在加权色距下会吸到浅橙（250,165,151）上，字心就冒出粉块。调不到相近的
    // 暗色时宁可保持平涂——马克笔本来就是少叠色、靠色块和轮廓说话。
    const markerShade = (base, t) => {
      const want = mix(base, [0, 0, 0], t);
      const c = nearestPalette(want);
      return (luma(c) < luma(base) - 2 && colorDist2(c, base) < 5200) ? c : base;
    };

    // ---- 量化 + 去噪 + 连通区 ----
    prog(0.14, '概括：' + palette.length + ' 色 · 分块…');
    await yieldUI();
    const Kp = palette.length;
    const labels = new Int16Array(N).fill(-1);
    for (let p = 0; p < N; p++) {
      if (paper[p]) continue;
      const r = R[p], g = G[p], b = B[p];
      let best = 0, bd = Infinity;
      for (let k = 0; k < Kp; k++) {
        const c = palette[k];
        const dr = r - c[0], dg = g - c[1], db = b - c[2];
        const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
        if (d < bd) { bd = d; best = k; }
      }
      labels[p] = best;
    }
    // 3×3 多数表：去掉 JPEG/渐变造成的单像素杂色；强边缘保护，别把画里的线吃掉
    {
      const out = new Int16Array(labels);
      const cnt = new Int32Array(Kp), stamp = new Int32Array(Kp);
      let ep = 0;
      for (let y = 1; y < H - 1; y++) {
        let p = y * W + 1;
        for (let x = 1; x < W - 1; x++, p++) {
          if (paper[p] || edge[p] > 18) continue;
          ep++;
          let best = -1, bn = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const row = p + dy * W;
            for (let dx = -1; dx <= 1; dx++) {
              const lab = labels[row + dx];
              if (lab < 0) continue;
              if (stamp[lab] !== ep) { stamp[lab] = ep; cnt[lab] = 0; }
              const c = ++cnt[lab];
              if (c > bn || (c === bn && lab === labels[p])) { bn = c; best = lab; }
            }
          }
          if (bn >= 5 && best >= 0) out[p] = best;
        }
      }
      for (let p = 0; p < N; p++) if (paper[p]) out[p] = -1;
      labels.set(out);
    }
    // 平涂判定 / 纹理强度在连通区之前算，决定碎块阈值和总预算。
    // 平涂判定用与笔刷风格无关的 4-bit 颜色直方图（bCnt）：前 6 个颜色格占
    // 非纸底像素的比例。按"量化后的色板标签"算会随笔刷变化（马克笔 K=10、
    // 油画 K=12），同一张海报在两种笔刷下会一个判平涂、一个判照片，笔数差 4 倍。
    // 实测 top6 占比：简笔平涂插画 0.91，海报 0.55、人像 0.38、风景 0.45，间隔很清楚。
    let top6bin = 0;
    const binsSorted = Array.from(bCnt).sort((a, b) => b - a);
    for (let i = 0; i < 6; i++) top6bin += binsSorted[i] || 0;
    const flatScore = sampleN > 0 ? top6bin / sampleN : 1;
    const eHist = new Int32Array(256);
    for (let p = 0; p < N; p += 2) if (!paper[p]) eHist[Math.min(255, edge[p] | 0)]++;
    let eTot = 0; for (let i = 0; i < 256; i++) eTot += eHist[i];
    let eCum = 0, e85 = 24;
    for (let i = 0; i < 256; i++) { eCum += eHist[i]; if (eCum >= eTot * 0.85) { e85 = Math.max(6, i); break; } }
    let eStrong = 0; for (let i = e85; i < 256; i++) eStrong += eHist[i];
    const edgeDensity = eTot > 0 ? eStrong / eTot : 0;
    const complexity = Math.max(0.78, Math.min(1.6, 0.78 + edgeDensity * 3.2));
    const isFlat = flatScore > 0.75;

    const cc = compsOfLabels(labels, W, H);
    const compOf = cc.compOf, comps = cc.comps;
    const C = comps.length;
    const parent = new Int32Array(C).fill(-1);
    const kept = new Uint8Array(C);
    const minArea = isFlat ? Math.max(28, Math.round(N * 0.00012)) : Math.max(24, Math.round(N * 0.00005));
    // 碎块并进邻近色最近的块：孤立噪点不会各自成一笔
    const small = [];
    for (let ci = 0; ci < C; ci++) {
      const cp = comps[ci];
      if (cp.label < 0) continue;
      if (cp.count >= minArea) kept[ci] = 1;
      else small.push(ci);
    }
    small.sort((a, b) => comps[b].count - comps[a].count);
    for (let pass = 0; pass < 2; pass++) {
      for (const ci of small) {
        if (parent[ci] >= 0) continue;
        const cp = comps[ci];
        if (cp.label < 0) continue;
        let best = -1, bestKept = 0, bestD = Infinity, bestN = -1;
        for (let k = 0; k < cp.count; k++) {
          const p = cc.pix[cp.start + k];
          const x = p % W, y = (p - x) / W;
          for (let d = 0; d < 4; d++) {
            const q = d === 0 ? (x > 0 ? p - 1 : -1) : d === 1 ? (x + 1 < W ? p + 1 : -1) :
              d === 2 ? (y > 0 ? p - W : -1) : (y + 1 < H ? p + W : -1);
            if (q < 0) continue;
            const cj = compOf[q];
            if (cj === ci || cj < 0 || comps[cj].label < 0) continue;
            const dd = colorDist2(palette[comps[cj].label], palette[cp.label]);
            const kJ = kept[cj] ? 1 : 0;
            if (kJ > bestKept || (kJ === bestKept && dd < bestD) ||
                (kJ === bestKept && dd === bestD && comps[cj].count > bestN)) {
              best = cj; bestKept = kJ; bestD = dd; bestN = comps[cj].count;
            }
          }
        }
        if (best >= 0) parent[ci] = best;
      }
    }
    for (let p = 0; p < N; p++) {
      let ci = compOf[p];
      if (ci < 0 || comps[ci].label < 0) { compOf[p] = -1; continue; }
      let guard = 0;
      while (parent[ci] >= 0 && guard++ < 64) ci = parent[ci];
      compOf[p] = ci;
      kept[ci] = 1;
    }
    const cArea = new Int32Array(C);
    for (let p = 0; p < N; p++) { const ci = compOf[p]; if (ci >= 0) cArea[ci]++; }

    // ---- 块统计 / 主体与背景 ----
    prog(0.28, '辨认主体与视觉中心…');
    await yieldUI();
    const cSumR = new Float64Array(C), cSumG = new Float64Array(C), cSumB = new Float64Array(C);
    const cSumL = new Float64Array(C), cSumSal = new Float64Array(C), cSumEdge = new Float64Array(C);
    const cX0 = new Int32Array(C).fill(W), cY0 = new Int32Array(C).fill(H);
    const cX1 = new Int32Array(C).fill(-1), cY1 = new Int32Array(C).fill(-1);
    const cSx = new Float64Array(C), cSy = new Float64Array(C);
    const cSxx = new Float64Array(C), cSxy = new Float64Array(C), cSyy = new Float64Array(C);
    const cFlowX = new Float64Array(C), cFlowY = new Float64Array(C), cFlowW = new Float64Array(C);
    const cBorder = new Uint8Array(C);
    for (let y = 0; y < H; y++) {
      let p = y * W;
      for (let x = 0; x < W; x++, p++) {
        const ci = compOf[p];
        if (ci < 0) continue;
        cSumR[ci] += R[p]; cSumG[ci] += G[p]; cSumB[ci] += B[p]; cSumL[ci] += L[p];
        cSumSal[ci] += sal[p]; cSumEdge[ci] += edge[p];
        if (x < cX0[ci]) cX0[ci] = x; if (x > cX1[ci]) cX1[ci] = x;
        if (y < cY0[ci]) cY0[ci] = y; if (y > cY1[ci]) cY1[ci] = y;
        cSx[ci] += x; cSy[ci] += y;
        cSxx[ci] += x * x; cSxy[ci] += x * y; cSyy[ci] += y * y;
        const fw = 0.15 + edge[p];
        cFlowX[ci] += flowX[p] * fw; cFlowY[ci] += flowY[p] * fw; cFlowW[ci] += fw;
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) cBorder[ci] = 1;
      }
    }
    const compInfo = new Array(C);
    for (let ci = 0; ci < C; ci++) {
      const a = cArea[ci];
      if (a <= 0) { compInfo[ci] = null; continue; }
      const bw = cX1[ci] - cX0[ci] + 1, bh = cY1[ci] - cY0[ci] + 1;
      const cx = cSx[ci] / a, cy = cSy[ci] / a;
      const vx = Math.max(0.01, cSxx[ci] / a - cx * cx);
      const vy = Math.max(0.01, cSyy[ci] / a - cy * cy);
      const vxy = cSxy[ci] / a - cx * cy;
      const tr = vx + vy, df = vx - vy;
      const e1 = tr * 0.5 + Math.sqrt(df * df * 0.25 + vxy * vxy);
      const e2 = Math.max(0.01, tr * 0.5 - Math.sqrt(df * df * 0.25 + vxy * vxy));
      compInfo[ci] = {
        ci, area: a, cx, cy, x0: cX0[ci], y0: cY0[ci], x1: cX1[ci], y1: cY1[ci],
        bw, bh, fill: a / Math.max(1, bw * bh), thick: a / Math.max(1, Math.max(bw, bh)),
        elong: Math.sqrt(e1 / e2), angle: 0.5 * Math.atan2(2 * vxy, vx - vy),
        mean: [Math.round(cSumR[ci] / a), Math.round(cSumG[ci] / a), Math.round(cSumB[ci] / a)],
        luma: cSumL[ci] / a, sal: cSumSal[ci] / a, edge: cSumEdge[ci] / a,
        border: !!cBorder[ci], label: comps[ci].label,
      };
    }

    // 背景：贴边 + 低显著（或极大）。背景同色块的笔触预算合并，先铺背景再画主体。
    const compBg = new Uint8Array(C);
    for (let ci = 0; ci < C; ci++) {
      const g = compInfo[ci];
      if (!g) continue;
      // 照片的石头/树叶背景纹理很强，用平涂图的显著性阈值会把整幅都判成主体；
      // 非平涂放宽贴边组的显著性门槛，让背景先归位。
      const salTol = isFlat ? (g.area > N * 0.05 ? 0.55 : 0.62) : 0.80;
      const bg = g.border && (g.sal < salTol);
      compBg[ci] = bg ? 1 : 0;
    }
    // 背景同色带的合并：从贴边背景出发，沿"区块相邻 + 颜色接近种子背景"泛洪。
    // 平涂图常有内圈浅色带/色环，它们不贴边，但仍是背景；只靠 border 会当成主体。
    {
      const cAdj = new Array(C);
      for (let i = 0; i < C; i++) cAdj[i] = new Set();
      const addEdge = (a, b) => {
        if (a === b || a < 0 || b < 0) return;
        if (!cAdj[a].has(b)) { cAdj[a].add(b); cAdj[b].add(a); }
      };
      for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
          const p = row + x, a = compOf[p];
          if (a < 0) continue;
          if (x + 1 < W) addEdge(a, compOf[p + 1]);
          if (y + 1 < H) addEdge(a, compOf[p + W]);
        }
      }
      const q = [];
      const seed = new Float64Array(C * 3).fill(-1);
      for (let ci = 0; ci < C; ci++) {
        if (!compBg[ci] || !compInfo[ci]) continue;
        q.push(ci);
        seed[ci * 3] = compInfo[ci].mean[0];
        seed[ci * 3 + 1] = compInfo[ci].mean[1];
        seed[ci * 3 + 2] = compInfo[ci].mean[2];
      }
      for (let head = 0; head < q.length; head++) {
        const ci = q[head];
        const sc = [seed[ci * 3], seed[ci * 3 + 1], seed[ci * 3 + 2]];
        for (const nb of cAdj[ci]) {
          if (compBg[nb]) continue;
          const g = compInfo[nb];
          if (!g || g.area < N * 0.0003 || g.sal >= (isFlat ? 0.75 : 0.88)) continue;
          if (colorDist2(g.mean, sc) > (isFlat ? 900 : 2000)) continue;
          compBg[nb] = 1;
          seed[nb * 3] = sc[0]; seed[nb * 3 + 1] = sc[1]; seed[nb * 3 + 2] = sc[2];
          q.push(nb);
        }
      }
    }
    // 组：每个连通块一组。背景不再按色板标签归一：
    // 同一暗色会同时出现在猫的斑纹、石头阴影和树丛里，合并后得到一个横跨整幅、
    // fill<0.1 的碎片组，扫线根本落不进去（实测 made=0）。
    // 更关键的是，归一后的组色和像素自己的量化色不一致：奶油字的组被映射成
    // 蓝/粉后，铺色和质检的 qimg 各说各话，字心就冒出彩色补丁。
    // 每个连通块保留自己的量化色，形状紧实，扫线扫得满，成品和计划同色。
    const compGroup = new Int32Array(C).fill(-1);
    const groupList = [];
    for (let ci = 0; ci < C; ci++) {
      const g = compInfo[ci];
      if (!g) continue;
      const gid = groupList.length;
      groupList.push({ bg: compBg[ci] ? 1 : 0, label: g.label });
      compGroup[ci] = gid;
    }
    let G_ = groupList.length;
    const groupOf = new Int32Array(N).fill(-1);
    for (let p = 0; p < N; p++) { const ci = compOf[p]; if (ci >= 0) groupOf[p] = compGroup[ci]; }
    const gArea = new Int32Array(G_), gSumR = new Float64Array(G_), gSumG = new Float64Array(G_), gSumB = new Float64Array(G_);
    const gSumL = new Float64Array(G_), gSumSal = new Float64Array(G_), gSumEdge = new Float64Array(G_);
    const gX0 = new Int32Array(G_).fill(W), gY0 = new Int32Array(G_).fill(H);
    const gX1 = new Int32Array(G_).fill(-1), gY1 = new Int32Array(G_).fill(-1);
    const gSx = new Float64Array(G_), gSy = new Float64Array(G_);
    const gSxx = new Float64Array(G_), gSxy = new Float64Array(G_), gSyy = new Float64Array(G_);
    const gFx = new Float64Array(G_), gFy = new Float64Array(G_), gFw = new Float64Array(G_);
    for (let y = 0; y < H; y++) {
      let p = y * W;
      for (let x = 0; x < W; x++, p++) {
        const gid = groupOf[p];
        if (gid < 0) continue;
        gArea[gid]++; gSumR[gid] += R[p]; gSumG[gid] += G[p]; gSumB[gid] += B[p];
        gSumL[gid] += L[p]; gSumSal[gid] += sal[p]; gSumEdge[gid] += edge[p];
        if (x < gX0[gid]) gX0[gid] = x; if (x > gX1[gid]) gX1[gid] = x;
        if (y < gY0[gid]) gY0[gid] = y; if (y > gY1[gid]) gY1[gid] = y;
        gSx[gid] += x; gSy[gid] += y; gSxx[gid] += x * x; gSxy[gid] += x * y; gSyy[gid] += y * y;
        const fw = 0.15 + edge[p];
        gFx[gid] += flowX[p] * fw; gFy[gid] += flowY[p] * fw; gFw[gid] += fw;
      }
    }
    const groups = [];
    for (let gi = 0; gi < G_; gi++) {
      const a = gArea[gi];
      if (a <= 0) continue;
      const bw = gX1[gi] - gX0[gi] + 1, bh = gY1[gi] - gY0[gi] + 1;
      const cx = gSx[gi] / a, cy = gSy[gi] / a;
      const vx = Math.max(0.01, gSxx[gi] / a - cx * cx);
      const vy = Math.max(0.01, gSyy[gi] / a - cy * cy);
      const vxy = gSxy[gi] / a - cx * cy;
      const tr = vx + vy, df = vx - vy;
      const e1 = tr * 0.5 + Math.sqrt(df * df * 0.25 + vxy * vxy);
      const e2 = Math.max(0.01, tr * 0.5 - Math.sqrt(df * df * 0.25 + vxy * vxy));
      const mean = [Math.round(gSumR[gi] / a), Math.round(gSumG[gi] / a), Math.round(gSumB[gi] / a)];
      groups.push({
        gid: gi, bg: groupList[gi].bg, label: groupList[gi].label, area: a,
        x0: gX0[gi], y0: gY0[gi], x1: gX1[gi], y1: gY1[gi], bw, bh,
        cx, cy, angle: 0.5 * Math.atan2(2 * vxy, vx - vy), elong: Math.sqrt(e1 / e2),
        thick: a / Math.max(1, Math.max(bw, bh)), fill: a / Math.max(1, bw * bh),
        mean, pal: palette[groupList[gi].label] || mean,
        luma: gSumL[gi] / a, sal: gSumSal[gi] / a, edge: gSumEdge[gi] / a,
        flowCoh: Math.hypot(gFx[gi], gFy[gi]) / Math.max(1e-6, gFw[gi]),
        flowAngle: 0.5 * Math.atan2(gFy[gi], gFx[gi]),
      });
    }
    // 线稿网络（fill 极低的细线连通域）：扫线会把一根根线切成碎片，必须走骨架。
    const gidLuma = new Float64Array(G_);
    for (const g of groups) gidLuma[g.gid] = g.luma;
    for (const g of groups) {
      g.lineArt = (g.fill < 0.14 && g.thick < 26 && g.area > 200 && g.area < N * 0.05) ? 1 : 0;
      // 铅笔里，粗短线（闭眼弧、嘴、头顶线）也会被当成小色块排线，结果排成虚线；
      // 这类"深色细长块"直接走骨架，才能一笔连到底。彩笔仍按色块铺，保留粗眼线。
      g.inkOnly = (style === 'pencil' && !g.bg && g.luma < 112 && g.thick < 18 &&
        g.fill < 0.45 && g.area > 20 && g.area < N * 0.01) ? 1 : 0;
      // 照片量化后，任意两块颜色之间都夹着一条 1~2px 的过渡色细条，
      // 全按线稿描出来就是"填色书轮廓"。真正的轮廓线两侧明暗差很大，
      // 纹理过渡条两侧几乎同色——按"两侧对比"筛，而不是按线本身深浅。
      if ((g.lineArt || g.inkOnly) && !isFlat) {
        const step = Math.max(1, Math.round(Math.sqrt(g.bw * g.bh / 600)));
        let lmin = 255, lmax = 0;
        for (let y = Math.max(0, g.y0); y <= Math.min(H - 1, g.y1); y += step) {
          const row = y * W;
          for (let x = Math.max(0, g.x0); x <= Math.min(W - 1, g.x1); x += step) {
            const p = row + x;
            if (groupOf[p] !== g.gid) continue;
            for (let d = 0; d < 4; d++) {
              const q = d === 0 ? (x > 0 ? p - 1 : -1) : d === 1 ? (x + 1 < W ? p + 1 : -1) :
                d === 2 ? (y > 0 ? p - W : -1) : (y + 1 < H ? p + W : -1);
              if (q < 0) continue;
              const h = groupOf[q];
              if (h < 0 || h === g.gid) continue;
              const hl = gidLuma[h];
              if (hl < lmin) lmin = hl; if (hl > lmax) lmax = hl;
            }
          }
        }
        g.edgeContrast = lmax - lmin;
        if (g.lineArt && lmax - lmin < 34) g.lineArt = 0;
      }
    }
    if (opts.debug) {
      const la = groups.filter((g) => g.lineArt).length, io = groups.filter((g) => g.inkOnly).length;
      console.log('[line] lineArt=' + la + ' inkOnly=' + io);
    }
    // 主体：不贴边、显著度够的组；太少就退化为"最显著的几组"
    const subjectFlag = new Uint8Array(G_);
    let subjectArea = 0;
    for (const g of groups) {
      if (!g.bg && g.area >= Math.max(24, N * 0.00035) && g.sal >= 0.18) {
        subjectFlag[g.gid] = 1; subjectArea += g.area;
      }
    }
    if (subjectArea < N * 0.006) {
      const cand = groups.slice().sort((a, b) => (b.area * b.sal) - (a.area * a.sal)).slice(0, 6);
      subjectFlag.fill(0); subjectArea = 0;
      for (const g of cand) { subjectFlag[g.gid] = 1; subjectArea += g.area; }
    }
    const subject = new Uint8Array(N);
    const contentMask = new Uint8Array(N);
    let sSx = 0, sSy = 0, sSxx = 0, sSxy = 0, sSyy = 0, sN2 = 0;
    let sx0 = W, sy0 = H, sx1 = -1, sy1 = -1;
    let ctX0 = W, ctY0 = H, ctX1 = -1, ctY1 = -1;
    for (let y = 0; y < H; y++) {
      let p = y * W;
      for (let x = 0; x < W; x++, p++) {
        const gid = groupOf[p];
        if (gid >= 0) {
          contentMask[p] = 1;
          if (x < ctX0) ctX0 = x; if (x > ctX1) ctX1 = x;
          if (y < ctY0) ctY0 = y; if (y > ctY1) ctY1 = y;
        }
        if (gid < 0 || !subjectFlag[gid]) continue;
        subject[p] = 1; sN2++;
        sSx += x; sSy += y; sSxx += x * x; sSxy += x * y; sSyy += y * y;
        if (x < sx0) sx0 = x; if (x > sx1) sx1 = x;
        if (y < sy0) sy0 = y; if (y > sy1) sy1 = y;
      }
    }
    if (ctX1 < 0) { ctX0 = 0; ctY0 = 0; ctX1 = W - 1; ctY1 = H - 1; }
    if (!sN2) { sx0 = ctX0; sy0 = ctY0; sx1 = ctX1; sy1 = ctY1; sSx = (ctX0 + ctX1) * 0.5 * N; sSy = (ctY0 + ctY1) * 0.5 * N; sN2 = N; }
    const sCx = sSx / Math.max(1, sN2), sCy = sSy / Math.max(1, sN2);
    const sVx = Math.max(0.01, sSxx / Math.max(1, sN2) - sCx * sCx);
    const sVy = Math.max(0.01, sSyy / Math.max(1, sN2) - sCy * sCy);
    const sVxy = sSxy / Math.max(1, sN2) - sCx * sCy;
    const subjAngle = 0.5 * Math.atan2(2 * sVxy, sVx - sVy);
    const topSub = groups.filter((g) => subjectFlag[g.gid])
      .sort((a, b) => (b.sal * Math.sqrt(b.area)) - (a.sal * Math.sqrt(a.area)));
    let focalX = sCx, focalY = sCy;
    {
      let vx2 = 0, vy2 = 0, vw = 0;
      for (let i = 0; i < Math.min(3, topSub.length); i++) {
        const w = topSub[i].sal * topSub[i].area;
        vx2 += topSub[i].cx * w; vy2 += topSub[i].cy * w; vw += w;
      }
      if (vw > 0) { focalX = vx2 / vw; focalY = vy2 / vw; }
    }
    // 视觉中心：优先用"粉红/皮肤特征"（嘴唇、舌头、内耳、腮红）的加权重心。
    // 照片里大块白胸/橘背的 sal×area 会把焦点拉回身体，而五官才是辨识核心。
    {
      let px2 = 0, py2 = 0, pw = 0;
      for (let y = 0; y < H; y++) {
        let p = y * W;
        for (let x = 0; x < W; x++, p++) {
          if (paper[p]) continue;
          const rr = R[p], gg = G[p], bb = B[p];
          const rg = rr - gg, gb = gg - bb;
          if (rg < 28 || gb < 0 || gb > 30) continue;
          const w = (rg - 22) * (32 - gb);
          if (w <= 0) continue;
          px2 += x * w; py2 += y * w; pw += w;
        }
      }
      if (pw > N * 0.0004) {
        const fx = px2 / pw, fy = py2 / pw;
        if (fx > W * 0.04 && fx < W * 0.96 && fy > H * 0.04 && fy < H * 0.96) {
          focalX = fx; focalY = fy;
        }
      }
    }
    const subj = {
      x: sCx, y: sCy, angle: subjAngle, x0: sx0, y0: sy0, x1: sx1, y1: sy1,
      focalX, focalY,
    };
    groups.sort((a, b) => (b.bg - a.bg) || (b.area - a.area));
    const subjectD = dilate(subject, W, H, Math.max(1, Math.round(2 * scaleB)));

    if (opts.debug) {
      console.log('[focal]', Math.round(subj.focalX), Math.round(subj.focalY), 'subj', subj.count, 'bbox', subj.x0, subj.y0, subj.x1, subj.y1);
      const peaks = [];
      const minD = Math.min(W, H) * 0.07;
      for (let p = 0; p < N; p += 2) {
        if (paper[p] || sal[p] < 0.62) continue;
        const x = p % W, y = (p - x) / W;
        let ok = true;
        for (const q of peaks) if (Math.hypot(q.x - x, q.y - y) < minD) { ok = false; break; }
        if (!ok) continue;
        peaks.push({ x, y, s: sal[p], e: edge[p], gid: groupOf[p] });
        peaks.sort((a, b) => b.s - a.s);
        if (peaks.length > 12) peaks.length = 12;
      }
      console.log('[peaks]', peaks.slice(0, 8).map((q) => q.x + ',' + q.y + ':' + q.s.toFixed(2) + '/' + q.e.toFixed(1) + '/g' + q.gid).join(' '));
      console.log('[topSub]', topSub.slice(0, 8).map((g) => 'g' + g.gid + ' a' + g.area + ' s' + g.sal.toFixed(2) + ' b' + g.x0 + ',' + g.y0 + '-' + g.x1 + ',' + g.y1).join(' | '));
    }
    // ---- 预算：简单平涂给几十~一两百笔，照片给几百~一两千笔；档位只加"点睛"的余量 ----
    const flatHeavy = isFlat && G_ > 45;
    const flatFactor = isFlat ? (flatHeavy ? 1.45 : 1.08) : 3.0;
    const budgetBase = style === 'marker' ? [55, 85, 150, 215, 300] : style === 'oil' ? [70, 105, 160, 230, 330] : [90, 140, 210, 300, 430];
    let budget = Math.max(36, Math.round(budgetBase[fid - 1] * flatFactor * complexity));
    // 平涂但块数多的画面（海报、带文字/图案的插画）不能按"几十个色块"的额度给：
    // 至少每组约两笔，否则大片底色之间露白。
    if (isFlat) budget = Math.max(budget, Math.round(G_ * 1.9));
    // 照片默认档也要能把大色面铺满：2100 笔时约 1/3 画面还是模糊底透出来。
    // 2600 仍落在"2000~3000 笔有意义的笔触"区间内；简单平涂的档位不变。
    const hardCap = (isFlat ? [240, 360, 520, 760, 1100] : [1100, 1700, 2600, 3400, 4400])[fid - 1];
    const baseBudget = Math.max(24, Math.round(budget * 0.68));
    // 照片的识别度靠视觉中心的小笔，不靠再铺一遍大色块；给塑形/点睛单独留额度。
    // 底色层铺完还有几十万像素没被色块笔盖住，额度必须放到硬上限附近，
    // 否则大色面只铺一半、剩下的靠模糊底透出来，脸和毛色分区都会糊。
    const detailBudget = isFlat ? budget : Math.max(budget, hardCap - 300);
    // 铺色不能把硬上限吃光：以前照片铺完直接顶到 2600，ph2 只剩 0~12 笔，
    // "塑形"和"点睛"两段等于消失，铅笔也没有排线可看。到硬上限前先留出额度。
    const accentReserve = isFlat ? 0 : (style === 'pencil' ? 72 : 36);
    const detailReserve = isFlat ? 0 : Math.max(60,
      Math.round(budget * (style === 'pencil' ? 0.50 : 0.36)));
    const baseCap = Math.max(24, hardCap - detailReserve - accentReserve);
    // 海报/字稿（线稿块多）和照片（几乎没有线稿块）在铅笔下不是一回事：
    // 前者奶白色面是字心，排线会糊住字；后者白毛需要稀排线交代体积。
    const graphic = groups.reduce((n, g) => n + (g.lineArt ? 1 : 0), 0) >= 12;
    const styleW0 = style === 'marker' ? [110, 92, 74, 58, 44] : style === 'oil' ? [122, 100, 82, 64, 48] : [0, 0, 0, 0, 0];
    let baseBrush = Math.max(style === 'pencil' ? 3 : 8, styleW0[fid - 1] * scaleB);
    const styleStep = style === 'oil' ? 0.64 : 0.71;
    const styleMin = style === 'marker' ? 9 : (style === 'oil' ? 7 : 2.2);
    // 只有"整幅的大平色面"（海报蓝底这类）才换大侧锋；照片的深色毛/石墙
    // 虽然面积大、边缘低，仍要用中号笔保留形体和笔触，否则会变成几何色块。
    const bigFlatPencil = (g) => style === 'pencil' && !isFlat &&
      g.area > N * 0.08 && g.edge < 4 && g.fill > 0.5;
    function groupBrush(g) {
      let bw = baseBrush * (g.bg ? 1.28 : 1);
      bw *= 1 - 0.16 * Math.min(1, g.sal);
      bw = Math.min(bw, Math.max(2.5, g.thick * 1.5));
      if (g.area < bw * bw * 1.7) bw = Math.max(2.2, Math.sqrt(g.area) * 0.95);
      // 铅笔的大而平的色面（海报蓝底）要换侧锋：30px 的笔加有限预算只能铺到
      // 六成，剩下四成露出 wash 的局部明暗，就成了规则竖条。用大笔一趟铺满，
      // 整块是同一明度，条纹自然消失，笔触也更像人。
      if (bigFlatPencil(g)) {
        bw = Math.max(bw, Math.min(165 * scaleB, Math.sqrt(g.area) * 0.45));
      }
      return Math.max(styleMin, Math.min(165 * scaleB, bw));
    }
    {
      let est = 0;
      for (const g of groups) {
        const bw = groupBrush(g);
        est += g.area / Math.max(4, bw * bw * styleStep);
      }
      if (est > baseBudget * 1.02) {
        const scale = Math.min(2.6, Math.sqrt(est / (baseBudget * 1.02)));
        baseBrush = Math.min(165 * scaleB, baseBrush * scale);
      }
    }
    function regionAngle(g) {
      if (g.elong > 1.85) return g.angle;
      if (g.flowCoh > 0.16 && isFinite(g.flowAngle)) return g.flowAngle;
      if (g.bg) return (W >= H ? 0 : Math.PI * 0.5);
      return g.angle;
    }

    // ---- 规划画布 / 覆盖率 ----
    const canvas = new Uint8Array(N * 3);
    canvas.fill(255);
    const covered = new Uint8Array(N);
    // 底色层(wash)会先把整幅 covered 打成 1，拿 covered 判断"这块还差哪里"就永远为 0；
    // 单记一份"被本块自己的笔涂过"的位图，补漏/覆盖率才准。
    const paintN = new Uint8Array(N);
    let zoneCov = 0;
    let coveredN = 0;
    let groupUncov = new Int32Array(G_);
    let gStrokeN = new Int32Array(G_);
    for (const g of groups) groupUncov[g.gid] = g.area;
    const strokes = [], clips = [];
    let maskPx = 0;
    let forcePaint = false;
    const pushClip = (x, y, w, h, mask) => { maskPx += w * h; clips.push({ x, y, w, h, mask }); return clips.length - 1; };

    function sampleColor(mask, bw, bh, bx, by, stride) {
      let sr = 0, sg = 0, sb = 0, n = 0;
      for (let y = 0; y < bh; y += stride) {
        const row = (by + y) * W + bx;
        for (let x = 0; x < bw; x += stride) {
          if (!mask[y * bw + x]) continue;
          const p = row + x;
          sr += R[p]; sg += G[p]; sb += B[p]; n++;
        }
      }
      return n ? [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)] : null;
    }

    // 一笔：spine（绝对坐标）+ 每点半宽 → 变宽走廊 + 1 位掩膜
    // zoneGid / zoneMask 二选一：把笔形裁进"这个画块/主体"，形状不会糊到隔壁
    let strokeSeed = 0;
    function emitStroke(spine, halfs, color, ph, opt) {
      opt = opt || {};
      const n = spine.length >> 1;
      if (n < 2) return -1;
      if (ph > 0 && strokes.length >= hardCap && !opt.ignoreCap) return -1;
      const rib = ribbonProf(spine, n, halfs, false);
      let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
      for (let i = 0; i < rib.length; i += 2) {
        const x = rib[i], y = rib[i + 1];
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (y < miny) miny = y; if (y > maxy) maxy = y;
      }
      const bx = Math.max(0, Math.floor(minx)), by = Math.max(0, Math.floor(miny));
      const bw = Math.min(W - bx, Math.ceil(maxx) - bx + 1), bh = Math.min(H - by, Math.ceil(maxy) - by + 1);
      if (bw <= 0 || bh <= 0) return -1;
      const local = new Array(rib.length);
      for (let i = 0; i < rib.length; i += 2) { local[i] = rib[i] - bx; local[i + 1] = rib[i + 1] - by; }
      const mask = new Uint8Array(bw * bh);
      fillPoly(mask, bw, bh, local);
      let nInk = 0;
      const zg = opt.zoneGid === undefined ? -1 : opt.zoneGid;
      const zm = opt.zoneMask || null;
      const zmr = opt.zoneMaskRect || null;   // bbox 局部掩膜（结构笔用，省一次全图拷贝）
      for (let y = 0; y < bh; y++) {
        const row = (by + y) * W + bx;
        let mr = y * bw;
        for (let x = 0; x < bw; x++, mr++) {
          if (!mask[mr]) continue;
          const p = row + x;
          // 严格按像素标签裁剪。以前允许 1px 出界"融合"，但细描边/字边的
          // 每一层奶油像素都紧挨红描边，出界规则会把整条描边加宽成色块，
          // 字心就被啃出红/蓝的缺口。像素只属于一个色块，各画各的不会露缝。
          if (zg >= 0 && groupOf[p] !== zg) { mask[mr] = 0; continue; }
          if (zm && !zm[p]) { mask[mr] = 0; continue; }
          if (zmr) {
            const zx = bx + x - zmr.x0, zy = by + y - zmr.y0;
            if (zx < 0 || zy < 0 || zx >= zmr.w || zy >= zmr.h || !zmr.m[zy * zmr.w + zx]) {
              mask[mr] = 0; continue;
            }
          }
          nInk++;
        }
      }
      // 像素级二级抖动：把"比 8 位色阶更细"的局部均值落成两笔互补的 Bayer 网点。
      // 平涂背景的渐变每个像素只差零点几，用整块纯色画出来会在色阶处留下
      // 一圈圈马赫色带；两笔交错的网点在正常观看距离下融合成连续过渡，
      // 和原图自带的细噪声同一观感。
      let autoCol = null;
      if (opt.ditherAuto && nInk > 0) {
        // 只用本笔实际盖住的像素算浮点均值：扫带在色区边界上也不会取到隔壁/纸白。
        let sr = 0, sg = 0, sb = 0, sn = 0;
        for (let y = 0; y < bh; y++) {
          const row = (by + y) * W + bx;
          let mr = y * bw;
          for (let x = 0; x < bw; x++, mr++) {
            if (!mask[mr]) continue;
            const p = row + x;
            sr += R[p]; sg += G[p]; sb += B[p];
            sn++;
          }
        }
        if (sn) {
          const fr = [sr / sn, sg / sn, sb / sn];
          const ratio = Math.max(0.03, Math.min(0.97,
            (fr[0] - Math.floor(fr[0]) + fr[1] - Math.floor(fr[1]) + fr[2] - Math.floor(fr[2])) / 3));
          const lo = [Math.floor(fr[0]), Math.floor(fr[1]), Math.floor(fr[2])];
          const hi = [Math.min(255, lo[0] + 1), Math.min(255, lo[1] + 1), Math.min(255, lo[2] + 1)];
          const sel = opt.ditherPx && opt.ditherPx.sel ? 1 : 0;
          autoCol = sel ? hi : lo;
          if (opt.ditherPx) opt.ditherPx.ratio = ratio;
        }
      }
      if (opt.ditherPx && nInk > 0) {
        const BAY = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
        const th = opt.ditherPx.ratio * 16;
        const sel = opt.ditherPx.sel ? 1 : 0;
        let keep = 0;
        for (let y = 0; y < bh; y++) {
          const gy = by + y, row = gy * W + bx;
          let mr = y * bw;
          for (let x = 0; x < bw; x++, mr++) {
            if (!mask[mr]) continue;
            const hi = BAY[(gy & 3) * 4 + ((bx + x) & 3)] < th ? 1 : 0;
            if (hi !== sel) { mask[mr] = 0; continue; }
            keep++;
          }
        }
        nInk = keep;
      }
      // 先数完再决定要不要落笔：笔太小直接作废，不能留下"已计覆盖"的假账。
      if (nInk < (opt.minInk || 2)) return -1;
      // 铺底笔只改画面、不记覆盖：覆盖/查漏仍以各色区自己的精确笔为准，
      // 这样铺底没被后笔盖到的像素还能被查漏兜住，成品不会残留中间色。
      // noZone 同理：起稿笔裁在组内但不动 paintN/zoneCov，后面每组的精确笔
      // 仍然算"新增像素"，不会被零增益删除，细化才是真实的推进。
      const noCover = !!opt.noCover, noZone = !!opt.noZone;
      let col;
      if (opt.localColor) {
        // 渐变组：每条扫带取原图在这条带里的真实均值，后笔可以微调前笔的颜色。
        // 平涂背景再放宽一点：沿笔轴取小圆盘、只统计背景像素，让相邻色区的
        // 交界处取到同一条过渡色，成品不会出现一圈圈同心色带。
        const smpL = sampleColor(mask, bw, bh, bx, by, nInk > 30000 ? 3 : (nInk > 8000 ? 2 : 1));
        col = smpL || (opt.color ? [opt.color[0], opt.color[1], opt.color[2]] : [128, 128, 128]);
      } else if (opt.color) col = [opt.color[0], opt.color[1], opt.color[2]];
      else {
        const smp = sampleColor(mask, bw, bh, bx, by, nInk > 30000 ? 3 : (nInk > 8000 ? 2 : 1));
        const base = smp || [128, 128, 128];
        if (style === 'pencil') {
          // 铅笔和彩笔共用同一套观察/分区，只在落笔时转成灰阶。
          // 大色面按"这一块的计划明度"落笔：逐条扫带取局部原图，会把海报的
          // 旧纸/石墙画成规则竖条纹。明度层次交给块面，毛发变化交给排线和塑形。
          col = opt.paletteColor || base;
        } else if (style === 'marker') {
          col = opt.paletteColor || base;
          if (opt.deep) col = mix(col, [0, 0, 0], 0.10);
        } else {
          const tint = (rand01(strokeSeed * 1.7, 4.3) - 0.5) * 9;
          const warm = (strokeSeed % 5 === 0) ? 3 : 0;
          col = [
            clamp(Math.round(base[0] + tint + warm), 0, 255),
            clamp(Math.round(base[1] + tint * 0.7), 0, 255),
            clamp(Math.round(base[2] + tint * 0.4 - warm), 0, 255),
          ];
        }
      }
      if (autoCol) col = autoCol;
      if (opt.dither) {
        const t = rand01((opt.ditherSeed || 0), 7.3) - 0.5;
        const d = t * opt.dither;
        col = [clamp(Math.round(col[0] + d), 0, 255),
          clamp(Math.round(col[1] + d), 0, 255), clamp(Math.round(col[2] + d), 0, 255)];
      }
      if (style === 'pencil') {
        // 石墙/浅毛保留一点纸感，暗部不要压成纯黑；整体连续过渡。
        // ph1 是大面积侧锋铺底，稍微提亮一档，给后面的排线留出层次。
        const lv = col[0] * 0.299 + col[1] * 0.587 + col[2] * 0.114;
        const v = (!isFlat && ph === 1)
          ? clamp(Math.round(lv * 0.90 + 16), 20, 246)
          : clamp(Math.round(lv * 0.95 + 12), 18, 244);
        col = [v, v, v];
      }
      let len = 0;
      for (let i = 1; i < n; i++) len += Math.hypot(spine[i * 2] - spine[(i - 1) * 2], spine[i * 2 + 1] - spine[(i - 1) * 2 + 1]);
      let weight;
      if (opt.ms !== undefined) weight = opt.ms;
      else if (ph === 0) weight = 26 + len * 3.0;
      else if (ph === 1) weight = 20 + len * 2.4;
      else if (ph === 2) weight = 16 + len * 2.0;
      else weight = 14 + len * 1.8;
      weight *= 0.9 + 0.2 * rand01(len + strokeSeed * 0.37, ph + 1.3);
      // 弯笔更慢：人画弧线/拐弯时手腕要跟着转，同弧长的弯笔耗时更长。
      // 只影响回放节奏，不影响成品像素。
      if (n >= 2 && len > 8) {
        const chord = Math.hypot(spine[(n - 1) * 2] - spine[0], spine[(n - 1) * 2 + 1] - spine[1]);
        weight *= 1 + 0.30 * (1 - chord / len);
      }
      if (style === 'pencil') weight *= 0.72;
      strokeSeed++;
      const cIdx = pushClip(bx, by, bw, bh, mask);
      let hwMid = 0;
      for (let i = 0; i < n; i++) hwMid += halfs[i];
      const st = {
        rib: Array.from(rib, (v) => Math.round(v * 10) / 10),
        tp: Array.from(spine, (v) => Math.round(v * 10) / 10),
        w: Math.round(hwMid / n * 2 * 10) / 10,
        color: col, pen: opt.pen ? 1 : 0,
        ms: weight, c: cIdx, r: -1, ph: ph, ly: -1,
      };
      if (opts.tagStrokes) st.zg = zg;
      if (opt.fin) st.fin = 1;
      strokes.push(st);
      if (!noZone && zg >= 0 && zg < gStrokeN.length) gStrokeN[zg]++;
      for (let y = 0; y < bh; y++) {
        const row = (by + y) * W + bx;
        let mr = y * bw;
        for (let x = 0; x < bw; x++, mr++) {
          if (!mask[mr]) continue;
          const p = row + x, q = p * 3;
          canvas[q] = col[0]; canvas[q + 1] = col[1]; canvas[q + 2] = col[2];
          // 结构笔跨多个同色色块：按像素实际归属记账。色差在容差内的算画对；
          // 差得多的既不算"已画准"也不记账，留给本次结构的收尾/后面的精确笔重涂。
          let colorOK = true;
          if (!noZone && opt.zoneGroups && zg < 0) {
            const gg = groupOf[p];
            if (gg >= 0) {
              if (opt.zoneTol) {
                // 默认按组均值（结构笔，artist 原行为）；描边笔用 zonePx 按像素真实色——
                // 同一组里字心色和暗边色差很大，用组均值会把画对的像素判成没画对。
                const cb2 = opt.zonePx ? [R[p], G[p], B[p]] : groups[gg].mean;
                const dr = col[0] - cb2[0], dg = col[1] - cb2[1], db = col[2] - cb2[2];
                colorOK = dr * dr + dg * dg + db * db <= opt.zoneTol * opt.zoneTol;
              }
              if (colorOK && !paintN[p]) { paintN[p] = 1; zoneCov++; groupUncov[gg]--; }
            }
          } else if (!noZone && zg >= 0 && !paintN[p]) {
            paintN[p] = 1; zoneCov++; groupUncov[zg]--;
          }
          // 结构/描边笔可以要求"按几何覆盖"：涂到了就算覆盖，颜色偏差交给误差守卫，
          // 否则收尾查漏会把同一片区域按碎片组重画上千笔。默认仍按颜色算（artist 不变）。
          if (!noCover && (colorOK || opt.geomCover) && !covered[p]) { covered[p] = 1; coveredN++; }
        }
      }
      return strokes.length - 1;
    }

    // 一个实心色块是一个原子绘制事件：rib 覆盖整个包围盒，真实形状由
    // clip mask 决定。播放器看到 blk=1 时会在色块槽位开始后一次性落下整块，
    // 不再把一个色块拆成几十/几百条扫带。细线仍走 emitStroke。
    function emitBlockFill(x0, y0, bw, bh, mask, color, ph, opt) {
      opt = opt || {};
      if (!mask || bw <= 0 || bh <= 0) return -1;
      let nInk = 0;
      for (let i = 0; i < mask.length; i++) if (mask[i]) nInk++;
      if (nInk <= 0) return -1;
      const cIdx = pushClip(x0, y0, bw, bh, mask);
      const x1 = x0 + bw - 1, y1 = y0 + bh - 1;
      const cy = y0 + (bh - 1) * 0.5;
      const st = {
        // 矩形只负责覆盖 bbox；着色边界始终由裁剪掩膜决定。
        rib: [x0, y0, x1, y0, x1, y1, x0, y1],
        tp: [x0, cy, x0 + (bw - 1) * 0.5, cy, x1, cy],
        w: Math.max(4, Math.min(bw, bh) * 0.4),
        color: [Math.round(color[0]), Math.round(color[1]), Math.round(color[2])],
        pen: 0, c: cIdx, r: -1, ph: ph, ly: -1,
        blk: 1,
        // 原子块不需要搬运笔尖；播放器会把它当作"一块直接放下"。
        travelK: 0,
        fl: 1,
        ms: opt.ms !== undefined ? opt.ms : Math.round(130 + Math.min(240, Math.sqrt(nInk) * 0.18)),
      };
      if (opt.stage) st.stage = opt.stage;
      if (opts.tagStrokes && opt.zoneGid !== undefined) st.zg = opt.zoneGid;
      strokes.push(st);
      const col = st.color;
      const noCover = !!opt.noCover, noZone = !!opt.noZone;
      for (let y = 0; y < bh; y++) {
        const row = (y0 + y) * W, mr = y * bw;
        for (let x = 0; x < bw; x++) {
          if (!mask[mr + x]) continue;
          const p = row + x0 + x, q = p * 3;
          canvas[q] = col[0]; canvas[q + 1] = col[1]; canvas[q + 2] = col[2];
          if (!noZone && !paintN[p]) {
            paintN[p] = 1; zoneCov++;
            const gid = groupOf[p];
            if (gid >= 0) groupUncov[gid]--;
          }
          if (!noCover && !covered[p]) {
            // “碰过”不等于“画对”。原子块可能暂时用父色盖住文字/描边，
            // 若这里直接把 covered 记 1，后续残差守卫会以为这些像素已完成，
            // 字边和细线就永远得不到纠正。只有颜色已经进入容差的像素才算
            // 完成覆盖；暂时被父色盖住的像素仍会进入残差候选。
            const err = Math.max(
              Math.abs(col[0] - R[p]),
              Math.abs(col[1] - G[p]),
              Math.abs(col[2] - B[p]));
            if (err <= 48) {
              covered[p] = 1; coveredN++;
            }
          }
        }
      }
      return strokes.length - 1;
    }

    function profFill(n, halfW, seed) {
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const f = n > 1 ? i / (n - 1) : 0.5;
        const w = 0.93 + 0.07 * Math.sin(Math.PI * f);
        out[i] = Math.max(1, halfW * w * (0.94 + 0.12 * rand01(seed + i * 0.71, 2.1)));
      }
      return out;
    }
    function profLine(n, halfW, seed) {
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const f = n > 1 ? i / (n - 1) : 0.5;
        const taper = 0.30 + 0.70 * Math.pow(Math.sin(Math.PI * f), 0.55);
        out[i] = Math.max(0.7, halfW * taper * (0.85 + 0.3 * rand01(seed + i * 1.13, 5.7)));
      }
      return out;
    }
    function lineSpine(x0, y0, x1, y1, bow, seed, nP) {
      const n = nP || Math.max(2, Math.min(9, Math.round(Math.hypot(x1 - x0, y1 - y0) / 22)));
      const dx = x1 - x0, dy = y1 - y0, ln = Math.hypot(dx, dy) || 1;
      const nx = -dy / ln, ny = dx / ln;
      const out = new Float64Array(n * 2);
      for (let i = 0; i < n; i++) {
        const f = n > 1 ? i / (n - 1) : 0.5;
        const off = bow * Math.sin(Math.PI * f) + (rand01(seed + i * 0.37, 6.1) - 0.5) * 0.8;
        out[i * 2] = x0 + dx * f + nx * off;
        out[i * 2 + 1] = y0 + dy * f + ny * off;
      }
      return { pts: out, n };
    }

    // 线稿网络：细化后沿所有分支走笔。扫线会把一根 2~4px 的线切成大量 4px 小段，
    // 笔身又被裁在组内，线与线之间就断成虚线；骨架走笔才能一笔连到底。
    function traceLineGroup(g, pad) {
      // pad：掩膜四周留白。笔画顶满 bbox 时，细化永远不会删边界行/列，
      // 骨架会烂成整片；留 2px 空白才能正常细化（默认 0，老调用不变）。
      pad = pad || 0;
      const x0 = g.x0 - pad, y0 = g.y0 - pad;
      const w = g.x1 - g.x0 + 1 + pad * 2, h = g.y1 - g.y0 + 1 + pad * 2;
      if (w * h > 900000 || w < 3 || h < 3) return [];
      const m = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        const yy = y + y0;
        if (yy < 0 || yy >= H) continue;
        const row = yy * W;
        for (let x = 0; x < w; x++) {
          const xx = x + x0;
          if (xx >= 0 && xx < W && groupOf[row + xx] === g.gid) m[y * w + x] = 1;
        }
      }
      // 线稿被 3×3 多数投票和抗锯齿啃出 1~2px 缺口时，骨架会断成几十截；
      // 先闭合 1px 再细化，长轮廓才能一笔到底。
      const sk = thin(dilate(m, w, h, 1), w, h).sk;
      const idx = [];
      for (let i = 0; i < sk.length; i++) if (sk[i]) idx.push(i);
      if (!idx.length) return [];
      const deg = (i) => {
        const x = i % w, y = (i - x) / w;
        let d = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h && sk[yy * w + xx]) d++;
        }
        return d;
      };
      const seen = new Uint8Array(sk.length);
      const walk = (s) => {
        const pts = [];
        let cur = s, prev = -1;
        while (cur >= 0 && !seen[cur]) {
          seen[cur] = 1; pts.push(cur);
          const cx = cur % w, cy = (cur - cx) / w;
          let best = -1, bestScore = -1e9;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const ni = ny * w + nx;
            if (ni === prev || !sk[ni] || seen[ni]) continue;
            let sc = dx === 0 || dy === 0 ? 0.04 : 0;
            if (prev >= 0) {
              const px = prev % w, py = (prev - px) / w;
              sc += (cx - px) * dx + (cy - py) * dy;
            }
            if (sc > bestScore) { bestScore = sc; best = ni; }
          }
          prev = cur; cur = best;
        }
        return pts;
      };
      const raw = [];
      for (const i of idx) if (deg(i) === 1 && !seen[i]) { const p = walk(i); if (p.length >= 3) raw.push(p); }
      for (const i of idx) if (!seen[i]) { const p = walk(i); if (p.length >= 3) raw.push(p); }
      const out = [];
      for (const p of raw) {
        const abs = new Float64Array(p.length * 2);
        for (let i = 0; i < p.length; i++) { abs[i * 2] = p[i] % w + x0; abs[i * 2 + 1] = Math.floor(p[i] / w) + y0; }
        // 1.15px 容差在直径四五百像素的圆上会留下几十像素长的直弦：
        // 头部/身体轮廓看起来是一圈折线，误差图上整条边都是红晕。
        // 0.5px 仍能滤掉骨架的像素台阶，又让弦高小于笔宽，圆弧才圆。
        const sp = rdpSimplify(abs, p.length, 0.5);
        if (sp.n >= 2) out.push({ pts: sp.pts, n: sp.n, len: p.length });
      }
      out.sort((a, b) => b.len - a.len);
      return out;
    }

    // 结构蒙版（若干同色碎组并成的一条结构）的骨架走笔。
    // 与 traceLineGroup 同一套细化/走线，只是掩膜来自并查集结构而不是单个色块。
    function traceMaskPaths(m, w, h, x0, y0) {
      const sk = thin(dilate(m, w, h, 1), w, h).sk;
      const idx = [];
      for (let i = 0; i < sk.length; i++) if (sk[i]) idx.push(i);
      if (!idx.length) return [];
      const deg = (i) => {
        const x = i % w, y = (i - x) / w;
        let d = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h && sk[yy * w + xx]) d++;
        }
        return d;
      };
      const seen = new Uint8Array(sk.length);
      const walk = (st0) => {
        const pts = [];
        let cur = st0, prev = -1;
        while (cur >= 0 && !seen[cur]) {
          seen[cur] = 1; pts.push(cur);
          const cx = cur % w, cy = (cur - cx) / w;
          let best = -1, bestScore = -1e9;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const ni = ny * w + nx;
            if (ni === prev || !sk[ni] || seen[ni]) continue;
            let sc = dx === 0 || dy === 0 ? 0.04 : 0;
            if (prev >= 0) {
              const px = prev % w, py = (prev - px) / w;
              sc += (cx - px) * dx + (cy - py) * dy;
            }
            if (sc > bestScore) { bestScore = sc; best = ni; }
          }
          prev = cur; cur = best;
        }
        return pts;
      };
      const raw = [];
      for (const i of idx) if (deg(i) === 1 && !seen[i]) { const pp = walk(i); if (pp.length >= 3) raw.push(pp); }
      for (const i of idx) if (!seen[i]) { const pp = walk(i); if (pp.length >= 3) raw.push(pp); }
      const out = [];
      for (const pp of raw) {
        const abs = new Float64Array(pp.length * 2);
        for (let i = 0; i < pp.length; i++) { abs[i * 2] = pp[i] % w + x0; abs[i * 2 + 1] = Math.floor(pp[i] / w) + y0; }
        const sp = rdpSimplify(abs, pp.length, 0.5);
        if (sp.n >= 2) out.push({ pts: sp.pts, n: sp.n, len: pp.length });
      }
      out.sort((a, b) => b.len - a.len);
      return out;
    }

    // 长线切成段（一段一笔），保留 1 个点重叠让接缝不断
    function splitSkPath(path, maxLen) {
      const out = [];
      let a = 0;
      while (a < path.n - 1) {
        let b = a + 1, acc = 0;
        while (b < path.n) {
          const d = Math.hypot(path.pts[b * 2] - path.pts[(b - 1) * 2], path.pts[b * 2 + 1] - path.pts[(b - 1) * 2 + 1]);
          if (acc + d > maxLen && b - a >= 2) break;
          acc += d; b++;
        }
        if (b - a < 2) break;
        const sp = new Float64Array((b - a) * 2);
        for (let i = a; i < b; i++) { sp[(i - a) * 2] = path.pts[i * 2]; sp[(i - a) * 2 + 1] = path.pts[i * 2 + 1]; }
        out.push({ pts: sp, n: b - a, len: acc });
        a = b - 1;
      }
      return out;
    }

    function traceContours(mask, x0, y0, x1, y1, frame) {
      const segs = [];
      const MW = frame && frame.w ? frame.w : W;
      const MH = frame && frame.h ? frame.h : H;
      const at = (x, y) => (x < 0 || y < 0 || x >= MW || y >= MH) ? 0 : mask[y * MW + x];
      const ep = (x, y, e) => e === 0 ? [x + 0.5, y] : e === 1 ? [x + 1, y + 0.5] : e === 2 ? [x + 0.5, y + 1] : [x, y + 0.5];
      const add = (x, y, e1, e2) => { const a = ep(x, y, e1), b = ep(x, y, e2); segs.push([a[0], a[1], b[0], b[1]]); };
      const xa = Math.max(0, x0 - 1), ya = Math.max(0, y0 - 1), xb = Math.min(MW - 1, x1), yb = Math.min(MH - 1, y1);
      for (let y = ya; y <= yb; y++) {
        for (let x = xa; x <= xb; x++) {
          const a = at(x, y), b = at(x + 1, y), c = at(x + 1, y + 1), d = at(x, y + 1);
          const idx = (a ? 8 : 0) | (b ? 4 : 0) | (c ? 2 : 0) | (d ? 1 : 0);
          if (idx === 0 || idx === 15) continue;
          if (idx === 1) add(x, y, 3, 2);
          else if (idx === 2) add(x, y, 2, 1);
          else if (idx === 3) add(x, y, 3, 1);
          else if (idx === 4) add(x, y, 0, 1);
          else if (idx === 5) {
            if ((a + b + c + d) >= 2) { add(x, y, 0, 3); add(x, y, 1, 2); }
            else { add(x, y, 0, 1); add(x, y, 2, 3); }
          } else if (idx === 6) add(x, y, 0, 2);
          else if (idx === 7) add(x, y, 0, 3);
          else if (idx === 8) add(x, y, 0, 3);
          else if (idx === 9) add(x, y, 0, 2);
          else if (idx === 10) {
            if ((a + b + c + d) >= 2) { add(x, y, 0, 1); add(x, y, 2, 3); }
            else { add(x, y, 0, 3); add(x, y, 1, 2); }
          } else if (idx === 11) add(x, y, 0, 1);
          else if (idx === 12) add(x, y, 3, 1);
          else if (idx === 13) add(x, y, 2, 1);
          else if (idx === 14) add(x, y, 3, 2);
        }
      }
      const key = (x, y) => (Math.round(x * 2) * 1000003 + Math.round(y * 2));
      const map = new Map();
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        for (const k of [key(s[0], s[1]), key(s[2], s[3])]) {
          let arr = map.get(k); if (!arr) { arr = []; map.set(k, arr); }
          arr.push(i);
        }
      }
      const used = new Uint8Array(segs.length);
      const out = [];
      for (let i = 0; i < segs.length; i++) {
        if (used[i]) continue;
        used[i] = 1;
        const s = segs[i];
        const pts = [s[0], s[1], s[2], s[3]];
        let endK = key(s[2], s[3]), startK = key(s[0], s[1]);
        for (let guard = 0; guard < 20000; guard++) {
          const arr = map.get(endK);
          let ni = -1;
          if (arr) for (const j of arr) if (!used[j]) { ni = j; break; }
          if (ni < 0) break;
          used[ni] = 1;
          const t = segs[ni];
          const k1 = key(t[0], t[1]);
          const nx = k1 === endK ? t[2] : t[0], ny = k1 === endK ? t[3] : t[1];
          pts.push(nx, ny);
          endK = key(nx, ny);
          if (endK === startK) break;
        }
        if (pts.length < 6) continue;
        const r = rdpSimplify(pts, pts.length >> 1, Math.max(0.8, 1.15 * scaleB));
        if (r.n < 2) continue;
        out.push({ pts: r.pts, n: r.n });
      }
      return out;
    }

    function inkLine(g, path, ph) {
      if (path.n < 2) return;
      const hw = (style === 'pencil' ? 1.7 : (style === 'oil' ? 2.7 : 2.5)) * scaleB * (1 + 0.06 * (fid - 3));
      const lc = style === 'pencil' ? [52, 52, 52] :
        (style === 'marker' ? g.pal : mix(g.pal, [26, 22, 20], 0.35));
      // 铅笔线不再按色块裁：裁半宽会把 1px 宽的骨架线切成一截截虚线，
      // 灰度线本来就要压过色块边界；彩笔保留裁剪，避免色边溢出。
      const opt = { pen: 1, color: lc };
      if (style !== 'pencil') opt.zoneGid = g.gid;
      emitStroke(path.pts, profFill(path.n, hw, g.gid * 1.7 + path.len), lc, ph, opt);
    }

    // 线稿分两批：外圈结构先落（起形），五官/胡须等视觉中心留到点睛。
    const lineChunksLate = [];

    // ---- 极简线稿：整幅就是几根笔画（两横一竖、十、干这类简笔画）----
    // 人不会给三条线铺底色/排线/补笔。骨架拆成几根最大笔画，一根一笔：
    // 方向照骨架中心线，粗细照内切距离（笔宽 = 原图笔画宽度）。
    // 有一块拆不出均匀细笔画（大色块/照片/海报）就整体退回正常通路。
    // compiler 也复用这份中心线结果，并在统计里把它标成 compiler 的对象决策，
    // 这样简单线稿不会被区域填色器拆成几十条横带。
    let trivialDone = false;
    let trivialPlanInfo = null;
    {
      const inkGroups = groups.filter((g) => g.area >= 24 && g.area < N * 0.5 &&
        !(g.bg && g.luma > 232 &&
          Math.max(g.mean[0], g.mean[1], g.mean[2]) - Math.min(g.mean[0], g.mean[1], g.mean[2]) < 26));
      let inkArea = 0;
      for (const g of inkGroups) inkArea += g.area;
      const maxHW = Math.max(10, Math.min(W, H) * 0.055);
      if (inkGroups.length && inkGroups.length <= 12 && inkArea < N * 0.42) {
        const parts = [];
        let ok = true;
        for (const g of inkGroups) {
          const gw = g.x1 - g.x0 + 1, gh = g.y1 - g.y0 + 1;
          const paths = (gw * gh <= 900000) ? traceLineGroup(g, 2) : [];
          // 距离变换的掩膜同样要留白：笔画顶满 bbox 时没有背景可量，内切距离全是 INF
          const PD = 2, pw = gw + PD * 2, phh = gh + PD * 2;
          let dtv = null;
          if (paths.length) {
            const m = new Uint8Array(pw * phh);
            for (let y = 0; y < gh; y++) {
              const row = (y + g.y0) * W + g.x0;
              for (let x = 0; x < gw; x++) if (groupOf[row + x] === g.gid) m[(y + PD) * pw + x + PD] = 1;
            }
            dtv = distanceTransform(m, pw, phh);
          }
          const dtAt = (ax, ay) => {
            if (!dtv) return 0;
            const x = Math.round(ax) - g.x0 + PD, y = Math.round(ay) - g.y0 + PD;
            if (x < 0 || y < 0 || x >= pw || y >= phh) return 0;
            const d = dtv[y * pw + x];
            return d >= 1e8 ? 0 : d;
          };
          const hwOf = (path) => {
            // 取沿路径的中位内切距离：交叉点处能放进更大的圆，取最大值会把
            // 横笔在"干"字交点处撑粗一截；中位数才是笔画本身的粗细。
            const samples = [];
            for (let i = 1; i < path.n; i++) {
              const ax = path.pts[(i - 1) * 2], ay = path.pts[(i - 1) * 2 + 1];
              const bx = path.pts[i * 2], by = path.pts[i * 2 + 1];
              const steps = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / 2));
              for (let k = 0; k <= steps; k++) {
                const f = k / steps;
                samples.push(dtAt(ax + (bx - ax) * f, ay + (by - ay) * f));
              }
            }
            if (!samples.length) return 0;
            samples.sort((a, b) => a - b);
            return samples[samples.length >> 1];
          };
          const tang2 = (pts, i, j) => {
            const dx = pts[j * 2] - pts[i * 2], dy = pts[j * 2 + 1] - pts[i * 2 + 1];
            const l = Math.hypot(dx, dy) || 1;
            return [dx / l, dy / l];
          };
          const cands = [];
          for (const path of paths) {
            const hw = hwOf(path);
            if (path.len < Math.max(6, hw * 2.4)) continue;   // 交点上的毛刺不算笔画
            if (hw < 1) continue;
            if (hw > maxHW) { ok = false; break; }
            cands.push({ pts: Array.from(path.pts), hw: hw + 0.9, len: path.len });
          }
          // 贪心走笔在交叉点把一根笔画截成几段：把"端点相接、来去同向"的段接回去，
          // 干/十字才是一笔一画，而不是一堆积木。细化还会把方头笔画两端吃掉约半个
          // 笔宽，最后沿端点切线延伸回去，zoneGid 会把出界部分裁成原形。
          let didMerge = true;
          while (didMerge && cands.length > 1) {
            didMerge = false;
            for (let i = 0; i < cands.length && !didMerge; i++) {
              for (let j = 0; j < cands.length && !didMerge; j++) {
                if (i === j) continue;
                const A = cands[i], B = cands[j];
                const nA = A.pts.length >> 1, nB = B.pts.length >> 1;
                if (nA < 2 || nB < 2) continue;
                // [A 的接点在尾?，B 的接点在头?，A 反转，B 反转]
                const combos = [[1, 1, 0, 0], [1, 0, 0, 1], [0, 1, 1, 0], [0, 0, 1, 1]];
                for (const [aE, bS, revA, revB] of combos) {
                  const axp = A.pts[aE ? (nA - 1) * 2 : 0], ayp = A.pts[aE ? (nA - 1) * 2 + 1 : 1];
                  const bxp = B.pts[bS ? 0 : (nB - 1) * 2], byp = B.pts[bS ? 1 : (nB - 1) * 2 + 1];
                  const tol = dtAt(axp, ayp) + dtAt(bxp, byp) + 8;
                  if (Math.hypot(axp - bxp, ayp - byp) > tol) continue;
                  // A 到达接点的方向 ≈ B 离开接点的方向，才是顺承的一根笔画
                  const da = tang2(A.pts, aE ? nA - 2 : 1, aE ? nA - 1 : 0);
                  const db = tang2(B.pts, bS ? 0 : nB - 1, bS ? 1 : nB - 2);
                  if (da[0] * db[0] + da[1] * db[1] < 0.7) continue;
                  const mp = [];
                  if (revA) for (let k = nA - 1; k >= 0; k--) mp.push(A.pts[k * 2], A.pts[k * 2 + 1]);
                  else for (let k = 0; k < nA; k++) mp.push(A.pts[k * 2], A.pts[k * 2 + 1]);
                  if (revB) for (let k = nB - 2; k >= 0; k--) mp.push(B.pts[k * 2], B.pts[k * 2 + 1]);
                  else for (let k = 1; k < nB; k++) mp.push(B.pts[k * 2], B.pts[k * 2 + 1]);
                  cands.splice(j, 1);
                  A.pts = mp; A.hw = Math.max(A.hw, B.hw); A.len += B.len;
                  didMerge = true;
                  break;
                }
              }
            }
          }
          if (ok && !cands.length && paths.length) {
            // 小圆点/极短笔：骨架只剩一小截，按一记点笔处理
            const hw = hwOf(paths[0]);
            if (hw >= 1 && hw <= maxHW) cands.push({ pts: Array.from(paths[0].pts), hw: hw + 0.9, len: paths[0].len });
            else ok = false;
          }
          if (ok && !paths.length) ok = false;    // 连骨架都走不出的块，交回正常通路
          if (!ok) break;
          const gparts = [];
          for (const piece of cands) {
            const n0 = piece.pts.length >> 1;
            if (n0 < 2) continue;
            const extPt = (i0, i1) => {
              const d = dtAt(piece.pts[i0 * 2], piece.pts[i0 * 2 + 1]);
              if (d < 1) return null;
              const ux = piece.pts[i0 * 2] - piece.pts[i1 * 2], uy = piece.pts[i0 * 2 + 1] - piece.pts[i1 * 2 + 1];
              const l = Math.hypot(ux, uy) || 1;
              return [piece.pts[i0 * 2] + ux / l * d, piece.pts[i0 * 2 + 1] + uy / l * d];
            };
            const eS = extPt(0, 1), eE = extPt(n0 - 1, n0 - 2);
            const n = n0 + (eS ? 1 : 0) + (eE ? 1 : 0);
            const pts = new Float64Array(n * 2);
            let k = 0;
            if (eS) { pts[k++] = eS[0]; pts[k++] = eS[1]; }
            for (let i = 0; i < n0; i++) { pts[k++] = piece.pts[i * 2]; pts[k++] = piece.pts[i * 2 + 1]; }
            if (eE) { pts[k++] = eE[0]; pts[k++] = eE[1]; }
            gparts.push({ g, path: { pts, n, len: piece.len }, hw: piece.hw });
          }
          parts.push(...gparts);
          if (parts.length > 26) { ok = false; break; }
        }
        if (ok && parts.length) {
          // 顺序照写字的习惯：横的先画（自上而下），竖的后画（自左而右）
          const vertOf = (pt) => Math.abs(pt.pts[(pt.n - 1) * 2] - pt.pts[0]) <
            Math.abs(pt.pts[(pt.n - 1) * 2 + 1] - pt.pts[1]);
          const topOf = (pt) => Math.min(pt.pts[1], pt.pts[(pt.n - 1) * 2 + 1]);
          const leftOf = (pt) => Math.min(pt.pts[0], pt.pts[(pt.n - 1) * 2]);
          parts.sort((a, b) => (vertOf(a.path) - vertOf(b.path)) ||
            (topOf(a.path) - topOf(b.path)) || (leftOf(a.path) - leftOf(b.path)));
          prog(0.55, '极简线稿：照原样落笔…');
          await yieldUI();
          for (const part of parts) {
            const { g, path, hw } = part;
            let len = 0;
            for (let i = 1; i < path.n; i++) {
              len += Math.hypot(path.pts[i * 2] - path.pts[(i - 1) * 2], path.pts[i * 2 + 1] - path.pts[(i - 1) * 2 + 1]);
            }
            emitStroke(path.pts, profFill(path.n, hw, g.gid * 5.1 + path.len), g.pal, 1, {
              pen: 1, color: g.pal, zoneGid: g.gid, ms: Math.round(340 + len * 2.6),
            });
          }
          trivialDone = strokes.length > 0;
          if (trivialDone) trivialPlanInfo = { mode: 'centerline', parts: parts.length, groups: inkGroups.length, paintable: inkArea };
          if (opts.debug) {
            console.log('[artist] trivial: strokes=' + strokes.length + ' inkGroups=' + inkGroups.length +
              ' maxHW=' + maxHW.toFixed(1));
          }
        }
      }
    }

    // 低色数线稿：量化会把长线切成大量同色碎组，逐组补缝会把二三十条
    // 中心线拆成上千笔。compiler 在这里按调色板标签把碎组合回完整墨线；
    // 只要除主底色外的所有色都是细线，就沿全局中心线一次画完。
    if (!trivialDone && opts.algo === 'compiler' && palette.length >= 2 && palette.length <= 8) {
      const stats = palette.map((c, i) => ({ i, c, n: 0, x0: W, y0: H, x1: -1, y1: -1 }));
      for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
          const s = stats[labels[row + x]];
          if (!s) continue;
          s.n++;
          if (x < s.x0) s.x0 = x; if (x > s.x1) s.x1 = x;
          if (y < s.y0) s.y0 = y; if (y > s.y1) s.y1 = y;
        }
      }
      const live = stats.filter((s) => s.n >= 24 && s.x1 >= s.x0 && s.y1 >= s.y0)
        .sort((a, b) => b.n - a.n);
      const bg = live[0];
      const ink = live.slice(1);
      const maxLineThick = Math.max(12, Math.min(W, H) * 0.045);
      const lineLikeLabel = (s) => {
        const bw = s.x1 - s.x0 + 1, bh = s.y1 - s.y0 + 1;
        const thick = s.n / Math.max(1, Math.max(bw, bh));
        const fill = s.n / Math.max(1, bw * bh);
        return s.n <= N * 0.12 && thick <= maxLineThick && fill <= 0.30;
      };
      const inkPx = ink.reduce((a, s) => a + s.n, 0);
      if (bg && bg.n + paperPx > N * 0.45 && luma(bg.c) >= 170 && ink.length >= 1 && ink.length <= 6 &&
          inkPx < N * 0.30 && ink.every(lineLikeLabel)) {
        let made = 0;
        for (const s of ink) {
          const bw = s.x1 - s.x0 + 1, bh = s.y1 - s.y0 + 1;
          const m = new Uint8Array(bw * bh);
          for (let yy = 0; yy < bh; yy++) {
            const row = (s.y0 + yy) * W + s.x0;
            for (let xx = 0; xx < bw; xx++) if (labels[row + xx] === s.i) m[yy * bw + xx] = 1;
          }
          const paths = traceMaskPaths(m, bw, bh, s.x0, s.y0);
          if (!paths.length) continue;
          const PD = 2, pw = bw + PD * 2, phh = bh + PD * 2;
          const dm = new Uint8Array(pw * phh);
          for (let yy = 0; yy < bh; yy++) {
            const row = yy * bw;
            for (let xx = 0; xx < bw; xx++) if (m[row + xx]) dm[(yy + PD) * pw + xx + PD] = 1;
          }
          const dtv = distanceTransform(dm, pw, phh);
          const dtAt = (ax, ay) => {
            const xx = Math.round(ax) - s.x0 + PD, yy = Math.round(ay) - s.y0 + PD;
            if (xx < 0 || yy < 0 || xx >= pw || yy >= phh) return 0;
            const d = dtv[yy * pw + xx];
            return d >= 1e8 ? 0 : d;
          };
          const zmr = { m, x0: s.x0, y0: s.y0, w: bw, h: bh };
          for (const path of paths) {
            const halfs = new Float64Array(path.n);
            for (let i = 0; i < path.n; i++) {
              halfs[i] = clamp(dtAt(path.pts[i * 2], path.pts[i * 2 + 1]) * 0.95 + 2.1, 2.6, 14.0);
            }
            const si = emitStroke(path.pts, halfs, s.c, 1, {
              zoneMaskRect: zmr, color: s.c, noCover: 0, noZone: 1, minInk: 1,
              ms: Math.round(90 + path.len * 2.0),
            });
            if (si >= 0) {
              strokes[si].stage = 'compiler:centerline';
              strokes[si].travelK = 0.18;
              strokes[si].fl = 1;
              made++;
            }
          }
        }
        // 中心线骨架在局部粗细突变、交点或圆弧合并处可能漏走一小段。
        // 这里只检查“仍未被任何笔覆盖”的原墨线像素，并在同一个真实
        // 墨线 mask 内补走；不扩线、不刷白底，也不使用邻色均值。
        let lineRepair = 0;
        for (const s of ink) {
          const bw = s.x1 - s.x0 + 1, bh = s.y1 - s.y0 + 1;
          const miss = new Uint8Array(bw * bh);
          let missN = 0;
          for (let yy = 0; yy < bh; yy++) {
            const row = (s.y0 + yy) * W + s.x0;
            for (let xx = 0; xx < bw; xx++) {
              if (labels[row + xx] !== s.i) continue;
              if (covered[row + xx]) continue;
              miss[yy * bw + xx] = 1; missN++;
            }
          }
          if (!missN) continue;
          const zmr = { m: miss, x0: s.x0, y0: s.y0, w: bw, h: bh };
          const mpaths = traceMaskPaths(miss, bw, bh, s.x0, s.y0);
          if (!mpaths.length) {
            let x0 = bw, y0 = bh, x1 = -1, y1 = -1;
            for (let yy = 0; yy < bh; yy++) for (let xx = 0; xx < bw; xx++) {
              if (!miss[yy * bw + xx]) continue;
              if (xx < x0) x0 = xx; if (xx > x1) x1 = xx;
              if (yy < y0) y0 = yy; if (yy > y1) y1 = yy;
            }
            if (x1 >= x0 && y1 >= y0) {
              const xa = s.x0 + x0, xb = s.x0 + x1;
              const ya = s.y0 + y0, yb = s.y0 + y1;
              const sp = xb > xa
                ? new Float64Array([xa, (ya + yb) * 0.5, xb, (ya + yb) * 0.5])
                : new Float64Array([(xa + xb) * 0.5, ya, (xa + xb) * 0.5, yb]);
              const hb = new Float64Array([2.4, 2.4]);
              const si = emitStroke(sp, hb, s.c, 1, {
                zoneMaskRect: zmr, color: s.c, noCover: 0, noZone: 1, minInk: 1,
                ms: 90,
              });
              if (si >= 0) { strokes[si].stage = 'compiler:centerline-repair'; strokes[si].fl = 1; lineRepair++; }
            }
          } else {
            for (const path of mpaths) {
              const hb = new Float64Array(path.n);
              for (let i = 0; i < path.n; i++) hb[i] = 2.6;
              const si = emitStroke(path.pts, hb, s.c, 1, {
                zoneMaskRect: zmr, color: s.c, noCover: 0, noZone: 1, minInk: 1,
                ms: Math.round(80 + path.len * 1.5),
              });
              if (si >= 0) { strokes[si].stage = 'compiler:centerline-repair'; strokes[si].fl = 1; lineRepair++; }
            }
          }
        }
        // 最后一次像素级封口：骨架和上面的补线仍可能在极小圆角、交叉口或
        // 单像素端点留下空隙。这里只扫描“原墨线标签内、仍未覆盖”的横向
        // run，并逐 run 用一像素高的局部笔补齐；笔形仍裁在原墨线 mask 内，
        // 所以不会把白底、邻色或抗锯齿外包进来。它数量很少，是确定性兜底，
        // 不是用大量均值补丁重画整条线。
        let lineSeal = 0;
        for (const s of ink) {
          const bw = s.x1 - s.x0 + 1, bh = s.y1 - s.y0 + 1;
          for (let yy = 0; yy < bh; yy++) {
            const row = (s.y0 + yy) * W + s.x0;
            let xx = 0;
            while (xx < bw) {
              while (xx < bw && (labels[row + xx] !== s.i || covered[row + xx])) xx++;
              if (xx >= bw) break;
              const xa = xx;
              while (xx < bw && labels[row + xx] === s.i && !covered[row + xx]) xx++;
              const xb = xx - 1;
              const rw = xb - xa + 1;
              const local = new Uint8Array(rw);
              local.fill(1);
              const zmr = { m: local, x0: s.x0 + xa, y0: s.y0 + yy, w: rw, h: 1 };
              const sp = new Float64Array([
                s.x0 + xa + 0.05, s.y0 + yy + 0.5,
                s.x0 + xb + 0.95, s.y0 + yy + 0.5,
              ]);
              const hb = new Float64Array([1.25, 1.25]);
              const si = emitStroke(sp, hb, s.c, 1, {
                zoneMaskRect: zmr, color: s.c, noCover: 0, noZone: 1, minInk: 1,
                ms: 34,
              });
              if (si >= 0) {
                strokes[si].stage = 'compiler:centerline-seal';
                strokes[si].travelK = 0.08;
                strokes[si].fl = 1;
                lineSeal++;
              }
            }
          }
        }
        made += lineRepair + lineSeal;
        if (made) {
          trivialDone = true;
          trivialPlanInfo = { mode: 'color-centerline', parts: made, groups: ink.length, paintable: inkPx };
          prog(0.55, '线稿：沿同色墨线一笔到底…');
        }
      }
    }
    // ================= 精确临摹通路 =================
    // 观察到的每个色区都按原图真实颜色落笔：先用保边平滑图做"局部容差漫水"，
    // 得到边界贴合的色区；再按色区形状选长线笔或宽扫笔。只有"怎么走笔"随机，
    // 色区、颜色、覆盖范围都不随机——换种子只会换作画过程，不会换成品。
    let exactInfo = null;
    async function runExactCopy() {
      const tEx = Date.now();
      const flatArt = isFlat || flatScore > 0.52;
      const TOL = flatArt ? 1.4 : 6.0;
      const GBLUR = 2;
      const GEPS = flatArt ? 120 : 260;
      const MINA = flatArt ? 80 : 220;
      const MERGE_CD = flatArt ? 0.8 : 10;
      const PROT_AREA = flatArt ? 1 : 8;
      const runSeed = (opts.seed === undefined || opts.seed === null)
        ? 1 : (opts.seed >>> 0);
      // 只把种子混进"过程"随机量：起笔位置、扫带相位、弓弯、分行、组顺序。
      const srnd = (k, q) => rand01(k * 0.917 + runSeed * 0.618 + 0.13, 3.7 + (q || 0) + runSeed * 0.011);
      const modeName = flatArt ? 'flat' : 'photo';
      const painterFlow = opts.algo === 'painter';
      const compilerFlow = opts.algo === 'compiler';
      let pfObjects = 0;
      let pfRing = false;
      let painterActive = false;
      let painterBgFill = '';
      let closedActive = false;
      let closedPlan = null;
      let compilerActive = false;
      let compilerPlan = null;
      let pfClosedRegions = 0;

      prog(flatArt ? 0.18 : 0.16, flatArt ? '观察：平滑轮廓与封闭色块…' : '观察：主体结构与明暗…');
      await yieldUI();

      // ---- 保边平滑：只用于"判断哪些像素属于同一色区"，取色仍回到原图 ----
      const Lf = new Float32Array(N);
      for (let p = 0; p < N; p++) Lf[p] = L[p];
      const mI = blurF(Lf, GBLUR);
      const sq = new Float32Array(N);
      for (let p = 0; p < N; p++) sq[p] = Lf[p] * Lf[p];
      const mII = blurF(sq, GBLUR);
      const aF = new Float32Array(N), bF = new Float32Array(N);
      for (let p = 0; p < N; p++) {
        const v = Math.max(0, mII[p] - mI[p] * mI[p]);
        aF[p] = v / (v + GEPS);
        bF[p] = mI[p] * (1 - aF[p]);
      }
      const maF = blurF(aF, GBLUR), mbF = blurF(bF, GBLUR);
      const D0 = new Float32Array(N), D1 = new Float32Array(N), D2 = new Float32Array(N);
      for (let p = 0; p < N; p++) {
        D0[p] = R[p] * maF[p] + mbF[p];
        D1[p] = G[p] * maF[p] + mbF[p];
        D2[p] = B[p] * maF[p] + mbF[p];
      }

      // ---- 局部容差漫水：只和"种子色 / 上一个像素"比较，渐变会分成很窄的带，
      // 不会像全图 K-means 那样把整片背景压成一个色块；细线也不会被背景吃掉 ----
      prog(0.24, '分色区：贴着边界生长…');
      await yieldUI();
      // 纸底边缘有一圈抗锯齿过渡色：纯纸底跳过，但紧贴画面的那 1px 也参与分色，
      // 否则外轮廓会留下白色锯齿。纯白纸面仍然不落笔。
      const segPaper = new Uint8Array(N);
      segPaper.set(paper);
      let rimPx = 0;
      for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
          const p = row + x;
          if (!paper[p]) continue;
          if ((x > 0 && !paper[p - 1]) || (x + 1 < W && !paper[p + 1]) ||
              (y > 0 && !paper[p - W]) || (y + 1 < H && !paper[p + W])) segPaper[p] = 0;
        }
      }
      for (let p = 0; p < N; p++) if (paper[p] && !segPaper[p]) rimPx++;
      const lab = new Int32Array(N).fill(-1);
      const regions = [];
      const stack = new Int32Array(N);
      for (let s = 0; s < N; s++) {
        if (lab[s] >= 0 || segPaper[s]) continue;
        const ri = regions.length;
        const s0 = D0[s], s1 = D1[s], s2 = D2[s];
        let top = 0;
        stack[top++] = s;
        lab[s] = ri;
        let n = 0, sr = 0, sg = 0, sb = 0;
        let x0 = W, y0 = H, x1 = -1, y1 = -1;
        while (top) {
          const p = stack[--top];
          n++;
          sr += R[p]; sg += G[p]; sb += B[p];
          const x = p % W, y = (p - x) / W;
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
          const tryAdd = (q) => {
            if (q < 0 || q >= N || lab[q] >= 0 || segPaper[q]) return;
            const d0 = D0[q] - s0, d1 = D1[q] - s1, d2 = D2[q] - s2;
            const ad0 = d0 < 0 ? -d0 : d0, ad1 = d1 < 0 ? -d1 : d1, ad2 = d2 < 0 ? -d2 : d2;
            const ds = ad0 > ad1 ? (ad0 > ad2 ? ad0 : ad2) : (ad1 > ad2 ? ad1 : ad2);
            if (ds > TOL) return;
            const e0 = D0[q] - D0[p], e1 = D1[q] - D1[p], e2 = D2[q] - D2[p];
            const ae0 = e0 < 0 ? -e0 : e0, ae1 = e1 < 0 ? -e1 : e1, ae2 = e2 < 0 ? -e2 : e2;
            if (ae0 + ae1 + ae2 > TOL * 3) return;
            lab[q] = ri;
            stack[top++] = q;
          };
          if (x > 0) tryAdd(p - 1);
          if (x + 1 < W) tryAdd(p + 1);
          if (y > 0) tryAdd(p - W);
          if (y + 1 < H) tryAdd(p + W);
        }
        regions.push({ n, sr, sg, sb, x0, y0, x1, y1 });
      }
      const RN = regions.length;
      if (opts.debug) console.log('[exact] ' + modeName + ' 初始色区=' + RN);

      if (opts.debug && typeof process !== 'undefined' && process.env && process.env.DARK_RECT) {
        const [rx0, ry0, rx1, ry1] = process.env.DARK_RECT.split(',').map(Number);
        const hits = [];
        for (let i = 0; i < RN; i++) {
          const r = regions[i];
          if (r.x1 < rx0 || r.x0 > rx1 || r.y1 < ry0 || r.y0 > ry1) continue;
          hits.push({ i, n: r.n, m: [Math.round(r.sr / r.n), Math.round(r.sg / r.n), Math.round(r.sb / r.n)],
            box: [r.x0, r.y0, r.x1, r.y1] });
        }
        hits.sort((a, b) => b.n - a.n);
        for (const h of hits.slice(0, 14)) console.log('[region] #' + h.i + ' n=' + h.n + ' m=' + JSON.stringify(h.m) + ' box=' + JSON.stringify(h.box));
      }

      // ---- 碎块归并：抗锯齿过渡带夹在两侧颜色之间，不是局部极值，并进最近色；
      // 线、细高光、瞳孔高光这些"比四周都暗/都亮"的小结构保留，它们决定像不像 ----
      prog(0.34, '清理碎色：保留线和高光…');
      await yieldUI();
      const parent = new Int32Array(RN).fill(-1);
      const findR = (i) => {
        let r = i;
        while (parent[r] >= 0) r = parent[r];
        while (i !== r) { const nx = parent[i]; parent[i] = r; i = nx; }
        return r;
      };
      const area = new Int32Array(RN);
      const sR = new Float64Array(RN), sG = new Float64Array(RN), sB = new Float64Array(RN);
      const bX0 = new Int32Array(RN), bY0 = new Int32Array(RN);
      const bX1 = new Int32Array(RN), bY1 = new Int32Array(RN);
      for (let i = 0; i < RN; i++) {
        const r = regions[i];
        area[i] = r.n; sR[i] = r.sr; sG[i] = r.sg; sB[i] = r.sb;
        bX0[i] = r.x0; bY0[i] = r.y0; bX1[i] = r.x1; bY1[i] = r.y1;
      }
      const buildAdj = () => {
        const adj = new Array(RN);
        const add = (a, b) => {
          a = findR(a); b = findR(b);
          if (a === b || a < 0 || b < 0) return;
          let m = adj[a]; if (!m) { m = new Map(); adj[a] = m; }
          m.set(b, (m.get(b) || 0) + 1);
          m = adj[b]; if (!m) { m = new Map(); adj[b] = m; }
          m.set(a, (m.get(a) || 0) + 1);
        };
        for (let y = 0; y < H; y++) {
          const row = y * W;
          for (let x = 0; x < W; x++) {
            const p = row + x;
            if (lab[p] < 0) continue;
            if (x + 1 < W && lab[p + 1] >= 0) add(lab[p], lab[p + 1]);
            if (y + 1 < H && lab[p + W] >= 0) add(lab[p], lab[p + W]);
          }
        }
        return adj;
      };
      const mergeRoots = (ai, bi) => {
        const a = findR(ai), b = findR(bi);
        if (a === b) return 0;
        const wa = area[a], wb = area[b];
        const mx0 = Math.min(bX0[a], bX0[b]), my0 = Math.min(bY0[a], bY0[b]);
        const mx1 = Math.max(bX1[a], bX1[b]), my1 = Math.max(bY1[a], bY1[b]);
        if (wa > wb) {
          parent[b] = a; area[a] += wb; sR[a] += sR[b]; sG[a] += sG[b]; sB[a] += sB[b]; area[b] = 0;
          bX0[a] = mx0; bY0[a] = my0; bX1[a] = mx1; bY1[a] = my1;
        } else {
          parent[a] = b; area[b] += wa; sR[b] += sR[a]; sG[b] += sG[a]; sB[b] += sB[a]; area[a] = 0;
          bX0[b] = mx0; bY0[b] = my0; bX1[b] = mx1; bY1[b] = my1;
        }
        return 1;
      };
      let passN = 0;
      for (let pass = 0; pass < 9; pass++) {
        const adj = buildAdj();
        const roots = [];
        for (let i = 0; i < RN; i++) if (area[i] > 0 && findR(i) === i) roots.push(i);
        roots.sort((a, b) => area[a] - area[b]);
        let merged = 0;
        for (const i of roots) {
          if (area[i] <= 0 || findR(i) !== i) continue;
          const bwI = bX1[i] - bX0[i] + 1, bhI = bY1[i] - bY0[i] + 1;
          const thickI = area[i] / Math.max(1, Math.max(bwI, bhI));
          const fillI = area[i] / Math.max(1, bwI * bhI);
          // 抗锯齿过渡带：细、空、夹在两侧颜色之间。它们不是画面结构，
          // 单独成组会在轮廓/色块边上留下一圈浅色描边。
          const aaLimit = flatArt ? N * 0.012 : N * 0.003;
          const aaLike = area[i] < aaLimit &&
            thickI < (flatArt ? 3.0 : 2.2) && fillI < (flatArt ? 0.32 : 0.25);
          if (area[i] >= MINA && !aaLike) continue;
          const nb = adj[i];
          if (!nb) continue;
          const m0 = sR[i] / area[i], m1 = sG[i] / area[i], m2 = sB[i] / area[i];
          const li = m0 * 0.299 + m1 * 0.587 + m2 * 0.114;
          let minCd = Infinity, minL = Infinity, maxL = -Infinity;
          let bigArea = -1, bigCd = 0;
          let best = -1, bestCd = Infinity, bestArea = -1;
          for (const [j, shared] of nb) {
            if (shared < 1) continue;
            const jj = findR(j);
            if (jj === i || area[jj] <= 0) continue;
            const n0 = sR[jj] / area[jj], n1 = sG[jj] / area[jj], n2 = sB[jj] / area[jj];
            const d0 = Math.abs(m0 - n0), d1 = Math.abs(m1 - n1), d2 = Math.abs(m2 - n2);
            const cd = d0 > d1 ? (d0 > d2 ? d0 : d2) : (d1 > d2 ? d1 : d2);
            if (cd < minCd) minCd = cd;
            // 小结构四周常包着一圈抗锯齿过渡色，最近邻颜色差很小；
            // 判断"该不该保留"要看最大的那个邻居，否则鼻头/高光会被过渡带拖下水。
            if (area[jj] > bigArea) { bigArea = area[jj]; bigCd = cd; }
            const lj = n0 * 0.299 + n1 * 0.587 + n2 * 0.114;
            if (lj < minL) minL = lj;
            if (lj > maxL) maxL = lj;
            if (cd < bestCd || (cd === bestCd && area[jj] > bestArea)) {
              bestCd = cd; best = jj; bestArea = area[jj];
            }
          }
          if (best < 0) continue;
          // 抗锯齿过渡带不是极值；线/高光是极值。只保护极值，且要求面积不是灰尘点。
          // 照片里的鼻头、肉垫、彩色斑纹未必是明度极值，但色度高，
          // 并掉就会让脸失去辨识度；抗锯齿带色度也有，仍按"细而空"排除。
          // 插画不启用这条：色块本来就少，宽口径保留会生出大量碎笔。
          const extreme = minL < Infinity && (li < minL - 18 || li > maxL + 18);
          const chroma = Math.max(m0, m1, m2) - Math.min(m0, m1, m2);
          const vivid = !flatArt && chroma > 22 && !aaLike;
          // 紧凑小结构四周常包着一圈抗锯齿过渡色，看最近邻会被拖下水，
          // 要看最大的邻居；细长过渡带仍然用最近邻，免得整圈描边都留下来。
          const protCd = (flatArt || aaLike) ? minCd : bigCd;
          if ((extreme || vivid) && protCd > 25 &&
              (area[i] >= PROT_AREA || (extreme && aaLike))) continue;
          merged += mergeRoots(i, best);
        }
        passN = pass + 1;
        if (!merged) break;
      }
      // ---- 同色相邻区合并：颜色相同的两块并起来不影响成品，只减少无意义的换笔 ----
      for (let pass = 0; pass < 12; pass++) {
        const adj = buildAdj();
        let merged = 0;
        for (let i = 0; i < RN; i++) {
          if (area[i] <= 0 || findR(i) !== i) continue;
          const nb = adj[i];
          if (!nb) continue;
          const m0 = sR[i] / area[i], m1 = sG[i] / area[i], m2 = sB[i] / area[i];
          for (const [j, shared] of nb) {
            if (shared < 3) continue;
            const jj = findR(j);
            if (jj === i || area[jj] <= 0) continue;
            const d0 = Math.abs(m0 - sR[jj] / area[jj]);
            const d1 = Math.abs(m1 - sG[jj] / area[jj]);
            const d2 = Math.abs(m2 - sB[jj] / area[jj]);
            if (Math.max(d0, Math.max(d1, d2)) > MERGE_CD) continue;
            merged += mergeRoots(i, jj);
            break;
          }
        }
        if (!merged) break;
      }

      // ---- 压实成 gid 0..Gn-1，并把每个像素的 groupOf 写成最终标签 ----
      const rootMap = new Int32Array(RN).fill(-1);
      let Gn = 0;
      for (let p = 0; p < N; p++) {
        if (lab[p] < 0) continue;
        const r = findR(lab[p]);
        let id = rootMap[r];
        if (id < 0) { id = Gn++; rootMap[r] = id; }
        lab[p] = id;
      }
      let assigned = 0;
      for (let p = 0; p < N; p++) {
        if (lab[p] >= 0) { assigned++; groupOf[p] = lab[p]; }
        else groupOf[p] = -1;
      }
      if (!Gn || assigned < (N - paperPx) * 0.95) {
        if (opts.debug) console.log('[exact] fallback: assigned=' + assigned + ' groups=' + Gn);
        for (let p = 0; p < N; p++) groupOf[p] = -1;
        return false;
      }

      // ---- 区域统计（取色用原图；流向/显著度沿用观察结果） ----
      prog(0.46, '量形状：面积、方向、厚度…');
      await yieldUI();
      const gA = new Int32Array(Gn), gR = new Float64Array(Gn), gG = new Float64Array(Gn), gB = new Float64Array(Gn);
      const gR2 = new Float64Array(Gn), gG2 = new Float64Array(Gn), gB2 = new Float64Array(Gn);
      const gMg = new Float64Array(Gn), gMgN = new Int32Array(Gn);
      const gL = new Float64Array(Gn), gSal = new Float64Array(Gn), gEdge = new Float64Array(Gn);
      const gX0 = new Int32Array(Gn).fill(W), gY0 = new Int32Array(Gn).fill(H);
      const gX1 = new Int32Array(Gn).fill(-1), gY1 = new Int32Array(Gn).fill(-1);
      const gSx = new Float64Array(Gn), gSy = new Float64Array(Gn);
      const gSxx = new Float64Array(Gn), gSxy = new Float64Array(Gn), gSyy = new Float64Array(Gn);
      const gFx = new Float64Array(Gn), gFy = new Float64Array(Gn), gFw = new Float64Array(Gn);
      const gBorder = new Uint8Array(Gn);
      // 只统计"离组边界至少 1px"的内部相邻像素：色区边缘的抗锯齿/描边
      // 会把平涂主体误判成渐变，窄带化后白白多出几百笔。
      const interior = new Uint8Array(N);
      for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
          const p = row + x;
          const gid = lab[p];
          if (gid < 0) continue;
          if (x === 0 || x + 1 === W || y === 0 || y + 1 === H) continue;
          if (lab[p - 1] === gid && lab[p + 1] === gid && lab[p - W] === gid && lab[p + W] === gid) interior[p] = 1;
        }
      }
      for (let y = 0; y < H; y++) {
        let p = y * W;
        for (let x = 0; x < W; x++, p++) {
          const gid = lab[p];
          if (gid < 0) continue;
          gA[gid]++; gR[gid] += R[p]; gG[gid] += G[p]; gB[gid] += B[p];
          gR2[gid] += R[p] * R[p]; gG2[gid] += G[p] * G[p]; gB2[gid] += B[p] * B[p];
          // 组内相邻像素的平均色差：只看同一色区内部，外面的描边/AA 边界不计。
          if (interior[p] && x + 1 < W && interior[p + 1] && lab[p + 1] === gid) {
            const q1 = p + 1;
            gMg[gid] += Math.max(Math.abs(R[q1] - R[p]), Math.max(Math.abs(G[q1] - G[p]), Math.abs(B[q1] - B[p])));
            gMgN[gid]++;
          }
          if (interior[p] && y + 1 < H && interior[p + W] && lab[p + W] === gid) {
            const q1 = p + W;
            gMg[gid] += Math.max(Math.abs(R[q1] - R[p]), Math.max(Math.abs(G[q1] - G[p]), Math.abs(B[q1] - B[p])));
            gMgN[gid]++;
          }
          gL[gid] += L[p]; gSal[gid] += sal[p]; gEdge[gid] += edge[p];
          if (x < gX0[gid]) gX0[gid] = x; if (x > gX1[gid]) gX1[gid] = x;
          if (y < gY0[gid]) gY0[gid] = y; if (y > gY1[gid]) gY1[gid] = y;
          gSx[gid] += x; gSy[gid] += y; gSxx[gid] += x * x; gSxy[gid] += x * y; gSyy[gid] += y * y;
          const fw = 0.15 + edge[p];
          gFx[gid] += flowX[p] * fw; gFy[gid] += flowY[p] * fw; gFw[gid] += fw;
          if (x === 0 || y === 0 || x === W - 1 || y === H - 1) gBorder[gid] = 1;
        }
      }
      const newGroups = [];
      for (let gi = 0; gi < Gn; gi++) {
        const a = gA[gi];
        if (!a) continue;
        const bw = gX1[gi] - gX0[gi] + 1, bh = gY1[gi] - gY0[gi] + 1;
        const cx = gSx[gi] / a, cy = gSy[gi] / a;
        const vx = Math.max(0.01, gSxx[gi] / a - cx * cx);
        const vy = Math.max(0.01, gSyy[gi] / a - cy * cy);
        const vxy = gSxy[gi] / a - cx * cy;
        const tr = vx + vy, df = vx - vy;
        const e1 = tr * 0.5 + Math.sqrt(df * df * 0.25 + vxy * vxy);
        const e2 = Math.max(0.01, tr * 0.5 - Math.sqrt(df * df * 0.25 + vxy * vxy));
        const mean = [Math.round(gR[gi] / a), Math.round(gG[gi] / a), Math.round(gB[gi] / a)];
        const thick = a / Math.max(1, Math.max(bw, bh));
        const fill = a / Math.max(1, bw * bh);
        const elong = Math.sqrt(e1 / e2);
        const mR = gR[gi] / a, mG = gG[gi] / a, mB = gB[gi] / a;
        const stdMax = Math.sqrt(Math.max(0, Math.max(
          gR2[gi] / a - mR * mR, gG2[gi] / a - mG * mG, gB2[gi] / a - mB * mB)));
        const lineLike = (thick <= 4.2 || (elong >= 2.6 && thick <= 9)) ? 1 : 0;
        const mg = gMg[gi] / Math.max(1, gMgN[gi]);
        const g = {
          gid: newGroups.length, bg: gBorder[gi] ? 1 : 0, label: 0, area: a,
          x0: gX0[gi], y0: gY0[gi], x1: gX1[gi], y1: gY1[gi], bw, bh,
          cx, cy, angle: 0.5 * Math.atan2(2 * vxy, vx - vy), elong, thick, fill,
          mean, pal: mean, luma: gL[gi] / a, sal: gSal[gi] / a, edge: gEdge[gi] / a,
          flowCoh: Math.hypot(gFx[gi], gFy[gi]) / Math.max(1e-6, gFw[gi]),
          flowAngle: 0.5 * Math.atan2(gFy[gi], gFx[gi]),
          lineArt: 0, inkOnly: 0,
          lineLike,
          std: +stdMax.toFixed(2), mg: +mg.toFixed(3),
          // 大面积、内部相邻像素色差持续很小但不为 0 的组：是渐变，不是平涂。
          // 用"组内平均相邻差"而不是总方差，避免被边界上几颗 AA 像素带偏。
          grad: (!lineLike && a >= 600 && mg > (flatArt ? 0.12 : 0.9)) ? 1 : 0,
          // 平涂的渐变区加一点确定性抖动，模拟原图的细微噪声。
          dither: (flatArt && !lineLike && a >= 900 && mg > 0.08) ? 0.9 : 0,
        };
        newGroups.push(g);
      }
      if (!newGroups.length) { for (let p = 0; p < N; p++) groupOf[p] = -1; return false; }
      groups.length = 0;
      for (const g of newGroups) groups.push(g);

      // ---- 组内明暗跨度大的组按亮度分档拆开（治“无中生有的深色”）----
      // 漫水在平滑后的 D 空间按容差切，印刷渐变/软阴影边缘的碎片会在合并阶段
      // 链式并成一组（海报红字上缘 95 亮度跨度的过渡带并进了亮红字心，
      // 飞机下方的软阴影并进了亮机身）。一组一个平涂均值会把亮部压成暗块。
      // 对内部亮度跨度大的组按亮度 k-档重拆：每档用自己像素的均值落笔。
      const dropGid = new Uint8Array(Gn);
      if (flatArt) {
        // ---- 组内颜色跨度大的组按颜色 k-档拆开（治"无中生有的深色"）----
        // 漫水在平滑后的 D 空间按容差切分，印刷渐变/软阴影/抗锯齿边缘的碎片
        // 会在合并阶段链式并成一组（海报红字上缘 95 亮度跨度的过渡带并进了
        // 亮红心、飞机下方的软阴影并进了亮机身、蓝像素并进了红描边）。
        // "一组一个平涂均值"会把亮部压成暗块、把异色像素画成错色。
        // 对内部色差大的组按颜色 k-means 重拆：每档用自己像素的均值落笔，
        // 一档内的色差收到可见阈值以下。只动分组和取色，不动笔形/顺序/种子。
        const plans = [];
        for (let gi = 0; gi < Gn; gi++) {
          const g = groups[gi];
          if (g.grad || g.soft) continue;
          if (g.area < 48 || g.std < 14) continue;
          plans.push({ gi, K: g.std >= 26 ? 4 : (g.std >= 18 ? 3 : 2), pix: [] });
        }
        if (plans.length) {
          const planOf = new Int32Array(Gn).fill(-1);
          plans.forEach((it, pi) => { planOf[it.gi] = pi; });
          for (let p = 0; p < N; p++) {
            const gid = groupOf[p];
            if (gid < 0) continue;
            const pi = planOf[gid];
            if (pi >= 0) plans[pi].pix.push(p);
          }
          for (let pi = 0; pi < plans.length; pi++) {
            const it = plans[pi];
            const px = it.pix;
            const K = it.K;
            if (px.length < 48) continue;
            // 初始化：按亮度分位点取 K 个像素的颜色作中心
            const lums = new Array(px.length);
            for (let i = 0; i < px.length; i++) {
              const p = px[i];
              lums[i] = 0.299 * R[p] + 0.587 * G[p] + 0.114 * B[p];
            }
            const idx = lums.map((v, i) => i).sort((a, b) => lums[a] - lums[b]);
            const cen = [];
            for (let k = 0; k < K; k++) {
              const i0 = idx[Math.floor((k + 0.5) * px.length / K)];
              const p = px[i0];
              cen.push([R[p], G[p], B[p]]);
            }
            // Lloyd 若干轮（RGB 空间）
            for (let iter = 0; iter < 8; iter++) {
              const sum = [[0,0,0],[0,0,0],[0,0,0],[0,0,0]];
              const cnt = [0,0,0,0];
              for (let i = 0; i < px.length; i++) {
                const p = px[i];
                let bk = 0, bd = Infinity;
                for (let k = 0; k < K; k++) {
                  const d = Math.abs(R[p] - cen[k][0]) + Math.abs(G[p] - cen[k][1]) + Math.abs(B[p] - cen[k][2]);
                  if (d < bd) { bd = d; bk = k; }
                }
                sum[bk][0] += R[p]; sum[bk][1] += G[p]; sum[bk][2] += B[p];
                cnt[bk]++;
              }
              for (let k = 0; k < K; k++) if (cnt[k]) { cen[k] = [sum[k][0]/cnt[k], sum[k][1]/cnt[k], sum[k][2]/cnt[k]]; }
            }
            // 汇总每档像素数（Lloyd 结束后统一按最终中心计数）
            const cnt = new Int32Array(K);
            for (let i = 0; i < px.length; i++) {
              const p = px[i];
              let bk = 0, bd = Infinity;
              for (let k = 0; k < K; k++) {
                const d = Math.abs(R[p] - cen[k][0]) + Math.abs(G[p] - cen[k][1]) + Math.abs(B[p] - cen[k][2]);
                if (d < bd) { bd = d; bk = k; }
              }
              cnt[bk]++;
            }
            // 档间太近的并回一档：分档只解决"可见错色"，不做无谓细分
            for (let a = 0; a < K; a++) {
              if (!cen[a] || !cnt[a]) continue;
              for (let b = a + 1; b < K; b++) {
                if (!cen[b] || !cnt[b]) continue;
                const dc = Math.abs(cen[a][0] - cen[b][0]) +
                  Math.abs(cen[a][1] - cen[b][1]) + Math.abs(cen[a][2] - cen[b][2]);
                if (dc >= 24) continue;
                const pa = cnt[a] >= cnt[b] ? a : b, pb = b + a - pa;
                cen[pa] = [(cen[a][0] * cnt[a] + cen[b][0] * cnt[b]) / (cnt[a] + cnt[b]),
                  (cen[a][1] * cnt[a] + cen[b][1] * cnt[b]) / (cnt[a] + cnt[b]),
                  (cen[a][2] * cnt[a] + cen[b][2] * cnt[b]) / (cnt[a] + cnt[b])];
                cnt[pa] += cnt[pb]; cnt[pb] = 0; cen[pb] = null;
                if (!cen[a]) break;
              }
              if (!cen[a]) break;
            }
            const alive = [];
            for (let k = 0; k < K; k++) if (cen[k] && cnt[k] >= 6) alive.push(k);
            if (alive.length <= 1) continue;
            // 逐像素定档并累计子组统计（几何/颜色/显著度与主构建同口径）
            const nB = alive.length;
            const acc = { r: new Float64Array(nB), g: new Float64Array(nB), b: new Float64Array(nB),
              n: new Int32Array(nB), l: new Float64Array(nB), sal: new Float64Array(nB), ed: new Float64Array(nB),
              x0: new Int32Array(nB).fill(W), y0: new Int32Array(nB).fill(H),
              x1: new Int32Array(nB).fill(-1), y1: new Int32Array(nB).fill(-1),
              sx: new Float64Array(nB), sy: new Float64Array(nB), sxx: new Float64Array(nB), sxy: new Float64Array(nB), syy: new Float64Array(nB),
              fx: new Float64Array(nB), fy: new Float64Array(nB), fw: new Float64Array(nB),
              r2: new Float64Array(nB), g2: new Float64Array(nB), b2: new Float64Array(nB), brd: new Int32Array(nB) };
            for (let i = 0; i < px.length; i++) {
              const p = px[i];
              let bk = 0, bd = Infinity;
              for (let ai = 0; ai < nB; ai++) {
                const k = alive[ai];
                const d = Math.abs(R[p] - cen[k][0]) + Math.abs(G[p] - cen[k][1]) + Math.abs(B[p] - cen[k][2]);
                if (d < bd) { bd = d; bk = ai; }
              }
              const x = p % W, y = (p - x) / W;
              acc.r[bk] += R[p]; acc.g[bk] += G[p]; acc.b[bk] += B[p];
              acc.r2[bk] += R[p] * R[p]; acc.g2[bk] += G[p] * G[p]; acc.b2[bk] += B[p] * B[p];
              acc.n[bk]++; acc.l[bk] += L[p]; acc.sal[bk] += sal[p]; acc.ed[bk] += edge[p];
              acc.sx[bk] += x; acc.sy[bk] += y; acc.sxx[bk] += x * x; acc.sxy[bk] += x * y; acc.syy[bk] += y * y;
              if (x < acc.x0[bk]) acc.x0[bk] = x; if (x > acc.x1[bk]) acc.x1[bk] = x;
              if (y < acc.y0[bk]) acc.y0[bk] = y; if (y > acc.y1[bk]) acc.y1[bk] = y;
              const fw = 0.15 + edge[p];
              acc.fx[bk] += flowX[p] * fw; acc.fy[bk] += flowY[p] * fw; acc.fw[bk] += fw;
              if (x === 0 || y === 0 || x === W - 1 || y === H - 1) acc.brd[bk] = 1;
              it.assign = it.assign || [];
              it.assign.push(bk);
            }
            const pg = groups[it.gi];
            const newBins = [];
            const startIdx = groups.length;
            for (let ai = 0; ai < nB; ai++) {
              const n = acc.n[ai];
              if (n <= 0) continue;
              const x0 = acc.x0[ai], y0 = acc.y0[ai], x1 = acc.x1[ai], y1 = acc.y1[ai];
              const bw2 = x1 - x0 + 1, bh2 = y1 - y0 + 1;
              const cx2 = acc.sx[ai] / n, cy2 = acc.sy[ai] / n;
              const vx = Math.max(0.01, acc.sxx[ai] / n - cx2 * cx2);
              const vy = Math.max(0.01, acc.syy[ai] / n - cy2 * cy2);
              const vxy = acc.sxy[ai] / n - cx2 * cy2;
              const tr2 = vx + vy, df2 = vx - vy;
              const e1 = tr2 * 0.5 + Math.sqrt(df2 * df2 * 0.25 + vxy * vxy);
              const e2 = Math.max(0.01, tr2 * 0.5 - Math.sqrt(df2 * df2 * 0.25 + vxy * vxy));
              const mean2 = [Math.round(acc.r[ai] / n), Math.round(acc.g[ai] / n), Math.round(acc.b[ai] / n)];
              const mR = acc.r[ai] / n, mG = acc.g[ai] / n, mB = acc.b[ai] / n;
              const std2 = Math.sqrt(Math.max(0, Math.max(acc.r2[ai] / n - mR * mR, acc.g2[ai] / n - mG * mG, acc.b2[ai] / n - mB * mB)));
              const thick2 = n / Math.max(1, Math.max(bw2, bh2));
              const fill2 = n / Math.max(1, bw2 * bh2);
              const elong2 = Math.sqrt(e1 / e2);
              const lineLike2 = (thick2 <= 4.2 || (elong2 >= 2.6 && thick2 <= 9)) ? 1 : 0;
              newBins.push({
                gid: 0, bg: acc.brd[ai] ? 1 : 0, label: 0, area: n,
                x0, y0, x1, y1, bw: bw2, bh: bh2, cx: cx2, cy: cy2,
                angle: 0.5 * Math.atan2(2 * vxy, vx - vy), elong: elong2, thick: thick2, fill: fill2,
                mean: mean2, pal: mean2, luma: acc.l[ai] / n, sal: acc.sal[ai] / n, edge: acc.ed[ai] / n,
                flowCoh: Math.hypot(acc.fx[ai], acc.fy[ai]) / Math.max(1e-6, acc.fw[ai]),
                flowAngle: 0.5 * Math.atan2(acc.fy[ai], acc.fx[ai]),
                lineArt: 0, inkOnly: 0, lineLike: lineLike2,
                std: +std2.toFixed(2), mg: pg.mg,
                grad: 0, dither: 0,
              });
            }
            for (const nb of newBins) { nb.gid = groups.length; groups.push(nb); }
            for (let i = 0; i < px.length; i++) groupOf[px[i]] = startIdx + it.assign[i];
            dropGid[it.gi] = 1;
          }
        }
      }
      {
        let dropped = false;
        for (let gi2 = 0; gi2 < Gn; gi2++) if (dropGid[gi2]) dropped = true;
        if (dropped) {
          const remapG = new Int32Array(groups.length).fill(-1);
          const kept = [];
          for (const g of groups) if (!dropGid[g.gid] && g) { remapG[g.gid] = kept.length; kept.push(g); }
          for (const g of kept) g.gid = remapG[g.gid];
          groups.length = 0;
          for (const g of kept) groups.push(g);
          for (let p = 0; p < N; p++) { const gid = groupOf[p]; if (gid >= 0 && remapG[gid] >= 0) groupOf[p] = remapG[gid]; }
        }
      }
      G_ = groups.length;
      groupUncov = new Int32Array(G_);
      gStrokeN = new Int32Array(G_);
      for (const g of groups) groupUncov[g.gid] = g.area;

      // ---- 落笔：每个色区都用自己的真实颜色；色区内部按形状扫/描 ----
      prog(0.56, '落色：先主体大形，再背景与明暗…');
      await yieldUI();
      const tone = (c) => {
        if (style !== 'pencil') return c;
        const v = clamp(Math.round(luma(c) * 0.95 + 12), 18, 244);
        return [v, v, v];
      };
      // 同一色区所有笔都用这个色区的精确均值：后笔压前笔也不会把成品颜色带偏，
      // 因此"零新增像素的笔"可以安全删掉，回放结果与规划画布逐像素一致。
      const colorOf = (g) => tone(g.mean);
      let zeroRemoved = 0;
      const emitPlan = (sp, halfs, color, ph, opt) => {
        opt = opt || {};
        opt.color = color;
        if (opt.minInk === undefined) opt.minInk = 1;
        const zc0 = zoneCov;
        const idx = emitStroke(sp, halfs, color, 0, opt);
        if (idx < 0) return -1;
        const gained = zoneCov - zc0;
        // forceKeep：重涂（把已经盖过但颜色不对的像素改对）也要保留这一笔。
        // 否则 emitStroke 已经把画布改了、这里却把笔删掉，成品和笔流对不上。
        if (gained <= 0 && !opt.forceKeep) {
          // 整笔都落在已经画过的同色像素上：删掉它，避免"画了等于没画"的笔。
          strokes.pop();
          if (opt.zoneGid >= 0 && gStrokeN[opt.zoneGid] > 0) gStrokeN[opt.zoneGid]--;
          zeroRemoved++;
          return -1;
        }
        const st = strokes[idx];
        st.ph = ph;
        if (ph === 0) baseCount++;
        return idx;
      };
      const mkAng = (g, isBg) => {
        let ang = g.angle;
        if (g.elong < 1.55 && g.flowCoh > 0.2 && !isBg) ang = g.flowAngle;
        if (isBg) ang += (srnd(g.gid * 2.3, 4.1) - 0.5) * 0.18;
        else ang += (srnd(g.gid * 3.1, 5.2) - 0.5) * (flatArt ? 0.08 : 0.20);
        return isFinite(ang) ? ang : 0;
      };
      // 档位只改笔触粗细/密度：分色区和取色由图像决定，成品精度不靠档位。
      const fidScale = [1.25, 1.12, 1, 0.9, 0.8][fid - 1];
      const bandHalf = (g) => {
        let bw = Math.sqrt(g.area) * (flatArt ? 0.98 : 0.86);
        bw = Math.min(bw, Math.max(7, g.thick * 2.7));
        bw *= (style === 'oil' ? 1.12 : style === 'pencil' ? 0.92 : 1);
        // 照片（过程版）：大色区也别用 40px 宽的单色带——那会把云、毛发、
        // 石墙的层次压成一块块硬边色斑。笔宽跟着色区厚度收窄，颜色按段取
        // 局部均值，笔触自然跟着明暗走。artist 的照片路径保持原参数。
        if (!flatArt && painterFlow) {
          return Math.max(2.6, Math.min(7.5, bw * 0.55) * fidScale);
        }
        if (g.grad) {
          // 渐变色区用窄带：每带取原图局部均值，色阶步长<0.5，
          // 既保留笔触方向，又不会出现一条条同心色带。
          return Math.max(2.0, Math.min(flatArt ? 24 : 18, bw) * 0.5 * fidScale);
        }
        return Math.max(3.2, Math.min(150 * scaleB, bw)) * 0.5 * fidScale;
      };
      const emitBand = (g, u0, u1, v, ca, sa, halfW, ph, ang, rev, zone, extra) => {
        const a = u0 - halfW * 0.62, b = u1 + halfW * 0.62;
        const len = b - a;
        if (len < 2) return;
        const nP = Math.max(3, Math.min(12, Math.round(len / 24) + 1));
        // 长带是手臂带出来的弧线：主弓弯随带长增大，再叠一个低频第二谐波
        // （手沿途的漂移）；幅度仍钳在带内，zoneGid 裁形后不出界。
        const bowA = halfW * (style === 'oil' ? 0.20 : 0.10) * (0.55 + 1.1 * Math.min(1, len / 640));
        const bow = (srnd(g.gid * 7.1 + v * 0.071, 6.3) - 0.5) * bowA;
        const bow2 = (srnd(g.gid * 3.9 + v * 0.047, 7.5) - 0.5) * bowA * 0.6;
        const bowPh = srnd(g.gid * 5.7 + v * 0.031, 8.3) * Math.PI * 2;
        const sp = new Float64Array(nP * 2);
        for (let i = 0; i < nP; i++) {
          const f = nP > 1 ? i / (nP - 1) : 0.5;
          const u = rev ? b - (b - a) * f : a + (b - a) * f;
          const vv = v + bow * Math.sin(Math.PI * f) + bow2 * Math.sin(2 * Math.PI * f + bowPh)
            + (srnd(g.gid * 9.3 + i * 0.77, 2.9) - 0.5) * 0.65;
          sp[i * 2] = g.cx + u * ca - vv * sa;
          sp[i * 2 + 1] = g.cy + u * sa + vv * ca;
        }
        const halfs = profFill(nP, halfW * 1.03, g.gid * 2.7 + v * 0.13 + runSeed * 0.37);
        const softBg = flatArt && g.soft ? 1 : 0;
        if (softBg) {
          // 背景是比 8 位色阶还细的渐变：一笔取本笔实际盖住像素的浮点均值，
          // 再拆成两级互补网点落笔。单笔纯色会在色阶处留下马赫色带，
          // 网点在正常观看距离下融合成连续过渡，和原图自带的细噪声同观感。
          const hint = colorOf(g);
          emitPlan(sp, halfs, hint, ph, {
            zoneGid: g.gid, pen: 0, ditherAuto: 1, ditherPx: { sel: 0 }, minInk: 1,
            ...(extra || {}),
          });
          emitPlan(sp, halfs, hint, ph, {
            zoneGid: g.gid, pen: 0, ditherAuto: 1, ditherPx: { sel: 1 }, minInk: 1,
            ...(extra || {}),
          });
          return;
        }
        const col = colorOf(g);
        const zo = zone
          ? { zoneMaskRect: { m: zone.m, x0: zone.x0, y0: zone.y0, w: zone.w, h: zone.h },
              zoneGroups: zone.gids, zoneTol: zone.tol === undefined ? 60 : zone.tol, forceKeep: 1 }
          : { zoneGid: g.gid };
        emitPlan(sp, halfs, col, ph, {
          ...zo, pen: 0,
          // 背景色区即使内部颜色很平，也按笔取局部色：相邻色区交界才会连成
          // 同一片渐变，而不是各自一块均值。
          localColor: (g.grad || (!flatArt && painterFlow)) ? 1 : 0,
          dither: g.dither || 0,
          ditherSeed: g.gid * 3.7 + v * 0.11 + runSeed * 0.53,
          ...(extra || {}),
        });
      };
      const sweepAt = (g, v, ca, sa, halfW, ph, ang, uMin, uMax, rev) => {
        let runA = null;
        const uA = uMin - halfW * 0.8, uB = uMax + halfW * 0.8;
        // 渐变色区的一条长扫带如果整段一个色，背景会顺着色阶分成一圈圈色带：
        // 一档扫带横跨几百像素却只有中点一个均值。按 48~72px 把长带接力着落笔，
        // 每段取自己那一段的真实均值，色阶步长就细到看不出来。
        // 段与段靠 emitBand 两端各 0.62*半宽 的出锋自然重叠，不会露缝。
        const local = g.grad || (flatArt && g.soft) || (!flatArt && painterFlow);
        const segLen = !local ? 0 : (flatArt ? 48 : (painterFlow ? 56 : 72));
        const emitRun = (a0, a1) => {
          const len = a1 - a0;
          if (!segLen || len <= segLen * 1.25) {
            emitBand(g, a0, a1, v, ca, sa, halfW, ph, ang, rev);
            return;
          }
          const k = Math.ceil(len / segLen);
          const dl = len / k;
          // 反向走笔时整串段一起倒：笔尖从带的一头连续推到另一头，不折返
          for (let i = 0; i < k; i++) {
            const j = rev ? k - 1 - i : i;
            emitBand(g, a0 + dl * j, a0 + dl * (j + 1), v, ca, sa, halfW, ph, ang, rev);
          }
        };
        for (let u = uA; u <= uB; u += 1) {
          const x = Math.round(g.cx + u * ca - v * sa);
          const y = Math.round(g.cy + u * sa + v * ca);
          const inside = x >= 0 && y >= 0 && x < W && y < H && groupOf[y * W + x] === g.gid;
          if (inside) { if (runA === null) runA = u; }
          else if (runA !== null) {
            emitRun(runA, u - 1);
            runA = null;
          }
        }
        if (runA !== null) emitRun(runA, uB);
      };
      const fillGaps = (g, ph, ang, halfW) => {
        if (!g || groupUncov[g.gid] <= 0) return;
        for (let pass = 0; pass < 3; pass++) {
          const un = groupUncov[g.gid];
          if (un <= 0) break;
          const a2 = ang + (pass % 2 ? -1 : 1) * (0.62 + pass * 0.21);
          const ca = Math.cos(a2), sa = Math.sin(a2);
          let vMin = Infinity, vMax = -Infinity;
          for (const [x, y] of [[g.x0 - g.cx, g.y0 - g.cy], [g.x1 - g.cx, g.y0 - g.cy],
            [g.x1 - g.cx, g.y1 - g.cy], [g.x0 - g.cx, g.y1 - g.cy]]) {
            const v = -x * sa + y * ca;
            if (v < vMin) vMin = v; if (v > vMax) vMax = v;
          }
          const v0 = Math.floor(vMin) - 1;
          const vn = Math.ceil(vMax - vMin) + 3;
          if (vn <= 0 || vn > 20000) break;
          const hist = new Int32Array(vn);
          for (let y = g.y0; y <= g.y1; y++) {
            const row = y * W;
            for (let x = g.x0; x <= g.x1; x++) {
              const p = row + x;
              if (groupOf[p] !== g.gid || paintN[p]) continue;
              const v = -((x - g.cx) * sa) + ((y - g.cy) * ca);
              const bi = Math.round(v - v0);
              if (bi >= 0 && bi < vn) hist[bi]++;
            }
          }
          const ord = Array.from({ length: vn }, (_, i) => i).sort((a, b) => hist[b] - hist[a]);
          const picked = [];
          for (const bi of ord) {
            if (hist[bi] < 2 || picked.length >= 4) break;
            const v = v0 + bi;
            let ok = true;
            for (const q of picked) if (Math.abs(q - v) < halfW * 0.55) { ok = false; break; }
            if (ok) picked.push(v);
          }
          if (!picked.length) break;
          for (const v of picked) sweepAt(g, v, ca, sa, halfW * 1.06, ph, a2, -g.bw, g.bw + g.bh);
        }
      };
      const paintBlob = (g, ph) => {
        const halfW = bandHalf(g);
        const ang = mkAng(g, !!g.bg);
        const ca = Math.cos(ang), sa = Math.sin(ang);
        let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
        for (const [x, y] of [[g.x0 - g.cx, g.y0 - g.cy], [g.x1 - g.cx, g.y0 - g.cy],
          [g.x1 - g.cx, g.y1 - g.cy], [g.x0 - g.cx, g.y1 - g.cy]]) {
          const u = x * ca + y * sa, v = -x * sa + y * ca;
          if (u < uMin) uMin = u; if (u > uMax) uMax = u;
          if (v < vMin) vMin = v; if (v > vMax) vMax = v;
        }
        const step = Math.max(3, halfW * 2 * (flatArt ? 0.62 : 0.58) * (0.94 + 0.12 * srnd(g.gid, 1)));
        const inset = Math.min(step * 0.52, halfW * 0.55);
        const phase = srnd(g.gid * 3.7 + runSeed * 0.13, 1.9) * step;
        const v0 = vMin + inset + phase * 0.32;
        const v1 = vMax - inset;
        // 先勾边后填心（cutting-in）：真人铺大色块先用小笔沿边界走一圈，再
        // 从一侧推进填心。勾边笔用组色、zoneGid 裁形，成品边界不变差，边缘
        // 覆盖反而更准。只对平涂大类块启用（照片通路的塑形有别的组织）。
        if (flatArt && !g.grad && !g.soft && g.area > 2600) cutInEdges(g, halfW, ph);
        if (v1 < v0) {
          // 极细的组（2~5px）留白比带宽还大，按原公式一档都落不下；
          // 至少从中心扫一档，zoneGid 会把它裁回原形。
          sweepAt(g, (vMin + vMax) * 0.5, ca, sa, Math.max(halfW, (vMax - vMin) * 0.5 + 1.2), ph, ang,
            Math.min(uMin, -g.bw), Math.max(uMax, g.bw + g.bh));
        }
        // 起笔方向按组轮换 + 相邻带蛇形交替：真人要么来回刷、要么从顺手的一侧
        // 一路推进，不会每条带都跳回同一端重新起笔。
        let dir = srnd(g.gid * 2.17 + runSeed * 0.023, 6.9) < 0.5 ? 1 : -1;
        // 相邻带间距是相关的漂移（手推进的自然不均匀），不是独立抖动
        let drift = (srnd(g.gid * 5.9 + runSeed * 0.017, 4.7) - 0.5) * step * 0.22;
        for (let v = v0; v <= v1 + 0.01; v += step) {
          if (groupUncov[g.gid] <= 0) break;
          drift = Math.max(-step * 0.2, Math.min(step * 0.2,
            drift + (srnd(g.gid * 5.9 + v * 0.05 + runSeed * 0.011, 4.7) - 0.5) * step * 0.5));
          sweepAt(g, v + drift, ca, sa, halfW, ph, ang, Math.min(uMin, -g.bw), Math.max(uMax, g.bw + g.bh), dir);
          dir = -dir;
        }
        fillGaps(g, ph, ang, halfW);
        if (groupUncov[g.gid] > 0) {
          // 组被更细的异色线从中间劈开时，任何中轴扫带都可能整条落在异色上，
          // sweepAt 会以为"这一档没有本组像素"。直接按 bbox 发一条宽扫带，
          // 由 zoneGid 裁出真实形状，保证本组一次补满。
          const wide = Math.max(halfW, (vMax - vMin) * 0.5 + 1.5);
          emitBand(g, Math.min(uMin, -g.bw) - 2, Math.max(uMax, g.bw + g.bh) + 2,
            (vMin + vMax) * 0.5, ca, sa, wide, ph, ang);
          fillGaps(g, ph, ang, Math.max(halfW, wide * 0.9));
        }
      };
      // 先勾边后填心：真人铺大色块先用小笔沿边界走一圈，再推进填心（cutting-in）。
      // 轮廓从"内缩 1.5px 的组掩膜"上追出来，勾边笔中心贴边内收、zoneGid 裁形，
      // 成品边界不会加宽，边缘覆盖反而更准。
      let __cutMask = null;
      const cutInEdges = (g, halfW, ph) => {
        if (strokes.length >= hardCap || groupUncov[g.gid] <= 0) return;
        if (!__cutMask) __cutMask = new Uint8Array(N);
        __cutMask.fill(0);
        for (let y = g.y0; y <= g.y1; y++) {
          const row = y * W;
          for (let x = g.x0; x <= g.x1; x++) if (groupOf[row + x] === g.gid) __cutMask[row + x] = 1;
        }
        const dt = distanceTransform(__cutMask, W, H);
        for (let p = 0; p < N; p++) __cutMask[p] = dt[p] > 1.5 ? 1 : 0;
        const contours = traceContours(__cutMask, g.x0, g.y0, g.x1, g.y1);
        let best = null, bestLen = 0;
        for (const c of contours) {
          let ln = 0;
          for (let i = 1; i < c.n; i++) ln += Math.hypot(c.pts[i * 2] - c.pts[(i - 1) * 2], c.pts[i * 2 + 1] - c.pts[(i - 1) * 2 + 1]);
          if (ln > bestLen) { bestLen = ln; best = c; }
        }
        if (!best || bestLen < 60) return;
        const hwE = Math.max(2.0, Math.min(6.5, halfW * 0.42));
        const maxLen = Math.max(240, 440 * scaleB);
        const chunks = Math.max(1, Math.ceil(bestLen / maxLen));
        const per = best.n / chunks;
        let off = 0;
        for (let ci = 0; ci < chunks; ci++) {
          if (strokes.length >= hardCap) break;
          const a = Math.floor(per * ci), bnd = Math.min(best.n - 1, Math.floor(per * (ci + 1)));
          if (bnd - a < 2) continue;
          const sp = new Float64Array((bnd - a + 1) * 2);
          for (let i = a; i <= bnd; i++) { sp[(i - a) * 2] = best.pts[i * 2]; sp[(i - a) * 2 + 1] = best.pts[i * 2 + 1]; }
          const halfs = profFill(sp.length >> 1, hwE, g.gid * 1.31 + off * 0.7 + runSeed * 0.19);
          emitPlan(sp, halfs, colorOf(g), ph, { zoneGid: g.gid, pen: 0 });
          off += 1.3;
        }
      };
      // 骨架线笔：线/胡须/轮廓/字边这类细长色区，沿中轴一笔连到底，
      // 笔宽按内切距离，两端按笔宽延伸；zoneGid 会把出界部分裁回原形。
      const lineParts = (g) => {
        const paths = (g.bw * g.bh <= 900000) ? traceLineGroup(g, 2) : [];
        if (!paths.length) return [];
        const PD = 2, pw = g.bw + PD * 2, phh = g.bh + PD * 2;
        const m = new Uint8Array(pw * phh);
        for (let y = 0; y < g.bh; y++) {
          const row = (y + g.y0) * W + g.x0;
          for (let x = 0; x < g.bw; x++) if (groupOf[row + x] === g.gid) m[(y + PD) * pw + x + PD] = 1;
        }
        const dtv = distanceTransform(m, pw, phh);
        const dtAt = (ax, ay) => {
          const x = Math.round(ax) - g.x0 + PD, y = Math.round(ay) - g.y0 + PD;
          if (x < 0 || y < 0 || x >= pw || y >= phh) return 0;
          const d = dtv[y * pw + x];
          return d >= 1e8 ? 0 : d;
        };
        const hwOf = (path) => {
          const smp = [];
          for (let i = 1; i < path.n; i++) {
            const ax = path.pts[(i - 1) * 2], ay = path.pts[(i - 1) * 2 + 1];
            const bx = path.pts[i * 2], by = path.pts[i * 2 + 1];
            const steps = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / 2));
            for (let k = 0; k <= steps; k++) {
              const f = k / steps;
              smp.push(dtAt(ax + (bx - ax) * f, ay + (by - ay) * f));
            }
          }
          if (!smp.length) return 0;
          smp.sort((a, b) => a - b);
          return smp[smp.length >> 1];
        };
        const tang2 = (pts, i, j) => {
          const dx = pts[j * 2] - pts[i * 2], dy = pts[j * 2 + 1] - pts[i * 2 + 1];
          const l = Math.hypot(dx, dy) || 1;
          return [dx / l, dy / l];
        };
        const cands = [];
        for (const path of paths) {
          const hw = hwOf(path);
          if (hw < 0.6) continue;
          // 交点上的毛刺不算笔画；真正的点/短笔交给块面通路。
          if (path.len < 4 && g.area > 40) continue;
          cands.push({ pts: Array.from(path.pts), hw: hw + 0.9, len: path.len });
        }
        let did = true;
        while (did && cands.length > 1) {
          did = false;
          for (let i = 0; i < cands.length && !did; i++) {
            for (let j = 0; j < cands.length && !did; j++) {
              if (i === j) continue;
              const A = cands[i], B = cands[j];
              const nA = A.pts.length >> 1, nB = B.pts.length >> 1;
              if (nA < 2 || nB < 2) continue;
              const combos = [[1, 1, 0, 0], [1, 0, 0, 1], [0, 1, 1, 0], [0, 0, 1, 1]];
              for (const [aE, bS, revA, revB] of combos) {
                const axp = A.pts[aE ? (nA - 1) * 2 : 0], ayp = A.pts[aE ? (nA - 1) * 2 + 1 : 1];
                const bxp = B.pts[bS ? 0 : (nB - 1) * 2], byp = B.pts[bS ? 1 : (nB - 1) * 2 + 1];
                const tol = dtAt(axp, ayp) + dtAt(bxp, byp) + 8;
                if (Math.hypot(axp - bxp, ayp - byp) > tol) continue;
                const da = tang2(A.pts, aE ? nA - 2 : 1, aE ? nA - 1 : 0);
                const db = tang2(B.pts, bS ? 0 : nB - 1, bS ? 1 : nB - 2);
                if (da[0] * db[0] + da[1] * db[1] < 0.7) continue;
                const mp = [];
                if (revA) for (let k = nA - 1; k >= 0; k--) mp.push(A.pts[k * 2], A.pts[k * 2 + 1]);
                else for (let k = 0; k < nA; k++) mp.push(A.pts[k * 2], A.pts[k * 2 + 1]);
                if (revB) for (let k = nB - 2; k >= 0; k--) mp.push(B.pts[k * 2], B.pts[k * 2 + 1]);
                else for (let k = 1; k < nB; k++) mp.push(B.pts[k * 2], B.pts[k * 2 + 1]);
                cands.splice(j, 1);
                A.pts = mp; A.hw = Math.max(A.hw, B.hw); A.len += B.len;
                did = true;
                break;
              }
            }
          }
        }
        const out = [];
        for (const piece of cands) {
          const n0 = piece.pts.length >> 1;
          if (n0 < 2) continue;
          const extPt = (i0, i1) => {
            const d = dtAt(piece.pts[i0 * 2], piece.pts[i0 * 2 + 1]);
            if (d < 1) return null;
            const ux = piece.pts[i0 * 2] - piece.pts[i1 * 2];
            const uy = piece.pts[i0 * 2 + 1] - piece.pts[i1 * 2 + 1];
            const l = Math.hypot(ux, uy) || 1;
            return [piece.pts[i0 * 2] + ux / l * d, piece.pts[i0 * 2 + 1] + uy / l * d];
          };
          const eS = extPt(0, 1), eE = extPt(n0 - 1, n0 - 2);
          const n = n0 + (eS ? 1 : 0) + (eE ? 1 : 0);
          const pts = new Float64Array(n * 2);
          let k = 0;
          if (eS) { pts[k++] = eS[0]; pts[k++] = eS[1]; }
          for (let i = 0; i < n0; i++) { pts[k++] = piece.pts[i * 2]; pts[k++] = piece.pts[i * 2 + 1]; }
          if (eE) { pts[k++] = eE[0]; pts[k++] = eE[1]; }
          out.push({ pts, n, hw: piece.hw, len: piece.len });
        }
        out.sort((a, b) => b.len - a.len);
        return out;
      };
      const paintLine = (g, ph) => {
        const parts = lineParts(g);
        if (!parts.length) { paintBlob(g, ph); return; }
        for (const part of parts) {
          let off = 0;
          const maxLen = 520 * scaleB;
          const chunks = [];
          if (part.len <= maxLen) chunks.push(part);
          else {
            const sp = { pts: part.pts, n: part.n, len: part.len };
            for (const ch of splitSkPath(sp, maxLen)) chunks.push({ pts: ch.pts, n: ch.n, hw: part.hw, len: ch.len });
          }
          for (const ch of chunks) {
            if (ch.n < 2) continue;
            const col = colorOf(g);
            // 骨架中轴的 dt 只是"中心处"的半径；线宽有起伏、拐角处更宽，
            // 按 1.02 倍走笔会在边缘留下 1~2px 毛边（随后变成大量补点）。
            // 线和胡须都靠 zoneGid 裁回原形，笔身放宽不会出界。
            const halfs = profFill(ch.n, (ch.hw * 1.30 + 0.45) * fidScale, g.gid * 1.9 + off + runSeed * 0.29);
            emitPlan(ch.pts, halfs, col, ph, { pen: 1, zoneGid: g.gid, ms: Math.round(180 + ch.len * 2.2) });
            off += 1.7;
          }
        }
        fillGaps(g, ph, g.angle, Math.max(2, g.thick * 0.6));
      };

      // 环状长结构（画框/内框）：沿骨架整圈一笔走完。
      // 人画海报是"先铺满底色，再顺着边框一口气绕一圈"；按块面扫带刷，
      // 一条带的可见墨迹被裁成框边两小截，回放里就成了几十段碎笔。
      const ringPlan = (g) => {
        if (!g || g.lineLike || g.area < N * 0.004) return null;
        const bw = g.x1 - g.x0 + 1, bh = g.y1 - g.y0 + 1;
        if (bw < W * 0.55 || bh < H * 0.55) return null;   // 不是绕画幅的框
        const per = 2 * (bw + bh);
        const wEst = g.area / Math.max(1, per);            // 平均带宽
        if (wEst > 34 * scaleB) return null;               // 太厚：整块底色，不是框
        const paths = traceLineGroup(g, 2);
        if (!paths.length) return null;
        const path = paths[0];
        if (path.len < per * 0.5) return null;             // 没绕成整圈
        // 框家族：紧贴黑框带的深色组（内框线、扫描边线碎组）也是这一圈的黑。
        // 只描 gid0 会把它们留给后面的"细化背景"，回放里就是绕完框还在边上来回点。
        const gids = [g.gid];
        let extraArea = 0;
        for (const gg of groups) {
          if (gg.gid === g.gid || gg.area > N * 0.02) continue;
          // 只收和黑框同色的深色组：蓝底暗边（60,86,117）也是"贴边深线"，
          // 但它不是框，跟着画黑会把蓝边啃掉一圈。
          const dr0 = gg.mean[0] - g.mean[0], dg0 = gg.mean[1] - g.mean[1], db0 = gg.mean[2] - g.mean[2];
          if (dr0 * dr0 + dg0 * dg0 + db0 * db0 > 45 * 45) continue;
          let tot = 0, hit = 0;
          for (let y = gg.y0; y <= gg.y1; y++) {
            const row = y * W;
            for (let x = gg.x0; x <= gg.x1; x++) {
              if (groupOf[row + x] !== gg.gid) continue;
              tot++;
              let ok = false;
              for (let dy = -6; dy <= 6 && !ok; dy++) {
                const yy = y + dy;
                if (yy < 0 || yy >= H) continue;
                const r2 = yy * W;
                for (let dx = -6; dx <= 6; dx++) {
                  const xx = x + dx;
                  if (xx < 0 || xx >= W) continue;
                  if (groupOf[r2 + xx] === g.gid) { ok = true; break; }
                }
              }
              if (ok) hit++;
            }
          }
          if (tot && hit / tot >= 0.55) { gids.push(gg.gid); extraArea += gg.area; }
        }
        if (opts.debug) {
          const lst = gids.slice(1).map((gid) => groups[gid].area + '@' + groups[gid].mean.join(','));
          console.log('[ringfam] n=' + gids.length + ' extraArea=' + extraArea + ' wFam=' +
            ((g.area + extraArea) / Math.max(1, per)).toFixed(1) + ' top=' + lst.slice(0, 8).join(' '));
        }
        if (extraArea > g.area * 0.9) return { path, paths, wEst, wFam: wEst, gids: [g.gid], mask: null };
        const set = new Uint8Array(G_);
        for (const gid of gids) set[gid] = 1;
        const mask = new Uint8Array(N);
        for (let p = 0; p < N; p++) if (set[groupOf[p]]) mask[p] = 1;
        return { path, paths, wEst, wFam: (g.area + extraArea) / Math.max(1, per), gids, mask };
      };
      const paintRing = (g, ph, plan) => {
        const PD = 2, pw = g.bw + PD * 2, phh = g.bh + PD * 2;
        const m = new Uint8Array(pw * phh);
        for (let y = 0; y < g.bh; y++) {
          const row = (y + g.y0) * W + g.x0;
          for (let x = 0; x < g.bw; x++) if (groupOf[row + x] === g.gid) m[(y + PD) * pw + x + PD] = 1;
        }
        const dtv = distanceTransform(m, pw, phh);
        const dtAt = (x, y) => {
          const xx = Math.round(x) - g.x0 + PD, yy = Math.round(y) - g.y0 + PD;
          if (xx < 0 || yy < 0 || xx >= pw || yy >= phh) return 0;
          const d = dtv[yy * pw + xx];
          return d >= 1e8 ? 0 : d;
        };
        const s0 = strokes.length;
        const col = colorOf(g);
        // 框家族（黑框带 + 贴着的深色内框线/边线碎组）一起裁形；没有家族就退回单组
        const ringOpt = (ms) => {
          const o = { pen: 1, ms };
          if (plan.mask) {
            o.zoneMask = plan.mask; o.zoneGroups = plan.gids; o.zoneTol = 255;
          } else o.zoneGid = g.gid;
          return o;
        };
        // ---- 一圈到底：先把路径统一成顺时针，再从"最鼓的一段"起笔 ----
        // 人画框是顺着一个方向绕一圈；起笔落在框上最厚/最鼓的地方，起笔圆头把
        // 凸起一次盖住，绕回起点时就不用再回手补。远端接第二段，两段首尾同点，
        // 回放里手不停、看不出换笔。
        const path = plan.path;
        let np = path.n;
        let pts = path.pts;
        const fS = Math.max(0.95, fidScale);
        const hwAt = (x, y) => Math.max(2.8, dtAt(x, y) * 1.45 + 1.2, (plan.wFam || plan.wEst) * 1.12) * fS;
        if (np >= 8) {
          let area2 = 0;
          for (let i = 0; i < np; i++) {
            const j = (i + 1) % np;
            area2 += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1];
          }
          if (area2 < 0) {                       // 反了就倒过来，保证顺时针
            const rp = new Float64Array(np * 2);
            for (let i = 0; i < np; i++) {
              rp[i * 2] = pts[(np - 1 - i) * 2];
              rp[i * 2 + 1] = pts[(np - 1 - i) * 2 + 1];
            }
            pts = rp;
          }
          // 起点转到左上角：从左上角起笔、沿顶边向右，顺时针绕一圈（人画的顺手方向）
          {
            let tl = 0, td = Infinity;
            for (let i = 0; i < np; i++) {
              const d = Math.abs(pts[i * 2]) + Math.abs(pts[i * 2 + 1]);
              if (d < td) { td = d; tl = i; }
            }
            if (tl > 0) {
              const rp = new Float64Array(np * 2);
              for (let i = 0; i < np; i++) {
                const j = (i + tl) % np;
                rp[i * 2] = pts[j * 2]; rp[i * 2 + 1] = pts[j * 2 + 1];
              }
              pts = rp;
            }
          }
          // 起点：周围一圈里"离骨架最远"的框像素最多的位置（凸起/鼓包）
          const R0 = Math.max(10, plan.wEst * 1.5);
          const near = plan.wEst * 0.9;
          let bestI = 0, bestOff = -1;
          for (let i = 0; i < np; i++) {
            const x = pts[i * 2], y = pts[i * 2 + 1];
            let off = 0;
            for (let yy = Math.max(0, Math.round(y - R0)); yy <= Math.min(H - 1, Math.round(y + R0)); yy += 2) {
              const row = yy * W;
              for (let xx = Math.max(0, Math.round(x - R0)); xx <= Math.min(W - 1, Math.round(x + R0)); xx += 2) {
                const p = row + xx;
                if (groupOf[p] !== g.gid) continue;
                if (Math.hypot(xx - x, yy - y) > near) off++;
              }
            }
            if (off > bestOff) { bestOff = off; bestI = i; }
          }
          const mid = (bestI + (np >> 1)) % np;
          const emitArc = (i0, i1, boost) => {
            const n = ((i1 - i0 + np) % np) + 1;
            if (n < 3) return;
            const sp = new Float64Array(n * 2);
            const halfs = new Float64Array(n);
            let len = 0;
            for (let k = 0; k < n; k++) {
              const i = (i0 + k) % np;
              sp[k * 2] = pts[i * 2]; sp[k * 2 + 1] = pts[i * 2 + 1];
              // 拐角处折线偏移会在外角留一个三角缺口：转角越大笔身越宽（裁在框内）
              const ip = (i - 1 + np) % np, inx = (i + 1) % np;
              const ax = pts[i * 2] - pts[ip * 2], ay = pts[i * 2 + 1] - pts[ip * 2 + 1];
              const bx = pts[inx * 2] - pts[i * 2], by = pts[inx * 2 + 1] - pts[i * 2 + 1];
              const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
              let turn = 0;
              if (la > 0.5 && lb > 0.5) {
                const dot = (ax * bx + ay * by) / (la * lb);
                turn = Math.acos(Math.max(-1, Math.min(1, dot)));
              }
              halfs[k] = hwAt(pts[i * 2], pts[i * 2 + 1]) *
                (1 + Math.min(1.6, Math.max(0, turn - 0.3) * 1.1));
              if (k) len += Math.hypot(sp[k * 2] - sp[(k - 1) * 2], sp[k * 2 + 1] - sp[(k - 1) * 2 + 1]);
            }
            // 拐角处 dt 跳变会让笔身鼓包：开口弧按夹紧边界做三点平滑
            for (let k = 0; k < n; k++) {
              const a = halfs[k > 0 ? k - 1 : 0], b = halfs[k < n - 1 ? k + 1 : n - 1];
              halfs[k] = (a + halfs[k] * 2 + b) * 0.25;
            }
            if (boost) halfs[0] = Math.max(halfs[0], R0 * fS);
            const si = emitPlan(sp, halfs, col, ph, ringOpt(Math.round((180 + len * 2.2) * 10)));
            if (si >= 0) strokes[si].ring = 1;
            if (opts.debug) console.log('[ring] arc n=' + n + ' len=' + Math.round(len) +
              ' start=' + Math.round(sp[0]) + ',' + Math.round(sp[1]));
          };
          // 四个角各做一次"落笔/收笔"：转角处圆头把画幅四角的黑角一次压住，
          // 绕完不用再回手补角；四段首尾同点，回放里是连续的一圈。
          const cornerIdx = (fx, fy) => {
            let bi = 0, bd = Infinity;
            for (let i = 0; i < np; i++) {
              const d = Math.abs(pts[i * 2] - fx) + Math.abs(pts[i * 2 + 1] - fy);
              if (d < bd) { bd = d; bi = i; }
            }
            return bi;
          };
          const cor = [cornerIdx(0, 0), cornerIdx(W - 1, 0), cornerIdx(W - 1, H - 1), cornerIdx(0, H - 1)];
          // 顺时针路径上四个角应该按顺序出现；起点可能落在任意一侧，排序后按环序走
          cor.sort((a, b) => a - b);
          let okCor = true;
          for (let k = 1; k < 4; k++) if (cor[k] - cor[k - 1] < np * 0.12) okCor = false;
          if (cor[3] - cor[0] < np * 0.5) okCor = false;
          if (okCor) {
            const startI = cor[0];
            for (let k = 0; k < 4; k++) {
              const a = cor[k], b = cor[(k + 1) % 4];
              emitArc(a, b, k === 0);
            }
            if (opts.debug) console.log('[ring] corners=' + cor.join(','));
          } else {
            emitArc(bestI, mid, true);
            emitArc(mid, bestI, false);
          }
        } else {
          // 太小的环：退回一条闭笔
          const nn = np + 1;
          const sp = new Float64Array(nn * 2);
          const halfs = new Float64Array(nn);
          for (let i = 0; i < nn; i++) {
            const si = i % np;
            sp[i * 2] = pts[si * 2]; sp[i * 2 + 1] = pts[si * 2 + 1];
            halfs[i] = hwAt(pts[si * 2], pts[si * 2 + 1]);
          }
          const si0 = emitPlan(sp, halfs, col, ph, ringOpt(12000));
          if (si0 >= 0) strokes[si0].ring = 1;
        }
        // 框边常带平行的第二条黑边（纸张上缘、扫描划痕）：同一次结构里顺手续上，
        // 不把它们留给后面的碎点补笔。
        let extra = 0;
        for (let pi = 1; pi < plan.paths.length; pi++) {
          const p2 = plan.paths[pi];
          if (p2.len < Math.max(18, plan.wEst * 2.5)) continue;
          const sp2 = new Float64Array(p2.n * 2);
          const halfs2 = new Float64Array(p2.n);
          let len = 0;
          for (let i = 0; i < p2.n; i++) {
            sp2[i * 2] = p2.pts[i * 2]; sp2[i * 2 + 1] = p2.pts[i * 2 + 1];
            halfs2[i] = hwAt(p2.pts[i * 2], p2.pts[i * 2 + 1]);
            if (i) len += Math.hypot(sp2[i * 2] - sp2[(i - 1) * 2], sp2[i * 2 + 1] - sp2[(i - 1) * 2 + 1]);
          }
          const si2 = emitPlan(sp2, halfs2, col, ph, ringOpt(Math.round((180 + len * 2.2) * 10)));
          if (si2 >= 0) strokes[si2].ring = 1;
          extra++;
        }
        // 一圈走完还差的边角（画幅四角的黑角、扫描毛边）：兜底补几笔。
        // 正常情况（起笔圆头 + 平均带宽保底）这里应该是 0 笔。
        let leftN = 0;
        for (const gid of plan.gids) leftN += Math.max(0, groupUncov[gid]);
        if (leftN > 0) {
          const unc = [];
          for (let p = 0; p < N; p++) {
            if (covered[p]) continue;
            if (plan.mask ? plan.mask[p] : groupOf[p] === g.gid) unc.push(p);
          }
          if (opts.debug) console.log('[ring] left=' + unc.length + '/' + g.area +
            ' (' + (100 * unc.length / Math.max(1, g.area)).toFixed(2) + '%) extra=' + extra);
          if (unc.length) {
            const seen2 = new Uint8Array(N);
            const q = new Int32Array(unc.length);
            for (const p0 of unc) {
              if (seen2[p0]) continue;
              let head = 0, tail = 0;
              q[tail++] = p0; seen2[p0] = 1;
              const comp = [];
              let x0 = W, y0 = H, x1 = -1, y1 = -1;
              while (head < tail) {
                const p = q[head++]; comp.push(p);
                const x = p % W, y = (p - x) / W;
                if (x < x0) x0 = x; if (x > x1) x1 = x;
                if (y < y0) y0 = y; if (y > y1) y1 = y;
                const visit = (r) => {
                  if (r < 0 || r >= N || seen2[r] || covered[r]) return;
                  if (plan.mask ? !plan.mask[r] : groupOf[r] !== g.gid) return;
                  seen2[r] = 1; q[tail++] = r;
                };
                if (x > 0) visit(p - 1);
                if (x + 1 < W) visit(p + 1);
                if (y > 0) visit(p - W);
                if (y + 1 < H) visit(p + W);
              }
              if (opts.debug && unc.length) console.log('[ring] comp ' + comp.length +
                ' bbox=' + x0 + ',' + y0 + ',' + x1 + ',' + y1);
              residualComp(groups[groupOf[p0]] || g, comp, x0, y0, x1, y1, ph);
            }
          }
        }
        return strokes.length - s0;
      };

      // ================= 画家·过程版（人画五遍） =================
      // 与"准确复刻"共用观察层与像素裁剪/记账机制，只把作画组织换成真人流程：
      //   遍1 起稿铺底：背景整片一口气刷满（字/框的位置也刷过去，不预留）
      //   遍2 逐对象完成：一个对象画完再走——外框 → 色心一次填满 → 细节 → 对象内查漏
      //   遍3 点睛：前景/遮挡/最小细节
      //   遍4 收笔：全图查漏（共用收尾块）
      // 没有近似底色表演层：起稿笔的颜色就是这块的最终颜色。
      // ---- 整块一口气填满（人刷字心：宽笔沿长边推几道，这一块当场就满）----
      // 与 paintBlob 的差别只在"不按中轴线断笔、不预缩边"：条带整条横贯 bbox、
      // 由 zoneGid 裁回组形，相邻条带互相搭接，所以不会出现边角留白要靠收笔遍
      // 回头补的情况（以前字心先松排、结尾再补一轮，回放里像分两次涂）。
      const paintRegionFill = (g, ph) => {
        if (groupUncov[g.gid] <= 0) return 0;
        const s0 = strokes.length;
        const ang = mkAng(g, false);
        const ca = Math.cos(ang), sa = Math.sin(ang);
        let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
        for (const [x, y] of [[g.x0 - g.cx, g.y0 - g.cy], [g.x1 - g.cx, g.y0 - g.cy],
          [g.x1 - g.cx, g.y1 - g.cy], [g.x0 - g.cx, g.y1 - g.cy]]) {
          const u = x * ca + y * sa, v = -x * sa + y * ca;
          if (u < uMin) uMin = u; if (u > uMax) uMax = u;
          if (v < vMin) vMin = v; if (v > vMax) vMax = v;
        }
        const short = Math.max(4, Math.min(g.bw, g.bh));
        // 笔宽跟短边走：细笔画一道就过，宽块 3~5 道，和铺底色一样是"刷"不是"点"
        const halfW = Math.max(3.4, Math.min(52 * scaleB, short * 0.44));
        const step = Math.max(3, halfW * 1.12);
        const span = vMax - vMin;
        const k = Math.max(1, Math.ceil(span / step));
        const uA = uMin - halfW * 1.7, uB = uMax + halfW * 1.7;
        // 字心是平涂块：用本组均值一次落成，不拆网点。软背景的两级网点是为
        // 了表现比 8 位色阶还细的渐变，用在这里会把一笔实色拆成两层点：回放里
        // 看着像"点涂"，不是背景那种一把刷满。
        const gs = (g.soft || g.grad || g.dither) ? { ...g, soft: 0, grad: 0, dither: 0 } : g;
        let n = 0;
        for (let i = 0; i < k; i++) {
          // 这里不查 hardCap：画家路径的笔是按像素覆盖发的（emitPlan 以 ph=0 落笔），
          // 硬上限只约束 artist 的表演笔，套在这里会让整组一条带都发不出。
          if (groupUncov[g.gid] <= 0) break;
          const f = k === 1 ? 0.5 : i / (k - 1);
          const v = vMin + span * f;
          emitBand(gs, uA, uB, v, ca, sa, halfW, ph, ang, (n & 1) ? 1 : 0);
          n++;
        }
        // 曲线组被直带擦漏的零星像素当场换角补掉（仍在这一笔群内，不留给收笔遍）
        const uAfter = groupUncov[g.gid];
        if (uAfter > 0) fillGaps(g, ph, ang, halfW);
        if (opts.debug) console.log('[fill] gid=' + g.gid + ' area=' + g.area + ' bbox=' + g.bw + 'x' + g.bh +
          ' ang=' + ang.toFixed(2) + ' hw=' + halfW.toFixed(1) + ' k=' + k + ' span=' + span.toFixed(0) +
          ' strips=' + n + ' unc=' + uAfter + '->' + groupUncov[g.gid] + ' strokes=' + (strokes.length - s0));
        return strokes.length - s0;
      };
      const paintFull = (g, ph) => {
        // 一次画准：线走骨架笔，块走完整块面（艺术家路径的 paintBlob 原行为）。
        if (g.lineLike && !g.soft) {
          paintLine(g, ph);
          if (groupUncov[g.gid] > 0) paintBlob(g, ph);
        } else paintBlob(g, ph);
      };
      // ---- 蓝底整页一趟（人铺底色）----
      // 旧 wash 把墨裁在"蓝像素"里，字/框的位置一个像素都不刷，等于先在纸上给字
      // 预留了位置；随后还要按色组重刷上万笔。真人不会预留：整块版面一口气刷满，
      // 字的位置也盖过去，回头再把字画在蓝底上。这里按条带蛇形扫完整个版面矩形，
      // 条带内按原图色段取局部真实色；每条刷完顺手把这条里明显不匀的斑块补掉。
      // 返回 ok=false（不是"蓝底大版面"的图）时，调用方回退旧的 wash+细化背景。
      const paintBgFlood = async (frameFam) => {
        // 铺满的对象 = 主色背景族（不按颜色特判：蓝底、白纸底、任何纯色底同一套）。
        // 闸门全部可测量：面积 ≥15%、贴画布 ≥3 条边、颜色均匀（面积加权 p90 偏差 ≤12）。
        const blue = new Uint8Array(N);
        let bx0 = W, by0 = H, bx1 = -1, by1 = -1, blueN = 0;
        for (let p = 0; p < N; p++) {
          const gid = groupOf[p];
          if (gid < 0 || !bgFirstPlan.famGid[gid] || frameFam[gid]) continue;
          blue[p] = 1; blueN++;
          const x = p % W, y = (p - x) / W;
          if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
          if (y < by0) by0 = y; if (y > by1) by1 = y;
        }
        const bwN = bx1 - bx0 + 1, bhN = by1 - by0 + 1;
        const rectFill = blueN / Math.max(1, bwN * bhN);
        if (opts.debug) console.log('[bgflood] famN=' + (blueN / N * 100).toFixed(1) + '% edges=' +
          bgFirstPlan.famEdges + ' spread=' + bgFirstPlan.famSpread.toFixed(1) +
          ' rectFill=' + (rectFill * 100).toFixed(1) + '%');
        // 背景 = 主色族里真正"铺满整页"的那一块。贴边数只能证明它碰到了画布边缘，
        // 不能证明它是页面：例如窗边插画的下半幅地面会同时碰到左、右、下三边，
        // 但只填满自身包围盒的一半。这里再要求包围盒内的高填充率，避免把横向
        // 地面/色带误当成整页底色而横贯全图重扫。四周有细框的海报仍由 pageLike
        // 处理；渐变/碎色底继续由 spread 挡掉。
        const pageLike = bwN >= W * 0.6 && bhN >= H * 0.6;
        const edgePageLike = bgFirstPlan.famEdges >= 3 && rectFill >= 0.62;
        if (blueN < N * 0.15 || bx1 < 0 || bgFirstPlan.famSpread > 12 ||
          !(pageLike || edgePageLike)) {
          return { ok: false, x: W * 0.5, y: H * 0.5 };
        }
        // 取色用的"纯蓝芯"：3×3 邻域全是蓝的像素。字的抗锯齿边是蓝底+奶油混出来的
        // 深蓝，按像素取均值会把跨字的色段带暗，回放里字就阴魂不散地浮在蓝底上。
        const core = new Uint8Array(N);
        for (let y = 1; y < H - 1; y++) {
          const row = y * W;
          for (let x = 1; x < W - 1; x++) {
            const p = row + x;
            if (!blue[p]) continue;
            if (blue[p - 1] && blue[p + 1] && blue[p - W] && blue[p + W] &&
              blue[p - W - 1] && blue[p - W + 1] && blue[p + W - 1] && blue[p + W + 1]) core[p] = 1;
          }
        }
        const bwP = bx1 - bx0 + 1, bhP = by1 - by0 + 1;
        // 主色底不是整张矩形：它只铺到“与主色背景连成一片、且没有被
        // 其它大背板隔断”的区域。这样海报标题/底色上的图形会被底色
        // 自然盖过，而像 FLY 上半幅深蓝版面、窗玻璃这类独立背板不会被
        // 主色横刷误盖，回放中段不会先出现一整块错误颜色。
        const blockG = new Uint8Array(G_);
        for (const g of groups) {
          if (frameFam[g.gid] ||
            (bgFirstPlan.bgSet[g.gid] && !bgFirstPlan.famGid[g.gid]) ||
            (!bgFirstPlan.bgSet[g.gid] && g.area > N * 0.025)) blockG[g.gid] = 1;
        }
        const baseRegion = new Uint8Array(N);
        const baseQ = new Int32Array(N);
        let baseHead = 0, baseTail = 0;
        for (let y = by0; y <= by1; y++) {
          const row = y * W;
          for (let x = bx0; x <= bx1; x++) {
            const p = row + x;
            if (!blue[p]) continue;
            baseRegion[p] = 1; baseQ[baseTail++] = p;
          }
        }
        while (baseHead < baseTail) {
          const p = baseQ[baseHead++], x = p % W, y = (p - x) / W;
          const visit = (q) => {
            if (q < 0 || q >= N || baseRegion[q] || segPaper[q]) return;
            const qx = q % W;
            if (qx < bx0 || qx > bx1 || q < by0 * W || q >= (by1 + 1) * W) return;
            const gid = groupOf[q];
            if (gid < 0 || blockG[gid]) return;
            baseRegion[q] = 1; baseQ[baseTail++] = q;
          };
          if (x > bx0) visit(p - 1);
          if (x < bx1) visit(p + 1);
          if (y > by0) visit(p - W);
          if (y < by1) visit(p + W);
        }
        const page = new Uint8Array(bwP * bhP);
        for (let y = by0; y <= by1; y++) {
          const row = y * W, mr = (y - by0) * bwP;
          for (let x = bx0; x <= bx1; x++) page[mr + x - bx0] = baseRegion[row + x] ? 1 : 0;
        }
        const zoneRect = { m: page, x0: bx0, y0: by0, w: bwP, h: bhP };
        const stripH = Math.max(10, Math.min(32, Math.round(Math.min(W, H) * 0.022)));
        const hw = stripH * 0.56;             // 条带略微搭接，刷完不留缝
        // 版面最外一圈（扫描暗边/压痕）：条带取色太粗，留给后面的"收边"用原图色
        // 逐组刷准（仍在同一遍里，绕一圈就完），成品边缘不会啃掉一圈蓝。
        const RIM = Math.max(16, Math.round(Math.min(W, H) * 0.03));
        const rows = Math.ceil(bhP / stripH);
        const d2c = (a, b) => {
          const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
          return dr * dr + dg * dg + db * db;
        };
        const seen = new Uint8Array(N);
        const bfs = new Int32Array(N);
        let endX = bx1, endY = by1, nStrokes = 0, nFix = 0;
        for (let r = 0; r < rows; r++) {
          const sy = by0 + r * stripH, ey = Math.min(by1, sy + stripH - 1);
          // 每列的主导色组（字形覆盖的列沿用两侧的蓝，不重开一段）
          const colG = new Int32Array(bwP).fill(-1);
          for (let x = bx0; x <= bx1; x++) {
            const cnt = new Map();
            for (let y = sy; y <= ey; y++) {
              const p = y * W + x;
              if (!core[p]) continue;         // 只按纯蓝芯投票：字的抗锯齿边不算色段
              const gid = groupOf[p];
              if (gid < 0) continue;
              const v = (cnt.get(gid) || 0) + 1;
              cnt.set(gid, v);
            }
            let best = -1, bn = 0;
            for (const [gid, v] of cnt) if (v > bn) { bn = v; best = gid; }
            colG[x - bx0] = best;
          }
          // 沿 x 切色段：只按纯蓝芯切；字/框占住的列先空出来
          const runs = [];
          let cur = null;
          for (let x = bx0; x <= bx1; x++) {
            const gid = colG[x - bx0];
            const g = gid >= 0 ? groups[gid] : null;
            if (g && cur) {
              if (gid === cur.gid || d2c(g.mean, cur.mean) <= 144) { cur.x1 = x; cur.gid = gid; continue; }
            }
            if (g) {
              if (cur && cur.x1 - cur.x0 + 1 < 6) { cur.x1 = x; cur.gid = gid; continue; }
              if (cur) runs.push(cur);
              cur = { gid, mean: g.mean, x0: x, x1: x };
            } else if (cur) { runs.push(cur); cur = null; }
          }
          if (cur) runs.push(cur);
          const keep = [];
          for (const run of runs) {
            let sr = 0, sg = 0, sb = 0, sn = 0;
            for (let y = sy; y <= ey; y++) {
              const row = y * W;
              for (let x = run.x0; x <= run.x1; x++) {
                const p = row + x;
                if (!core[p]) continue;
                sr += R[p]; sg += G[p]; sb += B[p]; sn++;
              }
            }
            if (!sn) {                        // 整段没剩纯蓝芯（极窄的缝）：退回全部蓝像素
              for (let y = sy; y <= ey; y++) {
                const row = y * W;
                for (let x = run.x0; x <= run.x1; x++) {
                  const p = row + x;
                  if (!blue[p]) continue;
                  sr += R[p]; sg += G[p]; sb += B[p]; sn++;
                }
              }
            }
            if (!sn) continue;
            run.col = [Math.round(sr / sn), Math.round(sg / sn), Math.round(sb / sn)];
            keep.push(run);
          }
          // 字/框的空档：左右两段的色线性过渡着刷过去（每 ~60px 一段）。
          // 直接用一侧的颜色会把字的轮廓留在蓝底上；过渡刷过去，字位就和蓝底融成一片。
          const segs = [];
          const putSeg = (x0, x1, col) => { if (x1 >= x0 && col) segs.push({ x0, x1, col }); };
          const putGap = (a, b, ca, cb) => {
            const len = b - a + 1;
            if (len <= 0) return;
            const k = Math.max(1, Math.ceil(len / 60));
            for (let i = 0; i < k; i++) {
              const x0 = a + Math.floor(len * i / k), x1 = a + Math.floor(len * (i + 1) / k) - 1;
              const f = (i + 0.5) / k;
              putSeg(x0, x1, [
                Math.round(ca[0] + (cb[0] - ca[0]) * f),
                Math.round(ca[1] + (cb[1] - ca[1]) * f),
                Math.round(ca[2] + (cb[2] - ca[2]) * f),
              ]);
            }
          };
          if (keep.length) {
            let px = bx0;
            for (let k = 0; k < keep.length; k++) {
              const run = keep[k];
              if (run.x0 > px) putGap(px, run.x0 - 1, k > 0 ? keep[k - 1].col : run.col, run.col);
              putSeg(run.x0, run.x1, run.col);
              px = run.x1 + 1;
            }
            if (px <= bx1) putGap(px, bx1, keep[keep.length - 1].col, keep[keep.length - 1].col);
          }
          if (r & 1) segs.reverse();          // 蛇形：下一行从另一头接上
          for (const seg of segs) {
            const xa = Math.max(bx0, seg.x0 - 1), xb = Math.min(bx1, seg.x1 + 1);
            const len = xb - xa;
            if (len < 2) continue;
            const nP = Math.max(2, Math.min(7, Math.round(len / 48) + 1));
            const sp = new Float64Array(nP * 2);
            const halfs = new Float64Array(nP);
            const yc = (sy + ey) * 0.5;
            const bow = (srnd(r * 1.7 + seg.x0 * 0.031, 4.9) - 0.5) * hw * 0.22;
            const seed = r * 3.1 + seg.x0 * 0.013 + runSeed * 0.05;
            for (let i = 0; i < nP; i++) {
              const f = nP > 1 ? i / (nP - 1) : 0.5;
              sp[i * 2] = xa + len * f;
              sp[i * 2 + 1] = yc + bow * Math.sin(Math.PI * f) +
                (srnd(seed + i * 0.77, 2.3) - 0.5) * 0.9;
              halfs[i] = hw * (0.97 + 0.06 * Math.sin(Math.PI * f)) *
                (0.97 + 0.06 * srnd(seed + i * 1.31, 3.7));
            }
            const si = emitStroke(sp, halfs, seg.col, 0, {
              pen: 0, color: seg.col, zoneMaskRect: zoneRect, noCover: 1, minInk: 8,
              ms: Math.round(12 + len * 0.35),
            });
            if (si >= 0) { nStrokes++; strokes[si].fl = 1; }
            endX = sp[sp.length - 2]; endY = sp[sp.length - 1];
          }
          // 条带内补色：这一条里色差 >24 的成块偏差，按块内真实色就地补掉。
          // 只补 ≥8px 的块；1~2px 的扫描噪点不来回点（肉眼看不见，点起来反而像机器）。
          const bad = [];
          for (let y = sy; y <= ey; y++) {
            const row = y * W;
            for (let x = bx0; x <= bx1; x++) {
              const p = row + x;
              if (!blue[p]) continue;
              const q = p * 3;
              if (Math.max(Math.abs(canvas[q] - R[p]), Math.abs(canvas[q + 1] - G[p]),
                Math.abs(canvas[q + 2] - B[p])) > 24) bad.push(p);
            }
          }
          if (bad.length) {
            for (const p0 of bad) {
              if (seen[p0]) continue;
              let head = 0, tail = 0;
              bfs[tail++] = p0; seen[p0] = 1;
              const pix = [];
              let x0 = W, y0 = H, x1 = -1, y1 = -1;
              const gid0 = groupOf[p0];
              while (head < tail) {
                const p = bfs[head++];
                pix.push(p);
                const x = p % W, y = (p - x) / W;
                if (x < x0) x0 = x; if (x > x1) x1 = x;
                if (y < y0) y0 = y; if (y > y1) y1 = y;
                const visit = (rr) => {
                  if (rr < sy * W || rr >= (ey + 1) * W || seen[rr]) return;
                  if (groupOf[rr] !== gid0 || !blue[rr]) return;
                  const qq = rr * 3;
                  if (Math.max(Math.abs(canvas[qq] - R[rr]), Math.abs(canvas[qq + 1] - G[rr]),
                    Math.abs(canvas[qq + 2] - B[rr])) <= 24) return;
                  seen[rr] = 1; bfs[tail++] = rr;
                };
                if (x > 0) visit(p - 1);
                if (x + 1 < W) visit(p + 1);
                if (y > 0) visit(p - W);
                if (y + 1 < H) visit(p + W);
              }
              if (pix.length < 8) continue;
              nFix++;
              let cr = 0, cg = 0, cb = 0;
              for (const p of pix) { cr += R[p]; cg += G[p]; cb += B[p]; }
              const col2 = [Math.round(cr / pix.length), Math.round(cg / pix.length), Math.round(cb / pix.length)];
              // 字边/红边的抗锯齿像素会混进蓝掩膜；这里只补"本身是蓝"的斑块，
              // 混色边留给后面的字，不先在蓝底上点出一圈红丝。
              // 只补"本身是主背景色"的斑块；混色边留给后面的字/主体
              if (Math.max(Math.abs(col2[0] - bgFirstPlan.washColor[0]),
                Math.abs(col2[1] - bgFirstPlan.washColor[1]),
                Math.abs(col2[2] - bgFirstPlan.washColor[2])) > 24) continue;
              const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
              const m = new Uint8Array(bw * bh);
              for (const p of pix) {
                const x = p % W, y = (p - x) / W;
                m[(y - y0) * bw + x - x0] = 1;
              }
              const hwFix = Math.max(2.4, 0.72 * Math.max(bw, bh) + 1);
              const sp2 = new Float64Array([x0, y0, x1, y1]);
              const hf2 = new Float64Array([hwFix, hwFix]);
              const sfix = emitStroke(sp2, hf2, col2, 0, {
                pen: 0, color: col2, zoneMaskRect: { m, x0, y0, w: bw, h: bh },
                noCover: 1, minInk: 1, ms: 24,
              });
              if (sfix >= 0) strokes[sfix].fl = 1;
            }
          }
          prog(0.68 + 0.03 * (r + 1) / rows, '铺满：整页蓝底一趟刷满…');
          await yieldUI();
        }
        // 蓝像素统一记账：这一遍就是蓝底的最终色；ph0 之后不再有蓝底笔。
        // 逐组记账是为了让尾声"收笔查漏"不会再回头补蓝区。
        let forced = 0;
        for (let p = 0; p < N; p++) {
          if (!blue[p] || segPaper[p]) continue;
          const gid = groupOf[p];
          if (gid < 0) continue;
          const x = p % W, y = (p - x) / W;
          const rim = x <= bx0 + RIM || x >= bx1 - RIM || y <= by0 + RIM || y >= by1 - RIM;
          if (rim) continue;                  // 外圈留给 edgeGroups 逐组画准
          if (!paintN[p]) { paintN[p] = 1; groupUncov[gid]--; zoneCov++; forced++; }
          if (!covered[p]) { covered[p] = 1; coveredN++; }
        }
        if (opts.debug) console.log('[flood] bgN=' + blueN + ' rect=' + bx0 + ',' + by0 + ',' + bx1 + ',' + by1 +
          ' strips=' + rows + ' strokes=' + nStrokes + ' fixComp=' + nFix + ' forced=' + forced);
        return { ok: true, x: endX, y: endY };
      };
      const paintHumanFlow = async (objectPass = false, objectBgSet = null) => {
        const BGP = bgFirstPlan;
        if (!objectPass && !BGP) return;
        // 对象模式使用 compiler 根据“父层所有权”标出的背景组；它不依赖旧
        // bgFirstPlan 的色族门槛，因此文字/描边对象不会因背景判据失败而消失。
        const bgSet = objectBgSet || BGP.bgSet;
        // 画框先认出来：背景铺满要避开边框带（框留到下一遍整圈画）
        const frameCand = BGP ? BGP.bgAll.slice().sort((a, b) => b.area - a.area)[0] : null;
        const framePlan = frameCand ? ringPlan(frameCand) : null;
        const frameFam = new Uint8Array(G_);
        if (framePlan) for (const gid of framePlan.gids) frameFam[gid] = 1;
        // 对象执行器与页面执行器共享手的位置和边框排除表，但对象模式绝不
        // 重新铺底、补背景或跑旧式补缝；它只处理前景对象内部。
        let handX = W * (0.5 + (srnd(11.7, 8.1) - 0.5) * 0.22);
        let handY = H * (0.5 + (srnd(13.1, 8.9) - 0.5) * 0.22);
        const ringDone = new Set();
        const blockFallbackDone = new Set();
        const paintBlockIn = (gids, x0, y0, x1, y1, ph, opt) => {
          const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
          if (bw <= 0 || bh <= 0 || bw * bh > 2200000) return 0;
          const m = new Uint8Array(bw * bh);
          const inSet = new Uint8Array(G_);
          for (const gid of gids) if (gid >= 0 && gid < G_) inSet[gid] = 1;
          let mn = 0;
          for (let y = y0; y <= y1; y++) {
            const row = y * W, mr = (y - y0) * bw;
            for (let x = x0; x <= x1; x++) {
              const gid = groupOf[row + x];
              if (gid < 0 || !inSet[gid]) continue;
              m[mr + x - x0] = 1; mn++;
            }
          }
          const minPx = (opt && opt.minPx) || 24;
          if (mn < minPx) return 0;
          const probePts = globalThis.__ISP_DEBUG_PTS || [];
          // 大色面底稿要盖过它内部的前景孔洞（标题、飞机、杯柄等），否则
          // 背景阶段会把字和物体先留成纸白，后面再像拼贴一样塞进去。
          // 只填“从包围盒外走不到”的封闭孔；贴边纸框/细框（填充率过低）
          // 不参与，避免把整幅画面误填成框色。
          const mShape = opt && opt.fillHoles ? m.slice() : null;
          let holeAdd = 0;
          if (opt && opt.fillHoles) {
            const fillFrac = mn / Math.max(1, bw * bh);
            // 细框/纸边也会围出巨大的内部空白；若外周几乎全被自身占用、
            // 内部又很空，它是“框”而不是“面板”，不能把整幅填成框色。
            let pN = 0, pT = 0;
            for (let x = 0; x < bw; x++) { pT += 2; if (m[x]) pN++; if (m[(bh - 1) * bw + x]) pN++; }
            for (let y = 1; y + 1 < bh; y++) { pT += 2; if (m[y * bw]) pN++; if (m[y * bw + bw - 1]) pN++; }
            const perimeter = pN / Math.max(1, pT);
            if (fillFrac >= 0.08 && fillFrac <= 0.94 && !(perimeter > 0.60 && fillFrac < 0.30)) {
              const outside = new Uint8Array(bw * bh);
              const q = new Int32Array(bw * bh);
              let qh = 0, qt = 0;
              const seed = (i) => { if (i >= 0 && i < outside.length && !outside[i] && !m[i]) { outside[i] = 1; q[qt++] = i; } };
              for (let x = 0; x < bw; x++) { seed(x); seed((bh - 1) * bw + x); }
              for (let y = 0; y < bh; y++) { seed(y * bw); seed(y * bw + bw - 1); }
              while (qh < qt) {
                const i = q[qh++], x = i % bw, y = (i - x) / bw;
                if (x > 0) seed(i - 1);
                if (x + 1 < bw) seed(i + 1);
                if (y > 0) seed(i - bw);
                if (y + 1 < bh) seed(i + bw);
              }
              for (let i = 0; i < m.length; i++) if (!m[i] && !outside[i]) { m[i] = 1; holeAdd++; }
              mn += holeAdd;
            }
          }
          // 背景版面里的主体/文字缺口常与包围盒边缘连通，严格意义上的封闭孔
          // 判据抓不到它们。preBg 是“先把大色面立住”的粗铺，按每一行的左右
          // 边界补齐内部跨度即可，后续真实剪影和对象笔会再把细节盖回来。
          if (opt && opt.fillSpan) {
            for (let y = 0; y < bh; y++) {
              const row = y * bw;
              let l = -1, r = -1;
              for (let x = 0; x < bw; x++) if (m[row + x]) { l = x; break; }
              for (let x = bw - 1; x >= 0; x--) if (m[row + x]) { r = x; break; }
              if (l < 0 || r <= l) continue;
              for (let x = l + 1; x < r; x++) m[row + x] = 1;
            }
          }
          // 对象与背景的分割边缘常有 1px 抗锯齿层不属于任何色组，只看真实
          // 剪影会留下纸白缝。底稿向外吃 1~2px，取到的仍是邻边原图颜色，
          // 相当于先铺满接缝；精确笔仍按原剪影裁剪，不改最终轮廓。
          const pad = Math.max(0, Math.min(4, (opt && opt.pad) | 0));
          for (let it = 0; it < pad; it++) {
            const d = m.slice();
            for (let y = 0; y < bh; y++) {
              const row = y * bw;
              for (let x = 0; x < bw; x++) {
                const i = row + x;
                if (m[i]) continue;
                if ((x > 0 && m[i - 1]) || (x + 1 < bw && m[i + 1]) ||
                    (y > 0 && m[i - bw]) || (y + 1 < bh && m[i + bw])) d[i] = 1;
              }
            }
            m.set(d);
          }
          if (pad) {
            mn = 0;
            for (let i = 0; i < m.length; i++) mn += m[i];
          }
          // 主组角度只决定扫带方向，不影响最终轮廓；轻微相移让不同对象
          // 的铺底不完全同向，避免整张图看起来像同一台扫描仪扫出来的。
          let lead = null, lineLead = null;
          for (const gid of gids) {
            const g = groups[gid];
            if (!g) continue;
            if (g.lineLike) {
              if (!lineLead || g.area > lineLead.area) lineLead = g;
              continue;
            }
            if (!lead || g.area > lead.area) lead = g;
          }
          const axisLead = lead || lineLead;
          let ang = axisLead && isFinite(axisLead.angle) ? axisLead.angle : 0;
          // 长细色带的扫带方向必须顺着它的长轴。若沿用对象内某个小色块的
          // 角度，扫带会几乎垂直穿过 1~3px 细带，离散采样后一笔也落不到
          // 掩膜里，回放中就会留下贯穿对象的长白缝。
          const aspect = Math.max(bw, bh) / Math.max(1, Math.min(bw, bh));
          if (aspect >= 3.2) ang = bw >= bh ? 0 : Math.PI * 0.5;
          if (opt && opt.horizontal) ang = 0;
          ang += (srnd((lead ? lead.gid : 0) * 4.7 + runSeed * 0.041, 3.9) - 0.5) * 0.10;
          const ca = Math.cos(ang), sa = Math.sin(ang);
          const cx = (x0 + x1) * 0.5, cy = (y0 + y1) * 0.5;
          let vMin = Infinity, vMax = -Infinity;
          for (const [x, y] of [[x0 - cx, y0 - cy], [x1 - cx, y0 - cy],
            [x1 - cx, y1 - cy], [x0 - cx, y1 - cy]]) {
            const v = -x * sa + y * ca;
            if (v < vMin) vMin = v; if (v > vMax) vMax = v;
          }
          const shortSide = Math.min(bw, bh);
          const maxHalf = (opt && opt.maxHalf) || 42 * scaleB;
          const hw = Math.max(3.5, Math.min(maxHalf, shortSide * 0.38,
            Math.max(5, Math.sqrt(mn) * 0.10)));
          const step = Math.max(3, hw * 0.86);
          const z = Math.min(2, Math.max(0, ph | 0));
          const s0 = strokes.length;
          // 稍微伸到包围盒外，笔身会由掩膜裁掉，只覆盖真实剪影。
          const uHalf = Math.hypot(bw, bh) * 0.54 + hw;
          const v0 = vMin - hw * 0.18;
          const v1 = vMax + hw * 0.18;
          const emitSweep = (mask, useLocal, baseColor, stage) => {
            const zoneRect = { m: mask, x0, y0, w: bw, h: bh };
            const runS0 = strokes.length;
            for (let v = v0; v <= v1 + 0.01; v += step) {
              let runA = null;
              const emitRun = (a, b) => {
                if (b - a < 1.5) return;
                const p0 = [cx + a * ca - v * sa, cy + a * sa + v * ca];
                const p1 = [cx + b * ca - v * sa, cy + b * sa + v * ca];
                const spine = new Float64Array([p0[0], p0[1], p1[0], p1[1]]);
                const halfs = new Float64Array([hw, hw]);
                // 与画家路径其余精确笔一致，粗铺永远以 ph=0 发射以绕过硬上限；
                // 落笔后再恢复真实阶段。否则背景阶段累计笔数一旦超过 hardCap，
                // 所有对象粗铺都会被静默丢弃，主体在中段仍是大块纸白。
                const si = emitStroke(spine, halfs, baseColor, 0, {
                  pen: 0, zoneMaskRect: zoneRect, noCover: 1, noZone: 1,
                  localColor: useLocal ? 1 : 0, color: baseColor || [128, 128, 128],
                  minInk: 1, ms: 28 + (b - a) * 0.22,
                });
                if (si >= 0) {
                  strokes[si].ph = z;
                  strokes[si].fl = 1;
                  strokes[si].travelK = 0.08;
                  if (stage) strokes[si].stage = stage;
                }
              };
              for (let u = -uHalf; u <= uHalf; u += 1) {
                const x = Math.round(cx + u * ca - v * sa) - x0;
                const y = Math.round(cy + u * sa + v * ca) - y0;
                const inside = x >= 0 && y >= 0 && x < bw && y < bh && mask[y * bw + x];
                if (inside) { if (runA === null) runA = u; }
                else if (runA !== null) { emitRun(runA, u - 1); runA = null; }
              }
              if (runA !== null) emitRun(runA, uHalf);
            }
            return strokes.length - runS0;
          };
          // 横扫对平行细带有效，但若细带本身有断续抗锯齿或位于对象边缘，
          // 采样仍可能整段漏掉。对长细色组再按真实掩膜逐行/逐列补一次
          // 贴形短线：仍然只取本组原色、只裁在本组像素内，不跨色平均。
          const emitThinRuns = (mask, g, stage, force) => {
            const gbw = g.x1 - g.x0 + 1, gbh = g.y1 - g.y0 + 1;
            const long = Math.max(gbw, gbh), thick = Math.min(gbw, gbh);
            if (!force && (long < Math.min(W, H) * 0.04 ||
                thick > Math.min(W, H) * 0.032 || long < thick * 3)) return 0;
            const gx0 = Math.max(x0, g.x0), gx1 = Math.min(x1, g.x1);
            const gy0 = Math.max(y0, g.y0), gy1 = Math.min(y1, g.y1);
            if (gx1 < gx0 || gy1 < gy0) return 0;
            let ang;
            if (long >= thick * 3.2) ang = gbw >= gbh ? 0 : Math.PI * 0.5;
            else ang = isFinite(g.angle) ? g.angle : (gbw >= gbh ? 0 : Math.PI * 0.5);
            const ca = Math.cos(ang), sa = Math.sin(ang);
            const cxg = (gx0 + gx1) * 0.5, cyg = (gy0 + gy1) * 0.5;
            const span = (Math.abs(gx1 - gx0) * Math.abs(ca) + Math.abs(gy1 - gy0) * Math.abs(sa)) * 0.5 + 2;
            const hw2 = Math.max(2, Math.min(22, thick * 0.62 + 1.5));
            const spine = new Float64Array([
              cxg - ca * span, cyg - sa * span,
              cxg + ca * span, cyg + sa * span,
            ]);
            const si = emitStroke(spine, new Float64Array([hw2, hw2]), g.mean, 0, {
              pen: 0, zoneMaskRect: { m: mask, x0, y0, w: bw, h: bh },
              noCover: 1, noZone: 1, localColor: 0, color: g.mean,
              minInk: 1, ms: 8 + span * 0.10,
            });
            if (si < 0) return 0;
            strokes[si].ph = z;
            strokes[si].fl = 1;
            strokes[si].travelK = 0.05;
            if (stage) strokes[si].stage = stage;
            return 1;
          };
          // 先铺一层连续“地面”：整块用主色一次带过，保证过程中没有纸白洞。
          // 这层绝不做局部取色，否则跨色区的扫带会被平均成灰褐条纹。
          // 随后只在真实剪影内按局部色重铺，保留原图的平涂层次和抗锯齿边。
          // 孔洞/跨行补齐只负责先把纸白盖掉，颜色必须按补进来的像素局部取。
          // 若统一刷成主组颜色，窗框的深色会把整块玻璃先涂黑，圆环也会先把
          // 中心涂成环色；这两种过程帧都像错误色块，而不是人在铺大形。
          // 补齐的孔洞/行跨里，绝大多数像素仍属于真实色组，已经由下面的
          // 分组局部笔精确覆盖。这里只保留不属于任何色组的抗锯齿/缝线像素，
          // 绝不能再把整块补洞区域用一笔“地面色”盖回去：那会跨过杯身、文字
          // 和飞机等前景，把先画对的内容重新抹成相邻背景的混色。
          const patch = mShape ? (() => {
            let any = 0;
            const q = new Uint8Array(m.length);
            for (let i = 0; i < m.length; i++) {
              if (!m[i] || mShape[i]) continue;
              const yy = y0 + ((i / bw) | 0), xx = x0 + (i % bw);
              if (groupOf[yy * W + xx] >= 0) continue;
              q[i] = 1; any++;
            }
            return any ? q : null;
          })() : null;
          const formMask = mShape || m;
          // 背景版面先铺时，孔洞/行跨必须直接用“这块版面的主色”盖住，
          // 不能把里面尚未开画的前景保留成纸白剪影。纸白文字/杯形在中段
          // 被背景补掉会像“画了又消失”；真人会先把底铺整，再在底上画对象。
          if (opt && opt.panelGround) {
            emitSweep(m, false, lead ? lead.mean : [128, 128, 128],
              opt.stage ? opt.stage + ':ground' : undefined);
            return strokes.length - s0;
          }
          if (patch) {
            emitSweep(formMask, false, lead ? lead.mean : [128, 128, 128],
              opt && opt.stage ? opt.stage + ':ground' : undefined);
          }
          // 局部色必须按原始色组分别取样。若让一笔同时扫过白杯和棕色书本，
          // 取样会把两种颜色平均成灰褐，过程帧就会出现明显错误色块。这里
          // 共用同一剪影和扫带方向，只把局部上色拆成色组粒度。
          const localGids = new Set(gids);
          if (mShape) {
            for (let i = 0; i < mShape.length; i++) {
              if (!mShape[i]) continue;
              const gid = groupOf[(y0 + ((i / bw) | 0)) * W + x0 + (i % bw)];
              if (gid >= 0) localGids.add(gid);
            }
          }
          if (probePts.length) {
            for (const [px, py] of probePts) {
              if (px < x0 || py < y0 || px > x1 || py > y1) continue;
              const i = (py - y0) * bw + px - x0;
              const pg = groupOf[py * W + px];
              console.log('[blockprobe-miss]', opt && opt.stage || '-', 'pt=' + px + ',' + py,
                'gid=' + pg, 'inSet=' + inSet[pg], 'm=' + m[i], 'form=' + formMask[i],
                'local=' + localGids.has(pg));
            }
          }
          for (const gid of localGids) {
            const gm = new Uint8Array(m.length);
            let any = 0;
            for (let i = 0; i < gm.length; i++) {
              if (!formMask[i]) continue;
              const yy = y0 + ((i / bw) | 0), xx = x0 + (i % bw);
              if (groupOf[yy * W + xx] !== gid) continue;
              gm[i] = 1; any++;
            }
            if (any) {
              const ng = emitSweep(gm, true, null,
                (opt && opt.stage ? opt.stage + ':g' + gid : undefined));
              const gt = groups[gid];
              if (gt && !blockFallbackDone.has(gid)) {
                const nfb = emitThinRuns(gm, gt,
                  opt && opt.stage ? opt.stage + ':thin' + gid : undefined, ng === 0);
                if (nfb > 0) blockFallbackDone.add(gid);
              }
              for (const [px, py] of probePts) {
                if (px < x0 || py < y0 || px > x1 || py > y1) continue;
                if (!gm[(py - y0) * bw + px - x0]) continue;
                console.log('[blockprobe]', opt && opt.stage || '-', 'gid=' + gid,
                  'pt=' + px + ',' + py, 'any=' + any, 'emit=' + ng);
              }
            }
          }
          if (patch) {
            emitSweep(patch, true, null,
              opt && opt.stage ? opt.stage + ':fill' : undefined);
          }
          return strokes.length - s0;
        };
        if (!objectPass) {
        // ---- 遍1 铺满：整块主色版面一口气刷满（字/框的位置也刷过去）----
        prog(0.68, '铺满：整页底色一趟刷满…');
        await yieldUI();
        // 剪影底稿：沿着选定轴向逐条扫过真实像素掩膜，而不是用一两根
        // 包围盒中心线“示意”一下。每条笔都用 zoneMaskRect 裁进对象剪影，
        // 相邻扫带留有重叠，所以圆盘、山体、窗格这类非矩形大形不会在中间
        // 留下纸白洞。底稿固定 noCover/noZone，后续精确笔仍会照常记账。
        // 构图底色先落一层：大面积背景块各用一到两笔带过，先把海报的上下
        // 版面、风景的天空/水面、窗玻璃等大关系立住。等整页底色刷完才看到
        // 蓝色版面，回放前半段会像在空纸上磨时间。这里只碰 bgSet 的大块，
        // 不碰文字、花、猫脸等前景；后续 flood/细化仍会逐像素校正。
        {
          // 只起最上面两块“版面”。背景色族常被文字/主体切成许多色组，
          // 若每组都铺一遍，后面的浅色组会半途盖掉刚画好的深色底，回放
          // 看起来像闪烁；低密度的外框组更不能做行跨填充，否则整页会先黑。
          // 先覆盖所有显著背景版面，而不是固定只取两块。大图常由天空、
          // 山体、水面、墙面、地面等多块共同构成；只铺两块会在其余区域
          // 留下大面积纸白，随后又被补上，过程像图层闪烁。
          // 背景先按画面中的高度从上到下铺，再按面积兜底。风景/室内图的
          // 天空、远山、水面、墙面、地面本来就是层层建立的关系；若只按面积
          // 排序，会先刷水面再刷天空，前几帧像在随机贴色块。
          const preBg = groups.filter((g) => {
            if (!bgSet[g.gid] || g.lineLike) return false;
            // 大面积的整块背板，和虽被压成窄带却横跨大半画幅的背景色层，
            // 都属于起稿阶段应当先铺的空间关系。窄小杂点留给背景细化。
            return g.area >= N * 0.01 || (g.area >= 400 && (g.bw >= W * 0.18 || g.bh >= H * 0.18));
          }).sort((a, b) => (a.y0 - b.y0) || (b.area - a.area)).slice(0, 64);
          const s0 = strokes.length;
          for (const g of preBg) {
            const panelFill = g.area / Math.max(1, (g.x1 - g.x0 + 1) * (g.y1 - g.y0 + 1));
            paintBlockIn([g.gid], g.x0, g.y0, g.x1, g.y1, 0, {
              minPx: 64, maxHalf: 52 * scaleB, stage: 'preBg',
              fillHoles: 1, fillSpan: panelFill >= 0.24 ? 1 : 0, panelGround: 1,
            });
          }
          // 大块起形是抬腕横扫，不是逐笔描线；让这些笔在时间轴上快速带过，
          // 避免一两个大色面的铺底占掉前 20%，画面却还停在纸白阶段。
          for (let i = s0; i < strokes.length; i++) strokes[i].ms *= 0.02;
          if (preBg.length) await yieldUI();
        }
        // 大形体紧随背景大面落色。太阳、窗玻璃、飞机、花盆、杯身等显著对象
        // 若等到背景细化完才出现，中段会先留下它们的纸白剪影，随后再补色，
        // 回放就像“画出来又消失”。这里仍只按真实像素剪影和通用面积门槛取形，
        // 不补孔洞、不跨组取色；后续对象精修会在同一位置继续画准。
        {
          const preForms = groups.filter((g) => {
            if (g.lineLike || bgSet[g.gid] || g.area < N * 0.004) return false;
            const bw = g.x1 - g.x0 + 1, bh = g.y1 - g.y0 + 1;
            const fill = g.area / Math.max(1, bw * bh);
            return fill >= 0.12 && bw <= W * 0.76 && bh <= H * 0.76;
          }).sort((a, b) => (b.area - a.area) || (a.cy - b.cy)).slice(0, 32);
          const s0 = strokes.length;
          for (const g of preForms) {
            paintBlockIn([g.gid], g.x0, g.y0, g.x1, g.y1, 0, {
              minPx: 64, maxHalf: 44 * scaleB, stage: 'preForm',
              fillHoles: 0, pad: 0,
            });
            handX = g.cx; handY = g.cy;
          }
          for (let i = s0; i < strokes.length; i++) strokes[i].ms *= 0.025;
          if (opts.debug) console.log('[preForm] groups=' + preForms.length +
            ' strokes=' + (strokes.length - s0));
          if (preForms.length) await yieldUI();
        }
        const floodS0 = strokes.length;
        const flood = await paintBgFlood(frameFam);
        // 铺底是手臂快速带过，不是逐笔精修；否则中段会长时间停在单色纸面，
        // 真正的构图和主体要等到回放很后面才出现。
        for (let i = floodS0; i < strokes.length; i++) strokes[i].ms *= 0.03;
        const bgFloodOk = flood.ok;
        painterBgFill = bgFloodOk ? 'once' : 'wash';
        if (flood.ok) {
          handX = flood.x; handY = flood.y;
        } else {
        // 旧 wash：非"蓝底大版面"的平涂图仍走这条路（下面还会按色组细化背景）
        {
          const wm = BGP.washMask, wc = BGP.washColor;
          const brushW = Math.max(22, Math.min(120, Math.min(W, H) / 10));
          const hw = brushW * 0.5;
          const stepY = Math.max(7, brushW * 0.50);
          const yTop = hw * 0.6, yBot = H - hw * 0.6;
          const rows = Math.max(2, Math.round((yBot - yTop) / stepY) + 1);
          const rowStep = (yBot - yTop) / Math.max(1, rows - 1);
          const nPt = Math.max(3, Math.min(16, Math.round(W / 70)));
          const yJit = (srnd(21.7 + runSeed * 0.01, 5.3) - 0.5) * brushW * 0.12;
          for (let r = 0; r < rows; r++) {
            const yy = yTop + rowStep * r;
            const spine = new Float64Array(nPt * 2);
            const halfs = new Float64Array(nPt);
            const dir = (r & 1) ? -1 : 1;
            const wob = (srnd(r * 2.7 + 9.1, 3.3) - 0.5) * 0.55;
            for (let i = 0; i < nPt; i++) {
              const f = i / (nPt - 1);
              const x = dir > 0 ? -hw * 0.5 + (W + hw) * f : W + hw * 0.5 - (W + hw) * f;
              const y = yy + yJit + wob * brushW * 0.45 +
                Math.sin(f * Math.PI * (1 + (r & 1)) + r * 0.9) * brushW * 0.08;
              spine[i * 2] = x; spine[i * 2 + 1] = y;
              halfs[i] = hw * (0.74 + 0.26 * Math.sin(Math.PI * f)) *
                (0.93 + 0.14 * srnd(r * 13.7 + i * 1.9, 4.1));
            }
            emitStroke(spine, halfs, wc, 0, {
              zoneMask: wm, color: wc, minInk: 64, noCover: 1, ms: 1200,
            });
            handX = dir > 0 ? W : 0; handY = yy;
            if ((r & 1) === 0) await yieldUI();
          }
        }
        }
        if (flood.ok) {
          // 版面边缘的扫描毛边/抗锯齿组（不是蓝、也不属于黑框带）：趁"铺满"这一遍
          // 顺手收掉，而不是绕完框再回来点，也不是留到尾声变成上千个小点。
          const edgeG = BGP.bgAll.filter((g) => !frameFam[g.gid] && groupUncov[g.gid] > 0 &&
            Math.max(g.mean[0], g.mean[1], g.mean[2]) < 145);
          const edgeChain = chainNN(edgeG, (g) => [g.cx, g.cy], flood.x, flood.y);
          let edgeN = 0;
          const e0 = strokes.length;
          for (const g of edgeChain) {
            const es0 = strokes.length;
            paintFull(g, 0);
            for (let i = es0; i < strokes.length; i++) strokes[i].edge = 1;
            edgeN++;
            if ((edgeN & 15) === 0) await yieldUI();
          }
          // 收边是快速带过：笔数多但每笔很小，时间轴压到主刷的零头，
          // 不让"铺满"这一遍在边上磨太久
          for (let i = e0; i < strokes.length; i++) strokes[i].ms = 2;
          if (opts.debug) console.log('[flood] edgeGroups=' + edgeN);
        }
        // ---- 遍1c 大形体 block-in：背景落下后，先把占画面显著的完整色面立住 ----
        // 红圆外环、飞机、太阳、窗玻璃等大色组有时不在主背景家族里，若等逐对象
        // 精修，圆形内芯已经出现、外环却还是一圈纸白。这里按面积和“是否有连续
        // 色面”选大组，用真实像素剪影一次铺满；不按颜色、文件名或位置分支。
        // ---- 遍1c 大形体 block-in：背景落下后，先把占画面显著的完整色面立住 ----
        // 红圆外环、飞机、太阳、杯碟等大色组有时不在主背景家族里，若等逐对象
        // 精修，圆形内芯已经出现、外环却还是一圈纸白。这里按面积和“是否有连续
        // 色面”选大组，用真实像素剪影一次铺满；不按颜色、文件名或位置分支。
        {
          // 扫描/抗锯齿会把一个完整圆环拆成多个相邻小色组。先按“像素相邻 +
          // 颜色接近”把非背景组并成大形体，再按联合面积选主块；这样不会因为
          // 某一段圆环单独不足面积门槛，就在过程里留下半圈纸白。
          const par = new Int32Array(G_);
          for (let i = 0; i < G_; i++) par[i] = i;
          const find = (a) => { let r = a; while (par[r] !== r) r = par[r]; return r; };
          const uni = (a, b) => {
            a = find(a); b = find(b);
            if (a === b) return;
            if (a < b) par[b] = a; else par[a] = b;
          };
          const nearFormColor = (a, b) => {
            const A = groups[a], B = groups[b];
            if (!A || !B || A.lineLike || B.lineLike) return false;
            if (bgSet[a] || bgSet[b]) return false;
            return Math.max(Math.abs(A.mean[0] - B.mean[0]),
              Math.abs(A.mean[1] - B.mean[1]),
              Math.abs(A.mean[2] - B.mean[2])) <= 36;
          };
          for (let y = 0; y < H; y++) {
            const row = y * W;
            for (let x = 0; x < W; x++) {
              const p = row + x, a = groupOf[p];
              if (a < 0) continue;
              if (x + 1 < W) {
                const b = groupOf[p + 1];
                if (b >= 0 && nearFormColor(a, b)) uni(a, b);
              }
              if (y + 1 < H) {
                const b = groupOf[p + W];
                if (b >= 0 && nearFormColor(a, b)) uni(a, b);
              }
            }
          }
          const fmap = new Map();
          for (const g of groups) {
            if (bgSet[g.gid] || g.lineLike) continue;
            const r = find(g.gid);
            let f = fmap.get(r);
            if (!f) {
              f = { gids: [], area: 0, x0: W, y0: H, x1: -1, y1: -1 };
              fmap.set(r, f);
            }
            f.gids.push(g.gid); f.area += g.area;
            if (g.x0 < f.x0) f.x0 = g.x0; if (g.x1 > f.x1) f.x1 = g.x1;
            if (g.y0 < f.y0) f.y0 = g.y0; if (g.y1 > f.y1) f.y1 = g.y1;
          }
          // 两层底稿：低填充的大形（圆环、框体、弧带）用封闭孔剪影立住；
          // 中等大小的实体形也先按真实色组粗铺，避免窗内的花叶、器皿等
          // 在背景阶段被周围色面围成一大块刺眼纸白。这里仍逐组取原色、
          // 不填色组内部孔洞，后段的对象描边/填色会重新完成细节。
          const major = [...fmap.values()].map((f) => {
            const bw = f.x1 - f.x0 + 1, bh = f.y1 - f.y0 + 1;
            return { f, fill: f.area / Math.max(1, bw * bh), bw, bh };
          }).filter(({ f, fill, bw, bh }) => {
            const lowDensity = f.area >= N * 0.0035 && fill <= 0.30;
            const solidMass = f.area >= N * 0.0005 && fill >= 0.22 &&
              f.area <= N * 0.09 && bw <= W * 0.42 && bh <= H * 0.42;
            return lowDensity || solidMass;
          }).sort((a, b) => b.f.area - a.f.area).slice(0, 60);
          const s0 = strokes.length;
          for (const { f, fill } of major) {
            paintBlockIn(f.gids, f.x0, f.y0, f.x1, f.y1, 0, {
              minPx: 96, maxHalf: 54 * scaleB, stage: 'major',
              fillHoles: fill <= 0.30 ? 1 : 0, pad: 1,
            });
            handX = (f.x0 + f.x1) * 0.5; handY = (f.y0 + f.y1) * 0.5;
          }
          // 大色面 block-in 是快速铺形，后续仍有精确描边/填充重新完成它。
          for (let i = s0; i < strokes.length; i++) strokes[i].ms *= 0.06;
          if (opts.debug) console.log('[majorin] forms=' + major.length +
            ' px=' + major.reduce((a, f) => a + f.f.area, 0) +
            ' strokes=' + (strokes.length - s0));
          if (major.length) await yieldUI();
        }
        // ---- 遍1b 背景粗铺：先把所有背景组用低分辨率块面铺满 ----
        // 主色 flood 只覆盖一个颜色家族；山体、水面、墙面等次要背景若等逐组精修，
        // 中段会长时间留白。这里用背景均值做一层 noCover 的块面底稿，只负责
        // "先把背景铺完整"，不占覆盖账、也不影响后续逐组真实取色。
        {
          const bm = new Uint8Array(N);
          const draftG = new Uint8Array(G_);
          const bandOk = (g) => {
            const long = Math.max(g.bw, g.bh), short = Math.min(g.bw, g.bh);
            return g.area >= N * 0.00015 && long >= Math.min(W, H) * 0.08 &&
              short <= Math.max(W, H) * 0.045 && long >= short * 3.2;
          };
          for (const g of groups) {
            const fill = g.area / Math.max(1, g.bw * g.bh);
            const band = bandOk(g);
            // 粗铺不只服务 bgSet：太阳内芯、窗玻璃、花盆、水面倒影这类
            // 大面积完整色面也必须在起稿时先立住。它们仍按本组真实掩膜
            // 裁剪，不会把相邻对象一起刷掉；后段逐对象精修会重新画准。
            // 重复的横向/纵向厚带（水面反光、窗台、舞台分界）会被分色器
            // 切成许多细组；只按“大色面”筛选会把它们留成贯穿构图的白洞。
            // 用可测量的长宽/厚度条件把整条厚带纳入粗铺，仍只涂本组真实像素。
            // lineLike 既可能是细笔画，也可能是被分色器标成细长的真实色带。
            // 后者若一并跳过，水面倒影/桌沿会在对象阶段到来前留下纯白横条。
            if (g.lineLike && !band) continue;
            if (bgSet[g.gid] || (g.area >= N * 0.006 && fill >= 0.30) || band) draftG[g.gid] = 1;
          }
          let bn = 0;
          for (let p = 0; p < N; p++) {
            const gid = groupOf[p];
            // 只给真正的背景组打底。把"所有小组"也包进来会让 s5 在刚起笔时
            // 先冒出一条红色/黄色的前景横带，看起来像误刷而不是铺底。
            if (gid >= 0 && !segPaper[p] && !paintN[p] && draftG[gid]) { bm[p] = 1; bn++; }
          }
          if (bn > N * 0.03) {
            const tile = Math.max(28, Math.min(56, Math.round(Math.min(W, H) * 0.045)));
            const stepX = Math.max(36, Math.round(tile * 1.55));
            const brushH = tile * 0.72;
            let underN = 0;
            for (let y = 0; y < H; y += tile) {
              const y0 = y, y1 = Math.min(H - 1, y + tile - 1);
              const yc = (y0 + y1) * 0.5;
              for (let x = 0; x < W; x += stepX) {
                const x0 = x, x1 = Math.min(W - 1, x + stepX - 1);
                // 先找这一块里占主导的背景色组。取局部均值会把窗玻璃、墙面、
                // 水面和前景混成一块灰绿/灰蓝色，回放中段看起来像马赛克；同一
                // 色组始终使用组均值，并把笔裁在该组自己的像素内，颜色才连续。
                const cnt = new Map();
                let tot = 0;
                for (let yy = y0; yy <= y1; yy += 2) {
                  const row = yy * W;
                  for (let xx = x0; xx <= x1; xx += 2) {
                    const p = row + xx;
                    if (segPaper[p]) continue;
                    tot++;
                    if (!bm[p]) continue;
                    const gid = groupOf[p];
                    if (gid >= 0) cnt.set(gid, (cnt.get(gid) || 0) + 1);
                  }
                }
                // 一个小格里常同时落着墙面、窗玻璃、桌沿三种颜色。只刷
                // 占比最高的那一种会把其余背景一直留成纸白；把格内显著的
                // 前三组各刷一笔，仍用各自掩膜裁剪，起稿阶段就能接近完整。
                const picks = [...cnt].filter(([, n]) => n >= 8 && n / Math.max(1, tot) >= 0.06)
                  .sort((a, b) => b[1] - a[1]).slice(0, 3);
                // 同一格里背景占明显多数时，先把仍为纸白的空隙压成这张
                // 背景区的真实主色，再让具体色组盖回去。否则水面反光、窗棂
                // 等细碎前景会把大背景切成大量白缝，回放中段像漏画。
                let bgPick = null, bgHit = 0;
                for (const [gid, n] of cnt) {
                  if (!bgSet[gid]) continue;
                  bgHit += n;
                  if (!bgPick || n > bgPick[1]) bgPick = [gid, n];
                }
                if (bgPick && bgHit >= tot * 0.32) {
                  const tw = x1 - x0 + 1, th = y1 - y0 + 1;
                  const pm = new Uint8Array(tw * th);
                  let pmn = 0;
                  for (let yy = y0; yy <= y1; yy++) {
                    const row = yy * W, mr = (yy - y0) * tw;
                    for (let xx = x0; xx <= x1; xx++) {
                      const p = row + xx, q = p * 3;
                      if (segPaper[p]) continue;
                      if (canvas[q] > 247 && canvas[q + 1] > 247 && canvas[q + 2] > 247) {
                        pm[mr + xx - x0] = 1; pmn++;
                      }
                    }
                  }
                  if (pmn >= 12) {
                    const tg = groups[bgPick[0]];
                    const sp = new Float64Array([x0 - brushH * 0.2, yc, x1 + brushH * 0.2, yc]);
                    const halfs = new Float64Array([brushH * 0.58, brushH * 0.58]);
                    emitStroke(sp, halfs, tg.mean, 0, {
                      pen: 0, zoneMaskRect: { m: pm, x0, y0, w: tw, h: th },
                      noCover: 1, noZone: 1, minInk: 1, ms: 0.08 + (x1 - x0) * 0.0008,
                    });
                  }
                }
                for (const [bestGid] of picks) {
                  const tg = groups[bestGid];
                  const tw = x1 - x0 + 1, th = y1 - y0 + 1;
                  const tm = new Uint8Array(tw * th);
                  let mn = 0;
                  for (let yy = y0; yy <= y1; yy++) {
                    const row = yy * W, mr = (yy - y0) * tw;
                    for (let xx = x0; xx <= x1; xx++) {
                      const p = row + xx;
                      if (!bm[p] || groupOf[p] !== bestGid) continue;
                      tm[mr + xx - x0] = 1; mn++;
                    }
                  }
                  if (mn < 12) continue;
                  const nP = 4;
                  const sp = new Float64Array(nP * 2), halfs = new Float64Array(nP);
                  const left = x0 - brushH * 0.55, right = x1 + brushH * 0.55;
                  const bow = (srnd(x0 * 0.17 + y0 * 0.11 + bestGid * 0.07, 8.6) - 0.5) * brushH * 0.24;
                  for (let k = 0; k < nP; k++) {
                    const f = k / (nP - 1);
                    sp[k * 2] = left + (right - left) * f;
                    sp[k * 2 + 1] = yc + bow * Math.sin(Math.PI * f);
                    halfs[k] = brushH * (0.94 + 0.08 * srnd(x0 + y0 * 0.37 + bestGid + k * 1.7, 3.9));
                  }
                  const si = emitStroke(sp, halfs, tg.mean, 0, {
                    pen: 0, zoneMaskRect: { m: tm, x0, y0, w: tw, h: th },
                    noCover: 1, minInk: 1,
                    ms: 0.08 + (x1 - x0) * 0.001,
                  });
                  if (si >= 0) { strokes[si].fl = 1; underN++; }
                }
              }
              if ((y / tile) % 4 === 0) await yieldUI();
            }
            // 背景内部允许补的只是同一色组之间的窄缝（窗棂/反光/文字边），
            // 不再把整行首尾之间的前景连同背景一起刷掉。这样猫脸、花、杯子
            // 不会被背景色块提前盖住，水面和窗玻璃的小白缝仍能连续。
            const holeGroups = groups.filter((g) => bgSet[g.gid] && !g.lineLike && g.area >= N * 0.02)
              .sort((a, b) => b.area - a.area);
            let holeStrokes = 0;
            for (const g of holeGroups) {
              const bw = g.bw, bh = g.bh;
              const hm = new Uint8Array(bw * bh);
              let markN = 0;
              const maxGap = Math.max(18, Math.min(72 * scaleB, bh * 0.30));
              for (let y = g.y0; y <= g.y1; y++) {
                let prev = -1;
                const mr = (y - g.y0) * bw;
                for (let x = g.x0; x <= g.x1; x++) {
                  const p = y * W + x;
                  if (groupOf[p] !== g.gid || !bm[p]) continue;
                  if (prev >= 0) {
                    const gap = x - prev - 1;
                    if (gap > 0 && gap <= maxGap) {
                      for (let xx = prev + 1; xx < x; xx++) {
                        const q = y * W + xx;
                        if (segPaper[q] || paintN[q] || covered[q]) continue;
                        const qg = groupOf[q];
                        // 大块前景不属于背景缝隙；只让扫描噪点/抗锯齿/无主像素被带过。
                        if (qg >= 0 && !bgSet[qg] && groups[qg] && groups[qg].area >= N * 0.0004) continue;
                        hm[mr + xx - g.x0] = 1; markN++;
                      }
                    }
                  }
                  prev = x;
                }
              }
              if (markN < Math.max(64, g.area * 0.02)) continue;
              const halfH = Math.max(5, Math.min(46 * scaleB, bh * 0.16));
              const k = Math.max(1, Math.ceil(bh / (halfH * 1.12)));
              for (let i = 0; i < k; i++) {
                const yc = g.y0 + bh * (i + 0.5) / k;
                const sp = new Float64Array([g.x0 - 2, yc, g.x1 + 2, yc]);
                const halfs = new Float64Array([halfH, halfH]);
                const si = emitStroke(sp, halfs, g.mean, 0, {
                  pen: 0, zoneMaskRect: { m: hm, x0: g.x0, y0: g.y0, w: bw, h: bh },
                  noCover: 1, minInk: 1, ms: 0.12,
                });
                if (si >= 0) { strokes[si].fl = 1; holeStrokes++; }
              }
              if ((holeStrokes & 31) === 0) await yieldUI();
            }
            if (opts.debug) console.log('[underlay] bgPx=' + bn + ' tile=' + tile +
              ' strokes=' + underN + ' hole=' + holeStrokes);
          }
        }
        // ---- 遍2a 结构：整圈边框一口气走完（蓝底铺好后立刻勾框，不掺别的）----
        {
          let ringN = 0;
          for (const g of BGP.bgAll.slice().sort((a, b) => b.area - a.area)) {
            // 画家路径的笔按像素覆盖发（emitPlan 以 ph=0 落笔，本来就不受 hardCap
            // 约束）；这里再按 hardCap 截断会让"铺满+收边"一多就永远画不到框。
            // 画框只认真正的框：比主背景明显更深，或色差很大。背景渐变
            // 一圈圈色带也满足 ringPlan 的"大 + 薄 + 绕画幅"几何门槛，
            // 但它们不是框——插画里这一误判会把粉圆重描两千多笔。
            const gc = g.mean;
            const gLum = 0.299 * gc[0] + 0.587 * gc[1] + 0.114 * gc[2];
            const wc0 = BGP.washColor;
            const wLum = 0.299 * wc0[0] + 0.587 * wc0[1] + 0.114 * wc0[2];
            const dr0 = gc[0] - wc0[0], dg0 = gc[1] - wc0[1], db0 = gc[2] - wc0[2];
            if (dr0 * dr0 + dg0 * dg0 + db0 * db0 < 90 * 90 &&
              Math.abs(gLum - wLum) < 55) continue;
            const plan = (g === frameCand) ? framePlan : ringPlan(g);
            if (!plan) continue;
            const n = paintRing(g, 1, plan);
            if (!n) continue;
            ringDone.add(g.gid);
            for (const gid of plan.gids) ringDone.add(gid);
            ringN++;
            if (opts.debug) console.log('[ring] gid=' + g.gid + ' area=' + g.area +
              ' w=' + plan.wEst.toFixed(1) + ' skel=' + plan.path.len + ' strokes=' + n);
          }
          if (opts.debug) console.log('[ring] total=' + ringN);
          if (ringN) await yieldUI();
        }
        // ---- 遍2 细化背景 ----
        // 一趟铺满只用了主色均值；颜色明显偏离铺底色的背景组（白纸阴影/暗角/
        // 蓝色斑纹）再按原色补准。没铺满（渐变/碎色底）时仍逐组补准。
        {
          const wc0 = BGP.washColor;
          const bgChain = chainChunks(BGP.bgAll.filter((g) =>
            !ringDone.has(g.gid) && groupUncov[g.gid] > 0), handX, handY, 24);
          let bgDone = 0;
          for (const g of bgChain) {
            const bs = strokes.length;
            paintFull(g, 1);
            // 背景补准是铺完底色后的顺手收拾，不是主体刻画。压缩这些小笔
            // 的相对时长，让大背板和主体不要等到回放过半才出现。
            for (let i = bs; i < strokes.length; i++) strokes[i].ms *= 0.24;
            handX = g.cx; handY = g.cy;
            if (((bgDone++) & 15) === 0) {
              prog(0.70 + 0.16 * bgDone / Math.max(1, bgChain.length), '细化背景：整片刷准…');
              await yieldUI();
            }
          }
        }
        }
        // ---- 遍3 画主体：一个对象一个对象完成（描边 → 填满 → 细部）----
        // 人画海报是"一个字/一架飞机画完再下一个"：先把这一圈的描边一口气描完，
        // 再把里面一次涂满，最后补细部。旧实现是"全部描边 → 全部填色"，而且描边
        // 按色块碎组逐块发笔：一个 f 的红边被切成上千笔、一直拖到片尾才补完，
        // 回放里就是"字一直没描完、填色东一块西一块"。
        // 这里按**像素 4 邻接**把前景并成对象：同一个字的描边和字心天然相连，
        // 字与字之间隔着蓝底，各自成块。每个对象内部：整圈描边一笔走完 → 字心
        // 整块填满 → 其余色块/碎点收尾。
        const mx3 = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
        const pobjs = (() => {
          const fg = new Uint8Array(G_);
          for (const g of groups) {
            if (bgSet[g.gid] || ringDone.has(g.gid) || frameFam[g.gid]) continue;
            if (g.area < 8) continue;              // 极小碎点留给收笔遍
            fg[g.gid] = 1;
          }
          // 只用"实色填充块"做对象骨架。细线是连通的网络，若也参与并查集，
          // 窗框会把窗玻璃、花盆、书和桌面全部串成一个巨型对象，回放就会
          // 整幅东补一笔西补一笔。颜色相近且相邻的填充块先归属同一对象；
          // 轮廓线随后只挂到真正相邻的填充对象上，不再作为跨对象桥梁。
          const par = new Int32Array(G_).fill(-1);
          const find = (i) => {
            let r0 = i;
            while (par[r0] >= 0) r0 = par[r0];
            while (i !== r0) { const nx = par[i]; par[i] = r0; i = nx; }
            return r0;
          };
          const uni = (a, b) => {
            a = find(a); b = find(b);
            if (a === b) return;
            if (par[a] > par[b]) { const t = a; a = b; b = t; }
            par[a] += par[b]; par[b] = a;
          };
          const closeFill = (a, b) => {
            const A = groups[a], B = groups[b];
            if (!A || !B || A.lineLike || B.lineLike) return false;
            return Math.max(Math.abs(A.mean[0] - B.mean[0]),
              Math.abs(A.mean[1] - B.mean[1]),
              Math.abs(A.mean[2] - B.mean[2])) <= 38;
          };
          for (let y = 0; y < H; y++) {
            const row = y * W;
            for (let x = 0; x < W; x++) {
              const p = row + x, a = groupOf[p];
              if (a < 0 || !fg[a] || groups[a].lineLike) continue;
              if (x + 1 < W) {
                const b = groupOf[p + 1];
                if (b >= 0 && b !== a && fg[b] && closeFill(a, b)) uni(a, b);
              }
              if (y + 1 < H) {
                const b = groupOf[p + W];
                if (b >= 0 && b !== a && fg[b] && closeFill(a, b)) uni(a, b);
              }
            }
          }
          const cmap = new Map();
          const addToObj = (o, g) => {
            o.gids.push(g.gid); o.gs.push(g); o.area += g.area;
            if (g.x0 < o.x0) o.x0 = g.x0; if (g.y0 < o.y0) o.y0 = g.y0;
            if (g.x1 > o.x1) o.x1 = g.x1; if (g.y1 > o.y1) o.y1 = g.y1;
          };
          for (let gid = 0; gid < G_; gid++) {
            if (!fg[gid] || groups[gid].lineLike) continue;
            const rt = find(gid);
            let o = cmap.get(rt);
            if (!o) { o = { gids: [], gs: [], area: 0, x0: W, y0: H, x1: -1, y1: -1 }; cmap.set(rt, o); }
            addToObj(o, groups[gid]);
          }
          // 每条线统计它与哪些填充对象直接相邻；取邻接像素最多的那个作为归属。
          // 没有直接邻接时按 bbox 距离找最近对象，避免孤立轮廓落到片尾。
          const roots = [...cmap.keys()];
          const rootObj = new Map(roots.map((r) => [r, cmap.get(r)]));
          const looseLines = [];
          for (let gid = 0; gid < G_; gid++) {
            if (!fg[gid] || !groups[gid].lineLike) continue;
            const g = groups[gid], votes = new Map();
            for (let y = g.y0; y <= g.y1; y++) {
              const row = y * W;
              for (let x = g.x0; x <= g.x1; x++) {
                const p = row + x;
                if (groupOf[p] !== gid) continue;
                const hit = (q) => {
                  const ng = groupOf[q];
                  if (ng < 0 || ng === gid || !fg[ng] || groups[ng].lineLike) return;
                  const rt = find(ng);
                  if (rootObj.has(rt)) votes.set(rt, (votes.get(rt) || 0) + 1);
                };
                if (x > 0) hit(p - 1);
                if (x + 1 < W) hit(p + 1);
                if (y > 0) hit(p - W);
                if (y + 1 < H) hit(p + W);
              }
            }
            let bestRoot = -1, bestVote = 0;
            for (const [rt, v] of votes) if (v > bestVote) { bestVote = v; bestRoot = rt; }
            if (bestRoot >= 0) addToObj(rootObj.get(bestRoot), g);
            else looseLines.push(g);
          }
          // 没有填充对象的纯线稿仍按线-线邻接合成对象，保持可绘制。
          if (looseLines.length) {
            const lp = new Int32Array(G_).fill(-1);
            const lf = (i) => { let r0 = i; while (lp[r0] >= 0) r0 = lp[r0]; return r0; };
            const lu = (a, b) => { a = lf(a); b = lf(b); if (a === b) return; if (lp[a] > lp[b]) { const t = a; a = b; b = t; } lp[a] += lp[b]; lp[b] = a; };
            // 线簇的几何与面积也参与并查集。只按“相邻且同色”会让扫描件的
            // 外框、抗锯齿边和纸纹通过一个接一个的近距离关系串成横跨整页
            // 的巨型对象；之后它会在主体阶段反复东补一笔西补一笔。
            const lbb = new Map(looseLines.map((g) => [g.gid, {
              x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1, area: g.area,
            }]));
            const maxLineW = W * 0.38, maxLineH = H * 0.24, maxLineA = N * 0.025;
            // 普通邻接仍限制簇的跨度，防止一条扫描抗锯齿边把整页无关线
            // 串成一个对象；但共线长线段是另一种结构：一张海报的框边、
            // 窗框、分隔线会被量化/抗锯齿切成许多 1~4px 的小段，段间常有
            // 几十像素空洞。只按 bbox 距离会把它们留成上百个对象，回放时
            // 就从主体画到片尾一直在补边。下面单独给“同一线槽内的长线段”
            // 一个较大的闭合上限，再由颜色和轴向严格约束。
            const lineUnionOk = (a, b, cap) => {
              const A = lbb.get(lf(a)), B = lbb.get(lf(b));
              if (!A || !B) return false;
              const lim = cap || { w: maxLineW, h: maxLineH, a: maxLineA };
              const x0 = Math.min(A.x0, B.x0), y0 = Math.min(A.y0, B.y0);
              const x1 = Math.max(A.x1, B.x1), y1 = Math.max(A.y1, B.y1);
              return x1 - x0 + 1 <= lim.w && y1 - y0 + 1 <= lim.h &&
                A.area + B.area <= lim.a;
            };
            const unionLine = (a, b, cap) => {
              const ra = lf(a), rb = lf(b);
              if (ra === rb || !lineUnionOk(a, b, cap)) return false;
              const A = lbb.get(ra), B = lbb.get(rb);
              lu(ra, rb);
              const root = lf(ra);
              lbb.set(root, {
                x0: Math.min(A.x0, B.x0), y0: Math.min(A.y0, B.y0),
                x1: Math.max(A.x1, B.x1), y1: Math.max(A.y1, B.y1),
                area: A.area + B.area,
              });
              return true;
            };
            const luBounded = (a, b) => unionLine(a, b);
            const laneCap = { w: W * 0.98, h: H * 0.98, a: N * 0.09 };
            const luLane = (a, b) => unionLine(a, b, laneCap);
            // 无主细线不再跨整页做像素连通：扫描件里边框、标题和装饰线
            // 常通过 1px 抗锯齿边缘串在一起。只合并真正贴近且同色的线段，
            // 行级文字交给后面的“同一行”合并，避免整页细线变回一个对象。
            const lineGap = Math.max(2, Math.min(W, H) * 0.006);
            for (let i = 0; i < looseLines.length; i++) {
              const A = looseLines[i];
              const aw = A.x1 - A.x0 + 1, ah = A.y1 - A.y0 + 1;
              for (let j = i + 1; j < looseLines.length; j++) {
                const B = looseLines[j];
                const dx = Math.max(0, Math.max(A.x0 - B.x1, B.x0 - A.x1));
                const dy = Math.max(0, Math.max(A.y0 - B.y1, B.y0 - A.y1));
                const near = Math.hypot(dx, dy) <= lineGap;
                const bwv = B.x1 - B.x0 + 1, bhv = B.y1 - B.y0 + 1;
                const thin = Math.max(2, Math.min(W, H) * 0.012);
                // 水平线槽：两条都薄、中心线几乎重合，且至少一条是长线。
                // 间隔上限按画布宽度给，专门接回被文字/抗锯齿打断的框边。
                const hLane = ah <= Math.max(10, thin) && bhv <= Math.max(10, thin) &&
                  Math.abs((A.y0 + A.y1) - (B.y0 + B.y1)) <= Math.max(8, thin * 2) &&
                  dx <= Math.max(lineGap, W * 0.14) &&
                  Math.max(aw, bwv) >= W * 0.06;
                // 垂直线槽同理；允许框线因扫描抖动横向偏几像素。
                const vLane = aw <= Math.max(10, thin) && bwv <= Math.max(10, thin) &&
                  Math.abs((A.x0 + A.x1) - (B.x0 + B.x1)) <= Math.max(8, thin * 2) &&
                  dy <= Math.max(lineGap, H * 0.14) &&
                  Math.max(ah, bhv) >= H * 0.06;
                if (!near && !hLane && !vLane) continue;
                if (mx3(A.mean, B.mean) > (hLane || vLane ? 42 : 32)) continue;
                if (hLane || vLane) luLane(A.gid, B.gid);
                else luBounded(A.gid, B.gid);
              }
            }
            const lmap = new Map();
            for (const g of looseLines) {
              const rt = lf(g.gid);
              let o = lmap.get(rt);
              if (!o) { o = { gids: [], gs: [], area: 0, x0: W, y0: H, x1: -1, y1: -1 }; lmap.set(rt, o); }
              addToObj(o, g);
            }
            for (const o of lmap.values()) cmap.set(100000 + roots.length + cmap.size, o);
          }
          let out = [...cmap.values()];
          for (const o of out) {
            o.cx = (o.x0 + o.x1) * 0.5; o.cy = (o.y0 + o.y1) * 0.5;
            o.gs.sort((a, b) => b.area - a.area);
          }
          if (opts.debug) {
            for (const o of out.slice().sort((a,b)=>b.area-a.area).slice(0,4)) {
              const qc = new Map(); let lineN=0, fillN=0;
              for (const g of o.gs) { if(g.lineLike) lineN+=g.area; else fillN+=g.area; const k=g.mean.map(v=>Math.round(v/32)*32).join(','); qc.set(k,(qc.get(k)||0)+g.area); }
              console.log('[objdetail] area='+o.area+' g='+o.gs.length+' line='+lineN+' fill='+fillN+' colors='+[...qc.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8).map(([k,v])=>k+':'+v).join('|'));
            }
          }
          if (opts.debug) {
            const oo = out.slice().sort((a,b)=>b.area-a.area)[0];
            console.log('[objgroups] ' + oo.gs.slice().sort((a,b)=>b.area-a.area).slice(0,30).map((g)=>g.gid+':'+g.area+'@['+g.x0+','+g.y0+','+g.x1+','+g.y1+']/'+g.mean.map(Math.round).join(',')+(g.lineLike?'L':'F')).join(' '));
          }
          if (opts.debug) console.log('[objpre] n=' + out.length + ' top=' + out.slice().sort((a,b)=>b.area-a.area).slice(0,12).map((o)=>o.area+'@'+o.gids.length+':['+o.x0+','+o.y0+','+o.x1+','+o.y1+']').join(' '));
          // 文字行、窗格等“同一横排、同色、近邻”的块合成一个对象。否则
          // 一个标题会在几十秒里只出现几个字母，下一行又穿插进来，像机器
          // 按面积逐块扫描；合并后是一行写完再写下一行。
          {
            const n0 = out.length;
            const par2 = new Int32Array(n0).fill(-1);
            const find2 = (i) => { let r = i; while (par2[r] >= 0) r = par2[r]; return r; };
            const uni2 = (a, b) => {
              a = find2(a); b = find2(b); if (a === b) return;
              if (par2[a] > par2[b]) { const t = a; a = b; b = t; }
              par2[a] += par2[b]; par2[b] = a;
            };
            const mean2 = (o) => {
              let sr = 0, sg = 0, sb = 0, n = 0;
              for (const g of o.gs) {
                if (g.lineLike) continue;
                sr += g.mean[0] * g.area; sg += g.mean[1] * g.area; sb += g.mean[2] * g.area;
                n += g.area;
              }
              if (!n) for (const g of o.gs) {
                sr += g.mean[0] * g.area; sg += g.mean[1] * g.area; sb += g.mean[2] * g.area;
                n += g.area;
              }
              return n ? [sr / n, sg / n, sb / n] : [0, 0, 0];
            };
            const cm = out.map(mean2);
            const info = out.map((o) => {
              const w = o.x1 - o.x0 + 1, h = o.y1 - o.y0 + 1;
              let lineA = 0;
              for (const g of o.gs) if (g.lineLike) lineA += g.area;
              return { w, h, lineShare: lineA / Math.max(1, o.area) };
            });
            for (let i = 0; i < n0; i++) {
              const A = out[i], a = info[i];
              // 只允许“单个字/词”级别的横向小块参与行合并。整页边框、
              // 大面积色板、跨越半幅的装饰线一旦参与，近邻关系会把它们
              // 和所有文字串成一个巨型对象，回放又退化成全图扫块。
              const aLeaf = a.w <= W * 0.32 && a.h <= H * 0.15 && A.area <= N * 0.09;
              if (!aLeaf) continue;
              for (let j = i + 1; j < n0; j++) {
                const B = out[j], b = info[j];
                const bLeaf = b.w <= W * 0.32 && b.h <= H * 0.15 && B.area <= N * 0.09;
                if (!bLeaf) continue;
                const minH = Math.min(a.h, b.h), maxH = Math.max(a.h, b.h);
                const yov = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0) + 1;
                const gapX = Math.max(0, Math.max(A.x0 - B.x1, B.x0 - A.x1));
                const rowBand = yov >= minH * 0.55 && Math.abs(A.cy - B.cy) <= maxH * 0.42;
                const near = gapX <= Math.max(8, Math.min(W * 0.04, minH * 2.8));
                const heightOk = maxH <= minH * 2.2 && Math.max(a.h, b.h) <= H * 0.16 &&
                  Math.max(a.w, b.w) + gapX <= W * 0.92;
                const areaOk = Math.max(A.area, B.area) <= Math.max(24, Math.min(A.area, B.area) * 12);
                const dc = Math.max(Math.abs(cm[i][0] - cm[j][0]), Math.abs(cm[i][1] - cm[j][1]),
                  Math.abs(cm[i][2] - cm[j][2]));
                if (rowBand && near && heightOk && areaOk && dc <= 38) uni2(i, j);
              }
            }
            const mmap = new Map();
            for (let i = 0; i < n0; i++) {
              const r = find2(i);
              let o = mmap.get(r);
              if (!o) { o = { gids: [], gs: [], area: 0, x0: W, y0: H, x1: -1, y1: -1 }; mmap.set(r, o); }
              for (const g of out[i].gs) addToObj(o, g);
            }
            out = [...mmap.values()];
            if (opts.debug) console.log('[objrow] n=' + out.length + ' top=' + out.slice().sort((a,b)=>b.area-a.area).slice(0,12).map((o)=>o.area+'@'+o.gids.length+':['+o.x0+','+o.y0+','+o.x1+','+o.y1+']').join(' '));
            for (const o of out) {
              o.cx = (o.x0 + o.x1) * 0.5; o.cy = (o.y0 + o.y1) * 0.5;
              o.gs.sort((a, b) => b.area - a.area);
            }
          }
          // 页面外框常由深/中/浅多圈细线组成，量化后又会沿边断成许多对象。
          // 它们颜色未必相同，不能靠“同色线段”完全合并；但几何上都贴着
          // 画幅外缘、细而长。这里把这些对象合为一个框族，保证起稿阶段
          // 一次把外框关系定住，不让右/下边零碎拖到片尾。
          {
            const margin = Math.max(4, Math.min(W, H) * 0.08);
            const edgeObjs = [];
            for (const o of out) {
              const ew = o.x1 - o.x0 + 1, eh = o.y1 - o.y0 + 1;
              const nearEdge = o.x0 <= margin || o.y0 <= margin ||
                o.x1 >= W - 1 - margin || o.y1 >= H - 1 - margin;
              if (!nearEdge) continue;
              let la = 0;
              for (const g of o.gs) if (g.lineLike) la += g.area;
              const ls = la / Math.max(1, o.area);
              const thinLong = (ew >= W * 0.15 && eh <= H * 0.09) ||
                (eh >= H * 0.15 && ew <= W * 0.09);
              const perimeter = (ew >= W * 0.55 || eh >= H * 0.55) && ls >= 0.45;
              const edgeLine = ls >= 0.72 && Math.min(ew, eh) <= Math.max(8, margin * 0.35);
              if (thinLong || perimeter || edgeLine) edgeObjs.push(o);
            }
            let fx0 = W, fy0 = H, fx1 = -1, fy1 = -1;
            for (const o of edgeObjs) {
              if (o.x0 < fx0) fx0 = o.x0; if (o.y0 < fy0) fy0 = o.y0;
              if (o.x1 > fx1) fx1 = o.x1; if (o.y1 > fy1) fy1 = o.y1;
            }
            if (edgeObjs.length >= 3 && fx1 - fx0 + 1 >= W * 0.55 && fy1 - fy0 + 1 >= H * 0.55) {
              const mergeset = new Set(edgeObjs);
              const frame = { gids: [], gs: [], area: 0, x0: W, y0: H, x1: -1, y1: -1, frameComplex: 1 };
              for (const o of edgeObjs) {
                frame.gids.push(...o.gids); frame.gs.push(...o.gs); frame.area += o.area;
                if (o.x0 < frame.x0) frame.x0 = o.x0; if (o.y0 < frame.y0) frame.y0 = o.y0;
                if (o.x1 > frame.x1) frame.x1 = o.x1; if (o.y1 > frame.y1) frame.y1 = o.y1;
              }
              out = out.filter((o) => !mergeset.has(o));
              out.push(frame);
              if (opts.debug) console.log('[framecomplex] parts=' + edgeObjs.length +
                ' groups=' + frame.gs.length + ' area=' + frame.area +
                ' bbox=[' + frame.x0 + ',' + frame.y0 + ',' + frame.x1 + ',' + frame.y1 + ']');
            }
          }
          // 大块、高填充率的色板是构图背板（例如海报里占大半幅的蓝色版面），
          // 即使不是主色家族，也必须先铺，再在其上画飞机/圆/文字。否则会先画出
          // 一个悬空主体、几十秒后才补背景，过程不像人。其余对象按阅读顺序。
          const objectTier = (o) => {
            const bw = o.x1 - o.x0 + 1, bh = o.y1 - o.y0 + 1;
            const fill = o.area / Math.max(1, bw * bh);
            let sw = 0, ss = 0;
            for (const g of o.gs) {
              if (g.lineLike) continue;
              sw += g.area; ss += g.sal * g.area;
            }
            const objSal = sw ? ss / sw : 1;
            let lineArea = 0;
            for (const g of o.gs) if (g.lineLike) lineArea += g.area;
            const lineShare = lineArea / Math.max(1, o.area);
            o.backdrop = (o.area >= N * 0.12 && bw * bh >= N * 0.10 &&
              fill >= 0.50 && objSal <= 0.40) ? 1 : 0;
            if (o.backdrop) return 0;
            // 容器/框：跨度大、整体空、由细边和大片镂空组成。人画这类
            // 结构会先起框把画面关系定住，再画框里的飞机、字、器皿；
            // 不能等主体画完才回头把框边一段段补到 80%。这里只看几何，
            // 不依赖任何具体颜色、文件名或样张形状。
            const containerLike = bw >= W * 0.22 && bh >= H * 0.22 &&
              bw * bh >= N * 0.18 && fill <= 0.38 && lineShare >= 0.28;
            o.container = containerLike ? 1 : 0;
            if (containerLike) return 1;
            // 大面积、成片的前景层（山体、水面、主体底座）先铺；鸟/云纹/反光
            // 这类小对象后画，避免中途出现"细节先出现、大片还没铺"的白洞。
            // 不能只看包围盒填充率：圆底板、杯身等对象常由多块同色面
            // 和内部镂空组成，fill 会偏低，但它们仍然是应在文字/细节之前完成的
            // 大形体。面积足够大且确实有连续色面时先画。
            // 背景/框已先立住，余下内容按页面的阅读顺序从上到下完成。
            if (o.area >= N * 0.018 && fill >= 0.10) return 2;
            if (o.area >= N * 0.002) return 3;
            return 4;
          };
          out.sort((a, b) => (objectTier(a) - objectTier(b)) ||
            (Math.round(a.cy / (H * 0.06)) - Math.round(b.cy / (H * 0.06))) ||
            (a.cx - b.cx));
          // 大主体先立住后，人体会顺手把它内部的把手、蒸汽、五官等局部
          // 一次补完，而不是先跳到画面下方写标题、很久后再回来。这里用
          // 通用几何关系：面积足够大的非整页对象是宿主，完全落在其包围盒内
          // 的小对象随宿主一起完成。整页背板/边框不参与，否则会把全图吞掉。
          {
            const hostOk = (o) => {
              if (o.frameComplex) return false;
              const bw = o.x1 - o.x0 + 1, bh = o.y1 - o.y0 + 1;
              const box = bw * bh;
              // 宿主必须本身是有厚度的实体块，不能是稀疏窗框/外框的
              // 包围盒。否则窗框会把框内所有花、物体都吸进同一对象，
              // 花盆等真正主体反而被排到很晚，留下大块纸白。
              if (box < N * 0.055 || box > N * 0.58 ||
                  bw < W * 0.16 || bh < H * 0.16) return false;
              if (o.area / Math.max(1, box) < 0.22) return false;
              let lineArea = 0;
              for (const g of o.gs) if (g.lineLike) lineArea += g.area;
              return lineArea / Math.max(1, o.area) < 0.55;
            };
            const childOk = (host, child) => {
              if (child === host || child.frameComplex) return false;
              const hbw = host.x1 - host.x0 + 1, hbh = host.y1 - host.y0 + 1;
              const cbw = child.x1 - child.x0 + 1, cbh = child.y1 - child.y0 + 1;
              const cab = cbw * cbh;
              if (cab > hbw * hbh * 0.55) return false;
              if (child.cx < host.x0 || child.cx > host.x1 ||
                  child.cy < host.y0 || child.cy > host.y1) return false;
              const ix = Math.max(0, Math.min(host.x1, child.x1) - Math.max(host.x0, child.x0) + 1);
              const iy = Math.max(0, Math.min(host.y1, child.y1) - Math.max(host.y0, child.y0) + 1);
              // 中心落在宿主内、且大部分面积也落在宿主内：既包括把手/蒸汽/
              // 五官这种完全内嵌细节，也包括飞机压在圆盘上的局部重叠。
              return ix * iy >= cab * 0.55;
            };
            const nObj = out.length;
            const par2 = new Int32Array(nObj).fill(-1);
            const find2 = (i) => { let r = i; while (par2[r] >= 0) r = par2[r]; return r; };
            const uni2 = (a, b) => {
              a = find2(a); b = find2(b); if (a === b) return;
              if (par2[a] > par2[b]) { const t = a; a = b; b = t; }
              par2[a] += par2[b]; par2[b] = a;
            };
            const hostIdx = [];
            for (let i = 0; i < nObj; i++) if (hostOk(out[i])) hostIdx.push(i);
            for (const hi of hostIdx) {
              for (let j = 0; j < nObj; j++) {
                if (hi !== j && childOk(out[hi], out[j])) uni2(hi, j);
              }
            }
            // 除了“内部细节随宿主”，还有一类关系是上下相接的承托物：
            // 花盆与花束、杯碟与杯子、底座与上方主体。它们不满足包含关系，
            // 但若分别排期，会出现植物已经画完、花盆仍是一块纸白，很久后
            // 才补容器的拼贴感。只合并两侧都有实际面积的近邻对象，文字行
            // 的细碎小块不参与，避免又把整段标题串成一个巨型对象。
            const supportFloor = N * 0.004;
            const supportGap = Math.max(10, Math.min(34, Math.min(W, H) * 0.035));
            const supportPair = (a, b) => {
              if (a.area < supportFloor || b.area < supportFloor) return false;
              if (a.area > N * 0.10 && b.area > N * 0.10) return false;
              const aw = a.x1 - a.x0 + 1, ah = a.y1 - a.y0 + 1;
              const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1;
              if (Math.max(aw, bw) > W * 0.72) return false;
              // 两侧都必须是有实体面积的色块。稀疏窗框/边框的包围盒虽与
              // 窗格相接，但它不是容器本身，不能借包围盒把整扇窗串起来。
              const af = a.area / Math.max(1, aw * ah);
              const bf = b.area / Math.max(1, bw * bh);
              if (af < 0.16 || bf < 0.16) return false;
              const ox = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + 1);
              if (ox < Math.min(aw, bw) * 0.32) return false;
              const gapAB = Math.max(0, b.y0 - a.y1 - 1);
              const gapBA = Math.max(0, a.y0 - b.y1 - 1);
              return Math.min(gapAB, gapBA) <= supportGap;
            };
            // 承托关系只允许形成紧密的小簇。没有这个上限时，逐对 union
            // 会通过共享的大对象把全图串成一个巨型簇，逐对象完成的顺序
            // 就退化成整页一起完成。
            const clusterBounds = (root) => {
              let x0 = W, y0 = H, x1 = -1, y1 = -1;
              for (let i = 0; i < nObj; i++) {
                if (find2(i) !== root) continue;
                const o = out[i];
                if (o.x0 < x0) x0 = o.x0; if (o.y0 < y0) y0 = o.y0;
                if (o.x1 > x1) x1 = o.x1; if (o.y1 > y1) y1 = o.y1;
              }
              return { x0, y0, x1, y1 };
            };
            const supportCandidates = [];
            for (let i = 0; i < nObj; i++) {
              for (let j = i + 1; j < nObj; j++) {
                if (!supportPair(out[i], out[j])) continue;
                const a = out[i], b = out[j];
                const ox = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + 1);
                const gap = Math.min(
                  Math.max(0, b.y0 - a.y1 - 1),
                  Math.max(0, a.y0 - b.y1 - 1));
                supportCandidates.push({ i, j, gap, overlap: ox / Math.min(a.x1 - a.x0 + 1, b.x1 - b.x0 + 1) });
              }
            }
            supportCandidates.sort((a, b) => a.gap - b.gap || b.overlap - a.overlap || a.i - b.i || a.j - b.j);
            const supportRoots = new Set();
            for (const c of supportCandidates) {
              const ri = find2(c.i), rj = find2(c.j);
              if (ri === rj) continue;
              const bi = clusterBounds(ri), bj = clusterBounds(rj);
              const x0 = Math.min(bi.x0, bj.x0), y0 = Math.min(bi.y0, bj.y0);
              const x1 = Math.max(bi.x1, bj.x1), y1 = Math.max(bi.y1, bj.y1);
              const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
              if (cw > W * 0.55 || ch > H * 0.55 || cw * ch > N * 0.14) continue;
              if (opts.debug) console.log('[support]', c.i, out[c.i].x0, out[c.i].y0, out[c.i].x1, out[c.i].y1,
                out[c.i].area, '+', c.j, out[c.j].x0, out[c.j].y0, out[c.j].x1, out[c.j].y1, out[c.j].area,
                'gap=' + c.gap);
              uni2(c.i, c.j);
              supportRoots.add(find2(c.i));
            }
            // 承托簇只包含两侧大块还不足以成为“一个完整对象”：叶片、
            // 盆沿、杯把、书脊等小组仍可能散落在同一紧凑区域。把落在
            // 该簇范围内、尺寸很小且不是背景/大框的碎片并进来，随后在
            // 簇的第一笔前先做整体粗铺，就不会出现主体已经出现、内部
            // 却长时间残留纸白的拼贴感。
            const clusterArea = (root) => {
              let a = 0;
              for (let i = 0; i < nObj; i++) if (find2(i) === root) a += out[i].area;
              return a;
            };
            // 碎片扩张必须围绕承托簇的初始边界封顶。不能在每次合并后
            // 重算 baseBox，否则一个 12% 的小扩张会通过多轮合并累积成
            // 贯穿整页的巨型对象。
            const expandLimits = new Map();
            if (opts.debug) for (const r0 of new Set([...supportRoots].map((r) => find2(r)))) {
              const b0 = clusterBounds(r0);
              console.log('[kinpre] root=' + r0 + ' bbox=[' + [b0.x0, b0.y0, b0.x1, b0.y1].join(',') + ']');
            }
            for (let pass = 0; pass < 2; pass++) {
              const roots = [...supportRoots].map((r) => find2(r));
              for (const sr0 of roots) {
                let sr = find2(sr0);
                let lim = expandLimits.get(sr);
                if (!lim) {
                  const bi = clusterBounds(sr);
                  lim = {
                    x0: bi.x0, y0: bi.y0, x1: bi.x1, y1: bi.y1,
                    box: (bi.x1 - bi.x0 + 1) * (bi.y1 - bi.y0 + 1),
                  };
                  expandLimits.set(sr, lim);
                }
                let bi = clusterBounds(sr);
                const margin = Math.max(8, supportGap * 1.5);
                const inSupportCluster = (i) => {
                  const r = find2(i);
                  for (const rr of supportRoots) if (find2(rr) === r) return true;
                  return false;
                };
                for (let i = 0; i < nObj; i++) {
                  // 已有承托簇的成员不能再被另一个簇当作“碎片”吸走。
                  // 否则两个互不相邻的簇会通过共享同一个碎片合并，最终
                  // 形成跨越窗格、花束和底座的伪对象。
                  if (inSupportCluster(i)) continue;
                  const o = out[i];
                  if (o.frameComplex || o.backdrop || o.container) continue;
                  // 只并真正的局部碎片；不能因为宿主簇已经很大，就把相邻
                  // 的整块窗格/器皿也卷进来。
                  if (o.area > Math.max(supportFloor * 1.5, 6400)) continue;
                  if (o.cx < bi.x0 - margin || o.cx > bi.x1 + margin ||
                      o.cy < bi.y0 - margin || o.cy > bi.y1 + margin) continue;
                  const obw = o.x1 - o.x0 + 1, obh = o.y1 - o.y0 + 1;
                  // 碎片与簇之间允许同一个局部容差：细叶尖、窗框边常与
                  // 主体相隔 1~2px，但视觉上仍属于同一块正在完成的区域。
                  const ox = Math.max(0, Math.min(o.x1, bi.x1 + margin) -
                    Math.max(o.x0, bi.x0 - margin) + 1);
                  const oy = Math.max(0, Math.min(o.y1, bi.y1 + margin) -
                    Math.max(o.y0, bi.y0 - margin) + 1);
                  if (ox * oy < obw * obh * 0.62) continue;
                  const x0 = Math.min(bi.x0, o.x0), y0 = Math.min(bi.y0, o.y0);
                  const x1 = Math.max(bi.x1, o.x1), y1 = Math.max(bi.y1, o.y1);
                  // 新边界只能落在初始簇附近的固定信封内；面积上限同样
                  // 相对初始簇计算，不随后续碎片逐次放大。
                  if (x0 < lim.x0 - margin || y0 < lim.y0 - margin ||
                      x1 > lim.x1 + margin || y1 > lim.y1 + margin) continue;
                  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
                  if (cw > W * 0.56 || ch > H * 0.56) continue;
                  if (cw * ch > Math.min(lim.box * 1.45 + N * 0.004, N * 0.16)) continue;
                  if (opts.debug) console.log('[kinexp] pass=' + pass + ' root=' + sr + ' add=' + i +
                    ' lim=[' + [lim.x0, lim.y0, lim.x1, lim.y1].join(',') + '] new=[' + [x0, y0, x1, y1].join(',') + ']');
                  const oldRoot = sr;
                  uni2(sr, i);
                  sr = find2(sr);
                  if (sr !== oldRoot) expandLimits.set(sr, lim);
                  supportRoots.add(sr);
                  bi = clusterBounds(sr);
                }
              }
            }
            const cmap = new Map();
            for (let i = 0; i < nObj; i++) {
              const r = find2(i);
              let c = cmap.get(r);
              if (!c) { c = { anchor: i, items: [] }; cmap.set(r, c); }
              c.items.push(i);
            }
            const clusters = [...cmap.values()].sort((a, b) => a.anchor - b.anchor);
            const clusterBox = (c) => {
              let x0 = W, y0 = H, x1 = -1, y1 = -1;
              for (const i of c.items) {
                const o = out[i];
                if (o.x0 < x0) x0 = o.x0; if (o.y0 < y0) y0 = o.y0;
                if (o.x1 > x1) x1 = o.x1; if (o.y1 > y1) y1 = o.y1;
              }
              return { x0, y0, x1, y1 };
            };
            const clusterWeight = (c) => c.items.reduce((a, i) => a + out[i].area, 0);
            // 同一局部构图常被分色器拆成左右窗格、花束和花盆几个承托簇。
            // 若只按簇依次完成，先画的花束会在一段时间里缺少同组叶片。
            // 这里只合并空间上重叠/紧邻且联合包络仍属局部区域的承托簇；
            // 整页背板或跨左右构图不会进入该过程。
            const cp = new Int32Array(clusters.length).fill(-1);
            const findC = (i) => { let r = i; while (cp[r] >= 0) r = cp[r]; return r; };
            const uniC = (a, b) => {
              a = findC(a); b = findC(b); if (a === b) return;
              if (cp[a] > cp[b]) { const t = a; a = b; b = t; }
              cp[a] += cp[b]; cp[b] = a;
            };
            for (let i = 0; i < clusters.length; i++) {
              if (clusters[i].items.length < 2) continue;
              for (let j = i + 1; j < clusters.length; j++) {
                if (clusters[j].items.length < 2) continue;
                const a = clusters[findC(i)], b = clusters[findC(j)];
                if (a === b) continue;
                const ba = clusterBox(a), bb = clusterBox(b);
                const gapX = Math.max(0, Math.max(ba.x0, bb.x0) - Math.min(ba.x1, bb.x1) - 1);
                const gapY = Math.max(0, Math.max(ba.y0, bb.y0) - Math.min(ba.y1, bb.y1) - 1);
                if (gapX > supportGap * 1.35 || gapY > supportGap * 1.35) continue;
                const ox = Math.min(ba.x1, bb.x1) - Math.max(ba.x0, bb.x0) + 1;
                const oy = Math.min(ba.y1, bb.y1) - Math.max(ba.y0, bb.y0) + 1;
                const nearShare = Math.max(ox / Math.max(1, Math.min(ba.x1 - ba.x0 + 1, bb.x1 - bb.x0 + 1)),
                  oy / Math.max(1, Math.min(ba.y1 - ba.y0 + 1, bb.y1 - bb.y0 + 1)));
                if (nearShare < 0.12) continue;
                const x0 = Math.min(ba.x0, bb.x0), y0 = Math.min(ba.y0, bb.y0);
                const x1 = Math.max(ba.x1, bb.x1), y1 = Math.max(ba.y1, bb.y1);
                const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
                if (cw > W * 0.60 || ch > H * 0.86 || cw * ch > N * 0.42) continue;
                if (clusterWeight(a) + clusterWeight(b) > N * 0.24) continue;
                uniC(i, j);
              }
            }
            const compMap = new Map();
            for (let ci = 0; ci < clusters.length; ci++) {
              const r = findC(ci), c = clusters[ci];
              let cc = compMap.get(r);
              if (!cc) { cc = { key: c.anchor, clusters: [], gids: [], box: null }; compMap.set(r, cc); }
              cc.clusters.push(c);
              for (const i of c.items) for (const gid of out[i].gids) {
                if (!cc.gids.includes(gid)) cc.gids.push(gid);
              }
            }
            for (const cc of compMap.values()) {
              let x0 = W, y0 = H, x1 = -1, y1 = -1;
              for (const c of cc.clusters) {
                const b = clusterBox(c);
                if (b.x0 < x0) x0 = b.x0; if (b.y0 < y0) y0 = b.y0;
                if (b.x1 > x1) x1 = b.x1; if (b.y1 > y1) y1 = b.y1;
              }
              cc.box = [x0, y0, x1, y1];
              if (cc.clusters.length > 1 && opts.debug) console.log('[kincomp] key=' + cc.key +
                ' clusters=' + cc.clusters.length + ' bbox=[' + cc.box.join(',') + ']');
            }
            const local = [];
            for (let ci = 0; ci < clusters.length; ci++) {
              const c = clusters[ci];
              const comp = compMap.get(findC(ci));
              if (c.items.length > 1) {
                if (opts.debug) console.log('[kinclu] anchor=' + c.anchor + ' n=' + c.items.length + ' items=' +
                  c.items.slice(0, 24).map((i) => i + ':' + out[i].area + ':[' + out[i].x0 + ',' + out[i].y0 + ',' + out[i].x1 + ',' + out[i].y1 + ']').join(' ') +
                  (c.items.length > 24 ? ' ...' : ''));
                for (const i of c.items) {
                  out[i].kinKey = comp.key;
                  out[i].kinGids = comp.gids;
                  out[i].kinBox = comp.box;
                }
              }
              const hosts = c.items.filter((i) => hostOk(out[i]));
              // 同一团里若一个宿主压在另一个宿主上（圆盘承托飞机），先画
              // 更大的承载主体，再把压在上面的对象补完。
              hosts.sort((i, j) => {
                const a = out[i], b = out[j];
                const aa = (a.x1 - a.x0 + 1) * (a.y1 - a.y0 + 1);
                const bb = (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1);
                return bb - aa || i - j;
              });
              // 无宿主时，承托物先画（y 更大的在下方），再把上方主体接上。
              // 有宿主时宿主已经在最前，内部细节仍按原来的就近顺序完成。
              const rest = c.items.filter((i) => !hostOk(out[i]));
              if (!hosts.length) rest.sort((i, j) => (out[j].cy - out[i].cy) || (out[i].cx - out[j].cx));
              for (const i of hosts.concat(rest)) local.push(out[i]);
            }
            out.length = 0;
            for (const o of local) out.push(o);
            if (opts.debug) console.log('[objflags] ' + out.map((o, i) => i + ':' + o.area + ':[' + o.x0 + ',' + o.y0 + ',' + o.x1 + ',' + o.y1 + ']' +
              ':k' + (o.kinKey === undefined ? '-' : o.kinKey) + ':f' + (o.frameComplex ? 1 : 0) + ':c' + (o.container ? 1 : 0) + ':b' + (o.backdrop ? 1 : 0)).join(' '));
          }
          if (opts.debug) {
            console.log('[obj] n=' + out.length + ' top=' + out.slice(0, 10).map((o) =>
              o.area + '@' + o.gids.length + ':[' + o.x0 + ',' + o.y0 + ',' + o.x1 + ',' + o.y1 + ']').join(' '));
          }
          return out;
        })();
        if (objectPass) console.log('[objpass] start objects=' + pobjs.length + ' strokes=' + strokes.length +
          ' bg=' + bgSet.reduce((a, b) => a + b, 0) + '/' + G_);
        if (opts.dumpGroups) globalThis.__ISP_DUMP_OBJ = pobjs.map((o) => ({
          tier: 1, area: o.area, bbox: [o.x0, o.y0, o.x1, o.y1], gids: o.gids,
          mass: [], local: [],
        }));
        // 对象内角色：字心（fill）/ 描边（rimC：细、色差大）/ 其它色块
        const objRoles = (o) => {
          let seed = null;
          for (const g of o.gs) {
            if (g.lineLike || g.area < 60) continue;
            if (!seed || g.area > seed.area) seed = g;
          }
          if (!seed) return { seed: o.gs[0] || null, fill: [], rimC: [], other: o.gs.slice() };
          const fc = seed.mean;
          const fill = [], rimC = [], other = [];
          for (const g of o.gs) {
            if (mx3(g.mean, fc) <= 64) fill.push(g);
            else if (g.area / Math.max(1, 0.5 * (g.bw + g.bh)) <= 18) rimC.push(g);
            else other.push(g);
          }
          return { seed, fill, rimC, other };
        };
        // 对象包围盒内的 fill / rim 掩膜。rim 只收真正贴着字心的细组：
        // 同一个对象里混进来的别的色块（比如一行字里另一色的字）不是这圈描边。
        const objMasks = (o, roles) => {
          const bw = o.x1 - o.x0 + 1, bh = o.y1 - o.y0 + 1;
          const fm = new Uint8Array(bw * bh), rm = new Uint8Array(bw * bh);
          const paintMask = (arr, m) => {
            for (const g of arr) {
              for (let y = g.y0; y <= g.y1; y++) {
                const row = y * W, mr = (y - o.y0) * bw;
                for (let x = g.x0; x <= g.x1; x++) {
                  if (groupOf[row + x] === g.gid) m[mr + x - o.x0] = 1;
                }
              }
            }
          };
          paintMask(roles.fill, fm);
          let fillN = 0;
          for (let i = 0; i < fm.length; i++) fillN += fm[i];
          const rimGs = [];
          let rimN = 0;
          if (roles.rimC.length && fillN >= 80) {
            const dil = dilate(fm, bw, bh, 5);
            for (const g of roles.rimC) {
              let tot = 0, hit = 0;
              for (let y = g.y0; y <= g.y1; y++) {
                const row = y * W, mr = (y - o.y0) * bw;
                for (let x = g.x0; x <= g.x1; x++) {
                  if (groupOf[row + x] !== g.gid) continue;
                  tot++;
                  if (dil[mr + x - o.x0]) hit++;
                }
              }
              if (tot >= 8 && hit / tot >= 0.50) { rimGs.push(g); rimN += tot; }
            }
            if (rimGs.length) paintMask(rimGs, rm);
          }
          return { bw, bh, fm, rm, fillN, rimN, rimGs };
        };
        // 外轮廓 vs 内部细节：细边组里，离"对象外"（背景/别的对象）3px 以内的
        // 算外轮廓，被字心/大面包住的算内部细节（眼睛、嘴、鼻子）。人先描外轮廓，
        // 整块填满后再点五官；旧实现把两者一起在填色前描完，插画里就成了
        // "先把脸上的线全画一遍，再涂身体"。
        const splitRim = (o, roles) => {
          const inSet = new Uint8Array(G_);
          for (const gid of o.gids) inSet[gid] = 1;
          const outAt = (x, y) => {
            if (x < 0 || y < 0 || x >= W || y >= H) return true;
            const gid = groupOf[y * W + x];
            return gid < 0 || !inSet[gid];
          };
          const outer = [], inner = [];
          for (const g of roles.rimC) {
            let tot = 0, hit = 0;
            for (let y = g.y0; y <= g.y1; y++) {
              const row = y * W;
              for (let x = g.x0; x <= g.x1; x++) {
                if (groupOf[row + x] !== g.gid) continue;
                tot++;
                if (outAt(x - 3, y) || outAt(x + 3, y) || outAt(x, y - 3) || outAt(x, y + 3) ||
                  outAt(x - 3, y - 3) || outAt(x + 3, y - 3) ||
                  outAt(x - 3, y + 3) || outAt(x + 3, y + 3)) hit++;
              }
            }
            ((tot && hit / tot >= 0.35) ? outer : inner).push(g);
          }
          return { outer, inner };
        };
        // 整圈描边：把这一圈的细边当成一条连续结构，沿骨架一笔走完（闭环就接回
        // 起点，回放里手不停）。笔身按掩膜内切半径放宽，超出的部分被 zoneMask
        // 裁掉，所以一圈下来不会留下要靠碎笔回补的缺口。
        const paintObjOutline = (o, roles, mk, ph) => {
          if (mk.rimN < 50 || mk.fillN < 80) return 0;
          if (mk.rimN > mk.fillN * 0.9) return 0;      // 不是"细边 + 大面"，是两块色
          if (mk.bw * mk.bh > 420000) return 0;
          const rimGids = mk.rimGs.map((g) => g.gid);
          const rimIs = new Uint8Array(G_);
          for (const g of mk.rimGs) rimIs[g.gid] = 1;
          const fs = Math.max(0.95, fidScale);
          const s0 = strokes.length;
          const CHUNK = 70;
          const dtCache = new Map();
          const dtOf = (m) => {
            let d = dtCache.get(m);
            if (!d) { d = distanceTransform(m, mk.bw, mk.bh); dtCache.set(m, d); }
            return d;
          };
          // 一条骨架路径按颜色真实变化切段：每点取原图色、5 点平滑，与段首起手色
          // 偏差超过 CUT_CD 才换段（最短段 MINRUN 像素）。平涂的一圈红边就是一整笔；
          // 扫描件真有明暗变化时自动切成 2~4 笔，不会把渐变抹成一个均值。
          const emitPath = (path, sm, gids, o2) => {
            if (path.n < 3) return;
            let plen = 0;
            for (let i = 1; i < path.n; i++) {
              plen += Math.hypot(path.pts[i * 2] - path.pts[(i - 1) * 2],
                path.pts[i * 2 + 1] - path.pts[(i - 1) * 2 + 1]);
            }
            if (plen < 8) return;
            const dtv = dtOf(sm);
            const dtAt = (x, y) => {
              const xx = Math.round(x) - o.x0, yy = Math.round(y) - o.y0;
              if (xx < 0 || yy < 0 || xx >= mk.bw || yy >= mk.bh) return 0;
              const d = dtv[yy * mk.bw + xx];
              return d >= 1e8 ? 0 : d;
            };
            const np = path.n, pts = path.pts;
            // 闭环：首尾相邻就把首点接到尾后，一整圈不停笔
            const dEnd = Math.hypot(pts[0] - pts[(np - 1) * 2], pts[1] - pts[(np - 1) * 2 + 1]);
            const closed = dEnd <= 4;
            const nn = closed ? np + 1 : np;
            const all = new Float64Array(nn * 2);
            for (let i = 0; i < np; i++) { all[i * 2] = pts[i * 2]; all[i * 2 + 1] = pts[i * 2 + 1]; }
            if (closed) { all[np * 2] = pts[0]; all[np * 2 + 1] = pts[1]; }
            const wScale = o2.wScale || 1.55;
            const CUT_CD = o2.cutCd || 12;
            const CUT_TOT = o2.cutTot || 20;
            const MINRUN = 24;
            // 路径点上的原图色（3×3 邻域里落在细边掩膜内的像素取均值：
            // 轮廓点落在像素边上，单点取色会一半取空）
            const cr = new Float32Array(nn), cg = new Float32Array(nn), cb = new Float32Array(nn);
            const ok = new Uint8Array(nn);
            for (let i = 0; i < nn; i++) {
              const gx = Math.round(all[i * 2]), gy = Math.round(all[i * 2 + 1]);
              let rr = 0, gg = 0, bb = 0, n2 = 0;
              for (let dy = -1; dy <= 1; dy++) {
                const yy = gy + dy;
                if (yy < o.y0 || yy > o.y1) continue;
                for (let dx = -1; dx <= 1; dx++) {
                  const xx = gx + dx;
                  if (xx < o.x0 || xx > o.x1) continue;
                  if (!sm[(yy - o.y0) * mk.bw + xx - o.x0]) continue;
                  const p = yy * W + xx;
                  rr += R[p]; gg += G[p]; bb += B[p]; n2++;
                }
              }
              if (!n2) continue;
              cr[i] = rr / n2; cg[i] = gg / n2; cb[i] = bb / n2; ok[i] = 1;
            }
            // 5 点平滑：扫描噪点不该决定断笔位置
            const sr = new Float32Array(nn), sg = new Float32Array(nn), sb = new Float32Array(nn);
            const sv = new Uint8Array(nn);
            for (let i = 0; i < nn; i++) {
              let rr = 0, gg = 0, bb = 0, n2 = 0;
              for (let k = -2; k <= 2; k++) {
                const j = i + k;
                if (j < 0 || j >= nn || !ok[j]) continue;
                rr += cr[j]; gg += cg[j]; bb += cb[j]; n2++;
              }
              if (!n2) continue;
              sr[i] = rr / n2; sg[i] = gg / n2; sb[i] = bb / n2; sv[i] = 1;
            }
            const dist = (i, j) => Math.hypot(all[i * 2] - all[j * 2], all[i * 2 + 1] - all[j * 2 + 1]);
            // 一段一笔：段色 = 这一段落笔处的真实均值，段间共享 1 个点
            let runN = 0;
            const runCols = [];
            const emitRun = (a, b) => {
              const cn = b - a;
              if (cn < 2) return;
              const sp = new Float64Array(cn * 2);
              const halfs = new Float64Array(cn);
              for (let i = 0; i < cn; i++) {
                const j = a + i;
                sp[i * 2] = all[j * 2]; sp[i * 2 + 1] = all[j * 2 + 1];
                halfs[i] = o2.half ? Math.max(2.4, o2.half) : Math.max(2.4, dtAt(all[j * 2], all[j * 2 + 1]) * wScale + 1.0);
              }
              // 拐角/分叉处 dt 会跳变：三点平滑一下，笔身不会鼓包
              for (let i = 0; i < cn; i++) {
                const h0 = halfs[i > 0 ? i - 1 : 0], h1 = halfs[i < cn - 1 ? i + 1 : cn - 1];
                halfs[i] = (h0 + halfs[i] * 2 + h1) * 0.25;
              }
              for (let i = 0; i < cn; i++) halfs[i] = Math.max(2.2, halfs[i] * fs);
              // 段色 = 这一笔实际盖住的 rim 像素真实均值（不是中心线采样）：
              // 一笔只有一个颜色时，这个均值让整段的逐像素误差最小。
              let rr = 0, gg = 0, bb = 0, n2 = 0;
              const seenP = new Set();
              for (let i = 0; i < cn; i++) {
                const cx = sp[i * 2], cy = sp[i * 2 + 1], hr = halfs[i], r2 = hr * hr;
                const ix = Math.round(cx), iy = Math.round(cy), rr0 = Math.ceil(hr);
                for (let dy = -rr0; dy <= rr0; dy++) {
                  const yy = iy + dy;
                  if (yy < o.y0 || yy > o.y1) continue;
                  for (let dx = -rr0; dx <= rr0; dx++) {
                    if (dx * dx + dy * dy > r2) continue;
                    const xx = ix + dx;
                    if (xx < o.x0 || xx > o.x1) continue;
                    if (!sm[(yy - o.y0) * mk.bw + xx - o.x0]) continue;
                    const p2 = yy * W + xx;
                    if (seenP.has(p2)) continue;
                    seenP.add(p2);
                    rr += R[p2]; gg += G[p2]; bb += B[p2]; n2++;
                  }
                }
              }
              let col;
              if (n2 >= 3) col = [Math.round(rr / n2), Math.round(gg / n2), Math.round(bb / n2)];
              else {
                // 这一段落在一档的断口上：用路径点所在组的颜色
                const cnt = new Map();
                for (let i = 0; i < cn; i++) {
                  const gx = Math.round(sp[i * 2]), gy = Math.round(sp[i * 2 + 1]);
                  if (gx < 0 || gy < 0 || gx >= W || gy >= H) continue;
                  const gid = groupOf[gy * W + gx];
                  if (gid >= 0 && rimIs[gid]) cnt.set(gid, (cnt.get(gid) || 0) + 1);
                }
                let bestGid = -1, bestN = 0;
                for (const [gid, n] of cnt) if (n > bestN) { bestN = n; bestGid = gid; }
                col = bestGid >= 0 ? colorOf(groups[bestGid]) : colorOf(roles.seed);
              }
              let len = 0;
              for (let i = 1; i < cn; i++) len += dist(a + i - 1, a + i);
              const msW = Math.round((120 + len * 2.6) * 2);
              const si0 = emitPlan(sp, halfs, col, ph, {
                pen: 1,
                zoneMaskRect: { m: sm, x0: o.x0, y0: o.y0, w: mk.bw, h: mk.bh },
                zoneGroups: gids, zoneTol: 16, zonePx: 1, geomCover: 1, forceKeep: 1,
                ms: msW,
              });
              if (si0 >= 0) strokes[si0].st = 1;
              runN++; if (runCols.length < 8) runCols.push(col.join('/'));
            };
            // 段首起手色 = 前 3 个有效平滑点的均值（抗单点噪点）
            let refR = 0, refG = 0, refB = 0;
            const setRef = (st) => {
              let rr = 0, gg = 0, bb = 0, n2 = 0;
              for (let j = st; j < nn && n2 < 3; j++) {
                if (!sv[j]) continue;
                rr += sr[j]; gg += sg[j]; bb += sb[j]; n2++;
              }
              refR = n2 ? rr / n2 : 0; refG = n2 ? gg / n2 : 0; refB = n2 ? bb / n2 : 0;
            };
            setRef(0);
            let a = 0, arc = 0;
            let mr = 0, mg = 0, mb = 0, mn = 0, over = 0;
            for (let i = 0; i < nn; i++) {
              if (!sv[i]) continue;
              if (!mn) { mr = sr[i]; mg = sg[i]; mb = sb[i]; mn = 1; }
              else {
                // 断了不是噪点说了算：要连续 2 个点偏离当前段均值，或整段漂移超过 CUT_TOT
                const dm = Math.max(Math.abs(sr[i] - mr / mn), Math.abs(sg[i] - mg / mn), Math.abs(sb[i] - mb / mn));
                const dt0 = Math.max(Math.abs(sr[i] - refR), Math.abs(sg[i] - refG), Math.abs(sb[i] - refB));
                if (i - a >= 3 && arc >= MINRUN && ((over >= 2 && dm > CUT_CD) || dt0 > CUT_TOT)) {
                  emitRun(a, i);
                  a = i - 1;                  // 段间共享 1 个点，回放里笔尖不跳
                  setRef(a);
                  arc = dist(a, i);
                  mr = sr[i]; mg = sg[i]; mb = sb[i]; mn = 1; over = 0;
                  continue;
                }
                over = dm > CUT_CD ? over + 1 : 0;
                mr += sr[i]; mg += sg[i]; mb += sb[i]; mn++;
              }
              arc += dist(i - 1 < a ? a : i - 1, i);
            }
            emitRun(a, nn);
            if (o2.tag !== undefined && opts.debug && runN > 4) console.log('[outline-path] tag=' + o2.tag +
              ' pts=' + path.n + ' runs=' + runN + ' cols=' + runCols.slice(0, 4).join(' '));
          };
          // ---- 1) 整圈底笔：沿"整条细边"的骨架先走一圈 ----
          // 细边按颜色切碎后，任何单一色档的骨架都是断续的（回放里是虚线）。
          // 先用整圈骨架走一遍视觉底笔，第一眼就是"一笔绕一圈"；底笔不记覆盖
          // （noZone/noCover），后面各色档再按真实颜色盖一遍，成品精度不受影响。
          // 细边被颜色/噪点切成很多组，按组骨架走会断成几十段；人描的是字形轮廓。
          // 取"对象外轮廓"（fill+rim 的边界），沿轮廓按整条细边的平均宽度落笔，
          // 笔身向内盖满细边，出界部分被 rim 掩膜裁掉。
          let pathsN = 0;
          {
            // 细边按颜色/噪点碎成很多骨架段。按端点最近把它们接成长链：
            // 同一圈细边（含内部的细条纹）只换一两次笔，不再几十段。
            const paths = traceMaskPaths(dilate(mk.rm, mk.bw, mk.bh, 2), mk.bw, mk.bh, o.x0, o.y0);
            // 每条骨架段的平均色：接链时只接同色的段（红描边接红描边，奶油边接奶油边）。
            // 不然一条链跨过两种颜色，一笔的段色谁也不像，只能靠后面的碎笔回补。
            const pMean = paths.map((pp) => {
              let rr = 0, gg = 0, bb = 0, n2 = 0;
              for (let k = 0; k < pp.n; k++) {
                const gx = Math.round(pp.pts[k * 2]), gy = Math.round(pp.pts[k * 2 + 1]);
                for (let dy = -1; dy <= 1; dy++) {
                  const yy = gy + dy;
                  if (yy < o.y0 || yy > o.y1) continue;
                  for (let dx = -1; dx <= 1; dx++) {
                    const xx = gx + dx;
                    if (xx < o.x0 || xx > o.x1) continue;
                    if (!mk.rm[(yy - o.y0) * mk.bw + xx - o.x0]) continue;
                    const pp2 = yy * W + xx;
                    rr += R[pp2]; gg += G[pp2]; bb += B[pp2]; n2++;
                  }
                }
              }
              return n2 ? [rr / n2, gg / n2, bb / n2] : null;
            });
            const JOIN_CD = 55;
            const usedP = new Uint8Array(paths.length);
            const JOIN_R = Math.max(16, Math.min(40, Math.round(Math.min(mk.bw, mk.bh) * 0.08)));
            const chains = [];
            for (let guard = 0; guard < paths.length + 1; guard++) {
              let si = -1, bestLen = -1;
              for (let i = 0; i < paths.length; i++) {
                if (!usedP[i] && paths[i].len > bestLen) { bestLen = paths[i].len; si = i; }
              }
              if (si < 0) break;
              usedP[si] = 1;
              const chain = { pts: Array.from(paths[si].pts), n: paths[si].n };
              let cR = 0, cG = 0, cB = 0, cW = 0;
              if (pMean[si]) { cR = pMean[si][0]; cG = pMean[si][1]; cB = pMean[si][2]; cW = 1; }
              const endPt = (tail) => tail
                ? [chain.pts[(chain.n - 1) * 2], chain.pts[(chain.n - 1) * 2 + 1]]
                : [chain.pts[0], chain.pts[1]];
              let grew = true;
              while (grew) {
                grew = false;
                for (const tail of [true, false]) {
                  const e = endPt(tail);
                  let bi = -1, bd = JOIN_R, rev = false;
                  for (let i = 0; i < paths.length; i++) {
                    if (usedP[i]) continue;
                    if (pMean[i] && cW > 0) {
                      const d = Math.hypot(pMean[i][0] - cR / cW, pMean[i][1] - cG / cW, pMean[i][2] - cB / cW);
                      if (d > JOIN_CD) continue;
                    }
                    const p = paths[i];
                    const d0 = Math.hypot(p.pts[0] - e[0], p.pts[1] - e[1]);
                    const d1 = Math.hypot(p.pts[(p.n - 1) * 2] - e[0], p.pts[(p.n - 1) * 2 + 1] - e[1]);
                    if (d0 <= bd) { bd = d0; bi = i; rev = false; }
                    if (d1 <= bd) { bd = d1; bi = i; rev = true; }
                  }
                  if (bi < 0) continue;
                  usedP[bi] = 1; grew = true;
                  const p = paths[bi];
                  const add = [];
                  for (let k = 0; k < p.n; k++) {
                    const j = rev ? (p.n - 1 - k) : k;
                    add.push(p.pts[j * 2], p.pts[j * 2 + 1]);
                  }
                  if (tail) chain.pts.push(...add);
                  else chain.pts.unshift(...add);
                  chain.n += p.n;
                  if (pMean[bi]) {
                    const w = Math.max(1, p.len);
                    cR += pMean[bi][0] * w; cG += pMean[bi][1] * w; cB += pMean[bi][2] * w; cW += w;
                  }
                }
              }
              chains.push(chain);
            }
            pathsN = chains.length;
            let clen = 0;
            for (const c of chains) {
              for (let i = 1; i < c.n; i++) {
                clen += Math.hypot(c.pts[i * 2] - c.pts[(i - 1) * 2],
                  c.pts[i * 2 + 1] - c.pts[(i - 1) * 2 + 1]);
              }
            }
            const bandW = Math.max(1.5, Math.min(16, mk.rimN / Math.max(1, clen)));
            const half = Math.max(2.6, Math.min(20, bandW * 1.1 + 1.5));
            let ci = 0;
            for (const c of chains) {
              if (c.n < 3) continue;
              emitPath({ pts: Float64Array.from(c.pts), n: c.n }, mk.rm, rimGids, { half, cutCd: 14, tag: ci++ });
            }
            if (opts.debug) console.log('[outline-loops] paths=' + paths.length + ' chains=' + chains.length);
          }
          if (opts.debug) {
            let left = 0;
            for (const g of mk.rimGs) left += Math.max(0, groupUncov[g.gid]);
            console.log('[outline] bbox=[' + o.x0 + ',' + o.y0 + ',' + o.x1 + ',' + o.y1 + '] fill=' + mk.fillN +
              ' rim=' + mk.rimN + ' paths=' + pathsN + ' strokes=' + (strokes.length - s0) +
              ' left=' + left + '/' + mk.rimN);
          }
          return strokes.length - s0;
        };
        // 同色簇一刷：扫描噪点/抗锯齿把字心/细边拆成几十个组，按颜色并回几簇，
        // 每簇沿长轴一条横贯带（被联合掩膜裁回原形），一条盖满。
        const paintClusterFill = (cl, ph) => {
          const g0 = cl.gs[0];
          const ang = mkAng(g0, false);
          const ca = Math.cos(ang), sa = Math.sin(ang);
          let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
          for (const [x, y] of [[cl.x0 - g0.cx, cl.y0 - g0.cy], [cl.x1 - g0.cx, cl.y0 - g0.cy],
            [cl.x1 - g0.cx, cl.y1 - g0.cy], [cl.x0 - g0.cx, cl.y1 - g0.cy]]) {
            const u = x * ca + y * sa, v = -x * sa + y * ca;
            if (u < uMin) uMin = u; if (u > uMax) uMax = u;
            if (v < vMin) vMin = v; if (v > vMax) vMax = v;
          }
          const span = Math.max(1, vMax - vMin);
          const halfW = Math.max(3.2, Math.min(52 * scaleB, span * 0.5 + 2));
          const k = Math.max(1, Math.ceil(span / (halfW * 1.12)));
          const uA = uMin - halfW * 1.7, uB = uMax + halfW * 1.7;
          const gr = {
            gid: -1, cx: g0.cx, cy: g0.cy, mean: cl.mean, area: cl.area,
            x0: cl.x0, y0: cl.y0, x1: cl.x1, y1: cl.y1, bw: cl.bw, bh: cl.bh,
          };
          const zone = { m: cl.m, x0: cl.x0, y0: cl.y0, w: cl.bw, h: cl.bh, gids: cl.gids, tol: 60 };
          for (let i = 0; i < k; i++) {
            const f = k === 1 ? 0.5 : i / (k - 1);
            emitBand(gr, uA, uB, vMin + span * f, ca, sa, halfW, ph, ang, k === 1 ? 0 : (i & 1), zone);
          }
        };
        // 若干组 → 联合 bbox/掩膜/均值，一刷
        const fillGroupCluster = (gs, ph) => {
          let area = 0, sr = 0, sg = 0, sb = 0;
          let x0 = W, y0 = H, x1 = -1, y1 = -1;
          for (const g of gs) {
            area += g.area;
            sr += g.mean[0] * g.area; sg += g.mean[1] * g.area; sb += g.mean[2] * g.area;
            if (g.x0 < x0) x0 = g.x0; if (g.x1 > x1) x1 = g.x1;
            if (g.y0 < y0) y0 = g.y0; if (g.y1 > y1) y1 = g.y1;
          }
          if (area <= 0) return 0;
          const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
          const m = new Uint8Array(bw * bh);
          const gids = [];
          for (const g of gs) {
            gids.push(g.gid);
            for (let y = g.y0; y <= g.y1; y++) {
              const row = y * W, mr = (y - y0) * bw;
              for (let x = g.x0; x <= g.x1; x++) {
                if (groupOf[row + x] === g.gid) m[mr + x - x0] = 1;
              }
            }
          }
          paintClusterFill({
            gs, area, mean: [sr / area, sg / area, sb / area],
            x0, y0, x1, y1, bw, bh, m, gids,
          }, ph);
          return 1;
        };
        // 按颜色并簇（同色碎片 ≤cd/通道），面积从大到小
        const colorClusters = (list, cd) => {
          const gs = list.slice().sort((a, b) => b.area - a.area);
          const used = new Uint8Array(gs.length);
          const out = [];
          for (let i = 0; i < gs.length; i++) {
            if (used[i]) continue;
            used[i] = 1;
            const cl = [gs[i]];
            for (let j = i + 1; j < gs.length; j++) {
              if (used[j]) continue;
              if (mx3(gs[j].mean, gs[i].mean) > cd) continue;
              used[j] = 1; cl.push(gs[j]);
            }
            out.push(cl);
          }
          return out;
        };
        // 描边后补边：只补"画布上真的偏了"的细边组（主描边用整段均值已经把
        // 大部分像素画在容差内，按 groupUncov 一刀切会把整圈拆回几十个碎片重画）。
        const paintRimClusters = (roles, ph) => {
          const gErr = (g) => {
            let sum = 0, n = 0;
            for (let y = g.y0; y <= g.y1; y++) {
              const row = y * W;
              for (let x = g.x0; x <= g.x1; x++) {
                const p = row + x;
                if (groupOf[p] !== g.gid) continue;
                const q = p * 3;
                sum += Math.max(Math.abs(canvas[q] - R[p]), Math.abs(canvas[q + 1] - G[p]),
                  Math.abs(canvas[q + 2] - B[p]));
                n++;
              }
            }
            return n ? sum / n : 0;
          };
          const left = roles.rimC.filter((g) => groupUncov[g.gid] > 0 && gErr(g) > 10);
          if (!left.length) return 0;
          const s0 = strokes.length;
          // 按色调粗分簇（≤24/通道）：扫描噪点/暗边/亮芯并成几簇，一簇一笔；
          // 色差在 24 内，成品误差仍受误差守卫控制。
          for (const cl of colorClusters(left, 24)) {
            if (cl.length === 1) paintRegionFill(cl[0], ph);
            else fillGroupCluster(cl, ph);
          }
          if (opts.debug) console.log('[rimclu] left=' + left.length + ' strokes=' + (strokes.length - s0));
          return strokes.length - s0;
        };
        // 对象起手先用完整剪影粗铺一层 noCover 底稿：真人不会先把整圈轮廓
        // 磨完再回头填色，更不会让大主体在中段一直是白洞。这里使用对象全部
        // 色组的联合掩膜，沿真实形状逐带扫满，而不是只拿最大填充组画一两笔
        // 中心线。底稿裁在对象像素内，后画不会污染背景；精确描边/填色仍按原
        // 流程重画，覆盖记账也完全不受底稿影响。
        const paintObjUndercoat = (o, roles, ph) => {
          let solidN = 0;
          for (const g of o.gs) if (!g.lineLike) solidN += g.area;
          if (solidN < 24) return 0;
          const s0 = strokes.length;
          paintBlockIn(o.gids, o.x0, o.y0, o.x1, o.y1, ph, {
            minPx: 24, pad: 1,
            maxHalf: Math.max(18, Math.min(54 * scaleB,
              Math.sqrt(Math.max(24, solidN)) * 0.20)),
          });
          if (opts.debug && strokes.length > s0) console.log('[undercoat] bbox=[' + o.x0 + ',' + o.y0 + ',' +
            o.x1 + ',' + o.y1 + '] strokes=' + (strokes.length - s0));
          return strokes.length - s0;
        };
        // 字心整块填满：同一对象的填充组连续发出，中间不插别的字。
        const paintObjFill = (o, roles, mk, ph) => {
          if (!roles.fill.length) return 0;
          const s0 = strokes.length;
          const clusters = colorClusters(roles.fill, 8);
          for (const cl of clusters) {
            if (cl.length === 1) {
              const g = cl[0];
              if (g.lineLike) paintFull(g, ph);
              else paintRegionFill(g, ph);
              continue;
            }
            fillGroupCluster(cl, ph);
          }
          if (opts.debug) console.log('[objfill] bbox=[' + o.x0 + ',' + o.y0 + ',' + o.x1 + ',' + o.y1 +
            '] fillG=' + roles.fill.length + ' clusters=' + clusters.length + ' strokes=' + (strokes.length - s0));
          return strokes.length - s0;
        };
        // 对象内其余色块 + 描边没盖到的零碎
        const paintObjRest = (o, roles, mk, ph) => {
          const s0 = strokes.length;
          const others = roles.other.slice().sort((a, b) => b.area - a.area);
          for (const g of others) {
            if (g.lineLike) paintFull(g, ph);
            else paintRegionFill(g, ph);
          }
          if (opts.debug && strokes.length > s0) console.log('[objrest] other=' + others.length +
            ' strokes=' + (strokes.length - s0));
          return strokes.length - s0;
        };
        // 对象级误差守卫：把"没盖到"或"盖错了"的像素按 4 邻接连通块收拾，
        // 每块最多两笔（主色一遍、偏色残余一遍）。笔数由真实误差区域决定。
        const cleanupObj = (o, mk, ph) => {
          const inSet = new Uint8Array(G_);
          for (const gid of o.gids) inSet[gid] = 1;
          // 分割器会把对象边界上的抗锯齿像素归到邻近背景组，导致对象内部
          // 留下背景色细缝。若该像素的真实颜色明显更接近本对象的填充色，
          // 就仍把它算作对象误差；纯背景像素颜色本来就接近背景，不会误收。
          const objCols = [];
          for (const g of o.gs) {
            if (g.lineLike || g.area < 10) continue;
            if (!objCols.some((c) => mx3(c, g.mean) < 10)) objCols.push(g.mean);
          }
          const isObjBoundaryMiss = (p, gid) => {
            if (!bgSet[gid] || !objCols.length) return false;
            const a = groups[gid];
            if (!a) return false;
            let dCur = 0, dObj = Infinity;
            for (let k = 0; k < 3; k++) dCur = Math.max(dCur, Math.abs([R[p], G[p], B[p]][k] - a.mean[k]));
            for (const c of objCols) {
              let d = 0;
              d = Math.max(Math.abs(R[p] - c[0]), Math.abs(G[p] - c[1]), Math.abs(B[p] - c[2]));
              if (d < dObj) dObj = d;
            }
            return dObj + 12 < dCur;
          };
          const isBad = (p) => {
            const gid = groupOf[p];
            if (gid < 0 || (!inSet[gid] && !isObjBoundaryMiss(p, gid))) return false;
            const q = p * 3;
            return Math.max(Math.abs(canvas[q] - R[p]), Math.abs(canvas[q + 1] - G[p]),
              Math.abs(canvas[q + 2] - B[p])) > 22;
          };
          const bad = [];
          for (let y = o.y0; y <= o.y1; y++) {
            const row = y * W;
            for (let x = o.x0; x <= o.x1; x++) {
              const p = row + x;
              if (isBad(p)) bad.push(p);
            }
          }
          if (!bad.length) return 0;
          const s0 = strokes.length;
          const seen2 = new Uint8Array(N);
          const q = new Int32Array(N);
          let nComp = 0;
          for (const p0 of bad) {
            if (seen2[p0]) continue;
            let head = 0, tail = 0;
            q[tail++] = p0; seen2[p0] = 1;
            const sr0 = R[p0], sg0 = G[p0], sb0 = B[p0];
            let pix = [];
            let x0 = W, y0 = H, x1 = -1, y1 = -1;
            while (head < tail) {
              const p = q[head++];
              pix.push(p);
              const x = p % W, y = (p - x) / W;
              if (x < x0) x0 = x; if (x > x1) x1 = x;
              if (y < y0) y0 = y; if (y > y1) y1 = y;
              const visit = (r) => {
                if (r < 0 || r >= N || seen2[r] || !isBad(r)) return;
                // 同色才连：红芯、暗边、抗锯齿过渡各成一笔，不会被一个均值抹平
                if (Math.max(Math.abs(R[r] - sr0), Math.abs(G[r] - sg0), Math.abs(B[r] - sb0)) > 30) return;
                seen2[r] = 1; q[tail++] = r;
              };
              if (x > 0) visit(p - 1);
              if (x + 1 < W) visit(p + 1);
              if (y > 0) visit(p - W);
              if (y + 1 < H) visit(p + W);
            }
            for (let pass = 0; pass < 2; pass++) {
              if (pix.length < 6) break;
              let sr = 0, sg = 0, sb = 0, cx = 0, cy = 0;
              for (const p of pix) {
                sr += R[p]; sg += G[p]; sb += B[p];
                const x = p % W; cx += x; cy += (p - x) / W;
              }
              const col = [Math.round(sr / pix.length), Math.round(sg / pix.length), Math.round(sb / pix.length)];
              cx /= pix.length; cy /= pix.length;
              const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
              const m = new Uint8Array(bw * bh);
              let sxx = 0, syy = 0, sxy = 0;
              for (const p of pix) {
                const x = p % W, y = (p - x) / W;
                m[(y - y0) * bw + x - x0] = 1;
                const dx = x - cx, dy = y - cy;
                sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
              }
              const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
              const ca = Math.cos(ang), sa = Math.sin(ang);
              let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
              for (const p of pix) {
                const x = p % W - cx, y = (p - p % W) / W - cy;
                const u = x * ca + y * sa, v = -x * sa + y * ca;
                if (u < uMin) uMin = u; if (u > uMax) uMax = u;
                if (v < vMin) vMin = v; if (v > vMax) vMax = v;
              }
              const span = Math.max(1, uMax - uMin);
              const thick = pix.length / Math.max(1, span);
              const halfW = Math.max(1.8, Math.min(12, thick * 0.9 + 1.6));
              const gr = { gid: -1, cx, cy, mean: col, area: pix.length, x0, y0, x1, y1, bw, bh };
              const zone = { m, x0, y0, w: bw, h: bh, gids: o.gids, tol: 0 };
              emitBand(gr, uMin, uMax, (vMin + vMax) * 0.5, ca, sa, halfW, ph, ang, 0, zone);
              let left2 = 0;
              for (const p of pix) {
                if (!paintN[p]) { left2++; continue; }
                const qq = p * 3;
                if (Math.max(Math.abs(canvas[qq] - R[p]), Math.abs(canvas[qq + 1] - G[p]),
                  Math.abs(canvas[qq + 2] - B[p])) > 20) left2++;
              }
              if (left2 <= pix.length * 0.2) break;
              emitBand(gr, vMin, vMax, (uMin + uMax) * 0.5, -sa, ca, halfW, ph, ang + Math.PI / 2, 0, zone);
              const rest = [];
              for (const p of pix) {
                const qq = p * 3;
                if (!paintN[p] || Math.max(Math.abs(canvas[qq] - R[p]), Math.abs(canvas[qq + 1] - G[p]),
                  Math.abs(canvas[qq + 2] - B[p])) > 20) rest.push(p);
              }
              if (rest.length < pix.length * 0.5) break;
              pix = rest;
            }
            nComp++;
          }
          if (opts.debug && strokes.length > s0) console.log('[clean] bbox=[' + o.x0 + ',' + o.y0 + ',' + o.x1 +
            ',' + o.y1 + '] comps=' + nComp + ' strokes=' + (strokes.length - s0));
          return strokes.length - s0;
        };
        // 小对象/细线不应因为被切成很多短笔就在时间轴上停滞十几秒。
        // 按实际面积、跨度和线材占比给对象段一个时长上限；只缩放回放时长，
        // 不改笔形、颜色或覆盖，最终画面与精度不受影响。
        const capObjectTime = (s0, o) => {
          const bw = o.x1 - o.x0 + 1, bh = o.y1 - o.y0 + 1;
          const span = Math.max(bw, bh);
          const root = Math.sqrt(Math.max(1, o.area));
          let lineArea = 0;
          for (const g of o.gs) if (g.lineLike) lineArea += g.area;
          const lineShare = lineArea / Math.max(1, o.area);
          let cap = 900 + root * 52 + span * 2.2;
          if (lineShare >= 0.70) cap = Math.min(cap, 700 + span * 4.5);
          else if (lineShare >= 0.40) cap = Math.min(cap, 1300 + root * 28 + span * 2.2);
          cap = Math.max(650, Math.min(14000, cap));
          let ms = 0;
          for (let i = s0; i < strokes.length; i++) ms += strokes[i].ms || 0;
          if (ms > cap * 1.08) {
            const k = cap / ms;
            for (let i = s0; i < strokes.length; i++) strokes[i].ms *= k;
          }
        };
        prog(0.69, '画主体：一个字/一个对象地完成…');
        await yieldUI();
        // 窗框、桌沿、台面边这类长细结构是画面的“尺子”，人通常在
        // 主体细节前就先把它立住。它们若排在对象末尾，会留下横贯画面
        // 的细白缝，看起来像最后贴上去的。这里只按几何跨度选结构线，
        // 不按样例或颜色特判，且仍按原始色组取色。
        const structural = pobjs.filter((o) => {
          if (o.frameComplex || o.backdrop || o.area < 40) return false;
          const bw = o.x1 - o.x0 + 1, bh = o.y1 - o.y0 + 1;
          const span = Math.max(bw, bh), thick = Math.min(bw, bh);
          if (span < Math.min(W, H) * 0.18 || thick > Math.max(W, H) * 0.065) return false;
          let lineArea = 0;
          for (const g of o.gs) if (g.lineLike) lineArea += g.area;
          return lineArea / Math.max(1, o.area) >= 0.55 || span >= thick * 4.5;
        });
        if (!objectPass && structural.length) {
          const s0 = strokes.length;
          for (const o of structural) {
            const bw = o.x1 - o.x0 + 1, bh = o.y1 - o.y0 + 1;
            const cx = (o.x0 + o.x1) * 0.5, cy = (o.y0 + o.y1) * 0.5;
            const horiz = bw >= bh;
            const sx0 = Math.max(0, Math.floor(cx - (horiz ? bw * 0.50 : Math.min(W, H) * 0.10)));
            const sy0 = Math.max(0, Math.floor(cy - (horiz ? Math.min(W, H) * 0.10 : bh * 0.50)));
            const sx1 = Math.min(W - 1, Math.ceil(cx + (horiz ? bw * 0.50 : Math.min(W, H) * 0.10)));
            const sy1 = Math.min(H - 1, Math.ceil(cy + (horiz ? Math.min(W, H) * 0.10 : bh * 0.50)));
            paintBlockIn(o.gids, sx0, sy0, sx1, sy1,
              2, { minPx: 12, pad: 1, maxHalf: Math.max(6, Math.min(24 * scaleB,
                Math.sqrt(Math.max(16, o.area)) * 0.10)), stage: 'structure' });
          }
          for (let i = s0; i < strokes.length; i++) strokes[i].ms *= 0.06;
          if (opts.debug) console.log('[structure] n=' + structural.length +
            ' strokes=' + (strokes.length - s0) + ' bbox=' + structural.map((o) =>
              '[' + [o.x0, o.y0, o.x1, o.y1].join(',') + ']').join(' '));
          await yieldUI();
        }
        let objDone = 0;
        const kinPainted = new Set();
        for (const o of pobjs) {
          const obStart = strokes.length;
          if (!objectPass && o.kinKey !== undefined && !kinPainted.has(o.kinKey)) {
            kinPainted.add(o.kinKey);
            let solidN = 0;
            for (const gid of o.kinGids) {
              const g = groups[gid];
              if (g && !g.lineLike) solidN += g.area;
            }
            if (solidN >= 24) {
              const kb = o.kinBox;
              paintBlockIn(o.kinGids, kb[0], kb[1], kb[2], kb[3], 2, {
                minPx: 24, pad: 1, stage: 'kincoat',
                maxHalf: Math.max(18, Math.min(54 * scaleB,
                  Math.sqrt(Math.max(24, solidN)) * 0.20)),
              });
              if (opts.debug) console.log('[kincoat] key=' + o.kinKey +
                ' bbox=[' + kb.join(',') + '] strokes=' + (strokes.length - obStart));
            }
          }
          if (o.area < 30) {
            if (!objectPass) for (const g of o.gs) paintFull(g, 2);
            continue;
          }
          // 框族只负责把外框几何完整地立起来。不要套对象级的填充/描边推断：
          // 多圈框线颜色不同，强行推断会把某一圈的颜色铺到另一圈上。按边框
          // 绕行的周序逐组画准，并把整段压成快速定界笔。
          if (o.frameComplex) {
            if (objectPass) continue;
            const edgeRank = (g) => {
              const dl = g.cx, dr = W - 1 - g.cx, dt = g.cy, db = H - 1 - g.cy;
              const md = Math.min(dl, dr, dt, db);
              if (md === dt) return [0, g.cx];
              if (md === dr) return [1, g.cy];
              if (md === db) return [2, W - g.cx];
              return [3, H - g.cy];
            };
            const fg = o.gs.slice().sort((a, b) => {
              const ak = edgeRank(a), bk = edgeRank(b);
              return ak[0] - bk[0] || ak[1] - bk[1];
            });
            for (const g of fg) paintFull(g, 2);
            for (let i = obStart; i < strokes.length; i++) strokes[i].ms *= 0.12;
            capObjectTime(obStart, o);
            for (let i = obStart; i < strokes.length; i++) strokes[i].ob = objDone;
            handX = o.cx; handY = o.cy;
            if (((objDone++) & 3) === 0) {
              prog(0.69 + 0.22 * objDone / Math.max(1, pobjs.length), '画主体：一个字/一个对象地完成…');
              await yieldUI();
            }
            continue;
          }
          const roles = objRoles(o);
          // 先描外轮廓，整块填满，再补内部细节（眼睛/嘴/鼻子这类被大面包住的线）。
          // 这是几何判据（离对象外 3px 内=外轮廓），不按图的类型分支。
          const rs = splitRim(o, roles);
          const rolesO = {
            seed: roles.seed, fill: roles.fill, rimC: rs.outer,
            other: roles.other.concat(rs.inner),
          };
          const mk = objMasks(o, rolesO);
          // 对象执行器只接“细外描边 + 实质字心”的闭合对象。纯线条文字、
          // 圆点、单块实心形继续保留 compiler 的区域/中心线结果，避免把
          // 已经画准的小字和圆点重新解释成宽扫色块。
          if (objectPass && (mk.rimN < 50 || mk.fillN < 80 || mk.rimN > mk.fillN * 0.9)) continue;
          // 没通过"贴着字心"检查的外轮廓组也归到 rest，填色后按原色补
          {
            const accRim = new Set(mk.rimGs.map((g) => g.gid));
            for (const g of rs.outer) if (!accRim.has(g.gid)) rolesO.other.push(g);
          }
          // 背板先铺大色，再处理其中的飞机/圆形/文字与轮廓；普通对象才走
          // "先描边、再填满"。否则大蓝底会先被其中的红圆/飞机轮廓抢跑。
          let nOut = 0;
          if (!o.backdrop) {
            if (!objectPass) paintObjUndercoat(o, roles, 2);
            nOut = paintObjOutline(o, rolesO, mk, 2);
            paintRimClusters(rolesO, 2);
          }
          const f0 = strokes.length;
          paintObjFill(o, roles, mk, 2);
          // 背板是手臂大幅铺色，不能按小细节的笔速占掉大半时间；
          // 压短这一段时长，让后续主体在背景成形后尽快出现。
          if (o.backdrop) {
            for (let i = f0; i < strokes.length; i++) strokes[i].ms *= 0.28;
          }
          // 换对象时手停一下"看"下一块（挂在第一笔的落笔时间上）
          if (strokes.length > f0) {
            const st0 = strokes[f0];
            st0.ms = (st0.ms || 0) + 150 + srnd(o.cx * 1.3 + o.cy * 0.7 + runSeed * 0.07, 12.4) * 200;
          }
          paintObjRest(o, rolesO, mk, 2);
          cleanupObj(o, mk, 2);
          capObjectTime(obStart, o);
          // 调试标记：这一段笔都属于同一个对象（真机排查"先描边再填满"用）
          for (let i = obStart; i < strokes.length; i++) strokes[i].ob = objDone;
          // 跨大半画幅的纯线结构（外框、整页装饰线）是快速定界笔，
          // 不能按小细节的速度吃掉大半时间；否则主体和文字会被拖到片尾。
          const lineShare = o.gs.length ? o.gs.filter((g) => g.lineLike).length / o.gs.length : 0;
          const spanLarge = (o.x1 - o.x0 + 1) > W * 0.55 || (o.y1 - o.y0 + 1) > H * 0.55;
          if (lineShare >= 0.70 && spanLarge) {
            for (let i = obStart; i < strokes.length; i++) strokes[i].ms *= 0.12;
          }
          handX = o.cx; handY = o.cy;
          if (((objDone++) & 3) === 0) {
            prog(0.69 + 0.22 * objDone / Math.max(1, pobjs.length), '画主体：一个字/一个对象地完成…');
            await yieldUI();
          }
          if (opts.debug && nOut >= 0) {
            // 逐对象概览：面积、字心组数、描边笔数
            console.log('[objdone] ' + objDone + '/' + pobjs.length + ' area=' + o.area +
              ' fillG=' + roles.fill.length + ' out=' + nOut);
          }
        }
        if (objectPass) console.log('[objpass] done objects=' + pobjs.length + ' strokes=' + strokes.length);
        pfObjects = pobjs.length;
        if (!objectPass) pfRing = ringDone.size > 0;
        prog(0.97, '收笔：全图检查与统一…');
        await yieldUI();
      };

      // ---- 闭合区域画家执行器 ----
      // 关键语义：solid 区域先描外轮廓，再用“外轮廓内部实心 mask”扫满；
      // mask 不查询 groupOf，所以内部其他颜色也会被父色盖住。随后包含树上的
      // 子区域再描边、填满，一层层把细节压回来。
      const paintClosedPlan = async () => {
        const order = closedPlan.order;
        const regionPhase = (r) => {
          if (r.depth <= 0) return 0;
          if (r.depth === 1) return r.area >= N * 0.008 ? 1 : 2;
          return Math.min(3, r.depth + 1);
        };
        const contourStroke = (r, loop, ph, stage, zoneMask) => {
          if (!loop || loop.n < 3) return 0;
          const xs = loop.pts;
          let total = 0;
          for (let i = 1; i < loop.n; i++) {
            total += Math.hypot(xs[i * 2] - xs[(i - 1) * 2], xs[i * 2 + 1] - xs[(i - 1) * 2 + 1]);
          }
          total += Math.hypot(xs[0] - xs[(loop.n - 1) * 2], xs[1] - xs[(loop.n - 1) * 2 + 1]);
          if (total < 3) return 0;
          const maxLen = Math.max(180, Math.min(360, Math.min(W, H) * 0.26));
          const chunks = Math.max(1, Math.ceil(total / maxLen));
          const maxPt = Math.max(3, Math.ceil(loop.n / chunks));
          const hw = clamp(r.thickness * 0.22 + 1.6, 1.8, 5.2) * Math.min(1.15, scaleB + 0.12);
          const zmr = { m: zoneMask || r.fillMask, x0: r.x0, y0: r.y0, w: r.bw, h: r.bh };
          let made = 0;
          for (let a = 0; a < loop.n; a += Math.max(2, maxPt - 1)) {
            const b = Math.min(loop.n - 1, a + maxPt);
            if (b - a < 1) break;
            const n = b - a + 1;
            const sp = new Float64Array(n * 2), halfs = new Float64Array(n);
            for (let i = 0; i < n; i++) {
              const j = a + i;
              sp[i * 2] = r.x0 + xs[j * 2];
              sp[i * 2 + 1] = r.y0 + xs[j * 2 + 1];
              halfs[i] = hw * (0.82 + 0.18 * Math.sin(Math.PI * i / Math.max(1, n - 1))) *
                (0.92 + 0.16 * srnd(r.id * 5.3 + a * 0.17 + i, 4.2));
            }
            const si = emitStroke(sp, halfs, r.color, ph, {
              zoneMaskRect: zmr, color: r.color, noCover: 1, noZone: 1,
              ignoreCap: 1, minInk: 1, ms: Math.round(55 + total / chunks * 1.8),
            });
            if (si >= 0) {
              strokes[si].stage = stage;
              strokes[si].travelK = 0.12;
              strokes[si].fl = 1;
              made++;
            }
            if (b >= loop.n - 1) break;
          }
          return made;
        };
        const fillStrips = (r, mask, ph, stage, localColors) => {
          const zmr = { m: mask, x0: r.x0, y0: r.y0, w: r.bw, h: r.bh };
          let ang = r.angle;
          if (r.area > N * 0.20 || r.bw > r.bh * 1.8) ang = 0;
          else if (r.bh > r.bw * 1.8) ang = Math.PI * 0.5;
          ang += (srnd(r.id * 2.7 + runSeed * 0.013, 3.4) - 0.5) * 0.035;
          const ca = Math.cos(ang), sa = Math.sin(ang);
          const cx = (r.x0 + r.x1) * 0.5, cy = (r.y0 + r.y1) * 0.5;
          let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
          for (const [x, y] of [[r.x0 - cx, r.y0 - cy], [r.x1 - cx, r.y0 - cy],
            [r.x1 - cx, r.y1 - cy], [r.x0 - cx, r.y1 - cy]]) {
            const u = x * ca + y * sa, v = -x * sa + y * ca;
            if (u < uMin) uMin = u; if (u > uMax) uMax = u;
            if (v < vMin) vMin = v; if (v > vMax) vMax = v;
          }
          let halfW;
          if (r.mode === 'line') {
            halfW = clamp(r.thickness * 0.62 + 1.0, 1.4, 5.0);
          } else if (r.mode === 'ring') {
            halfW = clamp(Math.min(r.bw, r.bh) * 0.28, 2.2, 24 * scaleB);
          } else {
            halfW = clamp(Math.sqrt(Math.max(8, r.fillArea)) * 0.055, 3.2, 48 * scaleB);
          }
          const step = Math.max(2.0, halfW * 1.12);
          const span = Math.max(1, vMax - vMin);
          const rows = Math.max(1, Math.ceil(span / step));
          const uA = uMin - halfW * 1.15, uB = uMax + halfW * 1.15;
          let made = 0;
          for (let ri = 0; ri < rows; ri++) {
            const f = rows === 1 ? 0.5 : ri / (rows - 1);
            const v = vMin + span * f;
            const n = Math.max(3, Math.min(9, Math.round((uB - uA) / 90) + 2));
            const sp = new Float64Array(n * 2), halfs = new Float64Array(n);
            const bow = (srnd(r.id * 7.1 + ri * 1.37 + runSeed * 0.017, 5.8) - 0.5) * halfW * 0.12;
            for (let i = 0; i < n; i++) {
              const ff = i / (n - 1);
              const u = uA + (uB - uA) * ff;
              const vv = v + bow * Math.sin(Math.PI * ff);
              sp[i * 2] = cx + u * ca - vv * sa;
              sp[i * 2 + 1] = cy + u * sa + vv * ca;
              halfs[i] = halfW * (0.93 + 0.07 * Math.sin(Math.PI * ff)) *
                (0.94 + 0.12 * srnd(r.id * 2.9 + ri * 0.31 + i, 6.1));
            }
            const mx = Math.round((sp[0] + sp[(n - 1) * 2]) * 0.5);
            const my = Math.round((sp[1] + sp[(n - 1) * 2 + 1]) * 0.5);
            const c = localColors && r.model && r.model.colorAt
              ? r.model.colorAt(mx, my) : r.color;
            const si = emitStroke(sp, halfs, c, ph, {
              zoneMaskRect: zmr, color: c, noCover: 1, noZone: 1,
              ignoreCap: 1, minInk: 1, ms: Math.round(45 + (uB - uA) * 1.7),
            });
            if (si >= 0) {
              strokes[si].stage = stage;
              strokes[si].travelK = 0.06;
              strokes[si].fl = 1;
              made++;
            }
          }
          return made;
        };
        const paintLineRegion = (r, ph) => {
          const paths = traceMaskPaths(r.fillMask, r.bw, r.bh, r.x0, r.y0);
          if (!paths.length) return fillStrips(r, r.fillMask, ph, 'closed:line-fallback');
          const zmr = { m: r.fillMask, x0: r.x0, y0: r.y0, w: r.bw, h: r.bh };
          const hw = clamp(r.thickness * 0.65 + 0.9, 1.3, 4.8);
          let made = 0;
          for (const path of paths) {
            for (const part of splitSkPath(path, 260)) {
              if (part.n < 2) continue;
              const halfs = profFill(part.n, hw, r.id * 2.1 + part.len * 0.13 + runSeed * 0.31);
              const si = emitStroke(part.pts, halfs, r.color, ph, {
                zoneMaskRect: zmr, color: r.color, noCover: 1, noZone: 1,
                ignoreCap: 1, minInk: 1, ms: Math.round(35 + part.len * 1.6),
              });
              if (si >= 0) {
                strokes[si].stage = 'closed:line';
                strokes[si].travelK = 0.20;
                strokes[si].fl = 1;
                made++;
              }
            }
          }
          if (!made) made = fillStrips(r, r.fillMask, ph, 'closed:line-fallback');
          return made;
        };
        // 实心色块不再由扫带拼出来：轮廓完成后直接把闭合领地作为一个原子
        // 色块落下。这样时间轴上不会出现“扫到一半、字和飞机位置仍是白纸”
        // 的假洞；内部异色随后由包含树中的子区域覆盖回来。
        const fillAtomicBlock = (r, ph, stage) => {
          const mask = r.paintMask || r.fillMask || r.mask;
          const si = emitBlockFill(r.x0, r.y0, r.bw, r.bh, mask, r.color, ph, {
            stage: stage,
            ms: Math.round(120 + Math.min(260, Math.sqrt(Math.max(1, r.area)) * 0.18)),
          });
          return si >= 0 ? 1 : 0;
        };
        let done = 0;
        const stepProgress = async (r) => {
          done++;
          if ((done & 15) === 0) {
            prog(0.70 + 0.22 * done / Math.max(1, order.length),
              r.mode === 'solid' ? '绕边落块：完整色块铺满后再画子区域…' : '逐层完成：轮廓与细节…');
            await yieldUI();
          }
        };
        // 页面底板必须先形成完整底色。它们是几何意义上的页面根块，不依赖
        // 文件名、固定颜色或样例坐标；先于所有普通对象落下，后续对象再覆盖。
        const pageBlocks = order.filter((r) => pageBaseCandidate(r));
        const pageBlockSet = new Set(pageBlocks);
        const groundFragments = closedPlan.groundFragments || new Set();
        // 页面底板的可见色面会被文字和图案挖出很多“假内轮廓”。底板先用
        // 完整闭合 mask 求最大的外环，再沿这个外环描边；内部缺口交给子对象。
        const outerLoopOfMask = (r, mask) => {
          if (!mask) return r.outer;
          const loops = traceContours(mask, -1, -1, r.bw, r.bh, { w: r.bw, h: r.bh });
          let best = null, bestA = 0;
          for (const lp of loops) {
            let a = 0;
            for (let i = 0; i < lp.n; i++) {
              const j = (i + 1) % lp.n;
              a += lp.pts[i * 2] * lp.pts[j * 2 + 1] - lp.pts[j * 2] * lp.pts[i * 2 + 1];
            }
            a = Math.abs(a) * 0.5;
            if (a > bestA) { bestA = a; best = lp; }
          }
          return best || r.outer;
        };
        // 原子底板负责连续色面，随后只从“页面自身可见像素”重建低频明暗和
        // 纸张颗粒。不能按原始色组整组重画：色组会把文字/飞机的抗锯齿边
        // 当成蓝色背景的一部分，导致主体尚未落笔就出现整页鬼影。这里直接
        // 使用页面区域的连续色场，并用纯页面色芯校正局部颗粒；所有纹理笔
        // 都裁在闭合页面领地内，内部异色仍由后续对象完整覆盖。
        const fillPageTexture = (r, ph) => {
          const ground = r.paintMask || r.groundMask || r.fillMask;
          if (!ground || !r.mask) return 0;
          const textureFrom = strokes.length;
          const zmr = { m: ground, x0: r.x0, y0: r.y0, w: r.bw, h: r.bh };
          const pageW = r.bw, pageH = r.bh;
          const base = r.color;
          const sampleCore = (xc, yc, sigma, minPure) => {
            const radius = sigma * 2.15;
            const iy0 = Math.max(0, Math.floor(yc - radius));
            const iy1 = Math.min(r.bh - 1, Math.ceil(yc + radius));
            const ix0 = Math.max(0, Math.floor(xc - radius));
            const ix1 = Math.min(r.bw - 1, Math.ceil(xc + radius));
            const inv2 = 1 / (2 * sigma * sigma);
            let sr = 0, sg = 0, sb = 0, sw = 0, pure = 0;
            for (let yy = iy0; yy <= iy1; yy++) {
              const row = yy * r.bw;
              for (let xx = ix0; xx <= ix1; xx++) {
                if (!r.mask[row + xx] || !ground[row + xx]) continue;
                // 3×3 都是页面本源像素才是可靠色芯；抗锯齿边和贴边噪声
                // 即使标成页面色，也不会进入局部采样窗。
                let core = true;
                for (let dy = -1; dy <= 1 && core; dy++) {
                  const ny = yy + dy;
                  if (ny < 0 || ny >= r.bh) { core = false; break; }
                  for (let dx = -1; dx <= 1; dx++) {
                    const nx = xx + dx;
                    if (nx < 0 || nx >= r.bw || !r.mask[ny * r.bw + nx]) { core = false; break; }
                  }
                }
                if (!core) continue;
                const dx = xx - xc, dy = yy - yc;
                const wgt = Math.exp(-(dx * dx + dy * dy) * inv2);
                const p = (r.y0 + yy) * W + r.x0 + xx;
                sr += R[p] * wgt; sg += G[p] * wgt; sb += B[p] * wgt; sw += wgt; pure++;
              }
            }
            return pure >= minPure && sw > 0 ? [sr / sw, sg / sw, sb / sw] : null;
          };
          // 在页面自身色芯上建立一张低分辨率连续色场。每个节点只从
          // 3×3 纯页面像素取样，随后做空洞扩散和一次低通，最后双线性读取。
          // 这样宽笔之间共享连续色值，不会像逐笔局部均值那样留下阶梯状云斑。
          const cell = clamp(Math.round(Math.min(W, H) * 0.024), 14, 28);
          const gx = Math.max(3, Math.ceil(pageW / cell) + 1);
          const gy = Math.max(3, Math.ceil(pageH / cell) + 1);
          const grid = new Float32Array(gx * gy * 3);
          const valid = new Uint8Array(gx * gy);
          for (let yy = 0; yy < gy; yy++) {
            const yc = pageH * yy / (gy - 1);
            for (let xx = 0; xx < gx; xx++) {
              const xc = pageW * xx / (gx - 1);
              const c0 = sampleCore(xc, yc, cell * 1.10, 8);
              if (!c0) continue;
              const gi = yy * gx + xx;
              valid[gi] = 1;
              grid[gi * 3] = c0[0]; grid[gi * 3 + 1] = c0[1]; grid[gi * 3 + 2] = c0[2];
            }
          }
          for (let pass = 0; pass < gx + gy; pass++) {
            let changed = 0;
            const src = grid.slice(), srcValid = valid.slice();
            for (let yy = 0; yy < gy; yy++) for (let xx = 0; xx < gx; xx++) {
              const gi = yy * gx + xx;
              if (srcValid[gi]) continue;
              let sr = 0, sg = 0, sb = 0, n = 0;
              for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const nx = xx + dx, ny = yy + dy;
                if (nx < 0 || ny < 0 || nx >= gx || ny >= gy) continue;
                const ni = ny * gx + nx;
                if (!srcValid[ni]) continue;
                sr += src[ni * 3]; sg += src[ni * 3 + 1]; sb += src[ni * 3 + 2]; n++;
              }
              if (!n) continue;
              grid[gi * 3] = sr / n; grid[gi * 3 + 1] = sg / n; grid[gi * 3 + 2] = sb / n;
              valid[gi] = 1; changed++;
            }
            if (!changed) break;
          }
          // 未采样到任何页面色芯的节点退回页面代表色，保证色场完整。
          for (let gi = 0; gi < gx * gy; gi++) if (!valid[gi]) {
            grid[gi * 3] = base[0]; grid[gi * 3 + 1] = base[1]; grid[gi * 3 + 2] = base[2];
          }
          for (let pass = 0; pass < 2; pass++) {
            const src = grid.slice();
            for (let yy = 0; yy < gy; yy++) for (let xx = 0; xx < gx; xx++) {
              let sr = 0, sg = 0, sb = 0, n = 0;
              for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const nx = xx + dx, ny = yy + dy;
                if (nx < 0 || ny < 0 || nx >= gx || ny >= gy) continue;
                const ni = ny * gx + nx;
                sr += src[ni * 3]; sg += src[ni * 3 + 1]; sb += src[ni * 3 + 2]; n++;
              }
              const gi = yy * gx + xx;
              grid[gi * 3] = sr / n; grid[gi * 3 + 1] = sg / n; grid[gi * 3 + 2] = sb / n;
            }
          }
          const fieldAt = (x, y) => {
            const fx = clamp(x / Math.max(1, pageW - 1), 0, 1) * (gx - 1);
            const fy = clamp(y / Math.max(1, pageH - 1), 0, 1) * (gy - 1);
            const ix = Math.min(gx - 1, Math.floor(fx)), iy = Math.min(gy - 1, Math.floor(fy));
            const ix1 = Math.min(gx - 1, ix + 1), iy1 = Math.min(gy - 1, iy + 1);
            const tx = fx - ix, ty = fy - iy;
            const out = [0, 0, 0];
            for (let ch = 0; ch < 3; ch++) {
              const a = grid[(iy * gx + ix) * 3 + ch], b = grid[(iy * gx + ix1) * 3 + ch];
              const c = grid[(iy1 * gx + ix) * 3 + ch], d = grid[(iy1 * gx + ix1) * 3 + ch];
              out[ch] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
            }
            return out;
          };
          const emitPageStroke = (sp, halfs, col, ms) => {
            const si = emitStroke(sp, halfs, col, ph, {
              zoneMaskRect: zmr, color: col, noCover: 1, noZone: 1,
              ignoreCap: 1, minInk: 1, ms: ms,
            });
            if (si < 0) return 0;
            strokes[si].stage = 'closed:page-texture';
            strokes[si].travelK = 0.055;
            strokes[si].fl = 1;
            return 1;
          };
          let made = 0;
          // 第一层：连续横向宽笔。色场由页面自身拟合，跨过文字/图形空洞时
          // 只做邻域插值，不会把前景色带进来；原子块保证任何空隙仍是底色。
          const band = clamp(Math.round(Math.min(W, H) * 0.032), 24, 40);
          const hw = band * 0.58;
          const stepY = Math.max(10, Math.round(band * 0.62));
          const nominal = Math.max(42, Math.round(band * 2.05));
          const overlap = nominal * 0.42;
          let row = 0;
          for (let y = r.y0 - hw * 0.25; y <= r.y1 + hw * 0.25; y += stepY, row++) {
            const yc = y + (srnd(r.id * 4.7 + row * 1.91 + runSeed * 0.013, 5.7) - 0.5) * stepY * 0.30;
            let x = r.x0 - hw * 0.35 +
              (srnd(r.id * 2.3 + row * 1.37 + runSeed * 0.017, 6.1) - 0.5) * nominal * 0.45;
            let seg = 0;
            while (x < r.x1 + hw * 0.35) {
              const len = nominal * (0.82 + 0.36 * srnd(r.id * 3.1 + row * 0.73 + seg * 1.67, 7.3));
              const xa = x, xb = Math.min(r.x1 + hw * 0.35, x + len);
              if (xb - xa < 5) break;
              const mx = Math.max(r.x0, Math.min(r.x1, Math.round((xa + xb) * 0.5)));
              const my = Math.max(r.y0, Math.min(r.y1, Math.round(yc)));
              const c = fieldAt(mx - r.x0, my - r.y0).map(Math.round);
              const sp = new Float64Array(6), halfs = new Float64Array(3);
              const bow = (srnd(r.id * 6.7 + row * 1.13 + seg * 2.21 + runSeed * 0.01, 4.9) - 0.5) * hw * 0.18;
              for (let i = 0; i < 3; i++) {
                const f = i / 2;
                sp[i * 2] = xa + (xb - xa) * f;
                sp[i * 2 + 1] = yc + bow * Math.sin(Math.PI * f);
                halfs[i] = hw * (0.94 + 0.06 * Math.sin(Math.PI * f));
              }
              made += emitPageStroke(sp, halfs, c, Math.round(18 + (xb - xa) * 0.22));
              x += Math.max(12, len - overlap);
              seg++;
            }
          }
          // 第二层：细颗粒只负责恢复原图的扫描/纸张微差。采样窗找不到
          // 足够纯页面色芯时直接跳过，宁可平滑也绝不提前画出前景轮廓。
          const microN = Math.max(1600, Math.min(4200,
            Math.round(pageW * pageH / 300)));
          const microHw = Math.max(2.2, band * 0.095);
          for (let i = 0; i < microN; i++) {
            // 随机散点而不是整齐网格：细纹理的本职是把宽笔留下的边界打散，
            // 规则行距反而会形成新的横向条纹。
            const jx = srnd(r.id * 11.3 + i * 1.731 + runSeed * 0.019, 8.9);
            const jy = srnd(r.id * 7.7 + i * 2.173 + runSeed * 0.023, 9.3);
            const x = r.x0 + jx * Math.max(1, pageW - 1);
            const y = r.y0 + jy * Math.max(1, pageH - 1);
            const local = sampleCore(x - r.x0, y - r.y0, 2.1, 10);
            if (!local) continue;
            const field = fieldAt(x - r.x0, y - r.y0);
            const c = [field[0] * 0.34 + local[0] * 0.66,
              field[1] * 0.34 + local[1] * 0.66,
              field[2] * 0.34 + local[2] * 0.66].map((v) => Math.round(clamp(v, 0, 255)));
            const ang = (srnd(r.id * 8.7 + i * 1.37 + runSeed * 0.007, 7.3) - 0.5) * 0.52;
            const ca = Math.cos(ang), sa = Math.sin(ang);
            const len = band * (1.05 + 0.55 * srnd(r.id * 4.9 + i * 2.11, 6.7));
            const sp = new Float64Array([x - ca * len * 0.5, y - sa * len * 0.5,
              x, y, x + ca * len * 0.5, y + sa * len * 0.5]);
            const halfs = new Float64Array([microHw, microHw * 1.05, microHw]);
            made += emitPageStroke(sp, halfs, c, 14);
          }
          // 页面纹理是一个铺底事务，而不是几千个需要逐个展示的对象。
          // 按整段总时长归一，确保原子块落下后纹理在首个检查点前完成，
          // 不再出现“上半页浅蓝、下半页深蓝”的扫带过程。
          let textureMs = 0;
          for (let i = textureFrom; i < strokes.length; i++) textureMs += strokes[i].ms || 0;
          const textureBudget = Math.max(30, Math.min(90,
            Math.sqrt(Math.max(1, pageW * pageH)) * 0.0022));
          const textureK = textureMs > 0 ? textureBudget / textureMs : 1;
          for (let i = textureFrom; i < strokes.length; i++) strokes[i].ms *= textureK;
          if (opts.debug) console.log('[closed-page-texture] strokes=' + made +
            ' page=' + pageW + 'x' + pageH + ' ms=' + Math.round(textureBudget) +
            ' color=' + r.color.join(','));
          return made;
        };
        for (const r of pageBlocks) {
          const ph = regionPhase(r);
          const edgeLoop = outerLoopOfMask(r, r.paintMask);
          if (edgeLoop) contourStroke(r, edgeLoop, ph, 'closed:page-edge', r.paintMask);
          fillAtomicBlock(r, ph, 'closed:page-block');
          // 原子块负责“一次铺满”，随后用底板自己的连续色场补回扫描纸纹。
          // 纹理只落回真实可见的底板像素，不重新挖洞，也不会把文字颜色掺进来。
          fillPageTexture(r, ph);
          await stepProgress(r);
        }        for (const r of order) {
          if (pageBlockSet.has(r) || groundFragments.has(r)) continue;
          const ph = regionPhase(r);
          if (r.mode === 'line') {
            paintLineRegion(r, ph);
          } else if (r.mode === 'solid') {
            if (r.outer) contourStroke(r, r.outer, ph, 'closed:edge');
            fillAtomicBlock(r, ph, 'closed:block');
          } else {
            if (r.outer) contourStroke(r, r.outer, ph, 'closed:edge');
            if (r.mode === 'ring' && r.loops) {
              for (const lp of r.loops) if (lp !== r.outer) contourStroke(r, lp, ph, 'closed:inner-edge');
            }
            // 空心环和细线保留原算法，绝不能用实心块把内部填掉。
            fillStrips(r, r.mask, ph, 'closed:fill');
          }
          await stepProgress(r);
        }
        // 最终覆盖账以画布和原图的实际误差为准：父色暂时盖住子区不算“画准”，
        // 子区后来覆盖回来且颜色接近原图才算。错误像素统一留给最后的残差守卫。
        let good = 0, bad = 0;
        for (let p = 0; p < N; p++) {
          if (segPaper[p]) continue;
          const q = p * 3;
          const err = Math.max(Math.abs(canvas[q] - R[p]), Math.abs(canvas[q + 1] - G[p]),
            Math.abs(canvas[q + 2] - B[p]));
          // 平涂区域允许纸张纹理/抗锯齿带来的小幅色差；否则会把整片已填色误判成漏色。
          if (err <= 48) {
            covered[p] = 1; paintN[p] = 1; good++;
          } else bad++;
        }
        groupUncov.fill(0);
        for (let p = 0; p < N; p++) {
          if (segPaper[p] || covered[p]) continue;
          const gid = groupOf[p];
          if (gid >= 0) groupUncov[gid]++;
        }
        zoneCov += good;
        pfClosedRegions = order.length;
        pfObjects = order.length;
        pfRing = order.some((r) => r.mode === 'ring');
        painterBgFill = 'closed';
        if (opts.debug) console.log('[closed] done regions=' + order.length + ' good=' + good +
          ' bad=' + bad + ' strokes=' + strokes.length + ' ms=' + (Date.now() - tEx));
        await yieldUI();
      };

      // ---- 编译器执行器 ----
      // 父区域：外轮廓绕一圈 → 整个闭合 mask 填满（不查询 groupOf，所以内部异色也会
      // 暂时被父色覆盖）→ 子区域按包含树覆盖回来。所有块面完成后，线条候选最后绘制。
      const paintCompilerPlan = async () => {
        const plan = compilerPlan;
        const regionPhase = (r) => {
          if (r.depth <= 0) return 0;
          if (r.depth === 1) return r.fillArea >= N * 0.008 ? 1 : 2;
          return Math.min(3, r.depth + 1);
        };
        const emitMasked = (sp, halfs, col, ph, zmr, stage, ms, localColor) => {
          const si = emitStroke(sp, halfs, col, ph, {
            // noCover 关闭后，笔实际触达的像素才算“覆盖率”；颜色误差仍由
            // quality 单独统计，不再把“已画但误差较大”误报成漏画。
            zoneMaskRect: zmr, color: localColor ? undefined : col, localColor: localColor ? 1 : 0, noCover: 0, noZone: 1,
            ignoreCap: 1, minInk: 1, ms: ms || Math.round(45 + halfs[0] * 12),
          });
          if (si >= 0) {
            strokes[si].stage = stage;
            strokes[si].travelK = stage === 'compiler:edge' ? 0.12 : 0.06;
            strokes[si].fl = 1;
          }
          return si;
        };
        const contourStroke = (r, loop, ph, stage) => {
          if (!loop || loop.n < 3) return 0;
          const xs = loop.pts;
          let total = 0;
          const segLen = [];
          for (let i = 0; i < loop.n; i++) {
            const j = (i + 1) % loop.n;
            const d = Math.hypot(xs[j * 2] - xs[i * 2], xs[j * 2 + 1] - xs[i * 2 + 1]);
            segLen.push(d); total += d;
          }
          if (total < 3) return 0;
          const maxLen = Math.max(170, Math.min(340, Math.min(W, H) * 0.25));
          const pieces = Math.max(1, Math.ceil(total / maxLen));
          const target = total / pieces;
          const zmr = { m: r.fillMask, x0: r.x0, y0: r.y0, w: r.bw, h: r.bh };
          const hw = clamp((r.mode === 'ring' ? r.thickness * 0.42 : r.thickness * 0.24) + 1.4,
            1.5, 6.2) * Math.min(1.15, scaleB + 0.12);
          let made = 0, a = 0, acc = 0;
          for (let cut = 0; cut < pieces && a < loop.n; cut++) {
            let b = a, run = 0;
            while (b < loop.n && (run + segLen[b] <= target * 1.08 || b === a)) { run += segLen[b]; b++; }
            if (b > loop.n) b = loop.n;
            if (b - a >= 2 || (a === 0 && b === 1)) {
              const n = Math.max(3, b - a + 1);
              const sp = new Float64Array(n * 2), halfs = new Float64Array(n);
              for (let i = 0; i < n; i++) {
                const j = Math.min(loop.n - 1, a + Math.round((b - a) * i / (n - 1)));
                sp[i * 2] = r.x0 + xs[j * 2];
                sp[i * 2 + 1] = r.y0 + xs[j * 2 + 1];
                halfs[i] = hw * (0.84 + 0.16 * Math.sin(Math.PI * i / (n - 1))) *
                  (0.94 + 0.12 * srnd(r.id * 5.3 + j * 0.17 + i, 4.2));
              }
              const c = r.model.colorAt(Math.round((sp[0] + sp[(n - 1) * 2]) * 0.5),
                Math.round((sp[1] + sp[(n - 1) * 2 + 1]) * 0.5));
              const si = emitMasked(sp, halfs, c, ph, zmr, stage, Math.round(55 + run * 1.8), 1);
              if (si >= 0) made++;
            }
            a = Math.max(a + 1, b - 1); acc += run;
            if (b >= loop.n || acc >= total * 0.995) break;
          }
          return made;
        };
        const fillRegion = (r, mask, ph, stage, colorOverride, localColors) => {
          const zmr = { m: mask, x0: r.x0, y0: r.y0, w: r.bw, h: r.bh };
          let ang = r.angle;
          if (r.fillArea > N * 0.16 || r.bw > r.bh * 1.7) ang = 0;
          else if (r.bh > r.bw * 1.7) ang = Math.PI * 0.5;
          ang += (srnd(r.id * 2.9 + runSeed * 0.013, 3.4) - 0.5) * 0.035;
          const ca = Math.cos(ang), sa = Math.sin(ang);
          const cx = (r.x0 + r.x1) * 0.5, cy = (r.y0 + r.y1) * 0.5;
          let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
          for (const [x, y] of [[r.x0 - cx, r.y0 - cy], [r.x1 - cx, r.y0 - cy],
            [r.x1 - cx, r.y1 - cy], [r.x0 - cx, r.y1 - cy]]) {
            const u = x * ca + y * sa, v = -x * sa + y * ca;
            if (u < uMin) uMin = u; if (u > uMax) uMax = u;
            if (v < vMin) vMin = v; if (v > vMax) vMax = v;
          }
          let halfW;
          if (r.mode === 'line') halfW = clamp(r.thickness * 0.62 + 1.0, 1.3, 4.8);
          else if (r.mode === 'ring') halfW = clamp(Math.min(r.bw, r.bh) * 0.24, 2.0, 22 * scaleB);
          else halfW = clamp(Math.sqrt(Math.max(8, r.fillArea)) * 0.055, 3.2, 52 * scaleB);
          // 一条扫带就是一笔，mask 在 emitStroke 内部按像素裁切；不再把
          // 每个连通 run 拆成多笔。这样既保留闭合填充的几何，又显著减少接缝。
          const step = Math.max(1.8, halfW * 0.82);
          const span = Math.max(1, vMax - vMin);
          const rows = Math.max(1, Math.ceil(span / step));
          const uA = uMin - halfW * 1.12, uB = uMax + halfW * 1.12;
          let made = 0;
          const runLen = uB - uA;
          // 一色一笔会丢掉横向渐变：海报蓝底这种 700px 宽扫带如果只用中心
          // 采样，左右两端都会被同一个中间色覆盖，成品就出现云状块。按色场
          // 变化把扫带切成连续短段，每段在自己的中点取色；父区域仍是完整
          // 闭合填充，只是把连续渐变更忠实地落下来。
          const richRun = r.fillArea >= 100000;
          const constKind = String.fromCharCode(99,111,110,115,116);
          const segN = (r.model.kind === constKind || runLen < 110)
            ? 1 : Math.max(2, Math.min(richRun ? 18 : 9, Math.ceil(runLen / ((richRun ? 48 : 115) * Math.max(0.8, scaleB)))));
          for (let ri = 0; ri < rows; ri++) {
            const f = rows === 1 ? 0.5 : ri / (rows - 1);
            const v = vMin + span * f;
            const bow = (srnd(r.id * 7.1 + ri * 1.37 + runSeed * 0.017, 5.8) - 0.5) * halfW * 0.10;
            for (let sg = 0; sg < segN; sg++) {
              const sa0 = runLen * sg / segN, sa1 = runLen * (sg + 1) / segN;
              const segLen = sa1 - sa0;
              const n = Math.max(3, Math.min(12, Math.round(segLen / 55) + 2));
              const sp = new Float64Array(n * 2), halfs = new Float64Array(n);
              for (let i = 0; i < n; i++) {
                const ff = i / (n - 1), u = uA + sa0 + segLen * ff;
                const vv = v + bow * Math.sin(Math.PI * ff);
                sp[i * 2] = cx + u * ca - vv * sa;
                sp[i * 2 + 1] = cy + u * sa + vv * ca;
                halfs[i] = halfW * (0.93 + 0.07 * Math.sin(Math.PI * ff)) *
                  (0.94 + 0.12 * srnd(r.id * 2.9 + ri * 0.31 + sg * 0.13 + i, 6.1));
              }
              const um = uA + (sa0 + sa1) * 0.5;
              const mx = Math.round(cx + um * ca - v * sa);
              const my = Math.round(cy + um * sa + v * ca);
              const c = colorOverride || r.model.colorAt(mx, my);
              const si = emitMasked(sp, halfs, c, ph, zmr, stage,
                Math.round(35 + segLen * 1.7), localColors ? 1 : 0);
              if (si >= 0) made++;
            }
          }
          return made;
        };
        // 父块整块填色不能只依赖稀疏扫带：圆形、斜边和尖角在扫带端头容易
        // 留下几个像素的暗色缺口。这里先保留普通扫带的笔触，再用逐行
        // 连续 run 做一次密集补满。所有笔仍严格裁在同一个父 mask 内，
        // 颜色也只有一个父色，因此不会形成新的色块或接缝。
        // 实心父块/普通色块只发出一个原子色块事件。内部异色先被父色完整
        // 覆盖，随后由包含树中的子区域按层级恢复；色块内部不再生成扫带。
        const fillParentMask = (r, mask, ph, color, stage, opt) => {
          opt = opt || {};
          const si = emitBlockFill(r.x0, r.y0, r.bw, r.bh, mask, color, ph, {
            stage: stage,
            ms: Math.round(150 + Math.min(260, Math.sqrt(Math.max(1, r.fillArea)) * 0.20)),
          });
          let made = si >= 0 ? 1 : 0;
          // 原子块先保证“整个色块一次出现”；非纯色叶子随后用局部原色补
          // 一层低权重纹理。这样既保留块面语义，也不会把一个有明暗/渐变的
          // 区域永久压成单一均值。父块不在这里补纹理，内部由子区域恢复。
          if (si >= 0 && opt.localTexture && r.model && r.model.kind !== 'const') {
            const texFrom = strokes.length;
            // 纹理只覆盖原图里真实可见的本色像素；闭包中属于子孙对象的
            // 占位像素由子孙层恢复，不在底色纹理阶段反复涂改。
            fillRegion(r, r.mask || mask, ph, stage + '-texture', null, 1);
            for (let i = texFrom; i < strokes.length; i++) strokes[i].ms *= 0.22;
            made += strokes.length - texFrom;
          }
          return made;
        };

        // 只有真正的页面根底板使用一个原子块。背景纹理/暗角仍由后面的
        // 背景细节层补充，但它们不能再改变"底色块一次铺满"的语义。
        const fillPageLike = (r, ph) => {
          const ground = r.paintMask || r.groundMask || r.fillMask;
          const color = (bgFirstPlan && bgFirstPlan.washColor) || r.color || r.model.mean;
          const si = emitBlockFill(r.x0, r.y0, r.bw, r.bh, ground, color, ph, {
            stage: 'compiler:page-block',
            ms: Math.round(180 + Math.min(320, Math.sqrt(Math.max(1, r.fillArea)) * 0.22)),
          });
          return si >= 0 ? 1 : 0;
        };

        // 页面底色本身是一个完整色块：先定义闭合区域，再一次性落下。
        // 后续扫带只负责纹理，不再承担"把纸铺满"的职责。
        const fillPageUndercoat = (r, ph) => {
          const wm = r.paintMask || r.groundMask || r.fillMask;
          const color = (bgFirstPlan && bgFirstPlan.washColor) || r.color;
          const si = emitBlockFill(r.x0, r.y0, r.bw, r.bh, wm, color, ph, {
            stage: 'compiler:page-block',
            ms: Math.round(180 + Math.min(320, Math.sqrt(Math.max(1, r.fillArea)) * 0.22)),
          });
          return si >= 0 ? 1 : 0;
        };

        const paintPageParity = (r, ph) => {
          compilerPlan.pageParityUsed = true;
          let made = fillPageUndercoat(r, ph);
          // 页面根底板拥有的原始色组，是旧 artist 真正用来铺准背景的单位。
          // 这里按像素所有权而不是按颜色硬筛：只要一组的大部分像素仍归页面
          // 底板所有，它就是背景纹理/暗角/抗锯齿，必须按原组精确重铺。
          const isPageGroundPixel = (p) => {
            const oid = plan.owner[p];
            const rr = oid >= 0 ? plan.regions[oid] : null;
            return !!(rr && rr.pageGround);
          };
          const bgGroups = [];
          const groundMean = (r.model && r.model.mean) || r.color || [0, 0, 0];
          // 底板纹理只能取“与底板同色族”的碎组。所有权图会把部分字的
          // 抗锯齿边缘留在页面根上；若只按 own>=50% 收集，整页文字会先在
          // 15% 处以鬼影形式出现。这里用相对底板代表色的色差自适应过滤，
          // 不依赖具体颜色或样例：渐变/暗角仍保留，红字、奶油字心等异色
          // 边缘留给对象事务。
          const groundGate = 56;
          // 只把真正成片的页面色场当成底板纹理。文字/描边旁的抗锯齿
          // 碎片面积小、所有权混杂，重画后会在主体尚未落笔时泄露整页
          // 鬼影；它们由后续对象事务和细节笔负责，不能提前参与底板。
          const bgMinArea = Math.max(300, Math.round(N * 0.00045));
          const bgOwnMin = 0.85;
          let filteredGroups = 0;
          for (const g of groups) {
            if (!g || g.area <= 0) continue;
            const gap = Math.max(Math.abs(g.mean[0] - groundMean[0]),
              Math.abs(g.mean[1] - groundMean[1]), Math.abs(g.mean[2] - groundMean[2]));
            if (g.area < bgMinArea || gap > groundGate) { filteredGroups++; continue; }
            let own = 0;
            const x0 = Math.max(0, g.x0), y0 = Math.max(0, g.y0);
            const x1 = Math.min(W - 1, g.x1), y1 = Math.min(H - 1, g.y1);
            for (let y = y0; y <= y1; y++) {
              const row = y * W;
              for (let x = x0; x <= x1; x++) {
                const p = row + x;
                if (groupOf[p] === g.gid && isPageGroundPixel(p)) own++;
              }
            }
            if (own >= Math.max(1, g.area * bgOwnMin)) bgGroups.push(g);
          }
          bgGroups.sort((a, b) => b.area - a.area);
          // 逐组重铺必须裁在原色组 mask 内，颜色取该组真实局部色；顺序只在
          // 组间不重叠的像素上决定最后一笔，不会产生新的跨区域色块。
          for (const g of bgGroups) {
            const start = strokes.length;
            // 原子底板已经把这页标成已覆盖；背景纹理组若不重置覆盖账，
            // paintFull 的零增益判定会把它们全部删掉，最终只剩一个平色块。
            // 这里只重置本组自己的像素和未覆盖计数，不碰其他组的所有权。
            for (let yy = g.y0; yy <= g.y1; yy++) {
              const row = yy * W;
              for (let xx = g.x0; xx <= g.x1; xx++) {
                const p = row + xx;
                if (groupOf[p] === g.gid) paintN[p] = 0;
              }
            }
            groupUncov[g.gid] = g.area;
            paintFull(g, 1);
            for (let i = start; i < strokes.length; i++) {
              strokes[i].stage = 'compiler:page-bg';
              strokes[i].travelK = 0.055;
              strokes[i].fl = 1;
              // 背景纹理是快速铺色，不是观众需要逐笔审视的主体事务。
              // 压低这些小笔的时间权重，避免 10k 个底色抖动吞掉近半条时间线；
              // 最终像素和笔数完全不变，只让主体对象更早进入画面。
              strokes[i].ms *= 0.10;
            }
            if (strokes.length > start) made += strokes.length - start;
          }
          if (opts.debug) console.log('[compiler-page] bgGroups=' + bgGroups.length +
            ' filtered=' + filteredGroups + ' strokes=' + made + ' root=' + r.id);
          return made;
        };

        const paintLineRegion = (r, ph, fine) => {
          const paths = traceMaskPaths(r.mask, r.bw, r.bh, r.x0, r.y0);
          if (!paths.length) return fillRegion(r, r.fillMask, ph, 'compiler:line-fallback');
          const zmr = { m: r.fillMask, x0: r.x0, y0: r.y0, w: r.bw, h: r.bh };
          const hw = clamp(r.thickness * 0.68 + 0.85, 1.2, 5.0);
          // 高精度描边：按真实色带的内切半径给笔身，并缩短取色段。每条短段
          // 的 localColor 只统计本笔在描边掩膜内盖到的像素，亮边/暗边不会被
          // 一个长段的中点色抹平。
          const dtv = fine ? distanceTransform(r.mask, r.bw, r.bh) : null;
          const dtAt = (x, y) => {
            const xx = Math.round(x) - r.x0, yy = Math.round(y) - r.y0;
            if (xx < 0 || yy < 0 || xx >= r.bw || yy >= r.bh) return 0;
            const d = dtv[yy * r.bw + xx];
            return d >= 1e8 ? 0 : d;
          };
          let made = 0;
          for (const path of paths) {
            for (const part of splitSkPath(path, fine ? 42 : 240)) {
              if (part.n < 2) continue;
              const halfs = new Float64Array(part.n);
              for (let i = 0; i < part.n; i++) {
                halfs[i] = fine
                  ? clamp(dtAt(part.pts[i * 2], part.pts[i * 2 + 1]) / 3 * 1.35 + 1.25, 1.7, 7.5)
                  : profFill(part.n, hw, r.id * 2.1 + part.len * 0.13 + runSeed * 0.31)[i];
              }
              const mid = Math.max(0, part.n >> 1);
              const c = r.model.colorAt(Math.round(part.pts[mid * 2]), Math.round(part.pts[mid * 2 + 1]));
              const si = emitMasked(part.pts, halfs, c, ph, zmr, 'compiler:line',
                Math.round(35 + part.len * 1.6), 1);
              if (si >= 0) made++;
            }
          }
          return made || fillRegion(r, r.fillMask, ph, 'compiler:line-fallback', null, 1);
        };

        // 执行器按“对象事务”落笔，而不是先全图描边、再全图填色。
        // 中间过程因此与真人作画一致：一个对象完成外框、父填色、子区域、
        // 边缘和细节后才抬笔去下一个对象。规划仍使用完整的包含树和闭合 mask，
        // 这里只改变执行顺序，不针对文件名、坐标或画面内容做特判。
        const fillSet = new Set(plan.fills);
        // 页面底色常被扫描纹理/文字切断成多个 normalized 碎片。它们不是
        // 前景对象，而是页面色场的延伸；若把整块碎片当成一个事务，右侧
        // 半页会连同标题一起抢在其它对象前画完。这里只做结构性判定，
        // 不依赖颜色/坐标：凡是归一化并指回页面根锚点的区域都算背景边界。
        // 只有真正覆盖画幅、位于包含树根部的区域才是“页面底板”。局部大色块
        // 也可能带 pageGround 标记并用来合并扫描碎片，但归一到这种局部锚点的
        // 子块仍是对象自己的分层（例如圆盘的奶油色内层），不能被背景过滤跳过。
        const pageAnchor = (a) => !!pageBaseCandidate(a);
        const pageEdgeFragment = (r) => {
          const a = r && r.parent;
          if (!pageAnchor(a)) return false;
          const nearEdge = r.x0 <= W * 0.06 || r.x1 >= W * 0.94 ||
            r.y0 <= H * 0.06 || r.y1 >= H * 0.94;
          const narrow = r.bw <= W * 0.32 || r.bh <= H * 0.32;
          const lowInk = r.rawFill <= 0.22;
          const gap = Math.max(Math.abs(r.color[0] - a.color[0]),
            Math.abs(r.color[1] - a.color[1]), Math.abs(r.color[2] - a.color[2]));
          // Scanned page margins are often one long, thin, low-fill root that
          // touches an edge and has nearly no interior of its own. Treating it
          // as an object lets a single region span several text lines and bridge
          // unrelated visual-line transactions.
          return nearEdge && narrow && lowInk && gap <= 40;
        };
        const backgroundLike = (r) => !!(r && ((r.pageGround && pageAnchor(r)) ||
          pageEdgeFragment(r) ||
          (plan.normalized.has(r) && r.modelFrom !== undefined &&
            pageAnchor(plan.regions[r.modelFrom]))));
        const inRegionHull = (r, x, y) => {
          const xx = Math.round(x) - r.x0, yy = Math.round(y) - r.y0;
          if (xx < 0 || yy < 0 || xx >= r.bw || yy >= r.bh) return false;
          return !!(r.hullMask && r.hullMask[yy * r.bw + xx]);
        };
        const txRootOf = (r) => {
          let t = r;
          while (t.parent && !backgroundLike(t.parent) && !t.parent.frameLike) t = t.parent;
          return t;
        };
        const readKey = (r) => {
          // 阅读顺序用对象左上角，而不是包围盒中心。高字母的 bbox 中心
          // 会下沉到下一行，导致标题被拆到段落之后才画。
          const rowH = Math.max(24, Math.min(84, H * 0.065));
          return Math.floor(r.y0 / rowH) * 100000 + r.x0;
        };
        const childKey = (r) => r.cy * W + r.cx;
        const tagTx = (from, txId) => {
          for (let i = from; i < strokes.length; i++) strokes[i].tx = txId;
        };
        const addObjectPause = (from, seed) => {
          if (strokes.length <= from) return;
          // 换对象时短暂“看”下一块。pause 落在一号笔上，不改变总笔数。
          strokes[from].ms += 150 + srnd(seed, 11.7) * 260;
          strokes[from].travelK = Math.max(0.16, strokes[from].travelK || 0.06);
        };

        // 底板先铺满，再落画框；两者都是独立大型事务。
        const pageFills = plan.fills.filter((r) => r.pageGround)
          .sort((a, b) => b.fillArea - a.fillArea);
        const frameFills = plan.fills.filter((r) => !r.pageGround &&
          (r.frameLike || r.canvasFrame)).sort((a, b) => b.fillArea - a.fillArea);
        const backgroundSet = new Set(pageFills.concat(frameFills));
        for (const r of plan.fills) if (backgroundLike(r)) backgroundSet.add(r);
        const paintRegionBase = (r, baseOpts) => {
          const ph = regionPhase(r);
          const skipOutline = !!(baseOpts && baseOpts.skipOutline);
          // 环形是真正的细线结构（字边、红描边、画框）：沿中心线绘制并逐段
          // 取局部原色，比用宽扫带覆盖整条环更贴近原图的明暗和抗锯齿。
          if (r.mode === 'ring') {
            if (r.children.length && r.hullMask) {
              // 外描边先绕边，再把闭合剪影完整铺成该层颜色。字心随后作为
              // 子区域覆盖中间，只留下描边和描边下方的抗锯齿底色。
              if (!skipOutline && r.outer) contourStroke(r, r.outer, ph, 'compiler:edge');
              fillParentMask(r, r.hullMask, ph, r.color, 'compiler:ring-parent');
            } else if (r.frameLike || r.thickness >= 12) {
              // 厚环不是一条中心线。按闭合环 mask 整块填满，避免粗画框
              // 只落下一根细线、周围反复露白。
              fillParentMask(r, r.fillMask, ph, r.color, 'compiler:ring-fill');
            } else {
              paintLineRegion(r, ph);
            }
            return;
          }
          // 外描边内部的暗边/抗锯齿细带属于同一圈描边，不是独立色块。
          // 对这类细子带沿中心线取局部色，避免把字边阴影刷成一条均值硬带。
          if (r.parent && r.parent.mode === 'ring' && r.thickness <= 6.5) {
            paintLineRegion(r, ph, true);
            return;
          }
          // 页面根底板的 outer 会沿扫描纹理/文字造成的内部断裂绕行，
          // 在底板尚未铺完时提前描出 “MAIL” 等轮廓。根底板边界由
          // groundMask 扫带裁切和独立画框事务负责，这里只描真正的对象。
          if (!skipOutline && r.outer && !r.pageGround) contourStroke(r, r.outer, ph, 'compiler:edge');
          // 只有真正的页面根底板使用连续扫带。被归一进底色的较大色块
          // 仍保留真实填充（否则 s8/s9 的内层底板会被外层纸色吞掉），但
          // 必须按自己的闭合 mask 普通填充，不能各自再铺一遍整页扫带。
          const pageLike = r.mode === 'solid' &&
            r.depth === 0 && r.fillArea >= N * 0.4 &&
            r.bw >= W * 0.75 && r.bh >= H * 0.75;
          if (pageLike) {
            // 只有“纹理/渐变底板”或“底板自身占主导且模型仍有残差”的
            // 扫描件才逐原组重铺。纯常数底板与填色线稿继续走 compiler 的
            // 低笔数色场，避免 s8 和矢量填色样例反向劣化。
            const rootOwn = r.fillArea / Math.max(1, r.bw * r.bh);
            const texturedRoot = !!(r.model && (r.model.kind !== 'const' ||
              (rootOwn >= 0.45 && (r.model.err || 0) >= 1)));
            if (texturedRoot) paintPageParity(r, ph);
            else fillPageLike(r, ph);
          } else {
            // 有子区域的实心父块同样使用自身代表色整体填满；内部异色
            // 暂时被覆盖，随后由包含树中的子区域逐层恢复。只有叶子
            // 区域保留自己的局部分析色场。
            const parentColor = r.children.length ? r.color : null;
            if (r.mode === 'solid') {
              // 实心叶子与实心父块都走原子色块；线稿和环形仍走各自
              // 的骨架/轮廓逻辑。
              fillParentMask(r, r.paintMask || r.fillMask, ph, parentColor || r.color,
                r.children.length ? 'compiler:parent-fill' : 'compiler:block-fill', {
                  localTexture: !r.children.length && r.fillArea >= 240 && (r.model.err || 0) >= 1.5,
                });
            } else {
              fillRegion(r, r.fillMask, ph, 'compiler:fill', null, r.mode === 'ring' ? 1 : 0);
            }
          }
        };

        // 大实心父块的原始 mask 通常只包含“确定属于本块”的像素。圆边、
        // 斜边和字角还有一圈 1px 的源图抗锯齿带，若只填父色就会留下
        // 孤立暗缺口。这里沿“膨胀 1px 与内缩 1px 之间”的几何边带追踪
        // 一条连续曲线，逐段读取源图局部色；不会扩大主体，也不会把整块
        // 边缘用一个均值刷平。
        const paintRegionRim = (r) => {
          if (r.mode !== 'solid' || r.pageGround || !r.children.length ||
            r.fillArea < N * 0.01 || !r.fillMask) return;
          const rim = dilate(r.fillMask, r.bw, r.bh, 1);
          const core = erode(r.fillMask, r.bw, r.bh, 1);
          const band = new Uint8Array(rim.length);
          for (let i = 0; i < rim.length; i++) band[i] = rim[i] && !core[i] ? 1 : 0;
          const paths = traceMaskPaths(band, r.bw, r.bh, r.x0, r.y0);
          const zmr = { m: band, x0: r.x0, y0: r.y0, w: r.bw, h: r.bh };
          for (const path of paths) {
            for (const part of splitSkPath(path, 54)) {
              if (part.n < 2) continue;
              const hb = new Float64Array(part.n);
              for (let i = 0; i < part.n; i++) {
                const f = i / Math.max(1, part.n - 1);
                hb[i] = 1.15 + 0.18 * Math.sin(Math.PI * f);
              }
              emitMasked(part.pts, hb, null, Math.min(3, Math.max(2, r.depth + 1)),
                zmr, 'compiler:edgeband', Math.round(18 + part.len * 0.35), 1);
            }
          }
        };
        const paintRingSeam = (r) => {
          if (r.mode === 'ring' && r.children.length) {
            paintLineRegion(r, Math.min(3, Math.max(2, r.depth + 1)), true);
          }
        };

        // 一页底板 / 画框事务。
        let bgDone = 0;
        for (const arr of [pageFills, frameFills]) {
          for (const r of arr) {
            const from = strokes.length;
            paintRegionBase(r);
            tagTx(from, 'bg:' + r.id);
            bgDone++;
            if ((bgDone & 3) === 0) {
              prog(0.69 + 0.20 * bgDone / Math.max(1, pageFills.length + frameFills.length),
                '编译器：铺满底板与画框…');
              await yieldUI();
            }
          }
        }

        // 每个顶层前景对象形成不可拆事务；内部父子仍严格由外到内。
        const txMap = new Map();
        for (const r of plan.fills) {
          if (backgroundSet.has(r)) continue;
          const root = txRootOf(r);
          if (!root) continue;
          let tx = txMap.get(root);
          if (!tx) {
            tx = { root, items: [], lines: [] };
            txMap.set(root, tx);
          }
          tx.items.push(r);
        }
        const transactions = [...txMap.values()].sort((a, b) => readKey(a.root) - readKey(b.root));
        const txOfRegion = new Map();
        for (const tx of transactions) for (const r of tx.items) txOfRegion.set(r, tx);
        // A glyph often has separate outline, fill and shadow roots, and scanned
        // text is split into many roots. Ordering those roots independently makes
        // one visual line appear as A -> M -> I -> R. Merge only the execution
        // layer into geometry-derived visual-line transactions; region trees,
        // masks, colors and stroke counts remain unchanged.
        const txBox = (tx) => {
          let x0 = W, y0 = H, x1 = -1, y1 = -1;
          for (const r of tx.items) {
            if (r.pageGround) continue;
            if (r.x0 < x0) x0 = r.x0; if (r.y0 < y0) y0 = r.y0;
            if (r.x1 > x1) x1 = r.x1; if (r.y1 > y1) y1 = r.y1;
          }
          if (x1 < x0 || y1 < y0) {
            const r = tx.root;
            x0 = r.x0; y0 = r.y0; x1 = r.x1; y1 = r.y1;
          }
          return { x0, y0, x1, y1, cx: (x0 + x1) * 0.5, cy: (y0 + y1) * 0.5 };
        };
        const mergeBox = (a, b) => {
          const x0 = Math.min(a.x0, b.x0), y0 = Math.min(a.y0, b.y0);
          const x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1);
          return { x0, y0, x1, y1, cx: (x0 + x1) * 0.5, cy: (y0 + y1) * 0.5 };
        };
        // Use the smaller object scale so a tall initial can join its word,
        // while neighboring rows, the airplane and following paragraphs cannot.
        const sameVisualLine = (a, b) => {
          const ha = Math.max(1, a.y1 - a.y0 + 1), hb = Math.max(1, b.y1 - b.y0 + 1);
          const minH = Math.min(ha, hb);
          const dy = Math.abs(a.cy - b.cy);
          const overlapY = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
          const gapX = Math.max(0, b.x0 - a.x1 - 1, a.x0 - b.x1 - 1);
          const maxDy = Math.max(6, minH * 0.45);
          const maxGapX = Math.max(8, minH * 0.58);
          return gapX <= maxGapX && dy <= maxDy &&
            (overlapY >= minH * 0.18 || dy <= minH * 0.30);
        };
        const txClusters = [];
        for (const tx of transactions) {
          let hit = null;
          const box = txBox(tx);
          for (const c of txClusters) {
            if (sameVisualLine(c.box, box)) { hit = c; break; }
          }
          if (!hit) {
            txClusters.push({ box, txs: [tx] });
          } else {
            hit.txs.push(tx);
            hit.box = mergeBox(hit.box, box);
            // A newly merged cluster may bridge two earlier clusters.
            let changed = true;
            while (changed) {
              changed = false;
              for (let i = txClusters.length - 1; i >= 0; i--) {
                const other = txClusters[i];
                if (other === hit || !sameVisualLine(hit.box, other.box)) continue;
                hit.txs.push(...other.txs);
                hit.box = mergeBox(hit.box, other.box);
                txClusters.splice(i, 1);
                changed = true;
              }
            }
          }
        }
        for (const c of txClusters) {
          c.txs.sort((a, b) => {
            const aa = txBox(a), bb = txBox(b);
            return (aa.x0 - bb.x0) || (aa.y0 - bb.y0) || (a.root.id - b.root.id);
          });
        }
        txClusters.sort((a, b) => readKey({ y0: a.box.y0, x0: a.box.x0 }) -
          readKey({ y0: b.box.y0, x0: b.box.x0 }));
        plan.txGroups = txClusters;
        if (opts.debug) console.log('[compiler:tx-groups] roots=' + transactions.length +
          ' groups=' + txClusters.length + ' sizes=' +
          txClusters.slice().sort((a, b) => b.txs.length - a.txs.length).slice(0, 10)
            .map((c) => c.txs.length).join(','));

        // 组级细节也要跟着对象走：先按组内像素的归属对象投票，把每个
        // 前景细节组绑定到对应事务；未被任何对象认领的组仍留到最后，
        // 只用于页面纹理和真正无归属的碎片。这样标题/段落的小字与
        // 抗锯齿边会在该对象抬笔前完成，而不是等全图主体画完后再跳着补。
        const noBgGroups = new Uint8Array(G_);
        const txDetailGroups = new Map();
        const detailRemainingGids = new Set(groups.map((g) => g.gid));
        for (const g of groups) {
          const votes = new Map();
          let otherN = 0;
          for (let y = g.y0; y <= g.y1; y++) {
            const row = y * W;
            for (let x = g.x0; x <= g.x1; x++) {
              const p = row + x;
              if (groupOf[p] !== g.gid) continue;
              const oid = plan.owner[p];
              const rr = oid >= 0 ? plan.regions[oid] : null;
              if (!rr || backgroundLike(rr) || rr.frameLike || rr.canvasFrame) { otherN++; continue; }
              const tx = txOfRegion.get(rr);
              if (!tx) { otherN++; continue; }
              votes.set(tx, (votes.get(tx) || 0) + 1);
            }
          }
          let bestTx = null, bestN = 0;
          for (const [tx, n] of votes) if (n > bestN) { bestTx = tx; bestN = n; }
          // 被背景所有权粘住的字形抗锯齿、点、短线通常会把多数像素记到
          // 页面/大底板上，单纯按 owner 投票会漏掉。若组本身是细节尺寸，
          // 再按几何归属找最近的对象事务；这也让同一文字对象的字缘和主体
          // 在同一个事务内完成，而不是全部堆到片尾。
          if ((!bestTx || bestN <= otherN) && g.area <= Math.max(900, N * 0.0015)) {
            const gcx = (g.x0 + g.x1) * 0.5, gcy = (g.y0 + g.y1) * 0.5;
            let bestDist = Infinity, bestArea = Infinity;
            for (const tx of transactions) {
              for (const f of tx.items) {
                if (f.mode === 'line' || f.pageGround) continue;
                let dist;
                if (inRegionHull(f, gcx, gcy)) dist = 0;
                else {
                  const dx = Math.max(0, f.x0 - g.x1, g.x0 - f.x1);
                  const dy = Math.max(0, f.y0 - g.y1, g.y0 - f.y1);
                  dist = Math.hypot(dx, dy);
                }
                const a = f.hullArea || f.fillArea || f.area;
                if (dist < bestDist - 0.25 || (Math.abs(dist - bestDist) <= 0.25 && a < bestArea)) {
                  bestDist = dist; bestArea = a; bestTx = tx;
                }
              }
            }
            const maxAssoc = Math.max(18, Math.min(48, Math.min(W, H) * 0.035));
            if (bestDist > maxAssoc) bestTx = null;
          }
          if (bestTx) {
            let set = txDetailGroups.get(bestTx);
            if (!set) { set = new Set(); txDetailGroups.set(bestTx, set); }
            set.add(g.gid);
            detailRemainingGids.delete(g.gid);
          }
        }
        plan.detailGroupsByTx = txDetailGroups;
        plan.detailRemainingGids = detailRemainingGids;

        // 不属于任何父对象的独立线条按“最小闭合归属对象”归入事务。
        const tailLines = [];
        const frameTxLines = [];
        for (const r of plan.lines) {
          if (r.frameLike || r.canvasFrame) { frameTxLines.push(r); continue; }
          const cx = (r.x0 + r.x1) * 0.5, cy = (r.y0 + r.y1) * 0.5;
          let best = null, bestArea = Infinity;
          for (const tx of transactions) {
            for (const f of tx.items) {
              if (f.mode === 'line' || f.pageGround || !inRegionHull(f, cx, cy)) continue;
              const a = f.hullArea || f.fillArea || f.area;
              if (a < bestArea) { bestArea = a; best = tx; }
            }
          }
          // 细线常常只是字形/图案内部的一小段，中心点落在闭合 hull 外，
          // 但它与所属对象的包围盒直接相交。按“bbox 距离最近、同距取更小
          // 闭合对象”兜底，能把这些线并回正在画的对象；距离过大的独立
          // 纸张细节仍留给最后的 tail，避免硬塞给无关图形。
          if (!best) {
            let bestDist = Infinity, bestHitArea = Infinity;
            const maxAssoc = Math.max(18, Math.min(48, Math.min(W, H) * 0.035));
            for (const tx of transactions) {
              for (const f of tx.items) {
                if (f.mode === 'line' || f.pageGround) continue;
                const dx = Math.max(0, f.x0 - r.x1, r.x0 - f.x1);
                const dy = Math.max(0, f.y0 - r.y1, r.y0 - f.y1);
                const dist = Math.hypot(dx, dy);
                const a = f.hullArea || f.fillArea || f.area;
                if (dist < bestDist - 0.25 || (Math.abs(dist - bestDist) <= 0.25 && a < bestHitArea)) {
                  bestDist = dist; bestHitArea = a; best = tx;
                }
              }
            }
            if (best && bestDist > maxAssoc) best = null;
          }
          if (best) best.lines.push(r);
          else tailLines.push(r);
        }
        if (frameFills.length) {
          const fr = frameFills[0];
          for (const r of frameTxLines) {
            const from = strokes.length;
            // 画框内部若有独立线条，并入最早画框事务，而不是推迟到全图末尾。
            paintLineRegion(r, Math.min(3, Math.max(2, r.depth + 1)));
            tagTx(from, 'bg:' + fr.id);
          }
        } else tailLines.push(...frameTxLines);

        const painted = new Set();
        // 区域事务的内部阶段。单个对象仍按原来的“绕边→填色→子层→细节”
        // 顺序执行；同一视觉行有多个对象时，则把整行按阶段推进，避免出现
        // A 全部画完后才轮到 I/R 的逐字跳画。
        const paintRegionOutline = (r) => {
          if (!r || r.pageGround || !fillSet.has(r)) return;
          const ph = regionPhase(r);
          if (r.mode === 'ring') {
            if (r.children.length && r.outer) contourStroke(r, r.outer, ph, 'compiler:edge');
            return;
          }
          // 细环内部阴影沿中心线绘制，外轮廓已在父环阶段处理。
          if (r.parent && r.parent.mode === 'ring' && r.thickness <= 6.5) return;
          if (r.outer) contourStroke(r, r.outer, ph, 'compiler:edge');
        };
        const walkTxRegions = (tx, enter, leave) => {
          const seen = new Set();
          const walk = (r) => {
            if (!r || seen.has(r)) return;
            seen.add(r);
            if (enter) enter(r);
            const kids = r.children.filter((ch) => txOfRegion.get(ch) === tx)
              .sort((a, b) => childKey(a) - childKey(b));
            for (const ch of kids) walk(ch);
            if (leave) leave(r);
          };
          walk(tx.root);
          // 极端情况下根节点没有进入 fills：其 items 仍必须完成。
          for (const r of tx.items) {
            if (seen.has(r)) continue;
            seen.add(r);
            if (enter) enter(r);
            if (leave) leave(r);
          }
        };
        const paintTransactionEdges = (tx) => {
          walkTxRegions(tx, null, (r) => {
            if (!fillSet.has(r)) return;
            const from = strokes.length;
            paintRegionRim(r);
            paintRingSeam(r);
            tagTx(from, tx.root.id);
          });
        };
        const paintStagedCluster = async (cluster) => {
          // 按包含深度成组推进整行：深度 0 的所有根对象先一起绕边、
          // 铺父色；随后整行一起进入下一层子区域。这样既保留“父色覆盖
          // 内部、子层再盖回来”的正确层级，也不会出现 A 全部完成后才
          // 开始 I/R 的逐字跳画。
          const bands = new Map();
          for (const tx of cluster.txs) {
            walkTxRegions(tx, (r) => {
              if (!fillSet.has(r) || painted.has(r)) return;
              const d = Number.isFinite(r.depth) ? r.depth : 0;
              let band = bands.get(d);
              if (!band) { band = []; bands.set(d, band); }
              band.push(r);
            }, null);
          }
          const depths = [...bands.keys()].sort((a, b) => a - b);
          for (const d of depths) {
            const band = bands.get(d);
            // 先让同一视觉组、同一深度的所有对象完成外轮廓，再统一落下
            // 色块。这样不会出现一个对象画完后其他对象还没起形的情况。
            for (const r of band) {
              const tx = txOfRegion.get(r);
              const from = strokes.length;
              paintRegionOutline(r);
              if (tx) tagTx(from, tx.root.id);
            }
            for (const r of band) {
              const tx = txOfRegion.get(r);
              const from = strokes.length;
              paintRegionBase(r, { skipOutline: true });
              painted.add(r);
              if (tx) tagTx(from, tx.root.id);
            }
            await yieldUI();
          }
          // 所有父子区域落定后，再从内向外补边缘。这里只完成“形体”
          // 阶段；线条和原色组细节留到全局细节阶段统一排程。
          for (const tx of cluster.txs) paintTransactionEdges(tx);

          const lineJobs = [];
          for (const tx of cluster.txs) {
            for (const r of tx.lines) lineJobs.push({ tx, r });
          }
          const detailGids = new Set();
          const txByGid = new Map();
          for (const tx of cluster.txs) {
            const set = txDetailGroups.get(tx);
            if (!set) continue;
            for (const gid of set) {
              detailGids.add(gid);
              txByGid.set(gid, tx.root.id);
            }
          }
          return { lineJobs, detailGids, txByGid };
        };

        // 先让所有视觉行完成“外轮廓 + 原子色块 + 边缘”，再统一进入细节
        // 阶段。这样大字号/大图案不会在时间轴前段独占几分钟；观众会先
        // 看到整张海报的主形体逐步立起来，然后细节按阅读顺序同时收口。
        const detailBatches = [];
        let groupDone = 0;
        for (const cluster of txClusters) {
          const fromGroup = strokes.length;
          // 单对象也走同一套阶段调度：大对象不能重新退回"自己画完再轮到
          // 其他对象"的旧事务路径。
          detailBatches.push(await paintStagedCluster(cluster));
          addObjectPause(fromGroup, cluster.box.x0 * 0.71 + cluster.box.y0 * 1.31 + groupDone * 2.17);
          groupDone++;
          prog(0.69 + 0.10 * groupDone / Math.max(1, txClusters.length),
            '编译器：先立起全部主形体…');
          if ((groupDone & 3) === 0) await yieldUI();
        }

        // 所有行的线条进入同一个阅读顺序队列。高字母、低位字缘和相邻
        // 字形会在同一高度交错生长，而不是先完整画完一个字再画下一个。
        const allLineJobs = [];
        const allDetailGids = new Set();
        const allTxByGid = new Map();
        for (const batch of detailBatches) {
          for (const job of batch.lineJobs) allLineJobs.push(job);
          for (const gid of batch.detailGids) {
            allDetailGids.add(gid);
            allTxByGid.set(gid, batch.txByGid.get(gid));
          }
        }
        allLineJobs.sort((a, b) =>
          readKey(a.r) - readKey(b.r) ||
          childKey(a.r) - childKey(b.r) ||
          a.tx.root.id - b.tx.root.id);
        for (let i = 0; i < allLineJobs.length; i++) {
          const job = allLineJobs[i];
          const from = strokes.length;
          paintLineRegion(job.r, Math.min(3, Math.max(2, job.r.depth + 1)));
          tagTx(from, job.tx.root.id);
          if ((i & 15) === 15) {
            prog(0.79 + 0.05 * i / Math.max(1, allLineJobs.length),
              '编译器：按阅读顺序补线条…');
            await yieldUI();
          }
        }

        // 原色组细节也只做一次全局调度。每个组仍严格绑定自己的事务，
        // 但落笔顺序完全由阅读顺序和空间位置决定，因此单个大事务不会
        // 垄断视觉进程；几何 mask、颜色与最终覆盖关系保持不变。
        if (allDetailGids.size) {
          await paintCompilerGroupDetails(noBgGroups, allDetailGids,
            undefined, { a: 0.84, b: 0.93, label: '编译器：按阅读顺序收口细节…' },
            allTxByGid);
        }
        // 不属于任何对象的细线只做最后一层，数量应远小于旧版全图线条阶段。
        const tailSorted = tailLines.slice().sort((a, b) => childKey(a) - childKey(b));
        for (let i = 0; i < tailSorted.length; i++) {
          const r = tailSorted[i];
          const from = strokes.length;
          paintLineRegion(r, Math.min(3, Math.max(2, r.depth + 1)));
          tagTx(from, 'tail');
          if ((i & 15) === 0) {
            prog(0.93 + 0.015 * i / Math.max(1, tailSorted.length), '编译器：补齐独立细线…');
            await yieldUI();
          }
        }
        if (opts.debug) console.log('[compiler:tx] objects=' + transactions.length +
          ' linesAssigned=' + plan.lines.filter((r) => !tailLines.includes(r)).length +
          ' tail=' + tailLines.length + ' frames=' + frameFills.length);
        // 不再做按组均值的小块回填：编译器已经有完整闭合 mask 和分层覆盖，
        // 额外均值补丁只会把蓝底重新切成云状色块。剩余误差交给对象内局部修正。
        // 局部修正：只在“当前图层所有权”内找高误差连通块，预算有限；
        // 不再跑全图均值补丁，因此不会把蓝底重新刷成斑驳碎块。
        let repaired = 0, repairPx = 0;
        const maxRepairStrokes = Math.min(1400, Math.max(360, Math.round(N * 0.0011)));
        const seen = new Uint8Array(N);
        const q = new Int32Array(N);
        const errAt = (p) => {
          const k = p * 3;
          return Math.max(Math.abs(canvas[k] - R[p]), Math.abs(canvas[k + 1] - G[p]),
            Math.abs(canvas[k + 2] - B[p]));
        };
        // 页面底板已经由一色多笔完整铺满；扫描纹理与原图均值之间的
        // 自然色差不是“漏画”。若这里再按误差补局部均值，会把本来
        // 连贯的蓝底重新切成深色云斑。局部修正只服务前景对象；页面
        // 层级错误已在排序阶段先外后内解决。
        const pageGroundOwner = (p) => {
          const oid = plan.owner[p];
          return oid >= 0 && !!(plan.regions[oid] && plan.regions[oid].pageGround);
        };
        for (let p0 = 0; p0 < N && repaired < maxRepairStrokes; p0++) {
          if (segPaper[p0] || seen[p0] || pageGroundOwner(p0) || errAt(p0) <= 28) continue;
          const sr0 = R[p0], sg0 = G[p0], sb0 = B[p0];
          let head = 0, tail = 0;
          q[tail++] = p0; seen[p0] = 1;
          const pix = [];
          let x0 = W, y0 = H, x1 = -1, y1 = -1;
          while (head < tail) {
            const p = q[head++], x = p % W, y = (p - x) / W;
            pix.push(p);
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
            const visit = (z) => {
              if (z < 0 || z >= N || seen[z] || segPaper[z] || pageGroundOwner(z) || errAt(z) <= 28) return;
              if (Math.max(Math.abs(R[z] - sr0), Math.abs(G[z] - sg0),
                Math.abs(B[z] - sb0)) > 26) return;
              seen[z] = 1; q[tail++] = z;
            };
            if (x > 0) {
              visit(p - 1);
              if (y > 0) visit(p - W - 1);
              if (y + 1 < H) visit(p + W - 1);
            }
            if (x + 1 < W) {
              visit(p + 1);
              if (y > 0) visit(p - W + 1);
              if (y + 1 < H) visit(p + W + 1);
            }
            if (y > 0) visit(p - W);
            if (y + 1 < H) visit(p + W);
          }
          if (pix.length < 3) continue;
          repairPx += pix.length;
          const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
          const m = new Uint8Array(bw * bh);
          for (const p of pix) m[((p - p % W) / W - y0) * bw + (p % W - x0)] = 1;
          const model = plan.fitColorModel(m, bw, bh, x0, y0, pix.length);
          const thin = pix.length <= Math.max(6, (bw + bh) * 2.4) ||
            (Math.max(bw, bh) >= Math.min(bw, bh) * 1.8 && pix.length <= bw * bh * 0.35);
          const rr = {
            id: 900000 + repaired, x0, y0, x1, y1, bw, bh,
            fillArea: pix.length, area: pix.length, mode: thin ? 'line' : 'solid',
            angle: bw >= bh ? 0 : Math.PI * 0.5, model,
            color: model.mean,
          };
          const before = strokes.length;
          fillRegion(rr, m, 3, 'compiler:repair', null, 0);
          if (strokes.length === before && rr.mode !== 'solid') {
            rr.mode = 'solid';
            fillRegion(rr, m, 3, 'compiler:repair', null, 0);
          }
          repaired += Math.max(1, strokes.length - before);
          if ((repaired & 31) === 0) await yieldUI();
        }

        // 真实覆盖补缝：只处理画布上仍为纸白、且不属于背景纸的像素。它们
        // 几乎都是被量化/抗锯齿切成 1~3px 的细缝，绝不能再用“整色区均值”
        // 回填。这里沿每个未覆盖连通 mask 的中心线补一笔，颜色由该 mask 的
        // 局部色场决定，几何与源图完全一致。
        let coverStrokes = 0, coverPx = 0, coverComps = 0, coverSkipped = 0, coverSkippedPx = 0;
        {
          const seen = new Uint8Array(N);
          const q = new Int32Array(N);
          const maxCoverStrokes = Math.min(2200, Math.max(900, Math.round(N * 0.0026)));
          const coverMinPx = palette.length <= 7 ? Math.max(4, Math.min(12, Math.round(Math.min(W, H) * 0.01))) : 1;
          for (let p0 = 0; p0 < N && coverStrokes < maxCoverStrokes; p0++) {
            if (segPaper[p0] || covered[p0] || seen[p0]) continue;
            let head = 0, tail = 0;
            q[tail++] = p0; seen[p0] = 1;
            const pix = [];
            let x0 = W, y0 = H, x1 = -1, y1 = -1;
            while (head < tail) {
              const p = q[head++], x = p % W, y = (p - x) / W;
              pix.push(p);
              if (x < x0) x0 = x; if (x > x1) x1 = x;
              if (y < y0) y0 = y; if (y > y1) y1 = y;
              const visit = (z) => {
                if (z < 0 || z >= N || seen[z] || covered[z] || segPaper[z]) return;
                seen[z] = 1; q[tail++] = z;
              };
              if (x > 0) visit(p - 1);
              if (x + 1 < W) visit(p + 1);
              if (y > 0) visit(p - W);
              if (y + 1 < H) visit(p + W);
            }
            if (pix.length < coverMinPx) { coverSkipped++; coverSkippedPx += pix.length; continue; }
            const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
            const m = new Uint8Array(bw * bh);
            for (const p of pix) m[((p - p % W) / W - y0) * bw + p % W - x0] = 1;
            const model = plan.fitColorModel(m, bw, bh, x0, y0, pix.length);
            const rr = {
              id: 950000 + coverComps, x0, y0, x1, y1, bw, bh,
              fillArea: pix.length, area: pix.length, mask: m, fillMask: m,
              mode: 'line', model, color: model.mean,
              angle: bw >= bh ? 0 : Math.PI * 0.5,
            };
            const before = strokes.length;
            fillRegion(rr, rr.mask, 3, 'compiler:cover', null, 1);
            const made = strokes.length - before;
            if (!made) {
              rr.mode = 'solid';
              fillRegion(rr, rr.mask, 3, 'compiler:cover-fill', null, 1);
              coverStrokes += strokes.length - before;
            } else coverStrokes += made;
            coverPx += pix.length;
            coverComps++;
            if ((coverComps & 63) === 0) await yieldUI();
          }
          if (opts.debug) console.log('[compiler] cover comps=' + coverComps +
            ' px=' + coverPx + ' strokes=' + coverStrokes + ' skip=' + coverSkipped + '/' + coverSkippedPx);
        }

        let good = 0, bad = 0;
        for (let p = 0; p < N; p++) {
          if (segPaper[p]) continue;
          const qq = p * 3;
          const err = Math.max(Math.abs(canvas[qq] - R[p]), Math.abs(canvas[qq + 1] - G[p]),
            Math.abs(canvas[qq + 2] - B[p]));
          if (err <= 64) { covered[p] = 1; paintN[p] = 1; good++; }
          else bad++;
        }
        groupUncov.fill(0);
        for (let p = 0; p < N; p++) {
          if (segPaper[p] || covered[p]) continue;
          const gid = groupOf[p];
          if (gid >= 0) groupUncov[gid]++;
        }
        zoneCov += good;
        pfClosedRegions = plan.fills.length + plan.lines.length;
        pfObjects = pfClosedRegions;
        pfRing = plan.order.some((r) => r.mode === 'ring');
        painterBgFill = 'compiler';
        if (opts.debug) console.log('[compiler] done fills=' + plan.fills.length + ' lines=' + plan.lines.length +
          ' good=' + good + ' bad=' + bad + ' repairs=' + repaired + ' repairPx=' + repairPx +
          ' strokes=' + strokes.length + ' ms=' + (Date.now() - tEx));
        await yieldUI();
      };

      // ---- compiler 的组级最后一层 ----
      // 区域合并适合建立父子层级和大块闭合面，但会把小字、点、胡须、细框
      // 合成过宽或过碎的候选。这里不重新铺底，只回到原图色组：细线沿骨架、
      // 小实心沿原始掩膜，在最上层按原色重画。zoneGid 严格裁回组内，因此
      // 不会把邻近底色或字心涂坏。
      const paintCompilerGroupDetails = async (bgSet, groupFilter, txId, phaseProgress, groupTxMap) => {
        // 紧凑实心碎片（小字、抗锯齿边缘）本身就是一个色块：用原始组掩膜
        // 一次落下整块，不再用宽扫笔伪装成色块。颜色跨度大的组按像素色
        // 聚类，每个颜色簇仍是一整块；只有真正的细长线才交给骨架笔。
        const paintCompactMask = (g, ph) => {
          const groupMask = () => {
            const m = new Uint8Array(g.bw * g.bh);
            for (let y = g.y0; y <= g.y1; y++) {
              const row = y * W;
              for (let x = g.x0; x <= g.x1; x++) {
                if (groupOf[row + x] === g.gid) m[(y - g.y0) * g.bw + x - g.x0] = 1;
              }
            }
            return m;
          };
          const emitBlock = (mask, color) => emitBlockFill(g.x0, g.y0, g.bw, g.bh, mask, color, ph, {
            stage: 'compiler:detail-block',
            zoneGid: g.gid,
            // 原子色块出现后不再需要扫过整组的观看时间；只保留一次短促的
            // 落块节拍。大组略长，小组几乎立即完成。
            ms: Math.round(55 + Math.min(145, Math.sqrt(Math.max(1, g.area)) * 1.7)),
          });
          // 阈值来自海报/线稿样例的误差-笔数扫描：低于 8 时收益快速衰减，
          // 高于 16 时大量可见字边会被重新压回单一均值。
          const splitStd = opts.compilerDetailSplitStd === undefined ? 8 : +opts.compilerDetailSplitStd;
          const splitK3 = opts.compilerDetailSplitK3 === undefined ? 16 : +opts.compilerDetailSplitK3;
          if (opts.compilerDetailSplitCompact === false || g.area < 24 || (g.std || 0) < splitStd) {
            const si = emitBlock(groupMask(), colorOf(g));
            return si < 0 ? 0 : 1;
          }
          // 小字/抗锯齿碎组常把亮红、暗红和橙色并成一个均值。这里只在
          // 已被组级误差闸门挑中的紧凑组内按真实像素色聚类，每组色用
          // 自己的原色落一个完整色块；几何仍严格裁在原组像素内。
          const pix = [];
          for (let y = g.y0; y <= g.y1; y++) {
            const row = y * W;
            for (let x = g.x0; x <= g.x1; x++) if (groupOf[row + x] === g.gid) pix.push(row + x);
          }
          if (pix.length < 24) {
            const si = emitBlock(groupMask(), colorOf(g));
            return si < 0 ? 0 : 1;
          }
          const K = (g.std || 0) >= splitK3 ? 3 : 2;
          const lums = pix.map((p) => 0.299 * R[p] + 0.587 * G[p] + 0.114 * B[p]);
          const byLum = lums.map((v, i) => i).sort((a, b) => lums[a] - lums[b]);
          let cen = [];
          for (let k = 0; k < K; k++) {
            const p = pix[byLum[Math.floor((k + 0.5) * pix.length / K)]];
            cen.push([R[p], G[p], B[p]]);
          }
          const assign = new Uint8Array(pix.length);
          for (let it = 0; it < 6; it++) {
            const sum = Array.from({ length: K }, () => [0, 0, 0, 0]);
            for (let i = 0; i < pix.length; i++) {
              const p = pix[i];
              let bk = 0, bd = Infinity;
              for (let k = 0; k < K; k++) {
                const d = Math.abs(R[p] - cen[k][0]) + Math.abs(G[p] - cen[k][1]) + Math.abs(B[p] - cen[k][2]);
                if (d < bd) { bd = d; bk = k; }
              }
              assign[i] = bk;
              sum[bk][0] += R[p]; sum[bk][1] += G[p]; sum[bk][2] += B[p]; sum[bk][3]++;
            }
            for (let k = 0; k < K; k++) if (sum[k][3]) {
              cen[k] = [sum[k][0] / sum[k][3], sum[k][1] / sum[k][3], sum[k][2] / sum[k][3]];
            }
          }
          const counts = new Int32Array(K);
          for (let i = 0; i < pix.length; i++) counts[assign[i]]++;
          const alive = [];
          for (let k = 0; k < K; k++) if (counts[k] >= 2) alive.push(k);
          if (alive.length <= 1) {
            const si = emitBlock(groupMask(), colorOf(g));
            return si < 0 ? 0 : 1;
          }
          let made = 0;
          for (const k of alive) {
            const m = new Uint8Array(g.bw * g.bh);
            for (let i = 0; i < pix.length; i++) {
              if (assign[i] !== k) continue;
              const p = pix[i], x = p % W, y = (p - x) / W;
              m[(y - g.y0) * g.bw + x - g.x0] = 1;
            }
            const si = emitBlock(m, cen[k].map(Math.round));
            if (si >= 0) made++;
          }
          return made;
        };
        const detail = groups.filter((g) => {
          if ((groupFilter && !groupFilter.has(g.gid)) || bgSet[g.gid] || g.area < 4) return false;
          if (!g.lineLike && g.area > Math.max(900, N * 0.0015)) return false;
          // 组级收口不是重画全图：只挑当前画布仍有可见误差的组。小字碎组
          // 通常几乎整组都错，会完整走微型掩膜；已经画准的组直接跳过，
          // 避免同样的色块重复落几千笔。
          let n = 0, bad = 0, maxE = 0;
          for (let yy = g.y0; yy <= g.y1; yy++) {
            const row = yy * W + g.x0;
            for (let xx = 0; xx < g.bw; xx++) {
              const p = row + xx;
              if (groupOf[p] !== g.gid) continue;
              const q = p * 3;
              const e = Math.max(Math.abs(canvas[q] - R[p]),
                Math.abs(canvas[q + 1] - G[p]), Math.abs(canvas[q + 2] - B[p]));
              n++;
              if (e > 20) bad++;
              if (e > maxE) maxE = e;
            }
          }
          return n > 0 && (bad >= Math.max(1, Math.ceil(n * 0.04)) || maxE >= 48);
        }).sort((a, b) =>
          (Math.floor(a.y0 / Math.max(24, Math.min(84, H * 0.065))) -
           Math.floor(b.y0 / Math.max(24, Math.min(84, H * 0.065)))) ||
          (a.x0 - b.x0) || (a.y0 - b.y0));
        if (opts.debug && txId === 'detail:final') {
          const assigned = new Set();
          for (const set of compilerPlan.detailGroupsByTx.values()) for (const gid of set) assigned.add(gid);
          const cat = {};
          for (const g of detail) {
            let page = 0, fg = 0, frame = 0, none = 0;
            for (let yy = g.y0; yy <= g.y1; yy++) for (let xx = g.x0; xx <= g.x1; xx++) {
              const p = yy * W + xx;
              if (groupOf[p] !== g.gid) continue;
              const rr = compilerPlan.owner[p] >= 0 ? compilerPlan.regions[compilerPlan.owner[p]] : null;
              if (!rr) none++;
              else if (rr.pageGround) page++;
              else if (rr.frameLike || rr.canvasFrame) frame++;
              else fg++;
            }
            const total = Math.max(1, page + fg + frame + none);
            const who = page / total >= 0.5 ? 'page' : frame / total >= 0.5 ? 'frame' : fg / total >= 0.5 ? 'fg' : 'mixed';
            const size = g.area < 64 ? 'tiny' : g.area < 400 ? 'small' : g.area < 2000 ? 'mid' : 'large';
            const key = (g.lineLike ? 'line' : 'fill') + ':' + size + ':' + who + ':' + (assigned.has(g.gid) ? 'assigned' : 'unassigned');
            cat[key] = (cat[key] || 0) + 1;
          }
          console.log('[compiler:detail-cats] ' + JSON.stringify(Object.fromEntries(Object.entries(cat).sort((a, b) => b[1] - a[1]))));
        }
        let done = 0;
        for (const g of detail) {
          // 编译器的大区域已经写过一层，但小字/细线往往只是“被某个父色盖住”，
          // 覆盖账会被误判为已完成，随后 paintLine/paintBlob 的新笔又因
          // zoneCov 没有增长而被当作零增益删除。组级收口本来就是要用原像素
          // 重画这些小结构，因此只在本组自己的掩膜内重置覆盖账；不碰父层和
          // 邻近组，也不会重新引入全图均值补丁。
          for (let yy = g.y0; yy <= g.y1; yy++) {
            const row = yy * W + g.x0;
            for (let xx = 0; xx < g.bw; xx++) {
              if (groupOf[row + xx] === g.gid) paintN[row + xx] = 0;
            }
          }
          groupUncov[g.gid] = g.area;
          // 判断只看几何与颜色：细长线沿骨架画；实心块（不论大小）按
          // 原组掩膜整块落下；只有真正有内部渐变的组保留局部扫色。
          const compact = g.bw * g.bh <= 2500 && g.area <= 900;
          // 紧凑“类线”多数是字缘/扫描碎片，不是真正连续线稿；它们按
          // 原始 mask 原子落块。只有更大的连续线条才值得走中心线。
          const blockDetail = !g.grad && (!g.lineLike || compact);
          const ds0 = strokes.length;
          if (g.lineLike && !blockDetail) {
            paintLine(g, 3);
            // 极短/极碎的小线有时追不出可用骨架；这时原子块至少不会留下
            // 扫描笔的中间态，也不会把邻近像素带进来。
            if (strokes.length === ds0 && groupUncov[g.gid] > 0) paintCompactMask(g, 3);
          } else if (blockDetail) {
            paintCompactMask(g, 3);
          } else {
            paintBlob(g, 3);
          }
          const fallbackStage = blockDetail ? 'compiler:detail-block'
            : (g.lineLike ? 'compiler:detail-line' : 'compiler:detail-blob');
          const groupTxId = groupTxMap && groupTxMap.has(g.gid)
            ? groupTxMap.get(g.gid) : txId;
          for (let si = ds0; si < strokes.length; si++) {
            if (!strokes[si].stage) strokes[si].stage = fallbackStage;
            if (groupTxId !== undefined) strokes[si].tx = groupTxId;
          }
          if (compact && blockDetail) {
            // 兼容旧诊断：紧凑实心块仍记为 detail-compact，方便比较时间轴。
            for (let si = ds0; si < strokes.length; si++) {
              if (strokes[si].blk) strokes[si].stage = 'compiler:detail-compact';
            }
          }
          done++;
          if (phaseProgress && (done & 31) === 0) {
            prog(phaseProgress.a + (phaseProgress.b - phaseProgress.a) * done / Math.max(1, detail.length),
              phaseProgress.label || '编译器：逐线和小形体收口…');
            await yieldUI();
          }
        }
        if (opts.debug && (!groupFilter || phaseProgress)) console.log('[compiler:details] groups=' + detail.length +
          ' strokes=' + strokes.length + (groupFilter ? ' scoped=1 tx=' + txId : ' scoped=0'));
        await yieldUI();
      };

      // ---- 排阶段：按最终画面结构，不按色板大小；同一阶段内按手的位置就近走笔 ----
      prog(0.66, flatArt ? '铺开：背景与主色块…' : '铺开：主体大形与背景…');
      await yieldUI();
      const focalX = subj.focalX, focalY = subj.focalY;
      for (const g of groups) {
        g.dF = Math.hypot(g.cx - focalX, g.cy - focalY);
        // 照片的主体判定不能只看"不贴边"：被猫挡住/圈住的岩石、洞壁也是独立色区，
        // 面积很大但不贴边，会把起形阶段变成满屏色块。贴边的大色区、低显著度的大色区
        // 一律当背景；小色区仍保留，避免把猫的爪尖、耳尖漏掉。
        let subj = !g.bg && g.area >= Math.max(20, N * 0.00025);
        if (!flatArt && subj) {
          const nearBorder = g.x0 < W * 0.045 || g.x1 > W * 0.955 ||
            g.y0 < H * 0.045 || g.y1 > H * 0.955;
          if (g.area >= N * 0.0015 && (nearBorder || g.sal < 0.35)) subj = false;
        }
        g.subj = subj ? 1 : 0;
        // 平涂背景是一整片浅粉渐变，被切成很多块（还有贴边的浅色细条）；
        // 它们不一定是独立色区，但明显是背景。用"大、浅、暖"把背景块和猫的
        // 奶油色身体分开：背景先铺，猫身随后，猫外面的浅色环不会在中途留白。
        const ml = 0.299 * g.mean[0] + 0.587 * g.mean[1] + 0.114 * g.mean[2];
        g.backdrop = (flatArt && g.area >= N * 0.0008 &&
          ml >= 190 && ml <= 243 &&
          g.mean[0] - g.mean[2] >= 20 && g.mean[0] - g.mean[2] <= 66) ? 1 : 0;
      }
      if (flatArt) {
        // 所有"大、浅、暖"的背景色区都按软背景处理：大色区扫带用两级网点落笔，
        // 细长的浅色背景条也走块面扫（不再按"线"涂成一条SCRATCH的纯色）。
        // 猫身奶油色（暖度 < 22）与深色墨线不参与。
        const cls = new Uint8Array(N);
        for (let p = 0; p < N; p++) {
          const gid = groupOf[p];
          if (gid < 0) continue;
          const gg = groups[gid];
          const ml = 0.299 * gg.mean[0] + 0.587 * gg.mean[1] + 0.114 * gg.mean[2];
          const warm = gg.mean[0] - gg.mean[2];
          if (gg.backdrop || (!gg.lineLike && ml >= 185 && ml <= 244 && warm >= 22 && warm <= 85)) cls[p] = 1;
        }
        const cnt = new Int32Array(G_);
        for (let p = 0; p < N; p++) {
          const gid = groupOf[p];
          if (gid >= 0 && cls[p]) cnt[gid]++;
        }
        for (const g of groups) g.soft = (cnt[g.gid] > g.area * 0.5) ? 1 : 0;
      }
      const phaseOf = (g) => {
        if (flatArt) {
          // 平涂图的主体是白猫画在白纸上：先铺色的话，猫到轮廓阶段才出现，
          // 中途还会沿每条描边留一圈白缝。深色墨线先起形，猫的形状从第一秒就在；
          // 胡须/小记号这类细墨线留到点睛。浅色"线"其实是渐变边/抗锯齿，随铺色走。
          const ink = g.lineLike && g.luma < 155;
          if (ink) return g.thick >= 2.2 ? 0 : 3;
          if (g.backdrop) return 1;
          if (g.lineLike) return (g.soft || g.bg) ? 1 : 2;
          if (g.area >= N * 0.002) return 1;
          if (g.bg) return 1;
          if (g.area >= N * 0.00008) return 2;
          return 3;
        }
        // 点睛只收"视觉中心附近"的暗墨细节（五官、胡须根、嘴线）。背景石缝、
        // 远处毛发的暗斑也是细小暗块，但它们属于纹理，必须跟塑形阶段一起收：
        // 全塞进点睛的话，总时长三分之一都在补背景的深色小洞。
        if (g.lineLike && g.luma < 155 && g.area < N * 0.0012 &&
          Math.hypot(g.cx - subj.focalX, g.cy - subj.focalY) < Math.min(W, H) * 0.28) return 3;
        if (g.subj && g.area >= N * 0.0016) return 0;
        if (g.bg && g.area >= N * 0.0007) return 1;
        return 2;
      };
      // ---- 平涂：背景先行 + 元素块 ----
      // 真人画海报/插画是先把背景整片铺满（中间色大笔推进，再用少量笔触调明暗），
      // 背景成形后才一处一处画主体：一架飞机画完再画大标题，不会先把全画面轮廓
      // 描一遍再统一填色。这里把"阶段"重排成：背景块 → 主体块 → 文字/结构块 → 细节块；
      // 主体块之间的先后换种子可以变，但背景先行和块内就近完成不变。
      const bgFirstPlan = (() => {
        if (!flatArt) return null;
        const K = palette.length;
        const gLab = new Int16Array(G_);
        const labArea = new Float64Array(K);
        for (const g of groups) {
          let bi = 0, bd = Infinity;
          for (let k = 0; k < K; k++) {
            const c = palette[k];
            const dr = g.mean[0] - c[0], dg = g.mean[1] - c[1], db = g.mean[2] - c[2];
            const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
            if (d < bd) { bd = d; bi = k; }
          }
          gLab[g.gid] = bi; labArea[bi] += g.area;
        }
        // 主色家族：面积最大的调色板色，加它色距 40 以内的同族色（背景渐变档）
        let seedLab = 0;
        for (let k = 1; k < K; k++) if (labArea[k] > labArea[seedLab]) seedLab = k;
        const seedShare = labArea[seedLab] / Math.max(1, N);
        const sc = palette[seedLab];
        const fam = new Uint8Array(K);
        let famShare = 0;
        for (let k = 0; k < K; k++) {
          const c = palette[k];
          if (Math.hypot(c[0] - sc[0], c[1] - sc[1], c[2] - sc[2]) <= 40) {
            fam[k] = 1; famShare += labArea[k];
          }
        }
        // 主色占幅不够：这不是"整片背景 + 主体"的构图，退回原来的阶段排法
        const famShareN = famShare / Math.max(1, N);
        // 画家·过程版的"整片背景"按主色家族判，不按单个调色板标签：扫描件的蓝底
        // 常被拆成几个相邻蓝档，seedShare 会随解码/重采样在 22%~35% 之间跳，
        // 同一个 URL 换个浏览器就掉回照片排法。画家模式仍用原判据，行为不变。
        const famGate = painterFlow ? famShareN : famShare;
        const seedGate = painterFlow ? 0.12 : 0.30;
        if (opts.debug) console.log('[bgfirst] seedLab=' + seedLab + ' share=' +
          (seedShare * 100).toFixed(1) + '% fam=' + (famShareN * 100).toFixed(1) +
          '% gate=' + (painterFlow ? 'painter' : 'artist'));
        // 画家过程版需要覆盖背景占比不高的插画/海报（天空、纸面、窗墙等），
        // 不能只服务蓝底占大半的版式；42% 是艺术家路径的稳定阈值，
        // painter 路径改用更宽容的 24% 下限，后续仍由 bgLike/贴边/面积闸门兜底。
        const minFamShare = painterFlow ? 0.24 : 0.42;
        if (famGate < minFamShare || seedShare < seedGate) return null;
        const bgSet = new Uint8Array(G_);
        const famGid = new Uint8Array(G_);
        const famBg = [], otherBg = [];
        let bgN = 0, famN = 0;
        // 背景家族只收"色相/饱和度都像背景"的面状组：调色板只有十来个色，
        // 深色轮廓线（飞机上缘、黑框）常被分到最接近的深蓝标签，但它饱和度
        // 远低于背景，不能跟着背景提前画；线状组一律留给主体/边框阶段。
        const satOf = (c) => {
          const mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]);
          return mx > 0 ? (mx - mn) / mx : 0;
        };
        const seedSat = satOf(sc);
        for (const g of groups) {
          // 贴边细长线（扫描边框/内框）和画幅四边 4% 内的低显著度碎边，
          // 都是背景的一部分；不并进元素块，否则一条边框会把全图串成一个元素。
          // frame 必须真的贴边：画面内部一条横跨半幅的飞机翼线不是画框。
          const frame = g.lineLike && g.area < N * 0.012 &&
            (g.bw > W * 0.5 || g.bh > H * 0.5) &&
            (g.x0 < W * 0.02 || g.x1 > W * 0.98 || g.y0 < H * 0.02 || g.y1 > H * 0.98);
          const margin = g.x0 < W * 0.04 || g.x1 > W * 0.96 ||
            g.y0 < H * 0.04 || g.y1 > H * 0.96;
          // 贴边碎边只收"扫描边框/压缩毛刺"这种小面积噪点；贴边的真实主体
          // （比如插画右下角那片叶子）不能算背景，否则背景阶段就把主体先画了。
          const edgeArt = margin && g.sal < 0.55 && g.area < N * 0.006;
          // 贴边的低显著度组才是背景；贴边的真实主体（插画右下角的叶子/梗）
          // 显著度高，分组合并后仍带着 border 标记，不能靠 g.bg 混进背景阶段。
          const bgLike = g.bg && (g.sal < 0.62 || g.area > N * 0.02);
          // 调色板近似会让小花、杯沿等前景落到主色标签上；只有确实被判为
          // 背景，或本身达到大背板尺度，才允许进入主色背景族。
          // 主色家族不是“颜色接近背景”就能进：太阳光晕、杯身、红色圆盘
          // 也常与底色同族。非背景组必须同时达到大背板尺度、跨越显著宽度/
          // 高度，且低饱和，才允许作为版面先铺；否则留到对象阶段局部完成。
          const widePanel = g.area >= N * 0.04 && g.sal <= 0.45 &&
            (g.bw >= W * 0.45 || g.bh >= H * 0.40);
          const famG = fam[gLab[g.gid]] && satOf(g.mean) >= seedSat * 0.6 &&
            (g.bg || widePanel);
          if (famG) { famGid[g.gid] = 1; famN += g.area; }
          if (famG || bgLike || frame || edgeArt) {
            bgSet[g.gid] = 1; bgN += g.area;
            (famG ? famBg : otherBg).push(g);
          }
        }
        // 次主色的大背板（例如两段式海报上半幅的深蓝版面）常常不属于
        // 主色家族，但它在视觉上就是背景。按"大面积 + 高填充 + 低显著度"
        // 补进背景阶段，先铺色再画上面的主体和文字。
        for (const g of groups) {
          if (bgSet[g.gid] || g.lineLike) continue;
          const fill = g.area / Math.max(1, g.bw * g.bh);
          // 大背板：面积达到整幅 12%，低显著度。
          // 只有“真正铺开成版面”的组才算背板：必须在至少一个方向跨越大半
          // 画幅，且是低饱和的连续色面。杯子、太阳光晕、圆盘等虽然面积/填充
          // 率也可能很大，但包围盒紧凑，是画在底板上的对象，不能提前当地色。
          const spansPanel = g.bw >= W * 0.45 || g.bh >= H * 0.40;
          const majorBackdrop = g.area >= N * 0.06 && fill >= 0.50 &&
            g.sal <= 0.50 && spansPanel;
          const panelBackdrop = g.area >= N * 0.015 && fill >= 0.55 &&
            g.sal <= 0.50 && spansPanel;
          if (majorBackdrop || panelBackdrop) {
            bgSet[g.gid] = 1; bgN += g.area; otherBg.push(g);
          }
        }
        if (opts.debug) console.log('[bgfirst] bgN=' + (bgN / N * 100).toFixed(1) + '%');
        if (bgN < N * 0.25) return null;
        // 前景元素块：bbox 邻近并查集。字形、飞机、每一行文字各自成块；
        // 换种子不改分块，只改块与块的先后。
        const fg = groups.filter((g) => !bgSet[g.gid]);
        const F = fg.length;
        const par = new Int32Array(F).fill(-1);
        const findF = (i) => {
          let r = i;
          while (par[r] >= 0) r = par[r];
          while (i !== r) { const nx = par[i]; par[i] = r; i = nx; }
          return r;
        };
        const unionF = (a, b) => {
          a = findF(a); b = findF(b);
          if (a === b) return;
          if (par[a] > par[b]) { const t = a; a = b; b = t; }
          par[a] += par[b]; par[b] = a;
        };
        const gap = Math.max(6, Math.round(0.012 * Math.min(W, H)));
        fg.sort((a, b) => (a.x0 - b.x0) || (a.y0 - b.y0));
        for (let i = 0; i < F; i++) {
          const A = fg[i];
          for (let j = i + 1; j < F && fg[j].x0 - A.x1 <= gap; j++) {
            const B = fg[j];
            const dx = Math.max(0, Math.max(A.x0 - B.x1, B.x0 - A.x1));
            const dy = Math.max(0, Math.max(A.y0 - B.y1, B.y0 - A.y1));
            if (dx <= gap && dy <= gap) unionF(i, j);
          }
        }
        const emap = new Map();
        for (let i = 0; i < F; i++) {
          const r0 = findF(i);
          let e = emap.get(r0);
          if (!e) { e = { gs: [], area: 0, sal: 0, x0: W, y0: H, x1: -1, y1: -1 }; emap.set(r0, e); }
          const g = fg[i];
          e.gs.push(g); e.area += g.area; e.sal += g.sal * g.area;
          if (g.x0 < e.x0) e.x0 = g.x0; if (g.y0 < e.y0) e.y0 = g.y0;
          if (g.x1 > e.x1) e.x1 = g.x1; if (g.y1 > e.y1) e.y1 = g.y1;
        }
        const elems = [...emap.values()];
        for (const e of elems) {
          e.sal /= Math.max(1, e.area);
          e.cx = (e.x0 + e.x1) * 0.5; e.cy = (e.y0 + e.y1) * 0.5;
          // 块内顺序就是人的局部工作顺序：先立大形和主要色块（大形→明暗→细节），
          // 再描深色轮廓，最小的高光/细线最后。文字块同理：字形先立准，描边后补。
          // 大色块直接进"起稿"阶段（e.mass），其余留在细化阶段按角色排。
          const massTh = Math.max(500, N * 0.0008);
          const roleOf = (g) => !g.lineLike ? 0 : (g.luma < 155 ? 1 : 2);
          const buckets = [[], [], []];
          e.mass = [];
          for (const g of e.gs) {
            if (!g.lineLike && g.area >= massTh) { e.mass.push(g); continue; }
            buckets[roleOf(g)].push(g);
          }
          e.mass.sort((p, q) => (q.area * (0.92 + 0.16 * srnd(q.gid, 6))) -
            (p.area * (0.92 + 0.16 * srnd(p.gid, 6))));
          e.mass = chainNN(e.mass, (g) => [g.cx, g.cy], e.cx, e.cy);
          const local = [];
          for (let b = 0; b < 3; b++) {
            const arr = buckets[b];
            if (!arr.length) continue;
            arr.sort((p, q) => (q.area * (0.92 + 0.16 * srnd(q.gid, 6 + b))) -
              (p.area * (0.92 + 0.16 * srnd(p.gid, 6 + b))));
            const ch = chainNN(arr, (g) => [g.cx, g.cy], e.cx, e.cy);
            for (const g of ch) local.push(g);
          }
          e.local = local;
          // 起稿底色用：元素 gid 表（底色掩膜盖住全部像素）+ 主色 = 元素里
          // 最大的非线状组的颜色（= 这块东西的"主要大色"，不能被描边/装饰色
          // 拉偏）。起稿时给"除大块外还没铺到的区域"打这层底色，细化再刷准。
          e.fgids = [];
          let mainFill = null;
          for (const g of e.gs) {
            e.fgids.push(g.gid);
            if (!g.lineLike && (!mainFill || g.area > mainFill.area)) mainFill = g;
          }
          e.baseCol = mainFill
            ? [mainFill.mean[0], mainFill.mean[1], mainFill.mean[2]]
            : [e.gs[0] ? e.gs[0].mean[0] : 200, e.gs[0] ? e.gs[0].mean[1] : 200, e.gs[0] ? e.gs[0].mean[2] : 200];
          // 大主体 / 其他文字 / 细节三档。档内顺序换种子可换，档间次序固定：
          // 主体都完成后再落次要文字，最后才点细节。
          e.tier = e.area >= N * 0.015 ? 1 : (e.area >= N * 0.002 ? 2 : 3);
        }
        // 背景细化的顺序：先把背景按面积从大到小排（换种子微扰），
        // 画的时候再按笔尖就近串联。不用固定网格：网格扫描像机器过扫描线，
        // 人是先把最大的色带立起来，再就近收拾剩下的窄带和噪点。
        const bgAll = famBg.concat(otherBg);
        bgAll.sort((a, b) => (b.area * (0.9 + 0.2 * srnd(b.gid, 8))) -
          (a.area * (0.9 + 0.2 * srnd(a.gid, 8))));
        // 铺底掩膜：背景里所有"颜色接近中间色"的像素都先铺掉——包括细长/细碎的
        // 蓝底斑纹和噪点。它们是同一条蓝底的明暗起伏，漏掉就会在中途帧留下满场
        // 白点；主体、红描边、黑框离中间色远，仍然留白到各自阶段。
        // 颜色取主色家族的面积加权均值；后面的精确背景笔逐像素重涂，成品不变。
        let wr = 0, wgc = 0, wbc = 0, wn = 0;
        for (const g of famBg) {
          wr += g.mean[0] * g.area; wgc += g.mean[1] * g.area; wbc += g.mean[2] * g.area;
          wn += g.area;
        }
        const washColor = wn > 0
          ? [Math.round(wr / wn), Math.round(wgc / wn), Math.round(wbc / wn)]
          : [sc[0], sc[1], sc[2]];
        const washGid = new Uint8Array(G_);
        for (const g of groups) {
          if (washGid[g.gid]) continue;
          const d = Math.hypot(g.mean[0] - washColor[0], g.mean[1] - washColor[1],
            g.mean[2] - washColor[2]);
          // 背景组放宽到 105：蓝底的暗角/旧纸斑偏色也能铺上；黑框、白纸边
          // 明显更远，留到边框阶段。非背景只收 1% 以下的小碎块（噪点/抗锯齿斑），
          // 大块主体不管颜色多接近都留白。
          // 非背景组只收亚像素级抗锯齿/扫描噪点。旧阈值会把杯子、书页等
          // 接近纸色的真实小物体也扫进底色，回放一开始就像先画完了茶具。
          if (bgSet[g.gid] ? d <= 105 : (d <= 95 && g.area <= N * 0.002)) washGid[g.gid] = 1;
        }
        const washMask = new Uint8Array(N);
        let washN = 0;
        for (let p = 0; p < N; p++) {
          const gid = groupOf[p];
          if (gid >= 0 && washGid[gid]) { washMask[p] = 1; washN++; }
        }
        // 主色背景的"均匀度"和"贴边数"：一趟铺满的两个可测量闸门。
        // 渐变背景（均匀度差）自动回退 wash+逐组补准，避免横向色带。
        let famSpread = 0, famSW = 0;
        for (const g of famBg) {
          const d = Math.max(Math.abs(g.mean[0] - washColor[0]), Math.abs(g.mean[1] - washColor[1]),
            Math.abs(g.mean[2] - washColor[2]));
          famSpread += d * g.area; famSW += g.area;
        }
        famSpread = famSW ? famSpread / famSW : 0;
        let edgeBits = 0;
        for (let x = 0; x < W; x++) {
          let gid = groupOf[x];
          if (gid >= 0 && famGid[gid]) edgeBits |= 1;
          gid = groupOf[(H - 1) * W + x];
          if (gid >= 0 && famGid[gid]) edgeBits |= 4;
        }
        for (let y = 0; y < H; y++) {
          let gid = groupOf[y * W];
          if (gid >= 0 && famGid[gid]) edgeBits |= 2;
          gid = groupOf[y * W + W - 1];
          if (gid >= 0 && famGid[gid]) edgeBits |= 8;
        }
        let famEdges = 0;
        for (let b = 0; b < 4; b++) if (edgeBits & (1 << b)) famEdges++;
        if (opts.debug) {
          let exBg = 0;
          for (const g of groups) if (!washGid[g.gid] && bgSet[g.gid]) exBg += g.area;
          console.log('[wash] color=' + JSON.stringify(washColor) + ' bgN=' + bgN +
            ' washN=' + washN + ' exBg=' + exBg);
        }
        const shuffle = (arr, salt) => {
          for (let i = arr.length - 1; i > 0; i--) {
            const j = (srnd(i * 3.71 + salt + runSeed * 0.03, 9.7) * (i + 1)) | 0;
            const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
          }
          return arr;
        };
        const byTier = [[], [], [], []];
        for (const e of elems) byTier[e.tier].push(e);
        shuffle(byTier[1], 1.7); shuffle(byTier[2], 2.9); shuffle(byTier[3], 4.3);
        // 三段输出：masses = 起稿（每个元素的大色块），rests = 主体细化，
        // details = 前景/细节收尾。起稿先立构图，细化一处完成一处。
        const masses = byTier[1].concat(byTier[2]).filter((e) => e.mass.length);
        const rests = byTier[1].concat(byTier[2]).filter((e) => e.local.length);
        const details = byTier[3].filter((e) => e.local.length);
        if (opts.debug) {
          let mm = 0, rl = 0;
          for (const e of masses) mm += e.mass.length;
          for (const e of rests) rl += e.local.length;
          console.log('[plan] masses=' + masses.length + ' massG=' + mm +
            ' rests=' + rests.length + ' restG=' + rl + ' details=' + details.length +
            ' tierCounts=' + JSON.stringify([byTier[1].length, byTier[2].length, byTier[3].length]));
        }
        return {
          bgSet, bgAll, otherBg: [], bgN,
          washMask, washColor, washN,
          famGid, famN, famSpread, famEdges,
          masses, rests, details,
        };
      })();

      // 页面底板/背景面板的“可见色面”会被前景挖出缺口，不能直接当作落色
      // 区域。只在几何上像页面底板的实心根区域上启用闭包：区域必须位于
      // 顶层、跨越大半画幅并贴近至少两条画幅边。这样不按颜色、文件名或
      // 样例特判，也不会把普通对象内部真正的镂空强行填掉。
      const pageBaseCandidate = (r) => {
        if (!r || r.mode !== 'solid' || r.frameLike || !r.outer) return false;
        const nearEdges = (r.x0 <= W * 0.06 ? 1 : 0) + (r.x1 >= W * 0.94 ? 1 : 0) +
          (r.y0 <= H * 0.06 ? 1 : 0) + (r.y1 >= H * 0.94 ? 1 : 0);
        return nearEdges >= 2 && r.bw >= W * 0.70 && r.bh >= H * 0.70 &&
          r.fillArea >= N * 0.12;
      };
      const makePageBaseMask = (r, regions) => {
        const gm = new Uint8Array(r.bw * r.bh).fill(1);
        // 页面底板可以盖住尚未绘制的子孙对象，但绝不能越过真实画框。
        for (const f of regions) {
          if (f === r || !f.frameLike || !f.mask) continue;
          const fDil = f._frameDil || (f._frameDil = dilate(f.mask, f.bw, f.bh, 2));
          for (let yy = 0; yy < f.bh; yy++) {
            const dy = f.y0 + yy - r.y0;
            if (dy < 0 || dy >= r.bh) continue;
            for (let xx = 0; xx < f.bw; xx++) {
              if (!fDil[yy * f.bw + xx]) continue;
              const dx = f.x0 + xx - r.x0;
              if (dx >= 0 && dx < r.bw) gm[dy * r.bw + dx] = 0;
            }
          }
        }
        return gm;
      };

      // ---- 闭合区域画家：先把父色块外轮廓绕一圈，再把轮廓内部整个填满，
      //      然后按包含关系逐层画子区域。子区域会覆盖父色，形成“底铺满 →
      //      对象压回来”的真实作画顺序。这里从全局 palette 连通块建区域，
      //      不使用会被局部漫水拆碎的 groupOf，因此大蓝底不会退化成数千碎斑。
      closedPlan = (() => {
        if (!(painterFlow && flatArt)) return null;
        const lc = compsOfLabels(labels, W, H);
        const minArea = Math.max(10, Math.round(N * 0.000012));
        const contourMin = Math.max(36, Math.round(N * 0.000035));
        const polyArea = (loop) => {
          let a = 0;
          const n = loop.n;
          for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            a += loop.pts[i * 2] * loop.pts[j * 2 + 1] - loop.pts[j * 2] * loop.pts[i * 2 + 1];
          }
          return Math.abs(a) * 0.5;
        };
        const pointInPoly = (x, y, loop) => {
          let inside = false;
          const n = loop.n;
          for (let i = 0, j = n - 1; i < n; j = i++) {
            const xi = loop.pts[i * 2], yi = loop.pts[i * 2 + 1];
            const xj = loop.pts[j * 2], yj = loop.pts[j * 2 + 1];
            if (((yi > y) !== (yj > y)) &&
                (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi)) inside = !inside;
          }
          return inside;
        };
        const regions = [];
        for (let ci = 0; ci < lc.comps.length; ci++) {
          const cp = lc.comps[ci];
          if (cp.label < 0 || cp.count < minArea) continue;
          const bw = cp.x1 - cp.x0 + 1, bh = cp.y1 - cp.y0 + 1;
          const mask = new Uint8Array(bw * bh);
          const gidN = new Uint32Array(G_);
          let sr = 0, sg = 0, sb = 0;
          let nearX = cp.x0, nearY = cp.y0, nearD = Infinity;
          const ccx = (cp.x0 + cp.x1) * 0.5, ccy = (cp.y0 + cp.y1) * 0.5;
          for (let k = 0; k < cp.count; k++) {
            const p = lc.pix[cp.start + k];
            const x = p % W, y = (p - x) / W;
            mask[(y - cp.y0) * bw + x - cp.x0] = 1;
            const gid = groupOf[p];
            if (gid >= 0) gidN[gid]++;
            sr += R[p]; sg += G[p]; sb += B[p];
            const d = (x - ccx) * (x - ccx) + (y - ccy) * (y - ccy);
            if (d < nearD) { nearD = d; nearX = x; nearY = y; }
          }
          const gids = [];
          for (let gid = 0; gid < G_; gid++) if (gidN[gid]) gids.push(gid);
          gids.sort((a, b) => gidN[b] - gidN[a]);
          let fillMask = mask;
          let outer = null, loops = null, fillArea = cp.count;
          let solidFill = fillEnclosedHoles(mask, bw, bh);
          let solidLoops = null;
          if (cp.count >= contourMin) {
            const smooth = closeMaskDisk(mask, bw, bh, 1);
            loops = traceContours(smooth, -1, -1, bw, bh, { w: bw, h: bh });
            const solidSmooth = fillEnclosedHoles(smooth, bw, bh);
            solidLoops = traceContours(solidSmooth, -1, -1, bw, bh, { w: bw, h: bh });
            solidFill = solidSmooth;
            let bestA = 0;
            for (const lp of solidLoops) {
              const a = polyArea(lp);
              if (a > bestA) { bestA = a; outer = lp; }
            }
            let fn = 0;
            for (let i = 0; i < solidSmooth.length; i++) if (solidSmooth[i]) fn++;
            if (fn > 0) { fillMask = solidSmooth; fillArea = fn; }
          }
          const bboxArea = Math.max(1, bw * bh);
          const fillRatio = fillArea / bboxArea;
          const ownRatio = cp.count / Math.max(1, fillArea);
          const rawFill = cp.count / bboxArea;
          const longSide = Math.max(bw, bh), shortSide = Math.max(1, Math.min(bw, bh));
          const thickness = cp.count / Math.max(1, longSide);
          const border = cp.x0 <= 1 || cp.y0 <= 1 || cp.x1 >= W - 2 || cp.y1 >= H - 2;
          // 空心边框/字边不能按“闭合后的包围盒占比”判实心：它们的外轮廓
          // 会把内部整片包进来，fillRatio 反而接近 1。用原始连通像素占闭合
          // 填充面积的比例判断，才能识别黑框、红描边这类真正的环。
          const canvasFrame = border && bw >= W * 0.45 && bh >= H * 0.45 && ownRatio < 0.34;
          const frameLike = canvasFrame ||
            (bw >= W * 0.70 && bh >= H * 0.70 && rawFill < 0.12);
          const lineMode = !canvasFrame && (thickness <= Math.max(2.8, 1.25 * scaleB) ||
            (longSide >= shortSide * 5 && fillRatio < 0.10));
          const ringMode = !lineMode && (canvasFrame ||
            (ownRatio < 0.45 && fillArea > cp.count * 1.35 && cp.count >= Math.max(28, N * 0.000035)));
          const mode = lineMode ? 'line' : (ringMode ? 'ring' : 'solid');
          if (mode === 'ring') {
            fillMask = mask;
            fillArea = cp.count;
            let bestA = 0;
            outer = null;
            for (const lp of loops) {
              const a = polyArea(lp);
              if (a > bestA) { bestA = a; outer = lp; }
            }
          } else if (mode === 'solid') {
            fillMask = solidFill;
          }
          // 环形只把真实色带作为自身填充 mask，但保留“补洞后的闭合剪影”。
          // 该剪影不是直接当色块画，而是用于判断它是否包住字心/内部对象。
          // 有子区域时，父形先铺满剪影，再由子区域覆盖回来；没有子区域时
          // 仍按中心线画，避免把空心圆误画成实心圆。
          let hullArea = 0;
          for (let i = 0; i < solidFill.length; i++) if (solidFill[i]) hullArea++;
          regions.push({
            id: regions.length, label: cp.label, area: cp.count, fillArea,
            x0: cp.x0, y0: cp.y0, x1: cp.x1, y1: cp.y1, bw, bh,
            cx: (cp.x0 + cp.x1) * 0.5, cy: (cp.y0 + cp.y1) * 0.5,
            insideX: nearX, insideY: nearY,
            color: [Math.round(sr / cp.count), Math.round(sg / cp.count), Math.round(sb / cp.count)],
            gids, mask, fillMask, outer, loops, mode, hullMask: solidFill, hullArea,
            fillRatio, ownRatio, thickness, canvasFrame, frameLike,
            angle: bw >= bh ? 0 : Math.PI * 0.5,
            parent: null, children: [], depth: 0,
          });
        }
        // 环形/描边也有“领地”：字的外描边是字心的父区域，不是与字心并列的
        // 独立线。用补洞后的闭合剪影建立包含树，再按剪影面积从小到大找最近父层，
        // 这样红描边会先成父形、奶油字心随后覆盖，而不是把两者分别铺成均值块。
        const claims = regions.filter((r) => (r.mode === 'solid' || r.mode === 'ring') &&
          r.outer && r.hullArea >= 32).sort((a, b) => a.hullArea - b.hullArea);
        for (const r of regions) {
          let par = null;
          for (const c of claims) {
            if (c === r || c.hullArea <= r.hullArea * 1.02) continue;
            if (r.insideX < c.x0 || r.insideX > c.x1 || r.insideY < c.y0 || r.insideY > c.y1) continue;
            const ox = Math.round(r.insideX) - c.x0, oy = Math.round(r.insideY) - c.y0;
            if (ox < 0 || oy < 0 || ox >= c.bw || oy >= c.bh) continue;
            if (c.hullMask[oy * c.bw + ox] && pointInPoly(r.insideX - c.x0, r.insideY - c.y0, c.outer)) {
              par = c; break;
            }
          }
          if (par) { r.parent = par; par.children.push(r); }
        }
        const markDepth = (r, d) => {
          r.depth = d;
          for (const ch of r.children) markDepth(ch, d + 1);
        };
        const roots = regions.filter((r) => !r.parent);
        for (const r of roots) markDepth(r, 0);
        // observedMask 只描述真实可见色，paintMask 描述这一层应当铺到的
        // 完整领地。普通实心区域沿用闭合剪影；页面底板再闭包到画幅内部，
        // 从而不会把文字/图形占位提前留成透明洞。
        for (const r of regions) {
          r.paintMask = r.mode === 'solid' ? r.fillMask : r.mask;
        }
        for (const r of regions) {
          if (!pageBaseCandidate(r)) continue;
          r.groundMask = makePageBaseMask(r, regions);
          r.paintMask = r.groundMask;
          r.pageGround = true;
        }
        // 同一页面底色常被文字和扫描纹理切成许多互不相连的色块。页面根
        // 原子块已经拥有完整闭合领地，这些落在领地内、颜色属于同一低对比
        // 色族的实心碎片若再各画一次，只会在成片底色上留下云状补丁。
        // 判定只使用包含关系、面积和相对色差，不按文件名、固定颜色特判。
        const pageAnchors = regions.filter((r) => r.pageGround && pageBaseCandidate(r));
        const groundFragments = new Set();
        for (const anchor of pageAnchors) {
          const gm = anchor.groundMask || anchor.paintMask;
          if (!gm) continue;
          for (const r of regions) {
            if (r === anchor || r.mode !== 'solid' || r.frameLike) continue;
            if (r.fillArea >= anchor.fillArea * 0.72) continue;
            const gap = Math.max(Math.abs(anchor.color[0] - r.color[0]),
              Math.abs(anchor.color[1] - r.color[1]), Math.abs(anchor.color[2] - r.color[2]));
            if (gap > 34) continue;
            const ox = Math.round(r.insideX) - anchor.x0;
            const oy = Math.round(r.insideY) - anchor.y0;
            if (ox < 0 || oy < 0 || ox >= anchor.bw || oy >= anchor.bh || !gm[oy * anchor.bw + ox]) continue;
            groundFragments.add(r);
          }
        }        const rootScore = (r) => (r.x0 <= 1 || r.x1 >= W - 2 || r.y0 <= 1 || r.y1 >= H - 2 ? 1 : 0) * N * 2 + r.area;
        roots.sort((a, b) => rootScore(b) - rootScore(a));
        const order = [];
        const walked = new Set();
        const walk = (r) => {
          if (walked.has(r)) return;
          walked.add(r);
          order.push(r);
          r.children.sort((a, b) =>
            (b.area * (0.94 + 0.12 * srnd(b.id + 17.3, 7.1))) -
            (a.area * (0.94 + 0.12 * srnd(a.id + 17.3, 7.1))));
          for (const ch of r.children) walk(ch);
        };
        for (const r of roots) walk(r);
        // 兜底保证每个闭合区域都恰好进入一次；即使包含关系仍有异常，也不能丢色。
        for (const r of regions) if (!walked.has(r)) walk(r);
        if (opts.debug) {
          const modes = order.reduce((m, r) => { m[r.mode] = (m[r.mode] || 0) + 1; return m; }, {});
          console.log('[closed] regions=' + regions.length + ' roots=' + roots.length +
            ' modes=' + JSON.stringify(modes) + ' largest=' +
            order.slice(0, 6).map((r) => r.area + ':' + r.mode + ':' + r.color.join(',')).join(' | '));
        }
        return { regions, order, roots, groundFragments, sourceComps: lc.comps };
      })();

      // ---- 无训练绘画编译器 ----
      // 与 closed 路径并列：同样把父区域整块填满，但区域颜色不再是一个均值。
      // 每个对象会拟合“常数 / 平面渐变 / 2~4 条色带”中最简单且误差最低的色场；
      // 细线条单独成为候选，全部区域画完后再压到最上层。
      compilerPlan = (() => {
        if (!(compilerFlow && flatArt)) return null;
        const lc = compsOfLabels(labels, W, H);
        const minArea = Math.max(9, Math.round(N * 0.000009));
        const contourMin = Math.max(28, Math.round(N * 0.000028));
        const frameMinX = W * 0.45, frameMinY = H * 0.45;
        const polyArea = (loop) => {
          let a = 0;
          const n = loop.n;
          for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            a += loop.pts[i * 2] * loop.pts[j * 2 + 1] - loop.pts[j * 2] * loop.pts[i * 2 + 1];
          }
          return Math.abs(a) * 0.5;
        };
        const pointInPoly = (x, y, loop) => {
          let inside = false;
          const n = loop.n;
          for (let i = 0, j = n - 1; i < n; j = i++) {
            const xi = loop.pts[i * 2], yi = loop.pts[i * 2 + 1];
            const xj = loop.pts[j * 2], yj = loop.pts[j * 2 + 1];
            if (((yi > y) !== (yj > y)) &&
                (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi)) inside = !inside;
          }
          return inside;
        };
        const clampC = (v, lo, hi) => v < lo ? lo : (v > hi ? hi : v);
        const solve3 = (A, y) => {
          const a = A[0], b = A[1], c = A[2], d = A[3], e = A[4], f = A[5], g = A[6], h = A[7], k = A[8];
          const det = a * (e * k - f * h) - b * (d * k - f * g) + c * (d * h - e * g);
          if (Math.abs(det) < 1e-8) return null;
          return [
            (y[0] * (e * k - f * h) - b * (y[1] * k - f * y[2]) + c * (y[1] * h - e * y[2])) / det,
            (a * (y[1] * k - f * y[2]) - y[0] * (d * k - f * g) + c * (d * y[2] - y[1] * g)) / det,
            (a * (e * y[2] - y[1] * h) - b * (d * y[2] - y[1] * g) + y[0] * (d * h - e * g)) / det,
          ];
        };
        const fitColorModel = (mask, bw, bh, x0, y0, count) => {
          let sr = 0, sg = 0, sb = 0, mnR = 255, mnG = 255, mnB = 255, mxR = 0, mxG = 0, mxB = 0;
          let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
          const syr = [0, 0, 0], syg = [0, 0, 0], syb = [0, 0, 0];
          const dx = Math.max(1, bw - 1), dy = Math.max(1, bh - 1);
          for (let yy = 0; yy < bh; yy++) {
            const row = (y0 + yy) * W + x0;
            for (let xx = 0; xx < bw; xx++) {
              if (!mask[yy * bw + xx]) continue;
              const p = row + xx, r = R[p], g = G[p], b = B[p];
              sr += r; sg += g; sb += b;
              if (r < mnR) mnR = r; if (r > mxR) mxR = r;
              if (g < mnG) mnG = g; if (g > mxG) mxG = g;
              if (b < mnB) mnB = b; if (b > mxB) mxB = b;
              const nx = xx / dx, ny = yy / dy;
              sx += nx; sy += ny; sxx += nx * nx; sxy += nx * ny; syy += ny * ny;
              syr[0] += r; syr[1] += r * nx; syr[2] += r * ny;
              syg[0] += g; syg[1] += g * nx; syg[2] += g * ny;
              syb[0] += b; syb[1] += b * nx; syb[2] += b * ny;
            }
          }
          const invN = 1 / Math.max(1, count);
          const mean = [Math.round(sr * invN), Math.round(sg * invN), Math.round(sb * invN)];
          const evalPlane = (m, x, y) => {
            if (!m) return mean;
            const nx = (x - x0) / dx, ny = (y - y0) / dy;
            return [m.coef[0][0] + m.coef[0][1] * nx + m.coef[0][2] * ny,
              m.coef[1][0] + m.coef[1][1] * nx + m.coef[1][2] * ny,
              m.coef[2][0] + m.coef[2][1] * nx + m.coef[2][2] * ny];
          };
          const modelAt = (m, x, y) => {
            if (!m) return mean.slice();
            let c;
            if (m.kind === 'plane') c = evalPlane(m, x, y);
            else if (m.kind === 'grid') {
              const nx = Math.max(0, Math.min(1, (x - x0) / dx));
              const ny = Math.max(0, Math.min(1, (y - y0) / dy));
              const fx = nx * (m.gx - 1), fy = ny * (m.gy - 1);
              const ix = Math.min(m.gx - 2, Math.floor(fx)), iy = Math.min(m.gy - 2, Math.floor(fy));
              const tx = m.gx === 1 ? 0 : fx - ix, ty = m.gy === 1 ? 0 : fy - iy;
              const i00 = (iy * m.gx + ix) * 3, i10 = i00 + 3;
              const i01 = i00 + m.gx * 3, i11 = i01 + 3;
              c = [0, 1, 2].map((ch) => {
                const top = m.grid[i00 + ch] * (1 - tx) + m.grid[i10 + ch] * tx;
                const bot = m.grid[i01 + ch] * (1 - tx) + m.grid[i11 + ch] * tx;
                return top * (1 - ty) + bot * ty;
              });
            } else if (m.kind === 'bands') {
              const t = m.axis === 0 ? (x - x0) / dx : (y - y0) / dy;
              const bi = Math.max(0, Math.min(m.colors.length - 1, Math.floor(t * m.colors.length)));
              c = m.colors[bi];
            } else c = m.mean;
            return [Math.round(clampC(c[0], m.lo[0], m.hi[0])),
              Math.round(clampC(c[1], m.lo[1], m.hi[1])),
              Math.round(clampC(c[2], m.lo[2], m.hi[2]))];
          };
          const errOf = (m) => {
            let err = 0, n = 0;
            for (let yy = 0; yy < bh; yy++) {
              const row = (y0 + yy) * W + x0;
              for (let xx = 0; xx < bw; xx++) {
                if (!mask[yy * bw + xx]) continue;
                const p = row + xx, c = modelAt(m, x0 + xx, y0 + yy);
                err += Math.max(Math.abs(c[0] - R[p]), Math.abs(c[1] - G[p]), Math.abs(c[2] - B[p]));
                n++;
              }
            }
            return err / Math.max(1, n);
          };
          const lo = [Math.max(0, mnR - 10), Math.max(0, mnG - 10), Math.max(0, mnB - 10)];
          const hi = [Math.min(255, mxR + 10), Math.min(255, mxG + 10), Math.min(255, mxB + 10)];
          let best = { kind: 'const', mean, lo, hi, err: 0 };
          best.err = errOf(best);
          if (count >= 18) {
            const A = [count, sx, sy, sx, sxx, sxy, sy, sxy, syy];
            const cr = solve3(A, syr), cg = solve3(A, syg), cb = solve3(A, syb);
            if (cr && cg && cb) {
              const pm = { kind: 'plane', coef: [cr, cg, cb], mean, lo, hi, err: 0 };
              pm.err = errOf(pm);
              if (pm.err + 1.25 < best.err) best = pm;
            }
            // 大色块用低分辨率双线性色场：它等价于“现场从原图采样一张
            // 4×4 调色网”，能跟随扫描件的暗角、纸张渐变和低频明暗，却不把
            // 同色背景重新切成独立补丁。所有格子由闭合 mask 自己采样。
            if (count >= 300) {
              const gx = count >= 100000 ? 32 : (count >= 1200 ? 10 : 4);
              const gy = gx;
              const ga = new Float64Array(gx * gy * 4);
              for (let yy = 0; yy < bh; yy++) {
                const row = (y0 + yy) * W + x0;
                const iy = Math.min(gy - 1, Math.floor(yy / bh * gy));
                for (let xx = 0; xx < bw; xx++) {
                  if (!mask[yy * bw + xx]) continue;
                  const ix = Math.min(gx - 1, Math.floor(xx / bw * gx));
                  const gi = (iy * gx + ix) * 4, p = row + xx;
                  ga[gi] += R[p]; ga[gi + 1] += G[p]; ga[gi + 2] += B[p]; ga[gi + 3]++;
                }
              }
              const grid = new Float64Array(gx * gy * 3);
              let missing = false;
              for (let gi = 0; gi < gx * gy; gi++) {
                const n = ga[gi * 4 + 3];
                if (n) {
                  grid[gi * 3] = ga[gi * 4] / n;
                  grid[gi * 3 + 1] = ga[gi * 4 + 1] / n;
                  grid[gi * 3 + 2] = ga[gi * 4 + 2] / n;
                } else missing = true;
              }
              if (missing) {
                // 空洞格先用最近的有效格补齐；仍然没有就退回区域均值。
                for (let pass = 0; pass < gx + gy && missing; pass++) {
                  const cp = grid.slice();
                  missing = false;
                  for (let yy = 0; yy < gy; yy++) {
                    for (let xx = 0; xx < gx; xx++) {
                      const gi = yy * gx + xx;
                      if (ga[gi * 4 + 3]) continue;
                      let sr = 0, sg2 = 0, sb2 = 0, sn = 0;
                      for (let ddy = -1; ddy <= 1; ddy++) for (let ddx = -1; ddx <= 1; ddx++) {
                        const nx2 = xx + ddx, ny2 = yy + ddy;
                        if (nx2 < 0 || ny2 < 0 || nx2 >= gx || ny2 >= gy) continue;
                        const ni = ny2 * gx + nx2;
                        if (!ga[ni * 4 + 3]) continue;
                        sr += cp[ni * 3]; sg2 += cp[ni * 3 + 1]; sb2 += cp[ni * 3 + 2]; sn++;
                      }
                      if (sn) {
                        grid[gi * 3] = sr / sn; grid[gi * 3 + 1] = sg2 / sn; grid[gi * 3 + 2] = sb2 / sn;
                        ga[gi * 4 + 3] = 1;
                      } else missing = true;
                    }
                  }
                }
              }
              const gm = { kind: 'grid', gx, gy, grid, mean, lo, hi, err: 0 };
              gm.err = errOf(gm);
              if (gm.err + 0.9 < best.err) best = gm;
            }
            const vx = sxx / count - (sx / count) * (sx / count);
            const vy = syy / count - (sy / count) * (sy / count);
            const axis = vx >= vy ? 0 : 1;
            const Kmax = count >= 900 ? 4 : (count >= 260 ? 3 : 2);
            for (let K = 2; K <= Kmax; K++) {
              const acc = Array.from({ length: K }, () => [0, 0, 0, 0]);
              for (let yy = 0; yy < bh; yy++) {
                const row = (y0 + yy) * W + x0;
                for (let xx = 0; xx < bw; xx++) {
                  if (!mask[yy * bw + xx]) continue;
                  const t = axis === 0 ? xx / dx : yy / dy;
                  const bi = Math.max(0, Math.min(K - 1, Math.floor(t * K)));
                  const p = row + xx;
                  acc[bi][0] += R[p]; acc[bi][1] += G[p]; acc[bi][2] += B[p]; acc[bi][3]++;
                }
              }
              const colors = acc.map((a) => a[3] ? [a[0] / a[3], a[1] / a[3], a[2] / a[3]] : mean);
              const bm = { kind: 'bands', axis, colors, mean, lo, hi, err: 0 };
              bm.err = errOf(bm);
              if (bm.err + 0.85 * (K - 1) < best.err) best = bm;
            }
          }
          best.mean = mean;
          best.lo = lo;
          best.hi = hi;
          best.colorAt = (x, y) => modelAt(best, x, y);
          best.strokeCount = best.kind === 'const' ? 1 :
            (best.kind === 'plane' ? 2 : (best.kind === 'grid' ? best.gx * best.gy : best.colors.length));
          return best;
        };

        const regions = [];
        for (let ci = 0; ci < lc.comps.length; ci++) {
          const cp = lc.comps[ci];
          if (cp.label < 0 || cp.count < minArea) continue;
          const bw = cp.x1 - cp.x0 + 1, bh = cp.y1 - cp.y0 + 1;
          const mask = new Uint8Array(bw * bh);
          let nearX = cp.x0, nearY = cp.y0, nearD = Infinity;
          const ccx = (cp.x0 + cp.x1) * 0.5, ccy = (cp.y0 + cp.y1) * 0.5;
          for (let k = 0; k < cp.count; k++) {
            const p = lc.pix[cp.start + k];
            const x = p % W, y = (p - x) / W;
            mask[(y - cp.y0) * bw + x - cp.x0] = 1;
            const d = (x - ccx) * (x - ccx) + (y - ccy) * (y - ccy);
            if (d < nearD) { nearD = d; nearX = x; nearY = y; }
          }
          const longSide = Math.max(bw, bh), shortSide = Math.max(1, Math.min(bw, bh));
          const thickness = cp.count / Math.max(1, longSide);
          const rawFill = cp.count / Math.max(1, bw * bh);
          const border = cp.x0 <= 1 || cp.y0 <= 1 || cp.x1 >= W - 2 || cp.y1 >= H - 2;
          const canvasFrame = border && bw >= frameMinX && bh >= frameMinY && rawFill < 0.34;
          // 不贴画布边缘的大画框同样只是边界线，不是内容父块；否则它的
          // 补洞剪影会先铺满整页，再靠子区域覆盖，既浪费笔数又容易露底。
          const frameLike = canvasFrame ||
            (bw >= W * 0.70 && bh >= H * 0.70 && rawFill < 0.12);
          const lineMode = !canvasFrame && (thickness <= Math.max(2.8, 1.2 * scaleB) ||
            (longSide >= shortSide * 4.5 && rawFill < 0.17));
          const hull = cp.count >= contourMin ? closeMaskDisk(mask, bw, bh, 1) : mask.slice();
          const loops = cp.count >= contourMin ? traceContours(hull, -1, -1, bw, bh, { w: bw, h: bh }) : [];
          // 紧凑的小圆点/小字块不能补洞后当实心外接形处理：一两像素的抗锯齿
          // 缺口会把圆点补成方块，把字角补成色板。小掩膜直接保留真实像素几何；
          // 只有大色面才需要闭合内部洞、建立父子领地。
          const compactSolid = cp.count <= Math.max(900, N * 0.0012) &&
            bw * bh <= 2500 && rawFill >= 0.58;
          let solidFill = lineMode ? hull : (compactSolid ? mask.slice() : fillEnclosedHoles(hull, bw, bh));
          // 大面积实心父块的闭合边界要覆盖源图 1px 抗锯齿带，否则圆/斜边
          // 会周期性露出底色形成锯齿。外扩只发生在大父块，子区域仍按
          // 各自 mask 覆盖回来。
          if (!lineMode && !canvasFrame && cp.count >= N * 0.01) {
            solidFill = dilate(solidFill, bw, bh, 1);
          }
          let fillArea = 0;
          for (let i = 0; i < solidFill.length; i++) if (solidFill[i]) fillArea++;
          const hullArea = fillArea;
          const ownRatio = cp.count / Math.max(1, fillArea);
          let outer = null;
          if (!lineMode) {
            const outLoops = traceContours(solidFill, -1, -1, bw, bh, { w: bw, h: bh });
            let bestA = 0;
            for (const lp of outLoops) {
              const a = polyArea(lp);
              if (a > bestA) { bestA = a; outer = lp; }
            }
          }
          // 环/字边/画框不能当实心父块：fillEnclosedHoles 会把整个内部都
          // 当成它的领地，后续子对象再正确也会先被一整片错误颜色覆盖。
          // 用“原始像素 / 闭合面积”识别真正的空心轮廓，与 closed 路径一致。
          // 但大面积厚色面即使被内部元素挖出很多洞，也不是“线环”：它更像
          // 背景/版面父块，必须作为实心领地，否则只剩中心线会把内部留白。
          const thickFill = !lineMode && !border && cp.count >= N * 0.04 &&
            thickness >= Math.max(8, Math.min(W, H) * 0.025) &&
            bw >= W * 0.55 && bh >= H * 0.55;
          const ringMode = !lineMode && !thickFill && (canvasFrame ||
            (ownRatio < 0.45 && fillArea > cp.count * 1.35 &&
              cp.count >= Math.max(28, N * 0.000035)));
          let mode = lineMode ? 'line' : (ringMode ? 'ring' : 'solid');
          let fillMask = mask;
          if (mode === 'solid') { fillMask = solidFill; fillArea = Math.max(1, fillArea); }
          else if (mode === 'ring') {
            fillMask = mask;
            fillArea = cp.count;
            // 环形只画自身轮廓，领地不包含内部。
            outer = null;
            let bestA = 0;
            for (const lp of loops) {
              const a = polyArea(lp);
              if (a > bestA) { bestA = a; outer = lp; }
            }
          } else fillArea = cp.count;
          const model = fitColorModel(mask, bw, bh, cp.x0, cp.y0, cp.count);
          regions.push({
            id: regions.length, label: cp.label, area: cp.count, fillArea,
            x0: cp.x0, y0: cp.y0, x1: cp.x1, y1: cp.y1, bw, bh,
            cx: (cp.x0 + cp.x1) * 0.5, cy: (cp.y0 + cp.y1) * 0.5,
            insideX: nearX, insideY: nearY,
            color: model.mean, model, mask, fillMask,
            paintMask: mode === 'solid' ? solidFill : mask, outer, loops,
            hullMask: solidFill, hullArea,
            mode, rawFill, ownRatio, thickness, canvasFrame, frameLike,
            angle: bw >= bh ? 0 : Math.PI * 0.5,
            parent: null, children: [], depth: 0,
          });
        }

        // 实心色块和空心描边都可以拥有领地。描边作为父层时使用“补洞后的
        // 闭合剪影”建立父子关系：红色外描边 → 奶油字心，而不是两个互不相干
        // 的色块。是否真的把剪影填满由执行器按 children 决定，空心圆仍走线。
        // 页面级底板本身也可能占画幅 80% 以上；不能按面积上限把它排除在
        // 包含树之外。所有拥有闭合外轮廓的实心块/描边环都可以是父层，
        // 由“最小且真正包含该区域”的候选决定直接父节点。
        const claims = regions.filter((r) => (r.mode === 'solid' ||
          (r.mode === 'ring' && !r.frameLike)) &&
          r.outer && r.hullArea >= 24).sort((a, b) => a.hullArea - b.hullArea);
        const ownedByFill = (c, x, y) => {
          const xx = Math.round(x) - c.x0, yy = Math.round(y) - c.y0;
          return xx >= 0 && yy >= 0 && xx < c.bw && yy < c.bh &&
            !!c.fillMask[yy * c.bw + xx];
        };
        // fillMask 只能证明“可见色面”，而子对象会把父色面挖成缺口。
        // 父层自己的闭合外轮廓/补洞剪影同样具有领地资格。
        const ownedByOutline = (c, x, y) => !!c.outer &&
          x >= c.x0 && y >= c.y0 && x <= c.x1 && y <= c.y1 &&
          pointInPoly(x - c.x0, y - c.y0, c.outer);
        const ownedByHull = (c, x, y) => {
          const xx = Math.round(x) - c.x0, yy = Math.round(y) - c.y0;
          return xx >= 0 && yy >= 0 && xx < c.bw && yy < c.bh &&
            !!c.hullMask[yy * c.bw + xx];
        };
        for (const r of regions) {
          let par = null;
          for (const c of claims) {
            if (c === r || c.hullArea <= r.hullArea * 1.015) continue;
            if (ownedByFill(c, r.insideX, r.insideY) ||
              ownedByHull(c, r.insideX, r.insideY) ||
              ownedByOutline(c, r.insideX, r.insideY)) { par = c; break; }
          }
          if (par) { r.parent = par; par.children.push(r); }
        }
        const markDepth = (r, d) => { r.depth = d; for (const ch of r.children) markDepth(ch, d + 1); };
        const roots = regions.filter((r) => !r.parent);
        for (const r of roots) markDepth(r, 0);
        // 非页面父块的闭合边向外补 1px，覆盖源图抗锯齿带；子区域仍会在
        // 后面覆盖内部。页面根底板不做此扩边，避免侵入黑色画框。
        // 父块的原始 mask 已经包含源图抗锯齿边；这里不能再统一外扩 1px。
        // 第二次扩边会把字心、圆边和描边一起撑粗，导致轮廓比原图大一圈。
        // 页面级实心色块按“闭合领地”而不是可见像素排序：外层纸色常常
        // 把内层深色底板当洞填满，必须先落外层，再让内层底板覆盖回来。
        const rootScore = (r) => (r.x0 <= 1 || r.x1 >= W - 2 || r.y0 <= 1 || r.y1 >= H - 2 ? N * 2 : 0) +
          (r.mode === 'solid' && r.fillArea >= N * 0.12 ? r.fillArea : r.area);
        roots.sort((a, b) => rootScore(b) - rootScore(a));
        const order = [];
        const walked = new Set();
        const walk = (r) => {
          if (walked.has(r)) return;
          walked.add(r);
          order.push(r);
          r.children.sort((a, b) => (b.area * (0.95 + 0.10 * srnd(b.id + 23.7, 7.9))) -
            (a.area * (0.95 + 0.10 * srnd(a.id + 23.7, 7.9))));
          for (const ch of r.children) walk(ch);
        };
        for (const r of roots) walk(r);
        for (const r of regions) if (!walked.has(r)) walk(r);

        // ---- 同色族碎块溶解 ----
        // 背景渐变/纸张纹理会被量化成很多相邻小块。它们不是独立对象：如果
        // 某个后代与父层的代表性颜色只差一个低对比量级，就让父层的连续色场
        // 一并负责它，不再逐块覆盖，否则成品会出现大面积“补丁云”。
        // 父层色场会用“自身 + 被溶解后代”的像素重新拟合，但仍只填父层自己的
        // 完整闭合 mask；真正的异色字心、描边和线条不会进入这个并集。
        const normalized = new Set();
        const colorGap = (a, b) => Math.max(Math.abs(a[0] - b[0]),
          Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
        for (const r of regions) r.familyColor = r.color.slice();
        for (const r of order) {
          if (normalized.has(r)) continue;
          const close = [];
          const stack = r.children.slice();
          while (stack.length) {
            const ch = stack.pop();
            const gap = colorGap(r.familyColor, ch.familyColor);
            // 只溶解真正低对比的纹理碎片。32 级左右的成片第二颜色通常是
            // 外圈/阴影等有意设计，不能并进父色均值，否则整圈会错色。
            if (gap <= 20) close.push(ch);
            for (const gc of ch.children) stack.push(gc);
          }
          if (!close.length) continue;
          const modelMask = new Uint8Array(r.bw * r.bh);
          let modelPx = 0;
          const addMask = (x0, y0, m, mw, mh) => {
            for (let yy = 0; yy < mh; yy++) {
              const dy = y0 + yy - r.y0;
              if (dy < 0 || dy >= r.bh) continue;
              for (let xx = 0; xx < mw; xx++) {
                if (!m[yy * mw + xx]) continue;
                const dx = x0 + xx - r.x0;
                if (dx < 0 || dx >= r.bw) continue;
                const di = dy * r.bw + dx;
                if (!modelMask[di]) { modelMask[di] = 1; modelPx++; }
              }
            }
          };
          addMask(r.x0, r.y0, r.mask, r.bw, r.bh);
          for (const ch of close) addMask(ch.x0, ch.y0, ch.mask, ch.bw, ch.bh);
          if (modelPx > 0) {
            r.model = fitColorModel(modelMask, r.bw, r.bh, r.x0, r.y0, modelPx);
            r.color = r.model.mean;
            r.modelPx = modelPx;
          }
          // 低对比碎块仍保留自己的真实几何，避免吸收后露出纸白；
          // 但它们统一使用父层重新拟合的连续色场，成品的颜色接缝因此消失。
          for (const ch of close) {
            ch.model = r.model;
            ch.color = r.model.mean;
            ch.modelFrom = r.id;
            normalized.add(ch);
          }
        }

        // 跨包含树溶解同色背景：`labels` 会把同一片蓝色底按扫描纹理切成
        // 多个互不相连的根，单靠“父子关系”只能归一其中一部分，剩下的根
        // 各用不同均值扫描，成品就出现云状补丁。这里再用实际闭合 mask +
        // 代表色做一次与树结构无关的归并：只要一个区域落在较大实心色块的
        // 领地内、颜色又属于同一低对比族，就共享后者的连续色场。
        const familyAnchors = regions.filter((r) => r.mode === 'solid' &&
          !normalized.has(r) && r.fillArea >= Math.max(96, N * 0.00022))
          .sort((a, b) => b.fillArea - a.fillArea);
        for (const anchor of familyAnchors) {
          for (const r of regions) {
            if (r === anchor || normalized.has(r) || r.fillArea >= anchor.fillArea * 0.82) continue;
            const nested = ownedByFill(anchor, r.insideX, r.insideY);
            // 几何嵌套中的独立色带必须用更严格的色差门槛；页面外缘碎片
            // 允许更宽，因为它们本来就是同一扫描底色的断裂块。
            if (colorGap(anchor.familyColor, r.familyColor) > (nested ? 20 : 34)) continue;
            // 扫描海报的底色常被字/边框切断成若干互不相连的根。它们与主底
            // 同色、贴画幅外缘，但不满足“几何包含”。这类页面级碎片也必须
            // 共享主底的色场，否则每个根都会各自勾边并重新取色，形成色块云。
            const edgeBand = r.x0 <= W * 0.06 || r.x1 >= W * 0.94 ||
              r.y0 <= H * 0.06 || r.y1 >= H * 0.94;
            const pageFragment = anchor.fillArea >= N * 0.12 && r.fillArea >= N * 0.0015 && edgeBand;
            if (!nested && !pageFragment) continue;
            r.model = anchor.model;
            r.color = anchor.model.mean;
            r.modelFrom = anchor.id;
            normalized.add(r);
          }
        }

        // 页面级锚点把同一色场的碎块合并成一张连续“底板”。它们本来就会被
        // 父色场一起覆盖，保留为独立小区域只会让后续补缝各取局部均值，重新
        // 形成色块云。只对真正的页面大底色启用，不吞普通对象内部的小色块。
        const pageGround = (r) => r.mode === 'solid' && r.outer && !normalized.has(r) &&
          r.fillArea >= N * 0.12 && (r.bw >= W * 0.55 || r.bh >= H * 0.55);
        for (const r of regions) {
          if (!pageGround(r)) continue;
          // 页面根底板取闭合包围矩形，再精确挖掉所有画框环。这样文字、
          // 图案和同色扫描碎片在父层内部都会先被父色盖住，同时蓝底不会
          // 越过闭合画框。不能直接用色块 fillMask：它会把扫描海报拆成
          // 若干洞，成品边缘重新出现深色补丁。
          const rootBlock = pageBaseCandidate(r);
          const gm = rootBlock ? makePageBaseMask(r, regions) : r.fillMask.slice();
          if (!rootBlock) {
            for (const ch of regions) {
              if (ch === r || ch.modelFrom !== r.id || !ch.mask) continue;
              for (let yy = 0; yy < ch.bh; yy++) {
                const dy = ch.y0 + yy - r.y0;
                if (dy < 0 || dy >= r.bh) continue;
                for (let xx = 0; xx < ch.bw; xx++) {
                  if (!ch.mask[yy * ch.bw + xx]) continue;
                  const dx = ch.x0 + xx - r.x0;
                  if (dx < 0 || dx >= r.bw) continue;
                  gm[dy * r.bw + dx] = 1;
                }
              }
            }
          }
          r.groundMask = gm;
          r.paintMask = gm;
          r.pageGround = true;
          // 大底板用色场表达明暗，不雕塑扫描颗粒。对 32×32 色场做两次
          // 3×3 低通，只作用于页面级锚点；文字/图形自己的色块不经过这里。
          const m = r.model;
          if (m && m.kind === 'grid' && m.grid) {
            for (let pass = 0; pass < 2; pass++) {
              const src = m.grid.slice();
              for (let yy = 0; yy < m.gy; yy++) for (let xx = 0; xx < m.gx; xx++) {
                let sr = 0, sg = 0, sb = 0, n = 0;
                for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                  const nx = xx + dx, ny = yy + dy;
                  if (nx < 0 || ny < 0 || nx >= m.gx || ny >= m.gy) continue;
                  const ii = (ny * m.gx + nx) * 3;
                  sr += src[ii]; sg += src[ii + 1]; sb += src[ii + 2]; n++;
                }
                const q = (yy * m.gx + xx) * 3;
                m.grid[q] = sr / n; m.grid[q + 1] = sg / n; m.grid[q + 2] = sb / n;
              }
            }
          }
        }

        // 所有权图：父层先填满，子层覆盖；线条最后落笔，所以线像素归线条。
        const skipLine = (r) => normalized.has(r) && r.mode === 'line';
        const owner = new Int32Array(N).fill(-1);
        for (const r of order) {
          // 已归一的同色碎块由锚点统一持有。若这里再把 owner 写回碎块，
          // 后面的背景识别会把它们当成前景重画，云状补丁又会出现。
          if (normalized.has(r)) continue;
          const om = r.groundMask || r.fillMask;
          for (let yy = 0; yy < r.bh; yy++) {
            const row = (r.y0 + yy) * W + r.x0;
            for (let xx = 0; xx < r.bw; xx++) {
              if (!om[yy * r.bw + xx]) continue;
              const p = row + xx;
              if (!segPaper[p]) owner[p] = r.id;
            }
          }
        }
        // 归一子块仍保留自己的真实几何发笔，负责补住扫带在窄缝/奇形边界
        // 上留下的纸白；它的颜色继承同一父色场，因此不会形成新的色块接缝。
        // 归一到父色场的碎块只保留真实子对象继续覆盖；碎块自身不再重复
        // 勾边/铺色。父区域已经用完整闭合色场盖过它们，再画一遍只会产生
        // 低对比接缝，并把笔数翻倍。
        // 归一碎块默认由锚点的 groundMask 一次铺过。若它只是页面根底板的
        // 一个实心碎片，再填一遍会把锚点色场在边框/抗锯齿附近的暗值刷回
        // 底板，形成云斑。环形描边、非页面根锚点下的实心区域（例如 s9 的
        // 奶油色圆形）仍有独立几何，必须保留。判断只依赖层级、面积和锚点，
        // 不依赖文件名或固定颜色。
        const pageRootAnchor = (r) => {
          if (r.modelFrom === undefined) return false;
          const a = regions[r.modelFrom];
          return pageBaseCandidate(a);
        };
        const fills = order.filter((r) => {
          if (r.mode === 'line') return false;
          if (!normalized.has(r)) return true;
          if (r.modelFrom === undefined || r.fillArea < N * 0.005) return false;
          // 页面根底板下的大型实心碎片已经在 groundMask 中铺过；小实心块
          // （s9 的杯口局部等）仍保留独立覆盖，不能一刀切丢掉。
          return !(r.mode === 'solid' && pageRootAnchor(r) &&
            r.fillArea >= N * 0.006);
        });
        const lines = order.filter((r) => r.mode === 'line' && !skipLine(r));
        // 给对象执行器一份“背景所有权”：只由顶层大色面和群组自身的 bg 标记
        // 构成，不按图片类型硬编码。前景字/线即使紧贴背景，其多数像素仍由
        // 子区域持有，因此不会被误当作背景跳过。
        const bgRegionIds = new Set();
        for (const r of regions) {
          if (r.depth !== 0 || r.mode === 'line') continue;
          if (r.fillArea >= N * 0.01 || (r.mode === 'ring' && r.fillArea >= N * 0.0015)) {
            bgRegionIds.add(r.id);
          }
        }
        const objectBgGids = new Uint8Array(G_);
        const bgHits = new Int32Array(G_);
        const groundHits = new Int32Array(G_);
        const groundDist = new Float64Array(G_);
        const groundDistN = new Int32Array(G_);
        for (let p = 0; p < N; p++) {
          const gid = groupOf[p];
          if (gid < 0) continue;
          const oid = owner[p];
          if (oid < 0) continue;
          const r = regions[oid];
          if (!r) continue;
          if (bgRegionIds.has(oid)) bgHits[gid]++;
          // 页面底板的 groundMask 已排除字心、前景对象和描边；但仍会留下
          // 扫描纹理和抗锯齿碎组。用碎组均值到“锚点总均值”的距离判断：
          // 同族蓝色纹理归背景，红字边、奶油字心等偏离主色的组仍交给组级
          // 收口。不能使用局部色场取值，因为边框附近色场本身会被暗边污染。
          if (!r.pageGround) continue;
          const g = groups[gid];
          if (!g) continue;
          groundHits[gid]++;
          groundDist[gid] += Math.max(Math.abs(r.model.mean[0] - g.mean[0]),
            Math.abs(r.model.mean[1] - g.mean[1]), Math.abs(r.model.mean[2] - g.mean[2]));
          groundDistN[gid]++;
        }
        // “父层所有权”只能用来识别真正成片的背景，不能把背景上的小字/
        // 抗锯齿碎片一起吞掉。小色组即使整块落在顶层背景区域内，也仍是
        // 前景细节，必须留给组级收口；否则 s8/s9 这类小字会被静默跳过。
        const bgMinArea = Math.max(400, Math.round(N * 0.00045));
        for (const g of groups) {
          const groundLike = groundHits[g.gid] >= Math.max(2, g.area * 0.5) &&
            groundDistN[g.gid] > 0 && groundDist[g.gid] / groundDistN[g.gid] <= 64;
          if (g.bg || groundLike ||
            (bgHits[g.gid] >= g.area * 0.5 && g.area >= bgMinArea)) {
            objectBgGids[g.gid] = 1;
          }
        }
        if (opts.debug) {
          const kinds = fills.reduce((m, r) => { m[r.model.kind] = (m[r.model.kind] || 0) + 1; return m; }, {});
          console.log('[compiler] regions=' + regions.length + ' fills=' + fills.length + ' lines=' + lines.length +
            ' normalized=' + normalized.size + ' models=' + JSON.stringify(kinds) + ' largest=' +
            order.slice(0, 6).map((r) => r.area + ':' + r.mode + ':' + r.model.kind).join(' | '));
        }
        return { regions, order, roots, fills, lines, owner, normalized, fitColorModel, sourceComps: lc.comps, objectBgGids };
      })();
      compilerActive = !!(compilerFlow && flatArt && compilerPlan && compilerPlan.order.length);
      closedActive = !!(painterFlow && flatArt && closedPlan && closedPlan.order.length);
      // 闭合路径自己负责完整作画；旧背景规划只作为 artist/回退路径的参考，
      // 不能再用 bgFirstPlan 的有无来决定 painter 是否启动。
      painterActive = painterFlow && flatArt && !!bgFirstPlan && !closedActive;
      const phaseGroups = [[], [], [], []];
      for (const g of groups) phaseGroups[phaseOf(g)].push(g);
      const orderClass = (g, ph) => {
        if (flatArt) {
          if (ph === 1) {
            const ml = 0.299 * g.mean[0] + 0.587 * g.mean[1] + 0.114 * g.mean[2];
            return g.backdrop ? 0 : (g.bg && ml > 243 ? 2 : 1);
          }
          if (ph === 2) return g.lineLike ? 0 : 1;
        }
        return 0;
      };
      for (let ph = 0; ph < 4; ph++) {
        const arr = phaseGroups[ph];
        if (ph === 0) {
          arr.sort((a, b) => (b.area * (0.94 + 0.12 * srnd(b.gid, 2))) -
            (a.area * (0.94 + 0.12 * srnd(a.gid, 2))));
        } else if (ph === 1) {
          // 平涂：背景浅粉先铺，猫身奶油色随后，几乎看不出的白纸边最后补。
          arr.sort((a, b) => (orderClass(a, 1) - orderClass(b, 1)) ||
            ((b.area * (0.95 + 0.10 * srnd(b.gid, 3))) -
              (a.area * (0.95 + 0.10 * srnd(a.gid, 3)))));
        } else if (ph === 2) {
          // 塑形先补色块交界那一圈过渡色，把白缝收掉，再画眼睛/腮红/小装饰。
          arr.sort((a, b) => (orderClass(a, 2) - orderClass(b, 2)) ||
            ((b.area * (0.92 + 0.16 * srnd(b.gid, 4))) -
              (a.area * (0.92 + 0.16 * srnd(a.gid, 4)))));
        } else {
          // 点睛：外圈结构先落，五官/胡须/高光最后；距离视觉中心越近越靠后。
          arr.sort((a, b) => (b.dF * (0.9 + 0.2 * srnd(b.gid, 5))) -
            (a.dF * (0.9 + 0.2 * srnd(a.gid, 5))));
        }
      }
      // 阶段内部按"优先级小桶 + 就近串笔"：大桶保证先大形后细节，
      // 小桶保证手不来回飞；换种子只改桶内次序/起笔点，不改阶段本身。
      const chainChunks = (arr, sx, sy, B) => {
        const out = [];
        let cx = sx, cy = sy;
        const chunkN = B || 24;
        for (let i = 0; i < arr.length; i += chunkN) {
          const chunk = arr.slice(i, i + chunkN);
          const ch = chainNN(chunk, (g) => [g.cx, g.cy], cx, cy);
          for (const g of ch) out.push(g);
          if (ch.length) { cx = ch[ch.length - 1].cx; cy = ch[ch.length - 1].cy; }
        }
        return out;
      };
      const ordered = [];
      let curX = W * (0.5 + (srnd(11.7, 8.1) - 0.5) * 0.22);
      let curY = H * (0.5 + (srnd(13.1, 8.9) - 0.5) * 0.22);
      if (bgFirstPlan) {
        // 第一遍起稿：宽笔铺满背景中间色（铺底笔已在前面铺）+ 各元素的大色块。
        // 起稿结束后整幅基本铺满，一眼能看出画的是什么；描边/小细节/明暗
        // 留给后面的细化遍，起稿不追求画准边。
        for (const e of bgFirstPlan.masses) {
          for (const g of e.mass) ordered.push({ g, ph: 0 });
          if (e.mass.length) { curX = e.mass[e.mass.length - 1].cx; curY = e.mass[e.mass.length - 1].cy; }
        }
        // 第二遍：背景整片细化（大色带先、窄带/噪点就近收拾），期间不落任何主体笔。
        for (const g of bgFirstPlan.bgAll) ordered.push({ g, ph: 1 });
        // 第三遍：主体逐块完成（大形已立，补中块色、描边、细节），
        // 文字块"字形→描边→装饰"。
        for (const e of bgFirstPlan.rests) {
          for (const g of e.local) ordered.push({ g, ph: 2 });
          curX = e.cx; curY = e.cy;
        }
        // 第四遍：前景/遮挡和最小细节（点睛）。
        for (const e of bgFirstPlan.details) {
          for (const g of e.local) ordered.push({ g, ph: 3 });
          curX = e.cx; curY = e.cy;
        }
      } else {
        for (let ph = 0; ph < 4; ph++) {
          const arr = phaseGroups[ph];
          if (!arr.length) continue;
          // 照片起形不绕路：先按面积把主体最大的几块颜色落下去，猫的剪影才立得住；
          // 平涂起形是描线，需要就近串起来，避免手在轮廓上乱跳。
          let chained;
          if (!flatArt && ph === 0) chained = arr;
          else {
            chained = [];
            let cx = curX, cy = curY;
            for (let i = 0; i < arr.length;) {
              const c0 = orderClass(arr[i], ph);
              let j = i + 1;
              while (j < arr.length && orderClass(arr[j], ph) === c0) j++;
              const ch = chainChunks(arr.slice(i, j), cx, cy, ph === 0 ? 12 : 24);
              for (const g of ch) chained.push(g);
              if (ch.length) { cx = ch[ch.length - 1].cx; cy = ch[ch.length - 1].cy; }
              i = j;
            }
          }
          for (const g of chained) ordered.push({ g, ph });
          if (chained.length) { curX = chained[chained.length - 1].cx; curY = chained[chained.length - 1].cy; }
        }
      }
      const residualComp = (g, pix, x0, y0, x1, y1, phR) => {
        if (!pix.length) return 0;
        const s0 = strokes.length;
        let cx = 0, cy = 0;
        for (const p of pix) { cx += p % W; cy += (p - p % W) / W; }
        cx /= pix.length; cy /= pix.length;
        const gr = {
          gid: g.gid, cx, cy, mean: g.mean, area: pix.length,
          x0, y0, x1, y1, bw: x1 - x0 + 1, bh: y1 - y0 + 1,
        };
        const span = Math.max(gr.bw, gr.bh);
        const thick = pix.length / Math.max(1, span);
        let halfW = clamp(thick * 0.8 + 1.3, 1.6, 6);
        let ang = isFinite(g.angle) ? g.angle : 0;
        const rounds = pix.length <= 2 ? 1 : 3;
        for (let round = 0; round < rounds; round++) {
          if (round === 1) { ang += 0.8; halfW += 0.8; }
          if (round === 2) { ang += 1.9; halfW += 1.4; }
          let left = 0;
          for (const p of pix) if (!covered[p]) left++;
          if (!left) break;
          const ca = Math.cos(ang), sa = Math.sin(ang);
          let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
          for (const p of pix) {
            const px = p % W - cx, py = (p - p % W) / W - cy;
            const u = px * ca + py * sa, v = -px * sa + py * ca;
            if (u < uMin) uMin = u; if (u > uMax) uMax = u;
            if (v < vMin) vMin = v; if (v > vMax) vMax = v;
          }
          const step = Math.max(1.2, halfW * 0.8);
          for (let v = vMin + halfW * 0.2; v <= vMax + 0.01; v += step) {
            sweepAt(gr, v, ca, sa, halfW, phR === undefined ? 3 : phR, ang, uMin, uMax);
          }
        }
        // 斜向细缝可能仍剩几个像素：逐个补小点，保证成品没有白点。
        let leftPix = null;
        for (const p of pix) if (!covered[p]) (leftPix || (leftPix = [])).push(p);
        if (leftPix && leftPix.length <= 48) {
          for (const p of leftPix) {
            const x = p % W, y = (p - x) / W;
            const sp = new Float64Array([x + 0.5, y + 0.5, x + 1.5, y + 0.5]);
            const halfs = new Float64Array([1.4, 1.4]);
            emitPlan(sp, halfs, colorOf(g), phR === undefined ? 3 : phR, { zoneGid: g.gid, pen: 0, minInk: 1 });
          }
        }
        return strokes.length - s0;
      };

      // ---- 照片的近似底色层 ----
      // 照片没有平涂图的 wash：旧流程直接按色区落笔，中途帧就是白纸上
      // 一块块色斑（"瑞士奶酪"）。人画照片会先把整幅色调铺一遍再细化。
      // 这里按横条取真实均值铺一层宽笔近似底色，noCover/noZone 不记覆盖、
      // 不占位，后面的精确色区笔仍会把每个像素重涂成原图色，成品精度不变。
      // 只给 painter 照片用；artist 照片路径保持原样。
      const paintPhotoUnderlay = () => {
        if (paperPx > N * 0.02) return 0;
        // 纸白像素后面没有色区笔重涂，近似底色不能盖到它们（否则成品会被染一层）
        let pm = null;
        if (paperPx > 0) {
          pm = new Uint8Array(N);
          for (let p = 0; p < N; p++) pm[p] = paper[p] ? 0 : 1;
        }
        const stripH = Math.max(36, Math.min(96, Math.round(Math.min(W, H) * 0.06)));
        const hw = stripH * 0.60;
        const rows = Math.ceil(H / stripH);
        let n = 0;
        const emitRun = (x0, x1, acc, yc, r) => {
          const len = x1 - x0;
          if (len < 4 || acc.n < 2) return;
          const col = [Math.round(acc.r / acc.n), Math.round(acc.g / acc.n), Math.round(acc.b / acc.n)];
          const np = Math.max(2, Math.min(6, Math.round(len / 120) + 1));
          const sp = new Float64Array(np * 2), halfs = new Float64Array(np);
          const dir = (r & 1) ? -1 : 1;
          const bow = (srnd(r * 2.3 + x0 * 0.017, 4.1) - 0.5) * hw * 0.3;
          for (let i = 0; i < np; i++) {
            const f = np > 1 ? i / (np - 1) : 0.5;
            const ff = dir > 0 ? f : 1 - f;
            sp[i * 2] = x0 + len * ff;
            sp[i * 2 + 1] = yc + bow * Math.sin(Math.PI * ff) +
              (srnd(r * 7.1 + i * 1.3, 3.3) - 0.5) * 1.2;
            halfs[i] = hw * (0.86 + 0.14 * Math.sin(Math.PI * ff)) *
              (0.94 + 0.12 * srnd(r * 5.7 + i * 2.1, 2.9));
          }
          const opt = {
            pen: 0, color: col, noCover: 1, noZone: 1, minInk: 8,
            ms: Math.round(160 + len * 0.5),
          };
          if (pm) opt.zoneMask = pm;
          const si = emitStroke(sp, halfs, col, 0, opt);
          if (si >= 0) n++;
        };
        for (let r = 0; r < rows; r++) {
          const sy = r * stripH, ey = Math.min(H - 1, sy + stripH - 1);
          const yc = (sy + ey) * 0.5;
          let cur = null;
          const CELL = 8;
          for (let x = 0; x < W; x += CELL) {
            const xe = Math.min(W - 1, x + CELL - 1);
            let sr = 0, sg = 0, sb = 0, sn = 0;
            for (let y = sy; y <= ey; y += 2) {
              const row = y * W;
              for (let xx = x; xx <= xe; xx += 2) {
                const p = row + xx;
                if (paper[p]) continue;
                sr += R[p]; sg += G[p]; sb += B[p]; sn++;
              }
            }
            if (!sn) continue;
            if (!cur) { cur = { x0: x, x1: xe, r: sr, g: sg, b: sb, n: sn }; continue; }
            const d = Math.abs(sr / sn - cur.r / cur.n) +
              Math.abs(sg / sn - cur.g / cur.n) + Math.abs(sb / sn - cur.b / cur.n);
            if (d <= 60) {
              cur.x1 = xe; cur.r += sr; cur.g += sg; cur.b += sb; cur.n += sn;
            } else {
              emitRun(cur.x0, cur.x1 + 1, cur, yc, r);
              cur = { x0: x, x1: xe, r: sr, g: sg, b: sb, n: sn };
            }
          }
          if (cur) emitRun(cur.x0, Math.min(W, cur.x1 + 1), cur, yc, r);
        }
        if (opts.debug) console.log('[underlay] strips=' + rows + ' strokes=' + n);
        return n;
      };

      // ---- 照片分层细化：按"画布误差"补笔，先中笔、后细笔 ----
      // 人画照片是分层来的：大色块铺完，在颜色不对的地方补中笔，最后用细笔
      // 收毛发/石缝/轮廓。这里每一层只挑"当前画布和原图差得最多"的地方落笔，
      // 笔身沿着结构流向、颜色取原图在这一带的局部均值；落笔前先算这一笔
      // 到底能减少多少误差，不能减少就不画（每笔都有真实贡献）。
      // 只给画家·过程版的照片用：artist 的照片笔流保持逐字节不变。
      const paintPhotoLayers = async () => {
        if (paperPx > N * 0.004) return 0;   // 扫描纸白不参与照片细化
        const layers = [
          { h: 8.4, T: 21, lenK: 2.4, ph: 2, cap: 2200 },
          { h: 5.0, T: 16, lenK: 2.3, ph: 2, cap: 2600 },
          { h: 3.0, T: 12.5, lenK: 2.0, ph: 3, cap: 5000 },
          { h: 1.8, T: 10.0, lenK: 1.6, ph: 3, cap: 6000 },
        ];
        let added = 0, tried = 0, kept = 0;
        const segD2 = (px, py, ax, ay, bx, by) => {
          const dx = bx - ax, dy = by - ay;
          const l2 = dx * dx + dy * dy;
          let t = l2 > 1e-6 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
          t = t < 0 ? 0 : (t > 1 ? 1 : t);
          const qx = ax + dx * t - px, qy = ay + dy * t - py;
          return qx * qx + qy * qy;
        };
        for (let li = 0; li < layers.length; li++) {
          const L = layers[li];
          const tL = Date.now();
          const h = Math.max(1.5, L.h * Math.min(1.35, scaleB));
          const step = Math.max(2, Math.round(h * 0.92));
          const done = new Uint8Array(N);
          const ox = (srnd(31.7 + li * 7.3, 4.1) * step) | 0;
          const oy = (srnd(37.1 + li * 5.9, 5.3) * step) | 0;
          let n = 0;
          for (let y = oy; y < H - 1; y += step) {
            for (let x = ox; x < W - 1; x += step) {
              if (n >= L.cap || added >= 11000) break;
              const p = y * W + x;
              if (done[p] || segPaper[p]) continue;
              const q = p * 3;
              // 当前画布误差（最大通道差）
              const e0 = Math.max(
                Math.abs(canvas[q] - R[p]),
                Math.abs(canvas[q + 1] - G[p]),
                Math.abs(canvas[q + 2] - B[p]));
              if (e0 < L.T) continue;
              tried++;
              // 方向：结构张量的切线（flowX/flowY 存的是 2θ），低相干时给随机角
              let ang;
              if (coh[p] > 0.10) ang = 0.5 * Math.atan2(flowY[p], flowX[p]);
              else ang = srnd(p * 0.013, 6.7) * Math.PI;
              ang += (srnd(p * 0.021 + li * 3.1, 8.3) - 0.5) * 0.24;
              const ca = Math.cos(ang), sa = Math.sin(ang);
              const len = clamp(h * L.lenK * (0.8 + 1.6 * Math.min(1, coh[p])), h * 1.2, h * 5.2)
                * (0.85 + 0.3 * srnd(p * 0.017, 2.9));
              const ax = x + 0.5 - ca * len * 0.5, ay = y + 0.5 - sa * len * 0.5;
              const bx = x + 0.5 + ca * len * 0.5, by = y + 0.5 + sa * len * 0.5;
              // 笔身覆盖范围：先算原图均值当笔色，再逐像素算这一笔的误差增益。
              const rx0 = Math.max(0, Math.floor(Math.min(ax, bx) - h));
              const rx1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + h));
              const ry0 = Math.max(0, Math.floor(Math.min(ay, by) - h));
              const ry1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + h));
              const r2 = h * h * 0.94;
              let pr = 0, pg = 0, pb = 0, cnt = 0;
              for (let yy = ry0; yy <= ry1; yy++) {
                const row = yy * W;
                for (let xx = rx0; xx <= rx1; xx++) {
                  if (segD2(xx + 0.5, yy + 0.5, ax, ay, bx, by) > r2) continue;
                  const pp = row + xx;
                  if (segPaper[pp]) continue;
                  const qq = pp * 3;
                  pr += R[pp]; pg += G[pp]; pb += B[pp]; cnt++;
                }
              }
              if (cnt < 6) { done[p] = 1; continue; }
              // 笔色 = 笔身覆盖像素的原图均值（单色最优的 L2 解；加权会偏向
              // 少量离群亮点，整片反而更花，实测误差更大）。
              const col = [Math.round(pr / cnt), Math.round(pg / cnt), Math.round(pb / cnt)];
              // 这一笔能减少多少误差：逐像素算"画之前 vs 画之后"
              let gain = 0, worst = 0;
              for (let yy = ry0; yy <= ry1; yy++) {
                const row = yy * W;
                for (let xx = rx0; xx <= rx1; xx++) {
                  if (segD2(xx + 0.5, yy + 0.5, ax, ay, bx, by) > r2) continue;
                  const pp = row + xx;
                  if (segPaper[pp]) continue;
                  const qq = pp * 3;
                  const oldE = Math.max(
                    Math.abs(canvas[qq] - R[pp]),
                    Math.abs(canvas[qq + 1] - G[pp]),
                    Math.abs(canvas[qq + 2] - B[pp]));
                  const newE = Math.max(
                    Math.abs(col[0] - R[pp]),
                    Math.abs(col[1] - G[pp]),
                    Math.abs(col[2] - B[pp]));
                  gain += oldE - newE;
                  if (newE - oldE > worst) worst = newE - oldE;
                }
              }
              if (gain < cnt * 0.75 || worst > 22) { done[p] = 1; continue; }
              const nP = 4;
              const sp = new Float64Array(nP * 2), halfs = new Float64Array(nP);
              const bow = (srnd(p * 0.011 + li * 1.7, 3.9) - 0.5) * h * 0.9;
              for (let i = 0; i < nP; i++) {
                const f = i / (nP - 1);
                const off = bow * Math.sin(Math.PI * f) +
                  (srnd(p * 0.007 + i * 1.13, 4.7) - 0.5) * 0.7;
                sp[i * 2] = ax + (bx - ax) * f - sa * off;
                sp[i * 2 + 1] = ay + (by - ay) * f + ca * off;
                halfs[i] = h * (0.80 + 0.24 * Math.sin(Math.PI * f)) *
                  (0.92 + 0.16 * srnd(p * 0.009 + i * 2.1, 3.3));
              }
              const si = emitPlan(sp, halfs, col, L.ph, {
                color: col, pen: 0, noCover: 0, geomCover: 1, noZone: 1, forceKeep: 1,
                minInk: 1, ms: Math.round(40 + len * 0.7),
              });
              if (si < 0) { done[p] = 1; continue; }
              kept++; n++; added++;
              // 这一笔盖过的范围在同一层里不再重复挑
              const md = h * 1.25;
              const mx0 = Math.max(0, Math.floor(Math.min(ax, bx) - md));
              const mx1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + md));
              const my0 = Math.max(0, Math.floor(Math.min(ay, by) - md));
              const my1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + md));
              for (let yy = my0; yy <= my1; yy++) {
                const row = yy * W;
                for (let xx = mx0; xx <= mx1; xx++) {
                  if (segD2(xx + 0.5, yy + 0.5, ax, ay, bx, by) <= md * md) done[row + xx] = 1;
                }
              }
            }
            if ((y & 63) === 0) await yieldUI();
            if (n >= L.cap || added >= 11000) break;
          }
          if (opts.debug) {
            console.log('[photolayer] L' + (li + 1) + ' h=' + h.toFixed(1) + ' T=' + L.T +
              ' tried=' + tried + ' kept=' + kept + ' added=' + added +
              ' ms=' + (Date.now() - tL));
          }
          if (added >= 11000) break;
        }
        return added;
      };

      // ---- 画家·过程版分支：平涂优先走闭合区域画家；照片保持原路径 ----
      const washIdx = [];
      if (compilerActive) {
        await paintCompilerPlan();
        // 先按原色组补最后一层细线/小形体；重型对象执行器只作为可选实验，
        // 默认不启动，避免把已经由 compiler 画准的小字和圆点重新解释成宽扫块。
        // 对象事务内先画一遍细节保证过程自然；所有对象结束后只收口那些
        // 几何上无法归属到对象、且当前仍有可见误差的组。已随对象画准的组
        // 不再做全图二次覆盖，避免片尾突然出现一大段补细节。
        await paintCompilerGroupDetails(new Uint8Array(G_),
          compilerPlan.detailRemainingGids,
          'detail:final', { a: 0.93, b: 0.955, label: '编译器：补齐无对象归属的细节…' });
        if (opts.compilerObjectPass) await paintHumanFlow(true, compilerPlan.objectBgGids);
      } else if (closedActive) {
        await paintClosedPlan();
      } else if (painterActive) {
        await paintHumanFlow();
      } else {

      // 铺底色：整片背景先用宽笔自上而下一档档扫过去，先铺满"中间色"再谈明暗。
      // 每一笔都裁在背景像素内，主体/文字位置保持留白，不会提前勾出轮廓；
      // 后面的精确背景笔会把每个像素重涂成原图色，成品精度不变，但中途帧
      // 看到的是整片连贯底色，而不是按色号跳着填出的一圈圈碎色带。
      if (bgFirstPlan && bgFirstPlan.washMask) {
        const wm = bgFirstPlan.washMask, wc = bgFirstPlan.washColor;
        const brushW = Math.max(22, Math.min(120, Math.min(W, H) / 10));
        const hw = brushW * 0.5;
        const stepY = Math.max(7, brushW * 0.50);
        const yTop = hw * 0.6, yBot = H - hw * 0.6;
        const rows = Math.max(2, Math.round((yBot - yTop) / stepY) + 1);
        const rowStep = (yBot - yTop) / Math.max(1, rows - 1);
        const nPt = Math.max(3, Math.min(16, Math.round(W / 70)));
        const yJit = (srnd(21.7 + runSeed * 0.01, 5.3) - 0.5) * brushW * 0.12;
        for (let r = 0; r < rows; r++) {
          const yy = yTop + rowStep * r;
          const spine = new Float64Array(nPt * 2);
          const halfs = new Float64Array(nPt);
          // 一行从左扫到右，下一行从右扫回，收笔不用飞回起点
          const dir = (r & 1) ? -1 : 1;
          const wob = (srnd(r * 2.7 + 9.1, 3.3) - 0.5) * 0.55;
          for (let i = 0; i < nPt; i++) {
            const f = i / (nPt - 1);
            const x = dir > 0 ? -hw * 0.5 + (W + hw) * f : W + hw * 0.5 - (W + hw) * f;
            // 长扫不是水平直线：整行略斜，再叠一点低频起伏（手臂弧线）
            const y = yy + yJit + wob * brushW * 0.45 +
              Math.sin(f * Math.PI * (1 + (r & 1)) + r * 0.9) * brushW * 0.08;
            spine[i * 2] = x; spine[i * 2 + 1] = y;
            // 两头略收、中间最宽：宽笔侧锋压下去再提起
            halfs[i] = hw * (0.74 + 0.26 * Math.sin(Math.PI * f)) *
              (0.93 + 0.14 * srnd(r * 13.7 + i * 1.9, 4.1));
          }
          const si = emitStroke(spine, halfs, wc, 0, {
            zoneMask: wm, color: wc, minInk: 64, noCover: 1, ms: 1200,
          });
          if (si >= 0) washIdx.push(si);
          prog(0.676 + 0.008 * (r + 1) / rows, '铺底色：宽笔铺满中间色…');
          await yieldUI();
        }
      }
      // 元素底色层：起稿阶段给每个元素"除大块外还没铺到的填充区"打一层近似
      // 底色（大块色块已经精确落笔，再铺就白花了）。宽笔沿元素长轴一挥，
      // 裁在元素填充像素内（zoneMask），noCover+noZone 不记覆盖/占位，
      // 细化阶段的精确笔仍然是真实推进。层级排在铺底之后、大块之前。
      const baseCoatIdx = [];
      if (bgFirstPlan && bgFirstPlan.masses) {
        for (const e of bgFirstPlan.masses) {
          const bw = e.x1 - e.x0 + 1, bh = e.y1 - e.y0 + 1;
          if (bw <= 0 || bh <= 0) continue;
          const massMark = new Uint8Array(G_);
          for (const g of e.mass) massMark[g.gid] = 1;
          const fillMark = new Uint8Array(G_);
          for (const gid of e.fgids) fillMark[gid] = 1;
          // 掩膜 = 元素全部像素 − 起稿已精确铺掉的大块：细线/描边/碎纹在起稿里
          // 只盖一层近似底色（真人起稿也是先用底色盖住再收拾），细化再画准。
          // zoneMask 按"全画布像素下标"取址，这里直接给整幅掩膜（只扫元素 bbox）。
          const m = new Uint8Array(N);
          for (let y = e.y0; y <= e.y1; y++) {
            const row = y * W;
            for (let x = e.x0; x <= e.x1; x++) {
              const p = row + x;
              const gid = groupOf[p];
              if (gid < 0 || !fillMark[gid] || massMark[gid]) continue;
              m[p] = 1;
            }
          }
          // 空掩膜（大块占满整个元素）就跳过：不画没有贡献的笔
          let mN = 0;
          for (let i = 0; i < m.length; i++) if (m[i]) mN++;
          if (!mN) continue;
          // 沿元素长轴一挥，短轴取 30% 作笔宽；大元素再补一挥
          const ax = bw >= bh;
          const hw = Math.max(2.5, Math.min(42, (ax ? bh : bw) * 0.30));
          const nStroke = bw > 240 || bh > 240 ? 2 : 1;
          for (let si = 0; si < nStroke; si++) {
            const off = nStroke === 1 ? 0 : (si === 0 ? -hw * 0.55 : hw * 0.55);
            const spine = new Float64Array(6 * 2);
            const halfs = new Float64Array(6);
            for (let i = 0; i < 6; i++) {
              const f = i / 5;
              const bow = Math.sin(f * Math.PI) * hw * 0.35 * (srnd(e.x0 * 3.1 + si, 3.7) - 0.5);
              const bx = ax ? e.x0 - hw + (bw + 2 * hw) * f : e.cx + off + bow * 0.6;
              const by = ax ? e.cy + off + bow : e.y0 - hw + (bh + 2 * hw) * f;
              spine[i * 2] = ax ? bx : e.cx + off + bow * 0.6;
              spine[i * 2 + 1] = by;
              halfs[i] = hw * (0.78 + 0.22 * Math.sin(Math.PI * f)) * (0.92 + 0.16 * srnd(si * 7.3 + i * 1.3, 4.4));
            }
            const bi = emitStroke(spine, halfs, e.baseCol, 0, {
              zoneMask: m, color: e.baseCol, noCover: 1, noZone: 1, minInk: 40, ms: 600,
            });
              if (bi >= 0) baseCoatIdx.push(bi);
            await yieldUI();
          }
        }
      }
      if (opts.debug) console.log('[basecoat] n=' + baseCoatIdx.length);

      // 照片：先把整幅色调铺一遍（近似底色，不记覆盖），再按色区细化
      if (painterFlow && !flatArt) paintPhotoUnderlay();



      // 每 16 组让出一次主线程，观察/落笔过程在页面上是连续的
      for (let oi = 0; oi < ordered.length; oi++) {
        const g = ordered[oi].g, ph = ordered[oi].ph;
        const pp = oi / Math.max(1, ordered.length);
        if (bgFirstPlan) {
          // 背景 → 主体 → 文字/结构 → 细节，进度文案跟着新阶段走。
          // 底色已经铺完，ph0 从铺底结束处（0.684）接着走到 0.76，进度条不回退。
          if (ph === 0) prog(0.676 + 0.084 * pp, '起稿：铺满底色与主体大色…');
          else if (ph === 1) prog(0.76 + 0.08 * pp, '细化背景：整片刷准…');
          else if (ph === 2) prog(0.84 + 0.10 * pp, '画主体：一处画完再走…');
          else prog(0.94 + 0.04 * pp, '前景与细节：遮挡、点睛…');
        } else if (ph === 0) prog(0.68 + 0.06 * pp, '起形：主体大块…');
        else if (ph === 1) prog(0.74 + 0.08 * pp, '铺大色：背景与明暗…');
        else if (ph === 2) prog(0.82 + 0.08 * pp, '塑形：内部色区…');
        else prog(0.9 + 0.07 * pp, '点睛：轮廓、胡须、高光…');
        if (g.lineLike && !g.soft) {
          paintLine(g, ph);
          // 骨架被相邻细色块夹断时，中轴可能落在别的组里，主笔会漏掉整条边。
          // 还差像素就再用块面扫一遍（仍裁在本组内），把补漏留在本阶段。
          if (groupUncov[g.gid] > 0) paintBlob(g, ph);
        } else paintBlob(g, ph);
        if ((oi & 15) === 0) await yieldUI();
      }
      }
      // 照片分层细化：主色块画完之后、查漏之前，按误差补中笔/细笔。
      // 放在查漏前是有意的：细碎色块由细化层按局部色补，查漏只兜最后的漏网像素。
      if (painterFlow && !flatArt && !opts.noPhotoLayers) await paintPhotoLayers();

      // ---- 收尾查漏：逐像素找出还没落色的地方，用最短的局部扫笔补上 ----
      // 只补"确实没画到"的像素；颜色仍是该色区的精确均值，成品不会多出杂色。
      let resPx = 0, resComp = 0, resStroke = 0;
      const residualMap = opts.debugMasks ? new Uint8Array(N) : null;
      // 闭合路径已经把主色铺满；残余只做有预算的边界/漏色修整，
      // 不把纸张纹理和抗锯齿误差逐点重画成数万笔。
      // 编译器只在自己建立的区域所有权内修正；旧残差按色组均值补块会把已经
      // 铺准的渐变背景重新刷成斑驳碎片，因此 compiler 必须完全跳过这一段。
      const residualCandidates = closedActive ? [] : null;
      const residualBudget = closedActive
        ? Math.min(16000, Math.max(6000, Math.round(N * 0.0194)))
        : Infinity;
      if (!compilerActive) {
        const seen = new Uint8Array(N);
        const q = new Int32Array(N);
        for (let p0 = 0; p0 < N; p0++) {
          if (segPaper[p0] || covered[p0] || seen[p0]) continue;
          const gid0 = groupOf[p0];
          if (gid0 < 0) continue;
          const g = groups[gid0];
          if (!g) continue;
          let head = 0, tail = 0;
          q[tail++] = p0; seen[p0] = 1;
          const pix = [];
          let x0 = W, y0 = H, x1 = -1, y1 = -1;
          while (head < tail) {
            const p = q[head++];
            pix.push(p);
            if (residualMap) residualMap[p] = 1;
            const x = p % W, y = (p - x) / W;
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
            const visit = (r) => {
              if (r < 0 || r >= N || seen[r] || segPaper[r] || covered[r]) return;
              if (groupOf[r] !== gid0) return;
              seen[r] = 1; q[tail++] = r;
            };
            if (x > 0) visit(p - 1);
            if (x + 1 < W) visit(p + 1);
            if (y > 0) visit(p - W);
            if (y + 1 < H) visit(p + W);
          }
          resPx += pix.length;
          resComp++;
          if (residualCandidates) residualCandidates.push({ g, pix, x0, y0, x1, y1 });
          else resStroke += residualComp(g, pix, x0, y0, x1, y1);
          if ((resComp & 31) === 0) await yieldUI();
        }
        if (residualCandidates) {
          residualCandidates.sort((a, b) => (b.pix.length - a.pix.length) || (b.g.area - a.g.area));
          for (const c of residualCandidates) {
            if (resStroke >= residualBudget) break;
            resStroke += residualComp(c.g, c.pix, c.x0, c.y0, c.x1, c.y1);
          }
          if (opts.debug) console.log('[closed-residual] components=' + residualCandidates.length +
            ' budget=' + residualBudget + ' strokes=' + resStroke);
        }
      }
      if (washIdx.length) {
        // 铺底占背景阶段约 14% 的时长：整片中间色要看得见在铺，又不能拖到
        // 精确色块一直不出现。按其余背景笔的实际权重配，风格/画幅都自适应。
        let ph0ms = 0;
        for (let i = 0; i < strokes.length; i++) {
          if (strokes[i].ph === 0) ph0ms += strokes[i].ms;
        }
        for (const i of washIdx) ph0ms -= strokes[i].ms;
        const per = Math.max(160, ph0ms * 0.35 / washIdx.length);
        for (const i of washIdx) strokes[i].ms = per;
      }
      if (strokes.length) {
        baseCount = strokes.filter((s) => s.ph === 0).length;
        strokes[strokes.length - 1].fin = 1;
      }
      // 覆盖率审计：按最终 covered 位图统计，和回放/成品逐像素一致
      let unPx = 0, unG = 0;
      {
        const unc = new Int32Array(G_);
        for (let p = 0; p < N; p++) {
          if (segPaper[p] || covered[p]) continue;
          const gid = groupOf[p];
          if (gid >= 0) { unc[gid]++; unPx++; }
        }
        for (let i = 0; i < G_; i++) if (unc[i]) unG++;
      }
      exactInfo = {
        seed: runSeed, mode: modeName, regions: RN, groups: groups.length,
        strokes: strokes.length, mergePasses: passN, uncovered: unPx, uncoveredGroups: unG,
        residualPx: resPx, residualComps: resComp, residualStrokes: resStroke,
        residualMap: opts.debugMasks ? residualMap : undefined,
        zeroRemoved, rimPx, paintable: N - paperPx + rimPx, ms: Date.now() - tEx,
        order: compilerActive ? 'compiler' : (closedActive ? 'closed' : (painterActive ? 'painter' : (bgFirstPlan ? 'bgfirst' : 'phase'))),
        bgFill: (closedActive || painterActive || compilerActive) ? painterBgFill : undefined,
        ring: (closedActive || painterActive || compilerActive) ? pfRing : undefined,
        objects: (closedActive || painterActive || compilerActive) ? pfObjects : undefined,
        closedRegions: (closedActive || compilerActive) ? pfClosedRegions : undefined,
        bgGroups: bgFirstPlan ? bgFirstPlan.bgAll.length : 0,
        washPx: bgFirstPlan ? bgFirstPlan.washN : 0,
        elements: bgFirstPlan ? bgFirstPlan.masses.length + bgFirstPlan.rests.length + bgFirstPlan.details.length : 0,
      };
      if (opts.dumpGroups) {
        globalThis.__ISP_DUMP_GROUPS = groups;
        globalThis.__ISP_DUMP_GROUPOF = groupOf;
        globalThis.__ISP_DUMP_CLOSED = closedPlan;
        globalThis.__ISP_DUMP_COMPILER = compilerPlan;
        globalThis.__ISP_DUMP_LABELS = labels;
        globalThis.__ISP_DUMP_COVERED = covered;
        globalThis.__ISP_DUMP_PAPER = paper;
        globalThis.__ISP_DUMP_CANVAS = canvas;
        globalThis.__ISP_DUMP_W = W;
        if (bgFirstPlan) globalThis.__ISP_DUMP_BG = bgFirstPlan.bgSet;
      }
      if (opts.dumpStrokes) {
        globalThis.__ISP_DUMP_STROKES = strokes;
        globalThis.__ISP_DUMP_CLIPS = clips;
      }
      if (opts.debug) {
        console.log('[exact] ' + modeName + ' seed=' + runSeed + ' tol=' + TOL + ' 初始=' + RN +
          ' 组=' + groups.length + ' 笔=' + strokes.length + ' 删零=' + zeroRemoved + ' ph=' +
          JSON.stringify([0, 1, 2, 3].map((p) => strokes.filter((s) => s.ph === p).length)) +
          ' 漏=' + unPx + '/' + unG + ' 残补=' + resPx + '/' + resComp + '/' + resStroke +
          ' ms=' + (Date.now() - tEx));
      }
      return true;
    }

    let baseCount = 0;
    let exactDone = false;
    if (trivialDone && opts.algo === 'compiler') {
      // 极简线稿已经在上面按骨架中心线落笔；这里只补齐 compiler 的结果元数据，
      // 不再走区域填色，也不重复落笔。
      exactInfo = {
        seed: opts.seed === undefined || opts.seed === null ? 1 : (opts.seed >>> 0),
        mode: 'flat', order: 'compiler', bgFill: 'centerline', ring: false,
        objects: trivialPlanInfo.parts, closedRegions: trivialPlanInfo.parts,
        compilerMode: trivialPlanInfo.mode, compilerGroups: trivialPlanInfo.groups,
        paintable: trivialPlanInfo.paintable,
      };
    }
    if (!trivialDone) exactDone = await runExactCopy();
    if (!trivialDone && !exactDone) {
    // ---- ph0：起形。先构图线，再主体/大块的长轮廓 ----
    prog(0.4, '起形：构图与长轮廓…');
    await yieldUI();
    {
      const gw = style === 'pencil' ? 1.35 : (style === 'oil' ? 1.5 : 1.2);
      const gc = style === 'pencil' ? [156, 156, 156] :
        (style === 'oil' ? [180, 160, 142] : [172, 163, 155]);
      const ca = Math.cos(subj.angle), sa = Math.sin(subj.angle);
      let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
      for (const [x, y] of [[sx0 - subj.x, sy0 - subj.y], [sx1 - subj.x, sy0 - subj.y],
        [sx1 - subj.x, sy1 - subj.y], [sx0 - subj.x, sy1 - subj.y]]) {
        const u = x * ca + y * sa, v = -x * sa + y * ca;
        if (u < uMin) uMin = u; if (u > uMax) uMax = u;
        if (v < vMin) vMin = v; if (v > vMax) vMax = v;
      }
      const gcl = style === 'pencil' ? [210, 210, 210] :
        (style === 'oil' ? [206, 193, 180] : [202, 195, 188]);
      const line = (u0, v0, u1, v1, seed, col) => {
        const x0 = subj.x + u0 * ca - v0 * sa, y0 = subj.y + u0 * sa + v0 * ca;
        const x1 = subj.x + u1 * ca - v1 * sa, y1 = subj.y + u1 * sa + v1 * ca;
        const sp = lineSpine(x0, y0, x1, y1, (rand01(seed, 8.2) - 0.5) * 6, seed, 5);
        const len = Math.hypot(x1 - x0, y1 - y0);
        const cc = col || gc;
        emitStroke(sp.pts, profLine(sp.n, gw, seed), cc, 0, {
          pen: 1, color: cc, zoneMask: subjectD, ms: Math.min(900, 180 + len * 1.6),
        });
      };
      // 构图线：彩笔留一条长轴加一条短的视觉中心线（大色面会盖掉）；
      // 铅笔只留一条极淡的短结构线，避免一个 X 压在脸上。
      if (style === 'pencil') {
        if (!isFlat) {
          // 照片不描量化缝，但起形阶段仍留一条很淡的短结构线（穿过视觉中心、
          // 顺着局部流向），让人看出"先定位置再上明暗"。线别拉太长，
          // 否则大色面盖不住，成品里会留一道划痕。
          let ang0 = subj.angle;
          const fp = Math.max(0, Math.min(N - 1, (subj.focalY | 0) * W + (subj.focalX | 0)));
          if (coh[fp] > 0.15) ang0 = 0.5 * Math.atan2(flowY[fp], flowX[fp]);
          const gl = Math.min(W, H) * 0.22;
          const gx0 = subj.focalX - Math.cos(ang0) * gl, gy0 = subj.focalY - Math.sin(ang0) * gl;
          const gx1 = subj.focalX + Math.cos(ang0) * gl, gy1 = subj.focalY + Math.sin(ang0) * gl;
          const sp = lineSpine(gx0, gy0, gx1, gy1, 1.4, 5.5, 5);
          emitStroke(sp.pts, profLine(sp.n, 0.8 * scaleB, 12.3), [231, 231, 231], 0, {
            pen: 1, color: [231, 231, 231], ms: 400,
          });
        }
        else {
          // 平涂铅笔的中轴不要一条实线从头顶拉到脚底：成品里会像一道接缝。
          // 改成四段很淡的短线，只在起形时提示位置，脸心留空。
          const span = Math.max(0, sy1 - sy0 - 16);
          for (let k = 0; k < 4; k++) {
            const a = sy0 + 8 + span * (0.04 + k * 0.24);
            const b = a + span * 0.075;
            const sp = lineSpine(subj.x, a, subj.x, b, 0.8, 5.5 + k, 4);
            emitStroke(sp.pts, profLine(sp.n, 0.75 * scaleB, 12.3 + k), [240, 240, 240], 0, {
              pen: 1, color: [240, 240, 240], zoneMask: subjectD, ms: 120,
            });
          }
        }
      } else if (!isFlat) {
        // 照片的起形线不要画成横竖准星：一条顺着主体长轴的轻线定姿态，
        // 一条更短的线穿过视觉中心定头/胸的位置。两条都比轮廓线淡，
        // 大色面一压就退到后面，只在最初两秒里提示"先看比例"。
        const vC = (vMin + vMax) * 0.5;
        const fu = (subj.focalX - subj.x) * ca + (subj.focalY - subj.y) * sa;
        const fv = -(subj.focalX - subj.x) * sa + (subj.focalY - subj.y) * ca;
        line(uMin + (uMax - uMin) * 0.10, vC,
          uMin + (uMax - uMin) * 0.90, vC + (vMax - vMin) * 0.05, 3.1, gcl);
        line(fu - (uMax - uMin) * 0.04, fv - (vMax - vMin) * 0.15,
          fu + (uMax - uMin) * 0.04, fv + (vMax - vMin) * 0.15, 7.7, gcl);
      }

      // 长轮廓：marching squares 追主体边界，按长度×显著度选前几条

      // 主体掩膜必须闭合后再追轮廓：照片里量化噪声会在掩膜上打出几千个小洞，
      // marching squares 会沿每个洞描一圈——整幅就变成"填色书轮廓"。
      // 若"主体"占了 78% 以上画面，说明主体检测失败（背景被当主体），干脆不描。
      let subjN = 0;
      for (let p = 0; p < N; p++) if (subject[p]) subjN++;
      // 照片的主体掩膜是一堆散落的显著块，边界横跨全幅、彼此穿插，
      // 追出来就是满纸波浪线（填色书）。照片的轮廓改由下面“大暗块外轮廓”负责。
      const contours = (subjN > N * 0.78 || !isFlat) ? [] : traceContours(closeMaskDisk(subject, W, H, 3), sx0, sy0, sx1, sy1);
      const scored = [];
      for (const c of contours) {
        let len = 0, salSum = 0, salN = 0;
        let minx = W, miny = H, maxx = -1, maxy = -1;
        for (let i = 0; i < c.n; i++) {
          const x = c.pts[i * 2], y = c.pts[i * 2 + 1];
          if (x < minx) minx = x; if (x > maxx) maxx = x;
          if (y < miny) miny = y; if (y > maxy) maxy = y;
          if (i > 0) len += Math.hypot(x - c.pts[(i - 1) * 2], y - c.pts[(i - 1) * 2 + 1]);
          const px2 = Math.max(0, Math.min(W - 1, x | 0)), py2 = Math.max(0, Math.min(H - 1, y | 0));
          salSum += sal[py2 * W + px2]; salN++;
        }
        if (len < 10 * scaleB) continue;
        // 整幅最外框不是"主体的轮廓"，跳过（否则起形会去描图片边）
        if (minx < 2 && miny < 2 && maxx > W - 3 && maxy > H - 3) continue;
        scored.push({ c, len, score: len * (0.35 + 0.65 * (salN ? salSum / salN : 0.3)) });
      }
      scored.sort((a, b) => b.score - a.score);
      let cLeft = 16;
      for (const sc of scored) {
        if (cLeft <= 0) break;
        const maxLen = (style === 'pencil' ? 260 : 210) * scaleB;
        const parts = Math.min(5, Math.max(1, Math.ceil(sc.len / maxLen)));
        for (let pi = 0; pi < parts && cLeft > 0; pi++) {
          const a = Math.floor(sc.c.n * pi / parts);
          const b = Math.min(sc.c.n - 1, Math.floor(sc.c.n * (pi + 1) / parts));
          if (b - a < 2) continue;
          const sp = new Float64Array((b - a + 1) * 2);
          for (let i = a; i <= b; i++) { sp[(i - a) * 2] = sc.c.pts[i * 2]; sp[(i - a) * 2 + 1] = sc.c.pts[i * 2 + 1]; }
          const mid = Math.floor((a + b) / 2) * 2;
          const mx = Math.max(0, Math.min(W - 1, sc.c.pts[mid] | 0)), my = Math.max(0, Math.min(H - 1, sc.c.pts[mid + 1] | 0));
          const src = [R[my * W + mx], G[my * W + mx], B[my * W + mx]];
          const lg = clamp(Math.round(luma(src) * 0.52), 26, 120);
          const cc = style === 'pencil' ? [lg, lg, lg] : mix(src, [28, 24, 22], 0.42);
          const hw = (style === 'pencil' ? 1.35 : (style === 'oil' ? 2.3 : 1.8)) * scaleB * (1 + 0.08 * (fid - 3));
          emitStroke(sp, profLine(b - a + 1, hw, 31.7 + pi), cc, 0, { pen: 1, color: cc, zoneMask: subjectD });
          cLeft--;
        }
      }

      // 线稿网络：先画离视觉中心远的外圈结构；五官/胡须留到 ph3
      const focusR = Math.min(W, H) * (style === 'pencil' ? 0.30 : 0.24);
      let earlyInk = 0, lateInk = 0, inkPx = 0;
      const maxChunk = (style === 'pencil' ? 140 : 160) * scaleB;
      const pencilChunks = [];
      for (const g of groups) {
        // 照片的"线稿"全是量化过渡缝：1~2px 宽、绕着每个色块走一圈，
        // 骨架追出来是满幅的破碎阶梯纹，不是五官也不是轮廓。真实照片里的线
        // 应该由明暗交界和排线暗示；只有平涂插画才有真正的线稿可描。
        // 铅笔照片例外：只描真正的 lineArt（海报的字边/结构边），不碰 inkOnly 缝。
        if (!isFlat && !(style === 'pencil' && g.lineArt)) continue;
        if (!g.lineArt && !g.inkOnly) continue;
        const paths = traceLineGroup(g);
        if (!paths.length) continue;
        g.skPaths = paths;
        for (const path of paths) inchk: for (const ch of splitSkPath(path, maxChunk)) {
          if (ch.n < 2 || ch.len < 5) continue;
          const mid = Math.floor(ch.n / 2) * 2;
          const mx = ch.pts[mid], my = ch.pts[mid + 1];
          const dF = Math.hypot(mx - subj.focalX, my - subj.focalY);
          inkPx += ch.len;
          if (style === 'pencil') pencilChunks.push({ g, ch, dF });
          else if (dF > focusR) { if (earlyInk < (isFlat ? 20 : 36)) { inkLine(g, ch, 0); earlyInk++; } else lineChunksLate.push({ g, ch, dF }); }
          else { lineChunksLate.push({ g, ch, dF }); lateInk++; }
        }
        if (opts.debug) console.log('[ink] gid=' + g.gid + ' paths=' + paths.length + ' long=' + earlyInk + ' late=' + lineChunksLate.length + ' px=' + inkPx);
      }
      // 照片没有可描的线稿，但大暗块（头、肩背、树干）的边界就是主体轮廓。
      // 只取视觉中心附近最大的 3 块，各描一条闭合外轮廓——这是"选择性长线"。
      if (!isFlat) {
        const far = (g) => Math.hypot(g.cx - subj.focalX, g.cy - subj.focalY);
        const fR2 = Math.min(W, H) * 0.42;
        // 大暗块先按"离视觉中心多近"加权再比面积：整幅的暗背景（石头、树丛）
        // 面积再大也不该被当主体轮廓，否则追出来是满纸岩石边线。
        const sil = groups.filter((g) => !g.lineArt && !g.inkOnly && g.luma < 118 &&
          g.area > N * 0.0022 && g.thick > 8 && (!g.bg || far(g) < fR2 * 0.55))
          .sort((a, b) => (b.area * Math.exp(-Math.pow(far(b) / (fR2 * 0.5), 2))) -
            (a.area * Math.exp(-Math.pow(far(a) / (fR2 * 0.5), 2))))
          .slice(0, 1);
        if (opts.debugMasks) console.log('[sil]', sil.map((g) =>
          `gid=${g.gid} a=${g.area} l=${g.luma | 0} bg=${g.bg} d=${far(g) | 0}`).join(' '));
        const sm = new Uint8Array(N);
        for (const g of sil) {
          sm.fill(0, g.y0 * W, (g.y1 + 1) * W);
          for (let y = g.y0; y <= g.y1; y++) {
            const row = y * W;
            for (let x = g.x0; x <= g.x1; x++) if (groupOf[row + x] === g.gid) sm[row + x] = 1;
          }
          const loops = traceContours(closeMaskDisk(sm, W, H, 2), g.x0, g.y0, g.x1, g.y1);
          loops.sort((a, b) => b.n - a.n);
          let drawn = 0;
          for (const lp of loops) {
            // 只取最大的一圈外轮廓：内圈（耳朵/眼窝的洞）在起形阶段画出来
            // 就是两个套在一起的变形虫，读者看不出那是头。
            if (drawn >= 1 || strokes.length >= hardCap) break;
            if (lp.n < 12) continue;
            const lc = style === 'pencil' ? [78, 78, 78] : mix(g.pal, [26, 22, 20], 0.45);
            const hw = (style === 'pencil' ? 1.55 : 2.0) * scaleB;
            const smooth = rdpSimplify(lp.pts, lp.n, Math.max(2.2, 2.8 * scaleB));
            if (smooth.n < 3) continue;
            for (const ch of splitSkPath(smooth, 260 * scaleB)) {
              if (ch.n < 3) continue;
              emitStroke(ch.pts, profFill(ch.n, hw, g.gid * 2.9 + ch.len), lc, 0, {
                pen: 1, color: lc,
              });
            }
            drawn++;
          }
        }
      }

      // 白毛在纸上是"没有颜色"的，只能靠边界交代：挑视觉中心附近最大的亮色块，
      // 用浅灰线勾一圈（白胸、前腿、白脸）——这是铅笔起形里最关键的几条线。
      if (style === 'pencil' && !isFlat) {
        const farL = (g) => Math.hypot(g.cx - subj.focalX, g.cy - subj.focalY);
        const lites = groups.filter((g) => !g.bg && !g.lineArt && !g.inkOnly && g.luma > 176 &&
          g.area > N * 0.0016 && g.thick > 10 && farL(g) < Math.min(W, H) * 0.55)
          .sort((a, b) => b.area - a.area).slice(0, 3);
        const lm = new Uint8Array(N);
        for (const g of lites) {
          if (strokes.length >= hardCap) break;
          lm.fill(0, Math.max(0, g.y0 - 1) * W, Math.min(N, (g.y1 + 2) * W));
          for (let y = g.y0; y <= g.y1; y++) {
            const row = y * W;
            for (let x = g.x0; x <= g.x1; x++) if (groupOf[row + x] === g.gid) lm[row + x] = 1;
          }
          const loops = traceContours(closeMaskDisk(lm, W, H, 2), g.x0, g.y0, g.x1, g.y1);
          loops.sort((a, b) => b.n - a.n);
          let drawn = 0;
          for (const lp of loops) {
            if (drawn >= 1) break;
            if (lp.n < 16) continue;
            const simp = rdpSimplify(lp.pts, lp.n, Math.max(1.4, 1.9 * scaleB));
            if (simp.n < 3) continue;
            const lc = [122, 122, 122];
            for (const ch of splitSkPath(simp, 240 * scaleB)) {
              if (ch.n < 3) continue;
              emitStroke(ch.pts, profFill(ch.n, 1.35 * scaleB, g.gid * 1.9 + ch.len), lc, 0, {
                pen: 1, color: lc,
              });
            }
            drawn++;
          }
        }
        if (opts.debugMasks) console.log('[lite]', lites.map((g) => 'g' + g.gid + ' a' + g.area + ' l' + (g.luma | 0)).join(' '));
      }

      if (style === 'pencil' && pencilChunks.length) {
        // 铅笔先起形：长线（外轮廓、身体、长胡须）按长度先落，不按离视线的远近切碎。
        const byLen = pencilChunks.slice().sort((a, b) => b.ch.len - a.ch.len);
        const nEarly = Math.min(byLen.length, Math.max(14, Math.round(byLen.length * 0.24)), 42);
        const drew = new Set();
        for (let i = 0; i < nEarly; i++) {
          if (strokes.length >= hardCap) break;
          inkLine(byLen[i].g, byLen[i].ch, 0);
          drew.add(byLen[i]); earlyInk++;
        }
        for (const c of pencilChunks) if (!drew.has(c)) lineChunksLate.push(c);
        if (opts.debug) console.log('[ink] pencil chunks=' + pencilChunks.length + ' early=' + earlyInk + ' late=' + lineChunksLate.length);
      }
      lineChunksLate.sort((a, b) => a.dF - b.dF);
    }

    // 一条扫带按颜色变化切成连续段：色面内部一笔带过，渐变处自然断笔
    function splitRun(g, ca, sa, v, u0, u1) {
      const out = [];
      const len = u1 - u0;
      if (len < 2) return out;
      const chunk = Math.max(6, baseBrush * 0.55);
      const nCh = Math.max(1, Math.ceil(len / chunk));
      const means = [];
      for (let ci = 0; ci < nCh; ci++) {
        const a = u0 + len * ci / nCh, b = u0 + len * (ci + 1) / nCh;
        let sr = 0, sg = 0, sb = 0, nn = 0;
        const samples = Math.max(2, Math.round((b - a) / 3));
        for (let s = 0; s < samples; s++) {
          const u = a + (b - a) * (s + 0.5) / samples;
          const x = Math.round(g.cx + u * ca - v * sa), y = Math.round(g.cy + u * sa + v * ca);
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const p = y * W + x;
          if (groupOf[p] !== g.gid) continue;
          sr += R[p]; sg += G[p]; sb += B[p]; nn++;
        }
        means.push(nn ? [sr / nn, sg / nn, sb / nn] : null);
      }
      const splitTol = style === 'marker' ? 999 : (style === 'oil' ? 20 : 26);
      // 铅笔的笔宽只有十几像素，按 3.2 倍切段会把每条扫线剁成 40px 的碎笔；
      // 石墨笔触本来就该拉得长，这里按画布尺度给最小段长。
      const maxSeg = style === 'pencil'
        ? Math.max(150 * scaleB, baseBrush * 9) * (0.9 + 0.2 * rand01(g.gid * 5.9, 2.7))
        : (g.bg ? baseBrush * 4.0 : baseBrush * 3.2) * (0.9 + 0.2 * rand01(g.gid * 5.9, 2.7));
      let curA = u0, curMean = null;
      for (let ci = 0; ci < nCh; ci++) {
        const m = means[ci];
        if (!m) continue;
        if (!curMean) { curMean = m.slice(); continue; }
        const d = Math.hypot(m[0] - curMean[0], m[1] - curMean[1], m[2] - curMean[2]);
        const segLen = u0 + len * (ci + 1) / nCh - curA;
        if ((d > splitTol || segLen > maxSeg) && segLen > baseBrush * 0.85) {
          out.push([curA, u0 + len * ci / nCh]);
          curA = u0 + len * ci / nCh;
          curMean = m.slice();
        } else {
          curMean = [curMean[0] * 0.7 + m[0] * 0.3, curMean[1] * 0.7 + m[1] * 0.3, curMean[2] * 0.7 + m[2] * 0.3];
        }
      }
      if (u1 - curA > 1) out.push([curA, u1]);
      return out;
    }

    // 画块铺色：沿结构/主轴一档档扫，带内按颜色断笔；笔形裁进本块形状
    function paintGroup(g, ph, deep, maxLines) {
      if (g.area <= 0) return;
      let bw = groupBrush(g);
      let thinMode = false;
      if (g.elong > 2.2 && g.thick < bw * 0.95) {
        bw = Math.max(styleMin, Math.min(bw, g.thick * 1.35));
        thinMode = true;
      }
      const halfW = bw * 0.5;
      let ang = regionAngle(g);
      if (style === 'oil' && !g.bg && g.flowCoh > 0.2) ang = g.flowAngle;
      if (g.bg) ang += (rand01(g.gid * 4.7, 3.9) - 0.5) * 0.16;
      if (!isFinite(ang)) ang = 0;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
      for (const [x, y] of [[g.x0 - g.cx, g.y0 - g.cy], [g.x1 - g.cx, g.y0 - g.cy], [g.x1 - g.cx, g.y1 - g.cy], [g.x0 - g.cx, g.y1 - g.cy]]) {
        const u = x * ca + y * sa, v = -x * sa + y * ca;
        if (u < uMin) uMin = u; if (u > uMax) uMax = u;
        if (v < vMin) vMin = v; if (v > vMax) vMax = v;
      }
      let step = Math.max(1.5, bw * (thinMode ? 0.56 : (deep ? 0.55 : styleStep)));
      const spanU = uMax - uMin + halfW * 2, spanV = vMax - vMin;
      let lines = Math.ceil(spanV / step) + 1;
      while (lines * spanU > 2600000 && step < bw * 2.5) { step *= 1.35; lines = Math.ceil(spanV / step) + 1; }
      // 起笔线要落在形状内部：贴着 vMin/vMax 的线往往整条都在形外，
      // 笔再宽也盖不到顶端的"帽"，会留下白月牙。向内收 0.55 个半笔宽，
      // 由笔身的半个宽度反包住上下边缘。
      const insetV = Math.min(step * 0.55, halfW * 0.55);
      const phase = (rand01(g.gid * 3.7, 1.9) - 0.5) * step * 0.3;
      const startV = maxLines === 1 ? (vMin + vMax) * 0.5 : vMin + insetV + phase * 0.4;
      const endV = maxLines === 1 ? startV : vMax - insetV;
      let lineN = 0;
      const __un0 = groupUncov[g.gid], __s0 = strokes.length;
      const vList = [];
      for (let v = startV; v <= endV; v += step) {
        vList.push(v);
        if (maxLines && vList.length >= maxLines) break;
      }
      if (maxLines !== 1 && vList.length && (!maxLines || vList.length < maxLines) &&
          endV - vList[vList.length - 1] > step * 0.5) vList.push(endV);
      // 起笔方向按组轮换 + 相邻带蛇形交替 + 间距相关漂移（同 paintBlob，手推进
      // 的自然不均匀；这里只动顺序/相位，掩膜与取色不变）。
      const pseed = (opts.seed === undefined || opts.seed === null) ? 1 : (opts.seed >>> 0);
      let dir = rand01(g.gid * 2.17 + pseed * 0.023, 6.9) < 0.5 ? 1 : -1;
      let drift = (rand01(g.gid * 3.7 + pseed * 0.13, 1.9) - 0.5) * step * 0.24;
      for (const v of vList) {
        lineN++;
        if (strokes.length >= hardCap) break;
        drift = Math.max(-step * 0.2, Math.min(step * 0.2,
          drift + (rand01(g.gid * 11.3 + v * 0.07 + pseed * 0.013, 5.5) - 0.5) * step * 0.5));
        sweepAt(g, v + drift, ca, sa, halfW, ang, uMin, uMax, ph, deep, dir);
        dir = -dir;
      }
      if (opts.debug && (g.gid === 1 || g.gid === 0 || g.gid === 14 || g.gid === 9)) console.log('[pg] gid=' + g.gid + ' area=' + g.area + ' ang=' + (ang*180/Math.PI).toFixed(0) + ' bw=' + bw.toFixed(0) + ' step=' + step.toFixed(0) + ' v=' + vMin.toFixed(0) + '..' + vMax.toFixed(0) + ' start=' + startV.toFixed(0) + ' end=' + endV.toFixed(0) + ' lines=' + lineN + ' un0=' + __un0 + ' un1=' + groupUncov[g.gid] + ' made=' + (strokes.length - __s0));
    }
    // 沿一条 v 扫：在本块掩膜内找连续段，按颜色分割后落笔
    function sweepAt(g, vv, ca, sa, halfW, ang, uMin, uMax, ph, deep, rev) {
      let runA = null, made = 0;
      const uEnd = uMax + halfW * 0.9;
      for (let u = uMin - halfW * 0.9; u <= uEnd; u += 1.0) {
        const x = Math.round(g.cx + u * ca - vv * sa), y = Math.round(g.cy + u * sa + vv * ca);
        const inside = x >= 0 && y >= 0 && x < W && y < H && groupOf[y * W + x] === g.gid;
        if (inside) { if (runA === null) runA = u; }
        else if (runA !== null) {
          const u0 = runA, u1 = u - 1;
          runA = null;
          if (u1 - u0 >= 1.5) { emitRun(g, u0, u1, vv, ca, sa, halfW, ang, ph, deep, rev); made++; }
        }
      }
      if (runA !== null && uEnd - runA >= 1.5) { emitRun(g, runA, uEnd, vv, ca, sa, halfW, ang, ph, deep, rev); made++; }
      return made;
    }

    // 补完色块：只针对「大块里还没盖住的窄条/侧翼」，按未覆盖像素的 v 分布
    // 选 1~2 条扫线，不重涂整块，也不追像素误差。
    function finishGroup(g, ph, maxStrokes) {
      if (!g || g.area <= 0) return 0;
      const bw = groupBrush(g), halfW = bw * 0.5;
      let ang = regionAngle(g);
      if (style === 'oil' && !g.bg && g.flowCoh > 0.2) ang = g.flowAngle;
      if (!isFinite(ang)) ang = 0;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
      for (const [x, y] of [[g.x0 - g.cx, g.y0 - g.cy], [g.x1 - g.cx, g.y0 - g.cy], [g.x1 - g.cx, g.y1 - g.cy], [g.x0 - g.cx, g.y1 - g.cy]]) {
        const u = x * ca + y * sa, v = -x * sa + y * ca;
        if (u < uMin) uMin = u; if (u > uMax) uMax = u;
        if (v < vMin) vMin = v; if (v > vMax) vMax = v;
      }
      const v0 = Math.floor(vMin) - 1, vn = Math.ceil(vMax - vMin) + 3;
      const hist = new Int32Array(vn);
      let total = 0;
      for (let y = g.y0; y <= g.y1; y++) {
        for (let x = g.x0; x <= g.x1; x++) {
          const p = y * W + x;
          if (groupOf[p] !== g.gid || paintN[p]) continue;
          const v = -((x - g.cx) * sa) + ((y - g.cy) * ca);
          const b = Math.round(v - v0);
          if (b >= 0 && b < vn) { hist[b]++; total++; }
        }
      }
      if (total < Math.max(12, Math.min(300, g.area * 0.01))) return 0;
      const order = Array.from({ length: vn }, (_, i) => i).sort((a, b) => hist[b] - hist[a]);
      const picked = [];
      for (const b of order) {
        if (hist[b] < 2 || picked.length >= maxStrokes) break;
        const v = v0 + b;
        let ok = true;
        for (const c of picked) if (Math.abs(c - v) < bw * 0.55) { ok = false; break; }
        if (ok) picked.push(v);
      }
      let made = 0;
      for (const v of picked) {
        if (strokes.length >= hardCap) break;
        made += sweepAt(g, v, ca, sa, halfW, ang, uMin, uMax, ph, false);
      }
      return made;
    }
    function emitRun(g, u0, u1, v, ca, sa, halfW, ang, ph, deep, rev) {
      const segs = splitRun(g, ca, sa, v, u0 - halfW * 0.85, u1 + halfW * 0.85);
      for (let si = 0; si < segs.length; si++) {
        // 反向走笔时段序连带方向一起倒，笔尖沿带连续推进（蛇形）
        const [a, b] = rev ? segs[segs.length - 1 - si] : segs[si];
        if (b - a < 1.5) continue;
        if (strokes.length >= hardCap) return;
        const len = b - a;
        const nP = Math.max(3, Math.min(9, Math.round(len / 22)));
        // 主弓弯随带长增大（长带是手臂弧线），叠第二谐波低频漂移
        const bowA = halfW * 0.34 * (0.55 + 0.9 * Math.min(1, len / 650));
        const bow = (rand01(g.gid * 7.1 + v * 0.13, 3.3) - 0.5) * bowA;
        const bow2 = (rand01(g.gid * 3.3 + v * 0.09, 7.7) - 0.5) * bowA * 0.55;
        const bowPh = rand01(g.gid * 5.1 + v * 0.06, 8.9) * Math.PI * 2;
        const sp = new Float64Array(nP * 2);
        for (let i = 0; i < nP; i++) {
          const f = nP > 1 ? i / (nP - 1) : 0.5;
          const u = rev ? b - (b - a) * f : a + (b - a) * f;
          const vv = v + bow * Math.sin(Math.PI * f) + bow2 * Math.sin(2 * Math.PI * f + bowPh)
            + (rand01(g.gid + i * 0.7, 9.1) - 0.5) * 0.7;
          sp[i * 2] = g.cx + u * ca - vv * sa;
          sp[i * 2 + 1] = g.cy + u * sa + vv * ca;
        }
        const hw = halfW * (deep ? 0.9 : 1);
        const halfs = profFill(nP, hw, g.gid * 2.3 + v);
        emitStroke(sp, halfs, null, ph, {
          zoneGid: g.gid,
          paletteColor: (style === 'marker' || style === 'pencil') ? g.pal : undefined,
          deep: deep, pen: 0,
        });
      }
    }

    // 排线：沿结构方向，间距由明暗决定；暗部更密，亮部留纸白
    function hatchGroup(g, ph, cross, cap, spacingMul, angleOverride, lightOk) {
      // 铅笔的白要留纸：238 的"白毛"再排线就成了灰污；亮部靠轮廓和周边暗部衬出来。
      // lightOk 只给"照片主体"的浅色块：白猫的身体没有排线就只剩一条轮廓，
      // 用很稀的浅灰排线交代体积，仍然看得见纸白。
      if (g.luma > (style === 'pencil' ? (lightOk ? 249 : 205) : 232) || g.area < 24) return;
      // 2~4px 的色带是量化的过渡条，不是色面；排线会把它排成实心轮廓线。
      if (style === 'pencil' && g.thick < 4.5) return;
      const lineW = Math.max(2.2, (style === 'pencil' ? 4.2 : 2.4) * scaleB) * (1 + 0.08 * (fid - 3));
      const dark = 1 - clamp01(g.luma / 240);
      const mul = spacingMul || 1;
      // 排线要压得住纸：以前间距太大，2000 笔也只像几道划痕，整幅还是白的。
      // 中间调 ~1/3 覆盖、暗部 ~1/2，交叉线再加密，才是铅笔的明暗组织。
      let spacing = lineW * (1.15 + (1 - dark) * 3.1) * (cross ? 0.78 : 1) * mul;
      spacing = Math.max(lineW * 1.10, Math.min(24 * scaleB, spacing));
      let ang = angleOverride !== undefined ? angleOverride : regionAngle(g);
      ang += cross ? -1.05 : 0.34;
      if (angleOverride === undefined && g.elong > 2.3 && !cross) ang = g.angle + 0.22;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
      for (const [x, y] of [[g.x0 - g.cx, g.y0 - g.cy], [g.x1 - g.cx, g.y0 - g.cy], [g.x1 - g.cx, g.y1 - g.cy], [g.x0 - g.cx, g.y1 - g.cy]]) {
        const u = x * ca + y * sa, v = -x * sa + y * ca;
        if (u < uMin) uMin = u; if (u > uMax) uMax = u;
        if (v < vMin) vMin = v; if (v > vMax) vMax = v;
      }
      const v0 = vMin + rand01(g.gid * 5.3, 2.2) * spacing;
      for (let v = v0; v <= vMax; v += spacing * (0.82 + 0.36 * rand01(g.gid * 4.1 + v * 0.03, 7.7))) {
        if (strokes.length >= cap) return;
        let runA = null;
        for (let u = uMin - 2; u <= uMax + 2; u += 1.2) {
          const x = Math.round(g.cx + u * ca - v * sa), y = Math.round(g.cy + u * sa + v * ca);
          const inside = x >= 0 && y >= 0 && x < W && y < H && groupOf[y * W + x] === g.gid;
          if (inside) { if (runA === null) runA = u; }
          else if (runA !== null) {
            if (u - 1 - runA > 3) hatchLine(g, runA, u - 1, v, ca, sa, lineW, ang, ph, cross, cap);
            runA = null;
          }
        }
        if (runA !== null && uMax - runA > 3) hatchLine(g, runA, uMax, v, ca, sa, lineW, ang, ph, cross, cap);
      }
    }
    function hatchLine(g, u0, u1, v, ca, sa, lineW, ang, ph, cross, cap) {
      // 一条长排线拆成几段短笔：人画排线不会一笔拉过整块色面，
      // 段与段之间留 0~8px 空档，角度也略微变化，才不是机器网纹。
      const runLen = u1 - u0;
      const maxSeg = (52 + 34 * rand01(g.gid * 4.7 + v * 0.11, 6.2)) * scaleB;
      const segs = [];
      if (runLen <= maxSeg * 1.25) segs.push([u0, u1]);
      else {
        let a = u0;
        let k = 0;
        while (a < u1 - 5) {
          const b = Math.min(u1, a + maxSeg * (0.7 + 0.6 * rand01(g.gid + k * 2.3, 3.1)));
          if (b - a > 8) segs.push([a, b]);
          a = b + (rand01(g.gid * 1.9 + k, 5.7) < 0.72 ? 2 + 7 * rand01(g.gid + k, 4.4) : 0);
          k++;
        }
      }
      for (const [a, b] of segs) {
        if (strokes.length >= cap) return;
        const da = ang + (rand01(g.gid * 7.3 + v * 0.09 + a, 5.1) - 0.5) * 0.09;
        const ca2 = Math.cos(da), sa2 = Math.sin(da);
        const nP = Math.max(3, Math.min(7, Math.round((b - a) / 24)));
        const sp = new Float64Array(nP * 2);
        for (let i = 0; i < nP; i++) {
          const f = nP > 1 ? i / (nP - 1) : 0.5;
          const u = a + (b - a) * f;
          const off = (rand01(g.gid * 9.7 + i + a, 4.4) - 0.5) * 1.1;
          sp[i * 2] = g.cx + u * ca2 - (v + off) * sa2;
          sp[i * 2 + 1] = g.cy + u * sa2 + (v + off) * ca2;
        }
        // 背景只用淡排线（退后），主体按明暗加深；避免整幅像同一张网纹
        const vv = g.bg
          ? clamp(Math.round(112 + g.luma * 0.42 - (cross ? 10 : 0)), 128, 214)
          : clamp(Math.round(30 + g.luma * 0.60 - (cross ? 18 : 0) - (ph === 2 ? 10 : 0)), 24, 205);
        emitStroke(sp, profLine(nP, lineW * 0.5, g.gid * 3.1 + v + a), [vv, vv, vv], ph, {
          zoneGid: g.gid, pen: 1, color: [vv, vv, vv],
        });
      }
    }

    function detailGroup(g, count, ph, salMin) {
      if (count <= 0 || g.area <= 0) return;
      const cand = [];
      const stride = Math.max(2, Math.round(Math.min(g.bw, g.bh) / 55));
      for (let y = Math.max(0, g.y0); y <= Math.min(H - 1, g.y1); y += stride) {
        const row = y * W;
        for (let x = Math.max(0, g.x0); x <= Math.min(W - 1, g.x1); x += stride) {
          const p = row + x;
          if (paper[p] || groupOf[p] !== g.gid || sal[p] < salMin) continue;
          cand.push({ p, x, y, s: sal[p] * (0.7 + 0.6 * clamp01(edge[p] / 32)) });
        }
      }
      cand.sort((a, b) => b.s - a.s);
      const picked = [];
      const minD = Math.max(5, Math.min(W, H) * 0.010);
      const need = Math.min(count, 48);
      for (let pass = 0; pass < 2 && picked.length < need; pass++) {
        const thr = salMin * (pass === 0 ? 1 : 0.62);
        for (const c of cand) {
          if (picked.length >= need) break;
          if (c.s < thr) continue;
          let ok = true;
          for (const q of picked) if (Math.hypot(q.x - c.x, q.y - c.y) < minD) { ok = false; break; }
          if (ok) picked.push(c);
        }
      }
      const baseLen = style === 'oil' ? Math.min(36, baseBrush * 0.44) : style === 'marker' ? Math.min(28, baseBrush * 0.36) : Math.min(30, Math.max(10, baseBrush * 0.9));
      const baseHw = style === 'oil' ? Math.min(9, Math.max(2.6, baseBrush * 0.11)) : style === 'marker' ? Math.min(6.5, Math.max(2.2, baseBrush * 0.075)) : Math.max(1.1, 1.5 * scaleB);
      for (const c of picked) {
        if (strokes.length >= hardCap) break;
        let ang;
        if (coh[c.p] > 0.12) ang = Math.atan2(flowY[c.p], flowX[c.p]) * 0.5;
        else ang = isFinite(g.flowAngle) ? g.flowAngle : g.angle;
        if (g.thick < 3.2) ang = g.elong > 1.6 ? g.angle : ang;
        const len = Math.max(5, baseLen * (0.75 + 0.5 * rand01(c.p, 2.8)) * (ph === 3 ? 0.82 : 1));
        const hw = Math.max(0.8, baseHw * (0.7 + 0.45 * rand01(c.p, 6.4)) * (g.thick < 3.2 ? 0.55 : 1));
        const dx = Math.cos(ang) * len * 0.5, dy = Math.sin(ang) * len * 0.5;
        const sp = lineSpine(c.x - dx, c.y - dy, c.x + dx, c.y + dy, (rand01(c.p, 3.7) - 0.5) * 2.6, c.p, ph === 3 ? 4 : 3);
        const src = [R[c.p], G[c.p], B[c.p]];
        // 塑形的笔色跟着"这一块的计划色"走，不在块边缘取到隔壁的颜色：
        // 字上的奶油色块边缘常常挨着红描边，按像素取色会把红点甩进字心。
        const gbase = palette[g.label] || g.pal || src;
        let col;
        if (style === 'pencil') {
          const v = clamp(Math.round(30 + luma(src) * 0.56 - (ph === 3 ? 12 : 0)), 24, 175);
          col = [v, v, v];
        } else if (style === 'marker') {
          let sh = markerShade(gbase, ph === 3 ? 0.26 : 0.15);
          // 色板里没有更暗的同色系时不要直接跳过：马克笔叠一层本来就该变深。
          // 用很轻的黑墨混合模拟叠色，塑形段才有落笔，五官边缘也能压住。
          if (sh === gbase) sh = mix(gbase, [0, 0, 0], ph === 3 ? 0.28 : 0.11);
          col = sh;
        } else {
          col = mix(gbase, src, 0.35);
          col = mix(col, [0, 0, 0], ph === 3 ? 0.10 : 0.04);
          const tt = (rand01(c.p * 1.3, 4.1) - 0.5) * 7;
          col = [clamp(col[0] + tt, 0, 255), clamp(col[1] + tt * 0.7, 0, 255), clamp(col[2] + tt * 0.4, 0, 255)];
        }
        emitStroke(sp.pts, style === 'oil' ? profFill(sp.n, hw, c.p) : profLine(sp.n, hw, c.p), col, ph, {
          pen: 1, color: col, zoneGid: g.gid,
        });
      }
    }

    // 小结构保底：只补"还没落过笔"的小块，每块最多一条中线笔，绝不整块重涂
    function rescueGroups(ph, maxN, capAt) {
      const list = groups.filter((g) => !g.bg && !g.lineArt && !g.inkOnly && g.area >= 16 && gStrokeN[g.gid] === 0 &&
        groupUncov[g.gid] > Math.max(4, g.area * 0.25))
        .sort((a, b) => (b.sal * Math.sqrt(b.area)) - (a.sal * Math.sqrt(a.area)));
      let used = 0;
      for (const g of list) {
        if (used >= maxN || strokes.length >= capAt || strokes.length >= hardCap) break;
        const before = strokes.length;
        forcePaint = true;
        paintGroup(g, ph, false, 1);
        forcePaint = false;
        used += strokes.length - before;
      }
    }

    // 视觉中心的细笔：只在焦点周围的人脸/头部区域，用短笔顺结构补色，
    // 把大笔底色的"块面感"收成可辨认的五官；不是全图逐像素补丁。
    function focalDetail(cap, ph) {
      if (cap <= 0) return 0;
      const fr = Math.min(W, H) * 0.34;
      const x0 = Math.max(0, Math.floor(subj.focalX - fr)), x1 = Math.min(W - 1, Math.ceil(subj.focalX + fr));
      const y0 = Math.max(0, Math.floor(subj.focalY - fr)), y1 = Math.min(H - 1, Math.ceil(subj.focalY + fr));
      const step = Math.max(6, Math.round(Math.min(W, H) / 90));
      const cand = [];
      for (let y = y0; y <= y1; y += step) {
        for (let x = x0; x <= x1; x += step) {
          const p = y * W + x;
          if (paper[p] || !subjectD[p]) continue;
          const sc = 1 + edge[p] * 0.35 + sal[p] * 6;
          if (sc < 1.6) continue;
          cand.push({ p, x, y, sc });
        }
      }
      cand.sort((a, b) => b.sc - a.sc);
      const picked = [];
      const minD = Math.max(6, Math.min(W, H) * 0.0105);
      for (let pass = 0; pass < 2 && picked.length < cap; pass++) {
        for (const c of cand) {
          if (picked.length >= cap) break;
          let ok = true;
          for (const q of picked) if (Math.hypot(q.x - c.x, q.y - c.y) < minD) { ok = false; break; }
          if (ok) picked.push(c);
        }
        if (picked.length >= cap || pass === 1) break;
      }
      for (const c of picked) {
        if (strokes.length >= hardCap) break;
        const p = c.p;
        let ang;
        if (coh[p] > 0.14) ang = Math.atan2(flowY[p], flowX[p]) * 0.5;
        else ang = (rand01(p * 1.7, 4.4) - 0.5) * 1.2;
        const len = Math.max(8, step * 2.3 * (0.78 + 0.45 * rand01(p, 2.8)));
        const hw = Math.max(2.2, step * 0.62 * (0.78 + 0.4 * rand01(p, 6.4)));
        const dx = Math.cos(ang) * len * 0.5, dy = Math.sin(ang) * len * 0.5;
        const sp = lineSpine(c.x - dx, c.y - dy, c.x + dx, c.y + dy,
          (rand01(p, 3.7) - 0.5) * 2.2, p, 4);
        const src = [R[p], G[p], B[p]];
        // 和 detailGroup 同理：短笔的色相服从这一块的计划色，别从边界上带进隔壁色。
        const gbase = palette[labels[p]] || src;
        let col;
        if (style === 'pencil') {
          const v = clamp(Math.round(30 + luma(src) * 0.56), 24, 180);
          col = [v, v, v];
        } else if (style === 'marker') {
          const sh = markerShade(gbase, 0.06);
          // 焦点短笔也不许换色系；平涂已经到位时不再加同色笔。
          if (sh === gbase) continue;
          col = sh;
        } else {
          col = mix(gbase, src, 0.35);
          const tt = (rand01(p * 1.3, 4.1) - 0.5) * 6;
          col = [clamp(col[0] + tt, 0, 255), clamp(col[1] + tt * 0.7, 0, 255), clamp(col[2] + tt * 0.4, 0, 255)];
        }
        const pgid = groupOf[p];
        emitStroke(sp.pts, style === 'oil' ? profFill(sp.n, hw, p) : profLine(sp.n, hw, p), col, ph, {
          pen: 1, color: col, zoneMask: subjectD, zoneGid: pgid,
        });
      }
      return picked.length;
    }

    // 照片类：先大笔铺一层"底色"（观察到的低频色块）。没有这层，
    // 几千个小色块不可能在预算内铺满，画布会到处露白，也不像人起稿。
    // 平涂插画不铺：它本来就有大片纸白和干净色块。
    function blockInWash(ph) {
      const cell = Math.max(46, Math.min(96, Math.round(Math.min(W, H) / 8)));
      const rb = Math.max(3, Math.round(cell * 0.14));
      const Rb = blurU8(R, rb), Gb = blurU8(G, rb), Bb = blurU8(B, rb);
      // 笔宽和档距留 15% 重叠、长度比横向档距长：底色是一张连成片的"底"，
      // 不是一排露缝的条子。主体大色块紧接着盖在上面，脸不会一直埋在底色里。
      const hw = cell * 0.58;
      const washMask = new Uint8Array(N);
      for (let p = 0; p < N; p++) if (!paper[p]) washMask[p] = 1;
      // 底色选色：马克笔按"这一格看到的主要色板色"投票，不把红字和蓝底
      // 平均成紫色；油画/铅笔仍用低频平均（它们靠笔触混色）。
      const washColor = (cx, cy, dx, dy, cp) => {
        if (style === 'marker') {
          const votes = new Map();
          let best = null, bestN = 0;
          const add = (qx, qy) => {
            qx = Math.round(qx); qy = Math.round(qy);
            if (qx < 0 || qy < 0 || qx >= W || qy >= H) return;
            const q = qy * W + qx;
            if (paper[q]) return;
            const c = nearestPalette([R[q], G[q], B[q]]);
            const n = (votes.get(c) || 0) + 1;
            votes.set(c, n);
            if (n > bestN) { bestN = n; best = c; }
          };
          for (const ff of [0.18, 0.5, 0.82]) add(cx + dx * (ff * 2 - 1), cy + dy * (ff * 2 - 1));
          add(cx - dy * 0.35, cy + dx * 0.35);
          add(cx + dy * 0.35, cy - dx * 0.35);
          return best;
        }
        let sr = 0, sg = 0, sb = 0, nn = 0;
        for (const ff of [0.18, 0.5, 0.82]) {
          const qx = Math.round(cx + dx * (ff * 2 - 1)), qy = Math.round(cy + dy * (ff * 2 - 1));
          if (qx < 0 || qy < 0 || qx >= W || qy >= H) continue;
          const q = qy * W + qx;
          if (paper[q]) continue;
          sr += Rb[q]; sg += Gb[q]; sb += Bb[q]; nn++;
        }
        if (!nn) return null;
        const col = [Math.round(sr / nn), Math.round(sg / nn), Math.round(sb / nn)];
        const tt = (rand01(cp * 2.7, 4.3) - 0.5) * 7;
        return [clamp(col[0] + tt, 0, 255), clamp(col[1] + tt * 0.7, 0, 255), clamp(col[2] + tt * 0.4, 0, 255)];
      };
      let made = 0;
      for (let pass = 0; pass < 1 && strokes.length < hardCap; pass++) {
        const baseAng = (pass === 0 ? -0.62 : 0.58) + (rand01(19 + pass, 2.9) - 0.5) * 0.10;
        const ca = Math.cos(baseAng), sa = Math.sin(baseAng);
        let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
        for (const [px, py] of [[0, 0], [W, 0], [W, H], [0, H]]) {
          const dx = px - W * 0.5, dy = py - H * 0.5;
          const u = dx * ca + dy * sa, v = -dx * sa + dy * ca;
          if (u < uMin) uMin = u; if (u > uMax) uMax = u;
          if (v < vMin) vMin = v; if (v > vMax) vMax = v;
        }
        const stepV = cell * 0.80, stepU = cell * 1.10;
        // 先把整个网格收成候选，再按"离主体多近"排序落笔：
        // 起手几笔就把猫周围的大色面压出来，然后向四周扩散；
        // 15% 的关键帧里构图已经在了，不是先擦亮一个角。
        const cells = [];
        // 循环范围向外多走半档：画面四边不能留一圈没铺到的白框。
        let iv = 0;
        for (let v = vMin - stepV * 0.5; v <= vMax + stepV * 0.5; v += stepV, iv++) {
          let iu = 0;
          for (let u = uMin - stepU * 0.5; u <= uMax + stepU * 0.5; u += stepU, iu++) {
            const jx = (rand01(pass * 91 + v * 0.013, 1.7) - 0.5) * cell * 0.42;
            const jy = (rand01(pass * 57 + u * 0.011, 4.9) - 0.5) * cell * 0.42;
            // 落在画外的中心夹回边界内：边缘那一笔仍在画面里，不留白边。
            const cx = clamp(W * 0.5 + u * ca - (v + jx) * sa, 0, W - 1);
            const cy = clamp(H * 0.5 + u * sa + (v + jx) * ca + jy, 0, H - 1);
            const cp = Math.round(cy) * W + Math.round(cx);
            if (paper[cp]) continue;
            const flowA = coh[cp] > 0.2 ? 0.5 * Math.atan2(flowY[cp], flowX[cp]) : baseAng;
            const ang = style === 'oil' ? flowA : baseAng + (rand01(cp, 6.3) - 0.5) * 0.16;
            const len = cell * (1.75 + 0.50 * rand01(cp * 0.7, 2.3));
            // 距离乘一点随机：顺序有主次，但不呈机械的同心圆。
            const d = Math.hypot(cx - subj.focalX, cy - subj.focalY) * (0.84 + 0.32 * rand01(cp, 9.1));
            // 隔格先铺一道：第一拨笔就把整幅的大色面点到，再回头补密。
            // 只按"离主体远近"排，开头十几秒会只有猫周围有颜色，右半张还是白纸。
            cells.push({ cx, cy, cp, ang, len, d, wave: (iu + iv) & 1 });
          }
        }
        cells.sort((a, b) => (a.wave - b.wave) || (a.d - b.d));
        for (const c of cells) {
            if (strokes.length >= hardCap) return made;
            const { cx, cy, cp, ang, len } = c;
            const dx = Math.cos(ang) * len * 0.5, dy = Math.sin(ang) * len * 0.5;
            const sp = lineSpine(cx - dx, cy - dy, cx + dx, cy + dy,
              (rand01(cp * 1.9, 5.1) - 0.5) * cell * 0.16, cp, 4);
            const col = washColor(cx, cy, dx, dy, cp);
            if (!col) continue;
            emitStroke(sp.pts, profFill(sp.n, hw, cp), col, ph, {
              pen: 0, color: col, zoneMask: washMask,
            });
            made++;
        }
      }
      // 补缝：网格缝隙和画面边角还露着底（covered=0）的地方补一笔宽笔。
      // 只补漏、不重涂，笔形和上面同一种，不会变成逐像素补丁。
      let gapN = 0;
      const gs = cell * 0.40;
      for (let gy = gs * 0.5; gy < H && gapN < 120; gy += gs) {
        for (let gx = gs * 0.5; gx < W && gapN < 120; gx += gs) {
          const xi = Math.round(gx), yi = Math.round(gy);
          const cp = yi * W + xi;
          if (paper[cp] || covered[cp]) continue;
          const baseAng = -0.62 + (rand01(77, 2.9) - 0.5) * 0.10;
          const flowA = coh[cp] > 0.2 ? 0.5 * Math.atan2(flowY[cp], flowX[cp]) : baseAng;
          const ang = style === 'oil' ? flowA : baseAng + (rand01(cp, 6.3) - 0.5) * 0.16;
          const len = cell * 1.35;
          const dx = Math.cos(ang) * len * 0.5, dy = Math.sin(ang) * len * 0.5;
          const sp = lineSpine(gx - dx, gy - dy, gx + dx, gy + dy,
            (rand01(cp * 1.9, 5.1) - 0.5) * cell * 0.16, cp, 4);
          const col = washColor(gx, gy, dx, dy, cp);
          if (!col) continue;
          emitStroke(sp.pts, profFill(sp.n, hw, cp), col, ph, {
            pen: 0, color: col, zoneMask: washMask,
          });
          made++; gapN++;
        }
      }
      if (opts.debugMasks) console.log('[gap] made=', gapN);
      return made;
    }


    // ---- ph1：先背景后主体的大色面；大块先铺，小结构至少各有一笔 ----
    prog(0.52, '铺大色：背景 → 主体…');
    const baseStart = strokes.length;
    if (style === 'pencil' && isFlat) {
      const pStart = strokes.length;
      {
        // 平涂（简笔/图标）：排线组织明暗 + 留纸白。

        // 平涂：先主体色块，再背景一层淡排线。
        const subjectH = groups.filter((g) => !g.bg && !g.lineArt && !g.inkOnly && g.luma <= 232 &&
          g.area >= Math.max(30, N * 0.0004))
          .sort((a, b) => (b.sal * Math.sqrt(b.area)) - (a.sal * Math.sqrt(a.area)));
        const bgH = groups.filter((g) => g.bg && g.luma <= 232 && g.area >= Math.max(60, N * 0.0008))
          .sort((a, b) => b.area - a.area);
        const subjCapH = Math.round(budget * 0.50);
        for (const g of subjectH) {
          if (strokes.length - pStart >= subjCapH) break;
          hatchGroup(g, 1, false, pStart + subjCapH);
        }
        const bgCapH = Math.round(budget * 0.72);
        for (const g of bgH) {
          if (strokes.length - pStart >= bgCapH) break;
          hatchGroup(g, 1, false, pStart + bgCapH);
        }
      }
    } else {
      // 人的顺序：先把背景的大色面铺出来（不是所有背景都精修），
      // 再把主体的大块按"大关系优先"铺满，最后补小结构。
      const photo = !isFlat;
      // 铅笔常态笔宽只有几像素，铺大色面必须换成侧锋；几像素的笔填不满画面。
      if (style === 'pencil') baseBrush = Math.max(baseBrush, 40 * scaleB);
      if (photo) {
        blockInWash(1);
        // 底色一落完就补主体的几块大颜色（脸、胸、背）：起形阶段立刻有"猫"，
        // 背景细节放后面——这是人画时的"先定主体大色，再收拾背景"。
        const fgFirst = groups.filter((g) => !g.bg && !g.lineArt && !g.inkOnly &&
          g.area > N * 0.002 &&
          Math.hypot(g.cx - subj.focalX, g.cy - subj.focalY) < Math.min(W, H) * 0.34)
          .sort((a, b) => b.area - a.area).slice(0, 8);
        for (const g of fgFirst) {
          if (strokes.length >= baseCap) break;
          paintGroup(g, 1, false, bigFlatPencil(g) ? undefined : 2);
        }
      }
      const p1Start = strokes.length;
      // 有底色层时背景已经立住了，不再把预算花在重复铺背景上
      // 背景也要有真正的笔触：只给几十笔时，整片背景就是模糊底在透，
      // 看着像失焦照片而不是画。照片给约 1/6 的硬上限，铺大色面、留概括。
      const bgCap = photo ? Math.round(baseCap * 0.08) : Math.round(baseBudget * 0.36);
      const bgGroups = groups.filter((g) => g.bg).sort((a, b) => b.area - a.area);
      for (const g of bgGroups) {
        if (strokes.length - p1Start >= bgCap) break;
        paintGroup(g, 1, false, photo ? 2 : undefined);
      }
      const fg = groups.filter((g) => !g.bg && !g.lineArt && !g.inkOnly);
      const fscore = (g) => g.sal * Math.sqrt(g.area) *
        (1 + Math.min(1.2, g.edge / 6)) *
        (1 + 0.5 * Math.exp(-Math.hypot(g.cx - subj.focalX, g.cy - subj.focalY) / (Math.min(W, H) * 0.4)));
      fg.sort((a, b) => fscore(b) - fscore(a));
      const subjectCap = Math.round(baseBudget * (photo ? 1.55 : 0.97));
      if (photo) {
        // 照片的小色块太多：按面积从大到小，把每个色面真正铺满（≥88%），
        // 不是"每块点一笔"就换下一块——底色层会从没盖住的地方透出来，脸就糊了。
        // 额度优先给大色面：最大 21 个组占了 55% 的画面，先把它们铺满最划算。
        const massCap = Math.round(baseCap * 0.62);
        // 离视觉中心远的小块是背景纹理（石墙缝、树叶点），不逐块描；
        // 留模糊底 + 大块笔触，背景自然退后。视觉中心附近的小块才保留（五官）。
        const fR = Math.min(W, H) * 0.42;
        const minMass = (g) => (Math.hypot(g.cx - subj.focalX, g.cy - subj.focalY) < fR
          ? Math.max(36, N * 0.00005) : Math.max(180, N * 0.0012));
        const mass = fg.filter((g) => g.area >= minMass(g))
          .sort((a, b) => (b.area + b.sal * b.area * 0.35) - (a.area + a.sal * a.area * 0.35));
        for (const g of mass) {
          if (strokes.length - p1Start >= massCap || strokes.length >= baseCap) break;
          if (!gStrokeN[g.gid]) paintGroup(g, 1, false, bigFlatPencil(g) ? undefined : 1);
          let guard = 0;
          while (guard < 9 && groupUncov[g.gid] > Math.max(14, g.area * 0.12) &&
                 strokes.length - p1Start < massCap && strokes.length < baseCap) {
            const before = strokes.length;
            finishGroup(g, 1, g.area > N * 0.008 ? 3 : 1);
            const made = strokes.length - before;
            if (!made) break;
            guard += made;
          }
        }
        // 整块覆盖到 90% 时，嘴上、眼窝这一小块可能还是空的（按整块统计看不出来），
        // 底色就会从脸上透出来。单独按视觉中心统计"还没落笔的像素"，补成色面。
        const faceR = Math.min(W, H) * 0.30;
        const faceUn = new Map();
        const fx0 = Math.max(0, Math.floor(subj.focalX - faceR)), fx1 = Math.min(W - 1, Math.ceil(subj.focalX + faceR));
        const fy0 = Math.max(0, Math.floor(subj.focalY - faceR)), fy1 = Math.min(H - 1, Math.ceil(subj.focalY + faceR));
        for (let y = fy0; y <= fy1; y++) {
          const dy = y - subj.focalY;
          for (let x = fx0; x <= fx1; x++) {
            const dx = x - subj.focalX;
            if (dx * dx + dy * dy > faceR * faceR) continue;
            const p = y * W + x;
            if (paper[p] || paintN[p]) continue;
            const gid = groupOf[p];
            if (gid < 0) continue;
            faceUn.set(gid, (faceUn.get(gid) || 0) + 1);
          }
        }
        const gidMap = new Map(groups.map((g) => [g.gid, g]));
        const faceG = Array.from(faceUn.entries()).filter(([gid, n]) => n >= 10 && gidMap.has(gid))
          .sort((a, b) => b[1] - a[1]).slice(0, 18);
        let faceMade = 0;
        // 脸部额度单独留：大色面已经把 massCap 吃满，这里按"补脸最多 60 笔"放行，
        // 不够的从塑形阶段扣（脸比背景多铺一块重要）。
        for (const [gid, n] of faceG) {
          if (faceMade >= 60 || strokes.length >= baseCap) break;
          faceMade += finishGroup(gidMap.get(gid), 1, n > 140 ? 2 : 1);
        }
        if (opts.debug) console.log('[face] g=' + faceG.length + ' made=' + faceMade);
      } else {
        for (const g of fg) {
          if (strokes.length - p1Start >= subjectCap) break;
          paintGroup(g, 1, false);
        }
      }
      // 大色块里被扫线漏掉的窄条/侧翼：按未覆盖像素补 1~2 条，不重涂整块
      const fin = fg.filter((g) => groupUncov[g.gid] > Math.max(20, g.area * 0.05))
        .sort((a, b) => fscore(b) - fscore(a));
      let finUsed = 0;
      for (const g of fin) {
        if (strokes.length - p1Start >= budget * 0.98 || finUsed >= Math.max(10, Math.round(budget * 0.07))) break;
        finUsed += finishGroup(g, 1, g.area > N * 0.03 ? 3 : 2);
      }
      // 背景大块同样补漏（底边/圆环侧翼），只补 1~2 条，保留留白
      const bgFin = bgGroups.filter((g) => groupUncov[g.gid] > Math.max(60, g.area * 0.004));
      for (const g of bgFin) {
        if (finUsed >= Math.max(12, Math.round(budget * 0.08))) break;
        finUsed += finishGroup(g, 1, 2);
      }
      if (opts.debug) console.log('[fin] used=' + finUsed + ' groups=' + fin.length +
        ' fg=' + fg.length + ' bg=' + bgGroups.length + ' massCap=' + (photo ? Math.round(baseCap * 0.70) : 0) +
        ' baseUsed=' + (strokes.length - p1Start));
      if (opts.debug) {
        let unG = 0, unPx = 0, unPx120 = 0, unG120 = 0;
        for (const g of groups) {
          const un = groupUncov[g.gid];
          if (un <= Math.max(4, g.area * 0.2)) continue;
          unG++; unPx += un;
          if (g.area >= 120) { unG120++; unPx120 += un; }
        }
        console.log('[uncov] groups=' + unG + ' px=' + unPx + ' groups120=' + unG120 + ' px120=' + unPx120);
        const uh = groups.filter((g) => groupUncov[g.gid] > Math.max(4, g.area * 0.2))
          .sort((a, b) => groupUncov[b.gid] - groupUncov[a.gid]).slice(0, 24);
        console.log('[uncovTop] ' + uh.map((g) => 'g' + g.gid + '(a' + g.area + ',u' + groupUncov[g.gid] +
          ',e' + g.edge.toFixed(0) + ',s' + g.sal.toFixed(2) + ',t' + g.thick.toFixed(0) +
          (g.bg ? ',bg' : '') + (g.lineArt ? ',line' : '') + (g.inkOnly ? ',ink' : '') + ')').join(' '));
        const brackets = [60, 120, 240, 480, 960, 1920];
        const parts = brackets.map((th) => {
          let gn = 0, px = 0;
          for (const g of groups) {
            if (g.area < th || g.bg) continue;
            const un = groupUncov[g.gid];
            if (un <= Math.max(4, g.area * 0.2)) continue;
            gn++; px += un;
          }
          return th + ':' + gn + '/' + px;
        });
        let lineN = 0, linePx = 0, inkN = 0, inkPx = 0;
        for (const g of groups) {
          const un = groupUncov[g.gid];
          if (un <= Math.max(4, g.area * 0.2)) continue;
          if (g.lineArt) { lineN++; linePx += un; }
          else if (g.inkOnly) { inkN++; inkPx += un; }
        }
        console.log('[uncovBr] fg ' + parts.join(' ') + ' line=' + lineN + '/' + linePx + ' ink=' + inkN + '/' + inkPx);
      }
      // 预算没轮到的色块：至少给 1~3 条扫线，先保证"看得出是什么"。
      // 这一段落笔不能看软预算（budget）：前面铺大色面已经超了软预算时，
      // 剩下的字/线稿/小色面会整块只剩糊底透出来，海报的字就碎了。
      // 按"未盖住的像素 × 显著度/边缘"排，线稿优先；额度到 baseCap 为止，
      // 给 ph2 塑形和 ph3 点睛留下笔数（见上面的 detailReserve）。
      const coverCap = Math.max(strokes.length,
        Math.min(baseCap, strokes.length + Math.max(90, Math.round(budget * 0.95))));
      const missing = groups.filter((g) => {
        if (g.area < 16) return false;
        const un = groupUncov[g.gid];
        // 大块哪怕只差一成，也是几十万像素：只看比例会把整片蓝底/字心漏掉，
        // 混过色的底色就留在成品上，成了紫/青斑。按"比例或绝对像素"双重门槛。
        const lim = Math.min(g.area * (isFlat ? 0.18 : 0.32), 2500);
        return un > Math.max(6, lim);
      }).sort((a, b) => {
        const wa = (a.lineArt || a.inkOnly ? 3.2 : 1) * (0.35 + a.sal) * (1 + Math.min(1.5, a.edge / 12));
        const wb = (b.lineArt || b.inkOnly ? 3.2 : 1) * (0.35 + b.sal) * (1 + Math.min(1.5, b.edge / 12));
        return groupUncov[b.gid] * wb - groupUncov[a.gid] * wa;
      });
      for (const g of missing) {
        if (strokes.length >= coverCap || strokes.length >= baseCap) break;
        paintGroup(g, 1, false, g.area > N * 0.001 ? 2 : 1);
        // 一次扫线只盖住几条带；大块按"未覆盖像素直方图"再挑 1~2 带补，
        // 直到只剩零头或额度用完，不重涂已经盖住的地方。
        let rounds = 0;
        while (rounds < 4 && strokes.length < coverCap && strokes.length < baseCap) {
          const left = groupUncov[g.gid];
          if (left <= Math.max(8, Math.min(g.area * 0.05, 900))) break;
          if (!finishGroup(g, 1, 2)) break;
          rounds++;
        }
      }
      // 其余背景小块：各一条，不重涂；留白也算画面的一部分
      for (const g of bgGroups) {
        if (gStrokeN[g.gid] || strokes.length >= coverCap || strokes.length >= baseCap) continue;
        paintGroup(g, 1, false, 1);
      }
      rescueGroups(1, Math.max(10, Math.round(budget * 0.08)), baseCap);
      if (opts.debug) {
        let un = 0, unG = 0, touch = 0;
        for (const g of groups) {
          const u = groupUncov[g.gid];
          if (u > 0) { un += u; unG++; }
          if (!gStrokeN[g.gid] && g.area >= 16) touch++;
        }
        console.log('[covfix] px=' + un + ' groups=' + unG + ' untouched=' + touch +
          ' base=' + (strokes.length - p1Start) + ' cap=' + coverCap);
        const top = groups.filter((g) => groupUncov[g.gid] > 0)
          .sort((a, b) => groupUncov[b.gid] - groupUncov[a.gid]).slice(0, 12);
        console.log('[covfixTop] ' + top.map((g) => 'g' + g.gid + '(a' + g.area +
          ',u' + groupUncov[g.gid] + ',n' + gStrokeN[g.gid] +
          (g.lineArt ? ',line' : '') + (g.bg ? ',bg' : '') + ')').join(' '));
      }
    }
    baseCount = strokes.length - baseStart;
    // ---- ph2：塑形。只在高显著/主体块加中间笔触 ----
    prog(0.72, '塑形：主体结构与明暗…');
    await yieldUI();
    // 平涂仍按软预算收笔；照片按"硬上限 - 点睛预留"算，别让 detailBudget
    // 在铺色超预算后把塑形压成 10 笔。
    const detailLeft = isFlat
      ? Math.max(10, detailBudget - strokes.length)
      : Math.max(10, hardCap - strokes.length - accentReserve);
    const detailCap = Math.min(detailLeft,
      Math.max(12, Math.round(baseCount * (isFlat ? 0.55 : 0.90))));
    if (style === 'pencil') {
      // 小色块（鼻子/腮红/圆点）先按形状补密排线：大块排线预算里它们常被挤掉，
      // 但五官缺少这些小面，脸就空了。笔迹被 zoneGid 裁在色块内，形状自然成立。
      const patchCap = Math.min(hardCap, strokes.length + Math.max(10, Math.round(budget * 0.11)));
      const patches = groups.filter((g) => !g.bg && !g.lineArt && !g.inkOnly && g.luma <= 232 &&
        g.area >= Math.max(60, N * 0.00008) && g.area <= Math.max(400, N * 0.006) &&
        g.sal >= 0.55 && g.thick <= 110)
        .sort((a, b) => {
          const da = Math.hypot(a.cx - subj.focalX, a.cy - subj.focalY);
          const db = Math.hypot(b.cx - subj.focalX, b.cy - subj.focalY);
          return (b.sal * Math.sqrt(b.area) * (1 + 1.2 * Math.exp(-db / (Math.min(W, H) * 0.25)))) -
            (a.sal * Math.sqrt(a.area) * (1 + 1.2 * Math.exp(-da / (Math.min(W, H) * 0.25))));
        });
      for (const g of patches) {
        if (strokes.length >= patchCap) break;
        // 每块最多 8 条：小色块之间均分，别让一个大腮红吃掉整个补笔预算
        hatchGroup(g, 2, false, Math.min(patchCap, strokes.length + 8), 0.52, undefined, !isFlat && !graphic);
      }
      // 暗部交叉排线：只压主体，不再排背景
      const c2 = Math.min(hardCap - accentReserve,
        Math.max(strokes.length + 18, detailBudget));
      const darkGroups = groups.filter((g) => !g.bg && !g.lineArt && !g.inkOnly && g.luma < 220 &&
        g.area >= Math.max(30, N * 0.0004))
        .sort((a, b) => (b.sal * b.area) - (a.sal * a.area));
      for (const g of darkGroups) {
        if (strokes.length >= c2) break;
        hatchGroup(g, 2, true, Math.min(c2, strokes.length + 14));
      }
    } else if (detailCap > 0) {
      const cboost = (g) => isFlat ? 1 :
        (1 + 1.6 * Math.exp(-Math.hypot(g.cx - subj.focalX, g.cy - subj.focalY) / (Math.min(W, H) * 0.30)));
      const cand = groups.filter((g) => !g.bg && !g.lineArt && !g.inkOnly && g.area > Math.max(30, N * 0.00025))
        .sort((a, b) => (b.sal * Math.sqrt(b.area) * cboost(b)) - (a.sal * Math.sqrt(a.area) * cboost(a)));
      let used = 0;
      // 塑形不是"把剩下的预算全撒成小碎笔"：每块最多 12 笔，只碰最靠前的
      // 十几个结构块。再多的短笔不会增加结构信息，只会把色面和字迹蹭花。
      const per = Math.max(isFlat ? 2 : 4, Math.min(12,
        Math.round(detailCap / Math.max(3, Math.min(isFlat ? 10 : 18, cand.length)))));
      const candTop = cand.slice(0, isFlat ? 12 : 28);
      for (const g of candTop) {
        if (used >= detailCap || strokes.length >= hardCap) break;
        const k = Math.min(per, detailCap - used);
        detailGroup(g, k, 2, Math.max(0.22, g.sal * 0.55));
        used += k;
      }
      if (!isFlat) {
        const fc = Math.min(style === 'pencil' ? 180 : 420,
          Math.max(0, (isFlat ? detailBudget : hardCap - accentReserve) - strokes.length - 20));
        focalDetail(fc, 2);
      }
    }

    // ---- ph3：点睛。只画视觉中心的小结构；画完主动停笔 ----
    prog(0.88, '点睛：视觉中心…');
    await yieldUI();
    // 照片的点睛：量化后"深、细、小"的块就是眼睛、鼻头、嘴线、耳朵暗边。
    // 它们不走排线（会排成一块灰），直接沿骨架落短深线。彩笔也留少量，
    // 五官的深色边是"这一只"的关键，不然脸会糊成一块。
    if (!isFlat) {
      const fR3 = Math.min(W, H) * 0.45;
      const inkMax = style === 'pencil' ? 70 : (style === 'marker' ? 26 : 30);
      const inks = groups.filter((g) => g.inkOnly && g.area > 14 &&
        Math.hypot(g.cx - subj.focalX, g.cy - subj.focalY) < fR3)
        .sort((a, b) => b.area - a.area).slice(0, 20);
      let inkMade = 0;
      for (const g of inks) {
        if (strokes.length >= hardCap || inkMade >= inkMax) break;
        const paths = traceLineGroup(g);
        const take = style === 'pencil' ? Math.min(2, paths.length) : 1;
        for (let i = 0; i < take; i++) {
          inkLine(g, paths[i], 3);
          inkMade++;
        }
      }
      if (opts.debugMasks) console.log('[pink]', inks.length, 'made', inkMade);
    }

    // 线稿的五官/胡须：最后落，短而准，是画面最重的深色
    if (lineChunksLate.length) {
      const inkMax = style === 'pencil' ? 78 : (isFlat ? (style === 'oil' ? 22 : 24) : 40);
      const inkCap = style === 'pencil'
        ? Math.min(lineChunksLate.length, inkMax)
        : Math.min(lineChunksLate.length, Math.max(8, Math.round(budget * 0.10)), inkMax);
      for (let i = 0; i < inkCap && strokes.length < hardCap; i++) {
        inkLine(lineChunksLate[i].g, lineChunksLate[i].ch, 3);
      }
    }
    {
      const focus = groups.filter((g) => !g.bg && !g.lineArt && !g.inkOnly && g.area > 20)
        .sort((a, b) => ((b.sal * Math.sqrt(b.area)) - (a.sal * Math.sqrt(a.area))))
        .slice(0, 3);
      const leave = Math.min(Math.max(6, Math.round((budget - strokes.length) * 0.25)), 18);
      let used = 0;
      for (const g of focus) {
        if (used >= leave || strokes.length >= hardCap) break;
        const k = Math.max(2, Math.min(8, leave - used));
        detailGroup(g, k, 3, 0.42);
        used += k;
      }
      // 最后几笔重音：视觉中心附近最强的边缘，短、深、收笔
      const focalX = subj.focalX, focalY = subj.focalY, fr = Math.max(60, Math.min(W, H) * 0.18);
      const cand = [];
      for (let y = Math.max(1, (focalY - fr) | 0); y < Math.min(H - 1, (focalY + fr) | 0); y += 2) {
        let p = y * W + Math.max(1, (focalX - fr) | 0);
        for (let x = Math.max(1, (focalX - fr) | 0); x < Math.min(W - 1, (focalX + fr) | 0); x += 2, p += 2) {
          if (paper[p] || edge[p] < 18 || sal[p] < 0.45) continue;
          cand.push({ p, x, y, score: edge[p] * sal[p] });
        }
      }
      cand.sort((a, b) => b.score - a.score);
      const pick = [];
      const minD = Math.max(6, Math.min(W, H) * 0.012);
      const maxPick = Math.max(3, Math.min(16, Math.round(leave * 0.3)));
      for (const c of cand) {
        if (pick.length >= maxPick) break;
        let ok = true;
        for (const q of pick) if (Math.hypot(q.x - c.x, q.y - c.y) < minD) { ok = false; break; }
        if (ok) pick.push(c);
      }
      for (let i = 0; i < pick.length; i++) {
        const c = pick[i];
        const ang = coh[c.p] > 0.12 ? Math.atan2(flowY[c.p], flowX[c.p]) * 0.5 : 0;
        const len = (style === 'oil' ? 14 : 22) * scaleB * (0.8 + 0.6 * rand01(c.p, 2.8));
        const hw = (style === 'pencil' ? 1.5 : (style === 'oil' ? 4.2 : 2.5)) * scaleB;
        const dx = Math.cos(ang) * len * 0.5, dy = Math.sin(ang) * len * 0.5;
        const sp = lineSpine(c.x - dx, c.y - dy, c.x + dx, c.y + dy, (rand01(c.p, 7.4) - 0.5) * 2.2, c.p, 4);
        let col;
        // 点睛用最深的色板色当"墨"：马克笔的暗奶油调不出来时，
        // 深色勾一下眼/嘴/字边，比一条同色的隐形笔有用。
        if (style === 'marker') col = palette[0];
        else {
          const src = [R[c.p], G[c.p], B[c.p]];
          if (style === 'pencil') {
            const v = clamp(Math.round(luma(src) * 0.55), 24, 110);
            col = [v, v, v];
          } else col = mix(mix(src, palette[labels[c.p]] || src, 0.5), [20, 18, 16], 0.28);
        }
        emitStroke(sp.pts, profLine(sp.n, hw, c.p), col, 3, {
          pen: 1, color: col, zoneMask: subjectD, zoneGid: groupOf[c.p],
          fin: i === pick.length - 1 && !strokes.some((s) => s.fin),
        });
      }
      if (!strokes.some((s) => s.fin) && strokes.length) strokes[strokes.length - 1].fin = 1;
    }
    } // 非极简通路结束（起形→铺大色→塑形→点睛）

    // ---- 质量：画布 vs 原图 + 主体覆盖 + 缩略结构 ----
    let sumErr = 0, maxErr = 0, gt8 = 0, gt24 = 0, gt48 = 0, uncovered = 0;
    let paintErr = 0, paintGt8 = 0, paintGt24 = 0, paintGt48 = 0, reproducedPx = 0;
    const reproduced = new Uint8Array(N);
    for (let p = 0; p < N; p++) {
      const q = p * 3;
      let d;
      if (style === 'pencil') {
        d = Math.abs((canvas[q] * 0.299 + canvas[q + 1] * 0.587 + canvas[q + 2] * 0.114) - L[p]);
      } else {
        const dr = Math.abs(canvas[q] - R[p]), dg = Math.abs(canvas[q + 1] - G[p]), db = Math.abs(canvas[q + 2] - B[p]);
        d = dr > dg ? (dr > db ? dr : db) : (dg > db ? dg : db);
      }
      sumErr += d;
      if (d > maxErr) maxErr = d;
      if (d > 8) gt8++; if (d > 24) gt24++; if (d > 48) gt48++;
      // 未落笔但画布已经和原图一致（纸白、线稿内部白区、抗锯齿过渡）不算漏画。
      // covered 仍只表示真实触达的像素；reproduced 用于人类可读的覆盖率/查漏。
      const ok = !!covered[p] || d <= 8;
      if (ok) { reproduced[p] = 1; reproducedPx++; }
      if (!paper[p] && !ok) uncovered++;
      if (!paper[p]) {
        paintErr += d;
        if (d > 8) paintGt8++; if (d > 24) paintGt24++; if (d > 48) paintGt48++;
      }
    }
    const nonPaperPx = Math.max(1, N - paperPx);
    let subjectCov = 0, subjectAll = 0, edgeRecall = 0, edgeAll = 0;
    for (let p = 0; p < N; p++) {
      if (subject[p]) { subjectAll++; if (reproduced[p]) subjectCov++; }
      if (!paper[p] && edge[p] >= e85) { edgeAll++; if (reproduced[p]) edgeRecall++; }
    }
    const s4 = 4, w4 = Math.max(1, Math.round(W / s4)), h4 = Math.max(1, Math.round(H / s4));
    let thumbMean = 0, thumbBad = 0, edgeScore = 0, edgeN = 0;
    {
      const cA = new Float64Array(w4 * h4 * 3), cB = new Float64Array(w4 * h4 * 3);
      for (let y = 0; y < H; y++) {
        const yy = Math.min(h4 - 1, (y / s4) | 0);
        let p = y * W;
        for (let x = 0; x < W; x++, p++) {
          const xx = Math.min(w4 - 1, (x / s4) | 0), k = (yy * w4 + xx) * 3;
          cA[k] += canvas[p * 3]; cA[k + 1] += canvas[p * 3 + 1]; cA[k + 2] += canvas[p * 3 + 2];
          cB[k] += R[p]; cB[k + 1] += G[p]; cB[k + 2] += B[p];
        }
      }
      const cell = s4 * s4;
      for (let i = 0; i < w4 * h4; i++) {
        for (let c = 0; c < 3; c++) {
          const a = cA[i * 3 + c] / cell, b = cB[i * 3 + c] / cell;
          const d = Math.abs(a - b);
          thumbMean += d;
          if (d > 8) thumbBad++;
        }
      }
      thumbMean /= w4 * h4 * 3;
      thumbBad = thumbBad / (w4 * h4 * 3) * 100;
      const lumA = new Float32Array(w4 * h4), lumB = new Float32Array(w4 * h4);
      for (let i = 0; i < w4 * h4; i++) {
        lumA[i] = (cA[i * 3] * 0.299 + cA[i * 3 + 1] * 0.587 + cA[i * 3 + 2] * 0.114) / cell;
        lumB[i] = (cB[i * 3] * 0.299 + cB[i * 3 + 1] * 0.587 + cB[i * 3 + 2] * 0.114) / cell;
      }
      for (let y = 1; y < h4 - 1; y++) {
        for (let x = 1; x < w4 - 1; x++) {
          const i = y * w4 + x;
          const ga = Math.hypot(lumA[i + 1] - lumA[i - 1], lumA[i + w4] - lumA[i - w4]);
          const gb = Math.hypot(lumB[i + 1] - lumB[i - 1], lumB[i + w4] - lumB[i - w4]);
          edgeScore += Math.min(ga, gb) / Math.max(4, Math.max(ga, gb));
          edgeN++;
        }
      }
      edgeScore = edgeN ? edgeScore / edgeN : 0;
    }
    const quality = {
      tolerance: 255,
      bucketT: 0, max: Math.round(maxErr), mean: +(sumErr / N).toFixed(3),
      gt8: +(gt8 / N * 100).toFixed(3),
      gt24: +(gt24 / N * 100).toFixed(3),
      gt48: +(gt48 / N * 100).toFixed(3),
      // 保留“非纸面”口径，方便和旧版画家指标继续横向比较；主字段 mean/gt*
      // 统一按整张画布统计，与导出后逐像素复核完全一致。
      paintMean: +(paintErr / nonPaperPx).toFixed(3),
      paintGt8: +(paintGt8 / nonPaperPx * 100).toFixed(3),
      paintGt24: +(paintGt24 / nonPaperPx * 100).toFixed(3),
      paintGt48: +(paintGt48 / nonPaperPx * 100).toFixed(3),
      effectiveCoverage: +(reproducedPx / N * 100).toFixed(2),
      uncovered, regions: G_, colorRegions: G_, inkRegions: 0,
      thumbMean: +thumbMean.toFixed(3), thumbBad: +thumbBad.toFixed(3),
      edgeScore: +edgeScore.toFixed(3),
      subjectCoverage: +(subjectCov / Math.max(1, subjectAll) * 100).toFixed(2),
      edgeCoverage: +(edgeRecall / Math.max(1, edgeAll) * 100).toFixed(2),
      paperOK: style === 'pencil', artist: true,
    };
    const phases = [0, 1, 2, 3].map((ph) => strokes.filter((s) => s.ph === ph).length);
    const buildMs = Date.now() - t0;
    const paintablePx = exactInfo && exactInfo.paintable ? exactInfo.paintable : (N - paperPx);
    const info = {
      mode: 'artist', style, level: fid, palette: palette.length, flatScore: +flatScore.toFixed(3),
      isFlat, complexity: +complexity.toFixed(3), groups: G_, budget, hardCap,
      baseBrush: +baseBrush.toFixed(1), baseStrokes: baseCount, strokes: strokes.length,
      max: quality.max, mean: quality.mean, uncovered, zoneCoverage: +(zoneCov / Math.max(1, paintablePx) * 100).toFixed(1), subjectCoverage: quality.subjectCoverage,
      edgeCoverage: quality.edgeCoverage, edgeScore: quality.edgeScore,
      buildMs, paperPx, maskPx, exact: exactInfo || undefined, seed: exactInfo ? exactInfo.seed : undefined,
      topGroups: groups.slice().sort((a, b) => b.area - a.area).slice(0, 16).map((g) => ({
        a: g.area, sal: +g.sal.toFixed(2), edge: +g.edge.toFixed(1), bd: g.bg, sd: g.std, mg: g.mg, gr: g.grad,
        fill: +g.fill.toFixed(2), th: +g.thick.toFixed(1), n: gStrokeN[g.gid],
        un: groupUncov[g.gid], lab: g.label, box: [g.x0, g.y0, g.x1, g.y1],
      })),
      // 全量分组（只在调试时带出）：排版/元素聚类的离线调参用
      allGroups: opts.debugMasks ? groups.map((g) => ({
        gid: g.gid, a: g.area, m: g.mean, box: [g.x0, g.y0, g.x1, g.y1],
        sal: +g.sal.toFixed(3), bg: g.bg, line: g.lineLike, subj: g.subj || 0,
        bd: g.backdrop || 0, soft: g.soft || 0, grad: g.grad, ph: 0,
      })) : undefined,
      paletteColors: palette.map((c) => c.join(',')),
      groupOf: opts.debugMasks ? groupOf : undefined,
      labels: opts.debugMasks ? labels : undefined,
      groupLabels: opts.debugMasks ? groups.map((g) => g.label) : undefined,
      qimg: opts.debugMasks ? (() => {
        const qi = new Uint8Array(N * 3);
        for (let p = 0; p < N; p++) { const c = palette[labels[p]] || [255, 255, 255]; qi[p * 3] = c[0]; qi[p * 3 + 1] = c[1]; qi[p * 3 + 2] = c[2]; }
        return qi;
      })() : undefined,
      covered: opts.debugMasks ? covered : undefined,
      residualMask: opts.debugMasks ? (exactInfo && exactInfo.residualMap) : undefined,
      subject: opts.debugMasks ? subject : undefined,
      paper: opts.debugMasks ? paper : undefined,
    };
    if (opts.debug) {
      console.log('[artist] ' + style + ' L' + fid + ' pal=' + palette.length + ' flat=' + info.isFlat +
        ' fs=' + flatScore.toFixed(3) + ' cx=' + complexity.toFixed(3) + ' groups=' + G_ + ' budget=' + budget + ' base=' + baseCount + ' strokes=' + strokes.length +
        ' mean=' + quality.mean + ' unc=' + uncovered + ' zone=' + (zoneCov / Math.max(1, paintablePx) * 100).toFixed(1) +
        '% subj=' + quality.subjectCoverage + '% edge=' + quality.edgeScore + ' ms=' + buildMs);
    }
    prog(1.0, '完成');
    return {
      W, H, strokes, clips,
      canvasRgb: opts.returnCanvas ? canvas : undefined,
      keys: undefined,
      palette: opts.debug ? palette : undefined,
      dbg: opts.debug ? {
        artist: info,
        marks: [
          { tag: '起形', n: phases[0] }, { tag: '铺大色', n: phases[1] },
          { tag: '塑形', n: phases[2] }, { tag: '点睛', n: phases[3] },
        ],
      } : undefined,
      probe: undefined,
      stats: {
        regions: G_, inkGroups: 0, strokes: strokes.length,
        totalMs: strokes.reduce((a, s) => a + s.ms, 0),
        phases, colors: style === 'pencil' ? 0 : palette.length,
        photo: !isFlat, style: opts.style, detail: opts.detail, fidelity: fid,
        quality, algo: opts.algo === 'compiler' ? 'compiler' : (opts.algo === 'painter' ? 'painter' : 'artist'),
        seed: exactInfo ? exactInfo.seed : undefined,
        exactMode: exactInfo ? exactInfo.mode : undefined,
        exactOrder: exactInfo ? exactInfo.order : undefined,
        bgFill: exactInfo ? exactInfo.bgFill : undefined,
        compilerMode: exactInfo ? exactInfo.compilerMode : undefined,
        closedRegions: exactInfo ? exactInfo.closedRegions : undefined,
        ring: exactInfo ? exactInfo.ring : undefined,
      },
    };
  }

  async function run(px, W, H, opts, onProgress) {
    const rawOpts = opts || {};
    opts = Object.assign({}, CFG, rawOpts);
    CAPFIX = opts.capFix !== false;
    PROF_FLAT_SAMPLE = opts.profFlatSample !== false;
    // 还原程度：1 省笔 … 5 极致。3 = 原来的标准档（默认，逐像素结果不变）。
    // 老的 detail 入参仍能用（0→1 省笔、1→3 标准、2→5 极致），新代码请传 fidelity。
    let fid = rawOpts.fidelity;
    if (fid === undefined || fid === null) {
      fid = rawOpts.detail === undefined ? CFG.fidelity
        : (rawOpts.detail === 0 ? 1 : (rawOpts.detail === 2 ? 5 : 3));
    }
    fid = Math.max(1, Math.min(5, Math.round(+fid) || 3));
    opts.fidelity = fid;
    // 档位差异全部落在“补笔要补多细”上：轮数、阈值、补漏切分、笔数上限；
    // 主笔触的取色/分区逻辑不动，所以低档只是少补细节，不会把画面画歪。
    // 只覆盖仍是默认值的项：调用方显式传的参数优先（外部项目可以自己微调）。
    const setDefault = (vals) => {
      for (const k in vals) if (opts[k] === CFG[k]) opts[k] = vals[k];
    };
    if (fid === 1) {
      setDefault({ residual: [34, 28, 23, 19], holeT: 46, resMin: 1.5,
                   holeSplit: 26, resTail: 0, resTailMax: 2 });
    } else if (fid === 2) {
      setDefault({ residual: [32, 26, 21, 17], holeT: 36, resMin: 1.15,
                   holeSplit: 14, resTail: 0 });
    } else if (fid === 4) {
      setDefault({ residual: [30, 24, 18, 14, 11, 9, 7, 5.5, 4.5], holeT: 20,
                   resMin: 0.75, resHalfA: 0.85, resHalfB: 0.55,
                   holeSplit: 6, edgeT: 7 });
    } else if (fid === 5) {
      setDefault({ residual: [30, 24, 18, 14, 11, 9, 7, 5.5, 4.5, 3.8], holeT: 17,
                   resMin: 0.6, resHalfA: 0.8, resHalfB: 0.5,
                   holeSplit: 4, edgeT: 6, resTail: 3, resTailMax: 4,
                   exactRepair: 1, exactRepairShift: 1, exactRepairMax: 400000 });
    }
    const capScale = fid === 1 ? 0.5 : (fid === 2 ? 0.7 : (fid === 4 ? 1.3 : (fid === 5 ? 1.8 : 1)));
    // cover mode：档位不再是"补笔轮数"，而是颜色容差 + 笔数预算。
    // 预设只用 rawOpts 里没显式传的值（和上面的 setDefault 同一套规则）。
    opts.coverMode = rawOpts.coverMode === undefined ? true : !!rawOpts.coverMode;
    {
      const cvT = [8, 6, 4, 2, 1][fid - 1];
      const cvTM = [20, 16, 12, 8, 2][fid - 1];
      const cvB = [26000, 45000, 100000, 175000, 500000][fid - 1];
      opts.coverT = Math.max(1, Math.round(rawOpts.coverT || cvT));
      opts.coverTMax = Math.max(opts.coverT, Math.round(rawOpts.coverTMax || cvTM));
      opts.coverBudget = Math.max(200, Math.round(rawOpts.coverBudget || cvB));
      // 兼容老入参：显式传 exactRepair>0 时，把它当作 cover 的颜色容差（不再追加补丁笔）。
      if (rawOpts.exactRepair !== undefined && +rawOpts.exactRepair > 0) {
        opts.coverT = opts.coverTMax = Math.max(1, Math.round(+rawOpts.exactRepair));
      }
      if (opts.coverMode) opts.exactRepair = 0;
    }
    // 笔触风格：只改"笔形/笔宽/重叠/起稿笔感"，覆盖率的规则不动（保真优先）
    if (opts.style === 'pencil') {
      Object.assign(opts, { bwF: 0.10, bwMin: 7, bwMax: 30, coverOv: 0.55,
                            taperLo: 0.74, taperAmp: 0.34, taperWob: 0.12,
                            sketchHalf: 1.2, sketchGrid: 9, sketchOver: 8, bleedP: 0.16 });
    } else if (opts.style === 'oil') {
      Object.assign(opts, { bwF: 0.21, bwMin: 12, bwMax: 62, coverOv: 0.72,
                            taperLo: 0.93, taperAmp: 0.11, taperWob: 0.05,
                            sketchHalf: 2.6, sketchGrid: 4, sketchOver: 3, bleedP: 0.3, bleedR: 3 });
    }
    const yieldUI = () => new Promise((r) => setTimeout(r, 0));
    const prog = (p, msg) => { if (onProgress) onProgress(p, msg); };
    // 分段计时（诊断用）：哪一段在吃时间
    const T = {}; let tPrev = Date.now();
    const lap = (k) => { const n = Date.now(); if (opts.debug) T[k] = (T[k] || 0) + (n - tPrev); tPrev = n; };

    // 第三种算法：画家模式（观察 → 概括 → 起形 → 分阶段落笔）。独立入口，不碰 cover/pyramid。
    // 'painter'（画家·过程版）共用同一套观察/落笔机制，只在作画组织上换成"人画五遍"流程。
    if (opts.algo === 'artist' || opts.algo === 'painter' || opts.algo === 'compiler') return runArtistMode(px, W, H, opts, onProgress);
    // 第二种算法：整幅逐级细化（16 → 8 → 4 → 2 → 1）。走独立入口，不碰 cover 路径。
    if (opts.algo === 'pyramid') return runPyramidMode(px, W, H, opts, onProgress);
    // cover mode 是一条独立的精确管线：不需要调色板/图层/残差，直接早返回。
    if (opts.coverMode) return runCoverMode(px, W, H, opts, onProgress);

    // 错误连通块的"真实厚度" = 2×最大内切半径（距离变换）。
    // 不能再用 面积÷外框边长：字母/飞机那圈深色描边是细环，按面积÷外框会算出 46px 的假厚度，
    // 整条描边就被当成"大片平滑渐变"跳过、永远不补（用户看到的"边被啃"里有一条就是这个）。
    function compThick(c, pixArr) {
      const bw2 = c.x1 - c.x0 + 1, bh2 = c.y1 - c.y0 + 1;
      const m2 = new Uint8Array(bw2 * bh2);
      for (let k = 0; k < c.count; k++) {
        const p2 = pixArr[c.start + k];
        const x2 = p2 % W, y2 = (p2 - x2) / W;
        m2[(y2 - c.y0) * bw2 + (x2 - c.x0)] = 1;
      }
      const dt2 = distanceTransform(m2, bw2, bh2);
      let mx2 = 0;
      for (let i2 = 0; i2 < dt2.length; i2++) if (dt2[i2] > mx2) mx2 = dt2[i2];
      return mx2 * 2;
    }

    const N = W * H;
    const R = new Uint8Array(N), G = new Uint8Array(N), B = new Uint8Array(N);
    for (let i = 0; i < N; i++) { R[i] = px[i * 4]; G[i] = px[i * 4 + 1]; B[i] = px[i * 4 + 2]; }
    // 分块用的平滑图（取色与差异仍用原图）。
    // 先 median3 去噪点；再看"纹理强度"决定要不要再模糊（照片才需要，插画保持线条锐利）
    let Rs = med3(R, W, H), Gs = med3(G, W, H), Bs = med3(B, W, H);
    {
      let diff = 0;
      for (let i = 0; i < N; i++) {
        const d = Math.abs(Rs[i] - R[i]) + Math.abs(Gs[i] - G[i]) + Math.abs(Bs[i] - B[i]);
        if (d > 36) diff++;
      }
      const texFrac = diff / N;
      if (texFrac > 0.06) {
        const blurN = Math.max(0, Math.min(3, opts.photoBlurPasses | 0));
        for (let q = 0; q < blurN; q++) {
          Rs = box3(Rs, W, H); Gs = box3(Gs, W, H); Bs = box3(Bs, W, H);
        }
      }
      var texFracOut = texFrac;
      // 照片自动模式：纹理强的图（照片/扫描件）单独一套参数——
      // 色数提上去、笔更细、允许更多笔，不然平涂会把纹理糊成一格一格的色块。
      if (texFrac > 0.06) {
        opts.photoMode = true;
        // 实测（照片样张）：40 色比 32 色可见差异 35.03% → 34.63%，笔数还略少；再往上加轮数没收益
        if (!opts.colors && opts.autoColors) opts.colors = texFrac > 0.14 ? 44 : 40;
        if (opts.maxStrokes === CFG.maxStrokes) opts.maxStrokes = Math.round(40000 * capScale);
        if (opts.minArea === CFG.minArea) opts.minArea = texFrac > 0.14 ? 90 : 110;
        if (opts.bwF === CFG.bwF) { opts.bwF = 0.12; opts.bwMin = 7; }
        if (opts.coverOv === CFG.coverOv) opts.coverOv = 0.58;
        // 细线对比门槛：照片类的"细线"多是毛发/发丝（该画的细节），门槛放低保住它们；
        // 平涂/海报类的"细线"多是纸纹脏痕，保持高门槛（不写上去）
        if (opts.inkMinCd === CFG.inkMinCd) opts.inkMinCd = 60;
        // 照片类的"层"要切得细：合并门槛一大，整片岩石/毛发会被并成一层、用一个平均色去刷，
        // 远处暗部就整片错（实测 s2 19.3% → 32.6%）。25 是实测拐点。
        if (opts.objMergeCd === CFG.objMergeCd) opts.objMergeCd = 25;
        // 照片类的"又大又厚"门槛要保持低：纹理本来就该留着，让残差去描 8~30px 厚的块
        // 只会把纹理糊成色块（实测照片可见差异 2.58% → 2.92%）
        if (opts.resThick === CFG.resThick) opts.resThick = 8;
        // 小纹理块用"跟厚度相称"的笔宽，别用一把大刷子把爪垫/毛发刷成一个均值色
        if (opts.bwThickCap === CFG.bwThickCap) opts.bwThickCap = 2.0;
        // 照片的“标准”档（第 3 档）自动套用更细的补笔 + 收边参数；
        // 低档更粗、高档更细，参数在 run() 开头按 fidelity 已经设好。
        if (fid === 3) {
          setDefault({
            residual: [30, 24, 18, 14, 11, 9, 7, 5.5], holeT: 22, resMin: 0.8,
            resHalfA: 0.85, resHalfB: 0.55, sketchMax: 76, sketchGrid: 5, edgeT: 8,
          });
        }
        // 最高档再把“又大又厚”的门槛压低一点：照片里 6~8px 的毛发/纹理块也进补笔。
        if (fid === 5 && opts.resThick === 8) opts.resThick = 6;
        // 补缝按颜色二分的停止阈值：18 时爪垫这种 17 级明暗差会被当成一块、补成均值色
        if (fid === 3 && opts.holeSplit === CFG.holeSplit) opts.holeSplit = 8;
      }
      // 非照片（海报/插画）：标准档关掉自适应尾轮（追的是 5~7 的亚可见色差，笔多收益极小）；
      // 只有用户主动选“精细/极致”才把它打开。
      if (!opts.photoMode) {
        if (fid <= 3 && opts.resTail === CFG.resTail) opts.resTail = 0;
        else if (fid === 4 && opts.resTail === CFG.resTail) opts.resTail = 1;
        if (opts.maxStrokes === CFG.maxStrokes) opts.maxStrokes = Math.round(CFG.maxStrokes * capScale);
      }
    }
    // 自动色数（插画类也走这里：没指定颜色数就按纹理强弱给个合适的）
    // 非照片类（插画/海报）的自动色数：原来是 24。实测 40 色在三张示例上都更好或持平——
    // 海报那种"印刷扫描件"的深色描边/暗红在 24 色里根本没有对应的中心，量化只能把它塞给
    // 橙字或蓝底，于是边上一圈被涂成浑浊的棕带（"Gets first attention" 可见差异 11.4% → 3.5%）。
    if (!opts.colors && opts.autoColors) opts.colors = 40;
    if (opts.debug) console.log(`[auto] 纹理 ${(texFracOut * 100).toFixed(1)}% → colors=${opts.colors} photo=${!!opts.photoMode} maxStrokes=${opts.maxStrokes} bwF=${opts.bwF}`);

    prog(0.02, '分析颜色…'); await yieldUI();

    // 1) Lab + k-means（隔点采样加速）
    const step = Math.max(1, Math.round(Math.sqrt(N / 220000)));
    const nS = Math.ceil(N / step);
    const samp = new Float32Array(nS * 3);
    let ns = 0;
    {
      const lab = [0, 0, 0];
      for (let i = 0; i < N; i += step) {
        srgb2labInto(Rs[i], Gs[i], Bs[i], lab);
        samp[ns * 3] = lab[0]; samp[ns * 3 + 1] = lab[1]; samp[ns * 3 + 2] = lab[2];
        ns++;
      }
    }
    const { cen } = kmeans(samp.subarray(0, ns * 3), opts.colors, 12, 12345);
    const cenRaw = Array.from(cen, (v) => Math.round(v));

    // 2) 归并相近中心（领袖聚类）→ 调色板（RGB 由样本均值给出）
    const K = opts.colors;
    const pai = new Int32Array(K).fill(-1);
    const pal = [];
    for (let k = 0; k < K; k++) {
      let hit = -1;
      for (let p = 0; p < pal.length; p++) {
        const d = Math.hypot(cen[k * 3] - pal[p][0], cen[k * 3 + 1] - pal[p][1], cen[k * 3 + 2] - pal[p][2]);
        if (d < opts.mergeThr) { hit = p; break; }
      }
      if (hit < 0) { pal.push([cen[k * 3], cen[k * 3 + 1], cen[k * 3 + 2], 0]); hit = pal.length - 1; }
      pai[k] = hit;
    }
    // 中心 → 代表 RGB（用该中心附近的像素均值），顺带把"每个像素属于哪个调色板色"
    // 一次算完（labels）。这两件事原来各跑了一遍全图 × K 色的最近中心搜索，
    // 用的是同一份 cen/pai（中间没有任何改动）⇒ 结果逐位相同，纯白跑一遍。
    const labels = new Uint8Array(N);
    {
      const accR = new Float64Array(pal.length), accG = new Float64Array(pal.length),
            accB = new Float64Array(pal.length), cnt = new Float64Array(pal.length);
      const lab = [0, 0, 0];
      for (let i = 0; i < N; i++) {
        srgb2labInto(Rs[i], Gs[i], Bs[i], lab);
        const l0 = lab[0], l1 = lab[1], l2 = lab[2];
        let best = 0, bd = Infinity;
        for (let k = 0, k3 = 0; k < K; k++, k3 += 3) {
          const dL = l0 - cen[k3], dA = l1 - cen[k3 + 1], dB = l2 - cen[k3 + 2];
          const d = dL * dL + dA * dA + dB * dB;
          if (d < bd) { bd = d; best = k; }
        }
        const p = pai[best];
        labels[i] = p;
        accR[p] += R[i]; accG[p] += G[i]; accB[p] += B[i]; cnt[p]++;
      }
      for (let p = 0; p < pal.length; p++) {
        if (cnt[p] > 0) { pal[p][0] = accR[p] / cnt[p]; pal[p][1] = accG[p] / cnt[p]; pal[p][2] = accB[p] / cnt[p]; }
      }
    }
    prog(0.16, '分块…'); await yieldUI();

    // 3) 全图归类 —— 已在上面的循环里一起算完（labels），这里不再重复搜一遍

    // 4) 连通域
    let { compOf, pix, comps } = compsOfLabels(labels, W, H);

    // 5) 碎块吸收（并到颜色最近、面积最大的邻块）
    const oldComps = comps;
    // 细线像素（文字笔画、轮廓线）单独记下来：它们并进邻块 ⇒ 铺色时那里会被底色铺满，
    // 细线自己留到最后再"写"上去（人也是先铺满、最后题字，不是先挖个洞再一点点补）
    const inkPix = new Uint8Array(N);
    // 纹理像素（纸纹/噪点）：并进邻块后"不画、不参与底色取色、残差也不补"。
    // 老海报/扫描件的斑驳就是被当成内容一块块画出来才显得脏，放大后跟原图差得远。
    const texPix = new Uint8Array(N);
    let nThin = 0, nTex = 0;
    {
      const parent = new Int32Array(comps.length);
      for (let i = 0; i < comps.length; i++) parent[i] = i;
      const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
      let nSmall = 0, nMerged = 0, nNoVote = 0, nFar = 0, nNaN = 0;
      const thinLim = 9.0 * (W / 1024);   // 平均笔画宽度 ≤ 它就算细线（对齐原来 maxr ≤ 6.5*scale 的口径）
      // 邻块投票的计数用 Int32Array + touched 列表，不用 Map：数字键的 Map 在这
      // 是几百万次哈希（3 万块 × 8 邻域 × 2 轮），换数组后同样的算术、同样的
      // "首次遇到顺序" ⇒ bestScore 并列时的取舍一致，结果逐位不变。
      const vcnt = new Int32Array(comps.length);
      const touched = [];
      for (let round = 0; round < 2; round++) {
        for (let ci = 0; ci < comps.length; ci++) {
          if (find(ci) !== ci) continue;
          const c = comps[ci];
          const bwW = c.x1 - c.x0 + 1, bwH = c.y1 - c.y0 + 1;
          const estW = c.count / Math.max(1, Math.max(bwW, bwH));
          // 细线只认"长条形"（文字笔画、轮廓）：方方正正的小斑不是线，是纸纹
          const elong = Math.max(bwW, bwH) / Math.max(1, Math.min(bwW, bwH));
          const thin = estW <= thinLim && c.count >= 8 && elong >= 2.2;
          if (!thin && c.count >= opts.minArea) continue;
          nSmall++;
          touched.length = 0;
          for (let k = 0; k < c.count; k++) {
            const p = pix[c.start + k];
            const x = p % W, y = (p - x) / W;
            for (let dy = -1; dy <= 1; dy++) {
              const yy = y + dy;
              if (yy < 0 || yy >= H) continue;
              const row = yy * W;
              for (let dx = -1; dx <= 1; dx++) {
                if (!dx && !dy) continue;
                const xx = x + dx;
                if (xx < 0 || xx >= W) continue;
                const cj = find(compOf[row + xx]);
                if (cj === ci) continue;
                if (vcnt[cj]++ === 0) touched.push(cj);
              }
            }
          }
          const pi = pal[c.label];
          let bestJ = -1, bestScore = -1;
          for (let ti = 0; ti < touched.length; ti++) {
            const cj = touched[ti], v = vcnt[cj];
            const pj = pal[comps[cj].label];
            const cd = Math.hypot(pj[0] - pi[0], pj[1] - pi[1], pj[2] - pi[2]);
            const score = v / (1 + cd * 0.5);
            if (score > bestScore) { bestScore = score; bestJ = cj; }
          }
          for (let ti = 0; ti < touched.length; ti++) vcnt[touched[ti]] = 0;
          if (bestJ < 0) { nNoVote++; continue; }
          const pj = pal[comps[bestJ].label];
          if (!pj || !pi) { nNaN++; continue; }
          const cd = Math.hypot(pj[0] - pi[0], pj[1] - pi[1], pj[2] - pi[2]);
          // 纹理判据：小块 + 对比不强 ⇒ 纸纹/噪点（并进邻块、不画）
          const tex = !thin && c.count < opts.texMax && cd <= opts.texCd;
          if (thin || c.count < 6 || cd <= opts.absorbCd || tex) {
            parent[ci] = bestJ; nMerged++;
            if (thin) {
              if (cd >= opts.inkMinCd) {
                nThin++; for (let k = 0; k < c.count; k++) inkPix[pix[c.start + k]] = 1;
              } else {                                   // 弱对比的"线"其实是纸纹暗纹，不写
                nTex++; for (let k = 0; k < c.count; k++) texPix[pix[c.start + k]] = 1;
              }
            } else {
              nTex++; for (let k = 0; k < c.count; k++) texPix[pix[c.start + k]] = 1;
            }
          } else nFar++;
        }
      }
      if (opts.debug) console.log(`[absorb] comps=${comps.length} small=${nSmall} merged=${nMerged} thin=${nThin} tex=${nTex} noVote=${nNoVote} far=${nFar} nan=${nNaN} pal=${pal.length}`);
      // 重贴标签
      const rootOf = new Int32Array(comps.length);
      for (let i = 0; i < comps.length; i++) rootOf[i] = find(i);
      const L2 = new Uint32Array(N);
      for (let i = 0; i < N; i++) L2[i] = rootOf[compOf[i]] + 1;
      const cc = compsOfLabels(L2, W, H);
      compOf = cc.compOf; pix = cc.pix; comps = cc.comps;
      for (const c of comps) {
        const oldIdx = c.label - 1;
        c.palLabel = oldComps[oldIdx] ? oldComps[oldIdx].label : c.label - 1;
      }
    }

    // 6) 区块统计（面积/重心/PCA/包围盒掩膜）
    lap('absorb');
    prog(0.28, '整理区块…'); await yieldUI();
    const regions = [];
    for (let ci = 0; ci < comps.length; ci++) {
      const c = comps[ci];
      const n = c.count;
      let sx = 0, sy = 0;
      for (let k = 0; k < n; k++) {
        const p = pix[c.start + k];
        const x = p % W; sx += x; sy += (p - x) / W;
      }
      const cx = sx / n, cy = sy / n;
      let sxx = 0, sxy = 0, syy = 0;
      for (let k = 0; k < n; k++) {
        const p = pix[c.start + k];
        const x = p % W, y = (p - x) / W;
        const dx = x - cx, dy = y - cy;
        sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
      }
      sxx /= n; sxy /= n; syy /= n;
      const tr = sxx + syy, det = sxx * syy - sxy * sxy;
      const l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det));
      const l2 = tr / 2 - Math.sqrt(Math.max(0, tr * tr / 4 - det));
      const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      let ax = Math.cos(ang), ay = Math.sin(ang);
      // 让主轴方向落在"更长"的一侧
      let tmin = Infinity, tmax = -Infinity, vmax = 0;
      const nx = -ay, ny = ax;
      for (let k = 0; k < n; k++) {
        const p = pix[c.start + k];
        const x = p % W, y = (p - x) / W;
        const t = (x - cx) * ax + (y - cy) * ay;
        const v = Math.abs((x - cx) * nx + (y - cy) * ny);
        if (t < tmin) tmin = t;
        if (t > tmax) tmax = t;
        if (v > vmax) vmax = v;
      }
      if (tmax - tmin < 2 * vmax) { ax = nx; ay = ny; let tn = Infinity, tx = -Infinity, vm = 0; }
      // 用最终轴重算范围
      {
        const nx2 = -ay, ny2 = ax;
        let t2min = Infinity, t2max = -Infinity, v2max = 0, v2s = [];
        for (let k = 0; k < n; k++) {
          const p = pix[c.start + k];
          const x = p % W, y = (p - x) / W;
          const t = (x - cx) * ax + (y - cy) * ay;
          const v = Math.abs((x - cx) * nx2 + (y - cy) * ny2);
          if (t < t2min) t2min = t;
          if (t > t2max) t2max = t;
          if (v > v2max) v2max = v;
        }
        tmin = t2min; tmax = t2max; vmax = v2max;
      }
      let sr = 0, sg = 0, sb = 0, cn = 0;
      for (let k = 0; k < n; k++) {
        const p = pix[c.start + k];
        if (inkPix[p] || texPix[p]) continue;   // 细线/纹理像素不算进底色（否则会被黑字、纸纹拉暗拉花）
        sr += R[p]; sg += G[p]; sb += B[p]; cn++;
      }
      const color = cn > 0 ? [sr / cn, sg / cn, sb / cn] : [0, 0, 0];
      regions.push({
        cid: ci, x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, area: n,
        cx, cy, ax, ay, tmin, tmax, hp: Math.max(1, vmax),
        color: [Math.round(color[0]), Math.round(color[1]), Math.round(color[2])],
        pix0: c.start, pix1: c.start + n - 1,
      });
    }

    // 7) 细线层：就是吸收阶段挑出来的细线像素（文字笔画、轮廓线）。
    //    它们已经并进邻块 ⇒ 铺色时被底色盖住，留到最后再"写"上去。
    const inkBin = inkPix;
    // 非照片图给细线留一条保护带：残差/补漏不要再去修已经画对的字和描边。
    // 照片不启用——照片里的"细线"是毛发/胡须，保护带会挡住周围的纹理修正。
    const inkGuard = new Uint8Array(N);
    if (!opts.photoMode && opts.inkGuard > 0) {
      inkGuard.set(dilate(inkPix, W, H, Math.max(0, Math.round(opts.inkGuard))));
    }
    const isInk = new Uint8Array(regions.length);
    const dbg = { dark: 0, darkThin: nThin, tex: texFracOut, texPix: nTex, pal: [], cen: cenRaw, smallLeft: regions.filter((r) => r.area < opts.minArea).length, marks: [] };
    const scale = W / 1024;
    // 区块面积分布（笔数来源分析的底数）：[<120, 120-600, 600-2400, 2400-1万, ≥1万]
    const areaBins = [0, 120, 600, 2400, 10000, Infinity];
    {
      const hist = new Array(areaBins.length - 1).fill(0);
      for (const r of regions) {
        for (let b = 0; b < hist.length; b++) if (r.area >= areaBins[b] && r.area < areaBins[b + 1]) { hist[b]++; break; }
      }
      dbg.areaHist = hist;
    }
    lap('regions');
    prog(0.38, '提笔勾线…'); await yieldUI();

    // 8) 笔触生成
    const strokes = [];       // {rib,tp,color,pen,ms,c(裁剪组),r(区块),ph(阶段)}
    const mark = (tag) => dbg.marks.push({ tag, n: strokes.length });   // 笔数分解埋点（dev/stroke_breakdown.mjs 用）
    const lastPen = { x: 0, y: 0 };   // 笔尖当前位置：铺色顺序按"就近"串起来
    // 阶段：0 起稿（轻勾轮廓） 1 铺色（大块优先→收小） 2 收形（勾线+中等补笔） 3 点睛（细补笔）
    let visCanvas = null;     // 调试/测试用：最终纯色光栅结果
    let keysRgb = null;       // 关键帧（拖动进度用）
    const clips = [];         // {x,y,w,h,mask}
    const target = { R, G, B };
    // 一块错误里"深浅混在一起"时（渐变带、两条细线挨着），用一个均值色补上去会把浅的那半
    // 刷深——飞机边上那些"深色楔子"就是这么来的，而且下一轮还会被重新判成错、再补一遍。
    // 先按颜色二分（方差最大的通道、按中位数切），每一份单独补（各用各的均值色）。
    const splitPixByColor = (pix, cnt, depth, out) => {
      if (depth >= 4 || cnt < 9) { out.push({ pix, cnt }); return; }
      let mn0 = 255, mn1 = 255, mn2 = 255, mx0 = 0, mx1 = 0, mx2 = 0;
      for (let k = 0; k < cnt; k++) {
        const p = pix[k];
        if (R[p] < mn0) mn0 = R[p]; if (R[p] > mx0) mx0 = R[p];
        if (G[p] < mn1) mn1 = G[p]; if (G[p] > mx1) mx1 = G[p];
        if (B[p] < mn2) mn2 = B[p]; if (B[p] > mx2) mx2 = B[p];
      }
      const s0 = mx0 - mn0, s1 = mx1 - mn1, s2 = mx2 - mn2;
      const smax = Math.max(s0, s1, s2);
      if (smax <= (opts.holeSplit || 1e9)) { out.push({ pix, cnt }); return; }
      const ch = s0 === smax ? 0 : (s1 === smax ? 1 : 2);
      const vals = new Float64Array(cnt);
      for (let k = 0; k < cnt; k++) { const p = pix[k]; vals[k] = ch === 0 ? R[p] : (ch === 1 ? G[p] : B[p]); }
      const sorted = Array.from(vals).sort((a, b) => a - b);
      const med = sorted[cnt >> 1];
      let i = 0, j = cnt - 1;
      while (i <= j) {
        if (vals[i] <= med) i++;
        else {
          const tp = pix[i]; pix[i] = pix[j]; pix[j] = tp;
          const tv = vals[i]; vals[i] = vals[j]; vals[j] = tv; j--;
        }
      }
      if (i === 0 || i === cnt) { out.push({ pix, cnt }); return; }
      splitPixByColor(pix.subarray(0, i), i, depth + 1, out);
      splitPixByColor(pix.subarray(i), cnt - i, depth + 1, out);
    };
    let curTarget = target;      // 当前取色源（底色层会换成"背景色场"）
    const strokeScale = Math.max(0.5, scale);

    const pushClip = (x, y, w, h, mask) => {
      clips.push({ x, y, w, h, mask });
      return clips.length - 1;
    };

    function bboxOfComp(cc, ci, pad) {
      const c = cc.comps[ci];
      const x = Math.max(0, c.x0 - pad), y = Math.max(0, c.y0 - pad);
      const x1 = Math.min(W - 1, c.x1 + pad), y1 = Math.min(H - 1, c.y1 + pad);
      const w = x1 - x + 1, h = y1 - y + 1;
      const m = new Uint8Array(w * h);
      for (let k = 0; k < c.count; k++) {
        const p = cc.pix[c.start + k];
        const px0 = p % W, py0 = (p - px0) / W;
        if (px0 < x || py0 < y || px0 > x1 || py0 > y1) continue;
        m[(py0 - y) * w + (px0 - x)] = 1;
      }
      return { x, y, w, h, m };
    }

    // 采样：某个多边形在某个掩膜内的目标平均色
    const segTmp = { w: 0, h: 0, m: null };
    function sampleColor(polyFlat, np, clipMask, clipX, clipY, clipW, clipH) {
      let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
      for (let i = 0; i < np; i++) {
        const x = polyFlat[i * 2], y = polyFlat[i * 2 + 1];
        if (x < xmin) xmin = x; if (x > xmax) xmax = x;
        if (y < ymin) ymin = y; if (y > ymax) ymax = y;
      }
      const mw = Math.max(1, Math.ceil(xmax - Math.floor(xmin)) + 1);
      const mh = Math.max(1, Math.ceil(ymax - Math.floor(ymin)) + 1);
      if (mw * mh > 4000000) return null;
      const ox = Math.floor(xmin), oy = Math.floor(ymin);
      const local = new Uint8Array(mw * mh);
      const pts = new Float64Array(np * 2);
      for (let i = 0; i < np; i++) { pts[i * 2] = polyFlat[i * 2] - ox; pts[i * 2 + 1] = polyFlat[i * 2 + 1] - oy; }
      fillPoly(local, mw, mh, pts);
      let sr = 0, sg = 0, sb = 0, cnt = 0;
      for (let y = 0; y < mh; y++) {
        const gy = oy + y;
        if (gy < clipY || gy >= clipY + clipH || gy < 0 || gy >= H) continue;
        for (let x = 0; x < mw; x++) {
          if (!local[y * mw + x]) continue;
          const gx = ox + x;
          if (gx < clipX || gx >= clipX + clipW || gx < 0 || gx >= W) continue;
          if (!clipMask[(gy - clipY) * clipW + (gx - clipX)]) continue;
          const p = gy * W + gx;
          sr += curTarget.R[p]; sg += curTarget.G[p]; sb += curTarget.B[p];
          cnt++;
        }
      }
      if (cnt < 4) return null;
      return [Math.round(sr / cnt), Math.round(sg / cnt), Math.round(sb / cnt)];
    }

    function pathSegments(path, n, segLen) {
      if (n < 2) return [{ pts: Float64Array.from([path[0], path[1]]), n: 1, len: 0 }];
      const cum = new Float64Array(n);
      for (let i = 1; i < n; i++) {
        cum[i] = cum[i - 1] + Math.hypot(path[i * 2] - path[(i - 1) * 2],
                                         path[i * 2 + 1] - path[(i - 1) * 2 + 1]);
      }
      const total = cum[n - 1];
      if (total <= 1e-6) return [{ pts: Float64Array.from([path[0], path[1]]), n: 1, len: 0 }];
      const at = (t) => {
        let i = 1;
        while (i < n - 1 && cum[i] < t) i++;
        const f = (t - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
        return [path[(i - 1) * 2] + (path[i * 2] - path[(i - 1) * 2]) * f,
                path[(i - 1) * 2 + 1] + (path[i * 2 + 1] - path[(i - 1) * 2 + 1]) * f];
      };
      const segs = [];
      const step = Math.max(4, segLen);
      let s0 = 0;
      while (s0 < total - 1e-6) {
        const e = Math.min(total, s0 + step);
        const pts = [];
        const p0 = at(s0), p1 = at(e);
        pts.push(p0[0], p0[1]);
        for (let k = 1; k < n - 1; k++) {
          if (cum[k] > s0 + 1e-6 && cum[k] < e - 1e-6) pts.push(path[k * 2], path[k * 2 + 1]);
        }
        pts.push(p1[0], p1[1]);
        segs.push({ pts: Float64Array.from(pts), n: pts.length >> 1, len: e - s0 });
        s0 = e;
      }
      return segs;
    }

    function emitStroke(ribFlat, np, pathFlat, nPath, halfW, color, pen, cIdx, rIdx, ph) {
      let len = 0;
      for (let i = 1; i < nPath; i++) {
        len += Math.hypot(pathFlat[i * 2] - pathFlat[(i - 1) * 2], pathFlat[i * 2 + 1] - pathFlat[(i - 1) * 2 + 1]);
      }
      const phase = ph === undefined ? 1 : ph;
      // 节奏：起稿又快又轻；点睛最慢最小心；其余按长度给时间（短笔也要有起步价）
      let weight;
      if (phase === 0) weight = 8 + len * 1.0;
      else if (phase === 3) weight = 26 + len * 2.6;
      else if (phase === 2) weight = 18 + len * 2.2;
      else weight = 12 + len * 1.8;
      weight *= 0.85 + 0.3 * rand01(len + strokes.length * 0.37, phase + 1.7);   // 每笔快慢有点起伏
      if (luma(color) > 238) weight *= 0.3;                                      // 白底一笔带过
      const rec = {
        rib: Array.from(ribFlat, (v) => Math.round(v * 10) / 10),
        tp: Array.from(pathFlat, (v) => Math.round(v * 10) / 10),
        w: Math.round(halfW * 2 * 10) / 10,
        color: [color[0], color[1], color[2]],
        pen: pen ? 1 : 0,
        ms: weight,           // 先存权重，收尾时按目标总时长归一
        c: cIdx, r: rIdx, ph: phase, ly: curLayer,
      };
      strokes.push(rec);
      if (nPath >= 1) {
        lastPen.x = pathFlat[(nPath - 1) * 2];
        lastPen.y = pathFlat[(nPath - 1) * 2 + 1];
      }
      return rec;
    }

    // 沿路径取局部色并按"颜色相近的相邻段"合并：返回待落笔的段（不直接落笔，好让调用方连笔）
    let segLenOverride = 0, joinCdOverride = 0;   // 底色层用：分段更短、颜色差得更少才并笔（渐变才不会被抹平）
    function localParts(path, n, halfW, clipMask, cx, cy, cw, ch, pen, cIdx, rIdx, fallback, ph) {
      const segs = pathSegments(path, n, segLenOverride || Math.max(opts.segMin * strokeScale, halfW * opts.segF));
      const cols = [];
      for (const sg of segs) {
        if (sg.n < 2) { cols.push(null); continue; }
        const rb = ribbon(sg.pts, sg.n, halfW);
        const rbS = ribbon(sg.pts, sg.n, halfW, true);   // 取色用平头：圆头会把两端邻色平均进来
        cols.push(sampleColor(rbS, rbS.length / 2, clipMask, cx, cy, cw, ch) || fallback);
      }
      const parts = [];
      let i = 0;
      while (i < segs.length) {
        let j = i;
        while (j + 1 < segs.length && cols[j + 1] && cols[i] &&
               Math.abs(cols[j + 1][0] - cols[i][0]) + Math.abs(cols[j + 1][1] - cols[i][1]) +
               Math.abs(cols[j + 1][2] - cols[i][2]) < (joinCdOverride || opts.segJoinCd)) j++;
        const pts = [];
        for (let k = i; k <= j; k++) {
          const P = segs[k].pts;
          for (let m = 0; m < P.length; m++) pts.push(P[m]);
        }
        const arr = Float64Array.from(pts);
        const np = arr.length / 2;
        if (np >= 2) {
          const rib = ribbon(arr, np, halfW);
          const col = cols[i] || fallback;
          const pn = pen < 0 ? (luma(col) < opts.inkLuma ? 1 : 0) : pen;   // -1：按色深自动
          parts.push({ rib, path: arr, col, pen: pn, cIdx, rIdx, ph });
        }
        i = j + 1;
      }
      return parts;
    }
    // 变宽版 localParts：半宽按"路径上这一点的厚度"来（细长层用：笔要跟着形状的宽窄走）
    function localPartsProf(path, n, halfAt, sampleM, cIdx, rIdx, fallback, ph, pen, sampleHalfAt) {
      const segs = pathSegments(path, n, Math.max(opts.segMin * strokeScale, 26));
      const ribs = [], cols = [];
      for (const sg of segs) {
        if (sg.n < 2) { ribs.push(null); cols.push(null); continue; }
        const halfs = new Float64Array(sg.n);
        for (let i = 0; i < sg.n; i++) halfs[i] = halfAt(sg.pts[i * 2], sg.pts[i * 2 + 1]);
        const rb = ribbonProf(sg.pts, sg.n, halfs);
        ribs.push(rb);
        // 取色可以另用一套"窄笔形"：笔形为了盖满形状被就地加宽之后，
        // 取色还按加宽后的范围算，就会把旁边的深色描边也平均进去（实测会画出灰条）
        let sPoly = ribbon(sg.pts, sg.n, halfs[0], true);
        if (sampleHalfAt) {
          const sh = new Float64Array(sg.n);
          for (let i = 0; i < sg.n; i++) sh[i] = sampleHalfAt(sg.pts[i * 2], sg.pts[i * 2 + 1]);
          // 取色笔形必须**平头**（noCap）：带圆头会把两端邻色平均进来，
          // 长笔在拐弯处采样到隔壁颜色就整段刷错色（与 ribbon(...) 的 noCap 同一口径）
          sPoly = ribbonProf(sg.pts, sg.n, sh, PROF_FLAT_SAMPLE);
        }
        cols.push(sampleColor(sPoly, sPoly.length / 2, sampleM.m, sampleM.x, sampleM.y, sampleM.w, sampleM.h) || fallback);
      }
      const parts = [];
      let i = 0;
      while (i < segs.length) {
        let j = i;
        while (j + 1 < segs.length && cols[j + 1] && cols[i] &&
               Math.abs(cols[j + 1][0] - cols[i][0]) + Math.abs(cols[j + 1][1] - cols[i][1]) +
               Math.abs(cols[j + 1][2] - cols[i][2]) < opts.segJoinCd) j++;
        const pts = [];
        for (let k = i; k <= j; k++) {
          const P = segs[k].pts;
          for (let m = 0; m < P.length; m++) pts.push(P[m]);
        }
        const arr = Float64Array.from(pts);
        if (arr.length >= 4) {
          const rib = (j > i) ? mergeLoops(ribs.slice(i, j + 1)) : ribs[i];
          parts.push({ rib, path: arr, col: cols[i] || fallback, pen: 1, cIdx, rIdx, ph });
        }
        i = j + 1;
      }
      return parts;
    }

    function emitLocal(path, n, halfW, clipMask, cx, cy, cw, ch, pen, cIdx, rIdx, fallback, ph, onRec) {
      for (const p of localParts(path, n, halfW, clipMask, cx, cy, cw, ch, pen, cIdx, rIdx, fallback, ph)) {
        const rec = emitStroke(p.rib, p.rib.length / 2, p.path, p.path.length / 2, halfW, p.col, p.pen, p.cIdx, p.rIdx, p.ph);
        if (onRec) onRec(rec);
      }
    }

    // ---- 7.5) 起稿：沿"主要轮廓"轻轻勾一遍（细、快、轻；后面铺色会盖住它，像真起稿） ----
    prog(0.42, '起稿勾形…'); await yieldUI();
    if (opts.sketch) {
      let maxCid = 0;
      for (const rg of regions) if (rg.cid > maxCid) maxCid = rg.cid;
      const areaOf = new Int32Array(maxCid + 1);
      for (const rg of regions) areaOf[rg.cid] = rg.area;
      const minSide = Math.max(200, Math.round(240 * scale * scale));   // 只勾大体轮廓，不勾碎屑
      const edge = new Uint8Array(N);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const p = y * W + x;
          const c0 = compOf[p], a0 = areaOf[c0] || 0;
          let on = 0;
          if (x + 1 < W) {
            const c1 = compOf[p + 1];
            if (c1 !== c0 && (a0 >= minSide || (areaOf[c1] || 0) >= minSide)) on = 1;
          }
          if (!on && y + 1 < H) {
            const c2 = compOf[p + W];
            if (c2 !== c0 && (a0 >= minSide || (areaOf[c2] || 0) >= minSide)) on = 1;
          }
          if (on) edge[p] = 1;
        }
      }
      const ecc = compsOfLabels(edge, W, H);
      const cand = [];
      for (let ci = 0; ci < ecc.comps.length; ci++) {
        if (ecc.comps[ci].label === 1 && ecc.comps[ci].count >= 12) cand.push(ci);
      }
      cand.sort((a, b) => ecc.comps[b].count - ecc.comps[a].count);
      const items = cand.slice(0, opts.sketchMax).map((ci) => ({
        ci, cx: (ecc.comps[ci].x0 + ecc.comps[ci].x1) / 2, cy: (ecc.comps[ci].y0 + ecc.comps[ci].y1) / 2,
      }));
      const seq = chainNN(items, (it) => [it.cx, it.cy], 0, 0);
      const halfS = Math.max(1.1, opts.sketchHalf * strokeScale);
      const clipPad = Math.max(1, Math.round(1.2 * strokeScale));
      const mix = opts.sketchMix;
      // 起稿色：局部目标色往铅笔灰里压一点——有"铅笔线"的味道，又不会留下大片深色残迹
      const pencil = (x, y) => {
        const xi = clamp(Math.round(x), 0, W - 1), yi = clamp(Math.round(y), 0, H - 1);
        const p0 = yi * W + xi;
        return [Math.round(R[p0] * (1 - mix) + 74 * mix),
                Math.round(G[p0] * (1 - mix) + 72 * mix),
                Math.round(B[p0] * (1 - mix) + 76 * mix)];
      };
      const grid = Math.max(0, Math.round(opts.sketchGrid * strokeScale));
      const over = Math.max(0, opts.sketchOver * strokeScale);
      for (const it of seq) {
        const bw = bboxOfComp(ecc, it.ci, clipPad + grid);
        const { sk } = thin(bw.m, bw.w, bw.h);
        const lp = longestPath(sk, bw.w, bw.h);
        if (!lp || lp.len < 4) continue;
        const absPath = new Float64Array(lp.len * 2);
        for (let i = 0; i < lp.len; i++) {
          absPath[i * 2] = lp.pts[i * 2] + bw.x;
          absPath[i * 2 + 1] = lp.pts[i * 2 + 1] + bw.y;
        }
        const mi = lp.len >> 1;
        const col = pencil(absPath[mi * 2], absPath[mi * 2 + 1]);
        // 真起稿画不准、也不收锋：路径按网格"随手"简化，两端再画过头一点
        let pth = absPath, pn = lp.len;
        if (grid > 1 && lp.len >= 6) {
          const simp = [];
          const push = (x, y) => {
            if (simp.length >= 2) {
              const lx = simp[simp.length - 2], ly = simp[simp.length - 1];
              if (Math.max(Math.abs(x - lx), Math.abs(y - ly)) < grid) return;
            }
            simp.push(x, y);
          };
          const d0x = absPath[0] - absPath[2], d0y = absPath[1] - absPath[3];
          const l0 = Math.hypot(d0x, d0y) || 1;
          push(absPath[0] + d0x / l0 * over, absPath[1] + d0y / l0 * over);
          for (let i = 0; i < lp.len; i++) push(absPath[i * 2], absPath[i * 2 + 1]);
          const e2 = (lp.len - 1) * 2;
          const d1x = absPath[e2] - absPath[e2 - 2], d1y = absPath[e2 + 1] - absPath[e2 - 1];
          const l1 = Math.hypot(d1x, d1y) || 1;
          push(absPath[e2] + d1x / l1 * over, absPath[e2 + 1] + d1y / l1 * over);
          if (simp.length >= 4) { pth = Float64Array.from(simp); pn = simp.length >> 1; }
        }
        // 粗线会偏出原始轮廓，掩膜相应放宽，免得被切成虚线
        const cIdx = pushClip(bw.x, bw.y, bw.w, bw.h, dilate(bw.m, bw.w, bw.h, clipPad + grid));
        const rib = ribbon(pth, pn, halfS);
        emitStroke(rib, rib.length / 2, pth, pn, halfS, col, 1, cIdx, -1, 0);
      }
    }
    mark('起稿');

    // ---- 8a) 细线层（轮廓线 + 文字）：分两拨画 ----
    // 属于某个对象的细线（猫嘴、胡须、字的描边）在该对象铺完色后立刻画；
    // 落在背景/纸底上的（题字、落款）留到最后，按行写。
    // 组划分（连通域、行序、归属）在铺色前统一做，这里只负责"画给定的组"。
    const inkClips = [];
    let inkIcc = null;                  // 细线连通域（两拨共用）
    let inkLastSeq = [];                // 留到最后的细线组（按行序）
    const inkOfObj = new Map();         // 对象序号 → [细线组 ci, ...]（按行序）
    const drawInkSeq = (seq, rasterFn, ph = 2) => {
      if (!inkIcc) return;
      const icc = inkIcc;
      for (const ci of seq) {
        const bw = bboxOfComp(icc, ci, 0);              // 严格掩膜（取色用）
        const clipM = opts.dilInk > 0 ? dilate(bw.m, bw.w, bw.h, opts.dilInk) : bw.m;
        const full = new Uint8Array(W * H);
        for (let k = 0; k < icc.comps[ci].count; k++) full[icc.pix[icc.comps[ci].start + k]] = 1;
        const cIdx = pushClip(bw.x, bw.y, bw.w, bw.h, clipM);
        let inkFallback = [46, 46, 52];
        {
          let sr0 = 0, sg0 = 0, sb0 = 0, n0 = 0;
          for (let k = 0; k < icc.comps[ci].count; k++) {
            const pp0 = icc.pix[icc.comps[ci].start + k];
            sr0 += R[pp0]; sg0 += G[pp0]; sb0 += B[pp0]; n0++;
          }
          if (n0) inkFallback = [Math.round(sr0 / n0), Math.round(sg0 / n0), Math.round(sb0 / n0)];
        }
        const bin = new Uint8Array(bw.w * bw.h);
        for (let y = 0; y < bw.h; y++) {
          for (let x = 0; x < bw.w; x++) bin[y * bw.w + x] = full[(y + bw.y) * W + (x + bw.x)];
        }
        const dt = distanceTransform(bin, bw.w, bw.h);
        let dmax = 0;
        for (let i = 0; i < dt.length; i++) if (dt[i] > dmax) dmax = dt[i];
        const half = clamp(dmax + 1.4 * strokeScale, 2.0, 12 * strokeScale);
        // 分支队列：每画一条最长骨架路径，就把剩下没盖住的连通块继续排队，
        // 直到整层线稿都被笔画覆盖（复杂线稿会有很多分支）。
        // 剩下的块只要还有点面积就继续排——门槛太高会留下没人画的白点。
        const queue = [bin.slice()];
        let guard = 0;
        while (queue.length && guard++ < 200) {
          const m0 = queue.shift();
          globalThis.__thinTag = 'ink';
          const { sk } = thin(m0, bw.w, bw.h);
          const lp = longestPath(sk, bw.w, bw.h);
          if (lp && lp.len >= 2) {
            const raw = new Float64Array(lp.len * 2);
            for (let i = 0; i < lp.len; i++) {
              raw[i * 2] = lp.pts[i * 2] + bw.x;
              raw[i * 2 + 1] = lp.pts[i * 2 + 1] + bw.y;
            }
            // 中轴拉直：直线的骨架是"一像素一像素拐"出来的，照描就是坑坑洼洼（用户点名的毛病）
            const sp = rdpSimplify(raw, lp.len, opts.lineTol);
            const absPath = sp.pts, nPath = sp.n;
          if (opts.localColor) {
            emitLocal(absPath, nPath, half, bw.m, bw.x, bw.y, bw.w, bw.h, -1, cIdx, -1, inkFallback, ph, rasterFn);
          } else {
            const rib = ribbon(absPath, nPath, half);
            const rec = emitStroke(rib, rib.length / 2, absPath, nPath, half, inkFallback, 1, cIdx, -1, ph);
            if (rasterFn) rasterFn(rec);
          }
            const cover = new Uint8Array(bw.w * bw.h);
            fillPoly(cover, bw.w, bw.h, (() => {
              const r = ribbon(absPath, nPath, half);
              const out = new Float64Array(r.length);
              for (let i = 0; i < r.length; i += 2) { out[i] = r[i] - bw.x; out[i + 1] = r[i + 1] - bw.y; }
              return out;
            })());
            for (let i = 0; i < m0.length; i++) if (m0[i] && cover[i]) m0[i] = 0;
          }
          // 剩下的连通块继续排队
          const rc = compsOfLabels(m0, bw.w, bw.h);
          for (let j = 0; j < rc.comps.length; j++) {
            if (rc.comps[j].label !== 1 || rc.comps[j].count < Math.max(6, half * half)) continue;
            const nm = new Uint8Array(bw.w * bw.h);
            for (let k = 0; k < rc.comps[j].count; k++) nm[rc.pix[rc.comps[j].start + k]] = 1;
            queue.push(nm);
          }
        }
        inkClips.push(cIdx);
      }
    };
    lap('ink');
    prog(0.52, '铺色块…'); await yieldUI();

    // ---- 8b) 非线稿区块：毛笔刷（沿主轴一档档来回涂） ----
    const regionOrder = [];
    let sweepRegions = 0, passTotal = 0, passMax = 0;   // 埋点：铺色区块数 / 总档数 / 单块最多档数
    const objOfComp = new Int32Array(regions.length);   // 区块 → 对象序号（残差/补漏也按这个顺序走）
    // ================= 图层栈：一个对象 = 一层 =================
    // 老版本是"一个层核一个区块" ⇒ 蓝底被色带切成几十条各画各的（用户截图里的竖条带）、
    // 黑框四条边也各画各的、每层还都只画自己"看得见"的那块。这里改成：
    //   ① 相邻 + 颜色相近的层核并成同一个对象（一整片蓝底是一层、一整圈黑框是一层）；
    //   ② 每层算出"完整形状"——被上层盖住的部分也要画（形状闭合推断，只补"上层"不补"下层"）；
    //   ③ 一层画完当场自检这一层有没有漏，漏了立刻补，不拖到最后。
    let baseObj = -1;                 // 底色层（最下面那层非纸底）
    let curLayer = -1;                // 当前正在画的层号（记进每一笔的 ly，收尾判"该不该删"用）
    let objLab = null;                // 像素 → 对象序号
    const objRegions = [];            // 每层包含哪些区块
    const objBox = [];                // 每层：可见部分的 bbox + 掩膜
    const objFull = [];               // 每层：完整形状（含被上层盖住的部分）
    const objStat = [];               // 每层：面积/主轴/半宽/厚度/颜色/是否细长/是否纸底
    const objAdj = [];                // 每层的邻接表（贴着哪些层）
    let nObj = 0;
    let bgMap = null;                 // 底色层的"背景色场"：被上层盖住的地方按周围推出来
    {
      const imp = (rg) => Math.hypot(rg.color[0] - 255, rg.color[1] - 255, rg.color[2] - 255);
      const isBg = (rg) => luma(rg.color) > 240 && imp(rg) < 24;
      const list = [];
      for (let ri = 0; ri < regions.length; ri++) if (!isInk[ri]) list.push(ri);
      // --- 并查集：**挨着 + 颜色相近** 两个条件同时满足才并成一层 ---
      // 只按"挨着"会把字并进蓝底（整幅变一层）；只按"颜色近"会把画面两头同色的东西并成一层
      // （笔尖满屏飞）。两个一起用，分出来的才是"一个东西"：一整片蓝底、一整圈黑框、一个字母。
      const uf = new Int32Array(regions.length);
      for (let i = 0; i < regions.length; i++) uf[i] = i;
      const find = (a) => { while (uf[a] !== a) { uf[a] = uf[uf[a]]; a = uf[a]; } return a; };
      const bgReg = new Uint8Array(regions.length);
      for (let ri = 0; ri < regions.length; ri++) if (isBg(regions[ri])) bgReg[ri] = 1;
      const cdist = (a, b) => Math.abs(regions[a].color[0] - regions[b].color[0]) +
                             Math.abs(regions[a].color[1] - regions[b].color[1]) +
                             Math.abs(regions[a].color[2] - regions[b].color[2]);
      {
        const cdMax = opts.objMergeCd;
        for (let y = 0; y < H; y++) {
          const row = y * W;
          for (let x = 0; x < W; x++) {
            const p = row + x, c0 = compOf[p];
            if (isInk[c0]) continue;
            const k0 = bgReg[c0];
            if (x + 1 < W) {
              const c1 = compOf[p + 1];
              if (c1 !== c0 && !isInk[c1] && bgReg[c1] === k0 && cdist(c0, c1) <= cdMax) {
                const ra = find(c0), rb = find(c1);
                if (ra !== rb) uf[ra] = rb;
              }
            }
            if (y + 1 < H) {
              const c1 = compOf[p + W];
              if (c1 !== c0 && !isInk[c1] && bgReg[c1] === k0 && cdist(c0, c1) <= cdMax) {
                const ra = find(c0), rb = find(c1);
                if (ra !== rb) uf[ra] = rb;
              }
            }
          }
        }
      }
      // --- 分组 → 层 ---
      const gmap = new Map();
      for (const ri of list) {
        const r = find(ri);
        let g = gmap.get(r);
        if (!g) { g = { regs: [], area: 0, isPaper: bgReg[ri] === 1 }; gmap.set(r, g); }
        g.regs.push(ri);
        g.area += regions[ri].area;
        if (!bgReg[ri]) g.isPaper = false;
      }
      let groups = Array.from(gmap.values());
      // 太小的组（零星几像素的碎屑）并进"挨着它、颜色最近"的那个组，不单独成层
      {
        const MINLAY = 300;
        const bigs = groups.filter((g) => g.isPaper || g.area >= MINLAY);
        const smalls = groups.filter((g) => !g.isPaper && g.area < MINLAY);
        if (smalls.length) {
          const gIdxOf = new Int32Array(regions.length).fill(-1);
          for (let gi = 0; gi < groups.length; gi++) for (const ri of groups[gi].regs) gIdxOf[ri] = gi;
          const glab = new Int32Array(N);
          for (let p = 0; p < N; p++) glab[p] = gIdxOf[compOf[p]];
          const pairs = new Set();
          for (let y = 0; y < H; y++) {
            const row = y * W;
            for (let x = 0; x < W; x++) {
              const p = row + x, a = glab[p];
              if (a < 0) continue;
              if (x + 1 < W) { const b = glab[p + 1]; if (b >= 0 && b !== a) { const lo = Math.min(a, b), hi = Math.max(a, b); pairs.add(lo * 4096 + hi); } }
              if (y + 1 < H) { const b = glab[p + W]; if (b >= 0 && b !== a) { const lo = Math.min(a, b), hi = Math.max(a, b); pairs.add(lo * 4096 + hi); } }
            }
          }
          const nbOf = new Map();
          for (const k of pairs) {
            const a = Math.floor(k / 4096), b = k % 4096;
            if (!nbOf.has(a)) nbOf.set(a, []); if (!nbOf.has(b)) nbOf.set(b, []);
            nbOf.get(a).push(b); nbOf.get(b).push(a);
          }
          const gcol = groups.map((g) => {
            let cr = 0, cg = 0, cb = 0;
            for (const ri of g.regs) { cr += regions[ri].color[0] * regions[ri].area; cg += regions[ri].color[1] * regions[ri].area; cb += regions[ri].color[2] * regions[ri].area; }
            const n = Math.max(1, g.area);
            return [cr / n, cg / n, cb / n];
          });
          const bigSet = new Set(bigs);
          for (const g of smalls) {
            const gi = groups.indexOf(g);
            let best = -1, bd = Infinity;
            for (const gj of (nbOf.get(gi) || [])) {
              const cand = groups[gj];
              if (!bigSet.has(cand)) continue;
              const d = Math.abs(gcol[gi][0] - gcol[gj][0]) + Math.abs(gcol[gi][1] - gcol[gj][1]) + Math.abs(gcol[gi][2] - gcol[gj][2]);
              if (d < bd) { bd = d; best = gj; }
            }
            // 只有"颜色也对得上"才并（否则一片橙色的碎块会被并进蓝底，底色色场就被染花了）；
            // 对不上的碎块自己留一层——小是小，但颜色是对的
            if (best >= 0 && bd <= 90) { groups[best].regs.push(...g.regs); groups[best].area += g.area; }
            else bigs.push(g);
          }
          groups = bigs;
        }
      }
      groups.sort((a, b) => (a.isPaper === b.isPaper ? b.area - a.area : (a.isPaper ? -1 : 1)));
      nObj = groups.length;
      for (let oi = 0; oi < nObj; oi++) objRegions.push(groups[oi].regs);
      for (let oi = 0; oi < nObj; oi++) for (const ri of objRegions[oi]) objOfComp[ri] = oi;
      dbg.groups = groups.length;
      dbg.loose = 0;
      dbg.cores = groups.length;
      dbg.objs = nObj;
      lap('sweep:uf');
      // --- 像素索引图 + 逐层统计 ---
      objLab = new Int32Array(N);
      for (let p = 0; p < N; p++) objLab[p] = objOfComp[compOf[p]];
      const oA = new Float64Array(nObj), oSx = new Float64Array(nObj), oSy = new Float64Array(nObj);
      for (let p = 0; p < N; p++) { const oi = objLab[p], x = p % W; oA[oi]++; oSx[oi] += x; oSy[oi] += (p - x) / W; }
      const oXx = new Float64Array(nObj), oXy = new Float64Array(nObj), oYy = new Float64Array(nObj);
      const oCx = new Float64Array(nObj), oCy = new Float64Array(nObj);
      for (let oi = 0; oi < nObj; oi++) { oCx[oi] = oA[oi] ? oSx[oi] / oA[oi] : 0; oCy[oi] = oA[oi] ? oSy[oi] / oA[oi] : 0; }
      for (let p = 0; p < N; p++) {
        const oi = objLab[p], x = p % W, y = (p - x) / W;
        const dx = x - oCx[oi], dy = y - oCy[oi];
        oXx[oi] += dx * dx; oXy[oi] += dx * dy; oYy[oi] += dy * dy;
      }
      for (let oi = 0; oi < nObj; oi++) objAdj.push(new Set());
      for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
          const p = row + x, a = objLab[p];
          if (x + 1 < W) { const b = objLab[p + 1]; if (b !== a) { objAdj[a].add(b); objAdj[b].add(a); } }
          if (y + 1 < H) { const b = objLab[p + W]; if (b !== a) { objAdj[a].add(b); objAdj[b].add(a); } }
        }
      }
      for (let oi = 0; oi < nObj; oi++) {
        const rl = objRegions[oi];
        let x0 = W, y0 = H, x1 = -1, y1 = -1, cr = 0, cg = 0, cb = 0, isPaper = true;
        for (const ri of rl) {
          const rg = regions[ri];
          if (rg.x0 < x0) x0 = rg.x0; if (rg.y0 < y0) y0 = rg.y0;
          if (rg.x1 > x1) x1 = rg.x1; if (rg.y1 > y1) y1 = rg.y1;
          cr += rg.color[0] * rg.area; cg += rg.color[1] * rg.area; cb += rg.color[2] * rg.area;
          if (!isBg(rg)) isPaper = false;
        }
        if (x1 < 0) { x0 = y0 = 0; x1 = y1 = 0; }
        const n = Math.max(1, oA[oi]);
        const sxx = oXx[oi] / n, sxy = oXy[oi] / n, syy = oYy[oi] / n;
        const tr = sxx + syy, det = sxx * syy - sxy * sxy;
        const l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det));
        const l2 = tr / 2 - Math.sqrt(Math.max(0, tr * tr / 4 - det));
        const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
        let ax = Math.cos(ang), ay = Math.sin(ang);
        // 主轴要落在"更长"的那一侧（否则一档档刷的方向是横着的，档数暴涨）
        if (l1 < l2) { const t = ax; ax = -ay; ay = t; }
        objStat.push({
          oi, area: oA[oi], x0, y0, x1, y1, cx: oCx[oi], cy: oCy[oi], ax, ay,
          l1: Math.sqrt(Math.max(0, l1)), l2: Math.sqrt(Math.max(0, l2)),
          tmin: Infinity, tmax: -Infinity, vmax: 0, hp: 1,
          color: [Math.round(cr / n), Math.round(cg / n), Math.round(cb / n)],
          isPaper, linear: false, from: 0,
        });
      }
      for (let p = 0; p < N; p++) {
        const oi = objLab[p], st = objStat[oi];
        const x = p % W, y = (p - x) / W;
        const t = (x - st.cx) * st.ax + (y - st.cy) * st.ay;
        const v = Math.abs(-(x - st.cx) * st.ay + (y - st.cy) * st.ax);
        if (t < st.tmin) st.tmin = t;
        if (t > st.tmax) st.tmax = t;
        if (v > st.vmax) st.vmax = v;
      }
      for (const st of objStat) {
        if (st.tmin > st.tmax) { st.tmin = st.tmax = 0; }
        st.hp = Math.max(1, st.vmax);
      }
      lap('sweep:stat');
      // 底色层：第一个非纸底的层
      baseObj = -1;
      for (let oi = 0; oi < nObj; oi++) if (!objStat[oi].isPaper && objStat[oi].area >= 200) { baseObj = oi; break; }
      if (baseObj < 0) baseObj = 0;
      dbg.base = baseObj;
      // --- 边界按颜色重判（抗锯齿过渡带）---
      // 目标图的边缘有一圈 1~2px 的混色像素；量化+合并把它们随机分给两侧的对象，
      // 于是"本来是直的边"看起来像被啃过（用户 2026-10-18 反馈的飞机边缘）。
      // 规则：贴着异类的像素，归给"颜色离它更近的那个邻居"——边界就被钉在 50% 混色处，
      // 直边变直、圆边变顺（平涂画法本来也不画毛边，只画两侧的纯色）。
      // 边界带（离异类 ≤2px）的像素清单：下面三个"边界重判"块都只扫这些像素——
      // 整幅扫描一个像素一个像素地查 Map，光这一项就要 7 秒
      const bandList = (() => {
        const band = new Uint8Array(N);
        for (let y = 0; y < H; y++) {
          const row = y * W;
          for (let x = 0; x < W; x++) {
            const p = row + x, a = objLab[p];
            if ((x + 1 < W && objLab[p + 1] !== a) || (y + 1 < H && objLab[p + W] !== a) ||
                (x > 0 && objLab[p - 1] !== a) || (y > 0 && objLab[p - W] !== a)) band[p] = 1;
          }
        }
        const bd = dilate(band, W, H, 2);
        const list = [];
        for (let p = 0; p < N; p++) if (bd[p]) list.push(p);
        return Int32Array.from(list);
      })();
      if (opts.edgeSnap) {
        let maxCid = 0;
        for (let p = 0; p < N; p++) if (compOf[p] > maxCid) maxCid = compOf[p];
        const cR = new Int32Array(maxCid + 1).fill(-1), cG = new Int32Array(maxCid + 1), cB = new Int32Array(maxCid + 1);
        for (const rg of regions) { cR[rg.cid] = rg.color[0]; cG[rg.cid] = rg.color[1]; cB[rg.cid] = rg.color[2]; }
        const colOfC = { get: (cid) => (cid >= 0 && cR[cid] >= 0 ? [cR[cid], cG[cid], cB[cid]] : null) };
        const DX4 = [1, -1, 0, 0], DY4 = [0, 0, 1, -1];
        let snapped = 0;
        // 过渡带可能有 2~3px 宽（扫描件的边缘不锐）：一轮只剥一层，所以走几轮
        for (let it = 0; it < (opts.edgeSnapIter | 0); it++) {
          const chP = [], chO = [];
          for (let bi = 0; bi < bandList.length; bi++) {
            {
              const p = bandList[bi], x = p % W, y = (p - x) / W, a = objLab[p];
              if (objStat[a].isPaper) continue;
              const ca = colOfC.get(compOf[p]);
              if (!ca) continue;
              const da = Math.abs(R[p] - ca[0]) + Math.abs(G[p] - ca[1]) + Math.abs(B[p] - ca[2]);
              // 自己的区色已经贴近原图 ⇒ 这多半是抗锯齿过渡带的混色（本来就该是混色），
              // 硬推成邻居的纯色只会把边推错 1px。只有"区色明显不像原图"才是真错分。
              if (da < opts.edgeSnapBad) continue;
              const cap = opts.edgeSnapRatio > 0 ? da * opts.edgeSnapRatio : Infinity;
              let best = -1, bd = Math.min(da - opts.edgeSnapTol, cap);
              for (let d = 0; d < 4; d++) {
                const xx = x + DX4[d], yy = y + DY4[d];
                if (xx < 0 || xx >= W || yy < 0 || yy >= H) continue;
                const q = yy * W + xx, b = objLab[q];
                if (b === a || objStat[b].isPaper) continue;
                const cb = colOfC.get(compOf[q]);
                if (!cb) continue;
                const d2 = Math.abs(R[p] - cb[0]) + Math.abs(G[p] - cb[1]) + Math.abs(B[p] - cb[2]);
                if (d2 < bd) { bd = d2; best = b; }
              }
              if (best >= 0) { chP.push(p); chO.push(best); }
            }
          }
          if (!chP.length) break;
          for (let i = 0; i < chP.length; i++) objLab[chP[i]] = chO[i];
          snapped += chP.length;
        }
        dbg.edgeSnap = snapped;
      }
      lap('sweep:rejudge');
      // --- 过渡带（抗锯齿斜坡）不能单独成层 ---
      // 目标图的边上有 1~3px 的混色带；量化会把它切成"一条细长的区块"，
      // 于是它自己成了一层、被涂成中间那个灰紫色（飞机边上的灰条就是这么来的）。
      // 判据：在两个不同方向各找一个"别的层"，自己的颜色正好是那两层纯色的混色 ⇒
      // 按"离哪边近"并进去（平涂画法里这条边就是两层颜色的硬交界）。
      if (opts.edgeRamp) {
        const colOfC = new Map();
        for (const rg of regions) colOfC.set(rg.cid, rg.color);
        const DX4 = [1, -1, 0, 0], DY4 = [0, 0, 1, -1];
        const R4 = opts.edgeRampR | 0;
        let rampN = 0;
        for (let it = 0; it < 3; it++) {
          const chP = [], chO = [];
          for (let bi = 0; bi < bandList.length; bi++) {
            {
              const p = bandList[bi], x = p % W, y = (p - x) / W, a = objLab[p];
              if (objStat[a].isPaper) continue;
              const sides = [];     // 四个方向各自最近的"别的层"
              for (let d = 0; d < 4; d++) {
                for (let s = 1; s <= R4; s++) {
                  const xx = x + DX4[d] * s, yy = y + DY4[d] * s;
                  if (xx < 0 || xx >= W || yy < 0 || yy >= H) break;
                  const q = yy * W + xx, b = objLab[q];
                  if (b === a) continue;
                  if (objStat[b].isPaper) break;
                  const cb = colOfC.get(compOf[q]);
                  if (!cb) break;
                  sides.push({ b, cb, d2: Math.abs(R[p] - cb[0]) + Math.abs(G[p] - cb[1]) + Math.abs(B[p] - cb[2]) });
                  break;
                }
              }
              if (sides.length < 2) continue;
              // 挑"两个不同层"里离得最近的一对
              let s1 = -1, s2 = -1, sBest = Infinity;
              for (let i = 0; i < sides.length; i++) {
                for (let j = i + 1; j < sides.length; j++) {
                  if (sides[i].b === sides[j].b) continue;
                  const sum = sides[i].d2 + sides[j].d2;
                  if (sum < sBest) { sBest = sum; s1 = i; s2 = j; }
                }
              }
              if (s1 < 0) continue;
              const A = sides[s1].cb, Bv = sides[s2].cb;
              const vx = Bv[0] - A[0], vy = Bv[1] - A[1], vz = Bv[2] - A[2];
              const vv = vx * vx + vy * vy + vz * vz;
              if (vv < 400) continue;                     // 两层颜色太近：无所谓
              const px2 = R[p] - A[0], py2 = G[p] - A[1], pz2 = B[p] - A[2];
              const t = (px2 * vx + py2 * vy + pz2 * vz) / vv;
              if (t <= 0.15 || t >= 0.85) continue;       // 更靠某一侧 ⇒ 不是混色带
              const dx2 = px2 - t * vx, dy2 = py2 - t * vy, dz2 = pz2 - t * vz;
              if (Math.abs(dx2) + Math.abs(dy2) + Math.abs(dz2) > opts.rampTol) continue;
              chP.push(p);
              chO.push(sides[s1].d2 <= sides[s2].d2 ? sides[s1].b : sides[s2].b);
            }
          }
          if (!chP.length) break;
          for (let i = 0; i < chP.length; i++) objLab[chP[i]] = chO[i];
          rampN += chP.length;
        }
        dbg.edgeRamp = rampN;
      }
      // 扫描件的网点 + 抗锯齿会把直边搅成 2px 上下的锯齿（用户说的"本来是直的却像被啃过"）。
      lap('sweep:ramp');
      // --- 掩膜边界"去锯齿"（多数表决）---
      // 扫描件的网点 + 抗锯齿会把直边搅成 2px 上下的锯齿（用户说的"本来是直的却像被啃过"）。
      // 在 5x5 窗口里数各层占了多少格，只有"压倒性多数"（≥ maskMajThr）才改判：
      // 3px 宽的细杆/笔画在 5x5 里最多占 15 格，达不到压倒多数 ⇒ 不会被吃掉。
      if (opts.maskMajority) {
        const R2 = (opts.maskMajority | 0) >> 1;
        const cnts = new Int32Array(nObj), touched = [];
        for (let it = 0; it < 2; it++) {
          const chP = [], chO = [];
          for (let bi = 0; bi < bandList.length; bi++) {
            {
              const p = bandList[bi], x = p % W, y = (p - x) / W, a = objLab[p];
              if (objStat[a].isPaper) continue;
              touched.length = 0;
              const y0 = Math.max(0, y - R2), y1 = Math.min(H - 1, y + R2);
              const x0 = Math.max(0, x - R2), x1 = Math.min(W - 1, x + R2);
              for (let yy = y0; yy <= y1; yy++) {
                const row = yy * W;
                for (let xx = x0; xx <= x1; xx++) {
                  const b = objLab[row + xx];
                  if (cnts[b]++ === 0) touched.push(b);
                }
              }
              let best = -1, bc = 0;
              for (const b of touched) {
                if (b === a || objStat[b].isPaper) continue;
                if (cnts[b] > bc) { bc = cnts[b]; best = b; }
              }
              const ca2 = cnts[a];
              for (const b of touched) cnts[b] = 0;
              if (best >= 0 && bc >= opts.maskMajThr && bc > ca2) { chP.push(p); chO.push(best); }
            }
          }
          if (!chP.length) break;
          for (let i = 0; i < chP.length; i++) objLab[chP[i]] = chO[i];
          dbg.maskMaj = (dbg.maskMaj || 0) + chP.length;
        }
      }
      lap('sweep:maj');
      // --- 可见部分的掩膜 + 每层的"厚度/细长"判定 ---
      for (let oi = 0; oi < nObj; oi++) {
        const st = objStat[oi];
        const ownM = regionMaskOf(objLab, W, oi, st.x0, st.y0, st.x1, st.y1);
        const own = { x0: st.x0, y0: st.y0, w: ownM.w, h: ownM.h, m: ownM.m };
        objBox.push(own);
        if (st.isPaper || st.area < 160 || oi === baseObj) continue;
        const dt = distanceTransform(own.m, own.w, own.h);
        const vals = [];
        for (let i = 0; i < dt.length; i++) if (own.m[i]) vals.push(dt[i]);
        vals.sort((a, b) => a - b);
        const med = vals.length ? vals[vals.length >> 1] : 0;
        st.thick = med;
        // 细长（黑框、支柱、字的笔画）：这一层"能画几个自己的厚度那么长"。
        // 用中轴厚度而不是外框短边：黑框是个大圈（外框=整幅），但它处处只有十几像素厚。
        const elong = (st.tmax - st.tmin) / Math.max(1, 2 * med);
        st.elong = elong;
        // 两个条件都要满足：够长（能画 9 个自己的厚度）+ 真的薄（绝对厚度有上限，
        // 否则照片里一大片细长的区域也会被判成"线"，几千笔去描它）
        st.linear = elong >= 9 && med * 2 <= Math.max(12, 24 * strokeScale);
      }
      lap('sweep:vis');
      // 非照片图：细长层（字的笔画、描边、黑框）也加一条保护带。
      // 这些层主笔覆盖率通常已 ≥99.5%，残差再补只是追 5~20 的亚可见色差；
      // 只挡小误差，真实缺口（> inkGuardErr）仍然照补。
      var thinGuard = new Uint8Array(N);      // var：残差阶段在层栈代码块之外，还要用它
      if (!opts.photoMode && opts.inkGuard > 0) {
        for (let oi = 0; oi < nObj; oi++) {
          const st = objStat[oi];
          if (!st.linear || st.isPaper) continue;
          const own = objBox[oi];
          for (let y = 0; y < own.h; y++) {
            const src = y * own.w, dst = (y + own.y0) * W + own.x0;
            for (let x = 0; x < own.w; x++) if (own.m[src + x]) thinGuard[dst + x] = 1;
          }
        }
      }
      // --- 完整形状：底色层 = 整幅（除了纸底）；其它层 = 自己可见的部分 ∪ 被上层盖住的部分 ---
      // "被上层盖住的部分"用形状闭合推断：把本层形状按"贴着它的上层有多厚"闭一下，
      // 闭出来的区域里属于上层的像素就是"本来也是这一层、只是被盖住了"。
      // 判据只认"上层"，所以飞机两翼之间那片天（下层）不会被补进飞机里。
      const paperPix = new Uint8Array(N);
      for (let p = 0; p < N; p++) if (objStat[objLab[p]].isPaper) paperPix[p] = 1;
      for (let oi = 0; oi < nObj; oi++) {
        const st = objStat[oi];
        const own = objBox[oi];
        if (oi === baseObj) {
          const m = new Uint8Array(N);
          for (let p = 0; p < N; p++) if (!paperPix[p]) m[p] = 1;
          objFull.push({ x0: 0, y0: 0, w: W, h: H, m });
          continue;
        }
        if (st.isPaper || !opts.occlude) { objFull.push(own); continue; }  // own 现在带 x0/y0
        let r = 0;
        for (const ob of objAdj[oi]) if (ob > oi && !objStat[ob].isPaper) r = Math.max(r, objStat[ob].hp * 2);
        // 外扩量 = 贴着它的上层有多厚 × 系数（objGrowF）。补出来的"完整形状"只要盖到
        // 上层的一半就够，再往外就是上层自己的地盘 —— 系数偏大时，字/飞机那些凸出的
        // 部位会伸出一圈圆头小凸起（回放画到那一层时看得见）。
        r = clamp(Math.round(r * opts.objGrowF), 3, 26);
        if (r <= 3) { objFull.push(own); continue; }
        const bx0 = Math.max(0, st.x0 - r), by0 = Math.max(0, st.y0 - r);
        const bx1 = Math.min(W - 1, st.x1 + r), by1 = Math.min(H - 1, st.y1 + r);
        const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
        const sub = new Uint8Array(bw * bh), above = new Uint8Array(bw * bh);
        let any = false;
        for (let y = 0; y < bh; y++) {
          const row = (y + by0) * W;
          for (let x = 0; x < bw; x++) {
            const o = objLab[row + bx0 + x];
            if (o === oi) sub[y * bw + x] = 1;
            else if (o > oi && !objStat[o].isPaper) { above[y * bw + x] = 1; any = true; }
          }
        }
        if (!any) { objFull.push(own); continue; }
        const cl = closeMaskDisk(sub, bw, bh, r);
        const m = new Uint8Array(bw * bh);
        let added = 0;
        for (let i = 0; i < m.length; i++) {
          if (sub[i]) m[i] = 1;
          else if (cl[i] && above[i]) { m[i] = 1; added++; }
        }
        if (!added) { objFull.push(own); continue; }
        st.grown = added;
        objFull.push({ x0: bx0, y0: by0, w: bw, h: bh, m });
      }
      lap('sweep:full');
      // --- 底色层的"背景色场"：被字/飞机盖住的地方看不见，按周围推出来 ---
      // 已知像素 = 底色层自己（往里缩 2px 避开边界混色），颜色取平滑图；未知像素按"最近的
      // 已知像素"向里灌（chamfer 两趟），再平滑几遍 —— 整幅任何位置都能取到底色。
      if (baseObj >= 0 && objBox[baseObj]) {
        const bm = objBox[baseObj];
        const bin = new Uint8Array(N);
        for (let y = 0; y < bm.h; y++) {
          const row = (y + objStat[baseObj].y0) * W;
          for (let x = 0; x < bm.w; x++) if (bm.m[y * bm.w + x]) bin[row + objStat[baseObj].x0 + x] = 1;
        }
        const core = erode(bin, W, H, 3);
        lap('bg:core');
        const smoothish = (p2) => {   // 平滑图在这里可不可信（跟区块纯色对得上 = 没被隔壁糊过来）
          const rc2 = regions[compOf[p2]].color;
          return Math.abs(rc2[0] - Rs[p2]) + Math.abs(rc2[1] - Gs[p2]) + Math.abs(rc2[2] - Bs[p2]) <= 36;
        };
        const cr = new Float32Array(N), cg = new Float32Array(N), cb = new Float32Array(N);
        const known = new Uint8Array(N);
        let nKnown = 0;
        if (opts.photoMode) {
          // 照片：底色层就是"整幅的底色"——用平滑图（明暗关系保住），别用"最近的底色像素"往外灌
          // （灌出来的色场在远处的暗部会整片错，实测差 15 个点，而残差补笔又嫌那些块"又大又厚"不补）
          for (let p = 0; p < N; p++) {
            const rc = regions[compOf[p]].color;
            if (Math.abs(rc[0] - Rs[p]) + Math.abs(rc[1] - Gs[p]) + Math.abs(rc[2] - Bs[p]) <= 36) {
              cr[p] = Rs[p]; cg[p] = Gs[p]; cb[p] = Bs[p];
            } else { cr[p] = rc[0]; cg[p] = rc[1]; cb[p] = rc[2]; }
          }
          bgMap = { R: cr, G: cg, B: cb };
          dbg.bgFill = 0;
          if (opts.dumpMasks) {
            const bm2 = new Uint8Array(N * 3);
            for (let pp = 0; pp < N; pp++) { bm2[pp*3] = cr[pp]; bm2[pp*3+1] = cg[pp]; bm2[pp*3+2] = cb[pp]; }
            dbg.bgMapImg = bm2;
          }
        } else {
        for (let p = 0; p < N; p++) {
          if (!core[p] || inkPix[p] || texPix[p]) continue;   // 细线/纹理像素被吸收进底色，但不是底色的颜色
          // 颜色取"平滑图"，但只在这个像素的平滑色跟它所属区块的纯色对得上时——
          // 对不上说明平滑把隔壁（字/飞机）的颜色糊过来了，这时用区块自己的纯色（干净）
          const rc = regions[compOf[p]].color;
          if (Math.abs(rc[0] - Rs[p]) + Math.abs(rc[1] - Gs[p]) + Math.abs(rc[2] - Bs[p]) <= 36) {
            cr[p] = Rs[p]; cg[p] = Gs[p]; cb[p] = Bs[p];
          } else {
            cr[p] = rc[0]; cg[p] = rc[1]; cb[p] = rc[2];
          }
          known[p] = 1; nKnown++;
        }
        lap('bg:known');
        const INF = 1e9;
        const dist = new Float32Array(N);
        for (let p = 0; p < N; p++) dist[p] = known[p] ? 0 : INF;
        const prop = (p, q, w2) => {
          const d = dist[q] + w2;
          if (d < dist[p]) { dist[p] = d; cr[p] = cr[q]; cg[p] = cg[q]; cb[p] = cb[q]; }
        };
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const p = y * W + x;
            if (dist[p] === 0) continue;
            if (x > 0) prop(p, p - 1, 3);
            if (y > 0) prop(p, p - W, 3);
            if (x > 0 && y > 0) prop(p, p - W - 1, 4);
            if (x + 1 < W && y > 0) prop(p, p - W + 1, 4);
          }
        }
        for (let y = H - 1; y >= 0; y--) {
          for (let x = W - 1; x >= 0; x--) {
            const p = y * W + x;
            if (dist[p] === 0) continue;
            if (x + 1 < W) prop(p, p + 1, 3);
            if (y + 1 < H) prop(p, p + W, 3);
            if (x + 1 < W && y + 1 < H) prop(p, p + W + 1, 4);
            if (x > 0 && y + 1 < H) prop(p, p + W - 1, 4);
          }
        }
        lap('bg:chamfer');
        // 平滑 4 遍（3×3 盒式模糊）：灌出来的硬边、区块之间的色阶差都抹平。
        // 提速两处，都不改结果：
        // ① 内点（1..H-2 行 × 1..W-2 列）九邻域齐全 ⇒ 去掉全部边界判断和 yy*W 乘法，
        //    计数恒为 9；边界像素只有 O(W+H) 个，照旧走通用写法。
        // ② 双缓冲，省掉每遍 new 三个 4MB 数组 + cr.set(nr) 的两趟拷贝。
        // 为什么"展开"不改结果：输入是 float32（24 位尾数），9 个数相加最多 28 位
        // < float64 的 53 位 ⇒ 求和本来就是精确的、与加法顺序无关。
        let curR = cr, curG = cg, curB = cb;
        let nxtR = new Float32Array(N), nxtG = new Float32Array(N), nxtB = new Float32Array(N);
        const blurGeneric = (x, y) => {
          const p = y * W + x;
          let sr = 0, sg = 0, sb = 0, cnt = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy; if (yy < 0 || yy >= H) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx; if (xx < 0 || xx >= W) continue;
              const q = yy * W + xx;
              sr += curR[q]; sg += curG[q]; sb += curB[q]; cnt++;
            }
          }
          nxtR[p] = sr / cnt; nxtG[p] = sg / cnt; nxtB[p] = sb / cnt;
        };
        for (let it = 0; it < 4; it++) {
          if (W >= 3 && H >= 3) {
            for (let y = 1; y < H - 1; y++) {
              const yc = y * W;
              for (let x = 1; x < W - 1; x++) {
                const p = yc + x;
                let sr = 0, sg = 0, sb = 0;
                for (let dy = -1; dy <= 1; dy++) {
                  const row = yc + dy * W;
                  for (let dx = -1; dx <= 1; dx++) {
                    const q = row + x + dx;
                    sr += curR[q]; sg += curG[q]; sb += curB[q];
                  }
                }
                nxtR[p] = sr / 9; nxtG[p] = sg / 9; nxtB[p] = sb / 9;
              }
            }
            for (let x = 0; x < W; x++) { blurGeneric(x, 0); blurGeneric(x, H - 1); }
            for (let y = 1; y < H - 1; y++) { blurGeneric(0, y); blurGeneric(W - 1, y); }
          } else {
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) blurGeneric(x, y);
          }
          { const t = curR; curR = nxtR; nxtR = t; }
          { const t = curG; curG = nxtG; nxtG = t; }
          { const t = curB; curB = nxtB; nxtB = t; }
        }
        if (curR !== cr) { cr.set(curR); cg.set(curG); cb.set(curB); }
        lap('bg:blur');
        bgMap = { R: cr, G: cg, B: cb };
        dbg.bgFill = nKnown;
        }
        if (opts.probePts) {
          dbg.probeInfo = opts.probePts.map(([x, y]) => {
            const p0 = y * W + x, ci = compOf[p0];
            return { x, y, compOf: ci, regColor: regions[ci] ? regions[ci].color : null,
              obj: objOfComp[ci], isBase: objOfComp[ci] === baseObj,
              inBaseMask: bin[p0] ? 1 : 0, inCore: core[p0] ? 1 : 0, ink: inkPix[p0] ? 1 : 0, tex: texPix[p0] ? 1 : 0,
              Rs: [Rs[p0], Gs[p0], Bs[p0]], known: known[p0] ? 1 : 0, bg: [Math.round(cr[p0]), Math.round(cg[p0]), Math.round(cb[p0])] };
          });
        }
        if (opts.dumpMasks) {
          const bm2 = new Uint8Array(N * 3);
          for (let pp = 0; pp < N; pp++) { bm2[pp*3] = cr[pp]; bm2[pp*3+1] = cg[pp]; bm2[pp*3+2] = cb[pp]; }
          dbg.bgMapImg = bm2;
        }
      }
      lap('sweep:obj');
      // ---- 细线组划分 + 归属（"两拨画法"的分派表）----
      // 算一次连通域，按"行"排好（文字和轮廓都是成行成列的），再看每组贴着谁：
      // 贴着"某个对象"的 ⇒ 跟那个对象一起画（猫嘴跟着猫脸，字的描边走完字就画上）；
      // 只贴着底色/纸底的（题字、落款、印在底上的小字）⇒ 留到最后写。
      {
        const icc = compsOfLabels(inkBin, W, H);
        const groups = [];
        for (let ci = 0; ci < icc.comps.length; ci++) {
          if (icc.comps[ci].label === 1 && icc.comps[ci].count >= 6) groups.push(ci);
        }
        groups.sort((a, b) => icc.comps[b].count - icc.comps[a].count);
        const items = groups.slice(0, 3000).map((ci) => ({
          ci,
          cx: (icc.comps[ci].x0 + icc.comps[ci].x1) / 2,
          cy: (icc.comps[ci].y0 + icc.comps[ci].y1) / 2,
          h: icc.comps[ci].y1 - icc.comps[ci].y0 + 1,
        }));
        items.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
        const rows = [];
        for (const it of items) {
          const cur = rows[rows.length - 1];
          if (!cur || it.cy - cur.cy > Math.max(9 * strokeScale, cur.h * 0.8)) {
            rows.push({ cy: it.cy, h: it.h, items: [it] });
          } else {
            cur.items.push(it);
            if (it.h > cur.h) cur.h = it.h;
          }
        }
        const gSeq = [];
        for (const r of rows) {
          r.items.sort((a, b) => a.cx - b.cx);        // 一行内从左到右
          for (const it of r.items) gSeq.push(it.ci);
        }
        // "背景侧"对象：纸底和底色层——只贴着它们的细线留到最后写
        const skipObjs = new Set();
        for (let oi = 0; oi < nObj; oi++) if (objStat[oi].isPaper) skipObjs.add(oi);
        if (baseObj >= 0) skipObjs.add(baseObj);
        let nToObj = 0, nLast = 0;
        for (const ci of gSeq) {
          const bw = bboxOfComp(icc, ci, 3);
          const m = dilate(bw.m, bw.w, bw.h, 3);
          const cnt = new Map();
          for (let y = 0; y < bw.h; y++) {
            const row = (y + bw.y) * W + bw.x;
            for (let x = 0; x < bw.w; x++) {
              if (!m[y * bw.w + x]) continue;
              const o = objOfComp[compOf[row + x]];
              cnt.set(o, (cnt.get(o) || 0) + 1);
            }
          }
          let bestO = -1, bestC = 0;
          for (const [o, c] of cnt) {
            if (skipObjs.has(o)) continue;
            if (c > bestC) { bestC = c; bestO = o; }
          }
          if (bestO >= 0 && bestC >= 8) {
            if (!inkOfObj.has(bestO)) inkOfObj.set(bestO, []);
            inkOfObj.get(bestO).push(ci);
            nToObj++;
          } else {
            inkLastSeq.push(ci);
            nLast++;
          }
        }
        inkIcc = icc;
        dbg.inkToObj = nToObj;
        dbg.inkLast = nLast;
      }
      const bleedRad = Math.max(1, Math.round(opts.bleedR * strokeScale));
      // 一个对象画完，立刻把它身上的细线补上（猫嘴/描边不拖到最后，最后只留题字）
      let curInkObj = -1;
      const drawInkOfObj = (oi) => {
        const l = inkOfObj.get(oi);
        if (l) drawInkSeq(l, null, 1);      // ph=1：算"铺色阶段"的笔（跟着对象走）
      };

      // 一层"完整形状"沿某个方向的真实范围（一档档刷要按它来，刷不到就是白边）
      const layerSpan = (full, ax, ay, cx, cy) => {
        let tmin = Infinity, tmax = -Infinity, vmax = 0;
        for (let y = 0; y < full.h; y++) {
          for (let x = 0; x < full.w; x++) {
            if (!full.m[y * full.w + x]) continue;
            const gx = x + full.x0, gy = y + full.y0;
            const t = (gx - cx) * ax + (gy - cy) * ay;
            const v = Math.abs(-(gx - cx) * ay + (gy - cy) * ax);
            if (t < tmin) tmin = t;
            if (t > tmax) tmax = t;
            if (v > vmax) vmax = v;
          }
        }
        if (tmin > tmax) { tmin = tmax = 0; }
        return { tmin, tmax, vmax };
      };

      // ---- 细长的一层：中轴 + 跟着形状的宽度（直线一笔到底，不切段、不手抖）----
      const paintAsLines = (oi, full, sampleM) => {
        const st = objStat[oi];
        const cIdx = pushClip(full.x0, full.y0, full.w, full.h, full.m);
        const halfMin = 1.3 * strokeScale, halfMax = 16 * strokeScale;
        const queue = [{ m: full.m.slice(), x: 0, y: 0, w: full.w, h: full.h }];
        let guard = 0;
        while (queue.length && guard++ < 400) {
          const it = queue.shift();
          if (it.w >= 2 && it.h >= 2) {
            const dt = distanceTransform(it.m, it.w, it.h);
            globalThis.__thinTag = 'line' + (it.w >= full.w ? 'full' : 'sub');
            const { sk } = thin(it.m, it.w, it.h);
            tick('thin');
            const lp = longestPath(sk, it.w, it.h);
            if (lp && lp.len >= 2) {
              const abs = new Float64Array(lp.len * 2);
              for (let i = 0; i < lp.len; i++) {
                abs[i * 2] = lp.pts[i * 2] + it.x + full.x0;
                abs[i * 2 + 1] = lp.pts[i * 2 + 1] + it.y + full.y0;
              }
              // 直线段拉直：中轴是一像素一像素拐出来的，不简化就是坑坑洼洼
              const sp = rdpSimplify(abs, lp.len, opts.lineTol);
              const halfAt = (x, y) => {
                const lx = Math.round(x - full.x0 - it.x), ly = Math.round(y - full.y0 - it.y);
                let d = 0;
                if (lx >= 0 && lx < it.w && ly >= 0 && ly < it.h) d = dt[ly * it.w + lx];
                return clamp(d + 0.8 * strokeScale, halfMin, halfMax);
              };
              // 每点半宽（拉直后的顶点上取厚度）
              const halfs = new Float64Array(sp.n);
              for (let i = 0; i < sp.n; i++) halfs[i] = halfAt(sp.pts[i * 2], sp.pts[i * 2 + 1]);
              // 落笔前先算"这支笔盖到哪"：中轴被拉直之后，笔形会切掉形状上的凸起/拐角，
              // 那些没盖到的像素以前是留给"每层自检"用方框补丁补的——边缘就成了坑坑洼洼
              // （用户 2026-10-18 反馈的"本来是直的却像被啃过"）。
              // 这里改成**就地加宽**：把离缺口最近的那个顶点加宽到能盖住它（不新增笔画）。
              if (opts.lineSeal && sp.n >= 2) {
                for (let sit = 0; sit < (opts.sealIter | 0); sit++) {
                  const r0 = ribbonProf(sp.pts, sp.n, halfs);
                  const loc0 = new Float64Array(r0.length);
                  for (let i = 0; i < r0.length; i += 2) { loc0[i] = r0[i] - full.x0 - it.x; loc0[i + 1] = r0[i + 1] - full.y0 - it.y; }
                  const cov0 = new Uint8Array(it.w * it.h);
                  fillPoly(cov0, it.w, it.h, loc0);
                  const gaps = [];
                  for (let i = 0; i < it.m.length; i++) if (it.m[i] && !cov0[i]) gaps.push(i);
                  if (!gaps.length) break;
                  let nW = 0;
                  for (const gi of gaps) {
                    const gx = (gi % it.w) + full.x0 + it.x, gy = ((gi / it.w) | 0) + full.y0 + it.y;
                    let bi = 0, bd = Infinity;
                    for (let i = 0; i < sp.n; i++) {
                      const dx = sp.pts[i * 2] - gx, dy = sp.pts[i * 2 + 1] - gy;
                      const d = dx * dx + dy * dy;
                      if (d < bd) { bd = d; bi = i; }
                    }
                    const need = Math.sqrt(bd) + 0.9 * strokeScale;
                    if (need > halfs[bi]) { halfs[bi] = need; nW++; }
                  }
                  if (!nW) break;
                }
              }
              const halfAt2 = (x, y) => {
                let bi = 0, bd = Infinity;
                for (let i = 0; i < sp.n; i++) {
                  const dx = sp.pts[i * 2] - x, dy = sp.pts[i * 2 + 1] - y;
                  const d = dx * dx + dy * dy;
                  if (d < bd) { bd = d; bi = i; }
                }
                return Math.max(halfAt(x, y), halfs[bi]);
              };
              for (const p2 of localPartsProf(sp.pts, sp.n, halfAt2, sampleM, cIdx, oi, st.color, 1, 1, halfAt)) {
                emitStroke(p2.rib, p2.rib.length / 2, p2.path, p2.path.length / 2,
                           Math.max(halfMin, st.thick || 2), p2.col, p2.pen, cIdx, oi, 1);
              }
              // 扣掉已经盖住的部分，剩下的连通块继续排队
              const r = ribbonProf(sp.pts, sp.n, halfs);
              const loc = new Float64Array(r.length);
              for (let i = 0; i < r.length; i += 2) { loc[i] = r[i] - full.x0 - it.x; loc[i + 1] = r[i + 1] - full.y0 - it.y; }
              const cov = new Uint8Array(it.w * it.h);
              fillPoly(cov, it.w, it.h, loc);
              let nMask = 0, nCov = 0, nAfter = 0;
              for (let i = 0; i < it.m.length; i++) { if (it.m[i]) { nMask++; if (cov[i]) nCov++; } }
              for (let i = 0; i < it.m.length; i++) if (it.m[i] && cov[i]) it.m[i] = 0;
              for (let i = 0; i < it.m.length; i++) if (it.m[i]) nAfter++;
              if (opts.debug) (dbg.lineInfo || (dbg.lineInfo = [])).push({
                oi, w: it.w, h: it.h, mask: nMask, cov: nCov, left: nAfter, pts: sp.n, raw: lp.len });
            }
          }
          // 剩下的连通块：各自的外框里继续排队（不整块重跑——细长层的外框可能是整幅）
          const rc = compsOfLabels(it.m, it.w, it.h);
          for (let j = 0; j < rc.comps.length; j++) {
            const c = rc.comps[j];
            if (c.label !== 1 || c.count < 6) continue;
            const mw = c.x1 - c.x0 + 1, mh = c.y1 - c.y0 + 1;
            const nm = new Uint8Array(mw * mh);
            for (let k = 0; k < c.count; k++) {
              const p3 = rc.pix[c.start + k], x = p3 % it.w, y = (p3 - x) / it.w;
              nm[(y - c.y0) * mw + (x - c.x0)] = 1;
            }
            queue.push({ m: nm, x: it.x + c.x0, y: it.y + c.y0, w: mw, h: mh });
          }
        }
      };

      // ---- 一层一整片刷（原来的毛笔刷：沿主轴一档档来回涂）----
      const paintSweep = (oi, full, sampleM) => {
        const st = objStat[oi];
        const isBase = oi === baseObj;
        const ax = isBase ? (W >= H ? 1 : 0) : st.ax;
        const ay = isBase ? (W >= H ? 0 : 1) : st.ay;
        const rcx = isBase ? W * 0.5 : st.cx, rcy = isBase ? H * 0.5 : st.cy;
        const span = layerSpan(full, ax, ay, rcx, rcy);
        const rtmin = span.tmin, rtmax = span.tmax;
        const vHalf = Math.max(1, span.vmax);
        const cIdx = pushClip(full.x0, full.y0, full.w, full.h, full.m);
        // 一小部分笔允许"画出界"：像人一样压到轮廓外面，后面被别的颜色覆盖回来
        const allowBleed = opts.bleedP > 0 && st.area >= 1200 && !isBase && bleedOK[oi];
        const cBleed = allowBleed
          ? pushClip(full.x0, full.y0, full.w, full.h, dilate(full.m, full.w, full.h, bleedRad))
          : cIdx;
        const ext0 = vHalf * 2;
        let bwid = clamp(ext0 * opts.bwF, opts.bwMin * strokeScale, opts.bwMax * strokeScale);
        // 照片里的小纹理块：笔再宽也只是把块内明暗平均掉。宽到"整块厚度"就够盖住，
        // 多出来的部分换成更多档（笔数略增，爪垫高光/毛发层次能留下来）。
        if (opts.photoMode && opts.bwThickCap > 0 && !isBase && st.thick > 0 && st.area < opts.bwThickArea) {
          bwid = Math.min(bwid, Math.max(opts.bwMin * strokeScale, st.thick * opts.bwThickCap));
        }
        // 窄的一层不抖：宽度本来就窄，抖一点边就花了（黑框/细条带就是这么变坑洼的）
        const thinF = clamp(vHalf / 22, 0.25, 1);
        const wobA = (opts.organic ? Math.min(2.8, bwid * 0.13) : Math.min(2.6, bwid * 0.1)) * thinF;
        const bowA = (opts.organic ? Math.min(2.4, bwid * 0.11) : 0) * thinF;
        const dev = wobA + bowA;
        const ext = ext0 + 2 * dev;
        let nP = Math.max(1, Math.ceil(ext / (bwid * opts.coverOv)));
        if (nP > 24) { nP = 24; bwid = Math.max(bwid, ext / (nP * opts.coverOv)); }
        sweepRegions++; passTotal += nP; if (nP > passMax) passMax = nP;
        const px2 = -ay, py2 = ax;
        const wobPh = rand01(oi * 7919 + 13, 1) * 6.283;
        const wobW = 2.2 + 2.6 * rand01(oi * 7919 + 41, 9);
        const bowDir = rand01(oi * 7919 + 29, 3) > 0.5 ? 1 : -1;
        const tPen = (lastPen.x - rcx) * ax + (lastPen.y - rcy) * ay;
        const fromPlus = tPen > 0;
        const rRep = objRegions[oi].length ? objRegions[oi][0] : -1;
        const phL = isBase ? 0 : 1;        // 底色层 = "铺底色"这一步，其余层 = "铺色"
        const run = { parts: [], col: null, cIdx: -1, ex: 0, ey: 0 };
        const flushRun = () => {
          const ps = run.parts;
          if (!ps.length) return;
          if (ps.length === 1) {
            const p = ps[0];
            emitStroke(p.rib, p.rib.length / 2, p.path, p.path.length / 2, p.halfW, p.col, p.pen, p.cIdx, rRep, p.ph);
          } else {
            const rib = mergeLoops(ps.map((p) => p.rib));
            let tot = 0;
            for (const p of ps) tot += p.path.length;
            const arr = new Float64Array(tot);
            let o = 0;
            for (const p of ps) { arr.set(p.path, o); o += p.path.length; }
            // 并成一笔之后只有一个颜色：取各段的"按长度加权均值"，不能拿第一段的颜色——
            // 一条长笔跨过渐变时，末端会整段刷成起点色（插画粉色圆里那块方块状鬼影就是这么来的）
            let cr2 = 0, cg2 = 0, cb2 = 0, cw2 = 0;
            for (const p of ps) {
              const w2 = p.path.length;
              cr2 += p.col[0] * w2; cg2 += p.col[1] * w2; cb2 += p.col[2] * w2; cw2 += w2;
            }
            const col2 = cw2 ? [Math.round(cr2 / cw2), Math.round(cg2 / cw2), Math.round(cb2 / cw2)] : ps[0].col;
            emitStroke(rib, rib.length / 2, arr, arr.length / 2, ps[0].halfW, col2, ps[0].pen, ps[0].cIdx, rRep, ps[0].ph);
          }
          run.parts = []; run.col = null; run.cIdx = -1; run.ex = 0; run.ey = 0;
        };
        const pushPart = (p, halfW) => {
          p.halfW = halfW;
          if (!opts.joinPass) { run.parts.push(p); flushRun(); return; }
          if (run.parts.length) {
            const cd = Math.abs(p.col[0] - run.col[0]) + Math.abs(p.col[1] - run.col[1]) + Math.abs(p.col[2] - run.col[2]);
            // 只能并"接得上"的段：跨档并笔时路径会在两档之间跳过去，
            // 笔形跟着自交、绕数归零，画出来就是个破洞（回放里那些白斑就是它）
            const gap = Math.hypot(p.path[0] - run.ex, p.path[1] - run.ey);
            // 并笔的色差门槛跟"分段并笔"用同一个值（底色层是 6）：用默认的 18 太松，
            // 一条长笔能跨 18 个色阶的渐变，末端就整段刷成起点色（鬼影的另一个来源）
            if (run.cIdx !== p.cIdx || cd >= (joinCdOverride || opts.joinCd) || gap > opts.joinGap) flushRun();
          }
          if (!run.parts.length) { run.col = p.col; run.cIdx = p.cIdx; }
          run.parts.push(p);
          run.ex = p.path[p.path.length - 2];
          run.ey = p.path[p.path.length - 1];
        };
        // 1) 先把这一层所有"档"的几何排好（路径 + 笔宽），先不落笔——
        //    这样才有机会在落笔前把"档与档之间的缝"算出来（见下面的联合覆盖自检）
        const passes = [];
        for (let k = 0; k < nP; k++) {
          const pi = fromPlus ? (nP - 1 - k) : k;
          const dir = ((k % 2 === 0) !== fromPlus) ? 1 : -1;
          const seed = oi * 7919 + pi * 104729 + k * 15485863;
          const v = -vHalf - dev + (pi + 0.5) * (ext / nP);
          const bwidP = opts.organic ? bwid * (0.9 + 0.2 * rand01(seed, 11)) : bwid;
          const wobPhP = wobPh + (rand01(seed, 1) - 0.5) * 0.7;
          const bowP = opts.organic ? bowA * bowDir * (0.7 + 0.6 * rand01(seed, 3)) : 0;
          const e0 = opts.organic ? (rand01(seed, 5) - 0.35) * 5 : 3;
          const e1 = opts.organic ? (rand01(seed, 7) - 0.35) * 5 : 3;
          const tA = dir > 0 ? rtmin - 2 - e0 : rtmax + 2 + e1;
          const tB = dir > 0 ? rtmax + 2 + e1 : rtmin - 2 - e0;
          const nseg = opts.organic ? 6 : 5;
          const path = new Float64Array(nseg * 2);
          const halfs = new Float64Array(nseg);
          for (let s = 0; s < nseg; s++) {
            const f = nseg > 1 ? s / (nseg - 1) : 0;
            const tt = tA + (tB - tA) * f;
            const off = v + wobA * Math.sin(wobPhP + f * wobW) + bowP * Math.sin(Math.PI * f);
            path[s * 2] = rcx + ax * tt + px2 * off;
            path[s * 2 + 1] = rcy + ay * tt + py2 * off;
            halfs[s] = (bwidP / 2) * (opts.taperLo + opts.taperAmp * Math.sin(Math.PI * f)
                                      + opts.taperWob * Math.sin(wobPhP + f * 3.1));
          }
          const useClip = (opts.bleedP > 0 && rand01(seed, 13) < opts.bleedP) ? cBleed : cIdx;
          passes.push({ path, halfs, n: nseg, half: bwidP / 2, useClip });
        }
        // 2) 铺色"一次过"：把这一层所有档的笔形按网页端口径（覆盖率 ≥ coverMin 才算画上）
        //    合起来光栅化一遍，掩膜里没盖到的像素**就地加宽离它最近的那一档**（不新增笔画）。
        //    白缝在铺的时候就补平，不用等每层自检事后补——用户看到的"铺色中间有空洞、
        //    最右边没铺到、后来又回来补一次"就是这么来的。
        let sealed = false;
        if (opts.sweepSeal && full.w * full.h >= opts.sealMin) {
          const cov = new Uint8Array(full.w * full.h);
          const raster = (ps) => {
            const rib = ribbon(ps.path, ps.n, ps.half);
            let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
            for (let i = 0; i < rib.length; i += 2) {
              const x = rib[i], y = rib[i + 1];
              if (x < xmin) xmin = x; if (x > xmax) xmax = x;
              if (y < ymin) ymin = y; if (y > ymax) ymax = y;
            }
            const bx = Math.max(full.x0, Math.floor(xmin)), by = Math.max(full.y0, Math.floor(ymin));
            const ex = Math.min(full.x0 + full.w - 1, Math.ceil(xmax)), ey = Math.min(full.y0 + full.h - 1, Math.ceil(ymax));
            if (ex < bx || ey < by) return;
            const w2 = ex - bx + 1, h2 = ey - by + 1;
            const cv = new Float32Array(w2 * h2);
            const p2 = new Float64Array(rib.length);
            for (let i = 0; i < rib.length; i += 2) { p2[i] = rib[i] - bx; p2[i + 1] = rib[i + 1] - by; }
            fillPolyCov(cv, w2, h2, p2, opts.coverSubY || 1);
            const cl = clips[ps.useClip];
            for (let y = 0; y < h2; y++) {
              const gy = by + y;
              if (gy < cl.y || gy >= cl.y + cl.h || gy < full.y0 || gy >= full.y0 + full.h) continue;
              const rowC = (gy - cl.y) * cl.w, rowF = (gy - full.y0) * full.w;
              for (let x = 0; x < w2; x++) {
                if (cv[y * w2 + x] < opts.coverMin) continue;
                const gx = bx + x;
                if (gx < cl.x || gx >= cl.x + cl.w) continue;
                if (!cl.mask[rowC + (gx - cl.x)]) continue;
                cov[rowF + (gx - full.x0)] = 1;
              }
            }
          };
          for (const ps of passes) raster(ps);
          let left = 0;
          for (let it = 0; it < (opts.sealIter | 0); it++) {
            const gaps = [];
            for (let y = 0; y < full.h; y++) {
              const rowF = y * full.w;
              for (let x = 0; x < full.w; x++) if (full.m[rowF + x] && !cov[rowF + x]) gaps.push(full.x0 + x, full.y0 + y);
            }
            left = gaps.length >> 1;
            if (opts.debug) { const S2 = dbg.seal || (dbg.seal = { layer: 0, gap: 0, left: 0 }); if (it === 0) S2.gap += left; S2.left += 0; S2.last = left; }
            if (!left) break;
            const dirty = new Set();
            for (let gi = 0; gi < gaps.length; gi += 2) {
              const gx = gaps[gi], gy = gaps[gi + 1];
              let best = -1, bd = Infinity, bi = 0, bpx = 0, bpy = 0;
              for (let pi = 0; pi < passes.length; pi++) {
                const ps = passes[pi];
                for (let i = 0; i < ps.n; i++) {
                  const dx = ps.path[i * 2] - gx, dy = ps.path[i * 2 + 1] - gy;
                  const d = dx * dx + dy * dy;
                  if (d < bd) { bd = d; best = pi; bi = i; bpx = ps.path[i * 2]; bpy = ps.path[i * 2 + 1]; }
                }
              }
              if (best < 0) continue;
              const ps = passes[best];
              const need = Math.hypot(bpx - gx, bpy - gy) + 0.9 * strokeScale;
              if (need > ps.half) { ps.half = need; dirty.add(best); }
            }
            if (!dirty.size) break;
            for (const pi of dirty) raster(passes[pi]);
          }
          sealed = !left;
          dbg.seal = dbg.seal || { layer: 0, gap: 0, left: 0 };
          dbg.seal.layer++;
        }
        // 3) 落笔（颜色照旧：按段取局部色，相邻同色段并成一笔）
        const segSave = segLenOverride;
        if (opts.photoMode && st.area < opts.bwThickArea && st.thick > 0) {
          // 小区域按"厚度"取短段：爪垫 3.7px 厚 → 9px 一段，块内的高光/阴影才能各取各的色
          segLenOverride = Math.max(8, st.thick * opts.segSmallF);
        }
        for (const ps of passes) {
          if (opts.localColor) {
            for (const p of localParts(ps.path, ps.n, ps.half, sampleM.m, sampleM.x, sampleM.y, sampleM.w, sampleM.h,
                                       0, ps.useClip, oi, st.color, phL)) {
              pushPart(p, ps.half);
            }
          } else {
            const rib = ribbon(ps.path, ps.n, ps.half);
            pushPart({ rib, path: ps.path, col: st.color, pen: 0, cIdx: ps.useClip, rIdx: oi, ph: phL }, ps.half);
          }
        }
        segLenOverride = segSave;
        flushRun();
        return sealed;
      };

      // ---- 每层当场自检：这一层自己有没有没刷到的地方（不只底色层）----
      // 把这一层刚落的笔按"网页端口径"（覆盖率 ≥ coverMin 才算画上）光栅化一遍，
      // 掩膜里没盖到的连通块立刻补掉——底层一次铺满，不留白斑等最后的补漏收拾。
      const layerCheck = (oi, full, from) => {
        if (!opts.layerCheck) return;
        const cov = new Uint8Array(full.w * full.h);
        for (let si = from; si < strokes.length; si++) {
          const st0 = strokes[si];
          const cl = clips[st0.c];
          const rib = st0.rib;
          const np2 = rib.length >> 1;
          let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
          for (let i = 0; i < np2; i++) {
            const x = rib[i * 2], y = rib[i * 2 + 1];
            if (x < xmin) xmin = x; if (x > xmax) xmax = x;
            if (y < ymin) ymin = y; if (y > ymax) ymax = y;
          }
          xmin = Math.max(cl.x, Math.floor(xmin)); ymin = Math.max(cl.y, Math.floor(ymin));
          xmax = Math.min(cl.x + cl.w - 1, Math.ceil(xmax)); ymax = Math.min(cl.y + cl.h - 1, Math.ceil(ymax));
          if (xmax < xmin || ymax < ymin) continue;
          const mw = xmax - xmin + 1, mh = ymax - ymin + 1;
          const pts2 = new Float64Array(np2 * 2);
          for (let i = 0; i < np2; i++) { pts2[i * 2] = rib[i * 2] - xmin; pts2[i * 2 + 1] = rib[i * 2 + 1] - ymin; }
          const cv2 = new Float32Array(mw * mh);
          fillPolyCov(cv2, mw, mh, pts2, opts.coverSubY || 1);
          for (let y = 0; y < mh; y++) {
            const rowC = (ymin + y - cl.y) * cl.w, row = (ymin + y);
            for (let x = 0; x < mw; x++) {
              if (cv2[y * mw + x] < opts.coverMin) continue;
              const xx = xmin + x;
              if (!cl.mask[rowC + (xx - cl.x)]) continue;
              if (xx < full.x0 || xx >= full.x0 + full.w || row < full.y0 || row >= full.y0 + full.h) continue;
              cov[(row - full.y0) * full.w + (xx - full.x0)] = 1;
            }
          }
        }
        const gap = new Uint8Array(full.w * full.h);
        let nGap = 0;
        for (let i = 0; i < gap.length; i++) if (full.m[i] && !cov[i]) { gap[i] = 1; nGap++; }
        // 边界带**主动**补一遍：本层自己那一圈 1~2px 的边界（掩膜减"缩 1px 的掩膜"）用局部色刷。
        // 为什么：主笔是"整层一个色"（细长层尤其），而边界那圈在原图里是混色/深描边——
        // 海报字母那圈深红描边、照片发丝边的灰过渡，平涂上去必然差一截。
        // 老版本是"笔形端头缺半个圆 ⇒ 自检发现洞 ⇒ 补丁按局部色补"歪打正着把边刷准的；
        // 端头修好之后没有洞了，这件事就得明着做（用户要的"和原图 1:1"主要在边上）。
        if (opts.rimPass && oi !== baseObj && (opts.rimLinearOnly ? objStat[oi].linear : true)) {
          const own2 = objBox[oi];
          const core = erode(own2.m, own2.w, own2.h, 1);
          for (let y = 0; y < own2.h; y++) {
            const fy = y + own2.y0 - full.y0;
            if (fy < 0 || fy >= full.h) continue;
            for (let x = 0; x < own2.w; x++) {
              const i2 = y * own2.w + x;
              if (!own2.m[i2] || core[i2]) continue;
              const fx = x + own2.x0 - full.x0;
              if (fx < 0 || fx >= full.w) continue;
              const k = fy * full.w + fx;
              if (!gap[k]) { gap[k] = 1; nGap++; }
            }
          }
        }
        if (!nGap) return;
        if (!dbg.gapAt) dbg.gapAt = {};
        dbg.gapAt[oi] = strokes.length;
        const gc = compsOfLabels(gap, full.w, full.h);
        const order = [];
        for (let ci = 0; ci < gc.comps.length; ci++) {
          if (gc.comps[ci].label !== 1) continue;
          const c = gc.comps[ci];
          order.push({ ci, h: hilbertIndex((c.x0 + c.x1) >> 1, (c.y0 + c.y1) >> 1, 10) });
        }
        order.sort((a, b) => a.h - b.h);     // 沿希尔伯特序走，笔尖一片一片挪
        for (const o of order) {
          const c = gc.comps[o.ci];
          // 一个缺口里"深浅混在一起"时（缺口压在深色描边上、或者跨着渐变），
          // 用整块的均值色补上去就是一道灰条（实测飞机边上那块 15x20 的灰斑）。
          // 先按颜色二分，每一份单独补（各用各的均值色）。
          const parts = [];
          {
            const px2 = new Int32Array(c.count);
            for (let k = 0; k < c.count; k++) {
              const p = gc.pix[c.start + k];
              const x = p % full.w, y = (p - x) / full.w;
              px2[k] = (y + full.y0) * W + (x + full.x0);     // 整幅坐标
            }
            splitPixByColor(px2, c.count, 0, parts);
          }
          for (const pt of parts) {
            let px0 = W, py0 = H, px1 = -1, py1 = -1, cr = 0, cg = 0, cb = 0;
            for (let k = 0; k < pt.cnt; k++) {
              const gp = pt.pix[k];
              const x = gp % W, y = (gp - x) / W;
              if (x < px0) px0 = x; if (x > px1) px1 = x;
              if (y < py0) py0 = y; if (y > py1) py1 = y;
              cr += R[gp]; cg += G[gp]; cb += B[gp];
            }
            const x0 = px0, y0 = py0, x1 = px1, y1 = py1;
            const mw = x1 - x0 + 1, mh = y1 - y0 + 1;
            const bin = new Uint8Array(mw * mh);
            for (let k = 0; k < pt.cnt; k++) {
              const gp = pt.pix[k];
              const x = gp % W, y = (gp - x) / W;
              bin[(y - y0) * mw + (x - x0)] = 1;      // 组内局部坐标（不是整幅坐标）
            }
            // 补缝的颜色：底色层用"背景色场"（bgMap）——用原图局部均值的话，
            // 这块正好压在字上就会补成"字和底的混色"（紫灰块，实测整片花掉）
            let col;
            if (oi === baseObj && bgMap) {
              let sr2 = 0, sg2 = 0, sb2 = 0;
              for (let k = 0; k < pt.cnt; k++) {
                const gp = pt.pix[k];
                sr2 += bgMap.R[gp]; sg2 += bgMap.G[gp]; sb2 += bgMap.B[gp];
              }
              col = [Math.round(sr2 / pt.cnt), Math.round(sg2 / pt.cnt), Math.round(sb2 / pt.cnt)];
            } else {
              col = [Math.round(cr / pt.cnt), Math.round(cg / pt.cnt), Math.round(cb / pt.cnt)];
            }
            const cIdx = pushClip(x0, y0, mw, mh, bin);
            // 外扩 1px 的方框笔形 ∩ 这个 1 位掩膜 ⇒ 严格只覆盖"确实没刷到"的像素
            const ex0 = x0 - 1, ey0 = y0 - 1, ex1 = x1 + 2, ey1 = y1 + 2;
            const rect = [ex0, ey0, ex1, ey0, ex1, ey1, ex0, ey1];
            emitStroke(rect, 4, [ex0, (ey0 + ey1) / 2, ex1, (ey0 + ey1) / 2], 2,
                       Math.max(1.6, mh / 2 + 1), col, 0, cIdx, objRegions[oi].length ? objRegions[oi][0] : -1, 1);
          }
        }
        dbg.layerGap = (dbg.layerGap || 0) + nGap;
        // 补完再验一次：还剩多少没盖到（只在诊断时跑：它会把这一层的笔再光栅化一遍，很贵）
        if (opts.debug) {
          const cov2 = new Uint8Array(full.w * full.h);
          for (let si = from; si < strokes.length; si++) {
            const st0 = strokes[si];
            const cl = clips[st0.c];
            const rib = st0.rib;
            const np2 = rib.length >> 1;
            let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
            for (let i = 0; i < np2; i++) { const x = rib[i * 2], y = rib[i * 2 + 1];
              if (x < xmin) xmin = x; if (x > xmax) xmax = x; if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
            xmin = Math.max(cl.x, Math.floor(xmin)); ymin = Math.max(cl.y, Math.floor(ymin));
            xmax = Math.min(cl.x + cl.w - 1, Math.ceil(xmax)); ymax = Math.min(cl.y + cl.h - 1, Math.ceil(ymax));
            if (xmax < xmin || ymax < ymin) continue;
            const mw = xmax - xmin + 1, mh = ymax - ymin + 1;
            const pts2 = new Float64Array(np2 * 2);
            for (let i = 0; i < np2; i++) { pts2[i * 2] = rib[i * 2] - xmin; pts2[i * 2 + 1] = rib[i * 2 + 1] - ymin; }
            const cv2 = new Float32Array(mw * mh);
            fillPolyCov(cv2, mw, mh, pts2, opts.coverSubY || 1);
            for (let y = 0; y < mh; y++) {
              const rowC = (ymin + y - cl.y) * cl.w, row = (ymin + y);
              for (let x = 0; x < mw; x++) {
                if (cv2[y * mw + x] < opts.coverMin) continue;
                const xx = xmin + x;
                if (!cl.mask[rowC + (xx - cl.x)]) continue;
                if (xx < full.x0 || xx >= full.x0 + full.w || row < full.y0 || row >= full.y0 + full.h) continue;
                cov2[(row - full.y0) * full.w + (xx - full.x0)] = 1;
              }
            }
          }
          let left2 = 0;
          for (let i = 0; i < gap.length; i++) if (full.m[i] && !cov2[i]) left2++;
          dbg.layerGapLeft = (dbg.layerGapLeft || 0) + left2;
        }
      };

      lap('sweep:layerprep');
      // ---- 绘制顺序：同色合并成"一趟" ----
      // 层与层之间只有"谁盖谁"这一条硬约束：A 的完整形状盖到了 B 的可见像素 ⇒ B 必须先画。
      // 其余两两之间顺序完全自由 —— 那就优先挑"跟上一笔同色、又离笔尖近"的那层，
      // 于是同一支笔会一路把同色的东西画完（一整排橙字连着写完），而不是按面积大小来回跳。
      const paintOrder = (() => {
        const ord = new Int32Array(nObj);
        for (let i = 0; i < nObj; i++) ord[i] = i;
        if (!opts.colorPass || nObj < 2) return ord;
        const need = new Map();          // a → Set(必须先画的层)
        const rel = new Map();           // b → Set(被 b 挡住的层)
        const addEdge = (b, a) => {
          let s = need.get(a); if (!s) { s = new Set(); need.set(a, s); }
          if (s.has(b)) return;
          s.add(b);
          let t = rel.get(b); if (!t) { t = new Set(); rel.set(b, t); }
          t.add(a);
        };
        // 判据：**两张完整形状只要相交，先后就不能换**（谁先谁后是按面积定的，换了就有一方
        // 会盖到对方身上）。先按外框粗筛，再逐像素确认——只用"可见掩膜相交"是不够的：
        // 两个层各自的完整形状会互相长进对方那边，只看可见部分会漏掉这类约束。
        const inter = (A, B) => {
          const y0 = Math.max(A.y0, B.y0), y1 = Math.min(A.y0 + A.h - 1, B.y0 + B.h - 1);
          const x0 = Math.max(A.x0, B.x0), x1 = Math.min(A.x0 + A.w - 1, B.x0 + B.w - 1);
          for (let y = y0; y <= y1; y++) {
            const rowA = (y - A.y0) * A.w, rowB = (y - B.y0) * B.w;
            for (let x = x0; x <= x1; x++) if (A.m[rowA + (x - A.x0)] && B.m[rowB + (x - B.x0)]) return true;
          }
          return false;
        };
        for (let a = 1; a < nObj; a++) {
          const F = objFull[a];
          for (let b = 0; b < a; b++) {
            const G = objFull[b];
            if (F.x0 > G.x0 + G.w - 1 || G.x0 > F.x0 + F.w - 1 ||
                F.y0 > G.y0 + G.h - 1 || G.y0 > F.y0 + F.h - 1) continue;   // 外框不相交
            if (inter(F, G)) addEdge(b, a);
          }
        }
        const indeg = new Int32Array(nObj);
        for (const [a, s] of need) indeg[a] = s.size;
        const done = new Uint8Array(nObj);
        const out = [];
        let pc = null, px0 = 0, py0 = 0, pa = 0;
        for (let k = 0; k < nObj; k++) {
          let bestSame = -1, bdSame = Infinity, bestAny = -1, baAny = -1;
          for (let i = 0; i < nObj; i++) {
            if (done[i] || indeg[i] > 0) continue;
            const st = objStat[i];
            if (pc) {
              const cd = Math.abs(st.color[0] - pc[0]) + Math.abs(st.color[1] - pc[1]) + Math.abs(st.color[2] - pc[2]);
              const ar = Math.max(st.area, pa) / Math.max(1, Math.min(st.area, pa));
              if (cd <= opts.colorPassTol && ar <= opts.colorPassArea) {
                const d = Math.hypot(st.cx - px0, st.cy - py0);
                if (d < bdSame) { bdSame = d; bestSame = i; }
                continue;
              }
            }
            if (st.area > baAny) { baAny = st.area; bestAny = i; }
          }
          let pick = bestSame >= 0 ? bestSame : bestAny;
          if (pick < 0) { for (let i = 0; i < nObj; i++) if (!done[i]) { pick = i; break; } }  // 有环：按原序打破
          done[pick] = 1; out.push(pick);
          pc = objStat[pick].color; px0 = objStat[pick].cx; py0 = objStat[pick].cy; pa = objStat[pick].area;
          const t = rel.get(pick);
          if (t) for (const a of t) indeg[a]--;
        }
        dbg.colorPasses = (() => {                 // 埋点：同色的层连着画算一趟，共几趟
          let n = 1;
          for (let i = 1; i < out.length; i++) {
            const c0 = objStat[out[i - 1]].color, c1 = objStat[out[i]].color;
            if (Math.abs(c0[0] - c1[0]) + Math.abs(c0[1] - c1[1]) + Math.abs(c0[2] - c1[2]) > opts.colorPassTol) n++;
          }
          return n;
        })();
        return Int32Array.from(out);
      })();

      // ---- 出界笔的顺序约束 ----
      // 铺色时允许一小部分笔"画出界"（像人一样压到轮廓外），但只有当出界那一圈**只压在
      // 已经画过的对象上**才允许：否则后画的邻居不会再来盖它，那圈颜色就留在别人身上
      // （实测：蓝层 #30 的两支出界笔把飞机 95 个米色像素盖成蓝色，飞机就"被啃"了）。
      const bleedOK = new Uint8Array(nObj);
      if (opts.bleedP > 0) {
        const posOf = new Int32Array(nObj).fill(-1);
        for (let k = 0; k < paintOrder.length; k++) posOf[paintOrder[k]] = k;
        const br = Math.max(1, opts.bleedR | 0);
        let nOK = 0, nNo = 0;
        for (const a of paintOrder) {
          const st = objStat[a];
          if (st.area < 1200 || a === baseObj) continue;
          const F = objFull[a];
          const x0 = Math.max(0, F.x0 - br), y0 = Math.max(0, F.y0 - br);
          const x1 = Math.min(W - 1, F.x0 + F.w - 1 + br), y1 = Math.min(H - 1, F.y0 + F.h - 1 + br);
          const w = x1 - x0 + 1, h = y1 - y0 + 1;
          const m = new Uint8Array(w * h);
          for (let y = 0; y < F.h; y++) {
            const row = (y + F.y0 - y0) * w;
            for (let x = 0; x < F.w; x++) if (F.m[y * F.w + x]) m[row + (x + F.x0 - x0)] = 1;
          }
          const d = dilate(m, w, h, br);
          let bad = false;
          for (const b of paintOrder) {
            if (b === a || posOf[b] > posOf[a]) continue;      // 排在后面的对象会把它盖回来，不用管
            const G = objFull[b];
            if (G.x0 > x1 || x0 > G.x0 + G.w - 1 || G.y0 > y1 || y0 > G.y0 + G.h - 1) continue;
            const gx0 = Math.max(x0, G.x0), gx1 = Math.min(x1, G.x0 + G.w - 1);
            const gy0 = Math.max(y0, G.y0), gy1 = Math.min(y1, G.y0 + G.h - 1);
            let hit = false;
            for (let y = gy0; y <= gy1 && !hit; y++) {
              const rowD = (y - y0) * w, rowF = (y - F.y0) * F.w, rowG = (y - G.y0) * G.w;
              for (let x = gx0; x <= gx1; x++) {
                if (!d[rowD + (x - x0)]) continue;
                if (F.m[rowF + (x - F.x0)]) continue;          // 只算"出界那一圈"
                if (G.m[rowG + (x - G.x0)]) { hit = true; break; }
              }
            }
            if (hit) { bad = true; break; }
          }
          if (bad) nNo++; else { bleedOK[a] = 1; nOK++; }
        }
        dbg.bleedOK = { ok: nOK, off: nNo };
      } else {
        bleedOK.fill(1);
      }

      lap('sweep:order');
      // ---- 逐层画 ----
      const TT = {}; let tMark = Date.now();
      const tick = (k) => { const n = Date.now(); TT[k] = (TT[k] || 0) + (n - tMark); tMark = n; };

      for (const oi of paintOrder) {
        curLayer = oi;
        if (oi !== curInkObj) {
          if (curInkObj >= 0) drawInkOfObj(curInkObj);
          curInkObj = oi;
        }
        const st = objStat[oi];
        if (!st.area) continue;
        const full = objFull[oi], own = objBox[oi];
        st.from = strokes.length;
        // 取色源：本层自己"看得见"的像素（往内缩 1px 避开边界混色；细线/纹理像素不算）
        let sampleM = own;
        // 细长层不缩边：它本来就只有 1~3px 厚，"缩 1px 避开边界混色"之后几乎没剩几个像素，
        // 取色就退化成"整层一个均值色"，边界那一圈（照片的发丝/海报的深色描边）全刷成平的。
        // 小区域不缩边：爪垫/小毛发块只有 3~4px 厚，缩 1px 后掩膜几乎空了，
        // sampleColor 全部失败 ⇒ 整层退回 st.color 一个均值色（实测爪垫 24 笔全是 209,176,146）。
        const noErodeSmall = opts.photoMode && st.area < (opts.bwThickArea || 4000);
        if (st.area > 600 && !(opts.thinNoErode && st.linear) && !noErodeSmall) {
          sampleM = { x: own.x, y: own.y, w: own.w, h: own.h, m: erode(own.m, own.w, own.h, 1) };
        }
        {
          // 取色时排除"细线/纹理像素"（那里是黑字、纸纹，采进去会让铺色发黑发花）——
          // 但如果排除之后剩得太少（照片类几乎整幅都是"纹理像素"），就别排除了，
          // 否则这一层没地方取色，只能整层用一个平均色，实测照片因此差 15 个点。
          let nTex = 0, nTot = 0;
          for (let y = 0; y < sampleM.h; y++) {
            const row = (y + sampleM.y) * W + sampleM.x;
            for (let x = 0; x < sampleM.w; x++) {
              if (!sampleM.m[y * sampleM.w + x]) continue;
              nTot++;
              if (inkPix[row + x] || texPix[row + x]) nTex++;
            }
          }
          if (nTex > 0 && nTex < 0.7 * nTot) {
            const sm = new Uint8Array(sampleM.m);
            for (let y = 0; y < sampleM.h; y++) {
              const row = (y + sampleM.y) * W + sampleM.x;
              for (let x = 0; x < sampleM.w; x++) if (inkPix[row + x] || texPix[row + x]) sm[y * sampleM.w + x] = 0;
            }
            sampleM = { x: sampleM.x, y: sampleM.y, w: sampleM.w, h: sampleM.h, m: sm };
          }
        }
        let sealed = false, checkFull = full;
        if (oi === baseObj && bgMap) {
          // 底色层：裁剪范围是整幅（上面要画的东西也照刷，一个洞都不留），取色用"背景色场"
          // （看得见的地方 = 平滑图，看不见的地方 = 按周围推出来的）；分段短、并笔卡得紧，
          // 免得一条长笔跨过渐变把颜色抹平（底色的暗角/渐变就是这么丢的）
          curTarget = bgMap;
          segLenOverride = Math.max(26, Math.round(56 * strokeScale));
          joinCdOverride = 6;
          sealed = paintSweep(oi, full, { x: 0, y: 0, w: W, h: H, m: full.m });
          segLenOverride = 0; joinCdOverride = 0;
          curTarget = target;
        } else if (st.linear) {
          paintAsLines(oi, full, own, sampleM);
        } else {
          // 照片小区域只刷"看得见的那块"：完整形状常包含被上层盖住的部分，
          // 笔扫出去以后 sampleColor 在可见掩膜里取不到色，整层会退回 st.color 一个均值色。
          const paintFull = (opts.photoMode && st.area < opts.bwThickArea) ? own : full;
          sealed = paintSweep(oi, paintFull, sampleM);
          checkFull = paintFull;
        }
        tick(st.linear ? 'lines' : 'sweep');
        // 落笔前已经做过联合覆盖自检、缝也补平了 ⇒ 这里的"事后自检"就没活干了，
        // 直接跳过（它要把这一层的笔再光栅化一遍，很贵）
        if (!sealed) layerCheck(oi, checkFull, st.from);
        tick('check');
        st.to = strokes.length;
        if (opts.debug) (dbg.paintTrace || (dbg.paintTrace = [])).push({
          oi, from: st.from, to: st.to, area: st.area, linear: !!st.linear,
          ly0: st.from < st.to ? strokes[st.from].ly : -1,
        });
      }
      if (curInkObj >= 0) drawInkOfObj(curInkObj);
      curLayer = -1;              // 后面的残差/补漏/题字都不是"某一层"了
      tick('lines');
      dbg.paint = TT;
      dbg.layerEnds = objStat.map((s2) => s2.to || 0);
      if (opts.dumpMasks) {
        const pal2 = [[255,255,255],[0,0,0],[255,0,0],[0,160,0],[0,0,255],[255,160,0],[160,0,255],[0,200,200],
                      [128,128,0],[255,0,255],[0,100,0],[128,0,0],[0,0,128],[200,200,0],[100,100,100],[255,100,100]];
        const lm = new Uint8Array(N * 3);
        for (let pp = 0; pp < N; pp++) {
          const c = pal2[objLab[pp] % pal2.length];
          lm[pp*3] = c[0]; lm[pp*3+1] = c[1]; lm[pp*3+2] = c[2];
        }
        dbg.layerMap = lm;
      }
      dbg.dumpMasks = opts.dumpMasks ? objStat.map((s2, i) => {
        const f = objFull[i], o = objBox[i];
        return { oi: s2.oi, color: s2.color, area: s2.area, linear: !!s2.linear, thick: s2.thick || 0,
                 grown: s2.grown || 0, full: { x0: f.x0, y0: f.y0, w: f.w, h: f.h, m: Array.from(f.m) },
                 own: { x0: o.x0, y0: o.y0, w: o.w, h: o.h, m: Array.from(o.m) } };
      }) : undefined;
      dbg.layers = objStat.map((s2) => ({
        oi: s2.oi, area: s2.area, paper: !!s2.isPaper, linear: !!s2.linear,
        thick: s2.thick ? +s2.thick.toFixed(1) : 0, grown: s2.grown || 0,
        strokes: (s2.to || 0) - s2.from, from: s2.from || 0, to: s2.to || 0,
        bbox: [s2.x0, s2.y0, s2.x1, s2.y1],
      }));
    }
    mark('铺色');
    lap('sweep');
    prog(0.78, '补笔修形…'); await yieldUI();

    dbg.mainStrokes = strokes.length;
    // ---- 8c) 残差补笔：哪块不像就在哪块补细笔（按局部小块，允许覆盖） ----
    // "边缘带"（区块交界附近 2px）：纹理像素在这里不跳过残差——
    // 边缘上的过渡像素如果也被 texPix 跳过，笔触的半覆盖边就没人补实，
    // 网页端抗锯齿渲染下会留下 1~2px 的白缝（实测插画 22px）。
    // 照片类不启用：它的边缘本来就是渐变纹理，硬补反而把可见差异补高（29.2% → 31.2%）。
    const edgeNear = (() => {
      if (opts.photoMode) return new Uint8Array(N);   // 照片类不启用：全 0 = 没有边缘带豁免
      const band = new Uint8Array(N);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const p = y * W + x, c0 = compOf[p];
          if ((x + 1 < W && compOf[p + 1] !== c0) || (y + 1 < H && compOf[p + W] !== c0)) band[p] = 1;
        }
      }
      return dilate(band, W, H, 2);
    })();
    // 局部起伏（3x3 窗口内每通道极差的最大值）：很小 = 这一带是平滑渐变/平色，
    // 不是"有结构的地方"——渐变上的采样台阶用点去描，只会描出一片鬼影（插画那个粉色圆里
    // 那块方块状淡影就是 5000 笔描出来的），而且描完还是不匀。
    const flatRng = (() => {
      const out = new Uint8Array(N);
      if (!(opts.resFlatTol > 0)) return out;      // 判据关着就别算（3x3 极差是整幅扫描）
      for (let y = 0; y < H; y++) {
        const y0 = y > 0 ? y - 1 : 0, y1 = y < H - 1 ? y + 1 : H - 1;
        for (let x = 0; x < W; x++) {
          const x0 = x > 0 ? x - 1 : 0, x1 = x < W - 1 ? x + 1 : W - 1;
          let r0 = 255, r1 = 0, g0 = 255, g1 = 0, b0 = 255, b1 = 0;
          for (let yy = y0; yy <= y1; yy++) {
            for (let xx = x0; xx <= x1; xx++) {
              const p = yy * W + xx;
              if (R[p] < r0) r0 = R[p]; if (R[p] > r1) r1 = R[p];
              if (G[p] < g0) g0 = G[p]; if (G[p] > g1) g1 = G[p];
              if (B[p] < b0) b0 = B[p]; if (B[p] > b1) b1 = B[p];
            }
          }
          const rr = r1 - r0, gg = g1 - g0, bb = b1 - b0;
          out[y * W + x] = rr > gg ? (rr > bb ? rr : bb) : (gg > bb ? gg : bb);
        }
      }
      return out;
    })();
    // 抗锯齿斜坡：目标色正好夹在"相邻两个区块的纯色"之间 ⇒ 这是渲染毛边，不是内容。
    // 补它 = 用一堆点去描一条毛边（笔数成千上万，成品还是毛的），不补 = 干净的硬边（人才这么画）。
    const rampPix = (() => {
      const m = new Uint8Array(N);
      if (!opts.resRampSkip || (opts.photoMode && !opts.resSkipRampPhoto)) return m;
      const colOf = new Map();
      for (const rg of regions) colOf.set(rg.cid, rg.color);
      const DX = [1, -1, 0, 0], DY = [0, 0, 1, -1];
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const p = y * W + x, c0 = compOf[p];
          let a = -1, b = -1;
          for (let d = 0; d < 4; d++) {
            for (let s = 1; s <= 3; s++) {
              const xx = x + DX[d] * s, yy = y + DY[d] * s;
              if (xx < 0 || xx >= W || yy < 0 || yy >= H) break;
              const cq = compOf[yy * W + xx];
              if (cq === c0) continue;
              if (a < 0) a = cq; else if (cq !== a && b < 0) b = cq;
              break;
            }
          }
          if (a < 0 || b < 0) continue;
          const A = colOf.get(a), Bv = colOf.get(b);
          if (!A || !Bv) continue;
          const vx = Bv[0] - A[0], vy = Bv[1] - A[1], vz = Bv[2] - A[2];
          const vv = vx * vx + vy * vy + vz * vz;
          if (vv < 400) continue;                        // 两边颜色太近：无所谓补不补
          const px2 = R[p] - A[0], py2 = G[p] - A[1], pz2 = B[p] - A[2];
          const t = (px2 * vx + py2 * vy + pz2 * vz) / vv;
          if (t <= 0.12 || t >= 0.88) continue;          // 不在两色之间（更靠某一侧）⇒ 不是毛边
          const dx2 = px2 - t * vx, dy2 = py2 - t * vy, dz2 = pz2 - t * vz;
          if (Math.abs(dx2) + Math.abs(dy2) + Math.abs(dz2) <= opts.rampTol) m[p] = 1;
        }
      }
      return m;
    })();
    let inkDrawn = false;
    let deadScan = null;   // 像素 → 最后画上它的笔号（回放/补笔时顺手记的，收尾删"零贡献笔"用）
    let curStroke = -1;    // 当前正在落色的笔号（给 deadScan 用）
    if ((opts.residual && opts.residual.length) || opts.returnCanvas || opts.returnKeys) {
      const canvas = new Uint8Array(N * 3);
      canvas.fill(255);
      if (opts.dropDead || opts.debug) deadScan = new Int32Array(N).fill(-1);
      const raster = (ribArr, color, clipIdx) => {
        const cl = clips[clipIdx];
        // 这一笔实际改了多少画布（Σ 每像素最大通道差）：回放按“看得见多少”分时间
        let visSum = 0;
        let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
        for (let i = 0; i + 1 < ribArr.length; i += 2) {
          const x = ribArr[i], y = ribArr[i + 1];
          if (x < xmin) xmin = x; if (x > xmax) xmax = x;
          if (y < ymin) ymin = y; if (y > ymax) ymax = y;
        }
        xmin = Math.max(cl.x, Math.floor(xmin)); ymin = Math.max(cl.y, Math.floor(ymin));
        xmax = Math.min(cl.x + cl.w - 1, Math.ceil(xmax)); ymax = Math.min(cl.y + cl.h - 1, Math.ceil(ymax));
        if (xmax < xmin || ymax < ymin) return;
        const mw = xmax - xmin + 1, mh = ymax - ymin + 1;
        const np2 = ribArr.length >> 1;
        const pts = new Float64Array(np2 * 2);
        for (let i = 0; i < np2; i++) { pts[i * 2] = ribArr[i * 2] - xmin; pts[i * 2 + 1] = ribArr[i * 2 + 1] - ymin; }
        // 光栅口径（老坑，见 README）：网页端是"画布多边形抗锯齿 ∩ 1 位硬遮罩"，
        // 所以这里也按覆盖率算——盖不到 coverMin 的像素就当"没画上"（保守），
        // 宁可让下一轮补笔/补漏把它补实，也不能让网页端留个半白的点。
        const cov = new Float32Array(mw * mh);
        fillPolyCov(cov, mw, mh, pts, opts.coverSubY || 1);
        for (let y = 0; y < mh; y++) {
          const yy = ymin + y;
          const rowC = (yy - cl.y) * cl.w;
          for (let x = 0; x < mw; x++) {
            let al = cov[y * mw + x];
            if (al <= 0) continue;
            if (!opts.featherRaster) al = al >= opts.coverMin ? 1 : 0;
            if (al <= 0) continue;
            const xx = xmin + x;
            if (!cl.mask[rowC + (xx - cl.x)]) continue;
            const pp = yy * W + xx;
            if (deadScan && curStroke >= 0) {
              // 一笔"在最终画布上零贡献"才允许删——但它要是**被别的图层**盖住的（不是被本层
              // 后来的笔盖住的），删掉就会在"那一层刚画完"那一帧留一个洞：底色层实测有 19 笔
              // 是被后面的图层盖住的，删完底色帧上就是 7623 个白点（0.92%）——用户看到的
              // "底色没涂满"。凡是"曾经被别的层盖过"的笔，一律不删。
              // 一笔"在最终画布上零贡献"才允许删——但它要是**被别的图层**盖住的（不是被本层
              // 后来的笔盖住的），删掉就会在"那一层刚画完"那一帧留一个洞：底色层实测有 19 笔
              // 是被后面的图层盖住的，删完底色帧上就是 7623 个白点（0.92%）——用户看到的
              // "底色没涂满"。凡是"曾经被别的层盖过"的笔，一律不删。
              const pv = deadScan[pp];
              if (pv >= 0 && pv !== curStroke) {
                const rs = strokes[pv];
                if (rs && rs.ly !== curLayer) rs.prot = 1;
              }
              deadScan[pp] = curStroke;   // 最后画上这个像素的笔
            }
            const oR = canvas[pp * 3], oG = canvas[pp * 3 + 1], oB = canvas[pp * 3 + 2];
            if (al >= 0.995) {
              canvas[pp * 3] = color[0]; canvas[pp * 3 + 1] = color[1]; canvas[pp * 3 + 2] = color[2];
            } else {
              canvas[pp * 3] = oR * (1 - al) + color[0] * al;
              canvas[pp * 3 + 1] = oG * (1 - al) + color[1] * al;
              canvas[pp * 3 + 2] = oB * (1 - al) + color[2] * al;
            }
            const dR = Math.abs(canvas[pp * 3] - oR);
            const dG = Math.abs(canvas[pp * 3 + 1] - oG);
            const dB = Math.abs(canvas[pp * 3 + 2] - oB);
            visSum += dR > dG ? (dR > dB ? dR : dB) : (dG > dB ? dG : dB);
          }
        }
        if (curStroke >= 0) {
          const rec = strokes[curStroke];
          if (rec) rec.vis = (rec.vis || 0) + visSum;
        }
      };
      // 关键帧：主笔过程中每 1/K 张快照，方便网页端拖动进度（当然也在跑完时快照一张）
      // 顺带（免费）记下"每个像素最后是被哪一笔画上的"（见 raster 里的 deadScan）：收尾用它删零贡献笔
      const keysOut = [];
      const kEvery = Math.max(1, Math.ceil(strokes.length / (opts.keyFrames || 5)));
      for (let i0 = 0; i0 < strokes.length; i0++) {
        const st0 = strokes[i0];
        curStroke = i0;
        raster(st0.rib, st0.color, st0.c);
        if ((i0 + 1) % kEvery === 0) keysOut.push({ i: i0 + 1, rgb: canvas.slice() });
      }
      if (!keysOut.length || keysOut[keysOut.length - 1].i !== strokes.length) {
        keysOut.push({ i: strokes.length, rgb: canvas.slice() });
      }
      // 按"产出站点"计数（诊断用：哪一段在刷笔数）
      const SRC = { batch: 0, resRibbon: 0, holeRibbon: 0, holeDab: 0, holeRect: 0 };
      dbg.rounds = [];
      dbg.src = SRC;
      // 外框笔形一定盖满自己的掩膜 ⇒ 直接按掩膜落色（等价，省掉在一整块大外框上跑覆盖光栅）
      const rasterMask = (clipIdx, color) => {
        const cl = clips[clipIdx];
        let visSum = 0;
        for (let y = 0; y < cl.h; y++) {
          const rowC = y * cl.w, row = (cl.y + y) * W;
          for (let x = 0; x < cl.w; x++) {
            if (!cl.mask[rowC + x]) continue;
            const pp = row + cl.x + x;
            if (deadScan && curStroke >= 0) {
              const pv = deadScan[pp];
              if (pv >= 0 && pv !== curStroke) {
                const rs = strokes[pv];
                if (rs && rs.ly !== curLayer) rs.prot = 1;
              }
              deadScan[pp] = curStroke;
            }
            const oR = canvas[pp * 3], oG = canvas[pp * 3 + 1], oB = canvas[pp * 3 + 2];
            canvas[pp * 3] = color[0]; canvas[pp * 3 + 1] = color[1]; canvas[pp * 3 + 2] = color[2];
            const dR = Math.abs(color[0] - oR), dG = Math.abs(color[1] - oG), dB = Math.abs(color[2] - oB);
            visSum += dR > dG ? (dR > dB ? dR : dB) : (dG > dB ? dG : dB);
          }
        }
        if (curStroke >= 0) {
          const rec = strokes[curStroke];
          if (rec) rec.vis = (rec.vis || 0) + visSum;
        }
      };
      const emitRaster = (rib, pathPts, nPath, halfW, col, pen, cIdx, ph, maskOnly) => {
        const rec = emitStroke(rib, rib.length / 2, pathPts, nPath, halfW, col, pen, cIdx, -1, ph);
        rec.src = dbg.srcSite || 'holeDab';       // 诊断：这一笔是哪一段产出的（行程/笔数分解用）
        dbg.src[dbg.srcSite || 'holeDab']++;
        curStroke = strokes.length - 1;
        if (maskOnly) rasterMask(rec.c, rec.color);
        else raster(rec.rib, rec.color, rec.c);
        return rec;
      };
      const TILE = 72;
      // 瓦片按"所属对象"排序：残差补笔也走"一个对象补完再补下一个"，
      // 不再全画面从上到下扫（那样笔尖会一直跨对象来回跳）
      const tileList = [];
      for (let ty = 0; ty < H; ty += TILE) {
        for (let tx = 0; tx < W; tx += TILE) {
          const mx = Math.min(W - 1, tx + (TILE >> 1)), my = Math.min(H - 1, ty + (TILE >> 1));
          tileList.push({ tx, ty, o: objOfComp[compOf[my * W + mx]] });
        }
      }
      tileList.sort((a, b) => a.o - b.o || a.ty - b.ty || a.tx - b.tx);
      // ---- 补丁合并池（残差补笔、收尾补漏共用）：笔数从几万降到几千的主要手段 ----
      // 补笔里绝大多数是 5~16px 的"小点"，一拍一笔，照片类能拍出两万个单点笔。
      // 但每一笔的笔形最终都会被它自己的 1 位裁剪掩膜裁掉多余部分 —— 也就是
      // "笔形只要盖住自己的掩膜"就够。于是把"同一格、颜色同一个桶"的补丁并成一笔：
      // 掩膜取并集、笔形取并集外框（再外扩 0.5px 保证盖住每个像素中心）、颜色取桶内加权均值。
      // 各补丁的掩膜互不相交 ⇒ 谁也没盖住谁 ⇒ 合并只带来"每通道 ≤ 半个桶宽"的取色偏差，
      // 换来笔数少一个数量级（桶宽可调：patchShift；空间粒度：patchCell）。
      const makePool = (cellOv, shiftOv, tolOv, boxOv) => {
        const CEL = Math.max(16, (cellOv === undefined ? opts.patchCell : cellOv) | 0);
        const pShift = shiftOv === undefined ? opts.patchShift : shiftOv;
        const pTol = tolOv === undefined ? opts.patchTol : tolOv;
        const BX = boxOv === undefined ? opts.patchBox : boxOv;
        const pool = new Map();
        let nOut = 0, nIn = 0, maxG = 0;
        const flushGroup = (g, ph) => {
          const mw = g.x1 - g.x0 + 1, mh = g.y1 - g.y0 + 1;
          const m = new Uint8Array(mw * mh);
          for (const p of g.parts) {
            for (let y = 0; y < p.h; y++) {
              const src = y * p.w, dst = (p.y - g.y0 + y) * mw + (p.x - g.x0);
              for (let x = 0; x < p.w; x++) if (p.m[src + x]) m[dst + x] = 1;
            }
          }
          const cIdx = pushClip(g.x0, g.y0, mw, mh, m);
          const ex0 = g.x0 - 0.5, ey0 = g.y0 - 0.5, ex1 = g.x1 + 1.5, ey1 = g.y1 + 1.5;
          const rect = [ex0, ey0, ex1, ey0, ex1, ey1, ex0, ey1];
          // 笔尖轨迹：按"就近串"把这一组点连起来，回放时看着像手在一个地方点点
          const n = g.px.length;
          const ord = n >= 3 ? chainNN(g.px.map((_, i) => i), (i) => [g.px[i], g.py[i]], g.px[0], g.py[0]) : null;
          const tp = [];
          for (let k = 0; k < n; k++) { const i = ord ? ord[k] : k; tp.push(g.px[i], g.py[i]); }
          const col = [Math.round(g.cr / g.cn), Math.round(g.cg / g.cn), Math.round(g.cb / g.cn)];
          dbg.srcSite = 'batch';
          const rec = emitRaster(rect, tp, n, 4.2, col, 0, cIdx, ph, true);
          rec.g = n;                      // 这一笔合了几个补丁（诊断用）
          nOut++;
        };
        return {
          add(col, x0, y0, x1, y1, mw, mh, mask, cx, cy, cnt) {
            // 自适应色差（patchTol > 0）：不再只认"固定色桶"，而是跟"这一组当前的均值色"比。
            // 固定色桶的毛病是桶宽必须卡在可见阈值以内（否则补上去还是错），于是同一个地方
            // 颜色略差一点的补丁就各成一笔，合并比只有 1.7:1；改成跟均值色比之后，
            // 只要彼此差得开（≤ patchTol）就能并进同一笔，均值色本身仍贴着每个补丁。
            // 开着自适应色差时色桶反而要**放粗**（候选多、再由均值色判据收紧），
            // 否则色桶先把自己卡死，自适应就白搭了
            const sh = pTol > 0 ? Math.min(7, pShift + 1) : pShift;
            const key = (((y0 / CEL) | 0) * 4096 + ((x0 / CEL) | 0)) + '|' +
                        (col[0] >> sh) + ',' + (col[1] >> sh) + ',' + (col[2] >> sh);
            if (opts.debug) {   // 诊断：补丁到底散落在多少个色阶桶里（桶数 ≈ 合并下限）
              const bk = (col[0] >> sh) + ',' + (col[1] >> sh) + ',' + (col[2] >> sh);
              (dbg.bk || (dbg.bk = new Set())).add(bk);
            }
            let list = pool.get(key);
            if (!list) { list = []; pool.set(key, list); }
            // 同一格同一色桶可以有好几组：谁能"装下"这个补丁就并进谁。
            // 两个门槛：外框不得超过 patchBox（网页端每一笔要清/合的画布、掩膜内存都看它），
            // 外框面积还不得超过 patchFill 允许的"稀疏度"（外框涨得比补丁多 → 掩膜全是被浪费的空白，
            // 而散点补丁本来就该并成一大笔：密度判据比"外框边长"省内存得多）。
            let g = null, gArea = Infinity;
            let nCand = 0, nBox = 0, nTol = 0;
            for (let li = 0; li < list.length; li++) {
              const gg = list[li];
              const bw = Math.max(gg.x1, x1) - Math.min(gg.x0, x0) + 1;
              const bh = Math.max(gg.y1, y1) - Math.min(gg.y0, y0) + 1;
              nCand++;
              if (bw > BX || bh > BX) { nBox++; continue; }
              if (pTol > 0) {   // 与组均值色的曼哈顿距离上限（超了就不许并）
                const d = Math.abs(col[0] - gg.cr / gg.cn) + Math.abs(col[1] - gg.cg / gg.cn) +
                          Math.abs(col[2] - gg.cb / gg.cn);
                if (d > pTol) { nTol++; continue; }
              }
              const area = bw * bh;
              if (area < gArea) { g = gg; gArea = area; }   // 挑"并进去之后外框最小"的一组，装得最满
            }
            if (opts.debug) {   // 诊断：补丁合并不上的原因（外框超限 / 色差超限 / 同键里根本没别的组）
              const R2 = dbg.poolRej || (dbg.poolRej = { key: 0, box: 0, tol: 0, ok: 0, cand: 0 });
              R2.cand += nCand;
              if (!list.length) R2.key++;
              else if (!nCand) R2.key++;
              else if (!g && nBox && !nTol) R2.box++;
              else if (!g && nTol) R2.tol++;
              else if (g) R2.ok++;
            }
            if (!g) { g = { cr: 0, cg: 0, cb: 0, cn: 0, pa: 0, x0, y0, x1, y1, parts: [], px: [], py: [] }; list.push(g); }
            if (x0 < g.x0) g.x0 = x0; if (y0 < g.y0) g.y0 = y0;
            if (x1 > g.x1) g.x1 = x1; if (y1 > g.y1) g.y1 = y1;
            g.cr += col[0] * cnt; g.cg += col[1] * cnt; g.cb += col[2] * cnt; g.cn += cnt; g.pa += cnt;
            g.parts.push({ x: x0, y: y0, w: mw, h: mh, m: mask });
            g.px.push(cx); g.py.push(cy);
            if (g.parts.length > maxG) maxG = g.parts.length;
            nIn++;
            // 一组别太大：回放更细、就近串也不至于变慢
            if (g.parts.length >= 360) { flushGroup(g, this._ph); list.splice(list.indexOf(g), 1); }
          },
          flush(ph) {
            this._ph = ph;
            // 落盘顺序按"就近串"走：回放时笔尖是在一片地方点点，不是全画面乱跳。
            // 只改顺序，不改任何像素结果——各组掩膜互不相交，谁也没盖住谁。
            const all = [];
            for (const list of pool.values()) for (const g of list) if (g.parts.length) all.push(g);
            const HB = 10;    // 最大边 1024 ⇒ 10 bit 够（更长的边会被夹到边界，仍然有序）
            if (all.length > 400) {
              // 沿希尔伯特序走：笔尖一片一片挪过去，不再按 (y,x) 横扫整幅
              for (const g of all) g.h = hilbertIndex((g.x0 + g.x1) >> 1, (g.y0 + g.y1) >> 1, HB);
              all.sort((a, b) => a.h - b.h);
              for (const g of all) flushGroup(g, ph);
            } else if (all.length > 1) {
              const used = new Uint8Array(all.length);
              let cx = lastPen.x, cy = lastPen.y;
              for (let k = 0; k < all.length; k++) {
                let best = -1, bd = Infinity;
                for (let i = 0; i < all.length; i++) {
                  if (used[i]) continue;
                  const g = all[i];
                  const dx = (g.x0 + g.x1) * 0.5 - cx, dy = (g.y0 + g.y1) * 0.5 - cy;
                  const d = dx * dx + dy * dy;
                  if (d < bd) { bd = d; best = i; }
                }
                used[best] = 1;
                const g = all[best];
                flushGroup(g, ph);
                cx = (g.x0 + g.x1) * 0.5; cy = (g.y0 + g.y1) * 0.5;
              }
            } else if (all.length) {
              flushGroup(all[0], ph);
            }
            pool.clear();
            return nOut;
          },
          stat() { return { out: nOut, in: nIn, maxG }; },
        };
      };
      let prevPct = 999;
      let nPieces = 0;   // 轮次预算按"补笔个数"算（从 0 起算：主笔已经花掉的预算不该算在补笔头上，
                         // 否则主笔一多，补笔就被预算砍在半路——实测 s2 只补了 5 轮就停了，差 15 个点）
                             // 合并成笔后笔数会变少，若按笔数算，合并本身会让补笔多跑一轮，
                             // 质量变好但耗时变长——那属于另一件事，不该被"省笔"顺手带出来
      const nSched = opts.residual.length;
      const nRounds = nSched + (opts.resTail | 0);
      let dArr = null;   // 轮末存下的"每像素最大通道差"，供下一轮的 skip 复用（见下面的注释）
      for (let round = 0; round < nRounds; round++) {
        // 预算闸门：排定轮次（粗→细的固定档）用完就停，但**尾巴轮**（自适应续补）只要还有收益就走，
        // 否则"还没收敛就被预算砍掉"——那正是老版本海报停在 20%、照片停在 29% 的原因。
        const inTail = round >= nSched;
        if (!inTail && nPieces > opts.maxStrokes) break;
        if (inTail && nPieces > opts.maxStrokes * opts.resTailMax) break;
        // 前两轮是"收形"（把轮廓/边缘修准），后面几轮是"点睛"（抠细节，手更慢更细）
        const phR = round < 2 ? 2 : 3;
        const thr = inTail
          ? Math.max(opts.resTailMin, opts.residual[nSched - 1] - (round - nSched + 1) * opts.resTailStep)
          : opts.residual[round];
        let added = 0;
        const pool = makePool();
        const addPatch = pool.add;
        const flushBatch = () => { pool.flush(phR); };
        const nBatch = () => pool.stat().out;
        // 全图错误掩膜：把"又大又厚"的错误块（大片平滑渐变差异）排除在补笔之外，
        // 否则会按 72px 小格补出块状拼贴
        lap('r:begin');
        const skip = new Uint8Array(N);
        {
          // "最大通道差"整幅重算一遍是这里最贵的一步（百万像素 × 3 通道）。
          // 轮末算"可见差异"时反正要算一次，顺手存进 dArr 留给下一轮用 ——
          // 两处看的是同一份画布（中间只有 prog/yieldUI，不改像素），
          // 所以这里只做一次比较（dArr > thr），结果完全一样。
          if (!dArr) {
            dArr = new Uint8Array(N);
            for (let i2 = 0; i2 < N; i2++) {
              dArr[i2] = Math.max(Math.abs(canvas[i2 * 3] - R[i2]),
                                  Math.abs(canvas[i2 * 3 + 1] - G[i2]),
                                  Math.abs(canvas[i2 * 3 + 2] - B[i2]));
            }
          }
          const wrongAll = new Uint8Array(N);
          for (let i2 = 0; i2 < N; i2++) if (dArr[i2] > thr) wrongAll[i2] = 1;
          const wcc = compsOfLabels(wrongAll, W, H);
          for (let ci = 0; ci < wcc.comps.length; ci++) {
            const c = wcc.comps[ci];
            if (c.label !== 1) continue;
            // "厚度"要用距离变换算**真实厚度**（2×最大内切半径），不能用 面积÷外框边长：
            // 字母/飞机那圈深色描边是"细环"，按面积÷外框能算出 46px 的假厚度 ⇒ 整条描边被
            // 当成"大片平滑渐变"跳过，永远不补（用户看到的"边被啃"里就有一条是这个）。
            const thick = compThick(c, wcc.pix);
            if (c.count > 2500 && thick > opts.resThick * strokeScale) {
              for (let k = 0; k < c.count; k++) skip[wcc.pix[c.start + k]] = 1;
            }
          }
        }
        lap('r:skip');
        for (let ti = 0; ti < tileList.length && added < 6000; ti++) {
          const tx = tileList[ti].tx, ty = tileList[ti].ty;
          {
            const tw = Math.min(TILE, W - tx), th = Math.min(TILE, H - ty);
            const wrong = new Uint8Array(tw * th);
            let any = 0;
            for (let y = 0; y < th; y++) {
              for (let x = 0; x < tw; x++) {
                const pp = (ty + y) * W + (tx + x);
                const d = Math.max(Math.abs(canvas[pp * 3] - R[pp]),
                                   Math.abs(canvas[pp * 3 + 1] - G[pp]),
                                   Math.abs(canvas[pp * 3 + 2] - B[pp]));
                // 细线像素跳过：它们留到最后由细线层"写"上去，残差补笔不用在这里重复劳动
                // 斜坡像素（抗锯齿毛边）和"平滑区的小误差"也跳过：那不是内容，描它只会描出鬼影
                if (d > thr && !skip[pp] && !((inkGuard[pp] || thinGuard[pp]) && d <= opts.inkGuardErr) && !(opts.resSkipInk && inkPix[pp]) && !(opts.resSkipRamp && rampPix[pp]) &&
                    !(opts.resFlatTol > 0 && flatRng[pp] <= opts.resFlatTol && d <= opts.resFlatErr) &&
                    !(opts.texResSkip && texPix[pp] && !edgeNear[pp])) { wrong[y * tw + x] = 1; any++; }
              }
            }
            if (any < 5) continue;
            const cc = compsOfLabels(wrong, tw, th);
            const toX = (lp) => tx + (lp % tw);
            const toY = (lp) => ty + ((lp / tw) | 0);
            for (let ci = 0; ci < cc.comps.length; ci++) {
              const c = cc.comps[ci];
              if (c.label !== 1 || c.count < 5) continue;
              // 按颜色分裂（方差最大通道二分，最多 3 层）
              const parts = [];
              (function split(st, cnt, depth) {
                if (depth >= 4 || cnt < 9) { parts.push([st, cnt]); return; }
                let mn0 = 255, mn1 = 255, mn2 = 255, mx0 = 0, mx1 = 0, mx2 = 0;
                for (let k = 0; k < cnt; k++) {
                  const pp = toY(cc.pix[st + k]) * W + toX(cc.pix[st + k]);
                  if (R[pp] < mn0) mn0 = R[pp]; if (R[pp] > mx0) mx0 = R[pp];
                  if (G[pp] < mn1) mn1 = G[pp]; if (G[pp] > mx1) mx1 = G[pp];
                  if (B[pp] < mn2) mn2 = B[pp]; if (B[pp] > mx2) mx2 = B[pp];
                }
                const s0 = mx0 - mn0, s1 = mx1 - mn1, s2 = mx2 - mn2;
                const smax = Math.max(s0, s1, s2);
                // 颜色散布不超过它就不切了：补上去用的是这一份的均值色，
                // 所以这个数直接决定"最后一公里"能压到多少（18 ⇒ 残差 ~9，正好卡在可见阈值上；
                // 降到 8 ⇒ 残差 ~4，代价是补丁数变多）
                if (smax <= opts.resSplit) { parts.push([st, cnt]); return; }
                const ch = s0 === smax ? 0 : (s1 === smax ? 1 : 2);
                const vals = new Float64Array(cnt);
                for (let k = 0; k < cnt; k++) {
                  const pp = toY(cc.pix[st + k]) * W + toX(cc.pix[st + k]);
                  vals[k] = ch === 0 ? R[pp] : (ch === 1 ? G[pp] : B[pp]);
                }
                const sorted = Array.from(vals).sort((a, b) => a - b);
                const med = sorted[cnt >> 1];
                let i = 0, j = cnt - 1;
                while (i <= j) {
                  if (vals[i] <= med) i++;
                  else {
                    const ti = cc.pix[st + i]; cc.pix[st + i] = cc.pix[st + j]; cc.pix[st + j] = ti;
                    const tv = vals[i]; vals[i] = vals[j]; vals[j] = tv; j--;
                  }
                }
                if (i === 0 || i === cnt) { parts.push([st, cnt]); return; }
                split(st, i, depth + 1);
                split(st + i, cnt - i, depth + 1);
              })(c.start, c.count, 0);

              // 颜色分裂后的每一份再按连通切开（避免"散点连成一条长笔"）。
              // 老实现是**对整张 72×72 瓦片**做一次连通（pm 每次新建 tw×th），一份就一次；
              // 照片类一轮几千份，这里就是最大的耗时点。改成只在"这一份自己的外框"里做连通。
              const pieces = [];      // 每项 = 一份的瓦片内像素下标
              for (const part of parts) {
                const st = part[0], cnt = part[1];
                if (cnt < 5) continue;
                let px0 = tw, py0 = th, px1 = -1, py1 = -1;
                for (let k = 0; k < cnt; k++) {
                  const lp = cc.pix[st + k], xx = lp % tw, yy = (lp / tw) | 0;
                  if (xx < px0) px0 = xx; if (xx > px1) px1 = xx;
                  if (yy < py0) py0 = yy; if (yy > py1) py1 = yy;
                }
                const bw = px1 - px0 + 1, bh = py1 - py0 + 1;
                // 本来就小、或者本来就紧凑（填充率高）的一份，不必再切连通
                if (cnt < 40 || cnt / (bw * bh) > 0.4) {
                  const arr = new Int32Array(cnt);
                  for (let k = 0; k < cnt; k++) arr[k] = cc.pix[st + k];
                  pieces.push(arr);
                  continue;
                }
                const pm = new Uint8Array(bw * bh);
                for (let k = 0; k < cnt; k++) {
                  const lp = cc.pix[st + k];
                  pm[(((lp / tw) | 0) - py0) * bw + ((lp % tw) - px0)] = 1;
                }
                const pc = compsOfLabels(pm, bw, bh);
                for (let j = 0; j < pc.comps.length; j++) {
                  const c2 = pc.comps[j];
                  if (c2.label !== 1 || c2.count < 5) continue;
                  const arr = new Int32Array(c2.count);
                  for (let k = 0; k < c2.count; k++) {
                    const lp = pc.pix[c2.start + k];
                    arr[k] = (py0 + ((lp / bw) | 0)) * tw + (px0 + (lp % bw));
                  }
                  pieces.push(arr);
                }
              }
              for (const idxArr of pieces) {
                const cnt = idxArr.length;
                if (cnt < 5) continue;
                let cr = 0, cg = 0, cb = 0;
                let x0 = W, y0 = H, x1 = -1, y1 = -1;
                for (let k = 0; k < cnt; k++) {
                  const lp = idxArr[k];
                  const xx = toX(lp), yy = toY(lp);
                  const pp = yy * W + xx;
                  cr += R[pp]; cg += G[pp]; cb += B[pp];
                  if (xx < x0) x0 = xx; if (xx > x1) x1 = xx;
                  if (yy < y0) y0 = yy; if (yy > y1) y1 = yy;
                }
                const col = [Math.round(cr / cnt), Math.round(cg / cnt), Math.round(cb / cnt)];
                const pad = 0;
                const bx = Math.max(0, x0 - pad), by = Math.max(0, y0 - pad);
                const bx1 = Math.min(W - 1, x1 + pad), by1 = Math.min(H - 1, y1 + pad);
                const mw = bx1 - bx + 1, mh = by1 - by + 1;
                const bin = new Uint8Array(mw * mh);
                for (let k = 0; k < cnt; k++) {
                  const lp = idxArr[k];
                  bin[(toY(lp) - by) * mw + (toX(lp) - bx)] = 1;
                }
                const clipMask = dilate(bin, mw, mh, pad);
                const cx0 = (x0 + x1) / 2, cy0 = (y0 + y1) / 2;
                if (cnt <= opts.resPatchMax) {         // 小点：并进"同色同格"的补丁笔（见 addPatch）
                  addPatch(col, bx, by, bx1, by1, mw, mh, bin, cx0, cy0, cnt);
                  added++;
                  continue;
                }
                const cIdx = pushClip(bx, by, mw, mh, clipMask);
                const dt = distanceTransform(bin, mw, mh);
                const dvals = Array.from(dt).sort((a, b) => a - b);
                const dmed = dvals[dvals.length >> 1];
                const half = clamp(dmed * opts.resHalfA + opts.resHalfB, opts.resMin * strokeScale, 8 * strokeScale);
                const sk2 = thin(bin, mw, mh).sk;
                const lp = longestPath(sk2, mw, mh);
                if (lp && lp.len >= 2) {
                  const absPath = new Float64Array(lp.len * 2);
                  for (let i = 0; i < lp.len; i++) {
                    absPath[i * 2] = lp.pts[i * 2] + bx;
                    absPath[i * 2 + 1] = lp.pts[i * 2 + 1] + by;
                  }
                  {
                    const segs = pathSegments(absPath, lp.len, Math.max(18, half * opts.segF));
                    const cols = [];
                    for (const sg of segs) {
                      if (sg.n < 2) { cols.push(null); continue; }
                      cols.push(sampleColor(ribbon(sg.pts, sg.n, half), sg.pts.length, bin, bx, by, mw, mh) || col);
                    }
                    let i2 = 0;
                    while (i2 < segs.length) {
                      let j2 = i2;
                      while (j2 + 1 < segs.length && cols[j2 + 1] && cols[i2] &&
                             Math.abs(cols[j2 + 1][0] - cols[i2][0]) +
                             Math.abs(cols[j2 + 1][1] - cols[i2][1]) +
                             Math.abs(cols[j2 + 1][2] - cols[i2][2]) < opts.segJoinCd) j2++;
                      const pts2 = [];
                      for (let k2 = i2; k2 <= j2; k2++) {
                        const P2 = segs[k2].pts;
                        for (let m2 = 0; m2 < P2.length; m2++) pts2.push(P2[m2]);
                      }
                      const arr2 = Float64Array.from(pts2);
                      if (arr2.length >= 4) {
                        const rb = ribbon(arr2, arr2.length / 2, half);
                        dbg.srcSite = 'resRibbon';
                        emitRaster(rb, arr2, arr2.length / 2, half, cols[i2] || col, 0, cIdx, phR);
                        added++;
                      }
                      i2 = j2 + 1;
                    }
                  }
                } else {                               // 没有骨架（奇形怪状的小块）：也并进补丁笔
                  addPatch(col, bx, by, bx1, by1, mw, mh, clipMask, cx0, cy0, cnt);
                  added++;
                }
              }
            }
          }
        }
        lap('r:tiles');
        flushBatch();          // 本轮攒下的补丁笔在这里落盘（像素结果与逐个补一致，只差半个色阶）
        lap('r:flush');
        nPieces += added;
        mark('残差' + (round + 1));
        // 一次算完"每像素最大通道差"和"可见差异计数"：dArr 留给下一轮的 skip 用
        let bad = 0;
        for (let i = 0; i < N; i++) {
          const d = Math.max(Math.abs(canvas[i * 3] - R[i]), Math.abs(canvas[i * 3 + 1] - G[i]), Math.abs(canvas[i * 3 + 2] - B[i]));
          dArr[i] = d;
          if (d > 8) bad++;
        }
        const pct = bad / N * 100;
        if (dbg.rounds) dbg.rounds.push({ r: round, thr, 补丁: added, 笔: nBatch(), 差异: +pct.toFixed(2), nPieces, max: opts.maxStrokes, inTail: inTail ? 1 : 0 });
        prog(0.78 + 0.2 * (round + 1) / opts.residual.length,
             (phR === 2 ? "收形补笔…" : "点睛补细节…") + " 第 " + (round + 1) + " 轮（" +
             nBatch() + " 笔，可见差异 " + pct.toFixed(2) + "%）");
        if (pct < 1.0) break;
        if (opts.resStop > 0 && prevPct - pct < opts.resStop && round >= 1) break;   // 收益变小就收手
        if (inTail && prevPct - pct < opts.resTailStop) break;    // 尾巴轮：收益掉到阈值以下就收手
        prevPct = pct;
        await yieldUI();
      }

      lap('residual');

      // ---- 8d) 题字落款（最后一拨细线）：贴在对象上的细线（猫嘴、字的描边）
      //      已经在铺色时跟着各自的对象画完了；这里只写"落在底上的"——
      //      题字、落款、印在底色上的小字，按行、按块一个个写出来。
      //      注意：这里仍按原来的顺序落色（补漏要看到已经写好的字，否则会把字当成白点重补）；
      //      回放时再把带 fin 标记的这几笔移到最末，见函数末尾的“回放编排”。
      prog(0.985, '题字落款…'); await yieldUI();
      drawInkSeq(inkLastSeq, (rec) => {
        rec.fin = 1;
        curStroke = strokes.length - 1;
        raster(rec.rib, rec.color, rec.c);
      }, 3);
      inkDrawn = true;
      mark('细线');

      // ---- 收尾补漏：残差补笔为了不把平滑渐变补成拼贴，设了"太小不补、太散不补"的门槛，
      //      贴着大片差异的小洞也会被连带跳过。这里分两类补，保证画面不留白点、白线：
      //      A) 真空白——画布上这块还是白的（什么都没画到），而原图不是白的；不论大小都补
      //      B) 剩余的"小块/细条"错误——用厚度判定，大而厚的块仍跳过（那是平涂风格化本身）
      if (opts.holeFill) {
        const errAt = (i) => Math.max(Math.abs(canvas[i * 3] - R[i]),
                                      Math.abs(canvas[i * 3 + 1] - G[i]),
                                      Math.abs(canvas[i * 3 + 2] - B[i]));
        const hp = makePool();
        // 补一个连通块：大洞贴着它的形状走一条（或几条）笔，小洞并进补丁笔（见 hp.add）
        const fillComp = (comp, comps2) => {
          const parts = [];
          splitPixByColor(comps2.pix.subarray(comp.start, comp.start + comp.count), comp.count, 0, parts);
          for (const pt of parts) fillPart(pt.pix, pt.cnt);
        };
        const fillPart = (pix, cnt) => {
          let x0 = W, y0 = H, x1 = -1, y1 = -1;
          let cr = 0, cg = 0, cb = 0;
          for (let k = 0; k < cnt; k++) {
            const p = pix[k];
            const x = p % W, y = (p - x) / W;
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
            cr += R[p]; cg += G[p]; cb += B[p];
          }
          const mw = x1 - x0 + 1, mh = y1 - y0 + 1;
          const bin = new Uint8Array(mw * mh);
          for (let k = 0; k < cnt; k++) {
            const p = pix[k];
            const x = p % W, y = (p - x) / W;
            bin[(y - y0) * mw + (x - x0)] = 1;
          }
          const col = [Math.round(cr / cnt), Math.round(cg / cnt), Math.round(cb / cnt)];
          // 小洞并进补丁笔：掩膜取并集、笔形取并集外框（外扩 0.5px）—— 一定盖满自己的掩膜，
          // 所以比"沿骨架走一笔"更稳（骨架笔在细缝/拐角会盖不到像素中心，那正是白点的老坑）。
          if (cnt <= opts.holeBatchMax) {
            hp.add(col, x0, y0, x1, y1, mw, mh, bin, (x0 + x1) / 2, (y0 + y1) / 2, cnt);
            return;
          }
          // 严格只覆盖"确实画错/没画"的那些像素，不外扩——否则会把周围本来正确的像素也刷成均值色
          const cIdx = pushClip(x0, y0, mw, mh, bin);
          const dt = distanceTransform(bin, mw, mh);
          const dvals = Array.from(dt).sort((a, b) => a - b);
          const dmed = dvals[dvals.length >> 1];
          const half = clamp(dmed + 1.2 * strokeScale, 1.6 * strokeScale, 9 * strokeScale);
          const sk3 = thin(bin, mw, mh).sk;
          const lp = longestPath(sk3, mw, mh);
          if (lp && lp.len >= 2) {
            const absPath = new Float64Array(lp.len * 2);
            for (let i = 0; i < lp.len; i++) {
              absPath[i * 2] = lp.pts[i * 2] + x0;
              absPath[i * 2 + 1] = lp.pts[i * 2 + 1] + y0;
            }
            // 一笔画长一点（笔数省），颜色按段取局部目标色（长条上颜色是渐变的，用一个均值色会不准）
            const segLen = Math.max(24, opts.holeSeg * strokeScale);
            const segs = pathSegments(absPath, lp.len, segLen);
            for (const sg of segs) {
              if (sg.n < 2) continue;
              const rb = ribbon(sg.pts, sg.n, half);
              const cSeg = sampleColor(rb, rb.length / 2, bin, x0, y0, mw, mh) || col;
              dbg.srcSite = 'holeRibbon';
              emitRaster(rb, sg.pts, sg.n, half, cSeg, cSeg[0] < 120 ? 1 : 0, cIdx, 3);
            }
          } else {
            const cx0 = (x0 + x1) / 2, cy0 = (y0 + y1) / 2;
            const rad = clamp(Math.hypot(mw, mh) / 2 + 1.2 * strokeScale, 2.2, 10);
            const poly = [];
            for (let k = 0; k < 13; k++) {
              const a = k / 13 * Math.PI * 2;
              poly.push(cx0 + rad * Math.cos(a), cy0 + rad * Math.sin(a));
            }
            dbg.srcSite = 'holeDab';
            emitRaster(poly, [cx0, cy0], 1, rad, col, 0, cIdx, 3);
          }
          // 自检：沿骨架走的笔形在细缝/拐角/极扁的形状上可能盖不到像素中心（画了等于没画）。
          // 对"自检后仍然是白的"那些像素，用方点笔形（严格掩膜）兜底——方框一定包含像素中心。
          const left = [];
          for (let k = 0; k < cnt; k++) {
            const p = pix[k];
            const mn = Math.min(canvas[p * 3], canvas[p * 3 + 1], canvas[p * 3 + 2]);
            if (mn >= opts.holeWhite) left.push(p);
          }
          if (left.length) {
            let lx0 = W, ly0 = H, lx1 = -1, ly1 = -1, lr = 0, lg = 0, lb = 0;
            for (const p of left) {
              const x = p % W, y = (p - x) / W;
              if (x < lx0) lx0 = x; if (x > lx1) lx1 = x;
              if (y < ly0) ly0 = y; if (y > ly1) ly1 = y;
              lr += R[p]; lg += G[p]; lb += B[p];
            }
            const lcol = [Math.round(lr / left.length), Math.round(lg / left.length), Math.round(lb / left.length)];
            const lw = lx1 - lx0 + 1, lh = ly1 - ly0 + 1;
            const b2 = new Uint8Array(lw * lh);
            for (const p of left) { const x = p % W, y = (p - x) / W; b2[(y - ly0) * lw + (x - lx0)] = 1; }
            const cIdx2 = pushClip(lx0, ly0, lw, lh, b2);
            const gx0 = lx0 - 1, gy0 = ly0 - 1, gx1 = lx1 + 2, gy1 = ly1 + 2;   // 外扩 1px，保证像素中心在框内
            const rect = [gx0, gy0, gx1, gy0, gx1, gy1, gx0, gy1];
            dbg.srcSite = 'holeRect';
            emitRaster(rect, [gx0, (gy0 + gy1) / 2, gx1, (gy0 + gy1) / 2], 2,
                       Math.max(1.6, lh / 2 + 1), lcol, 0, cIdx2, 3);
          }
        };
        const fillMask = (mask, limit, maxAdd, errFn) => {
          const base = strokes.length;
          const cc2 = compsOfLabels(mask, W, H);
          const list = [];
          for (let ci = 0; ci < cc2.comps.length; ci++) if (cc2.comps[ci].label === 1) list.push(ci);
          if (errFn) {
            // 给了误差函数就按"总误差量"排（面积 × 平均误差），而不是只按面积：
            // 只按面积排的话，"小而刺眼"的漏笔（30px 的深色条）会被几千个大块挤到预算外——
            // 收尾自检里剩下的白点/亮点就是这么漏掉的
            const score = new Float64Array(cc2.comps.length);
            for (const ci of list) {
              const c = cc2.comps[ci];
              let sc = 0;
              for (let k = 0; k < c.count; k++) sc += errFn(cc2.pix[c.start + k]);
              score[ci] = sc;
            }
            list.sort((a, b) => score[b] - score[a]);
          } else {
            list.sort((a, b) => cc2.comps[b].count - cc2.comps[a].count);   // 先补大块（同预算下总误差降得多）
          }
          // 选中之后改成沿希尔伯特序落笔：补谁不变，只是笔尖不再在全画面乱跳
          const sel = list.slice(0, limit);
          sel.sort((a, b) => {
            const ca = cc2.comps[a], cb = cc2.comps[b];
            return hilbertIndex((ca.x0 + ca.x1) >> 1, (ca.y0 + ca.y1) >> 1, 10) -
                   hilbertIndex((cb.x0 + cb.x1) >> 1, (cb.y0 + cb.y1) >> 1, 10);
          });
          let n = 0;
          for (const ci of sel) {
            if (maxAdd && strokes.length - base >= maxAdd) break;
            fillComp(cc2.comps[ci], cc2); n++;
          }
          return n;
        };
        // A0) 接缝修正：画布上"不该有的台阶"。
        //     逐像素差查不出它——台阶两侧各自只差 5~7，都没到可见阈值 8；
        //     可两块交界处画布是"一级台阶"、原图是平滑过渡，肉眼看就是一道弧线/一条缝
        //     （用户说的"贴纸式缝隙"就是这一类）。判据：画布这一步的台阶 >> 原图这一步的台阶。
        if (opts.seamFix) {
          const T3 = [R, G, B];
          const band = new Uint8Array(N);
          let anySeam = 0;
          for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
              const p = y * W + x;
              let sc = 0, st = 0;
              for (let d = 0; d < 4; d++) {
                const q = d === 0 ? (x + 1 < W ? p + 1 : -1)
                        : d === 1 ? (x > 0 ? p - 1 : -1)
                        : d === 2 ? (y + 1 < H ? p + W : -1)
                        : (y > 0 ? p - W : -1);
                if (q < 0) continue;
                for (let k = 0; k < 3; k++) {
                  const dc = Math.abs(canvas[p * 3 + k] - canvas[q * 3 + k]);
                  const dt = Math.abs(T3[k][p] - T3[k][q]);
                  if (dc > sc) sc = dc;
                  if (dt > st) st = dt;
                }
              }
              // 原图这一步本来就平滑（st 很小）而画布是硬台阶 ⇒ 这是我们自己画出来的缝
              if (sc >= opts.seamT && st <= opts.seamSmooth) { band[p] = 1; anySeam++; }
            }
          }
          let nS = 0;
          if (anySeam) {
            const bandD = dilate(band, W, H, opts.seamR);
            const m = new Uint8Array(N);
            for (let p = 0; p < N; p++) {
              if (bandD[p] && errAt(p) > opts.seamE) { m[p] = 1; nS++; }
            }
            if (nS) { fillMask(m, 4000, 6000); hp.flush(3); }
          }
          dbg.seam = { band: anySeam, fix: nS };
        }

        // A) 真白点：**画布上这块还是白的**（没人画上去），而原图明显不是白的。
        //    以前按"几何上有没有笔盖到"判定，问题是照片里"没盖到"的像素成千上万，
        //    而补漏是按连通块从大到小取的，真正刺眼的 1~2px 白点排在最后，被数量门槛丢掉。
        //    改成"画布看着白 + 原图不该白"（肉眼口径），并迭代到收敛。
        let nA = 0;
        for (let roundA = 0; roundA < 3; roundA++) {
          const m = new Uint8Array(N);
          let any = 0;
          for (let i = 0; i < N; i++) {
            const cmn = Math.min(canvas[i * 3], canvas[i * 3 + 1], canvas[i * 3 + 2]);
            const tmn = Math.min(R[i], G[i], B[i]);
            // 两类白点：
            // ① 纸面根本没被涂上（三通道都 ≥ holePaper）——只要原图不是纯白就要补，
            //    这样"全满的图"成品上就不会再有没有上色的地方（哪怕原图那里很浅）；
            // ② 只被抗锯齿毛边蹭到 / 被浅色笔盖错（≥ holeWhite 而原图明显更深）。
            // 门槛必须满足"原图 ≤ 画布"，否则补上目标色后仍然算白，会反复补、补不掉。
            if (!((cmn >= opts.holeWhite && tmn < opts.holeWhite - 16) ||    // 半覆盖/被浅色盖错
                  (cmn >= opts.holePaper && tmn < opts.holePaper - 8))) continue;   // "整块白纸"才算这一条
            m[i] = 1; any++;
          }
          if (!any) break;
          const got = fillMask(m, 20000, 12000);
          nA += got;
          hp.flush(3);            // 本轮并起来的补丁笔在这里落笔（下一轮重扫白点前必须落完）
          if (!got) break;
          await yieldUI();
        }
        // B) 剩余的小块/细条错误（A 补完后重新算，已经补上的不再重复）。
        //    这里的阈值放宽一倍：照片这类纹理区里，一小块错误用的是一个均值色，
        //    补上去对块内偏暗的一半反而更差，所以只补"明显不对"的那部分。
        let nB = 0;
        // 迭代几轮：每轮只补"总误差量"最大的那批，补掉之后再重算。
        // 只跑一轮的话，几十像素的深色漏笔永远排在几千个大块后面，预算一满就被丢掉
        // （收尾自检里剩下的亮点就是这么漏的）。
        for (let roundB = 0; roundB < (opts.holeRounds | 0); roundB++) {
          const thrB = clamp(opts.holeT * 2 * strokeScale, 32, 120);
          const m = new Uint8Array(N);
          let anyB = 0;
          for (let i = 0; i < N; i++) {
            const d2 = errAt(i);
            if (d2 <= thrB) continue;
            if (rampPix[i]) continue;                                            // 抗锯齿毛边：不描
            if (opts.resFlatTol > 0 && flatRng[i] <= opts.resFlatTol && d2 <= opts.resFlatErr) continue; // 平滑区的小台阶：不描
            m[i] = 1; anyB++;
          }
          if (!anyB) break;
          const cc2 = compsOfLabels(m, W, H);
          for (let ci = 0; ci < cc2.comps.length; ci++) {
            const c = cc2.comps[ci];
            if (c.label !== 1) continue;
            const thick = compThick(c, cc2.pix);      // 真实厚度（细环不会被误判成"厚"）
            if (c.count > opts.holeMax && thick > 4) {          // 又大又厚：平涂风格化，不补
              for (let k = 0; k < c.count; k++) m[cc2.pix[c.start + k]] = 0;
            }
          }
          const got = fillMask(m, 2500, 4200, errAt);
          nB += got;
          hp.flush(3);            // 本轮并起来的补丁笔在这里落笔（下一轮重算前必须落完）
          if (!got) break;
        }
        // C) 交界过渡带：两个色块硬碰硬的地方，目标图那一两像素是混色，
        //    我们画的是纯色，差值就是"可见差异"的主要来源——沿交界补上目标色本身
        let nC = 0;
        if (opts.edgeFill) {
          // 只在"两边颜色差得远"的交界上补：差得近的话混色像素本来就没多少误差，
          // 补上去只是把已经对的像素刷成中间色（实测会把平均差抬高）
          const colOf = new Map();
          for (const rg of regions) colOf.set(rg.cid, rg.color);
          const bigEdge = new Uint8Array(N);
          for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
              const p = y * W + x, c0 = compOf[p];
              let c1 = -1;
              if (x + 1 < W && compOf[p + 1] !== c0) c1 = compOf[p + 1];
              else if (y + 1 < H && compOf[p + W] !== c0) c1 = compOf[p + W];
              else if (x > 0 && compOf[p - 1] !== c0) c1 = compOf[p - 1];
              else if (y > 0 && compOf[p - W] !== c0) c1 = compOf[p - W];
              if (c1 < 0) continue;
              const A = colOf.get(c0), Bv = colOf.get(c1);
              if (!A || !Bv) continue;
              if (Math.abs(A[0] - Bv[0]) + Math.abs(A[1] - Bv[1]) + Math.abs(A[2] - Bv[2]) < opts.edgeCd) continue;
              bigEdge[p] = 1;
            }
          }
          const band = dilate(bigEdge, W, H, 1);
          const thrC = clamp(opts.edgeT * strokeScale, 6, 20);
          const m = new Uint8Array(N);
          let any = 0;
          for (let i = 0; i < N; i++) if (band[i] && errAt(i) > thrC) { m[i] = 1; any++; }
          if (any) { nC = fillMask(m, opts.edgeMax, 4200); hp.flush(3); }
        }
        if (nA || nB || nC) {
          let bad2 = 0;
          for (let i = 0; i < N; i++) if (errAt(i) > 8) bad2++;
          prog(0.995, `收尾补漏… 空白 ${nA} 处、碎块 ${nB} 处、交界 ${nC} 处（可见差异 ${(bad2 / N * 100).toFixed(2)}%）`);
          await yieldUI();
        }
      }

      // ---- 最后一公里：全图精修（只在最高还原档开）
      // 残差补笔每轮最多撒 6000 个补丁、收益一掉就收手，全图总有约 1% 的像素停在
      // "肉眼看得出来"的误差上。这里不再按轮次/厚度/保护带挑：把全图所有还差过
      // exactRepair 的像素按"格子 + 颜色桶"聚合，一整组用一条掩膜笔补上目标均值色。
      // 补完每个像素都不超过 exactRepair（掩膜笔是硬边、逐像素落色），成品与原图一致。
      if (opts.exactRepair > 0) {
        prog(0.996, '最后一公里：补最后 ' + opts.exactRepair + ' 级色差…'); await yieldUI();
        const T = opts.exactRepair;
        const CS = Math.max(16, opts.exactRepairCell | 0);
        const SH = Math.max(0, Math.min(7, opts.exactRepairShift | 0));
        const QB = 1 << (8 - SH);                       // 每通道的桶数
        const cellsX = Math.ceil(W / CS);
        const groups = new Map();
        let nWrong = 0;
        for (let y = 0; y < H; y++) {
          const row = y * W;
          for (let x = 0; x < W; x++) {
            const p = row + x;
            const dr = Math.abs(canvas[p * 3] - R[p]);
            const dg = Math.abs(canvas[p * 3 + 1] - G[p]);
            const db2 = Math.abs(canvas[p * 3 + 2] - B[p]);
            const d = dr > dg ? (dr > db2 ? dr : db2) : (dg > db2 ? dg : db2);
            if (d <= T) continue;
            const key = (((((y / CS) | 0) * cellsX + ((x / CS) | 0)) * QB + (R[p] >> SH)) * QB +
                         (G[p] >> SH)) * QB + (B[p] >> SH);
            let g = groups.get(key);
            if (!g) {
              g = { n: 0, r: 0, g: 0, b: 0, x0: x, y0: y, x1: x, y1: y, md: 0, pix: [] };
              groups.set(key, g);
            }
            g.n++; g.r += R[p]; g.g += G[p]; g.b += B[p];
            if (d > g.md) g.md = d;
            if (x < g.x0) g.x0 = x; else if (x > g.x1) g.x1 = x;
            if (y < g.y0) g.y0 = y; else if (y > g.y1) g.y1 = y;
            g.pix.push(p);
            nWrong++;
          }
        }
        // 先补最刺眼的：预算不够时，留下的也是看不出来的亚可见色差
        const arr = Array.from(groups.values());
        arr.sort((a, b) => b.md - a.md);
        const cap = Math.max(0, opts.exactRepairMax | 0);
        // 合并时的色差上限跟着目标走：T=2 时只允许完全同桶（tol=0），
        // 否则均值色漂移会把"补到 2 以内"重新拉回 3~4。
        const xpTol = T <= 2 ? 0 : (T <= 4 ? 1 : 2);
        const xp = makePool(CS, SH, xpTol, 128);
        let nX = 0;
        for (let gi = 0; gi < arr.length; gi++) {
          if (cap && nX >= cap) break;
          const g = arr[gi];
          const mw = g.x1 - g.x0 + 1, mh = g.y1 - g.y0 + 1;
          const bin = new Uint8Array(mw * mh);
          for (let k = 0; k < g.n; k++) {
            const p = g.pix[k];
            const x = p % W, y = (p - x) / W;
            bin[(y - g.y0) * mw + (x - g.x0)] = 1;
          }
          const col = [Math.round(g.r / g.n), Math.round(g.g / g.n), Math.round(g.b / g.n)];
          xp.add(col, g.x0, g.y0, g.x1, g.y1, mw, mh, bin,
                 (g.x0 + g.x1) / 2, (g.y0 + g.y1) / 2, g.n);
          nX++;
          if ((nX & 2047) === 0) {
            prog(0.996, '最后一公里… 已补 ' + nX + ' 组');
            await yieldUI();
          }
        }
        xp.flush(3);
        let bad24 = 0, mx = 0;
        for (let p = 0; p < N; p++) {
          const dr = Math.abs(canvas[p * 3] - R[p]);
          const dg = Math.abs(canvas[p * 3 + 1] - G[p]);
          const db2 = Math.abs(canvas[p * 3 + 2] - B[p]);
          const d = dr > dg ? (dr > db2 ? dr : db2) : (dg > db2 ? dg : db2);
          if (d > 24) bad24++;
          if (d > mx) mx = d;
        }
        dbg.exact = { T, groups: arr.length, patches: nX, wrong: nWrong,
                      可见: +(bad24 / N * 100).toFixed(3), 最大: mx };
        prog(0.998, '精修完成（可见差异 ' + (bad24 / N * 100).toFixed(2) + '%）');
        await yieldUI();
      }

      lap('holes');
      keysOut.push({ i: strokes.length, rgb: canvas.slice() });
      visCanvas = canvas;
      keysRgb = keysOut;
    }

    // 兜底：上面那段没跑（既不要 canvas 也不要关键帧）时，题字层也得画上
    if (!inkDrawn) {
      prog(0.985, '题字落款…'); await yieldUI();
      drawInkSeq(inkLastSeq, (rec) => { rec.fin = 1; }, 3);
      mark('细线');
    }

    mark('补漏');
    // ---- 收尾：删掉"一笔都没留下"的笔 ----
    // 一笔画上去的像素如果全被后面的笔盖住了，删掉它成品**像素级不变**，
    // 但回放里就少一次"在同一个地方又点一下"的多余动作（用户说的"多余不用的笔画"）。
    // 判据来自上面关键帧回放时顺手记的"最后画上每个像素的笔号"（跟网页端同一套光栅口径）。
    // ⚠️ 必须同时看 opts.dropDead：deadScan 现在 debug 下也会分配（诊断要用），
    // 但"删笔+重排笔号"只能 dropDead 打开时做——否则诊断跑里 from/to/gapAt/layerEnds
    // 这些按笔号的记账会全部错位（踩过一次：覆盖率读数整个失真）。
    if (deadScan && opts.dropDead) {
      const alive = new Uint8Array(strokes.length);
      let nAlive = 0;
      for (let p = 0; p < N; p++) { const i2 = deadScan[p]; if (i2 >= 0 && !alive[i2]) { alive[i2] = 1; nAlive++; } }
      // 判据升级（2026-10-18）：光"在最终画布上零贡献"不够——一笔可能"落笔时画上了、后来被
      // 别的图层盖掉"（它在回放里真的画过一笔），删了就在那一层刚画完时留个洞（底色层实测
      // 19 笔、7623 个白点 = 用户看到的"底色没涂满"）。凡是曾被别的层盖过的笔（raster 里打
      // 了 prot）一律保留；被本层后来的笔随手压过去的照删，省笔的收益保住。
      for (let i2 = 0; i2 < strokes.length; i2++) if (!alive[i2] && strokes[i2].prot) { alive[i2] = 1; nAlive++; }
      const nDrop = strokes.length - nAlive;
      dbg.deadDrop = nDrop; dbg.deadProt = strokes.filter((s2) => s2.prot).length;
      if (nDrop > 0) {
        // 关键帧索引重映射：新序号 = 它前面还剩几笔
        const pre = new Int32Array(strokes.length + 1);
        for (let i2 = 0; i2 < strokes.length; i2++) pre[i2 + 1] = pre[i2] + alive[i2];
        if (keysRgb) for (const k1 of keysRgb) k1.i = pre[k1.i];
        if (dbg.marks) for (const m1 of dbg.marks) m1.n = pre[m1.n];
        // 裁剪掩膜去重压缩：没有笔再引用的掩膜一并丢掉（省网页端内存）
        const cMap = new Int32Array(clips.length).fill(-1);
        const clips2 = [];
        let w2 = 0;
        for (let i2 = 0; i2 < strokes.length; i2++) {
          if (!alive[i2]) continue;
          const st2 = strokes[i2];
          if (cMap[st2.c] < 0) { cMap[st2.c] = clips2.length; clips2.push(clips[st2.c]); }
          st2.c = cMap[st2.c];
          strokes[w2++] = st2;
        }
        strokes.length = w2;
        clips.length = 0;
        for (const c2 of clips2) clips.push(c2);
        dbg.dropped = nDrop;
        dbg.clipsBefore = clips2.length;
      }
    }
    // 笔数分解收尾：铺色笔按"区块面积"归类（看小碎块到底贡献了多少笔）
    {
      const cnt = new Array(areaBins.length - 1).fill(0);
      for (const s2 of strokes) {
        if (s2.r < 0) continue;
        const a = regions[s2.r] ? regions[s2.r].area : 0;
        for (let b = 0; b < cnt.length; b++) if (a >= areaBins[b] && a < areaBins[b + 1]) { cnt[b]++; break; }
      }
      dbg.timing = T;
      dbg.sweepByArea = cnt;
      dbg.sweep = { regions: sweepRegions, passes: passTotal, maxPass: passMax };
    }

    // 时长归一：先按 targetSec 分配相对权重（网页端还会把"抬笔移动"的时间算进来再分一次）
    {
      let tot = 0;
      for (const st1 of strokes) tot += st1.ms;
      const k = tot > 0 ? (opts.targetSec * 1000) / tot : 1;
      for (const st1 of strokes) st1.ms = Math.round(Math.max(6, st1.ms * k) * 10) / 10;
    }

    // 回放编排：题字/落款是在补漏前落色的（补漏必须看到已经写好的字，否则会把字当成白点重补），
    // 但把这几笔的记录移到最末——回放最后看到的是几笔看得见的字，而不是一堆微补丁。
    // 只改 strokes 的顺序，不改任何像素、不改笔数；dropDead / keys / clips 都已在上一步处理完。
    if (!opts.debug) {                 // debug 跑要保留原始顺序，deadScan/marks 才对得上
      let nFin = 0;
      for (const st1 of strokes) if (st1.fin) nFin++;
      if (nFin) {
        const fin = [];
        let w = 0;
        for (let i = 0; i < strokes.length; i++) {
          const st1 = strokes[i];
          if (st1.fin) fin.push(st1); else strokes[w++] = st1;
        }
        strokes.length = w;
        for (const st1 of fin) strokes.push(st1);
      }
    }

    prog(1.0, '完成');
    if (opts.debug && deadScan) dbg.deadScan = deadScan;   // 诊断用：像素 → 最后画上它的笔号（管线自己的口径）
    return {
      W, H, strokes, clips,
      canvasRgb: opts.returnCanvas ? visCanvas : undefined,
      keys: opts.returnKeys ? keysRgb : undefined,
      palette: opts.debug ? pal.map((c) => [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])]) : undefined,
      dbg: opts.debug ? dbg : undefined,
      probe: opts.probe ? (() => {
        const p0 = opts.probe.y * W + opts.probe.x;
        const ci = compOf[p0];
        const ri = regions.findIndex((r) => r.cid === ci);
        const rg = regions[ri];
        return rg ? { cid: ci, ri, area: rg.area, bbox: [rg.x0, rg.y0, rg.x1, rg.y1], hp: Math.round(rg.hp),
                      color: rg.color, isLine: isInk[ri], strokesOfRegion: strokes.filter((st) => st.r === ri).length }
                  : { cid: ci, missing: true };
      })() : undefined,
      stats: {
        regions: regions.length,
        inkGroups: inkClips.length,
        strokes: strokes.length,
        totalMs: strokes.reduce((a, s) => a + s.ms, 0),
        phases: [0, 1, 2, 3].map((ph) => strokes.filter((s) => s.ph === ph).length),
        colors: opts.colors,
        photo: !!opts.photoMode,
        style: opts.style,
        detail: opts.detail,       // 老字段保留
        fidelity: fid,
      },
    };
  }

  root.ISP_PIPELINE = { run, CFG, _u: { ribbon, ribbonProf, fillPoly, fillPolyCov, distanceTransform, thin, longestPath, compsOfLabels, dilate, erode, closeMask, closeMaskDisk, rdpSimplify, mergeLoops } };
})(typeof self !== 'undefined' ? self : globalThis);
