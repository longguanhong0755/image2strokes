/* 主线程应用：上传 → 提炼（Worker 里跑管线）→ 逐笔回放 */
'use strict';

const MAXSIDE = 1024;
const $ = (id) => document.getElementById(id);

let W = 0, H = 0;                 // 画布尺寸
let STROKES = [], CLIPS = [], STATS = null;
let target = null;                // 目标图 ImageData（用于对比）
let painted = null, mt = null;    // 已完成的画（离屏）、主画布上下文
let tmpC = null, tmp = null;      // 单笔合成用的临时画布
let idx = 0, acc = 0, playing = false, done = false, lastT = performance.now();
let speed = 2, cursor = null, guide = null, showTip = true, showGuide = true;
let clipCache = new Map(), lastClip = -1;
let worker = null;
let cumMs = null;              // 每笔结束时的累计时间（含抬笔移动与停顿）
let keys = [];                 // 关键帧快照 {i, data} 或 {i, rgb}（管线侧光栅）
let keyEvery = 0;
let KEYFRAMES = [];
let selfChecking = false;         // 成品自检（找白点）进行中：期间 hud 不覆盖状态行
let rushing = false;              // "看成品"：快进到画完（每帧画一大批，画面看得见在飞速推进）
let draggingSeek = false;         // 正在拖进度条：这期间 hud 不要回写滑块位置
let checkMsg = '';                // 自检结论（挂在状态行末尾，一直都在）
// "像人在画"需要的三段时间轴：抬笔移动 travel + 换阶段停顿 beat + 落笔绘制 paint
let travels = null, beats = null, msPaint = null;
let targetMs = 240000;
let airPath = null;             // 抬笔移动的弧线（画在纸面上的淡虚线）
const lastEnd = [0, 0];         // 上一笔收笔的位置（抬笔弧线的起点）
const PHASES = ['铺底色', '铺色', '题字', '点睛'];

// ---------------- 工具 ----------------
const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));
function hash01(a, b) {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return x - Math.floor(x);
}
function ribbonPath(st) {
  const p = new Path2D();
  const r = st.rib;
  p.moveTo(r[0], r[1]);
  for (let i = 2; i < r.length; i += 2) p.lineTo(r[i], r[i + 1]);
  p.closePath();
  return p;
}
function tipAt(st, u) {
  const tp = st.tp, n = tp.length / 2;
  if (n < 2) return { x: tp[0], y: tp[1], dx: 1, dy: 0, single: true };
  let total = 0;
  for (let i = 1; i < n; i++) total += Math.hypot(tp[i * 2] - tp[(i - 1) * 2], tp[i * 2 + 1] - tp[(i - 1) * 2 + 1]);
  const want = clamp(u, 0, 1) * total;
  let run = 0;
  for (let i = 1; i < n; i++) {
    const ax = tp[(i - 1) * 2], ay = tp[(i - 1) * 2 + 1];
    const bx = tp[i * 2], by = tp[i * 2 + 1];
    const seg = Math.hypot(bx - ax, by - ay);
    if (run + seg >= want || i === n - 1) {
      const f = seg > 1e-6 ? (want - run) / seg : 1;
      const x = ax + (bx - ax) * f, y = ay + (by - ay) * f;
      const dx = bx - ax, dy = by - ay, ln = Math.hypot(dx, dy) || 1;
      return { x, y, dx: dx / ln, dy: dy / ln, single: false };
    }
    run += seg;
  }
  return { x: tp[0], y: tp[1], dx: 1, dy: 0, single: false };
}

// ---------------- 上传与提炼 ----------------
function fitImage(img) {
  let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  const s = Math.min(1, MAXSIDE / Math.max(w, h));
  w = Math.max(8, Math.round(w * s)); h = Math.max(8, Math.round(h * s));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, w, h);
  x.drawImage(img, 0, 0, w, h);
  return c;
}

function startExtract(imgCanvas) {
  W = imgCanvas.width; H = imgCanvas.height;
  const ctx2 = imgCanvas.getContext('2d');
  target = ctx2.getImageData(0, 0, W, H);
  $('stage').style.display = 'block';
  $('canvasWrap').style.display = 'none';
  $('welcome').style.display = 'none';
  $('status').textContent = '正在提炼…';
  $('bar').style.width = '0%';
  const detail = parseInt($('detail').value, 10);
  const opts = {
    colors: parseInt($('colors').value, 10) || 0,     // 0 = 自动（按纹理强度定）
    style: $('style').value,
    detail,
    targetSec: detail === 0 ? 120 : (detail === 2 ? 480 : 240),
  };
  targetMs = opts.targetSec * 1000;
  if (!worker) {
    worker = new Worker('js/worker.js?v=9');
    worker.onmessage = onWorker;
    worker.onerror = (e) => { $('status').textContent = '出错：' + e.message; };
  }
  const copy = new Uint8ClampedArray(target.data);   // 原数据留着做对比
  worker.postMessage({ px: copy.buffer, W, H, opts }, [copy.buffer]);
}

function onWorker(e) {
  const d = e.data;
  if (d.type === 'progress') {
    $('bar').style.width = (d.p * 100).toFixed(0) + '%';
    if (d.msg) $('status').textContent = d.msg;
    return;
  }
  if (d.type === 'error') { $('status').textContent = '出错：' + d.msg; return; }
  STROKES = d.res.strokes; CLIPS = d.res.clips; STATS = d.res.stats;
  KEYFRAMES = (d.res.keys || []).map((k) => ({ i: k.i, rgb: k.rgb }));
  buildCanvases();
  resetPlayback();
  checkMsg = '';
  $('stage').style.display = 'none';
  $('canvasWrap').style.display = 'block';
  $('stat').innerHTML = '共 <em>' + STATS.strokes + '</em> 笔 · 约 <em>' +
    Math.round(STATS.totalMs / 1000) + '</em> 秒画完（1×）· 铺底色 → 铺色 → 题字 → 点睛' +
    (STATS.photo ? ' · 已按照片自动用 <em>' + STATS.colors + '</em> 色' : (STATS.colors ? ' · ' + STATS.colors + ' 色' : ''));
  for (const id of ['expVideo', 'expJson', 'expPng']) { const b = $(id); if (b) b.disabled = false; }
  $('expMsg').textContent = '';
  // 开播；白点自检在后台画布上推进，补笔备好后追加到时间轴末尾（不挡着画画）
  playing = true;
  $('play').textContent = '暂停';
  startSelfCheck($('stat').innerHTML);
}

// ---------------- 画布 ----------------
function buildCanvases() {
  const main = $('cv');
  main.width = W; main.height = H;
  mt = main.getContext('2d');
  painted = document.createElement('canvas');
  painted.width = W; painted.height = H;
  painted.getContext('2d').fillStyle = '#ffffff';
  painted.getContext('2d').fillRect(0, 0, W, H);
  tmpC = document.createElement('canvas');
  tmpC.width = W; tmpC.height = H;
  tmp = tmpC.getContext('2d');
  clipCache = new Map(); lastClip = -1;
  buildTimeline();
  keyEvery = Math.max(300, Math.ceil(STROKES.length / 8));
  keys = [];
  fitView();
}

// 时间轴：每笔 = 抬笔移动(短) + 换阶段停顿(偶尔) + 落笔绘制；总时长仍然锁在 4 分钟
function buildTimeline() {
  const n = STROKES.length;
  travels = new Float64Array(n);
  beats = new Float64Array(n);
  msPaint = new Float64Array(n);
  const ends = new Float64Array(n * 2);
  let ex = 0, ey = 0, raw = 0, prevPh = -1;
  for (let i = 0; i < n; i++) {
    const st = STROKES[i];
    const tp = st.tp;
    if (i > 0) {
      const d = Math.hypot(tp[0] - ex, tp[1] - ey);
      // 手就在旁边就顺势接着画（不占时间）；隔得远才抬笔"飞"过去
      travels[i] = d < 40 ? 0 : Math.min(200, 30 + (d - 40) * 0.35);
    }
    const ph = st.ph === undefined ? 1 : st.ph;
    if (prevPh >= 0 && ph !== prevPh) beats[i] = ph === 3 ? 700 : 420;   // 换阶段前停一下，像在回看
    prevPh = ph;
    ex = tp[tp.length - 2]; ey = tp[tp.length - 1];
    ends[i * 2] = ex; ends[i * 2 + 1] = ey;
    raw += st.ms;
  }
  // 抬笔移动的总量封顶：细碎补笔动辄几千次"飞过去"，不封顶会把 4 分钟撑到七八分钟
  const cap = targetMs * 0.2;
  let sumT = 0;
  for (let i = 0; i < n; i++) sumT += travels[i];
  if (sumT > cap) { const sc = cap / sumT; for (let i = 0; i < n; i++) travels[i] *= sc; }
  let nonPaint = 0;
  for (let i = 0; i < n; i++) nonPaint += travels[i] + beats[i];
  const budget = Math.max(n * 3, targetMs - nonPaint);
  const k = raw > 0 ? budget / raw : 1;
  cumMs = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    msPaint[i] = Math.max(3, STROKES[i].ms * k);
    cumMs[i + 1] = cumMs[i] + travels[i] + beats[i] + msPaint[i];
  }
  if (STATS && n) STATS.totalMs = cumMs[n];
  if (n) { lastEnd[0] = STROKES[0].tp[0]; lastEnd[1] = STROKES[0].tp[1]; }
}

function fitView() {
  const wrap = $('canvasWrap');
  const maxW = wrap.clientWidth - 8, maxH = window.innerHeight - 190;
  const s = Math.min(maxW / W, maxH / H, 1);
  const cv = $('cv');
  cv.style.width = Math.round(W * s) + 'px';
  cv.style.height = Math.round(H * s) + 'px';
}
window.addEventListener('resize', fitView);

function clipCanvasFor(c) {
  if (clipCache.has(c)) return clipCache.get(c);
  const cl = CLIPS[c];
  const cv = document.createElement('canvas');
  cv.width = cl.w; cv.height = cl.h;
  const x = cv.getContext('2d');
  const id = x.createImageData(cl.w, cl.h);
  const m = cl.mask;
  for (let i = 0; i < m.length; i++) {
    id.data[i * 4] = 255; id.data[i * 4 + 1] = 255; id.data[i * 4 + 2] = 255;
    id.data[i * 4 + 3] = m[i] ? 255 : 0;
  }
  x.putImageData(id, 0, 0);
  if (clipCache.size > 40) {                       // 简单的容量控制
    const first = clipCache.keys().next().value;
    clipCache.delete(first);
  }
  clipCache.set(c, cv);
  return cv;
}

// 画一笔（u=1 为整笔）。u<1 时只把"半成品"放进临时画布，不落到成品
let pending = -1, pendRect = null;
function paintStroke(i, u, dest) {
  const st = STROKES[i];
  const cl = CLIPS[st.c];
  const t = tipAt(st, u);
  cursor = { x: t.x, y: t.y, r: Math.max(2.5, st.w * 0.5), pen: st.pen, color: st.color };
  guide = st.tp;
  const rgb = 'rgb(' + st.color[0] + ',' + st.color[1] + ',' + st.color[2] + ')';
  const rect = { x: cl.x, y: cl.y, w: cl.w, h: cl.h };
  tmp.setTransform(1, 0, 0, 1, 0, 0);
  tmp.clearRect(rect.x, rect.y, rect.w, rect.h);
  tmp.save();
  tmp.fillStyle = rgb;
  tmp.strokeStyle = rgb;
  if (u >= 1) {
    // 整笔：先填笔形，再沿笔形描一圈同色细边（约 0.7px）。
    // 这样抗锯齿产生的"半透明毛边"变成实心，两个色块相接处不会露出 1px 白缝
    // ——白点的根源之一就是这个（详见 README 的坑）。
    const pth = ribbonPath(st);
    tmp.lineWidth = 1.4;
    tmp.lineJoin = 'round';
    tmp.lineCap = 'round';
    tmp.fill(pth);
    tmp.stroke(pth);
  } else {
    tmp.clip(ribbonPath(st));                       // 半成品：笔形 ∩ 已扫过的部分
    tmp.clip(leadPath(t, st));
    tmp.fillRect(rect.x, rect.y, rect.w, rect.h);
    tmp.restore();
    tmp.save();                                     // 笔尖前方的湿边（半透明）
    tmp.clip(ribbonPath(st));
    const nx = -t.dy, ny = t.dx, spread = Math.max(4, st.w * 1.3);
    const fwd = st.pen ? 0 : Math.max(2, st.w * 0.9);
    const wet = new Path2D();
    wet.moveTo(t.x + nx * spread, t.y + ny * spread);
    wet.lineTo(t.x + t.dx * fwd + nx * spread, t.y + t.dy * fwd + ny * spread);
    wet.lineTo(t.x + t.dx * fwd - nx * spread, t.y + t.dy * fwd - ny * spread);
    wet.lineTo(t.x - nx * spread, t.y - ny * spread);
    wet.closePath();
    tmp.fillStyle = rgb;
    tmp.globalAlpha = 0.42;
    tmp.fill(wet);
  }
  tmp.restore();
  tmp.globalCompositeOperation = 'destination-in';  // 用遮罩裁形
  tmp.drawImage(clipCanvasFor(st.c), rect.x, rect.y);
  tmp.globalCompositeOperation = 'source-over';
  const ctx = (dest || painted).getContext('2d');
  ctx.drawImage(tmpC, rect.x, rect.y, rect.w, rect.h, rect.x, rect.y, rect.w, rect.h);
  if (u >= 1) {
    pending = -1; pendRect = null;
    lastEnd[0] = t.x; lastEnd[1] = t.y;      // 记下收笔位置，下一笔的抬笔弧线从这里起
    return true;
  }
  pending = i; pendRect = rect;
  return false;
}

// 抬笔移动：笔尖离开纸面，沿一条浅弧线飞到下一笔的起笔处（不落色，只留下淡淡的虚线）
function travelTo(i, f) {
  const st = STROKES[i];
  const tp = st.tp;
  const ox = lastEnd[0], oy = lastEnd[1];
  const dx = tp[0] - ox, dy = tp[1] - oy;
  const d = Math.hypot(dx, dy) || 1;
  const bow = Math.min(46, d * 0.22);
  const mx = (ox + tp[0]) / 2 - dy / d * bow;
  const my = (oy + tp[1]) / 2 + dx / d * bow;
  const e = f * f * (3 - 2 * f);                     // 起步慢、中间快、落下轻
  cursor = {
    x: (1 - e) * (1 - e) * ox + 2 * (1 - e) * e * mx + e * e * tp[0],
    y: (1 - e) * (1 - e) * oy + 2 * (1 - e) * e * my + e * e * tp[1],
    r: Math.max(2, st.w * 0.5), pen: st.pen, color: st.color, air: true,
  };
  airPath = [ox, oy, mx, my, tp[0], tp[1]];
  guide = null;
}
function endTravel() { airPath = null; }

// 笔尖前沿：以笔尖为中心、往后拉一块"已扫过"的多边形
function leadPath(t, st) {
  const behind = st.pen ? 0 : Math.max(2, st.w * 0.45);
  const spread = Math.max(4, st.w * 1.3);
  const seed = st.ms * 7 + st.tp.length;
  const p = new Path2D();
  const nx = -t.dy, ny = t.dx;
  const back = 4000;
  p.moveTo(t.x - t.dx * back + nx * spread, t.y - t.dy * back + ny * spread);
  for (let k = 1; k <= 12; k++) {                     // 锯齿状前沿
    const f = k / 12;
    const j = (hash01(seed, k) - 0.5) * spread * 0.55;
    const along = -behind * f;
    p.lineTo(t.x + t.dx * along + nx * (spread + j), t.y + t.dy * along + ny * (spread + j));
  }
  for (let k = 12; k >= 1; k--) {
    const f = k / 12;
    const j = (hash01(seed + 3, k) - 0.5) * spread * 0.55;
    const along = -behind * f;
    p.lineTo(t.x + t.dx * along - nx * (spread + j), t.y + t.dy * along - ny * (spread + j));
  }
  p.closePath();
  return p;
}

// ---------------- 播放循环 ----------------
function flushMain() {
  if (!mt || !painted) return;              // 还没选图、画布尚未建立
  mt.setTransform(1, 0, 0, 1, 0, 0);
  mt.fillStyle = '#ffffff';
  mt.fillRect(0, 0, W, H);
  if ($('cmp').checked && target) {
    mt.putImageData(target, 0, 0);
    return;
  }
  mt.drawImage(painted, 0, 0);
  if (pending >= 0 && !done && pendRect) {               // 半成品浮在成品之上
    mt.drawImage(tmpC, pendRect.x, pendRect.y, pendRect.w, pendRect.h,
                 pendRect.x, pendRect.y, pendRect.w, pendRect.h);
  }
  if (cursor && showTip && !done) drawCursor(mt, cursor);
  if (guide && showGuide && !done) drawGuide(mt, guide, cursor);
  if (airPath && showGuide && !done) drawAir(mt, airPath);   // 抬笔移动的浅弧线
}

function drawAir(ctx, p) {
  ctx.save();
  ctx.setLineDash([5, 7]);
  ctx.strokeStyle = 'rgba(70,70,82,0.22)';
  ctx.lineWidth = Math.max(1, W / 1024) * 1.2;
  ctx.beginPath();
  ctx.moveTo(p[0], p[1]);
  ctx.quadraticCurveTo(p[2], p[3], p[4], p[5]);
  ctx.stroke();
  ctx.restore();
}

function drawCursor(ctx, c) {
  ctx.save();
  ctx.translate(c.x, c.y);
  if (c.air) {                                  // 抬笔：空心小圈 + 一点芯，看得出笔离开了纸面
    ctx.strokeStyle = 'rgba(45,45,54,0.55)';
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(0, 0, Math.max(2.8, c.r * 0.85), 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(45,45,54,0.45)';
    ctx.beginPath(); ctx.arc(0, 0, Math.max(1.1, c.r * 0.26), 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    return;
  }
  if (c.pen) {
    ctx.fillStyle = 'rgba(30,30,36,0.92)';
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(2.2, c.r * 0.5), 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.strokeStyle = 'rgba(40,40,48,0.75)';
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(0, 0, c.r * 1.15, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(' + c.color[0] + ',' + c.color[1] + ',' + c.color[2] + ',0.85)';
    ctx.beginPath(); ctx.arc(0, 0, Math.max(2, c.r * 0.55), 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function drawGuide(ctx, tp, c) {
  if (!c) return;
  ctx.save();
  ctx.setLineDash([6, 6]);
  ctx.strokeStyle = 'rgba(60,60,70,0.32)';
  ctx.lineWidth = Math.max(1, W / 1024);
  ctx.beginPath();
  ctx.moveTo(tp[0], tp[1]);
  for (let i = 2; i < tp.length; i += 2) ctx.lineTo(tp[i], tp[i + 1]);
  ctx.stroke();
  ctx.restore();
}

let lastTickAt = 0;
function tick() {
  const now = performance.now();
  const gap = now - lastTickAt;          // 距上一帧多久（被节流时会是秒/分钟级）
  lastTickAt = now;
  const dt = Math.min(100, now - lastT); lastT = now;
  if (rushing && !done) {                    // 快进到成品：每帧画 2500 笔
    let n = 0;
    while (idx < STROKES.length && n++ < 2500) { paintStroke(idx, 1); idx++; }
    if (idx >= STROKES.length) { rushing = false; finish(); }
  } else if (playing && !done) {
    acc += dt * speed;
    let guard = 0;
    while (idx < STROKES.length && guard++ < 400) {
      const tot = travels[idx] + beats[idx] + msPaint[idx];
      if (acc < tot) break;
      acc -= tot;
      paintStroke(idx, 1);
      idx++;
      if (keyEvery && idx % keyEvery === 0 && idx < STROKES.length) snapshotKey(idx);
      if (idx >= STROKES.length) { finish(); break; }
    }
    if (idx < STROKES.length && !done) {
      const tv = travels[idx] + beats[idx];
      if (acc < tv) travelTo(idx, acc / Math.max(1, tv));        // 还在抬笔移动
      else { endTravel(); paintStroke(idx, clamp((acc - tv) / msPaint[idx], 0, 1)); }
    }
  }
  if (checkState) stepSelfCheck(gap);       // 成品自检：按帧分片推进（帧慢就多干点）
  flushMain();
  hud();
  schedule();
}

// 页面在后台时 rAF 不触发：退回定时器，保证"离开标签页也会继续画"
function schedule() {
  if (document.hidden) setTimeout(tick, 100);
  else requestAnimationFrame(tick);
}
// 看门狗：窗口未聚焦时 rAF 可能被节流甚至暂停，这里保证动画继续推进
setInterval(function () {
  if (performance.now() - lastTickAt > 50) tick();
}, 50);

function restoreKey(k, ctx) {
  if (k.data) { ctx.putImageData(k.data, 0, 0); return; }
  const W2 = W, H2 = H;
  if (!restoreKey.buf || restoreKey.buf.width !== W2 || restoreKey.buf.height !== H2) {
    restoreKey.buf = ctx.createImageData(W2, H2);
    const dd = restoreKey.buf.data;
    for (let i = 3; i < dd.length; i += 4) dd[i] = 255;
  }
  const img = restoreKey.buf, dd = img.data, rgb = k.rgb;
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    dd[j] = rgb[i]; dd[j + 1] = rgb[i + 1]; dd[j + 2] = rgb[i + 2];
  }
  ctx.putImageData(img, 0, 0);
}

function allKeys() { return KEYFRAMES.concat(keys).sort((a, b) => a.i - b.i); }

function snapshotKey(i) {
  try {
    keys.push({ i, data: painted.getContext('2d').getImageData(0, 0, W, H) });
  } catch (e) { /* 忽略：内存不足就放弃关键帧 */ }
}

function hud() {
  if (!STATS || selfChecking) return;
  const n = STROKES.length;
  const st = n ? STROKES[Math.min(idx, n - 1)] : null;
  const cur = done ? STATS.totalMs : (cumMs[idx] + acc);
  const p = STATS.totalMs > 0 ? cur / STATS.totalMs : 0;
  $('fill').style.width = (p * 100).toFixed(2) + '%';
  $('clock').textContent = fmt(cur / 1000) + ' / ' + fmt(STATS.totalMs / 1000);
  const sk = $('seek');
  if (sk && !draggingSeek) sk.value = String(Math.round(p * 1000));   // 进度条跟着跑（拖动时别抢）
  const ph = done ? 4 : (st && st.ph !== undefined ? st.ph : 1);
  setPhase(ph);
  if (!done) {
    $('stat').innerHTML = '阶段 <em>' + (PHASES[ph] || '') + '</em> · 第 <em>' +
      Math.min(idx + 1, n) + '</em> / ' + n + ' 笔 · ' + (p * 100).toFixed(0) + '%' + checkMsg;
  }
}

function setPhase(ph) {
  const el = $('phases');
  if (!el) return;
  for (let i = 0; i < el.children.length; i++) {
    el.children[i].className = i === ph ? 'on' : (i < ph ? 'done' : '');
  }
}

function fmt(s) {
  s = Math.max(0, Math.round(s));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function resetPlayback() {
  idx = 0; acc = 0; done = false; rushing = false; cursor = null; guide = null; airPath = null;
  pending = -1; pendRect = null;
  const ctx = painted.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
  keys = [];
  if (STROKES.length) { lastEnd[0] = STROKES[0].tp[0]; lastEnd[1] = STROKES[0].tp[1]; }
  playing = true;
  $('play').textContent = '暂停';
  $('stat').textContent = '准备开始…';
}

function jumpTo(sec) {
  const tgt = sec * 1000;
  const cur = done ? cumMs[STROKES.length] : (cumMs[idx] + acc);
  // 向前小步：直接在当前画面上续画，不用重来
  if (tgt >= cur - 50 && tgt - cur < 45000 && !done) {
    advanceTo(tgt);
    return;
  }
  const ctx = painted.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  let ci = 0;
  while (ci < STROKES.length && cumMs[ci + 1] <= tgt) ci++;
  let k = null;
  for (const kk of allKeys()) { if (kk.i <= ci) k = kk; else break; }
  if (k) restoreKey(k, ctx);
  else { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H); }
  done = false;
  idx = k ? k.i : 0;
  acc = 0;
  airPath = null;
  if (STROKES.length) {
    const pi = Math.max(0, Math.min(idx - 1, STROKES.length - 1));
    const tp = STROKES[pi].tp;
    lastEnd[0] = tp[tp.length - 2]; lastEnd[1] = tp[tp.length - 1];
  }
  advanceTo(tgt);
}

function advanceTo(tgt) {
  while (idx < STROKES.length && cumMs[idx + 1] <= tgt) {
    paintStroke(idx, 1);
    idx++;
    if (keyEvery && idx % keyEvery === 0 && idx < STROKES.length) snapshotKey(idx);
  }
  if (idx >= STROKES.length) { finish(); return; }
  acc = Math.max(0, tgt - cumMs[idx]);
  const tv = travels[idx] + beats[idx];
  if (acc < tv) {
    travelTo(idx, acc / Math.max(1, tv));
  } else {
    endTravel();
    paintStroke(idx, clamp((acc - tv) / msPaint[idx], 0, 1));
  }
}

// ---------------- 成品自检：空白点归零 ----------------
// 管线是拿它自己的光栅模型判"白点"的；网页端是浏览器的抗锯齿多边形 + 1 位硬遮罩裁剪，
// 两者在笔形边缘上会有细微出入。所以成品出来之后，在**真实画布**上再查一遍：
// 该有颜色却还是白的像素，按连通块补一个"方点笔"（严格掩膜，只盖这几个像素），迭代到 0。
// "算白"的两个门槛必须满足：原图门槛 ≤ 画布门槛。
// 这样"把目标色画上去"一定能消掉白点（否则会出现补了还是白点的死循环）；
// 同时画布门槛取得严一点（244），浅色区块不会被误判成白点而乱补。
// "没涂上色"的两个口径（都必须满足"原图门槛 ≤ 画布门槛"，否则补上目标色后仍算白点、消不掉）：
//   ① 纸面根本没被涂上（WHITE_PAPER = 纯白）：只要原图明显不是白就补——保证"全满的图"成品上没有空白处；
//   ② 只被抗锯齿毛边蹭到 / 被浅色笔盖错（WHITE_CANVAS + 原图明显更深）。
const WHITE_PAPER = 254;
const WHITE_CANVAS = 244;
const WHITE_TARGET = 228;
const isWhite = (r, g, b, t) => r >= t && g >= t && b >= t;
function whiteDots(dest) {
  let im;
  try { im = (dest || painted).getContext('2d').getImageData(0, 0, W, H).data; }
  catch (e) { return []; }
  const tgt = target.data;
  const m = new Uint8Array(W * H);
  let any = 0;
  for (let p = 0; p < W * H; p++) {
    const q = p * 4;
    const cmn = Math.min(im[q], im[q + 1], im[q + 2]);
    const tmn = Math.min(tgt[q], tgt[q + 1], tgt[q + 2]);
    if (!((cmn >= WHITE_CANVAS && tmn < WHITE_TARGET) ||
          (cmn >= WHITE_PAPER && tmn < WHITE_PAPER - 8))) continue;
    m[p] = 1; any++;
  }
  const out = [];
  if (!any) return out;
  const seen = new Uint8Array(W * H);
  const q = new Int32Array(any);
  for (let s = 0; s < W * H; s++) {
    if (!m[s] || seen[s]) continue;
    let head = 0, tail = 0, cnt = 0;
    q[tail++] = s; seen[s] = 1;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    while (head < tail) {
      const p = q[head++]; cnt++;
      const x = p % W, y = (p - x) / W;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const pp = yy * W + xx;
          if (!seen[pp] && m[pp]) { seen[pp] = 1; q[tail++] = pp; }
        }
      }
    }
    out.push({ x0, y0, x1, y1, n: cnt, pix: Array.prototype.slice.call(q.subarray(0, cnt)) });
  }
  out.sort((a, b) => b.n - a.n);
  return out;
}

// 每个白点补一个"方点笔"：掩膜严格等于这一块，笔形外扩 1px（保证像素中心一定落在笔形里），
// 颜色取目标图这一块的平均色。方框只被掩膜裁到那几个像素上，周围正确的像素不受影响。
function addDotStroke(cl, grow, dest) {
  const tgt = target.data;
  const g = grow || 0;                       // 顽固白点：一轮没补掉就把掩膜和笔形再外扩一圈
  const x0 = Math.max(0, cl.x0 - g), y0 = Math.max(0, cl.y0 - g);
  const x1 = Math.min(W - 1, cl.x1 + g), y1 = Math.min(H - 1, cl.y1 + g);
  const w0 = x1 - x0 + 1, h0 = y1 - y0 + 1;
  const mask = new Uint8Array(w0 * h0);
  let cr = 0, cg = 0, cb = 0, cnt = 0;
  for (const p of cl.pix) {
    const x = p % W, y = (p - x) / W;
    if (x < x0 || y < y0 || x > x1 || y > y1) continue;
    mask[(y - y0) * w0 + (x - x0)] = 1;
    cr += tgt[p * 4]; cg += tgt[p * 4 + 1]; cb += tgt[p * 4 + 2]; cnt++;
  }
  if (g) {                                   // 外扩的那些像素也纳入掩膜，颜色一起取
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const k = (y - y0) * w0 + (x - x0);
        if (mask[k]) continue;
        const q = (y * W + x) * 4;
        if (Math.min(tgt[q], tgt[q + 1], tgt[q + 2]) >= WHITE_PAPER) continue;   // 原图纯白的地方不收
        mask[k] = 1;
        cr += tgt[q]; cg += tgt[q + 1]; cb += tgt[q + 2]; cnt++;
      }
    }
  }
  CLIPS.push({ x: x0, y: y0, w: w0, h: h0, mask });
  const gx0 = x0 - 1, gy0 = y0 - 1, gx1 = x1 + 2, gy1 = y1 + 2;
  const my = (gy0 + gy1) / 2;
  STROKES.push({
    rib: [gx0, gy0, gx1, gy0, gx1, gy1, gx0, gy1],
    tp: [gx0, my, gx1, my],
    w: Math.max(3, h0 + 2),
    color: [Math.round(cr / cnt), Math.round(cg / cnt), Math.round(cb / cnt)],
    pen: 0, c: CLIPS.length - 1, r: -1, ph: 3, ms: 260,
  });
  paintStroke(STROKES.length - 1, 1, dest);
}

// 成品自检：扫"该有色却是白的"像素并补笔，扫到 0 才收手。
// 三条约束：
//   1) 不能挡住开播——用户在等的是"开始画"，所以自检在回放跑完之后再做；
//   2) 不能依赖 setTimeout/await 链——标签页被节流时那种链会长时间不回来，页面看着像死了；
//      改由主循环 tick() 分片推进（rAF 和 50ms 看门狗双驱动，播放能跑它就一定能跑）；
//   3) 不能跟回放抢主线程——早先的写法是在离屏画布上把整幅重画一遍（两万笔 ≈ 26 秒纯 CPU），
//      把 240 秒的回放拖成好几分钟；现在等回放画完，直接扫它画出来的那张成品，一笔都不用重画。
let selfCheckGen = 0;
let checkState = null;            // { gen, phase, round, added, left, head, cv, from }
function startSelfCheck(head) {
  // 自检要的是"成品画布"，而回放本身就在把成品一笔一笔堆出来 —— 所以先等着，别抢主线程。
  // 老做法是在离屏画布上把整幅**重画一遍**（两万笔 ≈ 26 秒纯 CPU），跟回放抢主线程，
  // 结果 240 秒的回放被拖成好几分钟；回放画完时 painted 就是成品，直接扫它，一笔都不用重画。
  checkState = { gen: ++selfCheckGen, phase: 0, i: 0, round: 0, added: 0, left: 0, head: head || '', cv: null, from: STROKES.length };
  return checkState;
}
function stepSelfCheck(gap) {
  const cs = checkState;
  if (!cs) { selfChecking = false; return; }
  if (cs.gen !== selfCheckGen) { checkState = null; selfChecking = false; return; }
  if (cs.phase === 0) {                                     // 等回放把成品画完
    if (!done) return;
    cs.head = $('stat').innerHTML;                          // 这时状态行里已经有成品读数了
    cs.cv = painted;                                        // 回放画出来的就是成品，直接扫它
    cs.phase = 2;
    cs.from = STROKES.length;
    selfChecking = true;
    $('stat').innerHTML = (cs.head || '') + ' · 白点自检中…';
    return;
  }
  const dots = whiteDots(cs.cv);
  cs.left = dots.length;
  if (!cs.left || cs.round >= 8) { finishSelfCheck(); return; }    // 扫到 0 个才收手
  const grow = cs.round >= 2 ? Math.min(2, cs.round - 1) : 0;      // 三轮还没清掉的：掩膜外扩再补
  for (const cl of dots) { addDotStroke(cl, grow, cs.cv); cs.added++; }
  cs.round++;
}
function finishSelfCheck() {
  const cs = checkState;
  if (!cs) return;
  checkState = null; selfChecking = false;
  checkMsg = ' · 白点自检 <em>' + (cs.left === 0 ? '0 个' : cs.left + ' 个残留') + '</em>' +
    (cs.added ? '（补 ' + cs.added + ' 笔）' : '');
  if (cs.added) {
    buildTimeline();                 // 补笔已追加在最后：重建时间轴，它们会在收尾阶段被画上
    if (done || idx >= STROKES.length) {   // 万一已经画完了：直接补到成品上
      for (let i = cs.from; i < STROKES.length; i++) paintStroke(i, 1);
      idx = STROKES.length; done = true;
    }
  }
  $('stat').innerHTML = (cs.head || $('stat').innerHTML) + checkMsg;
}

// ---------------- 收尾与差异 ----------------
function diffVsTarget() {
  const a = painted.getContext('2d').getImageData(0, 0, W, H).data;
  const b = target.data;
  let sum = 0, bad = 0;
  const tot = W * H * 3;
  for (let i = 0; i < a.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(a[i + k] - b[i + k]);
      if (d > 8) bad++;
      sum += d;
    }
  }
  // 整体差异：缩到 1/4 再看一次（忽略逐像素的颗粒/锯齿，更接近肉眼判断）
  const s = 4, w2 = Math.max(1, Math.round(W / s)), h2 = Math.max(1, Math.round(H / s));
  const c1 = document.createElement('canvas'); c1.width = w2; c1.height = h2;
  const c2 = document.createElement('canvas'); c2.width = w2; c2.height = h2;
  const x1 = c1.getContext('2d'), x2 = c2.getContext('2d');
  const tc = document.createElement('canvas'); tc.width = W; tc.height = H;
  tc.getContext('2d').putImageData(target, 0, 0);
  x1.drawImage(painted, 0, 0, w2, h2);
  x2.drawImage(tc, 0, 0, w2, h2);
  const d1 = x1.getImageData(0, 0, w2, h2).data, d2 = x2.getImageData(0, 0, w2, h2).data;
  let s2 = 0, b2 = 0;
  const t2 = w2 * h2 * 3;
  for (let i = 0; i < d1.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(d1[i + k] - d2[i + k]);
      if (d > 8) b2++;
      s2 += d;
    }
  }
  return { mean: sum / tot, badPct: bad / tot * 100, mean4: s2 / t2, bad4: b2 / t2 * 100 };
}

function finish() {
  done = true; playing = false; rushing = false; cursor = null; guide = null; airPath = null;
  $('play').textContent = '重播';
  setPhase(4);
  const d = diffVsTarget();
  const dots = whiteDots().reduce((a, c) => a + c.n, 0);
  $('stat').innerHTML = '画完了 · <em>' + STROKES.length + '</em> 笔 · 整体差异（1/4 缩放）平均 <em>' +
    d.mean4.toFixed(2) + '/255</em>、可见差异 <em>' + d.bad4.toFixed(2) + '%</em>' +
    ' · 逐像素细节差异平均 ' + d.mean.toFixed(2) + '、可见 ' + d.badPct.toFixed(2) + '%' +
    ' · 空白点 <em>' + dots + '</em> 个';
}

// ---------------- 导出 ----------------
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

// 成品图
function exportPng() {
  if (!STROKES.length) return;
  painted.toBlob((b) => {
    download(b, 'image2strokes-' + stamp() + '.png');
    $('expMsg').textContent = '成品图已导出（' + W + '×' + H + '）';
  }, 'image/png');
}

// 视频：把整段过程在 ~24 秒里重画一遍，用 MediaRecorder 录成 WebM。
// 推进由"真实时间"驱动（而不是靠每帧增量），所以即使标签页被节流
//（rAF 不触发、定时器降到 1Hz），成片的长度和进度也还是对的。
async function exportVideo() {
  if (!STROKES.length) return;
  const cv = $('cv');
  if (typeof MediaRecorder === 'undefined' || !cv.captureStream) {
    $('expMsg').textContent = '这个浏览器不支持录制，换 Chrome / Edge 试试';
    return;
  }
  const btn = $('expVideo'), oldTxt = btn.textContent;
  btn.disabled = true; btn.textContent = '录制中…';
  $('expMsg').textContent = '正在快放录制（画面会自动重画一遍）…';
  const OUT_SEC = 24;
  const oldTip = showTip, oldGuide = showGuide, wasPlaying = playing;
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find((m) => MediaRecorder.isTypeSupported(m)) || '';
  const rec = new MediaRecorder(cv.captureStream(30), mime ? { mimeType: mime, videoBitsPerSecond: 8000000 } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = () => r(); });
  const nextFrame = () => new Promise((r) => {
    let fired = false;
    const fin = () => { if (!fired) { fired = true; r(); } };
    const h = setTimeout(fin, 500);        // rAF 被节流时的兜底
    requestAnimationFrame(() => { clearTimeout(h); fin(); });
  });
  try {
    showTip = false; showGuide = false;     // 录进去的画面不带笔尖和参考线
    resetPlayback();
    playing = false;                        // 由下面的循环推进，不走 tick
    const total = STATS.totalMs;
    const rate = total / (OUT_SEC * 1000);  // 每毫秒真实时间推进多少毫秒的"画"
    rec.start();
    const t0 = performance.now();
    for (;;) {
      const simT = Math.min(total, (performance.now() - t0) * rate);
      while (idx < STROKES.length && cumMs[idx + 1] <= simT) {
        paintStroke(idx, 1); idx++;
        if ((idx & 511) === 0) $('expMsg').textContent = '录制中… ' + idx + ' / ' + STROKES.length + ' 笔';
      }
      if (idx >= STROKES.length) break;
      const tStart = cumMs[idx] + travels[idx] + beats[idx];
      if (simT > tStart) paintStroke(idx, clamp((simT - tStart) / msPaint[idx], 0, 1));
      flushMain();
      await nextFrame();
      if (performance.now() - t0 > OUT_SEC * 4000) {
        // 机器太慢时别再拖：剩下的笔一次补完，保证成品完整（视频会早一点结束）
        while (idx < STROKES.length) { paintStroke(idx, 1); idx++; }
        break;
      }
    }
    flushMain();
    await new Promise((r) => setTimeout(r, 600));              // 让最后一帧落进流里
  } finally {
    if (rec.state !== 'inactive') rec.stop();
    await stopped;
    showTip = oldTip; showGuide = oldGuide; playing = wasPlaying;
    $('tip').checked = oldTip; $('guideChk').checked = oldGuide;
    btn.disabled = false; btn.textContent = oldTxt;
  }
  if (!chunks.length) { $('expMsg').textContent = '录制失败，没拿到数据'; return; }
  const blob = new Blob(chunks, { type: 'video/webm' });
  download(blob, 'image2strokes-' + stamp() + '.webm');
  $('expMsg').textContent = '视频已导出：约 ' + OUT_SEC + ' 秒快放 · ' + (blob.size / 1048576).toFixed(1) + ' MB';
  finish();                                 // 回到"画完了"的状态
}

// 笔触脚本：笔形 + 轨迹 + 纯色 + 裁剪掩膜（PNG），可直接喂给别的绘图工具
function exportJson() {
  if (!STROKES.length) return;
  const btn = $('expJson'), oldTxt = btn.textContent;
  btn.disabled = true; btn.textContent = '打包中…';
  $('expMsg').textContent = '正在打包裁剪掩膜…';
  setTimeout(() => {
    try {
      const clips = CLIPS.map((c) => {
        const cv = document.createElement('canvas');
        cv.width = c.w; cv.height = c.h;
        const x = cv.getContext('2d');
        const id = x.createImageData(c.w, c.h);
        for (let k = 0; k < c.mask.length; k++) {
          id.data[k * 4] = 255; id.data[k * 4 + 1] = 255; id.data[k * 4 + 2] = 255;
          id.data[k * 4 + 3] = c.mask[k] ? 255 : 0;
        }
        x.putImageData(id, 0, 0);
        return { x: c.x, y: c.y, w: c.w, h: c.h, mask: cv.toDataURL('image/png') };
      });
      const data = {
        format: 'image2strokes/1', W, H,
        colors: STATS.colors, photo: !!STATS.photo, style: STATS.style, strokes: STROKES.length,
        note: '每条笔触：rib/tp 是平铺坐标数组（[x0,y0,x1,y1,…]），color 是纯色 RGB，' +
              'w 是笔宽，ms 是这一笔的时长，pen=1 表示硬笔尖；c 指向 clips 里的裁剪掩膜' +
              '（PNG：白色不透明=可以落色，透明=裁掉），绘制时把 rib 多边形与掩膜求交再填 color 即可。',
        strokes: STROKES, clips,
      };
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      download(blob, 'image2strokes-' + stamp() + '.json');
      $('expMsg').textContent = '笔触已导出：' + (blob.size / 1048576).toFixed(1) + ' MB';
    } catch (e) {
      $('expMsg').textContent = '导出失败：' + e.message;
    } finally {
      btn.disabled = false; btn.textContent = oldTxt;
    }
  }, 30);
}

// ---------------- 交互 ----------------
function bindUI() {
  $('file').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) loadFile(f);
  });
  const dz = $('drop');
  ['dragenter', 'dragover'].forEach((k) => dz.addEventListener(k, (e) => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((k) => dz.addEventListener(k, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });
  document.querySelectorAll('[data-sample]').forEach((el) => {
    el.addEventListener('click', () => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => startExtract(fitImage(im));
      im.onerror = () => { $('status').textContent = '示例图加载失败'; };
      im.src = el.getAttribute('data-sample');
    });
  });
  $('play').addEventListener('click', () => {
    if (done) { resetPlayback(); return; }
    playing = !playing;
    $('play').textContent = playing ? '暂停' : '继续';
  });
  $('speed').addEventListener('input', (e) => {
    speed = parseFloat(e.target.value);
    $('speedVal').textContent = speed.toFixed(2).replace(/0$/, '') + '×';
  });
  // 进度条：拖动时只更新读数（拖动本身会连续重画上千笔，会卡）；松手/实时轻量跳转
  let lastSeekAt = 0;
  $('seek').addEventListener('pointerdown', () => { draggingSeek = true; });
  window.addEventListener('pointerup', () => { draggingSeek = false; });
  $('seek').addEventListener('input', (e) => {
    if (!STROKES.length) return;
    const sec = parseFloat(e.target.value) / 1000 * (STATS.totalMs / 1000);
    $('clock').textContent = fmt(sec) + ' / ' + fmt(STATS.totalMs / 1000);
    const now = performance.now();
    if (now - lastSeekAt < 150) return;       // 拖动中最多 6~7 次/秒做实际定位
    lastSeekAt = now;
    playing = false;
    $('play').textContent = '继续';
    jumpTo(sec);
  });
  $('seek').addEventListener('change', (e) => {          // 松手：精确定位
    if (!STROKES.length) return;
    playing = false;
    $('play').textContent = '继续';
    jumpTo(parseFloat(e.target.value) / 1000 * (STATS.totalMs / 1000));
  });
  $('toEnd').addEventListener('click', () => {           // 看成品：快进到画完
    if (!STROKES.length) return;
    if (done) { resetPlayback(); return; }
    rushing = true; playing = true; $('play').textContent = '暂停';
    $('stat').textContent = '快进到成品…';
  });
  document.querySelectorAll('#phases span').forEach((el) => {
    el.addEventListener('click', () => {                 // 点阶段名 → 跳到该阶段开头
      const ph = parseInt(el.getAttribute('data-ph'), 10);
      if (!STROKES.length || !cumMs) return;
      let i = 0;
      while (i < STROKES.length && (STROKES[i].ph | 0) !== ph) i++;
      if (i >= STROKES.length) return;
      playing = false; $('play').textContent = '继续';
      jumpTo(cumMs[i] / 1000);
    });
  });
  $('cmp').addEventListener('change', () => {});
  $('tip').addEventListener('change', (e) => { showTip = e.target.checked; });
  $('guideChk').addEventListener('change', (e) => { showGuide = e.target.checked; });
  $('expPng').addEventListener('click', exportPng);
  $('expVideo').addEventListener('click', () => { exportVideo(); });
  $('expJson').addEventListener('click', exportJson);
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && STROKES.length) { e.preventDefault(); $('play').click(); }
  });
}

function loadFile(f) {
  const url = URL.createObjectURL(f);
  const im = new Image();
  im.onload = () => { startExtract(fitImage(im)); URL.revokeObjectURL(url); };
  im.onerror = () => { $('status').textContent = '图片读取失败'; URL.revokeObjectURL(url); };
  im.src = url;
}

bindUI();
schedule();
