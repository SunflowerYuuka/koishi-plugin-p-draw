// 解析器纯函数库：地址/尺寸/批量/seed/raw 前缀/tag 合并/预设解析。
// 不依赖 koishi，可独立单测。

// ------------------------------------------------------------------
// 地址规范化
// ------------------------------------------------------------------
function normalizeBaseUrl(raw) {
  let value = String(raw || '').trim()
  if (!value) value = 'http://127.0.0.1:8188'
  // 保留用户声明的协议（http/https），其余部分清理重复协议头。
  // 修复：原实现会把 https:// 降级成 http://，反向代理/加密链路下会连不上。
  const protocol = /^https?:\/\//i.test(value) ? value.slice(0, value.indexOf('://') + 3).toLowerCase() : 'http://'
  value = value.replace(/^https?:\/\//i, '')
  // 清理重复协议头，例如 http://http://host 或 http://https://host
  value = value.replace(/^https?:\/\//i, '')
  return (protocol + value).replace(/\/+$/, '')
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

// 将用户手写的正负面区块拆开。只识别独立行标记，避免把普通 tag（如 negative space）误判为负面段。
const NEGATIVE_SECTION_RE = /(?:^|\r?\n)\s*(?:negative(?:\s*prompt)?|negative_prompt|负面(?:提示词|词)?)\s*[:：]\s*/i

function splitPositiveNegativePrompt(prompt) {
  const text = String(prompt || '').trim()
  const match = NEGATIVE_SECTION_RE.exec(text)
  if (!match) return { positive: text, negative: '' }
  return {
    positive: text.slice(0, match.index).trim(),
    negative: text.slice(match.index + match[0].length).trim(),
  }
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

function parsePresetListRaw(list) {
  const result = {}
  for (const item of list || []) {
    const text = String(item || '').trim()
    if (!text) continue
    const parsed = parseNameTags(text)
    if (parsed) result[parsed.name] = parsed.tags
  }
  return result
}

// 预设列表解析带缓存：cfg.fixedCharacters / cfg.artistPresets 在持久化时整体替换（不原地修改），
// 用 WeakMap 按数组引用缓存解析结果，热路径（composePrompt/多人规划/批量）不再重复 split。
const presetListCache = new WeakMap()
function parsePresetList(list) {
  if (list && typeof list === 'object' && presetListCache.has(list)) {
    return presetListCache.get(list)
  }
  const result = parsePresetListRaw(list)
  if (list && typeof list === 'object') presetListCache.set(list, result)
  return result
}

module.exports = {
  normalizeBaseUrl,
  SIZE_ALIASES,
  SIZE_VALUE_PATTERN,
  escapeRe,
  parseGenerationSize,
  BATCH_TOKEN_PATTERNS,
  CN_NUM_MAP,
  cnNumValue,
  parseBatchCount,
  parseSeed,
  RAW_PREFIXES,
  stripRawPrefix,
  splitPositiveNegativePrompt,
  mergeTagText,
  parseNameTags,
  parsePresetList,
}
