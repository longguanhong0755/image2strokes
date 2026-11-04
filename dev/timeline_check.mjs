// 时间轴核算：直接跑管线，按 app.js 的算法算"抬笔移动/停顿/绘制"三段时间
// 用法: node dev/timeline_check.mjs dev/s2.raw [fidelity 1~5，默认 3]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
await import(pathToFileURL(path.join(root, 'js/pipeline.js')).href);
const [rawPath, fidArg] = process.argv.slice(2);
const fidelity = fidArg ? +fidArg : 3;
const buf = fs.readFileSync(rawPath);
const W = buf.readInt32LE(0), H = buf.readInt32LE(4);
const px = new Uint8ClampedArray(buf.buffer, buf.byteOffset + 8, W * H * 4);
const res = await globalThis.ISP_PIPELINE.run(px, W, H, { colors: 0, fidelity }, () => {});
const S = res.strokes;
// 与 app.js 的 buildTimeline 一致：时长按笔数自动定（150 秒起、8 分钟封顶）
const targetMs = Math.max(150000, Math.min(480000, Math.round(S.length * 9)));

// 与 app.js 的 buildTimeline 一致：可见阶段按原 ms，点睛/落款按 vis，三组各有时间预算
function costVis(st) {
  if (!st) return 4;
  const v = +st.vis;
  if (st.vis !== undefined && isFinite(v)) return v <= 0 ? 1 : 1 + 1.4 * Math.sqrt(v);
  if (st.g) return 1 + 3.2 * Math.sqrt(st.g);
  const ms = +st.ms;
  return isFinite(ms) && ms > 0 ? ms : 4;
}
function groupOf(st) { return st.fin ? 2 : ((st.ph | 0) === 3 ? 1 : 0); }
function costOf(st) { const g = groupOf(st); return g === 0 ? (st.ms > 0 ? st.ms : 4) : costVis(st); }

function timeline(capFrac) {
  let ex = 0, ey = 0, prevPh = -1, prevFin = false, jumped = 0;
  const tr = new Float64Array(S.length);
  const bt = new Float64Array(S.length);
  const costs = new Float64Array(S.length);
  const gOf = new Uint8Array(S.length);
  const gRaw = [0, 0, 0], gN = [0, 0, 0];
  for (let i = 0; i < S.length; i++) {
    const tp = S[i].tp;
    if (i > 0) {
      const d = Math.hypot(tp[0] - ex, tp[1] - ey);
      tr[i] = d < 40 ? 0 : Math.min(200, 30 + (d - 40) * 0.35);
      if (tr[i] > 0) jumped++;
    }
    const ph = S[i].ph === undefined ? 1 : (S[i].ph | 0);
    if (prevPh >= 0 && ph !== prevPh) bt[i] = ph === 3 ? 700 : 420;
    if (S[i].fin && !prevFin) bt[i] = Math.max(bt[i], 900);
    prevFin = !!S[i].fin;
    prevPh = ph;
    ex = tp[tp.length - 2]; ey = tp[tp.length - 1];
    const g = groupOf(S[i]), c = costOf(S[i]);
    costs[i] = c; gOf[i] = g; gRaw[g] += c; gN[g]++;
  }
  let sumT = 0; for (let i = 0; i < S.length; i++) sumT += tr[i];
  const cap = targetMs * capFrac;
  if (sumT > cap) { const sc = cap / sumT; for (let i = 0; i < S.length; i++) tr[i] *= sc; }
  let nonPaint = 0; for (let i = 0; i < S.length; i++) nonPaint += tr[i] + bt[i];
  const budget = Math.max(S.length, targetMs - nonPaint);
  const share = [0.87, 0.10, 0.03];
  let active = 0;
  for (let g = 0; g < 3; g++) if (gN[g] > 0) active += share[g];
  const norm = active > 0 ? 1 / active : 0;
  const phaseK = [0, 0, 0];
  for (let g = 0; g < 3; g++) if (gN[g] > 0 && gRaw[g] > 0) phaseK[g] = budget * share[g] * norm / gRaw[g];
  const mp = new Float64Array(S.length);
  let paint = 0;
  for (let i = 0; i < S.length; i++) {
    const g = gOf[i];
    mp[i] = phaseK[g] > 0 ? Math.max(1, costs[i] * phaseK[g]) : 1;
    paint += mp[i];
  }
  return { tr, bt, mp, nonPaint: nonPaint / 1000, travel: sumT > cap ? cap / 1000 : sumT / 1000, jumped, paint: paint / 1000, total: (nonPaint + paint) / 1000 };
}

const phases = [0, 1, 2, 3].map((p) => S.filter((s) => s.ph === p).length);
const nFin = S.filter((s) => s.fin).length;
console.log(`${path.basename(rawPath)}  ${W}x${H}  笔数 ${S.length}  各阶段 ${phases.join('/')}  落款 ${nFin}`);
const cur = timeline(0.12);
console.log(`  时间轴: 移动 ${cur.travel.toFixed(0)}s(${cur.jumped}次抬笔)  停顿 ${(cur.nonPaint - cur.travel).toFixed(0)}s  绘制 ${cur.paint.toFixed(0)}s  → 总 ${cur.total.toFixed(0)}s`);
for (let ph = 0; ph < 4; ph++) {
  let t = 0, np = 0, cnt = 0;
  for (let i = 0; i < S.length; i++) if ((S[i].ph | 0) === ph) { t += cur.tr[i] + cur.bt[i] + cur.mp[i]; np += cur.mp[i]; cnt++; }
  const share = cur.total > 0 ? t / 1000 / cur.total * 100 : 0;
  console.log(`    ph${ph}: ${String(cnt).padStart(6)} 笔  ${(t / 1000).toFixed(0)}s  ${share.toFixed(0)}%  (绘制 ${(np / 1000).toFixed(0)}s)`);
}
let cum = 0, finStart = -1;
for (let i = 0; i < S.length; i++) {
  if (S[i].fin && finStart < 0) finStart = cum;
  cum += cur.tr[i] + cur.bt[i] + cur.mp[i];
}
if (finStart >= 0) console.log(`  落款：第 ${(finStart / 1000).toFixed(1)}s 开始，最后一笔在 ${(cum / 1000).toFixed(1)}s`);
