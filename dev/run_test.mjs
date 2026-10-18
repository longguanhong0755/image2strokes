// Node 测速台：直接跑浏览器管线，量化"纯色笔触"还原度（不进浏览器）
// 用法: node dev/run_test.mjs dev/cat.raw [colors] [out.rgb]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const pipeFile = process.env.PIPE || path.join(root, 'js/pipeline.js');
await import(pathToFileURL(path.resolve(pipeFile)).href);

const args = process.argv.slice(2);
const rawPath = args[0] || path.join(here, 'cat.raw');
const colors = args[1] ? parseInt(args[1], 10) : 32;
const outPath = args[2] || path.join(here, 'out.rgb');
const extra = args[3] ? JSON.parse(args[3]) : {};

const buf = fs.readFileSync(rawPath);
const W = buf.readInt32LE(0), H = buf.readInt32LE(4);
const px = new Uint8ClampedArray(buf.buffer, buf.byteOffset + 8, W * H * 4);
console.log(`[test] ${path.basename(rawPath)} ${W}x${H}  colors=${colors}`);

const t0 = Date.now();
let lastMsg = '';
const res = await globalThis.ISP_PIPELINE.run(px, W, H, Object.assign({ colors, returnCanvas: true, debug: true }, extra), (p, m) => {
  if (m !== lastMsg) { lastMsg = m; process.stdout.write(`\r[${(p * 100).toFixed(0)}%] ${m}          `); }
});
const dt = (Date.now() - t0) / 1000;
process.stdout.write('\n');

// 指标：与页面完全一致的口径（单通道 >8 记为"可见差异"）
const c = res.canvasRgb;
let sum = 0, bad = 0;
for (let i = 0; i < W * H; i++) {
  for (let k = 0; k < 3; k++) {
    const d = Math.abs(c[i * 3 + k] - px[i * 4 + k]);
    if (d > 8) bad++;
    sum += d;
  }
}
const tot = W * H * 3;
console.log(`[dbg] 主笔 ${res.dbg.mainStrokes}  残差笔 ${res.stats.strokes - res.dbg.mainStrokes}`);
console.log(`[test] 用时 ${dt.toFixed(1)}s  区块 ${res.stats.regions}  线稿组 ${res.stats.inkGroups}  总笔数 ${res.stats.strokes}  ` +
            `总时长 ${(res.stats.totalMs / 1000).toFixed(0)}s`);
if (res.dbg) {
  console.log(`[dbg] 纹理强度 ${(res.dbg.tex*100).toFixed(1)}%  深色区块 ${res.dbg.dark}  其中细线 ${res.dbg.darkThin}  纹理像素块 ${res.dbg.texPix}  小块残留 ${res.dbg.smallLeft}`);
  console.log(`[dbg] 细线组：跟对象 ${res.dbg.inkToObj}  留最后 ${res.dbg.inkLast}`);
  console.log('[dbg] 调色板: ' + res.palette.map((c, i) => `${i}:(${c.join(',')})`).join(' '));
}
console.log(`[test] 平均差 ${(sum / tot).toFixed(2)}/255   可见差异 ${(bad / tot * 100).toFixed(2)}%`);

if (res.canvasRgb) {
  fs.writeFileSync(outPath, Buffer.from(res.canvasRgb.buffer, res.canvasRgb.byteOffset, W * H * 3));
  console.log(`[test] 写出 ${outPath}`);
}
