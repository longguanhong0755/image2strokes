/* 区域色块编译器：边缘感知分割 → 受控合并 → 拓扑排序。
 *
 * 这个模块只吃像素和参数，不碰 DOM / 引擎状态，方便在 Node 里直接跑基线。
 * 单位是"色块"：一块 = 一个连通区域 + 一种颜色 + 一次原子落块（emitBlockFill）。
 * 目标不是"多画几笔"，而是：在给定感知误差预算内，把色块数压到最少。
 *
 * 做法：
 *   1) 全分辨率算相邻像素的加权色差（2R+4G+3B），按差值升序看每条边；
 *      只有当色差不超过"两边区域自身已有起伏 + k/面积"时才并——强边界
 *      （文字/描边/轮廓）永远并不过去，平滑渐变会自己并成一片。
 *   2) 面积过小的碎块并进最像的邻块（没有像的就留着，那是真细节）。
 *   3) 剩下的块按"合并后均方误差不超过 mseT"为前提继续合并，直到块数达标。
 *   4) 仍然小于可见尺寸的块，无条件并进最像的邻块：一块至少得看得见。
 *   5) 从贴边块 BFS 拓扑深度，细长块压到邻块之后，按深度+面积出序。
 *
 * 入口：
 *   BLOCKS.build(R, G, B, W, H, { fidelity, blockK, blockMse, blockBudget, seed })
 * 返回：
 *   { blocks, order, labels, stats }
 *   blocks[i] = { id, x0, y0, bw, bh, mask, color, area, perim, depth, thin }
 *   order 是落块顺序（拓扑深度 + 面积）。
 */
(function (root) {
  'use strict';

  function build(R, G, B, W, H, opts) {
    opts = opts || {};
    const N = W * H;
    const t0 = Date.now();
    const fid = Math.max(1, Math.min(5, Math.round(+opts.fidelity || 3)));
    // 每档只描述"感知量"，跟样例内容无关：
    //   k      —— 允许并块的最大局部色差（加权平方距离）。越大块越少。
    //   mergeD —— 合并阶段两块均色允许的最大通道差。超过就是两种颜色，不许并。
    //   mseT   —— 一块内部允许的平均平方通道误差。块的偏色上限。
    //   budget —— 色块数上限；画面本来就简单时不会为了凑数去拆块。
    //   absorb —— 碎块阈值（占全图比例）：小于它就并进最像的邻块。
    //   force  —— 可见下限：受控合并停下后，仍小于它的块按 noiseD 判定去留。
    //   noiseD —— "噪点级"色差：小于它的小块并掉，大于它的说明真是一种颜色，留着。
    const CFG = [
      { k: 2600, mergeD: 48, noiseD: 96, mse: 800, budget: 72, absorb: 0.00050, force: 0.00120 },
      { k: 2000, mergeD: 34, noiseD: 80, mse: 500, budget: 120, absorb: 0.00030, force: 0.00080 },
      { k: 1500, mergeD: 24, noiseD: 64, mse: 300, budget: 200, absorb: 0.00020, force: 0.00045 },
      { k: 1100, mergeD: 16, noiseD: 48, mse: 160, budget: 330, absorb: 0.00012, force: 0.00025 },
      { k: 800, mergeD: 10, noiseD: 36, mse: 80, budget: 520, absorb: 0.00007, force: 0.00012 },
    ][fid - 1];
    const edgeK = opts.blockK !== undefined ? +opts.blockK : CFG.k;
    const mergeD = opts.blockMergeD !== undefined ? +opts.blockMergeD : CFG.mergeD;
    const mergeW = 9 * mergeD * mergeD;
    const noiseD = opts.blockNoiseD !== undefined ? +opts.blockNoiseD : CFG.noiseD;
    const noiseW = 9 * noiseD * noiseD;
    const mseT = opts.blockMse !== undefined ? +opts.blockMse : CFG.mse;
    const budget = opts.blockBudget !== undefined ? +opts.blockBudget : CFG.budget;
    const seed = (+opts.seed || 0) >>> 0;
    const useBlur = opts.blockBlur !== 0;
    const doSnap = opts.blockSnap !== 0;
    let tSeg = 0, tAbsorb = 0, tMerge = 0, tOrder = 0;

    // ---------- 1) 轻模糊：只用于算边缘权重，压扫描噪点；块颜色仍取原像素 ----------
    // 1-2-1 可分离模糊。1px 细线不会消失，只是对比度降一档，仍远高于噪点。
    let eR = R, eG = G, eB = B;
    if (useBlur && N > 4) {
      const tmp = new Uint16Array(N * 3);
      for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
          const p = row + x;
          const l = x > 0 ? p - 1 : p, r = x + 1 < W ? p + 1 : p;
          tmp[p * 3] = R[l] + 2 * R[p] + R[r];
          tmp[p * 3 + 1] = G[l] + 2 * G[p] + G[r];
          tmp[p * 3 + 2] = B[l] + 2 * B[p] + B[r];
        }
      }
      eR = new Uint8Array(N); eG = new Uint8Array(N); eB = new Uint8Array(N);
      for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
          const p = row + x;
          const u = y > 0 ? p - W : p, d = y + 1 < H ? p + W : p;
          eR[p] = (tmp[u * 3] + 2 * tmp[p * 3] + tmp[d * 3]) >> 4;
          eG[p] = (tmp[u * 3 + 1] + 2 * tmp[p * 3 + 1] + tmp[d * 3 + 1]) >> 4;
          eB[p] = (tmp[u * 3 + 2] + 2 * tmp[p * 3 + 2] + tmp[d * 3 + 2]) >> 4;
        }
      }
    }

    // ---------- 2) 相邻色差升序：并查集 + 内部起伏判据 ----------
    // 判据（Felzenszwalb）：w <= Int(C) + k/|C|。
    // Int(C) 是区域内最大单步色差，小区域有 k/|C| 的宽容度，大区域只能
    // 沿"自身已有起伏之内"的边界继续长——所以平滑渐变会连成一片，
    // 而文字/描边那种强边界永远过不去。
    let E = 0;
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        if (x + 1 < W) E++;
        if (y + 1 < H) E++;
      }
    }
    const ES = Math.pow(2, Math.ceil(Math.log2(Math.max(2, 2 * N))));
    const edges = new Float64Array(E);
    {
      let e = 0;
      for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
          const p = row + x;
          if (x + 1 < W) {
            const q = p + 1;
            const dr = eR[q] - eR[p], dg = eG[q] - eG[p], db = eB[q] - eB[p];
            edges[e++] = (2 * dr * dr + 4 * dg * dg + 3 * db * db) * ES + p * 2;
          }
          if (y + 1 < H) {
            const q = p + W;
            const dr = eR[q] - eR[p], dg = eG[q] - eG[p], db = eB[q] - eB[p];
            edges[e++] = (2 * dr * dr + 4 * dg * dg + 3 * db * db) * ES + p * 2 + 1;
          }
        }
      }
    }
    edges.sort();

    const par = new Int32Array(N), sz = new Int32Array(N).fill(1), intw = new Float64Array(N);
    for (let i = 0; i < N; i++) par[i] = i;
    const find = (x) => {
      let r = x;
      while (par[r] !== r) r = par[r];
      while (par[x] !== r) { const n = par[x]; par[x] = r; x = n; }
      return r;
    };
    for (let i = 0; i < E; i++) {
      const v = edges[i];
      const idx = v % ES;
      const w = (v - idx) / ES;
      const p = idx >>> 1;
      const q = (idx & 1) ? p + W : p + 1;
      let a = find(p), b = find(q);
      if (a === b) continue;
      if (w <= intw[a] + edgeK / sz[a] && w <= intw[b] + edgeK / sz[b]) {
        if (sz[a] < sz[b]) { const t = a; a = b; b = t; }
        par[b] = a; sz[a] += sz[b]; intw[a] = w;
      }
    }
    let labels = new Int32Array(N);
    let K = 0;
    {
      const rid = new Int32Array(N).fill(-1);
      for (let p = 0; p < N; p++) {
        const r = find(p);
        let id = rid[r];
        if (id < 0) { id = K++; rid[r] = id; }
        labels[p] = id;
      }
    }
    const initialK = K;
    tSeg = Date.now() - t0;

    // ---------- 3) 区域统计 / 邻接 ----------
    const collect = (lab, n) => {
      const area = new Float64Array(n);
      const sR = new Float64Array(n), sG = new Float64Array(n), sB = new Float64Array(n);
      const qR = new Float64Array(n), qG = new Float64Array(n), qB = new Float64Array(n);
      const x0 = new Int32Array(n).fill(W), y0 = new Int32Array(n).fill(H);
      const x1 = new Int32Array(n).fill(-1), y1 = new Int32Array(n).fill(-1);
      for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
          const p = row + x, id = lab[p], r = R[p], g = G[p], b = B[p];
          area[id]++;
          sR[id] += r; sG[id] += g; sB[id] += b;
          qR[id] += r * r; qG[id] += g * g; qB[id] += b * b;
          if (x < x0[id]) x0[id] = x;
          if (x > x1[id]) x1[id] = x;
          if (y < y0[id]) y0[id] = y;
          if (y > y1[id]) y1[id] = y;
        }
      }
      // 加权 SSE：Σ(2r²+4g²+3b²) - (2(Σr)²+4(Σg)²+3(Σb)²)/n
      const sse = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const a = Math.max(1, area[i]);
        const e = 2 * qR[i] + 4 * qG[i] + 3 * qB[i] -
          (2 * sR[i] * sR[i] + 4 * sG[i] * sG[i] + 3 * sB[i] * sB[i]) / a;
        sse[i] = Math.max(0, e);
      }
      return { area, sR, sG, sB, sse, x0, y0, x1, y1 };
    };
    const regionAdj = (lab, n) => {
      const adj = new Array(n);
      for (let i = 0; i < n; i++) adj[i] = new Map();
      const link = (a, b) => {
        if (a === b) return;
        adj[a].set(b, (adj[a].get(b) || 0) + 1);
        adj[b].set(a, (adj[b].get(a) || 0) + 1);
      };
      for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
          const p = row + x, a = lab[p];
          if (x + 1 < W) link(a, lab[p + 1]);
          if (y + 1 < H) link(a, lab[p + W]);
        }
      }
      return adj;
    };
    const compactLabels = (lab, n) => {
      const remap = new Int32Array(n).fill(-1);
      let K2 = 0;
      const out = new Int32Array(N);
      for (let p = 0; p < N; p++) {
        let id = remap[lab[p]];
        if (id < 0) id = remap[lab[p]] = K2++;
        out[p] = id;
      }
      return { labels: out, K: K2 };
    };
    const wd2 = (ar, ag, ab, br, bg, bb) => {
      const dr = ar - br, dg = ag - bg, db = ab - bb;
      return 2 * dr * dr + 4 * dg * dg + 3 * db * db;
    };

    // ---------- 4) 碎块吸收：小于 minA 的块并进最像的邻块 ----------
    // gate = 允许的色差上限；Infinity 表示无条件并（只按"最像"选目标）。
    // 无条件那一档只用在可见下限上：一块至少得看得见，否则留着就是噪点。
    const absorbSmall = (lab, n, minA, gate, tinyA) => {
      const st0 = collect(lab, n);
      const adj = regionAdj(lab, n);
      const dbg = opts.blockDebug ? { failD: new Uint32Array(8), failA: new Uint32Array(9), merged: 0 } : null;
      const up = new Int32Array(n);
      for (let i = 0; i < n; i++) up[i] = i;
      const ufind = (x) => {
        let r = x;
        while (up[r] !== r) r = up[r];
        while (up[x] !== r) { const t = up[x]; up[x] = r; x = t; }
        return r;
      };
      const ua = Float64Array.from(st0.area);
      const uR = Float64Array.from(st0.sR), uG = Float64Array.from(st0.sG), uB = Float64Array.from(st0.sB);
      const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => ua[a] - ua[b]);
      let merged = 0;
      for (const id0 of order) {
        const id = ufind(id0);
        if (ua[id] >= minA) continue;
        const an0 = Math.max(1, ua[id]);
        const mr = uR[id] / an0, mg = uG[id] / an0, mb = uB[id] / an0;
        let bj = -1, bw = Infinity;
        for (const nb of adj[id].keys()) {
          const j = ufind(nb);
          if (j === id) continue;
          const an = Math.max(1, ua[j]);
          const d = wd2(mr, mg, mb, uR[j] / an, uG[j] / an, uB[j] / an);
          if (d < bw) { bw = d; bj = j; }
        }
        if (bj < 0) continue;
        // 几个像素的碎点不管什么颜色都看不见，直接并；再大一点才看色差。
        if (ua[id] > (tinyA || 0) && bw > gate) {
          if (dbg) {
            const d = Math.sqrt(Math.max(0, bw)) / 3;   // 近似通道差
            dbg.failD[Math.min(7, Math.max(0, Math.floor(d / 16)))]++;
            dbg.failA[Math.min(8, Math.max(0, Math.floor(Math.log2(Math.max(1, ua[id])))))]++;
          }
          continue;
        }
        if (dbg) dbg.merged++;
        const a = id, b = bj;
        up[b] = a;
        ua[a] += ua[b];
        uR[a] += uR[b]; uG[a] += uG[b]; uB[a] += uB[b];
        // 邻接表并入根，后面被别的碎块找目标时仍能看到这些邻居
        for (const [nb, len] of adj[b]) {
          if (nb === a) continue;
          adj[a].set(nb, (adj[a].get(nb) || 0) + len);
          const an = adj[nb];
          if (an && an.get(b) !== undefined) an.delete(b);
          if (an) an.set(a, (an.get(a) || 0) + len);
        }
        adj[b].clear();
        merged++;
      }
      if (!merged) return { labels: lab, K: n, merged: 0, dbg };
      for (let p = 0; p < N; p++) lab[p] = ufind(lab[p]);
      const c = compactLabels(lab, n);
      return { labels: c.labels, K: c.K, merged, dbg };
    };

    // ---------- 7.5) 过渡块归边 ----------
    // 抗锯齿/扫描会在两种颜色之间留一圈 1~2px 的混色像素。边缘感知分割会把
    // 这圈各自切成窄块——画出来就是给每个形状描了一道半色调边。这里把
    // "平均厚度 <= 2.4px"的窄块逐像素还给四邻中颜色最近的那块：每个像素
    // 各自归边，轮廓位置不动，所以不会像整块归并那样把描边吃胖。
    // 门很紧（<= 20/通道）：只吃两色之间的过渡像素，真正的细线（深色描边、
    // 字边、细框）离两侧颜色都远，不会被抹掉。
    const snapThin = (lab, n, gateD) => {
      const st2 = collect(lab, n);
      const area2 = st2.area;
      const per2 = new Int32Array(n);
      for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
          const p = row + x, a = lab[p];
          if (x + 1 < W) { const b = lab[p + 1]; if (b !== a) { per2[a]++; per2[b]++; } }
          if (y + 1 < H) { const b = lab[p + W]; if (b !== a) { per2[a]++; per2[b]++; } }
        }
      }
      const cand = new Uint8Array(n);
      let nCand = 0;
      for (let i = 0; i < n; i++) {
        if (area2[i] <= 0 || per2[i] <= 0) continue;
        if (2 * area2[i] / per2[i] <= 2.4 && area2[i] <= N * 0.01) { cand[i] = 1; nCand++; }
      }
      if (!nCand) return { labels: lab, K: n, moved: 0, cand: 0 };
      const gateW = 9 * Math.min(gateD, 20) * Math.min(gateD, 20);
      const mean = new Array(n);
      for (let i = 0; i < n; i++) {
        const a = Math.max(1, area2[i]);
        mean[i] = [st2.sR[i] / a, st2.sG[i] / a, st2.sB[i] / a];
      }
      const out = new Int32Array(N);
      out.set(lab);
      let moved = 0;
      for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
          const p = row + x, b = lab[p];
          if (!cand[b]) continue;
          let best = -1, bd = Infinity;
          const tryNb = (q) => {
            const nb = lab[q];
            if (nb === b || cand[nb]) return;
            const m = mean[nb];
            const w = wd2(R[p], G[p], B[p], m[0], m[1], m[2]);
            if (w < bd) { bd = w; best = nb; }
          };
          if (x > 0) tryNb(p - 1);
          if (x + 1 < W) tryNb(p + 1);
          if (y > 0) tryNb(p - W);
          if (y + 1 < H) tryNb(p + W);
          if (best >= 0 && bd <= gateW) { out[p] = best; moved++; }
        }
      }
      if (!moved) return { labels: lab, K: n, moved: 0, cand: nCand };
      const c = compactLabels(out, n);
      return { labels: c.labels, K: c.K, moved, cand: nCand };
    };

    const minArea = Math.max(8, Math.round(N * CFG.absorb));
    const tinyArea = Math.max(6, Math.min(24, Math.round(N * 0.00001)));
    let abInfo = absorbSmall(labels, K, minArea, mergeW, 0);
    labels = abInfo.labels; K = abInfo.K;
    const absorb1 = abInfo.merged;
    tAbsorb = Date.now() - t0 - tSeg;

    // ---------- 5) 受控合并：一块内部的均方误差不许超过 mseT ----------
    let st = collect(labels, K);
    const adj = regionAdj(labels, K);
    const area = Float64Array.from(st.area);
    const sr = Float64Array.from(st.sR), sg = Float64Array.from(st.sG), sb = Float64Array.from(st.sB);
    const sse = Float64Array.from(st.sse);
    const root = new Int32Array(K);
    const alive = new Uint8Array(K).fill(1);
    for (let i = 0; i < K; i++) root[i] = i;
    const find2 = (i) => {
      while (root[i] !== i) { root[i] = root[root[i]]; i = root[i]; }
      return i;
    };
    // 合并代价 = 并块后 SSE 增量 / 总像素（Ward，用来排序：先并最不亏的）
    // 能否并 = 两块均色足够接近（是同一色）+ 并块后的加权均方误差 <= mseT
    const cand = (a, b) => {
      const na = area[a], nb = area[b], n = na + nb;
      if (n <= 0) return Infinity;
      const dr = sr[a] / na - sr[b] / nb;
      const dg = sg[a] / na - sg[b] / nb;
      const db = sb[a] / na - sb[b] / nb;
      const wd = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
      if (wd > mergeW) return Infinity;
      const mse = (sse[a] + sse[b] + wd * (na * nb / n)) / (9 * n);
      if (mse > mseT) return Infinity;
      return wd * (na * nb / (n * n));
    };

    const hc = [], ha = [], hb = [], hv = [];
    let hPushes = 0, hPops = 0, hStale = 0, hMax = 0, nbrIter = 0, maxDeg = 0;
    const hpush = (c, a, b, v) => {
      hPushes++;
      if (hc.length > hMax) hMax = hc.length;
      let i = hc.length;
      hc.push(c); ha.push(a); hb.push(b); hv.push(v);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (hc[p] <= c) break;
        hc[i] = hc[p]; ha[i] = ha[p]; hb[i] = hb[p]; hv[i] = hv[p];
        i = p;
      }
      hc[i] = c; ha[i] = a; hb[i] = b; hv[i] = v;
    };
    let pA = 0, pB = 0, pV = 0;
    const hpop = () => {
      hPops++;
      const n = hc.length - 1;
      pA = ha[0]; pB = hb[0]; pV = hv[0];
      if (n > 0) {
        const lc = hc[n], la = ha[n], lb = hb[n], lv = hv[n];
        let i = 0;
        for (;;) {
          let ch = i * 2 + 1;
          if (ch >= n) break;
          if (ch + 1 < n && hc[ch + 1] < hc[ch]) ch++;
          if (hc[ch] >= lc) break;
          hc[i] = hc[ch]; ha[i] = ha[ch]; hb[i] = hb[ch]; hv[i] = hv[ch];
          i = ch;
        }
        hc[i] = lc; ha[i] = la; hb[i] = lb; hv[i] = lv;
      }
      hc.pop(); ha.pop(); hb.pop(); hv.pop();
    };

    // 每块只维护"最便宜且不超误差上限"的那条邻边，堆里一块一项。
    const bestN = new Int32Array(K).fill(-1);
    const bver = new Int32Array(K);
    const recompute = (i) => {
      let bc = Infinity, bn = -1;
      for (const n of adj[i].keys()) {
        if (n === i || !alive[n]) continue;
        const c = cand(i, n);
        if (c < bc) { bc = c; bn = n; }
      }
      bestN[i] = bn;
      bver[i]++;
      if (bn >= 0 && bc < Infinity) hpush(bc, i, bn, bver[i]);
    };
    for (let i = 0; i < K; i++) recompute(i);

    let aliveN = K;
    let merges = 0;
    while (aliveN > budget && hc.length) {
      hpop();
      const a = pA, b = pB, v = pV;
      if (!alive[a] || !alive[b] || root[a] !== a || root[b] !== b || a === b ||
          v !== bver[a] || b !== bestN[a]) { hStale++; continue; }
      const c = cand(a, b);
      if (!isFinite(c)) { recompute(a); continue; }
      const big = area[a] >= area[b] ? a : b;
      const small = big === a ? b : a;
      const na = area[big], nb = area[small], n = na + nb;
      // 用当前均值重算并块后的 SSE 增量（cand 里已判定可行）
      const dr = sr[big] / na - sr[small] / nb;
      const dg = sg[big] / na - sg[small] / nb;
      const db = sb[big] / na - sb[small] / nb;
      const wd = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
      sse[big] += sse[small] + wd * (na * nb / n);
      area[big] = n;
      sr[big] += sr[small]; sg[big] += sg[small]; sb[big] += sb[small];
      alive[small] = 0; root[small] = big;
      const abig = adj[big], asmall = adj[small];
      for (const [n2, len] of asmall) {
        nbrIter++;
        if (n2 === big || !alive[n2]) continue;
        abig.set(n2, (abig.get(n2) || 0) + len);
        const an = adj[n2];
        if (an.get(small) !== undefined) an.delete(small);
        an.set(big, (an.get(big) || 0) + len);
      }
      abig.delete(small);
      asmall.clear();
      if (abig.size > maxDeg) maxDeg = abig.size;
      aliveN--; merges++;
      recompute(big);
      for (const n2 of abig.keys()) {
        if (alive[n2] && bestN[n2] === small) recompute(n2);
      }
    }
    tMerge = Date.now() - t0 - tSeg - tAbsorb;

    // ---------- 6) 落成最终标签 ----------
    {
      const rid = new Int32Array(K).fill(-1);
      let Bn = 0;
      for (let i = 0; i < K; i++) if (alive[i]) rid[i] = Bn++;
      const out = new Int32Array(N);
      for (let p = 0; p < N; p++) out[p] = rid[find2(labels[p])];
      labels = out;
      K = Bn;
    }

    // ---------- 7) 可见下限：受控合并会冻住大块，冻住的邻块没人收 -----------------
    // 所以最后再来一遍无条件吸收：剩下的块必须大到值得画一笔。
    const forceArea = Math.max(8, Math.round(N * CFG.force));
    let absorb2 = 0, dbg2 = null;
    if (forceArea > minArea) {
      abInfo = absorbSmall(labels, K, forceArea, noiseW, tinyArea);
      labels = abInfo.labels; K = abInfo.K;
      absorb2 = abInfo.merged;
      dbg2 = abInfo.dbg;
    }

    // ---------- 7.5) 过渡块归边：1~2px 混色窄块逐像素还给邻块 ----------
    // 跑两遍：一遍只能吃 1px 厚的一圈，两遍能收掉两色之间的双像素过渡。
    let snapMoved = 0, snapCand = 0;
    if (doSnap) {
      const s1 = snapThin(labels, K, noiseD);
      labels = s1.labels; K = s1.K; snapMoved += s1.moved; snapCand += s1.cand;
      if (s1.moved) {
        const s2 = snapThin(labels, K, noiseD);
        labels = s2.labels; K = s2.K; snapMoved += s2.moved; snapCand += s2.cand;
      }
    }

    // ---------- 8) 收口成最终色块：面积 / 均值 / bbox / 掩膜 ----------
    st = collect(labels, K);
    const blocks = new Array(K);
    for (let i = 0; i < K; i++) {
      const a = Math.max(1, st.area[i]);
      const x0 = st.x0[i], y0 = st.y0[i];
      const bw = st.x1[i] - x0 + 1, bh = st.y1[i] - y0 + 1;
      blocks[i] = {
        id: i, x0, y0, bw, bh,
        mask: new Uint8Array(bw * bh),
        area: st.area[i],
        color: [Math.round(st.sR[i] / a), Math.round(st.sG[i] / a), Math.round(st.sB[i] / a)],
        perim: 0, depth: -1, thin: 0,
      };
    }
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const b = blocks[labels[row + x]];
        b.mask[(y - b.y0) * b.bw + (x - b.x0)] = 1;
      }
    }

    // ---------- 9) 拓扑顺序：从贴边块 BFS，细化块压在填色块之后 ----------
    const fadj = new Array(K);
    for (let i = 0; i < K; i++) fadj[i] = new Map();
    const flink = (a, b) => {
      if (a === b) return;
      fadj[a].set(b, (fadj[a].get(b) || 0) + 1);
      fadj[b].set(a, (fadj[b].get(a) || 0) + 1);
    };
    const bBorder = new Uint8Array(K);
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const p = row + x, a = labels[p];
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) bBorder[a] = 1;
        if (x + 1 < W) flink(a, labels[p + 1]);
        if (y + 1 < H) flink(a, labels[p + W]);
      }
    }
    const bq = new Int32Array(K);
    let qh = 0, qt = 0;
    for (let i = 0; i < K; i++) {
      for (const [, len] of fadj[i]) blocks[i].perim += len;
      if (bBorder[i]) { blocks[i].depth = 0; bq[qt++] = i; }
    }
    while (qh < qt) {
      const i = bq[qh++];
      for (const n of fadj[i].keys()) {
        if (blocks[n].depth >= 0) continue;
        blocks[n].depth = blocks[i].depth + 1;
        bq[qt++] = n;
      }
    }
    for (let i = 0; i < K; i++) if (blocks[i].depth < 0) blocks[i].depth = 0;
    // 细长块是"边/线"：先让两边填完，再压线，避免线被填色盖掉。
    // 贴边块（depth 0）是底板，不参与这层回压：它天然包住整幅，
    // 边界周长必然很长，用“周长/面积”判细长会把它误判成线。
    for (let i = 0; i < K; i++) {
      const b = blocks[i];
      const disk = 2 * Math.sqrt(Math.PI * Math.max(1, b.area));
      b.thin = b.perim > disk * 1.45 ? 1 : 0;
      if (!b.thin) continue;
      if (b.depth <= 0) continue;
      let md = -1;
      for (const n of fadj[i].keys()) if (blocks[n].depth > md) md = blocks[n].depth;
      if (md + 1 > b.depth) b.depth = Math.min(md + 1, 12);
    }

    const hash01 = (a, b) => {
      const x = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
      return x - Math.floor(x);
    };
    const order = Array.from({ length: K }, (_, i) => i);
    order.sort((i, j) => {
      const a = blocks[i], b = blocks[j];
      if (a.depth !== b.depth) return a.depth - b.depth;
      const ka = a.area * (0.92 + 0.16 * hash01(seed + i * 1.37, 3.1));
      const kb = b.area * (0.92 + 0.16 * hash01(seed + j * 1.37, 3.1));
      return kb - ka;
    });
    tOrder = Date.now() - t0 - tSeg - tAbsorb - tMerge;

    // ---------- 10) 质量读数：只用于离线比对，不影响落块 ----------
    let sumErr = 0, maxErr = 0, bad = 0;
    const hist = new Uint32Array(256);
    for (let p = 0; p < N; p++) {
      const c = blocks[labels[p]].color;
      const e = Math.max(Math.abs(c[0] - R[p]), Math.abs(c[1] - G[p]), Math.abs(c[2] - B[p]));
      sumErr += e; if (e > maxErr) maxErr = e; hist[e]++;
      if (e > 24) bad++;
    }
    let acc = 0, p95 = 0;
    for (let e = 0; e < 256; e++) { acc += hist[e]; if (acc >= N * 0.95) { p95 = e; break; } }

    return {
      blocks, order, labels,
      stats: {
        W, H, N, tau: edgeK, budget, seed,
        mseT, mergeD, noiseD, minArea, forceArea, blur: useBlur ? 1 : 0,
        initial: initialK, absorb1, absorb2, merged: merges, coarse: initialK,
        blocks: K, sats: 0, resid: null,
        snapCand, snapMoved,
        dbg: dbg2 ? { failD: Array.from(dbg2.failD), failA: Array.from(dbg2.failA) } : null,
        meanErr: sumErr / N, maxErr, p95, badPct: bad / N * 100,
        ms: Date.now() - t0, tSeg, tAbsorb, tMerge, tOrder,
        hPushes, hPops, hStale, hMax, nbrIter, maxDeg,
      },
    };
  }

  root.BLOCKS = { build };
})(typeof self !== 'undefined' ? self : globalThis);
