// ComfyUI 结果等待与输出提取。
// waitComfyResult 依赖一个注入的 comfyGet（由 http 客户端提供），可独立单测。

function outputImages(history) {
  const images = []
  const outputs = history.outputs || {}
  if (outputs && typeof outputs === 'object') {
    for (const nodeOutput of Object.values(outputs)) {
      if (!nodeOutput || typeof nodeOutput !== 'object') continue
      for (const image of nodeOutput.images || []) {
        if (image && typeof image === 'object') images.push(image)
      }
    }
  }
  return images
}

// ------------------------------------------------------------------
// ComfyUI 结果等待：优先 WebSocket 事件，失败/不可用回退轮询
// ------------------------------------------------------------------
function waitViaWebSocket(baseUrl, promptId, clientId, timeoutMs) {
  return new Promise((resolve) => {
    let socket
    let timer = null
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try { if (socket) socket.close() } catch (e) { /* ignore */ }
      resolve(ok)
    }
    try {
      const wsUrl = baseUrl.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:') + `/ws?clientId=${encodeURIComponent(clientId)}`
      socket = new WebSocket(wsUrl)
    } catch (e) {
      finish(false)
      return
    }
    timer = setTimeout(() => finish(false), timeoutMs)
    socket.onmessage = (ev) => {
      let msg
      try { msg = JSON.parse(String(ev.data)) } catch (e) { return }
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'execution_success' && msg.data && msg.data.prompt_id === promptId) { finish(true); return }
      if (msg.type === 'execution_error' || msg.type === 'execution_interrupted') { finish(false) }
    }
    socket.onerror = () => finish(false)
    socket.onclose = () => finish(false)
  })
}

async function waitComfyResult(ctx, comfyGet, baseUrl, promptId, clientId, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs
  if (typeof WebSocket !== 'undefined') {
    const remaining = Math.max(0, deadline - Date.now())
    try {
      const viaWs = await waitViaWebSocket(baseUrl, promptId, clientId, remaining)
      if (viaWs) {
        try {
          const data = await comfyGet(`/history/${promptId}`, 20000)
          if (data && data[promptId]) return data[promptId]
        } catch (e) { /* fall through */ }
      }
    } catch (e) { /* fall through to polling */ }
  }
  while (Date.now() < deadline) {
    try {
      const data = await comfyGet(`/history/${promptId}`, 20000)
      if (data && data[promptId]) return data[promptId]
    } catch (e) { /* transient */ }
    await ctx.sleep(pollMs)
  }
  return null
}

module.exports = {
  outputImages,
  waitViaWebSocket,
  waitComfyResult,
}
