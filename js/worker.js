/* 提炼管线跑在 Worker 里：主线程只负责界面与回放 */
importScripts('pipeline.js?v=8');

self.onmessage = async function (e) {
  const d = e.data;
  const px = new Uint8ClampedArray(d.px);
  try {
    const res = await self.ISP_PIPELINE.run(px, d.W, d.H, d.opts || {}, function (p, msg) {
      self.postMessage({ type: 'progress', p: p, msg: msg });
    });
    self.postMessage({ type: 'done', res: res });
  } catch (err) {
    self.postMessage({ type: 'error', msg: (err && err.stack) || String(err) });
  }
};
