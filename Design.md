以下内容作为前序设计文档的**附录**，将对接目标锁定为 **Anima Aesthetic 1.1 的 Text-to-Image Baseline 工作流**（约 17 个节点）。Agent 应把这份附录作为实现时的首选路径，前序文档中的通用逻辑保持不变，只替换“工作流准备”与“配置默认值”部分。

---

# 附录：指定对接 Anima Aesthetic 1.1

## A1. 目标工作流：Text-to-Image Baseline

Anima Aesthetic 1.1 官方/社区发布的 10 个工作流中，**Text-to-Image Baseline** 是结构最精简、最适合插件对接的一个。它包含约 **17 个节点**，核心链路为：

```
UNETLoader (anima-aesthetic-v1.1) 
    → CLIPLoader (qwen_3_06b_base) 
    → EmptyLatentImage 
    → KSampler (er_sde, 30 steps, CFG 4) 
    → VAEDecode (Qwen-Image VAE) 
    → SaveImage
```

**推荐参数**（已由社区文档确认）：采样器 `er_sde`，调度器 `simple`，步数 **30**，CFG **4**，分辨率范围 **512–1536px**。Aesthetic 版本对低 CFG 的容忍度较高，CFG 3 也常常能产生更好的效果。

## A2. 模型文件与目录（必须精确匹配）

| 文件 | 目标目录 | 说明 |
|---|---|---|
| `anima-aesthetic-v1.1.safetensors` | `ComfyUI/models/diffusion_models/` | 约 **4.18GB**，BF16 精度 |
| `qwen_3_06b_base.safetensors` | `ComfyUI/models/text_encoders/` | 文本编码器，与 Base 模型共用 |
| `qwen_image_vae.safetensors` | `ComfyUI/models/vae/` | VAE，与 Base 模型共用 |

**8G 显存强烈建议**：使用 **GGUF Q8_0 量化版**（约 2.1GB），通过 `ComfyUI-GGUF` 插件的 `UnetLoaderGGUF` 节点加载。GGUF 版的推荐参数为 `euler`/`euler a`、`normal` 调度器、30–50 步、CFG 4–5。Agent 应在文档中同时给出 safetensors 和 GGUF 两种路径，但**默认配置推荐 GGUF**，以适配 4060 8G。

## A3. 节点 ID 的确定与配置填写

节点 ID 不是固定值，取决于用户实际使用的 JSON 文件。Agent 需要在文档中引导用户完成以下识别步骤：

1. 在 ComfyUI 中加载 `text2image anima-aesthetic-v1.1.json`。
2. 选中 **正面 CLIPTextEncode** 节点（标题通常为 “CLIP Text Encode (Positive Prompt)”），记下节点 ID（如 `6`）。
3. 选中 **负面 CLIPTextEncode** 节点，记下 ID（如 `7`）。
4. 选中 **EmptyLatentImage** 节点，记下 ID（如 `5`），填入 `resolutionNodeId`（可选）。
5. 选中 **KSampler** 节点，记下 ID（如 `3`），填入 `seedNodeId` 和 `stepsNodeId`（可选）。

在 `p-draw` 配置中的填写示例：

```yaml
customWorkflowEnabled: true
customWorkflowPath: "data/p-draw/workflows/anima-aesthetic-v1.1.json"
positivePromptNodeId: "6"
negativePromptNodeId: "7"
resolutionNodeId: "5"
seedNodeId: "3"
stepsNodeId: "3"
customWorkflowOverrideParameters: true
```

**重要**：如果用户的导出文件中节点 ID 与示例不同，以实际文件为准。Agent 不应在代码中硬编码任何节点 ID；节点 ID 始终来自配置。

## A4. 与 Base 模型的关键差异（提示词层）

Aesthetic 1.1 在 **80 万张高质量图像**上微调，**训练时已经剥离了质量标签**，因此正面提示词中 **不需要** `masterpiece, best quality, score_7` 之类的质量前缀。这与当前 `p-draw` 的 `qualityPrefix` 默认值（`masterpiece, best quality, score_7, safe,`）存在冲突。

**Agent 需要做的适配**：

- 在文档中明确告知用户：**使用 Aesthetic 1.1 时，建议将 `qualityPrefix` 设为空字符串**，或在自定义工作流路径下由 Agent 增加一个开关 `skipQualityPrefixForCustomWorkflow`（默认 `true`），当 `customWorkflowEnabled=true` 时自动跳过质量前缀注入。
- 负面提示词可以比 Base 模型更简洁。推荐值为：`worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts`。当前 `p-draw` 的 `negativePrompt` 默认值已接近此推荐，无需大幅改动，但 Agent 可以在文档中给出上述更精确的版本供用户选择。

## A5. 配置项最终形态（对接 Aesthetic 1.1）

在前序文档第 3 节的基础上，针对 Aesthetic 1.1 的推荐配置汇总如下（可直接作为用户配置模板）：

```yaml
comfyuiBaseUrl: "http://127.0.0.1:8188"

# 自定义工作流
customWorkflowEnabled: true
customWorkflowPath: "data/p-draw/workflows/anima-aesthetic-v1.1.json"
positivePromptNodeId: "<用户实际正面节点ID>"
negativePromptNodeId: "<用户实际负面节点ID>"
resolutionNodeId: "<可选，EmptyLatentImage节点ID>"
seedNodeId: "<可选，KSampler节点ID>"
stepsNodeId: "<可选，KSampler节点ID>"
customWorkflowOverrideParameters: true
customWorkflowReloadOnChange: true

# 8G 显存友好参数（写入工作流内，或通过 resolutionNodeId 覆盖）
width: 1024
height: 1024
steps: 30
cfg: 4.0
samplerName: "er_sde"
scheduler: "simple"

# 提示词（Aesthetic 1.1 适配）
qualityPrefix: ""
negativePrompt: "worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts"

# 如果使用 GGUF 量化
# 工作流内 UnetLoaderGGUF 节点选择 anima-aesthetic-v1.1-Q8_0.gguf
```

## A6. 验收标准（追加）

在前序文档第 8 节的基础上，增加以下针对 Aesthetic 1.1 的检查项：

- [ ] 使用 `text2image anima-aesthetic-v1.1.json` 作为自定义工作流，发送 `画图 1girl, solo, 白色裙子`，正面提示词被正确写入 CLIPTextEncode 节点，生成图像不带有“过度锐化”或“风格偏移”等 Base 模型常见的质量问题。
- [ ] `qualityPrefix` 设为空后，生成结果的画风保持 Aesthetic 1.1 的默认美学水平，不因缺少质量标签而劣化。
- [ ] 若使用 GGUF Q8_0 版本，显存占用峰值不超过 **7.5GB**，单张 1024×1024 / 30 步生成在 **30 秒量级**。
- [ ] 用户更换 `text2image anima-aesthetic-v1.1.json` 后，在 `customWorkflowReloadOnChange=true` 下无需重启插件即可生效。

## A7. 给 Agent 的额外约束

- **不要**在代码中内置任何特定 JSON 文件。工作流文件由用户从 ComfyUI 导出后放入 `data/p-draw/workflows/`，Agent 只负责读取和注入。
- **不要**假设节点 ID 固定为 `6`/`7`/`5`/`3`。这些数字仅作为文档示例；Agent 必须让用户在配置中填写实际 ID。
- **不要**为 Aesthetic 1.1 自动注入质量前缀。如果用户从 Base 模型迁移过来，Agent 应在诊断信息中提示“检测到自定义工作流已启用，qualityPrefix 可能不适用于 Aesthetic 模型，建议手动置空”。

---