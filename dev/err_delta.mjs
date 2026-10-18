// 误差变化定位：按 48x48 格子统计"可见误差（最大通道差 >24）像素数"的新旧差，
// 列出变差最多的格子 + 样例像素（原图色 / 旧成品 / 新成品）。
// 用法: node dev/err_delta.mjs dev/s3.raw dev/stg/old.rgb dev/stg/new.rgb [格子=48]
import fs from 'node:fs';
const buf = fs.readFileSync(process.argv[2]);
const W = buf.readInt32LE(0), H = buf.readInt32LE(4);
const px = new Uint8ClampedArray(buf.buffer, buf.byteOffset + 8, W * H * 4);
const A = fs.readFileSync(process.argv[3]), B = fs.readFileSync(process.argv[4]);
const CS = process.argv[5] ? +process.argv[5] : 48;
const N = W * H;
const vis = (img, p) => {
  const d = Math.max(Math.abs(img[p * 3] - px[p * 4]), Math.abs(img[p * 3 + 1] - px[p * 4 + 1]), Math.abs(img[p * 3 + 2] - px[p * 4 + 2]));
  return d > 24 ? 1 : 0;
};
const cw = Math.ceil(W / CS), ch = Math.ceil(H / CS);
const cells = [];
for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
  let a = 0, b = 0;
  for (let y = cy * CS; y < Math.min(H, (cy + 1) * CS); y++) for (let x = cx * CS; x < Math.min(W, (cx + 1) * CS); x++) {
    const p = y * W + x;
    a += vis(A, p); b += vis(B, p);
  }
  if (a !== b) cells.push({ cx, cy, a, b, d: b - a });
}
cells.sort((p, q) => q.d - p.d);
let totA = 0, totB = 0;
for (let p = 0; p < N; p++) { totA += vis(A, p); totB += vis(B, p); }
console.log(`可见像素：旧 ${totA}  新 ${totB}  差 ${totB - totA}`);
console.log(`变差最多的 12 格：`);
for (const c of cells.slice(0, 12)) {
  console.log(`  (${c.cx * CS},${c.cy * CS}) 旧${c.a} → 新${c.b}  (+${c.d})`);
  let shown = 0;
  for (let y = c.cy * CS; y < Math.min(H, (c.cy + 1) * CS) && shown < 4; y++) for (let x = c.cx * CS; x < Math.min(W, (c.cx + 1) * CS) && shown < 4; x++) {
    const p = y * W + x;
    if (vis(B, p) && !vis(A, p)) {
      console.log(`      (${x},${y}) 原图 ${px[p * 4]},${px[p * 4 + 1]},${px[p * 4 + 2]}  旧 ${A[p * 3]},${A[p * 3 + 1]},${A[p * 3 + 2]}  新 ${B[p * 3]},${B[p * 3 + 1]},${B[p * 3 + 2]}`);
      shown++;
    }
  }
}
console.log(`变好最多的 6 格：`);
for (const c of cells.slice(-6).reverse()) console.log(`  (${c.cx * CS},${c.cy * CS}) 旧${c.a} → 新${c.b}  (${c.d})`);
