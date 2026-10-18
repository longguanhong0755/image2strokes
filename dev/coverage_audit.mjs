// 主笔覆盖率审计（第 0 步基线）：
//   每个面积 ≥300 的对象，"主笔"（layerCheck 之前那些笔）按**与落笔同口径**（覆盖率 ≥coverMin
//   且过裁剪掩膜）能盖住自己掩膜的百分之多少；盖不住的部分就是靠 layerCheck 的"矩形补丁笔"事后补的。
//   用户看到的"中途没涂满"= 主笔覆盖率低；"补丁飞舞"= 补丁笔占比高。
// ⚠️ 必须跑 dropDead:false：收尾的删笔会把 strokes 数组重排，dbg.layers 的 from/to、gapAt、
//    layerEnds 全是"删笔前"的笔号，在成品上读就是错位的（本脚本强制 dropDead:false）。
// 用法: node dev/coverage_audit.mjs dev/s3.raw ['{"opts"}'] [最小面积=300]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(path.join(here, '..', 'js/pipeline.js')).href);

const buf = fs.readFileSync(process.argv[2]);
const W = buf.readInt32LE(0), H = buf.readInt32LE(4);
const px = new Uint8ClampedArray(buf.buffer, buf.byteOffset + 8, W * H * 4);
const N = W * H;
const extra = process.argv[3] ? JSON.parse(process.argv[3]) : {};
const minArea = process.argv[4] ? parseInt(process.argv[4], 10) : 300;
const R = new Uint8Array(N), G = new Uint8Array(N), B = new Uint8Array(N);
for (let i = 0; i < N; i++) { R[i] = px[i * 4]; G[i] = px[i * 4 + 1]; B[i] = px[i * 4 + 2]; }

const t0 = Date.now();
const res = await globalThis.ISP_PIPELINE.run(px, W, H, Object.assign({ colors: 0, returnCanvas: true, debug: true, dumpMasks: true, dropDead: false }, extra), () => {});
const U = globalThis.ISP_PIPELINE._u;
const { strokes, clips } = res;
const coverMin = 0.7;
const D = res.dbg.dumpMasks || [];
const layers = res.dbg.layers || [];
const gapAt = res.dbg.gapAt || {};
console.log(`笔 ${strokes.length}  层 ${D.length}  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s  opts=${JSON.stringify(extra)}`);

// 覆盖率光栅（与网页端/管线同口径）：把这一笔真正"画上"的像素回调出去
const covBuf = { m: null, w: 0, h: 0 };
function forEachCovered(st, cb) {
  const cl = clips[st.c], rib = st.rib, np = rib.length >> 1;
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  for (let i = 0; i < np; i++) {
    const x = rib[i * 2], y = rib[i * 2 + 1];
    if (x < xmin) xmin = x; if (x > xmax) xmax = x;
    if (y < ymin) ymin = y; if (y > ymax) ymax = y;
  }
  const bx = Math.max(cl.x, Math.floor(xmin)), by = Math.max(cl.y, Math.floor(ymin));
  const ex = Math.min(cl.x + cl.w - 1, Math.ceil(xmax)), ey = Math.min(cl.y + cl.h - 1, Math.ceil(ymax));
  if (ex < bx || ey < by) return;
  const w = ex - bx + 1, h = ey - by + 1;
  if (covBuf.w < w || covBuf.h < h) {
    covBuf.w = Math.max(w, covBuf.w); covBuf.h = Math.max(h, covBuf.h);
    covBuf.m = new Float32Array(covBuf.w * covBuf.h);
  }
  const m = covBuf.m, mw = covBuf.w;
  for (let y = 0; y < h; y++) m.fill(0, y * mw, y * mw + w);   // stride 是 mw
  const p2 = new Float64Array(np * 2);
  for (let k = 0; k < np; k++) { p2[k * 2] = rib[k * 2] - bx; p2[k * 2 + 1] = rib[k * 2 + 1] - by; }
  U.fillPolyCov(m, mw, h, p2, 2);
  for (let y = 0; y < h; y++) {
    const gy = by + y, rowC = (gy - cl.y) * cl.w, row = y * mw;
    for (let x = 0; x < w; x++) {
      if (m[row + x] < coverMin) continue;
      const gx = bx + x;
      if (!cl.mask[rowC + (gx - cl.x)]) continue;
      cb(gy * W + gx);
    }
  }
}

// 每个对象：主笔对自己掩膜（own=可见、full=完整形状）的覆盖率 + 补丁笔数
const rows = [];
let totPatch = 0, totMain = 0;
for (let oi = 0; oi < D.length; oi++) {
  const L = layers[oi];
  if (!L || L.area < minArea) continue;
  const from = L.from, to = L.to;
  const gAt = gapAt[oi] !== undefined ? gapAt[oi] : to;   // ≥gAt 的都是 layerCheck 补丁笔
  const own = D[oi].own, full = D[oi].full;
  const covOwn = new Uint8Array(own.w * own.h), covFull = new Uint8Array(full.w * full.h);
  let nMain = 0, nPatch = 0;
  for (let i = from; i < to; i++) {
    const isPatch = i >= gAt;
    if (isPatch) nPatch++; else nMain++;
    if (isPatch) continue;          // 覆盖率只看"主笔"：补丁是事后兜底，不该算进"这一层自己画满了"
    forEachCovered(strokes[i], (gp) => {
      const x = gp % W, y = (gp - x) / W;
      if (x >= own.x0 && x < own.x0 + own.w && y >= own.y0 && y < own.y0 + own.h) covOwn[(y - own.y0) * own.w + (x - own.x0)] = 1;
      if (x >= full.x0 && x < full.x0 + full.w && y >= full.y0 && y < full.y0 + full.h) covFull[(y - full.y0) * full.w + (x - full.x0)] = 1;
    });
  }
  let nOwn = 0, cOwn = 0, nFull = 0, cFull = 0;
  for (let i = 0; i < own.m.length; i++) if (own.m[i]) { nOwn++; if (covOwn[i]) cOwn++; }
  for (let i = 0; i < full.m.length; i++) if (full.m[i]) { nFull++; if (covFull[i]) cFull++; }
  totPatch += nPatch; totMain += nMain;
  rows.push({
    oi, area: L.area, linear: L.linear, thick: L.thick, paper: L.paper, bbox: L.bbox,
    nOwn, covOwn: nOwn ? cOwn / nOwn : 1, missOwn: nOwn - cOwn,
    nFull, covFull: nFull ? cFull / nFull : 1, missFull: nFull - cFull,
    nMain, nPatch, from, to,
  });
}

rows.sort((a, b) => a.covOwn - b.covOwn || b.area - a.area);
const bad = rows.filter((r) => r.covOwn < 0.97);
console.log(`\n面积≥${minArea} 的对象 ${rows.length} 个；主笔覆盖率 <97% 的 ${bad.length} 个`);
console.log(`补丁笔合计 ${totPatch} / 总笔 ${totPatch + totMain}（主笔 ${totMain}） = ${(totPatch / (totPatch + totMain) * 100).toFixed(2)}%`);
console.log(`\n主笔覆盖率最低的 20 个：`);
console.log('  oi | 面积 | 细长 | 厚 | 掩膜 | 主笔覆盖 | 缺(own) | 缺(full) | 主笔 | 补丁 | 补丁占比');
for (const r of rows.slice(0, 20)) {
  console.log(`  ${String(r.oi).padStart(3)} | ${String(r.area).padStart(6)} | ${r.linear ? ' 是 ' : ' 否 '} | ${String(r.thick).padStart(4)} | ${String(r.nOwn).padStart(5)} | ${(r.covOwn * 100).toFixed(2).padStart(7)}% | ${String(r.missOwn).padStart(7)} | ${String(r.missFull).padStart(8)} | ${String(r.nMain).padStart(4)} | ${String(r.nPatch).padStart(4)} | ${r.nMain + r.nPatch ? (r.nPatch / (r.nMain + r.nPatch) * 100).toFixed(0) : 0}%`);
}
console.log(`\n补丁占比最高的 12 个（笔数≥10）：`);
const byPatch = rows.filter((r) => r.nMain + r.nPatch >= 10).sort((a, b) => (b.nPatch / (b.nMain + b.nPatch)) - (a.nPatch / (a.nMain + a.nPatch)));
for (const r of byPatch.slice(0, 12)) {
  console.log(`  oi ${String(r.oi).padStart(3)} 面积${String(r.area).padStart(6)} 细长${r.linear ? 1 : 0} 主笔${String(r.nMain).padStart(4)} 补丁${String(r.nPatch).padStart(4)} = ${(r.nPatch / (r.nMain + r.nPatch) * 100).toFixed(0)}%  主笔覆盖 ${(r.covOwn * 100).toFixed(1)}%`);
}
// 专项：海报的飞机(#3)与 S(#7)、以及所有细长层汇总
const lin = rows.filter((r) => r.linear);
console.log(`\n细长层 ${lin.length} 个：主笔覆盖率中位 ${(lin.map((r) => r.covOwn).sort((a, b) => a - b)[lin.length >> 1] * 100).toFixed(1)}%，合计缺 ${lin.reduce((s, r) => s + r.missOwn, 0)} px，补丁 ${lin.reduce((s, r) => s + r.nPatch, 0)} 支`);
const nonlin = rows.filter((r) => !r.linear);
console.log(`非细长层 ${nonlin.length} 个：主笔覆盖率中位 ${(nonlin.map((r) => r.covOwn).sort((a, b) => a - b)[nonlin.length >> 1] * 100).toFixed(1)}%，合计缺 ${nonlin.reduce((s, r) => s + r.missOwn, 0)} px，补丁 ${nonlin.reduce((s, r) => s + r.nPatch, 0)} 支`);
for (const oi of [3, 7]) {
  const r = rows.find((x) => x.oi === oi);
  if (r) console.log(`oi ${oi}（${oi === 3 ? '飞机' : 'first 的 S'}）：面积 ${r.area} 细长${r.linear ? 1 : 0} 厚${r.thick} 主笔${r.nMain}支 覆盖 ${(r.covOwn * 100).toFixed(2)}%（缺 ${r.missOwn}px）补丁${r.nPatch}支`);
}

// 明细：DETAIL=<oi> 时把这层每一支笔的笔形外框 / 裁剪框 / 在这层掩膜里盖到几像素打出来
if (process.env.INDEXMAP !== undefined) {
  const dup = new Map();
  for (let i = 0; i < D.length; i++) {
    const k = layers[i].from + ':' + layers[i].to;
    if (!dup.has(k)) dup.set(k, []);
    dup.get(k).push(i);
  }
  const bad = [...dup.entries()].filter(([, v]) => v.length > 1);
  console.log(`\n索引对照：dumpMasks ${D.length} 项，layers ${layers.length} 项，nObj=${res.dbg.nObj !== undefined ? res.dbg.nObj : '?'}，笔 ${strokes.length}`);
  console.log(`  笔区间重复的索引组 ${bad.length} 组（前 10）：` + bad.slice(0, 10).map(([k, v]) => `[${k}]→${v.join('/')}`).join('  '));
  const show = (process.env.INDEXMAP === '1' ? [3, 7, 34, 39, 59] : process.env.INDEXMAP.split(',').map(Number));
  const trace = res.dbg.paintTrace || [];
  console.log(`  paintTrace 长度 ${trace.length}`);
  for (let k = 0; k < trace.length; k++) {
    const t = trace[k];
    if (!show.includes(t.oi)) continue;
    console.log(`   trace[${k}] oi=${t.oi} 笔[${t.from},${t.to}) 面积${t.area} 细长${t.linear ? 1 : 0} 首笔ly=${t.ly0}`);
  }
  for (const i of show) {
    const L = layers[i];
    if (!L) { console.log(`  idx ${i} 无`); continue; }
    const first = L.from < L.to ? strokes[L.from] : null;
    console.log(`  idx ${String(i).padStart(3)}: L.oi=${String(L.oi).padStart(3)} D.oi=${D[i] ? D[i].oi : '?'} 笔[${L.from},${L.to}) 面积${L.area} 细长${L.linear ? 1 : 0} 色${D[i] ? D[i].color.join(',') : '?'} own(${D[i] ? D[i].own.x0 + ',' + D[i].own.y0 + ' ' + D[i].own.w + 'x' + D[i].own.h : '?'}) 首笔ly=${first ? first.ly : '-'} 首笔色=${first ? first.color.join(',') : '-'} 首笔c=${first ? first.c : '-'}`);
  }
}
if (process.env.LINEINFO !== undefined) {
  const want = process.env.LINEINFO.split(',').map(Number);
  const li = res.dbg.lineInfo || [];
  console.log(`
lineInfo 共 ${li.length} 条；oi ∈ {${want.join(',')}} 的：`);
  for (const e of li) if (want.includes(e.oi)) {
    console.log(`  oi ${e.oi}: 块 ${e.w}x${e.h} 掩膜${e.mask} 覆盖${e.cov} 剩${e.left} 路径点${e.pts} 骨架点${e.raw}`);
  }
  const tot = new Map();
  for (const e of li) { const t = tot.get(e.oi) || { n: 0, mask: 0, cov: 0, left: 0 }; t.n++; t.mask += e.mask; t.cov += e.cov; t.left += e.left; tot.set(e.oi, t); }
  const bad = [...tot.entries()].filter(([, t]) => t.left > 0).sort((a, b) => b[1].left - a[1].left).slice(0, 12);
  console.log(`
细长层里"循环结束时还剩没盖到"的 TOP12（oi: 迭代数 掩膜/覆盖/剩余）：`);
  for (const [oi2, t] of bad) console.log(`  oi ${oi2}: ${t.n} 次  掩膜${t.mask} 覆盖${t.cov} 剩${t.left}`);
}
if (process.env.DETAIL !== undefined) {
  for (const oiS of process.env.DETAIL.split(',')) {
    const oi = +oiS;
    const L = layers[oi];
    if (!L) { console.log(`oi ${oi} 不存在`); continue; }
    const own = D[oi].own, full = D[oi].full;
    console.log(`\n=== 明细 oi ${oi}  面积${L.area} 细长${L.linear ? 1 : 0} 厚${L.thick} 纸底${L.paper ? 1 : 0} 色${D[oi].color.join(',')} 笔[${L.from},${L.to}) 补丁起于 ${gapAt[oi] !== undefined ? gapAt[oi] : '（无）'}`);
    console.log(`   own 外框 (${own.x0},${own.y0}) ${own.w}x${own.h}   full 外框 (${full.x0},${full.y0}) ${full.w}x${full.h}`);
    const covOwn = new Uint8Array(own.w * own.h);
    for (let i = L.from; i < L.to; i++) {
      const st = strokes[i], cl = clips[st.c];
      let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
      for (let k = 0; k < (st.rib.length >> 1); k++) {
        const x = st.rib[k * 2], y = st.rib[k * 2 + 1];
        if (x < xmin) xmin = x; if (x > xmax) xmax = x; if (y < ymin) ymin = y; if (y > ymax) ymax = y;
      }
      let hit = 0, hitBin = 0;
      {  // 对照：二值偶奇口径（管线内部"扣掉已盖"用的就是它）
        const cl2 = clips[st.c], rib2 = st.rib, np2 = rib2.length >> 1;
        let xa = Infinity, ya = Infinity, xb = -Infinity, yb = -Infinity;
        for (let k2 = 0; k2 < np2; k2++) { const x2 = rib2[k2 * 2], y2 = rib2[k2 * 2 + 1];
          if (x2 < xa) xa = x2; if (x2 > xb) xb = x2; if (y2 < ya) ya = y2; if (y2 > yb) yb = y2; }
        const bx2 = Math.max(cl2.x, Math.floor(xa)), by2 = Math.max(cl2.y, Math.floor(ya));
        const ex2 = Math.min(cl2.x + cl2.w - 1, Math.ceil(xb)), ey2 = Math.min(cl2.y + cl2.h - 1, Math.ceil(yb));
        if (ex2 >= bx2 && ey2 >= by2) {
          const w2 = ex2 - bx2 + 1, h2 = ey2 - by2 + 1;
          const m2 = new Uint8Array(w2 * h2);
          const p3 = new Float64Array(np2 * 2);
          for (let k2 = 0; k2 < np2; k2++) { p3[k2 * 2] = rib2[k2 * 2] - bx2; p3[k2 * 2 + 1] = rib2[k2 * 2 + 1] - by2; }
          U.fillPoly(m2, w2, h2, p3);
          for (let y2 = 0; y2 < h2; y2++) {
            const gy2 = by2 + y2, rowC2 = (gy2 - cl2.y) * cl2.w;
            for (let x2 = 0; x2 < w2; x2++) {
              if (!m2[y2 * w2 + x2]) continue;
              const gx2 = bx2 + x2;
              if (!cl2.mask[rowC2 + (gx2 - cl2.x)]) continue;
              if (gx2 < own.x0 || gx2 >= own.x0 + own.w || gy2 < own.y0 || gy2 >= own.y0 + own.h) continue;
              const kk = (gy2 - own.y0) * own.w + (gx2 - own.x0);
              if (own.m[kk] && !covOwn[kk]) hitBin++;
            }
          }
        }
      }
      const before = covOwn.reduce ? 0 : 0;
      forEachCovered(st, (gp) => {
        const x = gp % W, y = (gp - x) / W;
        if (x >= own.x0 && x < own.x0 + own.w && y >= own.y0 && y < own.y0 + own.h) {
          const k = (y - own.y0) * own.w + (x - own.x0);
          if (own.m[k] && !covOwn[k]) { covOwn[k] = 1; hit++; }
        }
      });
      console.log(`  #${i} ${i >= (gapAt[oi] !== undefined ? gapAt[oi] : L.to) ? '补' : '主'} 笔形框(${xmin.toFixed(0)},${ymin.toFixed(0)})..(${xmax.toFixed(0)},${ymax.toFixed(0)}) 裁剪(${cl.x},${cl.y})${cl.w}x${cl.h} w${st.w} 色${st.color.join(',')} 点${st.tp.length >> 1} ph${st.ph} ly${st.ly} → 本层新盖 ${hit}px（二值口径 ${hitBin}px）`);
    }
    let c = 0;
    for (let k = 0; k < own.m.length; k++) if (own.m[k] && covOwn[k]) c++;
    console.log(`  小计：主笔+补丁在本层掩膜里盖到 ${c}/${L.area}`);
  }
}
