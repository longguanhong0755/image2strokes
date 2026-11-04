// 3 张样图 × 5 个还原档位：笔数 / 误差 / 耗时 / 实际容差 / 颜色区数
// 用法：node dev/levels.mjs [s1 s2 s3] [1 2 3 4 5] [pyr]
//   默认跑 layer（分层宽笔）；加 pyr 跑 pyramid（逐级细化）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(path.join(here, '..', 'js', 'pipeline.js')).href);

const args = process.argv.slice(2);
const algo = args.includes('pyr') ? 'pyramid' : (args.includes('artist') ? 'artist' : 'layer');
const style = ['marker', 'oil', 'pencil'].find((x) => args.includes(x)) || 'marker';
const allSamples = ['s1', 's2', 's3'];
const samples = args.filter((a) => /^s\d$/.test(a));
const levels = args.filter((a) => /^[1-5]$/.test(a)).map(Number);
const useSamples = samples.length ? samples : allSamples;
const useLevels = levels.length ? levels : [1, 2, 3, 4, 5];

const bufs = new Map();
function loadRaw(name) {
  if (!bufs.has(name)) {
    const p = path.join(here, name + '.raw');
    if (!fs.existsSync(p)) throw new Error('缺少 ' + p + '（先跑 python dev/mkraw.py ...）');
    bufs.set(name, fs.readFileSync(p));
  }
  const buf = bufs.get(name);
  const W = buf.readInt32LE(0), H = buf.readInt32LE(4);
  const px = new Uint8ClampedArray(buf.buffer, buf.byteOffset + 8, W * H * 4);
  return { W, H, px };
}

console.log('algo=' + algo);
console.log('sample  fid  strokes   sec    avg   >8%    >24%   >48%   max  T  regions  unc  photo  ok');
for (const name of useSamples) {
  const { W, H, px } = loadRaw(name);
  for (const fid of useLevels) {
    const copy = new Uint8ClampedArray(px);
    const t0 = Date.now();
    const r = await globalThis.ISP_PIPELINE.run(copy, W, H, { colors: 0, fidelity: fid, algo, style }, () => {});
    const sec = (Date.now() - t0) / 1000;
    const q = r.stats.quality || {};
    const ok = q.artist ? true : (q.max !== undefined && q.max <= q.tolerance + 1e-9 && q.uncovered === 0);
    console.log([
      name.padEnd(6),
      String(fid).padStart(3),
      String(r.stats.strokes).padStart(8),
      sec.toFixed(2).padStart(6),
      (q.mean !== undefined ? q.mean.toFixed(3) : '-').padStart(7),
      (q.gt8 !== undefined ? q.gt8.toFixed(2) : '-').padStart(6),
      (q.gt24 !== undefined ? q.gt24.toFixed(2) : '-').padStart(7),
      (q.gt48 !== undefined ? q.gt48.toFixed(2) : '-').padStart(6),
      String(q.max !== undefined ? q.max : '-').padStart(5),
      String(q.tolerance !== undefined ? q.tolerance : '-').padStart(3),
      String(q.regions !== undefined ? q.regions : '-').padStart(8),
      String(q.uncovered !== undefined ? q.uncovered : '-').padStart(4),
      (r.stats.photo ? 'photo' : 'flat ').padStart(6),
      ok ? 'YES' : 'NO',
    ].join(' '));
  }
}
