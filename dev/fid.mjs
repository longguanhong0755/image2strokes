// 成品保真度（README 口径）：平均差/255、可见差异（最大通道差 >24 的像素占比）
// 用法: node dev/fid.mjs dev/s3.raw dev/stg/a.rgb [dev/stg/b.rgb ...]
import fs from 'node:fs';
const buf = fs.readFileSync(process.argv[2]);
const W = buf.readInt32LE(0), H = buf.readInt32LE(4);
const px = new Uint8ClampedArray(buf.buffer, buf.byteOffset + 8, W * H * 4);
const N = W * H;
for (const f of process.argv.slice(3)) {
  const b = fs.readFileSync(f);
  if (b.length !== N * 3) { console.log(`${f}: 尺寸不符 ${b.length} ≠ ${N * 3}`); continue; }
  let sum = 0, vis = 0, vis16 = 0, vis48 = 0, mx = 0;
  for (let p = 0; p < N; p++) {
    const dr = Math.abs(b[p * 3] - px[p * 4]), dg = Math.abs(b[p * 3 + 1] - px[p * 4 + 1]), db = Math.abs(b[p * 3 + 2] - px[p * 4 + 2]);
    const d = Math.max(dr, dg, db), s = dr + dg + db;
    sum += s / 3;
    if (d > 24) vis++;
    if (d > 16) vis16++;
    if (d > 48) vis48++;
    if (d > mx) mx = d;
  }
  console.log(`${f}\n  平均差 ${(sum / N).toFixed(3)}/255   可见(>24) ${(vis / N * 100).toFixed(2)}%   较可见(>16) ${(vis16 / N * 100).toFixed(2)}%   明显(>48) ${(vis48 / N * 100).toFixed(2)}%   最大 ${mx}`);
}
