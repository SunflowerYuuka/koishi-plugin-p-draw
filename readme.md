# koishi-plugin-p-draw

p点-绘图插件，连接本地 ComfyUI 生图，参考 AstrBot 的 [anima 绘图大师](https://github.com/YayiMiko/anima-master) 移植。需要配合 [p-qiandao](https://github.com/gfjdh/koishi-plugin-p-qiandao) 食用。

## 功能

- `p-draw <描述>`（别名：画图 / 生图 / 绘图 / 画画）文生图。
- `p-draw 多人 <描述>` 多人生图（2-4 人画面）：LLM 结构化规划人物分组、互动关系与统一场景，未指定尺寸时按人数/肢体接触自动选横图，生成后可选视觉校验。
- 批量张数：描述后加 `x3` / `×3` / `3张` / `三张` / `--数量 3` 可一次生成多张（上限 `batchMax`，默认 4），按张数 × 单价扣 P 点。
- 自然语言自动优化为 Danbooru tags（可选，需配置 LLM 接口）。
- **多模型 / 中转站回退**：同一组 url+key 下可填多个模型名逐个尝试，全挂了再切下一个 url+key；兼容非 DeepSeek 站点（不硬发 `thinking`），可用 `llmExtraBody` 追加站点私有参数。
- 联网搜索：描述中带 `联网`/`搜索`/`查一下` 等词时自动补充角色设定（需 Tavily Key）。
- **可选代理（分用途单独配置）**：`tavilyProxy` / `llmProxy` / `verifyLlmProxy` 三个独立开关，分别作用于联网搜索、LLM、视觉校验，留空即直连；LLM 通道还能各自指定专用代理。
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

控制台里配置分成 **11 个可折叠分组**，点标题即可折叠/展开，默认展开。分组是嵌套结构，`koishi.yml` 里写成 `组名: { 字段名: 值 }`，详见文末的分组对照与示例。

### ① ComfyUI 连接

| 项 | 说明 |
|----|------|
| `comfyuiBaseUrl` | ComfyUI API 地址（默认 `http://127.0.0.1:8188`） |
| `timeout` / `pollInterval` | 单次生成超时（秒，默认 300）、状态查询间隔（秒，默认 2） |

### ② 模型与采样参数

| 项 | 说明 |
|----|------|
| `unetName` / `clipName` / `vaeName` | 模型文件名，需与 ComfyUI 下拉框中的文件名完全一致 |
| `useGgufUnet` | `auto`（按后缀判断，默认）/ `true`（强制 `UnetLoaderGGUF`，需装 ComfyUI-GGUF）/ `false`（强制 `UNETLoader`） |
| `width` / `height` / `allowedSizes` | 默认尺寸与可用尺寸列表 |
| `steps` / `cfg` / `samplerName` / `scheduler` | 采样参数（Aesthetic 1.1 推荐 `30 / 4.0 / er_sde / simple`） |

### ③ 提示词与画师

| 项 | 说明 |
|----|------|
| `qualityPrefix` / `negativePrompt` | 质量词前缀与负面词。默认 `qualityPrefix` 为空（Aesthetic 1.1 不需要质量标签），`negativePrompt` 为 Aesthetic 推荐值；从 Base 模型迁移时再把前缀填回 `masterpiece, best quality, score_7`。**负面词推荐值**：`worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts`（即默认值；Base 模型可再加 `score_4, score_5, score_6`） |
| `styleTags` / `defaultArtistTags` | 画风 tags、备用画师 tags |
| `activeArtistPreset` / `artistPresets` | 启用的画师组名称与画师组列表 |
| `fixedCharacters` | 固定角色（仅兼容旧配置，运行时以数据库为准） |

### ④ 队列与批量

| 项 | 说明 |
|----|------|
| `queueEnabled` / `queueMaxRequests` | 生成队列开关与上限（0 表示不限制） |
| `batchMax` | 单次指令最多生成的张数（`x3` / `3张` / `--数量 3`），默认 4 |

### ⑤ P 点与优化券

| 项 | 说明 |
|----|------|
| `price` / `multiPrice` | 单张 / 多人单张消耗的 P 点 |
| `couponPrice` / `couponAskTimeout` | 提示词优化券单价（默认 3000，可被 `data/p-shop.json` 覆盖）与确认等待时间（秒） |
| `adminUsers` | 免 P 点管理员用户 ID |

### ⑥ 权限与日志

| 项 | 说明 |
|----|------|
| `adminOnly` | 仅管理员可用 |
| `allowedUserIds` / `blockedUserIds` | 用户白名单 / 黑名单（黑名单优先） |
| `allowedGroupIds` / `blockedGroupIds` | 群白名单 / 黑名单（黑名单优先） |
| `outputLogs` | 是否输出详细日志 |

### ⑦ 自定义工作流（折叠）

| 项 | 说明 |
|----|------|
| `customWorkflowEnabled` / `customWorkflowPath` | 启用自定义工作流 JSON；路径相对 Koishi 运行目录解析 |
| `skipQualityPrefixForCustomWorkflow` | 启用自定义工作流时跳过质量前缀注入（默认 `true`） |
| `customWorkflowOverrideParameters` | 用插件参数覆盖工作流内的采样参数（总开关）。注意：`modelParams` 里显式写了的字段不受这个开关限制，永远覆盖 |
| `customWorkflowReloadOnChange` | 工作流文件变化时自动重载，无需重启（默认 `true`） |
| `workflowOverrideModel` | 用 `unetName` 覆盖自定义工作流里的模型文件名（默认 `true`）。开着之后 `p-draw 模型 <名称>` 对预设也生效，不用改 JSON |
| `modelLoaderNodeId` | 指定覆盖哪个模型加载节点。留空时：工作流里只有一个模型加载节点就自动覆盖，有多个则不猜、跳过 |
| `positivePromptNodeId` / `negativePromptNodeId` | 正/负面提示词节点 ID；留空自动识别 |
| `resolutionNodeId` / `seedNodeId` / `stepsNodeId` | 尺寸 / 种子 / 步数节点 ID；可留空（留空则按节点类型覆盖） |
| `workflowPresets` | 工作流预设字典：`预设名 → { path, aliases, 节点 ID, steps, cfg, ... }`，供指令按名切换（见下方「工作流预设」） |
| `defaultWorkflowPreset` | 默认预设名；留空则使用 `customWorkflow*` 那套或内置工作流 |

### ⑧ 模型独立参数覆盖（折叠）

| 项 | 说明 |
|----|------|
| `modelParams` | 字典：`key`=模型文件名，`value` 只填要覆盖的 `samplerName` / `scheduler` / `steps` / `cfg` / `width` / `height`。匹配不区分大小写与 `-` `_`。**只要在 `modelParams` 里写了某个字段，它就会覆盖工作流内的值——包括自定义工作流**（不受 `customWorkflowOverrideParameters` 开关限制）。优先级：命令级 `--steps`/`--cfg` > 本节 > 全局配置 |

### ⑨ 提示词优化 / LLM（折叠）

| 项 | 说明 |
|----|------|
| `promptOptimizeEnabled` | 启用自然语言优化 |
| `llmBaseUrl` / `llmApiKey` | 主通道接口地址与 Key（OpenAI 兼容） |
| `llmProxy` | **仅 LLM** 使用代理，留空直连（详见「中转站、多模型与代理」） |
| `llmModels` | 主通道的**模型名列表**，按顺序逐个尝试（如 `["deepseek-chat","gpt-4o-mini"]`）。旧的 `llmModel` 单模型仍兼容 |
| `llmChannels` | 附加通道（中转站/备用站）：`通道名 → { baseUrl, apiKey, models }`。主通道所有模型都失败后按顺序继续试 |
| `llmChannelOrder` | 附加通道的尝试顺序（填通道名；留空则按配置先后顺序） |
| `llmThinking` | 是否发送 DeepSeek 专有的 `thinking` 字段。`auto`（默认，仅 DeepSeek 域名发送）/ `always` / `never`。**非 DeepSeek 模型带上它常被直接拒绝，中转站建议保持 auto 或改 never** |
| `llmExtraBody` | 附加请求体 JSON，最后覆盖。用于中转站私有参数，如 `{"enable_thinking":false}` |
| `llmMaxTokens` | LLM 输出上限 |
| `promptOptimizeTemplate` | 优化模板（支持 `{theme}` `{search_block}` `{character_rule}` 占位符） |

### ⑩ 联网搜索（折叠）

| 项 | 说明 |
|----|------|
| `webSearchEnabled` / `tavilyApiKey` | 联网搜索开关与 Tavily Key |
| `tavilyProxy` | **仅联网搜索**使用代理，留空直连 |
| `webSearchMaxResults` / `webSearchDepth` / `webSearchQueryTemplate` | 结果数量、搜索深度、搜索词模板 |

### ⑪ 多人视觉校验（折叠）

| 项 | 说明 |
|----|------|
| `multiVerifyEnabled` / `multiVerifyPassScore` | 校验开关与合格分数（0-10） |
| `multiCandidateCount` / `multiSendDegradedCandidate` | 候选采样数与全部不达标时是否仍发送最优候选 |
| `verifyLlmBaseUrl` / `verifyLlmApiKey` / `verifyLlmModels` | 视觉模型（需支持图片输入，如 qwen-vl）。和文本侧一样支持多模型逐个尝试 |
| `verifyLlmProxy` | **仅视觉校验**使用代理，留空直连 |
| `verifyLlmChannels` / `verifyLlmChannelOrder` | 视觉侧的附加通道与尝试顺序（结构同 `llmChannels`） |

### ⑫ 兼容项（折叠）

| 项 | 说明 |
|----|------|
| `workflow` | 旧版工作流标识，仅用于状态/诊断显示，内置工作流固定 `anima_t2i` |

控制台里配置分成 **11 个可折叠分组**（每个分组都能折叠/展开，默认展开）。分组是**嵌套结构**：`koishi.yml` 里对应写成 `组名: { 字段名: 值 }`。

已有的**扁平旧配置仍然生效**（插件会就地摊平并打一条日志提醒），但建议迁移成下面的分组写法——否则你在控制台里改同名项不会生效，因为旧扁平键优先级更高。

| 分组 | 内容 |
|---|---|
| `connection` | ComfyUI 地址、超时、轮询间隔 |
| `model` | 模型文件、采样参数、尺寸、`modelParams` |
| `prompt` | 质量前缀、负面词、画师组、固定角色 |
| `queue` | 队列与批量张数 |
| `pricing` | P 点价格、优化券、管理员 |
| `access` | 白名单/黑名单、日志 |
| `workflow` | 自定义工作流、节点 ID、工作流预设 |
| `llm` | 提示词优化、多通道/多模型、LLM 代理 |
| `search` | 联网搜索（Tavily）与其代理 |
| `vision` | 多人视觉校验及其通道/代理 |
| `legacy` | 旧版 `workflow` 标识，可忽略 |

```yaml
p-draw:0z81el:
  connection:
    comfyuiBaseUrl: http://127.0.0.1:8188
  model:
    unetName: anima-aesthetic-v1.1.safetensors
    cfg: 4.0
    steps: 30
  prompt:
    qualityPrefix: ''
  workflow:
    customWorkflowEnabled: true
    customWorkflowPath: data/p-draw/workflows/anima-aesthetic-v1.1.json
    workflowPresets:
      极速4步:
        path: data/p-draw/workflows/03-dmdx.json
        aliases: [极速]
        steps: 4
        cfg: 1.0
  llm:
    llmBaseUrl: https://api.deepseek.com
    llmModels: [deepseek-chat]
```

## 中转站、多模型与代理

> 下面片段为便于阅读只按**字段名**展示，实际请写在对应分组下：`llm*` → `llm:`，`tavilyProxy` / `webSearch*` → `search:`，`verifyLlm*` → `vision:`。

### 多模型逐个回退

同一个 `baseUrl` + `apiKey` 下可以填**多个模型名**，按顺序逐个尝试；前一个失败（网络错误 / 非 2xx / 返回空文本）自动换下一个：

```yaml
llmBaseUrl: https://relay.example.com/v1
llmApiKey: sk-xxx
llmModels:
  - deepseek-chat
  - gpt-4o-mini
```

如果这一组模型全挂了，再切换到下一个「通道」（另一组 url + key）：

```yaml
llmChannels:
  备用站:                      # 通道名自取，只用于排序和日志
    baseUrl: https://backup.example.com/v1
    apiKey: sk-yyy
    models:
      - qwen-max
llmChannelOrder:
  - 备用站
```

调用顺序：主通道的 `llmModels` 依次 → 全部失败 → `llmChannels` 里各通道的 `models` 依次。日志会记录每个候选的失败原因（`outputLogs` 开启时）。**视觉校验（`verifyLlm*`）规则完全相同**，只是配置项换成 `verifyLlmModels` / `verifyLlmChannels` / `verifyLlmChannelOrder`。

### 中转站兼容

请求体默认**只在 DeepSeek 域名下**附加 `thinking` 字段——很多中转站/其它模型不认识它，带上会被直接 400。特殊情况用 `llmThinking` 调：

| 取值 | 行为 |
|---|---|
| `auto`（默认） | 仅当 `baseUrl` 或模型名含 `deepseek` 时发送 |
| `always` | 总是发送（自建 DeepSeek 中转站用） |
| `never` | 从不发送（域名像 DeepSeek 但网关不认这个字段时用） |

站点私有参数用 `llmExtraBody` 追加，**最后覆盖**，所以也能改 `max_tokens` 等：

```yaml
llmExtraBody: '{"enable_thinking": false, "top_p": 0.9}'
```

### 代理（可选，按用途分开）

三个代理**互相独立**，都留空就是直连：

| 配置项 | 作用范围 | 所在分组 |
|---|---|---|
| `tavilyProxy` | 只影响联网搜索（Tavily） | ⑩ 联网搜索 |
| `llmProxy` | 只影响提示词优化 / 多人规划的文本 LLM | ⑨ 提示词优化 / LLM |
| `verifyLlmProxy` | 只影响多人视觉校验的视觉模型 | ⑪ 多人视觉校验 |

```yaml
tavilyProxy: http://127.0.0.1:7890      # 只给搜索走代理
llmProxy: ''                            # LLM 直连
verifyLlmProxy: socks5://127.0.0.1:7891 # 视觉模型走另一个
```

`llmChannels` / `verifyLlmChannels` 里每个通道还可以填 `proxy` 指定**该通道专用**代理，优先级高于上面三个用途级配置：

```yaml
llmChannels:
  海外中转:
    baseUrl: https://overseas.example.com/v1
    apiKey: sk-zzz
    models: [gpt-4o-mini]
    proxy: http://127.0.0.1:7890   # 只有这个通道走代理
```

格式都支持 `http://`、`socks5://`，也可省略协议直接写 `127.0.0.1:7890`。若宿主的 Koishi 里解析不到 `undici`，该代理会被忽略并告警一次，其余功能不受影响。

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

### 图生图（带参考图）

需要图片输入的工作流（图生图、分块放大、ControlNet）现在可以直接用：**把参考图和指令一起发**即可。

```
[发一张图] ＋ 画图 重绘：保持角色，换成水彩风格
```

插件会自动完成：从消息里取图 → 下载 → 上传到 ComfyUI 的 `input/pdraw/` → 把返回的文件名写进工作流的 `LoadImage` 节点。

- **没带图时会直接拒绝并提示**，既不扣点也不会跑出一张错的图
- `--重绘 0.6` / `--重绘幅度 0.6` 可临时指定重绘幅度（0–1，越大改动越大）
- 预设里可固定 `denoise`（重绘幅度）与 `imageNodeId`（多个 `LoadImage` 时指定改哪个）
- 传多张图时按顺序分配给多个 `LoadImage` 节点（ControlNet 多分支用）
- 上传文件名带时间戳，并发不会互相覆盖

`画图 工作流` 里会用「🖼 需带参考图」标出这类预设。

## 工作流预设

> 下面片段按字段名展示，实际写在 `workflow:` 分组下（见「配置说明」的分组示例）。

Anima Aesthetic 1.1 官方/社区共 10 个工作流。插件**不内置任何 JSON**，你导出后登记成预设，指令里按名字切换。

### 登记预设

```yaml
workflowPresets:
  基础文生图:                       # 预设名 = 指令里用的名字
    path: data/p-draw/workflows/09-baseline.json
    aliases: [基础, base]           # 指令别名（可选）
    positivePromptNodeId: '6'       # 节点 ID 可留空，插件会自动识别
    negativePromptNodeId: '7'
  极速4步:
    path: data/p-draw/workflows/03-dmdx.json
    aliases: [极速, fast]
    steps: 4                        # 该预设固定步数，覆盖全局与 modelParams
    cfg: 1.0
    overrideParameters: true
defaultWorkflowPreset: 基础文生图
```

### 指令用法

```
画图 --工作流 极速4步：1girl, solo
画图 极速：1girl, solo          # 用别名开头，等效
画图 工作流                      # 列出所有预设及其可用性
```

`画图 工作流` 会逐个体检并给出结论，例如：

```
✅ 基础文生图（别名：基础、base）
    节点 9 个 · 正面 #6 · 负面 #7 · 尺寸 #5
❌ 图生图（别名：i2i）
    不可用：需要图片输入（LoadImage），当前版本不支持图生图
```

选了不可用的预设会**直接拒绝并说明原因**，不会静默失败或跑错工作流。

### 10 个工作流的可用性对照

| # | 工作流 | 节点 | 起点 | 当前版本 |
|---|---|---|---|---|
| 09 | Text-to-Image Baseline | 17 | 文本 | ✅ 可用（已转好并实测） |
| 03 | DMDX 4-Step Speed Run | 19 | 文本 | ⏳ 需 DMDX LoRA（`dmdx_student_final_comfy.safetensors`） |
| 04 | Three-Stage High-Quality | 26 | 文本 | ✅ 可用（已转好并实测） |
| 01 | 1.5x Upscale | 20 | 文本 | ✅ 可用（见下方依赖） |
| 05 | Tiled Upscale | 45 | 图片 | ⚠️ 分块节点的 schema 映射待处理 |
| 08 | T2I + ControlNet + Face/Hand Repair | 60 | 文本 + 控制图 | ✅ 可用（已裁成单输出；ControlNet 分支默认旁路，需检测器 + SAM 模型） |
| 02 | ControlNet Precision Control | 32 | 图片 | ❌ 需图生图 |
| 06 | i2i + ControlNet + Face/Hand Repair | 52 | 图片 | ✅ 可用（已裁成单输出；WD14 打标器已剔除，重绘幅度建议 0.4–0.6） |
| 07 | Image-to-Image | 19 | 图片 | ⏳ 缺 `Qwen3VLProcessor`（自动打标节点，计划剔除后启用） |
| 10 | Anima-Edit LoRA / IC | 52 | 图片 | ❌ 需图生图 |

判断依据是自动体检的结果：**只要 JSON 里出现 `LoadImage` 一类节点，就判定为需要图片输入**。所以 05/08 到底能不能用，取决于你导出时是「从空 latent 开始」还是「从图开始」——`画图 工作流` 会直接告诉你。

### 官方工作流需要先装的自定义节点

官方这套工作流依赖几个 ComfyUI 自定义节点包，**不装的话图里会显示红色缺失节点**：

| 节点包 | 提供 | 用于 |
|---|---|---|
| [RES4LYF](https://github.com/ClownsharkBatwing/RES4LYF) | `ClownsharKSampler_Beta` | 几乎所有官方工作流的主力采样器（`beta57` 等调度器） |
| [Comfy-WaveSpeed](https://github.com/chengzeyi/Comfy-WaveSpeed) | `EnhancedLoadDiffusionModel` | 官方图的模型加载节点 |
| [ControlAltAI-Nodes](https://github.com/gseth/ControlAltAI-Nodes) | `FluxResolutionNode` | 按兆像素/比例计算尺寸 |
| [rgthree-comfy](https://github.com/rgthree/rgthree-comfy) | `Seed (rgthree)` | 08 等图的种子节点 |

> `XB_UNetNameBroadcaster`（在 XB_ToolBox 里）依赖极重（easyocr / whisper / diffusers…），**不建议装**。它只是给模型加载节点传一个字符串，删掉该节点、直接在加载节点的下拉框里选模型即可。

01 实测流程：装上 RES4LYF + Comfy-WaveSpeed + ControlAltAI-Nodes，删掉 `XB_UNetNameBroadcaster`，把模型选成自己的，导出 API 即可。**插件会自动把 `unetName` 注入模型节点**（见 `workflowOverrideModel`），所以后续换模型不用再改 JSON。

图生图能力（图片上传 + `LoadImage` 注入 + 重绘幅度）尚未实现，所以 ❌ 的四个目前只能等后续版本。

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
