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
    const used = new Uint8Array(n);
    let cx = sx, cy = sy;
    for (let k = 0; k < n; k++) {
      let best = -1, bd = Infinity;
      for (let i = 0; i < n; i++) {
        if (used[i]) continue;
        const p = posOf(items[i]);
        const d = (p[0] - cx) * (p[0] - cx) + (p[1] - cy) * (p[1] - cy);
        if (d < bd) { bd = d; best = i; }
      }
      used[best] = 1;
      out[k] = items[best];
      const p = posOf(items[best]);
      cx = p[0]; cy = p[1];
    }
    return out;
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
  function thin(bin, w, h) {
    const im = bin.slice();
    let changedTotal = false;
    for (let iter = 0; iter < 100; iter++) {
      let changed = false;
      for (let step = 0; step < 2; step++) {
        const del = [];
        for (let y = 1; y < h - 1; y++) {
          for (let x = 1; x < w - 1; x++) {
            const i = y * w + x;
            if (!im[i]) continue;
            const p2 = im[i - w], p3 = im[i - w + 1], p4 = im[i + 1], p5 = im[i + w + 1],
                  p6 = im[i + w], p7 = im[i + w - 1], p8 = im[i - 1], p9 = im[i - w - 1];
            const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
            if (B < 2 || B > 6) continue;
            const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
            let A = 0;
            for (let k = 0; k < 8; k++) if (seq[k] === 0 && seq[k + 1] === 1) A++;
            if (A !== 1) continue;
            if (step === 0) {
              if (p2 * p4 * p6 !== 0) continue;
              if (p4 * p6 * p8 !== 0) continue;
            } else {
              if (p2 * p4 * p8 !== 0) continue;
              if (p2 * p6 * p8 !== 0) continue;
            }
            del.push(i);
          }
        }
        if (del.length) {
          for (const i of del) im[i] = 0;
          changed = true;
        }
      }
      if (changed) changedTotal = true; else break;
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
  function ribbon(path, n, halfW) {
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
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      let dx = path[b * 2] - path[a * 2], dy = path[b * 2 + 1] - path[a * 2 + 1];
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
    // 末端圆头
    const ex = path[(n - 1) * 2], ey = path[(n - 1) * 2 + 1];
    const ea = Math.atan2(dir[(n - 1) * 2 + 1], dir[(n - 1) * 2]);
    for (let k = 1; k <= 4; k++) {
      const a = ea + Math.PI * k / 5;
      out.push(ex + halfW * Math.cos(a), ey + halfW * Math.sin(a));
    }
    for (let i = n - 1; i >= 0; i--) out.push(right[i * 2], right[i * 2 + 1]);
    const sa = Math.atan2(dir[1], dir[0]);
    for (let k = 1; k <= 4; k++) {
      const a = sa - Math.PI * k / 5;
      out.push(path[0] + halfW * Math.cos(a), path[1] + halfW * Math.sin(a));
    }
    return out;
  }

  // 变宽走廊：halfs[i] 是第 i 个点处的半宽（起笔细→中间粗→收笔细，像有笔压）
  function ribbonProf(path, n, halfs) {
    if (n === 1) return ribbon(path, 1, halfs[0]);
    const dir = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      let dx = path[b * 2] - path[a * 2], dy = path[b * 2 + 1] - path[a * 2 + 1];
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
    const ex = path[(n - 1) * 2], ey = path[(n - 1) * 2 + 1], hw1 = halfs[n - 1];
    const ea = Math.atan2(dir[(n - 1) * 2 + 1], dir[(n - 1) * 2]);
    for (let k = 1; k <= 4; k++) {
      const a = ea + Math.PI * k / 5;
      out.push(ex + hw1 * Math.cos(a), ey + hw1 * Math.sin(a));
    }
    for (let i = n - 1; i >= 0; i--) out.push(right[i * 2], right[i * 2 + 1]);
    const hw0 = halfs[0];
    const sa = Math.atan2(dir[1], dir[0]);
    for (let k = 1; k <= 4; k++) {
      const a = sa - Math.PI * k / 5;
      out.push(path[0] + hw0 * Math.cos(a), path[1] + hw0 * Math.sin(a));
    }
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
    maxSide: 1024,
    colors: 32,
    mergeThr: 9.0,          // Lab 距离，小于它合并（对渐变友好）
    minArea: 120,           // 小于它的小碎块并入邻块（越小分区越细，笔数越多）
    targetSec: 240,         // 回放总时长（1× 速度）
    bleedFirst: 0,          // 每个区块第一遍"铺底"允许外扩的像素（0 = 严格裁形，保真优先）
    resThick: 8,            // 补笔忽略"又大又厚"的错误块（那是平涂风格本身的平滑差异）
    inkLuma: 195,
    coverOk: 0.86,
    residual: [30, 24, 18, 14, 11, 9, 7],
    absorbCd: 60,           // 碎块并入邻块的颜色阈值（Lab/RGB 距离）
    resHalfA: 0.95, resHalfB: 0.7, resMin: 1.0,   // 补笔半宽 = dmed*A + B
    maxStrokes: 13000,      // 总笔数上限（照片类纹理太碎时保护）
    returnKeys: true,       // 生成关键帧（网页端拖动进度用）
    keyFrames: 5,
    resStop: 0,             // 补笔收益阈值（0 = 不提前收手，把 7 轮补完）
    localColor: true,       // 主笔触按段取局部纯色（更贴近原图渐变）
    dilMain: 3,             // 主笔允许溢出 3px（自然覆盖，后画的会盖住）
    dilInk: 0,              // 勾线层不向外扩边：它现在画在铺色之后，扩边会留下压不回去的深色描边
    // --- "像人在画"的相关参数 ---
    sketch: true,           // 起稿阶段：先沿主要轮廓轻勾一遍（后面会被铺色盖住）
    sketchMax: 56,          // 起稿最多勾多少条轮廓
    sketchHalf: 1.5,        // 起稿线半宽（乘 strokeScale）
    sketchMix: 0.45,        // 起稿色 = 局部目标色 与 铅笔灰 的混合比例
    bleedP: 0.22,           // 多少比例的铺色笔允许"画出界"，后面再被覆盖修回
    bleedR: 2,              // 出界的像素半径
    featherRaster: false,   // 光栅口径：false = 硬边（和网页端一致）；true = 羽化（只用于对比实验）
    organic: true,          // 单笔形态人性化：弧线 + 手抖 + 宽窄起伏
    inkEarly: false,        // 调试开关：勾线层放到铺色之前（默认 "铺色 → 勾线收形"，见 README 的坑 4）
    holeFill: true,         // 收尾补漏：把"还是没画上"的小洞逐个补掉（残差补笔有"太小/太散不补"的门槛）
    holeT: 28,              // 补漏的判定阈值（单通道差）
    holeWhite: 244,         // "看着是白的"门槛（这一类补验：原图明显更深的）
    holePaper: 254,         // "纸面根本没涂上"门槛（三通道都 ≥ 它 = 那像素还是白纸），原图比它深 8 以上就补
    holeMax: 420,           // 只补这么大的洞（像素数）；更大的块属于平涂风格化，补了会花
    holeSeg: 48,            // 补漏一笔画多长（越长笔数越省）
    // --- 交界过渡带（实测负收益，默认关；见 README 的坑 5）---
    edgeFill: false,        // 沿色块交界补"中间色"细笔：边界像素在目标图里大多本来就是纯色，补了反而更差
    edgeT: 10,              // 交界过渡带的阈值（单通道差）
    edgeCd: 60,             // 只补"两边颜色差得远"的交界（RGB 曼哈顿距离）
    edgeMax: 3200,          // 最多补多少处
    edgeSeg: 40,            // 过渡带一笔多长
    // --- 笔形/笔宽（风格预设会覆盖） ---
    bwF: 0.16, bwMin: 9, bwMax: 46, coverOv: 0.62,      // 笔宽 = 块厚×bwF，限幅；档间重叠 coverOv
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
        if (!opts.colors && opts.autoColors) opts.colors = texFrac > 0.14 ? 36 : 32;
        if (opts.maxStrokes === CFG.maxStrokes) opts.maxStrokes = 26000;
        if (opts.minArea === CFG.minArea) opts.minArea = texFrac > 0.14 ? 90 : 110;
        if (opts.bwF === CFG.bwF) { opts.bwF = 0.12; opts.bwMin = 7; }
        if (opts.coverOv === CFG.coverOv) opts.coverOv = 0.58;
      }
    }
    // 自动色数（插画类也走这里：没指定颜色数就按纹理强弱给个合适的）
    if (!opts.colors && opts.autoColors) opts.colors = 24;
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
    {
      const parent = new Int32Array(comps.length);
      for (let i = 0; i < comps.length; i++) parent[i] = i;
      const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
      let nSmall = 0, nMerged = 0, nNoVote = 0, nFar = 0, nNaN = 0;
      for (let round = 0; round < 2; round++) {
        const votes = new Map();
        for (let ci = 0; ci < comps.length; ci++) {
          if (find(ci) !== ci) continue;
          const c = comps[ci];
          if (c.count >= opts.minArea) continue;
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
          if (c.count < 6 || cd <= opts.absorbCd) { parent[ci] = bestJ; nMerged++; } else nFar++;
        }
      }
      if (opts.debug) console.log(`[absorb] comps=${comps.length} small=${nSmall} merged=${nMerged} noVote=${nNoVote} far=${nFar} nan=${nNaN} pal=${pal.length}`);
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
      let sr = 0, sg = 0, sb = 0;
      for (let k = 0; k < n; k++) {
        const p = pix[c.start + k];
        sr += R[p]; sg += G[p]; sb += B[p];
      }
      const color = [sr / n, sg / n, sb / n];
      regions.push({
        cid: ci, x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, area: n,
        cx, cy, ax, ay, tmin, tmax, hp: Math.max(1, vmax),
        color: [Math.round(color[0]), Math.round(color[1]), Math.round(color[2])],
        pix0: c.start, pix1: c.start + n - 1,
      });
    }

    // 7) 线稿区块（深 + 细）→ 并集
    const inkBin = new Uint8Array(N);
    const isInk = new Uint8Array(regions.length);
    const dbg = { dark: 0, darkThin: 0, pal: [], cen: cenRaw, tex: texFracOut, smallLeft: regions.filter((r) => r.area < opts.minArea).length };
    const scale = W / 1024;
    const thinLimit = 6.5 * scale;
    for (let ri = 0; ri < regions.length; ri++) {
      const rg = regions[ri];
      if (rg.area < 12) continue;
      const bwW = rg.x1 - rg.x0 + 1, bwH = rg.y1 - rg.y0 + 1;
      const bin = new Uint8Array(bwW * bwH);
      for (let k = 0; k < rg.area; k++) {
        const p = pix[rg.pix0 + k];
        const x = p % W, y = (p - x) / W;
        bin[(y - rg.y0) * bwW + (x - rg.x0)] = 1;
      }
      const dt = distanceTransform(bin, bwW, bwH);
      let dmax = 0;
      for (let i = 0; i < dt.length; i++) if (dt[i] > dmax) dmax = dt[i];
      const maxr = Math.min(dmax, 0.5 * Math.min(bwW, bwH), 14 * scale) + 1.8 * scale;
      dbg.dark++;
      if (maxr <= thinLimit) {
        dbg.darkThin++;
        isInk[ri] = 1;
        for (let k = 0; k < rg.area; k++) inkBin[pix[rg.pix0 + k]] = 1;
      }
    }
    prog(0.38, '提笔勾线…'); await yieldUI();

    // 8) 笔触生成
    const strokes = [];       // {rib,tp,color,pen,ms,c(裁剪组),r(区块),ph(阶段)}
    const lastPen = { x: 0, y: 0 };   // 笔尖当前位置：铺色顺序按"就近"串起来
    // 阶段：0 起稿（轻勾轮廓） 1 铺色（大块优先→收小） 2 收形（勾线+中等补笔） 3 点睛（细补笔）
    let visCanvas = null;     // 调试/测试用：最终纯色光栅结果
    let keysRgb = null;       // 关键帧（拖动进度用）
    const clips = [];         // {x,y,w,h,mask}
    const target = { R, G, B };
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
          sr += target.R[p]; sg += target.G[p]; sb += target.B[p];
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
        c: cIdx, r: rIdx, ph: phase,
      };
      strokes.push(rec);
      if (nPath >= 1) {
        lastPen.x = pathFlat[(nPath - 1) * 2];
        lastPen.y = pathFlat[(nPath - 1) * 2 + 1];
      }
      return rec;
    }

    // 沿路径取局部色并按"颜色相近的相邻段"合并成一笔
    function emitLocal(path, n, halfW, clipMask, cx, cy, cw, ch, pen, cIdx, rIdx, fallback, ph) {
      const segs = pathSegments(path, n, Math.max(30, halfW * 3));
      const cols = [];
      for (const sg of segs) {
        if (sg.n < 2) { cols.push(null); continue; }
        const rb = ribbon(sg.pts, sg.n, halfW);
        cols.push(sampleColor(rb, rb.length / 2, clipMask, cx, cy, cw, ch) || fallback);
      }
      let i = 0;
      while (i < segs.length) {
        let j = i;
        while (j + 1 < segs.length && cols[j + 1] && cols[i] &&
               Math.abs(cols[j + 1][0] - cols[i][0]) + Math.abs(cols[j + 1][1] - cols[i][1]) +
               Math.abs(cols[j + 1][2] - cols[i][2]) < 42) j++;
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
          emitStroke(rib, rib.length / 2, arr, np, halfW, col, pn, cIdx, rIdx, ph);
        }
        i = j + 1;
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

    // ---- 8a) 线稿：整层骨架 → 长路径笔（可多笔补足）；写在"铺色"之后执行（先铺色再勾线收形） ----
    const inkClips = [];
    const buildInkLayer = () => {
      const icc = compsOfLabels(inkBin, W, H);
      const groups = [];
      for (let ci = 0; ci < icc.comps.length; ci++) {
        if (icc.comps[ci].label === 1 && icc.comps[ci].count >= 6) groups.push(ci);
      }
      groups.sort((a, b) => icc.comps[b].count - icc.comps[a].count);
      // 勾线也按"就近"走：从笔尖现在的位置开始，串成一条不来回乱跳的路线
      const gSeq = chainNN(
        groups.slice(0, 260).map((ci) => ({ ci, cx: (icc.comps[ci].x0 + icc.comps[ci].x1) / 2, cy: (icc.comps[ci].y0 + icc.comps[ci].y1) / 2 })),
        (g) => [g.cx, g.cy], lastPen.x, lastPen.y
      ).map((g) => g.ci);
      let gi = 0;
      for (const ci of gSeq) {
        gi++;
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
          const { sk } = thin(m0, bw.w, bw.h);
          const lp = longestPath(sk, bw.w, bw.h);
          if (lp && lp.len >= 2) {
            const absPath = new Float64Array(lp.len * 2);
            for (let i = 0; i < lp.len; i++) {
              absPath[i * 2] = lp.pts[i * 2] + bw.x;
              absPath[i * 2 + 1] = lp.pts[i * 2 + 1] + bw.y;
            }
            if (opts.localColor) {
              emitLocal(absPath, lp.len, half, bw.m, bw.x, bw.y, bw.w, bw.h, -1, cIdx, -1, inkFallback, 2);
            } else {
              const rib = ribbon(absPath, lp.len, half);
              emitStroke(rib, rib.length / 2, absPath, lp.len, half, inkFallback, 1, cIdx, -1, 2);
            }
            const cover = new Uint8Array(bw.w * bw.h);
            fillPoly(cover, bw.w, bw.h, (() => {
              const r = ribbon(absPath, lp.len, half);
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
    if (opts.inkEarly) buildInkLayer();     // 调试开关：勾线放在铺色之前（旧行为）
    prog(0.52, '铺色块…'); await yieldUI();

    // ---- 8b) 非线稿区块：毛笔刷（沿主轴一档档来回涂） ----
    const regionOrder = [];
    {
      const imp = (rg) => Math.hypot(rg.color[0] - 255, rg.color[1] - 255, rg.color[2] - 255);
      const isBg = (rg) => luma(rg.color) > 240 && imp(rg) < 24;
      // 分层：白底先铺（纸面）→ 大色块 → 中块 → 小块；同层内按"就近"串成一条路线
      const tierOf = (rg) => (isBg(rg) ? 99 : Math.floor(Math.log2(Math.max(2, rg.area))));
      const list = [];
      for (let ri = 0; ri < regions.length; ri++) if (!isInk[ri]) list.push(ri);
      list.sort((a, b) => tierOf(regions[b]) - tierOf(regions[a]));
      let i0 = 0;
      while (i0 < list.length) {
        let j0 = i0 + 1;
        const t = tierOf(regions[list[i0]]);
        while (j0 < list.length && tierOf(regions[list[j0]]) === t) j0++;
        const grp = list.slice(i0, j0);
        const seq = chainNN(grp, (ri) => [regions[ri].cx, regions[ri].cy], lastPen.x, lastPen.y);
        for (const ri of seq) regionOrder.push(ri);
        i0 = j0;
      }
      const bleedRad = Math.max(1, Math.round(opts.bleedR * strokeScale));
      for (const ri of regionOrder) {
        const rg = regions[ri];
        if (isInk[ri]) continue;
        const clip = regionMaskOf(compOf, W, rg.cid, rg.x0, rg.y0, rg.x1, rg.y1);
        // 取色时把掩膜内缩 1px：避开边界上的混色像素，否则会被"拉亮"出亮边
        const sampleM = rg.area > 600 ? erode(clip.m, clip.w, clip.h, 1) : clip.m;
        const cIdx = pushClip(rg.x0, rg.y0, clip.w, clip.h, clip.m);
        // 一小部分笔允许"画出界"：像人一样压到轮廓外面，后面被别的颜色覆盖回来。
        // 只给大色块用——碎块上出界看不出"手感"，只会变成噪点、白花补笔预算。
        const allowBleed = opts.bleedP > 0 && rg.area >= 1200;
        const cBleed = allowBleed
          ? pushClip(rg.x0, rg.y0, clip.w, clip.h, dilate(clip.m, clip.w, clip.h, bleedRad))
          : cIdx;
        const ext0 = rg.hp * 2;
        let bwid = clamp(ext0 * opts.bwF, opts.bwMin * strokeScale, opts.bwMax * strokeScale);
        // 手抖/弧度是"整个区块一起漂"，不是每一档各抖一个方向——否则相邻两档会漏缝。
        // 横向范围按最大漂移量外扩，保证区块边缘也被盖住（多出来的部分被裁形切掉）。
        const wobA = opts.organic ? Math.min(2.8, bwid * 0.13) : Math.min(2.6, bwid * 0.1);
        const bowA = opts.organic ? Math.min(2.4, bwid * 0.11) : 0;
        const dev = wobA + bowA;
        const ext = ext0 + 2 * dev;
        let nP = Math.max(1, Math.ceil(ext / (bwid * opts.coverOv)));   // 档间足够重叠
        if (nP > 24) { nP = 24; bwid = Math.max(bwid, ext / (nP * opts.coverOv)); }   // 档数封顶就加宽笔刷
        const ax = rg.ax, ay = rg.ay;
        const px2 = -ay, py2 = ax;
        const wobPh = rand01(ri * 7919 + 13, 1) * 6.283;        // 区块级相位（一起漂）
        const wobW = 2.2 + 2.6 * rand01(ri * 7919 + 41, 9);     // 区块级波长（一起漂）
        const bowDir = rand01(ri * 7919 + 29, 3) > 0.5 ? 1 : -1;
        // 从笔尖近的那头起手，之后一档一档来回（不是每档都从同一头起的一排排平行线）
        const tPen = (lastPen.x - rg.cx) * ax + (lastPen.y - rg.cy) * ay;
        const fromPlus = tPen > 0;
        for (let k = 0; k < nP; k++) {
          const pi = fromPlus ? (nP - 1 - k) : k;
          const dir = ((k % 2 === 0) !== fromPlus) ? 1 : -1;
          const seed = ri * 7919 + pi * 104729 + k * 15485863;
          const v = -rg.hp - dev + (pi + 0.5) * (ext / nP);
          const bwidP = opts.organic ? bwid * (0.9 + 0.2 * rand01(seed, 11)) : bwid;
          const wobPhP = wobPh + (rand01(seed, 1) - 0.5) * 0.7;
          const bowP = opts.organic ? bowA * bowDir * (0.7 + 0.6 * rand01(seed, 3)) : 0;
          const e0 = opts.organic ? (rand01(seed, 5) - 0.35) * 5 : 3;
          const e1 = opts.organic ? (rand01(seed, 7) - 0.35) * 5 : 3;
          const tA = dir > 0 ? rg.tmin - 2 - e0 : rg.tmax + 2 + e1;
          const tB = dir > 0 ? rg.tmax + 2 + e1 : rg.tmin - 2 - e0;
          const nseg = opts.organic ? 6 : 5;
          const path = new Float64Array(nseg * 2);
          const halfs = new Float64Array(nseg);
          for (let s = 0; s < nseg; s++) {
            const f = nseg > 1 ? s / (nseg - 1) : 0;
            const tt = tA + (tB - tA) * f;
            const off = v + wobA * Math.sin(wobPhP + f * wobW) + bowP * Math.sin(Math.PI * f);
            path[s * 2] = rg.cx + ax * tt + px2 * off;
            path[s * 2 + 1] = rg.cy + ay * tt + py2 * off;
            // 笔压：两头细、中间粗，再抖一点（风格预设会给不同的 taper）
            halfs[s] = (bwidP / 2) * (opts.taperLo + opts.taperAmp * Math.sin(Math.PI * f)
                                      + opts.taperWob * Math.sin(wobPhP + f * 3.1));
          }
          const useClip = (opts.bleedP > 0 && rand01(seed, 13) < opts.bleedP) ? cBleed : cIdx;
          if (opts.localColor) {
            emitLocal(path, nseg, bwidP / 2, sampleM, rg.x0, rg.y0, clip.w, clip.h, 0, useClip, ri, rg.color, 1);
          } else {
            const rib = opts.organic ? ribbonProf(path, nseg, halfs) : ribbon(path, nseg, bwidP / 2);
            emitStroke(rib, rib.length / 2, path, nseg, bwidP / 2, rg.color, 0, useClip, ri, 1);
          }
        }
      }
    }
    prog(0.70, '勾线收形…'); await yieldUI();
    if (!opts.inkEarly) buildInkLayer();
    prog(0.78, '补笔修形…'); await yieldUI();

    dbg.mainStrokes = strokes.length;
    // ---- 8c) 残差补笔：哪块不像就在哪块补细笔（按局部小块，允许覆盖） ----
    if ((opts.residual && opts.residual.length) || opts.returnCanvas || opts.returnKeys) {
      const canvas = new Uint8Array(N * 3);
      canvas.fill(255);
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
        const local = new Uint8Array(mw * mh);
        const np2 = ribArr.length >> 1;
        const pts = new Float64Array(np2 * 2);
        for (let i = 0; i < np2; i++) { pts[i * 2] = ribArr[i * 2] - xmin; pts[i * 2 + 1] = ribArr[i * 2 + 1] - ymin; }
        fillPoly(local, mw, mh, pts);
        // 光栅口径：网页端是"硬边裁剪"（画布多边形抗锯齿 × 1 位遮罩），所以这里默认也按硬边算，
        // 否则羽化会把笔形边缘"糊"到相邻像素，补漏判定就会以为那里已经画上了（留白点的老坑）。
        const soft = opts.featherRaster ? feather(local, mw, mh) : local;
        for (let y = 0; y < mh; y++) {
          const yy = ymin + y;
          const rowC = (yy - cl.y) * cl.w;
          for (let x = 0; x < mw; x++) {
            const al = soft[y * mw + x];
            if (al <= 0) continue;
            const xx = xmin + x;
            if (!cl.mask[rowC + (xx - cl.x)]) continue;
            const pp = yy * W + xx;
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
      const keysOut = [];
      const kEvery = Math.max(1, Math.ceil(strokes.length / (opts.keyFrames || 5)));
      for (let i0 = 0; i0 < strokes.length; i0++) {
        const st0 = strokes[i0];
        raster(st0.rib, st0.color, st0.c);
        if ((i0 + 1) % kEvery === 0) keysOut.push({ i: i0 + 1, rgb: canvas.slice() });
      }
      if (!keysOut.length || keysOut[keysOut.length - 1].i !== strokes.length) {
        keysOut.push({ i: strokes.length, rgb: canvas.slice() });
      }
      const emitRaster = (rib, pathPts, nPath, halfW, col, pen, cIdx, ph) => {
        const rec = emitStroke(rib, rib.length / 2, pathPts, nPath, halfW, col, pen, cIdx, -1, ph);
        raster(rec.rib, rec.color, rec.c);
        return rec;
      };
      const TILE = 72;
      let prevPct = 999;
      for (let round = 0; round < opts.residual.length; round++) {
        if (strokes.length > opts.maxStrokes) break;
        // 前两轮是"收形"（把轮廓/边缘修准），后面几轮是"点睛"（抠细节，手更慢更细）
        const phR = round < 2 ? 2 : 3;
        const thr = opts.residual[round];
        let added = 0;
        // 全图错误掩膜：把"又大又厚"的错误块（大片平滑渐变差异）排除在补笔之外，
        // 否则会按 72px 小格补出块状拼贴
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
            const bw2 = c.x1 - c.x0 + 1, bh2 = c.y1 - c.y0 + 1;
            const thick = c.count / Math.max(1, Math.max(bw2, bh2));
            if (c.count > 2500 && thick > opts.resThick * strokeScale) {
              for (let k = 0; k < c.count; k++) skip[wcc.pix[c.start + k]] = 1;
            }
          }
        }
        for (let ty = 0; ty < H && added < 6000; ty += TILE) {
          for (let tx = 0; tx < W && added < 6000; tx += TILE) {
            const tw = Math.min(TILE, W - tx), th = Math.min(TILE, H - ty);
            const wrong = new Uint8Array(tw * th);
            let any = 0;
            for (let y = 0; y < th; y++) {
              for (let x = 0; x < tw; x++) {
                const pp = (ty + y) * W + (tx + x);
                const d = Math.max(Math.abs(canvas[pp * 3] - R[pp]),
                                   Math.abs(canvas[pp * 3 + 1] - G[pp]),
                                   Math.abs(canvas[pp * 3 + 2] - B[pp]));
                if (d > thr && !skip[pp]) { wrong[y * tw + x] = 1; any++; }
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
                if (smax <= 18) { parts.push([st, cnt]); return; }
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

              // 颜色分裂后的每一份再按连通切开（避免"散点连成一条长笔"）
              const pieces = [];
              for (const part of parts) {
                const st = part[0], cnt = part[1];
                if (cnt < 5) continue;
                const pm = new Uint8Array(tw * th);
                for (let k = 0; k < cnt; k++) pm[cc.pix[st + k]] = 1;
                const pc = compsOfLabels(pm, tw, th);
                for (let j = 0; j < pc.comps.length; j++) {
                  if (pc.comps[j].label === 1 && pc.comps[j].count >= 5) {
                    pieces.push([pc, j]);
                  }
                }
              }
              for (const piece of pieces) {
                const pcc = piece[0], ci2 = piece[1];
                const st = pcc.comps[ci2].start, cnt = pcc.comps[ci2].count;
                if (cnt < 5) continue;
                let cr = 0, cg = 0, cb = 0;
                let x0 = W, y0 = H, x1 = -1, y1 = -1;
                for (let k = 0; k < cnt; k++) {
                  const xx = toX(pcc.pix[st + k]), yy = toY(pcc.pix[st + k]);
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
                  bin[(toY(pcc.pix[st + k]) - by) * mw + (toX(pcc.pix[st + k]) - bx)] = 1;
                }
                const clipMask = dilate(bin, mw, mh, pad);
                const cIdx = pushClip(bx, by, mw, mh, clipMask);
                const cx0 = (x0 + x1) / 2, cy0 = (y0 + y1) / 2;
                if (cnt <= 16) {                       // 小点：一笔点掉
                  const rad = clamp(Math.sqrt(cnt / Math.PI) + 1.4, 2.0, 12);
                  const poly = [];
                  for (let k = 0; k < 13; k++) {
                    const a = k / 13 * Math.PI * 2;
                    poly.push(cx0 + rad * Math.cos(a), cy0 + rad * Math.sin(a));
                  }
                  emitRaster(poly, [cx0, cy0], 1, rad, col, 0, cIdx, phR);
                  added++;
                  continue;
                }
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
                    const segs = pathSegments(absPath, lp.len, Math.max(18, half * 3.2));
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
                             Math.abs(cols[j2 + 1][2] - cols[i2][2]) < 42) j2++;
                      const pts2 = [];
                      for (let k2 = i2; k2 <= j2; k2++) {
                        const P2 = segs[k2].pts;
                        for (let m2 = 0; m2 < P2.length; m2++) pts2.push(P2[m2]);
                      }
                      const arr2 = Float64Array.from(pts2);
                      if (arr2.length >= 4) {
                        const rb = ribbon(arr2, arr2.length / 2, half);
                        emitRaster(rb, arr2, arr2.length / 2, half, cols[i2] || col, 0, cIdx, phR);
                        added++;
                      }
                      i2 = j2 + 1;
                    }
                  }
                } else {
                  const rad = clamp(Math.sqrt(cnt / Math.PI) + 0.8, 2.0, 10);
                  const poly = [];
                  for (let k = 0; k < 13; k++) {
                    const a = k / 13 * Math.PI * 2;
                    poly.push(cx0 + rad * Math.cos(a), cy0 + rad * Math.sin(a));
                  }
                  emitRaster(poly, [cx0, cy0], 1, rad, col, 0, cIdx, phR);
                  added++;
                }
              }
            }
          }
        }
        let bad = 0;
        for (let i = 0; i < N; i++) {
          const d = Math.max(Math.abs(canvas[i * 3] - R[i]), Math.abs(canvas[i * 3 + 1] - G[i]), Math.abs(canvas[i * 3 + 2] - B[i]));
          if (d > 8) bad++;
        }
        const pct = bad / N * 100;
        prog(0.78 + 0.2 * (round + 1) / opts.residual.length,
             (phR === 2 ? "收形补笔…" : "点睛补细节…") + " 第 " + (round + 1) + " 轮（可见差异 " + pct.toFixed(2) + "%）");
        if (pct < 1.0) break;
        if (opts.resStop > 0 && prevPct - pct < opts.resStop && round >= 1) break;   // 收益变小就收手
        prevPct = pct;
        await yieldUI();
      }

      // ---- 收尾补漏：残差补笔为了不把平滑渐变补成拼贴，设了"太小不补、太散不补"的门槛，
      //      贴着大片差异的小洞也会被连带跳过。这里分两类补，保证画面不留白点、白线：
      //      A) 真空白——画布上这块还是白的（什么都没画到），而原图不是白的；不论大小都补
      //      B) 剩余的"小块/细条"错误——用厚度判定，大而厚的块仍跳过（那是平涂风格化本身）
      if (opts.holeFill) {
        const errAt = (i) => Math.max(Math.abs(canvas[i * 3] - R[i]),
                                      Math.abs(canvas[i * 3 + 1] - G[i]),
                                      Math.abs(canvas[i * 3 + 2] - B[i]));
        // 补一个连通块：贴着它的形状走一条（或几条）笔
        const fillComp = (comp, comps2) => {
          const x0 = comp.x0, y0 = comp.y0, x1 = comp.x1, y1 = comp.y1;
          const mw = x1 - x0 + 1, mh = y1 - y0 + 1;
          const bin = new Uint8Array(mw * mh);
          let cr = 0, cg = 0, cb = 0;
          for (let k = 0; k < comp.count; k++) {
            const p = comps2.pix[comp.start + k];
            const x = p % W, y = (p - x) / W;
            bin[(y - y0) * mw + (x - x0)] = 1;
            cr += R[p]; cg += G[p]; cb += B[p];
          }
          const col = [Math.round(cr / comp.count), Math.round(cg / comp.count), Math.round(cb / comp.count)];
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
            emitRaster(poly, [cx0, cy0], 1, rad, col, 0, cIdx, 3);
          }
          // 自检：沿骨架走的笔形在细缝/拐角/极扁的形状上可能盖不到像素中心（画了等于没画）。
          // 对"自检后仍然是白的"那些像素，用方点笔形（严格掩膜）兜底——方框一定包含像素中心。
          const left = [];
          for (let k = 0; k < comp.count; k++) {
            const p = comps2.pix[comp.start + k];
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
            emitRaster(rect, [gx0, (gy0 + gy1) / 2, gx1, (gy0 + gy1) / 2], 2,
                       Math.max(1.6, lh / 2 + 1), lcol, 0, cIdx2, 3);
          }
        };
        const fillMask = (mask, limit, maxAdd) => {
          const base = strokes.length;
          const cc2 = compsOfLabels(mask, W, H);
          const list = [];
          for (let ci = 0; ci < cc2.comps.length; ci++) if (cc2.comps[ci].label === 1) list.push(ci);
          list.sort((a, b) => cc2.comps[b].count - cc2.comps[a].count);   // 先补大块（同预算下总误差降得多）
          let n = 0;
          for (const ci of list.slice(0, limit)) {
            if (maxAdd && strokes.length - base >= maxAdd) break;
            fillComp(cc2.comps[ci], cc2); n++;
          }
          return n;
        };
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
          if (!got) break;
          await yieldUI();
        }
        // B) 剩余的小块/细条错误（A 补完后重新算，已经补上的不再重复）。
        //    这里的阈值放宽一倍：照片这类纹理区里，一小块错误用的是一个均值色，
        //    补上去对块内偏暗的一半反而更差，所以只补"明显不对"的那部分。
        let nB = 0;
        {
          const thrB = clamp(opts.holeT * 2 * strokeScale, 32, 120);
          const m = new Uint8Array(N);
          for (let i = 0; i < N; i++) if (errAt(i) > thrB) m[i] = 1;
          const cc2 = compsOfLabels(m, W, H);
          for (let ci = 0; ci < cc2.comps.length; ci++) {
            const c = cc2.comps[ci];
            if (c.label !== 1) continue;
            const bw2 = c.x1 - c.x0 + 1, bh2 = c.y1 - c.y0 + 1;
            const thick = c.count / Math.max(1, Math.max(bw2, bh2));
            if (c.count > opts.holeMax && thick > 4) {          // 又大又厚：平涂风格化，不补
              for (let k = 0; k < c.count; k++) m[cc2.pix[c.start + k]] = 0;
            }
          }
          nB = fillMask(m, 2500, 4200);
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
          if (any) nC = fillMask(m, opts.edgeMax, 4200);
        }
        if (nA || nB || nC) {
          let bad2 = 0;
          for (let i = 0; i < N; i++) if (errAt(i) > 8) bad2++;
          prog(0.995, `收尾补漏… 空白 ${nA} 处、碎块 ${nB} 处、交界 ${nC} 处（可见差异 ${(bad2 / N * 100).toFixed(2)}%）`);
          await yieldUI();
        }
      }

      keysOut.push({ i: strokes.length, rgb: canvas.slice() });
      visCanvas = canvas;
      keysRgb = keysOut;
    }

    // 时长归一：先按 targetSec 分配相对权重（网页端还会把"抬笔移动"的时间算进来再分一次）
    {
      let tot = 0;
      for (const st1 of strokes) tot += st1.ms;
      const k = tot > 0 ? (opts.targetSec * 1000) / tot : 1;
      for (const st1 of strokes) st1.ms = Math.round(Math.max(6, st1.ms * k) * 10) / 10;
    }
    prog(1.0, '完成');
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

  root.ISP_PIPELINE = { run, CFG, _u: { ribbon, fillPoly, distanceTransform, thin, longestPath, compsOfLabels } };
})(typeof self !== 'undefined' ? self : globalThis);
