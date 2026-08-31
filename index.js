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
 `;

const { zhCN } = require('./lib/i18n')
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
  fixedCharacters: Schema.array(Schema.string()).default([]).description('固定角色（格式：角色名=tags；仅用于兼容旧配置，运行时数据保存在数据库）'),

  // 队列
  queueEnabled: Schema.boolean().default(true).description('启用生成队列（逐张顺序执行）'),
  queueMaxRequests: Schema.number().default(5).description('队列最大任务数（0 表示不限制）'),
  batchMax: Schema.number().default(4).description('单次指令最多生成的张数（支持 x3 / 3张 / --数量 3 等写法）'),

  // P 点
  price: Schema.number().default(500).description('一张图消耗的 P 点'),
  multiPrice: Schema.number().default(900).description('多人指令（p-draw 多人）单张消耗的 P 点'),
  couponPrice: Schema.number().default(3000).description('提示词优化券单价（P 点/张，购买询问时显示；可自动读取 data/p-shop.json 里的价格覆盖）'),
  couponAskTimeout: Schema.number().default(60).description('提示词优化券确认等待时间（秒）'),
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
// 纯函数库已拆分到 lib/（解析 / tag 清洗 / 工作流 / Comfy 等待 / 多人规划 / HTTP 客户端）
// ------------------------------------------------------------------
const {
  normalizeBaseUrl, escapeRe, parseGenerationSize, parseBatchCount, parseSeed,
  stripRawPrefix, splitPositiveNegativePrompt, parseNameTags, parsePresetList, mergeTagText,
} = require('./lib/parse')
const {
  splitTags, joinPromptParts, mergeNegativePrompts, cleanContentTags, appendInlineProtectedTags,
  NO_ARTIST_RE, NO_STYLE_RE,
} = require('./lib/tags')
const {
  buildWorkflow,
} = require('./lib/workflows')
const { outputImages, waitComfyResult } = require('./lib/comfy')
const { materializeImageSource } = require('./lib/media')
const {
  MULTI_PERSON_NEGATIVE_TAGS, buildMultiPersonPlanPrompt, parseMultiPersonPlan,
  renderMultiPersonCharacter, multiPersonAutoSize,
} = require('./lib/multi')
const { buildComfyClient } = require('./lib/http')
exports.apply = async function apply(ctx, cfg) {
  // 注意：不在此处 extend p_system 表 —— 该表由 p-qiandao 等 p 系插件创建。
  // 重复声明同一张表可能导致 Koishi 的 schema 迁移冲突，拖垮签到插件。

  const logger = ctx.logger('p-draw')
  ctx.i18n.define('zh-CN', zhCN)

  // 运行时数据持久化到数据库，而不是调用 scope.update
  // 写 koishi.yml：scope.update 会触发插件重载，导致正在生成的图被 dispose（Context has
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
      payload.clip_available = clipList.includes(cfg.clipName)
      payload.vae_available = vaeList.includes(cfg.vaeName)
    } else {
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
      `主模型：${cfg.unetName} ${modelStatus(cfg.unetName, payload.unet_available)}`,
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
    if (isAdmin || !seeds.length) return ''
    return `已扣除 ${totalPrice} P 点，当前模型：${unetName}，--seed=${seeds.join(',')}`
  }

  function buildGenerationReply(session, { successCount, count, failures, notes = [], chargeNotice = '' }) {
    const reply = []
    if (chargeNotice) reply.push(chargeNotice)
    if (notes.length) reply.push(notes.join('\n'))
    if (failures.length) reply.push(session.text('.batch-partial', [successCount, count, failures.length, failures.join('；')]))
    return reply.filter(Boolean).join('\n')
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
    // 应用该模型的独立参数覆盖（modelParams），再叠加命令级 overrides（overrides.steps/cfg 优先于模型级）
    const modelSpecific = resolveModelParams(unetName)
    const workCfg = Object.assign({}, cfg, modelSpecific, { unetName })
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
    const promptBody = buildWorkflow(workCfg, prompt, negativePrompt, width, height, steps, cfgVal, seed, Boolean(size))

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

  async function optimizePrompt(session, userPrompt, force = false, precomputedSearch = null) {
    if (!cfg.promptOptimizeEnabled && !force) {
      return { ok: true, prompt: userPrompt, reason: 'optimize_disabled' }
    }
    if (!cfg.llmModel || !cfg.llmBaseUrl) {
      logger.warn('提示词优化已开启但未配置 llmModel / llmBaseUrl，跳过优化')
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

  // ---------------- 提示词组装 ----------------
  // fixedOverride：undefined=按名称自动匹配固定角色；'skip'=不注入固定角色；字符串=直接使用该字符串作为固定角色 tags
  async function composePrompt(userPrompt, raw, fixedOverride) {
    if (raw) return { prompt: userPrompt, degraded: false }
    const parts = []
    if (cfg.qualityPrefix) parts.push(String(cfg.qualityPrefix).trim())
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
    if (cfg.qualityPrefix) parts.push(String(cfg.qualityPrefix).trim())
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
  async function verifyGeneratedImages(session, images, userRequest, prompt, size, planCount, unet, negativePrompt) {
    const verifyBaseUrl = String(cfg.verifyLlmBaseUrl || '').trim()
    const verifyModel = String(cfg.verifyLlmModel || '').trim()
    if (!verifyBaseUrl || !verifyModel) {
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
      const regen = await runComfyGenerate(currentPrompt, size, { unet, negativePrompt: currentNegativePrompt })
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
    const queued = await enqueueBatch(count, (i) => runComfyGenerate(finalPrompt, size, { negativePrompt: multiNegative, unet }), { USERID, isAdmin, totalPrice: count * price })
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
        try { result = await runComfyGenerate(finalPrompt, size, { negativePrompt: multiNegative, unet }) } catch (e) { result = { ok: false, message: `生成失败：${e.message}` } }
      }
      if (!result.ok || !result.outputs || !result.outputs.length) return result
      if (!cfg.multiVerifyEnabled) {
        return { ok: true, outputs: result.outputs, seed: result.seed, prompt: finalPrompt, negativePrompt: result.negativePrompt, note: session.text('.multi-degraded', ['（未启用校验或未配置视觉模型）']) }
      }
      const verified = await verifyGeneratedImages(session, result.outputs, text, finalPrompt, size, plan.characters.length, unet, result.negativePrompt || multiNegative)
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

    return buildGenerationReply(session, { successCount, count, failures, notes, chargeNotice })
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
    const text = parsedSeed.prompt
    const seed = parsedSeed.seed
    const count = parsedBatch.count

    // P 点校验（按总价 = 张数 × 单价）
    // P 点校验（按总价 = 张数 × 单价）
    const pcheck = await precheckPoints(session, USERID, isAdmin, count * cfg.price)
    if (!pcheck.ok) return pcheck.message

    // 原样模式
    const stripped = stripRawPrefix(text)
    const raw = stripped.raw
    const promptSections = splitPositiveNegativePrompt(stripped.prompt)
    const userPrompt = promptSections.positive
    const userNegativePrompt = promptSections.negative
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
        const optimized = await optimizePrompt(session, userPrompt, false)
        finalPrompt = optimized.prompt
        degraded = !optimized.ok
        optimizedReason = optimized.reason || ''
      } else if (adminOpt) {
        // 管理员在全局关闭时也免费优化（不耗券）
        const optimized = await optimizePrompt(session, userPrompt, true)
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
      const composed = await composePrompt(finalPrompt, raw)
      finalPrompt = appendInlineProtectedTags(composed.prompt, userPrompt, raw)
      degraded = degraded || composed.degraded
    }

    // 扣 P 点（一次性扣除总价）
    if (!isAdmin) {
      const saving = await deductP(USERID, count * cfg.price)
      if (cfg.outputLogs) logger.info(`[p-draw] ${USERID} 已扣除 ${count * cfg.price} P 点（${count} 张 × ${cfg.price}），余额 ${saving - count * cfg.price}`)
    }

    // 用户手写了 negative: 区块时，默认负面词仍保留；用户 tag 只补充未出现的部分。
    const generationOverrides = Object.assign(
      { unet, seed },
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
    }, { USERID, isAdmin, totalPrice: count * cfg.price })
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

    const { results, successCount } = await executeBatch(USERID, isAdmin, count, cfg.price, runOne)

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
      totalPrice: successCount * cfg.price,
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

    return buildGenerationReply(session, { successCount, count, failures, chargeNotice })
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
    } catch (e) { /* ignore */ }
  })

  // 暴露内部接口供自动化测试调用（Koishi 忽略 apply 返回值，不影响生产行为）
  return { couponConfirmFlow, buyCouponsAndConsume, normalizeConfirm, resolveCouponPrice, buildChargeNotice, buildGenerationReply, sendNotices, sendImagesAsForward, executeBatch }
}
