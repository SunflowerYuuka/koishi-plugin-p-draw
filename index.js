const { Schema, h } = require('koishi')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const { pathToFileURL } = require('url')

exports.name = 'p-draw'

exports.inject = {
  required: ['database'],
  optional: [],
}

exports.usage = `
- **指令：p-draw [描述]**
    别名：画图，生图，绘图，画画
    消耗 P 点并连接本地 ComfyUI 生图，结果图会发回本群。
    例：\`画图 一个女孩，白色裙子，立绘，简单背景\`
- **指令：p-draw 状态**
    别名：绘图状态
    查看 ComfyUI 连接状态与模型可用性。
- **指令：p-draw 诊断**
    别名：部署诊断
    输出更详细的配置与连通性诊断。
- **尺寸：** 支持 \`竖图\` \`横图\` \`方图\` \`长竖图\` \`宽屏\` 或在描述中写 \`1024x1536：描述\` / \`--尺寸 1216x832\`。
- **原样模式：** 描述前加 \`无优化\` 直接提交写好的 tags。
- **联网搜索：** 描述中带 \`联网\` / \`搜索\` / \`查一下\` 等词时，会先联网搜索补充角色设定（需配置 Tavily Key）。
- **画师组：** \`创建画师组 名称=tags\` \`切换画师组 名称\` \`查看画师组\` \`删除画师组 名称\`
- **固定角色：** \`添加角色 名称=tags\`
- **以图生图：** \`p-draw i2i <描述>\`，并在同一条消息里附一张原图（文件/截图/链接均可）。发送后会询问处理模式：
  - **① 换风格（漫画化）**：保留原图构图，把图片转成二次元画风（用 ControlNet 锁结构）
  - **② 换装换姿势**：保留角色长相，重新设计服装/姿势/场景（用 IP-Adapter 保脸）
  - **③ 取消**：不生成
  - 可加 \`--denoise 0.6\` 单独调整强度；未装 ControlNet/IPAdapter 时自动回退普通 img2img。
`;

const zhCN = {
  comfyuiBaseUrl: { $description: 'ComfyUI 地址' },
  workflow: { $description: '工作流类型（内置 anima_t2i）' },
  customWorkflowEnabled: { $description: '使用自定义 ComfyUI 工作流 JSON' },
  customWorkflowPath: { $description: '自定义工作流 JSON 路径（相对插件目录）' },
  customWorkflowOverrideParameters: { $description: '用插件参数覆盖自定义工作流参数' },
  timeout: { $description: '单次生成超时（秒）' },
  pollInterval: { $description: '生成状态查询间隔（秒）' },
  unetName: { $description: '主模型文件名' },
  clipName: { $description: '文本编码器文件名' },
  vaeName: { $description: 'VAE 文件名' },
  width: { $description: '默认宽度' },
  height: { $description: '默认高度' },
  allowedSizes: { $description: '可用尺寸列表（宽x高）' },
  steps: { $description: '采样步数' },
  cfg: { $description: 'CFG 强度' },
  samplerName: { $description: '采样器' },
  scheduler: { $description: '调度器' },
  qualityPrefix: { $description: '质量词前缀' },
  negativePrompt: { $description: '负面提示词' },
  promptOptimizeEnabled: { $description: '启用自然语言优化（需要配置下方 LLM 接口）' },
  llmBaseUrl: { $description: 'LLM 接口地址（OpenAI 兼容，例如 https://api.deepseek.com/v1）' },
  llmApiKey: { $description: 'LLM API Key' },
  llmModel: { $description: 'LLM 模型名（留空则不优化，原样生图）' },
  llmMaxTokens: { $description: 'LLM 输出上限' },
  webSearchEnabled: { $description: '启用联网搜索（指令里写“联网/搜索/查一下”等触发）' },
  tavilyApiKey: { $description: 'Tavily API Key（联网搜索用，https://tavily.com 申请）' },
  webSearchMaxResults: { $description: '联网搜索结果数量' },
  webSearchDepth: { $description: '搜索深度（basic / advanced）' },
  webSearchQueryTemplate: { $description: '搜索词模板（{prompt} 代表用户需求）' },
  promptOptimizeTemplate: { $description: '自然语言优化模板（支持 {theme} {search_block} 占位符）' },
  fixedCharacters: { $description: '固定角色（格式：角色名=tags）' },
  artistPresets: { $description: '画师组（格式：名称=tags）' },
  activeArtistPreset: { $description: '启用的画师组名称' },
  defaultArtistTags: { $description: '备用画师 tags' },
  styleTags: { $description: '画风 tags' },
  queueEnabled: { $description: '启用生成队列（逐张顺序执行）' },
  queueMaxRequests: { $description: '队列最大任务数（0 表示不限制）' },
  batchMax: { $description: '单次指令最多生成的张数（支持 x3 / 3张 / --数量 3 等写法）' },
  price: { $description: '一张图消耗的 P 点' },
  multiPrice: { $description: '多人指令（p-draw 多人）单张消耗的 P 点' },
  couponPrice: { $description: '提示词优化券单价（P 点/张，购买询问时显示）' },
  couponAskTimeout: { $description: '提示词优化券确认等待时间（秒）' },
  img2imgDenoise: { $description: '普通以图生图（p-draw i2i）的去噪强度，越小越接近原图（建议 0.4-0.7）' },
  i2iMode: { $description: 'i2i 模式选择方式：ask=每次询问 / style=直接换风格（漫画化）/ ootd=直接换装换姿势 / plain=普通 img2img' },
  i2iAskTimeout: { $description: 'i2i 模式询问等待时间（秒）' },
  i2iStyleDenoise: { $description: '换风格模式（漫画化）的去噪强度，越大风格变化越彻底（建议 0.7-0.85）' },
  i2iOotdDenoise: { $description: '换装换姿势模式（保留角色）的去噪强度（建议 0.5-0.6）' },
  i2iControlNetStrength: { $description: '换风格模式的 ControlNet 强度，越大构图锁得越死（建议 0.5-0.8）' },
  i2iIPAdapterPath: { $description: 'Anima IP-Adapter 模型文件路径（换装换姿势模式保脸用；需安装 comfyui-anima-ipadapter 节点并把模型路径填到这里）' },
  i2iIPAdapterWeight: { $description: '换装换姿势模式的 IP-Adapter 权重，越大角色特征保留越强（建议 0.6-1.0）' },
  controlNetModel: { $description: 'ControlNet 模型文件名（留空自动检测 Qwen/Anima 系 ControlNet；需放到 ComfyUI/models/controlnet）' },
  taggerEnabled: { $description: 'i2i 前自动识图（需 ComfyUI 安装 WD14 Tagger 节点与模型；识别出的标签会注入提示词优化）' },
  taggerModel: { $description: '识图模型名（WD14 Tagger 节点里可选模型）' },
  taggerThreshold: { $description: '识图标签置信度阈值' },
  taggerCharacterThreshold: { $description: '识图角色标签置信度阈值' },
  adminUsers: { $description: '免 P 点管理员用户 ID 列表' },
  outputLogs: { $description: '是否在控制台输出详细日志' },
  multiVerifyEnabled: { $description: '多人图生成后启用视觉校验（需配置下方视觉模型）' },
  multiVerifyPassScore: { $description: '多人视觉校验合格分数（0-10）' },
  multiCandidateCount: { $description: '多人候选采样数量（校验失败时最多重试 候选数-1 次）' },
  multiSendDegradedCandidate: { $description: '多人候选全部不达标时仍发送最优候选' },
  verifyLlmBaseUrl: { $description: '视觉校验 LLM 接口地址（OpenAI 兼容；留空则跳过校验）' },
  verifyLlmApiKey: { $description: '视觉校验 LLM API Key' },
  verifyLlmModel: { $description: '视觉校验 LLM 模型名（需支持图片输入，如 qwen-vl）' },
  adminOnly: { $description: '仅管理员可用（adminUsers 中的用户）' },
  allowedUserIds: { $description: '用户白名单（QQ 号，留空表示不限制）' },
  blockedUserIds: { $description: '用户黑名单（QQ 号，黑名单优先于白名单）' },
  allowedGroupIds: { $description: 'QQ 群白名单（群号，留空表示不限制）' },
  blockedGroupIds: { $description: 'QQ 群黑名单（群号，黑名单优先于白名单）' },
  commands: {
    'p-draw': {
      description: '连接本地 ComfyUI 生图，消耗 P 点',
      messages: {
        'not-permitted': 'ComfyUI 助手已关闭，或当前用户没有使用权限。',
        usage: 'p-draw 帮助（本指令名可自行更换，如 /anm）：\n\n【生成】\n  p-draw <描述>\n  例：p-draw 一个女孩，白色裙子，立绘，简单背景\n  可加 --seed 数字 固定种子（单张 / 批量 / 连续图均支持）\n\n【多人生成】\n  p-draw 多人 <描述>（2-4 人画面）\n  例：p-draw 多人 左边若叶睦抱着吉他，右边千早爱音牵着她的手\n\n【连续图】\n  p-draw 连续 <角色>：<阶段1> → <阶段2> → ...\n  例：p-draw 连续 少女：清纯校服 → 换上晚礼服 → 华丽登场\n  全阶段共用同一 seed，角色外观尽量一致；可加 --seed 数字 固定种子\n  阶段分隔：→ / -> / |\n\n【批量张数】\n  描述后加 x3 / ×3 / 3张 / 三张 / --数量 3，例：p-draw 一个女孩 x3\n  多张按 张数×单价 一次性扣 P 点，余额不足则不生成\n\n【尺寸】\n  竖图 / 横图 / 方图 / 长竖图 / 宽屏，或 1024x1536：描述 / --尺寸 1216x832\n  例：p-draw 竖图：狐莉站在梨花树下\n\n【原样模式】\n  p-draw 无优化 masterpiece, best quality, 1girl, solo\n\n【提示词优化】\n  配置 LLM（llmBaseUrl/llmModel）后：\n  全局优化开启 → 每次自动把中文描述转成 Danbooru tags\n  全局优化关闭 → 生图时询问是否使用「提示词优化券」（p-shop 购买，每张图扣 1 张）：\n    有券 → 确认后消耗券并优化，拒绝则取消本次生图\n    没券 → 询问是否购买（显示价格），确认后购买并消耗、优化生图；\n          拒绝一次会再次警告，再拒绝则直接生图（不优化）；\n          P 点不足买不起券时，会询问是否仍然生图\n  无优化 <tags> 原样生图，不耗券\n  连续图逐阶段强制优化；多人指令依赖 LLM 规划（未配置会提示）\n\n【画师组】\n  创建画师组 名称=tags / 追加画师组 名称=tags / 切换画师组 名称 / 查看画师组 / 删除画师组 名称\n\n【固定角色】\n  添加角色 名称=tags\n\n【以图生图】\n  p-draw i2i <描述>，并在同一条消息里附一张原图（文件/截图/链接均可）\n  例：p-draw i2i 换成晚礼服，背景换成舞台灯光\n  发送后会询问处理模式（可配置 i2iMode 固定模式跳过询问）：\n    ① 换风格（漫画化）：保留原图构图，转成二次元画风（需 ControlNet）\n    ② 换装换姿势：保留角色长相，重新设计服装/姿势/场景（需 Anima IP-Adapter）\n    ③ 取消：不生成\n  可加 --denoise 0.6 单独调整强度；未装 ControlNet/IPAdapter 时自动回退普通 img2img\n\n【模型】\n  p-draw 模型（查看当前与可用模型） / p-draw 模型 名称（切换，支持模糊匹配）/ p-draw 模型 默认（重置）\n  例：p-draw 模型 anima-aesthetic\n\n【状态】\n  p-draw 状态（查看 ComfyUI 连接状态与模型可用性）',
        'account-notExists': '君现在还没有 p 点，请先签到哦',
        'no-enough-p': '君的 p 点不够 {0}p 哦，先去签个到吧qwq',
        'no-prompt': '请提供画面描述，例如：p-draw 一个女孩，白色裙子',
        generating: '正在生成中，请稍候...',
        charged: '已扣除 {0} P 点，出图后余额会再核对。',
        queued: '已加入生成队列，当前第 {0} 位（队列上限 {1}）。',
        'prompt-degraded': '提示词优化服务不可用{0}，本次已使用原始提示词继续生成；结果可能不符合 Danbooru Tag 预期。',
        'token-used': '已消耗 {0} 张提示词优化券，本次每张图都会使用 LLM 提示词优化。',
        'token-short': '提示词优化券不足（需 {0} 张，现有 {1} 张），本次未使用 LLM 优化。',
        'coupon-ask-use': '你有提示词优化券 {0} 张，本次生图需要消耗 {1} 张。\n是否使用提示词优化券进行 LLM 优化？\n（回复「是」使用 / 回复「否」取消本次生图）',
        'coupon-use-confirmed': '已消耗 {0} 张提示词优化券，本次每张图都会使用 LLM 优化。',
        'coupon-use-cancelled': '已取消本次生图（未使用提示词优化券）。',
        'coupon-cancelled': '未收到有效回复，本次操作已取消。',
        'coupon-ask-buy': '提示词优化券不足（需 {0} 张，现有 {1} 张）。\n提示词优化券价格：{2} P/张，本次共需 {3} P。\n是否购买并使用？\n（回复「是」购买 / 回复「否」不购买）',
        'coupon-buy-warn': '不使用提示词优化券的话，生成的图可能不好看。\n是否仍要购买并使用提示词优化券？\n（回复「是」购买 / 回复「否」直接生图）',
        'coupon-bought-used': '已购买 {0} 张提示词优化券（扣除 {1} P），并消耗 {0} 张用于本次 LLM 优化。',
        'coupon-buy-cancelled': '好的，本次不使用提示词优化券，直接生图。',
        'coupon-buy-pshort': 'P 点不足，无法购买提示词优化券（需 {0} P，现有 {1} P）。\n是否仍然生图（不使用 LLM 优化）？\n（回复「是」生图 / 回复「否」取消本次生图）',
        'coupon-consume-fail': '提示词优化券操作失败，本次未使用 LLM 优化。',
        'generate-failed': '生成失败：{0}',
        'generate-ok': '已扣除 {0} P 点，seed={1}',
        'generate-ok-batch': '已扣除 {0} P 点，共 {1} 张（seed：{2}）',
        'batch-partial': '本次共生成 {0}/{1} 张，失败 {2} 张：{3}',
        'batch-limit': '每次最多生成 {0} 张，本次已按 {0} 张处理。',
        'batch-count': '本次共生成 {0} 张。',
        'artist-format': '请使用「名称=tags」的格式。例：p-draw 创建画师组 千代风格=@artist_a, @artist_b,',
        'artist-created': '已保存并启用画师组「{0}」：\n{1}',
        'artist-appended': '已追加画师组「{0}」：\n{1}',
        'artist-default-appended': '已追加默认画师 tags：\n{0}',
        'artist-use-format': '请写要启用的画师组名称。例：p-draw 切换画师组 千代风格',
        'artist-default': '已切回默认画师 tags。',
        'artist-not-found': '没有找到画师组「{0}」。',
        'artist-used': '已启用画师组「{0}」：\n{1}',
        'artist-deleted': '已删除画师组「{0}」。',
        'artist-delete-format': '请写要删除的画师组名称。例：p-draw 删除画师组 千代风格',
        'character-format': '请使用「名称=tags」的格式。例：p-draw 添加角色 狐莉=1girl, solo, fox girl',
        'character-created': '已保存角色「{0}」：\n{1}',
        'multi-usage': '多人生图：p-draw 多人 <描述>（2-4 人画面）\n例：p-draw 多人 左边若叶睦抱着吉他，右边千早爱音牵着她的手',
        'multi-verify-passed': '多人图已通过视觉校验（{0} 分）。',
        'multi-verify-failed': '多人图未通过视觉校验{0}，已重试 {1} 次。',
        'multi-verify-degraded': '多人图校验失败，已发送最优候选{0}。',
        'multi-verify-discarded': '多人图校验失败且未启用降级发送，本次图片不发送。',
        'multi-degraded': '多人视觉校验不可用{0}，本次已直接发送生成结果。',
        'multi-verify-error': '多人视觉校验调用失败：{0}',
        'series-usage': '连续图：p-draw 连续 <角色>：<阶段1> → <阶段2> → ...\n例：p-draw 连续 少女：清纯校服 → 换上晚礼服 → 华丽登场\n或用 | 分隔，可加 --seed 固定种子保证角色一致。',
        'series-ok': '已扣除 {0} P 点，共 {1} 张连续图（seed={2}）',
        'model-usage': '当前模型：{0}\n可用模型：\n{1}\n用法：p-draw 模型 <名称>（支持模糊匹配，如 anima-aesthetic）；p-draw 模型 默认 恢复默认。',
        'model-switched': '已切换为模型「{0}」，对之后的生图生效。',
        'model-reset': '已恢复默认模型「{0}」。',
        'model-not-found': '未找到模型「{0}」。可用模型：\n{1}',
        'model-no-draw': '「模型」只能用来切换/查看模型，不能生图。请先用「p-draw 模型 <名称>」切换，再单独发送要画的内容。',
        'model-ambiguous': '「{0}」匹配到多个模型，请写得更具体些：\n{1}',
        'no-optimize': '提示：本次未使用 LLM 优化（{0}）。',
        'i2i-no-image': 'i2i（以图生图）需要附一张原图。用法：p-draw i2i <描述>，并在同一条消息里带上图片。',
        'i2i-upload-fail': '原图上传 ComfyUI 失败：{0}',
        'i2i-no-custom-workflow': 'i2i（以图生图）暂不支持自定义工作流（customWorkflowEnabled），请关闭后再试。',
        'i2i-mode-ask': '请选择 i2i 处理模式：\n① 换风格（漫画化）——保留原图构图，转成二次元画风\n② 换装换姿势——保留角色长相，重新设计服装/姿势/场景\n③ 取消——不生成\n回复 1 / 2 / 3 或对应名称即可。',
        'i2i-mode-invalid': '没有理解你的选择。请回复 ①换风格（漫画化） / ②换装换姿势 / ③取消。',
        'i2i-mode-cancelled': '已取消本次 i2i 生图。',
        'i2i-mode-style': '已选择【换风格（漫画化）】：保留原图构图，转成二次元画风。',
        'i2i-mode-ootd': '已选择【换装换姿势】：保留角色长相，重新设计服装/姿势/场景。',
        'i2i-no-controlnet': '未检测到可用的 Anima ControlNet-LLLite，本次「换风格」将使用普通 img2img，构图保留效果会弱一些。',
        'i2i-no-ipadapter': '未检测到可用的 Anima IP-Adapter，本次「换装换姿势」将使用普通 img2img，角色保留效果会弱一些。',
        'multi-no-llm': '多人指令需要 LLM 规划，但当前未配置 llmBaseUrl / llmModel。请管理员在配置中填写后使用。',
      },
    },
  },
}

exports.Config = Schema.object({
  // ComfyUI 连接
  comfyuiBaseUrl: Schema.string().default('http://127.0.0.1:8188').description('ComfyUI 地址'),
  workflow: Schema.string().default('anima_t2i').description('工作流类型（内置 anima_t2i）'),
  customWorkflowEnabled: Schema.boolean().default(false).description('使用自定义 ComfyUI 工作流 JSON'),
  customWorkflowPath: Schema.string().default('').description('自定义工作流 JSON 路径（相对插件目录）'),
  customWorkflowOverrideParameters: Schema.boolean().default(false).description('用插件参数覆盖自定义工作流参数'),
  timeout: Schema.number().default(300).description('单次生成超时（秒）'),
  pollInterval: Schema.number().default(2).description('生成状态查询间隔（秒）'),

  // 模型文件
  unetName: Schema.string().default('anima-base-v1.0.safetensors').description('主模型文件名（需与 ComfyUI models/diffusion_models 下的文件名完全一致，含连字符；默认 anima-base-v1.0.safetensors）'),
  i2iUnetName: Schema.string().default('anima-base-v1.0.safetensors').description('「换风格（漫画化）」工作流专用主模型文件名。LLLite 权重按 block 数逐块训练，当前 LLLite 权重为 28-block，必须搭配 28-block 模型（anima-base-v1.0 / anima-aesthetic-v1.1）；不要用 40-block 的 Anima-2.9B，否则报 depth_embed slices missing。留空则用主模型 unetName'),
  modelParams: Schema.dict(Schema.object({
    samplerName: Schema.string().description('采样器（如 er_sde / res_2s / dpmpp_2m）'),
    scheduler: Schema.string().description('调度器（如 simple / beta57 / normal）'),
    steps: Schema.number().description('采样步数'),
    cfg: Schema.number().description('CFG 强度'),
    width: Schema.number().description('默认宽度'),
    height: Schema.number().description('默认高度'),
  }).description('该模型的生成参数覆盖')).default({}).description('每个模型独立参数覆盖：key=模型文件名（如 anima-base-v1.0.safetensors、Anima-2.9B-preview-v1.safetensors、anima-aesthetic-v1.1.safetensors），value=要覆盖的参数（samplerName/scheduler/steps/cfg/width/height）。只填需要覆盖的字段，不填的用全局默认。匹配不区分大小写与 -/_。'),
  clipName: Schema.string().default('qwen_3_06b_base.safetensors').description('文本编码器文件名'),
  vaeName: Schema.string().default('qwen_image_vae.safetensors').description('VAE 文件名'),

  // 出图参数
  width: Schema.number().default(832).description('默认宽度'),
  height: Schema.number().default(1216).description('默认高度'),
  allowedSizes: Schema.array(Schema.string()).default(['832x1216', '896x1152', '1024x1024', '1152x896', '1216x832', '768x1344', '1344x768', '1024x1536']).description('可用尺寸列表（宽x高）'),
  steps: Schema.number().default(30).description('采样步数'),
  cfg: Schema.number().default(4.5).description('CFG 强度'),
  samplerName: Schema.string().default('er_sde').description('采样器'),
  scheduler: Schema.string().default('simple').description('调度器'),

  // 提示词
  qualityPrefix: Schema.string().default('masterpiece, best quality, score_7, safe,').description('质量词前缀'),
  negativePrompt: Schema.string().default('worst quality, low quality, score_1, score_2, score_3, artist name').description('负面提示词'),
  promptOptimizeEnabled: Schema.boolean().default(false).description('启用自然语言优化（需要配置下方 LLM 接口）'),
  llmBaseUrl: Schema.string().default('').description('LLM 接口地址（OpenAI 兼容，例如 https://api.deepseek.com/v1）'),
  llmApiKey: Schema.string().role('secret').default('').description('LLM API Key'),
  llmModel: Schema.string().default('').description('LLM 模型名（留空则不优化，原样生图）'),
  llmMaxTokens: Schema.number().default(1000).description('LLM 输出上限'),
  webSearchEnabled: Schema.boolean().default(false).description('启用联网搜索（指令里写“联网/搜索/查一下”等触发）'),
  tavilyApiKey: Schema.string().role('secret').default('').description('Tavily API Key（联网搜索用，https://tavily.com 申请）'),
  webSearchMaxResults: Schema.number().default(5).description('联网搜索结果数量'),
  webSearchDepth: Schema.string().default('basic').description('搜索深度（basic / advanced）'),
  webSearchQueryTemplate: Schema.string().default('{prompt} 角色 外观 立绘 服装 配色 武器 官方图 official art character design outfit appearance wiki fandom').description('搜索词模板（{prompt} 代表用户需求）'),
  promptOptimizeTemplate: Schema.string().description('自然语言优化模板（支持 {theme} {search_block} 占位符）').default('你是为 Anima 图像生成模型编写正面提示词的 AI 画师。\n\n请根据用户的原始要求设计一幅完整、协调、具有视觉吸引力的画面，并将结果输出为英文 Danbooru-style tags。\n\n输出要求：\n- 只输出一行英文 tags，使用英文逗号分隔。\n- 不要输出解释、分析、标题、编号、Markdown、代码块或中文。\n- 不要输出 masterpiece、best quality、score 等质量前缀。\n- 不要输出画师 tags；质量词和画师组会由程序另行拼接。\n- 尽量使用模型容易理解的可见画面描述。\n- 保持用户明确指定的角色、主体、人数、关键服装、动作、表情和道具。\n- 除上述明确要求外，可以自由决定服装细节、姿态、构图、镜头、背景、环境、光影、色彩、氛围、前景和特效。\n- 以最终图像协调、精致、有表现力和好看为优先，不需要机械追求固定 Tag 数量。\n- 不要为了数量重复同义词；画面已经完整时即可停止。\n- 请自行解决明显冲突，直接输出你认为最适合生成最终画面的版本。\n\n角色和动态上下文：\n{character_rule}\n{search_block}\n\n用户原始要求：\n{theme}'),
  artistPresets: Schema.array(Schema.string()).default([]).description('画师组（格式：名称=tags）'),
  activeArtistPreset: Schema.string().default('').description('启用的画师组名称'),
  defaultArtistTags: Schema.string().default('').description('备用画师 tags'),
  styleTags: Schema.string().default('').description('画风 tags'),

  // 队列
  queueEnabled: Schema.boolean().default(true).description('启用生成队列（逐张顺序执行）'),
  queueMaxRequests: Schema.number().default(5).description('队列最大任务数（0 表示不限制）'),
  batchMax: Schema.number().default(4).description('单次指令最多生成的张数（支持 x3 / 3张 / --数量 3 等写法）'),

  // P 点
  price: Schema.number().default(500).description('一张图消耗的 P 点'),
  multiPrice: Schema.number().default(900).description('多人指令（p-draw 多人）单张消耗的 P 点'),
  couponPrice: Schema.number().default(3000).description('提示词优化券单价（P 点/张，购买询问时显示；可自动读取 data/p-shop.json 里的价格覆盖）'),
  couponAskTimeout: Schema.number().default(60).description('提示词优化券确认等待时间（秒）'),
  img2imgDenoise: Schema.number().default(0.55).description('普通以图生图（p-draw i2i）的去噪强度，越小越接近原图（建议 0.4-0.7）'),
  i2iMode: Schema.string().default('ask').description('i2i 模式选择方式：ask=每次询问 / style=直接换风格（漫画化）/ ootd=直接换装换姿势 / plain=普通 img2img'),
  i2iAskTimeout: Schema.number().default(60).description('i2i 模式询问等待时间（秒）'),
  i2iStyleDenoise: Schema.number().default(0.75).description('换风格模式（漫画化）的去噪强度，越大风格变化越彻底（建议 0.7-0.85）'),
  i2iOotdDenoise: Schema.number().default(0.55).description('换装换姿势模式（保留角色）的去噪强度（建议 0.5-0.6）'),
  i2iControlNetStrength: Schema.number().default(0.7).description('换风格模式的 ControlNet-LLLite 强度，越大构图锁得越死（建议 0.5-0.8；需安装 kohya-ss/ComfyUI-Anima-LLLite 节点与权重）'),
  i2iIPAdapterPath: Schema.string().default('').description('Anima IP-Adapter 模型文件路径（换装换姿势模式保脸用；需安装 comfyui-anima-ipadapter 节点并把模型路径填到这里）'),
  i2iIPAdapterWeight: Schema.number().default(0.8).description('换装换姿势模式的 IP-Adapter 权重，越大角色特征保留越强（建议 0.6-1.0）'),
  controlNetModel: Schema.string().default('').description('Anima ControlNet-LLLite 权重文件名（留空自动检测 anima-lllite 系；需放到 ComfyUI/models/controlnet，如 anima-lllite-lineart-test-1.safetensors）'),
  taggerEnabled: Schema.boolean().default(false).description('i2i 前自动识图（需 ComfyUI 安装 WD14 Tagger 节点与模型；识别出的标签会注入提示词优化）'),
  taggerModel: Schema.string().default('wd-v1-4-convnext-tagger-v2').description('识图模型名（WD14 Tagger 节点里可选模型）'),
  taggerThreshold: Schema.number().default(0.35).description('识图标签置信度阈值'),
  taggerCharacterThreshold: Schema.number().default(0.85).description('识图角色标签置信度阈值'),
  adminUsers: Schema.array(Schema.string()).default([]).description('免 P 点管理员用户 ID 列表'),
  outputLogs: Schema.boolean().default(true).description('是否在控制台输出详细日志'),

  // 多人（移植自 anima /anm 多人）
  multiVerifyEnabled: Schema.boolean().default(true).description('多人图生成后启用视觉校验（需配置下方视觉模型）'),
  multiVerifyPassScore: Schema.number().default(6).description('多人视觉校验合格分数（0-10）'),
  multiCandidateCount: Schema.number().default(2).description('多人候选采样数量（校验失败时最多重试 候选数-1 次）'),
  multiSendDegradedCandidate: Schema.boolean().default(true).description('多人候选全部不达标时仍发送最优候选（false 则丢弃）'),
  verifyLlmBaseUrl: Schema.string().default('').description('视觉校验 LLM 接口地址（OpenAI 兼容；留空则跳过校验）'),
  verifyLlmApiKey: Schema.string().role('secret').default('').description('视觉校验 LLM API Key'),
  verifyLlmModel: Schema.string().default('').description('视觉校验 LLM 模型名（需支持图片输入，如 qwen-vl）'),

  // 权限
  adminOnly: Schema.boolean().default(false).description('仅管理员可用（adminUsers 中的用户）'),
  allowedUserIds: Schema.array(Schema.string()).default([]).description('用户白名单（QQ 号，留空表示不限制）'),
  blockedUserIds: Schema.array(Schema.string()).default([]).description('用户黑名单（QQ 号，黑名单优先于白名单）'),
  allowedGroupIds: Schema.array(Schema.string()).default([]).description('QQ 群白名单（群号，留空表示不限制）'),
  blockedGroupIds: Schema.array(Schema.string()).default([]).description('QQ 群黑名单（群号，黑名单优先于白名单）'),
}).i18n({
  'zh-CN': zhCN,
})

// ------------------------------------------------------------------
// 地址规范化
// ------------------------------------------------------------------
function normalizeBaseUrl(raw) {
  let value = String(raw || '').trim()
  if (!value) value = 'http://127.0.0.1:8188'
  // 清理重复协议头，例如 http://http://host 或 http://https://host
  value = value.replace(/^https?:\/\//i, '')
  if (!/^https?:\/\//i.test(value)) value = 'http://' + value
  return value.replace(/\/+$/, '')
}

// ------------------------------------------------------------------
// 尺寸别名与解析（移植自 anima command_router）
// ------------------------------------------------------------------
const SIZE_ALIASES = {
  '方图': 1.0,
  '正方形': 1.0,
  '竖图': 2 / 3,
  '竖版': 2 / 3,
  '横图': 3 / 2,
  '横版': 3 / 2,
  '长竖图': 9 / 16,
  '手机竖屏': 9 / 16,
  '宽屏': 16 / 9,
  '超宽图': 16 / 9,
}

const SIZE_VALUE_PATTERN = String.raw`(?<width>\d{2,5})\s*[xX×*＊✕✖хХ]\s*(?<height>\d{2,5})`

function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseGenerationSize(text, allowed) {
  const prompt = String(text || '').trim()
  let sizeMatch = null
  const patterns = [
    new RegExp(String.raw`(?<!\S)--(?:尺寸|分辨率)\s*(?:=|＝|:|：)?\s*${SIZE_VALUE_PATTERN}`, 'i'),
    new RegExp(String.raw`(?:尺寸|分辨率)\s*(?:为|是|=|＝|:|：)?\s*${SIZE_VALUE_PATTERN}`, 'i'),
    new RegExp(String.raw`^\s*${SIZE_VALUE_PATTERN}\s*[：:,，]`, 'i'),
  ]
  for (const pattern of patterns) {
    sizeMatch = prompt.match(pattern)
    if (sizeMatch) break
  }

  let selected = null
  if (sizeMatch) {
    selected = [parseInt(sizeMatch.groups.width), parseInt(sizeMatch.groups.height)]
  } else {
    const aliases = Object.keys(SIZE_ALIASES)
      .sort((a, b) => b.length - a.length)
      .map(escapeRe)
      .join('|')
    const aliasPatterns = [
      new RegExp(String.raw`(?<!\S)--(?:尺寸|分辨率)\s*(?:=|＝|:|：)?\s*(?<alias>${aliases})(?=$|\s|[：:,，])`, 'i'),
      new RegExp(String.raw`(?:尺寸|分辨率)\s*(?:为|是|=|＝|:|：)?\s*(?<alias>${aliases})(?=$|\s|[：:,，])`, 'i'),
      new RegExp(String.raw`^\s*(?<alias>${aliases})(?=$|\s|[：:,，])\s*[：:,，]?`, 'i'),
    ]
    for (const pattern of aliasPatterns) {
      sizeMatch = prompt.match(pattern)
      if (sizeMatch) break
    }
    if (sizeMatch && allowed.length) {
      const targetRatio = SIZE_ALIASES[sizeMatch.groups.alias]
      selected = allowed.reduce((best, size) => {
        const a = Math.abs(size[0] / size[1] - targetRatio)
        const b = Math.abs(size[0] * size[1] - 1024 * 1024)
        const ba = Math.abs(best[0] / best[1] - targetRatio)
        const bb = Math.abs(best[0] * best[1] - 1024 * 1024)
        return a < ba || (a === ba && b < bb) ? size : best
      })
    }
  }

  if (!sizeMatch) return { prompt, size: null, error: null }

  let cleaned = (prompt.slice(0, sizeMatch.index) + ' ' + prompt.slice(sizeMatch.index + sizeMatch[0].length)).trim()
  cleaned = cleaned.replace(/^[\s,，;；:：]+|[\s,，;；:：]+$/g, '')
  cleaned = cleaned.replace(/([,，;；])\s*[,，;；]+/g, '$1')
  cleaned = cleaned.replace(/\s+/g, ' ')

  if (selected && allowed.length && !allowed.some(s => s[0] === selected[0] && s[1] === selected[1])) {
    return {
      prompt: cleaned,
      size: null,
      error: `尺寸 ${selected[0]}x${selected[1]} 不可用。可用尺寸：${allowed.map(s => `${s[0]}x${s[1]}`).join('、')}`,
    }
  }
  if (selected === null) return { prompt: cleaned, size: null, error: '当前没有配置可用尺寸。' }
  return { prompt: cleaned, size: selected, error: null }
}

// 批量张数解析：x3 / ×3 / 3张 / 三张 / --数量 3 / 数量：3
const BATCH_TOKEN_PATTERNS = [
  /(?<!\S)(--|——)(?:数量|张数)\s*(?:=|＝|:|：)?\s*(?<num>\d+)/i,
  /(?:数量|张数)\s*(?:为|是|=|＝|:|：)\s*(?<num>\d+)/i,
  /(?<!\S)[x×X](?<num>\d+)(?![a-zA-Z0-9])/,
  /(?<!\S)(?<num>[一二两三四五六七八九十]+)张/,
  /(?<!\S)(?<num>\d+)张(?:图)?/,
]

const CN_NUM_MAP = { '一': 1, '两': 2, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 }

function cnNumValue(text) {
  if (/^\d+$/.test(text)) return parseInt(text, 10)
  if (CN_NUM_MAP[text] != null) return CN_NUM_MAP[text]
  if (/^十[一二三四五六七八九]$/.test(text)) return 10 + CN_NUM_MAP[text.slice(1)]
  if (text === '十') return 10
  return 0
}

function parseBatchCount(text, max) {
  const prompt = String(text || '').trim()
  const cap = Math.max(1, parseInt(max) || 1)
  let requested = 1
  let matched = false
  for (const pattern of BATCH_TOKEN_PATTERNS) {
    const m = prompt.match(pattern)
    if (!m) continue
    const numText = m.groups && m.groups.num != null ? m.groups.num : ''
    const value = cnNumValue(numText)
    if (value >= 1) {
      requested = value
      matched = true
    }
    const cleaned = (prompt.slice(0, m.index) + ' ' + prompt.slice(m.index + m[0].length)).trim()
      .replace(/^[\s,，;；:：]+|[\s,，;；:：]+$/g, '')
      .replace(/\s+/g, ' ')
    return { count: Math.min(requested, cap), requested, prompt: cleaned, matched, clamped: requested > cap }
  }
  return { count: 1, requested: 1, prompt, matched, clamped: false }
}

// 固定种子解析：--seed 17021628 / --seed:17021628 / --seed=17021628 / --seed＝123
// 从提示词里剥离并返回 { seed, prompt }
function parseSeed(text) {
  const prompt = String(text || '').trim()
  const m = prompt.match(/(?<!\S)--seed\s*(?:=|＝|:|：)?\s*(\d+)/i)
  if (!m) return { seed: null, prompt }
  const seed = parseInt(m[1], 10) >>> 0
  const cleaned = (prompt.slice(0, m.index) + ' ' + prompt.slice(m.index + m[0].length)).trim()
    .replace(/^[\s,，;；:：]+|[\s,，;；:：]+$/g, '')
    .replace(/\s+/g, ' ')
  return { seed, prompt: cleaned }
}

// 去噪强度解析：--denoise 0.3 / --denoise=0.6 / --去噪 0.4，并从提示词里剥离
function parseDenoise(text) {
  const prompt = String(text || '').trim()
  const m = prompt.match(/(?<!\S)--(?:denoise|去噪)\s*(?:=|＝|:|：)?\s*(\d+(?:\.\d+)?)/i)
  if (!m) return { denoise: null, prompt }
  const denoise = Math.min(1, Math.max(0, parseFloat(m[1])))
  const cleaned = (prompt.slice(0, m.index) + ' ' + prompt.slice(m.index + m[0].length)).trim()
    .replace(/^[\s,，;；:：]+|[\s,，;；:：]+$/g, '')
    .replace(/\s+/g, ' ')
  return { denoise, prompt: cleaned }
}

// ------------------------------------------------------------------
// 提示词辅助（移植自 anima prompt_presets）
// ------------------------------------------------------------------
const RAW_PREFIXES = [
  '原样', '原样tags', '原样tag', '原样 tags', '原样 tag',
  '直接画', '直接出图', '直接生图', '直接tags', '直接tag', '直接 tags', '直接 tag',
  '不优化', '无优化', '无优化tags', '无优化tag', '无优化 tags', '无优化 tag',
  '不要优化', '跳过优化', '跳过提示词优化', 'raw tags', 'raw tag', 'raw',
  'no optimize', 'no optimization', '不用优化',
]

function stripRawPrefix(prompt) {
  const text = String(prompt || '').trim()
  const lowered = text.toLowerCase()
  for (const prefix of RAW_PREFIXES) {
    if (lowered.startsWith(prefix.toLowerCase())) {
      return { raw: true, prompt: text.slice(prefix.length).replace(/^[\s,，;；:：]+/, '').trim() }
    }
  }
  return { raw: false, prompt: text }
}

function mergeTagText(existing, addition) {
  const tags = []
  const seen = new Set()
  for (const source of [existing, addition]) {
    for (const tag of String(source || '').split(',')) {
      const text = tag.trim()
      if (!text) continue
      const key = text.toLowerCase()
      if (seen.has(key)) continue
      tags.push(text)
      seen.add(key)
    }
  }
  return tags.join(', ') + (tags.length ? ',' : '')
}

function parseNameTags(text) {
  const raw = String(text || '').trim()
  const candidates = []
  for (const separator of ['=', '＝', '：', ':']) {
    const index = raw.indexOf(separator)
    if (index >= 0) candidates.push([index, separator])
  }
  candidates.sort((a, b) => a[0] - b[0])
  for (const [index, separator] of candidates) {
    const name = raw.slice(0, index).trim()
    const tags = raw.slice(index + separator.length).trim()
    if (!name || !tags) continue
    if (name.includes(',') || name.includes('\n')) continue
    if (/[@()[\]{}]/.test(name)) continue
    if (['artist', 'tag', 'tags', 'prompt', 'positive', 'negative'].includes(name.toLowerCase())) continue
    return { name, tags }
  }
  return null
}

function parsePresetList(list) {
  const result = {}
  for (const item of list || []) {
    const text = String(item || '').trim()
    if (!text) continue
    const parsed = parseNameTags(text)
    if (parsed) result[parsed.name] = parsed.tags
  }
  return result
}

// ------------------------------------------------------------------
// ComfyUI 工作流构建（移植自 anima comfyui_workflows）
// ------------------------------------------------------------------
function animaT2IWorkflow(cfg, prompt, negativePrompt, width, height, steps, cfgVal, seed) {
  return {
    '44': { class_type: 'UNETLoader', inputs: { unet_name: cfg.unetName, weight_dtype: 'fp8_e4m3fn' } },
    '45': { class_type: 'CLIPLoader', inputs: { clip_name: cfg.clipName, type: 'stable_diffusion', device: 'default' } },
    '15': { class_type: 'VAELoader', inputs: { vae_name: cfg.vaeName } },
    '28': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    '11': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['45', 0] } },
    '12': { class_type: 'CLIPTextEncode', inputs: { text: negativePrompt, clip: ['45', 0] } },
    '19': {
      class_type: 'KSampler',
      inputs: {
        model: ['44', 0],
        positive: ['11', 0],
        negative: ['12', 0],
        latent_image: ['28', 0],
        seed,
        steps,
        cfg: cfgVal,
        sampler_name: cfg.samplerName,
        scheduler: cfg.scheduler,
        denoise: 1,
      },
    },
    '8': { class_type: 'VAEDecodeTiled', inputs: { samples: ['19', 0], vae: ['15', 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'pdraw/anm' } },
  }
}

function buildWorkflow(cfg, prompt, negativePrompt, width, height, steps, cfgVal, seed, explicitSize) {
  if (cfg.customWorkflowEnabled && cfg.customWorkflowPath) {
    return customWorkflow(cfg, prompt, negativePrompt, width, height, steps, cfgVal, seed, explicitSize)
  }
  return animaT2IWorkflow(cfg, prompt, negativePrompt, width, height, steps, cfgVal, seed)
}

// 以图生图工作流（p-draw i2i）：LoadImage → VAEEncode → KSampler(denoise<1)
// 输入图编码为 latent 作为起点，尺寸保持原图，去噪强度由 cfg.img2imgDenoise 控制。
function animaI2IWorkflow(cfg, prompt, negativePrompt, width, height, steps, cfgVal, seed, inputImage, denoise) {
  return {
    '44': { class_type: 'UNETLoader', inputs: { unet_name: cfg.unetName, weight_dtype: 'fp8_e4m3fn' } },
    '45': { class_type: 'CLIPLoader', inputs: { clip_name: cfg.clipName, type: 'stable_diffusion', device: 'default' } },
    '15': { class_type: 'VAELoader', inputs: { vae_name: cfg.vaeName } },
    '13': { class_type: 'LoadImage', inputs: { image: inputImage } },
    '30': { class_type: 'VAEEncode', inputs: { pixels: ['13', 0], vae: ['15', 0] } },
    '11': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['45', 0] } },
    '12': { class_type: 'CLIPTextEncode', inputs: { text: negativePrompt, clip: ['45', 0] } },
    '19': {
      class_type: 'KSampler',
      inputs: {
        model: ['44', 0],
        positive: ['11', 0],
        negative: ['12', 0],
        latent_image: ['30', 0],
        seed,
        steps,
        cfg: cfgVal,
        sampler_name: cfg.samplerName,
        scheduler: cfg.scheduler,
        denoise,
      },
    },
    '8': { class_type: 'VAEDecodeTiled', inputs: { samples: ['19', 0], vae: ['15', 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'pdraw/anm_i2i' } },
  }
}

// 「换风格（漫画化）」i2i 工作流：LoadImage → 预处理器（LineArt / Canny）→ AnimaLLLiteApply_sdscripts 锁构图，
// VAEEncode 原图作起点，KSampler 用较高 denoise 整体转二次元风格。
// 注意：Anima 是 MiniTrainDIT 架构（隐藏层 3584 维），与 Qwen-Image 系 ControlNet 不兼容
// （InstantX 控制网期望 3584 维文本嵌入，Anima 只给 1024 维 → LayerNorm 崩溃）。
// 因此这里使用 Anima 原生支持的 ControlNet-LLLite（kohya-ss/ComfyUI-Anima-LLLite），
// 节点直接对 MODEL 打补丁并返回补丁后的模型，交给 KSampler。
// 预处理器：comfyui_controlnet_aux 的 AnimeLineArt/LineArt 节点（需安装该自定义节点）；
// 未安装时回退 ComfyUI 内置 Canny。anima-lllite-lineart 权重是按 lineart 训练的，用 LineArt 比 Canny 更贴。
function animaStyleI2IWorkflow(cfg, prompt, negativePrompt, width, height, steps, cfgVal, seed, inputImage, controlNetModel, controlNetStrength, denoise, preprocessor) {
  const detectRes = Math.max(width, height)
  const preprocessorNode = preprocessor === 'AnimeLineArtPreprocessor' || preprocessor === 'LineArtPreprocessor'
    ? { class_type: preprocessor, inputs: { image: ['13', 0], detect_resolution: detectRes, resolution: detectRes } }
    : { class_type: 'Canny', inputs: { image: ['13', 0], low_threshold: 0.4, high_threshold: 0.8 } }
  return {
    '44': { class_type: 'UNETLoader', inputs: { unet_name: cfg.i2iUnetName || cfg.unetName, weight_dtype: 'fp8_e4m3fn' } },
    '45': { class_type: 'CLIPLoader', inputs: { clip_name: cfg.clipName, type: 'stable_diffusion', device: 'default' } },
    '15': { class_type: 'VAELoader', inputs: { vae_name: cfg.vaeName } },
    '13': { class_type: 'LoadImage', inputs: { image: inputImage } },
    '30': { class_type: 'VAEEncode', inputs: { pixels: ['13', 0], vae: ['15', 0] } },
    '11': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['45', 0] } },
    '12': { class_type: 'CLIPTextEncode', inputs: { text: negativePrompt, clip: ['45', 0] } },
    '70': preprocessorNode,
    '71': { class_type: 'AnimaLLLiteApply_sdscripts', inputs: { model: ['44', 0], lllite_name: controlNetModel, image: ['70', 0], strength: controlNetStrength, start_percent: 0, end_percent: 1, preserve_wrapper: true } },
    '19': {
      class_type: 'KSampler',
      inputs: {
        model: ['71', 0],
        positive: ['11', 0],
        negative: ['12', 0],
        latent_image: ['30', 0],
        seed,
        steps,
        cfg: cfgVal,
        sampler_name: cfg.samplerName,
        scheduler: cfg.scheduler,
        denoise,
      },
    },
    '8': { class_type: 'VAEDecodeTiled', inputs: { samples: ['19', 0], vae: ['15', 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'pdraw/anm_i2i_style' } },
  }
}

// 「换装换姿势」i2i 工作流：LoadImage → AnimaSiglipeEncodeImage → AnimaIPAdapterApply 保角色特征，
// VAEEncode 原图作起点，KSampler 用中等 denoise 重画服装/姿势/场景。
function animaOotdI2IWorkflow(cfg, prompt, negativePrompt, width, height, steps, cfgVal, seed, inputImage, ipAdapterPath, ipAdapterWeight, denoise) {
  return {
    '44': { class_type: 'UNETLoader', inputs: { unet_name: cfg.unetName, weight_dtype: 'fp8_e4m3fn' } },
    '45': { class_type: 'CLIPLoader', inputs: { clip_name: cfg.clipName, type: 'stable_diffusion', device: 'default' } },
    '15': { class_type: 'VAELoader', inputs: { vae_name: cfg.vaeName } },
    '13': { class_type: 'LoadImage', inputs: { image: inputImage } },
    '30': { class_type: 'VAEEncode', inputs: { pixels: ['13', 0], vae: ['15', 0] } },
    '11': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['45', 0] } },
    '12': { class_type: 'CLIPTextEncode', inputs: { text: negativePrompt, clip: ['45', 0] } },
    '80': { class_type: 'AnimaIPAdapterLoader', inputs: { ipadapter_path: ipAdapterPath } },
    '81': { class_type: 'AnimaSiglipeEncodeImage', inputs: { image: ['13', 0] } },
    '82': { class_type: 'AnimaIPAdapterApply', inputs: { model: ['44', 0], ipadapter: ['80', 0], siglip_features: ['81', 0], start_at: 0, end_at: 1, weight: ipAdapterWeight } },
    '19': {
      class_type: 'KSampler',
      inputs: {
        model: ['82', 0],
        positive: ['11', 0],
        negative: ['12', 0],
        latent_image: ['30', 0],
        seed,
        steps,
        cfg: cfgVal,
        sampler_name: cfg.samplerName,
        scheduler: cfg.scheduler,
        denoise,
      },
    },
    '8': { class_type: 'VAEDecodeTiled', inputs: { samples: ['19', 0], vae: ['15', 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'pdraw/anm_i2i_ootd' } },
  }
}

// 根据 i2i 模式与已检测到的节点能力，决定最终工作流与去噪强度。
// mode：style=换风格（漫画化）/ ootd=换装换姿势 / 其他=基础 img2img
// caps：{ controlNet: { available, model }, ipAdapter: { available } }（由 detectI2ICapabilities 返回）
// 返回 { promptBody, kind, denoise }，kind 为 plain / controlnet / ipadapter。
function buildI2IWorkflow(cfg, prompt, negativePrompt, width, height, steps, cfgVal, seed, inputImage, mode, denoiseOverride, caps) {
  const fallbackDenoise = Number(cfg.img2imgDenoise) || 0.55
  if (mode === 'style') {
    if (caps && caps.controlNet && caps.controlNet.available && caps.controlNet.model) {
      const denoise = denoiseOverride != null ? denoiseOverride : (Number(cfg.i2iStyleDenoise) || 0.75)
      return {
        kind: 'controlnet',
        denoise,
        promptBody: animaStyleI2IWorkflow(cfg, prompt, negativePrompt, width, height, steps, cfgVal, seed, inputImage, caps.controlNet.model, Number(cfg.i2iControlNetStrength) || 0.7, denoise, caps.controlNet.preprocessor),
      }
    }
    // 没有 ControlNet：换风格又不想崩构图，denoise 自动压到 0.5 以内
    const denoise = denoiseOverride != null ? denoiseOverride : Math.min(Number(cfg.i2iStyleDenoise) || 0.75, 0.5)
    return { kind: 'plain', denoise, promptBody: animaI2IWorkflow(cfg, prompt, negativePrompt, width, height, steps, cfgVal, seed, inputImage, denoise) }
  }
  if (mode === 'ootd') {
    if (caps && caps.ipAdapter && caps.ipAdapter.available && String(cfg.i2iIPAdapterPath || '').trim()) {
      const denoise = denoiseOverride != null ? denoiseOverride : (Number(cfg.i2iOotdDenoise) || 0.55)
      return {
        kind: 'ipadapter',
        denoise,
        promptBody: animaOotdI2IWorkflow(cfg, prompt, negativePrompt, width, height, steps, cfgVal, seed, inputImage, String(cfg.i2iIPAdapterPath).trim(), Number(cfg.i2iIPAdapterWeight) || 0.8, denoise),
      }
    }
    const denoise = denoiseOverride != null ? denoiseOverride : (Number(cfg.i2iOotdDenoise) || 0.55)
    return { kind: 'plain', denoise, promptBody: animaI2IWorkflow(cfg, prompt, negativePrompt, width, height, steps, cfgVal, seed, inputImage, denoise) }
  }
  const denoise = denoiseOverride != null ? denoiseOverride : fallbackDenoise
  return { kind: 'plain', denoise, promptBody: animaI2IWorkflow(cfg, prompt, negativePrompt, width, height, steps, cfgVal, seed, inputImage, denoise) }
}

function customWorkflow(cfg, prompt, negativePrompt, width, height, steps, cfgVal, seed, explicitSize) {
  const rawPath = path.resolve(__dirname, cfg.customWorkflowPath)
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(rawPath, 'utf-8'))
  } catch (e) {
    throw new Error(`自定义工作流加载失败：${e.message}`)
  }
  const body = raw && typeof raw === 'object' && raw.prompt && typeof raw.prompt === 'object' ? raw.prompt : raw
  if (!body || typeof body !== 'object') throw new Error('自定义工作流 JSON 无效')

  const workflow = JSON.parse(JSON.stringify(body))
  const textNodes = []
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!node || typeof node !== 'object') continue
    const classType = String(node.class_type || '')
    const inputs = node.inputs
    if (classType.includes('TextEncode') && inputs && typeof inputs.text === 'string') {
      textNodes.push(String(nodeId))
    }
  }
  const positiveIds = conditioningTextNodeIds(workflow, 'positive', textNodes)
  const negativeIds = conditioningTextNodeIds(workflow, 'negative', textNodes)
  if (!positiveIds.length) throw new Error('自定义工作流中找不到正面提示词节点')
  if (!negativeIds.length) throw new Error('自定义工作流中找不到负面提示词节点')
  if (positiveIds.some(id => negativeIds.includes(id))) throw new Error('自定义工作流正负面节点有歧义')

  for (const nodeId of positiveIds) {
    if (workflow[nodeId] && workflow[nodeId].inputs) workflow[nodeId].inputs.text = prompt
  }
  for (const nodeId of negativeIds) {
    if (workflow[nodeId] && workflow[nodeId].inputs) workflow[nodeId].inputs.text = negativePrompt
  }

  for (const node of Object.values(workflow)) {
    if (!node || typeof node !== 'object') continue
    const classType = String(node.class_type || '')
    const inputs = node.inputs
    if (!inputs || typeof inputs !== 'object') continue
    if (classType === 'SaveImage' && 'filename_prefix' in inputs) {
      inputs.filename_prefix = 'pdraw/anm'
    }
    const override = Boolean(cfg.customWorkflowOverrideParameters)
    if ((override || explicitSize) && classType === 'EmptyLatentImage') {
      if ('width' in inputs) inputs.width = width
      if ('height' in inputs) inputs.height = height
    }
    if (override && (classType === 'KSampler' || classType === 'KSamplerAdvanced')) {
      if ('steps' in inputs) inputs.steps = steps
      if ('cfg' in inputs) inputs.cfg = cfgVal
      if (cfg.samplerName && 'sampler_name' in inputs) inputs.sampler_name = cfg.samplerName
      if (cfg.scheduler && 'scheduler' in inputs) inputs.scheduler = cfg.scheduler
    }
    if ('seed' in inputs) inputs.seed = seed
    if ('noise_seed' in inputs) inputs.noise_seed = seed
  }
  return workflow
}

function conditioningTextNodeIds(workflow, inputName, textNodes) {
  const pending = []
  for (const node of Object.values(workflow)) {
    if (!node || typeof node !== 'object') continue
    if (!['KSampler', 'KSamplerAdvanced'].includes(String(node.class_type || ''))) continue
    const link = node.inputs && node.inputs[inputName]
    if (Array.isArray(link) && link.length) pending.push(String(link[0]))
  }
  const found = []
  const visited = new Set()
  while (pending.length) {
    const nodeId = pending.pop()
    if (visited.has(nodeId)) continue
    visited.add(nodeId)
    if (textNodes.includes(nodeId)) {
      found.push(nodeId)
      continue
    }
    const node = workflow[nodeId]
    const inputs = node && node.inputs
    if (!inputs || typeof inputs !== 'object') continue
    for (const value of Object.values(inputs)) {
      if (Array.isArray(value) && value.length) {
        const sourceId = String(value[0])
        if (workflow[sourceId]) pending.push(sourceId)
      }
    }
  }
  return found
}

function outputImages(history) {
  const images = []
  const outputs = history.outputs || {}
  if (outputs && typeof outputs === 'object') {
    for (const nodeOutput of Object.values(outputs)) {
      if (!nodeOutput || typeof nodeOutput !== 'object') continue
      for (const image of nodeOutput.images || []) {
        if (image && typeof image === 'object') images.push(image)
      }
    }
  }
  return images
}

// ------------------------------------------------------------------
// ComfyUI 结果等待：优先 WebSocket 事件，失败/不可用回退轮询
// ------------------------------------------------------------------
function waitViaWebSocket(baseUrl, promptId, clientId, timeoutMs) {
  return new Promise((resolve) => {
    let socket
    let timer = null
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try { if (socket) socket.close() } catch (e) { /* ignore */ }
      resolve(ok)
    }
    try {
      const wsUrl = baseUrl.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:') + `/ws?clientId=${encodeURIComponent(clientId)}`
      socket = new WebSocket(wsUrl)
    } catch (e) {
      finish(false)
      return
    }
    timer = setTimeout(() => finish(false), timeoutMs)
    socket.onmessage = (ev) => {
      let msg
      try { msg = JSON.parse(String(ev.data)) } catch (e) { return }
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'execution_success' && msg.data && msg.data.prompt_id === promptId) { finish(true); return }
      if (msg.type === 'execution_error' || msg.type === 'execution_interrupted') { finish(false) }
    }
    socket.onerror = () => finish(false)
    socket.onclose = () => finish(false)
  })
}

async function waitComfyResult(ctx, comfyGet, baseUrl, promptId, clientId, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs
  if (typeof WebSocket !== 'undefined') {
    const remaining = Math.max(0, deadline - Date.now())
    try {
      const viaWs = await waitViaWebSocket(baseUrl, promptId, clientId, remaining)
      if (viaWs) {
        try {
          const data = await comfyGet(`/history/${promptId}`, 20000)
          if (data && data[promptId]) return data[promptId]
        } catch (e) { /* fall through */ }
      }
    } catch (e) { /* fall through to polling */ }
  }
  while (Date.now() < deadline) {
    try {
      const data = await comfyGet(`/history/${promptId}`, 20000)
      if (data && data[promptId]) return data[promptId]
    } catch (e) { /* transient */ }
    await ctx.sleep(pollMs)
  }
  return null
}

// ------------------------------------------------------------------
// Tag 清洗（移植自 anima tag_cleaner）
// ------------------------------------------------------------------
function splitTags(text) {
  let cleaned = String(text || '')
  cleaned = cleaned.replace(/```[\s\S]*?```/g, m => m.slice(3, -3).trim())
  cleaned = cleaned.replace(/，/g, ',').replace(/、/g, ',').replace(/;/g, ',')
  cleaned = cleaned.replace(/\n/g, ',')
  cleaned = cleaned.replace(/^(?:positive|prompt|tags|提示词|正向提示词)\s*[:：]/i, '')
  const parts = cleaned.split(',').map(p => p.trim().replace(/^[\s,.;:：]+|[\s,.;:：]+$/g, ''))
  return parts.filter(Boolean)
}

function normalizeTagKey(tag) {
  let value = String(tag || '').trim().toLowerCase()
  if (
    value.startsWith('(') && value.endsWith(')') &&
    (value.match(/\(/g) || []).length === 1 &&
    (value.match(/\)/g) || []).length === 1
  ) {
    value = value.slice(1, -1).trim()
  }
  value = value.replace(/:\s*[\d.]+$/, '')
  value = value.replace(/\s+/g, ' ')
  return value
}

function stripWrappingBrackets(text) {
  let value = String(text || '').trim()
  const pairs = { '(': ')', '[': ']', '{': '}' }
  let changed = true
  while (changed && value.length >= 2) {
    changed = false
    const left = value[0]
    const right = pairs[left]
    if (right && value.endsWith(right)) {
      value = value.slice(1, -1).trim()
      changed = true
    }
  }
  return value
}

const ARTIST_FUNCTION_RE = /^artist\s*:\s*([^:=()[\]{}]+?)\s*(?:[:=]\s*[-+]?(?:\d+(?:\.\d+)?|\.\d+)\s*)?$/i

function normalizeAnimaArtistTag(tag) {
  const raw = String(tag || '').trim()
  if (!raw) return ''
  if (raw.startsWith('@')) {
    const name = raw.slice(1).trim().replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
    return name ? `@${name}` : raw
  }
  const inner = stripWrappingBrackets(raw)
  const match = ARTIST_FUNCTION_RE.exec(inner)
  if (!match) return raw
  let name = match[1].trim()
  if (name.startsWith('@')) name = name.slice(1).trim()
  name = name.replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
  return name ? `@${name}` : raw
}

function canonicalTagText(tag) {
  const artistTag = normalizeAnimaArtistTag(tag)
  if (artistTag.startsWith('@')) return artistTag
  const key = normalizeTagKey(tag)
  if (key === '1 girl') return '1girl'
  if (key === 'punis') return 'penis'
  if (['point a sword at the audience', 'point a sword at viewer', 'point sword at the audience', 'point sword at viewer'].includes(key)) return 'sword pointed at viewer'
  return String(tag || '').trim()
}

// 内联画师标签（@name / artist:name）与内联质量词（masterpiece / best quality / score_N 等）。
// 提示词优化会把它们交给 LLM 重写并剥掉，这里在优化后把它们从原始输入中补回，
// 避免用户直接写在消息里的画师标签 / 质量词丢失。
const INLINE_QUALITY_RE = /^(masterpiece|best quality|amazing quality|high quality|good quality|score_\d+)$/i

function appendInlineProtectedTags(prompt, original, raw) {
  if (raw || !original) return prompt
  if (/(不用我的风格|不要我的风格|不使用我的风格|不要画师词|不用画师词|不加画师词|no artist)/i.test(original)) return prompt
  const tags = []
  const seen = new Set(splitTags(prompt).map(t => normalizeTagKey(t)))
  for (const token of splitTags(original)) {
    const t = String(token || '').trim()
    if (!t) continue
    const artist = normalizeAnimaArtistTag(t)
    if (artist.startsWith('@')) {
      const key = normalizeTagKey(artist)
      if (!seen.has(key)) {
        seen.add(key)
        tags.push(artist)
      }
      continue
    }
    if (INLINE_QUALITY_RE.test(t)) {
      const key = normalizeTagKey(t)
      if (!seen.has(key)) {
        seen.add(key)
        tags.push(t)
      }
    }
  }
  if (!tags.length) return prompt
  return prompt + ', ' + tags.join(', ')
}

const QUALITY_BLOCKLIST = new Set([
  'masterpiece', 'best quality', 'score_7', 'score_6', 'score_5', 'score_4', 'score_3', 'score_2', 'score_1',
  'safe', 'worst quality', 'low quality', 'artist name',
])
const CHARACTER_BLOCKLIST = new Set(['1 girl', '1girl', 'solo'])
const CHARACTER_IDENTITY_EXACT_BLOCKLIST = new Set([
  'girl', 'boy', 'child', 'teenager', 'young adult', 'adult', 'mature', 'loli', 'shota', 'petite', 'aged down', 'age regression',
  'vampire', 'angel', 'demon', 'fox girl', 'cat girl', 'animal girl',
  'ahoge', 'bangs', 'blunt bangs', 'sidelocks', 'hair between eyes', 'long hair', 'short hair', 'medium hair', 'very long hair',
  'twintails', 'low twintails', 'braids', 'side braid', 'ponytail', 'side ponytail', 'one side up', 'hair bun', 'double bun',
  'heterochromia', 'blue eyes', 'red eyes', 'green eyes', 'pink eyes', 'purple eyes', 'yellow eyes', 'golden eyes', 'grey eyes',
  'gray eyes', 'brown eyes', 'black eyes', 'black hair', 'brown hair', 'blonde hair', 'white hair', 'silver hair', 'blue hair',
  'red hair', 'pink hair', 'purple hair', 'green hair', 'grey hair', 'gray hair',
  'fox ears', 'cat ears', 'animal ears', 'pointed ears', 'tail', 'fox tail', 'cat tail', 'wings', 'angel wings', 'demon wings',
  'horns', 'halo', 'fang', 'freckles',
])
const CHARACTER_IDENTITY_PATTERNS = [
  /\b(?:black|brown|blonde|white|silver|blue|red|pink|purple|green|grey|gray|orange|gold|golden|light|dark|ice blue|silver white)\s+hair\b/,
  /\b(?:black|brown|blue|red|pink|purple|green|grey|gray|gold|golden|light|dark|ice blue|amber)\s+eyes?\b/,
  /\b(?:ears?|tail|wings?|horns?|halo|fangs?|heterochromia)\b/,
  /\b(?:vampire|angel|demon|fox girl|cat girl|animal girl)\b/,
  /\b(?:loli|shota|teenager|young adult|adult|mature|aged down|age regression)\b/,
]
const MULTI_CHARACTER_BLOCKLIST = new Set([
  '2girls', '3girls', '4girls', '5girls', '6+girls', 'multiple girls',
  '2boys', '3boys', '4boys', '5boys', '6+boys', 'multiple boys',
  'multiple people', 'crowd', 'group', 'background characters', 'extra girl', 'extra person', 'clone', 'duplicate', 'twins',
])
const NON_VISUAL_TAGS = new Set(['holding nothing'])
const EXCLUSIVE_TAG_GROUPS = {
  'looking at viewer': 'gaze_target', 'looking away': 'gaze_target',
  'light rays': 'light_beams', 'sun rays': 'light_beams', 'sunbeams': 'light_beams', 'sunlight rays': 'light_beams',
  'glowing': 'light_intensity', 'illuminated': 'light_intensity', 'bright': 'light_intensity', 'luminous': 'light_intensity', 'radiant': 'light_intensity',
  'backlight': 'backlighting', 'backlighting': 'backlighting',
  'rim light': 'rim_lighting', 'rim lighting': 'rim_lighting',
  'soft light': 'soft_lighting', 'soft lighting': 'soft_lighting',
  'floating particles': 'light_particles', 'light particles': 'light_particles', 'glowing particles': 'light_particles',
  'flowing dress': 'flowing_dress', 'dress flowing': 'flowing_dress',
  'hair blowing': 'wind_in_hair', 'wind in hair': 'wind_in_hair',
  'sad expression': 'sad_expression', 'sorrowful expression': 'sad_expression',
  'teary eyes': 'tearful_eyes', 'watery eyes': 'tearful_eyes', 'wet eyes': 'tearful_eyes',
}
const TAG_GROUP_LIMITS = { light_intensity: 2 }

function isCharacterIdentityTag(key) {
  const compact = normalizeTagKey(key).replace(/_/g, ' ')
  if (!compact) return false
  if (CHARACTER_IDENTITY_EXACT_BLOCKLIST.has(compact)) return true
  return CHARACTER_IDENTITY_PATTERNS.some(pattern => pattern.test(compact))
}

function cleanContentTags(text, maxTags = 65, stripCharacterTags = true, protectedCoreTags = [], allowMultiCharacter = false) {
  const tags = splitTags(text)
  const seen = new Set()
  const cleaned = []
  const artistRe = /^@\S+/
  const protectedSet = new Set(protectedCoreTags.map(t => normalizeTagKey(t)))
  const parenthesizedCoreRe = /^[a-z0-9_.'-]+_\([a-z0-9_.' -]{2,60}\)$/i
  for (let tag of tags) {
    tag = canonicalTagText(tag)
    const key = normalizeTagKey(tag)
    if (!key) continue
    if (seen.has(key)) continue
    if (QUALITY_BLOCKLIST.has(key)) continue
    if (stripCharacterTags && CHARACTER_BLOCKLIST.has(key)) continue
    if (stripCharacterTags && isCharacterIdentityTag(key)) continue
    if (!allowMultiCharacter && MULTI_CHARACTER_BLOCKLIST.has(key)) continue
    if (protectedSet.size && parenthesizedCoreRe.test(key) && !protectedSet.has(key)) continue
    if (artistRe.test(tag.trim())) continue
    if (tag.length > 80) continue
    seen.add(key)
    cleaned.push(tag)
  }
  const semanticKeys = cleaned.map(tag => normalizeTagKey(stripWrappingBrackets(tag)))
  const fullNudityKey = semanticKeys.includes('nude') ? 'nude' : 'naked'
  const hasFullNudity = semanticKeys.includes(fullNudityKey)
  const hasSpecificMist = semanticKeys.includes('morning mist')
  const hasClosedEyes = semanticKeys.some(k => k === 'closed eyes' || k === 'eyes closed')
  const hasSheerFabric = semanticKeys.includes('sheer fabric')
  const groupCounts = {}
  const semanticCleaned = []
  cleaned.forEach((tag, i) => {
    const key = semanticKeys[i]
    if (NON_VISUAL_TAGS.has(key)) return
    if (hasFullNudity && ['nude', 'naked', 'topless', 'bottomless'].includes(key)) {
      if (key !== fullNudityKey) return
    }
    if (hasSpecificMist && key === 'mist') return
    if (hasClosedEyes && key.includes('looking') && key.includes('viewer')) return
    if (hasSheerFabric && key === 'translucent fabric') return
    const group = EXCLUSIVE_TAG_GROUPS[key.replace(/_/g, ' ')]
    if (group) {
      const count = groupCounts[group] || 0
      if (count >= (TAG_GROUP_LIMITS[group] != null ? TAG_GROUP_LIMITS[group] : 1)) return
      groupCounts[group] = count + 1
    }
    semanticCleaned.push(tag)
  })
  return semanticCleaned.slice(0, maxTags).join(', ')
}

function joinPromptParts(parts) {
  const tags = []
  const seen = new Set()
  for (const part of parts) {
    for (const tag of splitTags(part)) {
      const canonical = canonicalTagText(tag)
      const key = normalizeTagKey(canonical)
      if (!key || seen.has(key)) continue
      seen.add(key)
      tags.push(canonical)
    }
  }
  return tags.join(', ')
}

// ------------------------------------------------------------------
// 多人规划（移植自 anima multi_person_prompt）
// ------------------------------------------------------------------
const MULTI_PERSON_NEGATIVE_TAGS = [
  'split screen', 'comic panels', 'multiple views', 'character sheet',
  'duplicate characters', 'cloned character', 'extra person', 'extra girl', 'extra boy',
  'twins', 'merged bodies', 'fused characters',
]

const MULTI_SAFE_SLOTS = new Set(['left', 'right', 'center', 'foreground', 'background', 'far left', 'far right'])
const MULTI_UNSAFE_COMPOSITION_MARKERS = [
  'split screen', 'panel', 'multiple views', 'alternate views', 'character sheet',
  'top left', 'top right', 'bottom left', 'bottom right',
]
const MULTI_SAFE_SPATIAL_MODES = new Set(['shared_contact', 'shared_scene', 'explicit_positions'])

function buildMultiPersonPlanPrompt(userPrompt, fixedCharacters = {}) {
  const fixedNote = Object.keys(fixedCharacters).length
    ? `Locally saved characters explicitly mentioned by the user:\n${JSON.stringify(fixedCharacters, null, 2)}`
    : 'No locally saved character name was detected.'
  return `Plan one coherent Anima image containing 2 to 4 people.

Use the user's requested identities, count, clothing, expressions, props, positions, and relationships. You may freely design compatible mutable details, background, lighting, and atmosphere when the user leaves them open.

Separate every person into an independent semantic block. Position slots are bookkeeping only and must never describe separate regions, panels, views, or sides of the image. Prefer one shared central group. Use explicit positions only when the user directly asks for left/right or foreground/background placement. Never use top_left, top_right, bottom_left, bottom_right, upper, lower, panel, or "side of the image".

For an existing named character, preserve the user's written name in "name" and provide the most likely Danbooru character tag in "danbooru_candidate". For an original or generic person, leave "danbooru_candidate" empty.

When a person matches one of the locally saved characters below, their saved tags are authoritative. Leave "appearance" empty and do not restate or alter their hair, eyes, species, ears, tail, body type, age, or fixed accessories. Only plan mutable clothing, expression, pose, and props.

Return JSON only with this exact shape:
{
  "count_tags": ["2girls"],
  "common_tags": ["medium shot", "outdoors"],
  "characters": [
    {
      "slot": "left",
      "name": "character name from the user",
      "danbooru_candidate": "romanized_character_tag",
      "role": "short semantic role such as rider or supporting girl",
      "visual_label": "distinctive visible label such as white-haired fox girl",
      "identity_anchors": ["3 to 6 short appearance tags"],
      "emphasized_anchors": ["0 to 3 explicitly requested unusual traits"],
      "appearance": "Visible identity traits for a non-fixed character only; empty for a locally saved character.",
      "clothing": "One concise English clothing phrase.",
      "expression": "One concise English expression phrase.",
      "pose": "One concise English body pose that does not repeat the interaction.",
      "props": ["visible prop held or worn by this person"]
    },
    {
      "slot": "right",
      "name": "second character name from the user",
      "danbooru_candidate": "romanized_character_tag",
      "appearance": "",
      "clothing": "One concise English clothing phrase.",
      "expression": "One concise English expression phrase.",
      "pose": "One concise English body pose.",
      "props": []
    }
  ],
  "relationship_tag": "holding hands",
  "interactions": [
    "Character A is holding Character B's hand."
  ],
  "spatial_mode": "shared_contact",
  "composition": "A single unified full-frame composition using one camera view."
}

Rules:
- Include exactly 2 to 4 character objects.
- count_tags must agree with the number and genders requested by the user.
- common_tags contain only shared scene, framing, camera, lighting, atmosphere, and count tags.
- relationship_tag is one short Danbooru-style relationship or action tag and appears immediately after the count tags in the final prompt.
- Do not put character names or character-specific appearance in common_tags.
- role is optional semantic bookkeeping and is not used to identify a person in the final interaction sentence.
- visual_label must be a unique 2 to 6 word visible description derived from identity_anchors, such as "white-haired fox girl" or "silver-haired vampire girl". Do not use names, ordinal labels, rider, supporter, top, bottom, left, or right as visual_label.
- identity_anchors must contain only 3 to 6 concise visible identity traits. For locally saved characters, select them only from the saved defining tags.
- emphasized_anchors may contain at most 3 identity_anchors that the user explicitly requested and that are unusual, contrastive, or likely to be confused between people. Never invent emphasis.
- For locally saved characters, appearance must be empty and saved defining tags must never be contradicted.
- Do not output quality tags, safety tags, artist tags, Markdown, or explanations.
- Keep character fields and relationships visually concrete.
- Preserve the user's explicit interaction direction and gaze direction.
- Put the complete directed relationship in exactly one interactions entry. Character pose fields must not repeat the relationship.
- Refer to people inside interactions exclusively as Character A, Character B, Character C, or Character D. Never use their names, translated names, or Danbooru tags there.
- spatial_mode must be shared_contact for physical interaction, shared_scene for a non-contact group, or explicit_positions only when the user explicitly requests relative positions.
- Prefer a single coherent moment rather than multiple competing actions.
- composition must use affirmative language to request one unified full-frame camera view.

${fixedNote}

User request:
${userPrompt}
`
}

function cleanMultiText(value, limit) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit).trim()
}

function multiStringTuple(value, limit, itemLimit) {
  if (!Array.isArray(value)) return []
  const result = []
  for (const item of value) {
    const text = cleanMultiText(item, itemLimit)
    if (text) result.push(text)
  }
  return result.slice(0, limit)
}

function normalizeMultiSlot(value) {
  const slot = cleanMultiText(value, 40).toLowerCase().replace(/_/g, ' ').replace(/-/g, ' ').replace(/\s+/g, ' ').trim()
  return MULTI_SAFE_SLOTS.has(slot) ? slot : ''
}

function parseMultiPersonPlan(text) {
  let raw = String(text || '').trim()
  raw = raw.replace(/^```(?:json)?\s*/i, '')
  raw = raw.replace(/\s*```$/, '')
  const match = raw.match(/\{[\s\S]*\}/)
  if (match) raw = match[0]
  let data
  try {
    data = JSON.parse(raw)
  } catch (e) {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const rawCharacters = data.characters
  if (!Array.isArray(rawCharacters) || rawCharacters.length < 2 || rawCharacters.length > 4) return null
  if (rawCharacters.some(item => !item || typeof item !== 'object')) return null

  const defaultSlots = {
    2: ['left', 'right'],
    3: ['left', 'center', 'right'],
    4: ['far left', 'left', 'right', 'far right'],
  }[rawCharacters.length]
  const proposedSlots = rawCharacters.map(item => normalizeMultiSlot(item.slot))
  if (
    proposedSlots.some(slot => !slot) ||
    new Set(proposedSlots).size !== proposedSlots.length ||
    (rawCharacters.length === 2 && !(new Set(proposedSlots).size === 2 && ['left', 'right'].every(s => proposedSlots.includes(s)) || ['foreground', 'background'].every(s => proposedSlots.includes(s))))
  ) {
    proposedSlots.splice(0, proposedSlots.length, ...defaultSlots)
  }

  const characters = proposedSlots.map((slot, index) => {
    const item = rawCharacters[index]
    return {
      slot,
      name: cleanMultiText(item.name, 120),
      danbooru_candidate: cleanMultiText(item.danbooru_candidate, 160),
      appearance: cleanMultiText(item.appearance, 500),
      clothing: cleanMultiText(item.clothing, 400),
      expression: cleanMultiText(item.expression, 240),
      pose: cleanMultiText(item.pose, 400),
      props: multiStringTuple(item.props, 12, 120),
      role: cleanMultiText(item.role, 80),
      visual_label: cleanMultiText(item.visual_label, 100),
      identity_anchors: multiStringTuple(item.identity_anchors, 6, 100),
      emphasized_anchors: multiStringTuple(item.emphasized_anchors, 3, 100),
    }
  })

  const countTags = multiStringTuple(data.count_tags, 8, 80)
  const commonTags = multiStringTuple(data.common_tags, 50, 100)
  const interactions = multiStringTuple(data.interactions, 1, 500)
  const composition = cleanMultiText(data.composition, 700)
  let spatialMode = cleanMultiText(data.spatial_mode, 40).toLowerCase()
  const relationshipTag = cleanMultiText(data.relationship_tag, 120)
  if (!MULTI_SAFE_SPATIAL_MODES.has(spatialMode)) spatialMode = interactions.length ? 'shared_contact' : 'shared_scene'
  let compositionSafe = composition
  if (MULTI_UNSAFE_COMPOSITION_MARKERS.some(marker => compositionSafe.toLowerCase().includes(marker))) compositionSafe = ''
  return {
    count_tags: countTags.length ? countTags : [`${characters.length}people`],
    common_tags: commonTags,
    characters,
    interactions,
    composition: compositionSafe,
    spatial_mode: spatialMode,
    relationship_tag: relationshipTag,
  }
}

function renderMultiPersonCharacter(character, opts = {}) {
  const {
    alias = '', resolvedIdentity = '', fixedTags = '', groupedContact = false,
    explicitPositions = false, identityAnchors = [], includePose = true,
  } = opts
  let label = String(alias || character.visual_label || character.role || '').trim()
  if (explicitPositions && character.slot) label = `${character.slot} ${label}`
  const identity = String(resolvedIdentity || character.danbooru_candidate || '').trim()
  const details = []
  if (identity && !fixedTags) details.push(identity)
  if (identityAnchors.length) {
    details.push(...identityAnchors)
  } else if (fixedTags) {
    for (const part of fixedTags.split(',')) {
      const t = part.trim().replace(/^ +| +$/g, '').replace(/^\(|\)$/g, '')
      if (t) details.push(t)
    }
  }
  if (!identityAnchors.length && !fixedTags && character.appearance) details.push(character.appearance)
  if (character.clothing) details.push(character.clothing)
  if (character.expression) details.push(character.expression)
  if (includePose && character.pose) details.push(character.pose)
  if (character.props && character.props.length) details.push(...character.props)
  const joined = details.filter(Boolean).join(', ')
  return `${label}: ${joined}.`
}

// ------------------------------------------------------------------
// 多人尺寸自动选择（移植自 anima command_actions multi_person 分支）
// ------------------------------------------------------------------
function multiPersonAutoSize(prompt, allowedSizes) {
  if (!Array.isArray(allowedSizes) || !allowedSizes.length) return null
  const promptLower = String(prompt || '').toLowerCase()
  const threeOrMore = /\b(?:三|四|3|4)\s*(?:人|个|名|girls?|boys?|people)\b|\b(?:3|4)(?:girls?|boys?|people)\b/.test(promptLower)
  const verticallyStacked = [
    '骑在肩', '骑肩', '肩膀上', '背着', '抱起', '扑倒', '压在', '上下叠',
    'on the shoulders', 'piggyback', 'carrying', 'on top of', 'stacked',
  ].some(marker => promptLower.includes(marker))
  const physicalContact = [
    '牵手', '拥抱', '接吻', '搂着', '抱着', '挽着',
    'holding hands', 'hugging', 'embracing', 'kissing', 'arm around',
  ].some(marker => promptLower.includes(marker))
  const target = threeOrMore
    ? [1216, 832]
    : verticallyStacked
      ? [1024, 1536]
      : physicalContact
        ? [1024, 1024]
        : [1152, 896]
  let best = allowedSizes[0]
  let bestScore = Infinity
  for (const size of allowedSizes) {
    const ratioDiff = Math.abs(size[0] / size[1] - target[0] / target[1])
    const areaDiff = Math.abs(size[0] * size[1] - target[0] * target[1])
    const score = ratioDiff * 10000 + areaDiff
    if (score < bestScore) {
      bestScore = score
      best = size
    }
  }
  return best
}

// ------------------------------------------------------------------
// 插件主体
// ------------------------------------------------------------------
exports.apply = async function apply(ctx, cfg) {
  // 注意：不在此处 extend p_system 表 —— 该表由 p-qiandao 等 p 系插件创建。
  // 重复声明同一张表可能导致 Koishi 的 schema 迁移冲突，拖垮签到插件。

  const logger = ctx.logger('p-draw')
  ctx.i18n.define('zh-CN', zhCN)

  // 运行时数据（画师组/固定角色）持久化到 p_draw_config 表，而不是调用 scope.update
  // 写 koishi.yml：scope.update 会触发插件重载，导致正在生成的图被 dispose（Context has
  // been disposed），且连续多次写入时配置文件会被冲掉（曾出现配置整体恢复成默认）。
  try {
    ctx.model.extend('p_draw_config', {
      id: 'unsigned',
      fixed_characters: 'json',
      artist_presets: 'json',
      active_artist_preset: 'text',
      default_artist_tags: 'text',
      user_models: 'json',
    }, { autoInc: true })
  } catch (e) {
    logger.warn(`p_draw_config 表初始化失败：${e.message}`)
  }

  // 用户自选模型偏好（userid -> unet 文件名），持久化在 p_draw_config.user_models
  if (!cfg.userModels || typeof cfg.userModels !== 'object') cfg.userModels = {}

  const tempDir = path.join(__dirname, 'temp')
  if (!fs.existsSync(tempDir)) {
    try { fs.mkdirSync(tempDir, { recursive: true }) } catch (e) { logger.warn('无法创建临时目录：' + e.message) }
  }

  const baseUrl = () => normalizeBaseUrl(cfg.comfyuiBaseUrl)

  function parseAllowedSizes() {
    const sizes = []
    for (const item of cfg.allowedSizes || []) {
      const m = String(item).match(/^\s*(\d{2,5})\s*[xX×*＊✕✖хХ]\s*(\d{2,5})\s*$/)
      if (m) sizes.push([parseInt(m[1]), parseInt(m[2])])
    }
    return sizes
  }

  async function comfyGet(apiPath, timeout = 20000) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const res = await fetch(baseUrl() + apiPath, { signal: controller.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } finally {
      clearTimeout(timer)
    }
  }
  async function comfyPost(apiPath, body, timeout = 20000) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const res = await fetch(baseUrl() + apiPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!res.ok) {
        // ComfyUI /prompt 校验失败时会返回 node_errors 等详细错误，尽量带出来便于排查
        const text = await res.text().catch(() => '')
        const detail = (() => {
          try {
            const data = JSON.parse(text)
            const nodeErrors = (data && data.node_errors) || (data && data.error && data.error.extra_info && data.error.extra_info.node_errors) || null
            if (nodeErrors && typeof nodeErrors === 'object') {
              const lines = Object.entries(nodeErrors).map(([id, e]) => {
                const cls = (e && e.class_type) || ''
                const errs = (e && Array.isArray(e.errors) && e.errors.length)
                  ? e.errors.map(x => `${(x && x.message) || ''}${x && x.details ? ' | ' + x.details : ''}`.trim()).join('; ')
                  : JSON.stringify(e)
                return `  #${id} [${cls}]: ${errs}`
              })
              if (lines.length) return `\n${lines.join('\n')}`
            }
            if (data && data.error) {
              return `${data.error.message || ''}${data.error.details ? ' ' + data.error.details : ''}`.trim()
            }
          } catch (e) { /* ignore */ }
          return text.slice(0, 800)
        })()
        throw new Error(`HTTP ${res.status}${detail ? '：' + detail : ''}`)
      }
      return await res.json()
    } finally {
      clearTimeout(timer)
    }
  }
  async function comfyGetBytes(apiPath, timeout = 120000) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const res = await fetch(baseUrl() + apiPath, { signal: controller.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    } finally {
      clearTimeout(timer)
    }
  }

  // ---------------- 状态 ----------------
  let objectInfoCache = null
  let objectInfoCacheAt = 0

  // /object_info 可能返回体巨大或接口本身很慢（自定义节点多），
  // 用短超时 + 10 分钟缓存，避免每次状态检查都干等。
  async function getObjectInfoCached() {
    if (objectInfoCache && Date.now() - objectInfoCacheAt < 10 * 60 * 1000) {
      return objectInfoCache
    }
    const data = await comfyGet('/object_info', 5000)
    objectInfoCache = data
    objectInfoCacheAt = Date.now()
    return data
  }

  async function statusPayload() {
    const sizes = parseAllowedSizes()
    const payload = {
      ok: true,
      base_url: baseUrl(),
      workflow: cfg.workflow,
      allowed_sizes: sizes.map(s => `${s[0]}x${s[1]}`),
      comfyui_api_reachable: false,
    }
    let stats
    try {
      stats = await comfyGet('/system_stats', 8000)
    } catch (e) {
      payload.ok = false
      payload.error = String(e && e.message || e)
      payload.connection_issue = classifyComfyError(e)
      payload.comfyui_api_reachable = false
      return payload
    }
    payload.comfyui_api_reachable = true
    // /object_info 可能很慢，单独容错：失败不判离线
    let objectInfo = null
    try {
      objectInfo = await getObjectInfoCached()
    } catch (e) {
      payload.object_info_warning = String(e && e.message || e)
    }
    const devices = stats && stats.devices ? stats.devices : []
    const device = devices[0] || {}
    payload.comfyui_version = stats && stats.system ? stats.system.comfyui_version : undefined
    payload.gpu = device.name
    payload.vram_total_mb = Math.round((device.vram_total || 0) / 1024 / 1024)
    payload.vram_free_mb = Math.round((device.vram_free || 0) / 1024 / 1024)
    if (objectInfo) {
      const unetList = availableModels(objectInfo, 'UNETLoader', 'unet_name')
      const clipList = availableModels(objectInfo, 'CLIPLoader', 'clip_name')
      const vaeList = availableModels(objectInfo, 'VAELoader', 'vae_name')
      payload.unet_available = unetList.includes(cfg.unetName)
      payload.unet_models = unetList
      payload.i2i_unet_available = unetList.includes(String(cfg.i2iUnetName || '').trim() || cfg.unetName)
      payload.clip_available = clipList.includes(cfg.clipName)
      payload.vae_available = vaeList.includes(cfg.vaeName)
    } else {
      payload.unet_available = undefined
      payload.i2i_unet_available = undefined
      payload.clip_available = undefined
      payload.vae_available = undefined
    }
    return payload
  }

  function classifyComfyError(e) {
    const text = String((e && e.message) || e || '').toLowerCase()
    if (text.includes('timeout') || text.includes('timed out')) return 'timeout'
    if (text.includes('refused') || text.includes('econnrefused')) return 'refused'
    if (text.includes('dns') || text.includes('enotfound') || text.includes('getaddrinfo')) return 'dns'
    return 'unknown'
  }

  function availableModels(objectInfo, node, inputName) {
    try {
      const value = objectInfo[node].input.required[inputName]
      if (Array.isArray(value) && value.length && Array.isArray(value[0])) {
        return value[0].map(String)
      }
    } catch (e) { /* ignore */ }
    return []
  }

  function statusText(payload) {
    if (!payload.comfyui_api_reachable) {
      const issue = payload.connection_issue
      const hint = issue === 'timeout'
        ? '连接超时。请确认 ComfyUI 已启动，且监听了可从本机访问的地址；跨机访问需确认防火墙放行 8188 端口。'
        : issue === 'refused'
          ? '连接被拒绝。请确认 ComfyUI 已启动，且端口与地址正确；服务端需使用 --listen 0.0.0.0 启动才能被局域网访问。'
          : issue === 'dns'
            ? '域名无法解析。请确认地址正确。'
            : '请先启动 ComfyUI，并确认地址正确。'
      return `ComfyUI 状态：离线\n地址：${payload.base_url}\n提示：${hint}\n错误：${payload.error || 'unknown'}`
    }
    const modelStatus = (configured, available) => {
      if (available === undefined) return '（未获取）'
      return available ? '✓' : '✗ 不可用'
    }
    const lines = [
      `ComfyUI 状态：在线`,
      `版本：${payload.comfyui_version || '未知'}`,
      `GPU：${payload.gpu || '未知'}（显存 ${payload.vram_total_mb}MB / 空闲 ${payload.vram_free_mb}MB）`,
      `主模型：${cfg.unetName} ${modelStatus(cfg.unetName, payload.unet_available)}`,
      `换风格模型：${cfg.i2iUnetName || cfg.unetName} ${modelStatus(cfg.i2iUnetName || cfg.unetName, payload.i2i_unet_available)}`,
      `文本编码器：${cfg.clipName} ${modelStatus(cfg.clipName, payload.clip_available)}`,
      `VAE：${cfg.vaeName} ${modelStatus(cfg.vaeName, payload.vae_available)}`,
      `可用尺寸：${payload.allowed_sizes.join('、')}`,
    ]
    if (payload.object_info_warning) {
      lines.push(`模型列表查询失败：${payload.object_info_warning}（不影响生图）`)
    }
    return lines.join('\n')
  }

  async function diagnoseText(session) {
    const payload = await statusPayload()
    const lines = ['【p-draw 诊断】']
    lines.push(`插件版本：${require('./package.json').version || '未知'}`)
    lines.push(`ComfyUI 地址：${payload.base_url}`)
    lines.push(`工作流：${cfg.customWorkflowEnabled ? '自定义 ' + (cfg.customWorkflowPath || '(未填写路径)') : (cfg.workflow || 'anima_t2i')}`)
    lines.push(`模型：${cfg.unetName} / ${cfg.clipName} / ${cfg.vaeName}`)
    lines.push(`默认尺寸：${cfg.width}x${cfg.height}，步数 ${cfg.steps}，CFG ${cfg.cfg}，采样器 ${cfg.samplerName}/${cfg.scheduler}`)
    lines.push(`队列：${cfg.queueEnabled ? '启用（上限 ' + (cfg.queueMaxRequests || '∞') + '）' : '关闭'}`)
    lines.push(`P 点价格：${cfg.price}`)
    lines.push(`权限：${cfg.adminOnly ? '仅管理员' : '开放'}`)
    lines.push(`你的 userId：${session.userId}`)
    lines.push(`管理员列表：${(cfg.adminUsers || []).length ? cfg.adminUsers.join(', ') : '（空）'}`)
    lines.push(`管理员匹配：${isAdminUser(session) ? '是（免 P 点）' : '否（会扣 P 点）'}`)
    if (payload.comfyui_api_reachable) {
      lines.push(`ComfyUI API：可达`)
      lines.push(`版本：${payload.comfyui_version || '未知'}`)
      lines.push(`GPU：${payload.gpu || '未知'}（显存 ${payload.vram_total_mb}MB / 空闲 ${payload.vram_free_mb}MB）`)
      lines.push(`模型可用性：主模型${payload.unet_available === undefined ? '（未获取）' : payload.unet_available ? '✓' : '✗'} / 编码器${payload.clip_available === undefined ? '（未获取）' : payload.clip_available ? '✓' : '✗'} / VAE${payload.vae_available === undefined ? '（未获取）' : payload.vae_available ? '✓' : '✗'}`)
      if (payload.unet_models && payload.unet_models.length) {
        lines.push(`可选模型：\n${payload.unet_models.join('\n')}`)
      }
    } else {
      lines.push(`ComfyUI API：不可达`)
      lines.push(`错误：${payload.error || 'unknown'}`)
    }
    if (payload.object_info_warning) {
      lines.push(`模型列表接口：${payload.object_info_warning}（不影响生图）`)
    }
    return lines.join('\n')
  }

  // ---------------- 生成 ----------------
  let generationQueue = Promise.resolve()
  let queueSize = 0
  let queueInFlight = 0

  function queueMax() {
    return Math.max(0, parseInt(cfg.queueMaxRequests) || 0)
  }

  function enqueue(work) {
    const maxQueue = queueMax()
    if (maxQueue && queueInFlight + queueSize >= maxQueue) {
      return { ok: false, error: 'queue_full', message: `生成队列已满（最多 ${maxQueue} 个），本次请求已丢弃，请稍后再试。` }
    }
    queueSize += 1
    const position = queueInFlight + queueSize
    const task = generationQueue.then(async () => {
      queueSize -= 1
      queueInFlight += 1
      try {
        return await work()
      } finally {
        queueInFlight -= 1
      }
    })
    generationQueue = task.catch(() => {})
    return { ok: true, task, position }
  }

  async function ensureComfyuiReady() {
    // 只做轻量的 /system_stats 探测，不请求慢接口 /object_info
    try {
      await comfyGet('/system_stats', 8000)
    } catch (e) {
      const issue = classifyComfyError(e)
      const hint = issue === 'timeout'
        ? '连接超时。请确认 ComfyUI 已启动，且监听了可从本机访问的地址；跨机访问需确认防火墙放行 8188 端口。'
        : issue === 'refused'
          ? '连接被拒绝。请确认 ComfyUI 已启动，且端口与地址正确；服务端需使用 --listen 0.0.0.0 启动才能被局域网访问。'
          : issue === 'dns'
            ? '域名无法解析。请确认地址正确。'
            : '请先启动 ComfyUI，并确认地址正确。'
      return { ok: false, message: `ComfyUI 未启动或无法连接（${baseUrl()}）。${hint}` }
    }
    return { ok: true }
  }

  // ---------------- 用户自选模型 ----------------
  // 从 ComfyUI /object_info（10 分钟缓存）读取真实的 UNET 模型列表
  async function listUnetModels() {
    try {
      const objectInfo = await getObjectInfoCached()
      const list = availableModels(objectInfo, 'UNETLoader', 'unet_name')
      if (list.length) return list
    } catch (e) { /* ignore */ }
    return []
  }

  // 解析该用户当前生效的 UNET 模型：有偏好且仍存在于 ComfyUI 时用偏好，否则回落默认
  async function resolveUnet(USERID) {
    const chosen = cfg.userModels && cfg.userModels[USERID]
    if (!chosen || !String(chosen).trim()) return cfg.unetName
    if (String(chosen).trim() === cfg.unetName) return cfg.unetName
    const list = await listUnetModels()
    if (list.length && !list.includes(String(chosen).trim())) return cfg.unetName
    return String(chosen).trim()
  }

  // 读取某模型在 modelParams 中的独立覆盖参数（只允许采样相关字段，避免误改 unet/clip/vae 等路径）
  const MODEL_OVERRIDE_KEYS = ['samplerName', 'scheduler', 'steps', 'cfg', 'width', 'height']
  function resolveModelParams(name) {
    if (!name || !cfg.modelParams || typeof cfg.modelParams !== 'object') return {}
    const norm = (s) => String(s || '').trim().toLowerCase().replace(/[-_]/g, '~')
    const key = norm(name)
    if (!key) return {}
    const normalized = {}
    for (const [k, v] of Object.entries(cfg.modelParams)) {
      normalized[norm(k)] = v
    }
    const raw = normalized[key]
    if (!raw || typeof raw !== 'object') return {}
    const out = {}
    for (const k of MODEL_OVERRIDE_KEYS) {
      if (raw[k] === undefined || raw[k] === null || raw[k] === '') continue
      out[k] = typeof raw[k] === 'string' ? raw[k].trim() : raw[k]
    }
    return out
  }

  // 名称匹配：精确 > 前缀唯一 > 包含唯一；多个匹配返回 { multiple: [...] }
  function matchUnetModel(input, list) {
    // 规范化：连字符与下划线视为等价（用户常写 anima-aesthetic，模型名是 anima_aesthetic）
    const norm = (s) => String(s || '').trim().toLowerCase().replace(/[-_]/g, '~')
    const key = norm(input)
    if (!key) return null
    const normList = list.map(m => ({ raw: m, n: norm(m) }))
    const exact = normList.find(m => m.n === key)
    if (exact) return exact.raw
    const starts = normList.filter(m => m.n.startsWith(key))
    if (starts.length === 1) return starts[0].raw
    const includes = normList.filter(m => m.n.includes(key))
    if (includes.length === 1) return includes[0].raw
    if (includes.length > 1) return { multiple: includes.map(m => m.raw) }
    return null
  }

  async function runComfyGenerate(prompt, size, overrides) {
    const sizes = parseAllowedSizes()
    const requestedWidth = (size && size[0]) || overrides.width || cfg.width
    const requestedHeight = (size && size[1]) || overrides.height || cfg.height
    const unetName = overrides.unet || cfg.unetName
    // 应用该模型的独立参数覆盖（modelParams），再叠加命令级 overrides（overrides.steps/cfg 优先于模型级）
    const modelSpecific = resolveModelParams(unetName)
    const workCfg = Object.assign({}, cfg, modelSpecific, { unetName })
    // 防御：sampler/scheduler 配置若带尾随空格会导致 ComfyUI 报 "Value not in list"，统一 trim
    if (typeof workCfg.samplerName === 'string') workCfg.samplerName = workCfg.samplerName.trim()
    if (typeof workCfg.scheduler === 'string') workCfg.scheduler = workCfg.scheduler.trim()
    const width = Math.round(Number(requestedWidth) || workCfg.width)
    const height = Math.round(Number(requestedHeight) || workCfg.height)
    const steps = Math.round(Number(overrides.steps) || workCfg.steps)
    const cfgVal = Number(overrides.cfg) || workCfg.cfg
    const seed = Number(overrides.seed) || crypto.randomInt(1, 2 ** 32 - 1)
    const negativePrompt = overrides.negativePrompt || cfg.negativePrompt || ''
    const i2iImage = overrides.i2iImage
    if (i2iImage && cfg.customWorkflowEnabled && cfg.customWorkflowPath) {
      return { ok: false, message: 'i2i（以图生图）暂不支持自定义工作流（customWorkflowEnabled），请关闭后再试。' }
    }
    const i2iOpts = overrides.i2i || {}
    const promptBody = i2iImage
      ? buildI2IWorkflow(workCfg, prompt, negativePrompt, width, height, steps, cfgVal, seed, i2iImage, i2iOpts.mode || 'plain', i2iOpts.denoise != null ? i2iOpts.denoise : null, i2iOpts.caps || null).promptBody
      : buildWorkflow(workCfg, prompt, negativePrompt, width, height, steps, cfgVal, seed, Boolean(size))

    const clientId = crypto.randomUUID()
    const submit = await comfyPost('/prompt', { prompt: promptBody, client_id: clientId }, 20000)
    const promptId = submit && submit.prompt_id
    if (!promptId) {
      if (cfg.outputLogs) logger.warn(`[p-draw] ComfyUI 提交失败，工作流：\n${JSON.stringify(promptBody).slice(0, 3000)}`)
      return { ok: false, message: `ComfyUI 提交失败：${JSON.stringify(submit || {}).slice(0, 300)}` }
    }

    const timeoutMs = Math.max(1, parseInt(cfg.timeout) || 300) * 1000
    const pollMs = Math.max(1, parseInt(cfg.pollInterval) || 2) * 1000
    const history = await waitComfyResult(ctx, comfyGet, baseUrl(), promptId, clientId, timeoutMs, pollMs)
    if (!history) {
      return { ok: false, message: `ComfyUI 排队或生成过久（超过 ${Math.floor(timeoutMs / 1000)} 秒）。` }
    }

    const status = history.status || {}
    if (status.status_str && status.status_str !== 'success') {
      const execErr = status.messages && status.messages.find((m) => Array.isArray(m) && m[0] === 'execution_error' && m[1])
      const errData = execErr && execErr[1]
      const errText = errData
        ? `[${errData.node_id} ${errData.node_type}] ${errData.exception_type || ''} ${errData.exception_message || ''}`.trim()
        : ''
      return { ok: false, message: `ComfyUI 工作流执行失败：${JSON.stringify(status).slice(0, 400)}${errText ? `\n异常：${errText}` : ''}` }
    }

    const images = outputImages(history)
    if (!images.length) {
      return { ok: false, message: 'ComfyUI 完成了任务但没有产出图片。' }
    }

    const outputs = []
    for (let i = 0; i < images.length; i++) {
      const image = images[i]
      const query = new URLSearchParams({
        filename: image.filename || '',
        subfolder: image.subfolder || '',
        type: image.type || 'output',
      })
      try {
        const buffer = await comfyGetBytes(`/view?${query.toString()}`, 120000)
        const ext = path.extname(image.filename || '.png') || '.png'
        const filePath = path.join(tempDir, `${Date.now()}_${crypto.randomBytes(4).toString('hex')}_pdraw${ext}`)
        await fsp.writeFile(filePath, buffer)
        outputs.push(pathToFileURL(filePath).href)
      } catch (e) {
        logger.warn(`下载生成图片失败：${e.message}`)
      }
    }
    if (!outputs.length) {
      return { ok: false, message: 'ComfyUI 已完成任务，但图片下载失败。' }
    }
    return {
      ok: true,
      outputs,
      seed,
      width,
      height,
      steps,
      cfg: cfgVal,
      prompt_id: promptId,
    }
  }

  // ---------------- LLM 提示词优化 ----------------
  // 兼容 OpenAI / DeepSeek 的返回结构：
  // content 可能是字符串、null、数组（[{type:'text',text:'...'}]），
  // DeepSeek V4 思考模式下答案可能只在 reasoning_content 里。
  function extractLlmText(res) {
    if (!res) return ''
    const choice = res.choices && res.choices[0]
    if (!choice) return ''
    const message = choice.message || {}
    let content = message.content
    // content 为空（'' / null / undefined）时回退到 reasoning_content
    if (!content || (Array.isArray(content) && !content.length)) {
      content = message.reasoning_content
    }
    if (Array.isArray(content)) {
      return content
        .filter(part => part && (part.type === 'text' || typeof part.text === 'string'))
        .map(part => part.text || '')
        .join('')
        .trim()
    }
    if (typeof content === 'string') return content.trim()
    if (content && typeof content.text === 'string') return content.text.trim()
    return ''
  }

  // ---------------- 联网搜索 ----------------
  const WEB_SEARCH_KEYWORDS = [
    '联网', '搜索', '搜一下', '查一下', '参考资料', '官方图', '设定图', '资料',
    'web search', 'online',
  ]

  function wantsWebSearch(prompt) {
    if (!cfg.webSearchEnabled || !cfg.tavilyApiKey) return false
    const lower = String(prompt || '').toLowerCase()
    return WEB_SEARCH_KEYWORDS.some(keyword => lower.includes(keyword.toLowerCase()))
  }

  // 把命中的固定角色 tags 渲染进优化模板的 {character_rule} 占位符。
  function buildCharacterRule(prompt) {
    const text = String(prompt || '')
    for (const [name, tags] of Object.entries(parsePresetList(cfg.fixedCharacters))) {
      if (name && text.includes(name)) {
        return `用户提到了固定角色「${name}」，其外观 tags 为：${tags} 请优先保留这些特征。`
      }
    }
    return ''
  }

  async function webSearch(prompt) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30000)
    try {
      const maxResults = Math.max(1, Math.min(parseInt(cfg.webSearchMaxResults) || 5, 8))
      const depth = ['basic', 'advanced'].includes(cfg.webSearchDepth) ? cfg.webSearchDepth : 'basic'
      const queryTemplate = String(cfg.webSearchQueryTemplate || '').trim() || '{prompt} anime game character official art visual design'
      const query = queryTemplate.includes('{prompt}')
        ? queryTemplate.replace(/\{prompt\}/g, prompt).trim()
        : `${prompt} ${queryTemplate}`.trim()
      const rawRes = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: cfg.tavilyApiKey,
          query,
          max_results: maxResults,
          search_depth: depth,
          topic: 'general',
        }),
        signal: controller.signal,
      })
      if (!rawRes.ok) {
        const bodyText = await rawRes.text().catch(() => '')
        logger.warn(`联网搜索接口返回错误：HTTP ${rawRes.status} ${bodyText.slice(0, 200)}`)
        return ''
      }
      const data = await rawRes.json()
      const results = Array.isArray(data.results) ? data.results : []
      const lines = [`用户主题：${prompt}`, '搜索结果：']
      for (const result of results) {
        const title = String(result.title || '').trim()
        const content = String(result.content || '').trim().replace(/\s+/g, ' ').slice(0, 500)
        const url = String(result.url || '').trim()
        if (!title && !content) continue
        lines.push(`- ${title}${content ? '\n摘要：' + content : ''}${url ? '\nURL：' + url : ''}`)
      }
      if (lines.length <= 2) {
        logger.warn('联网搜索无结果')
        return ''
      }
      const context = lines.join('\n')
      logger.info(`联网搜索完成，共 ${results.length} 条结果`)
      return context
    } catch (e) {
      logger.warn(`联网搜索失败：${e.message}`)
      return ''
    } finally {
      clearTimeout(timer)
    }
  }

  async function optimizePrompt(session, userPrompt, force = false, img2imgRule = '') {
    if (!cfg.promptOptimizeEnabled && !force) {
      return { ok: true, prompt: userPrompt, reason: 'optimize_disabled' }
    }
    if (!cfg.llmModel || !cfg.llmBaseUrl) {
      logger.warn('提示词优化已开启但未配置 llmModel / llmBaseUrl，跳过优化')
      return { ok: false, prompt: userPrompt, reason: 'llm_not_configured' }
    }
    let searchBlock = ''
    if (wantsWebSearch(userPrompt)) {
      searchBlock = await webSearch(userPrompt)
    }
    const characterRule = buildCharacterRule(userPrompt)
    const defaultTemplate = `你是为图像生成模型编写正面提示词的 AI 画师。\n\n请根据用户的原始要求设计一幅完整、协调、具有视觉吸引力的画面，并将结果输出为英文 Danbooru-style tags。\n\n输出要求：\n- 只输出一行英文 tags，使用英文逗号分隔。\n- 不要输出解释、分析、标题、编号、Markdown、代码块或中文。\n- 不要输出 masterpiece、best quality、score 等质量前缀。\n- 不要输出画师 tags；质量词和画师组会由程序另行拼接。\n- 尽量使用模型容易理解的可见画面描述。\n- 保持用户明确指定的角色、主体、人数、关键服装、动作、表情和道具。\n- 以最终图像协调、精致、有表现力和好看为优先。\n\n角色和动态上下文：\n{character_rule}\n{img2img_rule}\n{search_block}\n\n用户原始要求：\n{theme}`
    const template = (cfg.promptOptimizeTemplate || '').trim() || defaultTemplate
    const searchBlockText = searchBlock
      ? `联网搜索参考信息（请尽量依据这些内容补全角色外观与设定）：\n${searchBlock}`
      : ''
    const rendered = template
      .replace(/\{theme\}/g, userPrompt)
      .replace(/\{search_block\}/g, searchBlockText)
      .replace(/\{character_rule\}/g, characterRule)
      .replace(/\{outfit_transfer_rule\}/g, '')
      .replace(/\{reference_rule\}/g, '')
      .replace(/\{img2img_rule\}/g, img2imgRule)
      .replace(/\{sensual_rule\}/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 120000)
    try {
      const headers = { 'Content-Type': 'application/json' }
      if (cfg.llmApiKey) headers.Authorization = `Bearer ${cfg.llmApiKey}`
      const rawRes = await fetch(
        String(cfg.llmBaseUrl).replace(/\/+$/, '') + '/chat/completions',
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: cfg.llmModel,
            messages: [
              { role: 'system', content: rendered },
              { role: 'user', content: userPrompt },
            ],
            max_tokens: Math.max(64, parseInt(cfg.llmMaxTokens) || 1000),
            // DeepSeek V4 默认开启思考模式，改为关闭以保证 content 直接返回 tags
            thinking: { type: 'disabled' },
          }),
          signal: controller.signal,
        },
      )
      if (!rawRes.ok) {
        const bodyText = await rawRes.text().catch(() => '')
        const reason = `HTTP ${rawRes.status}${bodyText ? ' ' + bodyText.slice(0, 200) : ''}`
        logger.warn(`提示词优化接口返回错误：${reason}`)
        return { ok: false, prompt: userPrompt, reason }
      }
      const res = await rawRes.json()
      const text = extractLlmText(res)
      if (!text) {
        const reason = '接口未返回可用的文本内容'
        logger.warn(`提示词优化：${reason} 原始响应=${JSON.stringify(res).slice(0, 500)}`)
        return { ok: false, prompt: userPrompt, reason }
      }
      return { ok: true, prompt: text }
    } catch (e) {
      const reason = String(e && e.message || e)
      logger.warn(`提示词优化失败：${reason}`)
      return { ok: false, prompt: userPrompt, reason }
    } finally {
      clearTimeout(timer)
    }
  }

  function extractSeriesOptimizeJson(text) {
    let raw = String(text || '').trim()
    if (raw.startsWith('```')) raw = (raw.match(/```(?:json)?([\s\S]*?)```/) || [null, raw])[1].trim()
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start === -1 || end === -1 || end <= start) return null
    try { return JSON.parse(raw.slice(start, end + 1)) } catch (e) { return null }
  }

  function filterFixedTags(tags, drops) {
    if (!tags) return ''
    const dropKeys = (drops || []).map(d => canonicalTagText(String(d))).filter(Boolean)
    if (!dropKeys.length) return tags
    return splitTags(tags)
      .filter(t => !dropKeys.some(k => k && canonicalTagText(t).includes(k)))
      .join(', ')
  }

  // 连续图专用的阶段优化：LLM 把「角色 + 阶段描述」转成 Danbooru tags，并返回
  // 要从固定角色 tags 中移除的冲突项（如固定 silver hair、阶段变成 black hair）。
  async function optimizeSeriesStage(userPrompt, identity) {
    if (!cfg.llmModel || !cfg.llmBaseUrl) {
      return { ok: false, prompt: userPrompt, drops: [], reason: 'llm_not_configured' }
    }
    const fixedTags = identity && parsePresetList(cfg.fixedCharacters)[identity]
      ? parsePresetList(cfg.fixedCharacters)[identity]
      : ''
    const template = `你是为图像生成模型编写正面提示词的 AI 画师。这是「同一个角色」的连续变化过程中的某一个阶段。\n\n用户给出一行描述：<角色身份>，<本阶段的外貌/状态描述>。\n\n固定角色 tags（身份锚点，包含角色名标签、种族、体型、标志特征，也可能包含发色、瞳色等默认外观）：\n${fixedTags || '（无）'}\n\n输出要求：\n- 只输出一个 JSON 对象，不要 Markdown、不要解释、不要其他任何文字：\n{\n  "stage_tags": "一行英文 Danbooru-style tags，用于本阶段画面，英文逗号分隔；不含 masterpiece/best quality 等质量前缀，不含画师 tags",\n  "drop_fixed": ["要从固定 tags 中移除的标签列表；仅当本阶段描述明确改变了该外观时才列出"]\n}\n- 身份一致性：若用户描述的就是固定角色，stage_tags 必须包含该角色的角色名标签（如 kokkoro_(princess_connect!)），并保留种族、体型、标志特征等「不变的底层身份」。\n- 覆盖规则：本阶段描述明确提到的变化（发色、瞳色、表情、眼神、气质、种族变化等）必须体现在 stage_tags 中，并在 drop_fixed 中列出被替换掉的固定标签（措辞与固定 tags 一致或接近）。\n- 本阶段描述与固定 tags 无冲突时，drop_fixed 为 []。\n\n本阶段描述：\n{theme}`
    const rendered = template.replace(/\{theme\}/g, userPrompt)
    try {
      const text = await llmChat({ system: rendered, user: userPrompt, maxTokens: Math.min(parseInt(cfg.llmMaxTokens) || 700, 900) })
      const data = extractSeriesOptimizeJson(text)
      if (data && String(data.stage_tags || '').trim()) {
        const drops = Array.isArray(data.drop_fixed) ? data.drop_fixed.map(String).filter(Boolean) : []
        return { ok: true, prompt: String(data.stage_tags).trim(), drops, reason: '' }
      }
      // JSON 解析失败：把整段文本当作阶段 tags，不剔除固定标签
      return { ok: true, prompt: text, drops: [], reason: '' }
    } catch (e) {
      const reason = String(e && e.message || e)
      logger.warn(`连续图阶段优化失败：${reason}`)
      return { ok: false, prompt: userPrompt, drops: [], reason }
    }
  }

  // ---------------- 提示词组装 ----------------
  // fixedOverride：undefined=按名称自动匹配固定角色；'skip'=不注入固定角色；字符串=直接使用该字符串作为固定角色 tags
  function composePrompt(userPrompt, raw, fixedOverride) {
    if (raw) return { prompt: userPrompt, degraded: false }
    const parts = []
    if (cfg.qualityPrefix) parts.push(String(cfg.qualityPrefix).trim())
    if (fixedOverride === 'skip') {
      // 不注入固定角色 tags
    } else if (typeof fixedOverride === 'string') {
      if (String(fixedOverride).trim()) parts.push(String(fixedOverride).trim())
    } else {
      for (const [name, tags] of Object.entries(parsePresetList(cfg.fixedCharacters))) {
        if (name && userPrompt.includes(name)) {
          parts.push(tags)
          break
        }
      }
    }
    const presets = parsePresetList(cfg.artistPresets)
    let artistTags = ''
    if (cfg.activeArtistPreset && presets[cfg.activeArtistPreset]) {
      artistTags = presets[cfg.activeArtistPreset]
    } else if (cfg.defaultArtistTags) {
      artistTags = String(cfg.defaultArtistTags).trim()
    }
    if (artistTags && !/(不用我的风格|不要我的风格|不使用我的风格|不要画师词|不用画师词|不加画师词|no artist)/i.test(userPrompt)) {
      parts.push(artistTags)
    }
    if (cfg.styleTags && !/(不用我的风格|不要我的风格|不使用我的风格)/i.test(userPrompt)) {
      parts.push(String(cfg.styleTags).trim())
    }
    parts.push(userPrompt)
    return { prompt: parts.filter(Boolean).join(', ') + (parts.filter(Boolean).length ? ',' : ''), degraded: false }
  }

  // ---------------- 多人（移植自 anima /anm 多人） ----------------

  // 通用 LLM 调用：system + user，返回文本；失败抛错由调用方捕获。
  async function llmChat({ system, user, maxTokens = 700, baseUrl, apiKey, model, timeout = 120000 }) {
    const resolvedBase = baseUrl || cfg.llmBaseUrl
    const resolvedKey = apiKey || cfg.llmApiKey
    const resolvedModel = model || cfg.llmModel
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const headers = { 'Content-Type': 'application/json' }
      if (resolvedKey) headers.Authorization = `Bearer ${resolvedKey}`
      const rawRes = await fetch(
        String(resolvedBase).replace(/\/+$/, '') + '/chat/completions',
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: resolvedModel,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            max_tokens: Math.max(64, parseInt(maxTokens) || 700),
            thinking: { type: 'disabled' },
          }),
          signal: controller.signal,
        },
      )
      if (!rawRes.ok) {
        const bodyText = await rawRes.text().catch(() => '')
        throw new Error(`HTTP ${rawRes.status}${bodyText ? ' ' + bodyText.slice(0, 200) : ''}`)
      }
      const res = await rawRes.json()
      const text = extractLlmText(res)
      if (!text) throw new Error('接口未返回可用的文本内容')
      return text
    } finally {
      clearTimeout(timer)
    }
  }

  // 多人规划：让 LLM 输出结构化场景 JSON（2-4 人）。
  async function generateMultiPersonPlan(prompt) {
    const mentioned = {}
    for (const [name, tags] of Object.entries(parsePresetList(cfg.fixedCharacters))) {
      if (name && prompt.includes(name)) mentioned[name] = tags
    }
    const planPrompt = buildMultiPersonPlanPrompt(prompt, mentioned)
    let retryPlanPrompt = planPrompt
    let planError = 'invalid_plan'
    let rawPlan = ''
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        rawPlan = await llmChat({
          system: 'You plan multi-character Anima illustrations. Return only valid JSON matching the requested schema. Keep every character\'s identity and attributes in its own block.',
          user: retryPlanPrompt,
          maxTokens: Math.min(parseInt(cfg.llmMaxTokens) || 700, 900),
        })
      } catch (e) {
        planError = String(e && e.message || e).slice(0, 300)
        logger.warn(`多人规划尝试 ${attempt + 1} 失败：${planError}`)
      }
      if (rawPlan) {
        const candidate = parseMultiPersonPlan(rawPlan)
        if (candidate) {
          const aliases = ['CHARACTER A', 'CHARACTER B', 'CHARACTER C', 'CHARACTER D'].slice(0, candidate.characters.length)
          const allowedAliases = new Set(aliases)
          const interactionAliases = new Set()
          for (const interaction of candidate.interactions) {
            const found = String(interaction).match(/\bCharacter\s+[A-D]\b/gi) || []
            found.forEach(m => interactionAliases.add(m.toUpperCase()))
          }
          if (candidate.interactions.length && interactionAliases.size && ![...interactionAliases].every(a => allowedAliases.has(a))) {
            planError = 'invalid_interaction_aliases'
          } else {
            return { ok: true, plan: candidate, rawPlan }
          }
        } else {
          planError = 'invalid_plan'
        }
      }
      if (attempt === 0) {
        planError = 'invalid_plan'
        retryPlanPrompt += '\nThe previous response was invalid. Return corrected JSON only. Keep 2 to 4 characters, reference only defined Character aliases inside interactions, and preserve one coherent shared scene.'
      }
    }
    return { ok: false, plan: null, error: planError, rawPlan }
  }

  // 多人最终提示词组装：count/common tags + 角色块 + 互动 + 构图。
  function buildMultiPersonFinalPrompt(plan, prompt) {
    const aliases = ['Character A', 'Character B', 'Character C', 'Character D']
    const characterCount = plan.characters.length
    const characterRoles = []
    const characterBlocks = []
    const characterEntityNames = []
    let groupedContact = plan.spatial_mode === 'shared_contact'
    const explicitPositionRequested = /左边|右边|左侧|右侧|前景|后方|前后站位|\bon\s+the\s+(?:left|right)\b|\bforeground\b|\bbackground\b/i.test(prompt)
    let spatialMode = plan.spatial_mode
    if (explicitPositionRequested) spatialMode = 'explicit_positions'
    else if (plan.interactions.length) spatialMode = 'shared_contact'
    else if (spatialMode === 'explicit_positions') spatialMode = 'shared_scene'
    groupedContact = spatialMode === 'shared_contact'

    const usedFixedNames = new Set()
    const fixedGenders = []
    const configuredChars = parsePresetList(cfg.fixedCharacters)
    for (let index = 0; index < plan.characters.length; index++) {
      const character = plan.characters[index]
      let fixedName = ''
      for (const name of Object.keys(configuredChars)) {
        if (!usedFixedNames.has(name) && (name === character.name || name.includes(character.name) || character.name.includes(name))) {
          fixedName = name
          break
        }
      }
      let fixedTags = ''
      let resolvedIdentity = ''
      if (fixedName) {
        usedFixedNames.add(fixedName)
        const configuredTags = splitTags(configuredChars[fixedName])
        const normalizedSet = new Set(configuredTags.map(t => t.toLowerCase().replace(/\s+/g, '')))
        if (normalizedSet.has('1girl')) fixedGenders.push('girl')
        else if (normalizedSet.has('1boy')) fixedGenders.push('boy')
        fixedTags = configuredTags
          .filter(tag => !['1girl', '1 girl', '1boy', '1 boy', 'solo'].includes(tag.toLowerCase()))
          .join(', ')
      } else if (character.danbooru_candidate) {
        resolvedIdentity = character.danbooru_candidate
      }

      const availableIdentityTags = splitTags(fixedTags || character.appearance)
        .map(t => t.trim().replace(/^\(|\)$/g, '').trim())
        .filter(t => t && !['1girl', '1 girl', '1boy', '1 boy', 'solo'].includes(t.toLowerCase()))
      const proposedIdentityTags = (character.identity_anchors || [])
        .map(t => String(t).trim().replace(/^\(|\)$/g, '').trim())
        .filter(Boolean)
      let identityTags = fixedName || resolvedIdentity
        ? proposedIdentityTags.filter(tag => fixedTags.includes(tag.toLowerCase().replace(/\s+/g, ' '))).slice(0, 6)
        : proposedIdentityTags.slice(0, 6)
      if (!identityTags.length) identityTags = availableIdentityTags.slice(0, 6)

      let visualLabel = String(character.visual_label || '').trim().toLowerCase()
      if (!visualLabel || /\b(?:character\s+[a-d]|first|second|third|fourth|rider|support(?:ing|er)?|left|right|top|bottom)\b/i.test(visualLabel)) {
        const descriptors = identityTags.slice(0, 2).map(tag => {
          let d = tag.toLowerCase().replace(/[()_:]+/g, ' ').replace(/\s+/g, ' ').trim()
          d = d.replace(/\s+hair$/, '-haired').replace(/\s+eyes$/, '-eyed').replace(/\s+ears$/, '-eared')
          return d
        }).filter(Boolean).map(d => d.replace(/\s+/g, '-'))
        const genderLabel = plan.count_tags.some(t => t.includes('girl')) ? 'girl' : 'person'
        visualLabel = [...descriptors, genderLabel].join(' ')
      }
      if (!visualLabel) visualLabel = String(character.role || aliases[index]).trim().toLowerCase()
      if (characterRoles.includes(visualLabel)) visualLabel = `${visualLabel} ${index + 1}`
      characterRoles.push(visualLabel)

      const emphasized = new Set((character.emphasized_anchors || []).map(t => String(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).filter(Boolean))
      const renderedIdentityTags = identityTags.map(tag =>
        emphasized.has(String(tag).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()) ? `(${tag}:1.3)` : tag,
      )

      characterEntityNames.push(new Set([character.name, character.danbooru_candidate, fixedName, resolvedIdentity].filter(Boolean)))
      characterBlocks.push(renderMultiPersonCharacter(character, {
        alias: visualLabel,
        resolvedIdentity,
        fixedTags: fixedName ? fixedTags : '',
        groupedContact,
        explicitPositions: spatialMode === 'explicit_positions',
        identityAnchors: renderedIdentityTags,
        includePose: !groupedContact,
      }))
    }

    const blockedMarkers = ['split screen', 'panel', 'multiple view', 'alternate view', 'character sheet', 'duplicate character', 'cloned character']
    let deterministicCountTags = []
    if (fixedGenders.length === characterCount) {
      const girlCount = fixedGenders.filter(g => g === 'girl').length
      const boyCount = fixedGenders.filter(g => g === 'boy').length
      deterministicCountTags = [
        girlCount ? `${girlCount}girls` : '',
        boyCount ? `${boyCount}boys` : '',
      ].filter(Boolean)
    }
    if (!deterministicCountTags.length) {
      const matched = (plan.count_tags || []).filter(tag => {
        const m = String(tag).match(/^\s*(\d+)\s*(girls?|boys?|people|persons?)\s*$/i)
        return m && parseInt(m[1]) === characterCount
      })
      deterministicCountTags = matched.slice(0, 1)
      if (!deterministicCountTags.length) deterministicCountTags = [`${characterCount}people`]
    }
    const filteredCommonTags = (plan.common_tags || []).filter(tag =>
      !blockedMarkers.some(marker => tag.toLowerCase().includes(marker)) &&
      tag.trim().toLowerCase() !== String(plan.relationship_tag || '').trim().toLowerCase() &&
      !/^\s*\d+\s*(girls?|boys?|people|persons?)\s*$/i.test(tag),
    )
    const relationshipTag = String(plan.relationship_tag || '').trim()
    const commonContent = [
      ...deterministicCountTags,
      ...(characterCount === 2 ? ['duo'] : []),
      ...(relationshipTag ? [relationshipTag] : []),
      ...filteredCommonTags,
    ].join(', ')

    const normalizedInteractions = []
    for (const interaction of plan.interactions) {
      let normalized = interaction
      const replacements = []
      characterEntityNames.forEach((names, index) => {
        for (const name of names) {
          if (name.toLowerCase() !== aliases[index].toLowerCase()) replacements.push([name, aliases[index]])
        }
      })
      replacements.sort((a, b) => b[0].length - a[0].length)
      for (const [name, alias] of replacements) {
        if (/[\u0080-\uffff]/.test(name)) {
          normalized = normalized.split(name).join(` ${alias} `)
        } else {
          normalized = normalized.replace(new RegExp(`(?<![\\w])${escapeRe(name)}(?![\\w])`, 'gi'), alias)
        }
      }
      normalized = normalized.replace(/\s+/g, ' ').trim().replace(/\s+([,.;:!?])/g, '$1')
      normalizedInteractions.push(normalized)
    }

    const normalizedAliases = new Set()
    for (const interaction of normalizedInteractions) {
      const found = interaction.match(/\bCharacter\s+[A-D]\b/gi) || []
      found.forEach(m => normalizedAliases.add(m.toUpperCase()))
    }
    const allowedAliasSet = new Set(aliases.slice(0, characterCount).map(a => a.toUpperCase()))
    if (normalizedInteractions.length && (![...normalizedAliases].every(a => allowedAliasSet.has(a)) || normalizedAliases.size < 2)) {
      return { ok: false, error: 'invalid_interaction_aliases' }
    }

    const displayInteractions = normalizedInteractions.map(interaction => {
      let displayed = interaction
      aliases.slice(0, characterCount).forEach((alias, index) => {
        displayed = displayed.replace(new RegExp(`\\b${escapeRe(alias)}\\b`, 'gi'), `the ${characterRoles[index]}`)
      })
      return displayed
    })

    const sceneGuard = 'The composition shows one shared continuous moment.'
    let relativePosition = ''
    if (spatialMode === 'explicit_positions' && characterCount === 2) {
      const slotAliases = {}
      plan.characters.forEach((character, index) => { slotAliases[character.slot] = `the ${characterRoles[index]}` })
      if (slotAliases.left && slotAliases.right) {
        relativePosition = `${slotAliases.left} stands immediately beside ${slotAliases.right}, to ${slotAliases.right}'s left, while both remain in the same central group.`
      } else if (slotAliases.foreground && slotAliases.background) {
        relativePosition = `${slotAliases.foreground} stands slightly in front of ${slotAliases.background} while both remain together in the same continuous scene.`
      }
    }

    const narrativeBlocks = [...characterBlocks, ...displayInteractions, relativePosition, sceneGuard].filter(Boolean)

    // 组装最终提示词：质量词 + 画师组 + content + narrative 块
    const contentClean = cleanContentTags(commonContent, 65, false, [], true)
    const parts = []
    if (cfg.qualityPrefix) parts.push(String(cfg.qualityPrefix).trim())
    const presets = parsePresetList(cfg.artistPresets)
    let artistTags = ''
    if (cfg.activeArtistPreset && presets[cfg.activeArtistPreset]) {
      artistTags = presets[cfg.activeArtistPreset]
    } else if (cfg.defaultArtistTags) {
      artistTags = String(cfg.defaultArtistTags).trim()
    }
    if (artistTags) parts.push(artistTags)
    if (cfg.styleTags) parts.push(String(cfg.styleTags).trim())
    parts.push(contentClean || commonContent)
    let finalPrompt = joinPromptParts(parts)
    if (narrativeBlocks.length) finalPrompt += '\n\n' + narrativeBlocks.join('\n\n')
    return { ok: true, prompt: finalPrompt }
  }

  // 视觉校验（anima_verify + generation_verifier 移植）：对生成的图片跑视觉 LLM，
  // 不合格则用相同提示词重试（最多 multiCandidateCount 张），按多候选规则挑选并返回结果。
  async function verifyGeneratedImages(session, images, userRequest, prompt, size, planCount, unet) {
    const verifyBaseUrl = String(cfg.verifyLlmBaseUrl || '').trim()
    const verifyModel = String(cfg.verifyLlmModel || '').trim()
    if (!verifyBaseUrl || !verifyModel) {
      return { ok: true, degraded: true, message: '', verdict: null, outputs: images }
    }
    const passScore = Math.max(0, Math.min(10, parseInt(cfg.multiVerifyPassScore) || 6))
    const candidateCount = Math.max(1, Math.min(3, parseInt(cfg.multiCandidateCount) || 2))
    const maxRetry = candidateCount - 1
    const systemPrompt = buildVerifySystemPrompt(true, planCount)
    const candidates = []
    let lastVerdict = null
    let retries = 0
    let currentImages = images
    let currentPrompt = prompt

    async function verifyOnce(imgs, userReq) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 120000)
      try {
        const headers = { 'Content-Type': 'application/json' }
        if (cfg.verifyLlmApiKey) headers.Authorization = `Bearer ${cfg.verifyLlmApiKey}`
        const content = imgs.map(src => ({ type: 'image_url', image_url: { url: src } }))
        const rawRes = await fetch(
          verifyBaseUrl.replace(/\/+$/, '') + '/chat/completions',
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model: verifyModel,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: [{ type: 'text', text: `用户的原始画图请求（中文）：\n${userReq}\n\n请审查这张图片。` }, ...content] },
              ],
              max_tokens: Math.max(256, parseInt(cfg.llmMaxTokens) || 700),
            }),
            signal: controller.signal,
          },
        )
        if (!rawRes.ok) {
          const bodyText = await rawRes.text().catch(() => '')
          throw new Error(`HTTP ${rawRes.status}${bodyText ? ' ' + bodyText.slice(0, 200) : ''}`)
        }
        const res = await rawRes.json()
        return extractLlmText(res)
      } finally {
        clearTimeout(timer)
      }
    }

    function extractVerifyJson(text) {
      let raw = String(text || '').trim()
      if (raw.startsWith('```')) {
        raw = (raw.match(/```(?:json)?([\s\S]*?)```/) || [null, raw])[1].trim()
      }
      const start = raw.indexOf('{')
      const end = raw.lastIndexOf('}')
      if (start === -1 || end === -1 || end <= start) return null
      try { return JSON.parse(raw.slice(start, end + 1)) } catch (e) { return null }
    }

    function verdictFromData(data) {
      let score = 10
      try { score = parseInt(data.score) } catch (e) { score = 10 }
      const issues = Array.isArray(data.issues) ? data.issues.map(String).filter(Boolean).slice(0, 5) : []
      const fixHint = String(data.fix_hint || '').trim()
      const facts = data.multi_facts && typeof data.multi_facts === 'object' ? data.multi_facts : {}
      let visibleCount = null
      try { visibleCount = parseInt(facts.visible_person_count) } catch (e) { visibleCount = null }
      const layout = String(facts.layout || '').trim().toLowerCase()
      const identityMatch = String(facts.identity_match || '').trim().toLowerCase()
      const interactionDirection = String(facts.interaction_direction || '').trim().toLowerCase()
      let identityConfidence = 0
      try { identityConfidence = Math.min(1, Math.max(0, parseFloat(facts.identity_confidence) || 0)) } catch (e) { identityConfidence = 0 }
      let directionConfidence = 0
      try { directionConfidence = Math.min(1, Math.max(0, parseFloat(facts.direction_confidence) || 0)) } catch (e) { directionConfidence = 0 }
      const majorAnatomy = facts.major_anatomy_issue === true
      const explicitPass = typeof data.pass === 'boolean' ? data.pass : null
      const passed = explicitPass !== null ? (explicitPass && score >= passScore) : score >= passScore
      return { passed, score, issues, fixHint, visibleCount, layout, identityMatch, interactionDirection, identityConfidence, directionConfidence, majorAnatomy }
    }

    function rankCandidate(verdict) {
      const hardFailure = (
        (verdict.visibleCount !== null && verdict.visibleCount !== planCount) ||
        ['split_screen', 'collage', 'multiple_views'].includes(verdict.layout) ||
        verdict.majorAnatomy ||
        (['swapped', 'wrong'].includes(verdict.identityMatch) && verdict.identityConfidence >= 0.7) ||
        (['reversed', 'wrong'].includes(verdict.interactionDirection) && verdict.directionConfidence >= 0.7)
      )
      const eligible = verdict.skipped || (!hardFailure && verdict.score >= 5)
      let rank = verdict.score
      if (verdict.visibleCount === planCount) rank += 100
      if (verdict.layout === 'single_scene') rank += 50
      if (verdict.majorAnatomy) rank -= 40
      if (verdict.interactionDirection === 'correct') rank += 8
      else if (verdict.interactionDirection === 'unclear') rank += 2
      if (verdict.identityMatch === 'correct') rank += 5
      else if (verdict.identityMatch === 'partial') rank += 1
      return { eligible, rank }
    }

    let selectedOutputs = images
    let selectedVerdict = null
    while (true) {
      let reply = ''
      let data = null
      try {
        reply = await verifyOnce(currentImages, userRequest)
        data = extractVerifyJson(reply)
      } catch (e) {
        logger.warn(`多人视觉校验失败：${e.message}`)
        return { ok: true, degraded: true, message: session.text('.multi-verify-error', [String(e && e.message || e)]), verdict: null, outputs: images }
      }
      if (!data) {
        logger.warn(`多人视觉校验返回无法解析：${reply.slice(0, 200)}`)
        return { ok: true, degraded: true, message: '', verdict: null, outputs: images }
      }
      const verdict = verdictFromData(data)
      verdict.skipped = false
      candidates.push({ outputs: currentImages, verdict, prompt: currentPrompt })
      selectedOutputs = currentImages
      selectedVerdict = verdict

      const rank = rankCandidate(verdict)
      if (verdict.skipped || verdict.passed || (rank.eligible && rank.rank >= 5)) {
        break
      }
      if (retries >= maxRetry) break
      retries += 1
      const hint = verdict.fixHint || verdict.issues.join('；')
      if (hint) {
        currentPrompt = `${userRequest}\n【上次问题，请修正】${hint}`
      }
      const regen = await runComfyGenerate(currentPrompt, size, { unet })
      if (!regen.ok) {
        logger.warn(`多人校验重试生成失败：${regen.message}`)
        break
      }
      currentImages = regen.outputs
      currentPrompt = regen.finalPrompt || currentPrompt
    }

    // 多候选挑选
    const ranked = candidates.map((c, index) => ({ rank: rankCandidate(c.verdict), index, ...c }))
    const eligible = ranked.filter(c => c.rank.eligible)
    const best = (eligible.length ? eligible : ranked).sort((a, b) => b.rank.rank - a.rank.rank)[0]
    const multiAccepted = Boolean(eligible.length)
    selectedOutputs = best.outputs
    selectedVerdict = best.verdict
    if (!multiAccepted && !cfg.multiSendDegradedCandidate) {
      return { ok: false, discarded: true, message: session.text('.multi-verify-discarded'), verdict: selectedVerdict, outputs: [] }
    }
    const noteParts = []
    if (multiAccepted) {
      noteParts.push(session.text('.multi-verify-passed', [selectedVerdict.score]))
    } else {
      noteParts.push(session.text('.multi-verify-degraded', selectedVerdict.issues.length ? '（' + selectedVerdict.issues.join('；').slice(0, 80) + '）' : ''))
    }
    if (retries) noteParts.push(session.text('.multi-verify-failed', [selectedVerdict.issues.length ? '：' + selectedVerdict.issues.join('；').slice(0, 80) : '', retries]))
    return { ok: true, degraded: false, message: noteParts.join('\n'), verdict: selectedVerdict, outputs: selectedOutputs }
  }

  function buildVerifySystemPrompt(multiPerson, planCount) {
    let system = '你是一个严格但公正的二次元插画审查助手。你会看到用户的原始画图请求（中文）和一张已生成的图片。判断图片是否满足请求：主体是否正确、动作/姿态、服饰、场景、整体画风，以及基本质量（无明显肢体畸形、无脸崩、无乱码文字、构图协调）。\n\n只输出一个 JSON 对象，不要 Markdown、不要解释：\n{\n  "score": 0-10 的整数（10=完全符合）,\n  "pass": true/false,\n  "issues": ["用简短中文短语列出具体问题，没问题则空数组"],\n  "fix_hint": "一句中文，告诉提示词作者下次该怎么改；通过则留空"\n}\n\nissues 要具体，例如「少了草帽」「背景是教室不是废土」「多出第三只手」。图片明显没问题时，pass=true、给高分、issues 和 fix_hint 都留空。'
    if (multiPerson) {
      system += `\n这是 /anm 多人任务。还必须严格检查：实际人物数量是否符合请求；每个角色是否只出现一次；是否出现分屏、漫画格、多视图、克隆或额外人物；固定角色的发色、瞳色、种族和标志性配饰是否串到其他角色；互动的主动方、承受方和空间位置是否正确。`
      system += `\nJSON 中还必须增加 multi_facts 对象，只报告直接观察到的事实："visible_person_count" 为可见人物整数；"layout" 只能是 single_scene、split_screen、collage、multiple_views 或 unknown；"identity_match" 只能是 correct、partial、swapped、wrong 或 unknown；"interaction_direction" 只能是 correct、reversed、unclear、wrong 或 unknown。另给出 0.0 到 1.0 的 "identity_confidence" 和 "direction_confidence"，以及布尔值 "major_anatomy_issue"；只有能清楚看见证据时才给高置信度。不要让总分替代这些客观字段。`
    }
    return system
  }

  // 共享批量执行器：一次性扣除总价，逐张生成，单张失败只退该张单价。
  // runOne(i) 需返回 { ok, outputs, seed, message? }；返回数组为多张输出（如视觉校验候选）。
  async function executeBatch(USERID, isAdmin, count, unitPrice, runOne) {
    const results = []
    let successCount = 0
    for (let i = 0; i < count; i++) {
      let item
      try {
        item = await runOne(i)
      } catch (e) {
        item = { ok: false, message: String(e && e.message || e) }
      }
      const outputs = Array.isArray(item.outputs) ? item.outputs : (item.outputs ? [item.outputs] : [])
      if (item.ok && outputs.length) {
        successCount += 1
        results.push({ i, ok: true, outputs, seed: item.seed, note: item.note || '' })
      } else {
        if (!isAdmin) await refundP(USERID, unitPrice)
        if (cfg.outputLogs) logger.warn(`批量第 ${i + 1} 张生成失败（${USERID}）：${item.message || '无输出'}`)
        results.push({ i, ok: false, message: item.message || '无输出' })
      }
    }
    return { results, successCount }
  }

  // 多人主流程：尺寸自动选择 + 规划 + 组装 + 生成 + 校验 + 发图（引用原消息）
  async function handleGenerateMulti(session, rawText) {
    const USERID = session.userId
    const isAdmin = isAdminUser(session)
    const unet = await resolveUnet(USERID)
    const price = Math.max(0, parseInt(cfg.multiPrice) || cfg.price)
    if (cfg.outputLogs) {
      logger.info(`[p-draw] 多人请求 userId=${USERID} isAdmin=${isAdmin}`)
    }

    const allowed = parseAllowedSizes()
    const parsedSize = parseGenerationSize(rawText, allowed)
    if (parsedSize.error) return parsedSize.error

    // 批量张数解析（x3 / 3张 / --数量 3 等）
    const parsedBatch = parseBatchCount(parsedSize.prompt, cfg.batchMax)
    const text = parsedBatch.prompt
    if (!text) return session.text('.multi-usage')
    const count = parsedBatch.count

    // P 点校验（按总价 = 张数 × 单价）
    if (!isAdmin) {
      const notExists = await isAccountExists(USERID)
      if (!notExists) return session.text('.account-notExists')
      const usersdata = await getPUser(USERID)
      const saving = usersdata?.p || 0
      if (saving < count * price) return session.text('.no-enough-p', [count * price])
    }

    // 未指定尺寸时按人数/接触关系自动选横图
    let size = parsedSize.size
    if (!size && allowed.length) {
      size = multiPersonAutoSize(text, allowed)
    }

    // ComfyUI 就绪
    const ready = await ensureComfyuiReady()
    if (!ready.ok) return ready.message

    // 多人规划（强制依赖 LLM）
    if (!cfg.llmModel || !cfg.llmBaseUrl) {
      return session.text('.multi-no-llm')
    }

    // 多人规划
    const planResult = await generateMultiPersonPlan(text)
    if (!planResult.ok) {
      return session.text('.multi-usage') + '\n（多人规划失败：' + planResult.error + '）'
    }
    const plan = planResult.plan

    // 组装最终提示词
    const built = buildMultiPersonFinalPrompt(plan, text)
    if (!built.ok) {
      return session.text('.multi-usage') + '\n（多人规划失败：' + built.error + '）'
    }
    const finalPrompt = built.prompt

    // 多人负面词：在配置负面词后追加多人专属禁止词
    const multiNegative = [...(cfg.negativePrompt ? splitTags(cfg.negativePrompt) : []), ...MULTI_PERSON_NEGATIVE_TAGS].join(', ')

    // 扣 P 点（一次性扣除总价）
    if (!isAdmin) {
      const saving = await deductP(USERID, count * price)
      if (cfg.outputLogs) logger.info(`[p-draw] ${USERID} 多人已扣除 ${count * price} P 点（${count} 张 × ${price}），余额 ${saving - count * price}`)
    }

    // 队列：预排队全部任务，占满即退回总价
    const queuedTasks = []
    let firstPosition = null
    if (cfg.queueEnabled) {
      for (let i = 0; i < count; i++) {
        const q = enqueue(() => runComfyGenerate(finalPrompt, size, { negativePrompt: multiNegative, unet }))
        if (!q.ok) {
          if (!isAdmin) await refundP(USERID, count * price)
          return q.message
        }
        queuedTasks.push(q.task)
        if (firstPosition == null) firstPosition = q.position
      }
    }

    // 即时反馈
    const notice = []
    if (parsedBatch.clamped) notice.push(session.text('.batch-limit', [count]))
    if (cfg.queueEnabled) {
      notice.push(session.text('.queued', [firstPosition, cfg.queueMaxRequests || '∞']))
      if (count > 1) notice.push(session.text('.batch-count', [count]))
      if (!isAdmin) notice.push(session.text('.charged', [count * price]))
    } else {
      notice.push(session.text('.generating'))
      if (count > 1) notice.push(session.text('.batch-count', [count]))
      if (!isAdmin) notice.push(session.text('.charged', [count * price]))
    }
    if (notice.length) {
      try {
        await session.send(notice.filter(Boolean).join('\n'))
      } catch (e) {
        logger.warn(`发送反馈消息失败：${e.message}`)
      }
    }

    // 单张生成 +（可选）视觉校验
    const runOne = async (i) => {
      let result
      if (cfg.queueEnabled) {
        try { result = await queuedTasks[i] } catch (e) { result = { ok: false, message: `生成失败：${e.message}` } }
      } else {
        try { result = await runComfyGenerate(finalPrompt, size, { negativePrompt: multiNegative, unet }) } catch (e) { result = { ok: false, message: `生成失败：${e.message}` } }
      }
      if (!result.ok || !result.outputs || !result.outputs.length) return result
      if (!cfg.multiVerifyEnabled) {
        return { ok: true, outputs: result.outputs, seed: result.seed, note: session.text('.multi-degraded', ['（未启用校验或未配置视觉模型）']) }
      }
      const verified = await verifyGeneratedImages(session, result.outputs, text, finalPrompt, size, plan.characters.length, unet)
      if (!verified.ok) return { ok: false, message: verified.message }
      return { ok: true, outputs: verified.outputs, seed: result.seed, note: verified.message || '' }
    }

    const { results, successCount } = await executeBatch(USERID, isAdmin, count, price, runOne)

    // 汇总
    const allOutputs = []
    const notes = []
    const seeds = []
    const failures = []
    for (const item of results) {
      if (item.ok) {
        allOutputs.push(...item.outputs)
        if (item.seed != null) seeds.push(item.seed)
        if (item.note) notes.push(item.note)
      } else {
        failures.push(`第 ${item.i + 1} 张：${item.message}`)
      }
    }

    if (!allOutputs.length) {
      if (cfg.outputLogs) logger.warn(`多人生成全部失败（${USERID}），已按张退款`)
      return session.text('.generate-failed', ['全部失败（已按张退款）'])
    }

    if (cfg.outputLogs) logger.success(`${USERID} 多人生成成功 ${successCount}/${count} 张`)

    // 发图：引用用户触发指令的原消息
    const imageElements = allOutputs.map(src => h.image(src))
    try {
      await session.send(h.quote(session.messageId) + imageElements.join(''))
    } catch (e) {
      logger.warn(`发送多人图片失败：${e.message}`)
      await session.send(imageElements)
    }

    const reply = []
    if (count > 1) {
      reply.push(session.text('.generate-ok-batch', [count * price, successCount, seeds.join(', ') || '-']))
    } else {
      reply.push(session.text('.generate-ok', [price, seeds[0] || '-']))
    }
    if (notes.length) reply.push(notes.join('\n'))
    if (failures.length) reply.push(session.text('.batch-partial', [successCount, count, failures.length, failures.join('；')]))
    return reply.filter(Boolean).join('\n')
  }

  // 连续图/过程图主流程：同一角色多阶段（固定身份 + 阶段描述 + 全阶段共用同一 seed 保证一致性）
  // 语法：连续 <角色>：<阶段1> → <阶段2> → ...  或  连续 <角色>：<阶段1>|<阶段2>|...
  async function handleGenerateSeries(session, rawText) {
    const USERID = session.userId
    const isAdmin = isAdminUser(session)
    const unet = await resolveUnet(USERID)
    const price = Math.max(0, parseInt(cfg.price) || 500)

    // 阶段分隔符：箭头 / 管道
    const STAGE_SEP = /→|➔|➜|←|↔|=>|->|⇒|\|/

    // 尺寸解析（连续图默认横图）；固定 seed：全阶段共用，支持 --seed 覆盖（含 --seed: 冒号形式）
    const seedInfo = parseSeed(String(rawText || ''))
    const seed = seedInfo.seed != null ? seedInfo.seed : crypto.randomInt(1, 2 ** 32 - 1)
    const allowed = parseAllowedSizes()
    const parsedSize = parseGenerationSize(seedInfo.prompt, allowed)
    if (parsedSize.error) return parsedSize.error
    let size = parsedSize.size
    if (!size && allowed.length) {
      size = allowed.reduce((best, s) => {
        const a = Math.abs(s[0] / s[1] - 16 / 9)
        const b = Math.abs(best[0] / best[1] - 16 / 9)
        return a < b ? s : best
      })
    }
    const sizeCleanedPrompt = parsedSize.prompt

    // 提取身份与阶段文本（角色：阶段1 → 阶段2）
    let identity = ''
    let stageText = String(sizeCleanedPrompt || '').trim()
    const colonMatch = stageText.match(/^(.+?)[：:]\s*(.+)$/)
    if (colonMatch) {
      identity = colonMatch[1].trim()
      stageText = colonMatch[2].trim()
    }
    const stages = stageText
      .split(STAGE_SEP)
      .map(s => s.trim().replace(/^[\s,，、;；:：]+|[\s,，、;；:：]+$/g, '').replace(/\s+/g, ' '))
      .filter(Boolean)
    if (!stages.length) return session.text('.series-usage')

    const maxStages = Math.max(1, parseInt(cfg.batchMax) || 4)
    const count = Math.min(stages.length, maxStages)
    const clamped = stages.length > count
    const stageList = stages.slice(0, count)

    // P 点校验（按总价）
    if (!isAdmin) {
      const notExists = await isAccountExists(USERID)
      if (!notExists) return session.text('.account-notExists')
      const usersdata = await getPUser(USERID)
      const saving = usersdata?.p || 0
      if (saving < count * price) return session.text('.no-enough-p', [count * price])
    }

    // ComfyUI 就绪
    const ready = await ensureComfyuiReady()
    if (!ready.ok) return ready.message

    // 组装各阶段提示词：身份（含固定角色 tags）+ 阶段描述。
    // 连续图**只要配置了 LLM 就强制逐阶段优化**（不受 promptOptimizeEnabled 限制），
    // 因为 anima 是 Danbooru-tag 模型，中文阶段描述必须转成 tags 才能体现在画面里；
    // 未配置 LLM 时退回原始中文描述。
    const fixedChars = parsePresetList(cfg.fixedCharacters)
    const stagePrompts = []
    let degradedStages = 0
    for (const st of stageList) {
      const base = identity ? `${identity}，${st}` : st
      const result = await optimizeSeriesStage(base, identity)
      if (!result.ok) degradedStages += 1
      const stageTags = result.prompt || base
      const drops = result.drops || []
      // 始终注入固定角色 tags 作为身份锚点（保证角色名/种族/尖耳朵出现），
      // 阶段描述里被明确改变的外观由 drop 列表剔除，避免被固定默认值拉回。
      const identityTags = identity ? filterFixedTags(fixedChars[identity] || '', drops) : ''
      const anchor = stageTags
      const composed = composePrompt(anchor, false, identityTags)
      stagePrompts.push(composed.prompt)
    }

    // 扣 P 点（一次性扣除总价）
    if (!isAdmin) {
      const saving = await deductP(USERID, count * price)
      if (cfg.outputLogs) logger.info(`[p-draw] ${USERID} 连续图已扣除 ${count * price} P 点（${count} 阶段 × ${price}，seed=${seed}），余额 ${saving - count * price}`)
    }

    // 队列：预排队全部阶段
    const queuedTasks = []
    let firstPosition = null
    if (cfg.queueEnabled) {
      for (let i = 0; i < count; i++) {
        const q = enqueue(() => runComfyGenerate(stagePrompts[i], size, { seed, unet }))
        if (!q.ok) {
          if (!isAdmin) await refundP(USERID, count * price)
          return q.message
        }
        queuedTasks.push(q.task)
        if (firstPosition == null) firstPosition = q.position
      }
    }

    // 即时反馈
    const notice = []
    if (clamped) notice.push(session.text('.batch-limit', [count]))
    if (identity && fixedChars[identity]) notice.push(`已固定角色「${identity}」的身份 tags，各阶段外观将保持一致。`)
    if (degradedStages) notice.push(session.text('.prompt-degraded', ['（连续图阶段优化失败，已使用原始描述）']))
    if (cfg.queueEnabled) {
      notice.push(session.text('.queued', [firstPosition, cfg.queueMaxRequests || '∞']))
      if (count > 1) notice.push(session.text('.batch-count', [count]))
      if (!isAdmin) notice.push(session.text('.charged', [count * price]))
    } else {
      notice.push(session.text('.generating'))
      if (count > 1) notice.push(session.text('.batch-count', [count]))
      if (!isAdmin) notice.push(session.text('.charged', [count * price]))
    }
    if (notice.length) {
      try {
        await session.send(notice.filter(Boolean).join('\n'))
      } catch (e) {
        logger.warn(`发送反馈消息失败：${e.message}`)
      }
    }

    // 单阶段生成（共用 seed）
    const runOne = async (i) => {
      let result
      if (cfg.queueEnabled) {
        try { result = await queuedTasks[i] } catch (e) { result = { ok: false, message: `生成失败：${e.message}` } }
      } else {
        try { result = await runComfyGenerate(stagePrompts[i], size, { seed, unet }) } catch (e) { result = { ok: false, message: `生成失败：${e.message}` } }
      }
      return result
    }

    const { results, successCount } = await executeBatch(USERID, isAdmin, count, price, runOne)

    // 汇总
    const allOutputs = []
    const seeds = []
    const failures = []
    for (const item of results) {
      if (item.ok) {
        allOutputs.push(...item.outputs)
        if (item.seed != null) seeds.push(item.seed)
      } else {
        failures.push(`第 ${item.i + 1} 阶段：${item.message}`)
      }
    }

    if (!allOutputs.length) {
      if (cfg.outputLogs) logger.warn(`连续图全部失败（${USERID}），已按阶段退款`)
      return session.text('.generate-failed', ['全部失败（已按阶段退款）'])
    }

    if (cfg.outputLogs) logger.success(`${USERID} 连续图生成成功 ${successCount}/${count} 阶段（seed=${seed}）`)

    // 发图：引用用户触发指令的原消息
    const imageElements = allOutputs.map(src => h.image(src))
    try {
      await session.send(h.quote(session.messageId) + imageElements.join(''))
    } catch (e) {
      logger.warn(`发送连续图失败：${e.message}`)
      await session.send(imageElements)
    }

    const reply = []
    reply.push(session.text('.series-ok', [count * price, successCount, seed]))
    if (failures.length) reply.push(session.text('.batch-partial', [successCount, count, failures.length, failures.join('；')]))
    return reply.filter(Boolean).join('\n')
  }

  // ---------------- 权限 ----------------
  function readableOptimizeReason(reason) {
    if (!reason) return ''
    if (reason === 'llm_not_configured') return '（未配置 LLM 模型名或接口地址）'
    if (reason === 'optimize_disabled') return ''
    return `（${reason}）`
  }
  // Koishi 的 session.userId 可能带平台前缀（如 onebot:12345），
  // 这里统一归一化为纯数字串后再与配置中的 ID 比较。
  function normalizeId(value) {
    const text = String(value == null ? '' : value).trim()
    const match = text.match(/\d{5,}/)
    return match ? match[0] : text.toLowerCase()
  }

  function idInList(value, list) {
    const target = normalizeId(value)
    return (list || []).some(item => normalizeId(item) === target)
  }

  function isAdminUser(session) {
    return idInList(session.userId, cfg.adminUsers)
  }

  function isAllowed(session) {
    if (cfg.adminOnly && !isAdminUser(session)) return false

    const senderId = session.userId
    if (idInList(senderId, cfg.blockedUserIds)) return false

    const channelId = session.channelId || ''
    if (idInList(channelId, cfg.blockedGroupIds)) return false

    const allowedGroups = cfg.allowedGroupIds || []
    const allowedUsers = cfg.allowedUserIds || []

    if (channelId && idInList(channelId, allowedGroups)) return true

    if (channelId && allowedGroups.length && !allowedUsers.length) return false

    if (allowedUsers.length && !idInList(senderId, allowedUsers)) return false
    return true
  }

  // ---------------- P 点 ----------------
  async function getPUser(USERID) {
    try {
      const rows = await ctx.database.get('p_system', { userid: USERID })
      return rows && rows[0] ? rows[0] : null
    } catch (e) {
      logger.warn(`读取 p_system 失败（请确认已安装并启用 p-qiandao）：${e.message}`)
      return null
    }
  }

  async function isAccountExists(USERID) {
    const user = await getPUser(USERID)
    return !!user
  }

  async function deductP(USERID, amount) {
    const user = await getPUser(USERID)
    const current = user?.p || 0
    await ctx.database.set('p_system', { userid: USERID }, { p: Math.max(0, current - amount) })
    return current
  }

  async function refundP(USERID, amount) {
    const user = await getPUser(USERID)
    const current = user?.p || 0
    await ctx.database.set('p_system', { userid: USERID }, { p: current + amount })
  }

  // ---------------- 画师组/角色管理（持久化到数据库，避免 scope.update 触发重载） ----------------
  // 注意：更新数据里不能带主键 id，否则数据库驱动会报 cannot modify primary key
  function runtimeState() {
    return {
      fixed_characters: cfg.fixedCharacters || [],
      artist_presets: cfg.artistPresets || [],
      active_artist_preset: cfg.activeArtistPreset || '',
      default_artist_tags: cfg.defaultArtistTags || '',
      user_models: cfg.userModels || {},
    }
  }

  // 启动时把数据库里保存的画师组/固定角色合并进 cfg（数据库覆盖配置，保证运行时新增不被重启丢失）
  async function loadRuntimeState() {
    try {
      const rows = await ctx.database.get('p_draw_config', { id: 1 })
      const row = rows && rows[0]
      if (!row) return
      if (Array.isArray(row.fixed_characters)) cfg.fixedCharacters = row.fixed_characters
      if (Array.isArray(row.artist_presets)) cfg.artistPresets = row.artist_presets
      if (row.active_artist_preset) cfg.activeArtistPreset = row.active_artist_preset
      if (row.default_artist_tags != null) cfg.defaultArtistTags = row.default_artist_tags
      if (row.user_models && typeof row.user_models === 'object') cfg.userModels = row.user_models
      if (cfg.outputLogs) logger.info(`[p-draw] 已加载运行时配置（画师组 ${(cfg.artistPresets || []).length} 个，固定角色 ${(cfg.fixedCharacters || []).length} 个，模型偏好 ${Object.keys(cfg.userModels || {}).length} 个）`)
    } catch (e) {
      logger.warn(`读取运行时配置失败（画师组/固定角色可能未持久化）：${e.message}`)
    }
  }

  async function persistConfig(key, value) {
    cfg[key] = value
    try {
      const state = runtimeState()
      const existing = await ctx.database.get('p_draw_config', { id: 1 })
      if (existing && existing[0]) {
        await ctx.database.set('p_draw_config', { id: 1 }, state)
      } else {
        await ctx.database.create('p_draw_config', { id: 1, ...state })
      }
    } catch (e) {
      logger.warn(`运行时配置保存失败（重启后可能丢失）：${e.message}`)
    }
  }

  function normalizeTagText(text) {
    const tags = []
    for (const tag of String(text || '').split(',')) {
      const t = tag.trim()
      if (t) tags.push(t)
    }
    return tags.join(', ') + (tags.length ? ',' : '')
  }

  // ---------------- 指令 ----------------
  ctx.command('p/p-draw [prompt:rawtext]')
    .alias('画图', '生图', '绘图', '画画')
    .action(async ({ session }, prompt) => {
      const USERID = session.userId
      const text = String(prompt || '').trim()

      if (!isAllowed(session)) return session.text('.not-permitted')

      if (!text) return session.text('.usage')

      const lower = text.toLowerCase()
      if (lower === 'help' || lower === '帮助' || lower === '使用帮助' || lower === 'help 帮助') {
        return session.text('.usage')
      }
      if (lower === '状态' || lower === 'status') {
        const payload = await statusPayload()
        return statusText(payload)
      }
      if (lower === '诊断' || lower === 'diagnose' || lower === '部署诊断' || lower === 'debug' || lower === '调试' || lower === '调试状态') {
        return await diagnoseText(session)
      }

      // 连续图指令：p-draw 连续 <角色>：<阶段1> → <阶段2>
      const seriesMatch = text.match(/^连续\s*(.*)$/)
      if (seriesMatch) {
        return await handleGenerateSeries(session, seriesMatch[1].trim())
      }

      // 以图生图指令：p-draw i2i <描述>（需同一条消息附带原图）
      const i2iMatch = text.match(/^i2i\s*(.*)$/i)
      if (i2iMatch) {
        return await handleGenerateI2I(session, i2iMatch[1].trim())
      }

      // 多人指令：p-draw 多人 <描述>
      const multiMatch = text.match(/^(?:多人|多人生图|双人|三人|群像)\s*(.*)$/)
      if (multiMatch) {
        return await handleGenerateMulti(session, multiMatch[1].trim())
      }

      // 画师组管理
      const createArtist = text.match(/^(?:创建|新建|新建新的|创建新的|保存|保存新的)\s*画师组\s*(.*)$/)
      if (createArtist) {
        const parsed = parseNameTags(createArtist[1])
        if (!parsed) return session.text('.artist-format')
        const presets = parsePresetList(cfg.artistPresets)
        presets[parsed.name] = normalizeTagText(parsed.tags)
        await persistConfig('artistPresets', Object.entries(presets).map(([n, t]) => `${n}=${t}`))
        await persistConfig('activeArtistPreset', parsed.name)
        if (cfg.outputLogs) logger.success(`${USERID} 创建画师组 ${parsed.name}`)
        return session.text('.artist-created', [parsed.name, parsed.tags])
      }
      const appendArtist = text.match(/^(?:追加|添加|加入|加入新的|添加新的)\s*画师组\s*(.*)$/)
      if (appendArtist) {
        const parsed = parseNameTags(appendArtist[1])
        if (parsed) {
          const presets = parsePresetList(cfg.artistPresets)
          presets[parsed.name] = mergeTagText(presets[parsed.name], normalizeTagText(parsed.tags))
          await persistConfig('artistPresets', Object.entries(presets).map(([n, t]) => `${n}=${t}`))
          await persistConfig('activeArtistPreset', parsed.name)
          return session.text('.artist-appended', [parsed.name, presets[parsed.name]])
        }
        const presets = parsePresetList(cfg.artistPresets)
        const active = cfg.activeArtistPreset && presets[cfg.activeArtistPreset]
          ? cfg.activeArtistPreset
          : ''
        if (active) {
          presets[active] = mergeTagText(presets[active], normalizeTagText(appendArtist[1]))
          await persistConfig('artistPresets', Object.entries(presets).map(([n, t]) => `${n}=${t}`))
          return session.text('.artist-appended', [active, presets[active]])
        }
        const merged = mergeTagText(cfg.defaultArtistTags, normalizeTagText(appendArtist[1]))
        await persistConfig('defaultArtistTags', merged)
        return session.text('.artist-default-appended', [merged])
      }
      const useArtist = text.match(/^(?:切换|启用|使用|选择)\s*画师组\s*(.*)$/)
      if (useArtist) {
        const name = String(useArtist[1]).trim()
        if (!name) return session.text('.artist-use-format')
        if (['默认', '默认画师', '默认画师组', 'default'].includes(name)) {
          await persistConfig('activeArtistPreset', '')
          return session.text('.artist-default')
        }
        const presets = parsePresetList(cfg.artistPresets)
        if (!presets[name]) return session.text('.artist-not-found', [name])
        await persistConfig('activeArtistPreset', name)
        return session.text('.artist-used', [name, presets[name]])
      }
      if (text.match(/^(?:查看|列出|显示)\s*画师组|画师组列表|画师组$/)) {
        const presets = parsePresetList(cfg.artistPresets)
        const active = cfg.activeArtistPreset && presets[cfg.activeArtistPreset] ? cfg.activeArtistPreset : ''
        const lines = ['画师组：']
        lines.push(`- 备用画师 tags：${cfg.defaultArtistTags ? '已配置' : '未配置'}${!active ? '（当前）' : ''}`)
        if (!Object.keys(presets).length) {
          lines.push('- 已保存的画师组：无')
        } else {
          for (const [name, tags] of Object.entries(presets)) {
            lines.push(`- ${name}${name === active ? '（当前）' : ''}：${tags.slice(0, 120)}`)
          }
        }
        return lines.join('\n')
      }
      const deleteArtist = text.match(/^(?:删除|移除)\s*画师组\s*(.*)$/)
      if (deleteArtist) {
        const name = String(deleteArtist[1]).trim()
        if (!name) return session.text('.artist-delete-format')
        const presets = parsePresetList(cfg.artistPresets)
        if (!presets[name]) return session.text('.artist-not-found', [name])
        delete presets[name]
        await persistConfig('artistPresets', Object.entries(presets).map(([n, t]) => `${n}=${t}`))
        if (cfg.activeArtistPreset === name) await persistConfig('activeArtistPreset', '')
        return session.text('.artist-deleted', [name])
      }

      // 固定角色管理
      const addCharacter = text.match(/^(?:添加|加入|新增|新建|创建|保存)\s*(?:固定)?\s*角色\s*(.*)$/)
      if (addCharacter) {
        const parsed = parseNameTags(addCharacter[1])
        if (!parsed) return session.text('.character-format')
        const chars = parsePresetList(cfg.fixedCharacters)
        chars[parsed.name] = normalizeTagText(parsed.tags)
        await persistConfig('fixedCharacters', Object.entries(chars).map(([n, t]) => `${n}=${t}`))
        if (cfg.outputLogs) logger.success(`${USERID} 添加固定角色 ${parsed.name}`)
        return session.text('.character-created', [parsed.name, parsed.tags])
      }

      // 模型切换：p-draw 模型 <名称>（查看）/ p-draw 模型 默认（重置）
      const modelMatch = text.match(/^(?:切换)?\s*模型\s*(.*)$/)
      if (modelMatch) {
        const arg = String(modelMatch[1]).trim()
        const list = await listUnetModels()
        const all = list.length ? list : [cfg.unetName]
        const current = await resolveUnet(USERID)
        if (!arg || ['当前', '查看', '列表', 'help', '帮助'].includes(arg)) {
          return session.text('.model-usage', [current, all.join('\n')])
        }
        if (['默认', '重置', '恢复默认'].includes(arg)) {
          delete cfg.userModels[USERID]
          await persistConfig('userModels', cfg.userModels)
          if (cfg.outputLogs) logger.success(`${USERID} 恢复默认模型`)
          return session.text('.model-reset', [cfg.unetName])
        }
        const match = matchUnetModel(arg, all)
        if (!match) {
          // 明显是一段生图描述（带逗号/冒号/很长）时，明确告知模型指令不能生图
          if (/[,，:：]/.test(arg) || arg.length > 50) return session.text('.model-no-draw')
          return session.text('.model-not-found', [arg, all.join('\n')])
        }
        if (match.multiple) return session.text('.model-ambiguous', [arg, match.multiple.join('\n')])
        cfg.userModels[USERID] = String(match)
        await persistConfig('userModels', cfg.userModels)
        if (cfg.outputLogs) logger.success(`${USERID} 切换模型 → ${match}`)
        return session.text('.model-switched', [String(match)])
      }

      // 主生成流程
      return await handleGenerate(session, text)
    })

  // ---------------- 以图生图（p-draw i2i） ----------------
  async function handleGenerateI2I(session, rawText) {
    if (cfg.customWorkflowEnabled && cfg.customWorkflowPath) {
      return session.text('.i2i-no-custom-workflow')
    }
    const image = await extractImageFromSession(session)
    if (!image) return session.text('.i2i-no-image')
    let uploadName
    try {
      uploadName = await uploadImageToComfyui(image)
    } catch (e) {
      logger.warn(`上传原图失败：${e.message}`)
      return session.text('.i2i-upload-fail', [e.message])
    }
    if (cfg.outputLogs) logger.info(`[p-draw] i2i ${session.userId} 原图已上传：${uploadName}`)

    // 能力检测（ControlNet / Anima IP-Adapter）
    const caps = await detectI2ICapabilities()

    // 处理模式：i2iMode=ask 时交互询问；style/ootd/plain 直接固定
    let mode = 'plain'
    const cfgMode = String(cfg.i2iMode || 'ask').toLowerCase()
    if (cfgMode === 'style' || cfgMode === 'ootd') {
      mode = cfgMode
    } else if (cfgMode === 'ask' && typeof session.prompt === 'function') {
      const chosen = await askI2IMode(session)
      if (chosen === 'cancel') return session.text('.i2i-mode-cancelled')
      if (chosen === null) {
        await session.send(session.text('.i2i-mode-cancelled'))
        return ''
      }
      mode = chosen
      if (mode === 'style') await session.send(session.text('.i2i-mode-style'))
      if (mode === 'ootd') await session.send(session.text('.i2i-mode-ootd'))
    }
    if (cfg.outputLogs) logger.info(`[p-draw] i2i ${session.userId} 模式=${mode} ControlNet=${caps.controlNet.available ? caps.controlNet.model : '-'} IPAdapter=${caps.ipAdapter.available ? 'on' : 'off'}`)

    // 所选模式依赖的节点缺失时给出提示（仍会回退普通 img2img，不中断）
    const notices = []
    if (mode === 'style' && (!caps.controlNet.available || !caps.controlNet.model)) {
      notices.push(session.text('.i2i-no-controlnet'))
    }
    if (mode === 'ootd' && (!caps.ipAdapter.available || !String(cfg.i2iIPAdapterPath || '').trim())) {
      notices.push(session.text('.i2i-no-ipadapter'))
    }
    if (notices.length) {
      try { await session.send(notices.join('\n')) } catch (e) { logger.warn(`发送 i2i 提示失败：${e.message}`) }
    }

    // 识图：仅当启用、非无优化模式、且已配置 LLM（识图结果会注入提示词优化）时才执行
    let taggerTags = ''
    if (cfg.taggerEnabled && cfg.llmModel && cfg.llmBaseUrl && !stripRawPrefix(rawText).raw) {
      try {
        taggerTags = await taggerImage(uploadName)
        if (cfg.outputLogs) logger.info(`[p-draw] i2i ${session.userId} 识图完成：${taggerTags.slice(0, 120)}${taggerTags.length > 120 ? '...' : ''}`)
      } catch (e) {
        logger.warn(`识图失败（继续生图）：${e.message}`)
      }
    }
    return await handleGenerate(session, rawText, uploadName, taggerTags, { mode, caps })
  }

  // 识图预工作流：LoadImage → WD14Tagger|pysssss，读回原图 tags
  async function taggerImage(uploadName) {
    const model = String(cfg.taggerModel || 'wd-v1-4-convnext-tagger-v2').trim()
    const taggerNodeId = '61'
    const promptBody = {
      '60': { class_type: 'LoadImage', inputs: { image: uploadName } },
      [taggerNodeId]: {
        class_type: 'WD14Tagger|pysssss',
        inputs: {
          image: ['60', 0],
          model,
          threshold: Number(cfg.taggerThreshold) || 0.35,
          character_threshold: Number(cfg.taggerCharacterThreshold) || 0.85,
          replace_underscore: true,
          trailing_comma: false,
          exclude_tags: '',
        },
      },
    }
    const clientId = crypto.randomUUID()
    const submit = await comfyPost('/prompt', { prompt: promptBody, client_id: clientId }, 20000)
    const promptId = submit && submit.prompt_id
    if (!promptId) throw new Error('识图工作流提交失败')
    const timeoutMs = Math.max(1, parseInt(cfg.timeout) || 300) * 1000
    const pollMs = Math.max(1, parseInt(cfg.pollInterval) || 2) * 1000
    const history = await waitComfyResult(ctx, comfyGet, baseUrl(), promptId, clientId, timeoutMs, pollMs)
    if (!history) throw new Error('识图超时')
    const nodeOutput = history.outputs && history.outputs[taggerNodeId]
    const tags = (nodeOutput && Array.isArray(nodeOutput.tags) ? nodeOutput.tags : []).filter(Boolean)
    const first = String(tags[0] || '').trim()
    if (!first) throw new Error('识图未返回标签')
    return first
  }

  // 从会话消息里取第一张图片并下载为内存 Buffer
  async function extractImageFromSession(session) {
    const elements = session.elements || []
    const img = elements.find((e) => e.type === 'img' || e.type === 'image')
    if (!img) return null
    const attrs = img.attrs || img.data || {}
    const src = String(attrs.src || '')
    if (!src) return null
    try {
      if (/^file:\/\//i.test(src)) {
        const filePath = src.replace(/^file:\/\//i, '')
        const buffer = await fsp.readFile(filePath)
        return { buffer, ext: path.extname(filePath) || '.png' }
      }
      if (/^data:/i.test(src)) {
        const m = src.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/)
        if (!m) return null
        const kind = m[1].toLowerCase()
        const ext = kind === 'jpeg' ? '.jpg' : kind === 'webp' ? '.webp' : kind === 'png' ? '.png' : '.' + (kind || 'png')
        return { buffer: Buffer.from(m[2], 'base64'), ext }
      }
      const res = await fetch(src)
      if (!res.ok) return null
      const buffer = Buffer.from(await res.arrayBuffer())
      const mime = String(res.headers.get('content-type') || '')
      const ext = mime.includes('jpeg') ? '.jpg' : mime.includes('webp') ? '.webp' : '.png'
      return { buffer, ext }
    } catch (e) {
      logger.warn(`读取原图失败：${e.message}`)
      return null
    }
  }

  // 上传图片到 ComfyUI input 目录，返回 ComfyUI 使用的文件名
  async function uploadImageToComfyui(image) {
    const filename = `pdraw_i2i_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${image.ext || '.png'}`
    const form = new FormData()
    form.append('image', new Blob([image.buffer]), filename)
    form.append('overwrite', 'true')
    form.append('type', 'input')
    const res = await fetch(baseUrl() + '/upload/image', { method: 'POST', body: form })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json().catch(() => ({}))
    if (!data || !data.name) throw new Error('ComfyUI 未返回上传文件名')
    return data.name
  }

  // 检测 i2i 可用能力：Anima ControlNet-LLLite 节点与权重（comfyui-anima-lllite / kohya-ss/ComfyUI-Anima-LLLite）、
  // LineArt 预处理器（comfyui_controlnet_aux，可选）与 Anima IP-Adapter 专用节点（comfyui-anima-ipadapter）。
  // 检测失败全部视为不可用（回退普通 img2img）。
  // 注意：Qwen-Image InstantX ControlNet 与 Anima（MiniTrainDIT，3584 维）架构不兼容，这里只认 LLLite 权重。
  async function detectI2ICapabilities() {
    const caps = { controlNet: { available: false, model: null, preprocessor: 'Canny' }, ipAdapter: { available: false } }
    let info
    try {
      info = await getObjectInfoCached()
    } catch (e) {
      return caps
    }
    if (!info || typeof info !== 'object') return caps
    // LineArt 预处理器（comfyui_controlnet_aux）：AnimeLineArt 更贴近漫画线条，优先；LineArt 次之；都没有则回退 Canny
    if (info.AnimeLineArtPreprocessor) {
      caps.controlNet.preprocessor = 'AnimeLineArtPreprocessor'
    } else if (info.LineArtPreprocessor) {
      caps.controlNet.preprocessor = 'LineArtPreprocessor'
    }
    // Anima ControlNet-LLLite：lllite_name 从 models/controlnet 目录读取，只挑 anima-lllite 系权重
    if (info.AnimaLLLiteApply_sdscripts) {
      const llliteModels = availableModels(info, 'AnimaLLLiteApply_sdscripts', 'lllite_name')
      if (cfg.outputLogs) logger.info(`[p-draw] i2i LLLite 节点存在，models/controlnet 文件列表=${JSON.stringify(llliteModels)}`)
      if (llliteModels.length) {
        const configured = String(cfg.controlNetModel || '').trim()
        const norm = (s) => String(s).toLowerCase().replace(/[-_ ]/g, '')
        const prefers = ['anima-lllite-lineart', 'anima-lllite', 'lllite-lineart', 'lllite']
        const pool = llliteModels.filter((m) => /lllite/i.test(String(m)))
        const scored = pool.map((m) => ({ m, s: prefers.reduce((acc, p, i) => acc + (norm(m) === norm(p) ? prefers.length - i : 0), 0) }))
        scored.sort((a, b) => b.s - a.s)
        const best = (scored[0] && scored[0].m) || null
        caps.controlNet.model = configured && llliteModels.includes(configured) ? configured : best
        caps.controlNet.available = !!caps.controlNet.model
      }
      // 换风格专用主模型必须是 28-block（与 LLLite 权重匹配），检测它是否已安装
      const styleModel = String(cfg.i2iUnetName || '').trim() || cfg.unetName
      const unetList = availableModels(info, 'UNETLoader', 'unet_name')
      if (unetList.length && !unetList.includes(styleModel)) {
        logger.warn(`[p-draw] i2i 换风格专用主模型 ${styleModel} 不在 models/diffusion_models 中（现有：${JSON.stringify(unetList)}）。LLLite 权重为 28-block，请安装 anima-base-v1.0 或修改 i2iUnetName 配置，否则换风格会报 depth_embed slices missing`)
        caps.controlNet.modelMismatch = true
      }
    } else if (cfg.outputLogs) {
      logger.info('[p-draw] i2i 未检测到 AnimaLLLiteApply_sdscripts 节点（请确认已安装 kohya-ss/ComfyUI-Anima-LLLite 并重启 ComfyUI）')
    }
    if (info.AnimaIPAdapterLoader && info.AnimaIPAdapterApply && info.AnimaSiglipeEncodeImage) {
      caps.ipAdapter.available = true
    }
    if (cfg.outputLogs) logger.info(`[p-draw] i2i 能力检测：ControlNet(LLLite)=${JSON.stringify(caps.controlNet)} IPAdapter=${JSON.stringify(caps.ipAdapter)}`)
    return caps
  }

  // 交互式询问 i2i 处理模式，返回 'style' / 'ootd' / 'cancel' / null（超时或无法询问时 null）
  async function askI2IMode(session, i18nAsk) {
    if (typeof session.prompt !== 'function') return null
    await session.send(i18nAsk || session.text('.i2i-mode-ask'))
    const reply = await session.prompt((cfg.i2iAskTimeout || 60) * 1000).catch(() => null)
    const ans = String((reply && (reply.content != null ? reply.content : reply)) || '').trim()
    if (/^(1|①|换风格|风格|漫画|漫画化|style|stylechange)$/i.test(ans)) return 'style'
    if (/^(2|②|换装|换装换姿势|换衣服|换姿势|ootd|outfit)$/i.test(ans)) return 'ootd'
    if (/^(3|③|取消|不生成|不要|算了|cancel|no)$/i.test(ans)) return 'cancel'
    if (!ans) return null
    await session.send(session.text('.i2i-mode-invalid'))
    return askI2IMode(session, i18nAsk)
  }

  async function handleGenerate(session, rawText, i2iImage = null, taggerTags = '', i2iOpts = null) {
    const USERID = session.userId
    const isAdmin = isAdminUser(session)
    const unet = await resolveUnet(USERID)
    const i2iRule = i2iImage
      ? '这是以图生图（img2img）：原图的构图、主体与色调会被保留。请主要描述你希望发生的变化（风格、服装、表情、场景改造、细节调整等），不要重复描述原图已有的细节。'
        + (taggerTags
          ? `\n\n原图内容参考（本地识图自动识别出的标签，用于了解原图已包含的内容；不要照抄全部标签，只参考与用户改动需求相关的部分）：\n${taggerTags}`
          : '')
      : ''
    if (cfg.outputLogs) {
      logger.info(`[p-draw] 请求 userId=${USERID} isAdmin=${isAdmin} adminUsers=${JSON.stringify(cfg.adminUsers || [])} normalizeId=${normalizeId(USERID)}`)
    }

    // 尺寸解析
    const allowed = parseAllowedSizes()
    const parsedSize = parseGenerationSize(rawText, allowed)
    if (parsedSize.error) return parsedSize.error

    // 批量张数解析（x3 / 3张 / --数量 3 等）
    const parsedBatch = parseBatchCount(parsedSize.prompt, cfg.batchMax)
    // 固定种子解析（--seed:xxx / --seed xxx / --seed=xxx），并从提示词中剥离
    const parsedSeed = parseSeed(parsedBatch.prompt)
    // i2i 去噪强度解析（--denoise 0.6 / --去噪 0.4），并从提示词中剥离
    const parsedDenoise = i2iImage ? parseDenoise(parsedSeed.prompt) : { denoise: null, prompt: parsedSeed.prompt }
    const text = parsedDenoise.prompt
    const seed = parsedSeed.seed
    const denoise = parsedDenoise.denoise
    const count = parsedBatch.count

    // P 点校验（按总价 = 张数 × 单价）
    if (!isAdmin) {
      const notExists = await isAccountExists(USERID)
      if (!notExists) return session.text('.account-notExists')
      const usersdata = await getPUser(USERID)
      const saving = usersdata?.p || 0
      if (saving < count * cfg.price) return session.text('.no-enough-p', [count * cfg.price])
    }

    // 原样模式
    const stripped = stripRawPrefix(text)
    const raw = stripped.raw
    const userPrompt = stripped.prompt
    if (!userPrompt) return session.text('.no-prompt')

    // ComfyUI 就绪
    const ready = await ensureComfyuiReady()
    if (!ready.ok) return ready.message

    // 提示词
    let finalPrompt = userPrompt
    let degraded = false
    let optimizedReason = ''
    let tokenUsedCount = 0
    let tokenShortfall = 0
    let perImageOptimize = false
    let noOptimizeReason = ''
    let interactiveCoupon = false
    if (!raw) {
      const globalOpt = cfg.promptOptimizeEnabled
      const adminOpt = !globalOpt && isAdmin && cfg.llmModel && cfg.llmBaseUrl
      const tokenOpt = !globalOpt && !isAdmin && cfg.llmModel && cfg.llmBaseUrl
      if (globalOpt) {
        // 全局优化开启：一次优化，整批复用同一提示词
        const optimized = await optimizePrompt(session, userPrompt, false, i2iRule)
        finalPrompt = optimized.prompt
        degraded = !optimized.ok
        optimizedReason = optimized.reason || ''
      } else if (adminOpt) {
        // 管理员在全局关闭时也免费优化（不耗券）
        const optimized = await optimizePrompt(session, userPrompt, true, i2iRule)
        finalPrompt = optimized.prompt
        degraded = !optimized.ok
        optimizedReason = optimized.reason || ''
      } else if (tokenOpt) {
        // 全局优化关闭：使用 p-shop 的「提示词优化券」（p_system.llmToken）。
        // 券一次性，按张数扣：x3 扣 3 张，每张图独立做一次 LLM 优化。
        // 交互式确认：有券问是否使用（拒绝则取消本次生图）；
        // 没券/券不足问是否购买（显示价格，拒绝一次再警告并问第二次，再拒绝直接生图）。
        const puser = await getPUser(USERID)
        const tokens = puser ? parseInt(puser.llmToken || 0) : 0
        if (typeof session.prompt === 'function') {
          const outcome = await couponConfirmFlow(session, USERID, tokens, count)
          if (outcome.cancelled) return ''
          tokenUsedCount = outcome.tokenUsedCount
          perImageOptimize = outcome.perImageOptimize
          noOptimizeReason = outcome.noOptimizeReason
          interactiveCoupon = true
        } else {
          // 平台不支持交互式确认：退回自动消耗逻辑
          if (tokens >= count) {
            try {
              await ctx.database.set('p_system', { userid: USERID }, { llmToken: Math.max(0, tokens - count) })
              tokenUsedCount = count
              perImageOptimize = true
            } catch (e) {
              logger.warn(`消耗提示词优化券失败：${e.message}`)
            }
          } else {
            tokenShortfall = count - tokens
          }
        }
      } else {
        // 没走任何 LLM 优化：LLM 未配置
        noOptimizeReason = 'no-llm-config'
      }
    } else {
      noOptimizeReason = 'raw'
    }
    // 非按张优化模式：直接拼好整批复用的提示词
    if (!perImageOptimize) {
      const composed = composePrompt(finalPrompt, raw)
      finalPrompt = appendInlineProtectedTags(composed.prompt, userPrompt, raw)
      degraded = degraded || composed.degraded
    }

    // 扣 P 点（一次性扣除总价）
    if (!isAdmin) {
      const saving = await deductP(USERID, count * cfg.price)
      if (cfg.outputLogs) logger.info(`[p-draw] ${USERID} 已扣除 ${count * cfg.price} P 点（${count} 张 × ${cfg.price}），余额 ${saving - count * cfg.price}`)
    }

    // i2i 运行参数：模式（style/ootd/plain）、--denoise 覆盖值、检测到的能力
    const i2iRun = i2iImage
      ? { i2iImage, i2i: { mode: (i2iOpts && i2iOpts.mode) || 'plain', denoise: denoise != null ? denoise : null, caps: (i2iOpts && i2iOpts.caps) || null } }
      : {}

    // 队列：预排队全部任务，占满即退回总价
    const queuedTasks = []
    let firstPosition = null
    if (cfg.queueEnabled) {
      for (let i = 0; i < count; i++) {
        const q = enqueue(async () => {
          let p = finalPrompt
          if (perImageOptimize) {
            const optimized = await optimizePrompt(session, userPrompt, true, i2iRule)
            p = appendInlineProtectedTags(composePrompt(optimized.prompt || userPrompt, raw).prompt, userPrompt, raw)
          }
          return runComfyGenerate(p, parsedSize.size, Object.assign({ unet, seed }, i2iRun))
        })
        if (!q.ok) {
          if (!isAdmin) await refundP(USERID, count * cfg.price)
          return q.message
        }
        queuedTasks.push(q.task)
        if (firstPosition == null) firstPosition = q.position
      }
    }

    // 先发一条即时反馈（扣费结果 / 队列位置 / 降级提示），
    // 确保用户不会以为指令没反应。
    const notice = []
    if (degraded) {
      const reason = readableOptimizeReason(optimizedReason)
      notice.push(session.text('.prompt-degraded', [reason]))
    }
    if (tokenUsedCount && !interactiveCoupon) notice.push(session.text('.token-used', [tokenUsedCount]))
    if (tokenShortfall) notice.push(session.text('.token-short', [count, count - tokenShortfall]))
    if (!tokenShortfall && noOptimizeReason && !interactiveCoupon) {
      const reasons = {
        'no-llm-config': '未配置 LLM（llmBaseUrl/llmModel 为空）',
        'raw': '无优化模式（原样生图）',
      }
      notice.push(session.text('.no-optimize', [reasons[noOptimizeReason] || noOptimizeReason]))
    }
    if (parsedBatch.clamped) notice.push(session.text('.batch-limit', [count]))
    if (cfg.queueEnabled) {
      notice.push(session.text('.queued', [firstPosition, cfg.queueMaxRequests || '∞']))
      if (count > 1) notice.push(session.text('.batch-count', [count]))
      if (!isAdmin) notice.push(session.text('.charged', [count * cfg.price]))
    } else {
      notice.push(session.text('.generating'))
      if (count > 1) notice.push(session.text('.batch-count', [count]))
      if (!isAdmin) notice.push(session.text('.charged', [count * cfg.price]))
    }
    if (notice.length) {
      try {
        await session.send(notice.filter(Boolean).join('\n'))
      } catch (e) {
        logger.warn(`发送反馈消息失败：${e.message}`)
      }
    }

    // 单张生成
    const runOne = async (i) => {
      let p = finalPrompt
      if (perImageOptimize) {
        const optimized = await optimizePrompt(session, userPrompt, true, i2iRule)
        p = appendInlineProtectedTags(composePrompt(optimized.prompt || userPrompt, raw).prompt, userPrompt, raw)
      }
      let result
      if (cfg.queueEnabled) {
        try { result = await queuedTasks[i] } catch (e) { result = { ok: false, message: `生成失败：${e.message}` } }
      } else {
        try { result = await runComfyGenerate(p, parsedSize.size, Object.assign({ unet, seed }, i2iRun)) } catch (e) { result = { ok: false, message: `生成失败：${e.message}` } }
      }
      return result
    }

    const { results, successCount } = await executeBatch(USERID, isAdmin, count, cfg.price, runOne)

    // 汇总
    const allOutputs = []
    const seeds = []
    const failures = []
    for (const item of results) {
      if (item.ok) {
        allOutputs.push(...item.outputs)
        if (item.seed != null) seeds.push(item.seed)
      } else {
        failures.push(`第 ${item.i + 1} 张：${item.message}`)
      }
    }

    if (!allOutputs.length) {
      if (cfg.outputLogs) logger.warn(`生成全部失败（${USERID}），已按张退款`)
      return session.text('.generate-failed', ['全部失败（已按张退款）'])
    }

    if (cfg.outputLogs) logger.success(`${USERID} 生成成功 ${successCount}/${count} 张`)

    const imageElements = allOutputs.map(src => h.image(src))
    // 引用用户触发指令的原消息
    try {
      await session.send(h.quote(session.messageId) + imageElements.join(''))
    } catch (e) {
      logger.warn(`发送图片失败（引用）：${e.message}`)
      await session.send(imageElements)
    }

    const reply = []
    if (count > 1) {
      reply.push(session.text('.generate-ok-batch', [count * cfg.price, successCount, seeds.join(', ') || '-']))
    } else {
      reply.push(session.text('.generate-ok', [cfg.price, seeds[0] || '-']))
    }
    if (failures.length) reply.push(session.text('.batch-partial', [successCount, count, failures.length, failures.join('；')]))
    return reply.filter(Boolean).join('\n')
  }
  // ---------------- 提示词优化券交互式确认 ----------------
  // 仅全局优化关闭 + 非管理员 + 已配置 LLM（tokenOpt 分支）时进入。
  // 返回：{ cancelled, tokenUsedCount, perImageOptimize, noOptimizeReason }
  async function couponConfirmFlow(session, USERID, tokens, count) {
    const couponPrice = await resolveCouponPrice()
    if (tokens >= count) {
      // 有券：问是否使用；拒绝/超时都取消本次生图（尚未扣 P）
      await session.send(session.text('.coupon-ask-use', [tokens, count]))
      const reply = await session.prompt(cfg.couponAskTimeout * 1000)
      const ans = normalizeConfirm(reply)
      if (ans === true) {
        try {
          await ctx.database.set('p_system', { userid: USERID }, { llmToken: Math.max(0, tokens - count) })
          await session.send(session.text('.coupon-use-confirmed', [count]))
          return { cancelled: false, tokenUsedCount: count, perImageOptimize: true, noOptimizeReason: '' }
        } catch (e) {
          logger.warn(`消耗提示词优化券失败：${e.message}`)
          return { cancelled: false, tokenUsedCount: 0, perImageOptimize: false, noOptimizeReason: 'coupon-consume-fail' }
        }
      } else if (ans === false) {
        await session.send(session.text('.coupon-use-cancelled'))
        return { cancelled: true, tokenUsedCount: 0, perImageOptimize: false, noOptimizeReason: '' }
      } else {
        await session.send(session.text('.coupon-cancelled'))
        return { cancelled: true, tokenUsedCount: 0, perImageOptimize: false, noOptimizeReason: '' }
      }
    } else {
      // 没券/券不足：问是否购买（显示价格）；拒绝一次再警告并问第二次，再拒绝直接生图
      const askBuy = async () => {
        await session.send(session.text('.coupon-ask-buy', [count, tokens, couponPrice, count * couponPrice]))
        const reply = await session.prompt(cfg.couponAskTimeout * 1000)
        return normalizeConfirm(reply)
      }
      let ans = await askBuy()
      if (ans === false) {
        await session.send(session.text('.coupon-buy-warn'))
        const reply = await session.prompt(cfg.couponAskTimeout * 1000)
        ans = normalizeConfirm(reply)
        if (ans !== true) {
          await session.send(session.text('.coupon-buy-cancelled'))
          return { cancelled: false, tokenUsedCount: 0, perImageOptimize: false, noOptimizeReason: 'coupon-declined' }
        }
        return await buyCouponsAndConsume(session, USERID, tokens, count, couponPrice)
      } else if (ans === true) {
        return await buyCouponsAndConsume(session, USERID, tokens, count, couponPrice)
      } else {
        await session.send(session.text('.coupon-cancelled'))
        return { cancelled: true, tokenUsedCount: 0, perImageOptimize: false, noOptimizeReason: '' }
      }
    }
  }

  // 购买 count 张券并用于本批：先校验余额（需覆盖券价 + 本批生成价），扣券价 P 后消耗。
  async function buyCouponsAndConsume(session, USERID, tokens, count, couponPrice) {
    const total = count * couponPrice
    const usersdata = await getPUser(USERID)
    const saving = usersdata?.p || 0
    if (saving < total + count * cfg.price) {
      // P 点不足买不起券：询问是否仍然生图（不使用 LLM 优化）
      await session.send(session.text('.coupon-buy-pshort', [total, saving]))
      const reply = await session.prompt(cfg.couponAskTimeout * 1000)
      const ans = normalizeConfirm(reply)
      if (ans === true) {
        await session.send(session.text('.coupon-buy-cancelled'))
        return { cancelled: false, tokenUsedCount: 0, perImageOptimize: false, noOptimizeReason: 'coupon-declined' }
      }
      await session.send(session.text('.coupon-use-cancelled'))
      return { cancelled: true, tokenUsedCount: 0, perImageOptimize: false, noOptimizeReason: '' }
    }
    try {
      await deductP(USERID, total)
      // 净效果：买 count 张 + 本批消耗 count 张 = llmToken 保持原值
      await ctx.database.set('p_system', { userid: USERID }, { llmToken: Math.max(0, tokens) })
      await session.send(session.text('.coupon-bought-used', [count, total]))
      return { cancelled: false, tokenUsedCount: count, perImageOptimize: true, noOptimizeReason: '' }
    } catch (e) {
      logger.warn(`购买/消耗提示词优化券失败：${e.message}`)
      await refundP(USERID, total)
      await session.send(session.text('.coupon-consume-fail'))
      return { cancelled: false, tokenUsedCount: 0, perImageOptimize: false, noOptimizeReason: 'coupon-consume-fail' }
    }
  }

  // 解析用户对确认问题的回复：true=确认 / false=拒绝 / null=未确认（超时或乱答）
  function normalizeConfirm(reply) {
    const s = String(reply || '').trim().replace(/[，。！？、,.!?\s]/g, '').toLowerCase()
    if (!s) return null
    const yes = ['是', '对', '要', '用', '买', '购买', '好', '行', '可以', '确认', '确定', '嗯', '使用', '要用', '用券', '同意', 'yes', 'y', 'ok', '1', 'true']
    const no = ['不', '否', '不要', '不用', '不买', '不购买', '算了', '取消', '不用了', '不需要', '不行', '拒绝', '不是', 'no', 'n', '0', 'false']
    if (yes.includes(s)) return true
    if (no.includes(s)) return false
    return null
  }

  // 提示词优化券单价：优先读 data/p-shop.json 里覆盖的价格，否则用配置 couponPrice
  async function resolveCouponPrice() {
    const candidates = [
      path.join(ctx.baseDir, 'data', 'p-shop.json'),
      path.join(process.cwd(), 'data', 'p-shop.json'),
    ]
    for (const f of candidates) {
      try {
        if (fs.existsSync(f)) {
          const data = JSON.parse(fs.readFileSync(f, 'utf-8'))
          if (data && typeof data === 'object') {
            const item = data['提示词优化券']
            if (item && typeof item.price === 'number' && item.price > 0) return item.price
          }
        }
      } catch (e) {
        logger.warn(`读取 p-shop.json 价格失败：${e.message}`)
      }
    }
    return cfg.couponPrice
  }

  // 启动时合并数据库里保存的运行时配置（画师组/固定角色）
  await loadRuntimeState()

  ctx.on('dispose', () => {
    // 清理临时文件
    try {
      const files = fs.readdirSync(tempDir)
      for (const file of files) {
        try { fs.unlinkSync(path.join(tempDir, file)) } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
  })

  // 暴露内部接口供自动化测试调用（Koishi 忽略 apply 返回值，不影响生产行为）
  return { couponConfirmFlow, buyCouponsAndConsume, normalizeConfirm, resolveCouponPrice, handleGenerateI2I, extractImageFromSession, uploadImageToComfyui, taggerImage, animaI2IWorkflow, animaStyleI2IWorkflow, animaOotdI2IWorkflow, buildI2IWorkflow, detectI2ICapabilities, parseDenoise }
}
