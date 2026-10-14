// 诊断：找出"笔画颜色与目标色明显不符"的笔（定位伪影来源）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
await import(pathToFileURL(path.join(root, 'js/pipeline.js')).href);

const rawPath = process.argv[2] || path.join(here, 'illus.raw');
const buf = fs.readFileSync(rawPath);
const W = buf.readInt32LE(0), H = buf.readInt32LE(4);
const px = new Uint8ClampedArray(buf.buffer, buf.byteOffset + 8, W * H * 4);

const res = await globalThis.ISP_PIPELINE.run(px, W, H, { colors: 24, returnCanvas: false, returnKeys: false, residual: [] }, () => {});
const target = (x, y) => {
  const i = (y * W + x) * 4;
  return [px[i], px[i + 1], px[i + 2]];
};

const bad = [];
for (let k = 0; k < res.strokes.length; k++) {
  const s = res.strokes[k];
  const tp = s.tp;
  let cx = 0, cy = 0, n = 0;
  for (let i = 0; i < tp.length; i += 2) { cx += tp[i]; cy += tp[i + 1]; n++; }
  cx = Math.round(cx / n); cy = Math.round(cy / n);
  if (cx < 1 || cy < 1 || cx >= W - 1 || cy >= H - 1) continue;
  const t = target(cx, cy);
  const d = Math.max(Math.abs(t[0] - s.color[0]), Math.abs(t[1] - s.color[1]), Math.abs(t[2] - s.color[2]));
  if (d > 30) bad.push({ k, d, color: s.color, target: t, cx, cy, r: s.r, w: s.w, clip: s.c, clipBox: res.clips[s.c] ? [res.clips[s.c].x, res.clips[s.c].y, res.clips[s.c].w, res.clips[s.c].h] : null });
}
bad.sort((a, b) => b.d - a.d);
console.log(`[diag] 总笔数 ${res.strokes.length}，色差>30 的笔 ${bad.length}`);
for (const b of bad.slice(0, 12)) console.log(JSON.stringify(b));
