// 照片过程帧：node dev/_photo_frames.mjs s2 3
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(path.join(here, '..', 'js', 'pipeline.js')).href);
const name = process.argv[2] || 's2';
const seed = +(process.argv[3] || 3);
const buf = fs.readFileSync(path.join(here, name + '.raw'));
const W = buf.readInt32LE(0), H = buf.readInt32LE(4);
const px = new Uint8ClampedArray(buf.buffer, buf.byteOffset + 8, W * H * 4);
const res = await globalThis.ISP_PIPELINE.run(new Uint8ClampedArray(px), W, H,
  { colors: 0, fidelity: 5, algo: 'painter', style: 'marker', returnCanvas: true,
    seed, noPhotoLayers: process.env.NO_PL === '1' }, () => {});
const N = W * H, n = res.strokes.length, keys = res.clips;
const canvas = new Uint8Array(N * 3).fill(255);
const outDir = path.join(here, 'stg');
const head = Buffer.from(new Int32Array([W, H]).buffer);
const picks = [0.25, 0.5, 0.75, 0.9, 1.0].map((f) => Math.max(1, Math.round(n * f)));
picks.push(n);
let done = 0;
for (const want of picks) {
  while (done < want) {
    const st = res.strokes[done++], cl = keys[st.c], col = st.color;
    for (let y = 0; y < cl.h; y++) {
      const row = (cl.y + y) * W + cl.x, mr = y * cl.w;
      for (let x = 0; x < cl.w; x++) {
        if (!cl.mask[mr + x]) continue;
        const q = (row + x) * 3;
        canvas[q] = col[0]; canvas[q + 1] = col[1]; canvas[q + 2] = col[2];
      }
    }
  }
  const f = path.join(outDir, `_ph_${name}_${want}.rgb`);
  fs.writeFileSync(f, Buffer.concat([head, Buffer.from(canvas)]));
  console.log(`${want} -> ${f}`);
}
console.log('total', n);
