# koishi-plugin-p-draw

p点-绘图插件，连接本地 ComfyUI 生图，参考 AstrBot 的 [anima 绘图大师](https://github.com/YayiMiko/anima-master) 移植。需要配合 [p-qiandao](https://github.com/gfjdh/koishi-plugin-p-qiandao) 食用。

## 功能

- `p-draw <描述>`（别名：画图 / 生图 / 绘图 / 画画）文生图。
- `p-draw 多人 <描述>` 多人生图（2-4 人画面）：LLM 结构化规划人物分组、互动关系与统一场景，未指定尺寸时按人数/肢体接触自动选横图，生成后可选视觉校验。
- 批量张数：描述后加 `x3` / `×3` / `3张` / `三张` / `--数量 3` 可一次生成多张（上限 `batchMax`，默认 4），按张数 × 单价扣 P 点。
- 自然语言自动优化为 Danbooru tags（可选，需配置 LLM 接口）。
- 联网搜索：描述中带 `联网`/`搜索`/`查一下` 等词时自动补充角色设定（需 Tavily Key）。
- 原样 tags 模式（`无优化` 前缀）。
- 尺寸选择：`竖图` `横图` `方图` `长竖图` `宽屏`，或 `1024x1536：描述` / `--尺寸 1216x832`。
- 采样参数临时覆盖（可选）：`画图 少女 --cfg 3.5 --steps 40`（也可写 `--强度 3.5` / `--步数 40`）。优先级：命令级 > `modelParams` > 全局配置；参数会从提示词里剥离，不会混进 tags。
- 画师组管理（创建 / 追加 / 切换 / 查看 / 删除）。
- 固定角色（`添加角色 名称=tags`，可用 `查看角色` / `删除角色 名称` 管理）。
- **用户自选模型**：`p-draw 模型` 查看当前与可用模型（自动读取 ComfyUI 的 UNET 和 Animagine checkpoint），`p-draw 模型 <名称>` 切换（支持模糊匹配，如 `anima-aesthetic`），`p-draw 模型 默认` 恢复默认。偏好按用户保存（`p_draw_config.user_models`），单人和多人生成都会生效；未自选时用 `unetName` 默认模型。自定义工作流（`customWorkflowEnabled`）不参与模型切换。
- **Animagine XL 3.1**：将模型文件放入 ComfyUI 的 checkpoints 目录后，用 `p-draw 模型 animagine` 选择。该模型使用 SDXL Danbooru/tag 文生图工作流，并复用 `promptOptimizeTemplate`。
- 画师组保存在数据库 `p_draw_config` 表中；固定角色保存在 `p_draw_fixed_characters` 表中，每个角色一行。管理指令不触发插件重载（不会打断正在生成的图，也不会把配置恢复成默认）。旧版 `fixedCharacters` 配置会在启动时迁入角色表。
- 自定义 ComfyUI 工作流 JSON（对接 Anima Aesthetic 1.1 Text-to-Image Baseline，见下方「工作流对接」）。
- 生成队列（逐张顺序执行，防止争抢 GPU）。
- `p-draw 状态` 查看 ComfyUI 连接状态与模型可用性。
- `p-draw help`（或 `帮助`）查看全部指令帮助，包含生成 / 多人 / 批量张数 / 尺寸 / 画师组 / 状态等。
- 发图时会以合并转发发送，每张图片后附对应的 Positive / Negative 提示词；生成完成消息会显示实际模型和 seed（如 `已扣除 750 P 点，当前模型：animagine-xl-3.1.safetensors，--seed=123456`）。管理员/免扣费用户不显示扣费金额，但仍显示模型和 seed。
- 批量生成（如 `x5` / `x10`）开启 LLM 优化时，每张图会在生成前单独重新优化一次提示词；因此 `random color hair`、`random color eyes` 等动态要求可以在不同图片中产生不同结果。

## 安装

把 `koishi-plugin-p-draw/` 目录放到 Koishi 的 `plugins/` 下，在 `koishi.yml` 中启用：

```yaml
plugins:
  p-draw:
    comfyuiBaseUrl: http://127.0.0.1:8188
    unetName: anima-aesthetic-v1.1.safetensors
    clipName: qwen_3_06b_base.safetensors
    vaeName: qwen_image_vae.safetensors
    price: 500
```

或者在 Koishi 控制台「插件市场」中本地安装并填写配置。

## 使用

```
画图 一个女孩，白色裙子，立绘，简单背景
画图 一个女孩 x3
画图 三张：少女站在河岸
画图 无优化 masterpiece, best quality, 1girl, solo, white dress, simple background
画图 竖图：狐莉站在梨花树下
画图 1024x1536：少女站在河岸
画图 少女站在河岸 --cfg 3.5 --steps 40
画图 创建画师组 千代风格=@artist_a, @artist_b,
画图 切换画师组 千代风格
画图 添加角色 狐莉=1girl, solo, fox girl
画图 查看角色
画图 删除角色 狐莉
画图 多人 左边若叶睦抱着吉他，右边千早爱音牵着她的手
画图 多人 若叶睦与千早爱音十指相扣 x2
画图 模型 animagine
画图 状态
画图 help
```

## 配置说明

| 项 | 说明 |
|----|------|
| `comfyuiBaseUrl` | ComfyUI API 地址（默认 `http://127.0.0.1:8188`） |
| `unetName` / `clipName` / `vaeName` | 模型文件名，需与 ComfyUI 下拉框中的文件名一致 |
| `useGgufUnet` | 主模型加载方式：`auto`（按文件名后缀判断，默认）/ `true`（强制 `UnetLoaderGGUF`，需装 ComfyUI-GGUF）/ `false`（强制 `UNETLoader`） |
| `modelParams` | 每个模型独立参数覆盖（字典）：`key`=模型文件名，`value`=要覆盖的 `samplerName` / `scheduler` / `steps` / `cfg` / `width` / `height`。让不同模型用各自最佳采样参数，只填需要覆盖的字段，不填的用全局默认。匹配不区分大小写与 -/_。优先级：命令级 `--steps`/`--cfg` > 模型级 `modelParams` > 全局配置 |
| `customWorkflowEnabled` / `customWorkflowPath` | 使用自定义工作流 JSON；路径相对 Koishi 运行目录解析（插件目录作为回退） |
| `customWorkflowReloadOnChange` | 工作流 JSON 变化时自动重载，无需重启插件（默认 `true`） |
| `positivePromptNodeId` / `negativePromptNodeId` | 自定义工作流中正/负面提示词节点 ID；留空自动识别 |
| `resolutionNodeId` / `seedNodeId` / `stepsNodeId` | 自定义工作流中尺寸 / 种子 / 步数节点 ID；可留空（留空则按节点类型批量覆盖） |
| `skipQualityPrefixForCustomWorkflow` | 启用自定义工作流时自动跳过质量前缀注入（默认 `true`） |
| `width` / `height` / `allowedSizes` | 默认尺寸与可用尺寸列表 |
| `steps` / `cfg` / `samplerName` / `scheduler` | 采样参数 |
| `qualityPrefix` / `negativePrompt` | 质量词前缀与负面提示词。默认 `qualityPrefix` 为空（Aesthetic 1.1 不需要质量标签），`negativePrompt` 为 Aesthetic 推荐值；从 Base 模型迁移时再把 `qualityPrefix` 填回 `masterpiece, best quality, score_7` |
| `promptOptimizeEnabled` / `llmBaseUrl` / `llmApiKey` / `llmModel` | 自然语言优化（OpenAI 兼容接口） |
| `promptOptimizeTemplate` | 自然语言优化模板（支持 `{theme}` `{search_block}` `{character_rule}` 占位符） |
| `webSearchEnabled` / `tavilyApiKey` / `webSearchMaxResults` / `webSearchDepth` / `webSearchQueryTemplate` | 联网搜索（指令带 `联网`/`搜索` 触发，需 Tavily Key） |
| `fixedCharacters` / `artistPresets` / `activeArtistPreset` / `styleTags` | 角色、画师组与画风 |
| `queueEnabled` / `queueMaxRequests` | 生成队列 |
| `couponPrice` / `couponAskTimeout` | 提示词优化券单价（P 点/张，默认 3000，可被 `data/p-shop.json` 覆盖）与交互确认等待时间（秒，默认 60） |
| `batchMax` | 单次指令最多生成的张数（`x3` / `3张` / `--数量 3` 等写法），默认 4 |
| `price` / `multiPrice` / `adminUsers` | 单张 / 多人单张消耗的 P 点与免单管理员 |
| `multiVerifyEnabled` / `multiVerifyPassScore` / `multiCandidateCount` / `multiSendDegradedCandidate` | 多人视觉校验：合格分数、候选采样数、失败时是否降级发送 |
| `verifyLlmBaseUrl` / `verifyLlmApiKey` / `verifyLlmModel` | 多人视觉校验用视觉模型（OpenAI 兼容，需支持图片输入；留空则跳过校验） |
| `adminOnly` | 仅管理员可用（`adminUsers` 中的用户） |
| `allowedUserIds` / `blockedUserIds` | 用户白名单 / 黑名单（QQ 号，黑名单优先） |
| `allowedGroupIds` / `blockedGroupIds` | QQ 群白名单 / 黑名单（群号，黑名单优先） |
| `outputLogs` | 是否输出详细日志 |

## 工作流对接：Anima Aesthetic 1.1

### 1. 模型文件放置

| 文件 | 目标目录 | 说明 |
|---|---|---|
| `anima-aesthetic-v1.1.safetensors` | `ComfyUI/models/diffusion_models/` | 约 4.18GB，BF16 |
| `anima-aesthetic-v1.1-Q8_0.gguf` | `ComfyUI/models/diffusion_models/` | 约 2.1GB，GGUF 量化版（**8G 显存推荐**） |
| `qwen_3_06b_base.safetensors` | `ComfyUI/models/text_encoders/` | 文本编码器，与 Base 模型共用 |
| `qwen_image_vae.safetensors` | `ComfyUI/models/vae/` | VAE，与 Base 模型共用 |

**8G 显存（如 4060）推荐 GGUF Q8_0**：需要先安装 [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) 插件。插件按 `unetName` 后缀自动选择加载器——`.gguf` 用 `UnetLoaderGGUF`，其余用 `UNETLoader`；也可用 `useGgufUnet` 强制指定。

推荐参数：

| 精度 | 采样器 | 调度器 | 步数 | CFG |
|---|---|---|---|---|
| safetensors（BF16） | `er_sde` | `simple` | 30 | 4（用 3 也常更好） |
| GGUF Q8_0 | `euler` / `euler a` | `normal` | 30–50 | 4–5 |

分辨率范围 512–1536px。

### 2. 节点 ID 识别

节点 ID 取决于你实际导出的 JSON。**插件不内置任何节点 ID，也不假设任何固定值。**

1. 在 ComfyUI 中加载 `text2image anima-aesthetic-v1.1.json`；
2. 选中正面 CLIPTextEncode（标题通常是 `CLIP Text Encode (Positive Prompt)`），记下 ID（示例 `6`）；
3. 选中负面 CLIPTextEncode，记下 ID（示例 `7`）；
4. 选中 EmptyLatentImage，记下 ID（示例 `5`）→ 填 `resolutionNodeId`（可选）；
5. 选中 KSampler，记下 ID（示例 `3`）→ 填 `seedNodeId` 与 `stepsNodeId`（可选）。

配置的节点 ID 优先；**留空时插件会从 KSampler 的 positive/negative 连线自动反查**，因此不填也能用。填错时 `p-draw 诊断` 会列出工作流里实际可用的文本编码节点。

### 3. 提示词差异

Aesthetic 1.1 在 80 万张高质量图像上微调，**训练时已剥离质量标签**，正面提示词不需要 `masterpiece, best quality, score_7` 之类前缀。

- `qualityPrefix` 建议留空；
- `skipQualityPrefixForCustomWorkflow`（默认 `true`）：启用自定义工作流时自动跳过质量前缀注入；
- 负面词推荐 `worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts`（已是默认值）。

从 Base 模型迁移过来时，`p-draw 诊断` 会额外提示 qualityPrefix 可能不适用于 Aesthetic 模型。

### 4. 配置模板

工作流 JSON 由你从 ComfyUI 导出后放入 Koishi 运行目录的 `data/p-draw/workflows/`（插件启动时自动创建该目录）。

```yaml
p-draw:
  comfyuiBaseUrl: "http://127.0.0.1:8188"

  # 自定义工作流
  customWorkflowEnabled: true
  customWorkflowPath: "data/p-draw/workflows/anima-aesthetic-v1.1.json"
  positivePromptNodeId: "6"      # 以你导出的 JSON 为准
  negativePromptNodeId: "7"
  resolutionNodeId: "5"          # 可留空
  seedNodeId: "3"                # 可留空
  stepsNodeId: "3"               # 可留空
  customWorkflowOverrideParameters: true
  customWorkflowReloadOnChange: true

  # 8G 显存友好参数
  width: 1024
  height: 1024
  steps: 30
  cfg: 4.0
  samplerName: "er_sde"
  scheduler: "simple"

  # Aesthetic 1.1 提示词
  qualityPrefix: ""
  negativePrompt: "worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts"

  # 若使用 GGUF：unetName 填 .gguf 文件，插件自动改用 UnetLoaderGGUF
  # unetName: "anima-aesthetic-v1.1-Q8_0.gguf"
```

`customWorkflowPath` 相对 **Koishi 运行目录**解析（插件目录作为回退，兼容旧配置）。

### 5. 验收清单

- [ ] 使用 `text2image anima-aesthetic-v1.1.json`，发送 `画图 1girl, solo, 白色裙子`，正面提示词写入正确的 CLIPTextEncode 节点，成图无过度锐化或风格偏移。
- [ ] `qualityPrefix` 置空后，画风保持 Aesthetic 1.1 的默认美学水平。
- [ ] 使用 GGUF Q8_0 时，显存峰值不超过 7.5GB，1024×1024 / 30 步在 30 秒量级。
- [ ] 替换工作流 JSON 后，在 `customWorkflowReloadOnChange: true` 下无需重启插件即生效。
- [ ] `p-draw 诊断` 能显示实际工作流路径、更新时间与实际解析到的节点 ID。

## 注意

- `p-draw` 指令消耗 `price` P 点，`p-draw 多人` 消耗 `multiPrice` P 点，需要先通过 `p-qiandao` 签到。
- 批量张数按「张数 × 单价」**一次性扣足总价**，余额不足则整单不生成；单张失败只退该张。
- 生成失败会自动退回 P 点。
- 固定种子 `--seed 数字`（支持 `--seed:` `--seed=` `--seed＝` 形式）在单张和批量生成中都可用，且会从提示词中自动剥离，不会混进 tags。
- 采样参数 `--steps 40` / `--cfg 3.5`（兼容 `--步数` / `--强度`，支持 `=` `:` 形式）同样会从提示词中剥离，只覆盖当次生成，不改配置。取值范围：步数 1–150，CFG 0–30，超出会被截断。
- 多人指令的视觉校验需要单独配置视觉模型（`verifyLlm*`），未配置时会跳过校验直接发送。
- **提示词优化券**：当全局 `promptOptimizeEnabled` 关闭时，普通用户生图会**交互式询问**是否使用券（记录在 `p_system.llmToken`）：
  - 有券 → 询问是否使用；确认后消耗券并 LLM 优化，**拒绝则取消本次生图**（不扣 P）；
  - 没券/券不足 → 询问是否购买并显示价格（默认 `couponPrice` 3000 P/张，也可自动读取 `data/p-shop.json` 里覆盖的价格）；确认后扣 P 购买并消耗、优化生图；**拒绝一次会再次警告**（提示不用券图可能不好看）并再问一次，**再次拒绝则直接生图**（不优化）。**P 点不足买不起券时，会询问是否仍然生图**（回复「否」则取消本次生图）。
  - 券为一次性、**按张数消耗**：`x3` 需 3 张，每张图独立做一次 LLM 优化；券不足时该批不优化也不扣券（提示 `token-short`）。等待回复时间由 `couponAskTimeout`（秒）控制。
  - **管理员在全局关闭时自动免费优化**（不耗券）；`无优化` 原样模式不消耗、不询问。平台不支持交互确认时退回自动消耗逻辑。
- **未使用优化的提示**：单人生图没走 LLM 优化时会明确提示原因——未配置 LLM、未消耗优化券、或 `无优化` 原样模式；多人指令强依赖 LLM 规划，未配置 `llmBaseUrl`/`llmModel` 时会直接提示「多人指令需要 LLM 规划」。
- 本地模型不一定认识新角色，可用 `添加角色` 手动补充角色 tags。
