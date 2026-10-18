// 中途帧审计（第 0 步基线）：把"回放到中途看着没涂满"变成数字。
//   按笔序逐笔落色（与网页端同口径：覆盖率 ≥0.7 且过裁剪掩膜），在**每个对象画完那一刻**统计：
//     ① 该对象自己掩膜里，画布上还不是它自己颜色的像素（= 用户看到的"这一层没画满"，可能是白，也可能是底色）
//     ② 全图"原图有色却还没有任何笔画到"的像素（= 回放里整片空白的量）
//   最后再给关键阶段（全部主笔之后、成品）的读数。
// 用法: node dev/frame_holes.mjs dev/s3.raw ['{"opts"}']
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
const R = new Uint8Array(N), G = new Uint8Array(N), B = new Uint8Array(N);
let nPaper = 0;
for (let i = 0; i < N; i++) {
  R[i] = px[i * 4]; G[i] = px[i * 4 + 1]; B[i] = px[i * 4 + 2];
  if (R[i] > 244 && G[i] > 244 && B[i] > 244) nPaper++;
}

const t0 = Date.now();
const res = await globalThis.ISP_PIPELINE.run(px, W, H, Object.assign({ colors: 0, returnCanvas: true, debug: true, dumpMasks: true, dropDead: false }, extra), () => {});
const U = globalThis.ISP_PIPELINE._u;
const { strokes, clips } = res;
const coverMin = 0.7;
const D = res.dbg.dumpMasks || [];
const layers = res.dbg.layers || [];
const mainStrokes = res.dbg.mainStrokes || strokes.length;
console.log(`笔 ${strokes.length}（主笔 ${mainStrokes}）  层 ${D.length}  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s  opts=${JSON.stringify(extra)}`);

const covBuf = { m: null, w: 0, h: 0 };
function forEachCovered(st, cb) {
  const cl = clips[st.c], rib = st.rib, np = rib.length >> 1;
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  for (let i = 0; i < np; i++) {
    const x = rib[i * 2], y = rib[i * 2 + 1];
    if (x < xmin) xmin = x; if (x > xmax) xmax = x;
    if (y < ymin) ymin = y; if (y > ymax) ymax = y;
  }
  const bx = Math.max(cl.x, Math.floor(xmin)), by = Math.max(cl.y, Math.floor(ymin));
  const ex = Math.min(cl.x + cl.w - 1, Math.ceil(xmax)), ey = Math.min(cl.y + cl.h - 1, Math.ceil(ymax));
  if (ex < bx || ey < by) return;
  const w = ex - bx + 1, h = ey - by + 1;
  if (covBuf.w < w || covBuf.h < h) {
    covBuf.w = Math.max(w, covBuf.w); covBuf.h = Math.max(h, covBuf.h);
    covBuf.m = new Float32Array(covBuf.w * covBuf.h);
  }
  const m = covBuf.m, mw = covBuf.w;
  for (let y = 0; y < h; y++) m.fill(0, y * mw, y * mw + w);
  const p2 = new Float64Array(np * 2);
  for (let k = 0; k < np; k++) { p2[k * 2] = rib[k * 2] - bx; p2[k * 2 + 1] = rib[k * 2 + 1] - by; }
  U.fillPolyCov(m, mw, h, p2, 2);
  for (let y = 0; y < h; y++) {
    const gy = by + y, rowC = (gy - cl.y) * cl.w, row = y * mw;
    for (let x = 0; x < w; x++) {
      if (m[row + x] < coverMin) continue;
      const gx = bx + x;
      if (!cl.mask[rowC + (gx - cl.x)]) continue;
      cb(gy * W + gx);
    }
  }
}

// 边界：每个对象的 to（= 它画完那一刻的下一笔号）
const at = new Map();
for (const L of layers) {
  if (!L.area) continue;
  if (!at.has(L.to)) at.set(L.to, []);
  at.get(L.to).push(L.oi);
}
const canvas = new Uint8Array(N * 3);
const painted = new Uint8Array(N);
let nNever = N - nPaper;              // 原图有色的像素里，还没有任何笔画到的数量
const out = [];
const snap = (label, idx) => {
  const holes = [];
  for (const oi of (at.get(idx) || [])) {
    const L = layers[oi], own = D[oi].own, col = D[oi].color;
    let notOwn = 0, white = 0;
    for (let y = 0; y < own.h; y++) {
      for (let x = 0; x < own.w; x++) {
        if (!own.m[y * own.w + x]) continue;
        const gp = (y + own.y0) * W + (x + own.x0);
        if (!painted[gp]) { white++; continue; }
        const d = Math.abs(canvas[gp * 3] - col[0]) + Math.abs(canvas[gp * 3 + 1] - col[1]) + Math.abs(canvas[gp * 3 + 2] - col[2]);
        if (d > 60) notOwn++;
      }
    }
    holes.push({ oi, area: L.area, linear: L.linear, thick: L.thick, notOwn, white, nOwn: L.area, to: idx });
  }
  out.push({ label, idx, never: nNever, holes });
};
for (let i = 0; i < strokes.length; i++) {
  forEachCovered(strokes[i], (gp) => {
    canvas[gp * 3] = strokes[i].color[0]; canvas[gp * 3 + 1] = strokes[i].color[1]; canvas[gp * 3 + 2] = strokes[i].color[2];
    if (!painted[gp]) {
      painted[gp] = 1;
      const r = R[gp], g = G[gp], b = B[gp];
      if (!(r > 244 && g > 244 && b > 244)) nNever--;
    }
  });
  if (at.has(i + 1)) snap('层完成', i + 1);
  if (i + 1 === mainStrokes) console.log(`\n[主笔全部画完 @${i + 1}] 原图有色却还没画上 = ${nNever} px`);
}
snap('成品', strokes.length);
console.log(`[成品 @${strokes.length}] 原图有色却还没画上 = ${nNever} px`);

// 汇总：每个对象画完时"自己掩膜里还不是自己颜色"的像素
const all = out.flatMap((s) => s.holes.map((h) => ({ ...h, at: s.idx })));
const tot = all.reduce((s, h) => s + h.notOwn, 0);
console.log(`\n各对象"画完那一刻自己掩膜里颜色不对"的像素合计 ${tot} px（层数 ${all.length}）`);
const worst = all.filter((h) => h.notOwn > 0).sort((a, b) => b.notOwn - a.notOwn);
console.log(`有残留的对象 ${worst.length} 个；最差 20 个：`);
console.log('  oi | 面积 | 细长 | 厚 | 画完时颜色不对 | 其中还是白 | 时刻(笔号)');
for (const h of worst.slice(0, 20)) {
  console.log(`  ${String(h.oi).padStart(3)} | ${String(h.area).padStart(6)} | ${h.linear ? ' 是 ' : ' 否 '} | ${String(h.thick).padStart(4)} | ${String(h.notOwn).padStart(14)} | ${String(h.white).padStart(10)} | ${h.at}`);
}
// 逐层"画完时白洞"最大的 10 个（= 回放里看着最空的时刻）
const worstWhite = all.filter((h) => h.white > 0).sort((a, b) => b.white - a.white);
console.log(`\n画完时"自己掩膜里还是白"的层 ${worstWhite.length} 个；最差 10 个：`);
for (const h of worstWhite.slice(0, 10)) {
  console.log(`  oi ${String(h.oi).padStart(3)} 面积${String(h.area).padStart(6)} 细长${h.linear ? 1 : 0} 白 ${String(h.white).padStart(5)} px @笔号 ${h.at}`);
}
