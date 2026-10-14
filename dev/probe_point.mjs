// 诊断：某个像素点到底被哪些笔画覆盖（定位"回声/halo"的来源）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
await import(pathToFileURL(path.join(root, 'js/pipeline.js')).href);

const rawPath = process.argv[2];
const PX = parseInt(process.argv[3], 10), PY = parseInt(process.argv[4], 10);
const buf = fs.readFileSync(rawPath);
const W = buf.readInt32LE(0), H = buf.readInt32LE(4);
const px = new Uint8ClampedArray(buf.buffer, buf.byteOffset + 8, W * H * 4);
const withRes = process.argv[5] === "res";
const res = await globalThis.ISP_PIPELINE.run(px, W, H,
  { colors: 24, returnCanvas: false, returnKeys: false, probe: { x: PX, y: PY }, residual: withRes ? undefined : [] }, () => {});
const ti = (PY * W + PX) * 4;
console.log(`目标色 @(${PX},${PY}) = ${[px[ti], px[ti + 1], px[ti + 2]].join(',')}`);

function inPoly(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length / 2 - 1; i < pts.length / 2; j = i++) {
    const xi = pts[i * 2], yi = pts[i * 2 + 1], xj = pts[j * 2], yj = pts[j * 2 + 1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

let hits = 0;
for (let k = 0; k < res.strokes.length; k++) {
  const s = res.strokes[k];
  const cl = res.clips[s.c];
  if (!cl) continue;
  if (PX < cl.x || PY < cl.y || PX >= cl.x + cl.w || PY >= cl.y + cl.h) continue;
  if (!cl.mask[(PY - cl.y) * cl.w + (PX - cl.x)]) continue;
  if (!inPoly(s.rib, PX + 0.5, PY + 0.5)) continue;
  hits++;
  if (hits <= 12) {
    console.log(`#${k} r=${s.r} color=${s.color.join(',')} w=${s.w} pen=${s.pen} ms=${s.ms.toFixed(0)} clip=${s.c}[${cl.x},${cl.y},${cl.w},${cl.h}]`);
  }
}
console.log(`共 ${hits} 笔覆盖该点（最后一笔决定颜色）`);
if (res.probe) console.log("该点所属区块:", JSON.stringify(res.probe));
