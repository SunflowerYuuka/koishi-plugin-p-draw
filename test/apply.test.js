'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const path = require('path')
const os = require('os')
const fs = require('fs')

const plugin = require('../index.js')

// ---- mock Koishi ctx ----
function makeLogger() {
  const noop = () => {}
  return { info: noop, warn: noop, success: noop, error: noop }
}
function makeCtx() {
  const ctx = {
    baseDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pdraw-ctx-')),
    logger: () => makeLogger(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    i18n: { define: () => {} },
    model: { extend: () => {} },
    database: {
      get: async () => [],
      set: async () => {},
      create: async () => {},
    },
    on: () => {},
  }
  // 指令注册链
  ctx.command = () => {
    const chain = { alias: () => chain, action: () => chain }
    return chain
  }
  return ctx
}

const cfg = {
  comfyuiBaseUrl: 'http://127.0.0.1:8188',
  workflow: 'anima_t2i',
  customWorkflowEnabled: false,
  customWorkflowPath: '',
  customWorkflowOverrideParameters: false,
  timeout: 300,
  pollInterval: 2,
  unetName: 'anima-base-v1.0.safetensors',
  i2iUnetName: 'anima-base-v1.0.safetensors',
  modelParams: {},
  clipName: 'qwen_3_06b_base.safetensors',
  vaeName: 'qwen_image_vae.safetensors',
  width: 832,
  height: 1216,
  allowedSizes: ['832x1216', '1024x1024', '1216x832'],
  steps: 30,
  cfg: 4.5,
  samplerName: 'er_sde',
  scheduler: 'simple',
  qualityPrefix: 'masterpiece, best quality, score_7, safe,',
  negativePrompt: 'worst quality, low quality, score_1, score_2, score_3, artist name',
  promptOptimizeEnabled: false,
  llmBaseUrl: '',
  llmApiKey: '',
  llmModel: '',
  llmMaxTokens: 1000,
  webSearchEnabled: false,
  tavilyApiKey: '',
  webSearchMaxResults: 5,
  webSearchDepth: 'basic',
  webSearchQueryTemplate: '',
  promptOptimizeTemplate: '',
  artistPresets: [],
  activeArtistPreset: '',
  defaultArtistTags: '',
  styleTags: '',
  fixedCharacters: [],
  userModels: {},
  queueEnabled: false,
  queueMaxRequests: 0,
  batchMax: 4,
  price: 500,
  multiPrice: 900,
  couponPrice: 3000,
  couponAskTimeout: 60,
  img2imgDenoise: 0.55,
  i2iMode: 'ask',
  i2iAskTimeout: 60,
  seriesAskTimeout: 60,
  i2iStyleDenoise: 0.75,
  i2iOotdDenoise: 0.55,
  i2iControlNetStrength: 0.7,
  i2iIPAdapterPath: '',
  i2iIPAdapterWeight: 0.8,
  controlNetModel: '',
  taggerEnabled: false,
  taggerModel: 'wd-v1-4-convnext-tagger-v2',
  taggerThreshold: 0.35,
  taggerCharacterThreshold: 0.85,
  adminUsers: [],
  outputLogs: false,
  multiVerifyEnabled: false,
  multiVerifyPassScore: 6,
  multiCandidateCount: 2,
  multiSendDegradedCandidate: true,
  verifyLlmBaseUrl: '',
  verifyLlmApiKey: '',
  verifyLlmModel: '',
  adminOnly: false,
  allowedUserIds: [],
  blockedUserIds: [],
  allowedGroupIds: [],
  blockedGroupIds: [],
}

let iface = null
let ctx = null

test('apply boots and returns test interface', async () => {
  ctx = makeCtx()
  iface = await plugin.apply(ctx, cfg)
  assert.ok(iface)
  assert.strictEqual(typeof iface.normalizeConfirm, 'function')
  assert.strictEqual(typeof iface.resolveCouponPrice, 'function')
  assert.strictEqual(typeof iface.animaI2IWorkflow, 'function')
})

test('normalizeConfirm', () => {
  assert.strictEqual(iface.normalizeConfirm('是'), true)
  assert.strictEqual(iface.normalizeConfirm('购买'), true)
  assert.strictEqual(iface.normalizeConfirm('不'), false)
  assert.strictEqual(iface.normalizeConfirm('算了'), false)
  assert.strictEqual(iface.normalizeConfirm('乱写的'), null)
  assert.strictEqual(iface.normalizeConfirm(''), null)
})

test('parseDenoise via apply', () => {
  const r = iface.parseDenoise('i2i --denoise 0.7')
  assert.strictEqual(r.denoise, 0.7)
})

test('resolveCouponPrice falls back to cfg', async () => {
  const price = await iface.resolveCouponPrice()
  assert.strictEqual(price, cfg.couponPrice)
})

test('animaI2IWorkflow via apply', () => {
  const w = iface.animaI2IWorkflow(cfg, 'p', 'n', 512, 512, 30, 4.5, 7, 'in.png', 0.5)
  assert.strictEqual(w['13'].class_type, 'LoadImage')
  assert.strictEqual(w['19'].inputs.denoise, 0.5)
  assert.strictEqual(w['19'].inputs.seed, 7)
})

test('generated images and their prompts are sent as paired forward nodes', async () => {
  const sent = []
  const session = {
    messageId: '1742313783',
    send: async (message) => { sent.push(message) },
  }
  await iface.sendImagesAsForward(session, [
    { src: 'https://example.com/a.png', prompt: '1girl, blue eyes', negativePrompt: 'bad anatomy, watermark' },
    { src: 'https://example.com/b.png', prompt: '1girl, red eyes', negativePrompt: '' },
  ])
  assert.strictEqual(sent.length, 1)
  assert.strictEqual(sent[0].type, 'figure')
  assert.strictEqual(sent[0].children.length, 4)
  assert.strictEqual(sent[0].children[0].type, 'message')
  assert.strictEqual(sent[0].children[0].children[0].type, 'img')
  assert.strictEqual(sent[0].children[1].type, 'message')
  assert.strictEqual(sent[0].children[1].children[0].attrs.content, 'Positive:\n1girl, blue eyes\n\nNegative:\nbad anatomy, watermark')
  assert.strictEqual(sent[0].children[2].children[0].type, 'img')
  assert.strictEqual(sent[0].children[3].children[0].attrs.content, 'Positive:\n1girl, red eyes\n\nNegative:\n')
  assert.ok(!sent[0].children.some(child => child.type === 'quote'))
})

test('charged notice is quoted but remains a normal message', async () => {
  const sent = []
  const session = {
    messageId: '1742313783',
    text: (key) => key === '.charged' ? '已扣除 500 P 点' : key,
    send: async (message) => { sent.push(message) },
  }
  await iface.sendNotices(session, ['已扣除 500 P 点'], { quote: true })
  assert.strictEqual(sent.length, 1)
  assert.ok(typeof sent[0] === 'string')
  assert.ok(sent[0].includes('quote:1742313783'))
  assert.ok(sent[0].includes('已扣除 500 P 点'))
})

test('batch execution preserves the exact prompt for every successful image', async () => {
  const batch = await iface.executeBatch('tester', true, 2, 0, async (index) => ({
    ok: true,
    outputs: [`https://example.com/${index}.png`],
    prompt: `prompt-${index}`,
  }))
  assert.deepStrictEqual(batch.results.map(item => item.prompt), ['prompt-0', 'prompt-1'])
})

test('i18n dict present via Config', () => {
  assert.ok(plugin.Config)
  assert.ok(plugin.Config.i18nDict['zh-CN']['commands']['p-draw']['messages']['generating'])
})
