// 补丁热力图 + 残差错误图（看图判断"补丁是纹理还是没画好的边角"）
// 用法: node dev/patch_map.mjs dev/s3.raw [outPrefix]
// 产出 <prefix>-patch.rgb（补丁位置）与 <prefix>-err.rgb（成品 vs 原图的差异）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
await import(pathToFileURL(path.join(root, 'js/pipeline.js')).href);

const rawPath = process.argv[2] || path.join(here, 's3.raw');
const pref = process.argv[3] || path.join(here, 'patchmap');
const buf = fs.readFileSync(rawPath);
const W = buf.readInt32LE(0), H = buf.readInt32LE(4);
const px = new Uint8ClampedArray(buf.buffer, buf.byteOffset + 8, W * H * 4);

const opts = { returnCanvas: true, returnKeys: false, colors: 0 };
if (process.env.OPTS) Object.assign(opts, JSON.parse(process.env.OPTS));
const res = await globalThis.ISP_PIPELINE.run(px, W, H, opts, () => {});

// 1) 补丁位置：底图压暗；"一拍一笔"的补丁标黄，合并过的标红
{
  const out = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    out[i * 3] = px[i * 4] * 0.35; out[i * 3 + 1] = px[i * 4 + 1] * 0.35; out[i * 3 + 2] = px[i * 4 + 2] * 0.35;
  }
  for (const s of res.strokes) {
    if (!s.g) continue;
    const cl = res.clips[s.c];
    const r = s.g === 1 ? 255 : 255, g = s.g === 1 ? 220 : 0, b = 0;
    for (let y = 0; y < cl.h; y++) {
      for (let x = 0; x < cl.w; x++) {
        if (!cl.mask[y * cl.w + x]) continue;
        const p = (cl.y + y) * W + (cl.x + x);
        out[p * 3] = r; out[p * 3 + 1] = g; out[p * 3 + 2] = b;
      }
    }
  }
  fs.writeFileSync(pref + '-patch.rgb', Buffer.from(out));
}
// 2) 残差错误图：底图压暗；差异 >30 红 / 14~30 橙 / 8~14 黄
{
  const c = res.canvasRgb;
  const out = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    let d = 0;
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(c[i * 3 + k] - px[i * 4 + k]));
    let r, g, b;
    if (d > 30) { r = 255; g = 0; b = 0; }
    else if (d > 14) { r = 255; g = 140; b = 0; }
    else if (d > 8) { r = 255; g = 240; b = 0; }
    else { r = px[i * 4] * 0.35; g = px[i * 4 + 1] * 0.35; b = px[i * 4 + 2] * 0.35; }
    out[i * 3] = r; out[i * 3 + 1] = g; out[i * 3 + 2] = b;
  }
  fs.writeFileSync(pref + '-err.rgb', Buffer.from(out));
}
if (process.env.DUMP) {
  const c = res.canvasRgb;
  fs.writeFileSync(process.env.DUMP, Buffer.from(c.buffer, c.byteOffset, c.byteLength));
  console.log(`成品画布 → ${process.env.DUMP}`);
}
console.log(`${pref}-patch.rgb / ${pref}-err.rgb  ${W}x${H}`);
