// 取任意笔号处的画布快照（用关键帧），复现"画到第 N 笔时画面长什么样"
// 用法: node dev/frame_at.mjs dev/s3.raw 300,520,570 [colors] [tag]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(path.join(here, '..', 'js/pipeline.js')).href);
const buf = fs.readFileSync(process.argv[2]);
const W = buf.readInt32LE(0), H = buf.readInt32LE(4);
const px = new Uint8ClampedArray(buf.buffer, buf.byteOffset + 8, W * H * 4);
const idxs = process.argv[3].split(',').map(Number);
const colors = process.argv[4] ? +process.argv[4] : 0;
const tag = process.argv[5] || 'fr';
const opts = { returnCanvas: true, returnKeys: true, keyFrames: 1200, debug: true };
if (colors) opts.colors = colors;
const res = await globalThis.ISP_PIPELINE.run(px, W, H, opts, () => {});
const keys = res.keys || [];
const outDir = path.join(here, 'stg'); fs.mkdirSync(outDir, { recursive: true });
const head = Buffer.from(new Int32Array([W, H]).buffer);
for (const want of idxs) {
  let best = keys[0], bd = Infinity;
  for (const k of keys) { const d = Math.abs(k.i - want); if (d < bd) { bd = d; best = k; } }
  const f = path.join(outDir, `${tag}-${want}(实际${best.i}).rgb`);
  fs.writeFileSync(f, Buffer.concat([head, Buffer.from(best.rgb)]));
  console.log(`第 ${want} 笔 → 用第 ${best.i} 笔的帧 → ${f}`);
}
console.log('总笔数', res.stats.strokes, ' 关键帧', keys.length);
