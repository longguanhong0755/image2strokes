// 空白定位：找出"画面是白的但原图不是白"的地方
// 用法: node dev/blanks.mjs dev/s1.raw dev/s1-new.rgb [minSize]
import fs from 'node:fs';
const [rawP, rgbP, minArg] = process.argv.slice(2);
const minSize = minArg ? +minArg : 1;
const buf = fs.readFileSync(rawP);
const W = buf.readInt32LE(0), H = buf.readInt32LE(4);
const px = new Uint8ClampedArray(buf.buffer, buf.byteOffset + 8, W * H * 4);
const rgb = fs.readFileSync(rgbP);
const paint = new Uint8Array(W * H);       // 1 = 结果是白的
for (let i = 0; i < W * H; i++) {
  if (rgb[i*3] >= 248 && rgb[i*3+1] >= 248 && rgb[i*3+2] >= 248) paint[i] = 1;
}
// 原图中"本来就不白"（亮度<200）的位置
const want = [];
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const p = y * W + x;
  const l = 0.299 * px[p*4] + 0.587 * px[p*4+1] + 0.114 * px[p*4+2];
  if (l < 200 && paint[p]) want.push(p);
}
// 8 连通聚类
const seen = new Uint8Array(W * H);
const comps = [];
for (const s of want) {
  if (seen[s]) continue;
  const q = [s]; seen[s] = 1; let head = 0; const cells = [];
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  while (head < q.length) {
    const p = q[head++]; cells.push(p);
    const x = p % W, y = (p - x) / W;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const pp = yy * W + xx;
      if (!seen[pp] && paint[pp]) {
        const l = 0.299 * px[pp*4] + 0.587 * px[pp*4+1] + 0.114 * px[pp*4+2];
        if (l < 200) { seen[pp] = 1; q.push(pp); }
      }
    }
  }
  comps.push({ n: cells.length, x0, y0, x1, y1, p: cells[0] });
}
comps.sort((a, b) => b.n - a.n);
const tot = comps.reduce((a, c) => a + c.n, 0);
console.log(`${rgbP}: 空白像素 ${tot}（占全图 ${(tot/(W*H)*100).toFixed(3)}%），共 ${comps.length} 处；最大 ${comps[0] ? comps[0].n : 0}px`);
for (const c of comps.slice(0, 12)) {
  if (c.n < minSize) break;
  const t = [px[c.p*4], px[c.p*4+1], px[c.p*4+2]];
  console.log(`  ${c.n}px @ (${c.x0},${c.y0})-(${c.x1},${c.y1})  ${c.x1-c.x0+1}x${c.y1-c.y0+1}  该处原图色(${t.join(',')})`);
}
const hist = {};
for (const c of comps) { const b = c.n === 1 ? '1' : c.n <= 4 ? '2-4' : c.n <= 16 ? '5-16' : c.n <= 64 ? '17-64' : '65+'; hist[b] = (hist[b] || 0) + 1; }
console.log('  尺寸分布:', JSON.stringify(hist));
