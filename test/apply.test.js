'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const path = require('path')
const os = require('os')
const fs = require('fs')

const plugin = require('../index.js')
const { zhCN } = require('../lib/i18n')

// ---- mock Koishi ctx ----
function makeLogger() {
  const noop = () => {}
  return { info: noop, warn: noop, success: noop, error: noop }
}
function makeCtx(initialTables = {}) {
  const commands = []
  const actions = []
  const tables = Object.fromEntries(Object.entries(initialTables).map(([name, rows]) => [name, rows.map(row => ({ ...row }))]))
  const operations = []
  let nextId = 1
  for (const rows of Object.values(tables)) {
    for (const row of rows) nextId = Math.max(nextId, (row.id || 0) + 1)
  }
  const matches = (row, query) => Object.entries(query || {}).every(([key, value]) => row[key] === value)
  const ctx = {
    baseDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pdraw-ctx-')),
    logger: () => makeLogger(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    i18n: { define: () => {} },
    model: { extend: (table, fields, options) => operations.push({ type: 'extend', table, fields, options }) },
    database: {
      get: async (table, query = {}) => {
        operations.push({ type: 'get', table, query })
        return (tables[table] || []).filter(row => matches(row, query)).map(row => ({ ...row }))
      },
      set: async (table, query, data) => {
        operations.push({ type: 'set', table, query, data })
        for (const row of tables[table] || []) {
          if (matches(row, query)) Object.assign(row, data)
        }
      },
      create: async (table, data) => {
        operations.push({ type: 'create', table, data })
        const row = { ...data }
        if (row.id == null) row.id = nextId++
        if (!tables[table]) tables[table] = []
        tables[table].push(row)
        return { ...row }
      },
      remove: async (table, query) => {
        operations.push({ type: 'remove', table, query })
        tables[table] = (tables[table] || []).filter(row => !matches(row, query))
      },
    },
    on: () => {},
    commands,
    actions,
    tables,
    operations,
  }
  // 指令注册链
  ctx.command = (name) => {
    commands.push(name)
    const chain = { alias: () => chain, action: (handler) => { actions.push(handler); return chain } }
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
  assert.strictEqual(iface.handleGenerateI2I, undefined)
  assert.strictEqual(iface.animaI2IWorkflow, undefined)
})

test('fixed characters migrate once into their dedicated table and drive commands and prompts', async () => {
  const localCtx = makeCtx({
    p_draw_config: [{
      id: 1,
      fixed_characters: ['狐莉=1girl, fox girl', '小明=1boy, black hair'],
    }],
  })
  const localCfg = Object.assign({}, cfg, {
    fixedCharacters: [],
    adminUsers: ['tester'],
    userModels: {},
  })
  await plugin.apply(localCtx, localCfg)

  const extension = localCtx.operations.find(operation => operation.type === 'extend' && operation.table === 'p_draw_fixed_characters')
  assert.deepStrictEqual(extension.fields, { id: 'unsigned', name: 'string', tags: 'text' })
  const legacyExtension = localCtx.operations.find(operation => operation.type === 'extend' && operation.table === 'p_draw_config')
  assert.strictEqual(legacyExtension.fields.fixed_characters, 'json')
  assert.ok(plugin.Config.dict.fixedCharacters)
  assert.deepStrictEqual(localCtx.tables.p_draw_fixed_characters.map(({ name, tags }) => ({ name, tags })), [
    { name: '狐莉', tags: '1girl, fox girl' },
    { name: '小明', tags: '1boy, black hair' },
  ])

  await plugin.apply(localCtx, Object.assign({}, localCfg, { userModels: {} }))
  assert.strictEqual(localCtx.tables.p_draw_fixed_characters.length, 2)
  assert.deepStrictEqual(localCfg.fixedCharacters, [])

  const session = { userId: 'tester', text: (key, args = []) => `${key}:${args.join('|')}` }
  const command = localCtx.actions[0]
  assert.strictEqual(await command({ session }, '添加角色 狐莉=1girl, white fox girl'), '.character-created:狐莉|1girl, white fox girl')
  assert.deepStrictEqual(localCtx.tables.p_draw_fixed_characters.find(row => row.name === '狐莉').tags, '1girl, white fox girl,')
  assert.strictEqual(await command({ session }, '查看角色'), '固定角色：\n- 狐莉：1girl, white fox girl,\n- 小明：1boy, black hair')
  assert.strictEqual(await command({ session }, '删除角色 小明'), '.character-deleted:小明')
  assert.strictEqual(await command({ session }, '查看角色'), '固定角色：\n- 狐莉：1girl, white fox girl,')
  assert.strictEqual(localCtx.tables.p_draw_config[0].fixed_characters_migrated, true)
  await plugin.apply(localCtx, Object.assign({}, localCfg, { userModels: {} }))
  assert.deepStrictEqual(localCtx.tables.p_draw_fixed_characters.map(row => row.name), ['狐莉'])

  const previousFetch = global.fetch
  let submittedPrompt = null
  global.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/system_stats')) return { ok: true, json: async () => ({}) }
    if (String(url).endsWith('/prompt')) {
      submittedPrompt = JSON.parse(options.body).prompt
      return { ok: true, json: async () => ({}) }
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  try {
    await command({ session: Object.assign(session, { send: async () => {} }) }, '狐莉 standing')
    assert.ok(submittedPrompt['11'].inputs.text.includes('white fox girl'))
  } finally {
    global.fetch = previousFetch
  }
})

test('fixed character table rows are listed by ascending id', async () => {
  const localCtx = makeCtx({
    p_draw_config: [{ id: 1, fixed_characters_migrated: true }],
    p_draw_fixed_characters: [
      { id: 9, name: '后创建', tags: 'later' },
      { id: 3, name: '先创建', tags: 'first' },
    ],
  })
  await plugin.apply(localCtx, Object.assign({}, cfg, { fixedCharacters: [], userModels: {} }))
  const session = { userId: 'tester', text: (key, args = []) => `${key}:${args.join('|')}` }
  const result = await localCtx.actions[0]({ session }, '查看角色')
  assert.strictEqual(result, '固定角色：\n- 先创建：first\n- 后创建：later')
})

test('model selection includes Animagine checkpoint models', async () => {
  const previousFetch = global.fetch
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      UNETLoader: { input: { required: { unet_name: [['anima-base-v1.0.safetensors']] } } },
      CheckpointLoaderSimple: { input: { required: { ckpt_name: [['animagine-xl-3.1.safetensors', 'other-xl.safetensors']] } } },
    }),
  })
  try {
    const localCtx = makeCtx()
    await plugin.apply(localCtx, Object.assign({}, cfg, { userModels: {} }))
    const result = await localCtx.actions[0]({ session: {
      userId: 'tester',
      text: (key, args = []) => `${key}:${args.join('|')}`,
    } }, '模型 animagine')
    assert.ok(result.startsWith('.model-switched:animagine-xl-3.1.safetensors'))
    const unsupported = await localCtx.actions[0]({ session: {
      userId: 'tester',
      text: (key, args = []) => `${key}:${args.join('|')}`,
    } }, '模型 other-xl')
    assert.ok(unsupported.startsWith('.model-not-found:other-xl'))
  } finally {
    global.fetch = previousFetch
  }
})

test('Animagine model parameters override the effective generation settings', async () => {
  const previousFetch = global.fetch
  let submittedPrompt = null
  global.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/system_stats')) return { ok: true, json: async () => ({}) }
    if (String(url).endsWith('/prompt')) {
      submittedPrompt = JSON.parse(options.body).prompt
      return { ok: true, json: async () => ({}) }
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  try {
    const localCtx = makeCtx()
    await plugin.apply(localCtx, Object.assign({}, cfg, {
      unetName: 'animagine-xl-3.1.safetensors',
      modelParams: {
        'ANIMAGINE_XL_3.1.SAFETENSORS': {
          samplerName: 'dpmpp_2m',
          scheduler: 'karras',
          steps: 28,
          cfg: 7,
          width: 1024,
          height: 1024,
        },
      },
      adminUsers: ['tester'],
      userModels: {},
    }))
    await localCtx.actions[0]({ session: {
      userId: 'tester',
      text: (key, args = []) => `${key}:${args.join('|')}`,
      send: async () => {},
    } }, '无优化 1girl')

    assert.strictEqual(submittedPrompt['5'].inputs.width, 1024)
    assert.strictEqual(submittedPrompt['5'].inputs.height, 1024)
    assert.strictEqual(submittedPrompt['3'].inputs.steps, 28)
    assert.strictEqual(submittedPrompt['3'].inputs.cfg, 7)
    assert.strictEqual(submittedPrompt['3'].inputs.sampler_name, 'dpmpp_2m')
    assert.strictEqual(submittedPrompt['3'].inputs.scheduler, 'karras')
  } finally {
    global.fetch = previousFetch
  }
})

test('normalizeConfirm', () => {
  assert.strictEqual(iface.normalizeConfirm('是'), true)
  assert.strictEqual(iface.normalizeConfirm('购买'), true)
  assert.strictEqual(iface.normalizeConfirm('不'), false)
  assert.strictEqual(iface.normalizeConfirm('算了'), false)
  assert.strictEqual(iface.normalizeConfirm('乱写的'), null)
  assert.strictEqual(iface.normalizeConfirm(''), null)
})

test('resolveCouponPrice falls back to cfg', async () => {
  const price = await iface.resolveCouponPrice()
  assert.strictEqual(price, cfg.couponPrice)
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

test('charged notice formats the effective model and single actual seed as a quoted reply', async () => {
  const sent = []
  const session = {
    messageId: '1742313783',
    send: async (message) => { sent.push(message) },
  }
  const notice = iface.buildChargeNotice({
    isAdmin: false,
    totalPrice: 750,
    unetName: 'animagine-xl-3.1.safetensors',
    seeds: [123456],
  })
  assert.strictEqual(notice, '已扣除 750 P 点，当前模型：animagine-xl-3.1.safetensors，--seed=123456')
  await iface.sendNotices(session, [notice], { quote: true })
  assert.strictEqual(sent.length, 1)
  assert.ok(typeof sent[0] === 'string')
  assert.ok(sent[0].includes('<quote id="1742313783"/>'))
  assert.ok(sent[0].includes(notice))
})

test('OneBot charge notices use NapCat reply segments', async () => {
  const sent = []
  const session = {
    platform: 'onebot',
    messageId: '1969429000',
    send: async (message) => { sent.push(message) },
  }
  await iface.sendNotices(session, ['已扣除 750 P 点，当前模型：anima-base-v1.0.safetensors，--seed=123456'], { quote: true })
  assert.strictEqual(sent.length, 1)
  assert.ok(sent[0].includes('<reply id="1969429000"/>'))
})

test('charged batch notice keeps actual seeds in generation order and suppresses administrators', () => {
  assert.strictEqual(iface.buildChargeNotice({
    isAdmin: false,
    totalPrice: 1500,
    unetName: 'animagine-xl-3.1.safetensors',
    seeds: [90210, 42, 777],
  }), '已扣除 1500 P 点，当前模型：animagine-xl-3.1.safetensors，--seed=90210,42,777')
  assert.strictEqual(iface.buildChargeNotice({
    isAdmin: true,
    totalPrice: 1500,
    unetName: 'animagine-xl-3.1.safetensors',
    seeds: [90210],
  }), '')
  assert.strictEqual(iface.buildChargeNotice({
    isAdmin: false,
    totalPrice: 0,
    unetName: 'animagine-xl-3.1.safetensors',
    seeds: [],
  }), '')
})

test('successful completion reply returns charge details through the command result', () => {
  const session = { text: () => '' }
  assert.strictEqual(iface.buildGenerationReply(session, {
    successCount: 1,
    count: 1,
    failures: [],
    chargeNotice: '已扣除 750 P 点，当前模型：anima-base-v1.0.safetensors，--seed=123456',
  }), '已扣除 750 P 点，当前模型：anima-base-v1.0.safetensors，--seed=123456')
})

test('batch execution preserves the exact prompt for every successful image', async () => {
  const batch = await iface.executeBatch('tester', true, 2, 0, async (index) => ({
    ok: true,
    outputs: [`https://example.com/${index}.png`],
    prompt: `prompt-${index}`,
  }))
  assert.deepStrictEqual(batch.results.map(item => item.prompt), ['prompt-0', 'prompt-1'])
})

test('i18n dict exposes generation messages', () => {
  assert.ok(plugin.Config)
  assert.ok(zhCN.commands['p-draw'].messages.generating)
})

test('continuous generation is absent from configuration, help, and command handling', () => {
  const messages = zhCN.commands['p-draw'].messages
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')
  const removedMessageKey = ['ser', 'ies-usage'].join('')

  assert.strictEqual(plugin.Config.dict.seriesAskTimeout, undefined)
  assert.ok(!messages.usage.includes('\u8fde' + '\u7eed'))
  assert.strictEqual(messages[removedMessageKey], undefined)
  assert.ok(!source.includes('handleGenerate' + 'Series'))
  assert.ok(!source.includes("text.match(/^\u8fde\u7eed\\s*(.*)$/)"))
  assert.deepStrictEqual(ctx.commands, ['p/p-draw [prompt:rawtext]'])
})
