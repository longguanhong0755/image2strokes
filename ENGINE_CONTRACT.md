# image2strokes 引擎契约（给 inkbrief 等外部项目）

`js/engine.js` 是本项目对外唯一稳定入口。外部项目**不要**直接 import `pipeline.js`，
也不要复制一份到自己的仓库——直接加载这个入口。

## 入口与加载方式

Worker（classic worker）里：

```js
self.ISP_ENGINE_BASE = 'https://longguanhong0755.github.io/image2strokes/js/';
importScripts(self.ISP_ENGINE_BASE + 'engine.js?v=1');
const res = await self.ISP_PIPELINE.run(px, W, H, opts, onProgress);
```

`ISP_ENGINE_BASE` 是 `engine.js` 所在目录的 URL（带结尾 `/`）。
**必须显式设置**：`importScripts` 里的相对路径按“最初那个 Worker 脚本”的目录解析，
不是按 `engine.js` 的目录解析。同目录加载（本项目自己的 worker）可以省略。

## 稳定 API（api = 1）

```js
self.ISP_PIPELINE = {
  api: 1,
  version: '20',
  run(px, W, H, opts, onProgress) -> Promise<{
    W, H,
    strokes: [{ rib, tp, color, ... }],
    clips: [{ mask, ... }],
    stats: { ... },
    dbg?: { ... }
  }>,
  CFG, _u
}
```

- `px`：`Uint8ClampedArray`，RGBA，长度 `W*H*4`
- `opts`：见 `pipeline.js` 顶部 `CFG`；常用 `colors/style/detail/maxStrokes/dropDead`
- `onProgress(p, msg)`：`p` 是 0~1
- 返回的 `clips[].mask.buffer` 可以被 transfer（inkbrief 就这么做）

## 版本策略

- `pipeline.js` 内部怎么改都行；**只要 `run()` 的入参/返回结构不变，`api` 就不动**。
- 破坏性改动：`api + 1`，并且**保留旧 api 的入口**（例如 `engine-v2.js`），
  旧消费者继续走旧入口。不能直接改 `engine.js` 的语义。
- `engine.js` 的 `?v=` 只在入口文件本身变化时递增。
- 新引擎上线前跑 `node dev/engine_check.mjs`；CI 也会跑。

## 消费者怎么锁版本

inkbrief 的 `js/engine-config.js` 里有一个 `pin`（commit 号）。生产默认用
`https://cdn.jsdelivr.net/gh/longguanhong0755/image2strokes@<pin>/js/pipeline.js`，
本地开发默认用同源兄弟目录的最新代码。升级流程：

```bash
cd inkbrief
npm run engine:bump      # 把 pin 抬到 image2strokes 的 HEAD
npm run check:pin        # 真的下载并跑一遍该版本
```

然后提交 `js/engine-config.js`。这样上游更新不会直接改线上行为，
但升级是一次一行、可测试、可回滚的。
