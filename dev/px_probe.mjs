// 像素探针：给一串坐标，打印"原图色 / 成品色 / 归属层（含是否在本层完整形状里）/ 最后一笔是谁（层号·阶段·颜色·笔形点）"
// 用法: node dev/px_probe.mjs dev/s3.raw "x,y;x,y" ['{"opts"}']
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(path.join(here, '..', 'js/pipeline.js')).href);

const buf = fs.readFileSync(process.argv[2]);
const W = buf.readInt32LE(0), H = buf.readInt32LE(4);
const px = new Uint8ClampedArray(buf.buffer, buf.byteOffset + 8, W * H * 4);
const N = W * H;
const extra = process.argv[3] ? JSON.parse(process.argv[3]) : {};
const pts = (process.argv[4] || '').split(';').filter(Boolean).map((s) => s.split(',').map(Number));

const res = await globalThis.ISP_PIPELINE.run(px, W, H, Object.assign({ colors: 0, returnCanvas: true, debug: true, dumpMasks: true, dropDead: false }, extra), () => {});
const U = globalThis.ISP_PIPELINE._u;
const { strokes, clips, canvasRgb } = res;
const D = res.dbg.dumpMasks || [], layers = res.dbg.layers || [];
const mainStrokes = res.dbg.mainStrokes || 0;
const lab = new Int32Array(N).fill(-1);
for (let i = D.length - 1; i >= 0; i--) {
  const o = D[i].own;
  for (let y = 0; y < o.h; y++) for (let x = 0; x < o.w; x++) if (o.m[y * o.w + x]) lab[(y + o.y0) * W + (x + o.x0)] = i;
}
const inFull = (oi, x, y) => {
  const f = D[oi].full;
  return x >= f.x0 && x < f.x0 + f.w && y >= f.y0 && y < f.y0 + f.h && f.m[(y - f.y0) * f.w + (x - f.x0)] === 1;
};
const covBuf = { m: null, w: 0, h: 0 };
function coveredBy(st, gp) {
  const cl = clips[st.c], rib = st.rib, np = rib.length >> 1;
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  for (let i = 0; i < np; i++) { const x = rib[i * 2], y = rib[i * 2 + 1];
    if (x < xmin) xmin = x; if (x > xmax) xmax = x; if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
  const bx = Math.max(cl.x, Math.floor(xmin)), by = Math.max(cl.y, Math.floor(ymin));
  const ex = Math.min(cl.x + cl.w - 1, Math.ceil(xmax)), ey = Math.min(cl.y + cl.h - 1, Math.ceil(ymax));
  const x = gp % W, y = (gp - x) / W;
  if (x < bx || x > ex || y < by || y > ey) return false;
  const w = ex - bx + 1, h = ey - by + 1;
  if (covBuf.w < w || covBuf.h < h) { covBuf.w = Math.max(w, covBuf.w); covBuf.h = Math.max(h, covBuf.h); covBuf.m = new Float32Array(covBuf.w * covBuf.h); }
  const m = covBuf.m, mw = covBuf.w;
  for (let yy = 0; yy < h; yy++) m.fill(0, yy * mw, yy * mw + w);
  const p2 = new Float64Array(np * 2);
  for (let k = 0; k < np; k++) { p2[k * 2] = rib[k * 2] - bx; p2[k * 2 + 1] = rib[k * 2 + 1] - by; }
  U.fillPolyCov(m, mw, h, p2, 2);
  const lx = x - bx, ly2 = y - by;
  if (m[ly2 * mw + lx] < 0.7) return false;
  const rowC = (y - cl.y) * cl.w;
  return !!cl.mask[rowC + (x - cl.x)];
}
console.log(`笔 ${strokes.length}（主笔段结束于 ${mainStrokes}）  层 ${D.length}`);
for (const [x, y] of pts) {
  const p = y * W + x;
  const oi = lab[p];
  const hits = [];
  for (let i = 0; i < strokes.length; i++) if (coveredBy(strokes[i], p)) hits.push(i);
  const last = hits.length ? hits[hits.length - 1] : -1;
  const stage = last < 0 ? '没画上' : (last < mainStrokes ? `层(${strokes[last].ly})` : (strokes[last].ph === 2 || strokes[last].ph === 3 ? '残差/补漏' : '题字/细线'));
  console.log(`\n(${x},${y}) 原图 ${px[p * 4]},${px[p * 4 + 1]},${px[p * 4 + 2]}   成品 ${canvasRgb[p * 3]},${canvasRgb[p * 3 + 1]},${canvasRgb[p * 3 + 2]}`);
  console.log(`   归属 oi ${oi}${oi >= 0 ? `（色 ${D[oi].color.join(',')} 面积 ${D[oi].area} 细长${D[oi].linear ? 1 : 0} 厚${D[oi].thick}） 在本层完整形状里=${inFull(oi, x, y) ? 1 : 0}` : ''}`);
  console.log(`   盖过它的笔 ${hits.length} 支，最后一笔 #${last} 阶段=${stage}${last >= 0 ? ` 色${strokes[last].color.join(',')} w${strokes[last].w} 点${strokes[last].tp.length >> 1} ph${strokes[last].ph} ly${strokes[last].ly}` : ''}`);
  const tail = hits.slice(-5).map((i) => `#${i}(${strokes[i].color.join(',')}${i < mainStrokes ? ' ly' + strokes[i].ly : ' ph' + strokes[i].ph})`);
  if (tail.length) console.log(`   最后 5 支：${tail.join('  ')}`);
}
