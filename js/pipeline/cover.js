/* cover mode：颜色超像素 + 分层宽笔扫（"像素级对齐开关"之前的老算法线，保留兼容）
 *
 * 由 pipeline.js 的 run() 按 opts 分发进来；模块级状态（CFG）改成显式参数，
 * 纯工具从 js/pipeline/util.js 取。
 */
(function (root) {
  'use strict';

  async function runCoverMode(CFG, U, px, W, H, opts, onProgress) {
    const { clamp, luma, rand01, chainNN, hilbertIndex, LABF, srgb2labInto, srgb2lab, fillEnclosedHoles, fillPoly, fillPolyCov, distanceTransform, dilate, erode, rdpSimplify, closeMask, closeMaskDisk, compsOfLabels, thin, longestPath, ribbon, ribbonProf, mergeLoops, med3, box3, feather, kmeans, regionMaskOf } = U;
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

  root.ISP_PIPELINE_COVER = { run: runCoverMode };
})(typeof globalThis !== 'undefined' ? globalThis : this);
