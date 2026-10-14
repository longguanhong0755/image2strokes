// 两张结果图差异定位：node dev/rgb_diff.mjs dev/a.rgb dev/b.rgb [cell]
import fs from 'node:fs';
const [pa, pb, cellArg] = process.argv.slice(2);
const cell = parseInt(cellArg || '32', 10);
const A = fs.readFileSync(pa), B = fs.readFileSync(pb);
const W = parseInt(process.env.DW || '1024', 10), H = parseInt(process.env.DH || '1024', 10);
let nd = 0, s = 0;
const cells = new Map();
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = (y*W+x)*3;
  const d = Math.max(Math.abs(A[i]-B[i]), Math.abs(A[i+1]-B[i+1]), Math.abs(A[i+2]-B[i+2]));
  s += d;
  if (d > 8) {
    nd++;
    const k = ((y/cell)|0) + ',' + ((x/cell)|0);
    const c = cells.get(k) || { n: 0, sa: [0,0,0], sb: [0,0,0] };
    c.n++; c.sa[0]+=A[i]; c.sa[1]+=A[i+1]; c.sa[2]+=A[i+2];
    c.sb[0]+=B[i]; c.sb[1]+=B[i+1]; c.sb[2]+=B[i+2];
    cells.set(k, c);
  }
}
console.log(`两图平均差 ${(s/(W*H*3)).toFixed(2)}  差异像素 ${(nd/(W*H)*100).toFixed(2)}% (${nd})`);
const arr = [...cells.entries()].map(([k,v]) => ({k, n:v.n, a:v.sa.map(x=>Math.round(x/v.n)), b:v.sb.map(x=>Math.round(x/v.n))}));
arr.sort((p,q)=>q.n-p.n);
for (const c of arr.slice(0,12)) console.log(`  (${c.k}) ${c.n}px  old(${c.a.join(',')})  new(${c.b.join(',')})`);
