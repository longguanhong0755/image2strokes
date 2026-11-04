// 照片细化回归：node dev/_photo_layers.mjs s2 3 5
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(path.join(here, '..', 'js', 'pipeline.js')).href);
const name = process.argv[2] || 's2';
const seed = +(process.argv[3] || 3);
const fid = +(process.argv[4] || 5);
const buf = fs.readFileSync(path.join(here, name + '.raw'));
const W = buf.readInt32LE(0), H = buf.readInt32LE(4);
const px = new Uint8ClampedArray(buf.buffer, buf.byteOffset + 8, W * H * 4);
const t0 = Date.now();
const r = await globalThis.ISP_PIPELINE.run(new Uint8ClampedArray(px), W, H,
  { colors: 0, fidelity: fid, algo: 'painter', style: 'marker', returnCanvas: true, debug: true, seed, noPhotoLayers: process.env.NO_PL === '1' }, () => {});
const C = r.canvasRgb, N = W * H;
let sum = 0, gt24 = 0, gt16 = 0;
for (let p = 0; p < N; p++) {
  const q = p * 3, s = p * 4;
  const d = Math.max(Math.abs(C[q] - px[s]), Math.abs(C[q + 1] - px[s + 1]), Math.abs(C[q + 2] - px[s + 2]));
  sum += d; if (d > 24) gt24++; if (d > 16) gt16++;
}
console.log('FINAL ' + name + ' seed=' + seed + ' n=' + r.strokes.length +
  ' mean=' + (sum / N).toFixed(3) + ' gt16=' + (100 * gt16 / N).toFixed(2) +
  '% gt24=' + (100 * gt24 / N).toFixed(2) + '% unc=' + r.stats.quality.uncovered +
  ' ph=' + JSON.stringify(r.stats.phases) + ' totalMs=' + (r.stats.totalMs/1000).toFixed(1) + 's' + ' wall=' + ((Date.now()-t0)/1000).toFixed(1) + 's');
