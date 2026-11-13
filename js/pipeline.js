/* 图片 → "一笔一笔平涂" 的绘制脚本管线（纯 JS，无 DOM 依赖，可在 Worker / Node 里跑）
 *
 * 流程：
 *   颜色量化 → 连通分区 → 碎块吸收 → 分区笔刷（每笔一个纯色，可按段取局部色）
 *   → 深色细线（线稿）走骨架笔画 → 残差补笔修复（允许覆盖，越补越准）
 *
 * 输出的每一笔：rib 走廊多边形 + tp 笔尖轨迹 + 纯色 color + 裁剪组 c。
 */
(function (root) {
  'use strict';

  // 由 run() 从 opts 灌进来的开关（画笔形的工具函数在 run 外面，拿不到 opts）
  // 当前还原程度（1 省笔 … 5 极致）：编译器各阶段读它决定"补多细"，
  // 档位差异才落在细节密度上，而不是只改几个补笔预算。
  let COMPILER_FID = 3;
  // 还原程度的"色彩分辨率"档位表（见 run() 里的 COMPILER_VIEW）。
  // 语义（2026-11-09 定）：档位 = 处理细节/过渡色的细致程度，而不是"多补多少笔"。
  //   ① 省笔：把图像量化成很少的色块（渐变 → 深/中/浅 三级）
  //   ③ 标准：基准档，逐像素结果不变
  //   ⑤ 极致：区域色彩模型按近 1:1 的分辨率还原过渡，结构与标准档一致
  let COMPILER_VIEW = null;
  // 量化档（①②）的落笔颜色收敛函数：把任何"算出来的颜色"收到色板上。
  // 区域均值会跨过两种色板色（父块铺底、细线取色），不收敛就会在成片纯色里
  // 冒出一块块只差几个色阶的补丁。
  let SNAP_OUT = null;
  const snapOut = (c) => (SNAP_OUT && c ? SNAP_OUT(c) : c);
  let PROF_FLAT_SAMPLE = true;    // 细长层取色用"平头"变宽笔形（与 ribbon 的 noCap 一致）

  // ---------------- 基础工具 ----------------
  // 掩膜 / 几何 / 骨架 / 笔形 / 聚类这些纯函数已经拆到 js/pipeline/util.js（见该文件头）。
  // 这里只做名字绑定：调用处一个字都不用改，行为与拆分前逐字节一致。
  let clamp, luma, rand01, chainNN, hilbertIndex, LABF, srgb2labInto, srgb2lab,
    fillEnclosedHoles, fillPoly, fillPolyCov, distanceTransform, dilate, erode, rdpSimplify,
    closeMask, closeMaskDisk, compsOfLabels, thin, longestPath, ribbon, ribbonProf, mergeLoops,
    med3, box3, feather, kmeans, regionMaskOf;
  let UTIL = null, COVER = null, PYRAMID = null, EXACT = null;
  // 单独 import 本文件时（Node 调试脚本）util.js 还没加载，这里补一次；
  // worker 里 engine.js 已经 importScripts 过，走的是同步分支。
  async function ensureUtil() {
    let U = root.ISP_PIPELINE_UTIL;
    if (!U) {
      await import('./pipeline/util.js');
      U = root.ISP_PIPELINE_UTIL;
      if (!U) throw new Error('js/pipeline/util.js 未加载');
    }
    // 两条老算法线各自成文件；只 import 本文件时（Node 调试脚本）在这里补加载
    if (!root.ISP_PIPELINE_COVER) await import('./pipeline/cover.js');
    if (!root.ISP_PIPELINE_PYRAMID) await import('./pipeline/pyramid.js');
    if (!root.ISP_PIPELINE_EXACT) await import('./pipeline/artist-exact.js');
    // 色块编译器（compiler 新路径）是独立模块，worker 里由 engine.js 预加载。
    if (!root.BLOCKS) await import('./pipeline/blocks.js');
    COVER = root.ISP_PIPELINE_COVER;
    PYRAMID = root.ISP_PIPELINE_PYRAMID;
    EXACT = root.ISP_PIPELINE_EXACT;
    if (U !== UTIL) {
      UTIL = U;
      ({ clamp, luma, rand01, chainNN, hilbertIndex, LABF, srgb2labInto, srgb2lab,
        fillEnclosedHoles, fillPoly, fillPolyCov, distanceTransform, dilate, erode, rdpSimplify,
        closeMask, closeMaskDisk, compsOfLabels, thin, longestPath, ribbon, ribbonProf, mergeLoops,
        med3, box3, feather, kmeans, regionMaskOf } = U);
    }
    return U;
  }

  // ---------------- 主流程 ----------------
  const CFG = {
    // --- 图层栈（一个对象 = 一层）---
    objMergeCd: 70,         // 相邻且颜色差 < 它 ⇒ 同一层（蓝底的多条色带、黑框的四条边并成一整层）
    lineTol: 0.9,           // 细线中轴的拉直容差（像素）：直线段必须一笔到底、笔直
    layerCheck: true,       // 每一层刷完当场自检（不只底色层）：这一层自己有没有漏
    sweepSeal: true,        // 铺色"一次过"：落笔前先算这一层所有档的联合覆盖，缝就地加宽（不新增笔画）
    sealIter: 3,            // 加宽最多迭代几轮
    sealMin: 1200,          // 层外框小于它就不做（小层的缝交给每层自检，成本更省）
    lineSeal: true,         // 细长层同样"一次过"：中轴笔形没盖到的凸起就地加宽（不新增笔画）
    capFix: true,           // ribbonProf 端头扫正前方（见文件头 CAPFIX 注释）
    thinNoErode: true,      // 细长层取色不缩边（否则整层一个均值色，边界那圈刷平）
    rimPass: true,          // 每层画完，把自己那圈 1~2px 边界用**局部色**补一遍（治"边不像"）
    rimLinearOnly: true,    // 只对细长层做（大块平涂层的边由残差收拾，做了会多出几千笔）
    bleedOrder: true,       // 出界笔只许压在"已经画过"的对象上（否则那圈颜色留在别人身上）
    profFlatSample: true,   // 细长层取色用平头变宽笔形
    occlude: true,
  objGrowF: 0.55,      // 图层"完整形状"往外补的系数（见 closeMaskDisk 的注释；0.8 会伸出圆头小凸起）          // 每层补出"被上层盖住的部分"（形状闭合推断）；照片类纹理太碎时关掉更干净
    colorPass: true,        // 同色合并成"一趟"：互不遮挡的层之间顺序自由，优先挑"跟上一笔同色、
                            // 且离笔尖近"的那层——同一支笔一路把同色的东西画完（原来是按面积大小排，
                            // 笔尖在整幅上按"大块→小块"来回跳，一个字一层）
    colorPassTol: 36,       // "算同色"的色差上限（曼哈顿，约 12/通道）
    colorPassArea: 4,       // 同色还不够：面积也要在同一个量级（大/小之比 ≤ 它）才并进这一趟。
                            // 否则"整片蓝底"会把画面另一头的零星蓝点拉进同一趟，笔尖满屏飞
                            // （实测这一条同时把残差补笔的落点扰动压小）
    edgeSnap: false,        // 边界按颜色重判（**默认关**）：三张示例实测它净亏——照片可见差异
                            // 3.07% → 2.57%、AIR MAIL 5.23% → 2.46%，只有海报整幅靠"把背景纸纹
                            // 噪点刷成蓝底"赚回 0.1 个点。它当初是在替"调色板太小"擦屁股
                            // （色数提上去之后同样的问题不再出现），而它会把真的细描边啃掉一圈。
    edgeSnapTol: 6,         // 重判的容差（曼哈顿）：比本侧更近这么多才改判
    edgeSnapIter: 3,        // 重判最多剥几层（扫描件的过渡带可能有 2~3px 宽）
    edgeSnapBad: 40,        // 只修"真正的错分"：自己的区色离原图色 ≥ 它（曼哈顿）才允许改判。
                            // 抗锯齿过渡带的区色本来就是混色、已经贴近原图（实测海报上这类像素
                            // 有 1500+ 个），推成纯色反而把字的边推错——文字区可见差异 2.46% → 5.23%
    edgeSnapRatio: 0.62,    // 相对门槛：邻居的色距必须 ≤ 本侧的 62% 才改判（0 = 关，回到纯绝对容差）。
                            // 描边外缘那圈"深色/混色"像素离两侧都远，绝对距离常常"蓝底更近"⇒
                            // 判走之后红描边就被啃掉一圈（实测 AIR MAIL 里 2200 像素被翻）
    edgeSnapBand: 2,        // 边界带膨胀半径（越大越慢；3 会把更多过渡像素拉进重判）
    edgeRamp: true,         // 抗锯齿过渡带按两侧颜色并进去（不让它自己成层被涂成灰条）
    edgeRampR: 4,           // 过渡带判据的搜索半径（像素）
    maskMajority: 5,        // 掩膜边界去锯齿的窗口（5 = 5x5 多数表决；0 = 关）：
                            // 照片类靠它把边缘的锯齿抹平（可见差异 17.5% → 16.9%），海报类只改百来个像素
    maskMajThr: 17,         // 压倒性多数的门槛（25 格里的格数；越大越保守）
    maxSide: 1024,
    colors: 32,
    mergeThr: 9.0,          // Lab 距离，小于它合并（对渐变友好）
    minArea: 120,           // 小于它的小碎块并入邻块（越小分区越细，笔数越多）
    targetSec: 240,         // 回放总时长（1× 速度）
    bleedFirst: 0,          // 每个区块第一遍"铺底"允许外扩的像素（0 = 严格裁形，保真优先）
    resThick: 30,           // 补笔忽略"又大又厚"的错误块（那是平涂风格本身的平滑差异）。
                            // 门槛是**真实厚度**（2×最大内切半径，见 compThick）：8 的时候
                            // 连字母/飞机那圈深色描边（真厚 8~14px）都被当"大片"跳过，
                            // 边就一直差着；30 之后海报可见差异 2.01%→1.45%、明显误差 0.35%→0.04%。
    inkLuma: 195,
    coverOk: 0.86,
    residual: [30, 24, 18, 14, 11, 9, 7],
    absorbCd: 60,           // 碎块并入邻块的颜色阈值（Lab/RGB 距离）
    texMax: 1500,           // "纹理块"面积上限：小于它 + 弱对比 ⇒ 判为纸纹/噪点，并进邻块且不画
    texCd: 130,             // "纹理块"的对比上限（调色板距离）：超过它才当"真特征"保留
    inkMinCd: 100,          // 细线要画的对比下限：比它弱的"线"其实是纹理，不写
    resHalfA: 0.95, resHalfB: 0.7, resMin: 1.0,   // 补笔半宽 = dmed*A + B
    resSplit: 18,           // 补丁按颜色二分的停止阈值（越小补得越准、补丁越多）
    resPatchMax: 128,       // 小于这么多像素的错误块直接并进补丁笔（不走骨架笔）：
                            // 补丁笔的掩膜是 1 位硬遮罩、口径比骨架笔更准，而且能合并——实测比走骨架笔
                            // 笔数少 27%、可见差异还更低
    maxStrokes: 26000,      // 排定轮次的笔数上限（照片类纹理太碎时保护；尾巴轮另有倍数上限）
    returnKeys: true,       // 生成关键帧（网页端拖动进度用）
    keyFrames: 5,
    resStop: 0,             // 补笔收益阈值（0 = 不提前收手，把 7 轮补完）
    resTail: 20,            // 排定轮次之后的"自适应续补"轮数（按当前阈值一路补到收敛）
                            // 老版本是被固定档位+预算砍掉的：海报停在 20%、照片停在 29%，其实都没收敛
    resTailStep: 0.6,       // 续补每轮把阈值再降多少
    resTailMin: 3,          // 续补的阈值下限（再细下去补的是平涂风格本身，没意义）
    resTailStop: 0.25,      // 续补收益（可见差异百分点）低于它就收手
    resTailMax: 3,          // 续补最多把笔数预算用到排定轮的几倍
    exactRepair: 0,         // 最后一公里：全图精修的目标（每像素最大通道差；0 = 关）。
                            // 残差补笔每轮最多 6000 个补丁、收益一掉就收手，全图总有约 1% 的像素
                            // 停在"肉眼看得出来"的误差上；这一轮把剩下的错像素一次补到阈值以内。
    exactRepairCell: 128,   // 精修聚合格子（像素）：同格同色阶的错像素并成一条掩膜笔
    exactRepairShift: 1,    // 精修颜色桶位移（1 = 每通道 2 级）：越大笔越少、补完的色差越大
    exactRepairMax: 300000, // 精修最多撒多少个补丁（按组内最大误差从大到小，先补最刺眼的）
    localColor: true,       // 主笔触按段取局部纯色（更贴近原图渐变）
    segF: 3,                // 取色分段长 = 笔半宽 × 它（越小越贴局部色，笔数越多）
    segMin: 30,             // 取色分段长下限（像素）
    segJoinCd: 8,           // 相邻两段颜色差 < 它就连成一笔（曼哈顿）：越大笔越省、但会把渐变抹平
                            // 实测 42（≈14/通道）会把长笔跨过的渐变抹平——海报平坦区因此留下 ±8 的误差，
                            // 收到 8（≈3/通道）后主笔多 60%，可见差异直接降 5 个百分点
    dilMain: 3,             // 主笔允许溢出 3px（自然覆盖，后画的会盖住）
    dilInk: 0,              // 勾线层不向外扩边：它现在画在铺色之后，扩边会留下压不回去的深色描边
    // --- "像人在画"的相关参数 ---
    sketch: false,          // 起稿（默认关）：勾出来的灰线随即被铺色盖掉，对成品零贡献，
                            // 回放开头却是一段"乱线"——用户 2026-10-18 拍板删掉；要打形观感再打开
    sketchMax: 56,          // 起稿最多勾多少条轮廓
    sketchHalf: 1.5,        // 起稿线半宽（乘 strokeScale）
    sketchMix: 0.45,        // 起稿色 = 局部目标色 与 铅笔灰 的混合比例
    layerSketch: true,      // cover 模式"一层 = 先勾形再铺满"：每层铺色前先沿本层轮廓铅笔灰轻勾
                            // 一笔、勾完紧跟铺色盖掉。与 10-18 删掉的开头整段全局起稿不同——
                            // 那是长乱线开场，这里是嵌在每层里的节奏动作
    layerSketchMax: 2,      // 每层最多勾几条轮廓（只勾最大的主体层，每层最大的几圈）
    blockIn: true,          // 每层铺色前先用 1~4 档特宽笔"打形"（松色快笔），紧跟精确扫笔收拾
    bleedP: 0.22,           // 多少比例的铺色笔允许"画出界"，后面再被覆盖修回
    bleedR: 2,              // 出界的像素半径
    featherRaster: false,   // 光栅口径：false = 硬边（和网页端一致）；true = 羽化（只用于对比实验）
    organic: true,          // 单笔形态人性化：弧线 + 手抖 + 宽窄起伏
    holeFill: true,         // 收尾补漏：把"还是没画上"的小洞逐个补掉（残差补笔有"太小/太散不补"的门槛）
    holeT: 28,              // 补漏的判定阈值（单通道差）
    holeWhite: 244,         // "看着是白的"门槛（这一类补验：原图明显更深的）
    holePaper: 254,         // "纸面根本没涂上"门槛（三通道都 ≥ 它 = 那像素还是白纸），原图比它深 8 以上就补
    holeMax: 420,           // 只补这么大的洞（像素数）；更大的块属于平涂风格化，补了会花
    holeRounds: 3,          // 收尾补漏 B 类迭代几轮（每轮只补总误差量最大的那批）
    // --- 接缝修正（画布上"不该有的台阶"：两块各自差 5~7、加起来是一道肉眼可见的缝）---
    baseCheck: true,        // 底色层刷完当场自检：没盖到的楔形/边角立刻补上（底层一次铺满）
    seamFix: true,          // 开关
    seamT: 7,               // 画布这一步的台阶达到它就怀疑（单通道）
    seamSmooth: 6,          // 而原图这一步的台阶不超过它（= 原图这里本来是平滑的）
    seamR: 1,               // 沿缝两侧各看几像素
    seamE: 3,               // 缝带里"差得超过它"的像素才补（补上目标色，台阶就散成原图的渐变）
    dropDead: true,         // 收尾删掉"一笔都没留下"的笔（像素级不影响成品，回放里少一次多余动作）
    holeSeg: 48,            // 补漏一笔画多长（越长笔数越省）
    holeSplit: 18,          // 补漏的一块错误按颜色二分的停止阈值（0 = 不切）：
                            // 一块里深浅混着（渐变带、两条细线挨着）时，用一个均值色补会把浅的那半刷深
                            // （飞机边上那些"深色楔子"），而且下一轮又被判成错、再补一遍
    holeBatchMax: 200,      // 小于这么大的洞并进"补丁笔"（掩膜互不相交 ⇒ 合并像素等价，笔数省）
    patchShift: 3,          // 补笔合并的颜色分桶位移（3 = 每桶 8 个色阶）：同格同桶的散点合成一笔
    patchTol: 12,           // 自适应色差合并（0 = 关，按固定色桶并）：>0 时跟"组均值色"比，曼哈顿上限
                            // 固定色桶必须卡在可见阈值以内，合并比只有 1.7:1；改成跟组均值色比之后
                            // 同样的补笔轮次少用 37% 的笔数
    texResSkip: 0,          // 残差补笔跳过"纹理像素"（1 = 跳过；0 = 连纹理一起补）。                            // 主笔仍然不画纸纹（铺色干净），但残差补笔用细笔把颗粒/毛发点回来：
                            // 照片可见差异 25.5% → 19.6%，海报 12.4% → 10.3%
    resSkipInk: true,       // 残差不碰"细线像素"（它们留给最后的细线/题字阶段）
    inkGuard: 1,            // 非照片图：细线周围这么多像素内的小误差不再补。
                            // 细线主笔覆盖率通常已 ≥99.5%，再补只是追抗锯齿的亚可见色差
                            // （海报实测：红色描边主笔 769 支、补丁 4120 支）。
    inkGuardErr: 20,        // 保护带只挡"小误差"；大于它的真实缺口/白点仍然要补，否则线边会烂
    resSkipRamp: true,      // 残差不碰"抗锯齿斜坡像素"
    resRampSkip: false,     // 抗锯齿斜坡不补：目标色正好夹在相邻两个区块的纯色之间（渲染毛边，不是内容）。
                            // 补它 = 用一堆点去描毛边（插画 5000 笔里大半是这个），不补 = 干净的硬边
    rampTol: 30,            // 斜坡判据的容差（到"两色连线"的曼哈顿距离）
    resFlatTol: 0,          // 局部起伏 ≤ 它 = 平滑区（渐变/平色）
    resFlatErr: 26,         // 平滑区里误差 ≤ 它的不补：那是采样台阶，用点去描只会描出一片鬼影
    resSkipRampPhoto: false,// 照片类不启用斜坡判据（照片没有"纯色区块"，判不准）
    coverMin: 0.7,          // 光栅判"这一笔画上了"所需的覆盖率（网页端半透明毛边按没画上算）
    coverSubY: 2,           // 覆盖率用的亚扫描线数（1 = 只看像素中线，够抓白点且更快）
    patchCell: 2048,        // 补笔合并的空间格子（像素）；远大于图幅 = 不分格，只靠 patchShift/patchBox 控制
    patchBox: 128,          // 合并后一笔的外框上限（像素）：外框越大，网页端每笔要清/合的画布越大、内存越费
    patchFill: 0,           // 外框最小填充率（0 = 关，按"外框边长"卡）：>0 时改按密度卡，散点能并得更多
    // --- 交界过渡带（实测负收益，默认关；见 README 的坑 5）---
    edgeFill: false,        // 沿色块交界补"中间色"细笔：边界像素在目标图里大多本来就是纯色，补了反而更差
    edgeT: 10,              // 交界过渡带的阈值（单通道差）
    edgeCd: 60,             // 只补"两边颜色差得远"的交界（RGB 曼哈顿距离）
    edgeMax: 3200,          // 最多补多少处
    edgeSeg: 40,            // 过渡带一笔多长
    // --- 笔形/笔宽（风格预设会覆盖） ---
    bwF: 0.16, bwMin: 9, bwMax: 46, coverOv: 0.62,      // 笔宽 = 块厚×bwF，限幅；档间重叠 coverOv
    bwThickCap: 0,          // 照片小区域：笔宽最多是"真实厚度"的几倍（0=不限制）。
                            // 爪垫这种 3.7px 厚的纹理块原来用 12.8px 笔刷整块刷，细节被均值色抹平。
    bwThickArea: 4000,      // 只对可见面积小于它的照片区域收窄笔宽
    photoBlurPasses: 2,     // 照片分割前的 box3 次数（2=原来；1=保留更多细碎明暗，块更多、笔数更多）
    segSmallF: 2.5,         // 照片小区域的取色分段 = 厚度 × 它（下限 8px）：
                            // 原来 segMin=30 会把整块爪垫取成一个平均色，高光/阴影全丢
    joinPass: true,         // 同一区块来回的几档接成一条连续走笔（"像人一笔到底"，不是一档一笔）
    joinGap: 3,             // 连笔“接得上”的上限（像素）：两段之间跳得比它远就不能并
    joinCd: 18,             // 连笔的颜色上限（曼哈顿）：档间色差超过它就另起一笔。
                            // 实测 18（约 6 级/通道）是质量拐点：三张示例的成品指标都比不连笔更好；
                            // 24 以上开始把区块内的颜色变化抹平（海报可见差异 21.6% → 22.5%）
    taperLo: 0.86, taperAmp: 0.20, taperWob: 0.08,      // 笔压：两头细、中间粗、再抖一点
    // --- 起稿（"真起稿"会画得不准） ---
    sketchGrid: 6,          // 起稿路径按这个网格随手简化（越大越不准、越像真起稿）
    sketchOver: 5,          // 起稿两端的出锋（真起稿会画过头一点）
    // --- 自动/档位 ---
    autoColors: true,       // colors 为 0 时按纹理强度自动选色数（照片 32~36，插画 24）
    style: 'marker',        // 笔触风格：marker（平涂马克笔）/ pencil（铅笔速写）/ oil（油画厚涂）
    detail: 1,              // 老入参（兼容）：0/1/2 映射到 fidelity 1/3/5
    fidelity: 3,            // 还原程度 1 省笔 / 2 简洁 / 3 标准 / 4 精细 / 5 极致
    algo: 'layer',          // 算法：layer = 分层宽笔（API 默认）/ pyramid = 整幅逐级细化 / artist = 画家模式（网页端默认）
    // --- 精确颜色区覆盖（cover mode，默认开）---
    // 档位的含义从"补几轮"改成"颜色容差 + 笔数预算"：每个像素只属于一个颜色区，
    // 每个区一笔画完（矩形笔形 + 精确掩膜），最终逐像素误差 ≤ coverTMax。
    // 没有 residual / hole / seam / exactRepair 这些事后补笔。
    coverMode: true,
    coverT: 0,              // 0 = 按档位自动（8/6/4/2/1）：分组的色桶宽 = 2T+1
    coverTMax: 0,           // 0 = 按档位自动（20/16/12/8/2）：颜色容差硬上限；预算不够时 T 会往它靠
    coverBudget: 0,         // 0 = 按档位自动（[26k,45k,100k,175k,500k] 笔，绝对上限）
  };


  // ================= cover mode：颜色超像素 + 分层宽笔扫 =================
  // 五档走同一条人画管线，精度由算法参数区分（不是像素级对齐开关）：
  //   1) 颜色盒中位切分 → 同叶 8 连通区（细颜色区）；
  //   2) 相邻区按"并完仍能用 ±visTol 的颜色画全"合并成超像素块，块面积上限按档位收紧；
  //   3) 相邻 + 颜色相近的块并成"层"（照片类层更细），像人一样从后往前一层层画：
  //      底色层先按"完整形状"刷满整幅（主体底下也有底色，主体随后盖上去），其它层沿
  //      自己的主轴一档档重叠扫（旧 paintSweep 笔形：手抖 + 弓弯 + 出锋 + 出界笔），
  //      层间按遮挡关系排序，同色层优先凑到笔尖跟前连着画；
  //   4) 每条扫带的落墨掩膜 = 笔形光栅 ∩ 块像素，颜色按块取——观感照旧版，成品逐像素仍 ≤ 档位容差；
  //   5) 细线/文字块走中轴笔，最后按行"题字落款"；
  //   6) 每层铺色前先沿本层轮廓铅笔灰轻勾一笔再铺满（"先画大概的轮廓、再补充细节"）；
  //      临时灰线只落在"后面必有笔重涂"的像素上，纸底永不沾墨，成品一位都不变。
  // 没有 residual / 补漏 / exactRepair / 白点补笔，也没有虚焦底图。
  // ================= pyramid mode：整幅逐级细化（16 → 8 → 4 → 2 → 1） =================
  // 与 cover mode 并列的第二种算法（opts.algo = 'pyramid'）：
  //   1) 第一级整幅画一张"宽笔 + 宽容差"的粗稿（16px）：不求像素准，只求大色块和画面完整；
  //   2) 之后每一级只把"当前画布与目标差 > 本级容差"的像素交给 8px/4px/2px/1px 的笔重画，
  //      平坦且已经够准的地方不重复落笔；
  //   3) 最后一级容差 = 档位容差 V，颜色区按"并完每通道跨度 ≤ 2V"构建、段色取约束均值，
  //      数学上保证每个非纸底像素误差 ≤ V；第一级已覆盖全部非纸底像素，uncovered 恒为 0。
  // 粗稿不是低分辨率马赛克：颜色区仍在原分辨率上按颜色生长，只是容差松、笔宽大；
  // 笔触的落墨形状随色区走，不会出现方格网格。

  // ================= artist mode：观察 → 概括 → 起形 → 分层落笔 =================
  // 第三种算法（opts.algo = 'artist'）。和 cover/pyramid 的"逐像素重建"不同，这里先把
  // 图像看成"几张色面 + 几条结构线"：量化到有限色板、按颜色/相邻关系并成画块，找出
  // 主体与视觉中心，再按人的作画顺序生成有限笔触：
  //   ph0 起形：构图线 + 主体长轮廓（长而慢，先立大形）
  //   ph1 铺大色：背景大色面 → 主体大色面（大笔，优先把大关系铺满，再补小块）
  //   ph2 塑形：只在高显著/主体区域加中间笔触，沿结构方向走
  //   ph3 点睛：只画视觉中心的小结构，最后主动停笔
  // 三种笔触不是同一套笔触换皮：
  //   pencil = 长线起形 + 单向排线 + 暗部交叉排线 + 少量重音（不铺彩色底）
  //   marker = 有限色板大平涂 + 少量叠色 + 轮廓概括（保留纸白高光）
  //   oil    = 大笔色面 + 顺形体笔触 + 中间调塑形 + 视觉中心厚涂小笔
  async function runArtistMode(px, W, H, opts, onProgress) {
    const N = W * H;
    const prog = (p, msg) => { if (onProgress) onProgress(p, msg); };
    const yieldUI = () => new Promise((r) => setTimeout(r, 0));
    const t0 = Date.now();
    const style = opts.style === 'pencil' ? 'pencil' : (opts.style === 'oil' ? 'oil' : 'marker');
    const fid = Math.max(1, Math.min(5, opts.fidelity | 0));
    const scaleB = Math.max(0.62, Math.min(W, H) / 1024);
    const clamp01 = (v) => v < 0 ? 0 : (v > 1 ? 1 : v);
    const mix = (a, b, t) => [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t),
    ];
    const colorDist2 = (a, b) => {
      const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
      return dr * dr * 2 + dg * dg * 4 + db * db * 3;
    };

    prog(0.03, '观察：明暗与结构…');
    const R = new Uint8Array(N), G = new Uint8Array(N), B = new Uint8Array(N), L = new Uint8Array(N);
    for (let i = 0, p = 0; i < N; i++, p += 4) {
      const r = px[p], g = px[p + 1], b = px[p + 2];
      R[i] = r; G[i] = g; B[i] = b;
      L[i] = (0.299 * r + 0.587 * g + 0.114 * b + 0.5) | 0;
    }

    // 纸白：只认"从四边连进来的近白"，主体内部的白（猫毛、字）仍然要画。
    const paper = new Uint8Array(N);
    let paperPx = 0;
    {
      const q = new Int32Array(N);
      let head = 0, tail = 0;
      const push = (p) => {
        if (paper[p]) return;
        if (R[p] < 248 || G[p] < 248 || B[p] < 248) return;
        paper[p] = 1; q[tail++] = p;
      };
      for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
      for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
      while (head < tail) {
        const p = q[head++]; paperPx++;
        const x = p % W, y = (p - x) / W;
        if (x > 0) push(p - 1);
        if (x + 1 < W) push(p + 1);
        if (y > 0) push(p - W);
        if (y + 1 < H) push(p + W);
      }
    }

    // 可分离滑动盒模糊：观察用的低频图/结构张量都比逐像素高斯便宜，1024 图不卡。
    function blurU8(src, r) {
      if (r <= 0) return src.slice();
      const tmp = new Float32Array(N), out = new Uint8Array(N);
      const win = r * 2 + 1;
      for (let y = 0; y < H; y++) {
        const row = y * W;
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += src[row + (k < 0 ? 0 : (k >= W ? W - 1 : k))];
        for (let x = 0; x < W; x++) {
          tmp[row + x] = sum / win;
          const add = x + 1 + r, sub = x - r;
          sum += src[row + (add >= W ? W - 1 : add)] - src[row + (sub < 0 ? 0 : sub)];
        }
      }
      for (let x = 0; x < W; x++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += tmp[(k < 0 ? 0 : (k >= H ? H - 1 : k)) * W + x];
        for (let y = 0; y < H; y++) {
          out[y * W + x] = (sum / win + 0.5) | 0;
          const add = y + 1 + r, sub = y - r;
          sum += tmp[(add >= H ? H - 1 : add) * W + x] - tmp[(sub < 0 ? 0 : sub) * W + x];
        }
      }
      return out;
    }
    function blurF(src, r) {
      if (r <= 0) return Float32Array.from(src);
      const tmp = new Float32Array(N), out = new Float32Array(N);
      const win = r * 2 + 1;
      for (let y = 0; y < H; y++) {
        const row = y * W;
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += src[row + (k < 0 ? 0 : (k >= W ? W - 1 : k))];
        for (let x = 0; x < W; x++) {
          tmp[row + x] = sum / win;
          const add = x + 1 + r, sub = x - r;
          sum += src[row + (add >= W ? W - 1 : add)] - src[row + (sub < 0 ? 0 : sub)];
        }
      }
      for (let x = 0; x < W; x++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += tmp[(k < 0 ? 0 : (k >= H ? H - 1 : k)) * W + x];
        for (let y = 0; y < H; y++) {
          out[y * W + x] = sum / win;
          const add = y + 1 + r, sub = y - r;
          sum += tmp[(add >= H ? H - 1 : add) * W + x] - tmp[(sub < 0 ? 0 : sub) * W + x];
        }
      }
      return out;
    }

    // ---- 结构张量：flow = 边缘切线方向（排线/色面顺着结构走，而不是横平竖直）----
    const Lb = blurU8(L, Math.max(1, Math.round(scaleB)));
    const gx = new Float32Array(N), gy = new Float32Array(N), edge = new Float32Array(N);
    for (let y = 1; y < H - 1; y++) {
      let p = y * W + 1;
      for (let x = 1; x < W - 1; x++, p++) {
        const ax = (Lb[p + 1] - Lb[p - 1]) * 0.5;
        const ay = (Lb[p + W] - Lb[p - W]) * 0.5;
        gx[p] = ax; gy[p] = ay;
        edge[p] = Math.sqrt(ax * ax + ay * ay);
      }
    }
    const jr = Math.max(2, Math.round(3 * scaleB));
    let Jxx = new Float32Array(N), Jyy = new Float32Array(N), Jxy = new Float32Array(N);
    for (let p = 0; p < N; p++) { const a = gx[p], b = gy[p]; Jxx[p] = a * a; Jyy[p] = b * b; Jxy[p] = a * b; }
    Jxx = blurF(Jxx, jr); Jyy = blurF(Jyy, jr); Jxy = blurF(Jxy, jr);
    const flowX = new Float32Array(N), flowY = new Float32Array(N), coh = new Float32Array(N);
    for (let p = 0; p < N; p++) {
      const a = Jxx[p], b = Jxy[p], c = Jyy[p];
      const ang = 0.5 * Math.atan2(2 * b, a - c) + Math.PI * 0.5;
      flowX[p] = Math.cos(2 * ang); flowY[p] = Math.sin(2 * ang);
      const tr = a + c, df = a - c;
      coh[p] = tr > 1e-5 ? Math.sqrt(df * df + 4 * b * b) / tr : 0;
    }

    // ---- 显著度：中心 + 边缘密度 + 局部对比 + 肤色（人像的脸更容易成为视觉中心）----
    const edgeDens = blurF(edge, Math.max(3, Math.round(7 * scaleB)));
    const contrast = new Float32Array(N);
    {
      const big = blurU8(Lb, Math.max(6, Math.round(12 * scaleB)));
      for (let p = 0; p < N; p++) contrast[p] = Math.abs(Lb[p] - big[p]) / 72;
    }
    const sal = new Float32Array(N);
    const maxD = Math.hypot(W * 0.5, H * 0.5) || 1;
    for (let y = 0; y < H; y++) {
      let p = y * W;
      const dy = (y - H * 0.5) / maxD;
      for (let x = 0; x < W; x++, p++) {
        const dx = (x - W * 0.5) / maxD;
        const center = 1 - Math.min(1, Math.sqrt(dx * dx + dy * dy) * 1.15);
        const r = R[p], g = G[p], b = B[p];
        const skin = (r > 92 && g > 38 && b > 20 && r > g + 12 && r > b + 16 && r - g < 120) ? 1 : 0;
        sal[p] = 0.42 * clamp01(edgeDens[p] / 20) + 0.24 * clamp01(contrast[p]) +
                 0.26 * center + 0.10 * skin;
      }
    }
    {
      const hist = new Int32Array(64);
      let np = 0;
      for (let p = 0; p < N; p += 5) {
        if (paper[p]) continue;
        hist[Math.min(63, (sal[p] * 50) | 0)]++; np++;
      }
      let cum = 0, p90 = 1;
      for (let i = 0; i < 64; i++) { cum += hist[i]; if (cum >= np * 0.9) { p90 = (i + 1) / 50; break; } }
      p90 = Math.max(0.25, p90);
      for (let p = 0; p < N; p++) sal[p] = clamp01(sal[p] / p90);
    }

    // ---- 色板：颜色直方图 + 加权最远点。平涂图用众数色，浅橘/奶白不会被均值混成灰泥 ----
    // 铅笔的色板只用来分区，最终都转灰：色块少一点反而更像"概括过的形"；
    // 分得太碎时，暗部会碎成一堆小斑，猫的整块剪影就散了。
    // 色数随还原程度走：① 只有几个色（渐变被并成深/中/浅几块），⑤ 接近原图色阶。
    // ③ 仍是 10 色，基准档的逐像素结果不变。
    const Kbase = (style === 'marker' ? 10 : style === 'oil' ? 12 : 8) * (COMPILER_VIEW ? COMPILER_VIEW.k : 1);
    const K = Math.max(3, Math.min(64, Math.round(Kbase)));
    const stS = Math.max(2, Math.round(Math.sqrt(N / 70000)));
    const BINS = 16, binN = BINS * BINS * BINS;
    const bCnt = new Int32Array(binN), bR = new Float64Array(binN), bG = new Float64Array(binN), bB = new Float64Array(binN);
    let sampleN = 0;
    for (let y = 0; y < H; y += stS) {
      let p = y * W;
      for (let x = 0; x < W; x += stS, p += stS) {
        if (paper[p]) continue;
        const r = R[p], g = G[p], b = B[p];
        const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
        bCnt[key]++; bR[key] += r; bG[key] += g; bB[key] += b; sampleN++;
      }
    }
    const minBin = Math.max(2, Math.round(sampleN * 0.00008));
    const cands = [];
    for (let k = 0; k < binN; k++) {
      if (bCnt[k] < minBin) continue;
      cands.push({
        rgb: [Math.round(bR[k] / bCnt[k]), Math.round(bG[k] / bCnt[k]), Math.round(bB[k] / bCnt[k])],
        n: bCnt[k], used: 0,
      });
    }
    cands.sort((a, b) => b.n - a.n);
    const palette = [];
    if (cands.length) {
      palette.push(cands[0].rgb); cands[0].used = 1;
      while (palette.length < K) {
        let best = -1, bs = -1;
        for (let i = 0; i < cands.length; i++) {
          if (cands[i].used) continue;
          let bd = Infinity;
          for (const c of palette) {
            const d = colorDist2(cands[i].rgb, c);
            if (d < bd) bd = d;
          }
          const sc = Math.sqrt(cands[i].n) * bd;
          if (sc > bs) { bs = sc; best = i; }
        }
        if (best < 0) break;
        cands[best].used = 1;
        if (bs > 80) palette.push(cands[best].rgb);
      }
    }
    if (!palette.length) palette = [[128, 128, 128]];
    // 舌头/内耳/腮红这类"小面积但决定身份"的粉红色，直方图里占比太低，
    // 最远点选色常常轮不到；照片类单独补一个平均粉，色板仍然有限。
    {
      let pr = 0, pg = 0, pb = 0, pn = 0;
      for (let p = 0; p < N; p += 2) {
        if (paper[p]) continue;
        const r = R[p], g = G[p], b = B[p];
        const rg = r - g, gb = g - b;
        if (r < 80 || rg < 30 || rg > 110 || gb > 28) continue;
        const w = rg - 24;
        pr += r * w; pg += g * w; pb += b * w; pn += w;
      }
      if (pn > N * 0.0002) {
        const pc = [Math.round(pr / pn), Math.round(pg / pn), Math.round(pb / pn)];
        let bd = Infinity;
        for (const c of palette) bd = Math.min(bd, colorDist2(c, pc));
        if (bd > 260) palette.push(pc);
      }
    }
    palette.sort((a, b) => luma(a) - luma(b));
    // 低档位把图像量化到色板时，色板里"肉眼分不出的两个近似色"必须并掉：
    // 一片大面积渐变（浅粉圆盘）被量化成两个只差 3~5 个色阶的粉，
    // 分界线在成品里就是一块块看得见的圆角色斑——省笔档要的是"几块纯色"，
    // 不是"打了补丁的一整块"。只在量化档合并，标准档及以上不动。
    if (COMPILER_VIEW && COMPILER_VIEW.snap) {
      for (let i = 0; i < palette.length; i++) {
        for (let j = i + 1; j < palette.length;) {
          if (colorDist2(palette[i], palette[j]) < 760) {
            palette[i] = [
              Math.round((palette[i][0] + palette[j][0]) / 2),
              Math.round((palette[i][1] + palette[j][1]) / 2),
              Math.round((palette[i][2] + palette[j][2]) / 2)];
            palette.splice(j, 1);
          } else j++;
        }
      }
    }
    const nearestPalette = (c) => {
      let best = palette[0], bd = Infinity;
      for (let i = 0; i < palette.length; i++) {
        const d = colorDist2(palette[i], c);
        if (d < bd) { bd = d; best = palette[i]; }
      }
      return best;
    };
    // 马克笔的"暗一档"必须还在同一色系里。色板只有十来支，暗奶油（233,227,181）
    // 在加权色距下会吸到浅橙（250,165,151）上，字心就冒出粉块。调不到相近的
    // 暗色时宁可保持平涂——马克笔本来就是少叠色、靠色块和轮廓说话。
    const markerShade = (base, t) => {
      const want = mix(base, [0, 0, 0], t);
      const c = nearestPalette(want);
      return (luma(c) < luma(base) - 2 && colorDist2(c, base) < 5200) ? c : base;
    };

    // ---- 低档位：把图像本身量化到色板（"省笔 = 概括成几块纯色"）----
    // 量化发生在最前面：分区、取色、误差判定都跟着同一张量化图走，成品与目标一致，
    // 不会出现"目标还是渐变、笔却是色块"的色差。③ 档及更高档不动原图。
    // 落笔颜色也一并收敛到色板（跨色板色的区域均值会变成"补丁色"）。
    SNAP_OUT = (COMPILER_VIEW && COMPILER_VIEW.snap) ? nearestPalette : null;
    if (COMPILER_VIEW && COMPILER_VIEW.snap) {
      for (let p = 0; p < N; p++) {
        const c = nearestPalette([R[p], G[p], B[p]]);
        R[p] = c[0]; G[p] = c[1]; B[p] = c[2];
      }
      for (let p = 0; p < N; p++) L[p] = (0.299 * R[p] + 0.587 * G[p] + 0.114 * B[p] + 0.5) | 0;
    }

    // ---- 量化 + 去噪 + 连通区 ----
    prog(0.14, '概括：' + palette.length + ' 色 · 分块…');
    await yieldUI();
    const Kp = palette.length;
    const labels = new Int16Array(N).fill(-1);
    for (let p = 0; p < N; p++) {
      if (paper[p]) continue;
      const r = R[p], g = G[p], b = B[p];
      let best = 0, bd = Infinity;
      for (let k = 0; k < Kp; k++) {
        const c = palette[k];
        const dr = r - c[0], dg = g - c[1], db = b - c[2];
        const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
        if (d < bd) { bd = d; best = k; }
      }
      labels[p] = best;
    }
    // 3×3 多数表：去掉 JPEG/渐变造成的单像素杂色；强边缘保护，别把画里的线吃掉
    {
      const out = new Int16Array(labels);
      const cnt = new Int32Array(Kp), stamp = new Int32Array(Kp);
      let ep = 0;
      for (let y = 1; y < H - 1; y++) {
        let p = y * W + 1;
        for (let x = 1; x < W - 1; x++, p++) {
          if (paper[p] || edge[p] > 18) continue;
          ep++;
          let best = -1, bn = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const row = p + dy * W;
            for (let dx = -1; dx <= 1; dx++) {
              const lab = labels[row + dx];
              if (lab < 0) continue;
              if (stamp[lab] !== ep) { stamp[lab] = ep; cnt[lab] = 0; }
              const c = ++cnt[lab];
              if (c > bn || (c === bn && lab === labels[p])) { bn = c; best = lab; }
            }
          }
          if (bn >= 5 && best >= 0) out[p] = best;
        }
      }
      for (let p = 0; p < N; p++) if (paper[p]) out[p] = -1;
      labels.set(out);
    }
    // 平涂判定 / 纹理强度在连通区之前算，决定碎块阈值和总预算。
    // 平涂判定用与笔刷风格无关的 4-bit 颜色直方图（bCnt）：前 6 个颜色格占
    // 非纸底像素的比例。按"量化后的色板标签"算会随笔刷变化（马克笔 K=10、
    // 油画 K=12），同一张海报在两种笔刷下会一个判平涂、一个判照片，笔数差 4 倍。
    // 实测 top6 占比：简笔平涂插画 0.91，海报 0.55、人像 0.38、风景 0.45，间隔很清楚。
    let top6bin = 0;
    const binsSorted = Array.from(bCnt).sort((a, b) => b - a);
    for (let i = 0; i < 6; i++) top6bin += binsSorted[i] || 0;
    const flatScore = sampleN > 0 ? top6bin / sampleN : 1;
    const eHist = new Int32Array(256);
    for (let p = 0; p < N; p += 2) if (!paper[p]) eHist[Math.min(255, edge[p] | 0)]++;
    let eTot = 0; for (let i = 0; i < 256; i++) eTot += eHist[i];
    let eCum = 0, e85 = 24;
    for (let i = 0; i < 256; i++) { eCum += eHist[i]; if (eCum >= eTot * 0.85) { e85 = Math.max(6, i); break; } }
    let eStrong = 0; for (let i = e85; i < 256; i++) eStrong += eHist[i];
    const edgeDensity = eTot > 0 ? eStrong / eTot : 0;
    const complexity = Math.max(0.78, Math.min(1.6, 0.78 + edgeDensity * 3.2));
    const isFlat = flatScore > 0.75;

    const cc = compsOfLabels(labels, W, H);
    const compOf = cc.compOf, comps = cc.comps;
    const C = comps.length;
    const parent = new Int32Array(C).fill(-1);
    const kept = new Uint8Array(C);
    const minArea = isFlat ? Math.max(28, Math.round(N * 0.00012)) : Math.max(24, Math.round(N * 0.00005));
    // 碎块并进邻近色最近的块：孤立噪点不会各自成一笔
    const small = [];
    for (let ci = 0; ci < C; ci++) {
      const cp = comps[ci];
      if (cp.label < 0) continue;
      if (cp.count >= minArea) kept[ci] = 1;
      else small.push(ci);
    }
    small.sort((a, b) => comps[b].count - comps[a].count);
    for (let pass = 0; pass < 2; pass++) {
      for (const ci of small) {
        if (parent[ci] >= 0) continue;
        const cp = comps[ci];
        if (cp.label < 0) continue;
        let best = -1, bestKept = 0, bestD = Infinity, bestN = -1;
        for (let k = 0; k < cp.count; k++) {
          const p = cc.pix[cp.start + k];
          const x = p % W, y = (p - x) / W;
          for (let d = 0; d < 4; d++) {
            const q = d === 0 ? (x > 0 ? p - 1 : -1) : d === 1 ? (x + 1 < W ? p + 1 : -1) :
              d === 2 ? (y > 0 ? p - W : -1) : (y + 1 < H ? p + W : -1);
            if (q < 0) continue;
            const cj = compOf[q];
            if (cj === ci || cj < 0 || comps[cj].label < 0) continue;
            const dd = colorDist2(palette[comps[cj].label], palette[cp.label]);
            const kJ = kept[cj] ? 1 : 0;
            if (kJ > bestKept || (kJ === bestKept && dd < bestD) ||
                (kJ === bestKept && dd === bestD && comps[cj].count > bestN)) {
              best = cj; bestKept = kJ; bestD = dd; bestN = comps[cj].count;
            }
          }
        }
        if (best >= 0) parent[ci] = best;
      }
    }
    for (let p = 0; p < N; p++) {
      let ci = compOf[p];
      if (ci < 0 || comps[ci].label < 0) { compOf[p] = -1; continue; }
      let guard = 0;
      while (parent[ci] >= 0 && guard++ < 64) ci = parent[ci];
      compOf[p] = ci;
      kept[ci] = 1;
    }
    const cArea = new Int32Array(C);
    for (let p = 0; p < N; p++) { const ci = compOf[p]; if (ci >= 0) cArea[ci]++; }

    // ---- 块统计 / 主体与背景 ----
    prog(0.28, '辨认主体与视觉中心…');
    await yieldUI();
    const cSumR = new Float64Array(C), cSumG = new Float64Array(C), cSumB = new Float64Array(C);
    const cSumL = new Float64Array(C), cSumSal = new Float64Array(C), cSumEdge = new Float64Array(C);
    const cX0 = new Int32Array(C).fill(W), cY0 = new Int32Array(C).fill(H);
    const cX1 = new Int32Array(C).fill(-1), cY1 = new Int32Array(C).fill(-1);
    const cSx = new Float64Array(C), cSy = new Float64Array(C);
    const cSxx = new Float64Array(C), cSxy = new Float64Array(C), cSyy = new Float64Array(C);
    const cFlowX = new Float64Array(C), cFlowY = new Float64Array(C), cFlowW = new Float64Array(C);
    const cBorder = new Uint8Array(C);
    for (let y = 0; y < H; y++) {
      let p = y * W;
      for (let x = 0; x < W; x++, p++) {
        const ci = compOf[p];
        if (ci < 0) continue;
        cSumR[ci] += R[p]; cSumG[ci] += G[p]; cSumB[ci] += B[p]; cSumL[ci] += L[p];
        cSumSal[ci] += sal[p]; cSumEdge[ci] += edge[p];
        if (x < cX0[ci]) cX0[ci] = x; if (x > cX1[ci]) cX1[ci] = x;
        if (y < cY0[ci]) cY0[ci] = y; if (y > cY1[ci]) cY1[ci] = y;
        cSx[ci] += x; cSy[ci] += y;
        cSxx[ci] += x * x; cSxy[ci] += x * y; cSyy[ci] += y * y;
        const fw = 0.15 + edge[p];
        cFlowX[ci] += flowX[p] * fw; cFlowY[ci] += flowY[p] * fw; cFlowW[ci] += fw;
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) cBorder[ci] = 1;
      }
    }
    const compInfo = new Array(C);
    for (let ci = 0; ci < C; ci++) {
      const a = cArea[ci];
      if (a <= 0) { compInfo[ci] = null; continue; }
      const bw = cX1[ci] - cX0[ci] + 1, bh = cY1[ci] - cY0[ci] + 1;
      const cx = cSx[ci] / a, cy = cSy[ci] / a;
      const vx = Math.max(0.01, cSxx[ci] / a - cx * cx);
      const vy = Math.max(0.01, cSyy[ci] / a - cy * cy);
      const vxy = cSxy[ci] / a - cx * cy;
      const tr = vx + vy, df = vx - vy;
      const e1 = tr * 0.5 + Math.sqrt(df * df * 0.25 + vxy * vxy);
      const e2 = Math.max(0.01, tr * 0.5 - Math.sqrt(df * df * 0.25 + vxy * vxy));
      compInfo[ci] = {
        ci, area: a, cx, cy, x0: cX0[ci], y0: cY0[ci], x1: cX1[ci], y1: cY1[ci],
        bw, bh, fill: a / Math.max(1, bw * bh), thick: a / Math.max(1, Math.max(bw, bh)),
        elong: Math.sqrt(e1 / e2), angle: 0.5 * Math.atan2(2 * vxy, vx - vy),
        mean: [Math.round(cSumR[ci] / a), Math.round(cSumG[ci] / a), Math.round(cSumB[ci] / a)],
        luma: cSumL[ci] / a, sal: cSumSal[ci] / a, edge: cSumEdge[ci] / a,
        border: !!cBorder[ci], label: comps[ci].label,
      };
    }

    // 背景：贴边 + 低显著（或极大）。背景同色块的笔触预算合并，先铺背景再画主体。
    const compBg = new Uint8Array(C);
    for (let ci = 0; ci < C; ci++) {
      const g = compInfo[ci];
      if (!g) continue;
      // 照片的石头/树叶背景纹理很强，用平涂图的显著性阈值会把整幅都判成主体；
      // 非平涂放宽贴边组的显著性门槛，让背景先归位。
      const salTol = isFlat ? (g.area > N * 0.05 ? 0.55 : 0.62) : 0.80;
      const bg = g.border && (g.sal < salTol);
      compBg[ci] = bg ? 1 : 0;
    }
    // 背景同色带的合并：从贴边背景出发，沿"区块相邻 + 颜色接近种子背景"泛洪。
    // 平涂图常有内圈浅色带/色环，它们不贴边，但仍是背景；只靠 border 会当成主体。
    {
      const cAdj = new Array(C);
      for (let i = 0; i < C; i++) cAdj[i] = new Set();
      const addEdge = (a, b) => {
        if (a === b || a < 0 || b < 0) return;
        if (!cAdj[a].has(b)) { cAdj[a].add(b); cAdj[b].add(a); }
      };
      for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
          const p = row + x, a = compOf[p];
          if (a < 0) continue;
          if (x + 1 < W) addEdge(a, compOf[p + 1]);
          if (y + 1 < H) addEdge(a, compOf[p + W]);
        }
      }
      const q = [];
      const seed = new Float64Array(C * 3).fill(-1);
      for (let ci = 0; ci < C; ci++) {
        if (!compBg[ci] || !compInfo[ci]) continue;
        q.push(ci);
        seed[ci * 3] = compInfo[ci].mean[0];
        seed[ci * 3 + 1] = compInfo[ci].mean[1];
        seed[ci * 3 + 2] = compInfo[ci].mean[2];
      }
      for (let head = 0; head < q.length; head++) {
        const ci = q[head];
        const sc = [seed[ci * 3], seed[ci * 3 + 1], seed[ci * 3 + 2]];
        for (const nb of cAdj[ci]) {
          if (compBg[nb]) continue;
          const g = compInfo[nb];
          if (!g || g.area < N * 0.0003 || g.sal >= (isFlat ? 0.75 : 0.88)) continue;
          if (colorDist2(g.mean, sc) > (isFlat ? 900 : 2000)) continue;
          compBg[nb] = 1;
          seed[nb * 3] = sc[0]; seed[nb * 3 + 1] = sc[1]; seed[nb * 3 + 2] = sc[2];
          q.push(nb);
        }
      }
    }
    // 组：每个连通块一组。背景不再按色板标签归一：
    // 同一暗色会同时出现在猫的斑纹、石头阴影和树丛里，合并后得到一个横跨整幅、
    // fill<0.1 的碎片组，扫线根本落不进去（实测 made=0）。
    // 更关键的是，归一后的组色和像素自己的量化色不一致：奶油字的组被映射成
    // 蓝/粉后，铺色和质检的 qimg 各说各话，字心就冒出彩色补丁。
    // 每个连通块保留自己的量化色，形状紧实，扫线扫得满，成品和计划同色。
    const compGroup = new Int32Array(C).fill(-1);
    const groupList = [];
    for (let ci = 0; ci < C; ci++) {
      const g = compInfo[ci];
      if (!g) continue;
      const gid = groupList.length;
      groupList.push({ bg: compBg[ci] ? 1 : 0, label: g.label });
      compGroup[ci] = gid;
    }
    let G_ = groupList.length;
    const groupOf = new Int32Array(N).fill(-1);
    for (let p = 0; p < N; p++) { const ci = compOf[p]; if (ci >= 0) groupOf[p] = compGroup[ci]; }
    const gArea = new Int32Array(G_), gSumR = new Float64Array(G_), gSumG = new Float64Array(G_), gSumB = new Float64Array(G_);
    const gSumL = new Float64Array(G_), gSumSal = new Float64Array(G_), gSumEdge = new Float64Array(G_);
    const gX0 = new Int32Array(G_).fill(W), gY0 = new Int32Array(G_).fill(H);
    const gX1 = new Int32Array(G_).fill(-1), gY1 = new Int32Array(G_).fill(-1);
    const gSx = new Float64Array(G_), gSy = new Float64Array(G_);
    const gSxx = new Float64Array(G_), gSxy = new Float64Array(G_), gSyy = new Float64Array(G_);
    const gFx = new Float64Array(G_), gFy = new Float64Array(G_), gFw = new Float64Array(G_);
    for (let y = 0; y < H; y++) {
      let p = y * W;
      for (let x = 0; x < W; x++, p++) {
        const gid = groupOf[p];
        if (gid < 0) continue;
        gArea[gid]++; gSumR[gid] += R[p]; gSumG[gid] += G[p]; gSumB[gid] += B[p];
        gSumL[gid] += L[p]; gSumSal[gid] += sal[p]; gSumEdge[gid] += edge[p];
        if (x < gX0[gid]) gX0[gid] = x; if (x > gX1[gid]) gX1[gid] = x;
        if (y < gY0[gid]) gY0[gid] = y; if (y > gY1[gid]) gY1[gid] = y;
        gSx[gid] += x; gSy[gid] += y; gSxx[gid] += x * x; gSxy[gid] += x * y; gSyy[gid] += y * y;
        const fw = 0.15 + edge[p];
        gFx[gid] += flowX[p] * fw; gFy[gid] += flowY[p] * fw; gFw[gid] += fw;
      }
    }
    const groups = [];
    for (let gi = 0; gi < G_; gi++) {
      const a = gArea[gi];
      if (a <= 0) continue;
      const bw = gX1[gi] - gX0[gi] + 1, bh = gY1[gi] - gY0[gi] + 1;
      const cx = gSx[gi] / a, cy = gSy[gi] / a;
      const vx = Math.max(0.01, gSxx[gi] / a - cx * cx);
      const vy = Math.max(0.01, gSyy[gi] / a - cy * cy);
      const vxy = gSxy[gi] / a - cx * cy;
      const tr = vx + vy, df = vx - vy;
      const e1 = tr * 0.5 + Math.sqrt(df * df * 0.25 + vxy * vxy);
      const e2 = Math.max(0.01, tr * 0.5 - Math.sqrt(df * df * 0.25 + vxy * vxy));
      const mean = [Math.round(gSumR[gi] / a), Math.round(gSumG[gi] / a), Math.round(gSumB[gi] / a)];
      groups.push({
        gid: gi, bg: groupList[gi].bg, label: groupList[gi].label, area: a,
        x0: gX0[gi], y0: gY0[gi], x1: gX1[gi], y1: gY1[gi], bw, bh,
        cx, cy, angle: 0.5 * Math.atan2(2 * vxy, vx - vy), elong: Math.sqrt(e1 / e2),
        thick: a / Math.max(1, Math.max(bw, bh)), fill: a / Math.max(1, bw * bh),
        mean, pal: palette[groupList[gi].label] || mean,
        luma: gSumL[gi] / a, sal: gSumSal[gi] / a, edge: gSumEdge[gi] / a,
        flowCoh: Math.hypot(gFx[gi], gFy[gi]) / Math.max(1e-6, gFw[gi]),
        flowAngle: 0.5 * Math.atan2(gFy[gi], gFx[gi]),
      });
    }
    // 线稿网络（fill 极低的细线连通域）：扫线会把一根根线切成碎片，必须走骨架。
    const gidLuma = new Float64Array(G_);
    for (const g of groups) gidLuma[g.gid] = g.luma;
    for (const g of groups) {
      g.lineArt = (g.fill < 0.14 && g.thick < 26 && g.area > 200 && g.area < N * 0.05) ? 1 : 0;
      // 铅笔里，粗短线（闭眼弧、嘴、头顶线）也会被当成小色块排线，结果排成虚线；
      // 这类"深色细长块"直接走骨架，才能一笔连到底。彩笔仍按色块铺，保留粗眼线。
      g.inkOnly = (style === 'pencil' && !g.bg && g.luma < 112 && g.thick < 18 &&
        g.fill < 0.45 && g.area > 20 && g.area < N * 0.01) ? 1 : 0;
      // 照片量化后，任意两块颜色之间都夹着一条 1~2px 的过渡色细条，
      // 全按线稿描出来就是"填色书轮廓"。真正的轮廓线两侧明暗差很大，
      // 纹理过渡条两侧几乎同色——按"两侧对比"筛，而不是按线本身深浅。
      if ((g.lineArt || g.inkOnly) && !isFlat) {
        const step = Math.max(1, Math.round(Math.sqrt(g.bw * g.bh / 600)));
        let lmin = 255, lmax = 0;
        for (let y = Math.max(0, g.y0); y <= Math.min(H - 1, g.y1); y += step) {
          const row = y * W;
          for (let x = Math.max(0, g.x0); x <= Math.min(W - 1, g.x1); x += step) {
            const p = row + x;
            if (groupOf[p] !== g.gid) continue;
            for (let d = 0; d < 4; d++) {
              const q = d === 0 ? (x > 0 ? p - 1 : -1) : d === 1 ? (x + 1 < W ? p + 1 : -1) :
                d === 2 ? (y > 0 ? p - W : -1) : (y + 1 < H ? p + W : -1);
              if (q < 0) continue;
              const h = groupOf[q];
              if (h < 0 || h === g.gid) continue;
              const hl = gidLuma[h];
              if (hl < lmin) lmin = hl; if (hl > lmax) lmax = hl;
            }
          }
        }
        g.edgeContrast = lmax - lmin;
        if (g.lineArt && lmax - lmin < 34) g.lineArt = 0;
      }
    }
    if (opts.debug) {
      const la = groups.filter((g) => g.lineArt).length, io = groups.filter((g) => g.inkOnly).length;
      console.log('[line] lineArt=' + la + ' inkOnly=' + io);
    }
    // 主体：不贴边、显著度够的组；太少就退化为"最显著的几组"
    const subjectFlag = new Uint8Array(G_);
    let subjectArea = 0;
    for (const g of groups) {
      if (!g.bg && g.area >= Math.max(24, N * 0.00035) && g.sal >= 0.18) {
        subjectFlag[g.gid] = 1; subjectArea += g.area;
      }
    }
    if (subjectArea < N * 0.006) {
      const cand = groups.slice().sort((a, b) => (b.area * b.sal) - (a.area * a.sal)).slice(0, 6);
      subjectFlag.fill(0); subjectArea = 0;
      for (const g of cand) { subjectFlag[g.gid] = 1; subjectArea += g.area; }
    }
    const subject = new Uint8Array(N);
    const contentMask = new Uint8Array(N);
    let sSx = 0, sSy = 0, sSxx = 0, sSxy = 0, sSyy = 0, sN2 = 0;
    let sx0 = W, sy0 = H, sx1 = -1, sy1 = -1;
    let ctX0 = W, ctY0 = H, ctX1 = -1, ctY1 = -1;
    for (let y = 0; y < H; y++) {
      let p = y * W;
      for (let x = 0; x < W; x++, p++) {
        const gid = groupOf[p];
        if (gid >= 0) {
          contentMask[p] = 1;
          if (x < ctX0) ctX0 = x; if (x > ctX1) ctX1 = x;
          if (y < ctY0) ctY0 = y; if (y > ctY1) ctY1 = y;
        }
        if (gid < 0 || !subjectFlag[gid]) continue;
        subject[p] = 1; sN2++;
        sSx += x; sSy += y; sSxx += x * x; sSxy += x * y; sSyy += y * y;
        if (x < sx0) sx0 = x; if (x > sx1) sx1 = x;
        if (y < sy0) sy0 = y; if (y > sy1) sy1 = y;
      }
    }
    if (ctX1 < 0) { ctX0 = 0; ctY0 = 0; ctX1 = W - 1; ctY1 = H - 1; }
    if (!sN2) { sx0 = ctX0; sy0 = ctY0; sx1 = ctX1; sy1 = ctY1; sSx = (ctX0 + ctX1) * 0.5 * N; sSy = (ctY0 + ctY1) * 0.5 * N; sN2 = N; }
    const sCx = sSx / Math.max(1, sN2), sCy = sSy / Math.max(1, sN2);
    const sVx = Math.max(0.01, sSxx / Math.max(1, sN2) - sCx * sCx);
    const sVy = Math.max(0.01, sSyy / Math.max(1, sN2) - sCy * sCy);
    const sVxy = sSxy / Math.max(1, sN2) - sCx * sCy;
    const subjAngle = 0.5 * Math.atan2(2 * sVxy, sVx - sVy);
    const topSub = groups.filter((g) => subjectFlag[g.gid])
      .sort((a, b) => (b.sal * Math.sqrt(b.area)) - (a.sal * Math.sqrt(a.area)));
    let focalX = sCx, focalY = sCy;
    {
      let vx2 = 0, vy2 = 0, vw = 0;
      for (let i = 0; i < Math.min(3, topSub.length); i++) {
        const w = topSub[i].sal * topSub[i].area;
        vx2 += topSub[i].cx * w; vy2 += topSub[i].cy * w; vw += w;
      }
      if (vw > 0) { focalX = vx2 / vw; focalY = vy2 / vw; }
    }
    // 视觉中心：优先用"粉红/皮肤特征"（嘴唇、舌头、内耳、腮红）的加权重心。
    // 照片里大块白胸/橘背的 sal×area 会把焦点拉回身体，而五官才是辨识核心。
    {
      let px2 = 0, py2 = 0, pw = 0;
      for (let y = 0; y < H; y++) {
        let p = y * W;
        for (let x = 0; x < W; x++, p++) {
          if (paper[p]) continue;
          const rr = R[p], gg = G[p], bb = B[p];
          const rg = rr - gg, gb = gg - bb;
          if (rg < 28 || gb < 0 || gb > 30) continue;
          const w = (rg - 22) * (32 - gb);
          if (w <= 0) continue;
          px2 += x * w; py2 += y * w; pw += w;
        }
      }
      if (pw > N * 0.0004) {
        const fx = px2 / pw, fy = py2 / pw;
        if (fx > W * 0.04 && fx < W * 0.96 && fy > H * 0.04 && fy < H * 0.96) {
          focalX = fx; focalY = fy;
        }
      }
    }
    const subj = {
      x: sCx, y: sCy, angle: subjAngle, x0: sx0, y0: sy0, x1: sx1, y1: sy1,
      focalX, focalY,
    };
    groups.sort((a, b) => (b.bg - a.bg) || (b.area - a.area));
    const subjectD = dilate(subject, W, H, Math.max(1, Math.round(2 * scaleB)));

    if (opts.debug) {
      console.log('[focal]', Math.round(subj.focalX), Math.round(subj.focalY), 'subj', subj.count, 'bbox', subj.x0, subj.y0, subj.x1, subj.y1);
      const peaks = [];
      const minD = Math.min(W, H) * 0.07;
      for (let p = 0; p < N; p += 2) {
        if (paper[p] || sal[p] < 0.62) continue;
        const x = p % W, y = (p - x) / W;
        let ok = true;
        for (const q of peaks) if (Math.hypot(q.x - x, q.y - y) < minD) { ok = false; break; }
        if (!ok) continue;
        peaks.push({ x, y, s: sal[p], e: edge[p], gid: groupOf[p] });
        peaks.sort((a, b) => b.s - a.s);
        if (peaks.length > 12) peaks.length = 12;
      }
      console.log('[peaks]', peaks.slice(0, 8).map((q) => q.x + ',' + q.y + ':' + q.s.toFixed(2) + '/' + q.e.toFixed(1) + '/g' + q.gid).join(' '));
      console.log('[topSub]', topSub.slice(0, 8).map((g) => 'g' + g.gid + ' a' + g.area + ' s' + g.sal.toFixed(2) + ' b' + g.x0 + ',' + g.y0 + '-' + g.x1 + ',' + g.y1).join(' | '));
    }
    // ---- 预算：简单平涂给几十~一两百笔，照片给几百~一两千笔；档位只加"点睛"的余量 ----
    const flatHeavy = isFlat && G_ > 45;
    const flatFactor = isFlat ? (flatHeavy ? 1.45 : 1.08) : 3.0;
    const budgetBase = style === 'marker' ? [55, 85, 150, 215, 300] : style === 'oil' ? [70, 105, 160, 230, 330] : [90, 140, 210, 300, 430];
    let budget = Math.max(36, Math.round(budgetBase[fid - 1] * flatFactor * complexity));
    // 平涂但块数多的画面（海报、带文字/图案的插画）不能按"几十个色块"的额度给：
    // 至少每组约两笔，否则大片底色之间露白。
    if (isFlat) budget = Math.max(budget, Math.round(G_ * 1.9));
    // 照片默认档也要能把大色面铺满：2100 笔时约 1/3 画面还是模糊底透出来。
    // 2600 仍落在"2000~3000 笔有意义的笔触"区间内；简单平涂的档位不变。
    const hardCap = (isFlat ? [240, 360, 520, 760, 1100] : [1100, 1700, 2600, 3400, 4400])[fid - 1];
    const baseBudget = Math.max(24, Math.round(budget * 0.68));
    // 照片的识别度靠视觉中心的小笔，不靠再铺一遍大色块；给塑形/点睛单独留额度。
    // 底色层铺完还有几十万像素没被色块笔盖住，额度必须放到硬上限附近，
    // 否则大色面只铺一半、剩下的靠模糊底透出来，脸和毛色分区都会糊。
    const detailBudget = isFlat ? budget : Math.max(budget, hardCap - 300);
    // 铺色不能把硬上限吃光：以前照片铺完直接顶到 2600，ph2 只剩 0~12 笔，
    // "塑形"和"点睛"两段等于消失，铅笔也没有排线可看。到硬上限前先留出额度。
    const accentReserve = isFlat ? 0 : (style === 'pencil' ? 72 : 36);
    const detailReserve = isFlat ? 0 : Math.max(60,
      Math.round(budget * (style === 'pencil' ? 0.50 : 0.36)));
    const baseCap = Math.max(24, hardCap - detailReserve - accentReserve);
    // 海报/字稿（线稿块多）和照片（几乎没有线稿块）在铅笔下不是一回事：
    // 前者奶白色面是字心，排线会糊住字；后者白毛需要稀排线交代体积。
    const graphic = groups.reduce((n, g) => n + (g.lineArt ? 1 : 0), 0) >= 12;
    const styleW0 = style === 'marker' ? [110, 92, 74, 58, 44] : style === 'oil' ? [122, 100, 82, 64, 48] : [0, 0, 0, 0, 0];
    let baseBrush = Math.max(style === 'pencil' ? 3 : 8, styleW0[fid - 1] * scaleB);
    const styleStep = style === 'oil' ? 0.64 : 0.71;
    const styleMin = style === 'marker' ? 9 : (style === 'oil' ? 7 : 2.2);
    // 只有"整幅的大平色面"（海报蓝底这类）才换大侧锋；照片的深色毛/石墙
    // 虽然面积大、边缘低，仍要用中号笔保留形体和笔触，否则会变成几何色块。
    const bigFlatPencil = (g) => style === 'pencil' && !isFlat &&
      g.area > N * 0.08 && g.edge < 4 && g.fill > 0.5;
    function groupBrush(g) {
      let bw = baseBrush * (g.bg ? 1.28 : 1);
      bw *= 1 - 0.16 * Math.min(1, g.sal);
      bw = Math.min(bw, Math.max(2.5, g.thick * 1.5));
      if (g.area < bw * bw * 1.7) bw = Math.max(2.2, Math.sqrt(g.area) * 0.95);
      // 铅笔的大而平的色面（海报蓝底）要换侧锋：30px 的笔加有限预算只能铺到
      // 六成，剩下四成露出 wash 的局部明暗，就成了规则竖条。用大笔一趟铺满，
      // 整块是同一明度，条纹自然消失，笔触也更像人。
      if (bigFlatPencil(g)) {
        bw = Math.max(bw, Math.min(165 * scaleB, Math.sqrt(g.area) * 0.45));
      }
      return Math.max(styleMin, Math.min(165 * scaleB, bw));
    }
    {
      let est = 0;
      for (const g of groups) {
        const bw = groupBrush(g);
        est += g.area / Math.max(4, bw * bw * styleStep);
      }
      if (est > baseBudget * 1.02) {
        const scale = Math.min(2.6, Math.sqrt(est / (baseBudget * 1.02)));
        baseBrush = Math.min(165 * scaleB, baseBrush * scale);
      }
    }
    function regionAngle(g) {
      if (g.elong > 1.85) return g.angle;
      if (g.flowCoh > 0.16 && isFinite(g.flowAngle)) return g.flowAngle;
      if (g.bg) return (W >= H ? 0 : Math.PI * 0.5);
      return g.angle;
    }

    // ---- 规划画布 / 覆盖率 ----
    const canvas = new Uint8Array(N * 3);
    canvas.fill(255);
    const covered = new Uint8Array(N);
    // 底色层(wash)会先把整幅 covered 打成 1，拿 covered 判断"这块还差哪里"就永远为 0；
    // 单记一份"被本块自己的笔涂过"的位图，补漏/覆盖率才准。
    const paintN = new Uint8Array(N);
    let zoneCov = 0;
    let coveredN = 0;
    let groupUncov = new Int32Array(G_);
    let gStrokeN = new Int32Array(G_);
    for (const g of groups) groupUncov[g.gid] = g.area;
    const strokes = [], clips = [];
    let maskPx = 0;
    let forcePaint = false;
    const pushClip = (x, y, w, h, mask) => { maskPx += w * h; clips.push({ x, y, w, h, mask }); return clips.length - 1; };

    function sampleColor(mask, bw, bh, bx, by, stride) {
      let sr = 0, sg = 0, sb = 0, n = 0;
      for (let y = 0; y < bh; y += stride) {
        const row = (by + y) * W + bx;
        for (let x = 0; x < bw; x += stride) {
          if (!mask[y * bw + x]) continue;
          const p = row + x;
          sr += R[p]; sg += G[p]; sb += B[p]; n++;
        }
      }
      return n ? [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)] : null;
    }

    // 一笔：spine（绝对坐标）+ 每点半宽 → 变宽走廊 + 1 位掩膜
    // zoneGid / zoneMask 二选一：把笔形裁进"这个画块/主体"，形状不会糊到隔壁
    let strokeSeed = 0;
    function emitStroke(spine, halfs, color, ph, opt) {
      opt = opt || {};
      const n = spine.length >> 1;
      if (n < 2) return -1;
      if (ph > 0 && strokes.length >= hardCap && !opt.ignoreCap) return -1;
      const rib = ribbonProf(spine, n, halfs, false);
      let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
      for (let i = 0; i < rib.length; i += 2) {
        const x = rib[i], y = rib[i + 1];
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (y < miny) miny = y; if (y > maxy) maxy = y;
      }
      const bx = Math.max(0, Math.floor(minx)), by = Math.max(0, Math.floor(miny));
      const bw = Math.min(W - bx, Math.ceil(maxx) - bx + 1), bh = Math.min(H - by, Math.ceil(maxy) - by + 1);
      if (bw <= 0 || bh <= 0) return -1;
      const local = new Array(rib.length);
      for (let i = 0; i < rib.length; i += 2) { local[i] = rib[i] - bx; local[i + 1] = rib[i + 1] - by; }
      const mask = new Uint8Array(bw * bh);
      fillPoly(mask, bw, bh, local);
      let nInk = 0;
      const zg = opt.zoneGid === undefined ? -1 : opt.zoneGid;
      const zm = opt.zoneMask || null;
      const zmr = opt.zoneMaskRect || null;   // bbox 局部掩膜（结构笔用，省一次全图拷贝）
      for (let y = 0; y < bh; y++) {
        const row = (by + y) * W + bx;
        let mr = y * bw;
        for (let x = 0; x < bw; x++, mr++) {
          if (!mask[mr]) continue;
          const p = row + x;
          // 严格按像素标签裁剪。以前允许 1px 出界"融合"，但细描边/字边的
          // 每一层奶油像素都紧挨红描边，出界规则会把整条描边加宽成色块，
          // 字心就被啃出红/蓝的缺口。像素只属于一个色块，各画各的不会露缝。
          if (zg >= 0 && groupOf[p] !== zg) { mask[mr] = 0; continue; }
          if (zm && !zm[p]) { mask[mr] = 0; continue; }
          if (zmr) {
            const zx = bx + x - zmr.x0, zy = by + y - zmr.y0;
            if (zx < 0 || zy < 0 || zx >= zmr.w || zy >= zmr.h || !zmr.m[zy * zmr.w + zx]) {
              mask[mr] = 0; continue;
            }
          }
          nInk++;
        }
      }
      // 像素级二级抖动：把"比 8 位色阶更细"的局部均值落成两笔互补的 Bayer 网点。
      // 平涂背景的渐变每个像素只差零点几，用整块纯色画出来会在色阶处留下
      // 一圈圈马赫色带；两笔交错的网点在正常观看距离下融合成连续过渡，
      // 和原图自带的细噪声同一观感。
      let autoCol = null;
      if (opt.ditherAuto && nInk > 0) {
        // 只用本笔实际盖住的像素算浮点均值：扫带在色区边界上也不会取到隔壁/纸白。
        let sr = 0, sg = 0, sb = 0, sn = 0;
        for (let y = 0; y < bh; y++) {
          const row = (by + y) * W + bx;
          let mr = y * bw;
          for (let x = 0; x < bw; x++, mr++) {
            if (!mask[mr]) continue;
            const p = row + x;
            sr += R[p]; sg += G[p]; sb += B[p];
            sn++;
          }
        }
        if (sn) {
          const fr = [sr / sn, sg / sn, sb / sn];
          const ratio = Math.max(0.03, Math.min(0.97,
            (fr[0] - Math.floor(fr[0]) + fr[1] - Math.floor(fr[1]) + fr[2] - Math.floor(fr[2])) / 3));
          const lo = [Math.floor(fr[0]), Math.floor(fr[1]), Math.floor(fr[2])];
          const hi = [Math.min(255, lo[0] + 1), Math.min(255, lo[1] + 1), Math.min(255, lo[2] + 1)];
          const sel = opt.ditherPx && opt.ditherPx.sel ? 1 : 0;
          autoCol = sel ? hi : lo;
          if (opt.ditherPx) opt.ditherPx.ratio = ratio;
        }
      }
      if (opt.ditherPx && nInk > 0) {
        const BAY = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
        const th = opt.ditherPx.ratio * 16;
        const sel = opt.ditherPx.sel ? 1 : 0;
        let keep = 0;
        for (let y = 0; y < bh; y++) {
          const gy = by + y, row = gy * W + bx;
          let mr = y * bw;
          for (let x = 0; x < bw; x++, mr++) {
            if (!mask[mr]) continue;
            const hi = BAY[(gy & 3) * 4 + ((bx + x) & 3)] < th ? 1 : 0;
            if (hi !== sel) { mask[mr] = 0; continue; }
            keep++;
          }
        }
        nInk = keep;
      }
      // 先数完再决定要不要落笔：笔太小直接作废，不能留下"已计覆盖"的假账。
      if (nInk < (opt.minInk || 2)) return -1;
      // 铺底笔只改画面、不记覆盖：覆盖/查漏仍以各色区自己的精确笔为准，
      // 这样铺底没被后笔盖到的像素还能被查漏兜住，成品不会残留中间色。
      // noZone 同理：起稿笔裁在组内但不动 paintN/zoneCov，后面每组的精确笔
      // 仍然算"新增像素"，不会被零增益删除，细化才是真实的推进。
      const noCover = !!opt.noCover, noZone = !!opt.noZone;
      let col;
      if (opt.localColor) {
        // 渐变组：每条扫带取原图在这条带里的真实均值，后笔可以微调前笔的颜色。
        // 平涂背景再放宽一点：沿笔轴取小圆盘、只统计背景像素，让相邻色区的
        // 交界处取到同一条过渡色，成品不会出现一圈圈同心色带。
        const smpL = sampleColor(mask, bw, bh, bx, by, nInk > 30000 ? 3 : (nInk > 8000 ? 2 : 1));
        col = smpL || (opt.color ? [opt.color[0], opt.color[1], opt.color[2]] : [128, 128, 128]);
      } else if (opt.color) col = [opt.color[0], opt.color[1], opt.color[2]];
      else {
        const smp = sampleColor(mask, bw, bh, bx, by, nInk > 30000 ? 3 : (nInk > 8000 ? 2 : 1));
        const base = smp || [128, 128, 128];
        if (style === 'pencil') {
          // 铅笔和彩笔共用同一套观察/分区，只在落笔时转成灰阶。
          // 大色面按"这一块的计划明度"落笔：逐条扫带取局部原图，会把海报的
          // 旧纸/石墙画成规则竖条纹。明度层次交给块面，毛发变化交给排线和塑形。
          col = opt.paletteColor || base;
        } else if (style === 'marker') {
          col = opt.paletteColor || base;
          if (opt.deep) col = mix(col, [0, 0, 0], 0.10);
        } else {
          const tint = (rand01(strokeSeed * 1.7, 4.3) - 0.5) * 9;
          const warm = (strokeSeed % 5 === 0) ? 3 : 0;
          col = [
            clamp(Math.round(base[0] + tint + warm), 0, 255),
            clamp(Math.round(base[1] + tint * 0.7), 0, 255),
            clamp(Math.round(base[2] + tint * 0.4 - warm), 0, 255),
          ];
        }
      }
      if (autoCol) col = autoCol;
      if (opt.dither) {
        const t = rand01((opt.ditherSeed || 0), 7.3) - 0.5;
        const d = t * opt.dither;
        col = [clamp(Math.round(col[0] + d), 0, 255),
          clamp(Math.round(col[1] + d), 0, 255), clamp(Math.round(col[2] + d), 0, 255)];
      }
      if (style === 'pencil') {
        // 石墙/浅毛保留一点纸感，暗部不要压成纯黑；整体连续过渡。
        // ph1 是大面积侧锋铺底，稍微提亮一档，给后面的排线留出层次。
        const lv = col[0] * 0.299 + col[1] * 0.587 + col[2] * 0.114;
        const v = (!isFlat && ph === 1)
          ? clamp(Math.round(lv * 0.90 + 16), 20, 246)
          : clamp(Math.round(lv * 0.95 + 12), 18, 244);
        col = [v, v, v];
      }
      let len = 0;
      for (let i = 1; i < n; i++) len += Math.hypot(spine[i * 2] - spine[(i - 1) * 2], spine[i * 2 + 1] - spine[(i - 1) * 2 + 1]);
      let weight;
      if (opt.ms !== undefined) weight = opt.ms;
      else if (ph === 0) weight = 26 + len * 3.0;
      else if (ph === 1) weight = 20 + len * 2.4;
      else if (ph === 2) weight = 16 + len * 2.0;
      else weight = 14 + len * 1.8;
      weight *= 0.9 + 0.2 * rand01(len + strokeSeed * 0.37, ph + 1.3);
      // 弯笔更慢：人画弧线/拐弯时手腕要跟着转，同弧长的弯笔耗时更长。
      // 只影响回放节奏，不影响成品像素。
      if (n >= 2 && len > 8) {
        const chord = Math.hypot(spine[(n - 1) * 2] - spine[0], spine[(n - 1) * 2 + 1] - spine[1]);
        weight *= 1 + 0.30 * (1 - chord / len);
      }
      if (style === 'pencil') weight *= 0.72;
      strokeSeed++;
      const cIdx = pushClip(bx, by, bw, bh, mask);
      let hwMid = 0;
      for (let i = 0; i < n; i++) hwMid += halfs[i];
      const st = {
        rib: Array.from(rib, (v) => Math.round(v * 10) / 10),
        tp: Array.from(spine, (v) => Math.round(v * 10) / 10),
        w: Math.round(hwMid / n * 2 * 10) / 10,
        color: col, pen: opt.pen ? 1 : 0,
        ms: weight, c: cIdx, r: -1, ph: ph, ly: -1,
      };
      if (opts.tagStrokes) st.zg = zg;
      if (opt.fin) st.fin = 1;
      strokes.push(st);
      if (!noZone && zg >= 0 && zg < gStrokeN.length) gStrokeN[zg]++;
      for (let y = 0; y < bh; y++) {
        const row = (by + y) * W + bx;
        let mr = y * bw;
        for (let x = 0; x < bw; x++, mr++) {
          if (!mask[mr]) continue;
          const p = row + x, q = p * 3;
          canvas[q] = col[0]; canvas[q + 1] = col[1]; canvas[q + 2] = col[2];
          // 结构笔跨多个同色色块：按像素实际归属记账。色差在容差内的算画对；
          // 差得多的既不算"已画准"也不记账，留给本次结构的收尾/后面的精确笔重涂。
          let colorOK = true;
          if (!noZone && opt.zoneGroups && zg < 0) {
            const gg = groupOf[p];
            if (gg >= 0) {
              if (opt.zoneTol) {
                // 默认按组均值（结构笔，artist 原行为）；描边笔用 zonePx 按像素真实色——
                // 同一组里字心色和暗边色差很大，用组均值会把画对的像素判成没画对。
                const cb2 = opt.zonePx ? [R[p], G[p], B[p]] : groups[gg].mean;
                const dr = col[0] - cb2[0], dg = col[1] - cb2[1], db = col[2] - cb2[2];
                colorOK = dr * dr + dg * dg + db * db <= opt.zoneTol * opt.zoneTol;
              }
              if (colorOK && !paintN[p]) { paintN[p] = 1; zoneCov++; groupUncov[gg]--; }
            }
          } else if (!noZone && zg >= 0 && !paintN[p]) {
            paintN[p] = 1; zoneCov++; groupUncov[zg]--;
          }
          // 结构/描边笔可以要求"按几何覆盖"：涂到了就算覆盖，颜色偏差交给误差守卫，
          // 否则收尾查漏会把同一片区域按碎片组重画上千笔。默认仍按颜色算（artist 不变）。
          if (!noCover && (colorOK || opt.geomCover) && !covered[p]) { covered[p] = 1; coveredN++; }
        }
      }
      return strokes.length - 1;
    }

    // 一个实心色块是一个原子绘制事件：rib 覆盖整个包围盒，真实形状由
    // clip mask 决定。播放器看到 blk=1 时会在色块槽位开始后一次性落下整块，
    // 不再把一个色块拆成几十/几百条扫带。细线仍走 emitStroke。
    function emitBlockFill(x0, y0, bw, bh, mask, color, ph, opt) {
      opt = opt || {};
      if (!mask || bw <= 0 || bh <= 0) return -1;
      let nInk = 0;
      for (let i = 0; i < mask.length; i++) if (mask[i]) nInk++;
      if (nInk <= 0) return -1;
      const cIdx = pushClip(x0, y0, bw, bh, mask);
      // 几何按"覆盖到最后一个像素的外沿"算：用 x0+bw 而不是 x0+bw-1。
      // 旧写法把右下各缩了 1px，最后一列/最后一行的像素中心落在矩形外，
      // 只有 0.7px 的描边光泽进去，于是海报最右一列被混成 (76,76,76) 灰边。
      // 形状仍由裁剪掩膜决定，所以不会涂到区域外。
      const x1 = x0 + bw, y1 = y0 + bh;
      const cy = y0 + bh * 0.5;
      const st = {
        // 矩形只负责覆盖 bbox；着色边界始终由裁剪掩膜决定。
        rib: [x0, y0, x1, y0, x1, y1, x0, y1],
        tp: [x0, cy, x0 + bw * 0.5, cy, x1, cy],
        w: Math.max(4, Math.min(bw, bh) * 0.4),
        color: [Math.round(color[0]), Math.round(color[1]), Math.round(color[2])],
        pen: 0, c: cIdx, r: -1, ph: ph, ly: -1,
        blk: 1,
        // 原子块不需要搬运笔尖；播放器会把它当作"一块直接放下"。
        travelK: 0,
        fl: 1,
        ms: opt.ms !== undefined ? opt.ms : Math.round(130 + Math.min(240, Math.sqrt(nInk) * 0.18)),
      };
      if (opt.stage) st.stage = opt.stage;
      if (opts.tagStrokes && opt.zoneGid !== undefined) st.zg = opt.zoneGid;
      strokes.push(st);
      const col = st.color;
      // 纯"纸底"笔（整幅铺底）只服务回放：它让播放器在开局就有一张有底色的纸，
      // 但绝不能改写引擎的画布/误差账——否则后续按 canvas 误差做的"已达标就跳过"
      // 判断会被这一层假底色误导，成品反而变差。
      if (opt.noCanvas) return strokes.length - 1;
      const noCover = !!opt.noCover, noZone = !!opt.noZone;
      for (let y = 0; y < bh; y++) {
        const row = (y0 + y) * W, mr = y * bw;
        for (let x = 0; x < bw; x++) {
          if (!mask[mr + x]) continue;
          const p = row + x0 + x, q = p * 3;
          canvas[q] = col[0]; canvas[q + 1] = col[1]; canvas[q + 2] = col[2];
          if (!noZone && !paintN[p]) {
            paintN[p] = 1; zoneCov++;
            const gid = groupOf[p];
            if (gid >= 0) groupUncov[gid]--;
          }
          if (!noCover && !covered[p]) {
            // “碰过”不等于“画对”。原子块可能暂时用父色盖住文字/描边，
            // 若这里直接把 covered 记 1，后续残差守卫会以为这些像素已完成，
            // 字边和细线就永远得不到纠正。只有颜色已经进入容差的像素才算
            // 完成覆盖；暂时被父色盖住的像素仍会进入残差候选。
            const err = Math.max(
              Math.abs(col[0] - R[p]),
              Math.abs(col[1] - G[p]),
              Math.abs(col[2] - B[p]));
            if (err <= 48) {
              covered[p] = 1; coveredN++;
            }
          }
        }
      }
      return strokes.length - 1;
    }

    function profFill(n, halfW, seed) {
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const f = n > 1 ? i / (n - 1) : 0.5;
        const w = 0.93 + 0.07 * Math.sin(Math.PI * f);
        out[i] = Math.max(1, halfW * w * (0.94 + 0.12 * rand01(seed + i * 0.71, 2.1)));
      }
      return out;
    }
    function profLine(n, halfW, seed) {
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const f = n > 1 ? i / (n - 1) : 0.5;
        const taper = 0.30 + 0.70 * Math.pow(Math.sin(Math.PI * f), 0.55);
        out[i] = Math.max(0.7, halfW * taper * (0.85 + 0.3 * rand01(seed + i * 1.13, 5.7)));
      }
      return out;
    }
    function lineSpine(x0, y0, x1, y1, bow, seed, nP) {
      const n = nP || Math.max(2, Math.min(9, Math.round(Math.hypot(x1 - x0, y1 - y0) / 22)));
      const dx = x1 - x0, dy = y1 - y0, ln = Math.hypot(dx, dy) || 1;
      const nx = -dy / ln, ny = dx / ln;
      const out = new Float64Array(n * 2);
      for (let i = 0; i < n; i++) {
        const f = n > 1 ? i / (n - 1) : 0.5;
        const off = bow * Math.sin(Math.PI * f) + (rand01(seed + i * 0.37, 6.1) - 0.5) * 0.8;
        out[i * 2] = x0 + dx * f + nx * off;
        out[i * 2 + 1] = y0 + dy * f + ny * off;
      }
      return { pts: out, n };
    }

    // 线稿网络：细化后沿所有分支走笔。扫线会把一根 2~4px 的线切成大量 4px 小段，
    // 笔身又被裁在组内，线与线之间就断成虚线；骨架走笔才能一笔连到底。
    function traceLineGroup(g, pad) {
      // pad：掩膜四周留白。笔画顶满 bbox 时，细化永远不会删边界行/列，
      // 骨架会烂成整片；留 2px 空白才能正常细化（默认 0，老调用不变）。
      pad = pad || 0;
      const x0 = g.x0 - pad, y0 = g.y0 - pad;
      const w = g.x1 - g.x0 + 1 + pad * 2, h = g.y1 - g.y0 + 1 + pad * 2;
      if (w * h > 900000 || w < 3 || h < 3) return [];
      const m = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        const yy = y + y0;
        if (yy < 0 || yy >= H) continue;
        const row = yy * W;
        for (let x = 0; x < w; x++) {
          const xx = x + x0;
          if (xx >= 0 && xx < W && groupOf[row + xx] === g.gid) m[y * w + x] = 1;
        }
      }
      // 线稿被 3×3 多数投票和抗锯齿啃出 1~2px 缺口时，骨架会断成几十截；
      // 先闭合 1px 再细化，长轮廓才能一笔到底。
      const sk = thin(dilate(m, w, h, 1), w, h).sk;
      const idx = [];
      for (let i = 0; i < sk.length; i++) if (sk[i]) idx.push(i);
      if (!idx.length) return [];
      const deg = (i) => {
        const x = i % w, y = (i - x) / w;
        let d = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h && sk[yy * w + xx]) d++;
        }
        return d;
      };
      const seen = new Uint8Array(sk.length);
      const walk = (s) => {
        const pts = [];
        let cur = s, prev = -1;
        while (cur >= 0 && !seen[cur]) {
          seen[cur] = 1; pts.push(cur);
          const cx = cur % w, cy = (cur - cx) / w;
          let best = -1, bestScore = -1e9;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const ni = ny * w + nx;
            if (ni === prev || !sk[ni] || seen[ni]) continue;
            let sc = dx === 0 || dy === 0 ? 0.04 : 0;
            if (prev >= 0) {
              const px = prev % w, py = (prev - px) / w;
              sc += (cx - px) * dx + (cy - py) * dy;
            }
            if (sc > bestScore) { bestScore = sc; best = ni; }
          }
          prev = cur; cur = best;
        }
        return pts;
      };
      const raw = [];
      for (const i of idx) if (deg(i) === 1 && !seen[i]) { const p = walk(i); if (p.length >= 3) raw.push(p); }
      for (const i of idx) if (!seen[i]) { const p = walk(i); if (p.length >= 3) raw.push(p); }
      const out = [];
      for (const p of raw) {
        const abs = new Float64Array(p.length * 2);
        for (let i = 0; i < p.length; i++) { abs[i * 2] = p[i] % w + x0; abs[i * 2 + 1] = Math.floor(p[i] / w) + y0; }
        // 1.15px 容差在直径四五百像素的圆上会留下几十像素长的直弦：
        // 头部/身体轮廓看起来是一圈折线，误差图上整条边都是红晕。
        // 0.5px 仍能滤掉骨架的像素台阶，又让弦高小于笔宽，圆弧才圆。
        const sp = rdpSimplify(abs, p.length, 0.5);
        if (sp.n >= 2) out.push({ pts: sp.pts, n: sp.n, len: p.length });
      }
      out.sort((a, b) => b.len - a.len);
      return out;
    }

    // 结构蒙版（若干同色碎组并成的一条结构）的骨架走笔。
    // 与 traceLineGroup 同一套细化/走线，只是掩膜来自并查集结构而不是单个色块。
    function traceMaskPaths(m, w, h, x0, y0) {
      const sk = thin(dilate(m, w, h, 1), w, h).sk;
      const idx = [];
      for (let i = 0; i < sk.length; i++) if (sk[i]) idx.push(i);
      if (!idx.length) return [];
      const deg = (i) => {
        const x = i % w, y = (i - x) / w;
        let d = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h && sk[yy * w + xx]) d++;
        }
        return d;
      };
      const seen = new Uint8Array(sk.length);
      const walk = (st0) => {
        const pts = [];
        let cur = st0, prev = -1;
        while (cur >= 0 && !seen[cur]) {
          seen[cur] = 1; pts.push(cur);
          const cx = cur % w, cy = (cur - cx) / w;
          let best = -1, bestScore = -1e9;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const ni = ny * w + nx;
            if (ni === prev || !sk[ni] || seen[ni]) continue;
            let sc = dx === 0 || dy === 0 ? 0.04 : 0;
            if (prev >= 0) {
              const px = prev % w, py = (prev - px) / w;
              sc += (cx - px) * dx + (cy - py) * dy;
            }
            if (sc > bestScore) { bestScore = sc; best = ni; }
          }
          prev = cur; cur = best;
        }
        return pts;
      };
      const raw = [];
      for (const i of idx) if (deg(i) === 1 && !seen[i]) { const pp = walk(i); if (pp.length >= 3) raw.push(pp); }
      for (const i of idx) if (!seen[i]) { const pp = walk(i); if (pp.length >= 3) raw.push(pp); }
      const out = [];
      for (const pp of raw) {
        const abs = new Float64Array(pp.length * 2);
        for (let i = 0; i < pp.length; i++) { abs[i * 2] = pp[i] % w + x0; abs[i * 2 + 1] = Math.floor(pp[i] / w) + y0; }
        const sp = rdpSimplify(abs, pp.length, 0.5);
        if (sp.n >= 2) out.push({ pts: sp.pts, n: sp.n, len: pp.length });
      }
      out.sort((a, b) => b.len - a.len);
      return out;
    }

    // 长线切成段（一段一笔），保留 1 个点重叠让接缝不断
    function splitSkPath(path, maxLen) {
      const out = [];
      let a = 0;
      while (a < path.n - 1) {
        let b = a + 1, acc = 0;
        while (b < path.n) {
          const d = Math.hypot(path.pts[b * 2] - path.pts[(b - 1) * 2], path.pts[b * 2 + 1] - path.pts[(b - 1) * 2 + 1]);
          if (acc + d > maxLen && b - a >= 2) break;
          acc += d; b++;
        }
        if (b - a < 2) break;
        const sp = new Float64Array((b - a) * 2);
        for (let i = a; i < b; i++) { sp[(i - a) * 2] = path.pts[i * 2]; sp[(i - a) * 2 + 1] = path.pts[i * 2 + 1]; }
        out.push({ pts: sp, n: b - a, len: acc });
        a = b - 1;
      }
      return out;
    }

    function traceContours(mask, x0, y0, x1, y1, frame) {
      const segs = [];
      const MW = frame && frame.w ? frame.w : W;
      const MH = frame && frame.h ? frame.h : H;
      const at = (x, y) => (x < 0 || y < 0 || x >= MW || y >= MH) ? 0 : mask[y * MW + x];
      const ep = (x, y, e) => e === 0 ? [x + 0.5, y] : e === 1 ? [x + 1, y + 0.5] : e === 2 ? [x + 0.5, y + 1] : [x, y + 0.5];
      const add = (x, y, e1, e2) => { const a = ep(x, y, e1), b = ep(x, y, e2); segs.push([a[0], a[1], b[0], b[1]]); };
      const xa = Math.max(0, x0 - 1), ya = Math.max(0, y0 - 1), xb = Math.min(MW - 1, x1), yb = Math.min(MH - 1, y1);
      for (let y = ya; y <= yb; y++) {
        for (let x = xa; x <= xb; x++) {
          const a = at(x, y), b = at(x + 1, y), c = at(x + 1, y + 1), d = at(x, y + 1);
          const idx = (a ? 8 : 0) | (b ? 4 : 0) | (c ? 2 : 0) | (d ? 1 : 0);
          if (idx === 0 || idx === 15) continue;
          if (idx === 1) add(x, y, 3, 2);
          else if (idx === 2) add(x, y, 2, 1);
          else if (idx === 3) add(x, y, 3, 1);
          else if (idx === 4) add(x, y, 0, 1);
          else if (idx === 5) {
            if ((a + b + c + d) >= 2) { add(x, y, 0, 3); add(x, y, 1, 2); }
            else { add(x, y, 0, 1); add(x, y, 2, 3); }
          } else if (idx === 6) add(x, y, 0, 2);
          else if (idx === 7) add(x, y, 0, 3);
          else if (idx === 8) add(x, y, 0, 3);
          else if (idx === 9) add(x, y, 0, 2);
          else if (idx === 10) {
            if ((a + b + c + d) >= 2) { add(x, y, 0, 1); add(x, y, 2, 3); }
            else { add(x, y, 0, 3); add(x, y, 1, 2); }
          } else if (idx === 11) add(x, y, 0, 1);
          else if (idx === 12) add(x, y, 3, 1);
          else if (idx === 13) add(x, y, 2, 1);
          else if (idx === 14) add(x, y, 3, 2);
        }
      }
      const key = (x, y) => (Math.round(x * 2) * 1000003 + Math.round(y * 2));
      const map = new Map();
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        for (const k of [key(s[0], s[1]), key(s[2], s[3])]) {
          let arr = map.get(k); if (!arr) { arr = []; map.set(k, arr); }
          arr.push(i);
        }
      }
      const used = new Uint8Array(segs.length);
      const out = [];
      for (let i = 0; i < segs.length; i++) {
        if (used[i]) continue;
        used[i] = 1;
        const s = segs[i];
        const pts = [s[0], s[1], s[2], s[3]];
        let endK = key(s[2], s[3]), startK = key(s[0], s[1]);
        for (let guard = 0; guard < 20000; guard++) {
          const arr = map.get(endK);
          let ni = -1;
          if (arr) for (const j of arr) if (!used[j]) { ni = j; break; }
          if (ni < 0) break;
          used[ni] = 1;
          const t = segs[ni];
          const k1 = key(t[0], t[1]);
          const nx = k1 === endK ? t[2] : t[0], ny = k1 === endK ? t[3] : t[1];
          pts.push(nx, ny);
          endK = key(nx, ny);
          if (endK === startK) break;
        }
        if (pts.length < 6) continue;
        const r = rdpSimplify(pts, pts.length >> 1, Math.max(0.8, 1.15 * scaleB));
        if (r.n < 2) continue;
        out.push({ pts: r.pts, n: r.n });
      }
      return out;
    }

    function inkLine(g, path, ph) {
      if (path.n < 2) return;
      const hw = (style === 'pencil' ? 1.7 : (style === 'oil' ? 2.7 : 2.5)) * scaleB * (1 + 0.06 * (fid - 3));
      const lc = style === 'pencil' ? [52, 52, 52] :
        (style === 'marker' ? g.pal : mix(g.pal, [26, 22, 20], 0.35));
      // 铅笔线不再按色块裁：裁半宽会把 1px 宽的骨架线切成一截截虚线，
      // 灰度线本来就要压过色块边界；彩笔保留裁剪，避免色边溢出。
      const opt = { pen: 1, color: lc };
      if (style !== 'pencil') opt.zoneGid = g.gid;
      emitStroke(path.pts, profFill(path.n, hw, g.gid * 1.7 + path.len), lc, ph, opt);
    }

    // 线稿分两批：外圈结构先落（起形），五官/胡须等视觉中心留到点睛。
    const lineChunksLate = [];

    // ---- 极简线稿：整幅就是几根笔画（两横一竖、十、干这类简笔画）----
    // 人不会给三条线铺底色/排线/补笔。骨架拆成几根最大笔画，一根一笔：
    // 方向照骨架中心线，粗细照内切距离（笔宽 = 原图笔画宽度）。
    // 有一块拆不出均匀细笔画（大色块/照片/海报）就整体退回正常通路。
    // compiler 也复用这份中心线结果，并在统计里把它标成 compiler 的对象决策，
    // 这样简单线稿不会被区域填色器拆成几十条横带。
    let trivialDone = false;
    let trivialPlanInfo = null;
    {
      const inkGroups = groups.filter((g) => g.area >= 24 && g.area < N * 0.5 &&
        !(g.bg && g.luma > 232 &&
          Math.max(g.mean[0], g.mean[1], g.mean[2]) - Math.min(g.mean[0], g.mean[1], g.mean[2]) < 26));
      let inkArea = 0;
      for (const g of inkGroups) inkArea += g.area;
      const maxHW = Math.max(10, Math.min(W, H) * 0.055);
      if (inkGroups.length && inkGroups.length <= 12 && inkArea < N * 0.42) {
        const parts = [];
        let ok = true;
        for (const g of inkGroups) {
          const gw = g.x1 - g.x0 + 1, gh = g.y1 - g.y0 + 1;
          const paths = (gw * gh <= 900000) ? traceLineGroup(g, 2) : [];
          // 距离变换的掩膜同样要留白：笔画顶满 bbox 时没有背景可量，内切距离全是 INF
          const PD = 2, pw = gw + PD * 2, phh = gh + PD * 2;
          let dtv = null;
          if (paths.length) {
            const m = new Uint8Array(pw * phh);
            for (let y = 0; y < gh; y++) {
              const row = (y + g.y0) * W + g.x0;
              for (let x = 0; x < gw; x++) if (groupOf[row + x] === g.gid) m[(y + PD) * pw + x + PD] = 1;
            }
            dtv = distanceTransform(m, pw, phh);
          }
          const dtAt = (ax, ay) => {
            if (!dtv) return 0;
            const x = Math.round(ax) - g.x0 + PD, y = Math.round(ay) - g.y0 + PD;
            if (x < 0 || y < 0 || x >= pw || y >= phh) return 0;
            const d = dtv[y * pw + x];
            return d >= 1e8 ? 0 : d;
          };
          const hwOf = (path) => {
            // 取沿路径的中位内切距离：交叉点处能放进更大的圆，取最大值会把
            // 横笔在"干"字交点处撑粗一截；中位数才是笔画本身的粗细。
            const samples = [];
            for (let i = 1; i < path.n; i++) {
              const ax = path.pts[(i - 1) * 2], ay = path.pts[(i - 1) * 2 + 1];
              const bx = path.pts[i * 2], by = path.pts[i * 2 + 1];
              const steps = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / 2));
              for (let k = 0; k <= steps; k++) {
                const f = k / steps;
                samples.push(dtAt(ax + (bx - ax) * f, ay + (by - ay) * f));
              }
            }
            if (!samples.length) return 0;
            samples.sort((a, b) => a - b);
            return samples[samples.length >> 1];
          };
          const tang2 = (pts, i, j) => {
            const dx = pts[j * 2] - pts[i * 2], dy = pts[j * 2 + 1] - pts[i * 2 + 1];
            const l = Math.hypot(dx, dy) || 1;
            return [dx / l, dy / l];
          };
          const cands = [];
          for (const path of paths) {
            const hw = hwOf(path);
            if (path.len < Math.max(6, hw * 2.4)) continue;   // 交点上的毛刺不算笔画
            if (hw < 1) continue;
            if (hw > maxHW) { ok = false; break; }
            cands.push({ pts: Array.from(path.pts), hw: hw + 0.9, len: path.len });
          }
          // 贪心走笔在交叉点把一根笔画截成几段：把"端点相接、来去同向"的段接回去，
          // 干/十字才是一笔一画，而不是一堆积木。细化还会把方头笔画两端吃掉约半个
          // 笔宽，最后沿端点切线延伸回去，zoneGid 会把出界部分裁成原形。
          let didMerge = true;
          while (didMerge && cands.length > 1) {
            didMerge = false;
            for (let i = 0; i < cands.length && !didMerge; i++) {
              for (let j = 0; j < cands.length && !didMerge; j++) {
                if (i === j) continue;
                const A = cands[i], B = cands[j];
                const nA = A.pts.length >> 1, nB = B.pts.length >> 1;
                if (nA < 2 || nB < 2) continue;
                // [A 的接点在尾?，B 的接点在头?，A 反转，B 反转]
                const combos = [[1, 1, 0, 0], [1, 0, 0, 1], [0, 1, 1, 0], [0, 0, 1, 1]];
                for (const [aE, bS, revA, revB] of combos) {
                  const axp = A.pts[aE ? (nA - 1) * 2 : 0], ayp = A.pts[aE ? (nA - 1) * 2 + 1 : 1];
                  const bxp = B.pts[bS ? 0 : (nB - 1) * 2], byp = B.pts[bS ? 1 : (nB - 1) * 2 + 1];
                  const tol = dtAt(axp, ayp) + dtAt(bxp, byp) + 8;
                  if (Math.hypot(axp - bxp, ayp - byp) > tol) continue;
                  // A 到达接点的方向 ≈ B 离开接点的方向，才是顺承的一根笔画
                  const da = tang2(A.pts, aE ? nA - 2 : 1, aE ? nA - 1 : 0);
                  const db = tang2(B.pts, bS ? 0 : nB - 1, bS ? 1 : nB - 2);
                  if (da[0] * db[0] + da[1] * db[1] < 0.7) continue;
                  const mp = [];
                  if (revA) for (let k = nA - 1; k >= 0; k--) mp.push(A.pts[k * 2], A.pts[k * 2 + 1]);
                  else for (let k = 0; k < nA; k++) mp.push(A.pts[k * 2], A.pts[k * 2 + 1]);
                  if (revB) for (let k = nB - 2; k >= 0; k--) mp.push(B.pts[k * 2], B.pts[k * 2 + 1]);
                  else for (let k = 1; k < nB; k++) mp.push(B.pts[k * 2], B.pts[k * 2 + 1]);
                  cands.splice(j, 1);
                  A.pts = mp; A.hw = Math.max(A.hw, B.hw); A.len += B.len;
                  didMerge = true;
                  break;
                }
              }
            }
          }
          if (ok && !cands.length && paths.length) {
            // 小圆点/极短笔：骨架只剩一小截，按一记点笔处理
            const hw = hwOf(paths[0]);
            if (hw >= 1 && hw <= maxHW) cands.push({ pts: Array.from(paths[0].pts), hw: hw + 0.9, len: paths[0].len });
            else ok = false;
          }
          if (ok && !paths.length) ok = false;    // 连骨架都走不出的块，交回正常通路
          if (!ok) break;
          const gparts = [];
          for (const piece of cands) {
            const n0 = piece.pts.length >> 1;
            if (n0 < 2) continue;
            const extPt = (i0, i1) => {
              const d = dtAt(piece.pts[i0 * 2], piece.pts[i0 * 2 + 1]);
              if (d < 1) return null;
              const ux = piece.pts[i0 * 2] - piece.pts[i1 * 2], uy = piece.pts[i0 * 2 + 1] - piece.pts[i1 * 2 + 1];
              const l = Math.hypot(ux, uy) || 1;
              return [piece.pts[i0 * 2] + ux / l * d, piece.pts[i0 * 2 + 1] + uy / l * d];
            };
            const eS = extPt(0, 1), eE = extPt(n0 - 1, n0 - 2);
            const n = n0 + (eS ? 1 : 0) + (eE ? 1 : 0);
            const pts = new Float64Array(n * 2);
            let k = 0;
            if (eS) { pts[k++] = eS[0]; pts[k++] = eS[1]; }
            for (let i = 0; i < n0; i++) { pts[k++] = piece.pts[i * 2]; pts[k++] = piece.pts[i * 2 + 1]; }
            if (eE) { pts[k++] = eE[0]; pts[k++] = eE[1]; }
            gparts.push({ g, path: { pts, n, len: piece.len }, hw: piece.hw });
          }
          parts.push(...gparts);
          if (parts.length > 26) { ok = false; break; }
        }
        if (ok && parts.length) {
          // 顺序照写字的习惯：横的先画（自上而下），竖的后画（自左而右）
          const vertOf = (pt) => Math.abs(pt.pts[(pt.n - 1) * 2] - pt.pts[0]) <
            Math.abs(pt.pts[(pt.n - 1) * 2 + 1] - pt.pts[1]);
          const topOf = (pt) => Math.min(pt.pts[1], pt.pts[(pt.n - 1) * 2 + 1]);
          const leftOf = (pt) => Math.min(pt.pts[0], pt.pts[(pt.n - 1) * 2]);
          parts.sort((a, b) => (vertOf(a.path) - vertOf(b.path)) ||
            (topOf(a.path) - topOf(b.path)) || (leftOf(a.path) - leftOf(b.path)));
          prog(0.55, '极简线稿：照原样落笔…');
          await yieldUI();
          for (const part of parts) {
            const { g, path, hw } = part;
            let len = 0;
            for (let i = 1; i < path.n; i++) {
              len += Math.hypot(path.pts[i * 2] - path.pts[(i - 1) * 2], path.pts[i * 2 + 1] - path.pts[(i - 1) * 2 + 1]);
            }
            const si = emitStroke(path.pts, profFill(path.n, hw, g.gid * 5.1 + path.len), g.pal, 1, {
              pen: 1, color: g.pal, zoneGid: g.gid, ms: Math.round(340 + len * 2.6),
            });
            if (si >= 0) strokes[si].stage = 'compiler:centerline';
          }
          trivialDone = strokes.length > 0;
          if (trivialDone) trivialPlanInfo = { mode: 'centerline', parts: parts.length, groups: inkGroups.length, paintable: inkArea };
          if (opts.debug) {
            console.log('[artist] trivial: strokes=' + strokes.length + ' inkGroups=' + inkGroups.length +
              ' maxHW=' + maxHW.toFixed(1));
          }
        }
      }
    }

    // 低色数线稿：量化会把长线切成大量同色碎组，逐组补缝会把二三十条
    // 中心线拆成上千笔。compiler 在这里按调色板标签把碎组合回完整墨线；
    // 只要除主底色外的所有色都是细线，就沿全局中心线一次画完。
    if (!trivialDone && opts.algo === 'compiler' && palette.length >= 2 && palette.length <= 8) {
      const stats = palette.map((c, i) => ({ i, c, n: 0, x0: W, y0: H, x1: -1, y1: -1 }));
      for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
          const s = stats[labels[row + x]];
          if (!s) continue;
          s.n++;
          if (x < s.x0) s.x0 = x; if (x > s.x1) s.x1 = x;
          if (y < s.y0) s.y0 = y; if (y > s.y1) s.y1 = y;
        }
      }
      const live = stats.filter((s) => s.n >= 24 && s.x1 >= s.x0 && s.y1 >= s.y0)
        .sort((a, b) => b.n - a.n);
      const bg = live[0];
      const ink = live.slice(1);
      const maxLineThick = Math.max(12, Math.min(W, H) * 0.045);
      const lineLikeLabel = (s) => {
        const bw = s.x1 - s.x0 + 1, bh = s.y1 - s.y0 + 1;
        const thick = s.n / Math.max(1, Math.max(bw, bh));
        const fill = s.n / Math.max(1, bw * bh);
        return s.n <= N * 0.12 && thick <= maxLineThick && fill <= 0.30;
      };
      const inkPx = ink.reduce((a, s) => a + s.n, 0);
      if (bg && bg.n + paperPx > N * 0.45 && luma(bg.c) >= 170 && ink.length >= 1 && ink.length <= 6 &&
          inkPx < N * 0.30 && ink.every(lineLikeLabel)) {
        let made = 0;
        for (const s of ink) {
          const bw = s.x1 - s.x0 + 1, bh = s.y1 - s.y0 + 1;
          const m = new Uint8Array(bw * bh);
          for (let yy = 0; yy < bh; yy++) {
            const row = (s.y0 + yy) * W + s.x0;
            for (let xx = 0; xx < bw; xx++) if (labels[row + xx] === s.i) m[yy * bw + xx] = 1;
          }
          const paths = traceMaskPaths(m, bw, bh, s.x0, s.y0);
          if (!paths.length) continue;
          const PD = 2, pw = bw + PD * 2, phh = bh + PD * 2;
          const dm = new Uint8Array(pw * phh);
          for (let yy = 0; yy < bh; yy++) {
            const row = yy * bw;
            for (let xx = 0; xx < bw; xx++) if (m[row + xx]) dm[(yy + PD) * pw + xx + PD] = 1;
          }
          const dtv = distanceTransform(dm, pw, phh);
          const dtAt = (ax, ay) => {
            const xx = Math.round(ax) - s.x0 + PD, yy = Math.round(ay) - s.y0 + PD;
            if (xx < 0 || yy < 0 || xx >= pw || yy >= phh) return 0;
            const d = dtv[yy * pw + xx];
            return d >= 1e8 ? 0 : d;
          };
          const zmr = { m, x0: s.x0, y0: s.y0, w: bw, h: bh };
          for (const path of paths) {
            const halfs = new Float64Array(path.n);
            for (let i = 0; i < path.n; i++) {
              halfs[i] = clamp(dtAt(path.pts[i * 2], path.pts[i * 2 + 1]) * 0.95 + 2.1, 2.6, 14.0);
            }
            const si = emitStroke(path.pts, halfs, s.c, 1, {
              zoneMaskRect: zmr, color: s.c, noCover: 0, noZone: 1, minInk: 1,
              ms: Math.round(90 + path.len * 2.0),
            });
            if (si >= 0) {
              strokes[si].stage = 'compiler:centerline';
              strokes[si].travelK = 0.18;
              strokes[si].fl = 1;
              made++;
            }
          }
        }
        // 中心线骨架在局部粗细突变、交点或圆弧合并处可能漏走一小段。
        // 这里只检查“仍未被任何笔覆盖”的原墨线像素，并在同一个真实
        // 墨线 mask 内补走；不扩线、不刷白底，也不使用邻色均值。
        let lineRepair = 0;
        for (const s of ink) {
          const bw = s.x1 - s.x0 + 1, bh = s.y1 - s.y0 + 1;
          const miss = new Uint8Array(bw * bh);
          let missN = 0;
          for (let yy = 0; yy < bh; yy++) {
            const row = (s.y0 + yy) * W + s.x0;
            for (let xx = 0; xx < bw; xx++) {
              if (labels[row + xx] !== s.i) continue;
              if (covered[row + xx]) continue;
              miss[yy * bw + xx] = 1; missN++;
            }
          }
          if (!missN) continue;
          const zmr = { m: miss, x0: s.x0, y0: s.y0, w: bw, h: bh };
          const mpaths = traceMaskPaths(miss, bw, bh, s.x0, s.y0);
          if (!mpaths.length) {
            let x0 = bw, y0 = bh, x1 = -1, y1 = -1;
            for (let yy = 0; yy < bh; yy++) for (let xx = 0; xx < bw; xx++) {
              if (!miss[yy * bw + xx]) continue;
              if (xx < x0) x0 = xx; if (xx > x1) x1 = xx;
              if (yy < y0) y0 = yy; if (yy > y1) y1 = yy;
            }
            if (x1 >= x0 && y1 >= y0) {
              const xa = s.x0 + x0, xb = s.x0 + x1;
              const ya = s.y0 + y0, yb = s.y0 + y1;
              const sp = xb > xa
                ? new Float64Array([xa, (ya + yb) * 0.5, xb, (ya + yb) * 0.5])
                : new Float64Array([(xa + xb) * 0.5, ya, (xa + xb) * 0.5, yb]);
              const hb = new Float64Array([2.4, 2.4]);
              const si = emitStroke(sp, hb, s.c, 1, {
                zoneMaskRect: zmr, color: s.c, noCover: 0, noZone: 1, minInk: 1,
                ms: 90,
              });
              if (si >= 0) { strokes[si].stage = 'compiler:centerline-repair'; strokes[si].fl = 1; lineRepair++; }
            }
          } else {
            for (const path of mpaths) {
              const hb = new Float64Array(path.n);
              for (let i = 0; i < path.n; i++) hb[i] = 2.6;
              const si = emitStroke(path.pts, hb, s.c, 1, {
                zoneMaskRect: zmr, color: s.c, noCover: 0, noZone: 1, minInk: 1,
                ms: Math.round(80 + path.len * 1.5),
              });
              if (si >= 0) { strokes[si].stage = 'compiler:centerline-repair'; strokes[si].fl = 1; lineRepair++; }
            }
          }
        }
        // 最后一次像素级封口：骨架和上面的补线仍可能在极小圆角、交叉口或
        // 单像素端点留下空隙。这里只扫描“原墨线标签内、仍未覆盖”的横向
        // run，并逐 run 用一像素高的局部笔补齐；笔形仍裁在原墨线 mask 内，
        // 所以不会把白底、邻色或抗锯齿外包进来。它数量很少，是确定性兜底，
        // 不是用大量均值补丁重画整条线。
        let lineSeal = 0;
        for (const s of ink) {
          const bw = s.x1 - s.x0 + 1, bh = s.y1 - s.y0 + 1;
          for (let yy = 0; yy < bh; yy++) {
            const row = (s.y0 + yy) * W + s.x0;
            let xx = 0;
            while (xx < bw) {
              while (xx < bw && (labels[row + xx] !== s.i || covered[row + xx])) xx++;
              if (xx >= bw) break;
              const xa = xx;
              while (xx < bw && labels[row + xx] === s.i && !covered[row + xx]) xx++;
              const xb = xx - 1;
              const rw = xb - xa + 1;
              const local = new Uint8Array(rw);
              local.fill(1);
              const zmr = { m: local, x0: s.x0 + xa, y0: s.y0 + yy, w: rw, h: 1 };
              const sp = new Float64Array([
                s.x0 + xa + 0.05, s.y0 + yy + 0.5,
                s.x0 + xb + 0.95, s.y0 + yy + 0.5,
              ]);
              const hb = new Float64Array([1.25, 1.25]);
              const si = emitStroke(sp, hb, s.c, 1, {
                zoneMaskRect: zmr, color: s.c, noCover: 0, noZone: 1, minInk: 1,
                ms: 34,
              });
              if (si >= 0) {
                strokes[si].stage = 'compiler:centerline-seal';
                strokes[si].travelK = 0.08;
                strokes[si].fl = 1;
                lineSeal++;
              }
            }
          }
        }
        made += lineRepair + lineSeal;
        if (made) {
          trivialDone = true;
          trivialPlanInfo = { mode: 'color-centerline', parts: made, groups: ink.length, paintable: inkPx };
          prog(0.55, '线稿：沿同色墨线一笔到底…');
        }
      }
    }
    // ================= 精确临摹通路 =================
    // 观察到的每个色区都按原图真实颜色落笔：先用保边平滑图做"局部容差漫水"，
    // 得到边界贴合的色区；再按色区形状选长线笔或宽扫笔。只有"怎么走笔"随机，
    // 色区、颜色、覆盖范围都不随机——换种子只会换作画过程，不会换成品。
    let exactInfo = null;
    // 主体（约 7900 行）已经搬到 js/pipeline/artist-exact.js。
    // 原来靠闭包直接用的外层变量，现在由 exactCtx() 打包成 CTX：
    //   - 只读的按值传（数组/对象按引用，内容改了照样一致）
    //   - 会被整体重新赋值的用 get/set 访问器，赋值仍落回本作用域的变量
    function exactCtx() {
      return {
        H, N, R, G, B, L, W, K, blurF, canvas, fid, flatScore, flowX, flowY, hardCap, isFlat, labels, nearestPalette, opts, palette, paper, paperPx, prog, sal, scaleB, style, traceContours, traceLineGroup, traceMaskPaths, yieldUI, splitSkPath, profFill, emitBlockFill, emitStroke, covered, paintN, groupOf, clips, coh, edge, COMPILER_FID, COMPILER_VIEW, snapOut,
        U: UTIL,
        get G_() { return G_; }, set G_(v) { G_ = v; },
        get budget() { return budget; }, set budget(v) { budget = v; },
        get coveredN() { return coveredN; }, set coveredN(v) { coveredN = v; },
        get exactInfo() { return exactInfo; }, set exactInfo(v) { exactInfo = v; },
        get gStrokeN() { return gStrokeN; }, set gStrokeN(v) { gStrokeN = v; },
        get groupUncov() { return groupUncov; }, set groupUncov(v) { groupUncov = v; },
        get groups() { return groups; }, set groups(v) { groups = v; },
        get kept() { return kept; }, set kept(v) { kept = v; },
        get px() { return px; }, set px(v) { px = v; },
        get small() { return small; }, set small(v) { small = v; },
        get strokes() { return strokes; }, set strokes(v) { strokes = v; },
        get zoneCov() { return zoneCov; }, set zoneCov(v) { zoneCov = v; },
        get subj() { return subj; }, set subj(v) { subj = v; },
        get a() { return a; }, set a(v) { a = v; },
        get b() { return b; }, set b(v) { b = v; },
        get baseCount() { return baseCount; }, set baseCount(v) { baseCount = v; },
        get cands() { return cands; }, set cands(v) { cands = v; },
        get cc() { return cc; }, set cc(v) { cc = v; },
        get ci() { return ci; }, set ci(v) { ci = v; },
        get comps() { return comps; }, set comps(v) { comps = v; },
        get edgeN() { return edgeN; }, set edgeN(v) { edgeN = v; },
        get emitRun() { return emitRun; }, set emitRun(v) { emitRun = v; },
        get focalX() { return focalX; }, set focalX(v) { focalX = v; },
        get focalY() { return focalY; }, set focalY(v) { focalY = v; },
        get g() { return g; }, set g(v) { g = v; },
        get gFw() { return gFw; }, set gFw(v) { gFw = v; },
        get gFx() { return gFx; }, set gFx(v) { gFx = v; },
        get gFy() { return gFy; }, set gFy(v) { gFy = v; },
        get gSx() { return gSx; }, set gSx(v) { gSx = v; },
        get gSxx() { return gSxx; }, set gSxx(v) { gSxx = v; },
        get gSxy() { return gSxy; }, set gSxy(v) { gSxy = v; },
        get gSy() { return gSy; }, set gSy(v) { gSy = v; },
        get gSyy() { return gSyy; }, set gSyy(v) { gSyy = v; },
        get gX0() { return gX0; }, set gX0(v) { gX0 = v; },
        get gX1() { return gX1; }, set gX1(v) { gX1 = v; },
        get gY0() { return gY0; }, set gY0(v) { gY0 = v; },
        get gY1() { return gY1; }, set gY1(v) { gY1 = v; },
        get gi() { return gi; }, set gi(v) { gi = v; },
        get gx() { return gx; }, set gx(v) { gx = v; },
        get gy() { return gy; }, set gy(v) { gy = v; },
        get i() { return i; }, set i(v) { i = v; },
        get info() { return info; }, set info(v) { info = v; },
        get k() { return k; }, set k(v) { k = v; },
        get minArea() { return minArea; }, set minArea(v) { minArea = v; },
        get p() { return p; }, set p(v) { p = v; },
        get parent() { return parent; }, set parent(v) { parent = v; },
        get pass() { return pass; }, set pass(v) { pass = v; },
        get sweepAt() { return sweepAt; }, set sweepAt(v) { sweepAt = v; },
        get sx0() { return sx0; }, set sx0(v) { sx0 = v; },
        get sx1() { return sx1; }, set sx1(v) { sx1 = v; },
        get sy0() { return sy0; }, set sy0(v) { sy0 = v; },
        get sy1() { return sy1; }, set sy1(v) { sy1 = v; },
        get y() { return y; }, set y(v) { y = v; },
      };
    }
    async function runExactCopy() { return EXACT.runExactCopy(exactCtx()); }

    let baseCount = 0;
    let exactDone = false;
    if (trivialDone && opts.algo === 'compiler') {
      // 极简线稿已经在上面按骨架中心线落笔；这里补齐与区域编译器相同的
      // 事务元数据，保证消费方不需要区分“区域对象”和“中心线对象”。
      const trivialTx = [];
      let from = 0, curKind = null, curStep = null;
      const strokeBox = (a, b) => {
        let x0 = W, y0 = H, x1 = -1, y1 = -1;
        for (let k = a; k < b; k++) {
          const rib = strokes[k] && strokes[k].rib;
          if (!rib || rib.length < 2) continue;
          for (let q = 0; q < rib.length; q += 2) {
            x0 = Math.min(x0, rib[q]); y0 = Math.min(y0, rib[q + 1]);
            x1 = Math.max(x1, rib[q]); y1 = Math.max(y1, rib[q + 1]);
          }
        }
        return x1 >= x0 ? { x0, y0, x1, y1 } : { x0: 0, y0: 0, x1: W - 1, y1: H - 1 };
      };
      const commitTrivialTx = (to, kind, step) => {
        if (to <= from) return;
        const seq = trivialTx.length;
        for (let i = from; i < to; i++) {
          const st = strokes[i];
          st.tx = kind === 'object' ? 'centerline' : 'centerline:detail';
          st.txKind = kind;
          st.txSeq = seq;
          st.step = step;
        }
        const box = strokeBox(from, to);
        const steps = {};
        steps[step] = to - from;
        trivialTx.push({ id: kind === 'object' ? 'centerline' : 'centerline:detail',
          seq, kind, strokeStart: from, strokeEnd: to,
          x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1, steps });
        from = to;
      };
      for (let i = 0; i < strokes.length; i++) {
        const stage = String(strokes[i].stage || '');
        const kind = stage === 'compiler:centerline' ? 'object' : 'detail';
        const step = kind === 'object' ? 'line' : 'detail';
        if (curKind !== null && (kind !== curKind || step !== curStep)) {
          commitTrivialTx(i, curKind, curStep);
        }
        curKind = kind; curStep = step;
      }
      commitTrivialTx(strokes.length, curKind, curStep);
      const trivialCounts = {};
      for (const rec of trivialTx) trivialCounts[rec.kind] = (trivialCounts[rec.kind] || 0) + 1;
      exactInfo = {
        seed: opts.seed === undefined || opts.seed === null ? 1 : (opts.seed >>> 0),
        mode: 'flat', order: 'compiler', bgFill: 'centerline', ring: false,
        objects: trivialPlanInfo.parts, closedRegions: trivialPlanInfo.parts,
        compilerMode: trivialPlanInfo.mode, compilerGroups: trivialPlanInfo.groups,
        paintable: trivialPlanInfo.paintable,
        transactions: trivialTx, txCounts: trivialCounts,
        txOrder: trivialTx.map((rec) => rec.kind),
      };
    }
    if (!trivialDone) exactDone = await runExactCopy();
    if (!trivialDone && !exactDone) {
    // ---- ph0：起形。先构图线，再主体/大块的长轮廓 ----
    prog(0.4, '起形：构图与长轮廓…');
    await yieldUI();
    {
      const gw = style === 'pencil' ? 1.35 : (style === 'oil' ? 1.5 : 1.2);
      const gc = style === 'pencil' ? [156, 156, 156] :
        (style === 'oil' ? [180, 160, 142] : [172, 163, 155]);
      const ca = Math.cos(subj.angle), sa = Math.sin(subj.angle);
      let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
      for (const [x, y] of [[sx0 - subj.x, sy0 - subj.y], [sx1 - subj.x, sy0 - subj.y],
        [sx1 - subj.x, sy1 - subj.y], [sx0 - subj.x, sy1 - subj.y]]) {
        const u = x * ca + y * sa, v = -x * sa + y * ca;
        if (u < uMin) uMin = u; if (u > uMax) uMax = u;
        if (v < vMin) vMin = v; if (v > vMax) vMax = v;
      }
      const gcl = style === 'pencil' ? [210, 210, 210] :
        (style === 'oil' ? [206, 193, 180] : [202, 195, 188]);
      const line = (u0, v0, u1, v1, seed, col) => {
        const x0 = subj.x + u0 * ca - v0 * sa, y0 = subj.y + u0 * sa + v0 * ca;
        const x1 = subj.x + u1 * ca - v1 * sa, y1 = subj.y + u1 * sa + v1 * ca;
        const sp = lineSpine(x0, y0, x1, y1, (rand01(seed, 8.2) - 0.5) * 6, seed, 5);
        const len = Math.hypot(x1 - x0, y1 - y0);
        const cc = col || gc;
        emitStroke(sp.pts, profLine(sp.n, gw, seed), cc, 0, {
          pen: 1, color: cc, zoneMask: subjectD, ms: Math.min(900, 180 + len * 1.6),
        });
      };
      // 构图线：彩笔留一条长轴加一条短的视觉中心线（大色面会盖掉）；
      // 铅笔只留一条极淡的短结构线，避免一个 X 压在脸上。
      if (style === 'pencil') {
        if (!isFlat) {
          // 照片不描量化缝，但起形阶段仍留一条很淡的短结构线（穿过视觉中心、
          // 顺着局部流向），让人看出"先定位置再上明暗"。线别拉太长，
          // 否则大色面盖不住，成品里会留一道划痕。
          let ang0 = subj.angle;
          const fp = Math.max(0, Math.min(N - 1, (subj.focalY | 0) * W + (subj.focalX | 0)));
          if (coh[fp] > 0.15) ang0 = 0.5 * Math.atan2(flowY[fp], flowX[fp]);
          const gl = Math.min(W, H) * 0.22;
          const gx0 = subj.focalX - Math.cos(ang0) * gl, gy0 = subj.focalY - Math.sin(ang0) * gl;
          const gx1 = subj.focalX + Math.cos(ang0) * gl, gy1 = subj.focalY + Math.sin(ang0) * gl;
          const sp = lineSpine(gx0, gy0, gx1, gy1, 1.4, 5.5, 5);
          emitStroke(sp.pts, profLine(sp.n, 0.8 * scaleB, 12.3), [231, 231, 231], 0, {
            pen: 1, color: [231, 231, 231], ms: 400,
          });
        }
        else {
          // 平涂铅笔的中轴不要一条实线从头顶拉到脚底：成品里会像一道接缝。
          // 改成四段很淡的短线，只在起形时提示位置，脸心留空。
          const span = Math.max(0, sy1 - sy0 - 16);
          for (let k = 0; k < 4; k++) {
            const a = sy0 + 8 + span * (0.04 + k * 0.24);
            const b = a + span * 0.075;
            const sp = lineSpine(subj.x, a, subj.x, b, 0.8, 5.5 + k, 4);
            emitStroke(sp.pts, profLine(sp.n, 0.75 * scaleB, 12.3 + k), [240, 240, 240], 0, {
              pen: 1, color: [240, 240, 240], zoneMask: subjectD, ms: 120,
            });
          }
        }
      } else if (!isFlat) {
        // 照片的起形线不要画成横竖准星：一条顺着主体长轴的轻线定姿态，
        // 一条更短的线穿过视觉中心定头/胸的位置。两条都比轮廓线淡，
        // 大色面一压就退到后面，只在最初两秒里提示"先看比例"。
        const vC = (vMin + vMax) * 0.5;
        const fu = (subj.focalX - subj.x) * ca + (subj.focalY - subj.y) * sa;
        const fv = -(subj.focalX - subj.x) * sa + (subj.focalY - subj.y) * ca;
        line(uMin + (uMax - uMin) * 0.10, vC,
          uMin + (uMax - uMin) * 0.90, vC + (vMax - vMin) * 0.05, 3.1, gcl);
        line(fu - (uMax - uMin) * 0.04, fv - (vMax - vMin) * 0.15,
          fu + (uMax - uMin) * 0.04, fv + (vMax - vMin) * 0.15, 7.7, gcl);
      }

      // 长轮廓：marching squares 追主体边界，按长度×显著度选前几条

      // 主体掩膜必须闭合后再追轮廓：照片里量化噪声会在掩膜上打出几千个小洞，
      // marching squares 会沿每个洞描一圈——整幅就变成"填色书轮廓"。
      // 若"主体"占了 78% 以上画面，说明主体检测失败（背景被当主体），干脆不描。
      let subjN = 0;
      for (let p = 0; p < N; p++) if (subject[p]) subjN++;
      // 照片的主体掩膜是一堆散落的显著块，边界横跨全幅、彼此穿插，
      // 追出来就是满纸波浪线（填色书）。照片的轮廓改由下面“大暗块外轮廓”负责。
      const contours = (subjN > N * 0.78 || !isFlat) ? [] : traceContours(closeMaskDisk(subject, W, H, 3), sx0, sy0, sx1, sy1);
      const scored = [];
      for (const c of contours) {
        let len = 0, salSum = 0, salN = 0;
        let minx = W, miny = H, maxx = -1, maxy = -1;
        for (let i = 0; i < c.n; i++) {
          const x = c.pts[i * 2], y = c.pts[i * 2 + 1];
          if (x < minx) minx = x; if (x > maxx) maxx = x;
          if (y < miny) miny = y; if (y > maxy) maxy = y;
          if (i > 0) len += Math.hypot(x - c.pts[(i - 1) * 2], y - c.pts[(i - 1) * 2 + 1]);
          const px2 = Math.max(0, Math.min(W - 1, x | 0)), py2 = Math.max(0, Math.min(H - 1, y | 0));
          salSum += sal[py2 * W + px2]; salN++;
        }
        if (len < 10 * scaleB) continue;
        // 整幅最外框不是"主体的轮廓"，跳过（否则起形会去描图片边）
        if (minx < 2 && miny < 2 && maxx > W - 3 && maxy > H - 3) continue;
        scored.push({ c, len, score: len * (0.35 + 0.65 * (salN ? salSum / salN : 0.3)) });
      }
      scored.sort((a, b) => b.score - a.score);
      let cLeft = 16;
      for (const sc of scored) {
        if (cLeft <= 0) break;
        const maxLen = (style === 'pencil' ? 260 : 210) * scaleB;
        const parts = Math.min(5, Math.max(1, Math.ceil(sc.len / maxLen)));
        for (let pi = 0; pi < parts && cLeft > 0; pi++) {
          const a = Math.floor(sc.c.n * pi / parts);
          const b = Math.min(sc.c.n - 1, Math.floor(sc.c.n * (pi + 1) / parts));
          if (b - a < 2) continue;
          const sp = new Float64Array((b - a + 1) * 2);
          for (let i = a; i <= b; i++) { sp[(i - a) * 2] = sc.c.pts[i * 2]; sp[(i - a) * 2 + 1] = sc.c.pts[i * 2 + 1]; }
          const mid = Math.floor((a + b) / 2) * 2;
          const mx = Math.max(0, Math.min(W - 1, sc.c.pts[mid] | 0)), my = Math.max(0, Math.min(H - 1, sc.c.pts[mid + 1] | 0));
          const src = [R[my * W + mx], G[my * W + mx], B[my * W + mx]];
          const lg = clamp(Math.round(luma(src) * 0.52), 26, 120);
          const cc = style === 'pencil' ? [lg, lg, lg] : mix(src, [28, 24, 22], 0.42);
          const hw = (style === 'pencil' ? 1.35 : (style === 'oil' ? 2.3 : 1.8)) * scaleB * (1 + 0.08 * (fid - 3));
          emitStroke(sp, profLine(b - a + 1, hw, 31.7 + pi), cc, 0, { pen: 1, color: cc, zoneMask: subjectD });
          cLeft--;
        }
      }

      // 线稿网络：先画离视觉中心远的外圈结构；五官/胡须留到 ph3
      const focusR = Math.min(W, H) * (style === 'pencil' ? 0.30 : 0.24);
      let earlyInk = 0, lateInk = 0, inkPx = 0;
      const maxChunk = (style === 'pencil' ? 140 : 160) * scaleB;
      const pencilChunks = [];
      for (const g of groups) {
        // 照片的"线稿"全是量化过渡缝：1~2px 宽、绕着每个色块走一圈，
        // 骨架追出来是满幅的破碎阶梯纹，不是五官也不是轮廓。真实照片里的线
        // 应该由明暗交界和排线暗示；只有平涂插画才有真正的线稿可描。
        // 铅笔照片例外：只描真正的 lineArt（海报的字边/结构边），不碰 inkOnly 缝。
        if (!isFlat && !(style === 'pencil' && g.lineArt)) continue;
        if (!g.lineArt && !g.inkOnly) continue;
        const paths = traceLineGroup(g);
        if (!paths.length) continue;
        g.skPaths = paths;
        for (const path of paths) inchk: for (const ch of splitSkPath(path, maxChunk)) {
          if (ch.n < 2 || ch.len < 5) continue;
          const mid = Math.floor(ch.n / 2) * 2;
          const mx = ch.pts[mid], my = ch.pts[mid + 1];
          const dF = Math.hypot(mx - subj.focalX, my - subj.focalY);
          inkPx += ch.len;
          if (style === 'pencil') pencilChunks.push({ g, ch, dF });
          else if (dF > focusR) { if (earlyInk < (isFlat ? 20 : 36)) { inkLine(g, ch, 0); earlyInk++; } else lineChunksLate.push({ g, ch, dF }); }
          else { lineChunksLate.push({ g, ch, dF }); lateInk++; }
        }
        if (opts.debug) console.log('[ink] gid=' + g.gid + ' paths=' + paths.length + ' long=' + earlyInk + ' late=' + lineChunksLate.length + ' px=' + inkPx);
      }
      // 照片没有可描的线稿，但大暗块（头、肩背、树干）的边界就是主体轮廓。
      // 只取视觉中心附近最大的 3 块，各描一条闭合外轮廓——这是"选择性长线"。
      if (!isFlat) {
        const far = (g) => Math.hypot(g.cx - subj.focalX, g.cy - subj.focalY);
        const fR2 = Math.min(W, H) * 0.42;
        // 大暗块先按"离视觉中心多近"加权再比面积：整幅的暗背景（石头、树丛）
        // 面积再大也不该被当主体轮廓，否则追出来是满纸岩石边线。
        const sil = groups.filter((g) => !g.lineArt && !g.inkOnly && g.luma < 118 &&
          g.area > N * 0.0022 && g.thick > 8 && (!g.bg || far(g) < fR2 * 0.55))
          .sort((a, b) => (b.area * Math.exp(-Math.pow(far(b) / (fR2 * 0.5), 2))) -
            (a.area * Math.exp(-Math.pow(far(a) / (fR2 * 0.5), 2))))
          .slice(0, 1);
        if (opts.debugMasks) console.log('[sil]', sil.map((g) =>
          `gid=${g.gid} a=${g.area} l=${g.luma | 0} bg=${g.bg} d=${far(g) | 0}`).join(' '));
        const sm = new Uint8Array(N);
        for (const g of sil) {
          sm.fill(0, g.y0 * W, (g.y1 + 1) * W);
          for (let y = g.y0; y <= g.y1; y++) {
            const row = y * W;
            for (let x = g.x0; x <= g.x1; x++) if (groupOf[row + x] === g.gid) sm[row + x] = 1;
          }
          const loops = traceContours(closeMaskDisk(sm, W, H, 2), g.x0, g.y0, g.x1, g.y1);
          loops.sort((a, b) => b.n - a.n);
          let drawn = 0;
          for (const lp of loops) {
            // 只取最大的一圈外轮廓：内圈（耳朵/眼窝的洞）在起形阶段画出来
            // 就是两个套在一起的变形虫，读者看不出那是头。
            if (drawn >= 1 || strokes.length >= hardCap) break;
            if (lp.n < 12) continue;
            const lc = style === 'pencil' ? [78, 78, 78] : mix(g.pal, [26, 22, 20], 0.45);
            const hw = (style === 'pencil' ? 1.55 : 2.0) * scaleB;
            const smooth = rdpSimplify(lp.pts, lp.n, Math.max(2.2, 2.8 * scaleB));
            if (smooth.n < 3) continue;
            for (const ch of splitSkPath(smooth, 260 * scaleB)) {
              if (ch.n < 3) continue;
              emitStroke(ch.pts, profFill(ch.n, hw, g.gid * 2.9 + ch.len), lc, 0, {
                pen: 1, color: lc,
              });
            }
            drawn++;
          }
        }
      }

      // 白毛在纸上是"没有颜色"的，只能靠边界交代：挑视觉中心附近最大的亮色块，
      // 用浅灰线勾一圈（白胸、前腿、白脸）——这是铅笔起形里最关键的几条线。
      if (style === 'pencil' && !isFlat) {
        const farL = (g) => Math.hypot(g.cx - subj.focalX, g.cy - subj.focalY);
        const lites = groups.filter((g) => !g.bg && !g.lineArt && !g.inkOnly && g.luma > 176 &&
          g.area > N * 0.0016 && g.thick > 10 && farL(g) < Math.min(W, H) * 0.55)
          .sort((a, b) => b.area - a.area).slice(0, 3);
        const lm = new Uint8Array(N);
        for (const g of lites) {
          if (strokes.length >= hardCap) break;
          lm.fill(0, Math.max(0, g.y0 - 1) * W, Math.min(N, (g.y1 + 2) * W));
          for (let y = g.y0; y <= g.y1; y++) {
            const row = y * W;
            for (let x = g.x0; x <= g.x1; x++) if (groupOf[row + x] === g.gid) lm[row + x] = 1;
          }
          const loops = traceContours(closeMaskDisk(lm, W, H, 2), g.x0, g.y0, g.x1, g.y1);
          loops.sort((a, b) => b.n - a.n);
          let drawn = 0;
          for (const lp of loops) {
            if (drawn >= 1) break;
            if (lp.n < 16) continue;
            const simp = rdpSimplify(lp.pts, lp.n, Math.max(1.4, 1.9 * scaleB));
            if (simp.n < 3) continue;
            const lc = [122, 122, 122];
            for (const ch of splitSkPath(simp, 240 * scaleB)) {
              if (ch.n < 3) continue;
              emitStroke(ch.pts, profFill(ch.n, 1.35 * scaleB, g.gid * 1.9 + ch.len), lc, 0, {
                pen: 1, color: lc,
              });
            }
            drawn++;
          }
        }
        if (opts.debugMasks) console.log('[lite]', lites.map((g) => 'g' + g.gid + ' a' + g.area + ' l' + (g.luma | 0)).join(' '));
      }

      if (style === 'pencil' && pencilChunks.length) {
        // 铅笔先起形：长线（外轮廓、身体、长胡须）按长度先落，不按离视线的远近切碎。
        const byLen = pencilChunks.slice().sort((a, b) => b.ch.len - a.ch.len);
        const nEarly = Math.min(byLen.length, Math.max(14, Math.round(byLen.length * 0.24)), 42);
        const drew = new Set();
        for (let i = 0; i < nEarly; i++) {
          if (strokes.length >= hardCap) break;
          inkLine(byLen[i].g, byLen[i].ch, 0);
          drew.add(byLen[i]); earlyInk++;
        }
        for (const c of pencilChunks) if (!drew.has(c)) lineChunksLate.push(c);
        if (opts.debug) console.log('[ink] pencil chunks=' + pencilChunks.length + ' early=' + earlyInk + ' late=' + lineChunksLate.length);
      }
      lineChunksLate.sort((a, b) => a.dF - b.dF);
    }

    // 一条扫带按颜色变化切成连续段：色面内部一笔带过，渐变处自然断笔
    function splitRun(g, ca, sa, v, u0, u1) {
      const out = [];
      const len = u1 - u0;
      if (len < 2) return out;
      const chunk = Math.max(6, baseBrush * 0.55);
      const nCh = Math.max(1, Math.ceil(len / chunk));
      const means = [];
      for (let ci = 0; ci < nCh; ci++) {
        const a = u0 + len * ci / nCh, b = u0 + len * (ci + 1) / nCh;
        let sr = 0, sg = 0, sb = 0, nn = 0;
        const samples = Math.max(2, Math.round((b - a) / 3));
        for (let s = 0; s < samples; s++) {
          const u = a + (b - a) * (s + 0.5) / samples;
          const x = Math.round(g.cx + u * ca - v * sa), y = Math.round(g.cy + u * sa + v * ca);
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const p = y * W + x;
          if (groupOf[p] !== g.gid) continue;
          sr += R[p]; sg += G[p]; sb += B[p]; nn++;
        }
        means.push(nn ? [sr / nn, sg / nn, sb / nn] : null);
      }
      const splitTol = style === 'marker' ? 999 : (style === 'oil' ? 20 : 26);
      // 铅笔的笔宽只有十几像素，按 3.2 倍切段会把每条扫线剁成 40px 的碎笔；
      // 石墨笔触本来就该拉得长，这里按画布尺度给最小段长。
      const maxSeg = style === 'pencil'
        ? Math.max(150 * scaleB, baseBrush * 9) * (0.9 + 0.2 * rand01(g.gid * 5.9, 2.7))
        : (g.bg ? baseBrush * 4.0 : baseBrush * 3.2) * (0.9 + 0.2 * rand01(g.gid * 5.9, 2.7));
      let curA = u0, curMean = null;
      for (let ci = 0; ci < nCh; ci++) {
        const m = means[ci];
        if (!m) continue;
        if (!curMean) { curMean = m.slice(); continue; }
        const d = Math.hypot(m[0] - curMean[0], m[1] - curMean[1], m[2] - curMean[2]);
        const segLen = u0 + len * (ci + 1) / nCh - curA;
        if ((d > splitTol || segLen > maxSeg) && segLen > baseBrush * 0.85) {
          out.push([curA, u0 + len * ci / nCh]);
          curA = u0 + len * ci / nCh;
          curMean = m.slice();
        } else {
          curMean = [curMean[0] * 0.7 + m[0] * 0.3, curMean[1] * 0.7 + m[1] * 0.3, curMean[2] * 0.7 + m[2] * 0.3];
        }
      }
      if (u1 - curA > 1) out.push([curA, u1]);
      return out;
    }

    // 画块铺色：沿结构/主轴一档档扫，带内按颜色断笔；笔形裁进本块形状
    function paintGroup(g, ph, deep, maxLines) {
      if (g.area <= 0) return;
      let bw = groupBrush(g);
      let thinMode = false;
      if (g.elong > 2.2 && g.thick < bw * 0.95) {
        bw = Math.max(styleMin, Math.min(bw, g.thick * 1.35));
        thinMode = true;
      }
      const halfW = bw * 0.5;
      let ang = regionAngle(g);
      if (style === 'oil' && !g.bg && g.flowCoh > 0.2) ang = g.flowAngle;
      if (g.bg) ang += (rand01(g.gid * 4.7, 3.9) - 0.5) * 0.16;
      if (!isFinite(ang)) ang = 0;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
      for (const [x, y] of [[g.x0 - g.cx, g.y0 - g.cy], [g.x1 - g.cx, g.y0 - g.cy], [g.x1 - g.cx, g.y1 - g.cy], [g.x0 - g.cx, g.y1 - g.cy]]) {
        const u = x * ca + y * sa, v = -x * sa + y * ca;
        if (u < uMin) uMin = u; if (u > uMax) uMax = u;
        if (v < vMin) vMin = v; if (v > vMax) vMax = v;
      }
      let step = Math.max(1.5, bw * (thinMode ? 0.56 : (deep ? 0.55 : styleStep)));
      const spanU = uMax - uMin + halfW * 2, spanV = vMax - vMin;
      let lines = Math.ceil(spanV / step) + 1;
      while (lines * spanU > 2600000 && step < bw * 2.5) { step *= 1.35; lines = Math.ceil(spanV / step) + 1; }
      // 起笔线要落在形状内部：贴着 vMin/vMax 的线往往整条都在形外，
      // 笔再宽也盖不到顶端的"帽"，会留下白月牙。向内收 0.55 个半笔宽，
      // 由笔身的半个宽度反包住上下边缘。
      const insetV = Math.min(step * 0.55, halfW * 0.55);
      const phase = (rand01(g.gid * 3.7, 1.9) - 0.5) * step * 0.3;
      const startV = maxLines === 1 ? (vMin + vMax) * 0.5 : vMin + insetV + phase * 0.4;
      const endV = maxLines === 1 ? startV : vMax - insetV;
      let lineN = 0;
      const __un0 = groupUncov[g.gid], __s0 = strokes.length;
      const vList = [];
      for (let v = startV; v <= endV; v += step) {
        vList.push(v);
        if (maxLines && vList.length >= maxLines) break;
      }
      if (maxLines !== 1 && vList.length && (!maxLines || vList.length < maxLines) &&
          endV - vList[vList.length - 1] > step * 0.5) vList.push(endV);
      // 起笔方向按组轮换 + 相邻带蛇形交替 + 间距相关漂移（同 paintBlob，手推进
      // 的自然不均匀；这里只动顺序/相位，掩膜与取色不变）。
      const pseed = (opts.seed === undefined || opts.seed === null) ? 1 : (opts.seed >>> 0);
      let dir = rand01(g.gid * 2.17 + pseed * 0.023, 6.9) < 0.5 ? 1 : -1;
      let drift = (rand01(g.gid * 3.7 + pseed * 0.13, 1.9) - 0.5) * step * 0.24;
      for (const v of vList) {
        lineN++;
        if (strokes.length >= hardCap) break;
        drift = Math.max(-step * 0.2, Math.min(step * 0.2,
          drift + (rand01(g.gid * 11.3 + v * 0.07 + pseed * 0.013, 5.5) - 0.5) * step * 0.5));
        sweepAt(g, v + drift, ca, sa, halfW, ang, uMin, uMax, ph, deep, dir);
        dir = -dir;
      }
      if (opts.debug && (g.gid === 1 || g.gid === 0 || g.gid === 14 || g.gid === 9)) console.log('[pg] gid=' + g.gid + ' area=' + g.area + ' ang=' + (ang*180/Math.PI).toFixed(0) + ' bw=' + bw.toFixed(0) + ' step=' + step.toFixed(0) + ' v=' + vMin.toFixed(0) + '..' + vMax.toFixed(0) + ' start=' + startV.toFixed(0) + ' end=' + endV.toFixed(0) + ' lines=' + lineN + ' un0=' + __un0 + ' un1=' + groupUncov[g.gid] + ' made=' + (strokes.length - __s0));
    }
    // 沿一条 v 扫：在本块掩膜内找连续段，按颜色分割后落笔
    function sweepAt(g, vv, ca, sa, halfW, ang, uMin, uMax, ph, deep, rev) {
      let runA = null, made = 0;
      const uEnd = uMax + halfW * 0.9;
      for (let u = uMin - halfW * 0.9; u <= uEnd; u += 1.0) {
        const x = Math.round(g.cx + u * ca - vv * sa), y = Math.round(g.cy + u * sa + vv * ca);
        const inside = x >= 0 && y >= 0 && x < W && y < H && groupOf[y * W + x] === g.gid;
        if (inside) { if (runA === null) runA = u; }
        else if (runA !== null) {
          const u0 = runA, u1 = u - 1;
          runA = null;
          if (u1 - u0 >= 1.5) { emitRun(g, u0, u1, vv, ca, sa, halfW, ang, ph, deep, rev); made++; }
        }
      }
      if (runA !== null && uEnd - runA >= 1.5) { emitRun(g, runA, uEnd, vv, ca, sa, halfW, ang, ph, deep, rev); made++; }
      return made;
    }

    // 补完色块：只针对「大块里还没盖住的窄条/侧翼」，按未覆盖像素的 v 分布
    // 选 1~2 条扫线，不重涂整块，也不追像素误差。
    function finishGroup(g, ph, maxStrokes) {
      if (!g || g.area <= 0) return 0;
      const bw = groupBrush(g), halfW = bw * 0.5;
      let ang = regionAngle(g);
      if (style === 'oil' && !g.bg && g.flowCoh > 0.2) ang = g.flowAngle;
      if (!isFinite(ang)) ang = 0;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
      for (const [x, y] of [[g.x0 - g.cx, g.y0 - g.cy], [g.x1 - g.cx, g.y0 - g.cy], [g.x1 - g.cx, g.y1 - g.cy], [g.x0 - g.cx, g.y1 - g.cy]]) {
        const u = x * ca + y * sa, v = -x * sa + y * ca;
        if (u < uMin) uMin = u; if (u > uMax) uMax = u;
        if (v < vMin) vMin = v; if (v > vMax) vMax = v;
      }
      const v0 = Math.floor(vMin) - 1, vn = Math.ceil(vMax - vMin) + 3;
      const hist = new Int32Array(vn);
      let total = 0;
      for (let y = g.y0; y <= g.y1; y++) {
        for (let x = g.x0; x <= g.x1; x++) {
          const p = y * W + x;
          if (groupOf[p] !== g.gid || paintN[p]) continue;
          const v = -((x - g.cx) * sa) + ((y - g.cy) * ca);
          const b = Math.round(v - v0);
          if (b >= 0 && b < vn) { hist[b]++; total++; }
        }
      }
      if (total < Math.max(12, Math.min(300, g.area * 0.01))) return 0;
      const order = Array.from({ length: vn }, (_, i) => i).sort((a, b) => hist[b] - hist[a]);
      const picked = [];
      for (const b of order) {
        if (hist[b] < 2 || picked.length >= maxStrokes) break;
        const v = v0 + b;
        let ok = true;
        for (const c of picked) if (Math.abs(c - v) < bw * 0.55) { ok = false; break; }
        if (ok) picked.push(v);
      }
      let made = 0;
      for (const v of picked) {
        if (strokes.length >= hardCap) break;
        made += sweepAt(g, v, ca, sa, halfW, ang, uMin, uMax, ph, false);
      }
      return made;
    }
    function emitRun(g, u0, u1, v, ca, sa, halfW, ang, ph, deep, rev) {
      const segs = splitRun(g, ca, sa, v, u0 - halfW * 0.85, u1 + halfW * 0.85);
      for (let si = 0; si < segs.length; si++) {
        // 反向走笔时段序连带方向一起倒，笔尖沿带连续推进（蛇形）
        const [a, b] = rev ? segs[segs.length - 1 - si] : segs[si];
        if (b - a < 1.5) continue;
        if (strokes.length >= hardCap) return;
        const len = b - a;
        const nP = Math.max(3, Math.min(9, Math.round(len / 22)));
        // 主弓弯随带长增大（长带是手臂弧线），叠第二谐波低频漂移
        const bowA = halfW * 0.34 * (0.55 + 0.9 * Math.min(1, len / 650));
        const bow = (rand01(g.gid * 7.1 + v * 0.13, 3.3) - 0.5) * bowA;
        const bow2 = (rand01(g.gid * 3.3 + v * 0.09, 7.7) - 0.5) * bowA * 0.55;
        const bowPh = rand01(g.gid * 5.1 + v * 0.06, 8.9) * Math.PI * 2;
        const sp = new Float64Array(nP * 2);
        for (let i = 0; i < nP; i++) {
          const f = nP > 1 ? i / (nP - 1) : 0.5;
          const u = rev ? b - (b - a) * f : a + (b - a) * f;
          const vv = v + bow * Math.sin(Math.PI * f) + bow2 * Math.sin(2 * Math.PI * f + bowPh)
            + (rand01(g.gid + i * 0.7, 9.1) - 0.5) * 0.7;
          sp[i * 2] = g.cx + u * ca - vv * sa;
          sp[i * 2 + 1] = g.cy + u * sa + vv * ca;
        }
        const hw = halfW * (deep ? 0.9 : 1);
        const halfs = profFill(nP, hw, g.gid * 2.3 + v);
        emitStroke(sp, halfs, null, ph, {
          zoneGid: g.gid,
          paletteColor: (style === 'marker' || style === 'pencil') ? g.pal : undefined,
          deep: deep, pen: 0,
        });
      }
    }

    // 排线：沿结构方向，间距由明暗决定；暗部更密，亮部留纸白
    function hatchGroup(g, ph, cross, cap, spacingMul, angleOverride, lightOk) {
      // 铅笔的白要留纸：238 的"白毛"再排线就成了灰污；亮部靠轮廓和周边暗部衬出来。
      // lightOk 只给"照片主体"的浅色块：白猫的身体没有排线就只剩一条轮廓，
      // 用很稀的浅灰排线交代体积，仍然看得见纸白。
      if (g.luma > (style === 'pencil' ? (lightOk ? 249 : 205) : 232) || g.area < 24) return;
      // 2~4px 的色带是量化的过渡条，不是色面；排线会把它排成实心轮廓线。
      if (style === 'pencil' && g.thick < 4.5) return;
      const lineW = Math.max(2.2, (style === 'pencil' ? 4.2 : 2.4) * scaleB) * (1 + 0.08 * (fid - 3));
      const dark = 1 - clamp01(g.luma / 240);
      const mul = spacingMul || 1;
      // 排线要压得住纸：以前间距太大，2000 笔也只像几道划痕，整幅还是白的。
      // 中间调 ~1/3 覆盖、暗部 ~1/2，交叉线再加密，才是铅笔的明暗组织。
      let spacing = lineW * (1.15 + (1 - dark) * 3.1) * (cross ? 0.78 : 1) * mul;
      spacing = Math.max(lineW * 1.10, Math.min(24 * scaleB, spacing));
      let ang = angleOverride !== undefined ? angleOverride : regionAngle(g);
      ang += cross ? -1.05 : 0.34;
      if (angleOverride === undefined && g.elong > 2.3 && !cross) ang = g.angle + 0.22;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
      for (const [x, y] of [[g.x0 - g.cx, g.y0 - g.cy], [g.x1 - g.cx, g.y0 - g.cy], [g.x1 - g.cx, g.y1 - g.cy], [g.x0 - g.cx, g.y1 - g.cy]]) {
        const u = x * ca + y * sa, v = -x * sa + y * ca;
        if (u < uMin) uMin = u; if (u > uMax) uMax = u;
        if (v < vMin) vMin = v; if (v > vMax) vMax = v;
      }
      const v0 = vMin + rand01(g.gid * 5.3, 2.2) * spacing;
      for (let v = v0; v <= vMax; v += spacing * (0.82 + 0.36 * rand01(g.gid * 4.1 + v * 0.03, 7.7))) {
        if (strokes.length >= cap) return;
        let runA = null;
        for (let u = uMin - 2; u <= uMax + 2; u += 1.2) {
          const x = Math.round(g.cx + u * ca - v * sa), y = Math.round(g.cy + u * sa + v * ca);
          const inside = x >= 0 && y >= 0 && x < W && y < H && groupOf[y * W + x] === g.gid;
          if (inside) { if (runA === null) runA = u; }
          else if (runA !== null) {
            if (u - 1 - runA > 3) hatchLine(g, runA, u - 1, v, ca, sa, lineW, ang, ph, cross, cap);
            runA = null;
          }
        }
        if (runA !== null && uMax - runA > 3) hatchLine(g, runA, uMax, v, ca, sa, lineW, ang, ph, cross, cap);
      }
    }
    function hatchLine(g, u0, u1, v, ca, sa, lineW, ang, ph, cross, cap) {
      // 一条长排线拆成几段短笔：人画排线不会一笔拉过整块色面，
      // 段与段之间留 0~8px 空档，角度也略微变化，才不是机器网纹。
      const runLen = u1 - u0;
      const maxSeg = (52 + 34 * rand01(g.gid * 4.7 + v * 0.11, 6.2)) * scaleB;
      const segs = [];
      if (runLen <= maxSeg * 1.25) segs.push([u0, u1]);
      else {
        let a = u0;
        let k = 0;
        while (a < u1 - 5) {
          const b = Math.min(u1, a + maxSeg * (0.7 + 0.6 * rand01(g.gid + k * 2.3, 3.1)));
          if (b - a > 8) segs.push([a, b]);
          a = b + (rand01(g.gid * 1.9 + k, 5.7) < 0.72 ? 2 + 7 * rand01(g.gid + k, 4.4) : 0);
          k++;
        }
      }
      for (const [a, b] of segs) {
        if (strokes.length >= cap) return;
        const da = ang + (rand01(g.gid * 7.3 + v * 0.09 + a, 5.1) - 0.5) * 0.09;
        const ca2 = Math.cos(da), sa2 = Math.sin(da);
        const nP = Math.max(3, Math.min(7, Math.round((b - a) / 24)));
        const sp = new Float64Array(nP * 2);
        for (let i = 0; i < nP; i++) {
          const f = nP > 1 ? i / (nP - 1) : 0.5;
          const u = a + (b - a) * f;
          const off = (rand01(g.gid * 9.7 + i + a, 4.4) - 0.5) * 1.1;
          sp[i * 2] = g.cx + u * ca2 - (v + off) * sa2;
          sp[i * 2 + 1] = g.cy + u * sa2 + (v + off) * ca2;
        }
        // 背景只用淡排线（退后），主体按明暗加深；避免整幅像同一张网纹
        const vv = g.bg
          ? clamp(Math.round(112 + g.luma * 0.42 - (cross ? 10 : 0)), 128, 214)
          : clamp(Math.round(30 + g.luma * 0.60 - (cross ? 18 : 0) - (ph === 2 ? 10 : 0)), 24, 205);
        emitStroke(sp, profLine(nP, lineW * 0.5, g.gid * 3.1 + v + a), [vv, vv, vv], ph, {
          zoneGid: g.gid, pen: 1, color: [vv, vv, vv],
        });
      }
    }

    function detailGroup(g, count, ph, salMin) {
      if (count <= 0 || g.area <= 0) return;
      const cand = [];
      const stride = Math.max(2, Math.round(Math.min(g.bw, g.bh) / 55));
      for (let y = Math.max(0, g.y0); y <= Math.min(H - 1, g.y1); y += stride) {
        const row = y * W;
        for (let x = Math.max(0, g.x0); x <= Math.min(W - 1, g.x1); x += stride) {
          const p = row + x;
          if (paper[p] || groupOf[p] !== g.gid || sal[p] < salMin) continue;
          cand.push({ p, x, y, s: sal[p] * (0.7 + 0.6 * clamp01(edge[p] / 32)) });
        }
      }
      cand.sort((a, b) => b.s - a.s);
      const picked = [];
      const minD = Math.max(5, Math.min(W, H) * 0.010);
      const need = Math.min(count, 48);
      for (let pass = 0; pass < 2 && picked.length < need; pass++) {
        const thr = salMin * (pass === 0 ? 1 : 0.62);
        for (const c of cand) {
          if (picked.length >= need) break;
          if (c.s < thr) continue;
          let ok = true;
          for (const q of picked) if (Math.hypot(q.x - c.x, q.y - c.y) < minD) { ok = false; break; }
          if (ok) picked.push(c);
        }
      }
      const baseLen = style === 'oil' ? Math.min(36, baseBrush * 0.44) : style === 'marker' ? Math.min(28, baseBrush * 0.36) : Math.min(30, Math.max(10, baseBrush * 0.9));
      const baseHw = style === 'oil' ? Math.min(9, Math.max(2.6, baseBrush * 0.11)) : style === 'marker' ? Math.min(6.5, Math.max(2.2, baseBrush * 0.075)) : Math.max(1.1, 1.5 * scaleB);
      for (const c of picked) {
        if (strokes.length >= hardCap) break;
        let ang;
        if (coh[c.p] > 0.12) ang = Math.atan2(flowY[c.p], flowX[c.p]) * 0.5;
        else ang = isFinite(g.flowAngle) ? g.flowAngle : g.angle;
        if (g.thick < 3.2) ang = g.elong > 1.6 ? g.angle : ang;
        const len = Math.max(5, baseLen * (0.75 + 0.5 * rand01(c.p, 2.8)) * (ph === 3 ? 0.82 : 1));
        const hw = Math.max(0.8, baseHw * (0.7 + 0.45 * rand01(c.p, 6.4)) * (g.thick < 3.2 ? 0.55 : 1));
        const dx = Math.cos(ang) * len * 0.5, dy = Math.sin(ang) * len * 0.5;
        const sp = lineSpine(c.x - dx, c.y - dy, c.x + dx, c.y + dy, (rand01(c.p, 3.7) - 0.5) * 2.6, c.p, ph === 3 ? 4 : 3);
        const src = [R[c.p], G[c.p], B[c.p]];
        // 塑形的笔色跟着"这一块的计划色"走，不在块边缘取到隔壁的颜色：
        // 字上的奶油色块边缘常常挨着红描边，按像素取色会把红点甩进字心。
        const gbase = palette[g.label] || g.pal || src;
        let col;
        if (style === 'pencil') {
          const v = clamp(Math.round(30 + luma(src) * 0.56 - (ph === 3 ? 12 : 0)), 24, 175);
          col = [v, v, v];
        } else if (style === 'marker') {
          let sh = markerShade(gbase, ph === 3 ? 0.26 : 0.15);
          // 色板里没有更暗的同色系时不要直接跳过：马克笔叠一层本来就该变深。
          // 用很轻的黑墨混合模拟叠色，塑形段才有落笔，五官边缘也能压住。
          if (sh === gbase) sh = mix(gbase, [0, 0, 0], ph === 3 ? 0.28 : 0.11);
          col = sh;
        } else {
          col = mix(gbase, src, 0.35);
          col = mix(col, [0, 0, 0], ph === 3 ? 0.10 : 0.04);
          const tt = (rand01(c.p * 1.3, 4.1) - 0.5) * 7;
          col = [clamp(col[0] + tt, 0, 255), clamp(col[1] + tt * 0.7, 0, 255), clamp(col[2] + tt * 0.4, 0, 255)];
        }
        emitStroke(sp.pts, style === 'oil' ? profFill(sp.n, hw, c.p) : profLine(sp.n, hw, c.p), col, ph, {
          pen: 1, color: col, zoneGid: g.gid,
        });
      }
    }

    // 小结构保底：只补"还没落过笔"的小块，每块最多一条中线笔，绝不整块重涂
    function rescueGroups(ph, maxN, capAt) {
      const list = groups.filter((g) => !g.bg && !g.lineArt && !g.inkOnly && g.area >= 16 && gStrokeN[g.gid] === 0 &&
        groupUncov[g.gid] > Math.max(4, g.area * 0.25))
        .sort((a, b) => (b.sal * Math.sqrt(b.area)) - (a.sal * Math.sqrt(a.area)));
      let used = 0;
      for (const g of list) {
        if (used >= maxN || strokes.length >= capAt || strokes.length >= hardCap) break;
        const before = strokes.length;
        forcePaint = true;
        paintGroup(g, ph, false, 1);
        forcePaint = false;
        used += strokes.length - before;
      }
    }

    // 视觉中心的细笔：只在焦点周围的人脸/头部区域，用短笔顺结构补色，
    // 把大笔底色的"块面感"收成可辨认的五官；不是全图逐像素补丁。
    function focalDetail(cap, ph) {
      if (cap <= 0) return 0;
      const fr = Math.min(W, H) * 0.34;
      const x0 = Math.max(0, Math.floor(subj.focalX - fr)), x1 = Math.min(W - 1, Math.ceil(subj.focalX + fr));
      const y0 = Math.max(0, Math.floor(subj.focalY - fr)), y1 = Math.min(H - 1, Math.ceil(subj.focalY + fr));
      const step = Math.max(6, Math.round(Math.min(W, H) / 90));
      const cand = [];
      for (let y = y0; y <= y1; y += step) {
        for (let x = x0; x <= x1; x += step) {
          const p = y * W + x;
          if (paper[p] || !subjectD[p]) continue;
          const sc = 1 + edge[p] * 0.35 + sal[p] * 6;
          if (sc < 1.6) continue;
          cand.push({ p, x, y, sc });
        }
      }
      cand.sort((a, b) => b.sc - a.sc);
      const picked = [];
      const minD = Math.max(6, Math.min(W, H) * 0.0105);
      for (let pass = 0; pass < 2 && picked.length < cap; pass++) {
        for (const c of cand) {
          if (picked.length >= cap) break;
          let ok = true;
          for (const q of picked) if (Math.hypot(q.x - c.x, q.y - c.y) < minD) { ok = false; break; }
          if (ok) picked.push(c);
        }
        if (picked.length >= cap || pass === 1) break;
      }
      for (const c of picked) {
        if (strokes.length >= hardCap) break;
        const p = c.p;
        let ang;
        if (coh[p] > 0.14) ang = Math.atan2(flowY[p], flowX[p]) * 0.5;
        else ang = (rand01(p * 1.7, 4.4) - 0.5) * 1.2;
        const len = Math.max(8, step * 2.3 * (0.78 + 0.45 * rand01(p, 2.8)));
        const hw = Math.max(2.2, step * 0.62 * (0.78 + 0.4 * rand01(p, 6.4)));
        const dx = Math.cos(ang) * len * 0.5, dy = Math.sin(ang) * len * 0.5;
        const sp = lineSpine(c.x - dx, c.y - dy, c.x + dx, c.y + dy,
          (rand01(p, 3.7) - 0.5) * 2.2, p, 4);
        const src = [R[p], G[p], B[p]];
        // 和 detailGroup 同理：短笔的色相服从这一块的计划色，别从边界上带进隔壁色。
        const gbase = palette[labels[p]] || src;
        let col;
        if (style === 'pencil') {
          const v = clamp(Math.round(30 + luma(src) * 0.56), 24, 180);
          col = [v, v, v];
        } else if (style === 'marker') {
          const sh = markerShade(gbase, 0.06);
          // 焦点短笔也不许换色系；平涂已经到位时不再加同色笔。
          if (sh === gbase) continue;
          col = sh;
        } else {
          col = mix(gbase, src, 0.35);
          const tt = (rand01(p * 1.3, 4.1) - 0.5) * 6;
          col = [clamp(col[0] + tt, 0, 255), clamp(col[1] + tt * 0.7, 0, 255), clamp(col[2] + tt * 0.4, 0, 255)];
        }
        const pgid = groupOf[p];
        emitStroke(sp.pts, style === 'oil' ? profFill(sp.n, hw, p) : profLine(sp.n, hw, p), col, ph, {
          pen: 1, color: col, zoneMask: subjectD, zoneGid: pgid,
        });
      }
      return picked.length;
    }

    // 照片类：先大笔铺一层"底色"（观察到的低频色块）。没有这层，
    // 几千个小色块不可能在预算内铺满，画布会到处露白，也不像人起稿。
    // 平涂插画不铺：它本来就有大片纸白和干净色块。
    function blockInWash(ph) {
      const cell = Math.max(46, Math.min(96, Math.round(Math.min(W, H) / 8)));
      const rb = Math.max(3, Math.round(cell * 0.14));
      const Rb = blurU8(R, rb), Gb = blurU8(G, rb), Bb = blurU8(B, rb);
      // 笔宽和档距留 15% 重叠、长度比横向档距长：底色是一张连成片的"底"，
      // 不是一排露缝的条子。主体大色块紧接着盖在上面，脸不会一直埋在底色里。
      const hw = cell * 0.58;
      const washMask = new Uint8Array(N);
      for (let p = 0; p < N; p++) if (!paper[p]) washMask[p] = 1;
      // 底色选色：马克笔按"这一格看到的主要色板色"投票，不把红字和蓝底
      // 平均成紫色；油画/铅笔仍用低频平均（它们靠笔触混色）。
      const washColor = (cx, cy, dx, dy, cp) => {
        if (style === 'marker') {
          const votes = new Map();
          let best = null, bestN = 0;
          const add = (qx, qy) => {
            qx = Math.round(qx); qy = Math.round(qy);
            if (qx < 0 || qy < 0 || qx >= W || qy >= H) return;
            const q = qy * W + qx;
            if (paper[q]) return;
            const c = nearestPalette([R[q], G[q], B[q]]);
            const n = (votes.get(c) || 0) + 1;
            votes.set(c, n);
            if (n > bestN) { bestN = n; best = c; }
          };
          for (const ff of [0.18, 0.5, 0.82]) add(cx + dx * (ff * 2 - 1), cy + dy * (ff * 2 - 1));
          add(cx - dy * 0.35, cy + dx * 0.35);
          add(cx + dy * 0.35, cy - dx * 0.35);
          return best;
        }
        let sr = 0, sg = 0, sb = 0, nn = 0;
        for (const ff of [0.18, 0.5, 0.82]) {
          const qx = Math.round(cx + dx * (ff * 2 - 1)), qy = Math.round(cy + dy * (ff * 2 - 1));
          if (qx < 0 || qy < 0 || qx >= W || qy >= H) continue;
          const q = qy * W + qx;
          if (paper[q]) continue;
          sr += Rb[q]; sg += Gb[q]; sb += Bb[q]; nn++;
        }
        if (!nn) return null;
        const col = [Math.round(sr / nn), Math.round(sg / nn), Math.round(sb / nn)];
        const tt = (rand01(cp * 2.7, 4.3) - 0.5) * 7;
        return [clamp(col[0] + tt, 0, 255), clamp(col[1] + tt * 0.7, 0, 255), clamp(col[2] + tt * 0.4, 0, 255)];
      };
      let made = 0;
      for (let pass = 0; pass < 1 && strokes.length < hardCap; pass++) {
        const baseAng = (pass === 0 ? -0.62 : 0.58) + (rand01(19 + pass, 2.9) - 0.5) * 0.10;
        const ca = Math.cos(baseAng), sa = Math.sin(baseAng);
        let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
        for (const [px, py] of [[0, 0], [W, 0], [W, H], [0, H]]) {
          const dx = px - W * 0.5, dy = py - H * 0.5;
          const u = dx * ca + dy * sa, v = -dx * sa + dy * ca;
          if (u < uMin) uMin = u; if (u > uMax) uMax = u;
          if (v < vMin) vMin = v; if (v > vMax) vMax = v;
        }
        const stepV = cell * 0.80, stepU = cell * 1.10;
        // 先把整个网格收成候选，再按"离主体多近"排序落笔：
        // 起手几笔就把猫周围的大色面压出来，然后向四周扩散；
        // 15% 的关键帧里构图已经在了，不是先擦亮一个角。
        const cells = [];
        // 循环范围向外多走半档：画面四边不能留一圈没铺到的白框。
        let iv = 0;
        for (let v = vMin - stepV * 0.5; v <= vMax + stepV * 0.5; v += stepV, iv++) {
          let iu = 0;
          for (let u = uMin - stepU * 0.5; u <= uMax + stepU * 0.5; u += stepU, iu++) {
            const jx = (rand01(pass * 91 + v * 0.013, 1.7) - 0.5) * cell * 0.42;
            const jy = (rand01(pass * 57 + u * 0.011, 4.9) - 0.5) * cell * 0.42;
            // 落在画外的中心夹回边界内：边缘那一笔仍在画面里，不留白边。
            const cx = clamp(W * 0.5 + u * ca - (v + jx) * sa, 0, W - 1);
            const cy = clamp(H * 0.5 + u * sa + (v + jx) * ca + jy, 0, H - 1);
            const cp = Math.round(cy) * W + Math.round(cx);
            if (paper[cp]) continue;
            const flowA = coh[cp] > 0.2 ? 0.5 * Math.atan2(flowY[cp], flowX[cp]) : baseAng;
            const ang = style === 'oil' ? flowA : baseAng + (rand01(cp, 6.3) - 0.5) * 0.16;
            const len = cell * (1.75 + 0.50 * rand01(cp * 0.7, 2.3));
            // 距离乘一点随机：顺序有主次，但不呈机械的同心圆。
            const d = Math.hypot(cx - subj.focalX, cy - subj.focalY) * (0.84 + 0.32 * rand01(cp, 9.1));
            // 隔格先铺一道：第一拨笔就把整幅的大色面点到，再回头补密。
            // 只按"离主体远近"排，开头十几秒会只有猫周围有颜色，右半张还是白纸。
            cells.push({ cx, cy, cp, ang, len, d, wave: (iu + iv) & 1 });
          }
        }
        cells.sort((a, b) => (a.wave - b.wave) || (a.d - b.d));
        for (const c of cells) {
            if (strokes.length >= hardCap) return made;
            const { cx, cy, cp, ang, len } = c;
            const dx = Math.cos(ang) * len * 0.5, dy = Math.sin(ang) * len * 0.5;
            const sp = lineSpine(cx - dx, cy - dy, cx + dx, cy + dy,
              (rand01(cp * 1.9, 5.1) - 0.5) * cell * 0.16, cp, 4);
            const col = washColor(cx, cy, dx, dy, cp);
            if (!col) continue;
            emitStroke(sp.pts, profFill(sp.n, hw, cp), col, ph, {
              pen: 0, color: col, zoneMask: washMask,
            });
            made++;
        }
      }
      // 补缝：网格缝隙和画面边角还露着底（covered=0）的地方补一笔宽笔。
      // 只补漏、不重涂，笔形和上面同一种，不会变成逐像素补丁。
      let gapN = 0;
      const gs = cell * 0.40;
      for (let gy = gs * 0.5; gy < H && gapN < 120; gy += gs) {
        for (let gx = gs * 0.5; gx < W && gapN < 120; gx += gs) {
          const xi = Math.round(gx), yi = Math.round(gy);
          const cp = yi * W + xi;
          if (paper[cp] || covered[cp]) continue;
          const baseAng = -0.62 + (rand01(77, 2.9) - 0.5) * 0.10;
          const flowA = coh[cp] > 0.2 ? 0.5 * Math.atan2(flowY[cp], flowX[cp]) : baseAng;
          const ang = style === 'oil' ? flowA : baseAng + (rand01(cp, 6.3) - 0.5) * 0.16;
          const len = cell * 1.35;
          const dx = Math.cos(ang) * len * 0.5, dy = Math.sin(ang) * len * 0.5;
          const sp = lineSpine(gx - dx, gy - dy, gx + dx, gy + dy,
            (rand01(cp * 1.9, 5.1) - 0.5) * cell * 0.16, cp, 4);
          const col = washColor(gx, gy, dx, dy, cp);
          if (!col) continue;
          emitStroke(sp.pts, profFill(sp.n, hw, cp), col, ph, {
            pen: 0, color: col, zoneMask: washMask,
          });
          made++; gapN++;
        }
      }
      if (opts.debugMasks) console.log('[gap] made=', gapN);
      return made;
    }


    // ---- ph1：先背景后主体的大色面；大块先铺，小结构至少各有一笔 ----
    prog(0.52, '铺大色：背景 → 主体…');
    const baseStart = strokes.length;
    if (style === 'pencil' && isFlat) {
      const pStart = strokes.length;
      {
        // 平涂（简笔/图标）：排线组织明暗 + 留纸白。

        // 平涂：先主体色块，再背景一层淡排线。
        const subjectH = groups.filter((g) => !g.bg && !g.lineArt && !g.inkOnly && g.luma <= 232 &&
          g.area >= Math.max(30, N * 0.0004))
          .sort((a, b) => (b.sal * Math.sqrt(b.area)) - (a.sal * Math.sqrt(a.area)));
        const bgH = groups.filter((g) => g.bg && g.luma <= 232 && g.area >= Math.max(60, N * 0.0008))
          .sort((a, b) => b.area - a.area);
        const subjCapH = Math.round(budget * 0.50);
        for (const g of subjectH) {
          if (strokes.length - pStart >= subjCapH) break;
          hatchGroup(g, 1, false, pStart + subjCapH);
        }
        const bgCapH = Math.round(budget * 0.72);
        for (const g of bgH) {
          if (strokes.length - pStart >= bgCapH) break;
          hatchGroup(g, 1, false, pStart + bgCapH);
        }
      }
    } else {
      // 人的顺序：先把背景的大色面铺出来（不是所有背景都精修），
      // 再把主体的大块按"大关系优先"铺满，最后补小结构。
      const photo = !isFlat;
      // 铅笔常态笔宽只有几像素，铺大色面必须换成侧锋；几像素的笔填不满画面。
      if (style === 'pencil') baseBrush = Math.max(baseBrush, 40 * scaleB);
      if (photo) {
        blockInWash(1);
        // 底色一落完就补主体的几块大颜色（脸、胸、背）：起形阶段立刻有"猫"，
        // 背景细节放后面——这是人画时的"先定主体大色，再收拾背景"。
        const fgFirst = groups.filter((g) => !g.bg && !g.lineArt && !g.inkOnly &&
          g.area > N * 0.002 &&
          Math.hypot(g.cx - subj.focalX, g.cy - subj.focalY) < Math.min(W, H) * 0.34)
          .sort((a, b) => b.area - a.area).slice(0, 8);
        for (const g of fgFirst) {
          if (strokes.length >= baseCap) break;
          paintGroup(g, 1, false, bigFlatPencil(g) ? undefined : 2);
        }
      }
      const p1Start = strokes.length;
      // 有底色层时背景已经立住了，不再把预算花在重复铺背景上
      // 背景也要有真正的笔触：只给几十笔时，整片背景就是模糊底在透，
      // 看着像失焦照片而不是画。照片给约 1/6 的硬上限，铺大色面、留概括。
      const bgCap = photo ? Math.round(baseCap * 0.08) : Math.round(baseBudget * 0.36);
      const bgGroups = groups.filter((g) => g.bg).sort((a, b) => b.area - a.area);
      for (const g of bgGroups) {
        if (strokes.length - p1Start >= bgCap) break;
        paintGroup(g, 1, false, photo ? 2 : undefined);
      }
      const fg = groups.filter((g) => !g.bg && !g.lineArt && !g.inkOnly);
      const fscore = (g) => g.sal * Math.sqrt(g.area) *
        (1 + Math.min(1.2, g.edge / 6)) *
        (1 + 0.5 * Math.exp(-Math.hypot(g.cx - subj.focalX, g.cy - subj.focalY) / (Math.min(W, H) * 0.4)));
      fg.sort((a, b) => fscore(b) - fscore(a));
      const subjectCap = Math.round(baseBudget * (photo ? 1.55 : 0.97));
      if (photo) {
        // 照片的小色块太多：按面积从大到小，把每个色面真正铺满（≥88%），
        // 不是"每块点一笔"就换下一块——底色层会从没盖住的地方透出来，脸就糊了。
        // 额度优先给大色面：最大 21 个组占了 55% 的画面，先把它们铺满最划算。
        const massCap = Math.round(baseCap * 0.62);
        // 离视觉中心远的小块是背景纹理（石墙缝、树叶点），不逐块描；
        // 留模糊底 + 大块笔触，背景自然退后。视觉中心附近的小块才保留（五官）。
        const fR = Math.min(W, H) * 0.42;
        const minMass = (g) => (Math.hypot(g.cx - subj.focalX, g.cy - subj.focalY) < fR
          ? Math.max(36, N * 0.00005) : Math.max(180, N * 0.0012));
        const mass = fg.filter((g) => g.area >= minMass(g))
          .sort((a, b) => (b.area + b.sal * b.area * 0.35) - (a.area + a.sal * a.area * 0.35));
        for (const g of mass) {
          if (strokes.length - p1Start >= massCap || strokes.length >= baseCap) break;
          if (!gStrokeN[g.gid]) paintGroup(g, 1, false, bigFlatPencil(g) ? undefined : 1);
          let guard = 0;
          while (guard < 9 && groupUncov[g.gid] > Math.max(14, g.area * 0.12) &&
                 strokes.length - p1Start < massCap && strokes.length < baseCap) {
            const before = strokes.length;
            finishGroup(g, 1, g.area > N * 0.008 ? 3 : 1);
            const made = strokes.length - before;
            if (!made) break;
            guard += made;
          }
        }
        // 整块覆盖到 90% 时，嘴上、眼窝这一小块可能还是空的（按整块统计看不出来），
        // 底色就会从脸上透出来。单独按视觉中心统计"还没落笔的像素"，补成色面。
        const faceR = Math.min(W, H) * 0.30;
        const faceUn = new Map();
        const fx0 = Math.max(0, Math.floor(subj.focalX - faceR)), fx1 = Math.min(W - 1, Math.ceil(subj.focalX + faceR));
        const fy0 = Math.max(0, Math.floor(subj.focalY - faceR)), fy1 = Math.min(H - 1, Math.ceil(subj.focalY + faceR));
        for (let y = fy0; y <= fy1; y++) {
          const dy = y - subj.focalY;
          for (let x = fx0; x <= fx1; x++) {
            const dx = x - subj.focalX;
            if (dx * dx + dy * dy > faceR * faceR) continue;
            const p = y * W + x;
            if (paper[p] || paintN[p]) continue;
            const gid = groupOf[p];
            if (gid < 0) continue;
            faceUn.set(gid, (faceUn.get(gid) || 0) + 1);
          }
        }
        const gidMap = new Map(groups.map((g) => [g.gid, g]));
        const faceG = Array.from(faceUn.entries()).filter(([gid, n]) => n >= 10 && gidMap.has(gid))
          .sort((a, b) => b[1] - a[1]).slice(0, 18);
        let faceMade = 0;
        // 脸部额度单独留：大色面已经把 massCap 吃满，这里按"补脸最多 60 笔"放行，
        // 不够的从塑形阶段扣（脸比背景多铺一块重要）。
        for (const [gid, n] of faceG) {
          if (faceMade >= 60 || strokes.length >= baseCap) break;
          faceMade += finishGroup(gidMap.get(gid), 1, n > 140 ? 2 : 1);
        }
        if (opts.debug) console.log('[face] g=' + faceG.length + ' made=' + faceMade);
      } else {
        for (const g of fg) {
          if (strokes.length - p1Start >= subjectCap) break;
          paintGroup(g, 1, false);
        }
      }
      // 大色块里被扫线漏掉的窄条/侧翼：按未覆盖像素补 1~2 条，不重涂整块
      const fin = fg.filter((g) => groupUncov[g.gid] > Math.max(20, g.area * 0.05))
        .sort((a, b) => fscore(b) - fscore(a));
      let finUsed = 0;
      for (const g of fin) {
        if (strokes.length - p1Start >= budget * 0.98 || finUsed >= Math.max(10, Math.round(budget * 0.07))) break;
        finUsed += finishGroup(g, 1, g.area > N * 0.03 ? 3 : 2);
      }
      // 背景大块同样补漏（底边/圆环侧翼），只补 1~2 条，保留留白
      const bgFin = bgGroups.filter((g) => groupUncov[g.gid] > Math.max(60, g.area * 0.004));
      for (const g of bgFin) {
        if (finUsed >= Math.max(12, Math.round(budget * 0.08))) break;
        finUsed += finishGroup(g, 1, 2);
      }
      if (opts.debug) console.log('[fin] used=' + finUsed + ' groups=' + fin.length +
        ' fg=' + fg.length + ' bg=' + bgGroups.length + ' massCap=' + (photo ? Math.round(baseCap * 0.70) : 0) +
        ' baseUsed=' + (strokes.length - p1Start));
      if (opts.debug) {
        let unG = 0, unPx = 0, unPx120 = 0, unG120 = 0;
        for (const g of groups) {
          const un = groupUncov[g.gid];
          if (un <= Math.max(4, g.area * 0.2)) continue;
          unG++; unPx += un;
          if (g.area >= 120) { unG120++; unPx120 += un; }
        }
        console.log('[uncov] groups=' + unG + ' px=' + unPx + ' groups120=' + unG120 + ' px120=' + unPx120);
        const uh = groups.filter((g) => groupUncov[g.gid] > Math.max(4, g.area * 0.2))
          .sort((a, b) => groupUncov[b.gid] - groupUncov[a.gid]).slice(0, 24);
        console.log('[uncovTop] ' + uh.map((g) => 'g' + g.gid + '(a' + g.area + ',u' + groupUncov[g.gid] +
          ',e' + g.edge.toFixed(0) + ',s' + g.sal.toFixed(2) + ',t' + g.thick.toFixed(0) +
          (g.bg ? ',bg' : '') + (g.lineArt ? ',line' : '') + (g.inkOnly ? ',ink' : '') + ')').join(' '));
        const brackets = [60, 120, 240, 480, 960, 1920];
        const parts = brackets.map((th) => {
          let gn = 0, px = 0;
          for (const g of groups) {
            if (g.area < th || g.bg) continue;
            const un = groupUncov[g.gid];
            if (un <= Math.max(4, g.area * 0.2)) continue;
            gn++; px += un;
          }
          return th + ':' + gn + '/' + px;
        });
        let lineN = 0, linePx = 0, inkN = 0, inkPx = 0;
        for (const g of groups) {
          const un = groupUncov[g.gid];
          if (un <= Math.max(4, g.area * 0.2)) continue;
          if (g.lineArt) { lineN++; linePx += un; }
          else if (g.inkOnly) { inkN++; inkPx += un; }
        }
        console.log('[uncovBr] fg ' + parts.join(' ') + ' line=' + lineN + '/' + linePx + ' ink=' + inkN + '/' + inkPx);
      }
      // 预算没轮到的色块：至少给 1~3 条扫线，先保证"看得出是什么"。
      // 这一段落笔不能看软预算（budget）：前面铺大色面已经超了软预算时，
      // 剩下的字/线稿/小色面会整块只剩糊底透出来，海报的字就碎了。
      // 按"未盖住的像素 × 显著度/边缘"排，线稿优先；额度到 baseCap 为止，
      // 给 ph2 塑形和 ph3 点睛留下笔数（见上面的 detailReserve）。
      const coverCap = Math.max(strokes.length,
        Math.min(baseCap, strokes.length + Math.max(90, Math.round(budget * 0.95))));
      const missing = groups.filter((g) => {
        if (g.area < 16) return false;
        const un = groupUncov[g.gid];
        // 大块哪怕只差一成，也是几十万像素：只看比例会把整片蓝底/字心漏掉，
        // 混过色的底色就留在成品上，成了紫/青斑。按"比例或绝对像素"双重门槛。
        const lim = Math.min(g.area * (isFlat ? 0.18 : 0.32), 2500);
        return un > Math.max(6, lim);
      }).sort((a, b) => {
        const wa = (a.lineArt || a.inkOnly ? 3.2 : 1) * (0.35 + a.sal) * (1 + Math.min(1.5, a.edge / 12));
        const wb = (b.lineArt || b.inkOnly ? 3.2 : 1) * (0.35 + b.sal) * (1 + Math.min(1.5, b.edge / 12));
        return groupUncov[b.gid] * wb - groupUncov[a.gid] * wa;
      });
      for (const g of missing) {
        if (strokes.length >= coverCap || strokes.length >= baseCap) break;
        paintGroup(g, 1, false, g.area > N * 0.001 ? 2 : 1);
        // 一次扫线只盖住几条带；大块按"未覆盖像素直方图"再挑 1~2 带补，
        // 直到只剩零头或额度用完，不重涂已经盖住的地方。
        let rounds = 0;
        while (rounds < 4 && strokes.length < coverCap && strokes.length < baseCap) {
          const left = groupUncov[g.gid];
          if (left <= Math.max(8, Math.min(g.area * 0.05, 900))) break;
          if (!finishGroup(g, 1, 2)) break;
          rounds++;
        }
      }
      // 其余背景小块：各一条，不重涂；留白也算画面的一部分
      for (const g of bgGroups) {
        if (gStrokeN[g.gid] || strokes.length >= coverCap || strokes.length >= baseCap) continue;
        paintGroup(g, 1, false, 1);
      }
      rescueGroups(1, Math.max(10, Math.round(budget * 0.08)), baseCap);
      if (opts.debug) {
        let un = 0, unG = 0, touch = 0;
        for (const g of groups) {
          const u = groupUncov[g.gid];
          if (u > 0) { un += u; unG++; }
          if (!gStrokeN[g.gid] && g.area >= 16) touch++;
        }
        console.log('[covfix] px=' + un + ' groups=' + unG + ' untouched=' + touch +
          ' base=' + (strokes.length - p1Start) + ' cap=' + coverCap);
        const top = groups.filter((g) => groupUncov[g.gid] > 0)
          .sort((a, b) => groupUncov[b.gid] - groupUncov[a.gid]).slice(0, 12);
        console.log('[covfixTop] ' + top.map((g) => 'g' + g.gid + '(a' + g.area +
          ',u' + groupUncov[g.gid] + ',n' + gStrokeN[g.gid] +
          (g.lineArt ? ',line' : '') + (g.bg ? ',bg' : '') + ')').join(' '));
      }
    }
    baseCount = strokes.length - baseStart;
    // ---- ph2：塑形。只在高显著/主体块加中间笔触 ----
    prog(0.72, '塑形：主体结构与明暗…');
    await yieldUI();
    // 平涂仍按软预算收笔；照片按"硬上限 - 点睛预留"算，别让 detailBudget
    // 在铺色超预算后把塑形压成 10 笔。
    const detailLeft = isFlat
      ? Math.max(10, detailBudget - strokes.length)
      : Math.max(10, hardCap - strokes.length - accentReserve);
    const detailCap = Math.min(detailLeft,
      Math.max(12, Math.round(baseCount * (isFlat ? 0.55 : 0.90))));
    if (style === 'pencil') {
      // 小色块（鼻子/腮红/圆点）先按形状补密排线：大块排线预算里它们常被挤掉，
      // 但五官缺少这些小面，脸就空了。笔迹被 zoneGid 裁在色块内，形状自然成立。
      const patchCap = Math.min(hardCap, strokes.length + Math.max(10, Math.round(budget * 0.11)));
      const patches = groups.filter((g) => !g.bg && !g.lineArt && !g.inkOnly && g.luma <= 232 &&
        g.area >= Math.max(60, N * 0.00008) && g.area <= Math.max(400, N * 0.006) &&
        g.sal >= 0.55 && g.thick <= 110)
        .sort((a, b) => {
          const da = Math.hypot(a.cx - subj.focalX, a.cy - subj.focalY);
          const db = Math.hypot(b.cx - subj.focalX, b.cy - subj.focalY);
          return (b.sal * Math.sqrt(b.area) * (1 + 1.2 * Math.exp(-db / (Math.min(W, H) * 0.25)))) -
            (a.sal * Math.sqrt(a.area) * (1 + 1.2 * Math.exp(-da / (Math.min(W, H) * 0.25))));
        });
      for (const g of patches) {
        if (strokes.length >= patchCap) break;
        // 每块最多 8 条：小色块之间均分，别让一个大腮红吃掉整个补笔预算
        hatchGroup(g, 2, false, Math.min(patchCap, strokes.length + 8), 0.52, undefined, !isFlat && !graphic);
      }
      // 暗部交叉排线：只压主体，不再排背景
      const c2 = Math.min(hardCap - accentReserve,
        Math.max(strokes.length + 18, detailBudget));
      const darkGroups = groups.filter((g) => !g.bg && !g.lineArt && !g.inkOnly && g.luma < 220 &&
        g.area >= Math.max(30, N * 0.0004))
        .sort((a, b) => (b.sal * b.area) - (a.sal * a.area));
      for (const g of darkGroups) {
        if (strokes.length >= c2) break;
        hatchGroup(g, 2, true, Math.min(c2, strokes.length + 14));
      }
    } else if (detailCap > 0) {
      const cboost = (g) => isFlat ? 1 :
        (1 + 1.6 * Math.exp(-Math.hypot(g.cx - subj.focalX, g.cy - subj.focalY) / (Math.min(W, H) * 0.30)));
      const cand = groups.filter((g) => !g.bg && !g.lineArt && !g.inkOnly && g.area > Math.max(30, N * 0.00025))
        .sort((a, b) => (b.sal * Math.sqrt(b.area) * cboost(b)) - (a.sal * Math.sqrt(a.area) * cboost(a)));
      let used = 0;
      // 塑形不是"把剩下的预算全撒成小碎笔"：每块最多 12 笔，只碰最靠前的
      // 十几个结构块。再多的短笔不会增加结构信息，只会把色面和字迹蹭花。
      const per = Math.max(isFlat ? 2 : 4, Math.min(12,
        Math.round(detailCap / Math.max(3, Math.min(isFlat ? 10 : 18, cand.length)))));
      const candTop = cand.slice(0, isFlat ? 12 : 28);
      for (const g of candTop) {
        if (used >= detailCap || strokes.length >= hardCap) break;
        const k = Math.min(per, detailCap - used);
        detailGroup(g, k, 2, Math.max(0.22, g.sal * 0.55));
        used += k;
      }
      if (!isFlat) {
        const fc = Math.min(style === 'pencil' ? 180 : 420,
          Math.max(0, (isFlat ? detailBudget : hardCap - accentReserve) - strokes.length - 20));
        focalDetail(fc, 2);
      }
    }

    // ---- ph3：点睛。只画视觉中心的小结构；画完主动停笔 ----
    prog(0.88, '点睛：视觉中心…');
    await yieldUI();
    // 照片的点睛：量化后"深、细、小"的块就是眼睛、鼻头、嘴线、耳朵暗边。
    // 它们不走排线（会排成一块灰），直接沿骨架落短深线。彩笔也留少量，
    // 五官的深色边是"这一只"的关键，不然脸会糊成一块。
    if (!isFlat) {
      const fR3 = Math.min(W, H) * 0.45;
      const inkMax = style === 'pencil' ? 70 : (style === 'marker' ? 26 : 30);
      const inks = groups.filter((g) => g.inkOnly && g.area > 14 &&
        Math.hypot(g.cx - subj.focalX, g.cy - subj.focalY) < fR3)
        .sort((a, b) => b.area - a.area).slice(0, 20);
      let inkMade = 0;
      for (const g of inks) {
        if (strokes.length >= hardCap || inkMade >= inkMax) break;
        const paths = traceLineGroup(g);
        const take = style === 'pencil' ? Math.min(2, paths.length) : 1;
        for (let i = 0; i < take; i++) {
          inkLine(g, paths[i], 3);
          inkMade++;
        }
      }
      if (opts.debugMasks) console.log('[pink]', inks.length, 'made', inkMade);
    }

    // 线稿的五官/胡须：最后落，短而准，是画面最重的深色
    if (lineChunksLate.length) {
      const inkMax = style === 'pencil' ? 78 : (isFlat ? (style === 'oil' ? 22 : 24) : 40);
      const inkCap = style === 'pencil'
        ? Math.min(lineChunksLate.length, inkMax)
        : Math.min(lineChunksLate.length, Math.max(8, Math.round(budget * 0.10)), inkMax);
      for (let i = 0; i < inkCap && strokes.length < hardCap; i++) {
        inkLine(lineChunksLate[i].g, lineChunksLate[i].ch, 3);
      }
    }
    {
      const focus = groups.filter((g) => !g.bg && !g.lineArt && !g.inkOnly && g.area > 20)
        .sort((a, b) => ((b.sal * Math.sqrt(b.area)) - (a.sal * Math.sqrt(a.area))))
        .slice(0, 3);
      const leave = Math.min(Math.max(6, Math.round((budget - strokes.length) * 0.25)), 18);
      let used = 0;
      for (const g of focus) {
        if (used >= leave || strokes.length >= hardCap) break;
        const k = Math.max(2, Math.min(8, leave - used));
        detailGroup(g, k, 3, 0.42);
        used += k;
      }
      // 最后几笔重音：视觉中心附近最强的边缘，短、深、收笔
      const focalX = subj.focalX, focalY = subj.focalY, fr = Math.max(60, Math.min(W, H) * 0.18);
      const cand = [];
      for (let y = Math.max(1, (focalY - fr) | 0); y < Math.min(H - 1, (focalY + fr) | 0); y += 2) {
        let p = y * W + Math.max(1, (focalX - fr) | 0);
        for (let x = Math.max(1, (focalX - fr) | 0); x < Math.min(W - 1, (focalX + fr) | 0); x += 2, p += 2) {
          if (paper[p] || edge[p] < 18 || sal[p] < 0.45) continue;
          cand.push({ p, x, y, score: edge[p] * sal[p] });
        }
      }
      cand.sort((a, b) => b.score - a.score);
      const pick = [];
      const minD = Math.max(6, Math.min(W, H) * 0.012);
      const maxPick = Math.max(3, Math.min(16, Math.round(leave * 0.3)));
      for (const c of cand) {
        if (pick.length >= maxPick) break;
        let ok = true;
        for (const q of pick) if (Math.hypot(q.x - c.x, q.y - c.y) < minD) { ok = false; break; }
        if (ok) pick.push(c);
      }
      for (let i = 0; i < pick.length; i++) {
        const c = pick[i];
        const ang = coh[c.p] > 0.12 ? Math.atan2(flowY[c.p], flowX[c.p]) * 0.5 : 0;
        const len = (style === 'oil' ? 14 : 22) * scaleB * (0.8 + 0.6 * rand01(c.p, 2.8));
        const hw = (style === 'pencil' ? 1.5 : (style === 'oil' ? 4.2 : 2.5)) * scaleB;
        const dx = Math.cos(ang) * len * 0.5, dy = Math.sin(ang) * len * 0.5;
        const sp = lineSpine(c.x - dx, c.y - dy, c.x + dx, c.y + dy, (rand01(c.p, 7.4) - 0.5) * 2.2, c.p, 4);
        let col;
        // 点睛用最深的色板色当"墨"：马克笔的暗奶油调不出来时，
        // 深色勾一下眼/嘴/字边，比一条同色的隐形笔有用。
        if (style === 'marker') col = palette[0];
        else {
          const src = [R[c.p], G[c.p], B[c.p]];
          if (style === 'pencil') {
            const v = clamp(Math.round(luma(src) * 0.55), 24, 110);
            col = [v, v, v];
          } else col = mix(mix(src, palette[labels[c.p]] || src, 0.5), [20, 18, 16], 0.28);
        }
        emitStroke(sp.pts, profLine(sp.n, hw, c.p), col, 3, {
          pen: 1, color: col, zoneMask: subjectD, zoneGid: groupOf[c.p],
          fin: i === pick.length - 1 && !strokes.some((s) => s.fin),
        });
      }
      if (!strokes.some((s) => s.fin) && strokes.length) strokes[strokes.length - 1].fin = 1;
    }
    } // 非极简通路结束（起形→铺大色→塑形→点睛）

    // ---- 质量：画布 vs 原图 + 主体覆盖 + 缩略结构 ----
    let sumErr = 0, maxErr = 0, gt8 = 0, gt24 = 0, gt48 = 0, uncovered = 0;
    let paintErr = 0, paintGt8 = 0, paintGt24 = 0, paintGt48 = 0, reproducedPx = 0;
    const reproduced = new Uint8Array(N);
    for (let p = 0; p < N; p++) {
      const q = p * 3;
      let d;
      if (style === 'pencil') {
        d = Math.abs((canvas[q] * 0.299 + canvas[q + 1] * 0.587 + canvas[q + 2] * 0.114) - L[p]);
      } else {
        const dr = Math.abs(canvas[q] - R[p]), dg = Math.abs(canvas[q + 1] - G[p]), db = Math.abs(canvas[q + 2] - B[p]);
        d = dr > dg ? (dr > db ? dr : db) : (dg > db ? dg : db);
      }
      sumErr += d;
      if (d > maxErr) maxErr = d;
      if (d > 8) gt8++; if (d > 24) gt24++; if (d > 48) gt48++;
      // 未落笔但画布已经和原图一致（纸白、线稿内部白区、抗锯齿过渡）不算漏画。
      // covered 仍只表示真实触达的像素；reproduced 用于人类可读的覆盖率/查漏。
      const ok = !!covered[p] || d <= 8;
      if (ok) { reproduced[p] = 1; reproducedPx++; }
      if (!paper[p] && !ok) uncovered++;
      if (!paper[p]) {
        paintErr += d;
        if (d > 8) paintGt8++; if (d > 24) paintGt24++; if (d > 48) paintGt48++;
      }
    }
    const nonPaperPx = Math.max(1, N - paperPx);
    let subjectCov = 0, subjectAll = 0, edgeRecall = 0, edgeAll = 0;
    for (let p = 0; p < N; p++) {
      if (subject[p]) { subjectAll++; if (reproduced[p]) subjectCov++; }
      if (!paper[p] && edge[p] >= e85) { edgeAll++; if (reproduced[p]) edgeRecall++; }
    }
    const s4 = 4, w4 = Math.max(1, Math.round(W / s4)), h4 = Math.max(1, Math.round(H / s4));
    let thumbMean = 0, thumbBad = 0, edgeScore = 0, edgeN = 0;
    {
      const cA = new Float64Array(w4 * h4 * 3), cB = new Float64Array(w4 * h4 * 3);
      for (let y = 0; y < H; y++) {
        const yy = Math.min(h4 - 1, (y / s4) | 0);
        let p = y * W;
        for (let x = 0; x < W; x++, p++) {
          const xx = Math.min(w4 - 1, (x / s4) | 0), k = (yy * w4 + xx) * 3;
          cA[k] += canvas[p * 3]; cA[k + 1] += canvas[p * 3 + 1]; cA[k + 2] += canvas[p * 3 + 2];
          cB[k] += R[p]; cB[k + 1] += G[p]; cB[k + 2] += B[p];
        }
      }
      const cell = s4 * s4;
      for (let i = 0; i < w4 * h4; i++) {
        for (let c = 0; c < 3; c++) {
          const a = cA[i * 3 + c] / cell, b = cB[i * 3 + c] / cell;
          const d = Math.abs(a - b);
          thumbMean += d;
          if (d > 8) thumbBad++;
        }
      }
      thumbMean /= w4 * h4 * 3;
      thumbBad = thumbBad / (w4 * h4 * 3) * 100;
      const lumA = new Float32Array(w4 * h4), lumB = new Float32Array(w4 * h4);
      for (let i = 0; i < w4 * h4; i++) {
        lumA[i] = (cA[i * 3] * 0.299 + cA[i * 3 + 1] * 0.587 + cA[i * 3 + 2] * 0.114) / cell;
        lumB[i] = (cB[i * 3] * 0.299 + cB[i * 3 + 1] * 0.587 + cB[i * 3 + 2] * 0.114) / cell;
      }
      for (let y = 1; y < h4 - 1; y++) {
        for (let x = 1; x < w4 - 1; x++) {
          const i = y * w4 + x;
          const ga = Math.hypot(lumA[i + 1] - lumA[i - 1], lumA[i + w4] - lumA[i - w4]);
          const gb = Math.hypot(lumB[i + 1] - lumB[i - 1], lumB[i + w4] - lumB[i - w4]);
          edgeScore += Math.min(ga, gb) / Math.max(4, Math.max(ga, gb));
          edgeN++;
        }
      }
      edgeScore = edgeN ? edgeScore / edgeN : 0;
    }
    const quality = {
      tolerance: 255,
      bucketT: 0, max: Math.round(maxErr), mean: +(sumErr / N).toFixed(3),
      gt8: +(gt8 / N * 100).toFixed(3),
      gt24: +(gt24 / N * 100).toFixed(3),
      gt48: +(gt48 / N * 100).toFixed(3),
      // 保留“非纸面”口径，方便和旧版画家指标继续横向比较；主字段 mean/gt*
      // 统一按整张画布统计，与导出后逐像素复核完全一致。
      paintMean: +(paintErr / nonPaperPx).toFixed(3),
      paintGt8: +(paintGt8 / nonPaperPx * 100).toFixed(3),
      paintGt24: +(paintGt24 / nonPaperPx * 100).toFixed(3),
      paintGt48: +(paintGt48 / nonPaperPx * 100).toFixed(3),
      effectiveCoverage: +(reproducedPx / N * 100).toFixed(2),
      uncovered, regions: G_, colorRegions: G_, inkRegions: 0,
      thumbMean: +thumbMean.toFixed(3), thumbBad: +thumbBad.toFixed(3),
      edgeScore: +edgeScore.toFixed(3),
      subjectCoverage: +(subjectCov / Math.max(1, subjectAll) * 100).toFixed(2),
      edgeCoverage: +(edgeRecall / Math.max(1, edgeAll) * 100).toFixed(2),
      paperOK: style === 'pencil', artist: true,
    };
    const phases = [0, 1, 2, 3].map((ph) => strokes.filter((s) => s.ph === ph).length);
    const buildMs = Date.now() - t0;
    const paintablePx = exactInfo && exactInfo.paintable ? exactInfo.paintable : (N - paperPx);
    const info = {
      mode: 'artist', style, level: fid, palette: palette.length, flatScore: +flatScore.toFixed(3),
      isFlat, complexity: +complexity.toFixed(3), groups: G_, budget, hardCap,
      baseBrush: +baseBrush.toFixed(1), baseStrokes: baseCount, strokes: strokes.length,
      max: quality.max, mean: quality.mean, uncovered, zoneCoverage: +(zoneCov / Math.max(1, paintablePx) * 100).toFixed(1), subjectCoverage: quality.subjectCoverage,
      edgeCoverage: quality.edgeCoverage, edgeScore: quality.edgeScore,
      buildMs, paperPx, maskPx, exact: exactInfo || undefined, seed: exactInfo ? exactInfo.seed : undefined,
      topGroups: groups.slice().sort((a, b) => b.area - a.area).slice(0, 16).map((g) => ({
        a: g.area, sal: +g.sal.toFixed(2), edge: +g.edge.toFixed(1), bd: g.bg, sd: g.std, mg: g.mg, gr: g.grad,
        fill: +g.fill.toFixed(2), th: +g.thick.toFixed(1), n: gStrokeN[g.gid],
        un: groupUncov[g.gid], lab: g.label, box: [g.x0, g.y0, g.x1, g.y1],
      })),
      // 全量分组（只在调试时带出）：排版/元素聚类的离线调参用
      allGroups: opts.debugMasks ? groups.map((g) => ({
        gid: g.gid, a: g.area, m: g.mean, box: [g.x0, g.y0, g.x1, g.y1],
        sal: +g.sal.toFixed(3), bg: g.bg, line: g.lineLike, subj: g.subj || 0,
        bd: g.backdrop || 0, soft: g.soft || 0, grad: g.grad, ph: 0,
      })) : undefined,
      paletteColors: palette.map((c) => c.join(',')),
      groupOf: opts.debugMasks ? groupOf : undefined,
      labels: opts.debugMasks ? labels : undefined,
      groupLabels: opts.debugMasks ? groups.map((g) => g.label) : undefined,
      qimg: opts.debugMasks ? (() => {
        const qi = new Uint8Array(N * 3);
        for (let p = 0; p < N; p++) { const c = palette[labels[p]] || [255, 255, 255]; qi[p * 3] = c[0]; qi[p * 3 + 1] = c[1]; qi[p * 3 + 2] = c[2]; }
        return qi;
      })() : undefined,
      covered: opts.debugMasks ? covered : undefined,
      residualMask: opts.debugMasks ? (exactInfo && exactInfo.residualMap) : undefined,
      subject: opts.debugMasks ? subject : undefined,
      paper: opts.debugMasks ? paper : undefined,
    };
    if (opts.debug) {
      console.log('[artist] ' + style + ' L' + fid + ' pal=' + palette.length + ' flat=' + info.isFlat +
        ' fs=' + flatScore.toFixed(3) + ' cx=' + complexity.toFixed(3) + ' groups=' + G_ + ' budget=' + budget + ' base=' + baseCount + ' strokes=' + strokes.length +
        ' mean=' + quality.mean + ' unc=' + uncovered + ' zone=' + (zoneCov / Math.max(1, paintablePx) * 100).toFixed(1) +
        '% subj=' + quality.subjectCoverage + '% edge=' + quality.edgeScore + ' ms=' + buildMs);
    }
    prog(1.0, '完成');
    return {
      W, H, strokes, clips,
      canvasRgb: opts.returnCanvas ? canvas : undefined,
      keys: undefined,
      palette: opts.debug ? palette : undefined,
      dbg: opts.debug ? {
        artist: info,
        marks: [
          { tag: '起形', n: phases[0] }, { tag: '铺大色', n: phases[1] },
          { tag: '塑形', n: phases[2] }, { tag: '点睛', n: phases[3] },
        ],
      } : undefined,
      probe: undefined,
      stats: {
        regions: G_, inkGroups: 0, strokes: strokes.length,
        totalMs: strokes.reduce((a, s) => a + s.ms, 0),
        phases, colors: style === 'pencil' ? 0 : palette.length,
        photo: !isFlat, style: opts.style, detail: opts.detail, fidelity: fid,
        quality, algo: opts.algo === 'compiler' ? 'compiler' : (opts.algo === 'painter' ? 'painter' : 'artist'),
        seed: exactInfo ? exactInfo.seed : undefined,
        exactMode: exactInfo ? exactInfo.mode : undefined,
        exactOrder: exactInfo ? exactInfo.order : undefined,
        bgFill: exactInfo ? exactInfo.bgFill : undefined,
        compilerMode: exactInfo ? exactInfo.compilerMode : undefined,
        closedRegions: exactInfo ? exactInfo.closedRegions : undefined,
        ring: exactInfo ? exactInfo.ring : undefined,
        transactions: exactInfo ? exactInfo.transactions : undefined,
        txCounts: exactInfo ? exactInfo.txCounts : undefined,
        txOrder: exactInfo ? exactInfo.txOrder : undefined,
      },
    };
  }

  async function run(px, W, H, opts, onProgress) {
    await ensureUtil();
    const rawOpts = opts || {};
    opts = Object.assign({}, CFG, rawOpts);
    UTIL.cfg.capfix = opts.capFix !== false;
    PROF_FLAT_SAMPLE = opts.profFlatSample !== false;
    // 还原程度：1 省笔 … 5 极致。3 = 原来的标准档（默认，逐像素结果不变）。
    // 老的 detail 入参仍能用（0→1 省笔、1→3 标准、2→5 极致），新代码请传 fidelity。
    let fid = rawOpts.fidelity;
    if (fid === undefined || fid === null) {
      fid = rawOpts.detail === undefined ? CFG.fidelity
        : (rawOpts.detail === 0 ? 1 : (rawOpts.detail === 2 ? 5 : 3));
    }
    fid = Math.max(1, Math.min(5, Math.round(+fid) || 3));
    opts.fidelity = fid;
    COMPILER_FID = fid;
    SNAP_OUT = null;
    // ---- 还原程度 = “处理细节 / 过渡色”的细致程度（2026-11-09 重定义）----
    // 旧版把 4/5 档做成“补漏切得更碎、补丁更多”，结果插画上 ⑤ 档反而更乱更慢
    // （实测 s1：①③ 逐像素差 3.1%、⑤ 3.9%），档与档之间除了笔数也没别的差别。
    // 新版只动两件事：
    //   1) 色彩分辨率：区域色板色数 k、区域色彩模型（色带/色场）分辨率、底色格边长；
    //   2) 补笔只沿用基准档的结构参数，4/5 档仅多补 1~2 轮残差。
    // 于是 ① 把渐变并成 3~5 个色块，⑤ 把过渡还原到接近 1:1，中间各档只差色彩分辨率。
    COMPILER_VIEW = [
      // k：区域色板色数倍率基准；snap：是否把图像量化到色板（色块感）；
      // kMax*：色带模型上限；grid*：色场格子数；pen/gpen：模型验收惩罚（越小越细）；
      // cell：底色（纸面/渐变底）格子边长系数
      { k: 0.75, snap: 1, row: 1, kMaxBig: 1, kMaxMid: 1, kMaxSmall: 1, cell: 1.00,
        gridBig: 0, gridMid: 0, gridSmall: 0, gpen: 1.40, pen: 1.60, plane: 0 },
      { k: 0.88, snap: 1, row: 1, kMaxBig: 4, kMaxMid: 4, kMaxSmall: 3, cell: 1.00,
        gridBig: 0, gridMid: 0, gridSmall: 0, gpen: 1.10, pen: 1.15, plane: 1 },
      { k: 1.00, snap: 0, kMaxBig: 4, kMaxMid: 3, kMaxSmall: 2, cell: 1.00,
        gridBig: 32, gridMid: 10, gridSmall: 4, gpen: 0.90, pen: 0.85, plane: 1 },
      // 4/5 档的色板色数保持和标准档一致：把区域切得更碎反而会让"父块铺底"
      // 顺序错位（猫身体下缘那道浅色横带就是色板加到 22 色后切出来的）。
      // 这两档的细腻度全部交给色彩模型（色场/色带）和底色格子。
      { k: 1.00, snap: 0, kMaxBig: 6, kMaxMid: 4, kMaxSmall: 3, cell: 0.80,
        gridBig: 48, gridMid: 14, gridSmall: 5, gpen: 0.65, pen: 0.55, plane: 1 },
      { k: 1.00, snap: 0, kMaxBig: 9, kMaxMid: 5, kMaxSmall: 3, cell: 0.62,
        gridBig: 64, gridMid: 20, gridSmall: 6, gpen: 0.45, pen: 0.35, plane: 1 },
    ][fid - 1];
    // 诊断用：调用方可以覆盖档位表里的单项（实验脚本用，正常路径不传）。
    if (rawOpts.viewOverride) COMPILER_VIEW = Object.assign({}, COMPILER_VIEW, rawOpts.viewOverride);
    // 档位差异落在"色彩分辨率 + 补多细"上，不再改补漏切分/收边门槛：
    // 主笔触的取色/分区逻辑不动，所以低档只是更概括，不会把画面画歪。
    // 只覆盖仍是默认值的项：调用方显式传的参数优先（外部项目可以自己微调）。
    const setDefault = (vals) => {
      for (const k in vals) if (opts[k] === CFG[k]) opts[k] = vals[k];
    };
    if (fid === 1) {
      setDefault({ residual: [34, 28, 23, 19], holeT: 40, resMin: 1.35,
                   holeSplit: 22, resTail: 0, resTailMax: 2 });
    } else if (fid === 2) {
      setDefault({ residual: [32, 26, 21, 17], holeT: 33, resMin: 1.15,
                   holeSplit: 14, resTail: 0 });
    } else if (fid === 4) {
      // 精细：结构参数与标准档一致，只多补一轮更细的残差。
      setDefault({ residual: [30, 24, 18, 14, 11, 9, 7, 5.5], resMin: 0.9 });
    } else if (fid === 5) {
      // 极致：再多补两轮。旧版这里把补漏阈值压到 17、切分压到 4、外加全图精修，
      // 插画上会把一整块色区切成几段不同色（猫身体上那道浅色横带就是这么来的）。
      setDefault({ residual: [30, 24, 18, 14, 11, 9, 7, 5.5, 4.5], resMin: 0.8 });
    }
    const capScale = fid === 1 ? 0.5 : (fid === 2 ? 0.7 : (fid === 4 ? 1.3 : (fid === 5 ? 1.8 : 1)));
    // cover mode：档位不再是"补笔轮数"，而是颜色容差 + 笔数预算。
    // 预设只用 rawOpts 里没显式传的值（和上面的 setDefault 同一套规则）。
    opts.coverMode = rawOpts.coverMode === undefined ? true : !!rawOpts.coverMode;
    {
      const cvT = [8, 6, 4, 2, 1][fid - 1];
      const cvTM = [20, 16, 12, 8, 2][fid - 1];
      const cvB = [26000, 45000, 100000, 175000, 500000][fid - 1];
      opts.coverT = Math.max(1, Math.round(rawOpts.coverT || cvT));
      opts.coverTMax = Math.max(opts.coverT, Math.round(rawOpts.coverTMax || cvTM));
      opts.coverBudget = Math.max(200, Math.round(rawOpts.coverBudget || cvB));
      // 兼容老入参：显式传 exactRepair>0 时，把它当作 cover 的颜色容差（不再追加补丁笔）。
      if (rawOpts.exactRepair !== undefined && +rawOpts.exactRepair > 0) {
        opts.coverT = opts.coverTMax = Math.max(1, Math.round(+rawOpts.exactRepair));
      }
      if (opts.coverMode) opts.exactRepair = 0;
    }
    // 笔触风格：只改"笔形/笔宽/重叠/起稿笔感"，覆盖率的规则不动（保真优先）
    if (opts.style === 'pencil') {
      Object.assign(opts, { bwF: 0.10, bwMin: 7, bwMax: 30, coverOv: 0.55,
                            taperLo: 0.74, taperAmp: 0.34, taperWob: 0.12,
                            sketchHalf: 1.2, sketchGrid: 9, sketchOver: 8, bleedP: 0.16 });
    } else if (opts.style === 'oil') {
      Object.assign(opts, { bwF: 0.21, bwMin: 12, bwMax: 62, coverOv: 0.72,
                            taperLo: 0.93, taperAmp: 0.11, taperWob: 0.05,
                            sketchHalf: 2.6, sketchGrid: 4, sketchOver: 3, bleedP: 0.3, bleedR: 3 });
    }
    const yieldUI = () => new Promise((r) => setTimeout(r, 0));
    const prog = (p, msg) => { if (onProgress) onProgress(p, msg); };
    // 分段计时（诊断用）：哪一段在吃时间
    const T = {}; let tPrev = Date.now();
    const lap = (k) => { const n = Date.now(); if (opts.debug) T[k] = (T[k] || 0) + (n - tPrev); tPrev = n; };

    // 第三种算法：画家模式（观察 → 概括 → 起形 → 分阶段落笔）。独立入口，不碰 cover/pyramid。
    // 'painter'（画家·过程版）共用同一套观察/落笔机制，只在作画组织上换成"人画五遍"流程。
    if (opts.algo === 'artist' || opts.algo === 'painter' || opts.algo === 'compiler') return runArtistMode(px, W, H, opts, onProgress);
    // 第二种算法：整幅逐级细化（16 → 8 → 4 → 2 → 1）。走独立入口，不碰 cover 路径。
    if (opts.algo === 'pyramid') return PYRAMID.run(CFG, UTIL, px, W, H, opts, onProgress);
    // cover mode 是一条独立的精确管线：不需要调色板/图层/残差，直接早返回。
    if (opts.coverMode) return COVER.run(CFG, UTIL, px, W, H, opts, onProgress);

    // 错误连通块的"真实厚度" = 2×最大内切半径（距离变换）。
    // 不能再用 面积÷外框边长：字母/飞机那圈深色描边是细环，按面积÷外框会算出 46px 的假厚度，
    // 整条描边就被当成"大片平滑渐变"跳过、永远不补（用户看到的"边被啃"里有一条就是这个）。
    function compThick(c, pixArr) {
      const bw2 = c.x1 - c.x0 + 1, bh2 = c.y1 - c.y0 + 1;
      const m2 = new Uint8Array(bw2 * bh2);
      for (let k = 0; k < c.count; k++) {
        const p2 = pixArr[c.start + k];
        const x2 = p2 % W, y2 = (p2 - x2) / W;
        m2[(y2 - c.y0) * bw2 + (x2 - c.x0)] = 1;
      }
      const dt2 = distanceTransform(m2, bw2, bh2);
      let mx2 = 0;
      for (let i2 = 0; i2 < dt2.length; i2++) if (dt2[i2] > mx2) mx2 = dt2[i2];
      return mx2 * 2;
    }

    const N = W * H;
    const R = new Uint8Array(N), G = new Uint8Array(N), B = new Uint8Array(N);
    for (let i = 0; i < N; i++) { R[i] = px[i * 4]; G[i] = px[i * 4 + 1]; B[i] = px[i * 4 + 2]; }
    // 分块用的平滑图（取色与差异仍用原图）。
    // 先 median3 去噪点；再看"纹理强度"决定要不要再模糊（照片才需要，插画保持线条锐利）
    let Rs = med3(R, W, H), Gs = med3(G, W, H), Bs = med3(B, W, H);
    {
      let diff = 0;
      for (let i = 0; i < N; i++) {
        const d = Math.abs(Rs[i] - R[i]) + Math.abs(Gs[i] - G[i]) + Math.abs(Bs[i] - B[i]);
        if (d > 36) diff++;
      }
      const texFrac = diff / N;
      if (texFrac > 0.06) {
        const blurN = Math.max(0, Math.min(3, opts.photoBlurPasses | 0));
        for (let q = 0; q < blurN; q++) {
          Rs = box3(Rs, W, H); Gs = box3(Gs, W, H); Bs = box3(Bs, W, H);
        }
      }
      var texFracOut = texFrac;
      // 照片自动模式：纹理强的图（照片/扫描件）单独一套参数——
      // 色数提上去、笔更细、允许更多笔，不然平涂会把纹理糊成一格一格的色块。
      if (texFrac > 0.06) {
        opts.photoMode = true;
        // 实测（照片样张）：40 色比 32 色可见差异 35.03% → 34.63%，笔数还略少；再往上加轮数没收益
        if (!opts.colors && opts.autoColors) opts.colors = texFrac > 0.14 ? 44 : 40;
        if (opts.maxStrokes === CFG.maxStrokes) opts.maxStrokes = Math.round(40000 * capScale);
        if (opts.minArea === CFG.minArea) opts.minArea = texFrac > 0.14 ? 90 : 110;
        if (opts.bwF === CFG.bwF) { opts.bwF = 0.12; opts.bwMin = 7; }
        if (opts.coverOv === CFG.coverOv) opts.coverOv = 0.58;
        // 细线对比门槛：照片类的"细线"多是毛发/发丝（该画的细节），门槛放低保住它们；
        // 平涂/海报类的"细线"多是纸纹脏痕，保持高门槛（不写上去）
        if (opts.inkMinCd === CFG.inkMinCd) opts.inkMinCd = 60;
        // 照片类的"层"要切得细：合并门槛一大，整片岩石/毛发会被并成一层、用一个平均色去刷，
        // 远处暗部就整片错（实测 s2 19.3% → 32.6%）。25 是实测拐点。
        if (opts.objMergeCd === CFG.objMergeCd) opts.objMergeCd = 25;
        // 照片类的"又大又厚"门槛要保持低：纹理本来就该留着，让残差去描 8~30px 厚的块
        // 只会把纹理糊成色块（实测照片可见差异 2.58% → 2.92%）
        if (opts.resThick === CFG.resThick) opts.resThick = 8;
        // 小纹理块用"跟厚度相称"的笔宽，别用一把大刷子把爪垫/毛发刷成一个均值色
        if (opts.bwThickCap === CFG.bwThickCap) opts.bwThickCap = 2.0;
        // 照片的“标准”档（第 3 档）自动套用更细的补笔 + 收边参数；
        // 低档更粗、高档更细，参数在 run() 开头按 fidelity 已经设好。
        if (fid === 3) {
          setDefault({
            residual: [30, 24, 18, 14, 11, 9, 7, 5.5], holeT: 22, resMin: 0.8,
            resHalfA: 0.85, resHalfB: 0.55, sketchMax: 76, sketchGrid: 5, edgeT: 8,
          });
        }
        // 最高档再把“又大又厚”的门槛压低一点：照片里 6~8px 的毛发/纹理块也进补笔。
        if (fid === 5 && opts.resThick === 8) opts.resThick = 6;
        // 补缝按颜色二分的停止阈值：18 时爪垫这种 17 级明暗差会被当成一块、补成均值色
        if (fid === 3 && opts.holeSplit === CFG.holeSplit) opts.holeSplit = 8;
      }
      // 非照片（海报/插画）：标准档关掉自适应尾轮（追的是 5~7 的亚可见色差，笔多收益极小）；
      // 只有用户主动选“精细/极致”才把它打开。
      if (!opts.photoMode) {
        if (fid <= 3 && opts.resTail === CFG.resTail) opts.resTail = 0;
        else if (fid === 4 && opts.resTail === CFG.resTail) opts.resTail = 1;
        if (opts.maxStrokes === CFG.maxStrokes) opts.maxStrokes = Math.round(CFG.maxStrokes * capScale);
      }
    }
    // 自动色数（插画类也走这里：没指定颜色数就按纹理强弱给个合适的）
    // 非照片类（插画/海报）的自动色数：原来是 24。实测 40 色在三张示例上都更好或持平——
    // 海报那种"印刷扫描件"的深色描边/暗红在 24 色里根本没有对应的中心，量化只能把它塞给
    // 橙字或蓝底，于是边上一圈被涂成浑浊的棕带（"Gets first attention" 可见差异 11.4% → 3.5%）。
    if (!opts.colors && opts.autoColors) opts.colors = 40;
    if (opts.debug) console.log(`[auto] 纹理 ${(texFracOut * 100).toFixed(1)}% → colors=${opts.colors} photo=${!!opts.photoMode} maxStrokes=${opts.maxStrokes} bwF=${opts.bwF}`);

    prog(0.02, '分析颜色…'); await yieldUI();

    // 1) Lab + k-means（隔点采样加速）
    const step = Math.max(1, Math.round(Math.sqrt(N / 220000)));
    const nS = Math.ceil(N / step);
    const samp = new Float32Array(nS * 3);
    let ns = 0;
    {
      const lab = [0, 0, 0];
      for (let i = 0; i < N; i += step) {
        srgb2labInto(Rs[i], Gs[i], Bs[i], lab);
        samp[ns * 3] = lab[0]; samp[ns * 3 + 1] = lab[1]; samp[ns * 3 + 2] = lab[2];
        ns++;
      }
    }
    const { cen } = kmeans(samp.subarray(0, ns * 3), opts.colors, 12, 12345);
    const cenRaw = Array.from(cen, (v) => Math.round(v));

    // 2) 归并相近中心（领袖聚类）→ 调色板（RGB 由样本均值给出）
    const K = opts.colors;
    const pai = new Int32Array(K).fill(-1);
    const pal = [];
    for (let k = 0; k < K; k++) {
      let hit = -1;
      for (let p = 0; p < pal.length; p++) {
        const d = Math.hypot(cen[k * 3] - pal[p][0], cen[k * 3 + 1] - pal[p][1], cen[k * 3 + 2] - pal[p][2]);
        if (d < opts.mergeThr) { hit = p; break; }
      }
      if (hit < 0) { pal.push([cen[k * 3], cen[k * 3 + 1], cen[k * 3 + 2], 0]); hit = pal.length - 1; }
      pai[k] = hit;
    }
    // 中心 → 代表 RGB（用该中心附近的像素均值），顺带把"每个像素属于哪个调色板色"
    // 一次算完（labels）。这两件事原来各跑了一遍全图 × K 色的最近中心搜索，
    // 用的是同一份 cen/pai（中间没有任何改动）⇒ 结果逐位相同，纯白跑一遍。
    const labels = new Uint8Array(N);
    {
      const accR = new Float64Array(pal.length), accG = new Float64Array(pal.length),
            accB = new Float64Array(pal.length), cnt = new Float64Array(pal.length);
      const lab = [0, 0, 0];
      for (let i = 0; i < N; i++) {
        srgb2labInto(Rs[i], Gs[i], Bs[i], lab);
        const l0 = lab[0], l1 = lab[1], l2 = lab[2];
        let best = 0, bd = Infinity;
        for (let k = 0, k3 = 0; k < K; k++, k3 += 3) {
          const dL = l0 - cen[k3], dA = l1 - cen[k3 + 1], dB = l2 - cen[k3 + 2];
          const d = dL * dL + dA * dA + dB * dB;
          if (d < bd) { bd = d; best = k; }
        }
        const p = pai[best];
        labels[i] = p;
        accR[p] += R[i]; accG[p] += G[i]; accB[p] += B[i]; cnt[p]++;
      }
      for (let p = 0; p < pal.length; p++) {
        if (cnt[p] > 0) { pal[p][0] = accR[p] / cnt[p]; pal[p][1] = accG[p] / cnt[p]; pal[p][2] = accB[p] / cnt[p]; }
      }
    }
    prog(0.16, '分块…'); await yieldUI();

    // 3) 全图归类 —— 已在上面的循环里一起算完（labels），这里不再重复搜一遍

    // 4) 连通域
    let { compOf, pix, comps } = compsOfLabels(labels, W, H);

    // 5) 碎块吸收（并到颜色最近、面积最大的邻块）
    const oldComps = comps;
    // 细线像素（文字笔画、轮廓线）单独记下来：它们并进邻块 ⇒ 铺色时那里会被底色铺满，
    // 细线自己留到最后再"写"上去（人也是先铺满、最后题字，不是先挖个洞再一点点补）
    const inkPix = new Uint8Array(N);
    // 纹理像素（纸纹/噪点）：并进邻块后"不画、不参与底色取色、残差也不补"。
    // 老海报/扫描件的斑驳就是被当成内容一块块画出来才显得脏，放大后跟原图差得远。
    const texPix = new Uint8Array(N);
    let nThin = 0, nTex = 0;
    {
      const parent = new Int32Array(comps.length);
      for (let i = 0; i < comps.length; i++) parent[i] = i;
      const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
      let nSmall = 0, nMerged = 0, nNoVote = 0, nFar = 0, nNaN = 0;
      const thinLim = 9.0 * (W / 1024);   // 平均笔画宽度 ≤ 它就算细线（对齐原来 maxr ≤ 6.5*scale 的口径）
      // 邻块投票的计数用 Int32Array + touched 列表，不用 Map：数字键的 Map 在这
      // 是几百万次哈希（3 万块 × 8 邻域 × 2 轮），换数组后同样的算术、同样的
      // "首次遇到顺序" ⇒ bestScore 并列时的取舍一致，结果逐位不变。
      const vcnt = new Int32Array(comps.length);
      const touched = [];
      for (let round = 0; round < 2; round++) {
        for (let ci = 0; ci < comps.length; ci++) {
          if (find(ci) !== ci) continue;
          const c = comps[ci];
          const bwW = c.x1 - c.x0 + 1, bwH = c.y1 - c.y0 + 1;
          const estW = c.count / Math.max(1, Math.max(bwW, bwH));
          // 细线只认"长条形"（文字笔画、轮廓）：方方正正的小斑不是线，是纸纹
          const elong = Math.max(bwW, bwH) / Math.max(1, Math.min(bwW, bwH));
          const thin = estW <= thinLim && c.count >= 8 && elong >= 2.2;
          if (!thin && c.count >= opts.minArea) continue;
          nSmall++;
          touched.length = 0;
          for (let k = 0; k < c.count; k++) {
            const p = pix[c.start + k];
            const x = p % W, y = (p - x) / W;
            for (let dy = -1; dy <= 1; dy++) {
              const yy = y + dy;
              if (yy < 0 || yy >= H) continue;
              const row = yy * W;
              for (let dx = -1; dx <= 1; dx++) {
                if (!dx && !dy) continue;
                const xx = x + dx;
                if (xx < 0 || xx >= W) continue;
                const cj = find(compOf[row + xx]);
                if (cj === ci) continue;
                if (vcnt[cj]++ === 0) touched.push(cj);
              }
            }
          }
          const pi = pal[c.label];
          let bestJ = -1, bestScore = -1;
          for (let ti = 0; ti < touched.length; ti++) {
            const cj = touched[ti], v = vcnt[cj];
            const pj = pal[comps[cj].label];
            const cd = Math.hypot(pj[0] - pi[0], pj[1] - pi[1], pj[2] - pi[2]);
            const score = v / (1 + cd * 0.5);
            if (score > bestScore) { bestScore = score; bestJ = cj; }
          }
          for (let ti = 0; ti < touched.length; ti++) vcnt[touched[ti]] = 0;
          if (bestJ < 0) { nNoVote++; continue; }
          const pj = pal[comps[bestJ].label];
          if (!pj || !pi) { nNaN++; continue; }
          const cd = Math.hypot(pj[0] - pi[0], pj[1] - pi[1], pj[2] - pi[2]);
          // 纹理判据：小块 + 对比不强 ⇒ 纸纹/噪点（并进邻块、不画）
          const tex = !thin && c.count < opts.texMax && cd <= opts.texCd;
          if (thin || c.count < 6 || cd <= opts.absorbCd || tex) {
            parent[ci] = bestJ; nMerged++;
            if (thin) {
              if (cd >= opts.inkMinCd) {
                nThin++; for (let k = 0; k < c.count; k++) inkPix[pix[c.start + k]] = 1;
              } else {                                   // 弱对比的"线"其实是纸纹暗纹，不写
                nTex++; for (let k = 0; k < c.count; k++) texPix[pix[c.start + k]] = 1;
              }
            } else {
              nTex++; for (let k = 0; k < c.count; k++) texPix[pix[c.start + k]] = 1;
            }
          } else nFar++;
        }
      }
      if (opts.debug) console.log(`[absorb] comps=${comps.length} small=${nSmall} merged=${nMerged} thin=${nThin} tex=${nTex} noVote=${nNoVote} far=${nFar} nan=${nNaN} pal=${pal.length}`);
      // 重贴标签
      const rootOf = new Int32Array(comps.length);
      for (let i = 0; i < comps.length; i++) rootOf[i] = find(i);
      const L2 = new Uint32Array(N);
      for (let i = 0; i < N; i++) L2[i] = rootOf[compOf[i]] + 1;
      const cc = compsOfLabels(L2, W, H);
      compOf = cc.compOf; pix = cc.pix; comps = cc.comps;
      for (const c of comps) {
        const oldIdx = c.label - 1;
        c.palLabel = oldComps[oldIdx] ? oldComps[oldIdx].label : c.label - 1;
      }
    }

    // 6) 区块统计（面积/重心/PCA/包围盒掩膜）
    lap('absorb');
    prog(0.28, '整理区块…'); await yieldUI();
    const regions = [];
    for (let ci = 0; ci < comps.length; ci++) {
      const c = comps[ci];
      const n = c.count;
      let sx = 0, sy = 0;
      for (let k = 0; k < n; k++) {
        const p = pix[c.start + k];
        const x = p % W; sx += x; sy += (p - x) / W;
      }
      const cx = sx / n, cy = sy / n;
      let sxx = 0, sxy = 0, syy = 0;
      for (let k = 0; k < n; k++) {
        const p = pix[c.start + k];
        const x = p % W, y = (p - x) / W;
        const dx = x - cx, dy = y - cy;
        sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
      }
      sxx /= n; sxy /= n; syy /= n;
      const tr = sxx + syy, det = sxx * syy - sxy * sxy;
      const l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det));
      const l2 = tr / 2 - Math.sqrt(Math.max(0, tr * tr / 4 - det));
      const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      let ax = Math.cos(ang), ay = Math.sin(ang);
      // 让主轴方向落在"更长"的一侧
      let tmin = Infinity, tmax = -Infinity, vmax = 0;
      const nx = -ay, ny = ax;
      for (let k = 0; k < n; k++) {
        const p = pix[c.start + k];
        const x = p % W, y = (p - x) / W;
        const t = (x - cx) * ax + (y - cy) * ay;
        const v = Math.abs((x - cx) * nx + (y - cy) * ny);
        if (t < tmin) tmin = t;
        if (t > tmax) tmax = t;
        if (v > vmax) vmax = v;
      }
      if (tmax - tmin < 2 * vmax) { ax = nx; ay = ny; let tn = Infinity, tx = -Infinity, vm = 0; }
      // 用最终轴重算范围
      {
        const nx2 = -ay, ny2 = ax;
        let t2min = Infinity, t2max = -Infinity, v2max = 0, v2s = [];
        for (let k = 0; k < n; k++) {
          const p = pix[c.start + k];
          const x = p % W, y = (p - x) / W;
          const t = (x - cx) * ax + (y - cy) * ay;
          const v = Math.abs((x - cx) * nx2 + (y - cy) * ny2);
          if (t < t2min) t2min = t;
          if (t > t2max) t2max = t;
          if (v > v2max) v2max = v;
        }
        tmin = t2min; tmax = t2max; vmax = v2max;
      }
      let sr = 0, sg = 0, sb = 0, cn = 0;
      for (let k = 0; k < n; k++) {
        const p = pix[c.start + k];
        if (inkPix[p] || texPix[p]) continue;   // 细线/纹理像素不算进底色（否则会被黑字、纸纹拉暗拉花）
        sr += R[p]; sg += G[p]; sb += B[p]; cn++;
      }
      const color = cn > 0 ? [sr / cn, sg / cn, sb / cn] : [0, 0, 0];
      regions.push({
        cid: ci, x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, area: n,
        cx, cy, ax, ay, tmin, tmax, hp: Math.max(1, vmax),
        color: [Math.round(color[0]), Math.round(color[1]), Math.round(color[2])],
        pix0: c.start, pix1: c.start + n - 1,
      });
    }

    // 7) 细线层：就是吸收阶段挑出来的细线像素（文字笔画、轮廓线）。
    //    它们已经并进邻块 ⇒ 铺色时被底色盖住，留到最后再"写"上去。
    const inkBin = inkPix;
    // 非照片图给细线留一条保护带：残差/补漏不要再去修已经画对的字和描边。
    // 照片不启用——照片里的"细线"是毛发/胡须，保护带会挡住周围的纹理修正。
    const inkGuard = new Uint8Array(N);
    if (!opts.photoMode && opts.inkGuard > 0) {
      inkGuard.set(dilate(inkPix, W, H, Math.max(0, Math.round(opts.inkGuard))));
    }
    const isInk = new Uint8Array(regions.length);
    const dbg = { dark: 0, darkThin: nThin, tex: texFracOut, texPix: nTex, pal: [], cen: cenRaw, smallLeft: regions.filter((r) => r.area < opts.minArea).length, marks: [] };
    const scale = W / 1024;
    // 区块面积分布（笔数来源分析的底数）：[<120, 120-600, 600-2400, 2400-1万, ≥1万]
    const areaBins = [0, 120, 600, 2400, 10000, Infinity];
    {
      const hist = new Array(areaBins.length - 1).fill(0);
      for (const r of regions) {
        for (let b = 0; b < hist.length; b++) if (r.area >= areaBins[b] && r.area < areaBins[b + 1]) { hist[b]++; break; }
      }
      dbg.areaHist = hist;
    }
    lap('regions');
    prog(0.38, '提笔勾线…'); await yieldUI();

    // 8) 笔触生成
    const strokes = [];       // {rib,tp,color,pen,ms,c(裁剪组),r(区块),ph(阶段)}
    const mark = (tag) => dbg.marks.push({ tag, n: strokes.length });   // 笔数分解埋点（dev/stroke_breakdown.mjs 用）
    const lastPen = { x: 0, y: 0 };   // 笔尖当前位置：铺色顺序按"就近"串起来
    // 阶段：0 起稿（轻勾轮廓） 1 铺色（大块优先→收小） 2 收形（勾线+中等补笔） 3 点睛（细补笔）
    let visCanvas = null;     // 调试/测试用：最终纯色光栅结果
    let keysRgb = null;       // 关键帧（拖动进度用）
    const clips = [];         // {x,y,w,h,mask}
    const target = { R, G, B };
    // 一块错误里"深浅混在一起"时（渐变带、两条细线挨着），用一个均值色补上去会把浅的那半
    // 刷深——飞机边上那些"深色楔子"就是这么来的，而且下一轮还会被重新判成错、再补一遍。
    // 先按颜色二分（方差最大的通道、按中位数切），每一份单独补（各用各的均值色）。
    const splitPixByColor = (pix, cnt, depth, out) => {
      if (depth >= 4 || cnt < 9) { out.push({ pix, cnt }); return; }
      let mn0 = 255, mn1 = 255, mn2 = 255, mx0 = 0, mx1 = 0, mx2 = 0;
      for (let k = 0; k < cnt; k++) {
        const p = pix[k];
        if (R[p] < mn0) mn0 = R[p]; if (R[p] > mx0) mx0 = R[p];
        if (G[p] < mn1) mn1 = G[p]; if (G[p] > mx1) mx1 = G[p];
        if (B[p] < mn2) mn2 = B[p]; if (B[p] > mx2) mx2 = B[p];
      }
      const s0 = mx0 - mn0, s1 = mx1 - mn1, s2 = mx2 - mn2;
      const smax = Math.max(s0, s1, s2);
      if (smax <= (opts.holeSplit || 1e9)) { out.push({ pix, cnt }); return; }
      const ch = s0 === smax ? 0 : (s1 === smax ? 1 : 2);
      const vals = new Float64Array(cnt);
      for (let k = 0; k < cnt; k++) { const p = pix[k]; vals[k] = ch === 0 ? R[p] : (ch === 1 ? G[p] : B[p]); }
      const sorted = Array.from(vals).sort((a, b) => a - b);
      const med = sorted[cnt >> 1];
      let i = 0, j = cnt - 1;
      while (i <= j) {
        if (vals[i] <= med) i++;
        else {
          const tp = pix[i]; pix[i] = pix[j]; pix[j] = tp;
          const tv = vals[i]; vals[i] = vals[j]; vals[j] = tv; j--;
        }
      }
      if (i === 0 || i === cnt) { out.push({ pix, cnt }); return; }
      splitPixByColor(pix.subarray(0, i), i, depth + 1, out);
      splitPixByColor(pix.subarray(i), cnt - i, depth + 1, out);
    };
    let curTarget = target;      // 当前取色源（底色层会换成"背景色场"）
    const strokeScale = Math.max(0.5, scale);

    const pushClip = (x, y, w, h, mask) => {
      clips.push({ x, y, w, h, mask });
      return clips.length - 1;
    };

    function bboxOfComp(cc, ci, pad) {
      const c = cc.comps[ci];
      const x = Math.max(0, c.x0 - pad), y = Math.max(0, c.y0 - pad);
      const x1 = Math.min(W - 1, c.x1 + pad), y1 = Math.min(H - 1, c.y1 + pad);
      const w = x1 - x + 1, h = y1 - y + 1;
      const m = new Uint8Array(w * h);
      for (let k = 0; k < c.count; k++) {
        const p = cc.pix[c.start + k];
        const px0 = p % W, py0 = (p - px0) / W;
        if (px0 < x || py0 < y || px0 > x1 || py0 > y1) continue;
        m[(py0 - y) * w + (px0 - x)] = 1;
      }
      return { x, y, w, h, m };
    }

    // 采样：某个多边形在某个掩膜内的目标平均色
    const segTmp = { w: 0, h: 0, m: null };
    function sampleColor(polyFlat, np, clipMask, clipX, clipY, clipW, clipH) {
      let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
      for (let i = 0; i < np; i++) {
        const x = polyFlat[i * 2], y = polyFlat[i * 2 + 1];
        if (x < xmin) xmin = x; if (x > xmax) xmax = x;
        if (y < ymin) ymin = y; if (y > ymax) ymax = y;
      }
      const mw = Math.max(1, Math.ceil(xmax - Math.floor(xmin)) + 1);
      const mh = Math.max(1, Math.ceil(ymax - Math.floor(ymin)) + 1);
      if (mw * mh > 4000000) return null;
      const ox = Math.floor(xmin), oy = Math.floor(ymin);
      const local = new Uint8Array(mw * mh);
      const pts = new Float64Array(np * 2);
      for (let i = 0; i < np; i++) { pts[i * 2] = polyFlat[i * 2] - ox; pts[i * 2 + 1] = polyFlat[i * 2 + 1] - oy; }
      fillPoly(local, mw, mh, pts);
      let sr = 0, sg = 0, sb = 0, cnt = 0;
      for (let y = 0; y < mh; y++) {
        const gy = oy + y;
        if (gy < clipY || gy >= clipY + clipH || gy < 0 || gy >= H) continue;
        for (let x = 0; x < mw; x++) {
          if (!local[y * mw + x]) continue;
          const gx = ox + x;
          if (gx < clipX || gx >= clipX + clipW || gx < 0 || gx >= W) continue;
          if (!clipMask[(gy - clipY) * clipW + (gx - clipX)]) continue;
          const p = gy * W + gx;
          sr += curTarget.R[p]; sg += curTarget.G[p]; sb += curTarget.B[p];
          cnt++;
        }
      }
      if (cnt < 4) return null;
      return [Math.round(sr / cnt), Math.round(sg / cnt), Math.round(sb / cnt)];
    }

    function pathSegments(path, n, segLen) {
      if (n < 2) return [{ pts: Float64Array.from([path[0], path[1]]), n: 1, len: 0 }];
      const cum = new Float64Array(n);
      for (let i = 1; i < n; i++) {
        cum[i] = cum[i - 1] + Math.hypot(path[i * 2] - path[(i - 1) * 2],
                                         path[i * 2 + 1] - path[(i - 1) * 2 + 1]);
      }
      const total = cum[n - 1];
      if (total <= 1e-6) return [{ pts: Float64Array.from([path[0], path[1]]), n: 1, len: 0 }];
      const at = (t) => {
        let i = 1;
        while (i < n - 1 && cum[i] < t) i++;
        const f = (t - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
        return [path[(i - 1) * 2] + (path[i * 2] - path[(i - 1) * 2]) * f,
                path[(i - 1) * 2 + 1] + (path[i * 2 + 1] - path[(i - 1) * 2 + 1]) * f];
      };
      const segs = [];
      const step = Math.max(4, segLen);
      let s0 = 0;
      while (s0 < total - 1e-6) {
        const e = Math.min(total, s0 + step);
        const pts = [];
        const p0 = at(s0), p1 = at(e);
        pts.push(p0[0], p0[1]);
        for (let k = 1; k < n - 1; k++) {
          if (cum[k] > s0 + 1e-6 && cum[k] < e - 1e-6) pts.push(path[k * 2], path[k * 2 + 1]);
        }
        pts.push(p1[0], p1[1]);
        segs.push({ pts: Float64Array.from(pts), n: pts.length >> 1, len: e - s0 });
        s0 = e;
      }
      return segs;
    }

    function emitStroke(ribFlat, np, pathFlat, nPath, halfW, color, pen, cIdx, rIdx, ph) {
      let len = 0;
      for (let i = 1; i < nPath; i++) {
        len += Math.hypot(pathFlat[i * 2] - pathFlat[(i - 1) * 2], pathFlat[i * 2 + 1] - pathFlat[(i - 1) * 2 + 1]);
      }
      const phase = ph === undefined ? 1 : ph;
      // 节奏：起稿又快又轻；点睛最慢最小心；其余按长度给时间（短笔也要有起步价）
      let weight;
      if (phase === 0) weight = 8 + len * 1.0;
      else if (phase === 3) weight = 26 + len * 2.6;
      else if (phase === 2) weight = 18 + len * 2.2;
      else weight = 12 + len * 1.8;
      weight *= 0.85 + 0.3 * rand01(len + strokes.length * 0.37, phase + 1.7);   // 每笔快慢有点起伏
      if (luma(color) > 238) weight *= 0.3;                                      // 白底一笔带过
      const rec = {
        rib: Array.from(ribFlat, (v) => Math.round(v * 10) / 10),
        tp: Array.from(pathFlat, (v) => Math.round(v * 10) / 10),
        w: Math.round(halfW * 2 * 10) / 10,
        color: [color[0], color[1], color[2]],
        pen: pen ? 1 : 0,
        ms: weight,           // 先存权重，收尾时按目标总时长归一
        c: cIdx, r: rIdx, ph: phase, ly: curLayer,
      };
      strokes.push(rec);
      if (nPath >= 1) {
        lastPen.x = pathFlat[(nPath - 1) * 2];
        lastPen.y = pathFlat[(nPath - 1) * 2 + 1];
      }
      return rec;
    }

    // 沿路径取局部色并按"颜色相近的相邻段"合并：返回待落笔的段（不直接落笔，好让调用方连笔）
    let segLenOverride = 0, joinCdOverride = 0;   // 底色层用：分段更短、颜色差得更少才并笔（渐变才不会被抹平）
    function localParts(path, n, halfW, clipMask, cx, cy, cw, ch, pen, cIdx, rIdx, fallback, ph) {
      const segs = pathSegments(path, n, segLenOverride || Math.max(opts.segMin * strokeScale, halfW * opts.segF));
      const cols = [];
      for (const sg of segs) {
        if (sg.n < 2) { cols.push(null); continue; }
        const rb = ribbon(sg.pts, sg.n, halfW);
        const rbS = ribbon(sg.pts, sg.n, halfW, true);   // 取色用平头：圆头会把两端邻色平均进来
        cols.push(sampleColor(rbS, rbS.length / 2, clipMask, cx, cy, cw, ch) || fallback);
      }
      const parts = [];
      let i = 0;
      while (i < segs.length) {
        let j = i;
        while (j + 1 < segs.length && cols[j + 1] && cols[i] &&
               Math.abs(cols[j + 1][0] - cols[i][0]) + Math.abs(cols[j + 1][1] - cols[i][1]) +
               Math.abs(cols[j + 1][2] - cols[i][2]) < (joinCdOverride || opts.segJoinCd)) j++;
        const pts = [];
        for (let k = i; k <= j; k++) {
          const P = segs[k].pts;
          for (let m = 0; m < P.length; m++) pts.push(P[m]);
        }
        const arr = Float64Array.from(pts);
        const np = arr.length / 2;
        if (np >= 2) {
          const rib = ribbon(arr, np, halfW);
          const col = cols[i] || fallback;
          const pn = pen < 0 ? (luma(col) < opts.inkLuma ? 1 : 0) : pen;   // -1：按色深自动
          parts.push({ rib, path: arr, col, pen: pn, cIdx, rIdx, ph });
        }
        i = j + 1;
      }
      return parts;
    }
    // 变宽版 localParts：半宽按"路径上这一点的厚度"来（细长层用：笔要跟着形状的宽窄走）
    function localPartsProf(path, n, halfAt, sampleM, cIdx, rIdx, fallback, ph, pen, sampleHalfAt) {
      const segs = pathSegments(path, n, Math.max(opts.segMin * strokeScale, 26));
      const ribs = [], cols = [];
      for (const sg of segs) {
        if (sg.n < 2) { ribs.push(null); cols.push(null); continue; }
        const halfs = new Float64Array(sg.n);
        for (let i = 0; i < sg.n; i++) halfs[i] = halfAt(sg.pts[i * 2], sg.pts[i * 2 + 1]);
        const rb = ribbonProf(sg.pts, sg.n, halfs);
        ribs.push(rb);
        // 取色可以另用一套"窄笔形"：笔形为了盖满形状被就地加宽之后，
        // 取色还按加宽后的范围算，就会把旁边的深色描边也平均进去（实测会画出灰条）
        let sPoly = ribbon(sg.pts, sg.n, halfs[0], true);
        if (sampleHalfAt) {
          const sh = new Float64Array(sg.n);
          for (let i = 0; i < sg.n; i++) sh[i] = sampleHalfAt(sg.pts[i * 2], sg.pts[i * 2 + 1]);
          // 取色笔形必须**平头**（noCap）：带圆头会把两端邻色平均进来，
          // 长笔在拐弯处采样到隔壁颜色就整段刷错色（与 ribbon(...) 的 noCap 同一口径）
          sPoly = ribbonProf(sg.pts, sg.n, sh, PROF_FLAT_SAMPLE);
        }
        cols.push(sampleColor(sPoly, sPoly.length / 2, sampleM.m, sampleM.x, sampleM.y, sampleM.w, sampleM.h) || fallback);
      }
      const parts = [];
      let i = 0;
      while (i < segs.length) {
        let j = i;
        while (j + 1 < segs.length && cols[j + 1] && cols[i] &&
               Math.abs(cols[j + 1][0] - cols[i][0]) + Math.abs(cols[j + 1][1] - cols[i][1]) +
               Math.abs(cols[j + 1][2] - cols[i][2]) < opts.segJoinCd) j++;
        const pts = [];
        for (let k = i; k <= j; k++) {
          const P = segs[k].pts;
          for (let m = 0; m < P.length; m++) pts.push(P[m]);
        }
        const arr = Float64Array.from(pts);
        if (arr.length >= 4) {
          const rib = (j > i) ? mergeLoops(ribs.slice(i, j + 1)) : ribs[i];
          parts.push({ rib, path: arr, col: cols[i] || fallback, pen: 1, cIdx, rIdx, ph });
        }
        i = j + 1;
      }
      return parts;
    }

    function emitLocal(path, n, halfW, clipMask, cx, cy, cw, ch, pen, cIdx, rIdx, fallback, ph, onRec) {
      for (const p of localParts(path, n, halfW, clipMask, cx, cy, cw, ch, pen, cIdx, rIdx, fallback, ph)) {
        const rec = emitStroke(p.rib, p.rib.length / 2, p.path, p.path.length / 2, halfW, p.col, p.pen, p.cIdx, p.rIdx, p.ph);
        if (onRec) onRec(rec);
      }
    }

    // ---- 7.5) 起稿：沿"主要轮廓"轻轻勾一遍（细、快、轻；后面铺色会盖住它，像真起稿） ----
    prog(0.42, '起稿勾形…'); await yieldUI();
    if (opts.sketch) {
      let maxCid = 0;
      for (const rg of regions) if (rg.cid > maxCid) maxCid = rg.cid;
      const areaOf = new Int32Array(maxCid + 1);
      for (const rg of regions) areaOf[rg.cid] = rg.area;
      const minSide = Math.max(200, Math.round(240 * scale * scale));   // 只勾大体轮廓，不勾碎屑
      const edge = new Uint8Array(N);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const p = y * W + x;
          const c0 = compOf[p], a0 = areaOf[c0] || 0;
          let on = 0;
          if (x + 1 < W) {
            const c1 = compOf[p + 1];
            if (c1 !== c0 && (a0 >= minSide || (areaOf[c1] || 0) >= minSide)) on = 1;
          }
          if (!on && y + 1 < H) {
            const c2 = compOf[p + W];
            if (c2 !== c0 && (a0 >= minSide || (areaOf[c2] || 0) >= minSide)) on = 1;
          }
          if (on) edge[p] = 1;
        }
      }
      const ecc = compsOfLabels(edge, W, H);
      const cand = [];
      for (let ci = 0; ci < ecc.comps.length; ci++) {
        if (ecc.comps[ci].label === 1 && ecc.comps[ci].count >= 12) cand.push(ci);
      }
      cand.sort((a, b) => ecc.comps[b].count - ecc.comps[a].count);
      const items = cand.slice(0, opts.sketchMax).map((ci) => ({
        ci, cx: (ecc.comps[ci].x0 + ecc.comps[ci].x1) / 2, cy: (ecc.comps[ci].y0 + ecc.comps[ci].y1) / 2,
      }));
      const seq = chainNN(items, (it) => [it.cx, it.cy], 0, 0);
      const halfS = Math.max(1.1, opts.sketchHalf * strokeScale);
      const clipPad = Math.max(1, Math.round(1.2 * strokeScale));
      const mix = opts.sketchMix;
      // 起稿色：局部目标色往铅笔灰里压一点——有"铅笔线"的味道，又不会留下大片深色残迹
      const pencil = (x, y) => {
        const xi = clamp(Math.round(x), 0, W - 1), yi = clamp(Math.round(y), 0, H - 1);
        const p0 = yi * W + xi;
        return [Math.round(R[p0] * (1 - mix) + 74 * mix),
                Math.round(G[p0] * (1 - mix) + 72 * mix),
                Math.round(B[p0] * (1 - mix) + 76 * mix)];
      };
      const grid = Math.max(0, Math.round(opts.sketchGrid * strokeScale));
      const over = Math.max(0, opts.sketchOver * strokeScale);
      for (const it of seq) {
        const bw = bboxOfComp(ecc, it.ci, clipPad + grid);
        const { sk } = thin(bw.m, bw.w, bw.h);
        const lp = longestPath(sk, bw.w, bw.h);
        if (!lp || lp.len < 4) continue;
        const absPath = new Float64Array(lp.len * 2);
        for (let i = 0; i < lp.len; i++) {
          absPath[i * 2] = lp.pts[i * 2] + bw.x;
          absPath[i * 2 + 1] = lp.pts[i * 2 + 1] + bw.y;
        }
        const mi = lp.len >> 1;
        const col = pencil(absPath[mi * 2], absPath[mi * 2 + 1]);
        // 真起稿画不准、也不收锋：路径按网格"随手"简化，两端再画过头一点
        let pth = absPath, pn = lp.len;
        if (grid > 1 && lp.len >= 6) {
          const simp = [];
          const push = (x, y) => {
            if (simp.length >= 2) {
              const lx = simp[simp.length - 2], ly = simp[simp.length - 1];
              if (Math.max(Math.abs(x - lx), Math.abs(y - ly)) < grid) return;
            }
            simp.push(x, y);
          };
          const d0x = absPath[0] - absPath[2], d0y = absPath[1] - absPath[3];
          const l0 = Math.hypot(d0x, d0y) || 1;
          push(absPath[0] + d0x / l0 * over, absPath[1] + d0y / l0 * over);
          for (let i = 0; i < lp.len; i++) push(absPath[i * 2], absPath[i * 2 + 1]);
          const e2 = (lp.len - 1) * 2;
          const d1x = absPath[e2] - absPath[e2 - 2], d1y = absPath[e2 + 1] - absPath[e2 - 1];
          const l1 = Math.hypot(d1x, d1y) || 1;
          push(absPath[e2] + d1x / l1 * over, absPath[e2 + 1] + d1y / l1 * over);
          if (simp.length >= 4) { pth = Float64Array.from(simp); pn = simp.length >> 1; }
        }
        // 粗线会偏出原始轮廓，掩膜相应放宽，免得被切成虚线
        const cIdx = pushClip(bw.x, bw.y, bw.w, bw.h, dilate(bw.m, bw.w, bw.h, clipPad + grid));
        const rib = ribbon(pth, pn, halfS);
        emitStroke(rib, rib.length / 2, pth, pn, halfS, col, 1, cIdx, -1, 0);
      }
    }
    mark('起稿');

    // ---- 8a) 细线层（轮廓线 + 文字）：分两拨画 ----
    // 属于某个对象的细线（猫嘴、胡须、字的描边）在该对象铺完色后立刻画；
    // 落在背景/纸底上的（题字、落款）留到最后，按行写。
    // 组划分（连通域、行序、归属）在铺色前统一做，这里只负责"画给定的组"。
    const inkClips = [];
    let inkIcc = null;                  // 细线连通域（两拨共用）
    let inkLastSeq = [];                // 留到最后的细线组（按行序）
    const inkOfObj = new Map();         // 对象序号 → [细线组 ci, ...]（按行序）
    const drawInkSeq = (seq, rasterFn, ph = 2) => {
      if (!inkIcc) return;
      const icc = inkIcc;
      for (const ci of seq) {
        const bw = bboxOfComp(icc, ci, 0);              // 严格掩膜（取色用）
        const clipM = opts.dilInk > 0 ? dilate(bw.m, bw.w, bw.h, opts.dilInk) : bw.m;
        const full = new Uint8Array(W * H);
        for (let k = 0; k < icc.comps[ci].count; k++) full[icc.pix[icc.comps[ci].start + k]] = 1;
        const cIdx = pushClip(bw.x, bw.y, bw.w, bw.h, clipM);
        let inkFallback = [46, 46, 52];
        {
          let sr0 = 0, sg0 = 0, sb0 = 0, n0 = 0;
          for (let k = 0; k < icc.comps[ci].count; k++) {
            const pp0 = icc.pix[icc.comps[ci].start + k];
            sr0 += R[pp0]; sg0 += G[pp0]; sb0 += B[pp0]; n0++;
          }
          if (n0) inkFallback = [Math.round(sr0 / n0), Math.round(sg0 / n0), Math.round(sb0 / n0)];
        }
        const bin = new Uint8Array(bw.w * bw.h);
        for (let y = 0; y < bw.h; y++) {
          for (let x = 0; x < bw.w; x++) bin[y * bw.w + x] = full[(y + bw.y) * W + (x + bw.x)];
        }
        const dt = distanceTransform(bin, bw.w, bw.h);
        let dmax = 0;
        for (let i = 0; i < dt.length; i++) if (dt[i] > dmax) dmax = dt[i];
        const half = clamp(dmax + 1.4 * strokeScale, 2.0, 12 * strokeScale);
        // 分支队列：每画一条最长骨架路径，就把剩下没盖住的连通块继续排队，
        // 直到整层线稿都被笔画覆盖（复杂线稿会有很多分支）。
        // 剩下的块只要还有点面积就继续排——门槛太高会留下没人画的白点。
        const queue = [bin.slice()];
        let guard = 0;
        while (queue.length && guard++ < 200) {
          const m0 = queue.shift();
          globalThis.__thinTag = 'ink';
          const { sk } = thin(m0, bw.w, bw.h);
          const lp = longestPath(sk, bw.w, bw.h);
          if (lp && lp.len >= 2) {
            const raw = new Float64Array(lp.len * 2);
            for (let i = 0; i < lp.len; i++) {
              raw[i * 2] = lp.pts[i * 2] + bw.x;
              raw[i * 2 + 1] = lp.pts[i * 2 + 1] + bw.y;
            }
            // 中轴拉直：直线的骨架是"一像素一像素拐"出来的，照描就是坑坑洼洼（用户点名的毛病）
            const sp = rdpSimplify(raw, lp.len, opts.lineTol);
            const absPath = sp.pts, nPath = sp.n;
          if (opts.localColor) {
            emitLocal(absPath, nPath, half, bw.m, bw.x, bw.y, bw.w, bw.h, -1, cIdx, -1, inkFallback, ph, rasterFn);
          } else {
            const rib = ribbon(absPath, nPath, half);
            const rec = emitStroke(rib, rib.length / 2, absPath, nPath, half, inkFallback, 1, cIdx, -1, ph);
            if (rasterFn) rasterFn(rec);
          }
            const cover = new Uint8Array(bw.w * bw.h);
            fillPoly(cover, bw.w, bw.h, (() => {
              const r = ribbon(absPath, nPath, half);
              const out = new Float64Array(r.length);
              for (let i = 0; i < r.length; i += 2) { out[i] = r[i] - bw.x; out[i + 1] = r[i + 1] - bw.y; }
              return out;
            })());
            for (let i = 0; i < m0.length; i++) if (m0[i] && cover[i]) m0[i] = 0;
          }
          // 剩下的连通块继续排队
          const rc = compsOfLabels(m0, bw.w, bw.h);
          for (let j = 0; j < rc.comps.length; j++) {
            if (rc.comps[j].label !== 1 || rc.comps[j].count < Math.max(6, half * half)) continue;
            const nm = new Uint8Array(bw.w * bw.h);
            for (let k = 0; k < rc.comps[j].count; k++) nm[rc.pix[rc.comps[j].start + k]] = 1;
            queue.push(nm);
          }
        }
        inkClips.push(cIdx);
      }
    };
    lap('ink');
    prog(0.52, '铺色块…'); await yieldUI();

    // ---- 8b) 非线稿区块：毛笔刷（沿主轴一档档来回涂） ----
    const regionOrder = [];
    let sweepRegions = 0, passTotal = 0, passMax = 0;   // 埋点：铺色区块数 / 总档数 / 单块最多档数
    const objOfComp = new Int32Array(regions.length);   // 区块 → 对象序号（残差/补漏也按这个顺序走）
    // ================= 图层栈：一个对象 = 一层 =================
    // 老版本是"一个层核一个区块" ⇒ 蓝底被色带切成几十条各画各的（用户截图里的竖条带）、
    // 黑框四条边也各画各的、每层还都只画自己"看得见"的那块。这里改成：
    //   ① 相邻 + 颜色相近的层核并成同一个对象（一整片蓝底是一层、一整圈黑框是一层）；
    //   ② 每层算出"完整形状"——被上层盖住的部分也要画（形状闭合推断，只补"上层"不补"下层"）；
    //   ③ 一层画完当场自检这一层有没有漏，漏了立刻补，不拖到最后。
    let baseObj = -1;                 // 底色层（最下面那层非纸底）
    let curLayer = -1;                // 当前正在画的层号（记进每一笔的 ly，收尾判"该不该删"用）
    let objLab = null;                // 像素 → 对象序号
    const objRegions = [];            // 每层包含哪些区块
    const objBox = [];                // 每层：可见部分的 bbox + 掩膜
    const objFull = [];               // 每层：完整形状（含被上层盖住的部分）
    const objStat = [];               // 每层：面积/主轴/半宽/厚度/颜色/是否细长/是否纸底
    const objAdj = [];                // 每层的邻接表（贴着哪些层）
    let nObj = 0;
    let bgMap = null;                 // 底色层的"背景色场"：被上层盖住的地方按周围推出来
    {
      const imp = (rg) => Math.hypot(rg.color[0] - 255, rg.color[1] - 255, rg.color[2] - 255);
      const isBg = (rg) => luma(rg.color) > 240 && imp(rg) < 24;
      const list = [];
      for (let ri = 0; ri < regions.length; ri++) if (!isInk[ri]) list.push(ri);
      // --- 并查集：**挨着 + 颜色相近** 两个条件同时满足才并成一层 ---
      // 只按"挨着"会把字并进蓝底（整幅变一层）；只按"颜色近"会把画面两头同色的东西并成一层
      // （笔尖满屏飞）。两个一起用，分出来的才是"一个东西"：一整片蓝底、一整圈黑框、一个字母。
      const uf = new Int32Array(regions.length);
      for (let i = 0; i < regions.length; i++) uf[i] = i;
      const find = (a) => { while (uf[a] !== a) { uf[a] = uf[uf[a]]; a = uf[a]; } return a; };
      const bgReg = new Uint8Array(regions.length);
      for (let ri = 0; ri < regions.length; ri++) if (isBg(regions[ri])) bgReg[ri] = 1;
      const cdist = (a, b) => Math.abs(regions[a].color[0] - regions[b].color[0]) +
                             Math.abs(regions[a].color[1] - regions[b].color[1]) +
                             Math.abs(regions[a].color[2] - regions[b].color[2]);
      {
        const cdMax = opts.objMergeCd;
        for (let y = 0; y < H; y++) {
          const row = y * W;
          for (let x = 0; x < W; x++) {
            const p = row + x, c0 = compOf[p];
            if (isInk[c0]) continue;
            const k0 = bgReg[c0];
            if (x + 1 < W) {
              const c1 = compOf[p + 1];
              if (c1 !== c0 && !isInk[c1] && bgReg[c1] === k0 && cdist(c0, c1) <= cdMax) {
                const ra = find(c0), rb = find(c1);
                if (ra !== rb) uf[ra] = rb;
              }
            }
            if (y + 1 < H) {
              const c1 = compOf[p + W];
              if (c1 !== c0 && !isInk[c1] && bgReg[c1] === k0 && cdist(c0, c1) <= cdMax) {
                const ra = find(c0), rb = find(c1);
                if (ra !== rb) uf[ra] = rb;
              }
            }
          }
        }
      }
      // --- 分组 → 层 ---
      const gmap = new Map();
      for (const ri of list) {
        const r = find(ri);
        let g = gmap.get(r);
        if (!g) { g = { regs: [], area: 0, isPaper: bgReg[ri] === 1 }; gmap.set(r, g); }
        g.regs.push(ri);
        g.area += regions[ri].area;
        if (!bgReg[ri]) g.isPaper = false;
      }
      let groups = Array.from(gmap.values());
      // 太小的组（零星几像素的碎屑）并进"挨着它、颜色最近"的那个组，不单独成层
      {
        const MINLAY = 300;
        const bigs = groups.filter((g) => g.isPaper || g.area >= MINLAY);
        const smalls = groups.filter((g) => !g.isPaper && g.area < MINLAY);
        if (smalls.length) {
          const gIdxOf = new Int32Array(regions.length).fill(-1);
          for (let gi = 0; gi < groups.length; gi++) for (const ri of groups[gi].regs) gIdxOf[ri] = gi;
          const glab = new Int32Array(N);
          for (let p = 0; p < N; p++) glab[p] = gIdxOf[compOf[p]];
          const pairs = new Set();
          for (let y = 0; y < H; y++) {
            const row = y * W;
            for (let x = 0; x < W; x++) {
              const p = row + x, a = glab[p];
              if (a < 0) continue;
              if (x + 1 < W) { const b = glab[p + 1]; if (b >= 0 && b !== a) { const lo = Math.min(a, b), hi = Math.max(a, b); pairs.add(lo * 4096 + hi); } }
              if (y + 1 < H) { const b = glab[p + W]; if (b >= 0 && b !== a) { const lo = Math.min(a, b), hi = Math.max(a, b); pairs.add(lo * 4096 + hi); } }
            }
          }
          const nbOf = new Map();
          for (const k of pairs) {
            const a = Math.floor(k / 4096), b = k % 4096;
            if (!nbOf.has(a)) nbOf.set(a, []); if (!nbOf.has(b)) nbOf.set(b, []);
            nbOf.get(a).push(b); nbOf.get(b).push(a);
          }
          const gcol = groups.map((g) => {
            let cr = 0, cg = 0, cb = 0;
            for (const ri of g.regs) { cr += regions[ri].color[0] * regions[ri].area; cg += regions[ri].color[1] * regions[ri].area; cb += regions[ri].color[2] * regions[ri].area; }
            const n = Math.max(1, g.area);
            return [cr / n, cg / n, cb / n];
          });
          const bigSet = new Set(bigs);
          for (const g of smalls) {
            const gi = groups.indexOf(g);
            let best = -1, bd = Infinity;
            for (const gj of (nbOf.get(gi) || [])) {
              const cand = groups[gj];
              if (!bigSet.has(cand)) continue;
              const d = Math.abs(gcol[gi][0] - gcol[gj][0]) + Math.abs(gcol[gi][1] - gcol[gj][1]) + Math.abs(gcol[gi][2] - gcol[gj][2]);
              if (d < bd) { bd = d; best = gj; }
            }
            // 只有"颜色也对得上"才并（否则一片橙色的碎块会被并进蓝底，底色色场就被染花了）；
            // 对不上的碎块自己留一层——小是小，但颜色是对的
            if (best >= 0 && bd <= 90) { groups[best].regs.push(...g.regs); groups[best].area += g.area; }
            else bigs.push(g);
          }
          groups = bigs;
        }
      }
      groups.sort((a, b) => (a.isPaper === b.isPaper ? b.area - a.area : (a.isPaper ? -1 : 1)));
      nObj = groups.length;
      for (let oi = 0; oi < nObj; oi++) objRegions.push(groups[oi].regs);
      for (let oi = 0; oi < nObj; oi++) for (const ri of objRegions[oi]) objOfComp[ri] = oi;
      dbg.groups = groups.length;
      dbg.loose = 0;
      dbg.cores = groups.length;
      dbg.objs = nObj;
      lap('sweep:uf');
      // --- 像素索引图 + 逐层统计 ---
      objLab = new Int32Array(N);
      for (let p = 0; p < N; p++) objLab[p] = objOfComp[compOf[p]];
      const oA = new Float64Array(nObj), oSx = new Float64Array(nObj), oSy = new Float64Array(nObj);
      for (let p = 0; p < N; p++) { const oi = objLab[p], x = p % W; oA[oi]++; oSx[oi] += x; oSy[oi] += (p - x) / W; }
      const oXx = new Float64Array(nObj), oXy = new Float64Array(nObj), oYy = new Float64Array(nObj);
      const oCx = new Float64Array(nObj), oCy = new Float64Array(nObj);
      for (let oi = 0; oi < nObj; oi++) { oCx[oi] = oA[oi] ? oSx[oi] / oA[oi] : 0; oCy[oi] = oA[oi] ? oSy[oi] / oA[oi] : 0; }
      for (let p = 0; p < N; p++) {
        const oi = objLab[p], x = p % W, y = (p - x) / W;
        const dx = x - oCx[oi], dy = y - oCy[oi];
        oXx[oi] += dx * dx; oXy[oi] += dx * dy; oYy[oi] += dy * dy;
      }
      for (let oi = 0; oi < nObj; oi++) objAdj.push(new Set());
      for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
          const p = row + x, a = objLab[p];
          if (x + 1 < W) { const b = objLab[p + 1]; if (b !== a) { objAdj[a].add(b); objAdj[b].add(a); } }
          if (y + 1 < H) { const b = objLab[p + W]; if (b !== a) { objAdj[a].add(b); objAdj[b].add(a); } }
        }
      }
      for (let oi = 0; oi < nObj; oi++) {
        const rl = objRegions[oi];
        let x0 = W, y0 = H, x1 = -1, y1 = -1, cr = 0, cg = 0, cb = 0, isPaper = true;
        for (const ri of rl) {
          const rg = regions[ri];
          if (rg.x0 < x0) x0 = rg.x0; if (rg.y0 < y0) y0 = rg.y0;
          if (rg.x1 > x1) x1 = rg.x1; if (rg.y1 > y1) y1 = rg.y1;
          cr += rg.color[0] * rg.area; cg += rg.color[1] * rg.area; cb += rg.color[2] * rg.area;
          if (!isBg(rg)) isPaper = false;
        }
        if (x1 < 0) { x0 = y0 = 0; x1 = y1 = 0; }
        const n = Math.max(1, oA[oi]);
        const sxx = oXx[oi] / n, sxy = oXy[oi] / n, syy = oYy[oi] / n;
        const tr = sxx + syy, det = sxx * syy - sxy * sxy;
        const l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det));
        const l2 = tr / 2 - Math.sqrt(Math.max(0, tr * tr / 4 - det));
        const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
        let ax = Math.cos(ang), ay = Math.sin(ang);
        // 主轴要落在"更长"的那一侧（否则一档档刷的方向是横着的，档数暴涨）
        if (l1 < l2) { const t = ax; ax = -ay; ay = t; }
        objStat.push({
          oi, area: oA[oi], x0, y0, x1, y1, cx: oCx[oi], cy: oCy[oi], ax, ay,
          l1: Math.sqrt(Math.max(0, l1)), l2: Math.sqrt(Math.max(0, l2)),
          tmin: Infinity, tmax: -Infinity, vmax: 0, hp: 1,
          color: [Math.round(cr / n), Math.round(cg / n), Math.round(cb / n)],
          isPaper, linear: false, from: 0,
        });
      }
      for (let p = 0; p < N; p++) {
        const oi = objLab[p], st = objStat[oi];
        const x = p % W, y = (p - x) / W;
        const t = (x - st.cx) * st.ax + (y - st.cy) * st.ay;
        const v = Math.abs(-(x - st.cx) * st.ay + (y - st.cy) * st.ax);
        if (t < st.tmin) st.tmin = t;
        if (t > st.tmax) st.tmax = t;
        if (v > st.vmax) st.vmax = v;
      }
      for (const st of objStat) {
        if (st.tmin > st.tmax) { st.tmin = st.tmax = 0; }
        st.hp = Math.max(1, st.vmax);
      }
      lap('sweep:stat');
      // 底色层：第一个非纸底的层
      baseObj = -1;
      for (let oi = 0; oi < nObj; oi++) if (!objStat[oi].isPaper && objStat[oi].area >= 200) { baseObj = oi; break; }
      if (baseObj < 0) baseObj = 0;
      dbg.base = baseObj;
      // --- 边界按颜色重判（抗锯齿过渡带）---
      // 目标图的边缘有一圈 1~2px 的混色像素；量化+合并把它们随机分给两侧的对象，
      // 于是"本来是直的边"看起来像被啃过（用户 2026-10-18 反馈的飞机边缘）。
      // 规则：贴着异类的像素，归给"颜色离它更近的那个邻居"——边界就被钉在 50% 混色处，
      // 直边变直、圆边变顺（平涂画法本来也不画毛边，只画两侧的纯色）。
      // 边界带（离异类 ≤2px）的像素清单：下面三个"边界重判"块都只扫这些像素——
      // 整幅扫描一个像素一个像素地查 Map，光这一项就要 7 秒
      const bandList = (() => {
        const band = new Uint8Array(N);
        for (let y = 0; y < H; y++) {
          const row = y * W;
          for (let x = 0; x < W; x++) {
            const p = row + x, a = objLab[p];
            if ((x + 1 < W && objLab[p + 1] !== a) || (y + 1 < H && objLab[p + W] !== a) ||
                (x > 0 && objLab[p - 1] !== a) || (y > 0 && objLab[p - W] !== a)) band[p] = 1;
          }
        }
        const bd = dilate(band, W, H, 2);
        const list = [];
        for (let p = 0; p < N; p++) if (bd[p]) list.push(p);
        return Int32Array.from(list);
      })();
      if (opts.edgeSnap) {
        let maxCid = 0;
        for (let p = 0; p < N; p++) if (compOf[p] > maxCid) maxCid = compOf[p];
        const cR = new Int32Array(maxCid + 1).fill(-1), cG = new Int32Array(maxCid + 1), cB = new Int32Array(maxCid + 1);
        for (const rg of regions) { cR[rg.cid] = rg.color[0]; cG[rg.cid] = rg.color[1]; cB[rg.cid] = rg.color[2]; }
        const colOfC = { get: (cid) => (cid >= 0 && cR[cid] >= 0 ? [cR[cid], cG[cid], cB[cid]] : null) };
        const DX4 = [1, -1, 0, 0], DY4 = [0, 0, 1, -1];
        let snapped = 0;
        // 过渡带可能有 2~3px 宽（扫描件的边缘不锐）：一轮只剥一层，所以走几轮
        for (let it = 0; it < (opts.edgeSnapIter | 0); it++) {
          const chP = [], chO = [];
          for (let bi = 0; bi < bandList.length; bi++) {
            {
              const p = bandList[bi], x = p % W, y = (p - x) / W, a = objLab[p];
              if (objStat[a].isPaper) continue;
              const ca = colOfC.get(compOf[p]);
              if (!ca) continue;
              const da = Math.abs(R[p] - ca[0]) + Math.abs(G[p] - ca[1]) + Math.abs(B[p] - ca[2]);
              // 自己的区色已经贴近原图 ⇒ 这多半是抗锯齿过渡带的混色（本来就该是混色），
              // 硬推成邻居的纯色只会把边推错 1px。只有"区色明显不像原图"才是真错分。
              if (da < opts.edgeSnapBad) continue;
              const cap = opts.edgeSnapRatio > 0 ? da * opts.edgeSnapRatio : Infinity;
              let best = -1, bd = Math.min(da - opts.edgeSnapTol, cap);
              for (let d = 0; d < 4; d++) {
                const xx = x + DX4[d], yy = y + DY4[d];
                if (xx < 0 || xx >= W || yy < 0 || yy >= H) continue;
                const q = yy * W + xx, b = objLab[q];
                if (b === a || objStat[b].isPaper) continue;
                const cb = colOfC.get(compOf[q]);
                if (!cb) continue;
                const d2 = Math.abs(R[p] - cb[0]) + Math.abs(G[p] - cb[1]) + Math.abs(B[p] - cb[2]);
                if (d2 < bd) { bd = d2; best = b; }
              }
              if (best >= 0) { chP.push(p); chO.push(best); }
            }
          }
          if (!chP.length) break;
          for (let i = 0; i < chP.length; i++) objLab[chP[i]] = chO[i];
          snapped += chP.length;
        }
        dbg.edgeSnap = snapped;
      }
      lap('sweep:rejudge');
      // --- 过渡带（抗锯齿斜坡）不能单独成层 ---
      // 目标图的边上有 1~3px 的混色带；量化会把它切成"一条细长的区块"，
      // 于是它自己成了一层、被涂成中间那个灰紫色（飞机边上的灰条就是这么来的）。
      // 判据：在两个不同方向各找一个"别的层"，自己的颜色正好是那两层纯色的混色 ⇒
      // 按"离哪边近"并进去（平涂画法里这条边就是两层颜色的硬交界）。
      if (opts.edgeRamp) {
        const colOfC = new Map();
        for (const rg of regions) colOfC.set(rg.cid, rg.color);
        const DX4 = [1, -1, 0, 0], DY4 = [0, 0, 1, -1];
        const R4 = opts.edgeRampR | 0;
        let rampN = 0;
        for (let it = 0; it < 3; it++) {
          const chP = [], chO = [];
          for (let bi = 0; bi < bandList.length; bi++) {
            {
              const p = bandList[bi], x = p % W, y = (p - x) / W, a = objLab[p];
              if (objStat[a].isPaper) continue;
              const sides = [];     // 四个方向各自最近的"别的层"
              for (let d = 0; d < 4; d++) {
                for (let s = 1; s <= R4; s++) {
                  const xx = x + DX4[d] * s, yy = y + DY4[d] * s;
                  if (xx < 0 || xx >= W || yy < 0 || yy >= H) break;
                  const q = yy * W + xx, b = objLab[q];
                  if (b === a) continue;
                  if (objStat[b].isPaper) break;
                  const cb = colOfC.get(compOf[q]);
                  if (!cb) break;
                  sides.push({ b, cb, d2: Math.abs(R[p] - cb[0]) + Math.abs(G[p] - cb[1]) + Math.abs(B[p] - cb[2]) });
                  break;
                }
              }
              if (sides.length < 2) continue;
              // 挑"两个不同层"里离得最近的一对
              let s1 = -1, s2 = -1, sBest = Infinity;
              for (let i = 0; i < sides.length; i++) {
                for (let j = i + 1; j < sides.length; j++) {
                  if (sides[i].b === sides[j].b) continue;
                  const sum = sides[i].d2 + sides[j].d2;
                  if (sum < sBest) { sBest = sum; s1 = i; s2 = j; }
                }
              }
              if (s1 < 0) continue;
              const A = sides[s1].cb, Bv = sides[s2].cb;
              const vx = Bv[0] - A[0], vy = Bv[1] - A[1], vz = Bv[2] - A[2];
              const vv = vx * vx + vy * vy + vz * vz;
              if (vv < 400) continue;                     // 两层颜色太近：无所谓
              const px2 = R[p] - A[0], py2 = G[p] - A[1], pz2 = B[p] - A[2];
              const t = (px2 * vx + py2 * vy + pz2 * vz) / vv;
              if (t <= 0.15 || t >= 0.85) continue;       // 更靠某一侧 ⇒ 不是混色带
              const dx2 = px2 - t * vx, dy2 = py2 - t * vy, dz2 = pz2 - t * vz;
              if (Math.abs(dx2) + Math.abs(dy2) + Math.abs(dz2) > opts.rampTol) continue;
              chP.push(p);
              chO.push(sides[s1].d2 <= sides[s2].d2 ? sides[s1].b : sides[s2].b);
            }
          }
          if (!chP.length) break;
          for (let i = 0; i < chP.length; i++) objLab[chP[i]] = chO[i];
          rampN += chP.length;
        }
        dbg.edgeRamp = rampN;
      }
      // 扫描件的网点 + 抗锯齿会把直边搅成 2px 上下的锯齿（用户说的"本来是直的却像被啃过"）。
      lap('sweep:ramp');
      // --- 掩膜边界"去锯齿"（多数表决）---
      // 扫描件的网点 + 抗锯齿会把直边搅成 2px 上下的锯齿（用户说的"本来是直的却像被啃过"）。
      // 在 5x5 窗口里数各层占了多少格，只有"压倒性多数"（≥ maskMajThr）才改判：
      // 3px 宽的细杆/笔画在 5x5 里最多占 15 格，达不到压倒多数 ⇒ 不会被吃掉。
      if (opts.maskMajority) {
        const R2 = (opts.maskMajority | 0) >> 1;
        const cnts = new Int32Array(nObj), touched = [];
        for (let it = 0; it < 2; it++) {
          const chP = [], chO = [];
          for (let bi = 0; bi < bandList.length; bi++) {
            {
              const p = bandList[bi], x = p % W, y = (p - x) / W, a = objLab[p];
              if (objStat[a].isPaper) continue;
              touched.length = 0;
              const y0 = Math.max(0, y - R2), y1 = Math.min(H - 1, y + R2);
              const x0 = Math.max(0, x - R2), x1 = Math.min(W - 1, x + R2);
              for (let yy = y0; yy <= y1; yy++) {
                const row = yy * W;
                for (let xx = x0; xx <= x1; xx++) {
                  const b = objLab[row + xx];
                  if (cnts[b]++ === 0) touched.push(b);
                }
              }
              let best = -1, bc = 0;
              for (const b of touched) {
                if (b === a || objStat[b].isPaper) continue;
                if (cnts[b] > bc) { bc = cnts[b]; best = b; }
              }
              const ca2 = cnts[a];
              for (const b of touched) cnts[b] = 0;
              if (best >= 0 && bc >= opts.maskMajThr && bc > ca2) { chP.push(p); chO.push(best); }
            }
          }
          if (!chP.length) break;
          for (let i = 0; i < chP.length; i++) objLab[chP[i]] = chO[i];
          dbg.maskMaj = (dbg.maskMaj || 0) + chP.length;
        }
      }
      lap('sweep:maj');
      // --- 可见部分的掩膜 + 每层的"厚度/细长"判定 ---
      for (let oi = 0; oi < nObj; oi++) {
        const st = objStat[oi];
        const ownM = regionMaskOf(objLab, W, oi, st.x0, st.y0, st.x1, st.y1);
        const own = { x0: st.x0, y0: st.y0, w: ownM.w, h: ownM.h, m: ownM.m };
        objBox.push(own);
        if (st.isPaper || st.area < 160 || oi === baseObj) continue;
        const dt = distanceTransform(own.m, own.w, own.h);
        const vals = [];
        for (let i = 0; i < dt.length; i++) if (own.m[i]) vals.push(dt[i]);
        vals.sort((a, b) => a - b);
        const med = vals.length ? vals[vals.length >> 1] : 0;
        st.thick = med;
        // 细长（黑框、支柱、字的笔画）：这一层"能画几个自己的厚度那么长"。
        // 用中轴厚度而不是外框短边：黑框是个大圈（外框=整幅），但它处处只有十几像素厚。
        const elong = (st.tmax - st.tmin) / Math.max(1, 2 * med);
        st.elong = elong;
        // 两个条件都要满足：够长（能画 9 个自己的厚度）+ 真的薄（绝对厚度有上限，
        // 否则照片里一大片细长的区域也会被判成"线"，几千笔去描它）
        st.linear = elong >= 9 && med * 2 <= Math.max(12, 24 * strokeScale);
      }
      lap('sweep:vis');
      // 非照片图：细长层（字的笔画、描边、黑框）也加一条保护带。
      // 这些层主笔覆盖率通常已 ≥99.5%，残差再补只是追 5~20 的亚可见色差；
      // 只挡小误差，真实缺口（> inkGuardErr）仍然照补。
      var thinGuard = new Uint8Array(N);      // var：残差阶段在层栈代码块之外，还要用它
      if (!opts.photoMode && opts.inkGuard > 0) {
        for (let oi = 0; oi < nObj; oi++) {
          const st = objStat[oi];
          if (!st.linear || st.isPaper) continue;
          const own = objBox[oi];
          for (let y = 0; y < own.h; y++) {
            const src = y * own.w, dst = (y + own.y0) * W + own.x0;
            for (let x = 0; x < own.w; x++) if (own.m[src + x]) thinGuard[dst + x] = 1;
          }
        }
      }
      // --- 完整形状：底色层 = 整幅（除了纸底）；其它层 = 自己可见的部分 ∪ 被上层盖住的部分 ---
      // "被上层盖住的部分"用形状闭合推断：把本层形状按"贴着它的上层有多厚"闭一下，
      // 闭出来的区域里属于上层的像素就是"本来也是这一层、只是被盖住了"。
      // 判据只认"上层"，所以飞机两翼之间那片天（下层）不会被补进飞机里。
      const paperPix = new Uint8Array(N);
      for (let p = 0; p < N; p++) if (objStat[objLab[p]].isPaper) paperPix[p] = 1;
      for (let oi = 0; oi < nObj; oi++) {
        const st = objStat[oi];
        const own = objBox[oi];
        if (oi === baseObj) {
          const m = new Uint8Array(N);
          for (let p = 0; p < N; p++) if (!paperPix[p]) m[p] = 1;
          objFull.push({ x0: 0, y0: 0, w: W, h: H, m });
          continue;
        }
        if (st.isPaper || !opts.occlude) { objFull.push(own); continue; }  // own 现在带 x0/y0
        let r = 0;
        for (const ob of objAdj[oi]) if (ob > oi && !objStat[ob].isPaper) r = Math.max(r, objStat[ob].hp * 2);
        // 外扩量 = 贴着它的上层有多厚 × 系数（objGrowF）。补出来的"完整形状"只要盖到
        // 上层的一半就够，再往外就是上层自己的地盘 —— 系数偏大时，字/飞机那些凸出的
        // 部位会伸出一圈圆头小凸起（回放画到那一层时看得见）。
        r = clamp(Math.round(r * opts.objGrowF), 3, 26);
        if (r <= 3) { objFull.push(own); continue; }
        const bx0 = Math.max(0, st.x0 - r), by0 = Math.max(0, st.y0 - r);
        const bx1 = Math.min(W - 1, st.x1 + r), by1 = Math.min(H - 1, st.y1 + r);
        const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
        const sub = new Uint8Array(bw * bh), above = new Uint8Array(bw * bh);
        let any = false;
        for (let y = 0; y < bh; y++) {
          const row = (y + by0) * W;
          for (let x = 0; x < bw; x++) {
            const o = objLab[row + bx0 + x];
            if (o === oi) sub[y * bw + x] = 1;
            else if (o > oi && !objStat[o].isPaper) { above[y * bw + x] = 1; any = true; }
          }
        }
        if (!any) { objFull.push(own); continue; }
        const cl = closeMaskDisk(sub, bw, bh, r);
        const m = new Uint8Array(bw * bh);
        let added = 0;
        for (let i = 0; i < m.length; i++) {
          if (sub[i]) m[i] = 1;
          else if (cl[i] && above[i]) { m[i] = 1; added++; }
        }
        if (!added) { objFull.push(own); continue; }
        st.grown = added;
        objFull.push({ x0: bx0, y0: by0, w: bw, h: bh, m });
      }
      lap('sweep:full');
      // --- 底色层的"背景色场"：被字/飞机盖住的地方看不见，按周围推出来 ---
      // 已知像素 = 底色层自己（往里缩 2px 避开边界混色），颜色取平滑图；未知像素按"最近的
      // 已知像素"向里灌（chamfer 两趟），再平滑几遍 —— 整幅任何位置都能取到底色。
      if (baseObj >= 0 && objBox[baseObj]) {
        const bm = objBox[baseObj];
        const bin = new Uint8Array(N);
        for (let y = 0; y < bm.h; y++) {
          const row = (y + objStat[baseObj].y0) * W;
          for (let x = 0; x < bm.w; x++) if (bm.m[y * bm.w + x]) bin[row + objStat[baseObj].x0 + x] = 1;
        }
        const core = erode(bin, W, H, 3);
        lap('bg:core');
        const smoothish = (p2) => {   // 平滑图在这里可不可信（跟区块纯色对得上 = 没被隔壁糊过来）
          const rc2 = regions[compOf[p2]].color;
          return Math.abs(rc2[0] - Rs[p2]) + Math.abs(rc2[1] - Gs[p2]) + Math.abs(rc2[2] - Bs[p2]) <= 36;
        };
        const cr = new Float32Array(N), cg = new Float32Array(N), cb = new Float32Array(N);
        const known = new Uint8Array(N);
        let nKnown = 0;
        if (opts.photoMode) {
          // 照片：底色层就是"整幅的底色"——用平滑图（明暗关系保住），别用"最近的底色像素"往外灌
          // （灌出来的色场在远处的暗部会整片错，实测差 15 个点，而残差补笔又嫌那些块"又大又厚"不补）
          for (let p = 0; p < N; p++) {
            const rc = regions[compOf[p]].color;
            if (Math.abs(rc[0] - Rs[p]) + Math.abs(rc[1] - Gs[p]) + Math.abs(rc[2] - Bs[p]) <= 36) {
              cr[p] = Rs[p]; cg[p] = Gs[p]; cb[p] = Bs[p];
            } else { cr[p] = rc[0]; cg[p] = rc[1]; cb[p] = rc[2]; }
          }
          bgMap = { R: cr, G: cg, B: cb };
          dbg.bgFill = 0;
          if (opts.dumpMasks) {
            const bm2 = new Uint8Array(N * 3);
            for (let pp = 0; pp < N; pp++) { bm2[pp*3] = cr[pp]; bm2[pp*3+1] = cg[pp]; bm2[pp*3+2] = cb[pp]; }
            dbg.bgMapImg = bm2;
          }
        } else {
        for (let p = 0; p < N; p++) {
          if (!core[p] || inkPix[p] || texPix[p]) continue;   // 细线/纹理像素被吸收进底色，但不是底色的颜色
          // 颜色取"平滑图"，但只在这个像素的平滑色跟它所属区块的纯色对得上时——
          // 对不上说明平滑把隔壁（字/飞机）的颜色糊过来了，这时用区块自己的纯色（干净）
          const rc = regions[compOf[p]].color;
          if (Math.abs(rc[0] - Rs[p]) + Math.abs(rc[1] - Gs[p]) + Math.abs(rc[2] - Bs[p]) <= 36) {
            cr[p] = Rs[p]; cg[p] = Gs[p]; cb[p] = Bs[p];
          } else {
            cr[p] = rc[0]; cg[p] = rc[1]; cb[p] = rc[2];
          }
          known[p] = 1; nKnown++;
        }
        lap('bg:known');
        const INF = 1e9;
        const dist = new Float32Array(N);
        for (let p = 0; p < N; p++) dist[p] = known[p] ? 0 : INF;
        const prop = (p, q, w2) => {
          const d = dist[q] + w2;
          if (d < dist[p]) { dist[p] = d; cr[p] = cr[q]; cg[p] = cg[q]; cb[p] = cb[q]; }
        };
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const p = y * W + x;
            if (dist[p] === 0) continue;
            if (x > 0) prop(p, p - 1, 3);
            if (y > 0) prop(p, p - W, 3);
            if (x > 0 && y > 0) prop(p, p - W - 1, 4);
            if (x + 1 < W && y > 0) prop(p, p - W + 1, 4);
          }
        }
        for (let y = H - 1; y >= 0; y--) {
          for (let x = W - 1; x >= 0; x--) {
            const p = y * W + x;
            if (dist[p] === 0) continue;
            if (x + 1 < W) prop(p, p + 1, 3);
            if (y + 1 < H) prop(p, p + W, 3);
            if (x + 1 < W && y + 1 < H) prop(p, p + W + 1, 4);
            if (x > 0 && y + 1 < H) prop(p, p + W - 1, 4);
          }
        }
        lap('bg:chamfer');
        // 平滑 4 遍（3×3 盒式模糊）：灌出来的硬边、区块之间的色阶差都抹平。
        // 提速两处，都不改结果：
        // ① 内点（1..H-2 行 × 1..W-2 列）九邻域齐全 ⇒ 去掉全部边界判断和 yy*W 乘法，
        //    计数恒为 9；边界像素只有 O(W+H) 个，照旧走通用写法。
        // ② 双缓冲，省掉每遍 new 三个 4MB 数组 + cr.set(nr) 的两趟拷贝。
        // 为什么"展开"不改结果：输入是 float32（24 位尾数），9 个数相加最多 28 位
        // < float64 的 53 位 ⇒ 求和本来就是精确的、与加法顺序无关。
        let curR = cr, curG = cg, curB = cb;
        let nxtR = new Float32Array(N), nxtG = new Float32Array(N), nxtB = new Float32Array(N);
        const blurGeneric = (x, y) => {
          const p = y * W + x;
          let sr = 0, sg = 0, sb = 0, cnt = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy; if (yy < 0 || yy >= H) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx; if (xx < 0 || xx >= W) continue;
              const q = yy * W + xx;
              sr += curR[q]; sg += curG[q]; sb += curB[q]; cnt++;
            }
          }
          nxtR[p] = sr / cnt; nxtG[p] = sg / cnt; nxtB[p] = sb / cnt;
        };
        for (let it = 0; it < 4; it++) {
          if (W >= 3 && H >= 3) {
            for (let y = 1; y < H - 1; y++) {
              const yc = y * W;
              for (let x = 1; x < W - 1; x++) {
                const p = yc + x;
                let sr = 0, sg = 0, sb = 0;
                for (let dy = -1; dy <= 1; dy++) {
                  const row = yc + dy * W;
                  for (let dx = -1; dx <= 1; dx++) {
                    const q = row + x + dx;
                    sr += curR[q]; sg += curG[q]; sb += curB[q];
                  }
                }
                nxtR[p] = sr / 9; nxtG[p] = sg / 9; nxtB[p] = sb / 9;
              }
            }
            for (let x = 0; x < W; x++) { blurGeneric(x, 0); blurGeneric(x, H - 1); }
            for (let y = 1; y < H - 1; y++) { blurGeneric(0, y); blurGeneric(W - 1, y); }
          } else {
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) blurGeneric(x, y);
          }
          { const t = curR; curR = nxtR; nxtR = t; }
          { const t = curG; curG = nxtG; nxtG = t; }
          { const t = curB; curB = nxtB; nxtB = t; }
        }
        if (curR !== cr) { cr.set(curR); cg.set(curG); cb.set(curB); }
        lap('bg:blur');
        bgMap = { R: cr, G: cg, B: cb };
        dbg.bgFill = nKnown;
        }
        if (opts.probePts) {
          dbg.probeInfo = opts.probePts.map(([x, y]) => {
            const p0 = y * W + x, ci = compOf[p0];
            return { x, y, compOf: ci, regColor: regions[ci] ? regions[ci].color : null,
              obj: objOfComp[ci], isBase: objOfComp[ci] === baseObj,
              inBaseMask: bin[p0] ? 1 : 0, inCore: core[p0] ? 1 : 0, ink: inkPix[p0] ? 1 : 0, tex: texPix[p0] ? 1 : 0,
              Rs: [Rs[p0], Gs[p0], Bs[p0]], known: known[p0] ? 1 : 0, bg: [Math.round(cr[p0]), Math.round(cg[p0]), Math.round(cb[p0])] };
          });
        }
        if (opts.dumpMasks) {
          const bm2 = new Uint8Array(N * 3);
          for (let pp = 0; pp < N; pp++) { bm2[pp*3] = cr[pp]; bm2[pp*3+1] = cg[pp]; bm2[pp*3+2] = cb[pp]; }
          dbg.bgMapImg = bm2;
        }
      }
      lap('sweep:obj');
      // ---- 细线组划分 + 归属（"两拨画法"的分派表）----
      // 算一次连通域，按"行"排好（文字和轮廓都是成行成列的），再看每组贴着谁：
      // 贴着"某个对象"的 ⇒ 跟那个对象一起画（猫嘴跟着猫脸，字的描边走完字就画上）；
      // 只贴着底色/纸底的（题字、落款、印在底上的小字）⇒ 留到最后写。
      {
        const icc = compsOfLabels(inkBin, W, H);
        const groups = [];
        for (let ci = 0; ci < icc.comps.length; ci++) {
          if (icc.comps[ci].label === 1 && icc.comps[ci].count >= 6) groups.push(ci);
        }
        groups.sort((a, b) => icc.comps[b].count - icc.comps[a].count);
        const items = groups.slice(0, 3000).map((ci) => ({
          ci,
          cx: (icc.comps[ci].x0 + icc.comps[ci].x1) / 2,
          cy: (icc.comps[ci].y0 + icc.comps[ci].y1) / 2,
          h: icc.comps[ci].y1 - icc.comps[ci].y0 + 1,
        }));
        items.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
        const rows = [];
        for (const it of items) {
          const cur = rows[rows.length - 1];
          if (!cur || it.cy - cur.cy > Math.max(9 * strokeScale, cur.h * 0.8)) {
            rows.push({ cy: it.cy, h: it.h, items: [it] });
          } else {
            cur.items.push(it);
            if (it.h > cur.h) cur.h = it.h;
          }
        }
        const gSeq = [];
        for (const r of rows) {
          r.items.sort((a, b) => a.cx - b.cx);        // 一行内从左到右
          for (const it of r.items) gSeq.push(it.ci);
        }
        // "背景侧"对象：纸底和底色层——只贴着它们的细线留到最后写
        const skipObjs = new Set();
        for (let oi = 0; oi < nObj; oi++) if (objStat[oi].isPaper) skipObjs.add(oi);
        if (baseObj >= 0) skipObjs.add(baseObj);
        let nToObj = 0, nLast = 0;
        for (const ci of gSeq) {
          const bw = bboxOfComp(icc, ci, 3);
          const m = dilate(bw.m, bw.w, bw.h, 3);
          const cnt = new Map();
          for (let y = 0; y < bw.h; y++) {
            const row = (y + bw.y) * W + bw.x;
            for (let x = 0; x < bw.w; x++) {
              if (!m[y * bw.w + x]) continue;
              const o = objOfComp[compOf[row + x]];
              cnt.set(o, (cnt.get(o) || 0) + 1);
            }
          }
          let bestO = -1, bestC = 0;
          for (const [o, c] of cnt) {
            if (skipObjs.has(o)) continue;
            if (c > bestC) { bestC = c; bestO = o; }
          }
          if (bestO >= 0 && bestC >= 8) {
            if (!inkOfObj.has(bestO)) inkOfObj.set(bestO, []);
            inkOfObj.get(bestO).push(ci);
            nToObj++;
          } else {
            inkLastSeq.push(ci);
            nLast++;
          }
        }
        inkIcc = icc;
        dbg.inkToObj = nToObj;
        dbg.inkLast = nLast;
      }
      const bleedRad = Math.max(1, Math.round(opts.bleedR * strokeScale));
      // 一个对象画完，立刻把它身上的细线补上（猫嘴/描边不拖到最后，最后只留题字）
      let curInkObj = -1;
      const drawInkOfObj = (oi) => {
        const l = inkOfObj.get(oi);
        if (l) drawInkSeq(l, null, 1);      // ph=1：算"铺色阶段"的笔（跟着对象走）
      };

      // 一层"完整形状"沿某个方向的真实范围（一档档刷要按它来，刷不到就是白边）
      const layerSpan = (full, ax, ay, cx, cy) => {
        let tmin = Infinity, tmax = -Infinity, vmax = 0;
        for (let y = 0; y < full.h; y++) {
          for (let x = 0; x < full.w; x++) {
            if (!full.m[y * full.w + x]) continue;
            const gx = x + full.x0, gy = y + full.y0;
            const t = (gx - cx) * ax + (gy - cy) * ay;
            const v = Math.abs(-(gx - cx) * ay + (gy - cy) * ax);
            if (t < tmin) tmin = t;
            if (t > tmax) tmax = t;
            if (v > vmax) vmax = v;
          }
        }
        if (tmin > tmax) { tmin = tmax = 0; }
        return { tmin, tmax, vmax };
      };

      // ---- 细长的一层：中轴 + 跟着形状的宽度（直线一笔到底，不切段、不手抖）----
      const paintAsLines = (oi, full, sampleM) => {
        const st = objStat[oi];
        const cIdx = pushClip(full.x0, full.y0, full.w, full.h, full.m);
        const halfMin = 1.3 * strokeScale, halfMax = 16 * strokeScale;
        const queue = [{ m: full.m.slice(), x: 0, y: 0, w: full.w, h: full.h }];
        let guard = 0;
        while (queue.length && guard++ < 400) {
          const it = queue.shift();
          if (it.w >= 2 && it.h >= 2) {
            const dt = distanceTransform(it.m, it.w, it.h);
            globalThis.__thinTag = 'line' + (it.w >= full.w ? 'full' : 'sub');
            const { sk } = thin(it.m, it.w, it.h);
            tick('thin');
            const lp = longestPath(sk, it.w, it.h);
            if (lp && lp.len >= 2) {
              const abs = new Float64Array(lp.len * 2);
              for (let i = 0; i < lp.len; i++) {
                abs[i * 2] = lp.pts[i * 2] + it.x + full.x0;
                abs[i * 2 + 1] = lp.pts[i * 2 + 1] + it.y + full.y0;
              }
              // 直线段拉直：中轴是一像素一像素拐出来的，不简化就是坑坑洼洼
              const sp = rdpSimplify(abs, lp.len, opts.lineTol);
              const halfAt = (x, y) => {
                const lx = Math.round(x - full.x0 - it.x), ly = Math.round(y - full.y0 - it.y);
                let d = 0;
                if (lx >= 0 && lx < it.w && ly >= 0 && ly < it.h) d = dt[ly * it.w + lx];
                return clamp(d + 0.8 * strokeScale, halfMin, halfMax);
              };
              // 每点半宽（拉直后的顶点上取厚度）
              const halfs = new Float64Array(sp.n);
              for (let i = 0; i < sp.n; i++) halfs[i] = halfAt(sp.pts[i * 2], sp.pts[i * 2 + 1]);
              // 落笔前先算"这支笔盖到哪"：中轴被拉直之后，笔形会切掉形状上的凸起/拐角，
              // 那些没盖到的像素以前是留给"每层自检"用方框补丁补的——边缘就成了坑坑洼洼
              // （用户 2026-10-18 反馈的"本来是直的却像被啃过"）。
              // 这里改成**就地加宽**：把离缺口最近的那个顶点加宽到能盖住它（不新增笔画）。
              if (opts.lineSeal && sp.n >= 2) {
                for (let sit = 0; sit < (opts.sealIter | 0); sit++) {
                  const r0 = ribbonProf(sp.pts, sp.n, halfs);
                  const loc0 = new Float64Array(r0.length);
                  for (let i = 0; i < r0.length; i += 2) { loc0[i] = r0[i] - full.x0 - it.x; loc0[i + 1] = r0[i + 1] - full.y0 - it.y; }
                  const cov0 = new Uint8Array(it.w * it.h);
                  fillPoly(cov0, it.w, it.h, loc0);
                  const gaps = [];
                  for (let i = 0; i < it.m.length; i++) if (it.m[i] && !cov0[i]) gaps.push(i);
                  if (!gaps.length) break;
                  let nW = 0;
                  for (const gi of gaps) {
                    const gx = (gi % it.w) + full.x0 + it.x, gy = ((gi / it.w) | 0) + full.y0 + it.y;
                    let bi = 0, bd = Infinity;
                    for (let i = 0; i < sp.n; i++) {
                      const dx = sp.pts[i * 2] - gx, dy = sp.pts[i * 2 + 1] - gy;
                      const d = dx * dx + dy * dy;
                      if (d < bd) { bd = d; bi = i; }
                    }
                    const need = Math.sqrt(bd) + 0.9 * strokeScale;
                    if (need > halfs[bi]) { halfs[bi] = need; nW++; }
                  }
                  if (!nW) break;
                }
              }
              const halfAt2 = (x, y) => {
                let bi = 0, bd = Infinity;
                for (let i = 0; i < sp.n; i++) {
                  const dx = sp.pts[i * 2] - x, dy = sp.pts[i * 2 + 1] - y;
                  const d = dx * dx + dy * dy;
                  if (d < bd) { bd = d; bi = i; }
                }
                return Math.max(halfAt(x, y), halfs[bi]);
              };
              for (const p2 of localPartsProf(sp.pts, sp.n, halfAt2, sampleM, cIdx, oi, st.color, 1, 1, halfAt)) {
                emitStroke(p2.rib, p2.rib.length / 2, p2.path, p2.path.length / 2,
                           Math.max(halfMin, st.thick || 2), p2.col, p2.pen, cIdx, oi, 1);
              }
              // 扣掉已经盖住的部分，剩下的连通块继续排队
              const r = ribbonProf(sp.pts, sp.n, halfs);
              const loc = new Float64Array(r.length);
              for (let i = 0; i < r.length; i += 2) { loc[i] = r[i] - full.x0 - it.x; loc[i + 1] = r[i + 1] - full.y0 - it.y; }
              const cov = new Uint8Array(it.w * it.h);
              fillPoly(cov, it.w, it.h, loc);
              let nMask = 0, nCov = 0, nAfter = 0;
              for (let i = 0; i < it.m.length; i++) { if (it.m[i]) { nMask++; if (cov[i]) nCov++; } }
              for (let i = 0; i < it.m.length; i++) if (it.m[i] && cov[i]) it.m[i] = 0;
              for (let i = 0; i < it.m.length; i++) if (it.m[i]) nAfter++;
              if (opts.debug) (dbg.lineInfo || (dbg.lineInfo = [])).push({
                oi, w: it.w, h: it.h, mask: nMask, cov: nCov, left: nAfter, pts: sp.n, raw: lp.len });
            }
          }
          // 剩下的连通块：各自的外框里继续排队（不整块重跑——细长层的外框可能是整幅）
          const rc = compsOfLabels(it.m, it.w, it.h);
          for (let j = 0; j < rc.comps.length; j++) {
            const c = rc.comps[j];
            if (c.label !== 1 || c.count < 6) continue;
            const mw = c.x1 - c.x0 + 1, mh = c.y1 - c.y0 + 1;
            const nm = new Uint8Array(mw * mh);
            for (let k = 0; k < c.count; k++) {
              const p3 = rc.pix[c.start + k], x = p3 % it.w, y = (p3 - x) / it.w;
              nm[(y - c.y0) * mw + (x - c.x0)] = 1;
            }
            queue.push({ m: nm, x: it.x + c.x0, y: it.y + c.y0, w: mw, h: mh });
          }
        }
      };

      // ---- 一层一整片刷（原来的毛笔刷：沿主轴一档档来回涂）----
      const paintSweep = (oi, full, sampleM) => {
        const st = objStat[oi];
        const isBase = oi === baseObj;
        const ax = isBase ? (W >= H ? 1 : 0) : st.ax;
        const ay = isBase ? (W >= H ? 0 : 1) : st.ay;
        const rcx = isBase ? W * 0.5 : st.cx, rcy = isBase ? H * 0.5 : st.cy;
        const span = layerSpan(full, ax, ay, rcx, rcy);
        const rtmin = span.tmin, rtmax = span.tmax;
        const vHalf = Math.max(1, span.vmax);
        const cIdx = pushClip(full.x0, full.y0, full.w, full.h, full.m);
        // 一小部分笔允许"画出界"：像人一样压到轮廓外面，后面被别的颜色覆盖回来
        const allowBleed = opts.bleedP > 0 && st.area >= 1200 && !isBase && bleedOK[oi];
        const cBleed = allowBleed
          ? pushClip(full.x0, full.y0, full.w, full.h, dilate(full.m, full.w, full.h, bleedRad))
          : cIdx;
        const ext0 = vHalf * 2;
        let bwid = clamp(ext0 * opts.bwF, opts.bwMin * strokeScale, opts.bwMax * strokeScale);
        // 照片里的小纹理块：笔再宽也只是把块内明暗平均掉。宽到"整块厚度"就够盖住，
        // 多出来的部分换成更多档（笔数略增，爪垫高光/毛发层次能留下来）。
        if (opts.photoMode && opts.bwThickCap > 0 && !isBase && st.thick > 0 && st.area < opts.bwThickArea) {
          bwid = Math.min(bwid, Math.max(opts.bwMin * strokeScale, st.thick * opts.bwThickCap));
        }
        // 窄的一层不抖：宽度本来就窄，抖一点边就花了（黑框/细条带就是这么变坑洼的）
        const thinF = clamp(vHalf / 22, 0.25, 1);
        const wobA = (opts.organic ? Math.min(2.8, bwid * 0.13) : Math.min(2.6, bwid * 0.1)) * thinF;
        const bowA = (opts.organic ? Math.min(2.4, bwid * 0.11) : 0) * thinF;
        const dev = wobA + bowA;
        const ext = ext0 + 2 * dev;
        let nP = Math.max(1, Math.ceil(ext / (bwid * opts.coverOv)));
        if (nP > 24) { nP = 24; bwid = Math.max(bwid, ext / (nP * opts.coverOv)); }
        sweepRegions++; passTotal += nP; if (nP > passMax) passMax = nP;
        const px2 = -ay, py2 = ax;
        const wobPh = rand01(oi * 7919 + 13, 1) * 6.283;
        const wobW = 2.2 + 2.6 * rand01(oi * 7919 + 41, 9);
        const bowDir = rand01(oi * 7919 + 29, 3) > 0.5 ? 1 : -1;
        const tPen = (lastPen.x - rcx) * ax + (lastPen.y - rcy) * ay;
        const fromPlus = tPen > 0;
        const rRep = objRegions[oi].length ? objRegions[oi][0] : -1;
        const phL = isBase ? 0 : 1;        // 底色层 = "铺底色"这一步，其余层 = "铺色"
        const run = { parts: [], col: null, cIdx: -1, ex: 0, ey: 0 };
        const flushRun = () => {
          const ps = run.parts;
          if (!ps.length) return;
          if (ps.length === 1) {
            const p = ps[0];
            emitStroke(p.rib, p.rib.length / 2, p.path, p.path.length / 2, p.halfW, p.col, p.pen, p.cIdx, rRep, p.ph);
          } else {
            const rib = mergeLoops(ps.map((p) => p.rib));
            let tot = 0;
            for (const p of ps) tot += p.path.length;
            const arr = new Float64Array(tot);
            let o = 0;
            for (const p of ps) { arr.set(p.path, o); o += p.path.length; }
            // 并成一笔之后只有一个颜色：取各段的"按长度加权均值"，不能拿第一段的颜色——
            // 一条长笔跨过渐变时，末端会整段刷成起点色（插画粉色圆里那块方块状鬼影就是这么来的）
            let cr2 = 0, cg2 = 0, cb2 = 0, cw2 = 0;
            for (const p of ps) {
              const w2 = p.path.length;
              cr2 += p.col[0] * w2; cg2 += p.col[1] * w2; cb2 += p.col[2] * w2; cw2 += w2;
            }
            const col2 = cw2 ? [Math.round(cr2 / cw2), Math.round(cg2 / cw2), Math.round(cb2 / cw2)] : ps[0].col;
            emitStroke(rib, rib.length / 2, arr, arr.length / 2, ps[0].halfW, col2, ps[0].pen, ps[0].cIdx, rRep, ps[0].ph);
          }
          run.parts = []; run.col = null; run.cIdx = -1; run.ex = 0; run.ey = 0;
        };
        const pushPart = (p, halfW) => {
          p.halfW = halfW;
          if (!opts.joinPass) { run.parts.push(p); flushRun(); return; }
          if (run.parts.length) {
            const cd = Math.abs(p.col[0] - run.col[0]) + Math.abs(p.col[1] - run.col[1]) + Math.abs(p.col[2] - run.col[2]);
            // 只能并"接得上"的段：跨档并笔时路径会在两档之间跳过去，
            // 笔形跟着自交、绕数归零，画出来就是个破洞（回放里那些白斑就是它）
            const gap = Math.hypot(p.path[0] - run.ex, p.path[1] - run.ey);
            // 并笔的色差门槛跟"分段并笔"用同一个值（底色层是 6）：用默认的 18 太松，
            // 一条长笔能跨 18 个色阶的渐变，末端就整段刷成起点色（鬼影的另一个来源）
            if (run.cIdx !== p.cIdx || cd >= (joinCdOverride || opts.joinCd) || gap > opts.joinGap) flushRun();
          }
          if (!run.parts.length) { run.col = p.col; run.cIdx = p.cIdx; }
          run.parts.push(p);
          run.ex = p.path[p.path.length - 2];
          run.ey = p.path[p.path.length - 1];
        };
        // 1) 先把这一层所有"档"的几何排好（路径 + 笔宽），先不落笔——
        //    这样才有机会在落笔前把"档与档之间的缝"算出来（见下面的联合覆盖自检）
        const passes = [];
        for (let k = 0; k < nP; k++) {
          const pi = fromPlus ? (nP - 1 - k) : k;
          const dir = ((k % 2 === 0) !== fromPlus) ? 1 : -1;
          const seed = oi * 7919 + pi * 104729 + k * 15485863;
          const v = -vHalf - dev + (pi + 0.5) * (ext / nP);
          const bwidP = opts.organic ? bwid * (0.9 + 0.2 * rand01(seed, 11)) : bwid;
          const wobPhP = wobPh + (rand01(seed, 1) - 0.5) * 0.7;
          const bowP = opts.organic ? bowA * bowDir * (0.7 + 0.6 * rand01(seed, 3)) : 0;
          const e0 = opts.organic ? (rand01(seed, 5) - 0.35) * 5 : 3;
          const e1 = opts.organic ? (rand01(seed, 7) - 0.35) * 5 : 3;
          const tA = dir > 0 ? rtmin - 2 - e0 : rtmax + 2 + e1;
          const tB = dir > 0 ? rtmax + 2 + e1 : rtmin - 2 - e0;
          const nseg = opts.organic ? 6 : 5;
          const path = new Float64Array(nseg * 2);
          const halfs = new Float64Array(nseg);
          for (let s = 0; s < nseg; s++) {
            const f = nseg > 1 ? s / (nseg - 1) : 0;
            const tt = tA + (tB - tA) * f;
            const off = v + wobA * Math.sin(wobPhP + f * wobW) + bowP * Math.sin(Math.PI * f);
            path[s * 2] = rcx + ax * tt + px2 * off;
            path[s * 2 + 1] = rcy + ay * tt + py2 * off;
            halfs[s] = (bwidP / 2) * (opts.taperLo + opts.taperAmp * Math.sin(Math.PI * f)
                                      + opts.taperWob * Math.sin(wobPhP + f * 3.1));
          }
          const useClip = (opts.bleedP > 0 && rand01(seed, 13) < opts.bleedP) ? cBleed : cIdx;
          passes.push({ path, halfs, n: nseg, half: bwidP / 2, useClip });
        }
        // 2) 铺色"一次过"：把这一层所有档的笔形按网页端口径（覆盖率 ≥ coverMin 才算画上）
        //    合起来光栅化一遍，掩膜里没盖到的像素**就地加宽离它最近的那一档**（不新增笔画）。
        //    白缝在铺的时候就补平，不用等每层自检事后补——用户看到的"铺色中间有空洞、
        //    最右边没铺到、后来又回来补一次"就是这么来的。
        let sealed = false;
        if (opts.sweepSeal && full.w * full.h >= opts.sealMin) {
          const cov = new Uint8Array(full.w * full.h);
          const raster = (ps) => {
            const rib = ribbon(ps.path, ps.n, ps.half);
            let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
            for (let i = 0; i < rib.length; i += 2) {
              const x = rib[i], y = rib[i + 1];
              if (x < xmin) xmin = x; if (x > xmax) xmax = x;
              if (y < ymin) ymin = y; if (y > ymax) ymax = y;
            }
            const bx = Math.max(full.x0, Math.floor(xmin)), by = Math.max(full.y0, Math.floor(ymin));
            const ex = Math.min(full.x0 + full.w - 1, Math.ceil(xmax)), ey = Math.min(full.y0 + full.h - 1, Math.ceil(ymax));
            if (ex < bx || ey < by) return;
            const w2 = ex - bx + 1, h2 = ey - by + 1;
            const cv = new Float32Array(w2 * h2);
            const p2 = new Float64Array(rib.length);
            for (let i = 0; i < rib.length; i += 2) { p2[i] = rib[i] - bx; p2[i + 1] = rib[i + 1] - by; }
            fillPolyCov(cv, w2, h2, p2, opts.coverSubY || 1);
            const cl = clips[ps.useClip];
            for (let y = 0; y < h2; y++) {
              const gy = by + y;
              if (gy < cl.y || gy >= cl.y + cl.h || gy < full.y0 || gy >= full.y0 + full.h) continue;
              const rowC = (gy - cl.y) * cl.w, rowF = (gy - full.y0) * full.w;
              for (let x = 0; x < w2; x++) {
                if (cv[y * w2 + x] < opts.coverMin) continue;
                const gx = bx + x;
                if (gx < cl.x || gx >= cl.x + cl.w) continue;
                if (!cl.mask[rowC + (gx - cl.x)]) continue;
                cov[rowF + (gx - full.x0)] = 1;
              }
            }
          };
          for (const ps of passes) raster(ps);
          let left = 0;
          for (let it = 0; it < (opts.sealIter | 0); it++) {
            const gaps = [];
            for (let y = 0; y < full.h; y++) {
              const rowF = y * full.w;
              for (let x = 0; x < full.w; x++) if (full.m[rowF + x] && !cov[rowF + x]) gaps.push(full.x0 + x, full.y0 + y);
            }
            left = gaps.length >> 1;
            if (opts.debug) { const S2 = dbg.seal || (dbg.seal = { layer: 0, gap: 0, left: 0 }); if (it === 0) S2.gap += left; S2.left += 0; S2.last = left; }
            if (!left) break;
            const dirty = new Set();
            for (let gi = 0; gi < gaps.length; gi += 2) {
              const gx = gaps[gi], gy = gaps[gi + 1];
              let best = -1, bd = Infinity, bi = 0, bpx = 0, bpy = 0;
              for (let pi = 0; pi < passes.length; pi++) {
                const ps = passes[pi];
                for (let i = 0; i < ps.n; i++) {
                  const dx = ps.path[i * 2] - gx, dy = ps.path[i * 2 + 1] - gy;
                  const d = dx * dx + dy * dy;
                  if (d < bd) { bd = d; best = pi; bi = i; bpx = ps.path[i * 2]; bpy = ps.path[i * 2 + 1]; }
                }
              }
              if (best < 0) continue;
              const ps = passes[best];
              const need = Math.hypot(bpx - gx, bpy - gy) + 0.9 * strokeScale;
              if (need > ps.half) { ps.half = need; dirty.add(best); }
            }
            if (!dirty.size) break;
            for (const pi of dirty) raster(passes[pi]);
          }
          sealed = !left;
          dbg.seal = dbg.seal || { layer: 0, gap: 0, left: 0 };
          dbg.seal.layer++;
        }
        // 3) 落笔（颜色照旧：按段取局部色，相邻同色段并成一笔）
        const segSave = segLenOverride;
        if (opts.photoMode && st.area < opts.bwThickArea && st.thick > 0) {
          // 小区域按"厚度"取短段：爪垫 3.7px 厚 → 9px 一段，块内的高光/阴影才能各取各的色
          segLenOverride = Math.max(8, st.thick * opts.segSmallF);
        }
        for (const ps of passes) {
          if (opts.localColor) {
            for (const p of localParts(ps.path, ps.n, ps.half, sampleM.m, sampleM.x, sampleM.y, sampleM.w, sampleM.h,
                                       0, ps.useClip, oi, st.color, phL)) {
              pushPart(p, ps.half);
            }
          } else {
            const rib = ribbon(ps.path, ps.n, ps.half);
            pushPart({ rib, path: ps.path, col: st.color, pen: 0, cIdx: ps.useClip, rIdx: oi, ph: phL }, ps.half);
          }
        }
        segLenOverride = segSave;
        flushRun();
        return sealed;
      };

      // ---- 每层当场自检：这一层自己有没有没刷到的地方（不只底色层）----
      // 把这一层刚落的笔按"网页端口径"（覆盖率 ≥ coverMin 才算画上）光栅化一遍，
      // 掩膜里没盖到的连通块立刻补掉——底层一次铺满，不留白斑等最后的补漏收拾。
      const layerCheck = (oi, full, from) => {
        if (!opts.layerCheck) return;
        const cov = new Uint8Array(full.w * full.h);
        for (let si = from; si < strokes.length; si++) {
          const st0 = strokes[si];
          const cl = clips[st0.c];
          const rib = st0.rib;
          const np2 = rib.length >> 1;
          let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
          for (let i = 0; i < np2; i++) {
            const x = rib[i * 2], y = rib[i * 2 + 1];
            if (x < xmin) xmin = x; if (x > xmax) xmax = x;
            if (y < ymin) ymin = y; if (y > ymax) ymax = y;
          }
          xmin = Math.max(cl.x, Math.floor(xmin)); ymin = Math.max(cl.y, Math.floor(ymin));
          xmax = Math.min(cl.x + cl.w - 1, Math.ceil(xmax)); ymax = Math.min(cl.y + cl.h - 1, Math.ceil(ymax));
          if (xmax < xmin || ymax < ymin) continue;
          const mw = xmax - xmin + 1, mh = ymax - ymin + 1;
          const pts2 = new Float64Array(np2 * 2);
          for (let i = 0; i < np2; i++) { pts2[i * 2] = rib[i * 2] - xmin; pts2[i * 2 + 1] = rib[i * 2 + 1] - ymin; }
          const cv2 = new Float32Array(mw * mh);
          fillPolyCov(cv2, mw, mh, pts2, opts.coverSubY || 1);
          for (let y = 0; y < mh; y++) {
            const rowC = (ymin + y - cl.y) * cl.w, row = (ymin + y);
            for (let x = 0; x < mw; x++) {
              if (cv2[y * mw + x] < opts.coverMin) continue;
              const xx = xmin + x;
              if (!cl.mask[rowC + (xx - cl.x)]) continue;
              if (xx < full.x0 || xx >= full.x0 + full.w || row < full.y0 || row >= full.y0 + full.h) continue;
              cov[(row - full.y0) * full.w + (xx - full.x0)] = 1;
            }
          }
        }
        const gap = new Uint8Array(full.w * full.h);
        let nGap = 0;
        for (let i = 0; i < gap.length; i++) if (full.m[i] && !cov[i]) { gap[i] = 1; nGap++; }
        // 边界带**主动**补一遍：本层自己那一圈 1~2px 的边界（掩膜减"缩 1px 的掩膜"）用局部色刷。
        // 为什么：主笔是"整层一个色"（细长层尤其），而边界那圈在原图里是混色/深描边——
        // 海报字母那圈深红描边、照片发丝边的灰过渡，平涂上去必然差一截。
        // 老版本是"笔形端头缺半个圆 ⇒ 自检发现洞 ⇒ 补丁按局部色补"歪打正着把边刷准的；
        // 端头修好之后没有洞了，这件事就得明着做（用户要的"和原图 1:1"主要在边上）。
        if (opts.rimPass && oi !== baseObj && (opts.rimLinearOnly ? objStat[oi].linear : true)) {
          const own2 = objBox[oi];
          const core = erode(own2.m, own2.w, own2.h, 1);
          for (let y = 0; y < own2.h; y++) {
            const fy = y + own2.y0 - full.y0;
            if (fy < 0 || fy >= full.h) continue;
            for (let x = 0; x < own2.w; x++) {
              const i2 = y * own2.w + x;
              if (!own2.m[i2] || core[i2]) continue;
              const fx = x + own2.x0 - full.x0;
              if (fx < 0 || fx >= full.w) continue;
              const k = fy * full.w + fx;
              if (!gap[k]) { gap[k] = 1; nGap++; }
            }
          }
        }
        if (!nGap) return;
        if (!dbg.gapAt) dbg.gapAt = {};
        dbg.gapAt[oi] = strokes.length;
        const gc = compsOfLabels(gap, full.w, full.h);
        const order = [];
        for (let ci = 0; ci < gc.comps.length; ci++) {
          if (gc.comps[ci].label !== 1) continue;
          const c = gc.comps[ci];
          order.push({ ci, h: hilbertIndex((c.x0 + c.x1) >> 1, (c.y0 + c.y1) >> 1, 10) });
        }
        order.sort((a, b) => a.h - b.h);     // 沿希尔伯特序走，笔尖一片一片挪
        for (const o of order) {
          const c = gc.comps[o.ci];
          // 一个缺口里"深浅混在一起"时（缺口压在深色描边上、或者跨着渐变），
          // 用整块的均值色补上去就是一道灰条（实测飞机边上那块 15x20 的灰斑）。
          // 先按颜色二分，每一份单独补（各用各的均值色）。
          const parts = [];
          {
            const px2 = new Int32Array(c.count);
            for (let k = 0; k < c.count; k++) {
              const p = gc.pix[c.start + k];
              const x = p % full.w, y = (p - x) / full.w;
              px2[k] = (y + full.y0) * W + (x + full.x0);     // 整幅坐标
            }
            splitPixByColor(px2, c.count, 0, parts);
          }
          for (const pt of parts) {
            let px0 = W, py0 = H, px1 = -1, py1 = -1, cr = 0, cg = 0, cb = 0;
            for (let k = 0; k < pt.cnt; k++) {
              const gp = pt.pix[k];
              const x = gp % W, y = (gp - x) / W;
              if (x < px0) px0 = x; if (x > px1) px1 = x;
              if (y < py0) py0 = y; if (y > py1) py1 = y;
              cr += R[gp]; cg += G[gp]; cb += B[gp];
            }
            const x0 = px0, y0 = py0, x1 = px1, y1 = py1;
            const mw = x1 - x0 + 1, mh = y1 - y0 + 1;
            const bin = new Uint8Array(mw * mh);
            for (let k = 0; k < pt.cnt; k++) {
              const gp = pt.pix[k];
              const x = gp % W, y = (gp - x) / W;
              bin[(y - y0) * mw + (x - x0)] = 1;      // 组内局部坐标（不是整幅坐标）
            }
            // 补缝的颜色：底色层用"背景色场"（bgMap）——用原图局部均值的话，
            // 这块正好压在字上就会补成"字和底的混色"（紫灰块，实测整片花掉）
            let col;
            if (oi === baseObj && bgMap) {
              let sr2 = 0, sg2 = 0, sb2 = 0;
              for (let k = 0; k < pt.cnt; k++) {
                const gp = pt.pix[k];
                sr2 += bgMap.R[gp]; sg2 += bgMap.G[gp]; sb2 += bgMap.B[gp];
              }
              col = [Math.round(sr2 / pt.cnt), Math.round(sg2 / pt.cnt), Math.round(sb2 / pt.cnt)];
            } else {
              col = [Math.round(cr / pt.cnt), Math.round(cg / pt.cnt), Math.round(cb / pt.cnt)];
            }
            const cIdx = pushClip(x0, y0, mw, mh, bin);
            // 外扩 1px 的方框笔形 ∩ 这个 1 位掩膜 ⇒ 严格只覆盖"确实没刷到"的像素
            const ex0 = x0 - 1, ey0 = y0 - 1, ex1 = x1 + 2, ey1 = y1 + 2;
            const rect = [ex0, ey0, ex1, ey0, ex1, ey1, ex0, ey1];
            emitStroke(rect, 4, [ex0, (ey0 + ey1) / 2, ex1, (ey0 + ey1) / 2], 2,
                       Math.max(1.6, mh / 2 + 1), col, 0, cIdx, objRegions[oi].length ? objRegions[oi][0] : -1, 1);
          }
        }
        dbg.layerGap = (dbg.layerGap || 0) + nGap;
        // 补完再验一次：还剩多少没盖到（只在诊断时跑：它会把这一层的笔再光栅化一遍，很贵）
        if (opts.debug) {
          const cov2 = new Uint8Array(full.w * full.h);
          for (let si = from; si < strokes.length; si++) {
            const st0 = strokes[si];
            const cl = clips[st0.c];
            const rib = st0.rib;
            const np2 = rib.length >> 1;
            let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
            for (let i = 0; i < np2; i++) { const x = rib[i * 2], y = rib[i * 2 + 1];
              if (x < xmin) xmin = x; if (x > xmax) xmax = x; if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
            xmin = Math.max(cl.x, Math.floor(xmin)); ymin = Math.max(cl.y, Math.floor(ymin));
            xmax = Math.min(cl.x + cl.w - 1, Math.ceil(xmax)); ymax = Math.min(cl.y + cl.h - 1, Math.ceil(ymax));
            if (xmax < xmin || ymax < ymin) continue;
            const mw = xmax - xmin + 1, mh = ymax - ymin + 1;
            const pts2 = new Float64Array(np2 * 2);
            for (let i = 0; i < np2; i++) { pts2[i * 2] = rib[i * 2] - xmin; pts2[i * 2 + 1] = rib[i * 2 + 1] - ymin; }
            const cv2 = new Float32Array(mw * mh);
            fillPolyCov(cv2, mw, mh, pts2, opts.coverSubY || 1);
            for (let y = 0; y < mh; y++) {
              const rowC = (ymin + y - cl.y) * cl.w, row = (ymin + y);
              for (let x = 0; x < mw; x++) {
                if (cv2[y * mw + x] < opts.coverMin) continue;
                const xx = xmin + x;
                if (!cl.mask[rowC + (xx - cl.x)]) continue;
                if (xx < full.x0 || xx >= full.x0 + full.w || row < full.y0 || row >= full.y0 + full.h) continue;
                cov2[(row - full.y0) * full.w + (xx - full.x0)] = 1;
              }
            }
          }
          let left2 = 0;
          for (let i = 0; i < gap.length; i++) if (full.m[i] && !cov2[i]) left2++;
          dbg.layerGapLeft = (dbg.layerGapLeft || 0) + left2;
        }
      };

      lap('sweep:layerprep');
      // ---- 绘制顺序：同色合并成"一趟" ----
      // 层与层之间只有"谁盖谁"这一条硬约束：A 的完整形状盖到了 B 的可见像素 ⇒ B 必须先画。
      // 其余两两之间顺序完全自由 —— 那就优先挑"跟上一笔同色、又离笔尖近"的那层，
      // 于是同一支笔会一路把同色的东西画完（一整排橙字连着写完），而不是按面积大小来回跳。
      const paintOrder = (() => {
        const ord = new Int32Array(nObj);
        for (let i = 0; i < nObj; i++) ord[i] = i;
        if (!opts.colorPass || nObj < 2) return ord;
        const need = new Map();          // a → Set(必须先画的层)
        const rel = new Map();           // b → Set(被 b 挡住的层)
        const addEdge = (b, a) => {
          let s = need.get(a); if (!s) { s = new Set(); need.set(a, s); }
          if (s.has(b)) return;
          s.add(b);
          let t = rel.get(b); if (!t) { t = new Set(); rel.set(b, t); }
          t.add(a);
        };
        // 判据：**两张完整形状只要相交，先后就不能换**（谁先谁后是按面积定的，换了就有一方
        // 会盖到对方身上）。先按外框粗筛，再逐像素确认——只用"可见掩膜相交"是不够的：
        // 两个层各自的完整形状会互相长进对方那边，只看可见部分会漏掉这类约束。
        const inter = (A, B) => {
          const y0 = Math.max(A.y0, B.y0), y1 = Math.min(A.y0 + A.h - 1, B.y0 + B.h - 1);
          const x0 = Math.max(A.x0, B.x0), x1 = Math.min(A.x0 + A.w - 1, B.x0 + B.w - 1);
          for (let y = y0; y <= y1; y++) {
            const rowA = (y - A.y0) * A.w, rowB = (y - B.y0) * B.w;
            for (let x = x0; x <= x1; x++) if (A.m[rowA + (x - A.x0)] && B.m[rowB + (x - B.x0)]) return true;
          }
          return false;
        };
        for (let a = 1; a < nObj; a++) {
          const F = objFull[a];
          for (let b = 0; b < a; b++) {
            const G = objFull[b];
            if (F.x0 > G.x0 + G.w - 1 || G.x0 > F.x0 + F.w - 1 ||
                F.y0 > G.y0 + G.h - 1 || G.y0 > F.y0 + F.h - 1) continue;   // 外框不相交
            if (inter(F, G)) addEdge(b, a);
          }
        }
        const indeg = new Int32Array(nObj);
        for (const [a, s] of need) indeg[a] = s.size;
        const done = new Uint8Array(nObj);
        const out = [];
        let pc = null, px0 = 0, py0 = 0, pa = 0;
        for (let k = 0; k < nObj; k++) {
          let bestSame = -1, bdSame = Infinity, bestAny = -1, baAny = -1;
          for (let i = 0; i < nObj; i++) {
            if (done[i] || indeg[i] > 0) continue;
            const st = objStat[i];
            if (pc) {
              const cd = Math.abs(st.color[0] - pc[0]) + Math.abs(st.color[1] - pc[1]) + Math.abs(st.color[2] - pc[2]);
              const ar = Math.max(st.area, pa) / Math.max(1, Math.min(st.area, pa));
              if (cd <= opts.colorPassTol && ar <= opts.colorPassArea) {
                const d = Math.hypot(st.cx - px0, st.cy - py0);
                if (d < bdSame) { bdSame = d; bestSame = i; }
                continue;
              }
            }
            if (st.area > baAny) { baAny = st.area; bestAny = i; }
          }
          let pick = bestSame >= 0 ? bestSame : bestAny;
          if (pick < 0) { for (let i = 0; i < nObj; i++) if (!done[i]) { pick = i; break; } }  // 有环：按原序打破
          done[pick] = 1; out.push(pick);
          pc = objStat[pick].color; px0 = objStat[pick].cx; py0 = objStat[pick].cy; pa = objStat[pick].area;
          const t = rel.get(pick);
          if (t) for (const a of t) indeg[a]--;
        }
        dbg.colorPasses = (() => {                 // 埋点：同色的层连着画算一趟，共几趟
          let n = 1;
          for (let i = 1; i < out.length; i++) {
            const c0 = objStat[out[i - 1]].color, c1 = objStat[out[i]].color;
            if (Math.abs(c0[0] - c1[0]) + Math.abs(c0[1] - c1[1]) + Math.abs(c0[2] - c1[2]) > opts.colorPassTol) n++;
          }
          return n;
        })();
        return Int32Array.from(out);
      })();

      // ---- 出界笔的顺序约束 ----
      // 铺色时允许一小部分笔"画出界"（像人一样压到轮廓外），但只有当出界那一圈**只压在
      // 已经画过的对象上**才允许：否则后画的邻居不会再来盖它，那圈颜色就留在别人身上
      // （实测：蓝层 #30 的两支出界笔把飞机 95 个米色像素盖成蓝色，飞机就"被啃"了）。
      const bleedOK = new Uint8Array(nObj);
      if (opts.bleedP > 0) {
        const posOf = new Int32Array(nObj).fill(-1);
        for (let k = 0; k < paintOrder.length; k++) posOf[paintOrder[k]] = k;
        const br = Math.max(1, opts.bleedR | 0);
        let nOK = 0, nNo = 0;
        for (const a of paintOrder) {
          const st = objStat[a];
          if (st.area < 1200 || a === baseObj) continue;
          const F = objFull[a];
          const x0 = Math.max(0, F.x0 - br), y0 = Math.max(0, F.y0 - br);
          const x1 = Math.min(W - 1, F.x0 + F.w - 1 + br), y1 = Math.min(H - 1, F.y0 + F.h - 1 + br);
          const w = x1 - x0 + 1, h = y1 - y0 + 1;
          const m = new Uint8Array(w * h);
          for (let y = 0; y < F.h; y++) {
            const row = (y + F.y0 - y0) * w;
            for (let x = 0; x < F.w; x++) if (F.m[y * F.w + x]) m[row + (x + F.x0 - x0)] = 1;
          }
          const d = dilate(m, w, h, br);
          let bad = false;
          for (const b of paintOrder) {
            if (b === a || posOf[b] > posOf[a]) continue;      // 排在后面的对象会把它盖回来，不用管
            const G = objFull[b];
            if (G.x0 > x1 || x0 > G.x0 + G.w - 1 || G.y0 > y1 || y0 > G.y0 + G.h - 1) continue;
            const gx0 = Math.max(x0, G.x0), gx1 = Math.min(x1, G.x0 + G.w - 1);
            const gy0 = Math.max(y0, G.y0), gy1 = Math.min(y1, G.y0 + G.h - 1);
            let hit = false;
            for (let y = gy0; y <= gy1 && !hit; y++) {
              const rowD = (y - y0) * w, rowF = (y - F.y0) * F.w, rowG = (y - G.y0) * G.w;
              for (let x = gx0; x <= gx1; x++) {
                if (!d[rowD + (x - x0)]) continue;
                if (F.m[rowF + (x - F.x0)]) continue;          // 只算"出界那一圈"
                if (G.m[rowG + (x - G.x0)]) { hit = true; break; }
              }
            }
            if (hit) { bad = true; break; }
          }
          if (bad) nNo++; else { bleedOK[a] = 1; nOK++; }
        }
        dbg.bleedOK = { ok: nOK, off: nNo };
      } else {
        bleedOK.fill(1);
      }

      lap('sweep:order');
      // ---- 逐层画 ----
      const TT = {}; let tMark = Date.now();
      const tick = (k) => { const n = Date.now(); TT[k] = (TT[k] || 0) + (n - tMark); tMark = n; };

      for (const oi of paintOrder) {
        curLayer = oi;
        if (oi !== curInkObj) {
          if (curInkObj >= 0) drawInkOfObj(curInkObj);
          curInkObj = oi;
        }
        const st = objStat[oi];
        if (!st.area) continue;
        const full = objFull[oi], own = objBox[oi];
        st.from = strokes.length;
        // 取色源：本层自己"看得见"的像素（往内缩 1px 避开边界混色；细线/纹理像素不算）
        let sampleM = own;
        // 细长层不缩边：它本来就只有 1~3px 厚，"缩 1px 避开边界混色"之后几乎没剩几个像素，
        // 取色就退化成"整层一个均值色"，边界那一圈（照片的发丝/海报的深色描边）全刷成平的。
        // 小区域不缩边：爪垫/小毛发块只有 3~4px 厚，缩 1px 后掩膜几乎空了，
        // sampleColor 全部失败 ⇒ 整层退回 st.color 一个均值色（实测爪垫 24 笔全是 209,176,146）。
        const noErodeSmall = opts.photoMode && st.area < (opts.bwThickArea || 4000);
        if (st.area > 600 && !(opts.thinNoErode && st.linear) && !noErodeSmall) {
          sampleM = { x: own.x, y: own.y, w: own.w, h: own.h, m: erode(own.m, own.w, own.h, 1) };
        }
        {
          // 取色时排除"细线/纹理像素"（那里是黑字、纸纹，采进去会让铺色发黑发花）——
          // 但如果排除之后剩得太少（照片类几乎整幅都是"纹理像素"），就别排除了，
          // 否则这一层没地方取色，只能整层用一个平均色，实测照片因此差 15 个点。
          let nTex = 0, nTot = 0;
          for (let y = 0; y < sampleM.h; y++) {
            const row = (y + sampleM.y) * W + sampleM.x;
            for (let x = 0; x < sampleM.w; x++) {
              if (!sampleM.m[y * sampleM.w + x]) continue;
              nTot++;
              if (inkPix[row + x] || texPix[row + x]) nTex++;
            }
          }
          if (nTex > 0 && nTex < 0.7 * nTot) {
            const sm = new Uint8Array(sampleM.m);
            for (let y = 0; y < sampleM.h; y++) {
              const row = (y + sampleM.y) * W + sampleM.x;
              for (let x = 0; x < sampleM.w; x++) if (inkPix[row + x] || texPix[row + x]) sm[y * sampleM.w + x] = 0;
            }
            sampleM = { x: sampleM.x, y: sampleM.y, w: sampleM.w, h: sampleM.h, m: sm };
          }
        }
        let sealed = false, checkFull = full;
        if (oi === baseObj && bgMap) {
          // 底色层：裁剪范围是整幅（上面要画的东西也照刷，一个洞都不留），取色用"背景色场"
          // （看得见的地方 = 平滑图，看不见的地方 = 按周围推出来的）；分段短、并笔卡得紧，
          // 免得一条长笔跨过渐变把颜色抹平（底色的暗角/渐变就是这么丢的）
          curTarget = bgMap;
          segLenOverride = Math.max(26, Math.round(56 * strokeScale));
          joinCdOverride = 6;
          sealed = paintSweep(oi, full, { x: 0, y: 0, w: W, h: H, m: full.m });
          segLenOverride = 0; joinCdOverride = 0;
          curTarget = target;
        } else if (st.linear) {
          paintAsLines(oi, full, own, sampleM);
        } else {
          // 照片小区域只刷"看得见的那块"：完整形状常包含被上层盖住的部分，
          // 笔扫出去以后 sampleColor 在可见掩膜里取不到色，整层会退回 st.color 一个均值色。
          const paintFull = (opts.photoMode && st.area < opts.bwThickArea) ? own : full;
          sealed = paintSweep(oi, paintFull, sampleM);
          checkFull = paintFull;
        }
        tick(st.linear ? 'lines' : 'sweep');
        // 落笔前已经做过联合覆盖自检、缝也补平了 ⇒ 这里的"事后自检"就没活干了，
        // 直接跳过（它要把这一层的笔再光栅化一遍，很贵）
        if (!sealed) layerCheck(oi, checkFull, st.from);
        tick('check');
        st.to = strokes.length;
        if (opts.debug) (dbg.paintTrace || (dbg.paintTrace = [])).push({
          oi, from: st.from, to: st.to, area: st.area, linear: !!st.linear,
          ly0: st.from < st.to ? strokes[st.from].ly : -1,
        });
      }
      if (curInkObj >= 0) drawInkOfObj(curInkObj);
      curLayer = -1;              // 后面的残差/补漏/题字都不是"某一层"了
      tick('lines');
      dbg.paint = TT;
      dbg.layerEnds = objStat.map((s2) => s2.to || 0);
      if (opts.dumpMasks) {
        const pal2 = [[255,255,255],[0,0,0],[255,0,0],[0,160,0],[0,0,255],[255,160,0],[160,0,255],[0,200,200],
                      [128,128,0],[255,0,255],[0,100,0],[128,0,0],[0,0,128],[200,200,0],[100,100,100],[255,100,100]];
        const lm = new Uint8Array(N * 3);
        for (let pp = 0; pp < N; pp++) {
          const c = pal2[objLab[pp] % pal2.length];
          lm[pp*3] = c[0]; lm[pp*3+1] = c[1]; lm[pp*3+2] = c[2];
        }
        dbg.layerMap = lm;
      }
      dbg.dumpMasks = opts.dumpMasks ? objStat.map((s2, i) => {
        const f = objFull[i], o = objBox[i];
        return { oi: s2.oi, color: s2.color, area: s2.area, linear: !!s2.linear, thick: s2.thick || 0,
                 grown: s2.grown || 0, full: { x0: f.x0, y0: f.y0, w: f.w, h: f.h, m: Array.from(f.m) },
                 own: { x0: o.x0, y0: o.y0, w: o.w, h: o.h, m: Array.from(o.m) } };
      }) : undefined;
      dbg.layers = objStat.map((s2) => ({
        oi: s2.oi, area: s2.area, paper: !!s2.isPaper, linear: !!s2.linear,
        thick: s2.thick ? +s2.thick.toFixed(1) : 0, grown: s2.grown || 0,
        strokes: (s2.to || 0) - s2.from, from: s2.from || 0, to: s2.to || 0,
        bbox: [s2.x0, s2.y0, s2.x1, s2.y1],
      }));
    }
    mark('铺色');
    lap('sweep');
    prog(0.78, '补笔修形…'); await yieldUI();

    dbg.mainStrokes = strokes.length;
    // ---- 8c) 残差补笔：哪块不像就在哪块补细笔（按局部小块，允许覆盖） ----
    // "边缘带"（区块交界附近 2px）：纹理像素在这里不跳过残差——
    // 边缘上的过渡像素如果也被 texPix 跳过，笔触的半覆盖边就没人补实，
    // 网页端抗锯齿渲染下会留下 1~2px 的白缝（实测插画 22px）。
    // 照片类不启用：它的边缘本来就是渐变纹理，硬补反而把可见差异补高（29.2% → 31.2%）。
    const edgeNear = (() => {
      if (opts.photoMode) return new Uint8Array(N);   // 照片类不启用：全 0 = 没有边缘带豁免
      const band = new Uint8Array(N);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const p = y * W + x, c0 = compOf[p];
          if ((x + 1 < W && compOf[p + 1] !== c0) || (y + 1 < H && compOf[p + W] !== c0)) band[p] = 1;
        }
      }
      return dilate(band, W, H, 2);
    })();
    // 局部起伏（3x3 窗口内每通道极差的最大值）：很小 = 这一带是平滑渐变/平色，
    // 不是"有结构的地方"——渐变上的采样台阶用点去描，只会描出一片鬼影（插画那个粉色圆里
    // 那块方块状淡影就是 5000 笔描出来的），而且描完还是不匀。
    const flatRng = (() => {
      const out = new Uint8Array(N);
      if (!(opts.resFlatTol > 0)) return out;      // 判据关着就别算（3x3 极差是整幅扫描）
      for (let y = 0; y < H; y++) {
        const y0 = y > 0 ? y - 1 : 0, y1 = y < H - 1 ? y + 1 : H - 1;
        for (let x = 0; x < W; x++) {
          const x0 = x > 0 ? x - 1 : 0, x1 = x < W - 1 ? x + 1 : W - 1;
          let r0 = 255, r1 = 0, g0 = 255, g1 = 0, b0 = 255, b1 = 0;
          for (let yy = y0; yy <= y1; yy++) {
            for (let xx = x0; xx <= x1; xx++) {
              const p = yy * W + xx;
              if (R[p] < r0) r0 = R[p]; if (R[p] > r1) r1 = R[p];
              if (G[p] < g0) g0 = G[p]; if (G[p] > g1) g1 = G[p];
              if (B[p] < b0) b0 = B[p]; if (B[p] > b1) b1 = B[p];
            }
          }
          const rr = r1 - r0, gg = g1 - g0, bb = b1 - b0;
          out[y * W + x] = rr > gg ? (rr > bb ? rr : bb) : (gg > bb ? gg : bb);
        }
      }
      return out;
    })();
    // 抗锯齿斜坡：目标色正好夹在"相邻两个区块的纯色"之间 ⇒ 这是渲染毛边，不是内容。
    // 补它 = 用一堆点去描一条毛边（笔数成千上万，成品还是毛的），不补 = 干净的硬边（人才这么画）。
    const rampPix = (() => {
      const m = new Uint8Array(N);
      if (!opts.resRampSkip || (opts.photoMode && !opts.resSkipRampPhoto)) return m;
      const colOf = new Map();
      for (const rg of regions) colOf.set(rg.cid, rg.color);
      const DX = [1, -1, 0, 0], DY = [0, 0, 1, -1];
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const p = y * W + x, c0 = compOf[p];
          let a = -1, b = -1;
          for (let d = 0; d < 4; d++) {
            for (let s = 1; s <= 3; s++) {
              const xx = x + DX[d] * s, yy = y + DY[d] * s;
              if (xx < 0 || xx >= W || yy < 0 || yy >= H) break;
              const cq = compOf[yy * W + xx];
              if (cq === c0) continue;
              if (a < 0) a = cq; else if (cq !== a && b < 0) b = cq;
              break;
            }
          }
          if (a < 0 || b < 0) continue;
          const A = colOf.get(a), Bv = colOf.get(b);
          if (!A || !Bv) continue;
          const vx = Bv[0] - A[0], vy = Bv[1] - A[1], vz = Bv[2] - A[2];
          const vv = vx * vx + vy * vy + vz * vz;
          if (vv < 400) continue;                        // 两边颜色太近：无所谓补不补
          const px2 = R[p] - A[0], py2 = G[p] - A[1], pz2 = B[p] - A[2];
          const t = (px2 * vx + py2 * vy + pz2 * vz) / vv;
          if (t <= 0.12 || t >= 0.88) continue;          // 不在两色之间（更靠某一侧）⇒ 不是毛边
          const dx2 = px2 - t * vx, dy2 = py2 - t * vy, dz2 = pz2 - t * vz;
          if (Math.abs(dx2) + Math.abs(dy2) + Math.abs(dz2) <= opts.rampTol) m[p] = 1;
        }
      }
      return m;
    })();
    let inkDrawn = false;
    let deadScan = null;   // 像素 → 最后画上它的笔号（回放/补笔时顺手记的，收尾删"零贡献笔"用）
    let curStroke = -1;    // 当前正在落色的笔号（给 deadScan 用）
    if ((opts.residual && opts.residual.length) || opts.returnCanvas || opts.returnKeys) {
      const canvas = new Uint8Array(N * 3);
      canvas.fill(255);
      if (opts.dropDead || opts.debug) deadScan = new Int32Array(N).fill(-1);
      const raster = (ribArr, color, clipIdx) => {
        const cl = clips[clipIdx];
        // 这一笔实际改了多少画布（Σ 每像素最大通道差）：回放按“看得见多少”分时间
        let visSum = 0;
        let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
        for (let i = 0; i + 1 < ribArr.length; i += 2) {
          const x = ribArr[i], y = ribArr[i + 1];
          if (x < xmin) xmin = x; if (x > xmax) xmax = x;
          if (y < ymin) ymin = y; if (y > ymax) ymax = y;
        }
        xmin = Math.max(cl.x, Math.floor(xmin)); ymin = Math.max(cl.y, Math.floor(ymin));
        xmax = Math.min(cl.x + cl.w - 1, Math.ceil(xmax)); ymax = Math.min(cl.y + cl.h - 1, Math.ceil(ymax));
        if (xmax < xmin || ymax < ymin) return;
        const mw = xmax - xmin + 1, mh = ymax - ymin + 1;
        const np2 = ribArr.length >> 1;
        const pts = new Float64Array(np2 * 2);
        for (let i = 0; i < np2; i++) { pts[i * 2] = ribArr[i * 2] - xmin; pts[i * 2 + 1] = ribArr[i * 2 + 1] - ymin; }
        // 光栅口径（老坑，见 README）：网页端是"画布多边形抗锯齿 ∩ 1 位硬遮罩"，
        // 所以这里也按覆盖率算——盖不到 coverMin 的像素就当"没画上"（保守），
        // 宁可让下一轮补笔/补漏把它补实，也不能让网页端留个半白的点。
        const cov = new Float32Array(mw * mh);
        fillPolyCov(cov, mw, mh, pts, opts.coverSubY || 1);
        for (let y = 0; y < mh; y++) {
          const yy = ymin + y;
          const rowC = (yy - cl.y) * cl.w;
          for (let x = 0; x < mw; x++) {
            let al = cov[y * mw + x];
            if (al <= 0) continue;
            if (!opts.featherRaster) al = al >= opts.coverMin ? 1 : 0;
            if (al <= 0) continue;
            const xx = xmin + x;
            if (!cl.mask[rowC + (xx - cl.x)]) continue;
            const pp = yy * W + xx;
            if (deadScan && curStroke >= 0) {
              // 一笔"在最终画布上零贡献"才允许删——但它要是**被别的图层**盖住的（不是被本层
              // 后来的笔盖住的），删掉就会在"那一层刚画完"那一帧留一个洞：底色层实测有 19 笔
              // 是被后面的图层盖住的，删完底色帧上就是 7623 个白点（0.92%）——用户看到的
              // "底色没涂满"。凡是"曾经被别的层盖过"的笔，一律不删。
              // 一笔"在最终画布上零贡献"才允许删——但它要是**被别的图层**盖住的（不是被本层
              // 后来的笔盖住的），删掉就会在"那一层刚画完"那一帧留一个洞：底色层实测有 19 笔
              // 是被后面的图层盖住的，删完底色帧上就是 7623 个白点（0.92%）——用户看到的
              // "底色没涂满"。凡是"曾经被别的层盖过"的笔，一律不删。
              const pv = deadScan[pp];
              if (pv >= 0 && pv !== curStroke) {
                const rs = strokes[pv];
                if (rs && rs.ly !== curLayer) rs.prot = 1;
              }
              deadScan[pp] = curStroke;   // 最后画上这个像素的笔
            }
            const oR = canvas[pp * 3], oG = canvas[pp * 3 + 1], oB = canvas[pp * 3 + 2];
            if (al >= 0.995) {
              canvas[pp * 3] = color[0]; canvas[pp * 3 + 1] = color[1]; canvas[pp * 3 + 2] = color[2];
            } else {
              canvas[pp * 3] = oR * (1 - al) + color[0] * al;
              canvas[pp * 3 + 1] = oG * (1 - al) + color[1] * al;
              canvas[pp * 3 + 2] = oB * (1 - al) + color[2] * al;
            }
            const dR = Math.abs(canvas[pp * 3] - oR);
            const dG = Math.abs(canvas[pp * 3 + 1] - oG);
            const dB = Math.abs(canvas[pp * 3 + 2] - oB);
            visSum += dR > dG ? (dR > dB ? dR : dB) : (dG > dB ? dG : dB);
          }
        }
        if (curStroke >= 0) {
          const rec = strokes[curStroke];
          if (rec) rec.vis = (rec.vis || 0) + visSum;
        }
      };
      // 关键帧：主笔过程中每 1/K 张快照，方便网页端拖动进度（当然也在跑完时快照一张）
      // 顺带（免费）记下"每个像素最后是被哪一笔画上的"（见 raster 里的 deadScan）：收尾用它删零贡献笔
      const keysOut = [];
      const kEvery = Math.max(1, Math.ceil(strokes.length / (opts.keyFrames || 5)));
      for (let i0 = 0; i0 < strokes.length; i0++) {
        const st0 = strokes[i0];
        curStroke = i0;
        raster(st0.rib, st0.color, st0.c);
        if ((i0 + 1) % kEvery === 0) keysOut.push({ i: i0 + 1, rgb: canvas.slice() });
      }
      if (!keysOut.length || keysOut[keysOut.length - 1].i !== strokes.length) {
        keysOut.push({ i: strokes.length, rgb: canvas.slice() });
      }
      // 按"产出站点"计数（诊断用：哪一段在刷笔数）
      const SRC = { batch: 0, resRibbon: 0, holeRibbon: 0, holeDab: 0, holeRect: 0 };
      dbg.rounds = [];
      dbg.src = SRC;
      // 外框笔形一定盖满自己的掩膜 ⇒ 直接按掩膜落色（等价，省掉在一整块大外框上跑覆盖光栅）
      const rasterMask = (clipIdx, color) => {
        const cl = clips[clipIdx];
        let visSum = 0;
        for (let y = 0; y < cl.h; y++) {
          const rowC = y * cl.w, row = (cl.y + y) * W;
          for (let x = 0; x < cl.w; x++) {
            if (!cl.mask[rowC + x]) continue;
            const pp = row + cl.x + x;
            if (deadScan && curStroke >= 0) {
              const pv = deadScan[pp];
              if (pv >= 0 && pv !== curStroke) {
                const rs = strokes[pv];
                if (rs && rs.ly !== curLayer) rs.prot = 1;
              }
              deadScan[pp] = curStroke;
            }
            const oR = canvas[pp * 3], oG = canvas[pp * 3 + 1], oB = canvas[pp * 3 + 2];
            canvas[pp * 3] = color[0]; canvas[pp * 3 + 1] = color[1]; canvas[pp * 3 + 2] = color[2];
            const dR = Math.abs(color[0] - oR), dG = Math.abs(color[1] - oG), dB = Math.abs(color[2] - oB);
            visSum += dR > dG ? (dR > dB ? dR : dB) : (dG > dB ? dG : dB);
          }
        }
        if (curStroke >= 0) {
          const rec = strokes[curStroke];
          if (rec) rec.vis = (rec.vis || 0) + visSum;
        }
      };
      const emitRaster = (rib, pathPts, nPath, halfW, col, pen, cIdx, ph, maskOnly) => {
        const rec = emitStroke(rib, rib.length / 2, pathPts, nPath, halfW, col, pen, cIdx, -1, ph);
        rec.src = dbg.srcSite || 'holeDab';       // 诊断：这一笔是哪一段产出的（行程/笔数分解用）
        dbg.src[dbg.srcSite || 'holeDab']++;
        curStroke = strokes.length - 1;
        if (maskOnly) rasterMask(rec.c, rec.color);
        else raster(rec.rib, rec.color, rec.c);
        return rec;
      };
      const TILE = 72;
      // 瓦片按"所属对象"排序：残差补笔也走"一个对象补完再补下一个"，
      // 不再全画面从上到下扫（那样笔尖会一直跨对象来回跳）
      const tileList = [];
      for (let ty = 0; ty < H; ty += TILE) {
        for (let tx = 0; tx < W; tx += TILE) {
          const mx = Math.min(W - 1, tx + (TILE >> 1)), my = Math.min(H - 1, ty + (TILE >> 1));
          tileList.push({ tx, ty, o: objOfComp[compOf[my * W + mx]] });
        }
      }
      tileList.sort((a, b) => a.o - b.o || a.ty - b.ty || a.tx - b.tx);
      // ---- 补丁合并池（残差补笔、收尾补漏共用）：笔数从几万降到几千的主要手段 ----
      // 补笔里绝大多数是 5~16px 的"小点"，一拍一笔，照片类能拍出两万个单点笔。
      // 但每一笔的笔形最终都会被它自己的 1 位裁剪掩膜裁掉多余部分 —— 也就是
      // "笔形只要盖住自己的掩膜"就够。于是把"同一格、颜色同一个桶"的补丁并成一笔：
      // 掩膜取并集、笔形取并集外框（再外扩 0.5px 保证盖住每个像素中心）、颜色取桶内加权均值。
      // 各补丁的掩膜互不相交 ⇒ 谁也没盖住谁 ⇒ 合并只带来"每通道 ≤ 半个桶宽"的取色偏差，
      // 换来笔数少一个数量级（桶宽可调：patchShift；空间粒度：patchCell）。
      const makePool = (cellOv, shiftOv, tolOv, boxOv) => {
        const CEL = Math.max(16, (cellOv === undefined ? opts.patchCell : cellOv) | 0);
        const pShift = shiftOv === undefined ? opts.patchShift : shiftOv;
        const pTol = tolOv === undefined ? opts.patchTol : tolOv;
        const BX = boxOv === undefined ? opts.patchBox : boxOv;
        const pool = new Map();
        let nOut = 0, nIn = 0, maxG = 0;
        const flushGroup = (g, ph) => {
          const mw = g.x1 - g.x0 + 1, mh = g.y1 - g.y0 + 1;
          const m = new Uint8Array(mw * mh);
          for (const p of g.parts) {
            for (let y = 0; y < p.h; y++) {
              const src = y * p.w, dst = (p.y - g.y0 + y) * mw + (p.x - g.x0);
              for (let x = 0; x < p.w; x++) if (p.m[src + x]) m[dst + x] = 1;
            }
          }
          const cIdx = pushClip(g.x0, g.y0, mw, mh, m);
          const ex0 = g.x0 - 0.5, ey0 = g.y0 - 0.5, ex1 = g.x1 + 1.5, ey1 = g.y1 + 1.5;
          const rect = [ex0, ey0, ex1, ey0, ex1, ey1, ex0, ey1];
          // 笔尖轨迹：按"就近串"把这一组点连起来，回放时看着像手在一个地方点点
          const n = g.px.length;
          const ord = n >= 3 ? chainNN(g.px.map((_, i) => i), (i) => [g.px[i], g.py[i]], g.px[0], g.py[0]) : null;
          const tp = [];
          for (let k = 0; k < n; k++) { const i = ord ? ord[k] : k; tp.push(g.px[i], g.py[i]); }
          const col = [Math.round(g.cr / g.cn), Math.round(g.cg / g.cn), Math.round(g.cb / g.cn)];
          dbg.srcSite = 'batch';
          const rec = emitRaster(rect, tp, n, 4.2, col, 0, cIdx, ph, true);
          rec.g = n;                      // 这一笔合了几个补丁（诊断用）
          nOut++;
        };
        return {
          add(col, x0, y0, x1, y1, mw, mh, mask, cx, cy, cnt) {
            // 自适应色差（patchTol > 0）：不再只认"固定色桶"，而是跟"这一组当前的均值色"比。
            // 固定色桶的毛病是桶宽必须卡在可见阈值以内（否则补上去还是错），于是同一个地方
            // 颜色略差一点的补丁就各成一笔，合并比只有 1.7:1；改成跟均值色比之后，
            // 只要彼此差得开（≤ patchTol）就能并进同一笔，均值色本身仍贴着每个补丁。
            // 开着自适应色差时色桶反而要**放粗**（候选多、再由均值色判据收紧），
            // 否则色桶先把自己卡死，自适应就白搭了
            const sh = pTol > 0 ? Math.min(7, pShift + 1) : pShift;
            const key = (((y0 / CEL) | 0) * 4096 + ((x0 / CEL) | 0)) + '|' +
                        (col[0] >> sh) + ',' + (col[1] >> sh) + ',' + (col[2] >> sh);
            if (opts.debug) {   // 诊断：补丁到底散落在多少个色阶桶里（桶数 ≈ 合并下限）
              const bk = (col[0] >> sh) + ',' + (col[1] >> sh) + ',' + (col[2] >> sh);
              (dbg.bk || (dbg.bk = new Set())).add(bk);
            }
            let list = pool.get(key);
            if (!list) { list = []; pool.set(key, list); }
            // 同一格同一色桶可以有好几组：谁能"装下"这个补丁就并进谁。
            // 两个门槛：外框不得超过 patchBox（网页端每一笔要清/合的画布、掩膜内存都看它），
            // 外框面积还不得超过 patchFill 允许的"稀疏度"（外框涨得比补丁多 → 掩膜全是被浪费的空白，
            // 而散点补丁本来就该并成一大笔：密度判据比"外框边长"省内存得多）。
            let g = null, gArea = Infinity;
            let nCand = 0, nBox = 0, nTol = 0;
            for (let li = 0; li < list.length; li++) {
              const gg = list[li];
              const bw = Math.max(gg.x1, x1) - Math.min(gg.x0, x0) + 1;
              const bh = Math.max(gg.y1, y1) - Math.min(gg.y0, y0) + 1;
              nCand++;
              if (bw > BX || bh > BX) { nBox++; continue; }
              if (pTol > 0) {   // 与组均值色的曼哈顿距离上限（超了就不许并）
                const d = Math.abs(col[0] - gg.cr / gg.cn) + Math.abs(col[1] - gg.cg / gg.cn) +
                          Math.abs(col[2] - gg.cb / gg.cn);
                if (d > pTol) { nTol++; continue; }
              }
              const area = bw * bh;
              if (area < gArea) { g = gg; gArea = area; }   // 挑"并进去之后外框最小"的一组，装得最满
            }
            if (opts.debug) {   // 诊断：补丁合并不上的原因（外框超限 / 色差超限 / 同键里根本没别的组）
              const R2 = dbg.poolRej || (dbg.poolRej = { key: 0, box: 0, tol: 0, ok: 0, cand: 0 });
              R2.cand += nCand;
              if (!list.length) R2.key++;
              else if (!nCand) R2.key++;
              else if (!g && nBox && !nTol) R2.box++;
              else if (!g && nTol) R2.tol++;
              else if (g) R2.ok++;
            }
            if (!g) { g = { cr: 0, cg: 0, cb: 0, cn: 0, pa: 0, x0, y0, x1, y1, parts: [], px: [], py: [] }; list.push(g); }
            if (x0 < g.x0) g.x0 = x0; if (y0 < g.y0) g.y0 = y0;
            if (x1 > g.x1) g.x1 = x1; if (y1 > g.y1) g.y1 = y1;
            g.cr += col[0] * cnt; g.cg += col[1] * cnt; g.cb += col[2] * cnt; g.cn += cnt; g.pa += cnt;
            g.parts.push({ x: x0, y: y0, w: mw, h: mh, m: mask });
            g.px.push(cx); g.py.push(cy);
            if (g.parts.length > maxG) maxG = g.parts.length;
            nIn++;
            // 一组别太大：回放更细、就近串也不至于变慢
            if (g.parts.length >= 360) { flushGroup(g, this._ph); list.splice(list.indexOf(g), 1); }
          },
          flush(ph) {
            this._ph = ph;
            // 落盘顺序按"就近串"走：回放时笔尖是在一片地方点点，不是全画面乱跳。
            // 只改顺序，不改任何像素结果——各组掩膜互不相交，谁也没盖住谁。
            const all = [];
            for (const list of pool.values()) for (const g of list) if (g.parts.length) all.push(g);
            const HB = 10;    // 最大边 1024 ⇒ 10 bit 够（更长的边会被夹到边界，仍然有序）
            if (all.length > 400) {
              // 沿希尔伯特序走：笔尖一片一片挪过去，不再按 (y,x) 横扫整幅
              for (const g of all) g.h = hilbertIndex((g.x0 + g.x1) >> 1, (g.y0 + g.y1) >> 1, HB);
              all.sort((a, b) => a.h - b.h);
              for (const g of all) flushGroup(g, ph);
            } else if (all.length > 1) {
              const used = new Uint8Array(all.length);
              let cx = lastPen.x, cy = lastPen.y;
              for (let k = 0; k < all.length; k++) {
                let best = -1, bd = Infinity;
                for (let i = 0; i < all.length; i++) {
                  if (used[i]) continue;
                  const g = all[i];
                  const dx = (g.x0 + g.x1) * 0.5 - cx, dy = (g.y0 + g.y1) * 0.5 - cy;
                  const d = dx * dx + dy * dy;
                  if (d < bd) { bd = d; best = i; }
                }
                used[best] = 1;
                const g = all[best];
                flushGroup(g, ph);
                cx = (g.x0 + g.x1) * 0.5; cy = (g.y0 + g.y1) * 0.5;
              }
            } else if (all.length) {
              flushGroup(all[0], ph);
            }
            pool.clear();
            return nOut;
          },
          stat() { return { out: nOut, in: nIn, maxG }; },
        };
      };
      let prevPct = 999;
      let nPieces = 0;   // 轮次预算按"补笔个数"算（从 0 起算：主笔已经花掉的预算不该算在补笔头上，
                         // 否则主笔一多，补笔就被预算砍在半路——实测 s2 只补了 5 轮就停了，差 15 个点）
                             // 合并成笔后笔数会变少，若按笔数算，合并本身会让补笔多跑一轮，
                             // 质量变好但耗时变长——那属于另一件事，不该被"省笔"顺手带出来
      const nSched = opts.residual.length;
      const nRounds = nSched + (opts.resTail | 0);
      let dArr = null;   // 轮末存下的"每像素最大通道差"，供下一轮的 skip 复用（见下面的注释）
      for (let round = 0; round < nRounds; round++) {
        // 预算闸门：排定轮次（粗→细的固定档）用完就停，但**尾巴轮**（自适应续补）只要还有收益就走，
        // 否则"还没收敛就被预算砍掉"——那正是老版本海报停在 20%、照片停在 29% 的原因。
        const inTail = round >= nSched;
        if (!inTail && nPieces > opts.maxStrokes) break;
        if (inTail && nPieces > opts.maxStrokes * opts.resTailMax) break;
        // 前两轮是"收形"（把轮廓/边缘修准），后面几轮是"点睛"（抠细节，手更慢更细）
        const phR = round < 2 ? 2 : 3;
        const thr = inTail
          ? Math.max(opts.resTailMin, opts.residual[nSched - 1] - (round - nSched + 1) * opts.resTailStep)
          : opts.residual[round];
        let added = 0;
        const pool = makePool();
        const addPatch = pool.add;
        const flushBatch = () => { pool.flush(phR); };
        const nBatch = () => pool.stat().out;
        // 全图错误掩膜：把"又大又厚"的错误块（大片平滑渐变差异）排除在补笔之外，
        // 否则会按 72px 小格补出块状拼贴
        lap('r:begin');
        const skip = new Uint8Array(N);
        {
          // "最大通道差"整幅重算一遍是这里最贵的一步（百万像素 × 3 通道）。
          // 轮末算"可见差异"时反正要算一次，顺手存进 dArr 留给下一轮用 ——
          // 两处看的是同一份画布（中间只有 prog/yieldUI，不改像素），
          // 所以这里只做一次比较（dArr > thr），结果完全一样。
          if (!dArr) {
            dArr = new Uint8Array(N);
            for (let i2 = 0; i2 < N; i2++) {
              dArr[i2] = Math.max(Math.abs(canvas[i2 * 3] - R[i2]),
                                  Math.abs(canvas[i2 * 3 + 1] - G[i2]),
                                  Math.abs(canvas[i2 * 3 + 2] - B[i2]));
            }
          }
          const wrongAll = new Uint8Array(N);
          for (let i2 = 0; i2 < N; i2++) if (dArr[i2] > thr) wrongAll[i2] = 1;
          const wcc = compsOfLabels(wrongAll, W, H);
          for (let ci = 0; ci < wcc.comps.length; ci++) {
            const c = wcc.comps[ci];
            if (c.label !== 1) continue;
            // "厚度"要用距离变换算**真实厚度**（2×最大内切半径），不能用 面积÷外框边长：
            // 字母/飞机那圈深色描边是"细环"，按面积÷外框能算出 46px 的假厚度 ⇒ 整条描边被
            // 当成"大片平滑渐变"跳过，永远不补（用户看到的"边被啃"里就有一条是这个）。
            const thick = compThick(c, wcc.pix);
            if (c.count > 2500 && thick > opts.resThick * strokeScale) {
              for (let k = 0; k < c.count; k++) skip[wcc.pix[c.start + k]] = 1;
            }
          }
        }
        lap('r:skip');
        for (let ti = 0; ti < tileList.length && added < 6000; ti++) {
          const tx = tileList[ti].tx, ty = tileList[ti].ty;
          {
            const tw = Math.min(TILE, W - tx), th = Math.min(TILE, H - ty);
            const wrong = new Uint8Array(tw * th);
            let any = 0;
            for (let y = 0; y < th; y++) {
              for (let x = 0; x < tw; x++) {
                const pp = (ty + y) * W + (tx + x);
                const d = Math.max(Math.abs(canvas[pp * 3] - R[pp]),
                                   Math.abs(canvas[pp * 3 + 1] - G[pp]),
                                   Math.abs(canvas[pp * 3 + 2] - B[pp]));
                // 细线像素跳过：它们留到最后由细线层"写"上去，残差补笔不用在这里重复劳动
                // 斜坡像素（抗锯齿毛边）和"平滑区的小误差"也跳过：那不是内容，描它只会描出鬼影
                if (d > thr && !skip[pp] && !((inkGuard[pp] || thinGuard[pp]) && d <= opts.inkGuardErr) && !(opts.resSkipInk && inkPix[pp]) && !(opts.resSkipRamp && rampPix[pp]) &&
                    !(opts.resFlatTol > 0 && flatRng[pp] <= opts.resFlatTol && d <= opts.resFlatErr) &&
                    !(opts.texResSkip && texPix[pp] && !edgeNear[pp])) { wrong[y * tw + x] = 1; any++; }
              }
            }
            if (any < 5) continue;
            const cc = compsOfLabels(wrong, tw, th);
            const toX = (lp) => tx + (lp % tw);
            const toY = (lp) => ty + ((lp / tw) | 0);
            for (let ci = 0; ci < cc.comps.length; ci++) {
              const c = cc.comps[ci];
              if (c.label !== 1 || c.count < 5) continue;
              // 按颜色分裂（方差最大通道二分，最多 3 层）
              const parts = [];
              (function split(st, cnt, depth) {
                if (depth >= 4 || cnt < 9) { parts.push([st, cnt]); return; }
                let mn0 = 255, mn1 = 255, mn2 = 255, mx0 = 0, mx1 = 0, mx2 = 0;
                for (let k = 0; k < cnt; k++) {
                  const pp = toY(cc.pix[st + k]) * W + toX(cc.pix[st + k]);
                  if (R[pp] < mn0) mn0 = R[pp]; if (R[pp] > mx0) mx0 = R[pp];
                  if (G[pp] < mn1) mn1 = G[pp]; if (G[pp] > mx1) mx1 = G[pp];
                  if (B[pp] < mn2) mn2 = B[pp]; if (B[pp] > mx2) mx2 = B[pp];
                }
                const s0 = mx0 - mn0, s1 = mx1 - mn1, s2 = mx2 - mn2;
                const smax = Math.max(s0, s1, s2);
                // 颜色散布不超过它就不切了：补上去用的是这一份的均值色，
                // 所以这个数直接决定"最后一公里"能压到多少（18 ⇒ 残差 ~9，正好卡在可见阈值上；
                // 降到 8 ⇒ 残差 ~4，代价是补丁数变多）
                if (smax <= opts.resSplit) { parts.push([st, cnt]); return; }
                const ch = s0 === smax ? 0 : (s1 === smax ? 1 : 2);
                const vals = new Float64Array(cnt);
                for (let k = 0; k < cnt; k++) {
                  const pp = toY(cc.pix[st + k]) * W + toX(cc.pix[st + k]);
                  vals[k] = ch === 0 ? R[pp] : (ch === 1 ? G[pp] : B[pp]);
                }
                const sorted = Array.from(vals).sort((a, b) => a - b);
                const med = sorted[cnt >> 1];
                let i = 0, j = cnt - 1;
                while (i <= j) {
                  if (vals[i] <= med) i++;
                  else {
                    const ti = cc.pix[st + i]; cc.pix[st + i] = cc.pix[st + j]; cc.pix[st + j] = ti;
                    const tv = vals[i]; vals[i] = vals[j]; vals[j] = tv; j--;
                  }
                }
                if (i === 0 || i === cnt) { parts.push([st, cnt]); return; }
                split(st, i, depth + 1);
                split(st + i, cnt - i, depth + 1);
              })(c.start, c.count, 0);

              // 颜色分裂后的每一份再按连通切开（避免"散点连成一条长笔"）。
              // 老实现是**对整张 72×72 瓦片**做一次连通（pm 每次新建 tw×th），一份就一次；
              // 照片类一轮几千份，这里就是最大的耗时点。改成只在"这一份自己的外框"里做连通。
              const pieces = [];      // 每项 = 一份的瓦片内像素下标
              for (const part of parts) {
                const st = part[0], cnt = part[1];
                if (cnt < 5) continue;
                let px0 = tw, py0 = th, px1 = -1, py1 = -1;
                for (let k = 0; k < cnt; k++) {
                  const lp = cc.pix[st + k], xx = lp % tw, yy = (lp / tw) | 0;
                  if (xx < px0) px0 = xx; if (xx > px1) px1 = xx;
                  if (yy < py0) py0 = yy; if (yy > py1) py1 = yy;
                }
                const bw = px1 - px0 + 1, bh = py1 - py0 + 1;
                // 本来就小、或者本来就紧凑（填充率高）的一份，不必再切连通
                if (cnt < 40 || cnt / (bw * bh) > 0.4) {
                  const arr = new Int32Array(cnt);
                  for (let k = 0; k < cnt; k++) arr[k] = cc.pix[st + k];
                  pieces.push(arr);
                  continue;
                }
                const pm = new Uint8Array(bw * bh);
                for (let k = 0; k < cnt; k++) {
                  const lp = cc.pix[st + k];
                  pm[(((lp / tw) | 0) - py0) * bw + ((lp % tw) - px0)] = 1;
                }
                const pc = compsOfLabels(pm, bw, bh);
                for (let j = 0; j < pc.comps.length; j++) {
                  const c2 = pc.comps[j];
                  if (c2.label !== 1 || c2.count < 5) continue;
                  const arr = new Int32Array(c2.count);
                  for (let k = 0; k < c2.count; k++) {
                    const lp = pc.pix[c2.start + k];
                    arr[k] = (py0 + ((lp / bw) | 0)) * tw + (px0 + (lp % bw));
                  }
                  pieces.push(arr);
                }
              }
              for (const idxArr of pieces) {
                const cnt = idxArr.length;
                if (cnt < 5) continue;
                let cr = 0, cg = 0, cb = 0;
                let x0 = W, y0 = H, x1 = -1, y1 = -1;
                for (let k = 0; k < cnt; k++) {
                  const lp = idxArr[k];
                  const xx = toX(lp), yy = toY(lp);
                  const pp = yy * W + xx;
                  cr += R[pp]; cg += G[pp]; cb += B[pp];
                  if (xx < x0) x0 = xx; if (xx > x1) x1 = xx;
                  if (yy < y0) y0 = yy; if (yy > y1) y1 = yy;
                }
                const col = [Math.round(cr / cnt), Math.round(cg / cnt), Math.round(cb / cnt)];
                const pad = 0;
                const bx = Math.max(0, x0 - pad), by = Math.max(0, y0 - pad);
                const bx1 = Math.min(W - 1, x1 + pad), by1 = Math.min(H - 1, y1 + pad);
                const mw = bx1 - bx + 1, mh = by1 - by + 1;
                const bin = new Uint8Array(mw * mh);
                for (let k = 0; k < cnt; k++) {
                  const lp = idxArr[k];
                  bin[(toY(lp) - by) * mw + (toX(lp) - bx)] = 1;
                }
                const clipMask = dilate(bin, mw, mh, pad);
                const cx0 = (x0 + x1) / 2, cy0 = (y0 + y1) / 2;
                if (cnt <= opts.resPatchMax) {         // 小点：并进"同色同格"的补丁笔（见 addPatch）
                  addPatch(col, bx, by, bx1, by1, mw, mh, bin, cx0, cy0, cnt);
                  added++;
                  continue;
                }
                const cIdx = pushClip(bx, by, mw, mh, clipMask);
                const dt = distanceTransform(bin, mw, mh);
                const dvals = Array.from(dt).sort((a, b) => a - b);
                const dmed = dvals[dvals.length >> 1];
                const half = clamp(dmed * opts.resHalfA + opts.resHalfB, opts.resMin * strokeScale, 8 * strokeScale);
                const sk2 = thin(bin, mw, mh).sk;
                const lp = longestPath(sk2, mw, mh);
                if (lp && lp.len >= 2) {
                  const absPath = new Float64Array(lp.len * 2);
                  for (let i = 0; i < lp.len; i++) {
                    absPath[i * 2] = lp.pts[i * 2] + bx;
                    absPath[i * 2 + 1] = lp.pts[i * 2 + 1] + by;
                  }
                  {
                    const segs = pathSegments(absPath, lp.len, Math.max(18, half * opts.segF));
                    const cols = [];
                    for (const sg of segs) {
                      if (sg.n < 2) { cols.push(null); continue; }
                      cols.push(sampleColor(ribbon(sg.pts, sg.n, half), sg.pts.length, bin, bx, by, mw, mh) || col);
                    }
                    let i2 = 0;
                    while (i2 < segs.length) {
                      let j2 = i2;
                      while (j2 + 1 < segs.length && cols[j2 + 1] && cols[i2] &&
                             Math.abs(cols[j2 + 1][0] - cols[i2][0]) +
                             Math.abs(cols[j2 + 1][1] - cols[i2][1]) +
                             Math.abs(cols[j2 + 1][2] - cols[i2][2]) < opts.segJoinCd) j2++;
                      const pts2 = [];
                      for (let k2 = i2; k2 <= j2; k2++) {
                        const P2 = segs[k2].pts;
                        for (let m2 = 0; m2 < P2.length; m2++) pts2.push(P2[m2]);
                      }
                      const arr2 = Float64Array.from(pts2);
                      if (arr2.length >= 4) {
                        const rb = ribbon(arr2, arr2.length / 2, half);
                        dbg.srcSite = 'resRibbon';
                        emitRaster(rb, arr2, arr2.length / 2, half, cols[i2] || col, 0, cIdx, phR);
                        added++;
                      }
                      i2 = j2 + 1;
                    }
                  }
                } else {                               // 没有骨架（奇形怪状的小块）：也并进补丁笔
                  addPatch(col, bx, by, bx1, by1, mw, mh, clipMask, cx0, cy0, cnt);
                  added++;
                }
              }
            }
          }
        }
        lap('r:tiles');
        flushBatch();          // 本轮攒下的补丁笔在这里落盘（像素结果与逐个补一致，只差半个色阶）
        lap('r:flush');
        nPieces += added;
        mark('残差' + (round + 1));
        // 一次算完"每像素最大通道差"和"可见差异计数"：dArr 留给下一轮的 skip 用
        let bad = 0;
        for (let i = 0; i < N; i++) {
          const d = Math.max(Math.abs(canvas[i * 3] - R[i]), Math.abs(canvas[i * 3 + 1] - G[i]), Math.abs(canvas[i * 3 + 2] - B[i]));
          dArr[i] = d;
          if (d > 8) bad++;
        }
        const pct = bad / N * 100;
        if (dbg.rounds) dbg.rounds.push({ r: round, thr, 补丁: added, 笔: nBatch(), 差异: +pct.toFixed(2), nPieces, max: opts.maxStrokes, inTail: inTail ? 1 : 0 });
        prog(0.78 + 0.2 * (round + 1) / opts.residual.length,
             (phR === 2 ? "收形补笔…" : "点睛补细节…") + " 第 " + (round + 1) + " 轮（" +
             nBatch() + " 笔，可见差异 " + pct.toFixed(2) + "%）");
        if (pct < 1.0) break;
        if (opts.resStop > 0 && prevPct - pct < opts.resStop && round >= 1) break;   // 收益变小就收手
        if (inTail && prevPct - pct < opts.resTailStop) break;    // 尾巴轮：收益掉到阈值以下就收手
        prevPct = pct;
        await yieldUI();
      }

      lap('residual');

      // ---- 8d) 题字落款（最后一拨细线）：贴在对象上的细线（猫嘴、字的描边）
      //      已经在铺色时跟着各自的对象画完了；这里只写"落在底上的"——
      //      题字、落款、印在底色上的小字，按行、按块一个个写出来。
      //      注意：这里仍按原来的顺序落色（补漏要看到已经写好的字，否则会把字当成白点重补）；
      //      回放时再把带 fin 标记的这几笔移到最末，见函数末尾的“回放编排”。
      prog(0.985, '题字落款…'); await yieldUI();
      drawInkSeq(inkLastSeq, (rec) => {
        rec.fin = 1;
        curStroke = strokes.length - 1;
        raster(rec.rib, rec.color, rec.c);
      }, 3);
      inkDrawn = true;
      mark('细线');

      // ---- 收尾补漏：残差补笔为了不把平滑渐变补成拼贴，设了"太小不补、太散不补"的门槛，
      //      贴着大片差异的小洞也会被连带跳过。这里分两类补，保证画面不留白点、白线：
      //      A) 真空白——画布上这块还是白的（什么都没画到），而原图不是白的；不论大小都补
      //      B) 剩余的"小块/细条"错误——用厚度判定，大而厚的块仍跳过（那是平涂风格化本身）
      if (opts.holeFill) {
        const errAt = (i) => Math.max(Math.abs(canvas[i * 3] - R[i]),
                                      Math.abs(canvas[i * 3 + 1] - G[i]),
                                      Math.abs(canvas[i * 3 + 2] - B[i]));
        const hp = makePool();
        // 补一个连通块：大洞贴着它的形状走一条（或几条）笔，小洞并进补丁笔（见 hp.add）
        const fillComp = (comp, comps2) => {
          const parts = [];
          splitPixByColor(comps2.pix.subarray(comp.start, comp.start + comp.count), comp.count, 0, parts);
          for (const pt of parts) fillPart(pt.pix, pt.cnt);
        };
        const fillPart = (pix, cnt) => {
          let x0 = W, y0 = H, x1 = -1, y1 = -1;
          let cr = 0, cg = 0, cb = 0;
          for (let k = 0; k < cnt; k++) {
            const p = pix[k];
            const x = p % W, y = (p - x) / W;
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
            cr += R[p]; cg += G[p]; cb += B[p];
          }
          const mw = x1 - x0 + 1, mh = y1 - y0 + 1;
          const bin = new Uint8Array(mw * mh);
          for (let k = 0; k < cnt; k++) {
            const p = pix[k];
            const x = p % W, y = (p - x) / W;
            bin[(y - y0) * mw + (x - x0)] = 1;
          }
          const col = [Math.round(cr / cnt), Math.round(cg / cnt), Math.round(cb / cnt)];
          // 小洞并进补丁笔：掩膜取并集、笔形取并集外框（外扩 0.5px）—— 一定盖满自己的掩膜，
          // 所以比"沿骨架走一笔"更稳（骨架笔在细缝/拐角会盖不到像素中心，那正是白点的老坑）。
          if (cnt <= opts.holeBatchMax) {
            hp.add(col, x0, y0, x1, y1, mw, mh, bin, (x0 + x1) / 2, (y0 + y1) / 2, cnt);
            return;
          }
          // 严格只覆盖"确实画错/没画"的那些像素，不外扩——否则会把周围本来正确的像素也刷成均值色
          const cIdx = pushClip(x0, y0, mw, mh, bin);
          const dt = distanceTransform(bin, mw, mh);
          const dvals = Array.from(dt).sort((a, b) => a - b);
          const dmed = dvals[dvals.length >> 1];
          const half = clamp(dmed + 1.2 * strokeScale, 1.6 * strokeScale, 9 * strokeScale);
          const sk3 = thin(bin, mw, mh).sk;
          const lp = longestPath(sk3, mw, mh);
          if (lp && lp.len >= 2) {
            const absPath = new Float64Array(lp.len * 2);
            for (let i = 0; i < lp.len; i++) {
              absPath[i * 2] = lp.pts[i * 2] + x0;
              absPath[i * 2 + 1] = lp.pts[i * 2 + 1] + y0;
            }
            // 一笔画长一点（笔数省），颜色按段取局部目标色（长条上颜色是渐变的，用一个均值色会不准）
            const segLen = Math.max(24, opts.holeSeg * strokeScale);
            const segs = pathSegments(absPath, lp.len, segLen);
            for (const sg of segs) {
              if (sg.n < 2) continue;
              const rb = ribbon(sg.pts, sg.n, half);
              const cSeg = sampleColor(rb, rb.length / 2, bin, x0, y0, mw, mh) || col;
              dbg.srcSite = 'holeRibbon';
              emitRaster(rb, sg.pts, sg.n, half, cSeg, cSeg[0] < 120 ? 1 : 0, cIdx, 3);
            }
          } else {
            const cx0 = (x0 + x1) / 2, cy0 = (y0 + y1) / 2;
            const rad = clamp(Math.hypot(mw, mh) / 2 + 1.2 * strokeScale, 2.2, 10);
            const poly = [];
            for (let k = 0; k < 13; k++) {
              const a = k / 13 * Math.PI * 2;
              poly.push(cx0 + rad * Math.cos(a), cy0 + rad * Math.sin(a));
            }
            dbg.srcSite = 'holeDab';
            emitRaster(poly, [cx0, cy0], 1, rad, col, 0, cIdx, 3);
          }
          // 自检：沿骨架走的笔形在细缝/拐角/极扁的形状上可能盖不到像素中心（画了等于没画）。
          // 对"自检后仍然是白的"那些像素，用方点笔形（严格掩膜）兜底——方框一定包含像素中心。
          const left = [];
          for (let k = 0; k < cnt; k++) {
            const p = pix[k];
            const mn = Math.min(canvas[p * 3], canvas[p * 3 + 1], canvas[p * 3 + 2]);
            if (mn >= opts.holeWhite) left.push(p);
          }
          if (left.length) {
            let lx0 = W, ly0 = H, lx1 = -1, ly1 = -1, lr = 0, lg = 0, lb = 0;
            for (const p of left) {
              const x = p % W, y = (p - x) / W;
              if (x < lx0) lx0 = x; if (x > lx1) lx1 = x;
              if (y < ly0) ly0 = y; if (y > ly1) ly1 = y;
              lr += R[p]; lg += G[p]; lb += B[p];
            }
            const lcol = [Math.round(lr / left.length), Math.round(lg / left.length), Math.round(lb / left.length)];
            const lw = lx1 - lx0 + 1, lh = ly1 - ly0 + 1;
            const b2 = new Uint8Array(lw * lh);
            for (const p of left) { const x = p % W, y = (p - x) / W; b2[(y - ly0) * lw + (x - lx0)] = 1; }
            const cIdx2 = pushClip(lx0, ly0, lw, lh, b2);
            const gx0 = lx0 - 1, gy0 = ly0 - 1, gx1 = lx1 + 2, gy1 = ly1 + 2;   // 外扩 1px，保证像素中心在框内
            const rect = [gx0, gy0, gx1, gy0, gx1, gy1, gx0, gy1];
            dbg.srcSite = 'holeRect';
            emitRaster(rect, [gx0, (gy0 + gy1) / 2, gx1, (gy0 + gy1) / 2], 2,
                       Math.max(1.6, lh / 2 + 1), lcol, 0, cIdx2, 3);
          }
        };
        const fillMask = (mask, limit, maxAdd, errFn) => {
          const base = strokes.length;
          const cc2 = compsOfLabels(mask, W, H);
          const list = [];
          for (let ci = 0; ci < cc2.comps.length; ci++) if (cc2.comps[ci].label === 1) list.push(ci);
          if (errFn) {
            // 给了误差函数就按"总误差量"排（面积 × 平均误差），而不是只按面积：
            // 只按面积排的话，"小而刺眼"的漏笔（30px 的深色条）会被几千个大块挤到预算外——
            // 收尾自检里剩下的白点/亮点就是这么漏掉的
            const score = new Float64Array(cc2.comps.length);
            for (const ci of list) {
              const c = cc2.comps[ci];
              let sc = 0;
              for (let k = 0; k < c.count; k++) sc += errFn(cc2.pix[c.start + k]);
              score[ci] = sc;
            }
            list.sort((a, b) => score[b] - score[a]);
          } else {
            list.sort((a, b) => cc2.comps[b].count - cc2.comps[a].count);   // 先补大块（同预算下总误差降得多）
          }
          // 选中之后改成沿希尔伯特序落笔：补谁不变，只是笔尖不再在全画面乱跳
          const sel = list.slice(0, limit);
          sel.sort((a, b) => {
            const ca = cc2.comps[a], cb = cc2.comps[b];
            return hilbertIndex((ca.x0 + ca.x1) >> 1, (ca.y0 + ca.y1) >> 1, 10) -
                   hilbertIndex((cb.x0 + cb.x1) >> 1, (cb.y0 + cb.y1) >> 1, 10);
          });
          let n = 0;
          for (const ci of sel) {
            if (maxAdd && strokes.length - base >= maxAdd) break;
            fillComp(cc2.comps[ci], cc2); n++;
          }
          return n;
        };
        // A0) 接缝修正：画布上"不该有的台阶"。
        //     逐像素差查不出它——台阶两侧各自只差 5~7，都没到可见阈值 8；
        //     可两块交界处画布是"一级台阶"、原图是平滑过渡，肉眼看就是一道弧线/一条缝
        //     （用户说的"贴纸式缝隙"就是这一类）。判据：画布这一步的台阶 >> 原图这一步的台阶。
        if (opts.seamFix) {
          const T3 = [R, G, B];
          const band = new Uint8Array(N);
          let anySeam = 0;
          for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
              const p = y * W + x;
              let sc = 0, st = 0;
              for (let d = 0; d < 4; d++) {
                const q = d === 0 ? (x + 1 < W ? p + 1 : -1)
                        : d === 1 ? (x > 0 ? p - 1 : -1)
                        : d === 2 ? (y + 1 < H ? p + W : -1)
                        : (y > 0 ? p - W : -1);
                if (q < 0) continue;
                for (let k = 0; k < 3; k++) {
                  const dc = Math.abs(canvas[p * 3 + k] - canvas[q * 3 + k]);
                  const dt = Math.abs(T3[k][p] - T3[k][q]);
                  if (dc > sc) sc = dc;
                  if (dt > st) st = dt;
                }
              }
              // 原图这一步本来就平滑（st 很小）而画布是硬台阶 ⇒ 这是我们自己画出来的缝
              if (sc >= opts.seamT && st <= opts.seamSmooth) { band[p] = 1; anySeam++; }
            }
          }
          let nS = 0;
          if (anySeam) {
            const bandD = dilate(band, W, H, opts.seamR);
            const m = new Uint8Array(N);
            for (let p = 0; p < N; p++) {
              if (bandD[p] && errAt(p) > opts.seamE) { m[p] = 1; nS++; }
            }
            if (nS) { fillMask(m, 4000, 6000); hp.flush(3); }
          }
          dbg.seam = { band: anySeam, fix: nS };
        }

        // A) 真白点：**画布上这块还是白的**（没人画上去），而原图明显不是白的。
        //    以前按"几何上有没有笔盖到"判定，问题是照片里"没盖到"的像素成千上万，
        //    而补漏是按连通块从大到小取的，真正刺眼的 1~2px 白点排在最后，被数量门槛丢掉。
        //    改成"画布看着白 + 原图不该白"（肉眼口径），并迭代到收敛。
        let nA = 0;
        for (let roundA = 0; roundA < 3; roundA++) {
          const m = new Uint8Array(N);
          let any = 0;
          for (let i = 0; i < N; i++) {
            const cmn = Math.min(canvas[i * 3], canvas[i * 3 + 1], canvas[i * 3 + 2]);
            const tmn = Math.min(R[i], G[i], B[i]);
            // 两类白点：
            // ① 纸面根本没被涂上（三通道都 ≥ holePaper）——只要原图不是纯白就要补，
            //    这样"全满的图"成品上就不会再有没有上色的地方（哪怕原图那里很浅）；
            // ② 只被抗锯齿毛边蹭到 / 被浅色笔盖错（≥ holeWhite 而原图明显更深）。
            // 门槛必须满足"原图 ≤ 画布"，否则补上目标色后仍然算白，会反复补、补不掉。
            if (!((cmn >= opts.holeWhite && tmn < opts.holeWhite - 16) ||    // 半覆盖/被浅色盖错
                  (cmn >= opts.holePaper && tmn < opts.holePaper - 8))) continue;   // "整块白纸"才算这一条
            m[i] = 1; any++;
          }
          if (!any) break;
          const got = fillMask(m, 20000, 12000);
          nA += got;
          hp.flush(3);            // 本轮并起来的补丁笔在这里落笔（下一轮重扫白点前必须落完）
          if (!got) break;
          await yieldUI();
        }
        // B) 剩余的小块/细条错误（A 补完后重新算，已经补上的不再重复）。
        //    这里的阈值放宽一倍：照片这类纹理区里，一小块错误用的是一个均值色，
        //    补上去对块内偏暗的一半反而更差，所以只补"明显不对"的那部分。
        let nB = 0;
        // 迭代几轮：每轮只补"总误差量"最大的那批，补掉之后再重算。
        // 只跑一轮的话，几十像素的深色漏笔永远排在几千个大块后面，预算一满就被丢掉
        // （收尾自检里剩下的亮点就是这么漏的）。
        for (let roundB = 0; roundB < (opts.holeRounds | 0); roundB++) {
          const thrB = clamp(opts.holeT * 2 * strokeScale, 32, 120);
          const m = new Uint8Array(N);
          let anyB = 0;
          for (let i = 0; i < N; i++) {
            const d2 = errAt(i);
            if (d2 <= thrB) continue;
            if (rampPix[i]) continue;                                            // 抗锯齿毛边：不描
            if (opts.resFlatTol > 0 && flatRng[i] <= opts.resFlatTol && d2 <= opts.resFlatErr) continue; // 平滑区的小台阶：不描
            m[i] = 1; anyB++;
          }
          if (!anyB) break;
          const cc2 = compsOfLabels(m, W, H);
          for (let ci = 0; ci < cc2.comps.length; ci++) {
            const c = cc2.comps[ci];
            if (c.label !== 1) continue;
            const thick = compThick(c, cc2.pix);      // 真实厚度（细环不会被误判成"厚"）
            if (c.count > opts.holeMax && thick > 4) {          // 又大又厚：平涂风格化，不补
              for (let k = 0; k < c.count; k++) m[cc2.pix[c.start + k]] = 0;
            }
          }
          const got = fillMask(m, 2500, 4200, errAt);
          nB += got;
          hp.flush(3);            // 本轮并起来的补丁笔在这里落笔（下一轮重算前必须落完）
          if (!got) break;
        }
        // C) 交界过渡带：两个色块硬碰硬的地方，目标图那一两像素是混色，
        //    我们画的是纯色，差值就是"可见差异"的主要来源——沿交界补上目标色本身
        let nC = 0;
        if (opts.edgeFill) {
          // 只在"两边颜色差得远"的交界上补：差得近的话混色像素本来就没多少误差，
          // 补上去只是把已经对的像素刷成中间色（实测会把平均差抬高）
          const colOf = new Map();
          for (const rg of regions) colOf.set(rg.cid, rg.color);
          const bigEdge = new Uint8Array(N);
          for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
              const p = y * W + x, c0 = compOf[p];
              let c1 = -1;
              if (x + 1 < W && compOf[p + 1] !== c0) c1 = compOf[p + 1];
              else if (y + 1 < H && compOf[p + W] !== c0) c1 = compOf[p + W];
              else if (x > 0 && compOf[p - 1] !== c0) c1 = compOf[p - 1];
              else if (y > 0 && compOf[p - W] !== c0) c1 = compOf[p - W];
              if (c1 < 0) continue;
              const A = colOf.get(c0), Bv = colOf.get(c1);
              if (!A || !Bv) continue;
              if (Math.abs(A[0] - Bv[0]) + Math.abs(A[1] - Bv[1]) + Math.abs(A[2] - Bv[2]) < opts.edgeCd) continue;
              bigEdge[p] = 1;
            }
          }
          const band = dilate(bigEdge, W, H, 1);
          const thrC = clamp(opts.edgeT * strokeScale, 6, 20);
          const m = new Uint8Array(N);
          let any = 0;
          for (let i = 0; i < N; i++) if (band[i] && errAt(i) > thrC) { m[i] = 1; any++; }
          if (any) { nC = fillMask(m, opts.edgeMax, 4200); hp.flush(3); }
        }
        if (nA || nB || nC) {
          let bad2 = 0;
          for (let i = 0; i < N; i++) if (errAt(i) > 8) bad2++;
          prog(0.995, `收尾补漏… 空白 ${nA} 处、碎块 ${nB} 处、交界 ${nC} 处（可见差异 ${(bad2 / N * 100).toFixed(2)}%）`);
          await yieldUI();
        }
      }

      // ---- 最后一公里：全图精修（只在最高还原档开）
      // 残差补笔每轮最多撒 6000 个补丁、收益一掉就收手，全图总有约 1% 的像素停在
      // "肉眼看得出来"的误差上。这里不再按轮次/厚度/保护带挑：把全图所有还差过
      // exactRepair 的像素按"格子 + 颜色桶"聚合，一整组用一条掩膜笔补上目标均值色。
      // 补完每个像素都不超过 exactRepair（掩膜笔是硬边、逐像素落色），成品与原图一致。
      if (opts.exactRepair > 0) {
        prog(0.996, '最后一公里：补最后 ' + opts.exactRepair + ' 级色差…'); await yieldUI();
        const T = opts.exactRepair;
        const CS = Math.max(16, opts.exactRepairCell | 0);
        const SH = Math.max(0, Math.min(7, opts.exactRepairShift | 0));
        const QB = 1 << (8 - SH);                       // 每通道的桶数
        const cellsX = Math.ceil(W / CS);
        const groups = new Map();
        let nWrong = 0;
        for (let y = 0; y < H; y++) {
          const row = y * W;
          for (let x = 0; x < W; x++) {
            const p = row + x;
            const dr = Math.abs(canvas[p * 3] - R[p]);
            const dg = Math.abs(canvas[p * 3 + 1] - G[p]);
            const db2 = Math.abs(canvas[p * 3 + 2] - B[p]);
            const d = dr > dg ? (dr > db2 ? dr : db2) : (dg > db2 ? dg : db2);
            if (d <= T) continue;
            const key = (((((y / CS) | 0) * cellsX + ((x / CS) | 0)) * QB + (R[p] >> SH)) * QB +
                         (G[p] >> SH)) * QB + (B[p] >> SH);
            let g = groups.get(key);
            if (!g) {
              g = { n: 0, r: 0, g: 0, b: 0, x0: x, y0: y, x1: x, y1: y, md: 0, pix: [] };
              groups.set(key, g);
            }
            g.n++; g.r += R[p]; g.g += G[p]; g.b += B[p];
            if (d > g.md) g.md = d;
            if (x < g.x0) g.x0 = x; else if (x > g.x1) g.x1 = x;
            if (y < g.y0) g.y0 = y; else if (y > g.y1) g.y1 = y;
            g.pix.push(p);
            nWrong++;
          }
        }
        // 先补最刺眼的：预算不够时，留下的也是看不出来的亚可见色差
        const arr = Array.from(groups.values());
        arr.sort((a, b) => b.md - a.md);
        const cap = Math.max(0, opts.exactRepairMax | 0);
        // 合并时的色差上限跟着目标走：T=2 时只允许完全同桶（tol=0），
        // 否则均值色漂移会把"补到 2 以内"重新拉回 3~4。
        const xpTol = T <= 2 ? 0 : (T <= 4 ? 1 : 2);
        const xp = makePool(CS, SH, xpTol, 128);
        let nX = 0;
        for (let gi = 0; gi < arr.length; gi++) {
          if (cap && nX >= cap) break;
          const g = arr[gi];
          const mw = g.x1 - g.x0 + 1, mh = g.y1 - g.y0 + 1;
          const bin = new Uint8Array(mw * mh);
          for (let k = 0; k < g.n; k++) {
            const p = g.pix[k];
            const x = p % W, y = (p - x) / W;
            bin[(y - g.y0) * mw + (x - g.x0)] = 1;
          }
          const col = [Math.round(g.r / g.n), Math.round(g.g / g.n), Math.round(g.b / g.n)];
          xp.add(col, g.x0, g.y0, g.x1, g.y1, mw, mh, bin,
                 (g.x0 + g.x1) / 2, (g.y0 + g.y1) / 2, g.n);
          nX++;
          if ((nX & 2047) === 0) {
            prog(0.996, '最后一公里… 已补 ' + nX + ' 组');
            await yieldUI();
          }
        }
        xp.flush(3);
        let bad24 = 0, mx = 0;
        for (let p = 0; p < N; p++) {
          const dr = Math.abs(canvas[p * 3] - R[p]);
          const dg = Math.abs(canvas[p * 3 + 1] - G[p]);
          const db2 = Math.abs(canvas[p * 3 + 2] - B[p]);
          const d = dr > dg ? (dr > db2 ? dr : db2) : (dg > db2 ? dg : db2);
          if (d > 24) bad24++;
          if (d > mx) mx = d;
        }
        dbg.exact = { T, groups: arr.length, patches: nX, wrong: nWrong,
                      可见: +(bad24 / N * 100).toFixed(3), 最大: mx };
        prog(0.998, '精修完成（可见差异 ' + (bad24 / N * 100).toFixed(2) + '%）');
        await yieldUI();
      }

      lap('holes');
      keysOut.push({ i: strokes.length, rgb: canvas.slice() });
      visCanvas = canvas;
      keysRgb = keysOut;
    }

    // 兜底：上面那段没跑（既不要 canvas 也不要关键帧）时，题字层也得画上
    if (!inkDrawn) {
      prog(0.985, '题字落款…'); await yieldUI();
      drawInkSeq(inkLastSeq, (rec) => { rec.fin = 1; }, 3);
      mark('细线');
    }

    mark('补漏');
    // ---- 收尾：删掉"一笔都没留下"的笔 ----
    // 一笔画上去的像素如果全被后面的笔盖住了，删掉它成品**像素级不变**，
    // 但回放里就少一次"在同一个地方又点一下"的多余动作（用户说的"多余不用的笔画"）。
    // 判据来自上面关键帧回放时顺手记的"最后画上每个像素的笔号"（跟网页端同一套光栅口径）。
    // ⚠️ 必须同时看 opts.dropDead：deadScan 现在 debug 下也会分配（诊断要用），
    // 但"删笔+重排笔号"只能 dropDead 打开时做——否则诊断跑里 from/to/gapAt/layerEnds
    // 这些按笔号的记账会全部错位（踩过一次：覆盖率读数整个失真）。
    if (deadScan && opts.dropDead) {
      const alive = new Uint8Array(strokes.length);
      let nAlive = 0;
      for (let p = 0; p < N; p++) { const i2 = deadScan[p]; if (i2 >= 0 && !alive[i2]) { alive[i2] = 1; nAlive++; } }
      // 判据升级（2026-10-18）：光"在最终画布上零贡献"不够——一笔可能"落笔时画上了、后来被
      // 别的图层盖掉"（它在回放里真的画过一笔），删了就在那一层刚画完时留个洞（底色层实测
      // 19 笔、7623 个白点 = 用户看到的"底色没涂满"）。凡是曾被别的层盖过的笔（raster 里打
      // 了 prot）一律保留；被本层后来的笔随手压过去的照删，省笔的收益保住。
      for (let i2 = 0; i2 < strokes.length; i2++) if (!alive[i2] && strokes[i2].prot) { alive[i2] = 1; nAlive++; }
      const nDrop = strokes.length - nAlive;
      dbg.deadDrop = nDrop; dbg.deadProt = strokes.filter((s2) => s2.prot).length;
      if (nDrop > 0) {
        // 关键帧索引重映射：新序号 = 它前面还剩几笔
        const pre = new Int32Array(strokes.length + 1);
        for (let i2 = 0; i2 < strokes.length; i2++) pre[i2 + 1] = pre[i2] + alive[i2];
        if (keysRgb) for (const k1 of keysRgb) k1.i = pre[k1.i];
        if (dbg.marks) for (const m1 of dbg.marks) m1.n = pre[m1.n];
        // 裁剪掩膜去重压缩：没有笔再引用的掩膜一并丢掉（省网页端内存）
        const cMap = new Int32Array(clips.length).fill(-1);
        const clips2 = [];
        let w2 = 0;
        for (let i2 = 0; i2 < strokes.length; i2++) {
          if (!alive[i2]) continue;
          const st2 = strokes[i2];
          if (cMap[st2.c] < 0) { cMap[st2.c] = clips2.length; clips2.push(clips[st2.c]); }
          st2.c = cMap[st2.c];
          strokes[w2++] = st2;
        }
        strokes.length = w2;
        clips.length = 0;
        for (const c2 of clips2) clips.push(c2);
        dbg.dropped = nDrop;
        dbg.clipsBefore = clips2.length;
      }
    }
    // 笔数分解收尾：铺色笔按"区块面积"归类（看小碎块到底贡献了多少笔）
    {
      const cnt = new Array(areaBins.length - 1).fill(0);
      for (const s2 of strokes) {
        if (s2.r < 0) continue;
        const a = regions[s2.r] ? regions[s2.r].area : 0;
        for (let b = 0; b < cnt.length; b++) if (a >= areaBins[b] && a < areaBins[b + 1]) { cnt[b]++; break; }
      }
      dbg.timing = T;
      dbg.sweepByArea = cnt;
      dbg.sweep = { regions: sweepRegions, passes: passTotal, maxPass: passMax };
    }

    // 时长归一：先按 targetSec 分配相对权重（网页端还会把"抬笔移动"的时间算进来再分一次）
    {
      let tot = 0;
      for (const st1 of strokes) tot += st1.ms;
      const k = tot > 0 ? (opts.targetSec * 1000) / tot : 1;
      for (const st1 of strokes) st1.ms = Math.round(Math.max(6, st1.ms * k) * 10) / 10;
    }

    // 回放编排：题字/落款是在补漏前落色的（补漏必须看到已经写好的字，否则会把字当成白点重补），
    // 但把这几笔的记录移到最末——回放最后看到的是几笔看得见的字，而不是一堆微补丁。
    // 只改 strokes 的顺序，不改任何像素、不改笔数；dropDead / keys / clips 都已在上一步处理完。
    if (!opts.debug) {                 // debug 跑要保留原始顺序，deadScan/marks 才对得上
      let nFin = 0;
      for (const st1 of strokes) if (st1.fin) nFin++;
      if (nFin) {
        const fin = [];
        let w = 0;
        for (let i = 0; i < strokes.length; i++) {
          const st1 = strokes[i];
          if (st1.fin) fin.push(st1); else strokes[w++] = st1;
        }
        strokes.length = w;
        for (const st1 of fin) strokes.push(st1);
      }
    }

    prog(1.0, '完成');
    if (opts.debug && deadScan) dbg.deadScan = deadScan;   // 诊断用：像素 → 最后画上它的笔号（管线自己的口径）
    return {
      W, H, strokes, clips,
      canvasRgb: opts.returnCanvas ? visCanvas : undefined,
      keys: opts.returnKeys ? keysRgb : undefined,
      palette: opts.debug ? pal.map((c) => [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])]) : undefined,
      dbg: opts.debug ? dbg : undefined,
      probe: opts.probe ? (() => {
        const p0 = opts.probe.y * W + opts.probe.x;
        const ci = compOf[p0];
        const ri = regions.findIndex((r) => r.cid === ci);
        const rg = regions[ri];
        return rg ? { cid: ci, ri, area: rg.area, bbox: [rg.x0, rg.y0, rg.x1, rg.y1], hp: Math.round(rg.hp),
                      color: rg.color, isLine: isInk[ri], strokesOfRegion: strokes.filter((st) => st.r === ri).length }
                  : { cid: ci, missing: true };
      })() : undefined,
      stats: {
        regions: regions.length,
        inkGroups: inkClips.length,
        strokes: strokes.length,
        totalMs: strokes.reduce((a, s) => a + s.ms, 0),
        phases: [0, 1, 2, 3].map((ph) => strokes.filter((s) => s.ph === ph).length),
        colors: opts.colors,
        photo: !!opts.photoMode,
        style: opts.style,
        detail: opts.detail,       // 老字段保留
        fidelity: fid,
      },
    };
  }

  root.ISP_PIPELINE = { run, CFG, _u: { ribbon, ribbonProf, fillPoly, fillPolyCov, distanceTransform, thin, longestPath, compsOfLabels, dilate, erode, closeMask, closeMaskDisk, rdpSimplify, mergeLoops } };
})(typeof self !== 'undefined' ? self : globalThis);
