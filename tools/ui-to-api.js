// UI(workflow) → API(prompt) 转换器
//
// 用法：
//   node tools/ui-to-api.js <源UI.json> <输出API.json> [要删除的节点ID,逗号分隔] [模型名]
// 例：
//   node tools/ui-to-api.js 官方.json 01-upscale.json 21,8,35,10,11,12 anima-aesthetic-v1.1.safetensors
//
// 规则：
//   1) 连线按 UI 节点 inputs 数组里的“名字”取来源，不用 schema 下标
//   2) 是 widget 类型的输入，无论是否被接成连线，都在 widgets_values 里占一格 → 一律先消耗
//   3) seed / noise_seed 后面还有一个隐藏的 control_after_generate 值，要再跳过一格
//   4) bypass(mode 4) 节点按“同类型输入透传”重连，并且本身不出现在 API 里
const fs = require('fs')

const BASE = process.env.COMFY_URL || 'http://127.0.0.1:8188'
const SRC = process.argv[2]
const OUT = process.argv[3]
const DROP_NODES = new Set((process.argv[4] || '').split(',').map(s => s.trim()).filter(Boolean).map(Number))
const MODEL_NAME = (process.argv[5] || '').trim()
const SEED_NAMES = new Set(['seed', 'noise_seed'])

if (!SRC || !OUT) {
  console.error('用法: node tools/ui-to-api.js <源UI.json> <输出API.json> [删除节点ID,逗号分隔] [模型名]')
  process.exit(1)
}

const LINK_TYPES = new Set([
  'MODEL', 'CLIP', 'VAE', 'LATENT', 'IMAGE', 'MASK', 'CONDITIONING', 'CONTROL_NET',
  'UPSCALE_MODEL', 'CLIP_VISION', 'CLIP_VISION_OUTPUT', 'SIGMAS', 'SAMPLER', 'GUIDER',
  'NOISE', 'SEGS', 'DETAILER_PIPE', 'BASIC_PIPE', 'PIPE', 'STYLE_MODEL', 'T2I_ADAPTER',
  'MASK_LIST', 'AUDIO', 'VIDEO', 'IMAGE_LIST', 'WEBCAM',
])

function isWidgetSpec(spec) {
  if (!Array.isArray(spec)) return false
  const head = spec[0]
  if (Array.isArray(head)) return true
  if (typeof head === 'string' && LINK_TYPES.has(head)) return false
  return typeof head === 'string'
}

// 旁路节点可能串联（A 旁路 → B 旁路 → 消费者），要一路追到真正的源头
function resolveSource(map, target, seen = new Set()) {
  const key = `${target[0]}:${target[1]}`
  if (seen.has(key)) return target
  seen.add(key)
  const pass = map.get(key)
  return pass ? resolveSource(map, pass, seen) : target
}

;(async () => {
  const oi = await fetch(BASE + '/object_info').then(r => r.json())
  const ui = JSON.parse(fs.readFileSync(SRC, 'utf-8'))
  const nodes = ui.nodes.filter(n => !DROP_NODES.has(n.id))
  const keptLinks = ui.links.filter(l => !DROP_NODES.has(l[1]) && !DROP_NODES.has(l[3]))
  const linkById = new Map(keptLinks.map(l => [l[0], l]))

  // 节点 -> { 输入名: [源节点, 源slot] }
  const srcByName = new Map()
  for (const node of nodes) {
    const m = {}
    for (const inp of node.inputs || []) {
      if (inp.link == null) continue
      const l = linkById.get(inp.link)
      if (l) m[inp.name] = [String(l[1]), l[2]]
    }
    srcByName.set(String(node.id), m)
  }

  // bypass 透传："nodeId:outSlot" -> [源节点, 源slot]
  const bypassMap = new Map()
  for (const node of nodes) {
    if (node.mode !== 4) continue
    const m = srcByName.get(String(node.id)) || {}
    const outs = node.outputs || []
    outs.forEach((out, outSlot) => {
      const matchName = Object.keys(m).find((name) => {
        const inpDef = (node.inputs || []).find(i => i.name === name)
        return inpDef && inpDef.type === out.type
      })
      if (matchName) bypassMap.set(`${node.id}:${outSlot}`, m[matchName])
    })
  }

  const api = {}
  for (const node of nodes) {
    if (node.mode === 4) continue
    const def = oi[node.type]
    if (!def) { console.log(`!! 未知节点 ${node.type} #${node.id}`); continue }
    const ordered = [
      ...Object.entries(def.input.required || {}),
      ...Object.entries(def.input.optional || {}),
    ]
    const m = srcByName.get(String(node.id)) || {}
    const widgets = Array.isArray(node.widgets_values) ? node.widgets_values
      : (node.widgets_values && typeof node.widgets_values === 'object' ? Object.values(node.widgets_values) : [])

    const inputs = {}
    let w = 0
    for (const [name, spec] of ordered) {
      if (!isWidgetSpec(spec)) {
        if (m[name]) inputs[name] = resolveSource(bypassMap, m[name])
        continue
      }
      // widget 型输入：先消耗格子
      if (w >= widgets.length) continue
      let value = widgets[w]
      w++
      if (SEED_NAMES.has(name) && w < widgets.length) w++   // control_after_generate
      if (m[name]) {                                        // 被接成连线
        inputs[name] = resolveSource(bypassMap, m[name])
        continue
      }
      const ov = MODEL_NAME && (name === 'unet_name' || name === 'ckpt_name')
      if (ov) value = MODEL_NAME
      inputs[name] = value
    }
    api[String(node.id)] = { class_type: node.type, inputs }
  }

  fs.writeFileSync(OUT, JSON.stringify(api, null, 2))
  console.log('写入节点数:', Object.keys(api).length)
  for (const k of ['22', '7', '8', '10', '24', '2', '3', '4']) {
    if (api[k]) console.log(`  #${k} ${api[k].class_type}: ${JSON.stringify(api[k].inputs).slice(0, 200)}`)
  }

  // 默认只写文件；要提交到 ComfyUI 做校验，设 COMFY_VALIDATE=1
  if (process.env.COMFY_VALIDATE !== '1') {
    console.log('\n已写入文件（未提交校验；设 COMFY_VALIDATE=1 可顺带提交到 ComfyUI 校验）')
    return
  }
  const res = await fetch(BASE + '/prompt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: api, client_id: 'pdraw-01api3' }),
  })
  const txt = await res.text()
  const j = JSON.parse(txt)
  console.log('\n提交 HTTP', res.status, ' prompt_id:', j.prompt_id)
  const errs = j.node_errors || {}
  console.log('node_errors:', Object.keys(errs).length ? JSON.stringify(errs).slice(0, 1200) : '无 ✓')
})()
