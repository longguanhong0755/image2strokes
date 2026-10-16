// 笔画来源分解：按阶段/笔尖/长度分布统计，找出"笔数大户"
// 用法: node dev/stroke_stats.mjs dev/s2.raw [colors]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
await import(pathToFileURL(path.join(root, 'js/pipeline.js')).href);

const rawPath = process.argv[2] || path.join(here, 's2.raw');
const colors = process.argv[3] ? +process.argv[3] : undefined;
const buf = fs.readFileSync(rawPath);
const W = buf.readInt32LE(0), H = buf.readInt32LE(4);
const px = new Uint8ClampedArray(buf.buffer, buf.byteOffset + 8, W * H * 4);

const opts = { returnCanvasArgb: false, returnCanvas: false, stats: true };
if (colors) opts.colors = colors;
const t0 = Date.now();
const res = await globalThis.ISP_PIPELINE.run(px, W, H, opts, () => {});
const dt = (Date.now() - t0) / 1000;

const PH = ['起稿', '铺色', '收形', '点睛'];
const byPh = [0, 0, 0, 0], ptsByPh = [0, 0, 0, 0], lenByPh = [0, 0, 0, 0];
const inkByPh = [0, 0, 0, 0];
for (const s of res.strokes) {
  const ph = s.ph | 0;
  byPh[ph]++;
  ptsByPh[ph] += s.tp.length / 2;
  if (s.pen) inkByPh[ph]++;
  let L = 0;
  for (let i = 1; i < s.tp.length / 2; i++) L += Math.hypot(s.tp[i * 2] - s.tp[(i - 1) * 2], s.tp[i * 2 + 1] - s.tp[(i - 1) * 2 + 1]);
  lenByPh[ph] += L;
}
console.log(`[${path.basename(rawPath)}] ${W}x${H} 用时 ${dt.toFixed(1)}s 总笔数 ${res.strokes.length}  区块 ${res.stats.regions}`);
for (let i = 0; i < 4; i++) {
  console.log(`  ${PH[i]}: ${byPh[i]} 笔 (线稿笔 ${inkByPh[i]})  路径点 ${ptsByPh[i]}  总长 ${lenByPh[i].toFixed(0)}px  平均每笔 ${(byPh[i] ? (lenByPh[i] / byPh[i]).toFixed(1) : 0)}px`);
}

// 短笔/单点笔占比（合并候选）
let tiny = 0, dot = 0, tinyPx = 0;
for (const s of res.strokes) {
  const n = s.tp.length / 2;
  if (n <= 1) { dot++; continue; }
  let L = 0;
  for (let i = 1; i < n; i++) L += Math.hypot(s.tp[i * 2] - s.tp[(i - 1) * 2], s.tp[i * 2 + 1] - s.tp[(i - 1) * 2 + 1]);
  if (L <= 24) { tiny++; tinyPx += L; }
}
console.log(`  单点笔(点状) ${dot}   极短笔(<=24px) ${tiny}   这些短笔总长 ${tinyPx.toFixed(0)}px`);

// 按 clip 掩膜复用度：同 clip 的笔能否合并（同色+同 clip）
const byClip = new Map();
for (let i = 0; i < res.strokes.length; i++) {
  const s = res.strokes[i];
  const key = s.c + '|' + s.color.join(',') + '|' + s.pen + '|' + s.ph + '|' + Math.round(s.w);
  if (!byClip.has(key)) byClip.set(key, []);
  byClip.get(key).push(i);
}
let groups = 0, inGroups = 0, maxG = 0;
for (const v of byClip.values()) { if (v.length > 1) { groups++; inGroups += v.length; if (v.length > maxG) maxG = v.length; } }
console.log(`  同(clip,色,笔尖,阶段,粗细)的重复笔组 ${groups} 组，涉及 ${inGroups} 笔（最大一组 ${maxG} 笔）→ 至多可省 ${inGroups - groups} 笔`);

if (res.stats.breakdown) console.log('  阶段细分:', JSON.stringify(res.stats.breakdown));
