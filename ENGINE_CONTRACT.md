# image2strokes 引擎契约（给 inkbrief 等外部项目）

`js/engine.js` 是本项目对外唯一稳定入口。外部项目**不要**直接 import `pipeline.js`，
也不要复制一份到自己的仓库——直接加载这个入口。

## 入口与加载方式

Worker（classic worker）里：

```js
self.ISP_ENGINE_BASE = 'https://longguanhong0755.github.io/image2strokes/js/';
importScripts(self.ISP_ENGINE_BASE + 'engine.js?v=41');
const res = await self.ISP_PIPELINE.run(px, W, H, opts, onProgress);
```

`ISP_ENGINE_BASE` 是 `engine.js` 所在目录的 URL（带结尾 `/`）。
**必须显式设置**：`importScripts` 里的相对路径按“最初那个 Worker 脚本”的目录解析，
不是按 `engine.js` 的目录解析。同目录加载（本项目自己的 worker）可以省略。

## 稳定 API（api = 1）

```js
self.ISP_PIPELINE = {
  api: 1,
  version: '60',
  run(px, W, H, opts, onProgress) -> Promise<{
    W, H,
    strokes: [{ rib, tp, color, vis?, fin?, ... }],
    clips: [{ mask, ... }],
    stats: { ... },
    dbg?: { ... }
  }>,
  CFG, _u
}
```

- `px`：`Uint8ClampedArray`，RGBA，长度 `W*H*4`
- `opts`：见 `pipeline.js` 顶部 `CFG`；常用 `algo/fidelity/style/coverMode`。
  `algo` 是算法选择：`'layer'`（不传时的默认，分层宽笔）/ `'pyramid'`（整幅逐级细化）/
  `'artist'`（画家模式，网页端默认，见下）/ `'painter'`（画家·过程版，见下）。
  `layer` 仍是 API 默认值，老消费方不传 `algo`
  行为不变；显式传 `'artist'` 才走画家模式。
  `fidelity` 是 1~5 的还原程度（3 = 标准，默认）；老字段 `detail` 仍兼容（0→1、1→3、2→5）。
  `seed`（默认 1）只混入过程随机量（起笔位置、扫带相位、弓弯、组顺序）；同 seed 重跑可复现，
  不同 seed 成品精度一致、过程不同。网页端未带 `?seed=` 时每次生成随机种子。
  **默认 cover 模式（分层 + 宽笔扫；2026-10-24 加“每层勾形 → 打形 → 收拾”）**：
  细颜色区按“相邻+色近”并成**层**，像人一样从后往前一层层画——底色层按“完整形状”整幅
  宽扫（主体底下也有底色），其它层沿各自主轴一档档重叠扫（旧 paintSweep 笔形：
  手抖/弓弯/出锋/出界笔），层间按遮挡关系排序、同色层凑到笔尖跟前；每层铺色前先
  **勾形/打形**（最大的主体层勾铅笔灰细轮廓线 `pen:1`，够大的层先铺 1~4 档特宽松色粗笔，
  都是快笔），紧跟本层精确扫笔收拾；细线/文字最后按行“题字落款”。
  勾形/打形是**临时笔**：落墨掩膜只裁在“后面必有笔重涂”的像素上（本层/后层/文字），
  勾完随手被铺色盖掉，对成品逐像素零影响；`layerSketch:false` / `blockIn:false` 可关。
  每条扫带的落墨掩膜 = 笔形光栅 ∩ 颜色块像素，段色取约束均值；逐像素色差 ≤
  档位承诺（①≤24、②≤20、③≤16、④≤12、⑤≤8），>24 恒为 0；
  没有 residual / hole / exactRepair 这些事后补笔，也没有格子马赛克。
  档位只改三个算法参数：单块面积上限（6000→600px²）、颜色容差（24→8）、笔宽系数。
  `coverMode:false` 可切回旧版图层 + 补笔路径（A/B 用）。
  `colors` 在 cover 模式下不决定最终颜色，传 0/省略即可。
  老入参 `coverT/coverTMax/coverBudget/exactRepair` 在 cover 模式下被忽略。
  **第二种算法 `algo:'pyramid'`（逐级细化，2026-10-26）**：每一级都把整幅（非纸底）
  重画一遍——起稿用 64px 大刷子整幅横扫（一条扫带横穿全幅，带内按列均色切成连续段，
  每段一笔），之后 16px / 8px / 4px / 2px / 1px 逐级整幅重画；最后一级用精确颜色区
  （每通道跨度 ≤ 2V + 段色取约束均值）把整幅重画一遍，数学上保证逐像素 ≤ 档位承诺、
  uncovered 恒为 0。档位决定停笔尺寸（①16 / ②8 / ③4 / ④2 / ⑤1）和最终容差。
  粗级是原分辨率上的整幅宽笔扫，不是低分辨率马赛克，也不是按色区一块块出现。
  **第三种算法 `algo:'artist'`（画家模式，2026-10-26 重写为“逐像素照抄”；网页端默认）**：
  先按图上统计选策略——`flatArt = isFlat || flatScore > 0.52`。平涂/图标/海报走封闭色块，
  照片走细色区；两条通路共用同一套“分色 → 取色 → 按形落笔”的精确重建：
  ① 保边平滑（guided filter，只用于判断哪些像素属于同一色区；取色回到原图像素）；
  ② 局部容差漫水（平涂 TOL=1.4、照片 TOL=6；同时比较种子色和上一个像素），
     渐变色区分成窄带，细线不会被大片背景吃掉；
  ③ 迭代 RAG 合并碎块（平涂 MINA=80、照片 MINA=220；抗锯齿过渡带并进邻色，
     暗线/高光/高色度小结构受保护）；
  ④ 相邻同色区合并（平涂 MERGE_CD=0.8、照片 10）；
  ⑤ 每组用原图像素算精确均值（铅笔再统一转连续灰阶）；线状组沿骨架中轴一笔到底，
     笔宽按内切距离，端头按切线延伸，`zoneGid` 把出界部分裁回原形；
  ⑥ 按 `ph` 排阶段（`ph=0..3` 对应四遍）。平涂四遍推进：
     `ph=0` 起稿铺满——宽笔自上而下铺背景中间色（同色斑纹/噪点一起铺；铺底笔不记
     覆盖/占位），每个主体/文字块沿长轴挥一层"主色底"（裁在元素像素内，近似色），
     大色块直接精确落笔，起稿结束整幅基本成形；`ph=1` 细化背景——背景按面积从大到小、
     就近串联整片刷准（大色带先、窄带/噪点后，不做网格扫描），期间不落任何主体笔；
     `ph=2` 细化主体——按元素块一处画完再走（大形已立：中块色→深色描边→细线，
     文字块"字形→描边→装饰"）；`ph=3` 前景遮挡/最小细节。
     照片：0 主体大形 → 1 背景大色 → 2 主体结构与明暗 → 3 视觉中心（五官、暗边、嘴线）。
     同阶段/同档内按“优先级小桶 + 就近串笔”，换种子只改桶内顺序和起笔点；
  ⑦ 组内沿自己的主轴一档档扫（扫带掩膜 ∩ 本组像素），渐变色区按 48/72px 分段取局部均值；
     背景大色区若细到 8 位色阶以下，用互补两级网点落笔，避免马赫色带；
     运笔拟人化：平涂大类块先沿边界内缩勾一圈窄边再填心（cutting-in）；相邻扫带蛇形交替
     起笔、推进间距做相关漂移（±0.2 步长）；弓弯随带长增大并叠第二谐波。这些只动
     笔序/相位/起笔端，掩膜与取色不变，成品精度由 ⑧ 的审计兜底；
  ⑧ 每笔落下前检查“是否新增像素”，零新增立即删除（`zeroRemoved`）；收尾只补规划画布
     确实没盖到的本组像素，最后按最终覆盖位图统计 `uncovered`（正常为 0）。
  笔数按内容自适应（平涂约 3.2~3.3k、照片约 10k、海报约 12k，标准档实测）。
  **不设“概括/留白”豁免**：最终每个可画像素都由所在色区的精确均值覆盖，边界/纹理处
  仍有抗锯齿与细节差异，读数见 `stats.quality`。风格：`marker`/`oil` 只改笔宽、扫带间距和弓弯；
  `pencil` 共用同一套分区，但每笔落纸转成连续灰阶。`fidelity` 1~5 只改笔触粗细/密度
  （默认 3），分区与取色不变。
  三种算法共用 `strokes/clips/stats` 输出结构，导出与回放代码不用区分。
  `stats.algo === 'pyramid'` / `'artist'` / `'painter'` 仅在该模式出现，供消费方切换五步标签
  （pyramid：起稿/铺色/细化/收形/落款；artist 照片：起形/铺大色/塑形/点睛/收笔；
  artist 平涂走背景优先时：铺背景/画主体/文字结构/细节/收笔，`stats.exactOrder='bgfirst'`；
  painter 平涂走人画流程时：铺满整页/勾外框(或补背景)/画主体/点睛·收笔/落款，
  `stats.exactOrder='painter'`；第二遍画了闭合外框时 `stats.ring=true`（标签"勾外框"），
  否则是逐组补准背景（标签"补背景"）。`stats.bgFill`：`'once'` 主色背景一趟刷满 /
  `'wash'` 逐组补准；是否铺满按面积/贴边/颜色均匀度自动判定，不按图的类型特判）。
- `onProgress(p, msg)`：`p` 是 0~1
- `stats.fidelity` 是本次实际使用的还原档位（1~5）；`stats.detail` 保留给老消费方。
- 三种算法都返回 `stats.quality`。`layer/pyramid`：`{tolerance, bucketT, max, mean, gt8, gt24, gt48,
  uncovered, regions, colorRegions, inkRegions}`，`tolerance` 是本档颜色容差（逐像素最大
  通道差上界），`max/mean/gt*` 是规划画布对原图的实测读数；`uncovered` 必须为 0。
  `artist` 额外有 `{artist:true, paperOK, subjectCoverage, edgeScore, thumbMean, thumbBad}`，
  `tolerance` 固定 255（不承诺逐像素上界；色区取精确均值，边界/纹理处仍有差异），
  `mean/max/gt*` 是实测诊断读数；`uncovered` 正常为 0（精确通路会先补齐漏画像素）。
  `dbg.artist.exact`（`debug:true` 时）结构为：`{seed, mode:'flat'|'photo', regions, groups, strokes,
  mergePasses, uncovered, uncoveredGroups, residualPx, residualComps, residualStrokes,
  zeroRemoved, rimPx, paintable, ms, order, bgFill, ring, bgGroups, washPx, elements}`。`dbg.artist.exact.mode` 是实际走的策略
  （`flat` = 封闭色块，`photo` = 细色区）；`order='bgfirst'` 表示平涂走了“背景先行 + 元素块”排法
  （`bgGroups` = 背景块数、`elements` = 前景元素块数），`order='painter'` 是画家·过程版的
  人画流程（铺满整页 → 勾外框/补背景 → 逐个对象先描外轮廓、整块填满、再补内部细节 →
  点睛·收笔；`bgFill` = 背景铺法：`once` 主色背景条带一次刷满（面积≥15%、铺满画幅≥60%
  或被细框包住、颜色均匀度≤12，全部按像素测量，不按颜色特判）/ `wash` 逐组补准；
  `ring` = 是否画了闭合外框；`objects` = 像素连通的 foreground 对象数），
  `order='phase'` 是照片/回退排法；
  painter 照片仍为 `order='phase'`，但作画组织是"近似底色 → 色区笔（窄笔、56px 一段取局部均值）
  → 四层误差驱动的分层细化（粗/中/细/极细，每笔落笔前算误差增益，不能减少误差就不发笔）"；
  `order='phase'` 下 `bgFill/ring` 为 undefined。分层细化只作用于 painter 照片，artist 照片笔流不变。
  `stats.exactOrder` 与 `dbg.artist.exact.order` 同值。`stats.photo` 仍是原始 `isFlat` 判定，
  两者可能不同（扫描海报可能 `isFlat=false` 但 `flatScore>0.52`，按平涂处理）。
- `layer/pyramid` 下每个像素只属于一个颜色区，`rib` 是这条扫笔掩膜的整数外框矩形，
  `tp` 是回放用的笔尖轨迹（只影响观感）；消费方按“多边形 ∩ 1 位掩膜”绘制，
  结果与规划画布逐像素一致。`artist` 的笔按色区组织，允许同色重叠，但不留白；
  `rib`/`tp` 语义相同，正常覆盖所有可画像素。
- `vis` 是这一笔实际改动的画布量（Σ 每像素最大通道差），回放可按它分配时间；
  `fin` 标记最后一拨题字/落款（artist 是“收笔”）。两者都是新增的可选字段，旧的消费方可以忽略。
- `layer/pyramid` 的 `keys[].cov`（可选）是“到这一笔为止已经覆盖的像素”位图；关键帧 =
  白纸 + cov 内像素上色。`artist` 不返回 `keys`（不提供关键帧，直接逐笔重画）。旧消费方可以忽略。
- `layer/pyramid` 下 `stats.photo` 恒为 false；`pyramid` 的 `stats.colors` 为 0，
  cover 的颜色由桶决定。`artist` 的 `stats` 带 `algo:'artist'`、`style`、`fidelity`、
  `seed`、`exactMode`、`exactOrder`、`phases`（各阶段笔数；平涂背景优先时对应
  铺背景/画主体/文字结构/细节，照片对应起形/铺大色/塑形/点睛），`photo = !isFlat`，
  `colors` 铅笔为 0、其它为色板数；调色板/主体/预算等诊断在 `dbg.artist`（仅 `debug:true`），
  精确通路的分色/删笔统计在 `dbg.artist.exact`（`debug:true` 时返回）。
  `palette/probe` 可能不返回。

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
