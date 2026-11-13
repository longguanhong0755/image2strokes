/* 绘制主线 runExactCopy（"逐像素复刻 + 分区铺色 + 残差补漏"的主体）。

原来它是 runArtistMode 里的一个内部 async 函数，闭包捕获了外层上百个局部变量，
导致整个 pipeline.js 一个文件一万三千行。现在拆出来：外层状态通过 CTX 传进来。

  - 只读的名字按值传（数组 / 对象按引用，内容改了外面同样可见）
  - 会被整体重新赋值的（strokes / groups / px / …）在 CTX 里是 get/set 访问器，
    赋值仍然落回 runArtistMode 作用域的变量，后面的阶段读到的是新值

CTX 的构造在 pipeline.js 的 exactCtx()。
 */
(function (root) {
  'use strict';

  const api = {};

  api.runExactCopy = async function (CTX) {
    const { H, N, R, G, B, L, W, K, blurF, canvas, fid, flatScore, flowX, flowY, hardCap, isFlat, labels, nearestPalette, opts, palette, paper, paperPx, prog, sal, scaleB, style, traceContours, traceLineGroup, traceMaskPaths, yieldUI, splitSkPath, profFill, emitBlockFill, emitStroke, covered, paintN, groupOf, clips, coh, edge, COMPILER_FID, COMPILER_VIEW, snapOut } = CTX;
    const { clamp, luma, rand01, chainNN, hilbertIndex, LABF, srgb2labInto, srgb2lab,
      fillEnclosedHoles, fillPoly, fillPolyCov, distanceTransform, dilate, erode, rdpSimplify,
      closeMask, closeMaskDisk, compsOfLabels, thin, longestPath, ribbon, ribbonProf, mergeLoops,
      med3, box3, feather, kmeans, regionMaskOf } = CTX.U;

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
    CTX.groups.length = 0;
    for (const g of newGroups) CTX.groups.push(g);

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
        const g = CTX.groups[gi];
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
          const pg = CTX.groups[it.gi];
          const newBins = [];
          const startIdx = CTX.groups.length;
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
          for (const nb of newBins) { nb.gid = CTX.groups.length; CTX.groups.push(nb); }
          for (let i = 0; i < px.length; i++) groupOf[px[i]] = startIdx + it.assign[i];
          dropGid[it.gi] = 1;
        }
      }
    }
    {
      let dropped = false;
      for (let gi2 = 0; gi2 < Gn; gi2++) if (dropGid[gi2]) dropped = true;
      if (dropped) {
        const remapG = new Int32Array(CTX.groups.length).fill(-1);
        const kept = [];
        for (const g of CTX.groups) if (!dropGid[g.gid] && g) { remapG[g.gid] = kept.length; kept.push(g); }
        for (const g of kept) g.gid = remapG[g.gid];
        CTX.groups.length = 0;
        for (const g of kept) CTX.groups.push(g);
        for (let p = 0; p < N; p++) { const gid = groupOf[p]; if (gid >= 0 && remapG[gid] >= 0) groupOf[p] = remapG[gid]; }
      }
    }
    CTX.G_ = CTX.groups.length;
    CTX.groupUncov = new Int32Array(CTX.G_);
    CTX.gStrokeN = new Int32Array(CTX.G_);
    for (const g of CTX.groups) CTX.groupUncov[g.gid] = g.area;

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
      const zc0 = CTX.zoneCov;
      const idx = emitStroke(sp, halfs, color, 0, opt);
      if (idx < 0) return -1;
      const gained = CTX.zoneCov - zc0;
      // forceKeep：重涂（把已经盖过但颜色不对的像素改对）也要保留这一笔。
      // 否则 emitStroke 已经把画布改了、这里却把笔删掉，成品和笔流对不上。
      if (gained <= 0 && !opt.forceKeep) {
        // 整笔都落在已经画过的同色像素上：删掉它，避免"画了等于没画"的笔。
        CTX.strokes.pop();
        if (opt.zoneGid >= 0 && CTX.gStrokeN[opt.zoneGid] > 0) CTX.gStrokeN[opt.zoneGid]--;
        zeroRemoved++;
        return -1;
      }
      const st = CTX.strokes[idx];
      st.ph = ph;
      if (ph === 0) CTX.baseCount++;
      return idx;
    };
    const mkAng = (g, isBg) => {
      let ang = g.angle;
      if (g.elong < 1.55 && g.flowCoh > 0.2 && !isBg) ang = g.flowAngle;
      if (isBg) ang += (srnd(g.gid * 2.3, 4.1) - 0.5) * 0.18;
      else ang += (srnd(g.gid * 3.1, 5.2) - 0.5) * (flatArt ? 0.08 : 0.20);
      return isFinite(ang) ? ang : 0;
    };
    // 档位改笔触粗细/密度（① 更宽的带 ⇒ 更少的笔；⑤ 更窄的带 ⇒ 过渡更细），
    // 分色区和取色由（可能需要量化的）图像决定，成品精度不靠档位。
    const fidScale = [1.55, 1.24, 1, 0.88, 0.76][fid - 1];
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
      // ① 省笔档不要网点：色块就是色块，网点会把"几步纯色"又糊成灰。
      const softBg = (flatArt && g.soft && !(COMPILER_VIEW && COMPILER_VIEW.snap)) ? 1 : 0;
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
      if (!g || CTX.groupUncov[g.gid] <= 0) return;
      for (let pass = 0; pass < 3; pass++) {
        const un = CTX.groupUncov[g.gid];
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
        if (CTX.groupUncov[g.gid] <= 0) break;
        drift = Math.max(-step * 0.2, Math.min(step * 0.2,
          drift + (srnd(g.gid * 5.9 + v * 0.05 + runSeed * 0.011, 4.7) - 0.5) * step * 0.5));
        sweepAt(g, v + drift, ca, sa, halfW, ph, ang, Math.min(uMin, -g.bw), Math.max(uMax, g.bw + g.bh), dir);
        dir = -dir;
      }
      fillGaps(g, ph, ang, halfW);
      if (CTX.groupUncov[g.gid] > 0) {
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
      if (CTX.strokes.length >= hardCap || CTX.groupUncov[g.gid] <= 0) return;
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
        if (CTX.strokes.length >= hardCap) break;
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
      for (const gg of CTX.groups) {
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
        const lst = gids.slice(1).map((gid) => CTX.groups[gid].area + '@' + CTX.groups[gid].mean.join(','));
        console.log('[ringfam] n=' + gids.length + ' extraArea=' + extraArea + ' wFam=' +
          ((g.area + extraArea) / Math.max(1, per)).toFixed(1) + ' top=' + lst.slice(0, 8).join(' '));
      }
      if (extraArea > g.area * 0.9) return { path, paths, wEst, wFam: wEst, gids: [g.gid], mask: null };
      const set = new Uint8Array(CTX.G_);
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
      const s0 = CTX.strokes.length;
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
          if (si >= 0) CTX.strokes[si].ring = 1;
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
        if (si0 >= 0) CTX.strokes[si0].ring = 1;
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
        if (si2 >= 0) CTX.strokes[si2].ring = 1;
        extra++;
      }
      // 一圈走完还差的边角（画幅四角的黑角、扫描毛边）：兜底补几笔。
      // 正常情况（起笔圆头 + 平均带宽保底）这里应该是 0 笔。
      let leftN = 0;
      for (const gid of plan.gids) leftN += Math.max(0, CTX.groupUncov[gid]);
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
            residualComp(CTX.groups[groupOf[p0]] || g, comp, x0, y0, x1, y1, ph);
          }
        }
      }
      return CTX.strokes.length - s0;
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
      if (CTX.groupUncov[g.gid] <= 0) return 0;
      const s0 = CTX.strokes.length;
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
        if (CTX.groupUncov[g.gid] <= 0) break;
        const f = k === 1 ? 0.5 : i / (k - 1);
        const v = vMin + span * f;
        emitBand(gs, uA, uB, v, ca, sa, halfW, ph, ang, (n & 1) ? 1 : 0);
        n++;
      }
      // 曲线组被直带擦漏的零星像素当场换角补掉（仍在这一笔群内，不留给收笔遍）
      const uAfter = CTX.groupUncov[g.gid];
      if (uAfter > 0) fillGaps(g, ph, ang, halfW);
      if (opts.debug) console.log('[fill] gid=' + g.gid + ' area=' + g.area + ' bbox=' + g.bw + 'x' + g.bh +
        ' ang=' + ang.toFixed(2) + ' hw=' + halfW.toFixed(1) + ' k=' + k + ' span=' + span.toFixed(0) +
        ' strips=' + n + ' unc=' + uAfter + '->' + CTX.groupUncov[g.gid] + ' strokes=' + (CTX.strokes.length - s0));
      return CTX.strokes.length - s0;
    };
    const paintFull = (g, ph) => {
      // 一次画准：线走骨架笔，块走完整块面（艺术家路径的 paintBlob 原行为）。
      if (g.lineLike && !g.soft) {
        paintLine(g, ph);
        if (CTX.groupUncov[g.gid] > 0) paintBlob(g, ph);
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
      const blockG = new Uint8Array(CTX.G_);
      for (const g of CTX.groups) {
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
          const g = gid >= 0 ? CTX.groups[gid] : null;
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
          if (si >= 0) { nStrokes++; CTX.strokes[si].fl = 1; }
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
            if (sfix >= 0) CTX.strokes[sfix].fl = 1;
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
        if (!paintN[p]) { paintN[p] = 1; CTX.groupUncov[gid]--; CTX.zoneCov++; forced++; }
        if (!covered[p]) { covered[p] = 1; CTX.coveredN++; }
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
      const frameFam = new Uint8Array(CTX.G_);
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
        const inSet = new Uint8Array(CTX.G_);
        for (const gid of gids) if (gid >= 0 && gid < CTX.G_) inSet[gid] = 1;
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
          const g = CTX.groups[gid];
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
        const s0 = CTX.strokes.length;
        // 稍微伸到包围盒外，笔身会由掩膜裁掉，只覆盖真实剪影。
        const uHalf = Math.hypot(bw, bh) * 0.54 + hw;
        const v0 = vMin - hw * 0.18;
        const v1 = vMax + hw * 0.18;
        const emitSweep = (mask, useLocal, baseColor, stage) => {
          const zoneRect = { m: mask, x0, y0, w: bw, h: bh };
          const runS0 = CTX.strokes.length;
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
                CTX.strokes[si].ph = z;
                CTX.strokes[si].fl = 1;
                CTX.strokes[si].travelK = 0.08;
                if (stage) CTX.strokes[si].stage = stage;
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
          return CTX.strokes.length - runS0;
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
          CTX.strokes[si].ph = z;
          CTX.strokes[si].fl = 1;
          CTX.strokes[si].travelK = 0.05;
          if (stage) CTX.strokes[si].stage = stage;
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
          return CTX.strokes.length - s0;
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
            const gt = CTX.groups[gid];
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
        return CTX.strokes.length - s0;
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
        const preBg = CTX.groups.filter((g) => {
          if (!bgSet[g.gid] || g.lineLike) return false;
          // 大面积的整块背板，和虽被压成窄带却横跨大半画幅的背景色层，
          // 都属于起稿阶段应当先铺的空间关系。窄小杂点留给背景细化。
          return g.area >= N * 0.01 || (g.area >= 400 && (g.bw >= W * 0.18 || g.bh >= H * 0.18));
        }).sort((a, b) => (a.y0 - b.y0) || (b.area - a.area)).slice(0, 64);
        const s0 = CTX.strokes.length;
        for (const g of preBg) {
          const panelFill = g.area / Math.max(1, (g.x1 - g.x0 + 1) * (g.y1 - g.y0 + 1));
          paintBlockIn([g.gid], g.x0, g.y0, g.x1, g.y1, 0, {
            minPx: 64, maxHalf: 52 * scaleB, stage: 'preBg',
            fillHoles: 1, fillSpan: panelFill >= 0.24 ? 1 : 0, panelGround: 1,
          });
        }
        // 大块起形是抬腕横扫，不是逐笔描线；让这些笔在时间轴上快速带过，
        // 避免一两个大色面的铺底占掉前 20%，画面却还停在纸白阶段。
        for (let i = s0; i < CTX.strokes.length; i++) CTX.strokes[i].ms *= 0.02;
        if (preBg.length) await yieldUI();
      }
      // 大形体紧随背景大面落色。太阳、窗玻璃、飞机、花盆、杯身等显著对象
      // 若等到背景细化完才出现，中段会先留下它们的纸白剪影，随后再补色，
      // 回放就像“画出来又消失”。这里仍只按真实像素剪影和通用面积门槛取形，
      // 不补孔洞、不跨组取色；后续对象精修会在同一位置继续画准。
      {
        const preForms = CTX.groups.filter((g) => {
          if (g.lineLike || bgSet[g.gid] || g.area < N * 0.004) return false;
          const bw = g.x1 - g.x0 + 1, bh = g.y1 - g.y0 + 1;
          const fill = g.area / Math.max(1, bw * bh);
          return fill >= 0.12 && bw <= W * 0.76 && bh <= H * 0.76;
        }).sort((a, b) => (b.area - a.area) || (a.cy - b.cy)).slice(0, 32);
        const s0 = CTX.strokes.length;
        for (const g of preForms) {
          paintBlockIn([g.gid], g.x0, g.y0, g.x1, g.y1, 0, {
            minPx: 64, maxHalf: 44 * scaleB, stage: 'preForm',
            fillHoles: 0, pad: 0,
          });
          handX = g.cx; handY = g.cy;
        }
        for (let i = s0; i < CTX.strokes.length; i++) CTX.strokes[i].ms *= 0.025;
        if (opts.debug) console.log('[preForm] groups=' + preForms.length +
          ' strokes=' + (CTX.strokes.length - s0));
        if (preForms.length) await yieldUI();
      }
      const floodS0 = CTX.strokes.length;
      const flood = await paintBgFlood(frameFam);
      // 铺底是手臂快速带过，不是逐笔精修；否则中段会长时间停在单色纸面，
      // 真正的构图和主体要等到回放很后面才出现。
      for (let i = floodS0; i < CTX.strokes.length; i++) CTX.strokes[i].ms *= 0.03;
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
        const edgeG = BGP.bgAll.filter((g) => !frameFam[g.gid] && CTX.groupUncov[g.gid] > 0 &&
          Math.max(g.mean[0], g.mean[1], g.mean[2]) < 145);
        const edgeChain = chainNN(edgeG, (g) => [g.cx, g.cy], flood.x, flood.y);
        let edgeN = 0;
        const e0 = CTX.strokes.length;
        for (const g of edgeChain) {
          const es0 = CTX.strokes.length;
          paintFull(g, 0);
          for (let i = es0; i < CTX.strokes.length; i++) CTX.strokes[i].edge = 1;
          edgeN++;
          if ((edgeN & 15) === 0) await yieldUI();
        }
        // 收边是快速带过：笔数多但每笔很小，时间轴压到主刷的零头，
        // 不让"铺满"这一遍在边上磨太久
        for (let i = e0; i < CTX.strokes.length; i++) CTX.strokes[i].ms = 2;
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
        const par = new Int32Array(CTX.G_);
        for (let i = 0; i < CTX.G_; i++) par[i] = i;
        const find = (a) => { let r = a; while (par[r] !== r) r = par[r]; return r; };
        const uni = (a, b) => {
          a = find(a); b = find(b);
          if (a === b) return;
          if (a < b) par[b] = a; else par[a] = b;
        };
        const nearFormColor = (a, b) => {
          const A = CTX.groups[a], B = CTX.groups[b];
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
        for (const g of CTX.groups) {
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
        const s0 = CTX.strokes.length;
        for (const { f, fill } of major) {
          paintBlockIn(f.gids, f.x0, f.y0, f.x1, f.y1, 0, {
            minPx: 96, maxHalf: 54 * scaleB, stage: 'major',
            fillHoles: fill <= 0.30 ? 1 : 0, pad: 1,
          });
          handX = (f.x0 + f.x1) * 0.5; handY = (f.y0 + f.y1) * 0.5;
        }
        // 大色面 block-in 是快速铺形，后续仍有精确描边/填充重新完成它。
        for (let i = s0; i < CTX.strokes.length; i++) CTX.strokes[i].ms *= 0.06;
        if (opts.debug) console.log('[majorin] forms=' + major.length +
          ' px=' + major.reduce((a, f) => a + f.f.area, 0) +
          ' strokes=' + (CTX.strokes.length - s0));
        if (major.length) await yieldUI();
      }
      // ---- 遍1b 背景粗铺：先把所有背景组用低分辨率块面铺满 ----
      // 主色 flood 只覆盖一个颜色家族；山体、水面、墙面等次要背景若等逐组精修，
      // 中段会长时间留白。这里用背景均值做一层 noCover 的块面底稿，只负责
      // "先把背景铺完整"，不占覆盖账、也不影响后续逐组真实取色。
      {
        const bm = new Uint8Array(N);
        const draftG = new Uint8Array(CTX.G_);
        const bandOk = (g) => {
          const long = Math.max(g.bw, g.bh), short = Math.min(g.bw, g.bh);
          return g.area >= N * 0.00015 && long >= Math.min(W, H) * 0.08 &&
            short <= Math.max(W, H) * 0.045 && long >= short * 3.2;
        };
        for (const g of CTX.groups) {
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
                  const tg = CTX.groups[bgPick[0]];
                  const sp = new Float64Array([x0 - brushH * 0.2, yc, x1 + brushH * 0.2, yc]);
                  const halfs = new Float64Array([brushH * 0.58, brushH * 0.58]);
                  emitStroke(sp, halfs, tg.mean, 0, {
                    pen: 0, zoneMaskRect: { m: pm, x0, y0, w: tw, h: th },
                    noCover: 1, noZone: 1, minInk: 1, ms: 0.08 + (x1 - x0) * 0.0008,
                  });
                }
              }
              for (const [bestGid] of picks) {
                const tg = CTX.groups[bestGid];
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
                if (si >= 0) { CTX.strokes[si].fl = 1; underN++; }
              }
            }
            if ((y / tile) % 4 === 0) await yieldUI();
          }
          // 背景内部允许补的只是同一色组之间的窄缝（窗棂/反光/文字边），
          // 不再把整行首尾之间的前景连同背景一起刷掉。这样猫脸、花、杯子
          // 不会被背景色块提前盖住，水面和窗玻璃的小白缝仍能连续。
          const holeGroups = CTX.groups.filter((g) => bgSet[g.gid] && !g.lineLike && g.area >= N * 0.02)
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
                      if (qg >= 0 && !bgSet[qg] && CTX.groups[qg] && CTX.groups[qg].area >= N * 0.0004) continue;
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
              if (si >= 0) { CTX.strokes[si].fl = 1; holeStrokes++; }
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
          !ringDone.has(g.gid) && CTX.groupUncov[g.gid] > 0), handX, handY, 24);
        let bgDone = 0;
        for (const g of bgChain) {
          const bs = CTX.strokes.length;
          paintFull(g, 1);
          // 背景补准是铺完底色后的顺手收拾，不是主体刻画。压缩这些小笔
          // 的相对时长，让大背板和主体不要等到回放过半才出现。
          for (let i = bs; i < CTX.strokes.length; i++) CTX.strokes[i].ms *= 0.24;
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
        const fg = new Uint8Array(CTX.G_);
        for (const g of CTX.groups) {
          if (bgSet[g.gid] || ringDone.has(g.gid) || frameFam[g.gid]) continue;
          if (g.area < 8) continue;              // 极小碎点留给收笔遍
          fg[g.gid] = 1;
        }
        // 只用"实色填充块"做对象骨架。细线是连通的网络，若也参与并查集，
        // 窗框会把窗玻璃、花盆、书和桌面全部串成一个巨型对象，回放就会
        // 整幅东补一笔西补一笔。颜色相近且相邻的填充块先归属同一对象；
        // 轮廓线随后只挂到真正相邻的填充对象上，不再作为跨对象桥梁。
        const par = new Int32Array(CTX.G_).fill(-1);
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
          const A = CTX.groups[a], B = CTX.groups[b];
          if (!A || !B || A.lineLike || B.lineLike) return false;
          return Math.max(Math.abs(A.mean[0] - B.mean[0]),
            Math.abs(A.mean[1] - B.mean[1]),
            Math.abs(A.mean[2] - B.mean[2])) <= 38;
        };
        for (let y = 0; y < H; y++) {
          const row = y * W;
          for (let x = 0; x < W; x++) {
            const p = row + x, a = groupOf[p];
            if (a < 0 || !fg[a] || CTX.groups[a].lineLike) continue;
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
        for (let gid = 0; gid < CTX.G_; gid++) {
          if (!fg[gid] || CTX.groups[gid].lineLike) continue;
          const rt = find(gid);
          let o = cmap.get(rt);
          if (!o) { o = { gids: [], gs: [], area: 0, x0: W, y0: H, x1: -1, y1: -1 }; cmap.set(rt, o); }
          addToObj(o, CTX.groups[gid]);
        }
        // 每条线统计它与哪些填充对象直接相邻；取邻接像素最多的那个作为归属。
        // 没有直接邻接时按 bbox 距离找最近对象，避免孤立轮廓落到片尾。
        const roots = [...cmap.keys()];
        const rootObj = new Map(roots.map((r) => [r, cmap.get(r)]));
        const looseLines = [];
        for (let gid = 0; gid < CTX.G_; gid++) {
          if (!fg[gid] || !CTX.groups[gid].lineLike) continue;
          const g = CTX.groups[gid], votes = new Map();
          for (let y = g.y0; y <= g.y1; y++) {
            const row = y * W;
            for (let x = g.x0; x <= g.x1; x++) {
              const p = row + x;
              if (groupOf[p] !== gid) continue;
              const hit = (q) => {
                const ng = groupOf[q];
                if (ng < 0 || ng === gid || !fg[ng] || CTX.groups[ng].lineLike) return;
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
          const lp = new Int32Array(CTX.G_).fill(-1);
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
      if (objectPass) console.log('[objpass] start objects=' + pobjs.length + ' strokes=' + CTX.strokes.length +
        ' bg=' + bgSet.reduce((a, b) => a + b, 0) + '/' + CTX.G_);
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
        const inSet = new Uint8Array(CTX.G_);
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
        const rimIs = new Uint8Array(CTX.G_);
        for (const g of mk.rimGs) rimIs[g.gid] = 1;
        const fs = Math.max(0.95, fidScale);
        const s0 = CTX.strokes.length;
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
              col = bestGid >= 0 ? colorOf(CTX.groups[bestGid]) : colorOf(roles.seed);
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
            if (si0 >= 0) CTX.strokes[si0].st = 1;
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
          for (const g of mk.rimGs) left += Math.max(0, CTX.groupUncov[g.gid]);
          console.log('[outline] bbox=[' + o.x0 + ',' + o.y0 + ',' + o.x1 + ',' + o.y1 + '] fill=' + mk.fillN +
            ' rim=' + mk.rimN + ' paths=' + pathsN + ' strokes=' + (CTX.strokes.length - s0) +
            ' left=' + left + '/' + mk.rimN);
        }
        return CTX.strokes.length - s0;
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
        const left = roles.rimC.filter((g) => CTX.groupUncov[g.gid] > 0 && gErr(g) > 10);
        if (!left.length) return 0;
        const s0 = CTX.strokes.length;
        // 按色调粗分簇（≤24/通道）：扫描噪点/暗边/亮芯并成几簇，一簇一笔；
        // 色差在 24 内，成品误差仍受误差守卫控制。
        for (const cl of colorClusters(left, 24)) {
          if (cl.length === 1) paintRegionFill(cl[0], ph);
          else fillGroupCluster(cl, ph);
        }
        if (opts.debug) console.log('[rimclu] left=' + left.length + ' strokes=' + (CTX.strokes.length - s0));
        return CTX.strokes.length - s0;
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
        const s0 = CTX.strokes.length;
        paintBlockIn(o.gids, o.x0, o.y0, o.x1, o.y1, ph, {
          minPx: 24, pad: 1,
          maxHalf: Math.max(18, Math.min(54 * scaleB,
            Math.sqrt(Math.max(24, solidN)) * 0.20)),
        });
        if (opts.debug && CTX.strokes.length > s0) console.log('[undercoat] bbox=[' + o.x0 + ',' + o.y0 + ',' +
          o.x1 + ',' + o.y1 + '] strokes=' + (CTX.strokes.length - s0));
        return CTX.strokes.length - s0;
      };
      // 字心整块填满：同一对象的填充组连续发出，中间不插别的字。
      const paintObjFill = (o, roles, mk, ph) => {
        if (!roles.fill.length) return 0;
        const s0 = CTX.strokes.length;
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
          '] fillG=' + roles.fill.length + ' clusters=' + clusters.length + ' strokes=' + (CTX.strokes.length - s0));
        return CTX.strokes.length - s0;
      };
      // 对象内其余色块 + 描边没盖到的零碎
      const paintObjRest = (o, roles, mk, ph) => {
        const s0 = CTX.strokes.length;
        const others = roles.other.slice().sort((a, b) => b.area - a.area);
        for (const g of others) {
          if (g.lineLike) paintFull(g, ph);
          else paintRegionFill(g, ph);
        }
        if (opts.debug && CTX.strokes.length > s0) console.log('[objrest] other=' + others.length +
          ' strokes=' + (CTX.strokes.length - s0));
        return CTX.strokes.length - s0;
      };
      // 对象级误差守卫：把"没盖到"或"盖错了"的像素按 4 邻接连通块收拾，
      // 每块最多两笔（主色一遍、偏色残余一遍）。笔数由真实误差区域决定。
      const cleanupObj = (o, mk, ph) => {
        const inSet = new Uint8Array(CTX.G_);
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
          const a = CTX.groups[gid];
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
        const s0 = CTX.strokes.length;
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
        if (opts.debug && CTX.strokes.length > s0) console.log('[clean] bbox=[' + o.x0 + ',' + o.y0 + ',' + o.x1 +
          ',' + o.y1 + '] comps=' + nComp + ' strokes=' + (CTX.strokes.length - s0));
        return CTX.strokes.length - s0;
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
        for (let i = s0; i < CTX.strokes.length; i++) ms += CTX.strokes[i].ms || 0;
        if (ms > cap * 1.08) {
          const k = cap / ms;
          for (let i = s0; i < CTX.strokes.length; i++) CTX.strokes[i].ms *= k;
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
        const s0 = CTX.strokes.length;
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
        for (let i = s0; i < CTX.strokes.length; i++) CTX.strokes[i].ms *= 0.06;
        if (opts.debug) console.log('[structure] n=' + structural.length +
          ' strokes=' + (CTX.strokes.length - s0) + ' bbox=' + structural.map((o) =>
            '[' + [o.x0, o.y0, o.x1, o.y1].join(',') + ']').join(' '));
        await yieldUI();
      }
      let objDone = 0;
      const kinPainted = new Set();
      for (const o of pobjs) {
        const obStart = CTX.strokes.length;
        if (!objectPass && o.kinKey !== undefined && !kinPainted.has(o.kinKey)) {
          kinPainted.add(o.kinKey);
          let solidN = 0;
          for (const gid of o.kinGids) {
            const g = CTX.groups[gid];
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
              ' bbox=[' + kb.join(',') + '] strokes=' + (CTX.strokes.length - obStart));
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
          for (let i = obStart; i < CTX.strokes.length; i++) CTX.strokes[i].ms *= 0.12;
          capObjectTime(obStart, o);
          for (let i = obStart; i < CTX.strokes.length; i++) CTX.strokes[i].ob = objDone;
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
        const f0 = CTX.strokes.length;
        paintObjFill(o, roles, mk, 2);
        // 背板是手臂大幅铺色，不能按小细节的笔速占掉大半时间；
        // 压短这一段时长，让后续主体在背景成形后尽快出现。
        if (o.backdrop) {
          for (let i = f0; i < CTX.strokes.length; i++) CTX.strokes[i].ms *= 0.28;
        }
        // 换对象时手停一下"看"下一块（挂在第一笔的落笔时间上）
        if (CTX.strokes.length > f0) {
          const st0 = CTX.strokes[f0];
          st0.ms = (st0.ms || 0) + 150 + srnd(o.cx * 1.3 + o.cy * 0.7 + runSeed * 0.07, 12.4) * 200;
        }
        paintObjRest(o, rolesO, mk, 2);
        cleanupObj(o, mk, 2);
        capObjectTime(obStart, o);
        // 调试标记：这一段笔都属于同一个对象（真机排查"先描边再填满"用）
        for (let i = obStart; i < CTX.strokes.length; i++) CTX.strokes[i].ob = objDone;
        // 跨大半画幅的纯线结构（外框、整页装饰线）是快速定界笔，
        // 不能按小细节的速度吃掉大半时间；否则主体和文字会被拖到片尾。
        const lineShare = o.gs.length ? o.gs.filter((g) => g.lineLike).length / o.gs.length : 0;
        const spanLarge = (o.x1 - o.x0 + 1) > W * 0.55 || (o.y1 - o.y0 + 1) > H * 0.55;
        if (lineShare >= 0.70 && spanLarge) {
          for (let i = obStart; i < CTX.strokes.length; i++) CTX.strokes[i].ms *= 0.12;
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
      if (objectPass) console.log('[objpass] done objects=' + pobjs.length + ' strokes=' + CTX.strokes.length);
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
            CTX.strokes[si].stage = stage;
            CTX.strokes[si].travelK = 0.12;
            CTX.strokes[si].fl = 1;
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
            CTX.strokes[si].stage = stage;
            CTX.strokes[si].travelK = 0.06;
            CTX.strokes[si].fl = 1;
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
              CTX.strokes[si].stage = 'closed:line';
              CTX.strokes[si].travelK = 0.20;
              CTX.strokes[si].fl = 1;
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
        const textureFrom = CTX.strokes.length;
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
          CTX.strokes[si].stage = 'closed:page-texture';
          CTX.strokes[si].travelK = 0.055;
          CTX.strokes[si].fl = 1;
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
        for (let i = textureFrom; i < CTX.strokes.length; i++) textureMs += CTX.strokes[i].ms || 0;
        const textureBudget = Math.max(30, Math.min(90,
          Math.sqrt(Math.max(1, pageW * pageH)) * 0.0022));
        const textureK = textureMs > 0 ? textureBudget / textureMs : 1;
        for (let i = textureFrom; i < CTX.strokes.length; i++) CTX.strokes[i].ms *= textureK;
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
      CTX.groupUncov.fill(0);
      for (let p = 0; p < N; p++) {
        if (segPaper[p] || covered[p]) continue;
        const gid = groupOf[p];
        if (gid >= 0) CTX.groupUncov[gid]++;
      }
      CTX.zoneCov += good;
      pfClosedRegions = order.length;
      pfObjects = order.length;
      pfRing = order.some((r) => r.mode === 'ring');
      painterBgFill = 'closed';
      if (opts.debug) console.log('[closed] done regions=' + order.length + ' good=' + good +
        ' bad=' + bad + ' strokes=' + CTX.strokes.length + ' ms=' + (Date.now() - tEx));
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
          CTX.strokes[si].stage = stage;
          CTX.strokes[si].travelK = stage === 'compiler:edge' ? 0.12 : 0.06;
          CTX.strokes[si].fl = 1;
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
        // 外轮廓这一笔只负责"封住接缝"，不负责画墨线本身：
        // 墨线由该色组自己的细线笔（compiler:line / ink-line）画。
        // 旧公式按区域厚度给笔身（厚区域 → 6~7px 半径），于是猫身奶油色
        // 被啃掉一圈、墨线被撑成 13px 宽——看起来就是"轮廓很假"。
        // 现在固定成 2~4px 的窄带，并整体向外偏半像素，正好压在抗锯齿边上。
        const hw = clamp((r.mode === 'ring' ? r.thickness * 0.10 : r.thickness * 0.05) + 1.25,
          1.15, 2.2) * Math.min(1.15, scaleB + 0.12);
        // 外法向用"多边形质心 → 顶点"近似，够用且无额外开销。
        let ccx = 0, ccy = 0;
        for (let i = 0; i < loop.n; i++) { ccx += xs[i * 2]; ccy += xs[i * 2 + 1]; }
        ccx /= loop.n; ccy /= loop.n;
        const OUT = 0.55;
        // 只在"真的有边"的地方描轮廓。柔和渐隐（比如浅色圆盘向白纸过渡）
        // 在原图里根本没有线，硬描一圈就是在画面里凭空加一个圆——回放里
        // 一眼就看出不是人画的。判据可测量：沿轮廓取内外两点比色差，
        // 平均差太小就跳过（这一笔交给色块本身的填充）。
        {
          let dsum = 0, dcnt = 0;
          const step0 = Math.max(1, Math.floor(loop.n / 40));
          for (let i = 0; i < loop.n; i += step0) {
            const px0 = r.x0 + xs[i * 2], py0 = r.y0 + xs[i * 2 + 1];
            const dx0 = px0 - (r.x0 + ccx), dy0 = py0 - (r.y0 + ccy);
            const dl = Math.hypot(dx0, dy0) || 1;
            const nx = dx0 / dl, ny = dy0 / dl;
            const ix = Math.round(px0 - nx * 2.0), iy = Math.round(py0 - ny * 2.0);
            const ox = Math.round(px0 + nx * 2.6), oy = Math.round(py0 + ny * 2.6);
            if (ix < 1 || iy < 1 || ox < 1 || oy < 1 || ox >= W - 1 || oy >= H - 1) continue;
            const pi = iy * W + ix, po = oy * W + ox;
            const li = r.x0 + 0, lz = r.y0;
            const bi = (iy - lz) * r.bw + (ix - li);
            if (bi < 0 || bi >= r.fillMask.length || !r.fillMask[bi]) continue;
            dsum += Math.abs(R[pi] - R[po]) + Math.abs(G[pi] - G[po]) + Math.abs(B[pi] - B[po]);
            dcnt++;
          }
          if (dcnt >= 6 && dsum / dcnt < 30) return 0;
        }
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
              const px0 = r.x0 + xs[j * 2], py0 = r.y0 + xs[j * 2 + 1];
              const dx0 = px0 - (r.x0 + ccx), dy0 = py0 - (r.y0 + ccy);
              const dl = Math.hypot(dx0, dy0) || 1;
              sp[i * 2] = px0 + dx0 / dl * OUT;
              sp[i * 2 + 1] = py0 + dy0 / dl * OUT;
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
          const texFrom = CTX.strokes.length;
          // 纹理只覆盖原图里真实可见的本色像素；闭包中属于子孙对象的
          // 占位像素由子孙层恢复，不在底色纹理阶段反复涂改。
          fillRegion(r, r.mask || mask, ph, stage + '-texture', null, 1);
          for (let i = texFrom; i < CTX.strokes.length; i++) CTX.strokes[i].ms *= 0.22;
          made += CTX.strokes.length - texFrom;
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

      const paintPageParity = (r, ph, withUndercoat = true) => {
        compilerPlan.pageParityUsed = true;
        let made = withUndercoat ? fillPageUndercoat(r, ph) : 0;
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
        // 下限同时决定"背景被重刷多少遍"：旧值（N*0.00045 ≈ 470px）会让
        // 一整片平涂背景被拆成两千多笔小补丁来回刷——人铺底色不会这样。
        // 抬到 N*0.0035 后只有成片的明暗/渐变块参与，底色本身已由原子块
        // 一次铺满，观感不变而笔数大幅下降。
        const bgMinArea = Math.max(900, Math.round(N * 0.0012));
        const bgOwnMin = 0.85;
        let filteredGroups = 0;
        for (const g of CTX.groups) {
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
        //
        // 人铺底色是"几大笔推开"，不是把背景拆成上千个小补丁来回点。
        // 旧实现按原色组逐组 paintFull，一整片平涂粉底因此要两千多笔。
        // 这里改成按约 110px 的格子整块推进：每格一笔，颜色取格内原图
        // 均值，笔身裁在页面底板掩膜内。渐变/暗角照样保留（每格自带局部
        // 色），笔数从上千降到几十。
        // 底色掩膜 = 所有"页面级"像素（含白纸本身）。只看当前区域的 paintMask
        // 会漏掉同页的另一个底色区（例如浅色圆盘旁边的白纸），那些像素就
        // 永远停在原子底板的单色上，成品里出现"圆盘颜色铺满整幅"或一圈白边。
        const groundMask = new Uint8Array(N);
        for (let p = 0; p < N; p++) {
          const oid = plan.owner[p];
          if (oid >= 0) {
            const rr = plan.regions[oid];
            if (rr && (rr.pageGround || rr === r)) groundMask[p] = 1;
          }
        }
        for (let p = 0; p < N; p++) if ((r.paintMask || r.fillMask)[p]) groundMask[p] = 1;
        // 底色是否"真的是平的"：看**格内**亮度标准差的中位数。平涂/渐变在
        // 一格之内几乎没变化（中位数很低），扫描纹理/网点/暗角则很高。
        // 用格内残差而不是全图方差，是因为全图方差只反映"跨页有渐变"——
        // 而那恰好是格子铺色能忠实还原的部分。
        const probeCell = Math.max(24, Math.round(Math.min(W, H) * 0.062));
        let sd = 1e9, gn = 0;
        {
          const sds = [];
          for (let gy = 0; gy < H; gy += probeCell) {
            for (let gx = 0; gx < W; gx += probeCell) {
              const gx1 = Math.min(W, gx + probeCell) - 1, gy1 = Math.min(H, gy + probeCell) - 1;
              let a = 0, b = 0, c = 0;
              for (let yy = gy; yy <= gy1; yy++) {
                const row = yy * W;
                for (let xx = gx; xx <= gx1; xx++) {
                  const p = row + xx;
                  if (!groundMask[p]) continue;
                  const l = 0.299 * R[p] + 0.587 * G[p] + 0.114 * B[p];
                  a += l; b += l * l; c++;
                }
              }
              if (c >= probeCell * probeCell * 0.5) {
                gn += c;
                sds.push(Math.sqrt(Math.max(0, b / c - (a / c) * (a / c))));
              }
            }
          }
          if (sds.length) { sds.sort((x, y) => x - y); sd = sds[sds.length >> 1]; }
        }
        const smoothGround = sd <= 12;
        if (opts.debug) console.log('[compiler-ground] sd=' + (sd === 1e9 ? 'inf' : sd.toFixed(2)) +
          ' px=' + gn + ' smooth=' + smoothGround + ' root=' + r.id);
        // 量化档（①②）：底色区本身就是几个纯色区域，逐组铺平比逐格采样更准——
        // 格子会把色块边界切成 90px 的圆角方斑，逐组铺平则是沿原图等色线的干净边。
        if (!smoothGround || (COMPILER_VIEW && COMPILER_VIEW.snap)) {
          // 照片/扫描件：底色里有真实的扫描纹理与暗角，逐原色组重铺才能保住
          // 这些层次，因此保留旧路径（组数本身受 bgMinArea 控制）。
          for (const g of bgGroups) {
            const start = CTX.strokes.length;
            for (let yy = g.y0; yy <= g.y1; yy++) {
              const row = yy * W;
              for (let xx = g.x0; xx <= g.x1; xx++) {
                const p = row + xx;
                if (groupOf[p] === g.gid) paintN[p] = 0;
              }
            }
            CTX.groupUncov[g.gid] = g.area;
            paintFull(g, 1);
            for (let i = start; i < CTX.strokes.length; i++) {
              CTX.strokes[i].stage = 'compiler:page-bg';
              CTX.strokes[i].travelK = 0.055;
              CTX.strokes[i].fl = 1;
              CTX.strokes[i].ms *= 0.10;
            }
            if (CTX.strokes.length > start) made += CTX.strokes.length - start;
          }
          if (opts.debug) console.log('[compiler-page] bgGroups=' + bgGroups.length +
            ' filtered=' + filteredGroups + ' strokes=' + made + ' root=' + r.id);
          return made;
        }
        // 底色格边长随还原程度缩放：省笔档格子更大（几笔铺完），
        // 极致档更小（色场起伏跟得更紧）。基准 = 5.5% 短边。
        const cellScale = COMPILER_VIEW ? COMPILER_VIEW.cell : 1;
        const cellPx = Math.max(24, Math.round(Math.min(W, H) * 0.055 * cellScale));
        // 纸面（近白）底色片单独按组一次铺平：格子把"白纸 + 浅色圆盘"
        // 混在一格里会平均成中间色，成品就出现"底色铺满整幅画"和一圈白边。
        for (const g of CTX.groups) {
          if (g.area < N * 0.004) continue;
          const ml = 0.299 * g.mean[0] + 0.587 * g.mean[1] + 0.114 * g.mean[2];
          if (ml < 232) continue;
          const gm = new Uint8Array(g.bw * g.bh);
          let cnt = 0;
          for (let yy = g.y0; yy <= g.y1; yy++) {
            const row = yy * W + g.x0;
            for (let xx = 0; xx < g.bw; xx++) {
              if (groupOf[row + xx] === g.gid) { gm[(yy - g.y0) * g.bw + xx] = 1; cnt++; }
            }
          }
          if (cnt < N * 0.003) continue;
          const start = CTX.strokes.length;
          emitBlockFill(g.x0, g.y0, g.bw, g.bh, gm, g.mean, 1, {
            stage: 'compiler:page-bg',
            ms: Math.round(150 + Math.min(260, Math.sqrt(cnt) * 0.22)),
          });
          for (let i = start; i < CTX.strokes.length; i++) {
            CTX.strokes[i].travelK = 0.055;
            CTX.strokes[i].fl = 1;
          }
          if (CTX.strokes.length > start) made += CTX.strokes.length - start;
        }
        // 省笔/简洁档：图像已被量化成有限几个色，同一行里颜色相同的相邻格
        // 要并成"一条长横扫"。逐格落笔会把大色块画成一堆带圆角的方斑
        // （回放里就是"补丁/云斑"），并成长条之后色块边界才是干净的一条边。
        const washMerge = !!(COMPILER_VIEW && COMPILER_VIEW.row);
        const washSnap = (COMPILER_VIEW && COMPILER_VIEW.snap) ? ((c) => nearestPalette(c)) : ((c) => c);
        const cellColor = (gx, gy, gx1, gy1) => {
          let sr = 0, sg = 0, sb = 0, cn = 0;
          // 取色/裁切都用"底色区"（页面级像素 + 背景类色块 + 无主像素），
          // 而不是页根 mask：同页的另一个底色碎片（浅色圆盘旁边的白纸）
          // 如果不进格子，又没有任何对象事务认领它，成品就停在原子底板的
          // 单色上——看起来像"主体色铺满了整幅画"。
          for (let yy = gy; yy <= gy1; yy++) {
            const row = yy * W;
            for (let xx = gx; xx <= gx1; xx++) {
              const p = row + xx;
              if (!groundMask[p]) continue;
              sr += R[p]; sg += G[p]; sb += B[p]; cn++;
            }
          }
          if (cn < cellPx * cellPx * 0.12) return null;
          return washSnap([sr / cn, sg / cn, sb / cn]);
        };
        const emitSpan = (x0, x1, cyC, col, half) => {
          const start = CTX.strokes.length;
          // 一笔横跨整格（略微超出格子交给掩膜裁切），笔身约为格子一半高。
          const sp = new Float64Array(6);
          sp[0] = x0 - half * 0.35; sp[1] = cyC;
          sp[2] = (x0 + x1) * 0.5; sp[3] = cyC;
          sp[4] = x1 + half * 0.35; sp[5] = cyC;
          const halfs = new Float64Array(3).fill(half * 0.62);
          emitPlan(sp, halfs, col, ph, {
            pen: 0, zoneMask: groundMask, noCover: 1, noZone: 1,
            minInk: 1, forceKeep: 1, ms: Math.round(140 + (x1 - x0) * 1.6),
          });
          for (let i = start; i < CTX.strokes.length; i++) {
            CTX.strokes[i].stage = 'compiler:page-bg';
            CTX.strokes[i].travelK = 0.055;
            CTX.strokes[i].fl = 1;
          }
          if (CTX.strokes.length > start) made += CTX.strokes.length - start;
        };
        for (let gy = 0; gy < H; gy += cellPx) {
          const gy1 = Math.min(H, gy + cellPx) - 1;
          const cyC = (gy + gy1) * 0.5;
          if (!washMerge) {
            for (let gx = 0; gx < W; gx += cellPx) {
              const gx1 = Math.min(W, gx + cellPx) - 1;
              const col = cellColor(gx, gy, gx1, gy1);
              if (col) emitSpan(gx, gx1, cyC, col, cellPx * 0.5);
            }
            continue;
          }
          // 量化档：整行按颜色分成长条；半宽给到 0.9 格，行与行之间微微重叠，
          // 否则格子的上下留缝会露成一条条浅色横线（比色块本身更显眼）。
          let runX0 = -1, runX1 = -1, runCol = null;
          const flush = () => {
            if (runCol) emitSpan(runX0, runX1, cyC, runCol, cellPx * 0.9);
            runCol = null;
          };
          for (let gx = 0; gx < W; gx += cellPx) {
            const gx1 = Math.min(W, gx + cellPx) - 1;
            const col = cellColor(gx, gy, gx1, gy1);
            if (!col) { flush(); continue; }
            if (runCol && Math.abs(col[0] - runCol[0]) + Math.abs(col[1] - runCol[1]) +
                Math.abs(col[2] - runCol[2]) < 12) { runX1 = gx1; continue; }
            flush();
            runX0 = gx; runX1 = gx1; runCol = col;
          }
          flush();
        }
        if (opts.debug) console.log('[compiler-page] bgGroups=' + bgGroups.length +
          ' filtered=' + filteredGroups + ' strokes=' + made + ' root=' + r.id);
        return made;
      };

      // 细墨线（≤3.2px 的胡须、外轮廓线、字边）：一笔到底。
      // 人画一根胡须就是一笔；旧路径按 42px 切段、又把笔身按 thickness 抬高到
      // 3.4~3.6px，于是 2px 的线被画成 40px 一段的粗短笔，来回好几道，
      // 边缘犬牙交错。这里改成：不切段、笔身贴真实内切半径。
      const INK_THIN_T = 3.2;
      const paintLineRegion = (r, ph, fine) => {
        const thinInk = !fine && (r.thickness || 0) <= INK_THIN_T && r.mode === 'line';
        const paths = traceMaskPaths(r.mask, r.bw, r.bh, r.x0, r.y0);
        if (!paths.length) return fillRegion(r, r.fillMask, ph, 'compiler:line-fallback');
        const zmr = { m: r.fillMask, x0: r.x0, y0: r.y0, w: r.bw, h: r.bh };
        const hw = clamp(r.thickness * 0.68 + 0.85, 1.2, 5.0);
        // 高精度描边：按真实色带的内切半径给笔身，并缩短取色段。每条短段
        // 的 localColor 只统计本笔在描边掩膜内盖到的像素，亮边/暗边不会被
        // 一个长段的中点色抹平。
        const dtv = (fine || thinInk) ? distanceTransform(r.mask, r.bw, r.bh) : null;
        const dtAt = (x, y) => {
          const xx = Math.round(x) - r.x0, yy = Math.round(y) - r.y0;
          if (xx < 0 || yy < 0 || xx >= r.bw || yy >= r.bh) return 0;
          const d = dtv[yy * r.bw + xx];
          return d >= 1e8 ? 0 : d;
        };
        let made = 0;
        // 细墨线不切段（一整个骨架 = 一笔）；其它情况保持原来的取色粒度。
        const segMax = thinInk ? Math.round(560 * scaleB) : (fine ? 42 : 240);
        for (const path of paths) {
          for (const part of splitSkPath(path, segMax)) {
            if (part.n < 2) continue;
            const halfs = new Float64Array(part.n);
            for (let i = 0; i < part.n; i++) {
              halfs[i] = thinInk
                // dt 就是内切半径（像素）：+0.35 补半像素抗锯齿，别再乘系数加粗。
                ? clamp(dtAt(part.pts[i * 2], part.pts[i * 2 + 1]) * 1.06 + 0.35, 0.7, 2.8)
                : (fine
                  ? clamp(dtAt(part.pts[i * 2], part.pts[i * 2 + 1]) / 3 * 1.35 + 1.25, 1.7, 7.5)
                  : profFill(part.n, hw, r.id * 2.1 + part.len * 0.13 + runSeed * 0.31)[i]);
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
        // 页面底板/画框只是承载内容的背景事务，不能成为所有前景对象的
        // 共同事务根；否则整页文字和图形会塌缩成一个巨型对象。
        while (t.parent && !backgroundSet.has(t.parent) &&
               !backgroundLike(t.parent) && !t.parent.frameLike) t = t.parent;
        return t;
      };
      const childKey = (r) => r.cy * W + r.cx;
      const txRecords = [];
      // 回放层用事务编号把“起笔到抬笔”绑定成一个不可拆事件。tx/step
      // 只是可选扩展字段，不改变 API 1 的既有笔画结构。
      const txStepOf = (st) => {
        const stage = String((st && st.stage) || '');
        // detail-line / page-bg / repair / cover 都是事务内收尾动作；
        // 必须排在普通 line 之前判断，否则会丢失“细节”语义并拖慢尾部时间轴。
        if (/detail|texture|page-bg|repair|cover/i.test(stage)) return 'detail';
        if (/edge|outline/i.test(stage)) return 'outline';
        if (/line/i.test(stage)) return 'line';
        if (/fill|block|parent|seam/i.test(stage)) return 'fill';
        return st && st.blk ? 'fill' : 'detail';
      };
      const commitTx = (from, txId, txKind, box) => {
        if (CTX.strokes.length <= from) return null;
        const txSeq = txRecords.length;
        for (let i = from; i < CTX.strokes.length; i++) {
          const st = CTX.strokes[i];
          st.tx = txId;
          st.txKind = txKind;
          st.txSeq = txSeq;
          st.step = txStepOf(st);
        }
        const rec = {
          id: txId, seq: txSeq, kind: txKind,
          strokeStart: from, strokeEnd: CTX.strokes.length,
          x0: box && box.x0, y0: box && box.y0,
          x1: box && box.x1, y1: box && box.y1,
        };
        txRecords.push(rec);
        return rec;
      };
      const addObjectPause = (from, seed) => {
        if (CTX.strokes.length <= from) return;
        // 换对象时短暂“看”下一块。pause 落在一号笔上，不改变总笔数。
        CTX.strokes[from].ms += 150 + srnd(seed, 11.7) * 260;
        CTX.strokes[from].travelK = Math.max(0.16, CTX.strokes[from].travelK || 0.06);
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

      // 一个不可拆的页面底板事务：
      //   整页底色原子块 → 完整画框 → 蓝色/黑色交界与底板纹理。
      // 画框必须紧跟底色，不能等几千条背景纹理笔之后再出现；否则回放中
      // 会先看到半页蓝底，再逐段补黑框。纹理只能在这两者之后处理，且
      // 不允许再从基础底板 mask 中挖洞。
      const pageBaseStart = CTX.strokes.length;
      // 人的第一笔是"把纸铺满"：不论区域分解把画面切成多少碎块，纸面必须
      // 一次到位。此前底板只用页根区域的 mask，被分解判给别的对象的窄条
      // （例如海报右缘那条 13px 竖带）在回放早期一直是画布白，直到它的
      // 对象事务在 79% 处才补上，肉眼就是"边上有一条白线"。
      // 这一笔不承担任何区域语义，只保证"整张纸有底色"；后面所有对象都盖
      // 在它上面，因此成品像素与笔序的相对关系不变。
      {
        const root = pageFills[0] || null;
        // 纸色取"没有任何区域认领的那片像素"里最多的颜色，而不是页根均值。
        // 页根常常同时覆盖主体和边上的纸面，均值会落在主体色上——那样
        // 第一笔就把本该是白纸的四周刷成了浅粉色。
        let paperCol = null;
        {
          // 纸色判定：四个角都是接近纯白 → 这张画就是"白纸"（人也是这么看的，
          // 先看一眼纸角）。否则说明画面是满幅底色（海报类），交给页根均值。
          // 旧写法用页根均值，页根常常同时吃进主体和四周的纸面，均值落在主体
          // 色上，第一笔就把本该是白纸的四周刷成了主体色。
          const pad = Math.max(2, Math.round(Math.min(W, H) * 0.02));
          const corners = [[0, 0], [W - pad, 0], [0, H - pad], [W - pad, H - pad]];
          const means = [];
          for (const [bx, by] of corners) {
            let r2 = 0, g2 = 0, b2 = 0, n2 = 0;
            for (let y = by; y < Math.min(H, by + pad); y++) {
              for (let x = bx; x < Math.min(W, bx + pad); x++) {
                const p = y * W + x;
                r2 += R[p]; g2 += G[p]; b2 += B[p]; n2++;
              }
            }
            if (n2) means.push([r2 / n2, g2 / n2, b2 / n2]);
          }
          if (means.length === 4) {
            const lum = means.map((c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]);
            const lo = Math.min(...lum), hi = Math.max(...lum);
            if (lo >= 238 && hi - lo <= 14) {
              paperCol = [
                means.reduce((a, c) => a + c[0], 0) / 4,
                means.reduce((a, c) => a + c[1], 0) / 4,
                means.reduce((a, c) => a + c[2], 0) / 4,
              ];
            }
          }
        }
        const wash = paperCol || (bgFirstPlan && bgFirstPlan.washColor) ||
          (root && (root.color || (root.model && root.model.mean))) || null;
        if (wash) {
          const whole = new Uint8Array(N).fill(1);
          emitBlockFill(0, 0, W, H, whole, wash, 0, {
            stage: 'compiler:page-wash',
            zoneGid: undefined,
            // 只把纸面颜色落下，不抢占覆盖率账：真正的"覆盖"仍由各对象
            // 的精确笔负责，避免把尚未落笔的对象误记成已完成。
            noZone: 1,
            noCover: 1,
            noCanvas: 1,
            ms: Math.round(260 + Math.min(420, Math.sqrt(N) * 0.55)),
          });
        }
      }
      let bgDone = 0;
      const bgTotal = Math.max(1, pageFills.length + frameFills.length +
        pageFills.filter((r) => {
          const rootOwn = r.fillArea / Math.max(1, r.bw * r.bh);
          return !!(r.model && (r.model.kind !== 'const' ||
            (rootOwn >= 0.45 && (r.model.err || 0) >= 1)));
        }).length);
      for (const r of pageFills) {
        fillPageUndercoat(r, regionPhase(r));
        bgDone++;
        prog(0.685 + 0.08 * bgDone / bgTotal, '编译器：整页底色一次落下…');
        await yieldUI();
      }
      for (const r of frameFills) {
        paintRegionBase(r);
        bgDone++;
        prog(0.70 + 0.10 * bgDone / bgTotal, '编译器：整页底色后立即压回画框…');
        await yieldUI();
      }
      for (const r of pageFills) {
        const rootOwn = r.fillArea / Math.max(1, r.bw * r.bh);
        const texturedRoot = !!(r.model && (r.model.kind !== 'const' ||
          (rootOwn >= 0.45 && (r.model.err || 0) >= 1)));
        if (texturedRoot) {
          paintPageParity(r, regionPhase(r), false);
          bgDone++;
          prog(0.72 + 0.12 * bgDone / bgTotal, '编译器：在完整底板内补纹理…');
          await yieldUI();
        }
      }

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
      const transactions = [...txMap.values()];
      if (opts.debug) console.log('[compiler:tx-premerge] roots=' + transactions.length);

      // 同一字形的填色、描边、阴影在量化后可能变成互不相连的根。只有当
      // 两个事务的包围盒几乎重合、尺寸相近且中心贴近时才合并；不能仅凭
      // “小框在大框内”合并，否则整页的父子对象会沿包含关系传递塌缩成一个
      // 巨型事务，逐行逐字回放会消失。判据只看几何，不依赖颜色、坐标、
      // 文件名或样例编号。
      for (let changed = true; changed;) {
        changed = false;
        outer:
        for (let i = 0; i < transactions.length; i++) {
          for (let j = 0; j < transactions.length; j++) {
            if (i === j) continue;
            const a = transactions[i], b = transactions[j];
            const ba = txBox(a), bb = txBox(b);
            const aw = ba.x1 - ba.x0 + 1, ah = ba.y1 - ba.y0 + 1;
            const bw = bb.x1 - bb.x0 + 1, bh = bb.y1 - bb.y0 + 1;
            const aa = Math.max(1, aw * ah), ab = Math.max(1, bw * bh);
            const ix = Math.max(0, Math.min(ba.x1, bb.x1) - Math.max(ba.x0, bb.x0) + 1);
            const iy = Math.max(0, Math.min(ba.y1, bb.y1) - Math.max(ba.y0, bb.y0) + 1);
            const inter = ix * iy;
            const smallArea = Math.min(aa, ab), largeArea = Math.max(aa, ab);
            const overlap = inter / Math.max(1, smallArea);
            const sizeRatio = smallArea / largeArea;
            const span = Math.min(Math.max(aw, ah), Math.max(bw, bh));
            const centerDist = Math.hypot(ba.cx - bb.cx, ba.cy - bb.cy);
            if (overlap < 0.72 || sizeRatio < 0.45 ||
                centerDist > Math.max(3, span * 0.28)) continue;
            const large = aa >= ab ? a : b, small = aa >= ab ? b : a;
            large.items.push(...small.items);
            large.lines.push(...small.lines);
            transactions.splice(aa >= ab ? j : i, 1);
            changed = true;
            break outer;
          }
        }
      }
      const txOfRegion = new Map();
      for (const tx of transactions) for (const r of tx.items) txOfRegion.set(r, tx);
      // 视觉行由实际墨迹的稳健基线决定，不再把 y0 硬除以固定行高。
      // 单个字形的轮廓/填色/阴影仍合并为一个事务；行内再按 x 从左到右。
      const regionInkBaseline = (r) => {
        if (r._inkBaseline !== undefined) return r._inkBaseline;
        const m = r.mask || r.fillMask;
        if (!m) return (r._inkBaseline = r.y1);
        const rows = new Int32Array(r.bh);
        let total = 0;
        for (let y = 0; y < r.bh; y++) {
          const row = y * r.bw;
          let n = 0;
          for (let x = 0; x < r.bw; x++) if (m[row + x]) n++;
          rows[y] = n; total += n;
        }
        if (!total) return (r._inkBaseline = r.y1);
        const target = Math.max(1, Math.ceil(total * 0.82));
        let acc = 0, by = r.bh - 1;
        for (let y = 0; y < r.bh; y++) {
          acc += rows[y];
          if (acc >= target) { by = y; break; }
        }
        return (r._inkBaseline = r.y0 + by);
      };
      const txBaseline = (tx) => {
        let sum = 0, weight = 0;
        for (const r of tx.items) {
          if (r.pageGround || r.mode === 'line') continue;
          const w = Math.sqrt(Math.max(1, r.fillArea || r.area || 1));
          sum += regionInkBaseline(r) * w;
          weight += w;
        }
        const raw = weight > 0 ? sum / weight : txBox(tx).y1;
        const box = txBox(tx);
        const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1;
        // 大号首字母/竖排图案的墨迹 82% 分位会落到下方文字行，导致它
        // 被排到整段文字之后才画。高而窄的对象改用包围盒中线参与行聚类；
        // 普通字/图形仍使用真实墨迹基线。
        const tallNarrow = bh >= Math.max(96, Math.min(W, H) * 0.12) && bh >= bw * 1.25;
        return tallNarrow ? (box.y0 + box.y1) * 0.5 : raw;
      };
      const txInfos = transactions.map((tx) => {
        const box = txBox(tx);
        return {
          tx, box, baseline: txBaseline(tx),
          height: Math.max(1, box.y1 - box.y0 + 1),
        };
      });
      const parent = txInfos.map((_, i) => i);
      const find = (i) => {
        let q = i;
        while (parent[q] !== q) q = parent[q];
        while (parent[i] !== i) { const n = parent[i]; parent[i] = q; i = n; }
        return q;
      };
      const union = (a, b) => {
        const ra = find(a), rb = find(b);
        if (ra !== rb) parent[rb] = ra;
      };
      for (let i = 0; i < txInfos.length; i++) {
        const a = txInfos[i];
        for (let j = i + 1; j < txInfos.length; j++) {
          const b = txInfos[j];
          const minH = Math.min(a.height, b.height);
          const dyBaseline = Math.abs(a.baseline - b.baseline);
          const overlapY = Math.max(0, Math.min(a.box.y1, b.box.y1) -
            Math.max(a.box.y0, b.box.y0));
          const gapX = Math.max(0, b.box.x0 - a.box.x1 - 1,
            a.box.x0 - b.box.x1 - 1);
          const sameBaseline = dyBaseline <= Math.max(4, minH * 0.35);
          const sameBand = overlapY >= minH * 0.25 || dyBaseline <= minH * 0.22;
          const nearInLine = gapX <= Math.max(8, minH * 1.2);
          if (sameBaseline && sameBand && nearInLine) union(i, j);
        }
      }
      const byLine = new Map();
      for (let i = 0; i < txInfos.length; i++) {
        const root = find(i);
        let line = byLine.get(root);
        if (!line) { line = { infos: [], txs: [] }; byLine.set(root, line); }
        line.infos.push(txInfos[i]);
        line.txs.push(txInfos[i].tx);
      }
      const txLines = [...byLine.values()].map((line) => {
        line.txs.sort((a, b) => {
          const aa = txBox(a), bb = txBox(b);
          return (aa.x0 - bb.x0) || (aa.y0 - bb.y0) || (a.root.id - b.root.id);
        });
        const sortedBase = line.infos.map((x) => x.baseline).sort((a, b) => a - b);
        const box = line.infos.reduce((acc, x) => ({
          x0: Math.min(acc.x0, x.box.x0), y0: Math.min(acc.y0, x.box.y0),
          x1: Math.max(acc.x1, x.box.x1), y1: Math.max(acc.y1, x.box.y1),
        }), { x0: W, y0: H, x1: -1, y1: -1 });
        return {
          txs: line.txs, box,
          baseline: sortedBase[sortedBase.length >> 1] || box.y1,
        };
      }).sort((a, b) => (a.baseline - b.baseline) || (a.box.y0 - b.box.y0) ||
        (a.box.x0 - b.box.x0));
      plan.txGroups = txLines;
      if (opts.debug) console.log('[compiler:tx-groups] roots=' + transactions.length +
        ' lines=' + txLines.length + ' sizes=' +
        txLines.slice().sort((a, b) => b.txs.length - a.txs.length).slice(0, 10)
          .map((c) => c.txs.length).join(','));

      // 组级细节也要跟着对象走：先按组内像素的归属对象投票，把每个
      // 前景细节组绑定到对应事务；未被任何对象认领的组仍留到最后，
      // 只用于页面纹理和真正无归属的碎片。这样标题/段落的小字与
      // 抗锯齿边会在该对象抬笔前完成，而不是等全图主体画完后再跳着补。
      const noBgGroups = new Uint8Array(CTX.G_);
      const txDetailGroups = new Map();
      const detailRemainingGids = new Set(CTX.groups.map((g) => g.gid));
      for (const g of CTX.groups) {
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
        for (const r of frameTxLines) {
          // 画框内部若有独立线条，仍属于同一个页面底板事务。
          paintLineRegion(r, Math.min(3, Math.max(2, r.depth + 1)));
        }
      } else tailLines.push(...frameTxLines);
      const pageBaseBox = [...pageFills, ...frameFills].reduce((acc, r) => ({
        x0: Math.min(acc.x0, r.x0), y0: Math.min(acc.y0, r.y0),
        x1: Math.max(acc.x1, r.x1), y1: Math.max(acc.y1, r.y1),
      }), { x0: W, y0: H, x1: -1, y1: -1 });
      commitTx(pageBaseStart, 'pageBase', 'pageBase', pageBaseBox);

      const painted = new Set();
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

      // 一个对象 = 一个完整事务：
      // 父外轮廓 → 父层原子填满 → 子区域递归覆盖 → 边缘 → 本对象线条
      // → 本对象细节。事务提交前不允许任何其它前景对象插进来。
      const paintObjectTransaction = async (tx) => {
        const from = CTX.strokes.length;
        walkTxRegions(tx, (r) => {
          if (!fillSet.has(r) || painted.has(r) || r.pageGround) return;
          // paintRegionBase 自身严格先描外轮廓再原子落块；有子层时父色
          // 先覆盖整个闭合剪影，随后递归进入子层覆盖回来。
          paintRegionBase(r);
          painted.add(r);
        }, (r) => {
          if (!fillSet.has(r) || r.pageGround) return;
          paintRegionRim(r);
          paintRingSeam(r);
        });
        const lineJobs = tx.lines.slice().sort((a, b) => childKey(a) - childKey(b));
        for (const r of lineJobs) {
          paintLineRegion(r, Math.min(3, Math.max(2, r.depth + 1)));
        }
        const detailGids = txDetailGroups.get(tx);
        if (detailGids && detailGids.size) {
          await paintCompilerGroupDetails(noBgGroups, detailGids, tx.root.id);
        }
        addObjectPause(from, txBox(tx).x0 * 0.71 + txBox(tx).y0 * 1.31 + tx.root.id * 2.17);
        commitTx(from, tx.root.id, 'object', txBox(tx));
        return CTX.strokes.length - from;
      };

      // 视觉行按基线从上到下；行内每个对象从左到右完整画完再移动。
      let groupDone = 0;
      const objectTotal = transactions.length;
      for (const line of txLines) {
        for (const tx of line.txs) {
          await paintObjectTransaction(tx);
          groupDone++;
          prog(0.72 + 0.18 * groupDone / Math.max(1, objectTotal),
            '编译器：按视觉行逐字/逐对象完成…');
          if ((groupDone & 3) === 0) await yieldUI();
        }
      }
      // 对象事务完成后，先收口几何上无法归属到单个对象的原色组细节，
      // 再画独立尾线。二者都排在所有前景对象之后，不再插入其他对象。
      const finalDetailStart = CTX.strokes.length;
      // 对象事务之间可能互相覆盖抗锯齿和紧凑细节；完成所有对象后，对
      // 每个非背景细节组做一次只针对当前误差的二次检查。已经准确的组
      // 会被 groupFilter 内部跳过，不会重铺整页或制造新的碎色块。
      const finalDetailGids = new Set();
      for (const g of CTX.groups) if (!g.bg && g.area >= 4) finalDetailGids.add(g.gid);
      await paintCompilerGroupDetails(new Uint8Array(CTX.G_),
        finalDetailGids, 'detail:final',
        { a: 0.90, b: 0.925, label: '编译器：补齐无对象归属的细节…' });
      commitTx(finalDetailStart, 'detail:final', 'detail',
        { x0: 0, y0: 0, x1: W - 1, y1: H - 1 });
      const tailStart = CTX.strokes.length;
      const tailSorted = tailLines.slice().sort((a, b) => childKey(a) - childKey(b));
      for (let i = 0; i < tailSorted.length; i++) {
        const r = tailSorted[i];
        paintLineRegion(r, Math.min(3, Math.max(2, r.depth + 1)));
        if ((i & 15) === 0) {
          prog(0.925 + 0.015 * i / Math.max(1, tailSorted.length), '编译器：补齐独立细线…');
          await yieldUI();
        }
      }
      commitTx(tailStart, 'tail', 'tail',
        { x0: 0, y0: 0, x1: W - 1, y1: H - 1 });
      if (opts.debug) console.log('[compiler:tx] objects=' + transactions.length +
        ' linesAssigned=' + plan.lines.filter((r) => !tailLines.includes(r)).length +
        ' tail=' + tailLines.length + ' frames=' + frameFills.length);
      // 不再做按组均值的小块回填：编译器已经有完整闭合 mask 和分层覆盖，
      // 额外均值补丁只会把蓝底重新切成云状色块。剩余误差交给对象内局部修正。
      // 局部修正：只在“当前图层所有权”内找高误差连通块，预算有限；
      // 不再跑全图均值补丁，因此不会把蓝底重新刷成斑驳碎块。
      let repaired = 0, repairPx = 0;
      const repairStart = CTX.strokes.length;
      const REPAIR_ERR = 20;
      // 碎片面积下限：小于这个面积的误差块不值得单独起一笔。
      // 下限按还原程度缩放（省笔档更粗、极致档更细），否则档位就形同虚设。
      const repairMinPx = Math.max(12, Math.round(
        Math.min(W, H) * [0.030, 0.021, 0.014, 0.009, 0.006][COMPILER_FID - 1]));
      const maxRepairStrokes = Math.min(7000, Math.max(1000, Math.round(N * 0.0080)));
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
        // 只有"人眼能看出来"的偏差才值得补。旧阈值 12 会把大量 1~3px 的
        // 抗锯齿碎点也当成漏画，逐块补一笔——回放里就是"零星小点"和
        // "结尾还在补细碎笔"。取 20（仍在可见阈值 24 以内），并把
        // 面积下限抬到 12px：碎点留在原笔的边缘里，比单独补一笔更像手画。
        if (segPaper[p0] || seen[p0] || pageGroundOwner(p0) || errAt(p0) <= REPAIR_ERR) continue;
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
            if (z < 0 || z >= N || seen[z] || segPaper[z] || pageGroundOwner(z) || errAt(z) <= REPAIR_ERR) return;
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
        if (pix.length < repairMinPx) continue;
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
        const before = CTX.strokes.length;
        fillRegion(rr, m, 3, 'compiler:repair', null, 0);
        if (CTX.strokes.length === before && rr.mode !== 'solid') {
          rr.mode = 'solid';
          fillRegion(rr, m, 3, 'compiler:repair', null, 0);
        }
        repaired += Math.max(1, CTX.strokes.length - before);
        if ((repaired & 31) === 0) await yieldUI();
      }
      commitTx(repairStart, 'repair', 'detail',
        { x0: 0, y0: 0, x1: W - 1, y1: H - 1 });

      // 真实覆盖补缝：只处理画布上仍为纸白、且不属于背景纸的像素。它们
      // 几乎都是被量化/抗锯齿切成 1~3px 的细缝，绝不能再用“整色区均值”
      // 回填。这里沿每个未覆盖连通 mask 的中心线补一笔，颜色由该 mask 的
      // 局部色场决定，几何与源图完全一致。
      let coverStrokes = 0, coverPx = 0, coverComps = 0, coverSkipped = 0, coverSkippedPx = 0;
      const coverStart = CTX.strokes.length;
      {
        const seen = new Uint8Array(N);
        const q = new Int32Array(N);
        const maxCoverStrokes = Math.min(1400, Math.max(700, Math.round(N * 0.0018)));
        // 开场已经用一笔纸色洗过整张画布，所以"没盖到"的像素不会是白点，
        // 只会比目标暗一点点。为了几个像素的接缝单独起一笔，回放里就是
        // 抬笔去点一个看不见的小点——不像人。给个统一面积下限。
        const coverMinPx = Math.max(8,
          palette.length <= 7 ? Math.max(4, Math.min(12, Math.round(Math.min(W, H) * 0.01))) : 1);
        // "纸色"掩膜原本被整片跳过，于是色块与纸面交界处常留 1px 未涂的
        // 接缝：成品里就是一条细白圈（例如浅色圆盘的外缘）。这里允许补
        // 紧贴已画像素的那一层纸色，但只补一层——纸面内部仍然不碰。
        const seam = new Uint8Array(N);
        for (let y = 0; y < H; y++) {
          const row = y * W;
          for (let x = 0; x < W; x++) {
            const p = row + x;
            if (!segPaper[p] || covered[p]) continue;
            if ((x > 0 && covered[p - 1]) || (x + 1 < W && covered[p + 1]) ||
              (y > 0 && covered[p - W]) || (y + 1 < H && covered[p + W])) seam[p] = 1;
          }
        }
        for (let p0 = 0; p0 < N && coverStrokes < maxCoverStrokes; p0++) {
          if (covered[p0] || seen[p0]) continue;
          if (segPaper[p0] && !seam[p0]) continue;
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
              if (z < 0 || z >= N || seen[z] || covered[z]) return;
              if (segPaper[z] && !seam[z]) return;
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
          const before = CTX.strokes.length;
          fillRegion(rr, rr.mask, 3, 'compiler:cover', null, 1);
          const made = CTX.strokes.length - before;
          if (!made) {
            rr.mode = 'solid';
            fillRegion(rr, rr.mask, 3, 'compiler:cover-fill', null, 1);
            coverStrokes += CTX.strokes.length - before;
          } else coverStrokes += made;
          coverPx += pix.length;
          coverComps++;
          if ((coverComps & 63) === 0) await yieldUI();
        }
        if (opts.debug) console.log('[compiler] cover comps=' + coverComps +
          ' px=' + coverPx + ' strokes=' + coverStrokes + ' skip=' + coverSkipped + '/' + coverSkippedPx);
      }
      commitTx(coverStart, 'cover', 'detail',
        { x0: 0, y0: 0, x1: W - 1, y1: H - 1 });

      let good = 0, bad = 0;
      for (let p = 0; p < N; p++) {
        if (segPaper[p]) continue;
        const qq = p * 3;
        const err = Math.max(Math.abs(canvas[qq] - R[p]), Math.abs(canvas[qq + 1] - G[p]),
          Math.abs(canvas[qq + 2] - B[p]));
        if (err <= 64) { covered[p] = 1; paintN[p] = 1; good++; }
        else bad++;
      }
      CTX.groupUncov.fill(0);
      for (let p = 0; p < N; p++) {
        if (segPaper[p] || covered[p]) continue;
        const gid = groupOf[p];
        if (gid >= 0) CTX.groupUncov[gid]++;
      }
      CTX.zoneCov += good;
      pfClosedRegions = plan.fills.length + plan.lines.length;
      pfObjects = pfClosedRegions;
      pfRing = plan.order.some((r) => r.mode === 'ring');
      painterBgFill = 'compiler';
      plan.transactions = txRecords;
      if (opts.debug) console.log('[compiler] transactions=' + txRecords.length +
        ' done fills=' + plan.fills.length + ' lines=' + plan.lines.length +
        ' good=' + good + ' bad=' + bad + ' repairs=' + repaired + ' repairPx=' + repairPx +
        ' strokes=' + CTX.strokes.length + ' ms=' + (Date.now() - tEx));
      await yieldUI();
    };

    // ---- 色块编译器执行器 ----
    // 每个块一次原子填充（emitBlockFill）：形状由裁剪掩膜决定，颜色取块均值。
    // 块与块互不重叠，所以最终画布和落块顺序无关；顺序只服务回放观感。
    //   事务 1：贴边背景块（pageBase）——先把整幅底色铺出来；
    //   之后：前景块按空间聚成“对象”，按视觉行（先上后下、行内先左后右）
    //         逐个提交。一个对象 = 一次从起笔到抬笔，和画人的发力单元一致。
    const paintBlockPlan = async () => {
      const plan = blockPlan;
      const tB = Date.now();
      const txRecords = [];
      const blocks = plan.blocks, K = blocks.length, lab = plan.labels;
      // ---- 底板：贴边块（外圈/纸边）先并成一条 pageBase 事务 ----
      const bBorder = new Uint8Array(K);
      for (let x = 0; x < W; x++) {
        bBorder[lab[x]] = 1;
        bBorder[lab[(H - 1) * W + x]] = 1;
      }
      for (let y = 0; y < H; y++) {
        bBorder[lab[y * W]] = 1;
        bBorder[lab[y * W + W - 1]] = 1;
      }
      const bgIds = [];
      for (let i = 0; i < K; i++) if (bBorder[i]) bgIds.push(i);
      // ---- 对象聚类：前景块按空间网格分桶（桶数约为事务预算的 2.5 倍），
      // 同桶合并；仍超预算时，反复合并空间上最近的两个对象，保持区域连贯。
      const maxTx = Math.max(8, Math.min(140, Math.round(N / 6000)));
      const gCell = Math.max(8, Math.sqrt(N / (maxTx * 2.5)));
      const gCols = Math.max(1, Math.ceil(W / gCell));
      const clMap = new Map();
      for (let i = 0; i < K; i++) {
        if (bBorder[i]) continue;
        const b = blocks[i];
        const gx = Math.min(gCols - 1, Math.floor((b.x0 + b.bw * 0.5) / gCell));
        const gy = Math.floor((b.y0 + b.bh * 0.5) / gCell);
        const key = gy * gCols + gx;
        let c = clMap.get(key);
        if (!c) {
          c = { ids: [], x0: b.x0, y0: b.y0, x1: b.x0 + b.bw - 1, y1: b.y0 + b.bh - 1 };
          clMap.set(key, c);
        }
        c.ids.push(i);
        if (b.x0 < c.x0) c.x0 = b.x0;
        if (b.y0 < c.y0) c.y0 = b.y0;
        if (b.x0 + b.bw - 1 > c.x1) c.x1 = b.x0 + b.bw - 1;
        if (b.y0 + b.bh - 1 > c.y1) c.y1 = b.y0 + b.bh - 1;
      }
      const clusters = [...clMap.values()];
      while (clusters.length > maxTx) {
        let bi = 0, bj = 1, best = Infinity;
        for (let i = 0; i < clusters.length; i++) {
          const a = clusters[i];
          for (let j = i + 1; j < clusters.length; j++) {
            const b = clusters[j];
            const gx = Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1));
            const gy = Math.max(0, Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1));
            const g = gx * gx + gy * gy;
            if (g < best) { best = g; bi = i; bj = j; }
          }
        }
        const a = clusters[bi], b = clusters[bj];
        for (const id of b.ids) a.ids.push(id);
        if (b.x0 < a.x0) a.x0 = b.x0;
        if (b.y0 < a.y0) a.y0 = b.y0;
        if (b.x1 > a.x1) a.x1 = b.x1;
        if (b.y1 > a.y1) a.y1 = b.y1;
        clusters.splice(bj, 1);
      }
      // 视觉行：先上后下、行内先左后右（和真人扫幅顺序一致）。
      const bandH = Math.max(24, Math.min(84, H * 0.065));
      clusters.sort((a, b) => {
        const ba = Math.floor(a.y0 / bandH), bb = Math.floor(b.y0 / bandH);
        if (ba !== bb) return ba - bb;
        return (a.x0 - b.x0) || (a.y0 - b.y0);
      });
      // ---- 提交器：从 from 到当前笔尾记为一条事务 ----
      const commit = (from, txId, kind, box) => {
        if (CTX.strokes.length <= from) return;
        const txSeq = txRecords.length;
        for (let i = from; i < CTX.strokes.length; i++) {
          const st = CTX.strokes[i];
          st.tx = txId;
          st.txKind = kind;
          st.txSeq = txSeq;
          st.step = 'fill';
        }
        txRecords.push({
          id: txId, seq: txSeq, kind,
          strokeStart: from, strokeEnd: CTX.strokes.length,
          x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1,
        });
      };
      const emitOne = (b) => {
        const ph = b.depth <= 0 ? 0 : (b.depth === 1 ? 1 : (b.depth <= 3 ? 2 : 3));
        // 块越大，落块越“慢”（像大刷子铺一块）；小块快速点上去。
        const si = emitBlockFill(b.x0, b.y0, b.bw, b.bh, b.mask, b.color, ph, {
          stage: 'compiler:block',
          ms: Math.round(60 + Math.min(300, Math.sqrt(b.area) * 2.2)),
        });
        if (si >= 0) {
          CTX.strokes[si].stage = 'compiler:block';
          CTX.strokes[si].travelK = b.depth <= 0 ? 0.10 : 0.04;
        }
      };
      let done = 0, yieldedAt = 0;
      const tick = async () => {
        done++;
        if (done - yieldedAt >= 48) {
          yieldedAt = done;
          prog(0.22 + 0.66 * (done / Math.max(1, K)), '落块：一块一块铺满…');
          await yieldUI();
        }
      };
      // 1) 底板：贴边块并成一条 pageBase 事务，整幅先有底色。
      if (bgIds.length) {
        bgIds.sort((a, b) => blocks[b].area - blocks[a].area);
        let bx0 = W, by0 = H, bx1 = -1, by1 = -1;
        for (const id of bgIds) {
          const b = blocks[id];
          if (b.x0 < bx0) bx0 = b.x0;
          if (b.y0 < by0) by0 = b.y0;
          if (b.x0 + b.bw - 1 > bx1) bx1 = b.x0 + b.bw - 1;
          if (b.y0 + b.bh - 1 > by1) by1 = b.y0 + b.bh - 1;
        }
        // 贴边块铺满整幅时，事务盒就用整幅（回放要看到“整张纸先落底”）。
        if (bx0 <= 0 && by0 <= 0 && bx1 >= W - 1 && by1 >= H - 1) {
          bx0 = 0; by0 = 0; bx1 = W - 1; by1 = H - 1;
        }
        const from = CTX.strokes.length;
        for (const id of bgIds) { emitOne(blocks[id]); await tick(); }
        commit(from, 'block:pageBase', 'pageBase', { x0: bx0, y0: by0, x1: bx1, y1: by1 });
      }
      // 2) 主体：一个相邻块簇 = 一个对象事务。
      for (let ci = 0; ci < clusters.length; ci++) {
        const c = clusters[ci];
        const from = CTX.strokes.length;
        c.ids.sort((a, b) => (blocks[a].depth - blocks[b].depth) || (blocks[b].area - blocks[a].area));
        for (const id of c.ids) { emitOne(blocks[id]); await tick(); }
        commit(from, 'block:obj' + ci, 'object', { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 });
      }
      // 色块是整幅划分：每个像素都落了色。覆盖率按“已画”记，
      // 免得把“块色与源图有偏差”误报成漏画。
      for (let p = 0; p < N; p++) if (paintN[p]) covered[p] = 1;
      CTX.groupUncov.fill(0);
      for (let p = 0; p < N; p++) {
        if (!paintN[p] && !segPaper[p] && groupOf[p] >= 0) CTX.groupUncov[groupOf[p]]++;
      }
      pfClosedRegions = K;
      pfObjects = clusters.length;
      pfRing = false;
      painterBgFill = 'compiler';
      plan.transactions = txRecords;
      if (opts.debug) console.log('[blocks] done blocks=' + K + ' tx=' + txRecords.length +
        ' objects=' + clusters.length + ' bgBlocks=' + bgIds.length +
        ' strokes=' + CTX.strokes.length + ' ms=' + (Date.now() - tB));
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
      const detail = CTX.groups.filter((g) => {
        // 面积下限：细线结构天然窄，按 4px 起；色块要够大才值得单独落笔。
        // 4px 的碎色块单独画一笔，等于在人画面里点一个小点——这正是用户
        // 说的"零星小点"。它们本来就被父色和抗锯齿边覆盖，跳过更自然。
        if ((groupFilter && !groupFilter.has(g.gid)) || bgSet[g.gid]) return false;
        if (g.area < (g.lineLike ? 4 : 12)) return false;
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
        // 判定"这个组还值得再动一笔"：要么有一小片（≥Npx 且 ≥P%）明显偏差，
        // 要么整组面积够大且峰值偏差极高。旧条件只要 1 个像素 maxE≥48 就重画，
        // 于是边界上的抗锯齿碎组被反复描成小点。
        // N/P 随还原程度缩放：省笔档只补大块，极致档才去啃 2px 的碎边。
        return n > 0 && (bad >= Math.max([8, 5, 3, 2, 2][COMPILER_FID - 1],
          Math.ceil(n * [0.12, 0.09, 0.06, 0.040, 0.025][COMPILER_FID - 1])) ||
          (maxE >= [64, 56, 48, 40, 32][COMPILER_FID - 1] &&
           n >= [64, 40, 24, 16, 12][COMPILER_FID - 1]));
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
      // ---- 细墨线：一条线一笔 ----
      // 2~3px 的墨线（胡须、外轮廓线、字边）如果按"色组碎片"各自落块，一根胡须
      // 会被拆成几十笔小方块/短线，边缘犬牙交错、粗细不匀；真人是一笔从头拉到尾。
      // 这里把本事务内所有细线组并成一张掩膜，沿骨架整体走线：宽度取真实内切
      // 半径（不再用 1.3 倍放大），一条线一笔，颜色取笔下的原图均值。
      const THIN_T = 2.4;
      const thinGroups = [];
      const thickDetail = [];
      for (const g of detail) {
        if (g.lineLike && !g.grad && (g.thick || 0) <= THIN_T && g.area >= 4) thinGroups.push(g);
        else thickDetail.push(g);
      }
      const INK_MIN_LEN = 120;
      const paintThinInk = (gs) => {
        if (!gs.length) return gs;
        let x0 = W, y0 = H, x1 = -1, y1 = -1;
        const gids = new Uint8Array(CTX.G_);
        for (const g of gs) {
          gids[g.gid] = 1;
          if (g.x0 < x0) x0 = g.x0; if (g.x1 > x1) x1 = g.x1;
          if (g.y0 < y0) y0 = g.y0; if (g.y1 > y1) y1 = g.y1;
        }
        if (x1 < 0) return gs;
        const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
        const m = new Uint8Array(bw * bh);
        let any = 0;
        for (let y = y0; y <= y1; y++) {
          const row = y * W;
          for (let x = x0; x <= x1; x++) {
            const gid = groupOf[row + x];
            if (gid >= 0 && gids[gid]) { m[(y - y0) * bw + (x - x0)] = 1; any++; }
          }
        }
        if (!any) return [];
        const paths = traceMaskPaths(m, bw, bh, x0, y0);
        if (!paths.length) return [];
        // 只把"真正的长线"当一笔画：胡须、轮廓线、长笔画。字缘、碎点这类
        // 短骨架上笔反而更毛糙，它们仍然走原来的块面/短笔通路。
        const keepPaths = paths.filter((p) => p.len >= INK_MIN_LEN);
        if (!keepPaths.length) return gs;
        const dtv = distanceTransform(m, bw, bh);
        const dtAt = (ax, ay) => {
          const xx = Math.round(ax) - x0, yy = Math.round(ay) - y0;
          if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) return 0;
          const d = dtv[yy * bw + xx];
          return d >= 1e8 ? 0 : d;
        };
        // 这一笔实际会盖住的像素（骨架两侧各 2~3px），用来判断哪些组真被它解决了
        const hit = new Uint8Array(bw * bh);
        for (const path of keepPaths) {
          const n = path.n;
          for (let i = 0; i < n; i++) {
            const px = Math.round(path.pts[i * 2]) - x0, py = Math.round(path.pts[i * 2 + 1]) - y0;
            for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
              const xx = px + dx, yy = py + dy;
              if (xx >= 0 && yy >= 0 && xx < bw && yy < bh) hit[yy * bw + xx] = 1;
            }
          }
        }
        // 组级分流：被长线吃掉的组交给这一笔；剩下的组仍走原通路
        const leftover = [];
        for (const g of gs) {
          let tot = 0, got = 0;
          for (let yy = g.y0; yy <= g.y1; yy++) {
            const row = yy * W;
            for (let xx = g.x0; xx <= g.x1; xx++) {
              if (groupOf[row + xx] !== g.gid) continue;
              tot++;
              if (hit[(yy - y0) * bw + (xx - x0)]) got++;
            }
          }
          if (!tot || got / tot < 0.62) leftover.push(g);
          else {
            // 已经被这一整笔吃掉：不要再把覆盖账清零，否则后面的
            // 细节收口会认为这些像素"还没画"，用小块再描一遍——
            // 这正是"同一处反复描好几道"的来源。
            CTX.groupUncov[g.gid] = 0;
          }
        }
        // zoneMask 按"全画布像素下标"取址
        const zone = new Uint8Array(N);
        for (let y = y0; y <= y1; y++) {
          const row = y * W;
          for (let x = x0; x <= x1; x++) if (m[(y - y0) * bw + (x - x0)]) zone[row + x] = 1;
        }
        const maxLen = Math.round(520 * scaleB);
        const s0 = CTX.strokes.length;
        for (const path of keepPaths) {
          for (const ch of splitSkPath(path, maxLen)) {
            if (ch.n < 2 || (ch.len || 0) < INK_MIN_LEN * 0.6) continue;
            const halfs = new Float64Array(ch.n);
            let sr = 0, sg = 0, sb = 0, cn = 0;
            for (let i = 0; i < ch.n; i++) {
              const px = ch.pts[i * 2], py = ch.pts[i * 2 + 1];
              // 笔身贴着真实线宽走：dt 是内切半径，再加半像素抗锯齿余量。
              halfs[i] = clamp(dtAt(px, py) + 0.35, 0.7, 2.1);
              const ii = Math.round(py) * W + Math.round(px);
              if (ii >= 0 && ii < N) { sr += R[ii]; sg += G[ii]; sb += B[ii]; cn++; }
            }
            const col = tone(cn ? [sr / cn, sg / cn, sb / cn] : [0, 0, 0]);
            emitPlan(ch.pts, halfs, col, 3, {
              pen: 1, zoneMask: zone, zoneGroups: gids, zoneTol: 255,
              forceKeep: 1, ms: Math.round(150 + ch.len * 2.0),
            });
          }
        }
        for (let si = s0; si < CTX.strokes.length; si++) CTX.strokes[si].stage = 'compiler:ink-line';
        return leftover;
      };
      const inkLeft = paintThinInk(thinGroups) || thinGroups;
      let done = 0;
      for (const g of thickDetail.concat(inkLeft)) {
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
        CTX.groupUncov[g.gid] = g.area;
        // 判断只看几何与颜色：细长线沿骨架画；实心块（不论大小）按
        // 原组掩膜整块落下；只有真正有内部渐变的组保留局部扫色。
        const compact = g.bw * g.bh <= 2500 && g.area <= 900;
        // 紧凑“类线”多数是字缘/扫描碎片，不是真正连续线稿；它们按
        // 原始 mask 原子落块。只有更大的连续线条才值得走中心线。
        const blockDetail = !g.grad && (!g.lineLike || compact);
        const ds0 = CTX.strokes.length;
        if (g.lineLike && !blockDetail) {
          paintLine(g, 3);
          // 极短/极碎的小线有时追不出可用骨架；这时原子块至少不会留下
          // 扫描笔的中间态，也不会把邻近像素带进来。
          if (CTX.strokes.length === ds0 && CTX.groupUncov[g.gid] > 0) paintCompactMask(g, 3);
        } else if (blockDetail) {
          paintCompactMask(g, 3);
        } else {
          paintBlob(g, 3);
        }
        const fallbackStage = blockDetail ? 'compiler:detail-block'
          : (g.lineLike ? 'compiler:detail-line' : 'compiler:detail-blob');
        const groupTxId = groupTxMap && groupTxMap.has(g.gid)
          ? groupTxMap.get(g.gid) : txId;
        for (let si = ds0; si < CTX.strokes.length; si++) {
          if (!CTX.strokes[si].stage) CTX.strokes[si].stage = fallbackStage;
          if (groupTxId !== undefined) CTX.strokes[si].tx = groupTxId;
        }
        if (compact && blockDetail) {
          // 兼容旧诊断：紧凑实心块仍记为 detail-compact，方便比较时间轴。
          for (let si = ds0; si < CTX.strokes.length; si++) {
            if (CTX.strokes[si].blk) CTX.strokes[si].stage = 'compiler:detail-compact';
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
        ' strokes=' + CTX.strokes.length + (groupFilter ? ' scoped=1 tx=' + txId : ' scoped=0'));
      await yieldUI();
    };

    // ---- 排阶段：按最终画面结构，不按色板大小；同一阶段内按手的位置就近走笔 ----
    prog(0.66, flatArt ? '铺开：背景与主色块…' : '铺开：主体大形与背景…');
    await yieldUI();
    const focalX = CTX.subj.focalX, focalY = CTX.subj.focalY;
    for (const g of CTX.groups) {
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
        const gg = CTX.groups[gid];
        const ml = 0.299 * gg.mean[0] + 0.587 * gg.mean[1] + 0.114 * gg.mean[2];
        const warm = gg.mean[0] - gg.mean[2];
        if (gg.backdrop || (!gg.lineLike && ml >= 185 && ml <= 244 && warm >= 22 && warm <= 85)) cls[p] = 1;
      }
      const cnt = new Int32Array(CTX.G_);
      for (let p = 0; p < N; p++) {
        const gid = groupOf[p];
        if (gid >= 0 && cls[p]) cnt[gid]++;
      }
      for (const g of CTX.groups) g.soft = (cnt[g.gid] > g.area * 0.5) ? 1 : 0;
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
        Math.hypot(g.cx - CTX.subj.focalX, g.cy - CTX.subj.focalY) < Math.min(W, H) * 0.28) return 3;
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
      const gLab = new Int16Array(CTX.G_);
      const labArea = new Float64Array(K);
      for (const g of CTX.groups) {
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
      const bgSet = new Uint8Array(CTX.G_);
      const famGid = new Uint8Array(CTX.G_);
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
      for (const g of CTX.groups) {
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
      for (const g of CTX.groups) {
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
      const fg = CTX.groups.filter((g) => !bgSet[g.gid]);
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
      const washGid = new Uint8Array(CTX.G_);
      for (const g of CTX.groups) {
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
        for (const g of CTX.groups) if (!washGid[g.gid] && bgSet[g.gid]) exBg += g.area;
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
    let pageFrameRegions = [];
    const pageBaseCandidate = (r) => {
      if (!r || r.mode !== 'solid' || r.frameLike || !r.outer) return false;
      const nearEdges = (r.x0 <= W * 0.06 ? 1 : 0) + (r.x1 >= W * 0.94 ? 1 : 0) +
        (r.y0 <= H * 0.06 ? 1 : 0) + (r.y1 >= H * 0.94 ? 1 : 0);
      if (!(nearEdges >= 2 && r.bw >= W * 0.70 && r.bh >= H * 0.70 &&
        r.fillArea >= N * 0.12)) return false;
      // 大色块不等于页面底板。圆形/圆角插画的 bbox 也会跨过两条画幅边，
      // 但它的闭合色面只占 bbox 约 π/4；若直接铺满 bbox，四个角会被错误染色。
      // 只有以下两种结构性证据之一才算页面底板：
      //   1) 色面本身接近整页矩形；
      //   2) 色面被一个闭合画框从外侧包住（扫描海报的蓝底就是这种）。
      const bboxCoverage = r.fillArea / Math.max(1, r.bw * r.bh);
      // 扫描海报的页面底色会被文字/图案挖出大量内部孔，bbox 占有率通常
      // 只有 0.6~0.8；圆形插画的占有率也可能接近 0.8。用“色面沿自身
      // bbox 周边的实际接触率”区分二者：整页底板沿四周连续延伸，圆盘
      // 只会在大约四个切线点碰到外框。该判据只依赖几何。
      const bm = r.fillMask || r.mask;
      let borderHit = 0, borderN = 0;
      if (bm) {
        for (let x = 0; x < r.bw; x++) {
          borderN += 2;
          if (bm[x]) borderHit++;
          if (bm[(r.bh - 1) * r.bw + x]) borderHit++;
        }
        for (let y = 1; y < r.bh - 1; y++) {
          borderN += 2;
          if (bm[y * r.bw]) borderHit++;
          if (bm[y * r.bw + r.bw - 1]) borderHit++;
        }
      }
      const borderContact = borderHit / Math.max(1, borderN);
      const fullPageField = (bboxCoverage >= 0.88) ||
        (bboxCoverage >= 0.55 && borderContact >= 0.20);
      const enclosedByFrame = pageFrameRegions.some((f) => f !== r &&
        (f.frameLike || f.canvasFrame) && f.x0 <= r.x0 && f.y0 <= r.y0 &&
        f.x1 >= r.x1 && f.y1 >= r.y1);
      return fullPageField || enclosedByFrame;
    };
    const makePageBaseMask = (r) => {
      // 页面底板是整页剪影，不再从底色 mask 中挖掉画框、文字或任意前景。
      // 真人先整页铺底色，再把画框/字心压回去；如果底色先预留前景孔洞，
      // 回放中必然出现半页蓝底、白缝和迟到的补边。几何资格仍由
      // pageBaseCandidate() 决定，这里只负责把已认定的大页面闭合成整块。
      return new Uint8Array(r.bw * r.bh).fill(1);
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
        const gidN = new Uint32Array(CTX.G_);
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
        for (let gid = 0; gid < CTX.G_; gid++) if (gidN[gid]) gids.push(gid);
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
          color: snapOut([Math.round(sr / cp.count), Math.round(sg / cp.count), Math.round(sb / cp.count)]),
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
      // 供 pageBaseCandidate 判断“大色面是否属于某个闭合画框内部”。
      // 只收画幅级 ring，避免字形描边/角落花纹被当成页面画框。
      pageFrameRegions = regions.filter((r) => (r.frameLike || r.canvasFrame) &&
        r.bw >= W * 0.45 && r.bh >= H * 0.45);
      // observedMask 只描述真实可见色，paintMask 描述这一层应当铺到的
      // 完整领地。普通实心区域沿用闭合剪影；页面底板再闭包到画幅内部，
      // 从而不会把文字/图形占位提前留成透明洞。
      for (const r of regions) {
        r.paintMask = r.mode === 'solid' ? r.fillMask : r.mask;
      }
      for (const r of regions) {
        const isPageBase = pageBaseCandidate(r);
        if (opts.debug && r.fillArea >= N * 0.12) {
          const cov = r.fillArea / Math.max(1, r.bw * r.bh);
          console.log('[pagebase-mask] id=' + r.id + ' box=' + r.x0 + ',' + r.y0 + '-' + r.x1 + ',' + r.y1 +
            ' fill=' + r.fillArea + ' cov=' + cov.toFixed(3) + ' frames=' + pageFrameRegions.length +
            ' frameBoxes=' + pageFrameRegions.map((f) => f.x0 + ',' + f.y0 + '-' + f.x1 + ',' + f.y1).join('|') +
            ' pg=' + pageGround(r) + ' candidate=' + isPageBase);
        }
        if (!isPageBase) continue;
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

    // ---- 色块编译器（新路径）----
    // 一块 = 一个连通区域 + 一种颜色 + 一次原子落块；没有“笔”的概念。
    // 全分辨率边缘感知分割 → 碎块吸收 → 受控合并 → 拓扑深度出序。
    // 它不依赖"平涂/照片"的预判：照片照样按色块铺，判断交给算法本身。
    // 旧的区域编译器保留为 A/B 对照：opts.compilerLegacy。
    let blockPlan = null;
    if (compilerFlow && root.BLOCKS && !opts.compilerLegacy) {
      try {
        blockPlan = root.BLOCKS.build(R, G, B, W, H, {
          fidelity: COMPILER_FID, seed: runSeed,
          blockK: opts.blockK, blockMergeD: opts.blockMergeD, blockNoiseD: opts.blockNoiseD,
          blockMse: opts.blockMse, blockBudget: opts.blockBudget, blockBlur: opts.blockBlur,
          blockSnap: opts.blockSnap,
        });
      } catch (err) {
        blockPlan = null;
        if (opts.debug) console.log('[blocks] 规划失败，回退旧编译器：' + (err && err.message));
      }
      if (blockPlan && opts.debug) {
        const s = blockPlan.stats;
        console.log('[blocks] fidelity=' + COMPILER_FID + ' blocks=' + s.blocks +
          ' meanErr=' + s.meanErr.toFixed(2) + ' p95=' + s.p95 + ' bad%=' + s.badPct.toFixed(1) +
          ' k=' + s.tau + ' mergeD=' + s.mergeD + ' mse=' + s.mseT + ' budget=' + s.budget +
          ' ms=' + s.ms);
      }
    }

    // ---- 无训练绘画编译器（旧路径，保留做 A/B）----
    // 与 closed 路径并列：同样把父区域整块填满，但区域颜色不再是一个均值。
    // 每个对象会拟合“常数 / 平面渐变 / 2~4 条色带”中最简单且误差最低的色场；
    // 细线条单独成为候选，全部区域画完后再压到最上层。
    compilerPlan = (() => {
      if (blockPlan || !(compilerFlow && flatArt)) return null;
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
        // 色彩模型的分辨率随还原程度走：① 只允许"一整块纯色"，
        // ⑤ 才用 64×64 色场 / 9 级色带把过渡还原到接近 1:1。
        const CV = COMPILER_VIEW || { gridBig: 32, gridMid: 10, gridSmall: 4, gpen: 0.9,
          kMaxBig: 4, kMaxMid: 3, kMaxSmall: 2, pen: 0.85, plane: 1 };
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
          return snapOut([Math.round(clampC(c[0], m.lo[0], m.hi[0])),
            Math.round(clampC(c[1], m.lo[1], m.hi[1])),
            Math.round(clampC(c[2], m.lo[2], m.hi[2]))]);
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
          // ① 省笔档不拟合线性渐变：一整块纯色才叫"色块"。
          if (CV.plane && cr && cg && cb) {
            const pm = { kind: 'plane', coef: [cr, cg, cb], mean, lo, hi, err: 0 };
            pm.err = errOf(pm);
            if (pm.err + 1.25 < best.err) best = pm;
          }
          // 大色块用低分辨率双线性色场：它等价于“现场从原图采样一张
          // 4×4 调色网”，能跟随扫描件的暗角、纸张渐变和低频明暗，却不把
          // 同色背景重新切成独立补丁。所有格子由闭合 mask 自己采样。
          if (count >= 300 && CV.gridBig > 1) {
            const gx = count >= 100000 ? CV.gridBig : (count >= 1200 ? CV.gridMid : CV.gridSmall);
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
            if (gm.err + CV.gpen < best.err) best = gm;
          }
          const vx = sxx / count - (sx / count) * (sx / count);
          const vy = syy / count - (sy / count) * (sy / count);
          const axis = vx >= vy ? 0 : 1;
          const Kmax = count >= 900 ? CV.kMaxBig : (count >= 260 ? CV.kMaxMid : CV.kMaxSmall);
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
            if (bm.err + CV.pen * (K - 1) < best.err) best = bm;
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
          color: snapOut(model.mean), model, mask, fillMask,
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
          r.color = snapOut(r.model.mean);
          r.modelPx = modelPx;
        }
        // 低对比碎块仍保留自己的真实几何，避免吸收后露出纸白；
        // 但它们统一使用父层重新拟合的连续色场，成品的颜色接缝因此消失。
        for (const ch of close) {
          ch.model = r.model;
          ch.color = snapOut(r.model.mean);
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
          r.color = snapOut(anchor.model.mean);
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
        const isPageGround = pageGround(r);
        const rootBlock = isPageGround ? pageBaseCandidate(r) : false;
        if (opts.debug && (isPageGround || r.fillArea >= N * 0.12)) {
          const cov = r.fillArea / Math.max(1, r.bw * r.bh);
          let borderHit = 0, borderN = 0;
          if (r.fillMask) {
            for (let x = 0; x < r.bw; x++) {
              borderN += 2;
              if (r.fillMask[x]) borderHit++;
              if (r.fillMask[(r.bh - 1) * r.bw + x]) borderHit++;
            }
            for (let y = 1; y < r.bh - 1; y++) {
              borderN += 2;
              if (r.fillMask[y * r.bw]) borderHit++;
              if (r.fillMask[y * r.bw + r.bw - 1]) borderHit++;
            }
          }
          const borderContact = borderHit / Math.max(1, borderN);
          console.log('[pageground2] id=' + r.id + ' box=' + r.x0 + ',' + r.y0 + '-' + r.x1 + ',' + r.y1 +
            ' fill=' + r.fillArea + ' cov=' + cov.toFixed(3) + ' border=' + borderContact.toFixed(3) + ' pg=' + isPageGround +
            ' root=' + rootBlock + ' frames=' + pageFrameRegions.length +
            ' frameBoxes=' + pageFrameRegions.map((f) => f.x0 + ',' + f.y0 + '-' + f.x1 + ',' + f.y1).join('|'));
        }
        if (!isPageGround) continue;
        // 页面根底板取闭合包围矩形，再精确挖掉所有画框环。这样文字、
        // 图案和同色扫描碎片在父层内部都会先被父色盖住，同时蓝底不会
        // 越过闭合画框。不能直接用色块 fillMask：它会把扫描海报拆成
        // 若干洞，成品边缘重新出现深色补丁。
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
      const objectBgGids = new Uint8Array(CTX.G_);
      const bgHits = new Int32Array(CTX.G_);
      const groundHits = new Int32Array(CTX.G_);
      const groundDist = new Float64Array(CTX.G_);
      const groundDistN = new Int32Array(CTX.G_);
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
        const g = CTX.groups[gid];
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
      for (const g of CTX.groups) {
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
    compilerActive = !!(compilerFlow &&
      ((blockPlan && blockPlan.order.length) || (flatArt && compilerPlan && compilerPlan.order.length)));
    closedActive = !!(painterFlow && flatArt && closedPlan && closedPlan.order.length);
    // 闭合路径自己负责完整作画；旧背景规划只作为 artist/回退路径的参考，
    // 不能再用 bgFirstPlan 的有无来决定 painter 是否启动。
    painterActive = painterFlow && flatArt && !!bgFirstPlan && !closedActive;
    const phaseGroups = [[], [], [], []];
    for (const g of CTX.groups) phaseGroups[phaseOf(g)].push(g);
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
      const s0 = CTX.strokes.length;
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
      return CTX.strokes.length - s0;
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
      // 对象事务、无归属细节、独立尾线、残差修正和补缝都已在执行器内部
      // 按事务顺序完成；这里不能再重跑一遍细节，否则会在所有已提交事务
      // 之后追加一串无 tx 元数据的覆盖笔。
      if (blockPlan) {
        // 色块路径：整幅划分，没有“父区域 / 细节笔”的第二层。
        await paintBlockPlan();
      } else {
        await paintCompilerPlan();
        if (opts.compilerObjectPass) await paintHumanFlow(true, compilerPlan.objectBgGids);
      }
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
        const massMark = new Uint8Array(CTX.G_);
        for (const g of e.mass) massMark[g.gid] = 1;
        const fillMark = new Uint8Array(CTX.G_);
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
        if (CTX.groupUncov[g.gid] > 0) paintBlob(g, ph);
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
        const g = CTX.groups[gid0];
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
      for (let i = 0; i < CTX.strokes.length; i++) {
        if (CTX.strokes[i].ph === 0) ph0ms += CTX.strokes[i].ms;
      }
      for (const i of washIdx) ph0ms -= CTX.strokes[i].ms;
      const per = Math.max(160, ph0ms * 0.35 / washIdx.length);
      for (const i of washIdx) CTX.strokes[i].ms = per;
    }
    if (CTX.strokes.length) {
      CTX.baseCount = CTX.strokes.filter((s) => s.ph === 0).length;
      CTX.strokes[CTX.strokes.length - 1].fin = 1;
    }
    // 覆盖率审计：按最终 covered 位图统计，和回放/成品逐像素一致
    let unPx = 0, unG = 0;
    {
      const unc = new Int32Array(CTX.G_);
      for (let p = 0; p < N; p++) {
        if (segPaper[p] || covered[p]) continue;
        const gid = groupOf[p];
        if (gid >= 0) { unc[gid]++; unPx++; }
      }
      for (let i = 0; i < CTX.G_; i++) if (unc[i]) unG++;
    }
    // 事务摘要直接由最终笔触生成：旧算法没有 tx 字段时自然退化成单个事务，
    // compiler 则保留 pageBase / object / detail / tail 的真实边界和顺序。
    const txSummary = (() => {
      const bySeq = new Map();
      const byId = new Map();
      const planTxBySeq = new Map();
      const planTxs = (blockPlan && blockPlan.transactions) ||
        (compilerPlan && compilerPlan.transactions) || [];
      for (const rec of planTxs) planTxBySeq.set(rec.seq, rec);
      let fallbackSeq = 0;
      for (let i = 0; i < CTX.strokes.length; i++) {
        const st = CTX.strokes[i];
        const hasSeq = Number.isInteger(st.txSeq) && st.txSeq >= 0;
        const key = hasSeq ? ('s:' + st.txSeq)
          : (st.tx === undefined ? 'legacy' : ('i:' + String(st.tx)));
        let rec = hasSeq ? bySeq.get(key) : byId.get(key);
        if (!rec) {
          const geom = hasSeq ? planTxBySeq.get(st.txSeq) : null;
          rec = {
            id: st.tx === undefined ? 'legacy' : st.tx,
            seq: hasSeq ? st.txSeq : fallbackSeq++,
            kind: st.txKind || 'legacy',
            strokeStart: i, strokeEnd: i + 1,
            steps: {},
          };
          // 事务包围盒是执行器给出的原始对象几何，供时间轴/消费方检查
          // “先左后右、先上后下”，不改变既有 strokes/clips 契约。
          if (geom) {
            rec.x0 = geom.x0; rec.y0 = geom.y0;
            rec.x1 = geom.x1; rec.y1 = geom.y1;
          }
          if (hasSeq) bySeq.set(key, rec); else byId.set(key, rec);
        }
        rec.strokeEnd = i + 1;
        const step = st.step || (st.blk ? 'fill' : 'detail');
        rec.steps[step] = (rec.steps[step] || 0) + 1;
      }
      const out = [...bySeq.values(), ...byId.values()];
      out.sort((a, b) => (a.seq - b.seq) || (a.strokeStart - b.strokeStart));
      return out;
    })();
    const txCounts = {};
    for (const rec of txSummary) txCounts[rec.kind] = (txCounts[rec.kind] || 0) + 1;
    CTX.exactInfo = {
      seed: runSeed, mode: modeName, regions: RN, groups: CTX.groups.length,
      strokes: CTX.strokes.length, mergePasses: passN, uncovered: unPx, uncoveredGroups: unG,
      transactions: txSummary, txCounts,
      txOrder: txSummary.map((rec) => rec.kind),
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
      globalThis.__ISP_DUMP_GROUPS = CTX.groups;
      globalThis.__ISP_DUMP_GROUPOF = groupOf;
      globalThis.__ISP_DUMP_CLOSED = closedPlan;
      globalThis.__ISP_DUMP_COMPILER = compilerPlan;
      globalThis.__ISP_DUMP_BLOCKS = blockPlan;
      globalThis.__ISP_DUMP_LABELS = labels;
      globalThis.__ISP_DUMP_COVERED = covered;
      globalThis.__ISP_DUMP_PAPER = paper;
      globalThis.__ISP_DUMP_CANVAS = canvas;
      globalThis.__ISP_DUMP_W = W;
      if (bgFirstPlan) globalThis.__ISP_DUMP_BG = bgFirstPlan.bgSet;
    }
    if (opts.dumpStrokes) {
      globalThis.__ISP_DUMP_STROKES = CTX.strokes;
      globalThis.__ISP_DUMP_CLIPS = clips;
    }
    if (opts.debug) {
      console.log('[exact] ' + modeName + ' seed=' + runSeed + ' tol=' + TOL + ' 初始=' + RN +
        ' 组=' + CTX.groups.length + ' 笔=' + CTX.strokes.length + ' 删零=' + zeroRemoved + ' ph=' +
        JSON.stringify([0, 1, 2, 3].map((p) => CTX.strokes.filter((s) => s.ph === p).length)) +
        ' 漏=' + unPx + '/' + unG + ' 残补=' + resPx + '/' + resComp + '/' + resStroke +
        ' ms=' + (Date.now() - tEx));
    }
    return true;
  };

  root.ISP_PIPELINE_EXACT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
