/* 主线程应用：上传 → 提炼（Worker 里跑管线）→ 逐笔回放 */
'use strict';

const MAXSIDE = 1024;
const $ = (id) => document.getElementById(id);

let W = 0, H = 0;                 // 画布尺寸
let STROKES = [], CLIPS = [], STATS = null;
let PLAN = null;                 // 管线规划出来的最终画布（RGB）：看成品可以直接落这张，不必逐笔重画
let target = null;                // 目标图 ImageData（用于对比）
let painted = null, mt = null;    // 已完成的画（离屏）、主画布上下文
let tmpC = null, tmp = null;      // 单笔合成用的临时画布
let idx = 0, acc = 0, playing = false, done = false, lastT = performance.now();
let speed = 1, cursor = null, guide = null, showTip = true, showGuide = true;
let showLoupe = true;             // 细节放大镜（尾段微补笔只有几个像素，不放大看不出在画）
const LOUPE_CSS = 152, LOUPE_ZOOM = 4;
let clipCache = new Map(), maskC = null, mk = null;   // 掩膜 ImageData 缓存 + 共用格子画布
let worker = null;
let cumMs = null;              // 每笔结束时的累计时间（含抬笔移动与停顿）
let keys = [];                 // 关键帧快照 {i, data} 或 {i, rgb}（管线侧光栅）
let keyEvery = 0;
let KEYFRAMES = [];
let selfChecking = false;         // 成品自检（找白点）进行中：期间 hud 不覆盖状态行
let rushing = false;              // "看成品"：快进到画完（每帧画一大批，画面看得见在飞速推进）
let draggingSeek = false;         // 正在拖进度条：这期间 hud 不要回写滑块位置
let checkMsg = '';                // 自检结论（挂在状态行末尾，一直都在）
let extracting = false;           // 正在提炼：期间不接受第二次选图，避免两个任务在 worker 里串味
// "像人在画"需要的三段时间轴：抬笔移动 travel + 换阶段停顿 beat + 落笔绘制 paint
let travels = null, beats = null, msPaint = null;
let targetMs = 240000;          // 每次提炼后按笔数自动定（见 buildTimeline）
let finishHoldMs = 0;           // 最后一笔落完后停留多久再显示“画完了”
let finishHoldTimer = 0;
let finishHoldStarted = 0;
let airPath = null;             // 抬笔移动的弧线（画在纸面上的淡虚线）
const lastEnd = [0, 0];         // 上一笔收笔的位置（抬笔弧线的起点）
let algo = 'artist';            // 当前算法：artist 画家模式 / layer 分层宽笔 / pyramid 逐级细化
let srcCanvas = null;           // 最近一次选图的画布：切换算法时原地重提炼
let PHASES = ['铺底色', '铺色', '收形', '点睛', '落款'];

// 三种算法共用五步进度条，但阶段含义不同：artist 是"观察→起形→铺大色→塑形→点睛"，
// pyramid 是"起稿 → 铺色 → 细化 → 收形 → 落款"。
// 平涂精确复刻（背景先行）另有一套：背景 → 主体 → 文字/结构 → 细节。
function paintPhaseChips() {
  document.querySelectorAll('[data-ph]').forEach((el, i) => {
    if (i < PHASES.length) el.textContent = ['①', '②', '③', '④', '⑤'][i] + ' ' + PHASES[i];
  });
}
function setAlgoPhases(a) {
  // painter（画家·过程版）默认沿用 artist 的标签，防止照片回退路径上标签错配；
  // 平涂走新五遍流程时，结果回来后按 exactOrder==='painter' 再覆盖成专用标签。
  algo = a === 'pyramid' ? 'pyramid' :
    (a === 'artist' || a === 'painter' || a === 'compiler' ? a : 'layer');
  PHASES = algo === 'compiler'
    ? ['铺满父色块', '子区域覆盖', '逐层完成', '细节压回', '收笔']
    : algo === 'artist' || algo === 'painter'
      ? ['起形', '铺大色', '塑形', '点睛', '收笔']
      : algo === 'pyramid'
        ? ['起稿', '铺色', '细化', '收形', '落款']
        : ['铺底色', '铺色', '收形', '点睛', '落款'];
  paintPhaseChips();
}

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

/* 提示同时写两处：#note 常驻在选图框下面（提炼开始前也看得见），
   #status 只在进度条那块显示时才可见——原来错误只写 #status，等于永远看不到 */
function note(msg, kind) {
  const n = $('note');
  if (n) { n.textContent = msg; n.className = 'note' + (msg ? ' show ' + (kind || 'info') : ''); }
  const s = $('status');
  if (s && $('stage').style.display !== 'none') s.textContent = msg;
}

function setExtracting(on) {
  extracting = on;
  const dz = $('drop');
  if (dz) { dz.classList.toggle('busy', on); dz.setAttribute('aria-busy', on ? 'true' : 'false'); }
  document.querySelectorAll('[data-sample]').forEach((b) => { b.disabled = on; });
  const algoSel = $('algo'); if (algoSel) algoSel.disabled = on;   // 提炼中不许换算法，避免标签和结果对不上
}

function startExtract(imgCanvas) {
  if (extracting) { note('上一张还在提炼，等它跑完再换。', 'warn'); return; }
  srcCanvas = imgCanvas;                             // 切换算法时用它原地重提炼
  W = imgCanvas.width; H = imgCanvas.height;
  const ctx2 = imgCanvas.getContext('2d');
  target = ctx2.getImageData(0, 0, W, H);
  $('stage').style.display = 'block';
  $('canvasWrap').style.display = 'none';
  $('welcome').style.display = 'none';
  note('正在提炼…', 'info');
  setExtracting(true);
  $('bar').style.width = '0%';
  const fid = parseInt($('fidelity').value, 10) || 3;
  setAlgoPhases($('algo') ? $('algo').value : 'artist');
  // 过程可以每张不同，但每次的种子要能复现：?seed=123 可重跑同一段笔序。
  const seedQ = new URLSearchParams(location.search).get('seed');
  RUN_SEED = (seedQ !== null && seedQ !== '' && isFinite(+seedQ))
    ? ((+seedQ) >>> 0)
    : ((Date.now() ^ ((Math.random() * 0x100000000) >>> 0)) >>> 0);
  const runSeed = RUN_SEED;
  const opts = {
    colors: 0,                                       // UI 不再暴露颜色数：固定自动（按纹理强度定）
    style: $('style').value,
    fidelity: fid,                                   // 1 省笔 … 5 极致
    algo: algo,                                      // artist 画家模式 / layer 分层宽笔 / pyramid 逐级细化
    returnCanvas: true,                              // 成品画布：看成品时直接落图，不用逐笔快进
    seed: runSeed,
  };
  if (!worker) {
    worker = new Worker('js/worker.js?v=71');
    worker.onmessage = onWorker;
    worker.onerror = (e) => { setExtracting(false); note('出错：' + e.message, 'err'); };
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
  if (d.type === 'error') { setExtracting(false); note('出错：' + d.msg, 'err'); return; }
  setExtracting(false);
  STROKES = d.res.strokes; CLIPS = d.res.clips; STATS = d.res.stats;
  setAlgoPhases(STATS.algo || algo);               // 阶段标签跟结果走（pyramid/cover 各一套）
  // 平涂精确复刻改成"背景先行"后，四步的含义也跟着变（不是起形/铺大色了）
  if (STATS.exactOrder === 'bgfirst') {
    PHASES = ['起稿铺满', '细化背景', '细化主体', '前景细节', '收笔'];
    paintPhaseChips();
  }
  // 闭合区域画家：父色块绕边并填满，再逐层把子区域画回来。
  if (STATS.exactOrder === 'closed' || STATS.exactOrder === 'compiler') {
    PHASES = ['铺满父色块', '子区域覆盖', '逐层完成', '细节压回', '收笔'];
    paintPhaseChips();
  }
  // 画家·过程版：人画五遍（起稿铺底 → 逐对象完成 → 点睛 → 收笔）
  if (STATS.exactOrder === 'painter') {
    // 第二遍实际画了闭合外框就标"勾外框"，否则是"补背景"——按动作命名，
    // 不按图的颜色/类型分支。
    PHASES = STATS.ring
      ? ['铺满整页', '勾外框', '画主体', '点睛·收笔', '落款']
      : ['铺满整页', '补背景', '画主体', '点睛·收笔', '落款'];
    paintPhaseChips();
  }
  PLAN = d.res.canvasRgb || null;
  KEYFRAMES = (d.res.keys || []).map((k) => ({ i: k.i, rgb: k.rgb, cov: k.cov }));
  const finChip = $('phFin');
  const hasFin = STROKES.some((s) => s.fin);
  if (finChip) finChip.style.display = hasFin ? '' : 'none';
  buildCanvases();
  resetPlayback();
  checkMsg = '';
  $('stage').style.display = 'none';
  $('canvasWrap').style.display = 'block';
  note('', '');                    // 提炼完成：把选图框下面那句“正在提炼…”清掉
  fitView();                       // 画布刚可见时才量得到容器宽度（buildCanvases 里那次量到的是 0）
  $('stat').innerHTML = '共 <em>' + STATS.strokes + '</em> 笔 · 约 <em>' +
    Math.round(STATS.totalMs / 1000) + '</em> 秒画完（1×）· ' + PHASES.slice(0, 4).join(' → ') +
    (hasFin ? ' → ' + PHASES[4] : '') +
    (STATS.photo ? ' · 已按照片自动用 <em>' + STATS.colors + '</em> 色' : (STATS.colors ? ' · ' + STATS.colors + ' 色' : ''));
  for (const id of ['expVideo', 'expJson', 'expHtml', 'expSvg', 'expPng']) { const b = $(id); if (b) b.disabled = false; }
  $('expMsg').textContent = '';
  // 开播；白点自检在后台画布上推进，补笔备好后追加到时间轴末尾（不挡着画画）
  playing = true;
  $('play').textContent = '暂停';
  startSelfCheck($('stat').innerHTML);
}

// ---------------- 画布 ----------------
let RUN_SEED = 1;                  // 本次运行的随机种子（?seed= 可复现），节奏抖动用它
function buildCanvases() {
  const main = $('cv');
  main.width = W; main.height = H;
  mt = main.getContext('2d');
  painted = document.createElement('canvas');
  painted.width = W; painted.height = H;
  const pctx = painted.getContext('2d');
  pctx.fillStyle = '#ffffff';
  pctx.fillRect(0, 0, W, H);       // 回放从白纸开始：第一笔就是最大色块/背景
  tmpC = document.createElement('canvas');          // 单笔合成画布：只留格子大小，按需长大
  tmp = tmpC.getContext('2d');
  clipCache = new Map(); maskC = null; mk = null;
  buildTimeline();
  keyEvery = Math.max(300, Math.ceil(STROKES.length / 8));
  keys = [];
  fitView();
}

// 一笔该占多少回放时间：按它实际改了多少画布（vis，管线落色时记的 Σ 最大通道差），
// 而不是按“一个补丁也有起步价”。开方是为了让大块铺色和微补丁的倍率不至于悬殊到几百倍。
function strokeCost(st) {
  if (!st) return 4;
  const v = +st.vis;
  if (st.vis !== undefined && isFinite(v)) return v <= 0 ? 1 : 1 + 1.4 * Math.sqrt(v);
  if (st.g) return 1 + 3.2 * Math.sqrt(st.g);       // 老引擎没带 vis：按合并了几个补丁估
  const ms = +st.ms;
  return isFinite(ms) && ms > 0 ? ms : 4;
}

// compiler 时间轴按事务排，不再按总笔数压成固定 90 秒：
// - 原子色块 100~180ms 一次落下；
// - 轮廓/中心线按实际路径长度给 24~420ms；
// - 页面底板事务在开头约 2.2~2.8 秒内完整结束；
// - 每个对象事务至少 650ms，事务之间留 180~330ms 抬笔停顿；
// - 最后一笔完成后停留 1.3 秒再结束。
// 这个纯函数不依赖 DOM / 全局回放状态，engine_check 会直接执行它做时间轴回归。
function planCompilerTimeline(strokes, seed) {
  const n = strokes.length;
  const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));
  const hash01 = (a, b) => {
    const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  const pathLength = (st) => {
    const tp = st && st.tp;
    if (!tp || tp.length < 4) return 0;
    let len = 0;
    for (let i = 1; i < tp.length / 2; i++) {
      len += Math.hypot(tp[i * 2] - tp[(i - 1) * 2], tp[i * 2 + 1] - tp[(i - 1) * 2 + 1]);
    }
    return len;
  };
  const runSeed = Number.isFinite(+seed) ? (+seed >>> 0) : 0;
  const travels = new Float64Array(n);
  const beats = new Float64Array(n);
  const msPaint = new Float64Array(n);
  const groups = [];
  if (!n) {
    return {
      travels, beats, msPaint, cumMs: new Float64Array(1),
      groups, finishHoldMs: 0, totalMs: 0,
    };
  }
  let cur = null;
  for (let i = 0; i < n; i++) {
    const st = strokes[i];
    const key = Number.isInteger(st.txSeq) ? ('s:' + st.txSeq)
      : (st.tx === undefined ? 'legacy' : ('i:' + String(st.tx)));
    if (!cur || cur.key !== key) {
      cur = { key, start: i, end: i + 1, kind: st.txKind || 'legacy' };
      groups.push(cur);
    } else cur.end = i + 1;
  }
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const len = g.end - g.start;
    const durs = new Float64Array(len);
    let raw = 0;
    for (let j = 0; j < len; j++) {
      const i = g.start + j;
      const st = strokes[i];
      const step = st.step || (st.blk ? 'fill' : 'detail');
      const h = hash01(i * 1.37 + runSeed * 0.031, 3.9);
      let d;
      if (g.kind === 'pageBase' && step === 'detail') {
        // 底板纹理只做细察，不阻塞第一个前景对象；原子蓝底与黑框仍各占
        // 一个可见节拍，整页底色与画框在事务开头就已完整出现。
        d = 0.7 + h * 0.8;
      } else if (step === 'fill') {
        d = st.blk ? 100 + h * 80 : 35 + h * 70;
      } else if (step === 'outline' || step === 'line') {
        d = clamp(24 + pathLength(st) * 0.55, 24, 420) * (0.84 + h * 0.32);
      } else if (g.kind === 'detail' || g.kind === 'tail') {
        d = 8 + h * 12;
      } else {
        d = 10 + h * 30;
      }
      durs[j] = d;
      raw += d;
    }
    let want = raw;
    if (g.kind === 'pageBase') want = clamp(raw, 2200, 2800);
    else if (g.kind === 'object') want = Math.max(650, raw);
    else want = Math.max(260, raw);
    const k = raw > 0 ? want / raw : 0;
    for (let j = 0; j < len; j++) {
      const i = g.start + j;
      msPaint[i] = Math.max(0.25, durs[j] * k);
      if (gi > 0 && j === 0) {
        beats[i] += 180 + hash01(gi * 1.91 + runSeed * 0.017, 8.2) * 150;
      }
    }
  }
  const cumMs = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cumMs[i + 1] = cumMs[i] + travels[i] + beats[i] + msPaint[i];
  for (const g of groups) {
    g.beginMs = cumMs[g.start];
    g.endMs = cumMs[g.end];
  }
  const finishHoldMs = 1300;
  return { travels, beats, msPaint, cumMs, groups, finishHoldMs, totalMs: cumMs[n] + finishHoldMs };
}

function buildCompilerTimeline(n) {
  if (finishHoldTimer) { clearTimeout(finishHoldTimer); finishHoldTimer = 0; }
  finishHoldStarted = 0;
  const planned = planCompilerTimeline(STROKES, RUN_SEED);
  travels = planned.travels;
  beats = planned.beats;
  msPaint = planned.msPaint;
  cumMs = planned.cumMs;
  finishHoldMs = planned.finishHoldMs;
  targetMs = planned.totalMs;
  if (STATS) STATS.totalMs = targetMs;
  if (n) {
    lastEnd[0] = STROKES[0].tp[0];
    lastEnd[1] = STROKES[0].tp[1];
  }
}
// 时间轴：每笔 = 抬笔移动(短) + 换阶段停顿(偶尔) + 落笔绘制；总时长按笔数自动定
function buildTimeline() {
  const n = STROKES.length;
  if (algo === 'compiler') { buildCompilerTimeline(n); return; }
  finishHoldMs = 0;
  // 时长不再让用户选：画家模式按"有限笔数、看得清起承转合"给 30~90 秒；
  // 像素重建的旧模式仍按笔数给 150 秒起、8 分钟封顶。
  // 极简图（两横一竖这类，就几笔）不顶 30 秒下限：每笔 ~1.1 秒，几秒画完。
  targetMs = (algo === 'artist' || algo === 'painter')
    ? (n < 20
        ? clamp(Math.round(n * 1100), 3200, 30000)
        : clamp(Math.round(n * 24), 30000, 90000))
    : clamp(Math.round(n * 9), 150000, 480000);
  travels = new Float64Array(n);
  beats = new Float64Array(n);
  msPaint = new Float64Array(n);
  const costs = new Float64Array(n);
  const groupOf = new Uint8Array(n);      // 0=可见阶段(起稿/铺色/收形) 1=点睛微补 2=落款
  const gRaw = [0, 0, 0], gN = [0, 0, 0];
  const ends = new Float64Array(n * 2);
  let ex = 0, ey = 0, prevPh = -1, prevFin = false;
  for (let i = 0; i < n; i++) {
    const st = STROKES[i];
    const tp = st.tp;
    if (i > 0) {
      const d = Math.hypot(tp[0] - ex, tp[1] - ey);
      // 手就在旁边就顺势接着画（不占时间）；隔得远才抬笔"飞"过去
      travels[i] = d < 40 ? 0 : Math.min(200, 30 + (d - 40) * 0.35);
    }
    // 大幅铺底/定界是连续挥臂，不是逐笔抬腕找位置；否则几百条扫带光移动
    // 就会吃掉前四分之一时间轴，背景和主体迟迟立不起来。
    if (st.travelK !== undefined) travels[i] *= Math.max(0, st.travelK);
    const ph = st.ph === undefined ? 1 : (st.ph | 0);
    // 换阶段前停一下，像在回看；真人停顿长短不一，固定值像节拍器（仅画家模式随机化）
    const hb = hash01(i * 0.917 + RUN_SEED * 0.013, 4.4);
    if (prevPh >= 0 && ph !== prevPh) {
      beats[i] = (algo === 'artist' || algo === 'painter' || algo === 'compiler') ? (ph === 3 ? 480 + hb * 420 : 300 + hb * 320) : (ph === 3 ? 700 : 420);
    }
    if (st.fin && !prevFin) {
      beats[i] = Math.max(beats[i], (algo === 'artist' || algo === 'painter' || algo === 'compiler') ? 700 + hb * 500 : 900);   // 落款前停一下，让最后一拨看得清
    }
    prevFin = !!st.fin;
    prevPh = ph;
    ex = tp[tp.length - 2]; ey = tp[tp.length - 1];
    ends[i * 2] = ex; ends[i * 2 + 1] = ey;
    // 起稿/铺色/收形保留原来的笔速节奏；点睛和落款按“实际落色量”分时间
    const g = st.fin ? 2 : (ph === 3 ? 1 : 0);
    const c = g === 0 ? (st.ms > 0 ? st.ms : 4) : strokeCost(st);
    costs[i] = c; groupOf[i] = g; gRaw[g] += c; gN[g]++;
  }
  // 抬笔移动的总量封顶：细碎补笔动辄几千次"飞过去"，不封顶会把整段时间撑到目标的好几倍
  const cap = targetMs * 0.12;
  let sumT = 0;
  for (let i = 0; i < n; i++) sumT += travels[i];
  if (sumT > cap) { const sc = cap / sumT; for (let i = 0; i < n; i++) travels[i] *= sc; }
  let nonPaint = 0;
  for (let i = 0; i < n; i++) nonPaint += travels[i] + beats[i];
  const budget = Math.max(n, targetMs - nonPaint);
  if (algo === 'artist' || algo === 'painter' || algo === 'compiler') {
    // 画家模式按阶段排时间：起形/铺大色按落笔量分剩下的时间，
    // 塑形/点睛/收笔按"每笔至少多久"单独预留。塑形只有两三百笔，
    // 若仍按总落笔量分，会在最后几秒里一闪而过，看不出来在收形。
    const pOf = new Uint8Array(n);
    const pC = [0, 0, 0, 0, 0], pN = [0, 0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      const st = STROKES[i];
      const p = st.fin ? 4 : Math.min(3, st.ph === undefined ? 1 : (st.ph | 0));
      pOf[i] = p;
      costs[i] = st.ms > 0 ? st.ms : 4;
      // 每笔快慢有别：真人有的笔一带而过、有的反复确认。时长高斯感抖动，
      // 阶段内仍按权重归一，总时长不变。
      costs[i] *= 1 + (hash01(i * 1.71 + RUN_SEED * 0.029, 6.1) - 0.5) * 0.36;
      pC[p] += costs[i]; pN[p]++;
    }
    if (STATS && STATS.exactMode) {
      // 精确复刻路径的每一段都有明确任务，必须各自留出看得懂的时间：
      // 平涂先看起形勾出猫，再铺背景/底色，再收色块交界，最后五官胡须；
      // 照片先立主体结构，再铺环境，再塑形，最后细节。段内仍按落笔量分，
      // 长笔画得慢、短笔画得快，手的节奏不变。
      // 第 5 项是收笔（管线最多给最后一笔标 fin）：照片实测有 1 笔，
      // 留 1% 让它像最后盖个章，不能漏掉，否则 phaseMs[4] 无定义会毁掉整条时间轴。
      // 背景先行时背景本身就占了大半画面，时间也要跟着让给背景；
      // 主体一次画完一处，文字/细节收尾，不能还按旧的"起形 16%"分。
      const share = (STATS.exactOrder === 'painter' || STATS.exactOrder === 'closed' || STATS.exactOrder === 'compiler')
        ? (() => {
            // 所有画家路径统一按"每段笔数 + 落笔量"分时间：铺满/勾框/补背景这类
            // 笔数少但动作大的阶段不会被主体段挤成零点几秒，也不再按图类型写死配比。
            const raw = [0, 0, 0, 0, 0];
            for (let p = 0; p < 5; p++) raw[p] = Math.max(pN[p] / 100, pC[p] / 6000);
            const sum = raw.reduce((a, b) => a + b, 0) || 1;
            const s = raw.map((v) => v / sum);
            // 起稿/背景细化只是把大关系立住，不能因为碎笔多就吃掉前半段。
            // 给前两个阶段一个总时长上限，剩余时间按原有比例还给主体与收笔；
            // 这样 30% 左右已经进入“逐对象完成”，而不是还在空版面上磨。
            const leadCap = 0.22;
            const leadRaw = s[0] + s[1];
            if (leadRaw > leadCap) {
              const k = leadCap / leadRaw;
              const freed = leadRaw - leadCap;
              s[0] *= k; s[1] *= k;
              const tail = s[2] + s[3] + s[4];
              if (tail > 0) for (let p = 2; p < 5; p++) s[p] += freed * s[p] / tail;
            }
            const floor = [0.10, 0.05, 0.05, 0.02, 0.01];
            let tot = 0;
            for (let p = 0; p < 5; p++) {
              s[p] = Math.max(s[p], pN[p] > 0 ? floor[p] : 0);
              tot += s[p];
            }
            return s.map((v) => v / tot);
          })()
        : STATS.exactOrder === 'bgfirst'
          ? [0.18, 0.40, 0.36, 0.04, 0.02]
          : (STATS.photo
            ? (() => {
                // 照片的笔集中在塑形段（实测猫照片：起形 1394 / 铺色 835 /
                // 塑形 7541 / 点睛 403）。写死 32% 会让塑形段 260 笔/秒、
                // 糊成一片；按真实笔数分，段内仍按落笔量走。
                const w = [Math.max(1, pN[0]), Math.max(1, pN[1]),
                  Math.max(1, pN[2]), Math.max(1, pN[3])];
                const tot = w[0] + w[1] + w[2] + w[3];
                return [w[0] / tot, w[1] / tot, w[2] / tot, w[3] / tot, 0.01];
              })()
            : [0.16, 0.34, 0.33, 0.15, 0.02]);
      let active = 0;
      for (let p = 0; p < 5; p++) if (pN[p] > 0) active += share[p];
      const phaseMs = [0, 0, 0, 0, 0];
      if (active > 0) for (let p = 0; p < 5; p++) phaseMs[p] = budget * share[p] / active;
      for (let i = 0; i < n; i++) {
        const p = pOf[i];
        const v = pC[p] > 0 ? phaseMs[p] * costs[i] / pC[p] : 1;
        msPaint[i] = Number.isFinite(v) && v > 0 ? v : 1;
      }
    } else {
      const rate = [0, 0, 70, 220, 900];       // 塑形 70ms/笔、点睛 220ms/笔、落款 900ms/笔
      let want = 0;
      for (let p = 2; p <= 4; p++) want += pN[p] * rate[p];
      const detScale = want > 0 ? Math.min(1, budget * 0.55 / want) : 0;
      let det = 0;
      for (let p = 2; p <= 4; p++) det += pN[p] * rate[p] * detScale;
      const bulk = Math.max(n, budget - det);
      const bulkC = pC[0] + pC[1];
      for (let i = 0; i < n; i++) {
        const p = pOf[i];
        msPaint[i] = p <= 1
          ? (bulkC > 0 ? Math.max(1, costs[i] * bulk / bulkC) : 1)
          : Math.max(1, rate[p] * detScale);
      }
    }
  } else if (STATS && STATS.quality) {
    // cover 模式：每笔 ms 已在管线里按旧版节奏给好（铺底色轻快 / 铺色中等 / 收形慢 /
    // 点睛最慢最细 + 每笔起伏 + 白色一笔带过），这里只按权重归一，不再按阶段配比硬分——
    // 阶段占比由笔的节奏自然形成（和旧版图层管线同一套行为）。
    let tot = 0;
    for (let i = 0; i < n; i++) {
      const c = STROKES[i].ms > 0 ? STROKES[i].ms : 4;
      costs[i] = c; tot += c;
    }
    const k = tot > 0 ? budget / tot : 1;
    for (let i = 0; i < n; i++) msPaint[i] = Math.max(1, costs[i] * k);
  } else {
    // 时间预算：可见阶段 87%，点睛微补 10%，落款 3%。没有落款/点睛时按比例并回其余阶段。
    const share = [0.87, 0.10, 0.03];
    let activeShare = 0;
    for (let g = 0; g < 3; g++) if (gN[g] > 0) activeShare += share[g];
    const norm = activeShare > 0 ? 1 / activeShare : 0;
    const phaseK = [0, 0, 0];
    for (let g = 0; g < 3; g++) if (gN[g] > 0 && gRaw[g] > 0) phaseK[g] = (budget * share[g] * norm) / gRaw[g];
    for (let i = 0; i < n; i++) {
      const g = groupOf[i];
      msPaint[i] = phaseK[g] > 0 ? Math.max(1, costs[i] * phaseK[g]) : 1;
    }
  }
  cumMs = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    cumMs[i + 1] = cumMs[i] + travels[i] + beats[i] + msPaint[i];
  }
  if (STATS && n) STATS.totalMs = cumMs[n];
  if (n) { lastEnd[0] = STROKES[0].tp[0]; lastEnd[1] = STROKES[0].tp[1]; }
}

function fitView() {
  const wrap = $('canvasWrap');
  if (!W || !wrap.clientWidth) return;   // 容器还没显示（宽度为 0）时量出来是负数，等比算出来的宽度会被浏览器丢掉
  const maxW = wrap.clientWidth - 8, maxH = window.innerHeight - 190;
  const s = Math.min(maxW / W, maxH / H, 1);
  const cv = $('cv');
  cv.style.width = Math.round(W * s) + 'px';
  cv.style.height = Math.round(H * s) + 'px';
}
window.addEventListener('resize', fitView);

// 画布当前在屏幕上的缩放比（1 个图像像素 = 多少 CSS 像素）：笔尖/运笔线要按它设最小尺寸
function uiScale() {
  const cv = $('cv');
  return cv && cv.clientWidth ? cv.clientWidth / W : 1;
}

// 细节放大镜：跟随笔尖，显示 4× 左右的原图像素；放在笔尖的对角，避免挡住正在画的地方
function updateLoupe() {
  const box = $('loupe'), lc = $('loupeCv');
  if (!box || !lc) return;
  const st = STROKES.length ? STROKES[Math.min(idx, STROKES.length - 1)] : null;
  const cmpOn = $('cmp') && $('cmp').checked;
  const ph = st && st.ph !== undefined ? (st.ph | 0) : 1;
  const show = showLoupe && !done && !rushing && !cmpOn && !!cursor && !!mt &&
               !!st && (!!st.fin || ph >= 2 || st.w <= 12);
  if (!show) { box.classList.remove('on'); return; }
  const s = uiScale();
  if (!(s > 0) || !W || !H) { box.classList.remove('on'); return; }
  const size = clamp(LOUPE_CSS / (LOUPE_ZOOM * s), 24, Math.min(W, H));
  const sx = clamp(cursor.x - size / 2, 0, Math.max(0, W - size));
  const sy = clamp(cursor.y - size / 2, 0, Math.max(0, H - size));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const px = Math.round(LOUPE_CSS * dpr);
  if (lc.width !== px || lc.height !== px) { lc.width = px; lc.height = px; }
  const lx = lc.getContext('2d');
  lx.imageSmoothingEnabled = false;
  lx.clearRect(0, 0, px, px);
  lx.drawImage(mt.canvas, sx, sy, size, size, 0, 0, px, px);
  // 笔尖位置的小圈：放大后仍能一眼看到“正在哪一点上”
  lx.strokeStyle = 'rgba(200,83,47,0.9)';
  lx.lineWidth = Math.max(1, dpr);
  lx.beginPath();
  lx.arc(px / 2, px / 2, Math.max(5, px * 0.055), 0, Math.PI * 2);
  lx.stroke();
  const right = cursor.x < W * 0.5;
  const bottom = cursor.y < H * 0.5;
  box.style.left = right ? 'auto' : '8px';
  box.style.right = right ? '8px' : 'auto';
  box.style.top = bottom ? 'auto' : '8px';
  box.style.bottom = bottom ? '8px' : 'auto';
  box.classList.add('on');
}

// 掩膜缓存：每格只建一次 ImageData（白 = 不透明 = 可画）。以前是"canvas 缓存 40 个"，
// 但 2.7 万笔几乎笔笔是新格子，等于每笔都在现建 canvas——每笔 ~1ms，拖进度条重画
// 几千笔就卡死整页。ImageData 便宜得多，全量缓存也就几十 MB。
function clipImageFor(c) {
  if (clipCache.has(c)) return clipCache.get(c);
  const cl = CLIPS[c];
  const id = new ImageData(cl.w, cl.h);
  const dd = id.data, m = cl.mask;
  for (let i = 0; i < m.length; i++) {
    dd[i * 4] = 255; dd[i * 4 + 1] = 255; dd[i * 4 + 2] = 255;
    dd[i * 4 + 3] = m[i] ? 255 : 0;
  }
  clipCache.set(c, id);
  return id;
}

// 画一笔（u=1 为整笔）。u<1 时只把"半成品"放进临时画布，不落到成品
let pending = -1, pendRect = null;
function paintStroke(i, u, dest) {
  const st = STROKES[i];
  const cl = CLIPS[st.c];
  const t = tipAt(st, u);
  cursor = { x: t.x, y: t.y, r: Math.max(2.5, st.w * 0.5), pen: st.pen, color: st.color };
  guide = st.tp;
  // 原子色块在槽位开始后才出现，但一旦出现就是完整色块；不再按扫描线
  // 露出中间态。轮廓/细线仍然走正常的 u 进度绘制。
  if (st.blk && u <= 0) return false;
  const rgb = 'rgb(' + st.color[0] + ',' + st.color[1] + ',' + st.color[2] + ')';
  const rect = { x: cl.x, y: cl.y, w: cl.w, h: cl.h };
  // tmp 画布跟着"当前格子"走：不够就长、大太多就缩（留 2× 余量，避免每笔都重建）。
  // 关键点：掩膜合成 destination-in 和两次 drawImage 的成本是按 *tmp 画布面积* 算的，
  // 不是按笔形面积算的。以前只长不缩，一笔全画布格子（铺纸底色 / 整页色块）会把 tmp
  // 顶到整幅画布大小，之后每一笔（哪怕只有 30×20）都要做一次 100 万像素的合成——
  // 实测单笔 7.3ms，播放时每帧 8~9 笔就直接掉到 7fps（严重的卡顿）。跟着格子缩放后单笔 0.15ms。
  if (tmpC.width < rect.w || tmpC.height < rect.h ||
      tmpC.width > rect.w * 2 || tmpC.height > rect.h * 2) {
    tmpC.width = Math.max(1, rect.w);
    tmpC.height = Math.max(1, rect.h);
  }
  tmp.setTransform(1, 0, 0, 1, 0, 0);               // 清格子必须在恒等变换下
  tmp.clearRect(0, 0, rect.w, rect.h);
  tmp.setTransform(1, 0, 0, 1, -rect.x, -rect.y);   // 之后画进格子局部坐标，rib 出格的部分自动裁掉
  tmp.save();
  tmp.fillStyle = rgb;
  tmp.strokeStyle = rgb;
  if (st.blk || u >= 1) {
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
  tmp.setTransform(1, 0, 0, 1, 0, 0);               // 掩膜合成也必须在恒等变换下，否则整块错位
  // 掩膜裁形：ImageData 放到共用的格子画布上，再以 destination-in 画过来。
  // maskC 必须与 tmpC 同尺寸——destination-in 是整块运算，源比目标小会把目标其余部分擦成透明。
  if (!maskC) { maskC = document.createElement('canvas'); mk = maskC.getContext('2d'); }
  if (maskC.width !== tmpC.width || maskC.height !== tmpC.height) {
    maskC.width = tmpC.width;
    maskC.height = tmpC.height;
  }
  mk.putImageData(clipImageFor(st.c), 0, 0);
  tmp.globalCompositeOperation = 'destination-in';
  tmp.drawImage(maskC, 0, 0);
  tmp.globalCompositeOperation = 'source-over';
  const ctx = (dest || painted).getContext('2d');
  ctx.drawImage(tmpC, 0, 0, rect.w, rect.h, rect.x, rect.y, rect.w, rect.h);
  if (st.blk || u >= 1) {
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
  if ($('cmp').checked && target) {
    mt.putImageData(target, 0, 0);
    return;
  }
  mt.drawImage(painted, 0, 0);              // painted 永远是不透明白底，铺满全屏，不必再垫一遍白
  if (pending >= 0 && !done && pendRect) {               // 半成品浮在成品之上（tmp 是格子局部坐标）
    mt.drawImage(tmpC, 0, 0, pendRect.w, pendRect.h,
                 pendRect.x, pendRect.y, pendRect.w, pendRect.h);
  }
  if (cursor && showTip && !done) drawCursor(mt, cursor);
  if (guide && showGuide && !done) drawGuide(mt, guide, cursor);
  if (airPath && showGuide && !done) drawAir(mt, airPath);   // 抬笔移动的浅弧线
}

function drawAir(ctx, p) {
  const inv = 1 / Math.max(0.2, uiScale());
  ctx.save();
  ctx.setLineDash([5, 7]);
  ctx.strokeStyle = 'rgba(70,70,82,0.22)';
  ctx.lineWidth = Math.max(1.1, 1.2 * inv);      // 至少 1.2 个屏幕像素，缩小时也看得见
  ctx.beginPath();
  ctx.moveTo(p[0], p[1]);
  ctx.quadraticCurveTo(p[2], p[3], p[4], p[5]);
  ctx.stroke();
  ctx.restore();
}

function drawCursor(ctx, c) {
  const inv = 1 / Math.max(0.2, uiScale());
  ctx.save();
  ctx.translate(c.x, c.y);
  if (c.air) {                                  // 抬笔：空心小圈 + 一点芯，看得出笔离开了纸面
    ctx.strokeStyle = 'rgba(45,45,54,0.55)';
    ctx.lineWidth = Math.max(1.1, 1.2 * inv);
    ctx.beginPath(); ctx.arc(0, 0, Math.max(3 * inv, c.r * 0.85), 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(45,45,54,0.45)';
    ctx.beginPath(); ctx.arc(0, 0, Math.max(1.6 * inv, c.r * 0.26), 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    return;
  }
  if (c.pen) {
    ctx.fillStyle = 'rgba(30,30,36,0.92)';
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(2.6 * inv, c.r * 0.5), 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.strokeStyle = 'rgba(40,40,48,0.75)';
    ctx.lineWidth = Math.max(1.1, 1.3 * inv);
    ctx.beginPath(); ctx.arc(0, 0, Math.max(3.4 * inv, c.r * 1.15), 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(' + c.color[0] + ',' + c.color[1] + ',' + c.color[2] + ',0.85)';
    ctx.beginPath(); ctx.arc(0, 0, Math.max(1.9 * inv, c.r * 0.55), 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function drawGuide(ctx, tp, c) {
  if (!c) return;
  const inv = 1 / Math.max(0.2, uiScale());
  ctx.save();
  ctx.setLineDash([6, 6]);
  ctx.strokeStyle = 'rgba(60,60,70,0.32)';
  ctx.lineWidth = Math.max(1.1, 1.2 * inv);
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
  if (rushing && !done) {                    // 快进到成品：每帧最多花 ~12ms，画不完下帧接着来
    const t0 = performance.now();
    let cnt = 0;
    while (idx < STROKES.length) {
      paintStroke(idx, 1); idx++;
      if ((++cnt & 63) === 0 && performance.now() - t0 >= 12) break;
    }
    if (idx >= STROKES.length) { rushing = false; finish(); }
  } else if (playing && !done) {
    acc += dt * speed;
    let guard = 0;
    const t0 = performance.now();
    while (idx < STROKES.length && guard++ < 400) {
      const tot = travels[idx] + beats[idx] + msPaint[idx];
      if (acc < tot) break;
      acc -= tot;
      paintStroke(idx, 1);
      idx++;
      if (keyEvery && idx % keyEvery === 0 && idx < STROKES.length) snapshotKey(idx);
      if (idx >= STROKES.length) { finishWithHold(); break; }
      // 10× 速度下一帧可能要画上百笔：给主线程留时间，别整帧卡死（画面落后由下一帧补）
      if ((guard & 15) === 0 && performance.now() - t0 >= 12) break;
    }
    if (idx < STROKES.length && !done) {
      const tv = travels[idx] + beats[idx];
      if (acc < tv) travelTo(idx, acc / Math.max(1, tv));        // 还在抬笔移动
      else { endTravel(); paintStroke(idx, clamp((acc - tv) / msPaint[idx], 0, 1)); }
    }
  }
  if (checkState) stepSelfCheck(gap);       // 成品自检：按帧分片推进（帧慢就多干点）
  flushMain();
  updateLoupe();
  hud();
  schedule();
}

// 页面在后台时 rAF 不触发：退回定时器，保证"离开标签页也会继续画"。
// 同一时刻只允许一个待执行的 tick：以前 schedule() 与看门狗会各自排队一条 rAF 链，
// 每排一次就多一条链，帧越慢链越多、链越多帧越慢（实测每帧跑 6.8 次 tick，
// 也就是同一帧里把当前这笔重画了 6 遍）——这是播放卡顿的第二个来源。
let tickQueued = false, tickQueuedAt = 0, tickGen = 0;
function schedule() {
  const now = performance.now();
  // 250ms 内已经排过就不再排；超时说明那次 rAF 丢了（切到后台 / 被节流），重新排一条。
  if (tickQueued && now - tickQueuedAt < 250) return;
  tickQueued = true; tickQueuedAt = now;
  const gen = ++tickGen;
  const run = function () {
    if (gen !== tickGen) return;           // 已被更新的排程取代：这条作废，避免同一帧跑两次 tick
    tickQueued = false;
    tick();
  };
  if (document.hidden) setTimeout(run, 100);
  else requestAnimationFrame(run);
}
// 看门狗：窗口未聚焦时 rAF 可能被节流甚至暂停，这里保证动画继续推进（同样只排队一次）
setInterval(function () {
  if (performance.now() - lastTickAt > 50) schedule();
}, 50);

function restoreKey(k, ctx) {
  if (k.data) { ctx.putImageData(k.data, 0, 0); return; }
  // cover 模式的管线关键帧：白纸 + 已经画到的像素（cov=1）。
  // 没画到的地方保持白纸——回放就是从零开始，不再垫虚焦底图。
  if (k.cov) {
    const img = ctx.getImageData(0, 0, W, H);
    const dd = img.data, rgb = k.rgb, cov = k.cov;
    for (let p = 0, q = 0; p < W * H; p++, q += 4) {
      if (cov[p]) {
        dd[q] = rgb[p * 3]; dd[q + 1] = rgb[p * 3 + 1]; dd[q + 2] = rgb[p * 3 + 2];
      } else {
        dd[q] = 255; dd[q + 1] = 255; dd[q + 2] = 255;
      }
      dd[q + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return;
  }
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
  if (!STATS) return;
  const n = STROKES.length;
  const st = n ? STROKES[Math.min(idx, n - 1)] : null;
  const cur = done || finishHoldTimer ? STATS.totalMs : (cumMs[idx] + acc);
  const p = STATS.totalMs > 0 ? cur / STATS.totalMs : 0;
  $('fill').style.width = (p * 100).toFixed(2) + '%';
  $('clock').textContent = fmt(cur / 1000) + ' / ' + fmt(STATS.totalMs / 1000);
  const sk = $('seek');
  if (sk && !draggingSeek) sk.value = String(Math.round(p * 1000));   // 进度条跟着跑（拖动时别抢）
  // done 时 ph=5：五枚阶段章全部标记为 done，不要点亮“落款”
  const ph = done ? PHASES.length : (st && st.fin ? 4 : (st && st.ph !== undefined ? st.ph : 1));
  setPhase(ph);
  if (selfChecking) return;          // 自检期间只冻结状态行，时钟/进度/阶段继续跟着走
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
  cancelFinishHold();
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
  cancelFinishHold();
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

// ---------------- 成品自检：空白点只读检查 ----------------
// 成品的每个像素都由管线规划好了；这里只做一次真实画布上的白点扫描，
// 报告"该有色却还是白的"像素数，**绝不追加笔画**。
// 两个"没涂上色"的口径：
//   ① 纸面根本没被涂上（WHITE_PAPER = 纯白）：原图明显不是白，却还是纯白；
//   ② 只被抗锯齿毛边蹭到 / 被浅色笔盖错（WHITE_CANVAS + 原图明显更深）。
// 另外先扣掉规划容差（省笔档允许每通道最多 tol 的浅色差），避免把"按计划画浅了"误报成白点。
const WHITE_PAPER = 254;
const WHITE_CANVAS = 244;
const WHITE_TARGET = 228;
const isWhite = (r, g, b, t) => r >= t && g >= t && b >= t;
function whiteDots(dest) {
  let im;
  try { im = (dest || painted).getContext('2d').getImageData(0, 0, W, H).data; }
  catch (e) { return []; }
  const tgt = target.data;
  // 颜色区/覆盖管线本身就允许每通道最多 tol 的色差（省笔档更大）：
  // 画布比原图浅、但差值仍在规划容差内的，是"按计划画对了"，不是白点。
  const tol = (STATS && STATS.quality && +STATS.quality.tolerance) || 0;
  const m = new Uint8Array(W * H);
  let any = 0;
  for (let p = 0; p < W * H; p++) {
    const q = p * 4;
    const cmn = Math.min(im[q], im[q + 1], im[q + 2]);
    const tmn = Math.min(tgt[q], tgt[q + 1], tgt[q + 2]);
    if (cmn - tmn <= tol + 3) continue;          // 规划内的浅色差：不算白点
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

// 成品自检：等回放画完，直接扫成品画布上的"该有色却是白色的"像素。
// 只读：白点数量只报告，不追加笔画（详见 finishSelfCheck）。
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
    selfChecking = true;
    // 画家模式的留白是画面的一部分（铅笔尤其），不能按"白点"报错；
    // 只确认回放确实画完了。
    if (STATS && STATS.quality && STATS.quality.artist) {
      cs.left = -1;
      finishSelfCheck();
      return;
    }
    const dots = whiteDots(cs.cv);
    cs.left = dots.length;
    finishSelfCheck();
  }
}
// 只读自检：白点数量只报告，绝不追加任何笔画。
// 成品的每个像素都由"颜色区"规划好了；如果还出现白点，那是规划/渲染的 bug，
// 应该去修根因，而不是在结尾偷偷补方点（用户明确反对这种做法）。
function finishSelfCheck() {
  const cs = checkState;
  if (!cs) return;
  checkState = null; selfChecking = false;
  checkMsg = cs.left < 0
    ? ''
    : ' · 成色自检 <em>' + (cs.left === 0 ? '0 个白点' : cs.left + ' 个白点残留') + '</em>';
  $('stat').innerHTML = (cs.head || $('stat').innerHTML) + checkMsg;
}

// ---------------- 收尾与差异 ----------------
function diffVsTarget() {
  const a = painted.getContext('2d').getImageData(0, 0, W, H).data;
  const b = target.data;
  let sum = 0, bad = 0;
  const tot = W * H * 3;
  for (let i = 0; i < a.length; i += 4) {
    let dm = 0;
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(a[i + k] - b[i + k]);
      if (d > dm) dm = d;
      sum += d;
    }
    if (dm > 24) bad++;
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
    let dm2 = 0;
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(d1[i + k] - d2[i + k]);
      if (d > dm2) dm2 = d;
      s2 += d;
    }
    if (dm2 > 24) b2++;
  }
  return { mean: sum / tot, badPct: bad / (W * H) * 100, mean4: s2 / t2, bad4: b2 / (w2 * h2) * 100 };
}

function cancelFinishHold() {
  if (finishHoldTimer) clearTimeout(finishHoldTimer);
  finishHoldTimer = 0;
  finishHoldStarted = 0;
}

// 自然播放到最后时不立刻切“画完了”，先让最后一笔在画面上停留；
// 拖动进度/看成品/导出属于用户主动结束，仍走即时 finish。
function finishWithHold() {
  if (done) return;
  if (!(finishHoldMs > 0)) { finish(); return; }
  if (finishHoldTimer) return;
  finishHoldStarted = performance.now();
  finishHoldTimer = setTimeout(() => {
    finishHoldTimer = 0;
    finishHoldStarted = 0;
    if (!done) finish();
  }, finishHoldMs);
}

function finish() {
  cancelFinishHold();
  done = true; playing = false; rushing = false; cursor = null; guide = null; airPath = null;
  $('play').textContent = '重播';
  setPhase(PHASES.length);           // 全部阶段标记完成，不要点亮“落款”
  const d = diffVsTarget();
  const artist = !!(STATS && STATS.quality && STATS.quality.artist);
  const dots = artist ? -1 : whiteDots().reduce((a, c) => a + c.n, 0);
  $('stat').innerHTML = '画完了 · <em>' + STROKES.length + '</em> 笔 · ' +
    (artist ? '成品逐像素差异' : '整体差异（1/4 缩放）') +
    ' 平均 <em>' + d.mean4.toFixed(2) + '/255</em>、可见差异 <em>' + d.bad4.toFixed(2) + '%</em>' +
    ' · 逐像素差异平均 ' + d.mean.toFixed(2) + '、可见 ' + d.badPct.toFixed(2) + '%' +
    (artist ? ' · 未覆盖 <em>' + ((STATS.quality && STATS.quality.uncovered) | 0) + '</em> 像素' : ' · 空白点 <em>' + dots + '</em> 个');
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
      // 掩膜直接用 1 位 PNG 编码器（packMask + png1bit），不再为 5 万个格子逐个
      // createElement('canvas') + toDataURL——那一步在标准档要 100 多秒。
      const clips = CLIPS.map((c) => {
        const packed = packMask(c.mask, c.w, c.h);
        return {
          x: c.x, y: c.y, w: c.w, h: c.h,
          mask: packed ? 'data:image/png;base64,' + b64FromBytes(png1bit(packed, c.w, c.h)) : null,
        };
      });
      const data = {
        format: 'image2strokes/1', W, H,
        colors: STATS.colors, photo: !!STATS.photo, style: STATS.style,
        fidelity: STATS.fidelity, durationSec: Math.round(STATS.totalMs / 1000), strokes: STROKES.length,
        seed: STATS.seed, exactMode: STATS.exactMode,
        note: '每条笔触：rib/tp 是平铺坐标数组（[x0,y0,x1,y1,…]），color 是纯色 RGB，' +
              'w 是笔宽，ms 是这一笔的时长，pen=1 表示硬笔尖；c 指向 clips 里的裁剪掩膜' +
              '（1 位 PNG：白色不透明=可以落色，透明=裁掉；mask 为 null = 整个外框都可画），' +
              '绘制时把 rib 多边形与掩膜求交再填 color 即可。',
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

/* ============ 导出：会画画的网页（HTML）+ 静态矢量图（SVG） ============ */

// 大文件提醒阈值：超过就先 confirm 一下再导（用户选的方案）
const EXP_WARN_MB = 30;
function maybeWarnSize(bytes, msg) {
  if (bytes <= EXP_WARN_MB * 1048576) return true;
  return confirm('导出文件约 ' + Math.round(bytes / 1048576) + ' MB，' + msg + ' 仍然导出吗？');
}

// 掩膜从“每像素 1 字节”压成“1 位一行”：每行行首留 1 字节给 PNG 过滤器（恒 0），
// 像素按高位在前打包。全 1（整格都可画）返回 null = 不需要裁剪。
// 这个格式一鱼两吃：HTML 播放器解包回 0/1 数组，SVG 直接当 1 位 PNG 的 IDAT 原始数据。
function packMask(mask, w, h) {
  const rb = (w + 7) >> 3;
  for (let i = 0; i < w * h; i++) if (!mask[i]) {
    const rows = new Uint8Array(h * (rb + 1));
    for (let y = 0; y < h; y++) {
      const o = y * (rb + 1) + 1, ro = y * w;
      for (let x = 0; x < w; x++) if (mask[ro + x]) rows[o + (x >> 3)] |= 0x80 >> (x & 7);
    }
    return rows;
  }
  return null;
}

function b64FromBytes(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

const PNG_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b, f, t) {
  let c = 0xffffffff;
  for (let i = f; i < t; i++) c = PNG_CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function adler32(b, f, t) {
  let a = 1, s = 0;
  for (let i = f; i < t; i++) { a = (a + b[i]) % 65521; s = (s + a) % 65521; }
  return ((s << 16) | a) >>> 0;
}

// 最小 1 位灰度 PNG 编码器。rows 是 packMask 的输出（本身就是“过滤器字节 + 打包行”），
// 塞进 IDAT 就是合法 PNG。idat 传了就用现成的 zlib 流（exportSvg 里用浏览器自带的
// CompressionStream 真 deflate，掩膜是成片的 0/FF，能再压 5~20 倍），没传就写 stored 块。
// 像素 1 = 白 = 可画（SVG mask 按亮度裁剪），0 = 黑 = 裁掉。
function png1bit(rows, w, h, idat) {
  const raw = rows.length;
  const nBlocks = Math.max(1, Math.ceil(raw / 65535));
  const zLen = idat ? idat.length : 2 + 5 * nBlocks + raw + 4;
  const out = new Uint8Array(8 + 25 + 12 + zLen + 12);
  const u32 = (o, v) => { out[o] = v >>> 24; out[o + 1] = (v >> 16) & 255; out[o + 2] = (v >> 8) & 255; out[o + 3] = v & 255; };
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  let o = 8;
  u32(o, 13); out.set([0x49, 0x48, 0x44, 0x52], o + 4);        // IHDR
  u32(o + 8, w); u32(o + 12, h);
  out[o + 16] = 1;                                             // 位深 1
  out[o + 17] = 0;                                             // 灰度
  out[o + 18] = 0; out[o + 19] = 0; out[o + 20] = 0;           // 压缩/过滤/隔行
  u32(o + 21, crc32(out, o + 4, o + 21));
  o += 25;
  u32(o, zLen); out.set([0x49, 0x44, 0x41, 0x54], o + 4);      // IDAT
  const z = o + 8, p = z + zLen;
  if (idat) {
    out.set(idat, z);
  } else {
    out[z] = 0x78; out[z + 1] = 0x01;
    let q = z + 2;
    for (let f = 0; f < raw; f += 65535) {
      const to = Math.min(raw, f + 65535), len = to - f;
      out[q] = (to >= raw) ? 1 : 0;
      out[q + 1] = len & 255; out[q + 2] = (len >> 8) & 255;
      out[q + 3] = ~len & 255; out[q + 4] = (~len >> 8) & 255;
      out.set(rows.subarray(f, to), q + 5);
      q += 5 + len;
    }
    u32(q, adler32(rows, 0, raw));
  }
  u32(p, crc32(out, o + 4, p));
  o = p + 4;
  u32(o, 0); out.set([0x49, 0x45, 0x4e, 0x44], o + 4);         // IEND
  u32(o + 8, 0xae426082);
  return out;
}

// 导出共用的精简数据：掩膜按内容去重 + 打包；笔划去掉用不到的 r/ly 字段；
// 回放节奏直接搬当前时间轴（cumMs/travels/beats），播放器不用再实现 buildTimeline。
function buildExportData() {
  const n = STROKES.length;
  const idxMap = new Map(), byKey = new Map(), clipsOut = [];
  for (let c = 0; c < CLIPS.length; c++) {
    const cl = CLIPS[c];
    const packed = packMask(cl.mask, cl.w, cl.h);
    const b64 = packed ? b64FromBytes(packed) : '';
    const key = cl.w + 'x' + cl.h + ':' + b64;
    let ni = byKey.get(key);
    if (ni === undefined) { ni = clipsOut.length; byKey.set(key, ni); clipsOut.push([cl.x, cl.y, cl.w, cl.h, b64]); }
    idxMap.set(c, ni);
  }
  const strokesOut = new Array(n);
  const sched = new Array(n * 2);
  for (let i = 0; i < n; i++) {
    const s = STROKES[i];
    strokesOut[i] = { rib: s.rib, tp: s.tp, w: s.w, color: s.color, pen: s.pen || 0, ph: s.ph, c: idxMap.get(s.c), fin: s.fin || 0, blk: s.blk || 0 };
    sched[i * 2] = Math.round(cumMs[i] + travels[i] + beats[i]);   // 这一笔开始落色
    sched[i * 2 + 1] = Math.round(cumMs[i + 1]);                   // 这一笔结束（含抬笔/停顿）
  }
  return {
    v: 1, W, H, n,
    keyEvery: Math.max(300, Math.ceil(n / 8)),
    totalMs: Math.round(cumMs[n] + finishHoldMs),
    phases: PHASES.slice(),
    clips: clipsOut, strokes: strokesOut, sched,
  };
}

/* 导出网页里的独立播放器：整个函数会被 toString() 进 HTML 里执行，
   所以它只准用 DATA 和自己内部定义的东西，不能引用本文件的任何全局。
   画笔逻辑（paintStroke/leadPath/掩膜裁剪）照搬本文件，保证导出页和本站看起来一样。 */
function exportedPlayer() {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));
  const W = DATA.W, H = DATA.H, N = DATA.n;
  const S = DATA.strokes;
  const sched = DATA.sched;                    // [paintStart, slotEnd] × n，累计毫秒
  const keyEvery = DATA.keyEvery;
  const total = sched[N * 2 - 1] || 0;
  const slotStart = (i) => (i ? sched[i * 2 - 1] : 0);
  const paintStart = (i) => sched[i * 2];
  const slotEnd = (i) => sched[i * 2 + 1];
  const PHASES = DATA.phases || ['铺底色', '铺色', '收形', '点睛', '落款'];

  const CLIPS = DATA.clips.map((c) => {
    const w = c[2], h = c[3], b64 = c[4];
    const mask = new Uint8Array(w * h);
    if (b64) {
      const bin = atob(b64), rb = (w + 7) >> 3;
      for (let y = 0; y < h; y++) {
        const ro = y * (rb + 1) + 1;
        for (let x = 0; x < w; x++) mask[y * w + x] = (bin.charCodeAt(ro + (x >> 3)) >> (7 - (x & 7))) & 1;
      }
    } else mask.fill(1);
    return { x: c[0], y: c[1], w: w, h: h, mask: mask };
  });

  const cv = $('cv'), mt = cv.getContext('2d');
  cv.width = W; cv.height = H;
  const painted = document.createElement('canvas'); painted.width = W; painted.height = H;
  const tmpC = document.createElement('canvas');           // 单笔合成：格子大小，按需长大
  const tmp = tmpC.getContext('2d');
  const clipCache = new Map();                 // 掩膜 ImageData 缓存（每格一次，全量）
  let maskC = null, mk = null;                 // 共用的格子级掩膜画布

  let idx = 0, acc = 0, done = false, playing = true, speed = 1, dragging = false;
  let pending = -1, pendRect = null;
  let cursor = null, guide = null, airPath = null;
  let keys = [];
  const lastEnd = [0, 0];

  function hash01(a, b) {
    const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return x - Math.floor(x);
  }
  function ribbonPath(st) {
    const p = new Path2D(), r = st.rib;
    p.moveTo(r[0], r[1]);
    for (let i = 2; i < r.length; i += 2) p.lineTo(r[i], r[i + 1]);
    p.closePath();
    return p;
  }
  // 拟人运笔的时间弯曲：真人一笔不是匀速——起笔收笔慢、中段快（minimum-jerk，
  // Flash & Hogan 1985），拐弯处还会减速（三分之二幂律 v∝r^(1/3)）。
  // 每笔缓存一个"时间→弧长占比"的查找表：播放进度 u 先过表再换算弧长，
  // 每笔总时长（ms）不变，只改快慢分布。成品像素不受影响（u≥1 画整笔）。
  const WARP_BINS = 24, WARP_SAMPLES = 40;
  function warpU(st, u) {
    if (st.__wpLin) return u;
    let w = st.__wp;
    if (!w) { w = buildWarp(st); st.__wp = w; }
    const f = u * (WARP_BINS - 1);
    const i = f | 0;
    if (i >= WARP_BINS - 1) return 1;
    return w[i] + (w[i + 1] - w[i]) * (f - i);
  }
  function buildWarp(st) {
    const lin = new Float64Array(WARP_BINS);
    for (let j = 0; j < WARP_BINS; j++) lin[j] = j / (WARP_BINS - 1);
    const tp = st.tp, n = tp.length / 2;
    if (n < 3) { st.__wpLin = true; return lin; }
    let totalLen = 0;
    for (let i = 1; i < n; i++) totalLen += Math.hypot(tp[i * 2] - tp[(i - 1) * 2], tp[i * 2 + 1] - tp[(i - 1) * 2 + 1]);
    if (totalLen < 14) { st.__wpLin = true; return lin; }   // 点睛微笔太短，看不出节奏
    const M = WARP_SAMPLES;
    const px = new Float64Array(M), py = new Float64Array(M);
    for (let i = 0; i < M; i++) {
      const want = totalLen * i / (M - 1);
      let run = 0;
      for (let k = 1; k < n; k++) {
        const ax = tp[(k - 1) * 2], ay = tp[(k - 1) * 2 + 1];
        const bx = tp[k * 2], by = tp[k * 2 + 1];
        const seg = Math.hypot(bx - ax, by - ay);
        if (run + seg >= want || k === n - 1) {
          const f = seg > 1e-6 ? (want - run) / seg : 0;
          px[i] = ax + (bx - ax) * f; py[i] = ay + (by - ay) * f;
          break;
        }
        run += seg;
      }
    }
    const rs = new Float64Array(M);
    for (let i = 0; i < M; i++) {
      const a = i > 0 ? i - 1 : i, c = i < M - 1 ? i + 1 : i;
      const A = Math.hypot(px[i] - px[c], py[i] - py[c]);
      const B = Math.hypot(px[a] - px[c], py[a] - py[c]);
      const C = Math.hypot(px[a] - px[i], py[a] - py[i]);
      const ar2 = Math.abs((px[i] - px[a]) * (py[c] - py[a]) - (px[c] - px[a]) * (py[i] - py[a])) * 2; // 4×面积
      rs[i] = ar2 > 1e-6 && A * B * C > 1e-9 ? A * B * C / ar2 : 1e9;   // 三点外接圆半径，直线段→∞
    }
    let cum = 0;
    const timeAt = new Float64Array(M);
    for (let i = 0; i < M; i++) {
      if (i > 0) {
        const seg = Math.hypot(px[i] - px[i - 1], py[i] - py[i - 1]);
        // 三分之二幂律（相对直线归一）：直段全速 1.0，弯段按绝对半径减速
        // （r≈30px → 0.44×，r≥400px ≈ 1.0）。混合笔里弯段占用更多归一化时间；
        // 纯匀曲率笔归一化后仍是线性，慢体现在管线的时长权重上（曲率项）。
        const curveK = Math.min(1, Math.max(0.32, 0.135 * Math.cbrt(rs[i])));
        const bell = 0.30 + 0.70 * Math.pow(Math.sin(Math.PI * i / (M - 1)), 0.9);
        cum += seg / (curveK * bell);
      }
      timeAt[i] = cum;
    }
    const total = cum || 1;
    const out = new Float64Array(WARP_BINS);
    let sI = 0;
    for (let j = 0; j < WARP_BINS; j++) {
      const t = j / (WARP_BINS - 1);
      while (sI < M - 2 && timeAt[sI + 1] / total < t) sI++;
      const t0 = timeAt[sI] / total, t1 = timeAt[sI + 1] / total;
      const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
      out[j] = Math.min(1, (sI + f) / (M - 1));
    }
    return out;
  }
  function tipAt(st, u) {
    const tp = st.tp, n = tp.length / 2;
    if (n < 2) return { x: tp[0], y: tp[1], dx: 1, dy: 0, single: true };
    let totalLen = 0;
    for (let i = 1; i < n; i++) totalLen += Math.hypot(tp[i * 2] - tp[(i - 1) * 2], tp[i * 2 + 1] - tp[(i - 1) * 2 + 1]);
    const want = warpU(st, clamp(u, 0, 1)) * totalLen;
    let run = 0;
    for (let i = 1; i < n; i++) {
      const ax = tp[(i - 1) * 2], ay = tp[(i - 1) * 2 + 1];
      const bx = tp[i * 2], by = tp[i * 2 + 1];
      const seg = Math.hypot(bx - ax, by - ay);
      if (run + seg >= want || i === n - 1) {
        const f = seg > 1e-6 ? (want - run) / seg : 1;
        const x = ax + (bx - ax) * f, y = ay + (by - ay) * f;
        const dx = bx - ax, dy = by - ay, ln = Math.hypot(dx, dy) || 1;
        return { x: x, y: y, dx: dx / ln, dy: dy / ln, single: false };
      }
      run += seg;
    }
    return { x: tp[0], y: tp[1], dx: 1, dy: 0, single: false };
  }
  function leadPath(t, st) {
    const behind = st.pen ? 0 : Math.max(2, st.w * 0.45);
    const spread = Math.max(4, st.w * 1.3);
    const seed = st.ms * 7 + st.tp.length;
    const p = new Path2D();
    const nx = -t.dy, ny = t.dx;
    const back = 4000;
    p.moveTo(t.x - t.dx * back + nx * spread, t.y - t.dy * back + ny * spread);
    for (let k = 1; k <= 12; k++) {
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
  function clipImageFor(c) {
    if (clipCache.has(c)) return clipCache.get(c);
    const cl = CLIPS[c];
    const id = new ImageData(cl.w, cl.h);
    const dd = id.data, m = cl.mask;
    for (let i = 0; i < m.length; i++) {
      dd[i * 4] = 255; dd[i * 4 + 1] = 255; dd[i * 4 + 2] = 255;
      dd[i * 4 + 3] = m[i] ? 255 : 0;
    }
    clipCache.set(c, id);
    return id;
  }
  function paintStroke(i, u) {
    const st = S[i];
    const cl = CLIPS[st.c];
    const t = tipAt(st, u);
    cursor = { x: t.x, y: t.y, r: Math.max(2.5, st.w * 0.5), pen: st.pen, color: st.color };
    guide = st.tp;
    if (st.blk && u <= 0) return false;
    const rgb = 'rgb(' + st.color[0] + ',' + st.color[1] + ',' + st.color[2] + ')';
    const rect = { x: cl.x, y: cl.y, w: cl.w, h: cl.h };
    if (tmpC.width < rect.w || tmpC.height < rect.h ||
        tmpC.width > rect.w * 2 || tmpC.height > rect.h * 2) {   // tmp 跟着格子缩放（详见主播放器的注释）
      tmpC.width = Math.max(1, rect.w);
      tmpC.height = Math.max(1, rect.h);
    }
    tmp.setTransform(1, 0, 0, 1, 0, 0);                 // 清格子必须在恒等变换下
    tmp.clearRect(0, 0, rect.w, rect.h);
    tmp.setTransform(1, 0, 0, 1, -rect.x, -rect.y);      // 之后画进格子局部坐标
    tmp.save();
    tmp.fillStyle = rgb;
    tmp.strokeStyle = rgb;
    if (st.blk || u >= 1) {
      const pth = ribbonPath(st);
      tmp.lineWidth = 1.4;
      tmp.lineJoin = 'round';
      tmp.lineCap = 'round';
      tmp.fill(pth);
      tmp.stroke(pth);
    } else {
      tmp.clip(ribbonPath(st));
      tmp.clip(leadPath(t, st));
      tmp.fillRect(rect.x, rect.y, rect.w, rect.h);
      tmp.restore();
      tmp.save();
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
    tmp.setTransform(1, 0, 0, 1, 0, 0);                 // 掩膜合成必须在恒等变换下
    if (!maskC) { maskC = document.createElement('canvas'); mk = maskC.getContext('2d'); }
    if (maskC.width !== tmpC.width || maskC.height !== tmpC.height) {   // 与 tmpC 同尺寸，否则 dest-in 会擦掉其余部分
      maskC.width = tmpC.width;
      maskC.height = tmpC.height;
    }
    mk.putImageData(clipImageFor(st.c), 0, 0);
    tmp.globalCompositeOperation = 'destination-in';
    tmp.drawImage(maskC, 0, 0);
    tmp.globalCompositeOperation = 'source-over';
    painted.getContext('2d').drawImage(tmpC, 0, 0, rect.w, rect.h, rect.x, rect.y, rect.w, rect.h);
    if (st.blk || u >= 1) {
      pending = -1; pendRect = null;
      lastEnd[0] = t.x; lastEnd[1] = t.y;
      return true;
    }
    pending = i; pendRect = rect;
    return false;
  }
  function travelTo(i, f) {
    const st = S[i], tp = st.tp;
    const ox = lastEnd[0], oy = lastEnd[1];
    const dx = tp[0] - ox, dy = tp[1] - oy;
    const d = Math.hypot(dx, dy) || 1;
    const bow = Math.min(46, d * 0.22);
    const mx = (ox + tp[0]) / 2 - dy / d * bow;
    const my = (oy + tp[1]) / 2 + dx / d * bow;
    const e = f * f * (3 - 2 * f);
    cursor = {
      x: (1 - e) * (1 - e) * ox + 2 * (1 - e) * e * mx + e * e * tp[0],
      y: (1 - e) * (1 - e) * oy + 2 * (1 - e) * e * my + e * e * tp[1],
      r: Math.max(2, st.w * 0.5), pen: st.pen, color: st.color, air: true,
    };
    airPath = [ox, oy, mx, my, tp[0], tp[1]];
    guide = null;
  }
  function endTravel() { airPath = null; }
  function uiScale() { return cv.clientWidth ? cv.clientWidth / W : 1; }
  function drawAir(ctx, p) {
    const inv = 1 / Math.max(0.2, uiScale());
    ctx.save();
    ctx.setLineDash([5, 7]);
    ctx.strokeStyle = 'rgba(70,70,82,0.22)';
    ctx.lineWidth = Math.max(1.1, 1.2 * inv);
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    ctx.quadraticCurveTo(p[2], p[3], p[4], p[5]);
    ctx.stroke();
    ctx.restore();
  }
  function drawCursor(ctx, c) {
    const inv = 1 / Math.max(0.2, uiScale());
    ctx.save();
    ctx.translate(c.x, c.y);
    if (c.air) {
      ctx.strokeStyle = 'rgba(45,45,54,0.55)';
      ctx.lineWidth = Math.max(1.1, 1.2 * inv);
      ctx.beginPath(); ctx.arc(0, 0, Math.max(3 * inv, c.r * 0.85), 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = 'rgba(45,45,54,0.45)';
      ctx.beginPath(); ctx.arc(0, 0, Math.max(1.6 * inv, c.r * 0.26), 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      return;
    }
    if (c.pen) {
      ctx.fillStyle = 'rgba(30,30,36,0.92)';
      ctx.beginPath();
      ctx.arc(0, 0, Math.max(2.6 * inv, c.r * 0.5), 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.strokeStyle = 'rgba(40,40,48,0.75)';
      ctx.lineWidth = Math.max(1.1, 1.3 * inv);
      ctx.beginPath(); ctx.arc(0, 0, Math.max(3.4 * inv, c.r * 1.15), 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = 'rgba(' + c.color[0] + ',' + c.color[1] + ',' + c.color[2] + ',0.85)';
      ctx.beginPath(); ctx.arc(0, 0, Math.max(1.9 * inv, c.r * 0.55), 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  function drawGuide(ctx, tp, c) {
    if (!c) return;
    const inv = 1 / Math.max(0.2, uiScale());
    ctx.save();
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = 'rgba(60,60,70,0.32)';
    ctx.lineWidth = Math.max(1.1, 1.2 * inv);
    ctx.beginPath();
    ctx.moveTo(tp[0], tp[1]);
    for (let i = 2; i < tp.length; i += 2) ctx.lineTo(tp[i], tp[i + 1]);
    ctx.stroke();
    ctx.restore();
  }
  function flushMain() {
    mt.setTransform(1, 0, 0, 1, 0, 0);
    mt.drawImage(painted, 0, 0);              // painted 永远是不透明白底，不必再垫一遍白
    if (pending >= 0 && !done && pendRect) {
      mt.drawImage(tmpC, 0, 0, pendRect.w, pendRect.h,
                   pendRect.x, pendRect.y, pendRect.w, pendRect.h);
    }
    if (cursor && !done) drawCursor(mt, cursor);
    if (guide && !done) drawGuide(mt, guide, cursor);
    if (airPath && !done) drawAir(mt, airPath);
  }
  function snapshotKey(i) {
    try { keys.push({ i: i, data: painted.getContext('2d').getImageData(0, 0, W, H) }); } catch (e) { /* 内存不足就放弃 */ }
  }
  function allKeys() { return keys; }
  function restoreKey(k, ctx) {
    ctx.putImageData(k.data, 0, 0);
  }
  function advanceTo(tgt) {
    while (idx < N && slotEnd(idx) <= tgt) {
      paintStroke(idx, 1);
      idx++;
      if (idx % keyEvery === 0 && idx < N) snapshotKey(idx);
    }
    if (idx >= N) { finish(); return; }
    acc = Math.max(0, tgt - slotStart(idx));
    const dur = Math.max(1, slotEnd(idx) - slotStart(idx));
    const ps = Math.max(0, paintStart(idx) - slotStart(idx));
    if (acc < ps) travelTo(idx, acc / Math.max(1, ps));
    else { endTravel(); paintStroke(idx, clamp((acc - ps) / Math.max(1, dur - ps), 0, 1)); }
  }
  function jumpTo(ms) {
    ms = clamp(ms, 0, total);
    const cur = done ? total : (slotStart(idx) + acc);
    if (ms >= cur - 50 && ms - cur < 45000 && !done) { advanceTo(ms); return; }
    const ctx = painted.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    let ci = 0;
    while (ci < N && slotEnd(ci) <= ms) ci++;
    let k = null;
    for (const kk of allKeys()) { if (kk.i <= ci) k = kk; else break; }
    if (k) restoreKey(k, ctx);
    else { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H); }
    done = false; idx = k ? k.i : 0; acc = 0;
    endTravel(); pending = -1; pendRect = null;
    if (N) {
      const tp = S[Math.max(0, idx - 1)].tp;
      lastEnd[0] = tp[tp.length - 2]; lastEnd[1] = tp[tp.length - 1];
    }
    advanceTo(ms);
  }
  function fmt(s) {
    s = Math.max(0, Math.round(s));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function hud() {
    const cur = done ? total : Math.min(total, slotStart(idx) + acc);
    const p = total > 0 ? cur / total : 0;
    $('clock').textContent = fmt(cur / 1000) + ' / ' + fmt(total / 1000);
    const sk = $('seek');
    if (sk && !dragging) sk.value = String(Math.round(p * 1000));
    if (done) { $('stat').textContent = '画完了 · ' + N + ' 笔'; return; }
    const st = S[Math.min(idx, N - 1)];
    const ph = st && st.fin ? 4 : clamp(st ? (st.ph | 0) : 0, 0, 3);
    $('stat').textContent = '阶段 ' + (PHASES[ph] || '') + ' · 第 ' + Math.min(idx + 1, N) + ' / ' + N +
      ' 笔 · ' + (p * 100).toFixed(0) + '%';
  }
  function finish() {
    done = true; playing = false; cursor = null; guide = null; airPath = null;
    endTravel(); pending = -1; pendRect = null;
    $('play').textContent = '重播';
    hud();
  }
  function resetPlayback() {
    idx = 0; acc = 0; done = false; cursor = null; guide = null; airPath = null;
    endTravel(); pending = -1; pendRect = null; keys = [];
    const ctx = painted.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
    if (N) { lastEnd[0] = S[0].tp[0]; lastEnd[1] = S[0].tp[1]; }
    playing = true;
    $('play').textContent = '暂停';
    $('stat').textContent = '准备开始…';
  }
  let lastT = performance.now(), lastTickAt = lastT;
  function tick() {
    const now = performance.now();
    lastTickAt = now;
    const dt = Math.min(100, now - lastT); lastT = now;
    if (playing && !done) {
      acc += dt * speed;
      let guard = 0;
      while (idx < N && guard++ < 400 && acc >= Math.max(1, slotEnd(idx) - slotStart(idx))) {
        acc -= Math.max(1, slotEnd(idx) - slotStart(idx));
        paintStroke(idx, 1);
        idx++;
        if (idx % keyEvery === 0 && idx < N) snapshotKey(idx);
        if (idx >= N) { finish(); break; }
      }
      if (idx < N && !done) {
        const dur = Math.max(1, slotEnd(idx) - slotStart(idx));
        const ps = Math.max(0, paintStart(idx) - slotStart(idx));
        if (acc < ps) travelTo(idx, acc / Math.max(1, ps));
        else { endTravel(); paintStroke(idx, clamp((acc - ps) / Math.max(1, dur - ps), 0, 1)); }
      }
    }
    flushMain();
    hud();
    schedule();
  }
  let tickQueued = false, tickQueuedAt = 0, tickGen = 0;
  function schedule() {
    const now = performance.now();
    if (tickQueued && now - tickQueuedAt < 250) return;   // 只排一次（详见主播放器的注释）
    tickQueued = true; tickQueuedAt = now;
    const gen = ++tickGen;
    const run = function () { if (gen !== tickGen) return; tickQueued = false; tick(); };
    if (document.hidden) setTimeout(run, 100);
    else requestAnimationFrame(run);
  }
  setInterval(function () {
    if (performance.now() - lastTickAt > 50) schedule();
  }, 50);
  function fitView() {
    const maxW = Math.min(1100, window.innerWidth - 24), maxH = window.innerHeight - 130;
    const s = Math.min(maxW / W, maxH / H, 1);
    cv.style.width = Math.max(120, Math.round(W * s)) + 'px';
    cv.style.height = Math.max(80, Math.round(H * s)) + 'px';
  }
  $('play').addEventListener('click', function () {
    if (done) { resetPlayback(); return; }
    playing = !playing;
    $('play').textContent = playing ? '暂停' : '播放';
  });
  $('replay').addEventListener('click', resetPlayback);
  const sk = $('seek');
  sk.addEventListener('input', function () { dragging = true; });
  sk.addEventListener('change', function () {
    dragging = false;
    jumpTo((+sk.value / 1000) * total);
  });
  $('spd').addEventListener('change', function (e) { speed = parseFloat(e.target.value) || 1; });
  window.addEventListener('keydown', function (e) {
    if (e.code === 'Space') { e.preventDefault(); $('play').click(); }
  });
  window.addEventListener('resize', fitView);
  fitView();
  resetPlayback();
  schedule();
}

// 会画画的网页：单文件，双击打开自动播放，带播放/暂停、进度条、速度、重播
async function exportHtml() {
  if (!STROKES.length) return;
  const btn = $('expHtml'), oldTxt = btn.textContent;
  btn.disabled = true; btn.textContent = '打包中…';
  $('expMsg').textContent = '正在打包网页…';
  try {
    await new Promise((r) => setTimeout(r, 30));
    const json = JSON.stringify(buildExportData()).replace(/</g, '\\u003c');
    const playerSrc = '(' + exportedPlayer.toString() + ')();';
    const head = '<!DOCTYPE html>\n<html lang="zh">\n<head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
      '<title>image2strokes · 回放</title>\n<style>\n' +
      'body{margin:0;background:#efece6;display:flex;flex-direction:column;align-items:center;min-height:100vh;' +
      'font:14px/1.5 system-ui,-apple-system,sans-serif;color:#333}\n' +
      '#wrap{flex:1;display:flex;align-items:center;justify-content:center;width:100%;padding:18px 12px 6px;box-sizing:border-box}\n' +
      'canvas{background:#fff;box-shadow:0 3px 18px rgba(0,0,0,.14);max-width:100%}\n' +
      '#bar{width:100%;max-width:1100px;box-sizing:border-box;display:flex;gap:10px;align-items:center;' +
      'padding:10px 16px 16px;flex-wrap:wrap}\n' +
      'button,select{padding:5px 14px;border:1px solid #c9c4ba;border-radius:8px;background:#fff;cursor:pointer;font-size:13px}\n' +
      'button:hover{border-color:#9b948a}\n' +
      '#seek{flex:1;min-width:160px;accent-color:#b0472e}\n' +
      '#clock{font-variant-numeric:tabular-nums;color:#666;white-space:nowrap;font-size:13px}\n' +
      '#stat{color:#888;font-size:12.5px}\n' +
      '</style>\n</head>\n<body>\n' +
      '<div id="wrap"><canvas id="cv"></canvas></div>\n' +
      '<div id="bar">\n' +
      '<button id="play">暂停</button>\n' +
      '<button id="replay">重播</button>\n' +
      '<span id="clock">0:00 / 0:00</span>\n' +
      '<input id="seek" type="range" min="0" max="1000" value="0">\n' +
      '<select id="spd"><option value="0.5">0.5×</option><option value="1" selected>1×</option>' +
      '<option value="2">2×</option><option value="4">4×</option><option value="8">8×</option>' +
      '<option value="10">10×</option></select>\n' +
      '<span id="stat">准备开始…</span>\n' +
      '</div>\n' +
      '<' + 'script>var DATA=';
    const size = head.length + json.length + 2 + playerSrc.length + 40;
    if (!maybeWarnSize(size, '打开会很慢、拖进度条也会卡（' + STROKES.length + ' 笔）。')) {
      $('expMsg').textContent = '已取消导出';
      return;
    }
    const blob = new Blob([head, json, ';\n', playerSrc, '\n<' + '/script>\n</body>\n</html>\n'],
                          { type: 'text/html' });
    download(blob, 'image2strokes-' + stamp() + '.html');
    $('expMsg').textContent = '网页已导出：' + (blob.size / 1048576).toFixed(1) + ' MB · ' + STROKES.length + ' 笔';
  } catch (e) {
    $('expMsg').textContent = '导出失败：' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = oldTxt;
  }
}

// 静态矢量图 SVG：每笔一条 path（填充 + 同款 1.4px 描边），
// 裁剪掩膜编成 1 位 PNG 塞进 <mask><image>，成品和画布渲染一致。
/* SVG 导出（矢量成品图）：每笔一条 <path>；裁剪掩膜内嵌成 1 位 PNG（浏览器自带的
   CompressionStream 真 deflate，掩膜是成片的 0/FF，比 stored 块再小 9~15 倍）；颜色
   收进 <style> 类（逐块平均的独占色内联反而更省）；路径用相对坐标省一半字节。
   另外很多笔的落色范围（rib + 0.75px 描边外沿）根本没伸出自己的掩膜——这种笔的
   掩膜引用整个省掉，没人用的掩膜定义也不写，文件还能再小一到两成。 */
// cover 模式的掩膜是"格子内的一组像素"，可以直接写成像素对齐的矩形路径（矢量、无位图掩膜）。
// 每行找连续段、上下同段合并成矩形；最终 <path> 的数就是 mask 的精确覆盖。
function maskRectsD(cl) {
  const w = cl.w, h = cl.h, m = cl.mask, bx = cl.x, by = cl.y;
  const rects = [], active = new Map();
  for (let yy = 0; yy < h; yy++) {
    let xx = 0;
    while (xx < w) {
      if (!m[yy * w + xx]) { xx++; continue; }
      const x0 = xx;
      while (xx < w && m[yy * w + xx]) xx++;
      const key = x0 * 4096 + xx;
      const r = active.get(key);
      if (r && r.y + r.h === by + yy) r.h++;
      else {
        const nr = { x0: bx + x0, x1: bx + xx, y: by + yy, h: 1 };
        rects.push(nr); active.set(key, nr);
      }
    }
  }
  const out = [];
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i], ww = r.x1 - r.x0;
    out.push('M' + r.x0 + ' ' + r.y + 'h' + ww + 'v' + r.h + 'h-' + ww + 'z');
  }
  return out.join('');
}

async function exportSvgCover() {
  const btn = $('expSvg'), oldTxt = btn.textContent;
  btn.disabled = true; btn.textContent = '打包中…';
  $('expMsg').textContent = '正在打包 SVG（矢量色块）…';
  try {
    await new Promise((r) => setTimeout(r, 30));
    const n = STROKES.length;
    const hex = (c) => '#' + ((1 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]).toString(16).slice(1);
    const colUse = new Map();
    for (let i = 0; i < n; i++) {
      const c = STROKES[i].color, key = c[0] + ',' + c[1] + ',' + c[2];
      colUse.set(key, (colUse.get(key) || 0) + 1);
    }
    const colIdx = new Map(), styles = [];
    for (const [key, cnt] of colUse) {
      if (cnt < 4) continue;
      const c = key.split(',');
      colIdx.set(key, colIdx.size);
      styles.push('.c' + colIdx.get(key) + '{fill:' + hex(c) + '}');
    }
    const parts = [];
    parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H +
      '" viewBox="0 0 ' + W + ' ' + H + '">\n');
    parts.push('<!-- image2strokes · ' + n + ' 笔 · 还原程度 ' + (STATS ? STATS.fidelity : '') +
      ' · 颜色区精确覆盖（像素对齐的矢量矩形） -->\n');
    parts.push('<rect width="' + W + '" height="' + H + '" fill="#fff"/>\n');
    parts.push('<style>' + styles.join('') + '</style>\n');
    for (let i = 0; i < n; i++) {
      const st = STROKES[i], cl = CLIPS[st.c];
      const d = maskRectsD(cl);
      const ck = st.color, key = ck[0] + ',' + ck[1] + ',' + ck[2];
      const colAttr = colIdx.has(key) ? ' class="c' + colIdx.get(key) + '"' : ' fill="' + hex(ck) + '"';
      parts.push('<path' + colAttr + ' d="' + d + 'z"/>\n');
      if ((i & 4095) === 0) {
        $('expMsg').textContent = '正在打包 SVG… ' + i + ' / ' + n;
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    parts.push('</svg>\n');
    const blob = new Blob(parts, { type: 'image/svg+xml' });
    if (!maybeWarnSize(blob.size, 'SVG 仍然导出吗？')) return;
    download(blob, 'image2strokes-' + stamp() + '.svg');
    $('expMsg').textContent = 'SVG 已导出：' + (blob.size / 1048576).toFixed(1) + ' MB';
  } catch (e) {
    $('expMsg').textContent = '导出失败：' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = oldTxt;
  }
}

async function exportSvg() {
  if (!STROKES.length) return;
  // 精确模式每笔都带"本笔实际落色像素"的掩膜，直接按掩膜发像素对齐矩形就是画布成品，
  // 不需要再把 ribbon 做 4× 子采样去反推掩膜（上万笔时那一步要跑好几分钟）。
  if (STATS && STATS.quality && (STATS.exactMode || CLIPS.length === STROKES.length)) return exportSvgCover();
  const btn = $('expSvg'), oldTxt = btn.textContent;
  btn.disabled = true; btn.textContent = '打包中…';
  $('expMsg').textContent = '正在打包 SVG…';
  try {
    await new Promise((r) => setTimeout(r, 30));
    const n = STROKES.length;

    // ---- ① 逐笔判定掩膜是否白挂 ----
    // 快路径：rib 外扩 1px 的包围盒里掩膜全 1 且都在格子内 → 必然不溢出，掩膜可省。
    // 慢路径（贴边/掩膜有洞）：4× 子采样光栅化 rib、膨胀 0.75px（盖住 1.4 描边外沿），
    // 落在掩膜外的子采样才真的需要掩膜。
    const useMask = new Uint8Array(n), useClip = new Uint8Array(n);
    const S4 = 4, R = 3;
    const packedOf = new Array(CLIPS.length);        // 每格打包一次（全 1 = null）
    for (let c = 0; c < CLIPS.length; c++) packedOf[c] = packMask(CLIPS[c].mask, CLIPS[c].w, CLIPS[c].h);
    let scratch = new Uint8Array(0), dilH = new Uint8Array(0);
    for (let i = 0; i < n; i++) {
      const st = STROKES[i], cl = CLIPS[st.c], rib = st.rib, np = rib.length / 2;
      let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
      for (let k = 0; k < rib.length; k += 2) {
        if (rib[k] < minx) minx = rib[k]; if (rib[k] > maxx) maxx = rib[k];
        if (rib[k + 1] < miny) miny = rib[k + 1]; if (rib[k + 1] > maxy) maxy = rib[k + 1];
      }
      const px0 = Math.floor(minx) - 1, py0 = Math.floor(miny) - 1;
      const px1 = Math.ceil(maxx) + 2, py1 = Math.ceil(maxy) + 2;
      // cover 模式的笔：rib 是覆盖整块格子掩膜的轴对齐矩形。掩膜一定不能省
      // （矩形会盖到掩膜外），直接标记后跳过慢路径；否则每笔 4× 子采样光栅化，
      // 5 万笔的 SVG 导出要一分多钟。
      const rectRib = np === 4 && rib[0] === rib[6] && rib[1] === rib[3] &&
                      rib[2] === rib[4] && rib[5] === rib[7];
      if (rectRib && minx <= cl.x && miny <= cl.y && maxx >= cl.x + cl.w && maxy >= cl.y + cl.h) {
        if (packedOf[st.c]) useMask[i] = 1; else useClip[i] = 1;
        continue;
      }
      const inCell = px0 >= cl.x && py0 >= cl.y && px1 <= cl.x + cl.w && py1 <= cl.y + cl.h;
      let need = true;
      if (inCell) {
        // 包围盒内的掩膜是否全 1（全 1 掩膜 packedOf 是 null，视作全 1）
        need = false;
        if (packedOf[st.c]) {
          for (let py = py0; py < py1 && !need; py++) {
            const row = (py - cl.y) * cl.w;
            for (let px = px0; px < px1; px++) if (!cl.mask[row + px - cl.x]) { need = true; break; }
          }
        }
      }
      if (!need) continue;                       // 快路径：掩膜/框都省掉
      // 慢路径：精确光栅化
      const x0 = px0, y0 = py0, wS = (px1 - px0) * S4, hS = (py1 - py0) * S4, total = wS * hS;
      if (total > 16 * 1048576) { useMask[i] = 1; useClip[i] = 1; continue; }   // 怪笔保守双挂
      if (scratch.length < total) { scratch = new Uint8Array(total); dilH = new Uint8Array(total); }
      scratch.fill(0, 0, total);
      for (let sy = 0; sy < hS; sy++) {
        const yc = y0 + (sy + 0.5) / S4, xs = [];
        for (let e = 0; e < np; e++) {
          const ax = rib[e * 2], ay = rib[e * 2 + 1];
          const bx = rib[((e + 1) % np) * 2], by = rib[((e + 1) % np) * 2 + 1];
          if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) xs.push(ax + (yc - ay) / (by - ay) * (bx - ax));
        }
        if (!xs.length) continue;
        xs.sort((a, b) => a - b);
        const row = sy * wS;
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const fa = Math.max(x0, xs[k]), fb = Math.min(px1, xs[k + 1]);
          if (fb <= fa) continue;
          let sa = Math.ceil((fa - x0) * S4 - 0.5), sb = Math.ceil((fb - x0) * S4 - 0.5) - 1;
          if (sa < 0) sa = 0; if (sb > wS - 1) sb = wS - 1;
          for (let sx = sa; sx <= sb; sx++) scratch[row + sx] = 1;
        }
      }
      dilH.fill(0, 0, total);
      for (let y = 0; y < hS; y++) {
        const row = y * wS;
        let run = 0;
        for (let x = 0; x < wS; x++) { if (scratch[row + x]) run = R + 1; else if (run > 0) run--; dilH[row + x] = run > 0 ? 1 : 0; }
        run = 0;
        for (let x = wS - 1; x >= 0; x--) { if (scratch[row + x]) run = R + 1; else if (run > 0) run--; if (run > 0) dilH[row + x] = 1; }
      }
      for (let x = 0; x < wS; x++) {
        let run = 0;
        for (let y = 0; y < hS; y++) { if (dilH[y * wS + x]) run = R + 1; else if (run > 0) run--; scratch[y * wS + x] = run > 0 ? 1 : 0; }
        run = 0;
        for (let y = hS - 1; y >= 0; y--) { if (dilH[y * wS + x]) run = R + 1; else if (run > 0) run--; if (run > 0) scratch[y * wS + x] = 1; }
      }
      let spillMask = false;
      for (let by = 0; by < hS && !spillMask; by += 4) {
        const py = y0 + (by >> 2), inCy = py >= cl.y && py < cl.y + cl.h;
        for (let bx = 0; bx < wS; bx += 4) {
          const px = x0 + (bx >> 2);
          const on = inCy && px >= cl.x && px < cl.x + cl.w &&
            (!packedOf[st.c] || cl.mask[(py - cl.y) * cl.w + px - cl.x] === 1);
          if (on) continue;
          for (let dy = 0; dy < 4 && !spillMask; dy++) {
            const row = (by + dy) * wS + bx;
            for (let dx = 0; dx < 4; dx++) if (scratch[row + dx]) { spillMask = true; break; }
          }
          if (spillMask) break;
        }
      }
      if (spillMask) {
        if (packedOf[st.c]) useMask[i] = 1; else useClip[i] = 1;   // 全 1 掩膜的“掩膜”就是格子框
      }
      if ((i & 4095) === 0) {
        $('expMsg').textContent = '正在打包 SVG… 检查掩膜 ' + i + ' / ' + n;
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    // ---- ② defs：只为仍被引用的裁剪建 ----
    const parts = [];
    parts.push('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
      'width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">\n');
    parts.push('<!-- image2strokes · ' + STROKES.length + ' 笔 · 还原程度 ' + (STATS ? STATS.fidelity : '') +
      ' · 路径为矢量，可无损放大 -->\n');
    parts.push('<rect width="' + W + '" height="' + H + '" fill="#fff"/>\n');
    parts.push('<defs>\n');
    const ref = new Array(CLIPS.length).fill('');
    const maskByKey = new Map(), rectByKey = new Map();
    let defN = 0;
    for (let i = 0; i < n; i++) {
      const c = STROKES[i].c;
      if (ref[c] || (!useMask[i] && !useClip[i])) continue;
      if (ref[c]) continue;
      const cl = CLIPS[c];
      if (useMask[i]) {
        const packed = packedOf[c];
        // 位置参与去重：mask 的坐标系钉在用户空间，同内容不同位置是两个不同的掩膜
        const b64 = b64FromBytes(packed);
        const key = cl.x + ',' + cl.y + ',' + cl.w + 'x' + cl.h + ':' + b64;
        let id = maskByKey.get(key);
        if (id === undefined) {
          id = maskByKey.size; maskByKey.set(key, id);
          let idat = null;
          if (window.CompressionStream) {
            try {
              const zs = new Blob([packed]).stream().pipeThrough(new CompressionStream('deflate'));
              idat = new Uint8Array(await new Response(zs).arrayBuffer());
            } catch (e) { idat = null; }      // 老浏览器没有就退回 stored 块，只是文件大一点
          }
          const url = 'data:image/png;base64,' + b64FromBytes(png1bit(packed, cl.w, cl.h, idat));
          // image-rendering 钉死最近邻：双线性会把 1 位掩膜边缘平均成半透明，渗白缝
          parts.push('<mask id="m' + id + '" maskUnits="userSpaceOnUse" x="' + cl.x + '" y="' + cl.y +
            '" width="' + cl.w + '" height="' + cl.h + '"><image x="' + cl.x + '" y="' + cl.y +
            '" image-rendering="pixelated" xlink:href="' + url + '"/></mask>\n');
          if ((++defN & 1023) === 0) {
            $('expMsg').textContent = '正在打包 SVG… 掩膜 ' + defN;
            await new Promise((r) => setTimeout(r, 0));
          }
        }
        ref[c] = ' mask="url(#m' + id + ')"';
      } else {
        // 全 1 掩膜不等于“不用裁”：rib 可能比框大（比如精修补笔是外框矩形），
        // SVG 这边用 clipPath 补上同一道边界
        const rk = cl.x + ',' + cl.y + ',' + cl.w + ',' + cl.h;
        let rid = rectByKey.get(rk);
        if (rid === undefined) {
          rid = rectByKey.size; rectByKey.set(rk, rid);
          parts.push('<clipPath id="r' + rid + '"><rect x="' + cl.x + '" y="' + cl.y +
            '" width="' + cl.w + '" height="' + cl.h + '"/></clipPath>\n');
        }
        ref[c] = ' clip-path="url(#r' + rid + ')"';
      }
    }
    parts.push('</defs>\n');
    // ---- ③ 颜色：常用的（≥4 笔）收进 <style> 类，独占色内联 ----
    const hex = (c) => '#' + ((1 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]).toString(16).slice(1);
    const colUse = new Map();
    for (let i = 0; i < n; i++) {
      const c = STROKES[i].color, key = c[0] + ',' + c[1] + ',' + c[2];
      colUse.set(key, (colUse.get(key) || 0) + 1);
    }
    const colIdx = new Map(), styles = [];
    for (const [key, cnt] of colUse) {
      if (cnt < 4) continue;
      const c = key.split(',');
      colIdx.set(key, colIdx.size);
      styles.push('.c' + colIdx.get(key) + '{fill:' + hex(c) + ';stroke:' + hex(c) + '}');
    }
    const f1 = (v) => {
      let t = (Math.round(v * 10) / 10).toString();
      if (t.endsWith('.0')) t = t.slice(0, -2);
      if (t === '-0') t = '0';
      if (t.startsWith('0.')) t = t.slice(1);
      else if (t.startsWith('-0.')) t = '-' + t.slice(2);
      return t;
    };
    parts.push('<style>.p{stroke-width:1.4;stroke-linejoin:round;stroke-linecap:round}' +
      styles.join('') + '</style>\n');
    // ---- ④ 路径 ----
    for (let i = 0; i < n; i++) {
      const st = STROKES[i], rib = st.rib;
      // 相对坐标 + 省略前导 0 + 负号自带分隔：数值本身不取整，精度和绝对坐标一致
      let d = 'm' + f1(rib[0]) + ' ' + f1(rib[1]);
      let px = rib[0], py = rib[1];
      for (let k = 2; k < rib.length; k += 2) {
        const dx = f1(rib[k] - px), dy = f1(rib[k + 1] - py);
        d += (dx.charCodeAt(0) === 45 ? '' : ' ') + dx + (dy.charCodeAt(0) === 45 ? '' : ' ') + dy;
        px = rib[k]; py = rib[k + 1];
      }
      const ck = st.color, key = ck[0] + ',' + ck[1] + ',' + ck[2];
      const colAttr = colIdx.has(key) ? ' class="p c' + colIdx.get(key) + '"'
        : ' class="p" fill="' + hex(ck) + '" stroke="' + hex(ck) + '"';
      const rp = (useMask[i] || useClip[i]) ? ref[st.c] : '';
      parts.push('<path' + colAttr + ' d="' + d + 'z"' + rp + '/>\n');
      if ((i & 8191) === 0) {
        $('expMsg').textContent = '正在打包 SVG… 笔画 ' + i + ' / ' + n;
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    parts.push('</svg>\n');
    let size = 0;
    for (const p of parts) size += p.length;
    if (!maybeWarnSize(size, '共 ' + STROKES.length + ' 个图层，浏览器能看，Figma/AI 这类软件可能带不动。')) {
      $('expMsg').textContent = '已取消导出';
      return;
    }
    const blob = new Blob(parts, { type: 'image/svg+xml' });
    download(blob, 'image2strokes-' + stamp() + '.svg');
    $('expMsg').textContent = 'SVG 已导出：' + (blob.size / 1048576).toFixed(1) + ' MB · ' + STROKES.length + ' 笔';
  } catch (e) {
    $('expMsg').textContent = '导出失败：' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = oldTxt;
  }
}

// ---------------- 交互 ----------------
function bindUI() {
  const dz = $('drop');
  const openPicker = () => { if (!extracting) $('file').click(); };
  /* 原来这个框只写了"点击或拖入"，但没有任何 click 处理器——点它没反应，只能靠示例图。
     注意 #file 就嵌在框里，它自己的 click 会冒泡回来，必须挡掉，否则选择器被打开两次 */
  dz.addEventListener('click', (e) => { if (e.target === $('file')) return; openPicker(); });
  dz.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.code === 'Space') { e.preventDefault(); openPicker(); }
  });
  $('file').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) loadFile(f);
    e.target.value = '';                     // 连续选同一张也能重新触发
  });

  /* 整页都接收拖放：落在选图框外也认；同时拦住浏览器默认行为——
     否则浏览器会把图片当页面打开，正在跑的东西全丢 */
  let dragDepth = 0;
  const mask = $('dropMask');
  const hasFile = (e) => e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0;
  const endDrag = () => { dragDepth = 0; if (mask) mask.classList.remove('on'); dz.classList.remove('over'); };
  window.addEventListener('dragenter', (e) => {
    if (!hasFile(e)) return;
    e.preventDefault(); dragDepth++;
    if (mask) mask.classList.add('on');
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFile(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) endDrag(); });
  window.addEventListener('drop', (e) => {
    if (!hasFile(e)) return;
    e.preventDefault();
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    endDrag();
    if (f) loadFile(f);
  });
  dz.addEventListener('dragenter', () => dz.classList.add('over'));
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));

  /* 粘贴上传：截完图 Ctrl/Cmd+V 直接进来 */
  window.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file' && items[i].type.indexOf('image/') === 0) {
        const f = items[i].getAsFile();
        if (f) { e.preventDefault(); loadFile(f); return; }
      }
    }
  });

  // 示例图：上面 3 个分类，下面缩略图（每类 3 张）。切换分类只换显示，不触发提炼。
  const sampleCats = document.querySelectorAll('#sampleCats [data-cat]');
  const sampleThumbs = document.querySelectorAll('#sampleThumbs [data-sample]');
  const showSampleCat = (cat) => {
    sampleCats.forEach((b) => {
      const on = b.getAttribute('data-cat') === cat;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    sampleThumbs.forEach((b) => {
      b.style.display = b.getAttribute('data-cat') === cat ? '' : 'none';
    });
  };
  sampleCats.forEach((b) => {
    b.addEventListener('click', () => showSampleCat(b.getAttribute('data-cat')));
  });
  if (sampleThumbs.length) showSampleCat(sampleCats.length ? sampleCats[0].getAttribute('data-cat') : 'ill');
  sampleThumbs.forEach((el) => {
    el.addEventListener('click', () => {
      if (extracting) { note('上一张还在提炼，等它跑完再换。', 'warn'); return; }
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => startExtract(fitImage(im));
      im.onerror = () => note('示例图加载失败，检查一下 samples/ 是否齐全。', 'err');
      im.src = el.getAttribute('data-sample');
    });
  });
  $('play').addEventListener('click', () => {
    if (done) { resetPlayback(); return; }
    playing = !playing;
    $('play').textContent = playing ? '暂停' : '继续';
  });
  $('speed').addEventListener('input', (e) => setSpeed(parseFloat(e.target.value)));
  // 还原程度滑杆：只改档位数字，读数用 ①~⑤ + 名字，别让人去数刻度
  const FID_LABEL = ['① 省笔', '② 简洁', '③ 标准', '④ 精细', '⑤ 极致'];
  const syncFid = () => {
    const el = $('fidelity');
    const v = el ? clamp(parseInt(el.value, 10) || 3, 1, 5) : 3;
    const out = $('fidVal');
    if (out) out.textContent = FID_LABEL[v - 1];
  };
  $('fidelity').addEventListener('input', syncFid);
  syncFid();
  // 算法选择：URL ?algo= 优先，其次记住上次选择。
  // 不记住的话每次刷新都会弹回默认的 artist（准确复刻），看起来就像"改动没生效/还是旧版"。
  const ALGO_KEY = 'isp.algo';
  const ALGO_OK = { artist: 1, painter: 1, compiler: 1, layer: 1, pyramid: 1 };
  const saveAlgo = (v) => { try { localStorage.setItem(ALGO_KEY, v); } catch (e) {} };
  const pickAlgo = () => {
    const sel = $('algo');
    if (!sel) return 'artist';
    const q = (new URLSearchParams(location.search).get('algo') || '').trim();
    if (ALGO_OK[q]) { sel.value = q; return q; }   // 本次访问临时固定，不覆盖已记住的选择
    let v = '';
    if (!v) {
      try { const s = localStorage.getItem(ALGO_KEY) || ''; if (ALGO_OK[s]) v = s; } catch (e) {}
    }
    if (!v) v = sel.value || 'artist';
    sel.value = v;
    saveAlgo(v);
    return v;
  };
  // 算法切换：标签立即换；已经选过图就原地重新提炼（目标像素还在 srcCanvas 里）
  const algoSel = $('algo');
  if (algoSel) {
    setAlgoPhases(pickAlgo());
    algoSel.addEventListener('change', () => {
      saveAlgo(algoSel.value);
      setAlgoPhases(algoSel.value);
      if (srcCanvas && !extracting) {
        note('已切换算法，重新提炼…', 'info');
        startExtract(srcCanvas);
      }
    });
  }
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
  $('toEnd').addEventListener('click', () => {           // 看成品：直接落成品画布
    if (!STROKES.length) return;
    if (done) { resetPlayback(); return; }
    if (PLAN) {
      // 管线已经把最终画布规划好了（每个像素都精确落在颜色区里）。
      // "看成品"本来就是看结果，直接把规划画布落到 painted，比逐笔重画 5 万笔快得多。
      const ctx = painted.getContext('2d');
      const img = ctx.createImageData(W, H);
      const dd = img.data;
      for (let i = 0, j = 0; i < PLAN.length; i += 3, j += 4) {
        dd[j] = PLAN[i]; dd[j + 1] = PLAN[i + 1]; dd[j + 2] = PLAN[i + 2]; dd[j + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      idx = STROKES.length; acc = 0; pending = -1; pendRect = null;
      cursor = null; guide = null; airPath = null;
      rushing = false; playing = false;
      finish();
      flushMain();
      return;
    }
    rushing = true; playing = true; $('play').textContent = '暂停';
    $('stat').textContent = '快进到成品…';
  });
  const jumpPhase = (el) => {                              // 点/按阶段名 → 跳到该阶段开头
    const ph = parseInt(el.getAttribute('data-ph'), 10);
    if (!STROKES.length || !cumMs) return;
    let i = 0;
    if (ph === 4) {
      while (i < STROKES.length && !STROKES[i].fin) i++;   // 落款：管线标了 fin 的最后一拨
    } else {
      while (i < STROKES.length && (STROKES[i].ph | 0) !== ph) i++;
    }
    if (i >= STROKES.length) return;
    playing = false; $('play').textContent = '继续';
    jumpTo(cumMs[i] / 1000);
  };
  document.querySelectorAll('#phases span').forEach((el) => {
    el.tabIndex = 0; el.setAttribute('role', 'button');
    el.addEventListener('click', () => jumpPhase(el));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.code === 'Space') { e.preventDefault(); jumpPhase(el); }
    });
  });
  $('cmp').addEventListener('change', () => {});
  $('tip').addEventListener('change', (e) => { showTip = e.target.checked; });
  $('guideChk').addEventListener('change', (e) => { showGuide = e.target.checked; });
  $('loupeChk').addEventListener('change', (e) => { showLoupe = e.target.checked; });
  $('expPng').addEventListener('click', exportPng);
  $('expVideo').addEventListener('click', () => { exportVideo(); });
  $('expJson').addEventListener('click', exportJson);
  $('expHtml').addEventListener('click', exportHtml);
  $('expSvg').addEventListener('click', exportSvg);
  $('clearCache').addEventListener('click', hardRefresh);

  const fmtSpeed = (v) => (Math.round(v * 100) / 100) + '×';
  const setSpeed = (v) => {
    speed = Math.max(1, Math.min(10, Math.round(v * 2) / 2));
    $('speed').value = String(speed);
    $('speedVal').textContent = fmtSpeed(speed);
  };
  const seekRel = (deltaSec) => {
    if (!STROKES.length || !cumMs) return;
    const total = STATS.totalMs / 1000;
    const cur = (done ? cumMs[STROKES.length] : (cumMs[idx] + acc)) / 1000;
    playing = false; $('play').textContent = '继续';
    jumpTo(Math.max(0, Math.min(total, cur + deltaSec)));
  };
  const TOGGLE = { KeyO: 'cmp', KeyT: 'tip', KeyG: 'guideChk', KeyL: 'loupeChk' };
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;                                  // 选图框自己处理掉的 Enter/Space 不再抢
    const t = e.target;
    if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;   // 别抢控件自己的按键
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Space') {
      if (STROKES.length) { e.preventDefault(); $('play').click(); }
      return;
    }
    if (TOGGLE[e.code]) {
      const el = $(TOGGLE[e.code]);
      el.checked = !el.checked; el.dispatchEvent(new Event('change')); e.preventDefault(); return;
    }
    if (!STROKES.length) return;
    if (e.code === 'ArrowLeft') { e.preventDefault(); seekRel(e.shiftKey ? -30 : -5); }
    else if (e.code === 'ArrowRight') { e.preventDefault(); seekRel(e.shiftKey ? 30 : 5); }
    else if (e.code === 'ArrowUp') { e.preventDefault(); setSpeed(speed + 0.5); }
    else if (e.code === 'ArrowDown') { e.preventDefault(); setSpeed(speed - 0.5); }
    else if (e.code === 'Home') { e.preventDefault(); seekRel(-1e9); playing = true; $('play').textContent = '暂停'; }
    else if (e.code === 'End') { e.preventDefault(); $('toEnd').click(); }
  });
}

function loadFile(f) {
  if (extracting) { note('上一张还在提炼，等它跑完再换。', 'warn'); return; }
  if (!f.type || f.type.indexOf('image/') !== 0) { note('这不是图片文件——支持 JPG / PNG / WEBP。', 'err'); return; }
  if (f.size > 25 * 1024 * 1024) {
    note('图片超过 25MB，先压一下再传（长边反正只会用到 1024px）。', 'err'); return;
  }
  const url = URL.createObjectURL(f);
  const im = new Image();
  im.onload = () => { note('', ''); startExtract(fitImage(im)); URL.revokeObjectURL(url); };
  im.onerror = () => { note('这张图片读不出来，换一张试试。', 'err'); URL.revokeObjectURL(url); };
  im.src = url;
}

// ---------------- 清缓存刷新 ----------------
// 本站是纯静态页，"缓存"只有浏览器 HTTP 缓存一层（没有 Service Worker / 本地存储）。
// 更新后如果还看到旧版，点页脚「清缓存刷新」：把本页用到的资源都按 cache:'reload'
// 强制重拉一遍（浏览器会拿新响应写回缓存），再带一个新时间戳参数重开页面
//（新 URL 必缓存未命中，保证文档本身也是新的）——效果等同 Ctrl+F5 强制刷新。
async function hardRefresh() {
  if (!confirm('清掉本站缓存并强制刷新？当前画到一半的过程会重置。')) return;
  if (location.protocol.indexOf('http') === 0) {
    const urls = performance.getEntriesByType('resource')
      .map((e) => e.name).filter((u) => u.indexOf(location.origin) === 0);
    if (urls.length) await Promise.all(urls.map((u) => fetch(u, { cache: 'reload' }).catch(() => {})));
  }
  try { localStorage.clear(); } catch (e) {}
  try { sessionStorage.clear(); } catch (e) {}
  if (window.caches) {
    try {
      const ks = await caches.keys();
      await Promise.all(ks.map((k) => caches.delete(k)));
    } catch (e) {}
  }
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
  } catch (e) {}
  location.replace(location.pathname + '?r=' + Date.now() + location.hash);
}

bindUI();
schedule();
// 版本戳：标签页标题带 b70 = 已在跑最新代码（排查缓存问题用）
document.title += ' · b79';
