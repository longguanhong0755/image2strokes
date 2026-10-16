// 单点追查：给定像素，列出所有"掩膜里有它"的笔，看谁该盖住它却没盖住
// 用法: node dev/probe_dot.mjs dev/s2.raw 759 129 '{"colors":0,"patchShift":3,"patchCell":384}'
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(path.join(here, '..', 'js/pipeline.js')).href);

const [rawPath, xs, ys, optJson] = process.argv.slice(2);
const X = +xs, Y = +ys;
const extra = optJson ? JSON.parse(optJson) : {};
const buf = fs.readFileSync(rawPath);
const W = buf.readInt32LE(0), H = buf.readInt32LE(4);
const px = new Uint8ClampedArray(buf.buffer, buf.byteOffset + 8, W * H * 4);
const res = await globalThis.ISP_PIPELINE.run(px, W, H, Object.assign({ returnCanvas: true, debug: true }, extra), () => {});
const fillPolyEo = globalThis.ISP_PIPELINE._u.fillPoly;

const P = Y * W + X;
console.log(`像素 (${X},${Y}) 原图 ${[px[P * 4], px[P * 4 + 1], px[P * 4 + 2]].join(',')}  管线画布 ${[res.canvasRgb[P * 3], res.canvasRgb[P * 3 + 1], res.canvasRgb[P * 3 + 2]].join(',')}`);
let found = 0;
for (let si = 0; si < res.strokes.length; si++) {
  const st = res.strokes[si];
  const cl = res.clips[st.c];
  if (!cl) { console.log(`  笔#${si} 裁剪缺失 c=${st.c}`); continue; }
  if (X < cl.x || Y < cl.y || X >= cl.x + cl.w || Y >= cl.y + cl.h) continue;
  if (!cl.mask[(Y - cl.y) * cl.w + (X - cl.x)]) continue;
  // 掩膜里有这个像素：检查笔形是否盖住像素中心
  const rib = st.rib, n = rib.length >> 1;
  let xmin = Infinity, ymin = Infinity;
  for (let i = 0; i < n; i++) { if (rib[i * 2] < xmin) xmin = rib[i * 2]; if (rib[i * 2 + 1] < ymin) ymin = rib[i * 2 + 1]; }
  let xmax = -Infinity, ymax = -Infinity;
  for (let i = 0; i < n; i++) { if (rib[i * 2] > xmax) xmax = rib[i * 2]; if (rib[i * 2 + 1] > ymax) ymax = rib[i * 2 + 1]; }
  const inside = X + 0.5 > xmin - 1e-9 && X + 0.5 < xmax + 1e-9 && Y + 0.5 > ymin - 1e-9 && Y + 0.5 < ymax + 1e-9;
  console.log(`  笔#${si} 阶段${st.ph} 色(${st.color.join(',')}) 点数${n} 笔形框[${xmin},${ymin}-${xmax},${ymax}] ` +
              `裁剪框[${cl.x},${cl.y}+${cl.w}x${cl.h}] 中心在笔形内=${inside} 掩膜内=1`);
  found++;
}
console.log(`  掩膜含该像素的笔共 ${found} 笔`);
