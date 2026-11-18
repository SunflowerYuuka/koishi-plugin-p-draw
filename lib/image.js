// 图生图用的图片搬运：把聊天里的图片下载下来，再上传到 ComfyUI 的 input 目录。
// 只做纯逻辑 + 一个注入的 fetch，方便单测。

function guessContentType(name) {
  const ext = String(name || '').toLowerCase().split('.').pop()
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'bmp') return 'image/bmp'
  return 'image/png'
}

// data:image/png;base64,xxxx → { buffer, contentType }
function decodeDataUrl(source) {
  const text = String(source || '')
  const match = text.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/i)
  if (!match) return null
  const contentType = match[1] || 'image/png'
  const isBase64 = Boolean(match[2])
  try {
    const buffer = isBase64
      ? Buffer.from(match[3], 'base64')
      : Buffer.from(decodeURIComponent(match[3]), 'binary')
    return { buffer, contentType }
  } catch (e) {
    return null
  }
}

// 组装 multipart/form-data（不引第三方依赖）
function buildMultipart(fields, file) {
  const boundary = `----pdraw${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`
  const chunks = []
  for (const [name, value] of Object.entries(fields || {})) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      'utf8',
    ))
  }
  const contentType = file.contentType || guessContentType(file.filename)
  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${file.filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    'utf8',
  ))
  chunks.push(file.buffer)
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'))
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` }
}

// 上传到 ComfyUI，返回 LoadImage 节点可直接用的文件名（可能带子目录）
async function uploadImageToComfy(fetchImpl, baseUrl, { buffer, filename, contentType, subfolder = 'pdraw', overwrite = 'true' }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('图片内容为空')
  // 没给文件名时生成唯一名，避免并发时互相覆盖
  const fallback = `pdraw_${Date.now()}_${Math.random().toString(16).slice(2, 8)}.png`
  const safeName = String(filename || fallback).replace(/[\\/:*?"<>|]/g, '_')
  const { body, contentType: headerValue } = buildMultipart(
    { type: 'input', subfolder, overwrite },
    { buffer, filename: safeName, contentType },
  )
  const res = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/upload/image`, {
    method: 'POST',
    headers: { 'Content-Type': headerValue },
    body,
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`上传图片失败：HTTP ${res.status}${detail ? ' ' + detail.slice(0, 120) : ''}`)
  }
  const data = await res.json()
  const name = data && data.name
  if (!name) throw new Error('上传图片失败：ComfyUI 没有返回文件名')
  const sub = data.subfolder ? String(data.subfolder).replace(/^\/+|\/+$/g, '') : ''
  return sub ? `${sub}/${name}` : name
}

module.exports = {
  guessContentType,
  decodeDataUrl,
  buildMultipart,
  uploadImageToComfy,
}
