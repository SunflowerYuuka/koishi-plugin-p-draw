'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')

const parse = require('../lib/parse')
const tags = require('../lib/tags')
const wf = require('../lib/workflows')
const comfy = require('../lib/comfy')
const multi = require('../lib/multi')
const llm = require('../lib/llm')
const net = require('../lib/net')

// 统一的测试临时目录：进程退出时自动清理，避免在系统临时目录留下垃圾
const tempDirs = []
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
process.on('exit', () => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) { /* ignore */ }
  }
})

// ---------------- parse.js ----------------

test('normalizeBaseUrl', () => {
  assert.strictEqual(parse.normalizeBaseUrl('http://http://host:8188'), 'http://host:8188')
  assert.strictEqual(parse.normalizeBaseUrl('https://host/'), 'https://host')
  assert.strictEqual(parse.normalizeBaseUrl('host:8188'), 'http://host:8188')
  assert.strictEqual(parse.normalizeBaseUrl(''), 'http://127.0.0.1:8188')
})

test('parseGenerationSize explicit WxH', () => {
  const allowed = [[832, 1216], [1024, 1024], [1216, 832], [1024, 1536]]
  const r = parse.parseGenerationSize('1024x1536：一个女孩', allowed)
  assert.deepStrictEqual(r.size, [1024, 1536])
  assert.strictEqual(r.error, null)
  assert.ok(!r.prompt.includes('1024x1536'))
})

test('parseGenerationSize --尺寸', () => {
  const allowed = [[832, 1216], [1024, 1024]]
  const r = parse.parseGenerationSize('画一个女孩 --尺寸 1216x832', allowed)
  assert.ok(r.error.includes('不可用'))
  assert.strictEqual(r.size, null)
})

test('parseGenerationSize alias 竖图', () => {
  const allowed = [[832, 1216], [1152, 896], [1024, 1024]]
  const r = parse.parseGenerationSize('竖图：狐莉站在树下', allowed)
  assert.deepStrictEqual(r.size, [832, 1216])
  assert.ok(!r.prompt.includes('竖图'))
})

test('parseBatchCount', () => {
  assert.strictEqual(parse.parseBatchCount('一个女孩 x3', 4).count, 3)
  assert.strictEqual(parse.parseBatchCount('一个女孩 3张', 4).count, 3)
  assert.strictEqual(parse.parseBatchCount('一个女孩 三张', 4).count, 3)
  assert.strictEqual(parse.parseBatchCount('一个女孩 --数量 5', 4).count, 4)
  assert.strictEqual(parse.parseBatchCount('一个女孩 x3', 4).clamped, false)
  assert.strictEqual(parse.parseBatchCount('一个女孩 x9', 4).clamped, true)
  assert.strictEqual(parse.parseBatchCount('一个女孩', 4).count, 1)
})

test('parseSeed', () => {
  assert.strictEqual(parse.parseSeed('画 --seed 17021628').seed, 17021628)
  assert.strictEqual(parse.parseSeed('画 --seed=123').seed, 123)
  assert.strictEqual(parse.parseSeed('画 --seed:456').seed, 456)
  assert.strictEqual(parse.parseSeed('画一个女孩').seed, null)
  assert.ok(!parse.parseSeed('画 --seed 99').prompt.includes('--seed'))
})

test('stripRawPrefix', () => {
  assert.strictEqual(parse.stripRawPrefix('无优化 masterpiece, 1girl').raw, true)
  assert.strictEqual(parse.stripRawPrefix('raw tags, solo').raw, true)
  assert.strictEqual(parse.stripRawPrefix('一个女孩').raw, false)
})

test('splitPositiveNegativePrompt separates a standalone negative block', () => {
  const result = parse.splitPositiveNegativePrompt('masterpiece, 1girl, cat ears\n\nnegative:\nworst quality, bad anatomy, extra fingers')
  assert.strictEqual(result.positive, 'masterpiece, 1girl, cat ears')
  assert.strictEqual(result.negative, 'worst quality, bad anatomy, extra fingers')
})

test('splitPositiveNegativePrompt supports Chinese markers and does not split ordinary text', () => {
  const chinese = parse.splitPositiveNegativePrompt('1girl\n负面提示词：\nblurry, watermark')
  assert.strictEqual(chinese.positive, '1girl')
  assert.strictEqual(chinese.negative, 'blurry, watermark')
  const ordinary = parse.splitPositiveNegativePrompt('1girl, negative space, dark background')
  assert.strictEqual(ordinary.positive, '1girl, negative space, dark background')
  assert.strictEqual(ordinary.negative, '')
})

test('mergeTagText dedup', () => {
  const merged = parse.mergeTagText('@a, @b,', '@b, @c')
  assert.ok(merged.includes('@a'))
  assert.ok(merged.includes('@b'))
  assert.ok(merged.includes('@c'))
  assert.strictEqual(merged.split('@').length - 1, 3)
})

test('parseNameTags / parsePresetList', () => {
  assert.deepStrictEqual(parse.parseNameTags('狐莉=1girl, solo'), { name: '狐莉', tags: '1girl, solo' })
  assert.deepStrictEqual(parse.parseNameTags('千代风格：@a, @b'), { name: '千代风格', tags: '@a, @b' })
  const presets = parse.parsePresetList(['A=@a,', 'B=@b'])
  assert.deepStrictEqual(presets, { A: '@a,', B: '@b' })
})

test('parsePresetList memo returns same identity', () => {
  const list = ['A=@a', 'B=@b']
  const r1 = parse.parsePresetList(list)
  const r2 = parse.parsePresetList(list)
  assert.strictEqual(r1, r2)
})

// ---------------- tags.js ----------------

test('splitTags', () => {
  assert.deepStrictEqual(tags.splitTags('a, b，c、d\ne'), ['a', 'b', 'c', 'd', 'e'])
  assert.deepStrictEqual(tags.splitTags('prompt: x, y'), ['x', 'y'])
})

test('normalizeTagKey / canonicalTagText', () => {
  assert.strictEqual(tags.normalizeTagKey('(white hair:1.2)'), 'white hair')
  assert.strictEqual(tags.canonicalTagText('1 girl'), '1girl')
  assert.strictEqual(tags.canonicalTagText('@wlop'), '@wlop')
  assert.strictEqual(tags.normalizeAnimaArtistTag('artist:wlop'), '@wlop')
  assert.strictEqual(tags.normalizeAnimaArtistTag('@wlop_art'), '@wlop art')
})

test('appendInlineProtectedTags', () => {
  const base = 'masterpiece, 1girl, blue eyes'
  const out = tags.appendInlineProtectedTags(base, '一个女孩 @wlop', false)
  assert.ok(out.includes('@wlop'))
  // 未用逗号分隔的内联 @artist 也会保留
  const out0 = tags.appendInlineProtectedTags(base, '帮我画一个@wlop风格的女孩', false)
  assert.ok(out0.includes('@wlop'))
  // quality 与已存在的不重复
  assert.ok(out.startsWith(base))
  // 已存在时不再追加
  const out2 = tags.appendInlineProtectedTags('@wlop, 1girl', '@wlop', false)
  assert.strictEqual(out2, '@wlop, 1girl')
  // no artist 守卫
  assert.strictEqual(tags.appendInlineProtectedTags(base, '不要画师 @wlop', false), base)
  // raw 模式直接返回
  assert.strictEqual(tags.appendInlineProtectedTags(base, 'x @wlop', true), base)
})

test('cleanContentTags', () => {
  const r = tags.cleanContentTags('masterpiece, 1girl, solo, blue eyes, white hair, white hair, 2girls, night, sky')
  assert.ok(!r.includes('masterpiece'))
  assert.ok(!r.includes('1girl'))
  assert.ok(!r.includes('2girls'))
  // 角色外观 tag（blue eyes / white hair）作为身份 tag 被剥离、并去重
  assert.ok(!r.includes('white hair'))
  assert.ok(r.includes('night'))
  assert.ok(r.includes('sky'))
})

test('joinPromptParts dedup', () => {
  const r = tags.joinPromptParts(['masterpiece, 1girl, blue eyes', 'blue eyes, red dress', '1 girl'])
  assert.strictEqual(r.split('blue eyes').length - 1, 1)
  assert.strictEqual(r.split('1girl').length - 1, 1)
})

test('mergeNegativePrompts keeps defaults and appends only new user tags', () => {
  const merged = tags.mergeNegativePrompts(
    'worst quality, low quality, score_1, artist name',
    'low quality, bad anatomy, bad hands, watermark',
  )
  assert.strictEqual(merged, 'worst quality, low quality, score_1, artist name, bad anatomy, bad hands, watermark')
  assert.strictEqual(tags.mergeNegativePrompts('worst quality, low quality', ''), 'worst quality, low quality')
})

// ---------------- workflows.js ----------------

function baseCfg(extra = {}) {
  return Object.assign({
    unetName: 'anima-base-v1.0.safetensors',
    clipName: 'qwen_3_06b_base.safetensors',
    vaeName: 'qwen_image_vae.safetensors',
    samplerName: 'er_sde',
    scheduler: 'simple',
    customWorkflowEnabled: false,
    customWorkflowPath: '',
    customWorkflowOverrideParameters: false,
  }, extra)
}

test('animaT2IWorkflow structure', () => {
  const w = wf.animaT2IWorkflow(baseCfg(), 'p', 'n', 832, 1216, 30, 4.5, 123)
  assert.strictEqual(w['44'].class_type, 'UNETLoader')
  assert.strictEqual(w['19'].inputs.model[0], '44')
  assert.strictEqual(w['19'].inputs.positive[0], '11')
  assert.strictEqual(w['19'].inputs.negative[0], '12')
  assert.strictEqual(w['11'].inputs.text, 'p')
  assert.strictEqual(w['12'].inputs.text, 'n')
  assert.strictEqual(w['28'].inputs.width, 832)
})

test('animagineT2IWorkflow builds a checkpoint SDXL graph', () => {
  const w = wf.animagineT2IWorkflow(baseCfg({ unetName: 'animagine-xl-3.1.safetensors', samplerName: 'dpmpp_2m', scheduler: 'karras' }), '1girl', 'bad anatomy', 1024, 1536, 28, 7, 123)
  const checkpoint = Object.entries(w).find(([, node]) => node.class_type === 'CheckpointLoaderSimple')
  const latent = Object.entries(w).find(([, node]) => node.class_type === 'EmptyLatentImage')
  const sampler = Object.entries(w).find(([, node]) => node.class_type === 'KSampler')
  const decoded = Object.entries(w).find(([, node]) => node.class_type === 'VAEDecode')
  const saved = Object.entries(w).find(([, node]) => node.class_type === 'SaveImage')

  assert.ok(checkpoint)
  assert.strictEqual(checkpoint[1].inputs.ckpt_name, 'animagine-xl-3.1.safetensors')
  assert.strictEqual(latent[1].inputs.width, 1024)
  assert.strictEqual(latent[1].inputs.height, 1536)
  assert.deepStrictEqual(sampler[1].inputs.latent_image, [latent[0], 0])
  assert.strictEqual(sampler[1].inputs.steps, 28)
  assert.strictEqual(sampler[1].inputs.cfg, 7)
  assert.strictEqual(sampler[1].inputs.sampler_name, 'dpmpp_2m')
  assert.strictEqual(sampler[1].inputs.scheduler, 'karras')
  assert.strictEqual(sampler[1].inputs.seed, 123)
  assert.deepStrictEqual(decoded[1].inputs.samples, [sampler[0], 0])
  assert.strictEqual(saved[1].inputs.filename_prefix, 'pdraw/animagine')
})

test('buildWorkflow routes normalized Animagine names while retaining Anima routing', () => {
  const animagine = wf.buildWorkflow(baseCfg({ unetName: 'ANIMAGINE_XL_3.1.SAFETENSORS' }), 'p', 'n', 832, 1216, 30, 4.5, 123, false)
  const anima = wf.buildWorkflow(baseCfg(), 'p', 'n', 832, 1216, 30, 4.5, 123, false)

  assert.ok(Object.values(animagine).some(node => node.class_type === 'CheckpointLoaderSimple'))
  assert.strictEqual(anima['44'].class_type, 'UNETLoader')
})

test('buildWorkflow keeps custom workflow precedence over Animagine routing', () => {
  const dir = tmpDir('pdrawtest-wf-')
  const file = path.join(dir, 'wf.json')
  fs.writeFileSync(file, JSON.stringify({
    '1': { class_type: 'KSampler', inputs: { positive: ['10', 0], negative: ['11', 0], seed: 0 } },
    '10': { class_type: 'CLIPTextEncode', inputs: { text: 'old', clip: ['2', 0] } },
    '11': { class_type: 'CLIPTextEncode', inputs: { text: 'old negative', clip: ['2', 0] } },
  }))

  const w = wf.buildWorkflow(baseCfg({
    unetName: 'animagine-xl-3.1.safetensors',
    customWorkflowEnabled: true,
    customWorkflowPath: file,
  }), 'p', 'n', 832, 1216, 30, 4.5, 123, false)

  assert.strictEqual(w['1'].class_type, 'KSampler')
  assert.strictEqual(w['10'].inputs.text, 'p')
})

test('customWorkflow injects text and throws on missing nodes', () => {
  const dir = tmpDir('pdrawtest-wf-')
  const json = {
    '1': { class_type: 'KSampler', inputs: { model: ['2', 0], positive: ['10', 0], negative: ['11', 0], seed: 0 } },
    '10': { class_type: 'CLIPTextEncode', inputs: { text: 'OLD', clip: ['45', 0] } },
    '11': { class_type: 'CLIPTextEncode', inputs: { text: 'OLDN', clip: ['45', 0] } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'orig' } },
  }
  const file = path.join(dir, 'wf.json')
  fs.writeFileSync(file, JSON.stringify(json))
  const cfg = baseCfg({ customWorkflowEnabled: true, customWorkflowPath: file, customWorkflowOverrideParameters: true })
  const w = wf.customWorkflow(cfg, 'NEW', 'NEWN', 832, 1216, 30, 4.5, 42, true)
  assert.strictEqual(w['10'].inputs.text, 'NEW')
  assert.strictEqual(w['11'].inputs.text, 'NEWN')
  assert.strictEqual(w['9'].inputs.filename_prefix, 'pdraw/anm')
  assert.strictEqual(w['1'].inputs.seed, 42)
  // 找不到正面节点 -> 抛错
  const badFile = path.join(dir, 'bad.json')
  fs.writeFileSync(badFile, JSON.stringify({ '1': { class_type: 'KSampler', inputs: { positive: ['10', 0] } } }))
  assert.throws(() => wf.customWorkflow(baseCfg({ customWorkflowEnabled: true, customWorkflowPath: badFile }), 'p', 'n', 1, 1, 1, 1, 1, false), /找不到正面提示词节点/)
})

// ---------------- workflows.js：自定义工作流（Design.md A1/A2/A3/A5/A6/A7） ----------------

// 贴近 Aesthetic 1.1 Text-to-Image Baseline 的最小节点表（节点 ID 仅测试用，不代表真实导出）
function baselineGraph() {
  return {
    '44': { class_type: 'UNETLoader', inputs: { unet_name: 'anima-aesthetic-v1.1.safetensors', weight_dtype: 'default' } },
    '45': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_06b_base.safetensors', type: 'stable_diffusion' } },
    '15': { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'old positive', clip: ['45', 0] }, _meta: { title: 'CLIP Text Encode (Positive Prompt)' } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: 'old negative', clip: ['45', 0] }, _meta: { title: 'CLIP Text Encode (Negative Prompt)' } },
    '3': { class_type: 'KSampler', inputs: { model: ['44', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0], seed: 1, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['15', 0] } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'ComfyUI' } },
  }
}

function writeWorkflowFile(dir, name, json) {
  const file = path.join(dir, name)
  fs.writeFileSync(file, JSON.stringify(json))
  return file
}

test('isGgufUnet resolves auto / true / false', () => {
  assert.strictEqual(wf.isGgufUnet({ unetName: 'anima-aesthetic-v1.1-Q8_0.gguf' }), true)
  assert.strictEqual(wf.isGgufUnet({ unetName: 'X.GGUF' }), true)
  assert.strictEqual(wf.isGgufUnet({ unetName: 'anima-aesthetic-v1.1.safetensors' }), false)
  assert.strictEqual(wf.isGgufUnet({ unetName: 'x.safetensors', useGgufUnet: 'true' }), true)
  assert.strictEqual(wf.isGgufUnet({ unetName: 'x.gguf', useGgufUnet: 'false' }), false)
})

test('animaT2IWorkflow switches loader to UnetLoaderGGUF for .gguf models (A2)', () => {
  const gguf = wf.animaT2IWorkflow(baseCfg({ unetName: 'anima-aesthetic-v1.1-Q8_0.gguf' }), 'p', 'n', 1024, 1024, 30, 4, 7)
  assert.strictEqual(gguf['44'].class_type, 'UnetLoaderGGUF')
  assert.strictEqual(gguf['44'].inputs.unet_name, 'anima-aesthetic-v1.1-Q8_0.gguf')
  // GGUF loader 不接受 weight_dtype
  assert.strictEqual('weight_dtype' in gguf['44'].inputs, false)
  // KSampler 链路不变
  assert.strictEqual(gguf['19'].inputs.model[0], '44')

  const sft = wf.animaT2IWorkflow(baseCfg(), 'p', 'n', 1024, 1024, 30, 4, 7)
  assert.strictEqual(sft['44'].class_type, 'UNETLoader')
})

test('resolveCustomWorkflowPath prefers Koishi baseDir, then plugin dir', () => {
  const baseDir = tmpDir('pdrawtest-base-')
  const nested = path.join(baseDir, 'data', 'p-draw', 'workflows')
  fs.mkdirSync(nested, { recursive: true })
  const target = path.join(nested, 'anima-aesthetic-v1.1.json')
  fs.writeFileSync(target, JSON.stringify(baselineGraph()))

  // A5 的相对路径按运行目录解析
  assert.strictEqual(
    wf.resolveCustomWorkflowPath({ customWorkflowPath: 'data/p-draw/workflows/anima-aesthetic-v1.1.json' }, { baseDir }),
    target,
  )
  // 绝对路径直接使用
  assert.strictEqual(wf.resolveCustomWorkflowPath({ customWorkflowPath: target }, {}), target)
  // 空路径 / 缺失文件都要明确报错
  assert.throws(() => wf.resolveCustomWorkflowPath({ customWorkflowPath: '' }, {}), /为空/)
  assert.throws(() => wf.resolveCustomWorkflowPath({ customWorkflowPath: 'nope.json' }, { baseDir }), /不存在/)
})

test('auto detection resolves positive/negative text nodes without configured IDs', () => {
  const targets = wf.resolveCustomNodeTargets(baselineGraph(), {})
  assert.deepStrictEqual(targets.errors, [])
  assert.deepStrictEqual(targets.positive, ['6'])
  assert.deepStrictEqual(targets.negative, ['7'])
  assert.deepStrictEqual(targets.resolutionIds, ['5'])
  assert.deepStrictEqual(targets.stepsIds, ['3'])
  assert.deepStrictEqual(targets.seedIds, ['3'])
})

test('explicit node IDs take priority over structure detection (A3)', () => {
  const dir = tmpDir('pdrawtest-wf-')
  const file = writeWorkflowFile(dir, 'wf.json', baselineGraph())
  wf.clearWorkflowCache()
  const w = wf.customWorkflow(baseCfg({
    customWorkflowEnabled: true,
    customWorkflowPath: file,
    positivePromptNodeId: '6',
    negativePromptNodeId: '7',
  }), 'POS', 'NEG', 832, 1216, 30, 4.5, 99, false)
  assert.strictEqual(w['6'].inputs.text, 'POS')
  assert.strictEqual(w['7'].inputs.text, 'NEG')
})

test('invalid configured node ID reports the available text nodes', () => {
  const missing = wf.resolveCustomNodeTargets(baselineGraph(), { positivePromptNodeId: '999' })
  assert.ok(missing.errors.some(e => e.includes('999')))
  assert.ok(missing.errors.some(e => e.includes('#6')))

  // 存在但不是文本编码节点
  const notText = wf.resolveCustomNodeTargets(baselineGraph(), { positivePromptNodeId: '3' })
  assert.ok(notText.errors.some(e => e.includes('不是文本编码节点')))
})

test('resolutionNodeId / stepsNodeId / seedNodeId narrow the override targets', () => {
  const dir = tmpDir('pdrawtest-wf-')
  const file = writeWorkflowFile(dir, 'wf.json', baselineGraph())
  wf.clearWorkflowCache()
  const w = wf.customWorkflow(baseCfg({
    customWorkflowEnabled: true,
    customWorkflowPath: file,
    positivePromptNodeId: '6',
    negativePromptNodeId: '7',
    resolutionNodeId: '5',
    stepsNodeId: '3',
    seedNodeId: '3',
    customWorkflowOverrideParameters: true,
  }), 'P', 'N', 768, 1344, 12, 3.5, 555, true)
  assert.strictEqual(w['5'].inputs.width, 768)
  assert.strictEqual(w['5'].inputs.height, 1344)
  assert.strictEqual(w['3'].inputs.steps, 12)
  assert.strictEqual(w['3'].inputs.cfg, 3.5)
  assert.strictEqual(w['3'].inputs.seed, 555)
  // 采样器/调度器一并覆盖
  assert.strictEqual(w['3'].inputs.sampler_name, 'er_sde')
  assert.strictEqual(w['3'].inputs.scheduler, 'simple')
})

test('customWorkflowReloadOnChange reloads on mtime change, and keeps cache when disabled (A6)', () => {
  const dir = tmpDir('pdrawtest-wf-')
  const file = path.join(dir, 'wf.json')
  const withMarker = baselineGraph()
  withMarker['77'] = { class_type: 'Note', inputs: { text: 'marker' } }
  fs.writeFileSync(file, JSON.stringify(withMarker))
  wf.clearWorkflowCache()

  // 首次读取建立缓存
  const first = wf.customWorkflow(baseCfg({ customWorkflowEnabled: true, customWorkflowPath: file }), 'P', 'N', 832, 1216, 30, 4.5, 1, false)
  assert.ok(first['77'])

  // 换掉文件内容并推进 mtime
  const withoutMarker = baselineGraph()
  fs.writeFileSync(file, JSON.stringify(withoutMarker))
  const later = new Date(Date.now() + 5000)
  fs.utimesSync(file, later, later)

  // reloadOnChange=false：仍用缓存（旧内容）
  const stale = wf.customWorkflow(baseCfg({
    customWorkflowEnabled: true, customWorkflowPath: file, customWorkflowReloadOnChange: false,
  }), 'P', 'N', 832, 1216, 30, 4.5, 1, false)
  assert.ok(stale['77'], '关闭重载时应继续使用缓存')

  // reloadOnChange=true（默认）：读到新内容
  const reloaded = wf.customWorkflow(baseCfg({ customWorkflowEnabled: true, customWorkflowPath: file }), 'P', 'N', 832, 1216, 30, 4.5, 1, false)
  assert.strictEqual(reloaded['77'], undefined, '开启重载时应读到新的工作流文件')
})

test('inspectCustomWorkflow reports resolved node IDs and configuration errors', () => {
  const dir = tmpDir('pdrawtest-wf-')
  const file = writeWorkflowFile(dir, 'wf.json', baselineGraph())
  wf.clearWorkflowCache()

  const ok = wf.inspectCustomWorkflow(baseCfg({ customWorkflowEnabled: true, customWorkflowPath: file }), {})
  assert.strictEqual(ok.ok, true)
  assert.deepStrictEqual(ok.targets.positive, ['6'])
  assert.ok(ok.path.endsWith('wf.json'))

  const bad = wf.inspectCustomWorkflow(baseCfg({
    customWorkflowEnabled: true, customWorkflowPath: file, positivePromptNodeId: '999',
  }), {})
  assert.strictEqual(bad.ok, false)
  assert.ok(bad.error.includes('999'))
})

// ---------------- comfy.js ----------------

test('outputImages', () => {
  const history = { outputs: { '9': { images: [{ filename: 'a.png' }, { filename: 'b.png' }] }, '3': { images: [{ filename: 'c.png' }] } } }
  const imgs = comfy.outputImages(history)
  assert.deepStrictEqual(imgs.map(i => i.filename).sort(), ['a.png', 'b.png', 'c.png'])
  assert.deepStrictEqual(comfy.outputImages({}), [])
})

// ---------------- multi.js ----------------

test('buildMultiPersonPlanPrompt includes fixed note', () => {
  const p = multi.buildMultiPersonPlanPrompt('two girls', { 狐莉: '1girl, fox girl' })
  assert.ok(p.includes('狐莉'))
  assert.ok(p.includes('two girls'))
  const p2 = multi.buildMultiPersonPlanPrompt('two girls', {})
  assert.ok(p2.includes('No locally saved character name was detected'))
})

test('parseMultiPersonPlan valid', () => {
  const raw = JSON.stringify({
    count_tags: ['2girls'],
    common_tags: ['outdoors'],
    characters: [
      { slot: 'left', name: 'A', danbooru_candidate: '', appearance: 'white hair', clothing: 'dress', expression: 'smile', pose: 'standing', props: [], role: '', visual_label: 'white-haired girl', identity_anchors: ['white hair'], emphasized_anchors: [] },
      { slot: 'right', name: 'B', danbooru_candidate: '', appearance: 'black hair', clothing: 'coat', expression: '', pose: 'standing', props: [], role: '', visual_label: 'black-haired girl', identity_anchors: ['black hair'], emphasized_anchors: [] },
    ],
    relationship_tag: 'holding hands',
    interactions: ['Character A is holding Character B\'s hand.'],
    spatial_mode: 'shared_contact',
    composition: 'A single unified full-frame composition.',
  })
  const plan = multi.parseMultiPersonPlan(raw)
  assert.ok(plan)
  assert.strictEqual(plan.characters.length, 2)
  assert.strictEqual(plan.characters[0].slot, 'left')
  assert.strictEqual(plan.relationship_tag, 'holding hands')
})

test('parseMultiPersonPlan rejects invalid', () => {
  assert.strictEqual(multi.parseMultiPersonPlan('not json'), null)
  assert.strictEqual(multi.parseMultiPersonPlan('{"characters": []}'), null)
  assert.strictEqual(multi.parseMultiPersonPlan('{"characters": [{}]}'), null)
})

test('parseMultiPersonPlan falls back slots and blocks unsafe composition', () => {
  const raw = JSON.stringify({
    count_tags: ['2girls'],
    common_tags: [],
    characters: [
      { slot: 'banana', name: 'A', appearance: 'white hair', identity_anchors: ['white hair'], emphasized_anchors: [] },
      { slot: 'pear', name: 'B', appearance: 'black hair', identity_anchors: ['black hair'], emphasized_anchors: [] },
    ],
    relationship_tag: '',
    interactions: [],
    spatial_mode: 'explicit_positions',
    composition: 'A split screen showing two panels.',
  })
  const plan = multi.parseMultiPersonPlan(raw)
  assert.deepStrictEqual(plan.characters.map(c => c.slot), ['left', 'right'])
  assert.strictEqual(plan.composition, '')
})

test('renderMultiPersonCharacter formats', () => {
  const ch = { slot: 'left', visual_label: 'white-haired fox girl', appearance: 'white hair', clothing: 'red dress', expression: 'smile', pose: 'standing', props: ['flower'] }
  const prose = multi.renderMultiPersonCharacter(ch, { alias: 'white-haired fox girl' })
  assert.strictEqual(prose, 'white-haired fox girl: white hair, red dress, smile, standing, flower.')
  const stream = multi.renderMultiPersonCharacter(ch, { alias: 'white-haired fox girl', asTagStream: true })
  assert.strictEqual(stream, 'white-haired fox girl, white hair, red dress, smile, standing, flower')
})

test('multiPersonAutoSize', () => {
  const allowed = [[832, 1216], [896, 1152], [1024, 1024], [1152, 896], [1216, 832], [1024, 1536]]
  assert.deepStrictEqual(multi.multiPersonAutoSize('三个人', allowed), [1216, 832])
  assert.deepStrictEqual(multi.multiPersonAutoSize('四个女孩', allowed), [1216, 832])
  assert.deepStrictEqual(multi.multiPersonAutoSize('4girls', allowed), [1216, 832])
  assert.deepStrictEqual(multi.multiPersonAutoSize('牵手', allowed), [1024, 1024])
  assert.deepStrictEqual(multi.multiPersonAutoSize('背着', allowed), [1024, 1536])
  assert.deepStrictEqual(multi.multiPersonAutoSize('两个女孩', allowed), [1152, 896])
  assert.deepStrictEqual(multi.multiPersonAutoSize('34人', allowed), [1152, 896])
  assert.strictEqual(multi.multiPersonAutoSize('x', []), null)
})

test('auto detection works on a realistic Aesthetic baseline graph with a LoRA chain', () => {
  // 贴近 text2image anima-aesthetic-v1.1.json 的结构：GGUF loader -> LoraLoader -> KSampler
  const graph = {
    '1': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'anima-aesthetic-v1.1-Q8_0.gguf' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_06b_base.safetensors', type: 'stable_diffusion' } },
    '3': { class_type: 'LoraLoader', inputs: { lora_name: 'style.safetensors', strength_model: 1, strength_clip: 1, model: ['1', 0], clip: ['2', 0] } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: 'pos', clip: ['3', 1] }, _meta: { title: 'CLIP Text Encode (Positive Prompt)' } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: 'neg', clip: ['3', 1] }, _meta: { title: 'CLIP Text Encode (Negative Prompt)' } },
    '6': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    '7': { class_type: 'KSampler', inputs: { model: ['3', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0], seed: 0, steps: 30, cfg: 4, sampler_name: 'er_sde', scheduler: 'simple', denoise: 1 } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['9', 0] } },
    '9': { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
    '10': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'ComfyUI' } },
  }

  const targets = wf.resolveCustomNodeTargets(graph, {})
  assert.deepStrictEqual(targets.errors, [])
  assert.deepStrictEqual(targets.positive, ['4'])
  assert.deepStrictEqual(targets.negative, ['5'])
  // 只认 EmptyLatentImage 作为尺寸节点，不会误伤其它节点
  assert.deepStrictEqual(targets.resolutionIds, ['6'])
  assert.deepStrictEqual(targets.stepsIds, ['7'])

  // 走一遍完整注入，确认提示词、尺寸、seed 都落在正确的节点上
  const dir = tmpDir('pdrawtest-real-')
  const file = writeWorkflowFile(dir, 'aesthetic.json', graph)
  wf.clearWorkflowCache()
  const w = wf.customWorkflow(baseCfg({
    customWorkflowEnabled: true,
    customWorkflowPath: file,
    customWorkflowOverrideParameters: true,
  }), '1girl, solo, white dress', 'worst quality', 1024, 1536, 30, 4, 20241118, true)

  assert.strictEqual(w['4'].inputs.text, '1girl, solo, white dress')
  assert.strictEqual(w['5'].inputs.text, 'worst quality')
  assert.strictEqual(w['6'].inputs.width, 1024)
  assert.strictEqual(w['6'].inputs.height, 1536)
  assert.strictEqual(w['7'].inputs.seed, 20241118)
  // 节点 ID 与连线必须原样保留，不能被改写
  assert.strictEqual(w['7'].inputs.model[0], '3')
  assert.strictEqual(w['7'].inputs.latent_image[0], '6')
  assert.strictEqual(w['1'].class_type, 'UnetLoaderGGUF', '不要改用户工作流里的 loader')
})

test('parseStepsCfg extracts --steps / --cfg and strips them from the prompt', () => {
  const r1 = parse.parseStepsCfg('少女站在河岸 --steps 40 --cfg 3.5')
  assert.strictEqual(r1.steps, 40)
  assert.strictEqual(r1.cfg, 3.5)
  assert.strictEqual(r1.prompt, '少女站在河岸')

  // 中文别名与 = : 变体
  const r2 = parse.parseStepsCfg('1girl --步数=28 --强度:5.5')
  assert.strictEqual(r2.steps, 28)
  assert.strictEqual(r2.cfg, 5.5)
  assert.strictEqual(r2.prompt, '1girl')

  // 未提供时返回 null，提示词不变
  const r3 = parse.parseStepsCfg('一个女孩，白色裙子')
  assert.strictEqual(r3.steps, null)
  assert.strictEqual(r3.cfg, null)
  assert.strictEqual(r3.prompt, '一个女孩，白色裙子')

  // 只给其中一个
  const r4 = parse.parseStepsCfg('少女 --cfg 2')
  assert.strictEqual(r4.steps, null)
  assert.strictEqual(r4.cfg, 2)
  assert.strictEqual(r4.prompt, '少女')

  // 越界值截断，非法值忽略
  assert.strictEqual(parse.parseStepsCfg('a --steps 400').steps, parse.STEPS_LIMIT.max)
  assert.strictEqual(parse.parseStepsCfg('a --cfg 99').cfg, parse.CFG_LIMIT.max)
  assert.strictEqual(parse.parseStepsCfg('a --steps 0').steps, null)
})

test('parseStepsCfg does not eat ordinary prompt text', () => {
  // 没有 -- 前缀的普通词不应被当成参数
  const r = parse.parseStepsCfg('1girl, steps on stairs, cfg 7')
  assert.strictEqual(r.steps, null)
  assert.strictEqual(r.cfg, null)
  assert.strictEqual(r.prompt, '1girl, steps on stairs, cfg 7')
  // --seed 不能被误判成 --steps
  assert.strictEqual(parse.parseStepsCfg('a --seed 42').steps, null)
})

// ---------------- lib/llm.js：通道 × 模型回退 ----------------

test('splitModelList accepts arrays and separated strings', () => {
  assert.deepStrictEqual(llm.splitModelList(['a', 'b']), ['a', 'b'])
  assert.deepStrictEqual(llm.splitModelList('a, b，c\nd'), ['a', 'b', 'c', 'd'])
  assert.deepStrictEqual(llm.splitModelList(''), [])
  assert.deepStrictEqual(llm.splitModelList(['a', 'a']), ['a'])
  assert.deepStrictEqual(llm.splitModelList(null), [])
})

test('buildLlmChain tries every model of the primary channel, then the other channels', () => {
  const chain = llm.buildLlmChain({
    llmBaseUrl: 'https://api.deepseek.com/',
    llmApiKey: 'k1',
    llmModels: ['deepseek-chat', 'deepseek-reasoner'],
    llmChannels: {
      relayA: { baseUrl: 'https://relay-a.test/v1', apiKey: 'ka', models: ['gpt-4o-mini'] },
      relayB: { baseUrl: 'https://relay-b.test/v1', apiKey: 'kb', models: ['qwen-max'] },
    },
    llmChannelOrder: ['relayB', 'relayA'],
  })
  assert.deepStrictEqual(chain.map(c => c.model),
    ['deepseek-chat', 'deepseek-reasoner', 'qwen-max', 'gpt-4o-mini'])
  assert.strictEqual(chain[0].baseUrl, 'https://api.deepseek.com')
  assert.strictEqual(chain[0].label, '主通道')
  assert.strictEqual(chain[2].label, 'relayB')
})

test('buildLlmChain keeps legacy single llmModel working and skips incomplete channels', () => {
  const legacy = llm.buildLlmChain({ llmBaseUrl: 'https://x.test/v1', llmModel: 'm1' })
  assert.deepStrictEqual(legacy.map(c => c.model), ['m1'])

  const partial = llm.buildLlmChain({
    llmBaseUrl: 'https://x.test/v1',
    llmModels: ['m1'],
    llmChannels: { broken: { apiKey: 'k' }, noModels: { baseUrl: 'https://y.test' } },
  })
  assert.deepStrictEqual(partial.map(c => c.model), ['m1'])
  assert.strictEqual(llm.hasLlm({}), false)
  assert.strictEqual(llm.hasLlm({ llmBaseUrl: 'https://x.test', llmModels: ['m'] }), true)
})

test('vision role reads verifyLlm* config and its own channel dict', () => {
  const chain = llm.buildLlmChain({
    llmBaseUrl: 'https://text.test', llmModels: ['text-model'],
    verifyLlmBaseUrl: 'https://vision.test', verifyLlmModels: ['qwen-vl'],
    verifyLlmChannels: { backup: { baseUrl: 'https://vb.test', apiKey: 'k', models: ['glm-4v'] } },
  }, 'vision')
  assert.deepStrictEqual(chain.map(c => c.model), ['qwen-vl', 'glm-4v'])
  assert.strictEqual(chain[0].baseUrl, 'https://vision.test')
})

test('thinking is only sent to DeepSeek endpoints unless forced', () => {
  const deepseek = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' }
  const relay = { baseUrl: 'https://relay.test/v1', model: 'gpt-4o-mini' }

  assert.strictEqual(llm.shouldSendThinking({}, deepseek), true)
  assert.strictEqual(llm.shouldSendThinking({}, relay), false, '中转站默认不带 thinking')
  assert.strictEqual(llm.shouldSendThinking({ llmThinking: 'always' }, relay), true)
  assert.strictEqual(llm.shouldSendThinking({ llmThinking: 'never' }, deepseek), false)
})

test('buildChatBody merges extra body last and respects thinking mode', () => {
  const cfg = { llmExtraBody: '{"enable_thinking":false,"max_tokens":123}' }
  const body = llm.buildChatBody(cfg, {
    candidate: { baseUrl: 'https://relay.test', model: 'gpt-4o-mini' },
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 500,
  })
  assert.strictEqual(body.thinking, undefined)
  assert.strictEqual(body.enable_thinking, false)
  assert.strictEqual(body.max_tokens, 123, 'extraBody 应最后覆盖')

  const deep = llm.buildChatBody({}, {
    candidate: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
    messages: [], maxTokens: 64,
  })
  assert.deepStrictEqual(deep.thinking, { type: 'disabled' })

  // 非法 JSON 不应炸
  assert.deepStrictEqual(llm.parseExtraBody('not json'), {})
})

test('runLlmChain falls through failing candidates and reports why', async () => {
  const tried = []
  const result = await llm.runLlmChain(
    [{ model: 'a', label: 'A' }, { model: 'b', label: 'B' }, { model: 'c', label: 'C' }],
    async (candidate) => {
      tried.push(candidate.model)
      if (candidate.model === 'a') throw new Error('HTTP 401')
      if (candidate.model === 'b') throw new Error('HTTP 402')
      return 'ok-from-c'
    },
  )
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.value, 'ok-from-c')
  assert.strictEqual(result.candidate.model, 'c')
  assert.deepStrictEqual(tried, ['a', 'b', 'c'])
  assert.deepStrictEqual(result.errors.map(e => e.message), ['HTTP 401', 'HTTP 402'])

  const failed = await llm.runLlmChain([{ model: 'x', label: 'X' }], async () => { throw new Error('boom') })
  assert.strictEqual(failed.ok, false)
  assert.strictEqual(failed.value, null)
  assert.strictEqual(failed.errors.length, 1)
})

// ---------------- lib/net.js：可选代理 ----------------

test('normalizeProxyUrl defaults the protocol and ignores empty input', () => {
  assert.strictEqual(net.normalizeProxyUrl(''), '')
  assert.strictEqual(net.normalizeProxyUrl(null), '')
  assert.strictEqual(net.normalizeProxyUrl('127.0.0.1:7890'), 'http://127.0.0.1:7890')
  assert.strictEqual(net.normalizeProxyUrl('http://127.0.0.1:7890'), 'http://127.0.0.1:7890')
  assert.strictEqual(net.normalizeProxyUrl('socks5://127.0.0.1:7891'), 'socks5://127.0.0.1:7891')
  assert.strictEqual(net.resolveDispatcher(''), null, '未配置代理时不建 dispatcher')
})

test('createOutboundFetch falls back to a direct request when no proxy is configured', async () => {
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true } }
  try {
    const outbound = net.createOutboundFetch({})
    await outbound('https://api.tavily.com/search', { method: 'POST' }, '')
    await outbound('https://api.tavily.com/search', { method: 'POST' })
    assert.strictEqual(calls.length, 2)
    assert.strictEqual(calls[0].options.dispatcher, undefined, '直连时不应带 dispatcher')
    assert.strictEqual(calls[1].options.dispatcher, undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('each LLM channel can carry its own proxy', () => {
  const chain = llm.buildLlmChain({
    llmBaseUrl: 'https://primary.test/v1',
    llmModels: ['m1'],
    llmChannels: {
      viaProxy: { baseUrl: 'https://relay.test/v1', apiKey: 'k', models: ['m2'], proxy: '127.0.0.1:7890' },
      noProxy: { baseUrl: 'https://direct.test/v1', apiKey: 'k', models: ['m3'] },
    },
  })
  assert.strictEqual(chain[0].proxy, '', '主通道不绑定代理，由 llmProxy 决定')
  assert.strictEqual(chain[1].proxy, '127.0.0.1:7890', '通道自带代理应透传')
  assert.strictEqual(chain[2].proxy, '', '未配置代理的通道留空，由用途默认代理兜底')
})

test('modelParams override custom workflow values even when the global switch is off', () => {
  const dir = tmpDir('pdrawtest-wf-')
  const file = writeWorkflowFile(dir, 'wf.json', baselineGraph())
  wf.clearWorkflowCache()
  // 工作流内是 steps=20 / cfg=7 / sampler=euler / scheduler=normal / 512x512
  const base = {
    customWorkflowEnabled: true,
    customWorkflowPath: file,
    customWorkflowOverrideParameters: false, // 总开关关闭
  }

  // 1) 只配了 steps/cfg → 只覆盖这两个，采样器保持工作流里的值
  const w1 = wf.customWorkflow(baseCfg(base), 'P', 'N', 768, 1344, 45, 3.5, 7, false,
    { modelParams: { steps: 45, cfg: 3.5 } })
  assert.strictEqual(w1['3'].inputs.steps, 45, 'modelParams 显式配置应覆盖工作流')
  assert.strictEqual(w1['3'].inputs.cfg, 3.5)
  assert.strictEqual(w1['3'].inputs.sampler_name, 'euler', '未配置的字段不应被改动')
  assert.strictEqual(w1['3'].inputs.scheduler, 'normal')
  assert.strictEqual(w1['5'].inputs.width, 512, '未配置尺寸时不应覆盖尺寸')

  // 2) 配了 width/height → 尺寸被覆盖
  const w2 = wf.customWorkflow(baseCfg(base), 'P', 'N', 768, 1344, 45, 3.5, 7, false,
    { modelParams: { width: 768, height: 1344 } })
  assert.strictEqual(w2['5'].inputs.width, 768)
  assert.strictEqual(w2['5'].inputs.height, 1344)

  // 3) 什么都不配且总开关关闭 → 完全保持工作流原值（旧行为不变）
  const w3 = wf.customWorkflow(baseCfg(base), 'P', 'N', 768, 1344, 45, 3.5, 7, false)
  assert.strictEqual(w3['3'].inputs.steps, 20)
  assert.strictEqual(w3['3'].inputs.cfg, 7)
  assert.strictEqual(w3['5'].inputs.width, 512)
})

test('resolution nodes are detected across latent node variants (EmptySD3LatentImage)', () => {
  // 用户实际导出的 anima.json 用的是 EmptySD3LatentImage + KSamplerAdvanced
  const graph = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'anima-aesthetic-v1.1.safetensors' } },
    '28': { class_type: 'EmptySD3LatentImage', inputs: { width: 1024, height: 1536, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'p', clip: ['2', 0] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: 'n', clip: ['2', 0] } },
    '3': { class_type: 'KSamplerAdvanced', inputs: { model: ['1', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['28', 0], noise_seed: 1, steps: 30, cfg: 4 } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0] } },
  }
  assert.deepStrictEqual(wf.findResolutionNodeIds(graph), ['28'])

  const targets = wf.resolveCustomNodeTargets(graph, {})
  assert.deepStrictEqual(targets.errors, [])
  assert.deepStrictEqual(targets.positive, ['6'])
  assert.deepStrictEqual(targets.negative, ['7'])
  assert.deepStrictEqual(targets.resolutionIds, ['28'], 'EmptySD3LatentImage 也要能识别为尺寸节点')
  assert.deepStrictEqual(targets.stepsIds, ['3'], 'KSamplerAdvanced 也要能识别为采样节点')
  assert.deepStrictEqual(targets.seedIds, ['3'], 'KSamplerAdvanced 用 noise_seed')

  // 真的能覆盖到
  const dir = tmpDir('pdrawtest-wf-')
  const file = writeWorkflowFile(dir, 'anima-sd3.json', graph)
  wf.clearWorkflowCache()
  const w = wf.customWorkflow(baseCfg({ customWorkflowEnabled: true, customWorkflowPath: file }), 'P', 'N', 832, 1216, 30, 4, 5, true)
  assert.strictEqual(w['28'].inputs.width, 832)
  assert.strictEqual(w['28'].inputs.height, 1216)
})

// ---------------- 工作流预设：解析 + 体检 ----------------

test('parseWorkflowPreset handles the flag, bare aliases and unknown names', () => {
  const presets = [
    { name: '基础文生图', aliases: ['基础'] },
    { name: '极速4步', aliases: ['极速', 'fast'] },
    { name: '高清放大', aliases: ['高清'] },
  ]

  const flagged = parse.parseWorkflowPreset('--工作流 极速4步：1girl, solo', presets)
  assert.strictEqual(flagged.preset, '极速4步')
  assert.strictEqual(flagged.prompt, '1girl, solo')
  assert.strictEqual(flagged.error, null)

  const alias = parse.parseWorkflowPreset('极速：1girl, solo', presets)
  assert.strictEqual(alias.preset, '极速4步')
  assert.strictEqual(alias.prompt, '1girl, solo')

  const spaced = parse.parseWorkflowPreset('高清 1girl', presets)
  assert.strictEqual(spaced.preset, '高清放大')
  assert.strictEqual(spaced.prompt, '1girl')

  // 不匹配时原样返回，不误伤提示词
  const plain = parse.parseWorkflowPreset('1girl, solo', presets)
  assert.strictEqual(plain.preset, null)
  assert.strictEqual(plain.prompt, '1girl, solo')

  // 未知名称：报错并列出可用
  const bad = parse.parseWorkflowPreset('--工作流 不存在：x', presets)
  assert.strictEqual(bad.preset, null)
  assert.ok(bad.error.includes('不存在'))
  assert.ok(bad.error.includes('基础文生图'))

  // 未配置任何预设时形同虚设
  assert.deepStrictEqual(parse.parseWorkflowPreset('任意文本', []), { preset: null, prompt: '任意文本', error: null })
})

test('parseWorkflowPreset prefers the longest alias', () => {
  const presets = [
    { name: '短', aliases: ['高清'] },
    { name: '长', aliases: ['高清重绘'] },
  ]
  assert.strictEqual(parse.parseWorkflowPreset('高清重绘：a girl', presets).preset, '长')
  assert.strictEqual(parse.parseWorkflowPreset('高清：a girl', presets).preset, '短')
})

test('analyzeWorkflow tells text-startable graphs from image-input ones', () => {
  const textOnly = wf.analyzeWorkflow(baselineGraph())
  assert.strictEqual(textOnly.hasLatentStart, true)
  assert.strictEqual(textOnly.canRunTextOnly, true)
  assert.deepStrictEqual(textOnly.imageInputClasses, [])
  assert.deepStrictEqual(textOnly.requires, [])

  const withImage = Object.assign({}, baselineGraph(), {
    50: { class_type: 'LoadImage', inputs: { image: 'a.png' } },
    51: { class_type: 'VAEEncode', inputs: { pixels: ['50', 0], vae: ['15', 0] } },
  })
  const needsImage = wf.analyzeWorkflow(withImage)
  assert.strictEqual(needsImage.canRunTextOnly, false)
  assert.deepStrictEqual(needsImage.imageInputClasses, ['LoadImage'])
  assert.ok(needsImage.requires.some(item => item.includes('图片输入')))

  // 只有 ControlNet、没有 LoadImage
  const controlOnly = Object.assign({}, baselineGraph(), {
    60: { class_type: 'ControlNetApplyAdvanced', inputs: {} },
  })
  const withControl = wf.analyzeWorkflow(controlOnly)
  assert.ok(withControl.requires.some(item => item.includes('ControlNet')))
})

test('inspectWorkflowFile reports availability without throwing', () => {
  const dir = tmpDir('pdrawtest-preset-')
  const good = writeWorkflowFile(dir, 'good.json', baselineGraph())
  const bad = writeWorkflowFile(dir, 'needs-image.json', Object.assign({}, baselineGraph(), {
    50: { class_type: 'LoadImage', inputs: { image: 'a.png' } },
  }))

  const okReport = wf.inspectWorkflowFile(good, {}, { baseDir: dir })
  assert.strictEqual(okReport.ok, true)
  assert.deepStrictEqual(okReport.targets.positive, ['6'])

  const badReport = wf.inspectWorkflowFile(bad, {}, { baseDir: dir })
  assert.strictEqual(badReport.ok, false)
  assert.ok(badReport.error.includes('不支持图生图'))

  const missing = wf.inspectWorkflowFile('nope.json', {}, { baseDir: dir })
  assert.strictEqual(missing.ok, false)
  assert.ok(missing.error.includes('不存在'))
})

// ---------------- 模型名注入 ----------------

test('findModelLoaders recognises the model loader variants', () => {
  const graph = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: 'a.safetensors', weight_dtype: 'default' } },
    2: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'b.gguf' } },
    3: { class_type: 'EnhancedLoadDiffusionModel', inputs: { unet_name: 'c.safetensors', weight_dtype: 'default' } },
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'd.safetensors' } },
    5: { class_type: 'CLIPLoader', inputs: { clip_name: 'clip.safetensors' } },
  }
  const loaders = wf.findModelLoaders(graph)
  assert.deepStrictEqual(loaders.map(l => `${l.id}:${l.inputName}`), ['1:unet_name', '2:unet_name', '3:unet_name', '4:ckpt_name'])
})

test('applyModelOverride injects into a single loader and skips ambiguity', () => {
  const single = { 1: { class_type: 'EnhancedLoadDiffusionModel', inputs: { unet_name: 'old.safetensors', weight_dtype: 'default' } } }
  const r1 = wf.applyModelOverride(single, { unetName: 'mine.safetensors' }, { overrideModel: true })
  assert.strictEqual(r1.applied, true)
  assert.strictEqual(single[1].inputs.unet_name, 'mine.safetensors')

  // 两个加载器：不猜
  const multi = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: 'a.safetensors' } },
    2: { class_type: 'UNETLoader', inputs: { unet_name: 'b.safetensors' } },
  }
  const r2 = wf.applyModelOverride(multi, { unetName: 'mine.safetensors' }, { overrideModel: true })
  assert.strictEqual(r2.applied, false)
  assert.strictEqual(r2.reason, 'ambiguous')
  assert.strictEqual(multi[1].inputs.unet_name, 'a.safetensors')
  assert.strictEqual(multi[2].inputs.unet_name, 'b.safetensors')

  // 指定节点后只改那一个
  const r3 = wf.applyModelOverride(multi, { unetName: 'mine.safetensors' }, { overrideModel: true, modelLoaderNodeId: '2' })
  assert.strictEqual(r3.applied, true)
  assert.strictEqual(multi[1].inputs.unet_name, 'a.safetensors')
  assert.strictEqual(multi[2].inputs.unet_name, 'mine.safetensors')

  // 关掉开关就不动
  const single2 = { 1: { class_type: 'UNETLoader', inputs: { unet_name: 'keep.safetensors' } } }
  const r4 = wf.applyModelOverride(single2, { unetName: 'mine.safetensors' }, { overrideModel: false })
  assert.strictEqual(r4.applied, false)
  assert.strictEqual(single2[1].inputs.unet_name, 'keep.safetensors')
})

test('customWorkflow injects the configured model by default', () => {
  const graph = baselineGraph()
  graph['44'].inputs.unet_name = 'json-model.safetensors'
  const dir = tmpDir('pdrawtest-wf-')
  const file = writeWorkflowFile(dir, 'wf.json', graph)
  wf.clearWorkflowCache()

  const w = wf.customWorkflow(
    baseCfg({ customWorkflowEnabled: true, customWorkflowPath: file, unetName: 'cfg-model.safetensors' }),
    'P', 'N', 832, 1216, 30, 4, 1, false, { overrideModel: true },
  )
  assert.strictEqual(w['44'].inputs.unet_name, 'cfg-model.safetensors', 'unetName 应覆盖 JSON 里的模型')

  // 关闭时不覆盖
  wf.clearWorkflowCache()
  const w2 = wf.customWorkflow(
    baseCfg({ customWorkflowEnabled: true, customWorkflowPath: file, unetName: 'cfg-model.safetensors' }),
    'P', 'N', 832, 1216, 30, 4, 1, false, { overrideModel: false },
  )
  assert.strictEqual(w2['44'].inputs.unet_name, 'json-model.safetensors')
})

test('ClownsharKSampler_Beta and other samplers are recognised for prompt/steps/seed', () => {
  // 官方 Anima 工作流用的是 ClownsharKSampler_Beta（RES4LYF），不是 KSampler
  const graph = {
    1: { class_type: 'EnhancedLoadDiffusionModel', inputs: { unet_name: 'm.safetensors', weight_dtype: 'default' } },
    3: { class_type: 'CLIPLoader', inputs: { clip_name: 'c.safetensors', type: 'qwen_image', device: 'default' } },
    5: { class_type: 'CLIPTextEncode', inputs: { text: 'p', clip: ['3', 0] } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: 'n', clip: ['3', 0] } },
    7: { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    32: {
      class_type: 'ClownsharKSampler_Beta',
      inputs: {
        model: ['1', 0], positive: ['5', 0], negative: ['6', 0], latent_image: ['7', 0],
        steps: 34, cfg: 4.5, sampler_name: 'linear/euler', scheduler: 'beta57', seed: 1, denoise: 1,
      },
    },
    9: { class_type: 'SaveImage', inputs: { images: ['32', 0] } },
  }

  const targets = wf.resolveCustomNodeTargets(graph, {})
  assert.deepStrictEqual(targets.errors, [])
  assert.deepStrictEqual(targets.positive, ['5'], '应从 ClownsharK 的 positive 反查到文本节点')
  assert.deepStrictEqual(targets.negative, ['6'])
  assert.deepStrictEqual(targets.stepsIds, ['32'], 'ClownsharKSampler_Beta 应算采样节点')
  assert.deepStrictEqual(targets.seedIds, ['32'])
  assert.deepStrictEqual(wf.findModelLoaders(graph).map(l => l.id), ['1'])
})
