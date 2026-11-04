// 校验 app.js 里拟人运笔的时间弯曲 LUT（与 js/app.js 的 buildWarp 同逻辑的拷贝）：
// 1) 直线笔：钟形速度 → s(0.25) 明显 <0.25、s(0.75) 明显 >0.75（起收笔慢、中段快）
// 2) 拐弯笔：同 bell 下，急拐路径比直路在拐角后落后（曲线减速，三分之二幂律）
const WARP_BINS = 24, WARP_SAMPLES = 40;
const BELL_FLOOR = 0.30, BELL_POW = 0.9;   // 与 app.js 保持一致
function buildWarp(tp, noBell) {
  const lin = new Float64Array(WARP_BINS);
  for (let j = 0; j < WARP_BINS; j++) lin[j] = j / (WARP_BINS - 1);
  const n = tp.length / 2;
  if (n < 3) return lin;
  let totalLen = 0;
  for (let i = 1; i < n; i++) totalLen += Math.hypot(tp[i * 2] - tp[(i - 1) * 2], tp[i * 2 + 1] - tp[(i - 1) * 2 + 1]);
  if (totalLen < 14) return lin;
  const M = WARP_SAMPLES;
  const px = new Float64Array(M), py = new Float64Array(M);
  for (let i = 0; i < M; i++) {
    const want = totalLen * i / (M - 1);
    let run = 0;
    for (let k = 1; k < n; k++) {
      const ax = tp[(k - 1) * 2], ay = tp[(k - 1) * 2 + 1];
      const bx = tp[k * 2], by = tp[k * 2 + 1];
      const seg = Math.hypot(bx - ax, by - ay);
      if (run + seg >= want || k === n - 1) {
        const f = seg > 1e-6 ? (want - run) / seg : 0;
        px[i] = ax + (bx - ax) * f; py[i] = ay + (by - ay) * f;
        break;
      }
      run += seg;
    }
  }
  const rs = new Float64Array(M);
  for (let i = 0; i < M; i++) {
    const a = i > 0 ? i - 1 : i, c = i < M - 1 ? i + 1 : i;
    const A = Math.hypot(px[i] - px[c], py[i] - py[c]);
    const B = Math.hypot(px[a] - px[c], py[a] - py[c]);
    const C = Math.hypot(px[a] - px[i], py[a] - py[i]);
    const ar2 = Math.abs((px[i] - px[a]) * (py[c] - py[a]) - (px[c] - px[a]) * (py[i] - py[a])) * 2;
    rs[i] = ar2 > 1e-6 && A * B * C > 1e-9 ? A * B * C / ar2 : 1e9;
  }
  let cum = 0;
  const timeAt = new Float64Array(M);
  for (let i = 0; i < M; i++) {
    if (i > 0) {
      const seg = Math.hypot(px[i] - px[i - 1], py[i] - py[i - 1]);
      const curveK = Math.min(1, Math.max(0.32, 0.135 * Math.cbrt(rs[i])));
      const bell = noBell ? 1 : (BELL_FLOOR + (1 - BELL_FLOOR) * Math.pow(Math.sin(Math.PI * i / (M - 1)), BELL_POW));
      cum += seg / (curveK * bell);
    }
    timeAt[i] = cum;
  }
  const total = cum || 1;
  const out = new Float64Array(WARP_BINS);
  let sI = 0;
  for (let j = 0; j < WARP_BINS; j++) {
    const t = j / (WARP_BINS - 1);
    while (sI < M - 2 && timeAt[sI + 1] / total < t) sI++;
    const t0 = timeAt[sI] / total, t1 = timeAt[sI + 1] / total;
    const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    out[j] = Math.min(1, (sI + f) / (M - 1));
  }
  return out;
}
const lutAt = (w, u) => {
  const f = u * (WARP_BINS - 1), i = f | 0;
  if (i >= WARP_BINS - 1) return 1;
  return w[i] + (w[i + 1] - w[i]) * (f - i);
};
const line = new Float64Array([0, 0, 120, 0, 240, 0]);
const wl = buildWarp(line);
console.log('直线钟形 s(0.25)=%.3f s(0.5)=%.3f s(0.75)=%.3f (期望 ≪0.25 / ≈0.5 / ≫0.75)',
  lutAt(wl, 0.25), lutAt(wl, 0.5), lutAt(wl, 0.75));
// 弯段减速：关掉 bell，用"直行 100px + 半圆弧 r=50（157px）+ 直行 100px"的混合笔。
// 弧长占比 44%，但弧段 speed≈0.5 → 时间占比应 ≈61%，弧走完时（t≈0.80）s 应 ≈0.72。
const arcPts = [];
for (let i = 0; i <= 12; i++) {
  const th = Math.PI * i / 12;
  arcPts.push(100 - Math.cos(th) * 50, Math.sin(th) * 50);   // 起点 (0,0) 向右弯
}
const mixed = new Float64Array([0, 0, 100, 0].concat(arcPts.map((v, i) => v + (i % 2 === 0 ? 0 : 0))).concat([200, 0]));
// 上面拼法不对——直接手工拼：直行 100 → 半圆弧（圆心 (100,0)，r=50，从 (100,0) 绕到 (100,0)？）
// 改为：直行到 (100,0)，半圆 r=50 圆心 (100,50)? 简化：弧从 (100,0) 绕到 (100,0) 不行。
// 直接构造：直行 100px，然后上半圆 r=50（从 (100,0) 到 (200,0)，顶点 (150,-50)），再直行 100px。
const pathPts = [[0, 0], [100, 0]];
for (let i = 1; i <= 12; i++) {
  const th = Math.PI * i / 12;
  pathPts.push([100 + 50 * (1 - Math.cos(th)), -50 * Math.sin(th)]);
}
pathPts.push([300, 0]);
const flat = [];
for (const [x, y] of pathPts) flat.push(x, y);
const mixedPath = new Float64Array(flat);
const wStraight = buildWarp(line, true);
const wMixed = buildWarp(mixedPath, true);
const s08 = lutAt(wMixed, 0.8);
const s09 = lutAt(wMixed, 0.9);
console.log('混合笔（无钟形）: s(0.8)=%s s(0.9)=%s (弧段时间占比 61%%，弧走完 t≈0.80 → s≈0.72，应明显 <0.8)',
  s08.toFixed(3), s09.toFixed(3));
let ok = true;
if (!(lutAt(wl, 0.25) < 0.20)) { ok = false; console.log('FAIL: 起笔减速不足'); }
if (!(lutAt(wl, 0.75) > 0.80)) { ok = false; console.log('FAIL: 收笔减速不足'); }
if (!(lutAt(wl, 0.5) > 0.47 && lutAt(wl, 0.5) < 0.53)) { ok = false; console.log('FAIL: 钟形不对称异常'); }
if (!(s08 < 0.76)) { ok = false; console.log('FAIL: 弧段未占用更多时间'); }
if (!(s09 < 0.86)) { ok = false; console.log('FAIL: 弧段落后未保持'); }
console.log(ok ? 'WARP_OK' : 'WARP_FAIL');
