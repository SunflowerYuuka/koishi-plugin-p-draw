// 消息媒体来源处理。
// OneBot 不一定能读取机器人进程本地的 file:// 路径，因此发送前转换为 Buffer。

const fsp = require('fs/promises')
const { fileURLToPath } = require('url')

async function materializeImageSource(source, readFile = fsp.readFile) {
  if (typeof source !== 'string' || !/^file:\/\//i.test(source)) return source
  let filePath
  try {
    filePath = fileURLToPath(source)
  } catch (e) {
    return source
  }
  try {
    return await readFile(filePath)
  } catch (e) {
    return source
  }
}

module.exports = { materializeImageSource }
