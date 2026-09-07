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
- 画师组管理（创建 / 追加 / 切换 / 查看 / 删除）。
- 固定角色（`添加角色 名称=tags`，可用 `查看角色` / `删除角色 名称` 管理）。
- **用户自选模型**：`p-draw 模型` 查看当前与可用模型（自动读取 ComfyUI 的 UNET 和 Animagine checkpoint），`p-draw 模型 <名称>` 切换（支持模糊匹配，如 `anima-aesthetic`），`p-draw 模型 默认` 恢复默认。偏好按用户保存（`p_draw_config.user_models`），单人和多人生成都会生效；未自选时用 `unetName` 默认模型。自定义工作流（`customWorkflowEnabled`）不参与模型切换。
- **Animagine XL 3.1**：将模型文件放入 ComfyUI 的 checkpoints 目录后，用 `p-draw 模型 animagine` 选择。该模型使用 SDXL Danbooru/tag 文生图工作流，并复用 `promptOptimizeTemplate`。
- 画师组保存在数据库 `p_draw_config` 表中；固定角色保存在 `p_draw_fixed_characters` 表中，每个角色一行。管理指令不触发插件重载（不会打断正在生成的图，也不会把配置恢复成默认）。旧版 `fixedCharacters` 配置会在启动时迁入角色表。
- 自定义 ComfyUI 工作流 JSON。
- 生成队列（逐张顺序执行，防止争抢 GPU）。
- `p-draw 状态` 查看 ComfyUI 连接状态与模型可用性。
- `p-draw help`（或 `帮助`）查看全部指令帮助，包含生成 / 多人 / 批量张数 / 尺寸 / 画师组 / 状态等。
- 发图时会以合并转发发送，每张图片后附对应的 Positive / Negative 提示词；生成完成消息会显示实际模型和 seed（如 `已扣除 750 P 点，当前模型：animagine-xl-3.1.safetensors，--seed=123456`）。管理员/免扣费用户不显示扣费金额，但仍显示模型和 seed。

## 安装

把 `koishi-plugin-p-draw/` 目录放到 Koishi 的 `plugins/` 下，在 `koishi.yml` 中启用：

```yaml
plugins:
  p-draw:
    comfyuiBaseUrl: http://127.0.0.1:8188
    unetName: anima_baseV10.safetensors
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
| `modelParams` | 每个模型独立参数覆盖（字典）：`key`=模型文件名，`value`=要覆盖的 `samplerName` / `scheduler` / `steps` / `cfg` / `width` / `height`。让不同模型用各自最佳采样参数，只填需要覆盖的字段，命令级 `--steps`/`--cfg` 仍优先 |
| `customWorkflowEnabled` / `customWorkflowPath` | 使用自定义工作流 JSON（相对插件目录） |
| `width` / `height` / `allowedSizes` | 默认尺寸与可用尺寸列表 |
| `steps` / `cfg` / `samplerName` / `scheduler` | 采样参数 |
| `qualityPrefix` / `negativePrompt` | 质量词前缀与负面提示词 |
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

## 注意

- `p-draw` 指令消耗 `price` P 点，`p-draw 多人` 消耗 `multiPrice` P 点，需要先通过 `p-qiandao` 签到。
- 批量张数按「张数 × 单价」**一次性扣足总价**，余额不足则整单不生成；单张失败只退该张。
- 生成失败会自动退回 P 点。
- 固定种子 `--seed 数字`（支持 `--seed:` `--seed=` `--seed＝` 形式）在单张和批量生成中都可用，且会从提示词中自动剥离，不会混进 tags。
- 多人指令的视觉校验需要单独配置视觉模型（`verifyLlm*`），未配置时会跳过校验直接发送。
- **提示词优化券**：当全局 `promptOptimizeEnabled` 关闭时，普通用户生图会**交互式询问**是否使用券（记录在 `p_system.llmToken`）：
  - 有券 → 询问是否使用；确认后消耗券并 LLM 优化，**拒绝则取消本次生图**（不扣 P）；
  - 没券/券不足 → 询问是否购买并显示价格（默认 `couponPrice` 3000 P/张，也可自动读取 `data/p-shop.json` 里覆盖的价格）；确认后扣 P 购买并消耗、优化生图；**拒绝一次会再次警告**（提示不用券图可能不好看）并再问一次，**再次拒绝则直接生图**（不优化）。**P 点不足买不起券时，会询问是否仍然生图**（回复「否」则取消本次生图）。
  - 券为一次性、**按张数消耗**：`x3` 需 3 张，每张图独立做一次 LLM 优化；券不足时该批不优化也不扣券（提示 `token-short`）。等待回复时间由 `couponAskTimeout`（秒）控制。
  - **管理员在全局关闭时自动免费优化**（不耗券）；`无优化` 原样模式不消耗、不询问。平台不支持交互确认时退回自动消耗逻辑。
- **未使用优化的提示**：单人生图没走 LLM 优化时会明确提示原因——未配置 LLM、未消耗优化券、或 `无优化` 原样模式；多人指令强依赖 LLM 规划，未配置 `llmBaseUrl`/`llmModel` 时会直接提示「多人指令需要 LLM 规划」。
- 本地模型不一定认识新角色，可用 `添加角色` 手动补充角色 tags。
