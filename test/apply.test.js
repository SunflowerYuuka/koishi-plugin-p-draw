'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const path = require('path')
const os = require('os')
const fs = require('fs')

const plugin = require('../index.js')
const { zhCN } = require('../lib/i18n')

// 统一的测试临时目录：进程退出时自动清理，避免在系统临时目录留下垃圾
const tempDirs = []
const disposeHandlers = []
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
process.on('exit', () => {
  // 先跑插件注册的 dispose（清理它自己的临时目录），再清理测试自己建的目录
  for (const handler of disposeHandlers) {
    try { handler() } catch (e) { /* ignore */ }
  }
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) { /* ignore */ }
  }
})

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
    baseDir: tmpDir('pdrawtest-ctx-'),
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
    on: (event, handler) => {
      if (event === 'dispose' && typeof handler === 'function') disposeHandlers.push(handler)
    },
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
  assert.ok('fixedCharacters' in plugin.Config({}).prompt)
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

test('charged batch notice keeps actual seeds in generation order and shows model/seed to admins', () => {
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
  }), '当前模型：animagine-xl-3.1.safetensors，--seed=90210')
  assert.strictEqual(iface.buildChargeNotice({
    isAdmin: false,
    totalPrice: 0,
    unetName: 'animagine-xl-3.1.safetensors',
    seeds: [],
  }), '')
  assert.strictEqual(iface.buildChargeNotice({
    isAdmin: true,
    totalPrice: 0,
    unetName: 'animagine-xl-3.1.safetensors',
    seeds: [],
  }), '')
})

test('successful completion sends charge notice directly without a quote segment', async () => {
  const sent = []
  const session = {
    messageId: '1742313783',
    send: async (message) => { sent.push(message) },
  }
  const notice = iface.buildChargeNotice({
    isAdmin: true,
    totalPrice: 750,
    unetName: 'anima-base-v1.0.safetensors',
    seeds: [123456],
  })
  await iface.sendNotices(session, [notice])
  assert.strictEqual(sent.length, 1)
  assert.ok(typeof sent[0] === 'string')
  assert.ok(!sent[0].includes('<quote'))
  assert.ok(!sent[0].includes('<reply'))
  assert.ok(sent[0].includes('当前模型：anima-base-v1.0.safetensors，--seed=123456'))
})

test('successful completion reply carries only failures and notes', () => {
  const session = { text: () => '' }
  assert.strictEqual(iface.buildGenerationReply(session, {
    successCount: 1,
    count: 1,
    failures: [],
  }), '')
})

test('batch execution preserves the exact prompt for every successful image', async () => {
  const batch = await iface.executeBatch('tester', true, 2, 0, async (index) => ({
    ok: true,
    outputs: [`https://example.com/${index}.png`],
    prompt: `prompt-${index}`,
  }))
  assert.deepStrictEqual(batch.results.map(item => item.prompt), ['prompt-0', 'prompt-1'])
})

test('batch LLM optimization is selected per image for global and admin optimization', () => {
  assert.strictEqual(iface.shouldOptimizePerImage({ count: 1, enabled: true, admin: false }), false)
  assert.strictEqual(iface.shouldOptimizePerImage({ count: 5, enabled: true, admin: false }), true)
  assert.strictEqual(iface.shouldOptimizePerImage({ count: 5, enabled: false, admin: true }), true)
  assert.strictEqual(iface.shouldOptimizePerImage({ count: 5, enabled: false, admin: false }), false)
})

test('i18n dict exposes generation messages', () => {
  assert.ok(plugin.Config)
  assert.ok(zhCN.commands['p-draw'].messages.generating)
})

test('continuous generation is absent from configuration, help, and command handling', () => {
  const messages = zhCN.commands['p-draw'].messages
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')
  const removedMessageKey = ['ser', 'ies-usage'].join('')

  assert.strictEqual('seriesAskTimeout' in plugin.Config({}), false)
  assert.ok(!messages.usage.includes('\u8fde' + '\u7eed'))
  assert.strictEqual(messages[removedMessageKey], undefined)
  assert.ok(!source.includes('handleGenerate' + 'Series'))
  assert.ok(!source.includes("text.match(/^\u8fde\u7eed\\s*(.*)$/)"))
  assert.deepStrictEqual(ctx.commands, ['p/p-draw [prompt:rawtext]'])
})

// ---------------- Design.md A4/A7：质量前缀与 Aesthetic 适配 ----------------

test('custom workflow skips the quality prefix when the switch is on (A4)', async () => {
  const saved = {
    customWorkflowEnabled: cfg.customWorkflowEnabled,
    skipQualityPrefixForCustomWorkflow: cfg.skipQualityPrefixForCustomWorkflow,
    qualityPrefix: cfg.qualityPrefix,
    artistPresets: cfg.artistPresets,
    activeArtistPreset: cfg.activeArtistPreset,
    defaultArtistTags: cfg.defaultArtistTags,
    styleTags: cfg.styleTags,
  }
  try {
    cfg.qualityPrefix = 'masterpiece, best quality'
    cfg.artistPresets = []
    cfg.activeArtistPreset = ''
    cfg.defaultArtistTags = ''
    cfg.styleTags = ''

    // 内置工作流：质量前缀照常注入
    cfg.customWorkflowEnabled = false
    const builtin = await iface.composePrompt('1girl, solo', false)
    assert.ok(builtin.prompt.includes('masterpiece'))

    // 自定义工作流 + 默认开关(true)：跳过质量前缀
    cfg.customWorkflowEnabled = true
    cfg.skipQualityPrefixForCustomWorkflow = true
    const skipped = await iface.composePrompt('1girl, solo', false)
    assert.ok(!skipped.prompt.includes('masterpiece'))
    assert.ok(skipped.prompt.includes('1girl'))

    // 关掉开关：仍然注入
    cfg.skipQualityPrefixForCustomWorkflow = false
    const kept = await iface.composePrompt('1girl, solo', false)
    assert.ok(kept.prompt.includes('masterpiece'))
  } finally {
    Object.assign(cfg, saved)
  }
})

test('qualityPrefixWarning hints about Aesthetic migration only for custom workflows (A7)', () => {
  const saved = {
    customWorkflowEnabled: cfg.customWorkflowEnabled,
    skipQualityPrefixForCustomWorkflow: cfg.skipQualityPrefixForCustomWorkflow,
    qualityPrefix: cfg.qualityPrefix,
  }
  try {
    // 内置工作流：不提示
    cfg.customWorkflowEnabled = false
    cfg.qualityPrefix = 'masterpiece'
    assert.strictEqual(iface.qualityPrefixWarning(), '')

    // 自定义工作流 + 空前缀：不提示
    cfg.customWorkflowEnabled = true
    cfg.qualityPrefix = ''
    assert.strictEqual(iface.qualityPrefixWarning(), '')

    // 自定义工作流 + 非空前缀 + 已自动跳过
    cfg.qualityPrefix = 'masterpiece'
    cfg.skipQualityPrefixForCustomWorkflow = true
    assert.ok(iface.qualityPrefixWarning().includes('已自动跳过'))
    assert.ok(iface.qualityPrefixWarning().includes('建议手动置空'))

    // 自定义工作流 + 非空前缀 + 未跳过
    cfg.skipQualityPrefixForCustomWorkflow = false
    assert.ok(iface.qualityPrefixWarning().includes('可能不适用于 Aesthetic'))
  } finally {
    Object.assign(cfg, saved)
  }
})

test('diagnoseText reports custom workflow node IDs without contacting ComfyUI', async () => {
  const path_ = require('path')
  const os_ = require('os')
  const fs_ = require('fs')
  const dir = tmpDir('pdrawtest-diag-')
  const wfFile = path_.join(dir, 'wf.json')
  fs_.writeFileSync(wfFile, JSON.stringify({
    '1': { class_type: 'KSampler', inputs: { positive: ['10', 0], negative: ['11', 0], seed: 0 } },
    '10': { class_type: 'CLIPTextEncode', inputs: { text: 'p', clip: ['2', 0] } },
    '11': { class_type: 'CLIPTextEncode', inputs: { text: 'n', clip: ['2', 0] } },
  }))

  const saved = {
    customWorkflowEnabled: cfg.customWorkflowEnabled,
    customWorkflowPath: cfg.customWorkflowPath,
    qualityPrefix: cfg.qualityPrefix,
    comfyuiBaseUrl: cfg.comfyuiBaseUrl,
  }
  try {
    cfg.customWorkflowEnabled = true
    cfg.customWorkflowPath = wfFile
    cfg.qualityPrefix = 'masterpiece'
    // 指向不可达地址，避免诊断依赖真实 ComfyUI
    cfg.comfyuiBaseUrl = 'http://127.0.0.1:1'
    const text = await iface.diagnoseText({ userId: 'u1' })
    assert.ok(text.includes('自定义工作流'))
    assert.ok(text.includes('#10'))
    assert.ok(text.includes('#11'))
    assert.ok(text.includes('masterpiece 对 Aesthetic') || text.includes('建议手动置空'))
  } finally {
    Object.assign(cfg, saved)
  }
})

// ---------------- 配置分组（控制台折叠） ----------------

test('config is grouped into collapsible nested sections', () => {
  const schema = plugin.Config
  const resolved = schema({})
  const groups = Object.keys(resolved)

  assert.ok(groups.length >= 10, '应该切出足够多的分组')
  // 每个分组必须是对象：控制台只对嵌套 object 字段渲染折叠箭头（intersect 分支是平铺的）
  for (const group of groups) {
    assert.strictEqual(typeof resolved[group], 'object', group + ' 应为分组对象')
    assert.ok(!Array.isArray(resolved[group]), group + ' 不应是数组')
    assert.ok(Object.keys(resolved[group]).length > 0, group + ' 不应为空组')
  }

  // 关键字段各就各位
  assert.ok('comfyuiBaseUrl' in resolved.connection)
  assert.ok('unetName' in resolved.model)
  assert.ok('modelParams' in resolved.model)
  assert.ok('negativePrompt' in resolved.prompt)
  assert.ok('batchMax' in resolved.queue)
  assert.ok('price' in resolved.pricing)
  assert.ok('adminOnly' in resolved.access)
  assert.ok('workflowPresets' in resolved.workflow)
  assert.ok('llmModels' in resolved.llm)
  assert.ok('tavilyProxy' in resolved.search)
  assert.ok('verifyLlmModels' in resolved.vision)

  // 不能再有顶层扁平键，否则说明退回 intersect、折叠会失效
  assert.ok(!('unetName' in resolved), '顶层不应再有扁平键')
})

test('normalizeConfig flattens groups and lets legacy flat keys win', () => {
  // 老配置：全扁平 → 就地摊平，引用不变
  const flat = { unetName: 'legacy.safetensors', cfg: 4.5, qualityPrefix: 'masterpiece' }
  const r1 = iface.normalizeConfig(flat)
  assert.strictEqual(r1.config, flat, '应就地摊平并保持对象引用（测试和外部持有的 cfg 才能继续生效）')
  assert.strictEqual(r1.config.unetName, 'legacy.safetensors')
  assert.strictEqual(r1.config.cfg, 4.5)
  assert.deepStrictEqual(r1.legacy.sort(), ['cfg', 'qualityPrefix', 'unetName'])

  // 新配置：分组值摊平到顶层
  const r2 = iface.normalizeConfig({ model: { unetName: 'new.safetensors', cfg: 3 }, prompt: { qualityPrefix: '' } })
  assert.strictEqual(r2.config.unetName, 'new.safetensors')
  assert.strictEqual(r2.config.cfg, 3)
  assert.deepStrictEqual(r2.legacy, [])

  // 混合：旧扁平键优先，避免已生效的设置被默认值顶掉
  const r3 = iface.normalizeConfig({ model: { unetName: 'grouped.safetensors' }, unetName: 'flat.safetensors' })
  assert.strictEqual(r3.config.unetName, 'flat.safetensors')
  assert.deepStrictEqual(r3.legacy, ['unetName'])
})

// ---------------- 按预设定价 ----------------

test('presetPrice returns per-preset price and falls back when unset', () => {
  const f = iface.presetPrice
  assert.strictEqual(f(null), null, '没有预设 → 用全局价')
  assert.strictEqual(f({}), null, '预设没配 price → 用全局价')
  assert.strictEqual(f({ price: '' }), null)
  assert.strictEqual(f({ price: 'abc' }), null)
  assert.strictEqual(f({ price: 0 }), 0, '0 是合法值（免费）')
  assert.strictEqual(f({ price: 1200 }), 1200)
  assert.strictEqual(f({ price: '800' }), 800)
})

// ---------------- 分组名与旧扁平键撞名 ----------------

test('a group named workflow is not mistaken for the old flat key', () => {
  const r = iface.normalizeConfig({
    connection: { comfyuiBaseUrl: 'http://127.0.0.1:8188' },
    workflow: {
      customWorkflowEnabled: true,
      workflowPresets: { '基础': { path: 'a.json', price: 750 } },
    },
  })
  assert.deepStrictEqual(r.legacy, [], '同名分组不应被当成旧扁平键（会误报警告）')
  assert.strictEqual(r.config.customWorkflowEnabled, true, '分组内的字段仍要摊平生效')
  assert.ok(r.config.workflowPresets && r.config.workflowPresets['基础'], '预设字典要保留')
})

test('genuine flat legacy keys are still reported and still win', () => {
  const r = iface.normalizeConfig({
    price: 500,
    pricing: { price: 999 },   // 分组里的值不该覆盖扁平旧键
  })
  assert.deepStrictEqual(r.legacy, ['price'])
  assert.strictEqual(r.config.price, 500, '扁平旧键优先级更高')
})

test('the legacy workflow display field no longer collides with the workflow group', () => {
  const c = require('../index.js').Config({})
  assert.deepStrictEqual(Object.keys(c.legacy), ['legacyWorkflow'])
  assert.strictEqual(c.legacy.legacyWorkflow, 'anima_t2i')
  assert.ok('workflowPresets' in c.workflow, 'workflow 分组仍然正常')
})
