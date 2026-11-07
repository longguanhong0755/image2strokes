// image2strokes 自己的引擎体检：稳定入口存在、Worker 走入口、pipeline 真能跑。
// 用法：node dev/engine_check.mjs
// GitHub Actions 和本地都可以直接跑，不依赖浏览器。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ENGINE = path.join(ROOT, 'js/engine.js');
const WORKER = path.join(ROOT, 'js/worker.js');
const PIPELINE = path.join(ROOT, 'js/pipeline.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`); }
};

ok('js/engine.js 存在', fs.existsSync(ENGINE));
const src = fs.existsSync(ENGINE) ? fs.readFileSync(ENGINE, 'utf8') : '';
const m = /pipeline\.js\?v=(\d+)/.exec(src);
ok('engine.js 指向 pipeline.js', !!m, m ? `?v=${m[1]}` : '没找到');
const a = /self\.ISP_PIPELINE\.api\s*=\s*(\d+)/.exec(src);
ok('engine.js 声明 api', !!a, a ? `api=${a[1]}` : '没找到');
ok('engine.js 处理了 ENGINE_BASE', /ISP_ENGINE_BASE/.test(src));

const worker = fs.readFileSync(WORKER, 'utf8');
ok('worker 走稳定入口', /importScripts\('engine\.js\?v=/.test(worker), 'worker.js');

await import(pathToFileURL(PIPELINE).href);
const P = globalThis.ISP_PIPELINE;
ok('pipeline 导出 run', !!P && typeof P.run === 'function');

if (P && typeof P.run === 'function') {
  const W = 32, H = 32;
  const px = new Uint8ClampedArray(W * H * 4);
  const colors = [[220, 40, 40], [40, 160, 60], [40, 80, 200], [245, 240, 230]];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = colors[(y < H / 2 ? 0 : 2) + (x < W / 2 ? 0 : 1)];
      const i = (y * W + x) * 4;
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
    }
  }
  const res = await P.run(px, W, H, { colors: 4, style: 'marker', detail: 1, maxStrokes: 300, dropDead: false, returnKeys: false }, () => {});
  ok('run 返回尺寸', res && res.W === W && res.H === H, res ? `${res.W}x${res.H}` : '空返回');
  ok('run 有笔触', res && Array.isArray(res.strokes) && res.strokes.length > 0, res ? `${res.strokes.length} 笔` : '');
  ok('run 有裁剪组', res && Array.isArray(res.clips));
  const s = res && res.strokes && res.strokes[0];
  ok('单笔结构', !!s && Array.isArray(s.rib) && Array.isArray(s.color));

  // 第二种算法：整幅逐级细化（pyramid）也要能走稳定入口，并守住逐像素红线
  const pres = await P.run(new Uint8ClampedArray(px), W, H,
    { colors: 0, style: 'marker', fidelity: 3, algo: 'pyramid', returnCanvas: true }, () => {});
  ok('pyramid 返回尺寸', pres && pres.W === W && pres.H === H, pres ? `${pres.W}x${pres.H}` : '空返回');
  ok('pyramid 有笔触', pres && Array.isArray(pres.strokes) && pres.strokes.length > 0,
    pres ? `${pres.strokes.length} 笔` : '');
  const pq = pres && pres.stats && pres.stats.quality;
  ok('pyramid 红线', !!pq && pq.max <= pq.tolerance && pq.uncovered === 0,
    pq ? `max=${pq.max} T=${pq.tolerance} unc=${pq.uncovered}` : '没有 quality');

  // 画家·过程版：稳定入口也要能跑通，并守住逐像素红线
  const hres = await P.run(new Uint8ClampedArray(px), W, H,
    { colors: 0, style: 'marker', fidelity: 3, algo: 'painter', returnCanvas: true }, () => {});
  ok('painter 返回尺寸', hres && hres.W === W && hres.H === H, hres ? `${hres.W}x${hres.H}` : '空返回');
  ok('painter 有笔触', hres && Array.isArray(hres.strokes) && hres.strokes.length > 0,
    hres ? `${hres.strokes.length} 笔` : '');
  ok('painter 归档', hres && hres.stats && hres.stats.algo === 'painter',
    hres && hres.stats ? `algo=${hres.stats.algo} order=${hres.stats.exactOrder || '-'}` : '');
  const hq = hres && hres.stats && hres.stats.quality;
  ok('painter 红线', !!hq && hq.max <= hq.tolerance && hq.uncovered === 0,
    hq ? `max=${hq.max} T=${hq.tolerance} unc=${hq.uncovered}` : '没有 quality');

  // 编译器事务回归：用可复现的“页面底板 + 两行三列色块”夹具验证，
  // 不依赖样例文件、固定颜色或海报坐标。它同时覆盖底板先行、事务原子性、
  // 视觉行从左到右、时间轴完整收尾和 90 秒硬上限已移除。
  const CW = 96, CH = 64;
  const cpx = new Uint8ClampedArray(CW * CH * 4);
  for (let y = 0; y < CH; y++) {
    for (let x = 0; x < CW; x++) {
      const i = (y * CW + x) * 4;
      cpx[i] = 245; cpx[i + 1] = 240; cpx[i + 2] = 228; cpx[i + 3] = 255;
    }
  }
  const fillRect = (x0, y0, x1, y1, color) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * CW + x) * 4;
        cpx[i] = color[0]; cpx[i + 1] = color[1]; cpx[i + 2] = color[2];
      }
    }
  };
  fillRect(8, 8, 20, 20, [220, 50, 40]);
  fillRect(28, 8, 40, 20, [30, 110, 200]);
  fillRect(48, 8, 60, 20, [40, 150, 70]);
  fillRect(8, 34, 20, 48, [30, 30, 30]);
  fillRect(28, 34, 40, 48, [170, 30, 160]);
  fillRect(48, 34, 60, 48, [240, 150, 10]);
  const cres = await P.run(cpx, CW, CH,
    { colors: 0, style: 'marker', fidelity: 3, algo: 'compiler', seed: 3, returnCanvas: true }, () => {});
  ok('compiler 返回尺寸', cres && cres.W === CW && cres.H === CH, cres ? `${cres.W}x${cres.H}` : '空返回');
  ok('compiler 有笔触', cres && Array.isArray(cres.strokes) && cres.strokes.length > 0,
    cres ? `${cres.strokes.length} 笔` : '');
  const cstats = cres && cres.stats;
  const ctxs = (cstats && cstats.transactions) || [];
  ok('compiler 首个事务是页面底板', ctxs.length > 0 && ctxs[0].kind === 'pageBase' &&
    ctxs[0].x0 === 0 && ctxs[0].y0 === 0 && ctxs[0].x1 === CW - 1 && ctxs[0].y1 === CH - 1,
    ctxs[0] ? `kind=${ctxs[0].kind} box=${ctxs[0].x0},${ctxs[0].y0},${ctxs[0].x1},${ctxs[0].y1}` : '没有事务');
  let txTagged = true, txOrdered = true, lastSeq = -1;
  for (const st of (cres && cres.strokes) || []) {
    if (!Number.isInteger(st.txSeq) || !st.txKind || !st.step) txTagged = false;
    if (st.txSeq < lastSeq) txOrdered = false;
    lastSeq = st.txSeq;
  }
  ok('compiler 每笔都有事务元数据', txTagged);
  ok('compiler 笔触按事务顺序连续', txOrdered);
  let txContinuous = true;
  for (let i = 0; i < ctxs.length; i++) {
    if (ctxs[i].seq !== i) txContinuous = false;
    if (i && ctxs[i].strokeStart !== ctxs[i - 1].strokeEnd) txContinuous = false;
    if (ctxs[i].strokeEnd <= ctxs[i].strokeStart) txContinuous = false;
  }
  ok('compiler 事务无重叠或断档', txContinuous, `${ctxs.length} 个事务`);
  const objectTx = ctxs.filter((tx) => tx.kind === 'object' && Number.isFinite(tx.x0));
  const topRow = objectTx.slice(0, 3), bottomRow = objectTx.slice(3, 6);
  const leftToRight = (row) => row.length > 1 && row.every((tx, i) => !i || tx.x0 > row[i - 1].x0);
  ok('compiler 视觉行先上后下、行内先左后右',
    objectTx.length === 6 && topRow.every((tx) => tx.y0 < 32) &&
    bottomRow.every((tx) => tx.y0 >= 32) && leftToRight(topRow) && leftToRight(bottomRow),
    objectTx.map((tx) => `${tx.x0},${tx.y0}`).join(' | '));
  const cq = cstats && cstats.quality;
  ok('compiler 红线', !!cq && cq.max <= cq.tolerance && cq.uncovered === 0,
    cq ? `max=${cq.max} T=${cq.tolerance} unc=${cq.uncovered} mean=${cq.mean}` : '没有 quality');

  // 合成黑白简笔画：验证极简中心线仍走 object/line 事务，而不是退化成无事务的散笔。
  const LW = 96, LH = 64;
  const lpx = new Uint8ClampedArray(LW * LH * 4);
  for (let i = 0; i < LW * LH; i++) {
    lpx[i * 4] = 255; lpx[i * 4 + 1] = 255; lpx[i * 4 + 2] = 255; lpx[i * 4 + 3] = 255;
  }
  const inkPixel = (x, y) => {
    if (x < 0 || y < 0 || x >= LW || y >= LH) return;
    const i = (y * LW + x) * 4;
    lpx[i] = 20; lpx[i + 1] = 20; lpx[i + 2] = 20;
  };
  for (let x = 10; x < 86; x++) {
    const y = Math.round(16 + (x - 10) * 0.32);
    inkPixel(x, y); inkPixel(x, y + 1);
  }
  for (let y = 16; y < 52; y++) { inkPixel(48, y); inkPixel(49, y); }
  const lres = await P.run(lpx, LW, LH,
    { colors: 0, style: 'marker', fidelity: 3, algo: 'compiler', seed: 3, returnCanvas: true }, () => {});
  const lstrokes = (lres && lres.strokes) || [];
  const ltxs = (lres && lres.stats && lres.stats.transactions) || [];
  const lq = lres && lres.stats && lres.stats.quality;
  const lUntagged = lstrokes.filter((st) => !Number.isInteger(st.txSeq) || !st.txKind || !st.step).length;
  const lMainTx = ltxs.some((tx) => tx.kind === 'object' && tx.steps && tx.steps.line > 0);
  ok('compiler 简笔画中心线事务完整',
    lres && lres.stats.compilerMode === 'centerline' && lstrokes.length > 0 && ltxs.length > 0 &&
    lMainTx && lUntagged === 0 && !!lq && lq.max <= lq.tolerance && lq.uncovered === 0,
    `mode=${lres && lres.stats.compilerMode} tx=${ltxs.length} untagged=${lUntagged} ` +
    `max=${lq && lq.max} unc=${lq && lq.uncovered}`);

  // 直接执行 app.js 里的纯时间轴规划器，保证测试的是产品实际代码。
  const appSrc = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  const tlStart = appSrc.indexOf('function planCompilerTimeline(');
  const tlEnd = appSrc.indexOf('\nfunction buildCompilerTimeline(', tlStart);
  ok('app 编译器时间轴规划器可提取', tlStart >= 0 && tlEnd > tlStart);
  if (tlStart >= 0 && tlEnd > tlStart) {
    const factory = new Function(appSrc.slice(tlStart, tlEnd) + '\nreturn planCompilerTimeline;');
    const planner = factory();
    const tl = planner(cres.strokes, 3);
    const lastEndMs = tl.cumMs[tl.cumMs.length - 1];
    let monotonic = true;
    for (let i = 1; i < tl.cumMs.length; i++) if (tl.cumMs[i] < tl.cumMs[i - 1]) monotonic = false;
    ok('compiler 时间轴覆盖全部笔触并含最终停留',
      monotonic && Math.abs(tl.totalMs - (lastEndMs + tl.finishHoldMs)) < 1e-6 &&
      tl.cumMs[tl.cumMs.length - 2] < tl.totalMs,
      `last=${lastEndMs.toFixed(1)} hold=${tl.finishHoldMs} total=${tl.totalMs.toFixed(1)}`);
    const pageTx = tl.groups[0];
    ok('compiler 底板事务可见时长', pageTx && pageTx.kind === 'pageBase' &&
      pageTx.endMs - pageTx.beginMs >= 2199.9 && pageTx.endMs - pageTx.beginMs <= 2800.1,
      pageTx ? `${(pageTx.endMs - pageTx.beginMs).toFixed(1)}ms` : '没有底板事务');
    const objGroups = tl.groups.filter((g) => g.kind === 'object');
    ok('compiler 每个对象事务至少有完整节拍',
      objGroups.length > 0 && objGroups.every((g) => g.endMs - g.beginMs >= 649.9),
      objGroups.length + ' 个对象事务');
    let timelineContinuous = true;
    for (let i = 1; i < tl.groups.length; i++) {
      if (tl.groups[i].beginMs < tl.groups[i - 1].endMs) timelineContinuous = false;
    }
    ok('compiler 事务时间轴不重叠', timelineContinuous);
    const stress = [];
    for (let g = 0; g < 180; g++) {
      stress.push({ txSeq: g, txKind: 'object', step: 'outline', tp: [0, g, 20, g] });
      stress.push({ txSeq: g, txKind: 'object', step: 'fill', blk: 1, tp: [10, g] });
    }
    const stressTl = planner(stress, 3);
    ok('compiler 时间轴不再受 90 秒硬上限截断', stressTl.totalMs > 90000,
      `stress total=${(stressTl.totalMs / 1000).toFixed(1)}s`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
