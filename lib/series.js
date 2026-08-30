// 连续图阶段串联器。
// 通过注入 runStage 保持纯粹：上阶段成功输出会成为下一阶段的参考图来源。

function createSeriesStageRunner(stagePrompts, runStage) {
  let previousOutput = null
  let chainError = ''
  return async function run(index) {
    if (chainError) return { ok: false, message: chainError }
    let result
    try {
      result = await runStage({
        index,
        prompt: String(stagePrompts[index] || ''),
        previousOutput,
      })
    } catch (error) {
      chainError = error && error.message ? error.message : `连续图第 ${index + 1} 阶段生成失败`
      return { ok: false, message: chainError }
    }
    if (result && result.ok && Array.isArray(result.outputs) && result.outputs.length) {
      previousOutput = result.outputs[0]
    } else if (!result || !result.ok) {
      chainError = (result && result.message) || `连续图第 ${index + 1} 阶段生成失败`
    }
    return result
  }
}

module.exports = { createSeriesStageRunner }
