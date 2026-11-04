// image2strokes 自己的引擎体检：稳定入口存在、Worker 走入口、pipeline 真能跑。
// 用法：node dev/engine_check.mjs
// GitHub Actions 和本地都可以直接跑，不依赖浏览器。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ENGINE = path.join(ROOT, 'js/engine.js');
const WORKER = path.join(ROOT, 'js/worker.js');
const PIPELINE = path.join(ROOT, 'js/pipeline.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`); }
};

ok('js/engine.js 存在', fs.existsSync(ENGINE));
const src = fs.existsSync(ENGINE) ? fs.readFileSync(ENGINE, 'utf8') : '';
const m = /pipeline\.js\?v=(\d+)/.exec(src);
ok('engine.js 指向 pipeline.js', !!m, m ? `?v=${m[1]}` : '没找到');
const a = /self\.ISP_PIPELINE\.api\s*=\s*(\d+)/.exec(src);
ok('engine.js 声明 api', !!a, a ? `api=${a[1]}` : '没找到');
ok('engine.js 处理了 ENGINE_BASE', /ISP_ENGINE_BASE/.test(src));

const worker = fs.readFileSync(WORKER, 'utf8');
ok('worker 走稳定入口', /importScripts\('engine\.js\?v=/.test(worker), 'worker.js');

await import(pathToFileURL(PIPELINE).href);
const P = globalThis.ISP_PIPELINE;
ok('pipeline 导出 run', !!P && typeof P.run === 'function');

if (P && typeof P.run === 'function') {
  const W = 32, H = 32;
  const px = new Uint8ClampedArray(W * H * 4);
  const colors = [[220, 40, 40], [40, 160, 60], [40, 80, 200], [245, 240, 230]];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = colors[(y < H / 2 ? 0 : 2) + (x < W / 2 ? 0 : 1)];
      const i = (y * W + x) * 4;
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
    }
  }
  const res = await P.run(px, W, H, { colors: 4, style: 'marker', detail: 1, maxStrokes: 300, dropDead: false, returnKeys: false }, () => {});
  ok('run 返回尺寸', res && res.W === W && res.H === H, res ? `${res.W}x${res.H}` : '空返回');
  ok('run 有笔触', res && Array.isArray(res.strokes) && res.strokes.length > 0, res ? `${res.strokes.length} 笔` : '');
  ok('run 有裁剪组', res && Array.isArray(res.clips));
  const s = res && res.strokes && res.strokes[0];
  ok('单笔结构', !!s && Array.isArray(s.rib) && Array.isArray(s.color));

  // 第二种算法：整幅逐级细化（pyramid）也要能走稳定入口，并守住逐像素红线
  const pres = await P.run(new Uint8ClampedArray(px), W, H,
    { colors: 0, style: 'marker', fidelity: 3, algo: 'pyramid', returnCanvas: true }, () => {});
  ok('pyramid 返回尺寸', pres && pres.W === W && pres.H === H, pres ? `${pres.W}x${pres.H}` : '空返回');
  ok('pyramid 有笔触', pres && Array.isArray(pres.strokes) && pres.strokes.length > 0,
    pres ? `${pres.strokes.length} 笔` : '');
  const pq = pres && pres.stats && pres.stats.quality;
  ok('pyramid 红线', !!pq && pq.max <= pq.tolerance && pq.uncovered === 0,
    pq ? `max=${pq.max} T=${pq.tolerance} unc=${pq.uncovered}` : '没有 quality');

  // 画家·过程版：稳定入口也要能跑通，并守住逐像素红线
  const hres = await P.run(new Uint8ClampedArray(px), W, H,
    { colors: 0, style: 'marker', fidelity: 3, algo: 'painter', returnCanvas: true }, () => {});
  ok('painter 返回尺寸', hres && hres.W === W && hres.H === H, hres ? `${hres.W}x${hres.H}` : '空返回');
  ok('painter 有笔触', hres && Array.isArray(hres.strokes) && hres.strokes.length > 0,
    hres ? `${hres.strokes.length} 笔` : '');
  ok('painter 归档', hres && hres.stats && hres.stats.algo === 'painter',
    hres && hres.stats ? `algo=${hres.stats.algo} order=${hres.stats.exactOrder || '-'}` : '');
  const hq = hres && hres.stats && hres.stats.quality;
  ok('painter 红线', !!hq && hq.max <= hq.tolerance && hq.uncovered === 0,
    hq ? `max=${hq.max} T=${hq.tolerance} unc=${hq.uncovered}` : '没有 quality');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
