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

// 构造一个「会自动套代理」的 fetch。
// getProxy() 每次调用都求值，配置热更新即时生效；onWarn 用于把降级原因告诉用户。
function createOutboundFetch({ getProxy, onWarn } = {}) {
  let warned = false
  return async function outboundFetch(url, options = {}) {
    const proxy = normalizeProxyUrl(typeof getProxy === 'function' ? getProxy() : getProxy)
    if (!proxy) return fetch(url, options)

    const dispatcher = resolveDispatcher(proxy)
    if (!dispatcher) {
      if (!warned && typeof onWarn === 'function') {
        warned = true
        onWarn(`已配置代理 ${proxy}，但无法启用（缺少 undici 依赖），本次及后续请求将直连。`)
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
