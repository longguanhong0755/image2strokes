// 逐笔覆盖率追查：对给定像素，按网页端口径（非零环绕 + 亚采样）算出每笔的实际覆盖率
// 用法: node dev/probe_cov.mjs dev/s2.raw 759 129 '{"colors":0,"patchShift":3,"patchCell":384}'
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

function fillPoly(mask, mw, mh, pts) {
  const n = pts.length >> 1;
  if (n < 3) return;
  let ymin = Infinity, ymax = -Infinity;
  for (let i = 0; i < n; i++) { const y = pts[i * 2 + 1]; if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
  ymin = Math.max(0, Math.floor(ymin)); ymax = Math.min(mh - 1, Math.ceil(ymax));
  const xs2 = new Float64Array(n + 1), dr = new Int8Array(n + 1), idx = new Int32Array(n + 1);
  for (let y = ymin; y <= ymax; y++) {
    const yc = y + 0.5;
    let m = 0;
    for (let i = 0; i < n; i++) {
      const x0 = pts[i * 2], yy0 = pts[i * 2 + 1];
      const j = (i + 1) % n;
      const x1 = pts[j * 2], yy1 = pts[j * 2 + 1];
      if ((yy0 <= yc && yy1 > yc) || (yy1 <= yc && yy0 > yc)) {
        xs2[m] = x0 + (yc - yy0) / (yy1 - yy0) * (x1 - x0);
        dr[m] = yy1 > yy0 ? 1 : -1;
        m++;
      }
    }
    if (m < 2) continue;
    for (let k = 0; k < m; k++) idx[k] = k;
    const sub = Array.prototype.slice.call(idx.subarray(0, m)).sort((a, b) => xs2[a] - xs2[b]);
    let wind = 0, startX = 0;
    const row = y * mw;
    for (const k of sub) {
      const prev = wind; wind += dr[k];
      if (prev === 0 && wind !== 0) startX = xs2[k];
      else if (prev !== 0 && wind === 0) {
        let xa = Math.ceil(startX - 0.5), xb = Math.floor(xs2[k] - 0.5);
        if (xb < 0 || xa >= mw) continue;
        if (xa < 0) xa = 0; if (xb >= mw) xb = mw - 1;
        for (let x = xa; x <= xb; x++) mask[row + x] = 1;
      }
    }
  }
}

const SUB = 3, OFF = [];
for (let k = 0; k < SUB; k++) OFF.push((2 * k + 1) / (2 * SUB) - 0.5);

const P = Y * W + X;
console.log(`像素 (${X},${Y}) 原图 ${[px[P * 4], px[P * 4 + 1], px[P * 4 + 2]].join(',')}  管线画布 ${[res.canvasRgb[P * 3], res.canvasRgb[P * 3 + 1], res.canvasRgb[P * 3 + 2]].join(',')}`);
let cov = 0;
const bits = [];
for (let si = 0; si < res.strokes.length; si++) {
  const st = res.strokes[si];
  const cl = res.clips[st.c];
  if (X < cl.x || Y < cl.y || X >= cl.x + cl.w || Y >= cl.y + cl.h) continue;
  if (!cl.mask[(Y - cl.y) * cl.w + (X - cl.x)]) continue;
  const rib = st.rib, np = rib.length >> 1;
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  for (let i = 0; i < np; i++) {
    const x = rib[i * 2], y = rib[i * 2 + 1];
    if (x < xmin) xmin = x; if (x > xmax) xmax = x;
    if (y < ymin) ymin = y; if (y > ymax) ymax = y;
  }
  xmin = Math.max(cl.x, Math.floor(xmin) - 1); ymin = Math.max(cl.y, Math.floor(ymin) - 1);
  xmax = Math.min(cl.x + cl.w - 1, Math.ceil(xmax) + 1); ymax = Math.min(cl.y + cl.h - 1, Math.ceil(ymax) + 1);
  if (xmax < xmin || ymax < ymin) { bits.push(`  笔#${si} 框与裁剪不相交`); continue; }
  const mw = xmax - xmin + 1, mh = ymax - ymin + 1;
  const acc = new Float32Array(mw * mh);
  for (const sy of OFF) for (const sx of OFF) {
    const pts = [];
    for (let i = 0; i < np; i++) pts.push(rib[i * 2] - xmin + sx, rib[i * 2 + 1] - ymin + sy);
    const bin = new Uint8Array(mw * mh);
    fillPoly(bin, mw, mh, pts);
    for (let k = 0; k < acc.length; k++) if (bin[k]) acc[k] += 1 / (SUB * SUB);
  }
  const ix = (Y - ymin) * mw + (X - xmin);
  if (ix < 0 || ix >= acc.length) { bits.push(`  笔#${si} 索引越界 ix=${ix} len=${acc.length} X-xmin=${X-xmin} Y-ymin=${Y-ymin} mw=${mw} mh=${mh} 框[${xmin},${ymin}] 裁剪[${cl.x},${cl.y}+${cl.w}x${cl.h}]`); continue; }
  const a = acc[ix];
  cov = cov + (1 - cov) * a;
  bits.push(`  笔#${si} 阶段${st.ph} 色(${st.color.join(',')}) 点数${np} 该像素覆盖率 ${a.toFixed(3)}  框[${xmin},${ymin}+${mw}x${mh}] 裁剪框[${cl.x},${cl.y}+${cl.w}x${cl.h}]`);
}
console.log(bits.join('\n'));
console.log(`  累计覆盖率 cov = ${cov.toFixed(3)}（<0.05 即"没笔盖到"）`);
