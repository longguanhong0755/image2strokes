// 补笔合并参数扫描：同一张图跑多组参数，比"总笔数 / 可见差异 / 平均差"
// 用法: node dev/sweep_patch.mjs dev/s2.raw '[{"patchShift":3,"patchCell":256},...]'
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(path.join(here, '..', 'js/pipeline.js')).href);

const rawPath = process.argv[2];
const grid = JSON.parse(process.argv[3]);
const buf = fs.readFileSync(rawPath);
const W = buf.readInt32LE(0), H = buf.readInt32LE(4);
const px = new Uint8ClampedArray(buf.buffer, buf.byteOffset + 8, W * H * 4);

function score(canvasRgb) {
  let sum = 0, bad = 0;
  for (let i = 0; i < W * H; i++) {
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(canvasRgb[i * 3 + k] - px[i * 4 + k]);
      if (d > 8) bad++;
      sum += d;
    }
  }
  return { bad: bad / (W * H * 3) * 100, avg: sum / (W * H * 3) };
}

console.log(`[${path.basename(rawPath)}]  ${W}x${H}`);
for (const g of grid) {
  const t0 = Date.now();
  const res = await globalThis.ISP_PIPELINE.run(px, W, H, Object.assign({ returnCanvas: true, returnKeys: false, debug: true }, g), () => {});
  const sc = score(res.canvasRgb);
  const sp = res.dbg && res.dbg.srcPieces ? res.dbg.srcPieces : 0;
  let mb = 0, boxSum = 0, boxMax = 0;
  for (const cl of res.clips) { mb += cl.w * cl.h; if (cl.w * cl.h > boxMax) boxMax = cl.w * cl.h; }
  boxSum = mb;
  console.log(`  ${JSON.stringify(g).padEnd(40)} 笔数 ${String(res.strokes.length).padStart(6)}  ` +
              `每笔合入 ${(sp / Math.max(1, res.strokes.length)).toFixed(2)}  ` +
              `可见差异 ${sc.bad.toFixed(2)}%  平均差 ${sc.avg.toFixed(2)}  ${((Date.now() - t0) / 1000).toFixed(0)}s  ` +
              `裁剪总面 ${(boxSum / 1e6).toFixed(1)}Mpx 最大单块 ${(boxMax / 1e3).toFixed(0)}kpx`);
  if (process.env.ROUNDS) console.log('    轮次: ' + JSON.stringify(res.dbg.rounds));
}
