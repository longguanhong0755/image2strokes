// 定位"单点笔"出处：按 r(区块索引)/ph(阶段)/笔尖/点数 交叉统计
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(path.join(here, '..', 'js/pipeline.js')).href);
const buf = fs.readFileSync(process.argv[2]);
const W = buf.readInt32LE(0), H = buf.readInt32LE(4);
const px = new Uint8ClampedArray(buf.buffer, buf.byteOffset + 8, W * H * 4);
const extra = process.argv[3] ? JSON.parse(process.argv[3]) : {};
const res = await globalThis.ISP_PIPELINE.run(px, W, H, Object.assign({ returnCanvas: false, returnKeys: false, debug: true }, extra), () => {});
const tab = new Map();
for (const s of res.strokes) {
  const n = s.tp.length / 2;
  const kind = n === 1 ? '单点' : (n === 2 ? '两点' : '多点');
  const key = `ph${s.ph} r${s.r < 0 ? '<0' : '>=0'} pen${s.pen} ${kind}`;
  tab.set(key, (tab.get(key) || 0) + 1);
}
const rows = [...tab.entries()].sort((a, b) => b[1] - a[1]);
console.log(`总笔 ${res.strokes.length}`);
for (const [k, v] of rows.slice(0, 20)) console.log(`  ${k}: ${v}`);
console.log('站点产出:', JSON.stringify(res.dbg && res.dbg.src || {}));
