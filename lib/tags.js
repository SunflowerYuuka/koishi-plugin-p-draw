// Tag 清洗纯函数库（移植自 anima tag_cleaner）。
// 不依赖 koishi，可独立单测。

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

// 用户明确表示「不要画师 / 不要风格」时的守卫正则。
// 语义说明：这与负面词里的 artist name（不要画师署名/水印）是两回事；
// 只有用户明确说了这些词才跳过画师/风格 tags，其余情况画师 tags 正常拼接。
const NO_ARTIST_RE = /(不用我的风格|不要我的风格|不使用我的风格|不要画师|不用画师|不加画师|不要画师词|不用画师词|不加画师词|no artist)/i
const NO_STYLE_RE = /(不用我的风格|不要我的风格|不使用我的风格)/i

function appendInlineProtectedTags(prompt, original, raw) {
  if (raw || !original) return prompt
  if (NO_ARTIST_RE.test(original)) return prompt
  const tags = []
  const seen = new Set(splitTags(prompt).map(t => normalizeTagKey(t)))
  const addArtist = (artist) => {
    const key = normalizeTagKey(artist)
    if (!seen.has(key)) {
      seen.add(key)
      tags.push(artist)
    }
  }
  const addQuality = (t) => {
    const key = normalizeTagKey(t)
    if (!seen.has(key)) {
      seen.add(key)
      tags.push(t)
    }
  }
  // 逗号分隔的显式 token
  for (const token of splitTags(original)) {
    const t = String(token || '').trim()
    if (!t) continue
    const artist = normalizeAnimaArtistTag(t)
    if (artist.startsWith('@')) {
      addArtist(artist)
      continue
    }
    if (INLINE_QUALITY_RE.test(t)) addQuality(t)
  }
  // 修复：未用逗号分隔的内联 @artist（如「帮我画一个@wlop风格的女孩」）也会被保留
  const inlineMatches = String(original).match(/@[^\s,，、;；@]+/g) || []
  for (const rawArtist of inlineMatches) {
    const artist = normalizeAnimaArtistTag(rawArtist)
    if (artist.startsWith('@')) addArtist(artist)
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

module.exports = {
  splitTags,
  normalizeTagKey,
  stripWrappingBrackets,
  ARTIST_FUNCTION_RE,
  normalizeAnimaArtistTag,
  canonicalTagText,
  INLINE_QUALITY_RE,
  NO_ARTIST_RE,
  NO_STYLE_RE,
  appendInlineProtectedTags,
  QUALITY_BLOCKLIST,
  CHARACTER_BLOCKLIST,
  CHARACTER_IDENTITY_EXACT_BLOCKLIST,
  CHARACTER_IDENTITY_PATTERNS,
  MULTI_CHARACTER_BLOCKLIST,
  NON_VISUAL_TAGS,
  EXCLUSIVE_TAG_GROUPS,
  TAG_GROUP_LIMITS,
  isCharacterIdentityTag,
  cleanContentTags,
  joinPromptParts,
}
