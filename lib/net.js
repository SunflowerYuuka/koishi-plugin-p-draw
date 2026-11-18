// 出站 HTTP：可选代理（Tavily / LLM / 视觉校验共用）。
//
// Node 内置 fetch 不支持直接用代理，这里通过 undici 的 ProxyAgent 挂 dispatcher。
// undici 属于可选依赖：拿不到时降级为直连，并且只告警一次，不影响其他功能。

let undiciModule = null
let undiciLoaded = false

function loadUndici() {
  if (undiciLoaded) return undiciModule
  undiciLoaded = true
  try {
    // eslint-disable-next-line global-require
    undiciModule = require('undici')
  } catch (e) {
    undiciModule = null
  }
  return undiciModule
}

// 允许省略协议：127.0.0.1:7890 → http://127.0.0.1:7890
function normalizeProxyUrl(value) {
  const raw = String(value == null ? '' : value).trim()
  if (!raw) return ''
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
}

// 是否能用上真实代理（undici 可用且 ProxyAgent 能构造）
const dispatcherCache = new Map()

function resolveDispatcher(proxyUrl) {
  const url = normalizeProxyUrl(proxyUrl)
  if (!url) return null
  if (dispatcherCache.has(url)) return dispatcherCache.get(url)
  const mod = loadUndici()
  let dispatcher = null
  if (mod && typeof mod.ProxyAgent === 'function') {
    try {
      dispatcher = new mod.ProxyAgent(url)
    } catch (e) {
      dispatcher = null
    }
  }
  dispatcherCache.set(url, dispatcher)
  return dispatcher
}

function proxySupportAvailable() {
  const mod = loadUndici()
  return Boolean(mod && typeof mod.ProxyAgent === 'function')
}

// 构造一个「按次指定代理」的 fetch：outboundFetch(url, options, proxyUrl)。
//
// 代理是分用途配置的（联网搜索 / 文本 LLM / 视觉校验各一套），所以这里不在工厂里
// 绑定代理，而是每次调用由调用方传入；proxyUrl 为空即直连。
function createOutboundFetch({ onWarn } = {}) {
  const warned = new Set()
  return async function outboundFetch(url, options = {}, proxyUrl = '') {
    const proxy = normalizeProxyUrl(proxyUrl)
    if (!proxy) return fetch(url, options)

    const dispatcher = resolveDispatcher(proxy)
    if (!dispatcher) {
      if (!warned.has(proxy) && typeof onWarn === 'function') {
        warned.add(proxy)
        onWarn(`已配置代理 ${proxy}，但无法启用（缺少 undici 依赖），该代理将被忽略，本次直连。`)
      }
      return fetch(url, options)
    }
    return fetch(url, { ...options, dispatcher })
  }
}

function clearDispatcherCache() {
  dispatcherCache.clear()
}

module.exports = {
  normalizeProxyUrl,
  resolveDispatcher,
  proxySupportAvailable,
  createOutboundFetch,
  clearDispatcherCache,
}
