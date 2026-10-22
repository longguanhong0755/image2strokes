// 单次跑管线并打印用时（A/B 用：PIPE=dev/_v19.js node dev/bench_pipe.mjs dev/s1.raw）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const pipe = process.env.PIPE || path.join(here, '..', 'js/pipeline.js');
await import(pathToFileURL(path.resolve(pipe)).href);
const buf = fs.readFileSync(process.argv[2]);
const W = buf.readInt32LE(0), H = buf.readInt32LE(4);
const px = new Uint8ClampedArray(buf.buffer, buf.byteOffset + 8, W * H * 4);
const t0 = Date.now();
const r = await globalThis.ISP_PIPELINE.run(px, W, H, { colors: 0 }, () => {});
console.log(`${(Date.now() - t0) / 1000}`);
