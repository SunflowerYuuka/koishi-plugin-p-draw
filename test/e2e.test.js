'use strict'
// 端到端链路测试：用 stub ComfyUI 跑通一次真实生成，
// 断言 Design.md A4/A6 的关键行为——提示词写到配置的节点、跳过质量前缀、参数覆盖、loader 不被改写。
const { test } = require('node:test')
const assert = require('node:assert')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')

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

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001',
  'hex',
)

// 贴近 text2image anima-aesthetic-v1.1.json 的最小图（节点 ID 仅测试用）
function aestheticGraph() {
  return {
    '1': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'anima-aesthetic-v1.1-Q8_0.gguf' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_06b_base.safetensors', type: 'stable_diffusion' } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: 'pos', clip: ['2', 0] } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: 'neg', clip: ['2', 0] } },
    '6': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    '7': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0], seed: 0, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['2', 0] } },
    '10': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'ComfyUI' } },
  }
}

function startStubComfy() {
  const state = { captured: null }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method === 'POST' && url.pathname === '/prompt') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        state.captured = JSON.parse(body)
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ prompt_id: 'p1' }))
      })
      return
    }
    if (url.pathname === '/system_stats') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        system: { comfyui_version: 'stub' },
        devices: [{ name: 'StubGPU', vram_total: 8 * 1024 ** 3, vram_free: 7 * 1024 ** 3 }],
      }))
      return
    }
    if (url.pathname === '/history/p1') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        p1: { status: { status_str: 'success' }, outputs: { '10': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } } },
      }))
      return
    }
    if (url.pathname === '/view') {
      res.setHeader('Content-Type', 'image/png')
      res.end(PNG)
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  return { state, server }
}

function makeCtx(baseDir) {
  const tables = { p_draw_config: [], p_draw_fixed_characters: [] }
  const actions = []
  const matches = (row, query) => Object.entries(query || {}).every(([key, value]) => row[key] === value)
  const noop = () => {}
  const ctx = {
    baseDir,
    logger: () => ({ info: noop, warn: noop, success: noop, error: noop }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    i18n: { define: noop },
    model: { extend: noop },
    on: (event, handler) => {
      if (event === 'dispose' && typeof handler === 'function') disposeHandlers.push(handler)
    },
    database: {
      get: async (table, query = {}) => (tables[table] || []).filter((row) => matches(row, query)).map((row) => ({ ...row })),
      set: async () => {},
      create: async () => ({}),
      remove: async () => {},
    },
  }
  ctx.command = () => {
    const chain = { alias: () => chain, action: (handler) => { actions.push(handler); return chain } }
    return chain
  }
  return { ctx, actions }
}

function makeCfg(port) {
  return {
    comfyuiBaseUrl: `http://127.0.0.1:${port}`,
    workflow: 'anima_t2i',
    // A5：路径相对 Koishi 运行目录
    customWorkflowEnabled: true,
    customWorkflowPath: 'data/p-draw/workflows/anima-aesthetic-v1.1.json',
    customWorkflowOverrideParameters: true,
    customWorkflowReloadOnChange: true,
    // A3：节点 ID 全部来自配置
    positivePromptNodeId: '4',
    negativePromptNodeId: '5',
    resolutionNodeId: '6',
    seedNodeId: '7',
    stepsNodeId: '7',
    timeout: 20,
    pollInterval: 1,
    unetName: 'anima-aesthetic-v1.1-Q8_0.gguf',
    useGgufUnet: 'auto',
    modelParams: {},
    clipName: 'qwen_3_06b_base.safetensors',
    vaeName: 'qwen_image_vae.safetensors',
    width: 1024,
    height: 1024,
    allowedSizes: ['832x1216', '1024x1024', '1216x832', '1024x1536'],
    steps: 30,
    cfg: 4,
    samplerName: 'er_sde',
    scheduler: 'simple',
    // A4：非空质量前缀 + 自定义工作流 → 应被跳过
    qualityPrefix: 'masterpiece, best quality',
    skipQualityPrefixForCustomWorkflow: true,
    negativePrompt: 'worst quality, low quality',
    promptOptimizeEnabled: false,
    llmBaseUrl: '', llmApiKey: '', llmModel: '', llmMaxTokens: 1000,
    webSearchEnabled: false, tavilyApiKey: '', webSearchMaxResults: 5, webSearchDepth: 'basic',
    webSearchQueryTemplate: '', promptOptimizeTemplate: '',
    artistPresets: [], activeArtistPreset: '', defaultArtistTags: '', styleTags: '',
    fixedCharacters: [], userModels: {},
    queueEnabled: false, queueMaxRequests: 0, batchMax: 4,
    price: 500, multiPrice: 900, couponPrice: 3000, couponAskTimeout: 60,
    adminUsers: ['10001'], outputLogs: false,
    multiVerifyEnabled: false, multiVerifyPassScore: 6, multiCandidateCount: 2, multiSendDegradedCandidate: true,
    verifyLlmBaseUrl: '', verifyLlmApiKey: '', verifyLlmModel: '',
    adminOnly: false, allowedUserIds: [], blockedUserIds: [], allowedGroupIds: [], blockedGroupIds: [],
  }
}

test('end-to-end: prompt lands in configured nodes, quality prefix skipped, image delivered', async () => {
  // 强制走轮询，避免 stub 服务器上的 ws:// 连接噪音
  const savedWebSocket = globalThis.WebSocket
  delete globalThis.WebSocket

  const { state, server } = startStubComfy()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  try {
    const baseDir = tmpDir('pdrawtest-e2e-')
    const wfDir = path.join(baseDir, 'data', 'p-draw', 'workflows')
    fs.mkdirSync(wfDir, { recursive: true })
    fs.writeFileSync(path.join(wfDir, 'anima-aesthetic-v1.1.json'), JSON.stringify(aestheticGraph()))

    const { ctx, actions } = makeCtx(baseDir)
    const plugin = require('../index.js')
    const iface = await plugin.apply(ctx, makeCfg(port))

    const sent = []
    const session = {
      userId: '10001',
      platform: 'onebot',
      messageId: 'm1',
      event: { message: { id: 'm1' } },
      text: (key, args) => `${key}${args ? ':' + JSON.stringify(args) : ''}`,
      send: async (content) => { sent.push(content) },
    }

    await actions[0]({ session }, '1girl, solo, white dress')

    const posted = state.captured && state.captured.prompt
    assert.ok(posted, '应向 ComfyUI POST /prompt')

    // A6：正面提示词写入配置的 CLIPTextEncode 节点
    assert.strictEqual(posted['4'].inputs.text, '1girl, solo, white dress')
    assert.ok(posted['5'].inputs.text.includes('worst quality'))

    // A4：自定义工作流下质量前缀被跳过
    assert.ok(!posted['4'].inputs.text.includes('masterpiece'))

    // 参数覆盖落在配置的节点上
    assert.strictEqual(posted['7'].inputs.steps, 30)
    assert.ok(posted['6'].inputs.width >= 832)

    // 用户工作流自身的 loader 不能被改写（A7）
    assert.strictEqual(posted['1'].class_type, 'UnetLoaderGGUF')

    // 图片确实发出去了
    assert.ok(sent.length > 0, '应发送消息')
    assert.ok(sent.some((item) => String(item).includes('figure')), '应以合并转发发送图片')

    // 诊断报告解析到的节点与 A7 提示
    const diag = await iface.diagnoseText({ userId: '10001' })
    assert.ok(diag.includes('#4') && diag.includes('#5'))
    assert.ok(diag.includes('建议手动置空'))
  } finally {
    server.close()
    if (savedWebSocket) globalThis.WebSocket = savedWebSocket
  }
})

test('end-to-end: --steps / --cfg override the workflow and never leak into the prompt', async () => {
  const savedWebSocket = globalThis.WebSocket
  delete globalThis.WebSocket

  const { state, server } = startStubComfy()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  try {
    const baseDir = tmpDir('pdrawtest-e2e-')
    const wfDir = path.join(baseDir, 'data', 'p-draw', 'workflows')
    fs.mkdirSync(wfDir, { recursive: true })
    fs.writeFileSync(path.join(wfDir, 'anima-aesthetic-v1.1.json'), JSON.stringify(aestheticGraph()))

    const { ctx, actions } = makeCtx(baseDir)
    const plugin = require('../index.js')
    await plugin.apply(ctx, makeCfg(port))

    const sent = []
    const session = {
      userId: '10001',
      platform: 'onebot',
      messageId: 'm2',
      event: { message: { id: 'm2' } },
      text: (key, args) => key + (args ? ':' + JSON.stringify(args) : ''),
      send: async (content) => { sent.push(content) },
    }

    // 配置文件里是 steps=30 / cfg=4，命令级参数应覆盖它们
    await actions[0]({ session }, '1girl, solo --steps 45 --cfg 2.5')

    const posted = state.captured && state.captured.prompt
    assert.ok(posted, '应向 ComfyUI POST /prompt')
    assert.strictEqual(posted['7'].inputs.steps, 45, '命令行 --steps 应覆盖配置文件')
    assert.strictEqual(posted['7'].inputs.cfg, 2.5, '命令行 --cfg 应覆盖配置文件')
    // 参数必须从提示词里剥离，不能变成 tag
    assert.strictEqual(posted['4'].inputs.text, '1girl, solo')
    assert.ok(!posted['4'].inputs.text.includes('--'))
  } finally {
    server.close()
    if (savedWebSocket) globalThis.WebSocket = savedWebSocket
  }
})

test('end-to-end: failed LLM model falls through to the next one in the same channel', async () => {
  const savedWebSocket = globalThis.WebSocket
  delete globalThis.WebSocket

  const llmCalls = []
  const captured = { prompt: null }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      if (req.method === 'POST' && url.pathname === '/prompt') {
        captured.prompt = JSON.parse(body).prompt
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ prompt_id: 'p1' }))
        return
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const parsed = JSON.parse(body)
        llmCalls.push({ model: parsed.model, hasThinking: 'thinking' in parsed })
        if (parsed.model === 'bad-model') {
          res.statusCode = 500
          res.end('upstream exploded')
          return
        }
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ choices: [{ message: { content: '1girl, solo, optimized-tags' } }] }))
        return
      }
      if (url.pathname === '/system_stats') {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ system: { comfyui_version: 'stub' }, devices: [{ name: 'StubGPU', vram_total: 8 * 1024 ** 3, vram_free: 7 * 1024 ** 3 }] }))
        return
      }
      if (url.pathname === '/history/p1') {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ p1: { status: { status_str: 'success' }, outputs: { '10': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } } } }))
        return
      }
      if (url.pathname === '/view') { res.setHeader('Content-Type', 'image/png'); res.end(PNG); return }
      res.statusCode = 404
      res.end('{}')
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  try {
    const baseDir = tmpDir('pdrawtest-e2e-')
    const wfDir = path.join(baseDir, 'data', 'p-draw', 'workflows')
    fs.mkdirSync(wfDir, { recursive: true })
    fs.writeFileSync(path.join(wfDir, 'anima-aesthetic-v1.1.json'), JSON.stringify(aestheticGraph()))

    const { ctx, actions } = makeCtx(baseDir)
    const plugin = require('../index.js')
    const config = Object.assign(makeCfg(port), {
      promptOptimizeEnabled: true,
      llmBaseUrl: `http://127.0.0.1:${port}/v1`,
      llmApiKey: 'test-key',
      llmModel: '',
      llmModels: ['bad-model', 'good-model'],
    })
    await plugin.apply(ctx, config)

    const session = {
      userId: '10001',
      platform: 'onebot',
      messageId: 'm3',
      event: { message: { id: 'm3' } },
      text: (key, args) => key + (args ? ':' + JSON.stringify(args) : ''),
      send: async () => {},
    }

    await actions[0]({ session }, '一个女孩站在河岸')

    // 第一个模型失败后必须自动换第二个
    assert.deepStrictEqual(llmCalls.map(c => c.model), ['bad-model', 'good-model'])
    // 非 DeepSeek 端点默认不应携带 thinking（中转站常见 400 原因）
    assert.ok(llmCalls.every(c => c.hasThinking === false), '不应向非 DeepSeek 端点发送 thinking')
    // 最终用的是第二个模型返回的 tags
    assert.ok(captured.prompt, '应已向 ComfyUI 提交')
    assert.strictEqual(captured.prompt['4'].inputs.text, '1girl, solo, optimized-tags')
  } finally {
    server.close()
    if (savedWebSocket) globalThis.WebSocket = savedWebSocket
  }
})
