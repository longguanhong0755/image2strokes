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
  function srgb2lab(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    r = r > 0.04045 ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
    g = g > 0.04045 ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
    b = b > 0.04045 ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;
    let X = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
    let Y = (r * 0.2126 + g * 0.7152 + b * 0.0722);
    let Z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    X = f(X); Y = f(Y); Z = f(Z);
    return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
  }

  // ---------------- 多边形扫描线填充（偶奇），写入 bbox 局部掩膜 ----------------
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
      for (let i = 0; i < n; i++) {
        const L = samples[i * 3], A = samples[i * 3 + 1], B = samples[i * 3 + 2];
        let best = 0, bd = Infinity;
        for (let k = 0; k < K; k++) {
          const dL = L - cen[k * 3], dA = A - cen[k * 3 + 1], dB = B - cen[k * 3 + 2];
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
    occlude: true,          // 每层补出"被上层盖住的部分"（形状闭合推断）；照片类纹理太碎时关掉更干净
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
    detail: 1,              // 细节档：0 快看 / 1 标准 / 2 慢工出细活
  };

  function regionMaskOf(compOf, W, compId, x0, y0, x1, y1) {
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const m = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) m[y * w + x] = compOf[(y + y0) * W + (x + x0)] === compId ? 1 : 0;
    }
    return { w, h, m };
  }

  async function run(px, W, H, opts, onProgress) {
    opts = Object.assign({}, CFG, opts || {});
    CAPFIX = opts.capFix !== false;
    PROF_FLAT_SAMPLE = opts.profFlatSample !== false;
    // 细节档：只影响"补笔要补多细"，不影响主笔触的取色逻辑
    if (opts.detail === 0) {
      Object.assign(opts, { residual: [30, 24, 18, 14], holeT: 40, resMin: 1.2, sketchMax: 40, edgeFill: false });
    } else if (opts.detail === 2) {
      Object.assign(opts, { residual: [30, 24, 18, 14, 11, 9, 7, 5.5], holeT: 22, resMin: 0.8,
                            resHalfA: 0.85, resHalfB: 0.55, sketchMax: 76, sketchGrid: 5, edgeT: 8 });
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
        Rs = box3(box3(Rs, W, H), W, H);
        Gs = box3(box3(Gs, W, H), W, H);
        Bs = box3(box3(Bs, W, H), W, H);
      }
      var texFracOut = texFrac;
      // 照片自动模式：纹理强的图（照片/扫描件）单独一套参数——
      // 色数提上去、笔更细、允许更多笔，不然平涂会把纹理糊成一格一格的色块。
      if (texFrac > 0.06) {
        opts.photoMode = true;
        // 实测（照片样张）：40 色比 32 色可见差异 35.03% → 34.63%，笔数还略少；再往上加轮数没收益
        if (!opts.colors && opts.autoColors) opts.colors = texFrac > 0.14 ? 44 : 40;
        if (opts.maxStrokes === CFG.maxStrokes) opts.maxStrokes = 40000;
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
    for (let i = 0; i < N; i += step) {
      const lab = srgb2lab(Rs[i], Gs[i], Bs[i]);
      samp[ns * 3] = lab[0]; samp[ns * 3 + 1] = lab[1]; samp[ns * 3 + 2] = lab[2];
      ns++;
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
    // 中心 → 代表 RGB（用该中心附近的像素均值）
    {
      const accR = new Float64Array(pal.length), accG = new Float64Array(pal.length),
            accB = new Float64Array(pal.length), cnt = new Float64Array(pal.length);
      for (let i = 0; i < N; i++) {
        const lab = srgb2lab(Rs[i], Gs[i], Bs[i]);
        let best = 0, bd = Infinity;
        for (let k = 0; k < K; k++) {
          const dL = lab[0] - cen[k * 3], dA = lab[1] - cen[k * 3 + 1], dB = lab[2] - cen[k * 3 + 2];
          const d = dL * dL + dA * dA + dB * dB;
          if (d < bd) { bd = d; best = k; }
        }
        const p = pai[best];
        accR[p] += R[i]; accG[p] += G[i]; accB[p] += B[i]; cnt[p]++;
      }
      for (let p = 0; p < pal.length; p++) {
        if (cnt[p] > 0) { pal[p][0] = accR[p] / cnt[p]; pal[p][1] = accG[p] / cnt[p]; pal[p][2] = accB[p] / cnt[p]; }
      }
    }
    prog(0.16, '分块…'); await yieldUI();

    // 3) 全图归类
    const labels = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const lab = srgb2lab(Rs[i], Gs[i], Bs[i]);
      let best = 0, bd = Infinity;
      for (let k = 0; k < K; k++) {
        const dL = lab[0] - cen[k * 3], dA = lab[1] - cen[k * 3 + 1], dB = lab[2] - cen[k * 3 + 2];
        const d = dL * dL + dA * dA + dB * dB;
        if (d < bd) { bd = d; best = k; }
      }
      labels[i] = pai[best];
    }

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
      for (let round = 0; round < 2; round++) {
        const votes = new Map();
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
          votes.clear();
          for (let k = 0; k < c.count; k++) {
            const p = pix[c.start + k];
            const x = p % W, y = (p - x) / W;
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                if (!dx && !dy) continue;
                const xx = x + dx, yy = y + dy;
                if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
                const cj = find(compOf[yy * W + xx]);
                if (cj === ci) continue;
                votes.set(cj, (votes.get(cj) || 0) + 1);
              }
            }
          }
          let bestJ = -1, bestScore = -1;
          for (const [cj, v] of votes) {
            const pj = pal[comps[cj].label], pi = pal[c.label];
            const cd = Math.hypot(pj[0] - pi[0], pj[1] - pi[1], pj[2] - pi[2]);
            const score = v / (1 + cd * 0.5);
            if (score > bestScore) { bestScore = score; bestJ = cj; }
          }
          if (bestJ < 0) { nNoVote++; continue; }
          const pj = pal[comps[bestJ].label], pi = pal[c.label];
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
        r = clamp(Math.round(r * 0.8), 3, 26);
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
        const cl = closeMask(sub, bw, bh, r);
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
        for (let it = 0; it < 4; it++) {          // 整体平滑几遍：灌出来的硬边、区块之间的色阶差都抹平
          const nr = new Float32Array(cr), ng = new Float32Array(cg), nb = new Float32Array(cb);
          for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
              const p = y * W + x;
              let sr = 0, sg = 0, sb = 0, cnt = 0;
              for (let dy = -1; dy <= 1; dy++) {
                const yy = y + dy; if (yy < 0 || yy >= H) continue;
                for (let dx = -1; dx <= 1; dx++) {
                  const xx = x + dx; if (xx < 0 || xx >= W) continue;
                  const q = yy * W + xx;
                  sr += cr[q]; sg += cg[q]; sb += cb[q]; cnt++;
                }
              }
              nr[p] = sr / cnt; ng[p] = sg / cnt; nb[p] = sb / cnt;
            }
          }
          cr.set(nr); cg.set(ng); cb.set(nb);
        }
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
        if (st.area > 600 && !(opts.thinNoErode && st.linear)) {
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
        let sealed = false;
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
          sealed = paintSweep(oi, full, sampleM);
        }
        tick(st.linear ? 'lines' : 'sweep');
        // 落笔前已经做过联合覆盖自检、缝也补平了 ⇒ 这里的"事后自检"就没活干了，
        // 直接跳过（它要把这一层的笔再光栅化一遍，很贵）
        if (!sealed) layerCheck(oi, full, st.from);
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
            if (al >= 0.995) {
              canvas[pp * 3] = color[0]; canvas[pp * 3 + 1] = color[1]; canvas[pp * 3 + 2] = color[2];
            } else {
              canvas[pp * 3] = canvas[pp * 3] * (1 - al) + color[0] * al;
              canvas[pp * 3 + 1] = canvas[pp * 3 + 1] * (1 - al) + color[1] * al;
              canvas[pp * 3 + 2] = canvas[pp * 3 + 2] * (1 - al) + color[2] * al;
            }
          }
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
            canvas[pp * 3] = color[0]; canvas[pp * 3 + 1] = color[1]; canvas[pp * 3 + 2] = color[2];
          }
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
      const CEL = Math.max(16, opts.patchCell | 0);
      const makePool = () => {
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
            const sh = opts.patchTol > 0 ? Math.min(7, opts.patchShift + 1) : opts.patchShift;
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
            const BX = opts.patchBox;
            let g = null, gArea = Infinity;
            let nCand = 0, nBox = 0, nTol = 0;
            for (let li = 0; li < list.length; li++) {
              const gg = list[li];
              const bw = Math.max(gg.x1, x1) - Math.min(gg.x0, x0) + 1;
              const bh = Math.max(gg.y1, y1) - Math.min(gg.y0, y0) + 1;
              nCand++;
              if (bw > BX || bh > BX) { nBox++; continue; }
              if (opts.patchTol > 0) {   // 与组均值色的曼哈顿距离上限（超了就不许并）
                const d = Math.abs(col[0] - gg.cr / gg.cn) + Math.abs(col[1] - gg.cg / gg.cn) +
                          Math.abs(col[2] - gg.cb / gg.cn);
                if (d > opts.patchTol) { nTol++; continue; }
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
          const wrongAll = new Uint8Array(N);
          for (let i2 = 0; i2 < N; i2++) {
            const d2 = Math.max(Math.abs(canvas[i2 * 3] - R[i2]),
                                Math.abs(canvas[i2 * 3 + 1] - G[i2]),
                                Math.abs(canvas[i2 * 3 + 2] - B[i2]));
            if (d2 > thr) wrongAll[i2] = 1;
          }
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
                if (d > thr && !skip[pp] && !(opts.resSkipInk && inkPix[pp]) && !(opts.resSkipRamp && rampPix[pp]) &&
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
        let bad = 0;
        for (let i = 0; i < N; i++) {
          const d = Math.max(Math.abs(canvas[i * 3] - R[i]), Math.abs(canvas[i * 3 + 1] - G[i]), Math.abs(canvas[i * 3 + 2] - B[i]));
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

      // ---- 8d) 题字落款（最后一拨细线）：贴在对象上的细线（猫嘴、字的描边）
      //      已经在铺色时跟着各自的对象画完了；这里只写"落在底上的"——
      //      题字、落款、印在底色上的小字，按行、按块一个个写出来。
      lap('residual');
      prog(0.985, '题字落款…'); await yieldUI();
      drawInkSeq(inkLastSeq, (rec) => { curStroke = strokes.length - 1; raster(rec.rib, rec.color, rec.c); });
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

      lap('holes');
      keysOut.push({ i: strokes.length, rgb: canvas.slice() });
      visCanvas = canvas;
      keysRgb = keysOut;
    }

    // 兜底：上面那段没跑（既不要 canvas 也不要关键帧）时，题字层也得画上
    if (!inkDrawn) {
      prog(0.985, '题字落款…'); await yieldUI();
      drawInkSeq(inkLastSeq, null);
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
        detail: opts.detail,
      },
    };
  }

  root.ISP_PIPELINE = { run, CFG, _u: { ribbon, ribbonProf, fillPoly, fillPolyCov, distanceTransform, thin, longestPath, compsOfLabels, dilate, erode, closeMask, rdpSimplify, mergeLoops } };
})(typeof self !== 'undefined' ? self : globalThis);
