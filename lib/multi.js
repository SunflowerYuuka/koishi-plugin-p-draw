// 多人规划纯函数库（移植自 anima multi_person_prompt / command_actions）。
// 不依赖 koishi，可独立单测。

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
    explicitPositions = false, identityAnchors = [], includePose = true, asTagStream = false,
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
  if (asTagStream) return [label, joined].filter(Boolean).join(', ')
  return `${label}: ${joined}.`
}

// ------------------------------------------------------------------
// 多人尺寸自动选择（移植自 anima command_actions multi_person 分支）
// ------------------------------------------------------------------
function multiPersonAutoSize(prompt, allowedSizes) {
  if (!Array.isArray(allowedSizes) || !allowedSizes.length) return null
  const promptLower = String(prompt || '').toLowerCase()
  // 修复：JS 中 \b 边界不识别 CJK（三/四 与两侧都非 \w，\b 永远不成立），
  // 导致「三个人/四人」等中文人数无法触发宽屏尺寸。改用否定数字 lookbehind 匹配。
  const threeOrMore = /(?<!\d)(?:三|四)\s*(?:人|个|名)|(?<!\d)(?:3|4)(?:\s*(?:人|个|名)|(?:girls?|boys?|people))\b/i.test(promptLower)
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

module.exports = {
  MULTI_PERSON_NEGATIVE_TAGS,
  MULTI_SAFE_SLOTS,
  MULTI_UNSAFE_COMPOSITION_MARKERS,
  MULTI_SAFE_SPATIAL_MODES,
  buildMultiPersonPlanPrompt,
  cleanMultiText,
  multiStringTuple,
  normalizeMultiSlot,
  parseMultiPersonPlan,
  renderMultiPersonCharacter,
  multiPersonAutoSize,
}
