// ComfyUI HTTP 客户端工厂：统一 GET/POST/GET-bytes，带超时与错误详情提取。
// 不再需要在 apply 里重复三套 fetch + AbortController。

// 构造 ComfyUI 专用客户端。getBaseUrl 在每次调用时求值，保证配置热更新生效。
function buildComfyClient({ getBaseUrl }) {
  async function get(apiPath, timeout = 20000) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const res = await fetch(getBaseUrl() + apiPath, { signal: controller.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } finally {
      clearTimeout(timer)
    }
  }

  async function post(apiPath, body, timeout = 20000) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const res = await fetch(getBaseUrl() + apiPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!res.ok) {
        // ComfyUI /prompt 校验失败时会返回 node_errors 等详细错误，尽量带出来便于排查
        const text = await res.text().catch(() => '')
        const detail = (() => {
          try {
            const data = JSON.parse(text)
            const nodeErrors = (data && data.node_errors) || (data && data.error && data.error.extra_info && data.error.extra_info.node_errors) || null
            if (nodeErrors && typeof nodeErrors === 'object') {
              const lines = Object.entries(nodeErrors).map(([id, e]) => {
                const cls = (e && e.class_type) || ''
                const errs = (e && Array.isArray(e.errors) && e.errors.length)
                  ? e.errors.map(x => `${(x && x.message) || ''}${x && x.details ? ' | ' + x.details : ''}`.trim()).join('; ')
                  : JSON.stringify(e)
                return `  #${id} [${cls}]: ${errs}`
              })
              if (lines.length) return `\n${lines.join('\n')}`
            }
            if (data && data.error) {
              return `${data.error.message || ''}${data.error.details ? ' ' + data.error.details : ''}`.trim()
            }
          } catch (e) { /* ignore */ }
          return text.slice(0, 800)
        })()
        throw new Error(`HTTP ${res.status}${detail ? '：' + detail : ''}`)
      }
      return await res.json()
    } finally {
      clearTimeout(timer)
    }
  }

  async function getBytes(apiPath, timeout = 120000) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const res = await fetch(getBaseUrl() + apiPath, { signal: controller.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    } finally {
      clearTimeout(timer)
    }
  }

  return { get, post, getBytes }
}

module.exports = { buildComfyClient }
