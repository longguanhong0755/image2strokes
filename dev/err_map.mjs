// 错误分布诊断：node dev/err_map.mjs dev/s1.raw dev/s1-new.rgb [cell]
import fs from 'node:fs';
const [rawP, rgbP, cellArg] = process.argv.slice(2);
const cell = parseInt(cellArg || '32', 10);
const buf = fs.readFileSync(rawP);
const W = buf.readInt32LE(0), H = buf.readInt32LE(4);
const px = new Uint8ClampedArray(buf.buffer, buf.byteOffset + 8, W * H * 4);
const rgb = fs.readFileSync(rgbP);
let bad = 0, sum = 0;
const badMask = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) {
  let m = 0, s = 0;
  for (let k = 0; k < 3; k++) { const d = Math.abs(rgb[i*3+k] - px[i*4+k]); s += d; if (d > 8) m = 1; }
  sum += s; if (m) { bad++; badMask[i] = 1; }
}
console.log(`总平均差 ${(sum/(W*H*3)).toFixed(2)}  可见差异 ${(bad/(W*H)*100).toFixed(2)}%  (${bad} px)`);
const cw = Math.ceil(W/cell), ch = Math.ceil(H/cell);
const cells = [];
for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
  let n = 0, sr=0,sg=0,sb=0, pr=0,pg=0,pb=0;
  for (let y = cy*cell; y < Math.min(H,(cy+1)*cell); y++) for (let x = cx*cell; x < Math.min(W,(cx+1)*cell); x++) {
    const i = y*W+x;
    if (badMask[i]) { n++; for (let k=0;k<3;k++){} }
    sr+=px[i*4]; sg+=px[i*4+1]; sb+=px[i*4+2];
    pr+=rgb[i*3]; pg+=rgb[i*3+1]; pb+=rgb[i*3+2];
  }
  const tot = Math.min(H,(cy+1)*cell)-cy*cell;
  const n2 = tot * (Math.min(W,(cx+1)*cell)-cx*cell);
  if (n>0) cells.push({cx,cy,n,pct:n/n2*100, t:[Math.round(sr/n2),Math.round(sg/n2),Math.round(sb/n2)], p:[Math.round(pr/n2),Math.round(pg/n2),Math.round(pb/n2)]});
}
cells.sort((a,b)=>b.pct-a.pct);
console.log('最差的 14 个格子（目标色 → 画面色）:');
for (const c of cells.slice(0,14)) {
  console.log(`  (${c.cx*cell},${c.cy*cell})  ${c.pct.toFixed(1)}%  ${c.n}px   target(${c.t.join(',')})  painted(${c.p.join(',')})`);
}
// 错误掩膜出图
const out = Buffer.alloc(W*H*3);
for (let i=0;i<W*H;i++){ const v = badMask[i]?0:255; out[i*3]=v; out[i*3+1]=v; out[i*3+2]=v; }
fs.writeFileSync(rgbP.replace('.rgb','-bad.rgb'), out);
console.log('错误掩膜 → ' + rgbP.replace('.rgb','-bad.rgb'));
