const { Schema, h } = require('koishi')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const os = require('os')
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
- **采样参数：** 描述里可写 \`--steps 40\` / \`--cfg 3.5\`（也可写 \`--步数\` / \`--强度\`）临时覆盖步数与 CFG，优先于 \`modelParams\` 与全局配置。
- **工作流预设：** 配置里可登记多套工作流 JSON，用 \`--工作流 名称：描述\` 或直接以名称/别名开头（如 \`极速：描述\`）切换；\`画图 工作流\` 可列出所有预设及是否可用。
- **原样模式：** 描述前加 \`无优化\` 直接提交写好的 tags。
- **联网搜索：** 描述中带 \`联网\` / \`搜索\` / \`查一下\` 等词时，会先联网搜索补充角色设定（需配置 Tavily Key）。
- **画师组：** \`创建画师组 名称=tags\` \`切换画师组 名称\` \`查看画师组\` \`删除画师组 名称\`
- **固定角色：** \`添加角色 名称=tags\`
 `;

const { zhCN } = require('./lib/i18n')
// 配置分组定义：组名 → 组内扁平键。
//
// 控制台里只有「嵌套 object 字段」才会渲染出折叠箭头（intersect 分支是平铺的），
// 所以这里用嵌套结构换折叠能力；运行时统一摊平成扁平 cfg，
// 并兼容老版本写在 koishi.yml 里的扁平键。
const CONFIG_GROUPS = {
  connection: ['comfyuiBaseUrl', 'timeout', 'pollInterval'],
  model: [
    'unetName', 'useGgufUnet', 'clipName', 'vaeName', 'width', 'height',
    'allowedSizes', 'steps', 'cfg', 'samplerName', 'scheduler', 'modelParams',
  ],
  prompt: [
    'qualityPrefix', 'negativePrompt', 'styleTags', 'defaultArtistTags',
    'activeArtistPreset', 'artistPresets', 'fixedCharacters',
  ],
  queue: ['queueEnabled', 'queueMaxRequests', 'batchMax'],
  pricing: ['price', 'multiPrice', 'couponPrice', 'couponAskTimeout', 'workflowConfirm', 'workflowConfirmTimeout', 'adminUsers'],
  access: ['adminOnly', 'allowedUserIds', 'blockedUserIds', 'allowedGroupIds', 'blockedGroupIds', 'outputLogs'],
  workflow: [
    'customWorkflowEnabled', 'customWorkflowPath', 'skipQualityPrefixForCustomWorkflow',
    'customWorkflowOverrideParameters', 'customWorkflowReloadOnChange',
    'workflowOverrideModel', 'modelLoaderNodeId',
    'positivePromptNodeId', 'negativePromptNodeId', 'resolutionNodeId', 'seedNodeId', 'stepsNodeId',
    'workflowPresets', 'defaultWorkflowPreset',
  ],
  llm: [
    'promptOptimizeEnabled', 'llmBaseUrl', 'llmApiKey', 'llmProxy', 'llmModel', 'llmModels',
    'llmChannels', 'llmChannelOrder', 'llmThinking', 'llmExtraBody', 'llmMaxTokens',
    'promptOptimizeTemplate',
  ],
  search: [
    'webSearchEnabled', 'tavilyApiKey', 'tavilyProxy',
    'webSearchMaxResults', 'webSearchDepth', 'webSearchQueryTemplate',
  ],
  vision: [
    'multiVerifyEnabled', 'multiVerifyPassScore', 'multiCandidateCount', 'multiSendDegradedCandidate',
    'verifyLlmBaseUrl', 'verifyLlmApiKey', 'verifyLlmProxy', 'verifyLlmModel', 'verifyLlmModels',
    'verifyLlmChannels', 'verifyLlmChannelOrder',
  ],
  legacy: ['legacyWorkflow'],
}

// 把嵌套配置摊平成扁平 cfg（就地写入，保持对象引用不变）。
// 优先级：顶层的旧扁平键 > 分组内的值。这样老 koishi.yml 直接可用，
// 而迁移到新结构后（顶层不再有同名键）就以分组值为准。
function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const known = Object.values(CONFIG_GROUPS).flat()
  const groupNames = new Set(Object.keys(CONFIG_GROUPS))
  // 名字同时是分组名时要区分：值是对象就按分组处理。
  // （历史上 legacy 分组里有个叫 workflow 的旧字段，会和 workflow 分组撞名）
  const legacy = known.filter((key) => {
    if (!Object.prototype.hasOwnProperty.call(src, key)) return false
    if (groupNames.has(key) && src[key] && typeof src[key] === 'object') return false
    return true
  })

  for (const [group, keys] of Object.entries(CONFIG_GROUPS)) {
    const node = src[group]
    if (!node || typeof node !== 'object') continue
    for (const key of keys) {
      // 顶层扁平旧键优先，不被分组值覆盖
      if (legacy.includes(key)) continue
      if (key in node) src[key] = node[key]
    }
  }
  return { config: src, legacy }
}

// 控制台里每个分组是一个「可折叠小节」：嵌套 object 字段天生带折叠箭头，默认展开。
exports.Config = Schema.object({
  connection: Schema.object({
    comfyuiBaseUrl: Schema.string().default('http://127.0.0.1:8188').description('ComfyUI 地址'),
    timeout: Schema.number().default(300).description('单次生成超时（秒）'),
    pollInterval: Schema.number().default(2).description('生成状态查询间隔（秒）'),
  }).description('① ComfyUI 连接'),

  model: Schema.object({
    unetName: Schema.string().default('anima-aesthetic-v1.1.safetensors').description('主模型文件名，需与 ComfyUI models/diffusion_models 下的文件名完全一致；8G 显存可填 .gguf 版（插件自动改用 UnetLoaderGGUF）'),
    useGgufUnet: Schema.union([
      Schema.const('auto').description('按文件名自动判断（.gguf → UnetLoaderGGUF）'),
      Schema.const('true').description('强制 UnetLoaderGGUF（需安装 ComfyUI-GGUF）'),
      Schema.const('false').description('强制原生 UNETLoader'),
    ]).default('auto').description('主模型加载方式'),
    clipName: Schema.string().default('qwen_3_06b_base.safetensors').description('文本编码器文件名（ComfyUI models/text_encoders）'),
    vaeName: Schema.string().default('qwen_image_vae.safetensors').description('VAE 文件名（ComfyUI models/vae）'),
    width: Schema.number().default(832).description('默认宽度'),
    height: Schema.number().default(1216).description('默认高度'),
    allowedSizes: Schema.array(Schema.string()).default(['832x1216', '896x1152', '1024x1024', '1152x896', '1216x832', '768x1344', '1344x768', '1024x1536']).description('可用尺寸列表（宽x高）'),
    steps: Schema.number().default(30).description('采样步数'),
    cfg: Schema.number().default(4.0).description('CFG 强度（Aesthetic 1.1 推荐 4，用 3 也常更好）'),
    samplerName: Schema.string().default('er_sde').description('采样器'),
    scheduler: Schema.string().default('simple').description('调度器'),
    modelParams: Schema.dict(Schema.object({
      samplerName: Schema.string().description('采样器'),
      scheduler: Schema.string().description('调度器'),
      steps: Schema.number().description('采样步数'),
      cfg: Schema.number().description('CFG 强度'),
      width: Schema.number().description('默认宽度'),
      height: Schema.number().description('默认高度'),
    }).description('该模型的参数覆盖')).default({}).description('按模型覆盖参数：key=模型文件名，value 只填要覆盖的字段。显式写了的字段会覆盖工作流内取值'),
  }).description('② 模型与采样参数').collapse(),

  prompt: Schema.object({
    qualityPrefix: Schema.string().default('').description('质量词前缀（Aesthetic 1.1 建议留空；Base 模型可填 masterpiece, best quality, score_7）'),
    negativePrompt: Schema.string().default('worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts').description('负面提示词。推荐值就是当前默认值：worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts（Aesthetic 1.1 适用）。若用 Base 模型，可再加 score_4, score_5, score_6'),
    styleTags: Schema.string().default('').description('画风 tags'),
    defaultArtistTags: Schema.string().default('').description('备用画师 tags'),
    activeArtistPreset: Schema.string().default('').description('启用的画师组名称'),
    artistPresets: Schema.array(Schema.string()).default([]).description('画师组（格式：名称=tags）'),
    fixedCharacters: Schema.array(Schema.string()).default([]).description('固定角色（格式：角色名=tags；仅兼容旧配置，运行时以数据库为准）'),
  }).description('③ 提示词与画师').collapse(),

  queue: Schema.object({
    queueEnabled: Schema.boolean().default(true).description('启用生成队列（逐张顺序执行）'),
    queueMaxRequests: Schema.number().default(5).description('队列最大任务数（0 表示不限制）'),
    batchMax: Schema.number().default(4).description('单次指令最多生成的张数'),
  }).description('④ 队列与批量').collapse(),

  pricing: Schema.object({
    price: Schema.number().default(500).description('一张图消耗的 P 点'),
    multiPrice: Schema.number().default(900).description('多人指令单张消耗的 P 点'),
    couponPrice: Schema.number().default(3000).description('提示词优化券单价（可被 data/p-shop.json 覆盖）'),
    couponAskTimeout: Schema.number().default(60).description('优化券确认等待时间（秒）'),
  workflowConfirm: Schema.boolean().default(true).description('画图前先报点数明细并等用户确认（默认开）'),
  workflowConfirmTimeout: Schema.number().default(60).description('点数确认的等待时间（秒）'),
    adminUsers: Schema.array(Schema.string()).default([]).description('免 P 点管理员用户 ID'),
  }).description('⑤ P 点与优化券').collapse(),

  access: Schema.object({
    adminOnly: Schema.boolean().default(false).description('仅管理员可用'),
    allowedUserIds: Schema.array(Schema.string()).default([]).description('用户白名单（留空不限制）'),
    blockedUserIds: Schema.array(Schema.string()).default([]).description('用户黑名单（优先于白名单）'),
    allowedGroupIds: Schema.array(Schema.string()).default([]).description('群白名单（留空不限制）'),
    blockedGroupIds: Schema.array(Schema.string()).default([]).description('群黑名单（优先于白名单）'),
    outputLogs: Schema.boolean().default(true).description('输出详细日志'),
  }).description('⑥ 权限与日志').collapse(),

  workflow: Schema.object({
    customWorkflowEnabled: Schema.boolean().default(false).description('使用自定义 ComfyUI 工作流 JSON'),
    customWorkflowPath: Schema.string().default('').description('工作流 JSON 路径（相对 Koishi 运行目录，如 data/p-draw/workflows/anima-aesthetic-v1.1.json）'),
    skipQualityPrefixForCustomWorkflow: Schema.boolean().default(true).description('启用自定义工作流时跳过质量前缀注入'),
    customWorkflowOverrideParameters: Schema.boolean().default(false).description('用插件参数覆盖工作流内的采样参数'),
    customWorkflowReloadOnChange: Schema.boolean().default(true).description('工作流文件变化时自动重载（无需重启）'),
    workflowOverrideModel: Schema.boolean().default(true).description('用 unetName 覆盖自定义工作流里的模型文件名（让 `p-draw 模型` 切换对预设也生效）'),
    modelLoaderNodeId: Schema.string().default('').description('指定覆盖哪个模型加载节点 ID（留空：工作流里只有一个模型加载节点时自动覆盖；有多个时跳过不猜）'),
    positivePromptNodeId: Schema.string().default('').description('正面提示词节点 ID（留空自动识别；示例 6，以实际 JSON 为准）'),
    negativePromptNodeId: Schema.string().default('').description('负面提示词节点 ID（留空自动识别；示例 7）'),
    resolutionNodeId: Schema.string().default('').description('尺寸节点 ID（留空自动识别）'),
    seedNodeId: Schema.string().default('').description('种子节点 ID（KSampler，可留空；示例 3）'),
    stepsNodeId: Schema.string().default('').description('步数节点 ID（KSampler，可留空；示例 3）'),
    workflowPresets: Schema.dict(Schema.object({
      path: Schema.string().description('工作流 JSON 路径（相对 Koishi 运行目录）'),
      aliases: Schema.array(Schema.string()).description('指令别名，例如 ["极速","fast"]'),
      positivePromptNodeId: Schema.string().description('正面提示词节点 ID（留空自动识别）'),
      negativePromptNodeId: Schema.string().description('负面提示词节点 ID（留空自动识别）'),
      resolutionNodeId: Schema.string().description('尺寸节点 ID（留空自动识别）'),
      seedNodeId: Schema.string().description('种子节点 ID（留空自动识别）'),
      stepsNodeId: Schema.string().description('步数节点 ID（留空自动识别）'),
      steps: Schema.number().description('该预设固定步数（如极速流 4）'),
      cfg: Schema.number().description('该预设固定 CFG'),
      samplerName: Schema.string().description('该预设固定采样器'),
      scheduler: Schema.string().description('该预设固定调度器'),
      overrideParameters: Schema.boolean().description('用上面的参数覆盖工作流内取值'),
      denoise: Schema.number().description('图生图的重绘幅度 0–1（1=整张重绘）。只对需要图片输入的工作流有意义'),
      imageNodeId: Schema.string().description('图片输入节点 ID（LoadImage）。留空则自动使用工作流里的图片节点'),
      price: Schema.number().description('该预设每张消耗的 P 点（留空沿用全局 price / multiPrice）'),
      warning: Schema.string().description('该预设被使用时报给用户的提醒（留空不提醒），例如换背景类的能力边界说明'),
      overrideModel: Schema.boolean().description('是否把 unetName 写进这个工作流的模型节点（留空沿用全局）'),
      modelLoaderNodeId: Schema.string().description('该预设的模型加载节点 ID（留空沿用全局）'),
    }).description('预设')).default({}).description('工作流预设：key=预设名。指令里用 `--工作流 <名称>` 或名称/别名开头选择（如 `画图 极速：1girl`）'),
    defaultWorkflowPreset: Schema.string().default('').description('默认预设名（留空则用上面的 customWorkflow* 那套）'),
  }).description('⑦ 自定义工作流').collapse(),

  llm: Schema.object({
    promptOptimizeEnabled: Schema.boolean().default(false).description('启用自然语言优化（需配置下面的 LLM 接口）'),
    llmBaseUrl: Schema.string().default('').description('LLM 接口地址（OpenAI 兼容，如 https://api.deepseek.com/v1）'),
    llmApiKey: Schema.string().role('secret').default('').description('LLM API Key'),
    llmProxy: Schema.string().default('').description('仅 LLM 使用代理（留空直连）。格式 http://127.0.0.1:7890 / socks5://127.0.0.1:7891，可省略 http://；通道内单独填了 proxy 则优先用通道的'),
    llmModel: Schema.string().default('').description('LLM 模型名（旧版单模型；请在 llmModels 里配置，这里留空即可）'),
    llmModels: Schema.array(Schema.string()).default([]).description('主通道的模型名列表，按顺序逐个尝试（如 ["deepseek-chat","gpt-4o-mini"]）'),
    llmChannels: Schema.dict(Schema.object({
      baseUrl: Schema.string().description('接口地址（OpenAI 兼容）'),
      apiKey: Schema.string().role('secret').description('API Key'),
      models: Schema.array(Schema.string()).description('该通道的模型名列表，按顺序尝试'),
      proxy: Schema.string().description('该通道专用代理（留空则用上面的 llmProxy）'),
    }).description('通道')).default({}).description('附加通道（中转站/备用站）：主通道全部模型都失败后，按顺序继续尝试这些通道'),
    llmChannelOrder: Schema.array(Schema.string()).default([]).description('附加通道的尝试顺序（填通道名；留空则按配置里的先后顺序）'),
    llmThinking: Schema.union([
      Schema.const('auto').description('仅 DeepSeek 系接口发送 thinking（推荐）'),
      Schema.const('always').description('总是发送 thinking'),
      Schema.const('never').description('从不发送 thinking（部分中转站必须选这个）'),
    ]).default('auto').description('是否发送 DeepSeek 专有的 thinking 字段；非 DeepSeek 模型带了通常会被拒'),
    llmExtraBody: Schema.string().role('textarea').default('{}').description('附加请求体 JSON（最后覆盖），用于中转站私有参数，如 {"enable_thinking":false}'),
    llmMaxTokens: Schema.number().default(1000).description('LLM 输出上限'),
    promptOptimizeTemplate: Schema.string().description('优化模板（支持 {theme} {search_block} {character_rule} 占位符）').default('你是为 Anima 图像生成模型编写正面提示词的 AI 画师。\n\n请根据用户的原始要求设计一幅完整、协调、具有视觉吸引力的画面，并将结果输出为英文 Danbooru-style tags。\n\n输出要求：\n- 只输出一行英文 tags，使用英文逗号分隔。\n- 不要输出解释、分析、标题、编号、Markdown、代码块或中文。\n- 不要输出 masterpiece、best quality、score 等质量前缀。\n- 不要输出画师 tags；质量词和画师组会由程序另行拼接。\n- 尽量使用模型容易理解的可见画面描述。\n- 保持用户明确指定的角色、主体、人数、关键服装、动作、表情和道具。\n- 除上述明确要求外，可以自由决定服装细节、姿态、构图、镜头、背景、环境、光影、色彩、氛围、前景和特效。\n- 以最终图像协调、精致、有表现力和好看为优先，不需要机械追求固定 Tag 数量。\n- 不要为了数量重复同义词；画面已经完整时即可停止。\n- 请自行解决明显冲突，直接输出你认为最适合生成最终画面的版本。\n\n角色和动态上下文：\n{character_rule}\n{search_block}\n\n用户原始要求：\n{theme}'),
  }).description('⑧ 提示词优化 / LLM').collapse(),

  search: Schema.object({
    webSearchEnabled: Schema.boolean().default(false).description('启用联网搜索（指令里写「联网/搜索/查一下」触发）'),
    tavilyApiKey: Schema.string().role('secret').default('').description('Tavily API Key（https://tavily.com）'),
    tavilyProxy: Schema.string().default('').description('仅联网搜索（Tavily）使用代理（留空直连）。与 LLM / 视觉校验的代理互相独立'),
    webSearchMaxResults: Schema.number().default(5).description('搜索结果数量'),
    webSearchDepth: Schema.string().default('basic').description('搜索深度（basic / advanced）'),
    webSearchQueryTemplate: Schema.string().default('{prompt} 角色 外观 立绘 服装 配色 武器 官方图 official art character design outfit appearance wiki fandom').description('搜索词模板（{prompt} 代表用户需求）'),
  }).description('⑨ 联网搜索').collapse(),

  vision: Schema.object({
    multiVerifyEnabled: Schema.boolean().default(true).description('多人图生成后启用视觉校验'),
    multiVerifyPassScore: Schema.number().default(6).description('校验合格分数（0-10）'),
    multiCandidateCount: Schema.number().default(2).description('候选采样数量（最多重试 候选数-1 次）'),
    multiSendDegradedCandidate: Schema.boolean().default(true).description('全部候选不达标时仍发送最优候选'),
    verifyLlmBaseUrl: Schema.string().default('').description('视觉校验接口地址（OpenAI 兼容；留空跳过校验）'),
    verifyLlmApiKey: Schema.string().role('secret').default('').description('视觉校验 API Key'),
    verifyLlmProxy: Schema.string().default('').description('仅视觉校验使用代理（留空直连）。通道内单独填了 proxy 则优先用通道的'),
    verifyLlmModel: Schema.string().default('').description('视觉校验模型名（旧版单模型；请在 verifyLlmModels 里配置）'),
    verifyLlmModels: Schema.array(Schema.string()).default([]).description('视觉通道的模型名列表，按顺序逐个尝试（需支持图片输入，如 qwen-vl）'),
    verifyLlmChannels: Schema.dict(Schema.object({
      baseUrl: Schema.string().description('接口地址（OpenAI 兼容）'),
      apiKey: Schema.string().role('secret').description('API Key'),
      models: Schema.array(Schema.string()).description('该通道的模型名列表，按顺序尝试'),
      proxy: Schema.string().description('该通道专用代理（留空则用上面的 verifyLlmProxy）'),
    }).description('通道')).default({}).description('视觉校验的附加通道：主通道全部失败后按顺序继续尝试'),
    verifyLlmChannelOrder: Schema.array(Schema.string()).default([]).description('视觉附加通道的尝试顺序（填通道名；留空则按配置先后顺序）'),
  }).description('⑩ 多人视觉校验').collapse(),

  legacy: Schema.object({
    legacyWorkflow: Schema.string().default('anima_t2i').description('旧版工作流标识，仅用于状态/诊断显示，内置工作流固定 anima_t2i（原键名 workflow 与工作流分组撞名，已改名）'),
  }).description('⑪ 兼容项（旧版，可忽略）').collapse(),
})

// ------------------------------------------------------------------
// 纯函数库已拆分到 lib/（解析 / tag 清洗 / 工作流 / Comfy 等待 / 多人规划 / HTTP 客户端）
// ------------------------------------------------------------------
const {
  normalizeBaseUrl, escapeRe, parseGenerationSize, parseBatchCount, parseSeed, parseStepsCfg, parseWorkflowPreset,
  stripRawPrefix, splitPositiveNegativePrompt, parseNameTags, parsePresetList, mergeTagText,
} = require('./lib/parse')
const {
  splitTags, joinPromptParts, mergeNegativePrompts, cleanContentTags, appendInlineProtectedTags,
  NO_ARTIST_RE, NO_STYLE_RE,
} = require('./lib/tags')
const {
  buildWorkflow, inspectCustomWorkflow, isGgufUnet, inspectWorkflowFile,
} = require('./lib/workflows')
const { outputImages, waitComfyResult } = require('./lib/comfy')
const { materializeImageSource } = require('./lib/media')
const {
  MULTI_PERSON_NEGATIVE_TAGS, buildMultiPersonPlanPrompt, parseMultiPersonPlan,
  renderMultiPersonCharacter, multiPersonAutoSize,
} = require('./lib/multi')
const { fileURLToPath } = require('url')
const { buildComfyClient } = require('./lib/http')
const { createOutboundFetch, normalizeProxyUrl, proxySupportAvailable } = require('./lib/net')
const { buildLlmChain, hasLlm, buildChatBody, runLlmChain } = require('./lib/llm')
const { uploadImageToComfy, decodeDataUrl, guessContentType } = require('./lib/image')
exports.apply = async function apply(ctx, rawConfig) {
  // 配置统一摊平成扁平 cfg：同时接受新的分组写法和老版本的扁平写法
  const { config: cfg, legacy } = normalizeConfig(rawConfig)

  const logger = ctx.logger('p-draw')
  ctx.i18n.define('zh-CN', zhCN)
  if (legacy.length) {
    logger.warn(`[p-draw] koishi.yml 里仍有扁平旧配置键（${legacy.slice(0, 6).join('、')}${legacy.length > 6 ? ' 等' : ''}），本次已按它们生效；建议迁移到分组结构后删掉旧键，否则控制台里改同名项不会生效。`)
  }

  // 出站请求：代理按用途各自传入（联网搜索 / 文本 LLM / 视觉校验互不影响）
  const outboundFetch = createOutboundFetch({
    onWarn: (message) => logger.warn(message),
  })

  // 注意：不在此处 extend p_system 表 —— 该表由 p-qiandao 等 p 系插件创建。
  // 重复声明同一张表可能导致 Koishi 的 schema 迁移冲突，拖垮签到插件。

  // 运行时数据持久化到数据库，而不是调用 scope.update  // 写 koishi.yml：scope.update 会触发插件重载，导致正在生成的图被 dispose（Context has
  // been disposed），且重复写入时配置文件会被冲掉（曾出现配置整体恢复成默认）。
  try {
    ctx.model.extend('p_draw_config', {
      id: 'unsigned',
      fixed_characters: 'json',
      fixed_characters_migrated: 'boolean',
      artist_presets: 'json',
      active_artist_preset: 'text',
      default_artist_tags: 'text',
      user_models: 'json',
    }, { autoInc: true })
  } catch (e) {
    logger.warn(`p_draw_config 表初始化失败：${e.message}`)
  }

  try {
    ctx.model.extend('p_draw_fixed_characters', {
      id: 'unsigned',
      name: 'string',
      tags: 'text',
    }, { autoInc: true, unique: ['name'] })
  } catch (e) {
    logger.warn(`p_draw_fixed_characters 表初始化失败：${e.message}`)
  }

  // 用户自选模型偏好（userid -> unet 文件名），持久化在 p_draw_config.user_models
  if (!cfg.userModels || typeof cfg.userModels !== 'object') cfg.userModels = {}

  // 启动时清理上次运行遗留的临时目录（先清理，再创建本次目录）。
  // 目录名带 PID：只清理「进程已退出」的目录，避免并行实例把自己的活跃临时目录删掉
  // （旧版无 PID 后缀的 pdraw-* 视为历史遗留，直接清理）。
  function cleanupStaleTempDirs() {
    try {
      for (const name of fs.readdirSync(os.tmpdir())) {
        if (!name.startsWith('pdraw-')) continue
        const owned = name.match(/^pdraw-(\d+)-/)
        if (owned) {
          const pid = parseInt(owned[1], 10)
          if (pid === process.pid) continue
          try {
            process.kill(pid, 0)
            continue // 进程仍存活，跳过
          } catch (e) { /* 进程已退出，可清理 */ }
        }
        const dir = path.join(os.tmpdir(), name)
        try {
          for (const file of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, file))
          fs.rmdirSync(dir)
        } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
  }

  cleanupStaleTempDirs()

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pdraw-${process.pid}-`))

  // 自定义工作流目录（Design.md A7：工作流文件由用户从 ComfyUI 导出后放入 data/p-draw/workflows/）
  const workflowDir = path.join(ctx.baseDir || process.cwd(), 'data', 'p-draw', 'workflows')
  try {
    fs.mkdirSync(workflowDir, { recursive: true })
  } catch (e) {
    logger.warn(`创建自定义工作流目录失败（${workflowDir}）：${e.message}`)
  }

  // 自定义工作流路径一律相对 Koishi 运行目录解析（见 lib/workflows.js）
  const workflowOpts = () => ({
    baseDir: ctx.baseDir || process.cwd(),
    overrideModel: cfg.workflowOverrideModel !== false,
    modelLoaderNodeId: cfg.modelLoaderNodeId || '',
  })

  // ---------------- 工作流预设 ----------------
  // 预设 = 一个 JSON 路径 + 可选的节点 ID / 采样参数覆盖，指令里按名字选用。
  function presetList() {
    const dict = cfg.workflowPresets
    if (!dict || typeof dict !== 'object') return []
    return Object.entries(dict)
      .filter(([, value]) => value && typeof value === 'object')
      .map(([name, value]) => ({ name, aliases: value.aliases || [], ...value }))
  }

  function findPreset(name) {
    if (!name) return null
    return presetList().find(preset => preset.name === name) || null
  }

  // 预设 → 生成用的配置补丁（工作流路径 + 节点 ID + 参数）
  function presetCfgPatch(preset) {
    if (!preset) return {}
    const patch = {
      customWorkflowEnabled: true,
      customWorkflowPath: preset.path || '',
      positivePromptNodeId: preset.positivePromptNodeId || '',
      negativePromptNodeId: preset.negativePromptNodeId || '',
      resolutionNodeId: preset.resolutionNodeId || '',
      seedNodeId: preset.seedNodeId || '',
      stepsNodeId: preset.stepsNodeId || '',
      customWorkflowOverrideParameters: preset.overrideParameters != null
        ? Boolean(preset.overrideParameters)
        : Boolean(cfg.customWorkflowOverrideParameters),
    }
    if (preset.overrideModel !== undefined && preset.overrideModel !== null) {
      patch.workflowOverrideModel = Boolean(preset.overrideModel)
    }
    if (preset.modelLoaderNodeId) patch.modelLoaderNodeId = String(preset.modelLoaderNodeId)
    return patch
  }

  // 预设里显式写死的参数，优先级高于 modelParams
  function presetParams(preset) {
    if (!preset) return {}
    const out = {}
    for (const key of ['steps', 'cfg', 'samplerName', 'scheduler', 'width', 'height']) {
      if (preset[key] === undefined || preset[key] === null || preset[key] === '') continue
      out[key] = key === 'samplerName' || key === 'scheduler' ? String(preset[key]).trim() : Number(preset[key])
    }
    return out
  }

  // 预设可以单独定价；没配就回落到全局 price / multiPrice
  function presetPrice(preset) {
    if (!preset || preset.price === undefined || preset.price === null || preset.price === '') return null
    const value = Number(preset.price)
    return Number.isFinite(value) && value >= 0 ? value : null
  }

  // 体检：这个预设现在能不能真的跑（能否从纯文本启动）
  function inspectPreset(preset) {    return inspectWorkflowFile(preset.path, {
      positivePromptNodeId: preset.positivePromptNodeId || '',
      negativePromptNodeId: preset.negativePromptNodeId || '',
      resolutionNodeId: preset.resolutionNodeId || '',
      seedNodeId: preset.seedNodeId || '',
      stepsNodeId: preset.stepsNodeId || '',
      customWorkflowReloadOnChange: cfg.customWorkflowReloadOnChange,
    }, workflowOpts())
  }

  // 指令里选了预设时先体检，不可用就给出人话原因
  function checkPresetUsable(name) {
    const preset = findPreset(name)
    if (!preset) return { ok: false, message: `没有名为「${name}」的工作流预设。可用：${presetList().map(p => p.name).join('、') || '（未配置）'}` }
    if (!String(preset.path || '').trim()) return { ok: false, message: `预设「${name}」没有填写 path。` }
    const report = inspectPreset(preset)
    if (!report.ok) return { ok: false, message: `预设「${name}」当前不可用：${report.error}` }
    return { ok: true, preset }
  }

  // ---------------- 图生图：从消息取图 → 下载 → 上传到 ComfyUI ----------------

  // 消息里带的图片地址（http / file / base64 / data: 都可能有）
  // 图片元素的 src 在不同适配器里落点不一样：src / url / file 都见过
  function imageElementSrc(element) {
    const attrs = (element && element.attrs) || {}
    const src = attrs.src || attrs.url || attrs.file || attrs.path
    if (src) return String(src)
    // 兜底：某些适配器把地址放在 data 里
    if (element && typeof element.data === 'string' && /^(https?:|base64:|data:|file:)/i.test(element.data)) return element.data
    return ''
  }

  // 从消息里收集图片地址。支持：
  // 1) 同一条消息里的图片（图 + 文字一起发）
  // 2) 引用的消息里的图片（回复一张图再发指令）
  // 3) 适配器把消息给成字符串时，从 CQ 码 / 裸链接里捞
  function messageImageSources(session) {
    const sources = []
    const seen = new Set()
    const push = (value) => {
      const text = String(value || '').trim()
      if (!text || seen.has(text)) return
      seen.add(text)
      sources.push(text)
    }

    const collect = (message) => {
      if (!message) return
      if (typeof message === 'string') {
        // CQ 码：CQ:image,file=xxx / CQ:image,url=xxx
        for (const m of message.matchAll(/\[CQ:image,[^\]]*?(?:file|url)=([^,\]]+)/gi)) push(m[1])
        // 裸链接
        for (const m of message.matchAll(/https?:\/\/[^\s"'<>]+\.(?:png|jpe?g|webp|gif|bmp)/gi)) push(m[0])
        return
      }
      if (Array.isArray(message)) {
        for (const element of message) {
          if (!element || typeof element !== 'object') continue
          const type = String(element.type || '').toLowerCase()
          if (type === 'img' || type === 'image') {
            push(imageElementSrc(element))
          } else if (type === 'quote' || type === 'reply') {
            // 引用的消息可能还带自己的 elements
            collect(element.attrs && element.attrs.elements)
            collect(element.data && element.data.elements)
          }
        }
      }
    }

    try {
      collect(session?.event?.message)
      // 引用场景：部分适配器把被引用消息放在 event.quote / session.quote
      collect(session?.event?.quote && session.event.quote.elements)
      collect(session?.quote && session.quote.elements)
    } catch (e) { /* ignore */ }
    return sources
  }

  // 消息里都有哪些元素类型（图片没识别出来时用来解释原因）
  function messageElementTypes(session) {
    const types = []
    try {
      const message = session?.event?.message
      if (typeof message === 'string') return ['text(原始字符串)']
      if (Array.isArray(message)) {
        for (const element of message) {
          const type = String((element && element.type) || '?').toLowerCase()
          if (!types.includes(type)) types.push(type)
        }
      }
    } catch (e) { /* ignore */ }
    return types
  }

  async function fetchImageBuffer(src) {
    const text = String(src || '')
    const dataUrl = decodeDataUrl(text)
    if (dataUrl) return dataUrl
    if (/^base64:\/\//i.test(text)) {
      const decoded = decodeDataUrl('data:image/png;base64,' + text.slice('base64://'.length))
      if (decoded) return decoded
      throw new Error('base64 图片解码失败')
    }
    if (/^file:\/\//i.test(text)) {
      const filePath = fileURLToPath(text)
      return { buffer: await fsp.readFile(filePath), contentType: guessContentType(filePath) }
    }
    if (/^https?:\/\//i.test(text)) {
      const res = await outboundFetch(text, {})
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buffer = Buffer.from(await res.arrayBuffer())
      const headerType = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-type') : ''
      return { buffer, contentType: headerType || guessContentType(text) }
    }
    throw new Error('不支持的图片来源')
  }

  // 判断当前要用的工作流是否吃图片，并把消息里的图准备好
  async function prepareImageInputs(session, preset) {
    let needsImage = false
    try {
      if (preset) {
        needsImage = Boolean(inspectPreset(preset)?.analysis?.imageInputClasses?.length)
      } else if (cfg.customWorkflowEnabled && cfg.customWorkflowPath) {
        const report = inspectWorkflowFile(cfg.customWorkflowPath, cfg, workflowOpts())
        needsImage = Boolean(report?.analysis?.imageInputClasses?.length)
      }
    } catch (e) { /* 读不到就当不需要 */ }

    if (!needsImage) return { ok: true, files: [], needsImage: false }

    const sources = messageImageSources(session)
    if (!sources.length) {
      const types = messageElementTypes(session)
      const seen = types.length ? `\n（这条消息里识别到的元素：${types.join('、')}）` : ''
      return {
        ok: false,
        needsImage: true,
        message: '这个工作流需要图片输入：把参考图和指令放在同一条消息里发，或者**回复**一张图再发指令。' + seen,
      }
    }

    const files = []
    for (const src of sources) {
      try {
        const { buffer, contentType } = await fetchImageBuffer(src)
        files.push(await uploadImageToComfy(outboundFetch, baseUrl(), { buffer, contentType }))
      } catch (e) {
        return { ok: false, needsImage: true, message: `图片处理失败：${e.message}` }
      }
    }
    if (cfg.outputLogs) logger.info(`[p-draw] 已上传 ${files.length} 张参考图：${files.join(', ')}`)
    return { ok: true, files, needsImage: true }
  }

  // A4：自定义工作流（Aesthetic 1.1）默认跳过质量前缀注入
  function shouldSkipQualityPrefix() {
    return Boolean(cfg.customWorkflowEnabled && cfg.skipQualityPrefixForCustomWorkflow)
  }

  // A7：自定义工作流启用且质量前缀非空时，提示用户质量标签可能不适用于 Aesthetic 模型
  function qualityPrefixWarning() {
    if (!cfg.customWorkflowEnabled) return ''
    if (!String(cfg.qualityPrefix || '').trim()) return ''
    return shouldSkipQualityPrefix()
      ? '检测到自定义工作流已启用，已自动跳过质量前缀注入；qualityPrefix 对 Aesthetic 模型不生效，建议手动置空。'
      : '检测到自定义工作流已启用，qualityPrefix 可能不适用于 Aesthetic 模型，建议手动置空（或开启 skipQualityPrefixForCustomWorkflow）。'
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

  // ComfyUI HTTP 客户端（统一超时与错误详情提取，见 lib/http.js）
  const { get: comfyGet, post: comfyPost, getBytes: comfyGetBytes } = buildComfyClient({ getBaseUrl: baseUrl })

  // ---------------- 状态 ----------------
  let objectInfoCache = null
  let objectInfoCacheAt = 0
  let objectInfoInFlight = null

  // /object_info 可能返回体巨大或接口本身很慢（自定义节点多），
  // 用短超时 + 10 分钟缓存，避免每次状态检查都干等。
  // 并发请求共用同一个 in-flight promise，避免同一时刻重复请求 /object_info。
  async function getObjectInfoCached() {
    if (objectInfoCache && Date.now() - objectInfoCacheAt < 10 * 60 * 1000) {
      return objectInfoCache
    }
    if (objectInfoInFlight) return objectInfoInFlight
    objectInfoInFlight = comfyGet('/object_info', 5000)
      .then((data) => {
        objectInfoCache = data
        objectInfoCacheAt = Date.now()
        return data
      })
      .finally(() => { objectInfoInFlight = null })
    return objectInfoInFlight
  }

  async function statusPayload() {
    const sizes = parseAllowedSizes()
    const payload = {
      ok: true,
      base_url: baseUrl(),
      workflow: cfg.legacyWorkflow,
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
      // 主模型列表按实际使用的 loader 读取：GGUF 走 UnetLoaderGGUF，其余走 UNETLoader
      const gguf = isGgufUnet(cfg)
      const unetNode = gguf ? 'UnetLoaderGGUF' : 'UNETLoader'
      const unetList = availableModels(objectInfo, unetNode, 'unet_name')
      const clipList = availableModels(objectInfo, 'CLIPLoader', 'clip_name')
      const vaeList = availableModels(objectInfo, 'VAELoader', 'vae_name')
      payload.unet_loader = unetNode
      payload.unet_loader_available = Boolean(objectInfo[unetNode])
      payload.unet_available = unetList.includes(cfg.unetName)
      payload.unet_models = unetList
      payload.clip_available = clipList.includes(cfg.clipName)
      payload.vae_available = vaeList.includes(cfg.vaeName)
    } else {
      payload.unet_loader = isGgufUnet(cfg) ? 'UnetLoaderGGUF' : 'UNETLoader'
      payload.unet_loader_available = undefined
      payload.unet_available = undefined
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
      `主模型：${cfg.unetName} ${modelStatus(cfg.unetName, payload.unet_available)}（加载器 ${payload.unet_loader || (isGgufUnet(cfg) ? 'UnetLoaderGGUF' : 'UNETLoader')}）`,
      `文本编码器：${cfg.clipName} ${modelStatus(cfg.clipName, payload.clip_available)}`,
      `VAE：${cfg.vaeName} ${modelStatus(cfg.vaeName, payload.vae_available)}`,
      `可用尺寸：${payload.allowed_sizes.join('、')}`,
    ]
    if (payload.object_info_warning) {
      lines.push(`模型列表查询失败：${payload.object_info_warning}（不影响生图）`)
    }
    return lines.join('\n')
  }

  // 自定义工作流的诊断明细：来源路径 / mtime / 实际解析到的节点 ID / 定位方式
  function customWorkflowDiagLines() {
    const lines = []
    const report = inspectCustomWorkflow(cfg, workflowOpts())
    if (!report.ok && !report.path) {
      lines.push(`自定义工作流：读取失败 — ${report.error}`)
      return lines
    }
    lines.push(`自定义工作流：${report.path}`)
    if (report.mtimeMs) {
      const stamp = new Date(report.mtimeMs)
      lines.push(`工作流更新时间：${stamp.toLocaleString('zh-CN')}（${cfg.customWorkflowReloadOnChange === false ? '变更不自动重载' : '变更自动重载'}）`)
    }
    if (!report.ok) {
      lines.push(`自定义工作流：解析失败 — ${report.error}`)
      return lines
    }
    const t = report.targets
    const how = (configured, found) => (configured ? '配置指定' : (found ? '自动识别' : '自动识别（未找到）'))
    const fmt = (ids) => (ids && ids.length ? ids.map(id => `#${id}`).join('、') : '（无）')
    lines.push(`正面提示词节点：${fmt(t.positive)}（${how(cfg.positivePromptNodeId, t.positive.length)}）`)
    lines.push(`负面提示词节点：${fmt(t.negative)}（${how(cfg.negativePromptNodeId, t.negative.length)}）`)
    lines.push(`尺寸节点：${fmt(t.resolutionIds)}（${how(cfg.resolutionNodeId, t.resolutionIds.length)}）`)
    lines.push(`步数节点：${fmt(t.stepsIds)}（${how(cfg.stepsNodeId, t.stepsIds.length)}）`)
    lines.push(`种子节点：${fmt(t.seedIds)}（${how(cfg.seedNodeId, t.seedIds.length)}）`)
    lines.push(`识别的文本编码节点：${fmt(t.textNodes)}`)
    const loaders = report.modelLoaders || []
    if (loaders.length) {
      const list = loaders.map(l => `#${l.id} ${l.classType}`).join('、')
      const how = cfg.workflowOverrideModel === false
        ? '不注入（workflowOverrideModel=false，模型由 JSON 决定）'
        : loaders.length > 1
          ? (String(cfg.modelLoaderNodeId || '').trim() ? `只注入 #${cfg.modelLoaderNodeId}` : '跳过（有多个模型加载节点，可用 modelLoaderNodeId 指定）')
          : `注入 ${cfg.unetName}`
      lines.push(`模型加载节点：${list}（${how}）`)
    } else {
      lines.push('模型加载节点：（未找到可注入的 UNETLoader / CheckpointLoaderSimple）')
    }
    return lines
  }

  // 预设总览：每个预设能不能跑、需要什么（不实际生图）
  function presetOverviewText() {
    const presets = presetList()
    if (!presets.length) {
      return '还没有配置工作流预设。\n在「⑦ 自定义工作流 → workflowPresets」里添加，key 用预设名，例如：\n  workflowPresets:\n    极速4步:\n      path: data/p-draw/workflows/03-dmdx.json\n      aliases: [极速]'
    }
    const lines = ['工作流预设：']
    for (const preset of presets) {
      const report = inspectPreset(preset)
      const aliases = (preset.aliases || []).length ? `（别名：${preset.aliases.join('、')}）` : ''
      const unit = presetPrice(preset)
      const priceTag = unit != null ? `  ${unit} P/张` : '  默认价'
      const imageTag = report.needsImage ? '  🖼 需带参考图' : ''
      lines.push(`${report.ok ? '✅' : '❌'} ${preset.name}${aliases}${imageTag}${priceTag}`)
      if (report.ok) {
        const analysis = report.analysis
        const pos = report.targets.positive.map(id => `#${id}`).join('、')
        const neg = report.targets.negative.map(id => `#${id}`).join('、')
        lines.push(`    节点 ${analysis.nodeCount} 个 · 正面 ${pos} · 负面 ${neg} · 尺寸 ${report.targets.resolutionIds.map(id => `#${id}`).join('、') || '（无）'}`)
      } else {
        lines.push(`    不可用：${report.error}`)
      }
    }
    const def = String(cfg.defaultWorkflowPreset || '').trim()
    lines.push(`默认预设：${def ? `${def}${findPreset(def) ? '' : '（未找到此预设，已回落）'}` : '（未设置，使用内置/自定义工作流）'}`)
    lines.push('用法：画图 --工作流 <名称>：描述　或　画图 <别名>：描述')
    return lines.join('\n')
  }

  // 诊断里附一段预设摘要
  function presetDiagLines() {
    const presets = presetList()
    if (!presets.length) return []
    const lines = [`工作流预设（${presets.length} 个）：`]
    for (const preset of presets) {
      const report = inspectPreset(preset)
      lines.push(`  ${report.ok ? '✅' : '❌'} ${preset.name}${report.ok ? '' : ` — ${report.error}`}`)
    }
    return lines
  }

  async function diagnoseText(session) {
    const payload = await statusPayload()
    const lines = ['【p-draw 诊断】']
    lines.push(`插件版本：${require('./package.json').version || '未知'}`)
    lines.push(`ComfyUI 地址：${payload.base_url}`)
    lines.push(`工作流：${cfg.customWorkflowEnabled ? '自定义 ' + (cfg.customWorkflowPath || '(未填写路径)') : (cfg.legacyWorkflow || 'anima_t2i')}`)
    if (cfg.customWorkflowEnabled) {
      lines.push(...customWorkflowDiagLines())
    }
    lines.push(`模型：${cfg.unetName} / ${cfg.clipName} / ${cfg.vaeName}`)
    lines.push(`主模型加载器：${payload.unet_loader || (isGgufUnet(cfg) ? 'UnetLoaderGGUF' : 'UNETLoader')}`)
    lines.push(`默认尺寸：${cfg.width}x${cfg.height}，步数 ${cfg.steps}，CFG ${cfg.cfg}，采样器 ${cfg.samplerName}/${cfg.scheduler}`)
    lines.push(`质量前缀：${String(cfg.qualityPrefix || '').trim() ? '已配置' + (shouldSkipQualityPrefix() ? '（自定义工作流下已跳过）' : '') : '未配置（空）'}`)
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
      if (payload.unet_loader_available === false) {
        lines.push(`加载器提示：ComfyUI 中没有 ${payload.unet_loader} 节点，请安装 ComfyUI-GGUF 插件，或把 useGgufUnet 设为 false 使用 safetensors 模型。`)
      }
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
    // A7：自定义工作流 + 非空 qualityPrefix 的迁移提示
    const warning = qualityPrefixWarning()
    if (warning) lines.push(`⚠ ${warning}`)
    lines.push(...presetDiagLines())
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

  // ---------------- 共享辅助（三大 handler 共用骨架，去重） ----------------

  // 画师 tags 解析 + no artist 守卫（用户明确「不要画师/不要风格」时跳过）。
  // 语义：与负面词里的 artist name（去签名/水印）无关，只响应用户的显式拒绝。
  function resolveArtistTags(userPrompt, opts = {}) {
    const presets = parsePresetList(cfg.artistPresets)
    let artistTags = ''
    if (cfg.activeArtistPreset && presets[cfg.activeArtistPreset]) {
      artistTags = presets[cfg.activeArtistPreset]
    } else if (cfg.defaultArtistTags) {
      artistTags = String(cfg.defaultArtistTags).trim()
    }
    if (artistTags && !opts.skipGuard && NO_ARTIST_RE.test(String(userPrompt || ''))) return ''
    return artistTags
  }

  function resolveStyleTags(userPrompt, opts = {}) {
    if (!cfg.styleTags) return ''
    if (!opts.skipGuard && NO_STYLE_RE.test(String(userPrompt || ''))) return ''
    return String(cfg.styleTags).trim()
  }

  // P 点余额预检（单图/多人共用）
  async function precheckPoints(session, USERID, isAdmin, totalPrice) {
    if (isAdmin) return { ok: true }
    const notExists = await isAccountExists(USERID)
    if (!notExists) return { ok: false, message: session.text('.account-notExists') }
    const usersdata = await getPUser(USERID)
    const saving = usersdata?.p || 0
    if (saving < totalPrice) return { ok: false, message: session.text('.no-enough-p', [totalPrice]) }
    return { ok: true }
  }

  // 预排队整批任务：先检查队列容量再入队，杜绝「部分入队后满、退款但任务仍执行」。
  // 任一失败路径都按原逻辑退款（P 已在入队前扣除）。
  async function enqueueBatch(count, work, { USERID, isAdmin, totalPrice }) {
    const tasks = []
    let firstPosition = null
    if (!cfg.queueEnabled) return { ok: true, tasks, firstPosition }
    const maxQueue = queueMax()
    // 容量预检与入队循环之间没有 await，单线程内是原子的
    if (maxQueue && queueInFlight + queueSize + count > maxQueue) {
      if (!isAdmin) await refundP(USERID, totalPrice)
      return { ok: false, message: `生成队列已满（最多 ${maxQueue} 个），本次请求已丢弃，请稍后再试。` }
    }
    for (let i = 0; i < count; i++) {
      const q = enqueue(() => work(i))
      if (!q.ok) {
        if (!isAdmin) await refundP(USERID, totalPrice)
        return { ok: false, message: q.message }
      }
      tasks.push(q.task)
      if (firstPosition == null) firstPosition = q.position
    }
    return { ok: true, tasks, firstPosition }
  }

  // 即时反馈的公共部分。扣费提醒在生成完成后使用实际 seed 发送。
  function feedbackBase(session, { firstPosition, count }) {
    const notices = []
    if (cfg.queueEnabled) {
      notices.push(session.text('.queued', [firstPosition, cfg.queueMaxRequests || '∞']))
      if (count > 1) notices.push(session.text('.batch-count', [count]))
    } else {
      notices.push(session.text('.generating'))
      if (count > 1) notices.push(session.text('.batch-count', [count]))
    }
    return { notices }
  }

  function buildChargeNotice({ isAdmin, totalPrice, unetName, seeds }) {
    if (!seeds.length) return ''
    const modelSeed = `当前模型：${unetName}，--seed=${seeds.join(',')}`
    if (isAdmin) return modelSeed
    return `已扣除 ${totalPrice} P 点，${modelSeed}`
  }

  function buildGenerationReply(session, { successCount, count, failures, notes = [] }) {
    const reply = []
    if (notes.length) reply.push(notes.join('\n'))
    if (failures.length) reply.push(session.text('.batch-partial', [successCount, count, failures.length, failures.join('；')]))
    return reply.filter(Boolean).join('\n')
  }

  function shouldOptimizePerImage({ count, enabled, admin }) {
    return count > 1 && (enabled || admin)
  }

  async function sendNotices(session, notices, opts = {}) {
    const content = notices.filter(Boolean).join('\n')
    if (!content) return
    try {
      const quoteId = session.event?.message?.id || session.messageId
      let message = content
      if (opts.quote && quoteId) {
        const quote = session.platform === 'onebot'
          ? h('reply', { id: quoteId })
          : h.quote(quoteId)
        message = quote + content
      }
      if (cfg.outputLogs && opts.quote) logger.info(`[p-draw] 发送扣费引用通知 platform=${session.platform || 'unknown'} messageId=${quoteId || 'missing'}`)
      await session.send(message)
    } catch (e) {
      logger.warn(`发送反馈消息失败：${e.message}`)
    }
  }

  // 生成图片使用合并转发；每张图后紧跟实际使用的正负面提示词，不附原消息引用。
  async function sendImagesAsForward(session, outputs) {
    const nodes = []
    const fallback = []
    for (const output of outputs) {
      const src = typeof output === 'string' ? output : output.src
      const prompt = typeof output === 'string' ? '' : String(output.prompt || '')
      const negativePrompt = typeof output === 'string' ? '' : String(output.negativePrompt || '')
      const materialized = await materializeImageSource(src)
      const image = Buffer.isBuffer(materialized) ? h.image(materialized) : h.image(src)
      nodes.push(h('message', image))
      fallback.push(image)
      const promptText = `Positive:\n${prompt}\n\nNegative:\n${negativePrompt}`
      nodes.push(h('message', promptText))
      fallback.push(promptText)
    }
    try {
      await session.send(h('figure', nodes))
    } catch (e) {
      logger.warn(`发送转发图片失败：${e.message}`)
      await session.send(fallback)
    }
  }

  // P 点读改写按用户串行化，避免并发指令互相覆盖余额
  const userLocks = new Map()
  function withUserLock(USERID, fn) {
    const prev = userLocks.get(USERID) || Promise.resolve()
    const next = prev.then(fn, fn)
    userLocks.set(USERID, next.catch(() => {}))
    return next
  }

  // ---------------- 用户自选模型 ----------------
  // 从 ComfyUI /object_info（10 分钟缓存）读取 UNET 和 checkpoint 模型列表
  async function listUnetModels() {
    try {
      const objectInfo = await getObjectInfoCached()
      const list = [
        ...availableModels(objectInfo, 'UNETLoader', 'unet_name'),
        // GGUF 模型（ComfyUI-GGUF）同样可供用户选择
        ...availableModels(objectInfo, 'UnetLoaderGGUF', 'unet_name'),
        ...availableModels(objectInfo, 'CheckpointLoaderSimple', 'ckpt_name')
          .filter(name => String(name).trim().toLowerCase().replace(/[-_]/g, '~') === 'animagine~xl~3.1.safetensors'),
      ]
      const unique = [...new Set(list)]
      if (unique.length) return unique
    } catch (e) { /* ignore */ }
    return []
  }

  // 解析该用户当前生效的模型：有偏好且仍存在于 ComfyUI 时用偏好，否则回落默认
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
    const unetName = overrides.unet || cfg.unetName
    // 工作流预设：把路径 / 节点 ID 替换进配置，并取出预设写死的采样参数
    const preset = overrides.preset || null
    const presetExtra = presetParams(preset)
    const baseCfg = preset ? Object.assign({}, cfg, presetCfgPatch(preset)) : cfg
    // 应用该模型的独立参数覆盖（modelParams），再叠加预设参数与命令级 overrides
    const modelSpecific = resolveModelParams(unetName)
    const workCfg = Object.assign({}, baseCfg, modelSpecific, presetExtra, { unetName })
    // 预设/modelParams 里显式配置的字段要覆盖自定义工作流内的取值
    const overrideKeys = Object.assign({}, modelSpecific, presetExtra)
    const requestedWidth = (size && size[0]) || overrides.width || workCfg.width
    const requestedHeight = (size && size[1]) || overrides.height || workCfg.height
    // 防御：sampler/scheduler 配置若带尾随空格会导致 ComfyUI 报 "Value not in list"，统一 trim
    if (typeof workCfg.samplerName === 'string') workCfg.samplerName = workCfg.samplerName.trim()
    if (typeof workCfg.scheduler === 'string') workCfg.scheduler = workCfg.scheduler.trim()
    const width = Math.round(Number(requestedWidth) || workCfg.width)
    const height = Math.round(Number(requestedHeight) || workCfg.height)
    const steps = Math.round(Number(overrides.steps) || workCfg.steps)
    const cfgVal = Number(overrides.cfg) || workCfg.cfg
    const seed = Number(overrides.seed) || crypto.randomInt(1, 2 ** 32 - 1)
    const negativePrompt = joinPromptParts([overrides.negativePrompt || cfg.negativePrompt || ''])
    const promptBody = buildWorkflow(workCfg, prompt, negativePrompt, width, height, steps, cfgVal, seed, Boolean(size), Object.assign({}, workflowOpts(), {
      modelParams: overrideKeys,
      overrideModel: baseCfg.workflowOverrideModel !== false,
      modelLoaderNodeId: baseCfg.modelLoaderNodeId || '',
      images: overrides.images || [],
      denoise: overrides.denoise != null ? overrides.denoise
        : (preset && preset.denoise != null && preset.denoise !== '' ? Number(preset.denoise) : undefined),
      imageNodeId: (preset && preset.imageNodeId) || '',
    }))

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
      negativePrompt,
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
  async function fixedCharacterRows(query = {}) {
    const rows = await ctx.database.get('p_draw_fixed_characters', query)
    return rows.sort((a, b) => Number(a.id) - Number(b.id))
  }

  async function buildCharacterRule(prompt) {
    const text = String(prompt || '')
    for (const { name, tags } of await fixedCharacterRows()) {
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
      const rawRes = await outboundFetch('https://api.tavily.com/search', {
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
      }, cfg.tavilyProxy)
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

  // 统一调用 LLM：按「通道 × 模型」候选链逐个尝试，返回首个成功结果。
  // role='text' 用 llm* 配置，role='vision' 用 verifyLlm* 配置（需支持图片输入）。
  async function callLlm({ role = 'text', system, user, images, maxTokens = 700, timeout = 120000 }) {
    const chain = buildLlmChain(cfg, role)
    if (!chain.length) {
      return { ok: false, text: '', reason: 'llm_not_configured', candidate: null, errors: [] }
    }

    const messages = []
    if (system) messages.push({ role: 'system', content: system })
    if (images && images.length) {
      messages.push({
        role: 'user',
        content: [
          ...(user ? [{ type: 'text', text: user }] : []),
          ...images.map((src) => ({ type: 'image_url', image_url: { url: src } })),
        ],
      })
    } else {
      messages.push({ role: 'user', content: user })
    }

    const result = await runLlmChain(chain, async (candidate) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)
      try {
        const headers = { 'Content-Type': 'application/json' }
        if (candidate.apiKey) headers.Authorization = `Bearer ${candidate.apiKey}`
        const body = buildChatBody(cfg, { candidate, messages, maxTokens, defaultMaxTokens: maxTokens })
        // 代理按用途分开：通道自带 proxy 优先，否则用该用途的默认代理
        const purposeProxy = role === 'vision' ? cfg.verifyLlmProxy : cfg.llmProxy
        const proxy = candidate.proxy || purposeProxy || ''
        const rawRes = await outboundFetch(candidate.baseUrl + '/chat/completions', {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        }, proxy)
        if (!rawRes.ok) {
          const detail = await rawRes.text().catch(() => '')
          throw new Error(`HTTP ${rawRes.status}${detail ? ' ' + detail.slice(0, 200) : ''}`)
        }
        const res = await rawRes.json()
        const text = extractLlmText(res)
        if (!text) throw new Error('接口未返回可用的文本内容')
        return text
      } finally {
        clearTimeout(timer)
      }
    }, {
      onError: (candidate, message) => {
        if (cfg.outputLogs) logger.warn(`[p-draw] LLM 候选失败（${candidate.label} / ${candidate.model}）：${message}`)
      },
    })

    if (!result.ok) {
      const last = result.errors.length ? result.errors[result.errors.length - 1].message : 'unknown'
      return { ok: false, text: '', reason: last, candidate: null, errors: result.errors }
    }
    if (cfg.outputLogs && (chain.length > 1 || result.errors.length)) {
      logger.info(`[p-draw] LLM 命中 ${result.candidate.label} / ${result.candidate.model}（前面失败 ${result.errors.length} 个）`)
    }
    return { ok: true, text: result.value, candidate: result.candidate, errors: result.errors }
  }

  async function optimizePrompt(session, userPrompt, force = false, precomputedSearch = null) {
    if (!cfg.promptOptimizeEnabled && !force) {
      return { ok: true, prompt: userPrompt, reason: 'optimize_disabled' }
    }
    if (!hasLlm(cfg)) {
      logger.warn('提示词优化已开启但未配置任何 LLM 通道（llmBaseUrl + llmModels），跳过优化')
      return { ok: false, prompt: userPrompt, reason: 'llm_not_configured' }
    }
    let searchBlock = ''
    if (precomputedSearch != null) {
      // 批量按张优化时由调用方复用同一份搜索结果，避免重复请求 Tavily
      searchBlock = precomputedSearch
    } else if (wantsWebSearch(userPrompt)) {
      searchBlock = await webSearch(userPrompt)
    }
    const characterRule = await buildCharacterRule(userPrompt)
    const defaultTemplate = `你是为图像生成模型编写正面提示词的 AI 画师。\n\n请根据用户的原始要求设计一幅完整、协调、具有视觉吸引力的画面，并将结果输出为英文 Danbooru-style tags。\n\n输出要求：\n- 只输出一行英文 tags，使用英文逗号分隔。\n- 不要输出解释、分析、标题、编号、Markdown、代码块或中文。\n- 不要输出 masterpiece、best quality、score 等质量前缀。\n- 不要输出画师 tags；质量词和画师组会由程序另行拼接。\n- 尽量使用模型容易理解的可见画面描述。\n- 保持用户明确指定的角色、主体、人数、关键服装、动作、表情和道具。\n- 以最终图像协调、精致、有表现力和好看为优先。\n\n角色和动态上下文：\n{character_rule}\n{search_block}\n\n用户原始要求：\n{theme}`
    const template = (cfg.promptOptimizeTemplate || '').trim() || defaultTemplate
    const searchBlockText = searchBlock
      ? `联网搜索参考信息（请尽量依据这些内容补全角色外观与设定）：\n${searchBlock}`
      : ''
    const rendered = template
      .replace(/\{theme\}/g, userPrompt)
      .replace(/\{search_block\}/g, searchBlockText)
      .replace(/\{character_rule\}/g, characterRule)
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    const outcome = await callLlm({
      role: 'text',
      system: rendered,
      user: userPrompt,
      maxTokens: cfg.llmMaxTokens,
    })
    if (!outcome.ok) {
      logger.warn(`提示词优化失败（已尝试 ${outcome.errors.length} 个候选）：${outcome.reason}`)
      return { ok: false, prompt: userPrompt, reason: outcome.reason }
    }
    return { ok: true, prompt: outcome.text }
  }

  // ---------------- 提示词组装 ----------------
  // fixedOverride：undefined=按名称自动匹配固定角色；'skip'=不注入固定角色；字符串=直接使用该字符串作为固定角色 tags
  async function composePrompt(userPrompt, raw, fixedOverride) {
    if (raw) return { prompt: userPrompt, degraded: false }
    const parts = []
    if (cfg.qualityPrefix && !shouldSkipQualityPrefix()) parts.push(String(cfg.qualityPrefix).trim())
    if (fixedOverride === 'skip') {
      // 不注入固定角色 tags
    } else if (typeof fixedOverride === 'string') {
      if (String(fixedOverride).trim()) parts.push(String(fixedOverride).trim())
    } else {
      for (const { name, tags } of await fixedCharacterRows()) {
        if (name && userPrompt.includes(name)) {
          parts.push(tags)
          break
        }
      }
    }
    const artistTags = resolveArtistTags(userPrompt)
    if (artistTags) parts.push(artistTags)
    const styleTags = resolveStyleTags(userPrompt)
    if (styleTags) parts.push(styleTags)
    parts.push(userPrompt)
    return { prompt: joinPromptParts(parts), degraded: false }
  }

  // ---------------- 多人（移植自 anima /anm 多人） ----------------

  // 通用 LLM 调用：system + user，返回文本；失败抛错由调用方捕获。
  // 多人规划用的文本 LLM 调用：统一走「通道 × 模型」回退链，全部失败才抛错。
  async function llmChat({ system, user, maxTokens = 700, timeout = 120000 }) {
    const outcome = await callLlm({ role: 'text', system, user, maxTokens, timeout })
    if (!outcome.ok) {
      throw new Error(outcome.reason === 'llm_not_configured' ? '未配置任何 LLM 通道' : outcome.reason)
    }
    return outcome.text
  }

  // 多人规划：让 LLM 输出结构化场景 JSON（2-4 人）。
  async function generateMultiPersonPlan(prompt) {
    const mentioned = {}
    for (const { name, tags } of await fixedCharacterRows()) {
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
  async function buildMultiPersonFinalPrompt(plan, prompt) {
    const aliases = ['Character A', 'Character B', 'Character C', 'Character D']
    const characterCount = plan.characters.length
    const characterRoles = []
    const characterTagStream = []
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
    const configuredChars = Object.fromEntries((await fixedCharacterRows()).map(({ name, tags }) => [name, tags]))
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
      characterTagStream.push(renderMultiPersonCharacter(character, {
        alias: visualLabel,
        resolvedIdentity,
        fixedTags: fixedName ? fixedTags : '',
        groupedContact,
        explicitPositions: spatialMode === 'explicit_positions',
        identityAnchors: renderedIdentityTags,
        includePose: !groupedContact,
        asTagStream: true,
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

    const narrativeBlocks = [...displayInteractions, relativePosition].filter(Boolean)

    // 组装最终提示词：质量词 + 画师组 + 主 tag 流（含角色外观）+ narrative 块（仅互动/站位）
    const contentClean = cleanContentTags(commonContent, 65, false, [], true)
    const parts = []
    if (cfg.qualityPrefix && !shouldSkipQualityPrefix()) parts.push(String(cfg.qualityPrefix).trim())
    // 多人同样遵守 no artist 守卫（与单图一致）：用户说「不要画师」时跳过画师 tags
    const artistTags = resolveArtistTags(prompt)
    if (artistTags) parts.push(artistTags)
    const styleTags = resolveStyleTags(prompt)
    if (styleTags) parts.push(styleTags)
    parts.push(contentClean || commonContent)
    if (characterTagStream.length) parts.push(characterTagStream.join(', '))
    let finalPrompt = joinPromptParts(parts)
    if (narrativeBlocks.length) finalPrompt += '\n\n' + narrativeBlocks.join('\n\n')
    return { ok: true, prompt: finalPrompt }
  }

  // 视觉校验（anima_verify + generation_verifier 移植）：对生成的图片跑视觉 LLM，
  // 不合格则用相同提示词重试（最多 multiCandidateCount 张），按多候选规则挑选并返回结果。
  async function verifyGeneratedImages(session, images, userRequest, prompt, size, planCount, unet, negativePrompt, preset = null) {
    if (!hasLlm(cfg, 'vision')) {
      return { ok: true, degraded: true, message: '', verdict: null, outputs: images, prompt, negativePrompt }
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
    let currentNegativePrompt = negativePrompt

    // 视觉校验同样走「通道 × 模型」回退链（role='vision' 用 verifyLlm* 配置）
    async function verifyOnce(imgs, userReq) {
      const outcome = await callLlm({
        role: 'vision',
        system: systemPrompt,
        user: `用户的原始画图请求（中文）：\n${userReq}\n\n请审查这张图片。`,
        images: imgs,
        maxTokens: Math.max(256, parseInt(cfg.llmMaxTokens) || 700),
      })
      if (!outcome.ok) throw new Error(outcome.reason)
      return outcome.text
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
        return { ok: true, degraded: true, message: session.text('.multi-verify-error', [String(e && e.message || e)]), verdict: null, outputs: images, prompt: currentPrompt, negativePrompt: currentNegativePrompt }
      }
      if (!data) {
        logger.warn(`多人视觉校验返回无法解析：${reply.slice(0, 200)}`)
        return { ok: true, degraded: true, message: '', verdict: null, outputs: images, prompt: currentPrompt, negativePrompt: currentNegativePrompt }
      }
      const verdict = verdictFromData(data)
      verdict.skipped = false
      candidates.push({ outputs: currentImages, verdict, prompt: currentPrompt, negativePrompt: currentNegativePrompt })
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
      const regen = await runComfyGenerate(currentPrompt, size, Object.assign({ unet, negativePrompt: currentNegativePrompt }, preset ? { preset } : {}))
      if (!regen.ok) {
        logger.warn(`多人校验重试生成失败：${regen.message}`)
        break
      }
      currentImages = regen.outputs
      currentNegativePrompt = regen.negativePrompt || currentNegativePrompt
    }

    // 多候选挑选
    const ranked = candidates.map((c, index) => ({ rank: rankCandidate(c.verdict), index, ...c }))
    const eligible = ranked.filter(c => c.rank.eligible)
    const best = (eligible.length ? eligible : ranked).sort((a, b) => b.rank.rank - a.rank.rank)[0]
    const multiAccepted = Boolean(eligible.length)
    selectedOutputs = best.outputs
    selectedVerdict = best.verdict
    if (!multiAccepted && !cfg.multiSendDegradedCandidate) {
      return { ok: false, discarded: true, message: session.text('.multi-verify-discarded'), verdict: selectedVerdict, outputs: [], prompt: best.prompt, negativePrompt: best.negativePrompt }
    }
    const noteParts = []
    if (multiAccepted) {
      noteParts.push(session.text('.multi-verify-passed', [selectedVerdict.score]))
    } else {
      noteParts.push(session.text('.multi-verify-degraded', selectedVerdict.issues.length ? '（' + selectedVerdict.issues.join('；').slice(0, 80) + '）' : ''))
    }
    if (retries) noteParts.push(session.text('.multi-verify-failed', [selectedVerdict.issues.length ? '：' + selectedVerdict.issues.join('；').slice(0, 80) : '', retries]))
    return { ok: true, degraded: false, message: noteParts.join('\n'), verdict: selectedVerdict, outputs: selectedOutputs, prompt: best.prompt, negativePrompt: best.negativePrompt }
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
  // runOne(i) 需返回 { ok, outputs, seed, prompt, negativePrompt, message? }；返回数组为多张输出（如视觉校验候选）。
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
        results.push({ i, ok: true, outputs, seed: item.seed, prompt: item.prompt || '', negativePrompt: item.negativePrompt || '', note: item.note || '' })
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
    let price = Math.max(0, parseInt(cfg.multiPrice) || cfg.price)
    if (cfg.outputLogs) {
      logger.info(`[p-draw] 多人请求 userId=${USERID} isAdmin=${isAdmin}`)
    }

    const allowed = parseAllowedSizes()
    const parsedSize = parseGenerationSize(rawText, allowed)
    if (parsedSize.error) return parsedSize.error

    // 批量张数解析（x3 / 3张 / --数量 3 等）
    const parsedBatch = parseBatchCount(parsedSize.prompt, cfg.batchMax)
    // 采样参数覆盖（--steps 40 / --cfg 3.5），并从描述中剥离，避免进入 LLM 规划
    const parsedTuning = parseStepsCfg(parsedBatch.prompt)
    // 工作流预设（多人生图同样支持）
    const parsedPreset = parseWorkflowPreset(parsedTuning.prompt, presetList())
    if (parsedPreset.error) return parsedPreset.error
    let activePreset = null
    if (parsedPreset.preset) {
      const usable = checkPresetUsable(parsedPreset.preset)
      if (!usable.ok) return usable.message
      activePreset = usable.preset
    } else if (String(cfg.defaultWorkflowPreset || '').trim()) {
      const usable = checkPresetUsable(String(cfg.defaultWorkflowPreset).trim())
      if (usable.ok) activePreset = usable.preset
      else if (cfg.outputLogs) logger.warn(`[p-draw] 默认预设不可用，已回落：${usable.message}`)
    }
    const presetUnitPrice = presetPrice(activePreset)
    if (presetUnitPrice != null) price = presetUnitPrice
    const text = parsedPreset.prompt
    if (!text) return session.text('.multi-usage')
    const count = parsedBatch.count
    const tuningOverrides = Object.assign(
      activePreset ? { preset: activePreset } : {},
      parsedTuning.steps != null ? { steps: parsedTuning.steps } : {},
      parsedTuning.cfg != null ? { cfg: parsedTuning.cfg } : {},
    )

    // P 点校验（按总价 = 张数 × 单价）
    const pcheck = await precheckPoints(session, USERID, isAdmin, count * price)
    if (!pcheck.ok) return pcheck.message

    // 未指定尺寸时按人数/接触关系自动选横图
    let size = parsedSize.size
    if (!size && allowed.length) {
      size = multiPersonAutoSize(text, allowed)
    }

    // ComfyUI 就绪
    const ready = await ensureComfyuiReady()
    if (!ready.ok) return ready.message

    // 多人规划（强制依赖 LLM）
    if (!hasLlm(cfg)) {
      return session.text('.multi-no-llm')
    }

    // 多人规划
    const planResult = await generateMultiPersonPlan(text)
    if (!planResult.ok) {
      return session.text('.multi-usage') + '\n（多人规划失败：' + planResult.error + '）'
    }
    const plan = planResult.plan

    // 组装最终提示词
    const built = await buildMultiPersonFinalPrompt(plan, text)
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

    // 队列：预排队全部任务（先查容量再入队，占满整体退回总价）
    const queued = await enqueueBatch(count, (i) => runComfyGenerate(finalPrompt, size, Object.assign({ negativePrompt: multiNegative, unet }, tuningOverrides)), { USERID, isAdmin, totalPrice: count * price })
    if (!queued.ok) return queued.message
    const queuedTasks = queued.tasks
    const firstPosition = queued.firstPosition

    // 即时反馈
    const notice = []
    if (parsedBatch.clamped) notice.push(session.text('.batch-limit', [count]))
    const feedback = feedbackBase(session, { firstPosition, count })
    notice.push(...feedback.notices)
    await sendNotices(session, notice)

    // 单张生成 +（可选）视觉校验
    const runOne = async (i) => {
      let result
      if (cfg.queueEnabled) {
        try { result = await queuedTasks[i] } catch (e) { result = { ok: false, message: `生成失败：${e.message}` } }
      } else {
        try { result = await runComfyGenerate(finalPrompt, size, Object.assign({ negativePrompt: multiNegative, unet }, tuningOverrides)) } catch (e) { result = { ok: false, message: `生成失败：${e.message}` } }
      }
      if (!result.ok || !result.outputs || !result.outputs.length) return result
      if (!cfg.multiVerifyEnabled) {
        return { ok: true, outputs: result.outputs, seed: result.seed, prompt: finalPrompt, negativePrompt: result.negativePrompt, note: session.text('.multi-degraded', ['（未启用校验或未配置视觉模型）']) }
      }
      const verified = await verifyGeneratedImages(session, result.outputs, text, finalPrompt, size, plan.characters.length, unet, result.negativePrompt || multiNegative, activePreset)
      if (!verified.ok) return { ok: false, message: verified.message }
      return { ok: true, outputs: verified.outputs, seed: result.seed, prompt: verified.prompt || finalPrompt, negativePrompt: verified.negativePrompt || result.negativePrompt || multiNegative, note: verified.message || '' }
    }

    const { results, successCount } = await executeBatch(USERID, isAdmin, count, price, runOne)

    // 汇总
    const allOutputs = []
    const forwardOutputs = []
    const notes = []
    const seeds = []
    const failures = []
    for (const item of results) {
      if (item.ok) {
        allOutputs.push(...item.outputs)
        forwardOutputs.push(...item.outputs.map(src => ({ src, prompt: item.prompt || finalPrompt, negativePrompt: item.negativePrompt })))
        if (item.seed != null) seeds.push(item.seed)
        if (item.note) notes.push(item.note)
      } else {
        failures.push(`第 ${item.i + 1} 张：${item.message}`)
      }
    }

    const chargeNotice = buildChargeNotice({
      isAdmin,
      totalPrice: successCount * price,
      unetName: unet,
      seeds,
    })
    if (!allOutputs.length) {
      if (cfg.outputLogs) logger.warn(`多人生成全部失败（${USERID}），已按张退款`)
      return session.text('.generate-failed', ['全部失败（已按张退款）'])
    }

    if (cfg.outputLogs) logger.success(`${USERID} 多人生成成功 ${successCount}/${count} 张`)

    // 发图：合并转发，不引用原指令
    await sendImagesAsForward(session, forwardOutputs)

    await sendNotices(session, [chargeNotice])

    return buildGenerationReply(session, { successCount, count, failures, notes })
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
    return withUserLock(USERID, async () => {
      const user = await getPUser(USERID)
      const current = user?.p || 0
      await ctx.database.set('p_system', { userid: USERID }, { p: Math.max(0, current - amount) })
      return current
    })
  }

  async function refundP(USERID, amount) {
    return withUserLock(USERID, async () => {
      const user = await getPUser(USERID)
      const current = user?.p || 0
      await ctx.database.set('p_system', { userid: USERID }, { p: current + amount })
    })
  }

  // ---------------- 画师组/角色管理（持久化到数据库，避免 scope.update 触发重载） ----------------
  // 注意：更新数据里不能带主键 id，否则数据库驱动会报 cannot modify primary key
  function runtimeState() {
    return {
      artist_presets: cfg.artistPresets || [],
      active_artist_preset: cfg.activeArtistPreset || '',
      default_artist_tags: cfg.defaultArtistTags || '',
      user_models: cfg.userModels || {},
    }
  }

  let legacyRuntimeFixedCharacters = []
  let fixedCharactersMigrated = false

  // 启动时加载 p_draw_config 中仍归属该表的运行时数据。
  // fixed_characters 只作为旧版本迁移输入，运行时不再覆盖 cfg.fixedCharacters。
  async function loadRuntimeState() {
    try {
      const rows = await ctx.database.get('p_draw_config', { id: 1 })
      const row = rows && rows[0]
      if (!row) return
      if (Array.isArray(row.fixed_characters)) legacyRuntimeFixedCharacters = row.fixed_characters
      fixedCharactersMigrated = row.fixed_characters_migrated === true
      if (Array.isArray(row.artist_presets)) cfg.artistPresets = row.artist_presets
      if (row.active_artist_preset) cfg.activeArtistPreset = row.active_artist_preset
      if (row.default_artist_tags != null) cfg.defaultArtistTags = row.default_artist_tags
      if (row.user_models && typeof row.user_models === 'object') cfg.userModels = row.user_models
      if (cfg.outputLogs) logger.info(`[p-draw] 已加载运行时配置（画师组 ${(cfg.artistPresets || []).length} 个，模型偏好 ${Object.keys(cfg.userModels || {}).length} 个）`)
    } catch (e) {
      logger.warn(`读取运行时配置失败（画师组或模型偏好可能未持久化）：${e.message}`)
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

  async function migrateFixedCharacters() {
    if (fixedCharactersMigrated) return
    const existingRows = await fixedCharacterRows()
    const existingNames = new Set(existingRows.map(row => row.name))
    const legacyEntries = [...(cfg.fixedCharacters || []), ...legacyRuntimeFixedCharacters]
    for (const entry of legacyEntries) {
      const parsed = parseNameTags(entry)
      if (!parsed || existingNames.has(parsed.name)) continue
      await ctx.database.create('p_draw_fixed_characters', {
        name: parsed.name,
        tags: parsed.tags,
      })
      existingNames.add(parsed.name)
    }
    const existingConfig = await ctx.database.get('p_draw_config', { id: 1 })
    if (existingConfig && existingConfig[0]) {
      await ctx.database.set('p_draw_config', { id: 1 }, { fixed_characters_migrated: true })
    } else {
      await ctx.database.create('p_draw_config', { id: 1, ...runtimeState(), fixed_characters_migrated: true })
    }
    fixedCharactersMigrated = true
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
      if (lower === '工作流' || lower === '预设' || lower === 'workflow' || lower === 'workflows') {
        return presetOverviewText()
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
        const tags = normalizeTagText(parsed.tags)
        const existing = (await fixedCharacterRows({ name: parsed.name }))[0]
        if (existing) await ctx.database.set('p_draw_fixed_characters', { id: existing.id }, { name: parsed.name, tags })
        else await ctx.database.create('p_draw_fixed_characters', { name: parsed.name, tags })
        if (cfg.outputLogs) logger.success(`${USERID} 添加固定角色 ${parsed.name}`)
        return session.text('.character-created', [parsed.name, parsed.tags])
      }
      if (text.match(/^(?:查看|列出|显示)\s*(?:固定)?\s*角色$|^(?:固定)?\s*角色列表$/)) {
        const rows = await fixedCharacterRows()
        if (!rows.length) return '固定角色：无'
        return ['固定角色：', ...rows.map(row => `- ${row.name}：${row.tags}`)].join('\n')
      }
      const deleteCharacter = text.match(/^(?:删除|移除)\s*(?:固定)?\s*角色\s*(.*)$/)
      if (deleteCharacter) {
        const name = String(deleteCharacter[1]).trim()
        if (!name) return session.text('.character-delete-format')
        const existing = (await fixedCharacterRows({ name }))[0]
        if (!existing) return session.text('.character-not-found', [name])
        await ctx.database.remove('p_draw_fixed_characters', { id: existing.id })
        return session.text('.character-deleted', [name])
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

  async function handleGenerate(session, rawText) {
    const USERID = session.userId
    const isAdmin = isAdminUser(session)
    const unet = await resolveUnet(USERID)
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
    // 采样参数覆盖（--steps 40 / --cfg 3.5），并从提示词中剥离
    const parsedTuning = parseStepsCfg(parsedSeed.prompt)
    // 工作流预设：--工作流 xxx 或开头裸写名称/别名
    const parsedPreset = parseWorkflowPreset(parsedTuning.prompt, presetList())
    if (parsedPreset.error) return parsedPreset.error
    let activePreset = null
    if (parsedPreset.preset) {
      const usable = checkPresetUsable(parsedPreset.preset)
      if (!usable.ok) return usable.message
      activePreset = usable.preset
    } else if (String(cfg.defaultWorkflowPreset || '').trim()) {
      // 默认预设不可用时不阻断生成，回落到 customWorkflow* / 内置工作流
      const usable = checkPresetUsable(String(cfg.defaultWorkflowPreset).trim())
      if (usable.ok) activePreset = usable.preset
      else if (cfg.outputLogs) logger.warn(`[p-draw] 默认预设不可用，已回落：${usable.message}`)
    }
    const text = parsedPreset.prompt
    const seed = parsedSeed.seed
    const count = parsedBatch.count
    // 预设可单独定价，未配置则用全局 price
    const unitPrice = presetPrice(activePreset) ?? Math.max(0, Number(cfg.price) || 0)
    // 命令级参数优先于预设 / modelParams / 全局配置（见 runComfyGenerate）
    // 图生图：工作流吃图时先把消息里的图下好、传到 ComfyUI；没带图就直接拦下（不扣点）
    const imagePlan = await prepareImageInputs(session, activePreset)
    if (!imagePlan.ok) return imagePlan.message

    const tuningOverrides = Object.assign(
      activePreset ? { preset: activePreset } : {},
      parsedTuning.steps != null ? { steps: parsedTuning.steps } : {},
      parsedTuning.cfg != null ? { cfg: parsedTuning.cfg } : {},
      parsedTuning.denoise != null ? { denoise: parsedTuning.denoise } : {},
      imagePlan.files.length ? { images: imagePlan.files } : {},
    )
    if (cfg.outputLogs && (parsedTuning.steps != null || parsedTuning.cfg != null)) {
      logger.info(`[p-draw] 命令级参数覆盖：steps=${parsedTuning.steps ?? '-'} cfg=${parsedTuning.cfg ?? '-'}`)
    }

    // P 点校验（按总价 = 张数 × 单价）
    // P 点校验（按总价 = 张数 × 单价）
    const pcheck = await precheckPoints(session, USERID, isAdmin, count * unitPrice)
    if (!pcheck.ok) return pcheck.message

    // 原样模式
    const stripped = stripRawPrefix(text)
    const raw = stripped.raw
    const promptSections = splitPositiveNegativePrompt(stripped.prompt)
    const userPrompt = promptSections.positive
    const userNegativePrompt = promptSections.negative
    if (!userPrompt) return session.text('.no-prompt')

    // 点数确认：先报明细（多少点、来自哪个工作流），用户同意再画。
    // 管理员免扣费，没有需要确认的花费，直接放过。
    if (cfg.workflowConfirm && !isAdmin && typeof session.prompt === 'function') {
      const totalCost = count * unitPrice
      const presetName = activePreset ? activePreset.name : '内置默认工作流'
      const lines = [
        `本次任务需要 ${totalCost} P 点`,
        `· 工作流：${presetName}（${unitPrice} P/张 × ${count} 张）`,
      ]
      if (imagePlan.files.length) lines.push(`· 参考图：${imagePlan.files.length} 张（已上传）`)
      const presetWarning = activePreset ? String(activePreset.warning || '').trim() : ''
      if (presetWarning) lines.push(`· 提醒：${presetWarning}`)
      lines.push('', `回复「是」开始绘制，回复「否」取消（${cfg.workflowConfirmTimeout} 秒内）`)
      await session.send(lines.join('\n'))
      const reply = await session.prompt(cfg.workflowConfirmTimeout * 1000).catch(() => null)
      if (normalizeConfirm(reply) !== true) {
        return session.text('.workflow-confirm-cancelled')
      }
    }

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
      const adminOpt = !globalOpt && isAdmin && hasLlm(cfg)
      const tokenOpt = !globalOpt && !isAdmin && hasLlm(cfg)
      if (globalOpt) {
        if (shouldOptimizePerImage({ count, enabled: true, admin: false })) {
          perImageOptimize = true
        } else {
          const optimized = await optimizePrompt(session, userPrompt, false)
          finalPrompt = optimized.prompt
          degraded = !optimized.ok
          optimizedReason = optimized.reason || ''
        }
      } else if (adminOpt) {
        if (shouldOptimizePerImage({ count, enabled: false, admin: true })) {
          perImageOptimize = true
        } else {
          const optimized = await optimizePrompt(session, userPrompt, true)
          finalPrompt = optimized.prompt
          degraded = !optimized.ok
          optimizedReason = optimized.reason || ''
        }
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
      const composed = await composePrompt(finalPrompt, raw)
      finalPrompt = appendInlineProtectedTags(composed.prompt, userPrompt, raw)
      degraded = degraded || composed.degraded
    }

    // 扣 P 点（一次性扣除总价）
    if (!isAdmin) {
      const saving = await deductP(USERID, count * unitPrice)
      if (cfg.outputLogs) logger.info(`[p-draw] ${USERID} 已扣除 ${count * unitPrice} P 点（${count} 张 × ${unitPrice}），余额 ${saving - count * unitPrice}`)
    }

    // 用户手写了 negative: 区块时，默认负面词仍保留；用户 tag 只补充未出现的部分。
    const generationOverrides = Object.assign(
      { unet, seed },
      tuningOverrides,
      userNegativePrompt ? { negativePrompt: mergeNegativePrompts(cfg.negativePrompt, userNegativePrompt) } : {},
    )

    // 性能：按张优化（perImageOptimize）时联网搜索只做一次，各图复用同一份结果
    const searchCache = perImageOptimize && wantsWebSearch(userPrompt) ? await webSearch(userPrompt) : null

    // 队列：预排队全部任务（先查容量再入队，占满整体退回总价）
    const queued = await enqueueBatch(count, async (i) => {
      let p = finalPrompt
      if (perImageOptimize) {
        const optimized = await optimizePrompt(session, userPrompt, true, searchCache)
        p = appendInlineProtectedTags((await composePrompt(optimized.prompt || userPrompt, raw)).prompt, userPrompt, raw)
      }
      const generated = await runComfyGenerate(p, parsedSize.size, generationOverrides)
      return { ...generated, prompt: p }
    }, { USERID, isAdmin, totalPrice: count * unitPrice })
    if (!queued.ok) return queued.message
    const queuedTasks = queued.tasks
    const firstPosition = queued.firstPosition

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
    const feedback = feedbackBase(session, { firstPosition, count })
    notice.push(...feedback.notices)
    await sendNotices(session, notice)

    // 单张生成
    const runOne = async (i) => {
      let p = finalPrompt
      if (perImageOptimize) {
        const optimized = await optimizePrompt(session, userPrompt, true, searchCache)
        p = appendInlineProtectedTags((await composePrompt(optimized.prompt || userPrompt, raw)).prompt, userPrompt, raw)
      }
      let result
      if (cfg.queueEnabled) {
        try { result = await queuedTasks[i] } catch (e) { result = { ok: false, message: `生成失败：${e.message}` } }
      } else {
        try { result = await runComfyGenerate(p, parsedSize.size, generationOverrides) } catch (e) { result = { ok: false, message: `生成失败：${e.message}` } }
      }
      if (!result.prompt) result.prompt = p
      return result
    }

    const { results, successCount } = await executeBatch(USERID, isAdmin, count, unitPrice, runOne)

    // 汇总
    const allOutputs = []
    const forwardOutputs = []
    const seeds = []
    const failures = []
    for (const item of results) {
      if (item.ok) {
        allOutputs.push(...item.outputs)
        forwardOutputs.push(...item.outputs.map(src => ({ src, prompt: item.prompt || finalPrompt, negativePrompt: item.negativePrompt })))
        if (item.seed != null) seeds.push(item.seed)
      } else {
        failures.push(`第 ${item.i + 1} 张：${item.message}`)
      }
    }

    const chargeNotice = buildChargeNotice({
      isAdmin,
      totalPrice: successCount * unitPrice,
      unetName: unet,
      seeds,
    })
    if (!allOutputs.length) {
      if (cfg.outputLogs) logger.warn(`生成全部失败（${USERID}），已按张退款`)
      return session.text('.generate-failed', ['全部失败（已按张退款）'])
    }

    if (cfg.outputLogs) logger.success(`${USERID} 生成成功 ${successCount}/${count} 张`)

    // 发图：合并转发，不引用原指令
    await sendImagesAsForward(session, forwardOutputs)

    await sendNotices(session, [chargeNotice])

    return buildGenerationReply(session, { successCount, count, failures })
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
        const reply = await session.prompt(cfg.couponAskTimeout * 1000).catch(() => null)
        return normalizeConfirm(reply)
      }
      let ans = await askBuy()
      if (ans === false) {
        await session.send(session.text('.coupon-buy-warn'))
        const reply = await session.prompt(cfg.couponAskTimeout * 1000).catch(() => null)
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

  // 提示词优化券单价：优先读 data/p-shop.json 里覆盖的价格，否则用配置 couponPrice。
  // 加 60 秒 TTL 缓存，避免每次购买询问都同步读盘。
  let couponPriceCache = null
  let couponPriceCacheAt = 0
  async function resolveCouponPrice() {
    if (couponPriceCache != null && Date.now() - couponPriceCacheAt < 60 * 1000) {
      return couponPriceCache
    }
    let price = cfg.couponPrice
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
            if (item && typeof item.price === 'number' && item.price > 0) {
              price = item.price
              break
            }
          }
        }
      } catch (e) {
        logger.warn(`读取 p-shop.json 价格失败：${e.message}`)
      }
    }
    couponPriceCache = price
    couponPriceCacheAt = Date.now()
    return price
  }

  // 启动时加载配置表，并将旧 fixedCharacters 数据迁入专用表。
  await loadRuntimeState()
  await migrateFixedCharacters()

  ctx.on('dispose', () => {
    // 清理临时文件
    try {
      const files = fs.readdirSync(tempDir)
      for (const file of files) {
        try { fs.unlinkSync(path.join(tempDir, file)) } catch (e) { /* ignore */ }
      }
      try { fs.rmdirSync(tempDir) } catch (e) { /* ignore */ }
    } catch (e) { /* ignore */ }
  })

  // 暴露内部接口供自动化测试调用（Koishi 忽略 apply 返回值，不影响生产行为）
  return { couponConfirmFlow, buyCouponsAndConsume, normalizeConfirm, resolveCouponPrice, buildChargeNotice, buildGenerationReply, shouldOptimizePerImage, sendNotices, sendImagesAsForward, executeBatch, composePrompt, messageImageSources, shouldSkipQualityPrefix, qualityPrefixWarning, customWorkflowDiagLines, diagnoseText, workflowDir, normalizeConfig, presetList, presetOverviewText, presetPrice }
}
