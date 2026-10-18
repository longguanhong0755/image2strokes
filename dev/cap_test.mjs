// 笔形端头自检（合成用例）：等宽时 ribbonProf 必须和 ribbon 几乎一模一样。
// 老代码里 ribbonProf 两端扫的是侧后方 ⇒ 端头前半球盖不住、笔身还被啃掉 ~halfW/2。
// 用法: node dev/cap_test.mjs
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(path.join(here, '..', 'js/pipeline.js')).href);
const U = globalThis.ISP_PIPELINE._u;
const R = (U.ribbon || U.ribbonProf) ? U : null;

function cov(pts, w, h) {
  const m = new Float32Array(w * h);
  U.fillPolyCov(m, w, h, pts, 4);
  let n = 0;
  for (let i = 0; i < m.length; i++) if (m[i] >= 0.7) n++;
  return { m, n };
}
const cases = [
  { name: '直线 (0,0)-(20,0) half=3', path: [0, 0, 20, 0], half: 3 },
  { name: '直线 (0,0)-(40,0) half=6', path: [0, 0, 40, 0], half: 6 },
  { name: '折线 (0,0)-(15,0)-(30,12) half=5', path: [0, 0, 15, 0, 30, 12], half: 5 },
  { name: '短笔 (0,0)-(5,0) half=4', path: [0, 0, 5, 0], half: 4 },
];
let bad = 0;
for (const c of cases) {
  const n = c.path.length >> 1;
  const halfs = new Float64Array(n).fill(c.half);
  const a = R.ribbon(new Float64Array(c.path), n, c.half);
  const b = R.ribbonProf(new Float64Array(c.path), n, halfs);
  const W = 80, H = 80;
  const A = cov(a, W, H), B = cov(b, W, H);
  let onlyA = 0, onlyB = 0;
  for (let i = 0; i < A.m.length; i++) {
    if (A.m[i] >= 0.7 && B.m[i] < 0.7) onlyA++;
    if (B.m[i] >= 0.7 && A.m[i] < 0.7) onlyB++;
  }
  const ok = onlyA === 0 && onlyB === 0;
  if (!ok) bad++;
  console.log(`${ok ? 'OK  ' : '差  '} ${c.name}：ribbon ${A.n}px  ribbonProf ${B.n}px  只有 ribbon 有 ${onlyA}px  只有 ribbonProf 有 ${onlyB}px`);
}
console.log(bad ? `\n${bad} 个用例不一致` : '\n全部一致：等宽时两种笔形等价');
