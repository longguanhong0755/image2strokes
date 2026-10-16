// 抗锯齿空白点定位：按网页端的真实渲染方式（canvas 抗锯齿多边形 ∩ 1 位硬遮罩，逐笔 source-over）
// 模拟出成品图，再找"结果是白的但原图不白"的小点。
// 用法: node dev/aa_blanks.mjs dev/s1.raw [optsJSON]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const pipeFile = process.env.PIPE || path.join(root, 'js/pipeline.js');
await import(pathToFileURL(path.resolve(pipeFile)).href);

const args = process.argv.slice(2);
const rawPath = args[0] || path.join(here, 's1.raw');
const SUB = args[1] ? parseInt(args[1], 10) : 3;          // 每像素每轴亚采样数
const extra = args[2] ? JSON.parse(args[2]) : {};

const buf = fs.readFileSync(rawPath);
const W = buf.readInt32LE(0), H = buf.readInt32LE(4);
const px = new Uint8ClampedArray(buf.buffer, buf.byteOffset + 8, W * H * 4);

const t0 = Date.now();
const res = await globalThis.ISP_PIPELINE.run(px, W, H, Object.assign({ returnCanvas: true }, extra), () => {});
console.log(`[aa] 提取 ${(Date.now() - t0) / 1000}s  ${res.stats.strokes} 笔`);

const fillPolyEo = globalThis.ISP_PIPELINE._u.fillPoly;
const { W: w, H: h, strokes, clips } = res;

// 非零环绕填充（网页端 canvas 的规则）：自相交的笔形网页端是填满的，
// 管线和这里的模拟如果按偶奇算就会"挖洞"，把本来画上的地方误报成空白点。
function fillPoly(mask, mw, mh, pts) {
  const n = pts.length >> 1;
  if (n < 3) return;
  let ymin = Infinity, ymax = -Infinity;
  for (let i = 0; i < n; i++) {
    const y = pts[i * 2 + 1];
    if (y < ymin) ymin = y; if (y > ymax) ymax = y;
  }
  ymin = Math.max(0, Math.floor(ymin)); ymax = Math.min(mh - 1, Math.ceil(ymax));
  const xs = new Float64Array(n + 1), dr = new Int8Array(n + 1), idx = new Int32Array(n + 1);
  for (let y = ymin; y <= ymax; y++) {
    const yc = y + 0.5;
    let m = 0;
    for (let i = 0; i < n; i++) {
      const x0 = pts[i * 2], yy0 = pts[i * 2 + 1];
      const j = (i + 1) % n;
      const x1 = pts[j * 2], yy1 = pts[j * 2 + 1];
      if ((yy0 <= yc && yy1 > yc) || (yy1 <= yc && yy0 > yc)) {
        xs[m] = x0 + (yc - yy0) / (yy1 - yy0) * (x1 - x0);
        dr[m] = yy1 > yy0 ? 1 : -1;
        m++;
      }
    }
    if (m < 2) continue;
    for (let k = 0; k < m; k++) idx[k] = k;
    const sub = Array.prototype.slice.call(idx.subarray(0, m)).sort((a, b) => xs[a] - xs[b]);
    let wind = 0, startX = 0;
    const row = y * mw;
    for (const k of sub) {
      const prev = wind;
      wind += dr[k];
      if (prev === 0 && wind !== 0) startX = xs[k];
      else if (prev !== 0 && wind === 0) {
        let xa = Math.ceil(startX - 0.5), xb = Math.floor(xs[k] - 0.5);
        if (xb < 0 || xa >= mw) continue;
        if (xa < 0) xa = 0; if (xb >= mw) xb = mw - 1;
        for (let x = xa; x <= xb; x++) mask[row + x] = 1;
      }
    }
  }
}

// 顶点法线外扩（模拟网页端那一记 lineWidth 1.4 的同色描边：笔形实际覆盖 = 填充 ∪ 边界外扩 0.7px）
function offsetOut(pts, n, d) {
  const out = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    const px0 = pts[i * 2], py0 = pts[i * 2 + 1];
    const j = (i + 1) % n, k = (i - 1 + n) % n;
    const ax = pts[j * 2] - px0, ay = pts[j * 2 + 1] - py0;
    const bx = px0 - pts[k * 2], by = py0 - pts[k * 2 + 1];
    const la = Math.hypot(ax, ay) || 1, lb = Math.hypot(bx, by) || 1;
    let mx = -ay / la - by / lb, my = ax / la + bx / lb;
    const lm = Math.hypot(mx, my) || 1;
    out[i * 2] = px0 + mx / lm * d;
    out[i * 2 + 1] = py0 + my / lm * d;
  }
  return out;
}
function areaOf(pts, n) {
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1];
  }
  return Math.abs(a) / 2;
}

// SUB×SUB 个亚像素偏移（像素内 (2k+1)/(2·SUB) 位置）
const OFF = [];
for (let k = 0; k < SUB; k++) OFF.push((2 * k + 1) / (2 * SUB) - 0.5);

const canvas = new Float32Array(w * h * 3).fill(255);
const cov = new Float32Array(w * h);          // 累计不透明度（1 - Π(1-a)）
let lastStroke = new Int32Array(w * h).fill(-1);   // 最后一笔"明显盖上"（a≥0.4）的笔号
const realloc = () => { lastStroke = new Int32Array(w * h).fill(-1); };
const pts = [];                      // 复用的点缓存
const ptsO = [];                     // 描边外扩后的点缓存
const t1 = Date.now();
let area = 0;
for (let si = 0; si < strokes.length; si++) {
  const st = strokes[si];
  const cl = clips[st.c];
  const rib = st.rib;
  const np = rib.length >> 1;
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  for (let i = 0; i < np; i++) {
    const x = rib[i * 2], y = rib[i * 2 + 1];
    if (x < xmin) xmin = x; if (x > xmax) xmax = x;
    if (y < ymin) ymin = y; if (y > ymax) ymax = y;
  }
  xmin = Math.max(cl.x, Math.floor(xmin) - 1); ymin = Math.max(cl.y, Math.floor(ymin) - 1);
  xmax = Math.min(cl.x + cl.w - 1, Math.ceil(xmax) + 1); ymax = Math.min(cl.y + cl.h - 1, Math.ceil(ymax) + 1);
  if (xmax < xmin || ymax < ymin) continue;
  const mw = xmax - xmin + 1, mh = ymax - ymin + 1;
  const acc = new Float32Array(mw * mh);
  // 网页端每一笔都是"先填笔形、再沿笔形描一圈同色细边（1.4px）"，
  // 所以实际覆盖 = 笔形 ∪ 外扩 0.7px。不模拟这一步会把"边缘擦过"误报成白点。
  const ribOff = np >= 3 ? (() => {
    const a1 = offsetOut(rib, np, 0.7), a2 = offsetOut(rib, np, -0.7);
    const o = areaOf(a1, np) >= areaOf(a2, np) ? a1 : a2;   // 面积变大的一侧才是朝外
    const arr = new Float64Array(np * 2);
    for (let i = 0; i < np; i++) { arr[i * 2] = o[i * 2] - xmin; arr[i * 2 + 1] = o[i * 2 + 1] - ymin; }
    return arr;
  })() : null;
  for (let oi = 0; oi < OFF.length; oi++) {
    for (let oj = 0; oj < OFF.length; oj++) {
      const sx = OFF[oi], sy = OFF[oj];
      pts.length = 0;
      for (let i = 0; i < np; i++) { pts.push(rib[i * 2] - xmin + sx, rib[i * 2 + 1] - ymin + sy); }
      const bin = new Uint8Array(mw * mh);
      fillPoly(bin, mw, mh, pts);
      if (ribOff) {                       // 同色描边：把笔形外扩 0.7px 一起算进去
        const off = new Uint8Array(mw * mh);
        ptsO.length = 0;
        for (let i = 0; i < np; i++) ptsO.push(ribOff[i * 2] + sx, ribOff[i * 2 + 1] + sy);
        fillPoly(off, mw, mh, ptsO);
        for (let k = 0; k < acc.length; k++) if (off[k]) bin[k] = 1;
      }
      const wgt = 1 / (OFF.length * OFF.length);
      for (let k = 0; k < acc.length; k++) if (bin[k]) acc[k] += wgt;
    }
  }
  const col = st.color;
  for (let y = 0; y < mh; y++) {
    const rowC = (ymin + y - cl.y) * cl.w, rowP = (ymin + y) * w;
    for (let x = 0; x < mw; x++) {
      const a = acc[y * mw + x];
      if (a <= 0) continue;
      if (!cl.mask[rowC + (xmin + x - cl.x)]) continue;
      const p = rowP + xmin + x;
      canvas[p * 3] = canvas[p * 3] * (1 - a) + col[0] * a;
      canvas[p * 3 + 1] = canvas[p * 3 + 1] * (1 - a) + col[1] * a;
      canvas[p * 3 + 2] = canvas[p * 3 + 2] * (1 - a) + col[2] * a;
      cov[p] = cov[p] + (1 - cov[p]) * a;
      if (a >= 0.4) lastStroke[p] = si;
      area++;
    }
  }
}
console.log(`[aa] 模拟渲染 ${(Date.now() - t1) / 1000}s`);

// 成品口径指标（和网页端一致：抗锯齿硬裁 + 逐笔覆盖）
{
  let sum = 0, bad = 0;
  for (let p = 0; p < w * h; p++) {
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(canvas[p * 3 + k] - px[p * 4 + k]);
      if (d > 8) bad++;
      sum += d;
    }
  }
  console.log(`[aa] 成品口径 平均差 ${(sum / (w * h * 3)).toFixed(2)}/255  可见差异 ${(bad / (w * h * 3) * 100).toFixed(2)}%  笔数 ${strokes.length}`);
}

// 空白点：与网页端同一口径——① 纸面没涂上（三通道 ≥250）而原图不是纯白；② 只有毛边（≥244）而原图明显更深
const isWhite = new Uint8Array(w * h);
let whiteTot = 0;
for (let p = 0; p < w * h; p++) {
  if (canvas[p * 3] >= 250 && canvas[p * 3 + 1] >= 250 && canvas[p * 3 + 2] >= 250) { isWhite[p] = 1; whiteTot++; }
}
const want = [];
for (let p = 0; p < w * h; p++) {
  const cmn = Math.min(canvas[p * 3], canvas[p * 3 + 1], canvas[p * 3 + 2]);
  const tmn = Math.min(px[p * 4], px[p * 4 + 1], px[p * 4 + 2]);
  if ((cmn >= 244 && tmn < 228) || (cmn >= 254 && tmn < 246)) want.push(p);
}
const seen = new Uint8Array(w * h);
const comps = [];
for (const s of want) {
  if (seen[s]) continue;
  const q = [s]; seen[s] = 1; let head = 0; let n = 0;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  while (head < q.length) {
    const p = q[head++]; n++;
    const x = p % w, y = (p - x) / w;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const pp = yy * w + xx;
      const vOk = (() => {
        const cmn = Math.min(canvas[pp * 3], canvas[pp * 3 + 1], canvas[pp * 3 + 2]);
        const tmn = Math.min(px[pp * 4], px[pp * 4 + 1], px[pp * 4 + 2]);
        return (cmn >= 244 && tmn < 228) || (cmn >= 254 && tmn < 246);
      })();
      if (!seen[pp] && vOk) { seen[pp] = 1; q.push(pp); }
    }
  }
  comps.push({ n, x0, y0, x1, y1, p: s });
}
comps.sort((a, b) => b.n - a.n);
const tot = comps.reduce((a, c) => a + c.n, 0);
console.log(`[aa] 空白点 ${tot} 像素 / ${comps.length} 处（占全图 ${(tot / (w * h) * 100).toFixed(3)}%）；最大 ${comps[0] ? comps[0].n : 0}px`);
for (const c of comps.slice(0, 10)) {
  const t = [px[c.p * 4], px[c.p * 4 + 1], px[c.p * 4 + 2]];
  // 看周边：4 邻域有多少是白的（全白=真洞；混着=抗锯齿缝）
  let nb = 0, black = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const x = c.p % w + dx, y = ((c.p - c.p % w) / w) + dy;
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const q = y * w + x;
    if (isWhite[q]) nb++;
    const l = 0.299 * canvas[q * 3] + 0.587 * canvas[q * 3 + 1] + 0.114 * canvas[q * 3 + 2];
    if (l < 120) black++;
  }
  console.log(`  ${c.n}px @ (${c.x0},${c.y0})-(${c.x1},${c.y1})  原图色(${t.join(',')})  8邻域:白${nb}/深色${black}` +
    `  管线画布(${[res.canvasRgb[c.p * 3], res.canvasRgb[c.p * 3 + 1], res.canvasRgb[c.p * 3 + 2]].join(',')})`);
}
const hist = {};
for (const c of comps) { const b = c.n === 1 ? '1' : c.n <= 4 ? '2-4' : c.n <= 16 ? '5-16' : c.n <= 64 ? '17-64' : '65+'; hist[b] = (hist[b] || 0) + 1; }
console.log('  尺寸分布:', JSON.stringify(hist));

// 归因：每个白点是"没笔盖到" / "半透明缝" / "被亮色笔盖错"
{
  const cnt = { none: 0, fringe: 0, wrong: 0 };
  const phHist = {};
  const samples = { none: [], fringe: [], wrong: [] };
  for (const p of want) {
    const st = lastStroke[p] >= 0 ? strokes[lastStroke[p]] : null;
    let cls;
    if (cov[p] < 0.05) cls = 'none';
    else if (cov[p] < 0.9) cls = 'fringe';
    else cls = 'wrong';
    cnt[cls]++;
    if (cls === 'wrong' && st) {
      const key = 'ph' + st.ph + ' rgb' + st.color.join(',');
      phHist[key] = (phHist[key] || 0) + 1;
      if (samples.wrong.length < 6) samples.wrong.push(`${p % w},${(p - p % w) / w} 覆盖笔#${lastStroke[p]} 阶段${st.ph} 色(${st.color.join(',')}) 不透明度${cov[p].toFixed(2)} 原图色(${[px[p * 4], px[p * 4 + 1], px[p * 4 + 2]].join(',')})`);
    }
    if (cls === 'fringe' && samples.fringe.length < 4) samples.fringe.push(`${p % w},${(p - p % w) / w} 不透明度${cov[p].toFixed(2)}`);
    if (cls === 'none' && samples.none.length < 4) samples.none.push(`${p % w},${(p - p % w) / w}`);
  }
  console.log(`[aa] 归因：没笔盖到 ${cnt.none}px、半透明缝 ${cnt.fringe}px、被亮色笔盖错 ${cnt.wrong}px`);
  if (samples.none.length) console.log('   没盖到例：' + samples.none.join(' | '));
  if (samples.fringe.length) console.log('   半透明缝例：' + samples.fringe.join(' | '));
  if (samples.wrong.length) console.log('   盖错例：\n     ' + samples.wrong.join('\n     '));
  const top = Object.entries(phHist).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (top.length) console.log('   盖错笔的分布：' + top.map(([k, v]) => `${k}:${v}`).join('  '));
}

// 阈值敏感度：换个"算不算白"的门槛，看数量怎么变
for (const th of [235, 240, 248, 252]) {
  let n = 0;
  for (let p = 0; p < w * h; p++) {
    if (canvas[p * 3] < th || canvas[p * 3 + 1] < th || canvas[p * 3 + 2] < th) continue;
    const l = 0.299 * px[p * 4] + 0.587 * px[p * 4 + 1] + 0.114 * px[p * 4 + 2];
    if (l < 200) n++;
  }
  console.log(`  门槛 ≥${th}: ${n} 像素`);
}

// 肉眼口径：比原图亮一大截的孤立小点（目标偏暗、结果偏亮、4 连通簇 ≤48px）
{
  const bad = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const pl = 0.299 * canvas[p * 3] + 0.587 * canvas[p * 3 + 1] + 0.114 * canvas[p * 3 + 2];
    const tl = 0.299 * px[p * 4] + 0.587 * px[p * 4 + 1] + 0.114 * px[p * 4 + 2];
    if (tl < 190 && pl - tl > 55) bad[p] = 1;
  }
  const seen2 = new Uint8Array(w * h);
  const dots = [];
  let tot2 = 0;
  for (let s = 0; s < w * h; s++) {
    if (!bad[s] || seen2[s]) continue;
    const q = [s]; seen2[s] = 1; let head = 0; let n = 0;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, sum = 0;
    while (head < q.length) {
      const p = q[head++]; n++;
      const x = p % w, y = (p - x) / w;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      sum += (0.299 * canvas[p * 3] + 0.587 * canvas[p * 3 + 1] + 0.114 * canvas[p * 3 + 2])
           - (0.299 * px[p * 4] + 0.587 * px[p * 4 + 1] + 0.114 * px[p * 4 + 2]);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const pp = yy * w + xx;
        if (!seen2[pp] && bad[pp]) { seen2[pp] = 1; q.push(pp); }
      }
    }
    if (n <= 48) { dots.push({ n, x0, y0, x1, y1, p: s, d: sum / n }); tot2 += n; }
  }
  dots.sort((a, b) => b.n - a.n);
  console.log(`[aa] 亮斑（比原图亮 >55 的孤立小点）${tot2} 像素 / ${dots.length} 处`);
  for (const c of dots.slice(0, 8)) {
    console.log(`  ${c.n}px @ (${c.x0},${c.y0})-(${c.x1},${c.y1})  平均过亮 ${c.d.toFixed(0)}  原图色(${[px[c.p * 4], px[c.p * 4 + 1], px[c.p * 4 + 2]].join(',')})  画成(${[canvas[c.p * 3], canvas[c.p * 3 + 1], canvas[c.p * 3 + 2]].map(Math.round).join(',')})`);
  }
}

// 交叉参考：管线自己的 canvasRgb（无抗锯齿口径）
{
  const c = res.canvasRgb;
  let cnt = 0;
  for (let p = 0; p < w * h; p++) {
    if (c[p * 3] >= 245 && c[p * 3 + 1] >= 245 && c[p * 3 + 2] >= 245) {
      const l = 0.299 * px[p * 4] + 0.587 * px[p * 4 + 1] + 0.114 * px[p * 4 + 2];
      if (l < 200) cnt++;
    }
  }
  console.log(`[aa] 对照：管线硬边口径的空白 ${cnt} 像素`);
}
const outRgb = path.join(here, 'aa-' + path.basename(rawPath).replace(/\.raw$/, '') + '.rgb');
fs.writeFileSync(outRgb, Buffer.from(new Uint8Array(w * h * 3).map((_, i) => Math.max(0, Math.min(255, canvas[i])))));
console.log(`[aa] 写出 ${outRgb}`);
