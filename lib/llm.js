// LLM 通道与模型回退。
//
// 一个「通道」= 一组 baseUrl + apiKey；通道内可以填多个模型名。
// 调用顺序：主通道的模型逐个试 → 全挂 → 下一个通道的模型逐个试。
// 纯函数 + 一个 runner，不依赖 koishi，可独立单测。

const THINKING_MODES = new Set(['auto', 'always', 'never'])

// 支持数组或逗号/换行分隔的字符串
function splitModelList(value) {
  const out = []
  const push = (item) => {
    const text = String(item == null ? '' : item).trim()
    if (text && !out.includes(text)) out.push(text)
  }
  if (Array.isArray(value)) value.forEach(push)
  else if (typeof value === 'string') value.split(/[,，\n]/).forEach(push)
  return out
}

function normalizeBaseUrl(value) {
  return String(value == null ? '' : value).trim().replace(/\/+$/, '')
}

// 通道的模型列表：models（数组）优先，兼容旧的单个 model 字段
function channelModels(channel) {
  const models = splitModelList(channel && channel.models)
  for (const model of splitModelList(channel && channel.model)) {
    if (!models.includes(model)) models.push(model)
  }
  return models
}

// 附加通道，按 llmChannelOrder 排序；未列出的通道补在后面，避免漏配就丢通道
function collectChannels(cfg, role) {
  const isVision = role === 'vision'
  const dict = isVision ? cfg.verifyLlmChannels : cfg.llmChannels
  if (!dict || typeof dict !== 'object') return []
  const declared = splitModelList(isVision ? cfg.verifyLlmChannelOrder : cfg.llmChannelOrder)
  const names = declared.filter(name => dict[name])
  for (const name of Object.keys(dict)) {
    if (!names.includes(name)) names.push(name)
  }
  return names.map(name => ({ name, channel: dict[name] }))
}

// 摊平成有序候选链：[{ baseUrl, apiKey, model, label }]
function buildLlmChain(cfg, role = 'text') {
  const c = cfg || {}
  const isVision = role === 'vision'
  const primaryBase = normalizeBaseUrl(isVision ? c.verifyLlmBaseUrl : c.llmBaseUrl)
  const primaryKey = String((isVision ? c.verifyLlmApiKey : c.llmApiKey) || '').trim()
  const primaryModels = channelModels({
    models: isVision ? c.verifyLlmModels : c.llmModels,
    model: isVision ? c.verifyLlmModel : c.llmModel,
  })

  const candidates = []
  const seen = new Set()
  const add = (baseUrl, apiKey, model, label, proxy) => {
    const base = normalizeBaseUrl(baseUrl)
    if (!base || !model) return
    const key = [base, String(apiKey || ''), model].join('\u0000')
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({ baseUrl: base, apiKey: String(apiKey || ''), model, label: label || base, proxy: String(proxy || '').trim() })
  }

  for (const model of primaryModels) add(primaryBase, primaryKey, model, '主通道', '')
  for (const { name, channel } of collectChannels(c, role)) {
    const base = channel && channel.baseUrl
    const key = channel && channel.apiKey
    // 通道可以单独指定代理；留空则用该用途的默认代理（由调用方决定）
    const channelProxy = channel && channel.proxy
    for (const model of channelModels(channel)) add(base, key, model, name, channelProxy)
  }
  return candidates
}

function hasLlm(cfg, role = 'text') {
  return buildLlmChain(cfg, role).length > 0
}

function resolveThinkingMode(value) {
  const mode = String(value == null ? '' : value).trim().toLowerCase()
  return THINKING_MODES.has(mode) ? mode : 'auto'
}

// thinking 是 DeepSeek 专有字段，别的模型 / 中转站带上通常直接 400。
// auto：只有当 baseUrl 或模型名看起来是 DeepSeek 时才发。
function shouldSendThinking(cfg, candidate) {
  const mode = resolveThinkingMode(cfg && cfg.llmThinking)
  if (mode === 'always') return true
  if (mode === 'never') return false
  const haystack = `${(candidate && candidate.baseUrl) || ''} ${(candidate && candidate.model) || ''}`.toLowerCase()
  return haystack.includes('deepseek')
}

function parseExtraBody(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return {}
  try {
    const data = JSON.parse(raw)
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  } catch (e) {
    return {}
  }
}

// 请求体：基础字段 + 条件性 thinking + 用户自定义附加参数（最后覆盖）
function buildChatBody(cfg, { candidate, messages, maxTokens, defaultMaxTokens = 700 }) {
  const body = {
    model: candidate.model,
    messages,
    max_tokens: Math.max(64, parseInt(maxTokens) || defaultMaxTokens),
  }
  if (shouldSendThinking(cfg, candidate)) body.thinking = { type: 'disabled' }
  return Object.assign(body, parseExtraBody(cfg && cfg.llmExtraBody))
}

// 依次尝试候选；attempt 抛错即视为该候选失败，继续下一个。
// 返回 { ok, candidate, value, errors }，errors 里保留每次失败原因便于诊断。
async function runLlmChain(candidates, attempt, { onError } = {}) {
  const errors = []
  for (const candidate of candidates) {
    try {
      const value = await attempt(candidate)
      return { ok: true, candidate, value, errors }
    } catch (e) {
      const message = String((e && e.message) || e || 'unknown')
      errors.push({ model: candidate.model, label: candidate.label, message })
      if (typeof onError === 'function') {
        try { onError(candidate, message) } catch (err) { /* ignore */ }
      }
    }
  }
  return { ok: false, candidate: null, value: null, errors }
}

module.exports = {
  THINKING_MODES,
  splitModelList,
  normalizeBaseUrl,
  channelModels,
  collectChannels,
  buildLlmChain,
  hasLlm,
  resolveThinkingMode,
  shouldSendThinking,
  parseExtraBody,
  buildChatBody,
  runLlmChain,
}
