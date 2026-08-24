# koishi-plugin-p-draw

p点-绘图插件，连接本地 ComfyUI 生图，参考 AstrBot 的 [anima 绘图大师](https://github.com/YayiMiko/anima-master) 移植。需要配合 [p-qiandao](https://github.com/gfjdh/koishi-plugin-p-qiandao) 食用。

## 功能

- `p-draw <描述>`（别名：画图 / 生图 / 绘图 / 画画）文生图。
- `p-draw 多人 <描述>` 多人生图（2-4 人画面）：LLM 结构化规划人物分组、互动关系与统一场景，未指定尺寸时按人数/肢体接触自动选横图，生成后可选视觉校验。
- `p-draw 连续 <角色>：<阶段1> → <阶段2> → ...` 连续图/过程图（同一角色的变化过程）：全阶段共用同一 seed，角色外观尽量一致，默认横图，支持 `|` 分隔与 `--seed` 覆盖。**仅保留 `连续` 一个别名**。
- 批量张数：描述后加 `x3` / `×3` / `3张` / `三张` / `--数量 3` 可一次生成多张（上限 `batchMax`，默认 4），按张数 × 单价扣 P 点。
- 自然语言自动优化为 Danbooru tags（可选，需配置 LLM 接口）。
- 联网搜索：描述中带 `联网`/`搜索`/`查一下` 等词时自动补充角色设定（需 Tavily Key）。
- 原样 tags 模式（`无优化` 前缀）。
- 尺寸选择：`竖图` `横图` `方图` `长竖图` `宽屏`，或 `1024x1536：描述` / `--尺寸 1216x832`。
- 画师组管理（创建 / 追加 / 切换 / 查看 / 删除）。
- 固定角色（`添加角色 名称=tags`）。
- **以图生图**：`p-draw i2i <描述>` 并在同一条消息附一张原图（文件 / 截图 / 链接均可），发送后会让用户选择处理方式（可用 `i2iMode` 固定跳过询问）：**① 换风格（漫画化）**——保留原图构图，整体转成二次元画风，优先用 Anima **ControlNet-LLLite**（Canny 锁构图）；**② 换装换姿势**——保留角色长相，重新设计服装 / 姿势 / 场景，优先用 Anima IP-Adapter（保脸）；**③ 取消**——不生成。支持 `--denoise 0.6` / `--去噪 0.4` 单独调整强度；未安装对应节点 / 模型时自动回退普通 img2img（纯 `LoadImage → VAEEncode → KSampler(denoise<1)`，**无需修改 ComfyUI**），去噪强度由 `img2imgDenoise` 控制（默认 0.55）。不支持自定义工作流（`customWorkflowEnabled`）时使用 i2i 会提示关闭。
- **i2i 自动识图**：配置 `taggerEnabled` 后，i2i 会先通过 ComfyUI 的 **WD14 Tagger** 节点对原图识图，把识别出的标签注入提示词优化，让不支持读图的 LLM（如 DeepSeek）也能"看到"原图内容。需要在 ComfyUI `custom_nodes` 安装 [ComfyUI-WD14-Tagger](https://github.com/pythongosssss/ComfyUI-WD14-Tagger)，并把模型 `.onnx` + `.csv` 放进 `custom_nodes/ComfyUI-WD14-Tagger/models/`（模型名由 `taggerModel` 指定，默认 `wd-v1-4-convnext-tagger-v2`）。仅当已配置 LLM（`llmBaseUrl`/`llmModel`）且非 `无优化` 模式时才会识图；识图失败会跳过并正常生图。
- **用户自选模型**：`p-draw 模型` 查看当前与可用模型（自动读取 ComfyUI 的 UNET 列表），`p-draw 模型 <名称>` 切换（支持模糊匹配，如 `anima-aesthetic`），`p-draw 模型 默认` 恢复默认。偏好按用户保存（`p_draw_config.user_models`），单人 / 多人 / 连续图都生效；未自选时用 `unetName` 默认模型。自定义工作流（`customWorkflowEnabled`）不参与模型切换。
- 画师组与固定角色**保存在数据库 `p_draw_config` 表中**，管理指令不触发插件重载（不会打断正在生成的图，也不会把配置恢复成默认）。数据库中的值在重启后覆盖配置里的同名项。
- 自定义 ComfyUI 工作流 JSON。
- 生成队列（逐张顺序执行，防止争抢 GPU）。
- `p-draw 状态` 查看 ComfyUI 连接状态与模型可用性。
- `p-draw help`（或 `帮助`）查看全部指令帮助，包含生成 / 多人 / 批量张数 / 尺寸 / 画师组 / 状态等。
- 发图时会引用你触发指令的原消息。

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
画图 i2i 换成晚礼服，背景换成舞台灯光 --denoise 0.6（同一条消息附原图，随后回复 1=换风格 / 2=换装换姿势 / 3=取消）
画图 多人 左边若叶睦抱着吉他，右边千早爱音牵着她的手
画图 多人 若叶睦与千早爱音十指相扣 x2
画图 连续 圣女：白色长发红瞳、圣洁白裙、端庄微笑 → 发梢染黑、眼神迷离、白裙开裂 → 黑发红瞳、妖艳邪笑、黑色破损礼服
画图 连续 狐莉：站姿|坐姿|躺姿 --seed 42
画图 状态
画图 help
```

## 配置说明

| 项 | 说明 |
|----|------|
| `comfyuiBaseUrl` | ComfyUI API 地址（默认 `http://127.0.0.1:8188`） |
| `unetName` / `clipName` / `vaeName` | 模型文件名，需与 ComfyUI 下拉框中的文件名一致 |
| `i2iUnetName` | 「换风格（漫画化）」专用主模型文件名，默认 `anima-base-v1.0.safetensors`。LLLite 权重按 block 数逐块训练（当前权重为 28-block），必须配 28-block 模型（`anima-base-v1.0` / `anima-aesthetic-v1.1`）；**不要用 40-block 的 `Anima-2.9B`**，否则报 `depth_embed slices missing`。留空则用 `unetName` |
| `modelParams` | 每个模型独立参数覆盖（字典）：`key`=模型文件名，`value`=要覆盖的 `samplerName` / `scheduler` / `steps` / `cfg` / `width` / `height`。让不同模型用各自最佳采样参数，只填需要覆盖的字段，命令级 `--steps`/`--cfg` 仍优先 |
| `customWorkflowEnabled` / `customWorkflowPath` | 使用自定义工作流 JSON（相对插件目录） |
| `width` / `height` / `allowedSizes` | 默认尺寸与可用尺寸列表 |
| `steps` / `cfg` / `samplerName` / `scheduler` | 采样参数 |
| `qualityPrefix` / `negativePrompt` | 质量词前缀与负面提示词 |
| `promptOptimizeEnabled` / `llmBaseUrl` / `llmApiKey` / `llmModel` | 自然语言优化（OpenAI 兼容接口） |
| `promptOptimizeTemplate` | 自然语言优化模板（支持 `{theme}` `{search_block}` `{character_rule}` `{img2img_rule}` 占位符） |
| `webSearchEnabled` / `tavilyApiKey` / `webSearchMaxResults` / `webSearchDepth` / `webSearchQueryTemplate` | 联网搜索（指令带 `联网`/`搜索` 触发，需 Tavily Key） |
| `fixedCharacters` / `artistPresets` / `activeArtistPreset` / `styleTags` | 角色、画师组与画风 |
| `queueEnabled` / `queueMaxRequests` | 生成队列 |
| `img2imgDenoise` | 普通以图生图（`p-draw i2i`）去噪强度，默认 0.55（建议 0.4-0.7，越小越接近原图） |
| `i2iMode` | i2i 模式选择方式：`ask`=每次询问（默认） / `style`=直接换风格（漫画化） / `ootd`=直接换装换姿势 / `plain`=普通 img2img |
| `i2iAskTimeout` | i2i 处理方式询问等待时间（秒，默认 60） |
| `i2iStyleDenoise` | 换风格（漫画化）去噪强度，默认 0.75（建议 0.7-0.85，越大风格变化越彻底；无 ControlNet 时自动压到 0.5 防崩） |
| `i2iOotdDenoise` | 换装换姿势去噪强度，默认 0.55（建议 0.5-0.6） |
| `i2iControlNetStrength` | 换风格模式的 ControlNet-LLLite 强度，默认 0.7（建议 0.5-0.8，越大构图锁得越死） |
| `controlNetModel` | Anima ControlNet-LLLite 权重文件名（留空自动检测 `anima-lllite` 系，如 `anima-lllite-lineart-test-1.safetensors`；需放到 ComfyUI `models/controlnet/`） |
| `i2iIPAdapterPath` | Anima IP-Adapter 模型文件**路径**（换装换姿势保脸用，如 `E:/anima/ipadapter.safetensors`；需安装 [comfyui-anima-ipadapter](https://github.com/Wenaka2004/comfyui-anima-ipadapter) 节点） |
| `i2iIPAdapterWeight` | 换装换姿势模式的 IP-Adapter 权重，默认 0.8（建议 0.6-1.0，越大角色特征保留越强） |
| `taggerEnabled` / `taggerModel` / `taggerThreshold` / `taggerCharacterThreshold` | i2i 自动识图开关、识图模型名、标签阈值 / 角色标签阈值（需 ComfyUI 安装 WD14 Tagger 节点与模型） |
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
- 固定种子 `--seed 数字`（支持 `--seed:` `--seed=` `--seed＝` 形式）在**单张 / 批量 / 连续图**里都可用，且会从提示词中自动剥离，不会混进 tags。
- 多人指令的视觉校验需要单独配置视觉模型（`verifyLlm*`），未配置时会跳过校验直接发送。
- 连续图用「同一角色 + 全阶段共用 seed」保证一致性。固定角色的身份 tags（角色名 / 种族 / 尖耳朵等）会**始终注入每一阶段**，保证图跟角色相关；阶段描述里明确改变的外观（发色/瞳色/种族变化等）会自动从固定 tags 中剔除，避免"固定银发把黑化阶段拉回去"。
- **连续图配置了 LLM（`llmBaseUrl`/`llmModel`）时会交互式询问是否使用 LLM 逐阶段优化**：回复 `1 / 是` 使用 LLM（把中文描述转成 Danbooru tags），回复 `2 / 否` 不使用 LLM（直接按你输入的内容生图，适合已写好英文 tags 的情况），回复 `3 / 取消` 则不生成。等待时间由 `seriesAskTimeout`（秒）控制；未配置 LLM 或平台不支持交互时，配置了 LLM 就自动逐阶段优化。anima 是 tag 模型，中文不翻译就体现不到画面里。阶段描述尽量写**能看见的变化**（发色渐变、眼神、服装破损、光环变黑、表情），心理/抽象描述（"感到厌恶""沉迷"）模型很难画出来。
- **提示词优化券**：当全局 `promptOptimizeEnabled` 关闭时，普通用户生图会**交互式询问**是否使用券（记录在 `p_system.llmToken`）：
  - 有券 → 询问是否使用；确认后消耗券并 LLM 优化，**拒绝则取消本次生图**（不扣 P）；
  - 没券/券不足 → 询问是否购买并显示价格（默认 `couponPrice` 3000 P/张，也可自动读取 `data/p-shop.json` 里覆盖的价格）；确认后扣 P 购买并消耗、优化生图；**拒绝一次会再次警告**（提示不用券图可能不好看）并再问一次，**再次拒绝则直接生图**（不优化）。**P 点不足买不起券时，会询问是否仍然生图**（回复「否」则取消本次生图）。
  - 券为一次性、**按张数消耗**：`x3` 需 3 张，每张图独立做一次 LLM 优化；券不足时该批不优化也不扣券（提示 `token-short`）。等待回复时间由 `couponAskTimeout`（秒）控制。
  - **管理员在全局关闭时自动免费优化**（不耗券）；`无优化` 原样模式不消耗、不询问。平台不支持交互确认时退回自动消耗逻辑。
- **未使用优化的提示**：单人生图没走 LLM 优化时会明确提示原因——未配置 LLM、未消耗优化券、或 `无优化` 原样模式；多人指令强依赖 LLM 规划，未配置 `llmBaseUrl`/`llmModel` 时会直接提示「多人指令需要 LLM 规划」。
- **i2i 增强模式依赖的节点**：换风格（漫画化）需要 ComfyUI 安装 [kohya-ss/ComfyUI-Anima-LLLite](https://github.com/kohya-ss/ComfyUI-Anima-LLLite) 自定义节点，并在 `models/controlnet/` 放一个 `anima-lllite` 系权重（`AnimaLLLiteApply_sdscripts` 节点下拉可见）。**LLLite 权重按 block 数逐块训练，必须与所用模型一致：当前权重为 28-block，换风格工作流默认用 `i2iUnetName`（`anima-base-v1.0`，28-block）；若用 40-block 的 `Anima-2.9B` 会报 `depth_embed slices missing for module idx(es) [28..39]`。****注意：Anima 是 MiniTrainDIT 架构（3584 维），与 Qwen-Image 系 ControlNet（如 `Qwen-Image-InstantX-ControlNet-Union`）不兼容，装了也不会被本插件使用。** 可选安装 [comfyui_controlnet_aux](https://github.com/Fannovel16/comfyui_controlnet_aux) 获得 LineArt 预处理器（优先 `AnimeLineArtPreprocessor`，其次 `LineArtPreprocessor`），线条比内置 Canny 更贴合 lllite-lineart 权重；未安装时自动回退 Canny。换装换姿势需要安装 [comfyui-anima-ipadapter](https://github.com/Wenaka2004/comfyui-anima-ipadapter) 自定义节点并配置 `i2iIPAdapterPath`。以上节点缺失时都会自动回退普通 img2img 并提示，不影响出图。
- 本地模型不一定认识新角色，可用 `添加角色` 手动补充角色 tags。
