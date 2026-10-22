// 盒式模糊 A/B 微基准：新旧两版实现在同一份数据上跑，避开整条管线的机器抖动
// 用法: node dev/bench_blur.mjs [W] [H] [重复次数]
const W = +(process.argv[2] || 1024), H = +(process.argv[3] || 1024), REP = +(process.argv[4] || 5);
const N = W * H;
const rnd = (() => { let s = 12345; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; })();
const cr = new Float32Array(N), cg = new Float32Array(N), cb = new Float32Array(N);
for (let i = 0; i < N; i++) { cr[i] = rnd() * 255; cg[i] = rnd() * 255; cb[i] = rnd() * 255; }

function blurOld(cr, cg, cb) {
  for (let it = 0; it < 4; it++) {
    const nr = new Float32Array(cr), ng = new Float32Array(cg), nb = new Float32Array(cb);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        let sr = 0, sg = 0, sb = 0, cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= W) continue;
            const q = yy * W + xx;
            sr += cr[q]; sg += cg[q]; sb += cb[q]; cnt++;
          }
        }
        nr[p] = sr / cnt; ng[p] = sg / cnt; nb[p] = sb / cnt;
      }
    }
    cr.set(nr); cg.set(ng); cb.set(nb);
  }
  return [cr, cg, cb];
}

function blurNew(cr, cg, cb) {
  let curR = cr, curG = cg, curB = cb;
  let nxtR = new Float32Array(N), nxtG = new Float32Array(N), nxtB = new Float32Array(N);
  const generic = (x, y) => {
    const p = y * W + x;
    let sr = 0, sg = 0, sb = 0, cnt = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy; if (yy < 0 || yy >= H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx; if (xx < 0 || xx >= W) continue;
        const q = yy * W + xx;
        sr += curR[q]; sg += curG[q]; sb += curB[q]; cnt++;
      }
    }
    nxtR[p] = sr / cnt; nxtG[p] = sg / cnt; nxtB[p] = sb / cnt;
  };
  for (let it = 0; it < 4; it++) {
    if (W >= 3 && H >= 3) {
      for (let y = 1; y < H - 1; y++) {
        const yc = y * W;
        for (let x = 1; x < W - 1; x++) {
          const p = yc + x;
          let sr = 0, sg = 0, sb = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const row = yc + dy * W;
            for (let dx = -1; dx <= 1; dx++) { const q = row + x + dx; sr += curR[q]; sg += curG[q]; sb += curB[q]; }
          }
          nxtR[p] = sr / 9; nxtG[p] = sg / 9; nxtB[p] = sb / 9;
        }
      }
      for (let x = 0; x < W; x++) { generic(x, 0); generic(x, H - 1); }
      for (let y = 1; y < H - 1; y++) { generic(0, y); generic(W - 1, y); }
    } else {
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) generic(x, y);
    }
    { const t = curR; curR = nxtR; nxtR = t; }
    { const t = curG; curG = nxtG; nxtG = t; }
    { const t = curB; curB = nxtB; nxtB = t; }
  }
  if (curR !== cr) { cr.set(curR); cg.set(curG); cb.set(curB); }
  return [cr, cg, cb];
}

// 先各跑一次预热
let a = blurOld(cr.slice(), cg.slice(), cb.slice());
let b = blurNew(cr.slice(), cg.slice(), cb.slice());
let diff = 0, mx = 0;
for (let i = 0; i < N; i++) {
  for (const [u, v] of [[a[0][i], b[0][i]], [a[1][i], b[1][i]], [a[2][i], b[2][i]]]) {
    if (u !== v) { diff++; const d = Math.abs(u - v); if (d > mx) mx = d; }
  }
}
console.log(`逐位对比：不同的通道值 ${diff} / ${N * 3}   最大差 ${mx}`);

let tOld = Infinity, tNew = Infinity;
for (let i = 0; i < REP; i++) {
  let t = Date.now(); blurOld(cr.slice(), cg.slice(), cb.slice()); tOld = Math.min(tOld, Date.now() - t);
  t = Date.now(); blurNew(cr.slice(), cg.slice(), cb.slice()); tNew = Math.min(tNew, Date.now() - t);
}
console.log(`旧版 ${(tOld / 1000).toFixed(2)}s   新版 ${(tNew / 1000).toFixed(2)}s   提速 ${(tOld / tNew).toFixed(2)}×（${W}x${H}，取 ${REP} 次最小值）`);
