// 回归基准：一条命令跑完三张样图，跟基准 JSON 对比（读数 + 成品逐像素 md5）
//   node dev/regress.mjs            跟 dev/regress-baseline.json 对比，劣化/成品变了就报警
//   node dev/regress.mjs --save     把当前结果写成新基准
//   node dev/regress.mjs s1 s3      只跑指定的几张
// 提速类改动的验收口径：md5 必须一致（成品逐像素不变）；改画面类改动则看读数不劣化。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(path.join(here, '..', 'js/pipeline.js')).href);

const BASE = path.join(here, 'regress-baseline.json');
const save = process.argv.includes('--save');
const only = process.argv.slice(2).filter((a) => /^s\d/.test(a));
const names = only.length ? only : ['s1', 's2', 's3'];

// 口径与 README 一致：colors=0（自动）、生产设置（debug 关，避免调试分支影响结果）
const opts = Object.assign({ colors: 0, returnCanvas: true }, process.env.OPTS ? JSON.parse(process.env.OPTS) : {});

const out = {};
for (const nm of names) {
  const buf = fs.readFileSync(path.join(here, nm + '.raw'));
  const W = buf.readInt32LE(0), H = buf.readInt32LE(4);
  const px = new Uint8ClampedArray(buf.buffer, buf.byteOffset + 8, W * H * 4);
  const t0 = Date.now();
  const res = await globalThis.ISP_PIPELINE.run(px, W, H, opts, () => {});
  const sec = (Date.now() - t0) / 1000;
  const c = res.canvasRgb, N = W * H;
  let sum = 0, vis = 0, vis48 = 0, mx = 0;
  for (let p = 0; p < N; p++) {
    const dr = Math.abs(c[p * 3] - px[p * 4]), dg = Math.abs(c[p * 3 + 1] - px[p * 4 + 1]), db = Math.abs(c[p * 3 + 2] - px[p * 4 + 2]);
    const d = Math.max(dr, dg, db);
    sum += (dr + dg + db) / 3;
    if (d > 24) vis++;
    if (d > 48) vis48++;
    if (d > mx) mx = d;
  }
  out[nm] = {
    sec: +sec.toFixed(2),
    strokes: res.stats.strokes,
    avg: +(sum / N).toFixed(3),
    vis: +(vis / N * 100).toFixed(2),
    vis48: +(vis48 / N * 100).toFixed(2),
    max: mx,
    md5: crypto.createHash('md5').update(Buffer.from(c.buffer, c.byteOffset, N * 3)).digest('hex').slice(0, 12),
  };
  const o = out[nm];
  console.log(`${nm}  ${o.sec.toFixed(1)}s  笔 ${o.strokes}  平均 ${o.avg}  可见 ${o.vis}%  明显 ${o.vis48}%  最大 ${o.max}  md5 ${o.md5}`);
}

if (save) {
  fs.writeFileSync(BASE, JSON.stringify(out, null, 2));
  console.log(`\n基准已写入 ${path.basename(BASE)}`);
  process.exit(0);
}

if (!fs.existsSync(BASE)) { console.log('\n（没有基准文件，先跑 --save）'); process.exit(1); }
const base = JSON.parse(fs.readFileSync(BASE, 'utf8'));
let bad = 0;
console.log('\n--- 对比基准 ---');
for (const nm of Object.keys(out)) {
  const a = base[nm], b = out[nm];
  if (!a) { console.log(`${nm}: 基准里没有，跳过`); continue; }
  const d = [];
  if (b.md5 !== a.md5) d.push(`成品 md5 变了（${a.md5} → ${b.md5}）`);
  if (b.strokes !== a.strokes) d.push(`笔数 ${a.strokes} → ${b.strokes}`);
  if (Math.abs(b.avg - a.avg) > 0.02) d.push(`平均差 ${a.avg} → ${b.avg}`);
  if (b.vis > a.vis + 0.02) d.push(`可见差异 ${a.vis}% → ${b.vis}%`);
  if (b.vis48 > a.vis48 + 0.02) d.push(`明显差异 ${a.vis48}% → ${b.vis48}%`);
  const speed = `提速 ${(a.sec / b.sec).toFixed(2)}×（${a.sec}s → ${b.sec}s）`;
  if (d.length) { bad++; console.log(`${nm}: ✗  ${d.join('；')}   ${speed}`); }
  else console.log(`${nm}: ✓  读数与成品都不变   ${speed}`);
}
process.exit(bad ? 1 : 0);
