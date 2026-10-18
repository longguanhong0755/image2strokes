// 区域误差矩阵（第 0 步基线）：给定 bbox，把"原图色类 → 成品色类"的迁移计数打出来，
// 再列最大的几个错误连通块（尺寸/bbox/原图均值/成品均值/归属层/最后一笔），区域小就打 ASCII 图。
// 色类默认按海报的米/红/蓝/深/纸底判定，可用第 7 个参数传 JSON 覆盖。
// 用法: node dev/region_matrix.mjs dev/s3.raw x0 y0 x1 y1 ['{"opts"}']
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(path.join(here, '..', 'js/pipeline.js')).href);

const buf = fs.readFileSync(process.argv[2]);
const W = buf.readInt32LE(0), H = buf.readInt32LE(4);
const px = new Uint8ClampedArray(buf.buffer, buf.byteOffset + 8, W * H * 4);
const N = W * H;
const X0 = +process.argv[3], Y0 = +process.argv[4], X1 = +process.argv[5], Y1 = +process.argv[6];
const extra = process.argv[7] ? JSON.parse(process.argv[7]) : {};
const R = new Uint8Array(N), G = new Uint8Array(N), B = new Uint8Array(N);
for (let i = 0; i < N; i++) { R[i] = px[i * 4]; G[i] = px[i * 4 + 1]; B[i] = px[i * 4 + 2]; }

const t0 = Date.now();
const res = await globalThis.ISP_PIPELINE.run(px, W, H, Object.assign({ colors: 0, returnCanvas: true, debug: true, dumpMasks: true, dropDead: false }, extra), () => {});
const U = globalThis.ISP_PIPELINE._u;
const { strokes, clips, canvasRgb } = res;
const coverMin = 0.7;
const D = res.dbg.dumpMasks || [];
const layers = res.dbg.layers || [];
console.log(`笔 ${strokes.length}  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s  区域 (${X0},${Y0})..(${X1},${Y1})  opts=${JSON.stringify(extra)}`);

// 层归属：用 own 掩膜反推
const lab = new Int32Array(N).fill(-1);
for (let i = D.length - 1; i >= 0; i--) {
  const o = D[i].own;
  for (let y = 0; y < o.h; y++) for (let x = 0; x < o.w; x++) if (o.m[y * o.w + x]) lab[(y + o.y0) * W + (x + o.x0)] = i;
}
// 最后一笔
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
const last = res.dbg.deadScan || new Int32Array(N).fill(-1);
if (!res.dbg.deadScan) for (let i = 0; i < strokes.length; i++) forEachCovered(strokes[i], (gp) => { last[gp] = i; });
else console.log('（最后一笔用管线自己的 deadScan，口径权威）');

// 色类
const REF = [
  { k: 'C', c: [237, 229, 186] },   // 米色（字/飞机）
  { k: 'R', c: [238, 54, 42] },     // 红描边
  { k: 'B', c: [20, 70, 130] },     // 蓝底
  { k: 'K', c: [20, 20, 24] },      // 深色（黑字/机轮）
  { k: 'W', c: [246, 246, 244] },   // 纸底/白
];
const CUT = 95;
function cls(r, g, b) {
  let best = '?', bd = Infinity;
  for (const f of REF) {
    const d = Math.abs(r - f.c[0]) + Math.abs(g - f.c[1]) + Math.abs(b - f.c[2]);
    if (d < bd) { bd = d; best = f.k; }
  }
  return bd > CUT ? '?' : best;
}
const mat = new Map();
let nPix = 0;
for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) {
  const p = y * W + x;
  const a = cls(R[p], G[p], B[p]), b = cls(canvasRgb[p * 3], canvasRgb[p * 3 + 1], canvasRgb[p * 3 + 2]);
  const key = a + '>' + b;
  mat.set(key, (mat.get(key) || 0) + 1);
  nPix++;
}
console.log(`\n区域像素 ${nPix}；色类迁移（只列 ≥3 的）：`);
const keys = [...mat.entries()].sort((a, b) => b[1] - a[1]);
const ORDER = ['C', 'R', 'B', 'K', 'W', '?'];
for (const a of ORDER) {
  const row = keys.filter(([k]) => k[0] === a).sort((x, y) => y[1] - x[1]);
  if (!row.length) continue;
  const line = row.filter(([, v]) => v >= 3).map(([k, v]) => `${k} ${v}`).join('   ');
  const same = mat.get(a + '>' + a) || 0;
  const tot = row.reduce((s, [, v]) => s + v, 0);
  if (line) console.log(`  原图${a}（${tot}px，其中对上 ${same} = ${(same / tot * 100).toFixed(1)}%）: ${line}`);
}

// 错误连通块（色类不同）
const bad = new Uint8Array(N);
let nBad = 0;
for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) {
  const p = y * W + x;
  if (cls(R[p], G[p], B[p]) !== cls(canvasRgb[p * 3], canvasRgb[p * 3 + 1], canvasRgb[p * 3 + 2])) { bad[p] = 1; nBad++; }
}
const seen = new Uint8Array(N);
const blocks = [];
const st = [];
for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) {
  const p0 = y * W + x;
  if (!bad[p0] || seen[p0]) continue;
  st.length = 0; st.push(p0); seen[p0] = 1;
  let h = 0, bx0 = x, bx1 = x, by0 = y, by1 = y, sr = 0, sg = 0, sb = 0, cr = 0, cg = 0, cb = 0, w2 = 0;
  const owners = new Map(), lasts = new Map();
  while (h < st.length) {
    const p = st[h++];
    const px2 = p % W, py = (p - px2) / W;
    if (px2 < bx0) bx0 = px2; if (px2 > bx1) bx1 = px2; if (py < by0) by0 = py; if (py > by1) by1 = py;
    sr += R[p]; sg += G[p]; sb += B[p]; cr += canvasRgb[p * 3]; cg += canvasRgb[p * 3 + 1]; cb += canvasRgb[p * 3 + 2];
    if (lab[p] >= 0) owners.set(lab[p], (owners.get(lab[p]) || 0) + 1);
    if (last[p] >= 0) lasts.set(last[p], (lasts.get(last[p]) || 0) + 1);
    w2++;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = px2 + dx, ny = py + dy;
      if (nx < X0 || nx > X1 || ny < Y0 || ny > Y1) continue;
      const q = ny * W + nx;
      if (bad[q] && !seen[q]) { seen[q] = 1; st.push(q); }
    }
  }
  const topOwner = [...owners.entries()].sort((a, b) => b[1] - a[1])[0] || [-1, 0];
  const topLast = [...lasts.entries()].sort((a, b) => b[1] - a[1])[0] || [-1, 0];
  blocks.push({ n: w2, bx0, by0, bx1, by1, sr, sg, sb, cr, cg, cb, oi: topOwner[0], nOwn: topOwner[1], last: topLast[0], nLast: topLast[1] });
}
blocks.sort((a, b) => b.n - a.n);
console.log(`\n错误块 ${blocks.length} 个 / 共 ${nBad} px；最大 8 个：`);
for (const b of blocks.slice(0, 8)) {
  const L = b.oi >= 0 ? layers[b.oi] : null;
  const s2 = b.last >= 0 ? strokes[b.last] : null;
  console.log(`  ${String(b.n).padStart(6)}px  (${b.bx0},${b.by0})..(${b.bx1},${b.by1})  原图 ${(b.sr / b.n).toFixed(0)},${(b.sg / b.n).toFixed(0)},${(b.sb / b.n).toFixed(0)} → 成品 ${(b.cr / b.n).toFixed(0)},${(b.cg / b.n).toFixed(0)},${(b.cb / b.n).toFixed(0)}`);
  console.log(`          归属 oi ${b.oi}（${b.nOwn}/${b.n}，${L ? `面积${L.area} 细长${L.linear ? 1 : 0} 厚${L.thick} 色${D[b.oi].color.join(',')}` : ''}）  最后一笔 #${b.last}（${b.nLast}/${b.n}${s2 ? `，ly=${s2.ly} ph=${s2.ph} 色${s2.color.join(',')} w${s2.w} 点${s2.tp.length >> 1}` : ''}）`);
}

// ASCII（区域够小才打）
if (X1 - X0 + 1 <= 120 && Y1 - Y0 + 1 <= 84) {
  console.log(`\nASCII（大写=原图、小写=成品；C/c 米色 B/b 蓝 R/r 红 K/k 深 W/w 纸底 ?=其它）：`);
  for (let y = Y0; y <= Y1; y++) {
    let s1 = '', s2 = '';
    for (let x = X0; x <= X1; x++) {
      const p = y * W + x;
      const a = cls(R[p], G[p], B[p]), b = cls(canvasRgb[p * 3], canvasRgb[p * 3 + 1], canvasRgb[p * 3 + 2]);
      s1 += a; s2 += b === '?' ? '.' : b.toLowerCase();
    }
    console.log('  ' + s1);
    console.log('  ' + s2);
  }
}
