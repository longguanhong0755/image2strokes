/* 图片 → 绘制脚本管线的"纯工具"层：几何 / 掩膜 / 骨架 / 笔形 / 聚类。
 *
 * 这些函数只吃参数、不碰图像状态（唯一的开关是 api.cfg.capfix，等价于旧的 CAPFIX），
 * 所以可以从 pipeline.js 里单独拆出来，被分色、分区、铺色、补漏各个阶段共用。
 *
 * 加载顺序：engine.js 里 importScripts 先加载本文件，再加载 pipeline.js；
 * pipeline.js 被单独 import（Node 里的调试脚本）时，会自己 import 本文件补上。
 */
(function (root) {
  'use strict';

  const api = {};
  api.cfg = { capfix: true };   // ribbonProf 端头扫正前方（见 ribbonProf 注释）

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
      const a = api.cfg.capfix ? ea + Math.PI / 2 - Math.PI * k / 5 : ea + Math.PI * k / 5;
      out.push(ex + hw1 * Math.cos(a), ey + hw1 * Math.sin(a));
    }
    for (let i = n - 1; i >= 0; i--) out.push(right[i * 2], right[i * 2 + 1]);
    const hw0 = halfs[0];
    const sa = Math.atan2(dir[1], dir[0]);
    for (let k = 1; k <= 4; k++) {
      const a = api.cfg.capfix ? sa - Math.PI / 2 - Math.PI * k / 5 : sa - Math.PI * k / 5;
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

  function regionMaskOf(compOf, W, compId, x0, y0, x1, y1) {
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const m = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) m[y * w + x] = compOf[(y + y0) * W + (x + x0)] === compId ? 1 : 0;
    }
    return { w, h, m };
  }

  // ---- 导出 ----
  api.clamp = clamp;
  api.luma = luma;
  api.rand01 = rand01;
  api.chainNN = chainNN;
  api.hilbertIndex = hilbertIndex;
  api.LABF = LABF;
  api.srgb2labInto = srgb2labInto;
  api.srgb2lab = srgb2lab;
  api.fillEnclosedHoles = fillEnclosedHoles;
  api.fillPoly = fillPoly;
  api.fillPolyCov = fillPolyCov;
  api.distanceTransform = distanceTransform;
  api.dilate = dilate;
  api.erode = erode;
  api.rdpSimplify = rdpSimplify;
  api.closeMask = closeMask;
  api.closeMaskDisk = closeMaskDisk;
  api.compsOfLabels = compsOfLabels;
  api.thin = thin;
  api.longestPath = longestPath;
  api.ribbon = ribbon;
  api.ribbonProf = ribbonProf;
  api.mergeLoops = mergeLoops;
  api.med3 = med3;
  api.box3 = box3;
  api.feather = feather;
  api.kmeans = kmeans;
  api.regionMaskOf = regionMaskOf;

  root.ISP_PIPELINE_UTIL = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
