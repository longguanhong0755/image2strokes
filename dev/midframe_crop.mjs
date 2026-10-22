// 取某个笔号处的关键帧并裁剪一块，写成 raw RGB（做"新旧对比图"用）
// 用法: PIPE=dev/_v19.js node dev/midframe_crop.mjs dev/s3.raw 600 x0,y0,w,h out.rgb
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const pipe = process.env.PIPE || path.join(here, '..', 'js/pipeline.js');
await import(pathToFileURL(path.resolve(pipe)).href);
const buf = fs.readFileSync(process.argv[2]);
const W = buf.readInt32LE(0), H = buf.readInt32LE(4);
const px = new Uint8ClampedArray(buf.buffer, buf.byteOffset + 8, W * H * 4);
const want = +process.argv[3];
const [cx0, cy0, cw, ch] = process.argv[4].split(',').map(Number);
const out = process.argv[5];
const extra = process.env.OPTS ? JSON.parse(process.env.OPTS) : {};
const res = await globalThis.ISP_PIPELINE.run(px, W, H, { colors: 0, returnKeys: true, keyFrames: 1600, ...extra }, () => {});
const keys = res.keys || [];
let best = keys[0], bd = Infinity;
for (const k of keys) { const d = Math.abs(k.i - want); if (d < bd) { bd = d; best = k; } }
const crop = new Uint8Array(cw * ch * 3);
for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
  const s = ((y + cy0) * W + (x + cx0)) * 3, d = (y * cw + x) * 3;
  crop[d] = best.rgb[s]; crop[d + 1] = best.rgb[s + 1]; crop[d + 2] = best.rgb[s + 2];
}
fs.writeFileSync(out, Buffer.from(crop));
console.log(`第 ${want} 笔 → 关键帧 ${best.i} → ${out}（${cw}x${ch}）`);
