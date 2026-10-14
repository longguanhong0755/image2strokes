// 时间轴核算：直接跑管线，按 app.js 的算法算"抬笔移动/停顿/绘制"三段时间
// 用法: node dev/timeline_check.mjs dev/s2.raw [colors]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
await import(pathToFileURL(path.join(root, 'js/pipeline.js')).href);
const [rawPath, colorsArg] = process.argv.slice(2);
const colors = colorsArg ? +colorsArg : 24;
const buf = fs.readFileSync(rawPath);
const W = buf.readInt32LE(0), H = buf.readInt32LE(4);
const px = new Uint8ClampedArray(buf.buffer, buf.byteOffset + 8, W * H * 4);
const res = await globalThis.ISP_PIPELINE.run(px, W, H, { colors, targetSec: 240 }, () => {});
const S = res.strokes;
const targetMs = 240000;
function timeline(travelRule, capFrac) {
  let ex = 0, ey = 0, raw = 0, prevPh = -1, jumped = 0;
  const tr = new Float64Array(S.length);
  const bt = new Float64Array(S.length);
  for (let i = 0; i < S.length; i++) {
    const tp = S[i].tp;
    if (i > 0) {
      const d = Math.hypot(tp[0] - ex, tp[1] - ey);
      tr[i] = travelRule(d);
      if (tr[i] > 0) jumped++;
    }
    const ph = S[i].ph === undefined ? 1 : S[i].ph;
    if (prevPh >= 0 && ph !== prevPh) bt[i] = ph === 3 ? 700 : 420;
    prevPh = ph;
    ex = tp[tp.length - 2]; ey = tp[tp.length - 1];
    raw += S[i].ms;
  }
  let sumT = 0; for (let i = 0; i < S.length; i++) sumT += tr[i];
  const cap = targetMs * capFrac;
  if (sumT > cap) { const sc = cap / sumT; for (let i = 0; i < S.length; i++) tr[i] *= sc; }
  let nonPaint = 0; for (let i = 0; i < S.length; i++) nonPaint += tr[i] + bt[i];
  const budget = Math.max(S.length * 3, targetMs - nonPaint);
  const k = budget / raw;
  let msPaint = 0;
  for (let i = 0; i < S.length; i++) msPaint += Math.max(3, S[i].ms * k);
  return { nonPaint: nonPaint / 1000, travel: tr.reduce((a, b) => a + b, 0) / 1000, jumped, msPaint: msPaint / 1000, total: (nonPaint + msPaint) / 1000 };
}
const phases = [0, 1, 2, 3].map((p) => S.filter((s) => s.ph === p).length);
console.log(`${path.basename(rawPath)}  ${W}x${H}  笔数 ${S.length}  各阶段 ${phases.join('/')}`);
const cur = timeline((d) => (d < 40 ? 0 : Math.min(200, 30 + (d - 40) * 0.35)), 0.2);
console.log(`  现在:  移动 ${cur.travel.toFixed(0)}s(${cur.jumped}次抬笔)  停顿 ${(cur.nonPaint - cur.travel).toFixed(0)}s  绘制 ${cur.msPaint.toFixed(0)}s  → 总 ${cur.total.toFixed(0)}s`);
const alt = timeline((d) => (d < 40 ? 0 : Math.min(200, 30 + (d - 40) * 0.35)), 0.12);
console.log(`  收紧:  移动 ${alt.travel.toFixed(0)}s(${alt.jumped}次抬笔)  停顿 ${(alt.nonPaint - alt.travel).toFixed(0)}s  绘制 ${alt.msPaint.toFixed(0)}s  → 总 ${alt.total.toFixed(0)}s`);
