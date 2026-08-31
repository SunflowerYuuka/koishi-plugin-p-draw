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

function buildWorkflow(cfg, prompt, negativePrompt, width, height, steps, cfgVal, seed, explicitSize) {
  if (cfg.customWorkflowEnabled && cfg.customWorkflowPath) {
    return customWorkflow(cfg, prompt, negativePrompt, width, height, steps, cfgVal, seed, explicitSize)
  }
  const normalizedModel = String(cfg.unetName || '').trim().toLowerCase().replace(/[-_]/g, '~')
  if (normalizedModel === 'animagine~xl~3.1.safetensors') {
    return animagineT2IWorkflow(cfg, prompt, negativePrompt, width, height, steps, cfgVal, seed)
  }
  return animaT2IWorkflow(cfg, prompt, negativePrompt, width, height, steps, cfgVal, seed)
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
  animagineT2IWorkflow,
  buildWorkflow,
  customWorkflow,
  conditioningTextNodeIds,
}
