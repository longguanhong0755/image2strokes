/* 提炼管线跑在 Worker 里：主线程只负责界面与回放 */
importScripts('engine.js?v=43');

self.onmessage = async function (e) {
  const d = e.data;
  const px = new Uint8ClampedArray(d.px);
  try {
    const res = await self.ISP_PIPELINE.run(px, d.W, d.H, d.opts || {}, function (p, msg) {
      self.postMessage({ type: 'progress', p: p, msg: msg });
    });
    // 极致档有 20 多万笔，structured clone 到主线程要几十秒；给个明确提示，
    // 不然进度条停在 100%、界面看着像卡死。
    self.postMessage({ type: 'progress', p: 1, msg: '正在打包 ' + res.strokes.length + ' 笔…' });
    self.postMessage({ type: 'done', res: res });
  } catch (err) {
    self.postMessage({ type: 'error', msg: (err && err.stack) || String(err) });
  }
};
