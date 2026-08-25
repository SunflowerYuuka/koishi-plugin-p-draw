// ComfyUI 工作流构建（移植自 anima comfyui_workflows）。
// 纯函数，不依赖 koishi；customWorkflow 需要 fs/path。

const fs = require('fs')
const path = require('path')

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
  // lib/ 子目录下运行，customWorkflowPath 相对插件根目录，故需要回退一层
  const rawPath = path.resolve(__dirname, '..', cfg.customWorkflowPath)
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

module.exports = {
  animaT2IWorkflow,
  buildWorkflow,
  animaI2IWorkflow,
  animaStyleI2IWorkflow,
  animaOotdI2IWorkflow,
  buildI2IWorkflow,
  customWorkflow,
  conditioningTextNodeIds,
}
