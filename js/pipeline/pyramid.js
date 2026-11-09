/* pyramid mode：逐级细化（粗到细反复补笔），保留兼容
 *
 * 由 pipeline.js 的 run() 按 opts 分发进来；模块级状态（CFG）改成显式参数，
 * 纯工具从 js/pipeline/util.js 取。
 */
(function (root) {
  'use strict';

  async function runPyramidMode(CFG, U, px, W, H, opts, onProgress) {
    const { clamp, luma, rand01, chainNN, hilbertIndex, LABF, srgb2labInto, srgb2lab, fillEnclosedHoles, fillPoly, fillPolyCov, distanceTransform, dilate, erode, rdpSimplify, closeMask, closeMaskDisk, compsOfLabels, thin, longestPath, ribbon, ribbonProf, mergeLoops, med3, box3, feather, kmeans, regionMaskOf } = U;
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

  root.ISP_PIPELINE_PYRAMID = { run: runPyramidMode };
})(typeof globalThis !== 'undefined' ? globalThis : this);
