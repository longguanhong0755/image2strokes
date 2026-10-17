// 笔数分解：总笔数是哪个阶段贡献的、小碎块占了多少（省笔改造的决策依据，只读不改图）
// 用法: node dev/stroke_breakdown.mjs dev/s3.raw [colors]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
await import(pathToFileURL(path.join(root, 'js/pipeline.js')).href);

const rawPath = process.argv[2] || path.join(here, 's3.raw');
const colors = process.argv[3] ? +process.argv[3] : undefined;
const buf = fs.readFileSync(rawPath);
const W = buf.readInt32LE(0), H = buf.readInt32LE(4);
const px = new Uint8ClampedArray(buf.buffer, buf.byteOffset + 8, W * H * 4);

const opts = { returnCanvas: true, returnKeys: false, debug: true };
if (colors) opts.colors = colors;
if (process.env.OPTS) Object.assign(opts, JSON.parse(process.env.OPTS));   // 参数扫描：OPTS='{"patchBox":256}'
const t0 = Date.now();
const res = await globalThis.ISP_PIPELINE.run(px, W, H, opts, () => {});
const dt = (Date.now() - t0) / 1000;
const d = res.dbg || {};
const st = res.stats;

console.log(`\n[${path.basename(rawPath)}] ${W}x${H}  用时 ${dt.toFixed(1)}s  总笔数 ${st.strokes}`);
console.log(`  区块 ${st.regions} 个 · 线稿组 ${st.inkGroups} · 纹理强度 ${((d.tex || 0) * 100).toFixed(1)}% · ${st.colors} 色${st.photo ? '（照片档）' : ''}`);

// 阶段分解：marks 记的是"该阶段结束时的累计笔数"，相邻两项之差 = 这个阶段新增了多少笔
const marks = d.marks || [];
console.log('\n  阶段分解（累计 → 新增）:');
let prev = 0;
for (const m of marks) {
  console.log(`    ${m.tag.padEnd(8)} 累计 ${String(m.n).padStart(6)}   新增 ${String(m.n - prev).padStart(6)}`);
  prev = m.n;
}

// 成品口径（与网页端一致：单通道 >8 记"可见差异"）
{
  const c = res.canvasRgb;
  let sum = 0, bad = 0;
  for (let i = 0; i < W * H; i++) {
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(c[i * 3 + k] - px[i * 4 + k]);
      if (d > 8) bad++;
      sum += d;
    }
  }
  const tot = W * H * 3;
  console.log(`\n  成品：平均差 ${(sum / tot).toFixed(2)}/255 · 可见差异 ${(bad / tot * 100).toFixed(2)}%`);
}
if (d.bk) console.log(`  补丁涉及的不同色阶桶 ${d.bk.size} 个`);

const AB = ['<120', '120-600', '600-2400', '2400-1万', '≥1万'];
if (d.areaHist) {
  let tot = 0;
  for (const v of d.areaHist) tot += v;
  console.log('\n  区块面积分布:');
  for (let i = 0; i < d.areaHist.length; i++) {
    console.log(`    ${AB[i].padEnd(10)} ${String(d.areaHist[i]).padStart(6)} 个   ${(d.areaHist[i] / Math.max(1, tot) * 100).toFixed(1)}%`);
  }
}
if (d.sweepByArea) {
  console.log('\n  铺色笔按"区块面积"分解:');
  for (let i = 0; i < d.sweepByArea.length; i++) {
    console.log(`    ${AB[i].padEnd(10)} ${String(d.sweepByArea[i]).padStart(6)} 笔`);
  }
}
if (d.sweep) console.log(`\n  铺色区块 ${d.sweep.regions} 个 · 总档数 ${d.sweep.passes} · 单块最多 ${d.sweep.maxPass} 档`);
if (d.rounds) {
  console.log('  残差各轮（补丁数/落盘笔数/可见差异）:');
  for (const r of d.rounds) console.log(`    第${r.r + 1}轮 thr=${r.thr}  补丁 ${r.补丁}  笔 ${r.笔}  差异 ${r.差异}%`);
}

let dot = 0, tiny = 0, poolN = 0, poolIn = 0, poolMax = 0, solo = 0;
for (const s of res.strokes) {
  if (s.g) { poolN++; poolIn += s.g; if (s.g > poolMax) poolMax = s.g; if (s.g === 1) solo++; }
  const n = s.tp.length / 2;
  if (n <= 1) { dot++; continue; }
  let L = 0;
  for (let i = 1; i < n; i++) L += Math.hypot(s.tp[i * 2] - s.tp[(i - 1) * 2], s.tp[i * 2 + 1] - s.tp[(i - 1) * 2 + 1]);
  if (L <= 24) tiny++;
}
console.log(`\n  单点笔 ${dot} · 极短笔(≤24px) ${tiny}`);
console.log(`  补丁笔 ${poolN} 笔（合进 ${poolIn} 个补丁，最大一组 ${poolMax}，其中"只合了 1 个补丁"的 ${solo} 笔）`);
{
  let bytes = 0, big = 0;
  for (const c of res.clips) { bytes += c.mask.length; if (c.w * c.h > 128 * 128) big++; }
  console.log(`  裁剪掩膜 ${res.clips.length} 张，合计 ${(bytes / 1048576).toFixed(1)} MB（>128x128 的 ${big} 张）`);
}
