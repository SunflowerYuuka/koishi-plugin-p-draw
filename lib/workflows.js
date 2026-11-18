// ComfyUI 工作流构建（移植自 anima comfyui_workflows）。
// 纯函数 + fs：内置 Anima / Animagine 图，以及用户导出的自定义工作流 JSON 注入。
//
// 自定义工作流的「工作流准备」分层（Design.md A1/A3/A7）：
//   1) resolveCustomWorkflowPath  路径解析（Koishi baseDir 优先，插件目录回退）
//   2) readCustomWorkflowBody     读取 + 按 mtime/size 缓存（支持 customWorkflowReloadOnChange 热重载）
//   3) resolveCustomNodeTargets   节点定位（显式配置 ID 优先，结构反查回退）
//   4) customWorkflow             注入提示词 / 尺寸 / 采样参数 / seed
//
// 约束：代码中不硬编码任何节点 ID。节点 ID 始终来自配置或工作流结构本身（A7）。

const fs = require('fs')
const path = require('path')

// ------------------------------------------------------------------
// 主模型 loader 选择（Design.md A2：8G 显存推荐 GGUF Q8_0）
// ------------------------------------------------------------------
// useGgufUnet: 'auto'（按文件名后缀）/ 'true' / 'false'
function isGgufUnet(cfg) {
  const mode = String((cfg && cfg.useGgufUnet) || 'auto').trim().toLowerCase()
  if (['true', 'yes', 'on', '1', 'gguf'].includes(mode)) return true
  if (['false', 'no', 'off', '0', 'safetensors'].includes(mode)) return false
  return /\.gguf$/i.test(String((cfg && cfg.unetName) || '').trim())
}

// GGUF 走 ComfyUI-GGUF 的 UnetLoaderGGUF，其余走原生 UNETLoader。
function unetLoaderNode(cfg) {
  if (isGgufUnet(cfg)) {
    return { class_type: 'UnetLoaderGGUF', inputs: { unet_name: cfg.unetName } }
  }
  return { class_type: 'UNETLoader', inputs: { unet_name: cfg.unetName, weight_dtype: 'fp8_e4m3fn' } }
}

// ------------------------------------------------------------------
// 内置工作流
// ------------------------------------------------------------------
function animaT2IWorkflow(cfg, prompt, negativePrompt, width, height, steps, cfgVal, seed) {
  return {
    '44': unetLoaderNode(cfg),
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

function animagineT2IWorkflow(cfg, prompt, negativePrompt, width, height, steps, cfgVal, seed) {
  return {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: cfg.unetName } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: negativePrompt, clip: ['4', 1] } },
    '3': {
      class_type: 'KSampler',
      inputs: {
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
        seed,
        steps,
        cfg: cfgVal,
        sampler_name: cfg.samplerName,
        scheduler: cfg.scheduler,
        denoise: 1,
      },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'pdraw/animagine' } },
  }
}

// ------------------------------------------------------------------
// 1) 路径解析
// ------------------------------------------------------------------
// A5 的 customWorkflowPath 形如 "data/p-draw/workflows/anima-aesthetic-v1.1.json"，
// 相对 Koishi 的 baseDir（即运行目录）而不是插件目录，因此 baseDir 优先、插件目录回退。
function resolveCustomWorkflowPath(cfg, opts = {}) {
  const raw = String((cfg && cfg.customWorkflowPath) || '').trim()
  if (!raw) throw new Error('自定义工作流路径为空，请填写 customWorkflowPath')
  if (path.isAbsolute(raw)) {
    if (!fs.existsSync(raw)) throw new Error(`自定义工作流文件不存在：${raw}`)
    return raw
  }
  const candidates = []
  if (opts.baseDir) candidates.push(path.resolve(opts.baseDir, raw))
  candidates.push(path.resolve(__dirname, '..', raw))
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error(`自定义工作流文件不存在。已查找：\n${candidates.map(c => '  ' + c).join('\n')}`)
}

// ------------------------------------------------------------------
// 2) 读取 + 缓存（customWorkflowReloadOnChange 热重载）
// ------------------------------------------------------------------
const workflowFileCache = new Map() // absPath -> { mtimeMs, size, body }

function readCustomWorkflowBody(absPath, reloadOnChange) {
  let stat
  try {
    stat = fs.statSync(absPath)
  } catch (e) {
    throw new Error(`自定义工作流读取失败：${e.message}`)
  }
  const cached = workflowFileCache.get(absPath)
  const fresh = cached && (!reloadOnChange || (cached.mtimeMs === stat.mtimeMs && cached.size === stat.size))
  if (fresh) return cached.body

  let body
  try {
    body = JSON.parse(fs.readFileSync(absPath, 'utf-8'))
  } catch (e) {
    throw new Error(`自定义工作流加载失败：${e.message}`)
  }
  // 兼容「导出为 API 格式」的文件：内容包在 { prompt: {...} } 里
  const graph = body && typeof body === 'object' && body.prompt && typeof body.prompt === 'object' ? body.prompt : body
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    throw new Error('自定义工作流 JSON 无效：顶层不是节点表')
  }
  workflowFileCache.set(absPath, { mtimeMs: stat.mtimeMs, size: stat.size, body: graph })
  return graph
}

function clearWorkflowCache() {
  workflowFileCache.clear()
}

// ------------------------------------------------------------------
// 3) 节点定位
// ------------------------------------------------------------------
function cleanNodeId(value) {
  const text = String(value == null ? '' : value).trim().replace(/^#/, '')
  return text
}

function nodeLabel(workflow, id) {
  const node = workflow[id]
  if (!node || typeof node !== 'object') return `#${id}（不存在）`
  const title = node._meta && node._meta.title
  return `#${id} [${node.class_type || '未知'}${title ? ' / ' + title : ''}]`
}

// 所有「带 text 输入的文本编码节点」，用于提示词注入与报错提示
function collectTextNodeIds(workflow) {
  const ids = []
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!node || typeof node !== 'object') continue
    const classType = String(node.class_type || '')
    const inputs = node.inputs
    if (classType.includes('TextEncode') && inputs && typeof inputs.text === 'string') {
      ids.push(String(nodeId))
    }
  }
  return ids
}

function findNodesByClass(workflow, classTypes) {
  const wanted = new Set(classTypes)
  const ids = []
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (node && typeof node === 'object' && wanted.has(String(node.class_type || ''))) ids.push(String(nodeId))
  }
  return ids
}

// 采样节点：类名含 sampler 且带 steps 输入（KSampler / KSamplerAdvanced / ClownsharKSampler_Beta …）
function findSamplerNodeIds(workflow) {
  const ids = []
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!node || typeof node !== 'object') continue
    if (!/sampler/i.test(String(node.class_type || ''))) continue
    const inputs = node.inputs
    if (!inputs || typeof inputs !== 'object') continue
    if (!('steps' in inputs)) continue
    ids.push(String(nodeId))
  }
  return ids
}
// 尺寸节点：凡是「类名带 Latent 且同时有 width/height 输入」的都算。
// 这样 EmptyLatentImage、EmptySD3LatentImage、EmptyHunyuanLatentVideo 等新老节点都能认。
function findResolutionNodeIds(workflow) {
  const ids = []
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!node || typeof node !== 'object') continue
    const classType = String(node.class_type || '')
    const inputs = node.inputs
    if (!inputs || typeof inputs !== 'object') continue
    if (!/latent/i.test(classType)) continue
    if (!('width' in inputs) || !('height' in inputs)) continue
    ids.push(String(nodeId))
  }
  return ids
}

// 从任意带 positive/negative 输入的节点（KSampler、KSamplerAdvanced、ClownsharKSampler_Beta
// 等所有采样器）沿连线反查，找到真正的文本编码节点。
// 不写死采样器类名，否则 RES4LYF / 自定义采样器都会识别不到。
// samplerOnly=true 时只从采样器节点出发反查。
// 图生图/重绘类工作流里 InpaintModelConditioning 之类的中转节点也有 positive/negative 输入，
// 若把它们和采样器一起当起点，两条链会同时命中正负两组文本节点 → 被判成"有歧义"。
function conditioningTextNodeIds(workflow, inputName, textNodes, samplerOnly = false) {
  const pending = []
  for (const node of Object.values(workflow)) {
    if (!node || typeof node !== 'object') continue
    if (samplerOnly && !/sampler/i.test(String(node.class_type || ''))) continue
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
    // 中转节点（如 InpaintModelConditioning）同时有 positive 和 negative：
    // 只沿着同名的那个输入继续走，否则正负两条链会互相污染
    const sameName = inputs[inputName]
    if (Array.isArray(sameName) && sameName.length) {
      const sourceId = String(sameName[0])
      if (workflow[sourceId]) pending.push(sourceId)
      continue
    }
    for (const value of Object.values(inputs)) {
      if (Array.isArray(value) && value.length) {
        const sourceId = String(value[0])
        if (workflow[sourceId]) pending.push(sourceId)
      }
    }
  }
  return found
}

// 解析自定义工作流中真正要写入的节点集合。
// 显式配置（positivePromptNodeId 等）优先；留空则按结构反查。ID 不存在时给出可用节点提示。
function resolveCustomNodeTargets(workflow, cfg = {}) {
  const textNodes = collectTextNodeIds(workflow)
  const errors = []
  const explicitPositive = cleanNodeId(cfg.positivePromptNodeId)
  const explicitNegative = cleanNodeId(cfg.negativePromptNodeId)

  function resolveTextNode(explicit, inputName, label) {
    if (!explicit) {
      // 优先只从采样器反查：图生图/重绘工作流里的条件中转节点容易造成正负混淆
      const fromSampler = conditioningTextNodeIds(workflow, inputName, textNodes, true)
      if (fromSampler.length) return fromSampler
      return conditioningTextNodeIds(workflow, inputName, textNodes)
    }
    const available = textNodes.map(id => nodeLabel(workflow, id)).join('\n  ') || '（无）'
    if (!workflow[explicit]) {
      errors.push(`配置的${label}节点 ID「${explicit}」不存在于工作流中。可用文本编码节点：\n  ${available}`)
      return []
    }
    if (!textNodes.includes(explicit)) {
      errors.push(`配置的${label}节点 ID「${explicit}」不是文本编码节点（${nodeLabel(workflow, explicit)}）。可用文本编码节点：\n  ${available}`)
      return []
    }
    return [explicit]
  }

  let positive = resolveTextNode(explicitPositive, 'positive', '正面提示词')
  let negative = resolveTextNode(explicitNegative, 'negative', '负面提示词')

  // 显式配置优先：自动反查结果不得抢占已被显式指定的节点
  if (explicitPositive) negative = negative.filter(id => id !== explicitPositive)
  if (explicitNegative) positive = positive.filter(id => id !== explicitNegative)

  if (!positive.length && !errors.length) errors.push('自定义工作流中找不到正面提示词节点')
  if (!negative.length && !errors.length) errors.push('自定义工作流中找不到负面提示词节点')
  if (positive.length && negative.length && positive.some(id => negative.includes(id))) {
    errors.push('自定义工作流正负面节点有歧义，请在配置中显式填写 positivePromptNodeId / negativePromptNodeId')
  }

  // 尺寸节点：显式指定则只改该节点，否则改所有 EmptyLatentImage
  const explicitResolution = cleanNodeId(cfg.resolutionNodeId)
  let resolutionIds = []
  if (explicitResolution) {
    if (!workflow[explicitResolution]) {
      errors.push(`配置的尺寸节点 ID「${explicitResolution}」不存在于工作流中。可能是：\n  ${findResolutionNodeIds(workflow).map(id => nodeLabel(workflow, id)).join('\n  ') || '（无）'}`)
    } else {
      resolutionIds = [explicitResolution]
    }
  } else {
    resolutionIds = findResolutionNodeIds(workflow)
  }

  // 采样节点：显式指定则只改该节点，否则改所有 KSampler
  const samplerClasses = findSamplerNodeIds(workflow)
  const explicitSteps = cleanNodeId(cfg.stepsNodeId)
  let stepsIds = []
  if (explicitSteps) {
    if (!workflow[explicitSteps]) {
      errors.push(`配置的步数节点 ID「${explicitSteps}」不存在于工作流中。可能是：\n  ${samplerClasses.map(id => nodeLabel(workflow, id)).join('\n  ') || '（无）'}`)
    } else {
      stepsIds = [explicitSteps]
    }
  } else {
    stepsIds = samplerClasses
  }

  // seed 节点：显式指定则只改该节点，否则改所有带 seed / noise_seed 输入的节点
  const explicitSeed = cleanNodeId(cfg.seedNodeId)
  let seedIds = []
  if (explicitSeed) {
    if (!workflow[explicitSeed]) {
      errors.push(`配置的种子节点 ID「${explicitSeed}」不存在于工作流中。可能是：\n  ${samplerClasses.map(id => nodeLabel(workflow, id)).join('\n  ') || '（无）'}`)
    } else {
      seedIds = [explicitSeed]
    }
  } else {
    seedIds = Object.entries(workflow)
      .filter(([, node]) => node && typeof node === 'object' && node.inputs && typeof node.inputs === 'object'
        && ('seed' in node.inputs || 'noise_seed' in node.inputs))
      .map(([id]) => String(id))
  }

  return { positive, negative, resolutionIds, stepsIds, seedIds, textNodes, errors }
}

// ------------------------------------------------------------------
// 4) 注入
// ------------------------------------------------------------------
function customWorkflow(cfg, prompt, negativePrompt, width, height, steps, cfgVal, seed, explicitSize, opts = {}) {
  const absPath = resolveCustomWorkflowPath(cfg, opts)
  // 默认热重载（A6：换 JSON 无需重启插件）
  const reloadOnChange = cfg.customWorkflowReloadOnChange !== false
  const body = readCustomWorkflowBody(absPath, reloadOnChange)

  // 深拷贝后再改，缓存里的原始节点表不被污染
  const workflow = JSON.parse(JSON.stringify(body))

  const targets = resolveCustomNodeTargets(workflow, cfg)
  if (targets.errors.length) throw new Error(targets.errors.join('\n'))

  // 模型名注入：让 unetName / p-draw 模型 对自定义工作流也生效
  const modelResult = applyModelOverride(workflow, cfg, opts)

  // 图片输入（图生图）：工作流需要图却没给 → 明确报错，不要静默跑出个错的图
  const imageResult = applyImageInputs(workflow, opts.images, opts)
  if (imageResult.reason === 'missing-image') {
    const names = imageResult.loaders.map(loader => `#${loader.id} ${loader.classType}`).join('、')
    throw new Error(`这个工作流需要图片输入（${names}），请随指令带一张参考图再发送`)
  }
  if (String(imageResult.reason).startsWith('node-not-found')) {
    throw new Error(`配置的图片节点 ID「${opts.imageNodeId}」不存在于工作流中`)
  }
  // 重绘幅度：只在显式给出时覆盖，保留多段工作流各段自己的 denoise
  applyDenoise(workflow, opts.denoise)

  for (const nodeId of targets.positive) {
    if (workflow[nodeId] && workflow[nodeId].inputs) workflow[nodeId].inputs.text = prompt
  }
  for (const nodeId of targets.negative) {
    if (workflow[nodeId] && workflow[nodeId].inputs) workflow[nodeId].inputs.text = negativePrompt
  }

  const override = Boolean(cfg.customWorkflowOverrideParameters)
  // modelParams 里显式配置的字段永远覆盖工作流内取值（用户明确为这个模型指定的值），
  // 其余字段才受 customWorkflowOverrideParameters 这个总开关控制。
  const modelParams = (opts && opts.modelParams && typeof opts.modelParams === 'object') ? opts.modelParams : {}
  const explicitlySet = (key) => Object.prototype.hasOwnProperty.call(modelParams, key)
  const overwrite = (key) => override || explicitlySet(key)
  const resolutionSet = new Set(targets.resolutionIds)
  const stepsSet = new Set(targets.stepsIds)
  const seedSet = new Set(targets.seedIds)

  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!node || typeof node !== 'object') continue
    const classType = String(node.class_type || '')
    const inputs = node.inputs
    if (!inputs || typeof inputs !== 'object') continue
    if (classType === 'SaveImage' && 'filename_prefix' in inputs) {
      inputs.filename_prefix = 'pdraw/anm'
    }
    // 尺寸：总开关开、用户显式指定尺寸、或 modelParams 配了 width/height 时覆盖
    const sizeOverride = override || explicitSize || overwrite('width') || overwrite('height')
    if (sizeOverride && resolutionSet.has(nodeId)) {
      if ('width' in inputs) inputs.width = width
      if ('height' in inputs) inputs.height = height
    }
    if (stepsSet.has(nodeId)) {
      if ('steps' in inputs && overwrite('steps')) inputs.steps = steps
      if ('cfg' in inputs && overwrite('cfg')) inputs.cfg = cfgVal
      if (cfg.samplerName && 'sampler_name' in inputs && overwrite('samplerName')) inputs.sampler_name = cfg.samplerName
      if (cfg.scheduler && 'scheduler' in inputs && overwrite('scheduler')) inputs.scheduler = cfg.scheduler
    }
    if (seedSet.has(nodeId)) {
      if ('seed' in inputs) inputs.seed = seed
      if ('noise_seed' in inputs) inputs.noise_seed = seed
    }
  }
  return workflow
}

// 只读检查：供「p-draw 诊断」报告工作流来源与实际解析到的节点，不生成图片
function inspectCustomWorkflow(cfg, opts = {}) {
  const report = { ok: false, path: '', mtimeMs: null, targets: null, textNodes: [], modelLoaders: [], error: '' }
  try {
    const absPath = resolveCustomWorkflowPath(cfg, opts)
    report.path = absPath
    try { report.mtimeMs = fs.statSync(absPath).mtimeMs } catch (e) { /* ignore */ }
    const body = readCustomWorkflowBody(absPath, cfg.customWorkflowReloadOnChange !== false)
    const workflow = JSON.parse(JSON.stringify(body))
    const targets = resolveCustomNodeTargets(workflow, cfg)
    report.targets = targets
    report.textNodes = targets.textNodes
    report.modelLoaders = findModelLoaders(workflow)
    if (targets.errors.length) {
      report.error = targets.errors.join('；')
      return report
    }
    report.ok = true
    return report
  } catch (e) {
    report.error = String(e && e.message || e)
    return report
  }
}

// 只有图像输入类节点才需要用户「喂图」；这些工作流在纯文生图模式下无法使用
const IMAGE_INPUT_RE = /^(LoadImage|LoadImageMask|LoadImageOutput|ImageInput|LoadImageFromUrl)$/i
const CONTROLNET_RE = /controlnet/i

// 主模型加载节点 → 模型文件名所在的输入名
const MODEL_LOADER_INPUTS = {
  UNETLoader: 'unet_name',
  UnetLoaderGGUF: 'unet_name',
  EnhancedLoadDiffusionModel: 'unet_name',
  CheckpointLoaderSimple: 'ckpt_name',
}

// 找出工作流里的模型加载节点
function findModelLoaders(workflow) {
  const found = []
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!node || typeof node !== 'object') continue
    const inputName = MODEL_LOADER_INPUTS[String(node.class_type || '')]
    if (!inputName) continue
    const inputs = node.inputs
    if (!inputs || !(inputName in inputs)) continue
    found.push({ id: String(nodeId), inputName, classType: String(node.class_type) })
  }
  return found
}

// 把 cfg.unetName 写进工作流的模型加载节点。
// 多个加载器时不猜（除非用 modelLoaderNodeId 指定），避免把双模型工作流写坏。
function applyModelOverride(workflow, cfg, opts = {}) {
  if (opts.overrideModel === false) return { applied: false, loaders: findModelLoaders(workflow), reason: 'disabled' }
  const loaders = findModelLoaders(workflow)
  const model = String((cfg && cfg.unetName) || '').trim()
  if (!loaders.length) return { applied: false, loaders, reason: 'no-loader' }
  if (!model) return { applied: false, loaders, reason: 'no-model' }

  const pinned = cleanNodeId(opts.modelLoaderNodeId)
  let targets = loaders
  if (pinned) {
    targets = loaders.filter(loader => loader.id === pinned)
    if (!targets.length) return { applied: false, loaders, reason: `node-not-found:${pinned}` }
  } else if (loaders.length > 1) {
    return { applied: false, loaders, reason: 'ambiguous' }
  }

  for (const target of targets) {
    workflow[target.id].inputs[target.inputName] = model
  }
  return { applied: true, loaders, targets, model, reason: '' }
}

// 体检：这个工作流能不能在「纯文本」模式下跑，需要什么额外输入
// 找出工作流里的图片输入节点（LoadImage 等）
function findImageLoaderNodes(workflow) {
  const found = []
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!node || typeof node !== 'object') continue
    const classType = String(node.class_type || '')
    if (!IMAGE_INPUT_RE.test(classType)) continue
    const inputs = node.inputs
    if (!inputs || typeof inputs !== 'object') continue
    const inputName = 'image' in inputs
      ? 'image'
      : (Object.keys(inputs).find(key => typeof inputs[key] === 'string') || 'image')
    found.push({ id: String(nodeId), classType, inputName })
  }
  return found
}

// 把已上传到 ComfyUI 的图片文件名写进 LoadImage 节点。
// 多个 LoadImage 时按顺序分配；imageNodeId 可指定只改一个。
function applyImageInputs(workflow, images, opts = {}) {
  const loaders = findImageLoaderNodes(workflow)
  const provided = (Array.isArray(images) ? images : []).filter(Boolean)

  if (!loaders.length) {
    return { applied: false, loaders, targets: [], reason: provided.length ? 'no-loader' : 'not-needed' }
  }
  if (!provided.length) {
    return { applied: false, loaders, targets: [], reason: 'missing-image' }
  }

  const pinned = cleanNodeId(opts.imageNodeId)
  let targets = loaders
  if (pinned) {
    targets = loaders.filter(loader => loader.id === pinned)
    if (!targets.length) return { applied: false, loaders, targets: [], reason: `node-not-found:${pinned}` }
  }

  targets.forEach((loader, index) => {
    const value = provided[index] || provided[provided.length - 1]
    if (value) workflow[loader.id].inputs[loader.inputName] = value
  })
  return { applied: true, loaders, targets, reason: '' }
}

// 重绘幅度：只写给采样器节点（有 denoise 输入的），用于图生图。
// 不传就不动 —— 多段工作流各段自己的 denoise 才不会被压平。
function applyDenoise(workflow, denoise) {
  if (denoise === undefined || denoise === null || denoise === '') return { applied: false, count: 0 }
  const value = Number(denoise)
  if (!Number.isFinite(value)) return { applied: false, count: 0 }
  let count = 0
  for (const node of Object.values(workflow)) {
    if (!node || typeof node !== 'object') continue
    if (!/sampler/i.test(String(node.class_type || ''))) continue
    const inputs = node.inputs
    if (!inputs || typeof inputs !== 'object' || !('denoise' in inputs)) continue
    inputs.denoise = value
    count += 1
  }
  return { applied: count > 0, count }
}

// 体检：这个工作流能不能在「纯文本」模式下跑，需要什么额外输入
function analyzeWorkflow(workflow) {
  const classes = Object.values(workflow).map(node => String((node && node.class_type) || ''))
  const unique = (list) => [...new Set(list)]
  const imageInputClasses = unique(classes.filter(type => IMAGE_INPUT_RE.test(type)))
  const controlNetClasses = unique(classes.filter(type => CONTROLNET_RE.test(type)))
  const resolutionIds = findResolutionNodeIds(workflow)
  const textNodes = collectTextNodeIds(workflow)

  const requires = []
  if (imageInputClasses.length) requires.push(`图片输入（${imageInputClasses.join(' / ')}）`)
  if (controlNetClasses.length && !imageInputClasses.length) {
    requires.push(`ControlNet 控制图（${controlNetClasses.join(' / ')}）`)
  }

  return {
    nodeCount: classes.length,
    textNodes,
    resolutionIds,
    imageInputClasses,
    controlNetClasses,
    hasLatentStart: resolutionIds.length > 0,
    requires,
    // 纯文本可跑：有文生图起点，且没有任何需要外部图片的节点
    canRunTextOnly: resolutionIds.length > 0 && imageInputClasses.length === 0,
  }
}

// 体检任意一个工作流文件（预设用）。返回结构不抛错，便于诊断里逐条展示。
function inspectWorkflowFile(workflowPath, cfg = {}, opts = {}) {
  const report = {
    ok: false, path: '', mtimeMs: null, analysis: null, targets: null, error: '',
  }
  try {
    const absPath = resolveCustomWorkflowPath({ customWorkflowPath: workflowPath }, opts)
    report.path = absPath
    try { report.mtimeMs = fs.statSync(absPath).mtimeMs } catch (e) { /* ignore */ }
    const body = readCustomWorkflowBody(absPath, cfg.customWorkflowReloadOnChange !== false)
    const workflow = JSON.parse(JSON.stringify(body))
    report.analysis = analyzeWorkflow(workflow)
    const targets = resolveCustomNodeTargets(workflow, cfg)
    report.targets = targets
    // 需要图片输入不算「不可用」——现在支持图生图，只要指令里带图就能跑
    report.needsImage = report.analysis.imageInputClasses.length > 0
    if (targets.errors.length) {
      report.error = targets.errors.join('；')
      return report
    }
    // 图生图工作流的 latent 来自 VAEEncode，没有空 latent 节点，不能因此判为不可用
    if (!report.analysis.hasLatentStart && !report.needsImage) {
      report.error = report.analysis.requires.length
        ? `需要${report.analysis.requires.join('、')}，且工作流里找不到可写入尺寸的 latent 节点`
        : '工作流里找不到可写入尺寸的 latent 节点（缺少文生图起点）'
      return report
    }
    report.ok = true
    return report
  } catch (e) {
    report.error = String((e && e.message) || e)
    return report
  }
}

function buildWorkflow(cfg, prompt, negativePrompt, width, height, steps, cfgVal, seed, explicitSize, opts = {}) {
  if (cfg.customWorkflowEnabled && cfg.customWorkflowPath) {
    return customWorkflow(cfg, prompt, negativePrompt, width, height, steps, cfgVal, seed, explicitSize, opts)
  }
  const normalizedModel = String(cfg.unetName || '').trim().toLowerCase().replace(/[-_]/g, '~')
  if (normalizedModel === 'animagine~xl~3.1.safetensors') {
    return animagineT2IWorkflow(cfg, prompt, negativePrompt, width, height, steps, cfgVal, seed)
  }
  return animaT2IWorkflow(cfg, prompt, negativePrompt, width, height, steps, cfgVal, seed)
}

module.exports = {
  isGgufUnet,
  unetLoaderNode,
  animaT2IWorkflow,
  animagineT2IWorkflow,
  resolveCustomWorkflowPath,
  readCustomWorkflowBody,
  clearWorkflowCache,
  cleanNodeId,
  nodeLabel,
  collectTextNodeIds,
  findNodesByClass,
  findSamplerNodeIds,
  findResolutionNodeIds,
  buildWorkflow,
  customWorkflow,
  conditioningTextNodeIds,
  resolveCustomNodeTargets,
  inspectCustomWorkflow,
  IMAGE_INPUT_RE,
  CONTROLNET_RE,
  MODEL_LOADER_INPUTS,
  findModelLoaders,
  applyModelOverride,
  findImageLoaderNodes,
  applyImageInputs,
  applyDenoise,
  analyzeWorkflow,
  inspectWorkflowFile,
}
