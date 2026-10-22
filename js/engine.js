/* image2strokes 对外引擎入口（给 inkbrief 等外部项目用）
 *
 * 这是**稳定入口**：外部项目只认这个文件，不直接认 pipeline.js。
 * 以后 pipeline.js 改名、拆分、换缓存号，只要在这里同步，外部项目不用改。
 *
 * 契约（改动必须遵守，否则会破坏已经在用它的项目）：
 *   - 必须暴露 self.ISP_PIPELINE.run(px, W, H, opts, onProgress)
 *   - ISP_PIPELINE.api 是整数；**破坏性改动必须 +1**，并保留旧 api 的入口文件
 *   - 返回结构：{ W, H, strokes, clips, stats, dbg? }
 *
 * 外部项目加载方式（Worker 内，classic worker）：
 *   importScripts('https://<image2strokes 站点>/js/engine.js?v=1')
 */
if (typeof importScripts !== 'function') {
  throw new Error('image2strokes engine.js 只能在 Worker（importScripts）里加载');
}

// importScripts 的相对路径按“最初那个 Worker 脚本”的目录解析，不是按本文件所在目录。
// 外部项目把本文件放在别的目录时，先设 self.ISP_ENGINE_BASE = '<到 js/ 的目录 URL，带结尾 />'。
// 不设则默认跟 Worker 同目录（image2strokes 自己的 worker 就是这种情况）。
const ENGINE_BASE = new URL(self.ISP_ENGINE_BASE || './', self.location.href).href;
importScripts(new URL('pipeline.js?v=20', ENGINE_BASE).href);

if (!self.ISP_PIPELINE || typeof self.ISP_PIPELINE.run !== 'function') {
  throw new Error('image2strokes engine.js: pipeline.js 没有导出 run()');
}

// 稳定契约版本。pipeline 内部怎么改都不动它；只有 run() 的入参/返回结构破坏性变化才 +1。
self.ISP_PIPELINE.api = 1;
// 给人看的引擎版本（跟 pipeline 的 ?v= 保持一致即可）
self.ISP_PIPELINE.version = '20';
self.ISP_PIPELINE.entry = 'image2strokes/js/engine.js';
