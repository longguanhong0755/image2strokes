// 导出验收：真实浏览器里点四个导出按钮，校验产物不是空壳
// 用法: node dev/export_check.mjs [s1|s2|s3] [marker|oil|pencil] [fid]
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
const style = process.argv[3] || 'oil';
const fid = process.argv[4] || '3';
const fileMap = { s1: 'samples/sample-1.jpg', s2: 'samples/sample-2.jpg', s3: 'samples/sample-3.jpg' };
const imgPath = path.join(root, fileMap[sample] || fileMap.s2);

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const fp = path.join(root, url === '/' ? 'index.html' : url);
  if (!fp.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    const ext = path.extname(fp);
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});
await new Promise((r) => server.listen(8138, '127.0.0.1', r));

const browser = await chromium.launch({
  executablePath: 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe',
  args: ['--use-gl=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
// 大文件导出会弹"约 xx MB，仍然导出吗？"，真浏览器里用户点确定；无头验收里直接同意。
page.on('dialog', (d) => d.accept());

await page.goto('http://127.0.0.1:8138/?seed=' + (process.env.ARTIST_SEED || '3'));
await page.evaluate((v) => { document.getElementById('fidelity').value = String(v); }, fid);
await page.evaluate((a) => { const el = document.getElementById('algo'); if (el) el.value = a; }, (process.env.ALGO || 'artist'));
await page.evaluate((v) => { const el = document.getElementById('style'); if (el) el.value = v; }, style);
await page.setInputFiles('#file', imgPath);
await page.waitForFunction(() => document.getElementById('canvasWrap').style.display === 'block', null, { timeout: 120000 });
await page.waitForFunction(() => /第 \d+ \/ \d+ 笔/.test(document.getElementById('stat').textContent || ''), null, { timeout: 90000 });
// 覆盖下载：不真的落盘，直接在页面里量产物
await page.evaluate(() => {
  window.__dl = [];
  window.download = (blob, name) => {
    const p = (async () => {
      const buf = new Uint8Array(await blob.arrayBuffer());
      const head = Array.from(buf.slice(0, 8)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
      let text = '';
      if (/json|svg|html|text/.test(blob.type) || /\.(json|svg|html)$/.test(name)) {
        text = new TextDecoder().decode(buf.slice(0, 400));
      }
      window.__dl.push({ name, type: blob.type, size: buf.length, head, text });
    })();
    window.__dlP = p;
  };
});
async function grab(label, click, timeout = 20000) {
  const before = await page.evaluate(() => window.__dl.length);
  await page.evaluate(click);
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const n = await page.evaluate(() => window.__dl.length);
    if (n > before) break;
    await page.waitForTimeout(200);
  }
  await page.evaluate(() => window.__dlP && window.__dlP);
  const items = await page.evaluate(() => window.__dl);
  const it = items[items.length - 1];
  if (!it || items.length === before) { console.log('[FAIL]', label, 'no download'); return null; }
  console.log('[dl]', label, it.name, it.type, it.size + 'B', 'head=' + it.head, it.text ? 'text=' + JSON.stringify(it.text.slice(0, 60)) : '');
  return it;
}

const stat1 = await page.evaluate(() => document.getElementById('stat').textContent);
console.log('[stat]', stat1.slice(0, 100));
const results = [];
results.push(['png', await grab('png', () => document.getElementById('expPng').click())]);
results.push(['json', await grab('strokes', () => document.getElementById('expJson').click(), 60000)]);
results.push(['svg', await grab('svg', () => document.getElementById('expSvg').click(), 30000)]);
results.push(['html', await grab('web', () => document.getElementById('expHtml').click(), 60000)]);
results.push(['video', await grab('video', () => document.getElementById('expVideo').click(), 180000)]);

let ok = true;
for (const [kind, it] of results) {
  if (!it) { ok = false; continue; }
  if (kind === 'png' && !(it.size > 8000 && it.head.startsWith('89 50 4e 47'))) { console.log('[BAD] png'); ok = false; }
  if (kind === 'json' && !(it.size > 2000 && it.text.includes('"format"'))) { console.log('[BAD] json'); ok = false; }
  if (kind === 'svg' && !(it.size > 500 && it.text.includes('<svg'))) { console.log('[BAD] svg'); ok = false; }
  if (kind === 'html' && !(it.size > 5000 && it.text.includes('<!DOCTYPE'))) { console.log('[BAD] html'); ok = false; }
  if (kind === 'video' && !(it.size > 20000 && it.head.startsWith('1a 45 df a3'))) { console.log('[BAD] video'); ok = false; }
}
console.log('[errors]', errors.length ? errors.slice(0, 5) : 'none');
console.log('[result]', ok && !errors.length ? 'PASS' : 'FAIL');
await browser.close();
server.close();
process.exit(ok && !errors.length ? 0 : 1);
