// 无头浏览器验收：真实回放中途截图 + 自检 0 白点 + seek + 无页面错误
// 用法: node dev/browser_check.mjs [s1|s2|s3] [fid]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const pwPath = process.env.NPM_CACHE
  ? path.join(process.env.NPM_CACHE, 'node_modules', 'playwright', 'index.mjs')
  : 'C:/Users/Administrator/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs';
const { chromium } = await import(pathToFileURL(pwPath).href);

const sample = process.argv[2] || 's2';
const fid = process.argv[3] || '3';
const algo = process.argv[4] || 'layer';
const styleArg = process.argv[5] || '';
const fileMap = {
  s1: 'samples/sample-1.jpg', s2: 'samples/sample-2.jpg', s3: 'samples/sample-3.jpg',
  portrait: 'dev/portrait.jpg', landscape: 'dev/landscape.jpg',
};
const devImg = ['jpg', 'png'].map((e) => path.join(root, 'dev', sample + '.' + e)).find((p) => fs.existsSync(p));
const imgPath = fileMap[sample] ? path.join(root, fileMap[sample]) : (devImg || path.join(root, fileMap.s2));
const outDir = path.join(here, 'stg');
fs.mkdirSync(outDir, { recursive: true });

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let fp = path.join(root, url === '/' ? 'index.html' : url);
  if (!fp.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    const ext = path.extname(fp);
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});
await new Promise((r) => server.listen(8137, '127.0.0.1', r));

const browser = await chromium.launch({
  executablePath: 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe',
  args: ['--use-gl=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

const seedArg = process.env.ARTIST_SEED || '3';
await page.goto('http://127.0.0.1:8137/?seed=' + seedArg);
console.log('[seed]', seedArg);
await page.evaluate((v) => { document.getElementById('fidelity').value = String(v); }, fid);
await page.evaluate((a) => { const el = document.getElementById('algo'); if (el) el.value = a; }, algo);
if (styleArg) await page.evaluate((v) => { const el = document.getElementById('style'); if (el) el.value = v; }, styleArg);
console.log('[algo]', algo, styleArg ? ('style=' + styleArg) : '');
await page.setInputFiles('#file', imgPath);
await page.waitForFunction(() => document.getElementById('canvasWrap').style.display === 'block', null, { timeout: 120000 });
await page.waitForFunction(() => /第 \d+ \/ \d+ 笔/.test(document.getElementById('stat').textContent || ''), null, { timeout: 60000 });
const stat1 = await page.evaluate(() => document.getElementById('stat').textContent);
console.log('[stat]', stat1.slice(0, 120));

// 回放中途截图（真实 tick 推进）
await page.waitForTimeout(2500);
await page.screenshot({ path: path.join(outDir, `br-${sample}f${fid}-${algo}${styleArg ? '-' + styleArg : ''}-early.png`) });
await page.waitForTimeout(6000);
await page.screenshot({ path: path.join(outDir, `br-${sample}f${fid}-${algo}${styleArg ? '-' + styleArg : ''}-mid.png`) });

// ---- 交互回归：播放/暂停、倍速、笔尖/运笔线、对比原图、细节放大 ----
const uiFails = [];
const statNow = () => page.evaluate(() => document.getElementById('stat').textContent);
const strokeNo = (s) => { const m = /第 (\d+) \//.exec(s || ''); return m ? +m[1] : -1; };
const canvasHash = () => page.evaluate(() => {
  const cv = document.getElementById('cv');
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let h = 2166136261;
  for (let i = 0; i < d.length; i += 97) { h ^= d[i]; h = Math.imul(h, 16777619); }
  return h >>> 0;
});
const setChk = (id, on) => page.evaluate(([cid, v]) => {
  const el = document.getElementById(cid);
  el.checked = v;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, [id, on]);
const setRange = (id, v) => page.evaluate(([rid, val]) => {
  const el = document.getElementById(rid);
  el.value = String(val);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, [id, v]);

// 暂停后笔数不再前进；继续后恢复推进
if ((await page.evaluate(() => document.getElementById('play').textContent)) !== '暂停') {
  uiFails.push('播放中按钮文字不是“暂停”');
}
await page.evaluate(() => document.getElementById('play').click());
await page.waitForTimeout(700);
const p1 = strokeNo(await statNow());
await page.waitForTimeout(700);
const p2 = strokeNo(await statNow());
if ((await page.evaluate(() => document.getElementById('play').textContent)) !== '继续') uiFails.push('暂停后按钮文字不是“继续”');
if (p1 !== p2) uiFails.push('暂停后笔数仍在前进 ' + p1 + '→' + p2);
await page.evaluate(() => document.getElementById('play').click());
await page.waitForTimeout(900);
const p3 = strokeNo(await statNow());
if (!(p3 > p2)) uiFails.push('继续后笔数没有前进 ' + p2 + '→' + p3);
console.log('[play]', p1, p2, p3);

// 倍速：读数变 4×，且同样时长推进的笔数明显更多（先量 1× 基线）
await setRange('speed', 4);
await page.waitForTimeout(200);
const spdTxt = await page.evaluate(() => document.getElementById('speedVal').textContent);
if (spdTxt !== '4×') uiFails.push('倍速读数不是 4×：' + spdTxt);
const a0 = strokeNo(await statNow());
await page.waitForTimeout(900);
const a1 = strokeNo(await statNow());
await setRange('speed', 1);
console.log('[speed]', spdTxt, a0, '→', a1);
if (!(a1 > a0)) uiFails.push('4× 播放时笔数没有前进');
await page.waitForTimeout(250);

// 暂停在固定帧，逐项开关叠加层/对比，画布必须真的变化。
// 笔尖位置可能落在画布外（起笔前的抬笔点），这时开关本来就没有像素变化；
// 先把笔尖/运笔线放到画面中间，测渲染路径本身。
await page.evaluate(() => document.getElementById('play').click());
await page.waitForTimeout(500);
await page.evaluate(() => {
  cursor = { x: W * 0.5, y: H * 0.5, r: 6, pen: 1, color: [0, 0, 0], air: false };
  guide = [W * 0.25, H * 0.3, W * 0.5, H * 0.45, W * 0.75, H * 0.6];
});
await page.waitForTimeout(300);
const snap = () => page.evaluate(() => {
  const cv = document.getElementById('cv');
  window.__cb = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data.slice();
});
const diffSnap = () => page.evaluate(() => {
  const cv = document.getElementById('cv');
  const a = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  const b = window.__cb;
  let n = 0, max = 0;
  for (let q = 0; q < b.length; q += 4) {
    const d = Math.max(Math.abs(a[q] - b[q]), Math.abs(a[q + 1] - b[q + 1]), Math.abs(a[q + 2] - b[q + 2]));
    if (d) { n++; if (d > max) max = d; }
  }
  return { n, max };
});
await snap();
await setChk('tip', false);
await page.waitForTimeout(350);
const tipOff = await diffSnap();
await setChk('tip', true);
if (!(tipOff.n > 0)) uiFails.push('关掉笔尖后画面没变化');
await page.waitForTimeout(300);
await snap();
await setChk('guideChk', false);
await page.waitForTimeout(350);
const guideOff = await diffSnap();
await setChk('guideChk', true);
if (!(guideOff.n > 0)) uiFails.push('关掉运笔线后画面没变化');
await page.waitForTimeout(300);
const hPreCmp = await canvasHash();
await setChk('cmp', true);
await page.waitForTimeout(400);
const hCmp = await canvasHash();
await setChk('cmp', false);
await page.waitForTimeout(400);
const hBack = await canvasHash();
if (hCmp === hPreCmp) uiFails.push('对比原图没有切换画面');
if (hBack !== hPreCmp) uiFails.push('关掉对比原图后没回到画布（' + hPreCmp + '→' + hBack + '）');
console.log('[overlay]', 'tip', tipOff, 'guide', guideOff, 'cmp', hCmp !== hPreCmp, hBack === hPreCmp);

// 细节放大：跳到 70%（点睛段，细笔）应自动出现；关掉立刻收起，再开恢复
await page.evaluate(() => {
  const sk = document.getElementById('seek');
  sk.value = '700';
  sk.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(900);
const loupeOn = () => page.evaluate(() => document.getElementById('loupe').classList.contains('on'));
const l0 = await loupeOn();
await setChk('loupeChk', false);
await page.waitForTimeout(250);
const l1 = await loupeOn();
await setChk('loupeChk', true);
await page.waitForTimeout(250);
const l2 = await loupeOn();
console.log('[loupe]', l0, l1, l2);
if (!l0) uiFails.push('70% 处细节放大没有出现');
if (l1) uiFails.push('关掉细节放大后没有收起');
if (!l2) uiFails.push('重新打开细节放大后没有恢复');

// 关键帧：2% / 15% / 40% / 70%（拖动定位到对应时刻，真实画布状态）
for (const pc of [20, 150, 400, 700]) {
  await page.evaluate((v) => {
    const sk = document.getElementById('seek');
    sk.value = String(v);
    sk.dispatchEvent(new Event('input', { bubbles: true }));
  }, pc);
  await page.waitForTimeout(650);
  await page.screenshot({ path: path.join(outDir, `br-${sample}f${fid}-${algo}${styleArg ? '-' + styleArg : ''}-kf${String(pc / 10).padStart(2, '0')}.png`) });
}

// 拖进度条：先跳 50%，再回 20%
await page.evaluate(() => {
  const sk = document.getElementById('seek');
  sk.value = '500';
  sk.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(700);
await page.screenshot({ path: path.join(outDir, `br-${sample}f${fid}-${algo}${styleArg ? '-' + styleArg : ''}-seek50.png`) });
await page.evaluate(() => {
  const sk = document.getElementById('seek');
  sk.value = '200';
  sk.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(700);

// 阶段跳转：点阶段章应落到该阶段第一笔（画家模式五段）
if (algo === 'artist') {
  for (const ph of [2, 1]) {
    const hit = await page.evaluate((v) => {
      const el = document.querySelector(`#phases span[data-ph="${v}"]`);
      if (!el) return false;
      el.click();
      return true;
    }, ph);
    if (!hit) continue;
    await page.waitForTimeout(800);
    const stp = await page.evaluate(() => document.getElementById('stat').textContent);
    console.log('[phase-jump ' + ph + ']', stp.slice(0, 90));
    await page.screenshot({ path: path.join(outDir, `br-${sample}f${fid}-${algo}${styleArg ? '-' + styleArg : ''}-ph${ph}.png`) });
  }
}

// 看成品：直接落到规划画布
await page.evaluate(() => document.getElementById('toEnd').click());
await page.waitForTimeout(500);
const statEnd = await page.evaluate(() => document.getElementById('stat').textContent);
console.log('[end]', statEnd.slice(0, 160));
await page.screenshot({ path: path.join(outDir, `br-${sample}f${fid}-${algo}${styleArg ? '-' + styleArg : ''}-end.png`) });

// 白点自检（只读）结果在状态行里；再统计成品画布上的纯白像素占比作参考
const whiteInfo = await page.evaluate(() => {
  const cv = document.getElementById('cv');
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let white = 0;
  for (let p = 0; p < cv.width * cv.height; p++) {
    const q = p * 4;
    if (d[q] >= 254 && d[q + 1] >= 254 && d[q + 2] >= 254) white++;
  }
  return { white, total: cv.width * cv.height };
});
console.log('[white]', whiteInfo.white, '/', whiteInfo.total, '(' + (whiteInfo.white / whiteInfo.total * 100).toFixed(2) + '%', 'raw reference)');
// 纯白像素可能是原图本来就白的纸面，不能单看上面的原始计数。
// 以 app 状态行的“空白点/未覆盖”为准：该有色却仍为白的像素必须为 0。
const uncMatch = /未覆盖\s*(\d+)\s*像素/.exec(statEnd);
const blankMatch = /空白点\s*(\d+)\s*个/.exec(statEnd);
const missing = uncMatch ? +uncMatch[1] : (blankMatch ? +blankMatch[1] : null);
if (missing === null) uiFails.push('成品状态行缺少空白点/未覆盖读数');
else if (missing !== 0) uiFails.push('成品仍有 ' + missing + ' 个白点/未覆盖像素');
console.log('[coverage]', missing);

console.log('[interaction]', uiFails.length ? uiFails : 'ok');
console.log('[errors]', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();
server.close();
if (errors.length || uiFails.length) process.exit(1);
