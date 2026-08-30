'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { pathToFileURL } = require('url')

const parse = require('../lib/parse')
const tags = require('../lib/tags')
const wf = require('../lib/workflows')
const comfy = require('../lib/comfy')
const multi = require('../lib/multi')
const media = require('../lib/media')
const series = require('../lib/series')

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

test('parseDenoise', () => {
  assert.strictEqual(parse.parseDenoise('i2i --denoise 0.6').denoise, 0.6)
  assert.strictEqual(parse.parseDenoise('i2i --去噪 0.4').denoise, 0.4)
  assert.strictEqual(parse.parseDenoise('i2i').denoise, null)
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
    i2iUnetName: 'anima-base-v1.0.safetensors',
    clipName: 'qwen_3_06b_base.safetensors',
    vaeName: 'qwen_image_vae.safetensors',
    samplerName: 'er_sde',
    scheduler: 'simple',
    customWorkflowEnabled: false,
    customWorkflowPath: '',
    customWorkflowOverrideParameters: false,
    i2iStyleDenoise: 0.75,
    i2iOotdDenoise: 0.55,
    img2imgDenoise: 0.55,
    i2iControlNetStrength: 0.7,
    i2iIPAdapterPath: '',
    i2iIPAdapterWeight: 0.8,
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

test('buildI2IWorkflow modes', () => {
  const img = 'x.png'
  // plain
  const plain = wf.buildI2IWorkflow(baseCfg(), 'p', 'n', 512, 512, 30, 4.5, 1, img, 'plain', null, null)
  assert.strictEqual(plain.kind, 'plain')
  assert.strictEqual(plain.promptBody['13'].class_type, 'LoadImage')
  // style with controlnet caps
  const style = wf.buildI2IWorkflow(baseCfg(), 'p', 'n', 512, 512, 30, 4.5, 1, img, 'style', null, { controlNet: { available: true, model: 'anima-lllite-lineart.safetensors', preprocessor: 'Canny' }, ipAdapter: { available: false } })
  assert.strictEqual(style.kind, 'controlnet')
  assert.strictEqual(style.promptBody['71'].class_type, 'AnimaLLLiteApply_sdscripts')
  assert.strictEqual(style.promptBody['44'].inputs.unet_name, 'anima-base-v1.0.safetensors')
  // style without caps -> plain with low denoise
  const styleFallback = wf.buildI2IWorkflow(baseCfg(), 'p', 'n', 512, 512, 30, 4.5, 1, img, 'style', null, { controlNet: { available: false }, ipAdapter: { available: false } })
  assert.strictEqual(styleFallback.kind, 'plain')
  assert.ok(styleFallback.denoise <= 0.5)
  // ootd with ipadapter
  const ootd = wf.buildI2IWorkflow(baseCfg({ i2iIPAdapterPath: '/models/ip.safetensors' }), 'p', 'n', 512, 512, 30, 4.5, 1, img, 'ootd', null, { controlNet: { available: false }, ipAdapter: { available: true } })
  assert.strictEqual(ootd.kind, 'ipadapter')
  assert.strictEqual(ootd.promptBody['82'].class_type, 'AnimaIPAdapterApply')
})

test('customWorkflow injects text and throws on missing nodes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdraw-wf-'))
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

// ---------------- comfy.js ----------------

test('outputImages', () => {
  const history = { outputs: { '9': { images: [{ filename: 'a.png' }, { filename: 'b.png' }] }, '3': { images: [{ filename: 'c.png' }] } } }
  const imgs = comfy.outputImages(history)
  assert.deepStrictEqual(imgs.map(i => i.filename).sort(), ['a.png', 'b.png', 'c.png'])
  assert.deepStrictEqual(comfy.outputImages({}), [])
})

test('materializeImageSource converts local file URLs to buffers', async () => {
  const filePath = path.join(os.tmpdir(), 'pdraw.png')
  const source = await media.materializeImageSource(pathToFileURL(filePath).href, async (resolvedPath) => {
    assert.strictEqual(path.resolve(resolvedPath), path.resolve(filePath))
    return Buffer.from('png-data')
  })
  assert.ok(Buffer.isBuffer(source))
  assert.strictEqual(source.toString(), 'png-data')
})

test('materializeImageSource preserves non-file image sources', async () => {
  const source = 'https://example.com/image.png'
  assert.strictEqual(await media.materializeImageSource(source), source)
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

test('createSeriesStageRunner passes each successful stage output to the next stage', async () => {
  const calls = []
  const runStage = series.createSeriesStageRunner(['stage-1', 'stage-2', 'stage-3'], async (input) => {
    calls.push(input)
    return { ok: true, outputs: [`image-${input.index}`] }
  })
  await runStage(0)
  await runStage(1)
  await runStage(2)
  assert.strictEqual(calls[0].previousOutput, null)
  assert.strictEqual(calls[1].previousOutput, 'image-0')
  assert.strictEqual(calls[2].previousOutput, 'image-1')
  assert.deepStrictEqual(calls.map(call => call.prompt), ['stage-1', 'stage-2', 'stage-3'])
})
