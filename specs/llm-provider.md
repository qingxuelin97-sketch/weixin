# spec: LLM 适配层

**文件**：`src/llm/{types,http,openai-compatible,presets,bubbles,router}.ts`。

## 契约
- `ChatProvider.complete()` 单次补全；`generate()` 返回 `AsyncIterable<Bubble>`。V1 非流式
  （一次性 yield），签名即流式——升级 NDJSON/SSE 不改调用方。
- `Bubble = {type: text|voice|sticker|image|recall, content, emotion?, delay?}`；一律经
  `parseBubbles()`（NDJSON / JSON 数组 / 纯文本兜底）+ zod 校验，delay 上限 8s。
- 传输 `httpJson()`：原生优先走 CapacitorHttp（免 CORS），Web/测试走 fetch，调用方无感。

## Provider 预设（`presets.ts`）
| kind | base_url | 默认模型 | 备注 |
|---|---|---|---|
| deepseek | api.deepseek.com | deepseek-chat / -reasoner | 国内直连；官方有审核，全开档勿走 |
| minimax | api.minimaxi.com/v1 | MiniMax-Text-01 | 含 TTS（另见 tts）；输入/输出双审(1026/1027) |
| zen | opencode.ai/zen/v1 | deepseek-v3/glm-4.6/kimi-k2 | 走代理；宽松通道；目录会轮换 |

N 槽位：用户可加任意 OpenAI 兼容 Provider；每 Provider 留 `fallbackBaseUrl`。

## 路由 + 降级（`router.ts`）
- 按 `role`(chat/director/memory/reasoning) + `nsfwTier` 选 provider/model。
- 拒答检测：`finish_reason=content_filter` / 错误码 1026/1027 / 拒答正则 / **JSON 解析失败即信号**。
- 三级降级：① 同模型软化重试 + DeepSeek prefix 预填 → ② 宽松链粘性路由 10 条 → ③ 人设化拒绝
  （由调用方给 `personaRefusal`）。**原始拒答/报错永不上屏**。auth 错误不 ladder。

## 模型路由默认
日常/导演/记忆抽取=deepseek-chat；复杂剧情=deepseek-reasoner；语音=MiniMax TTS；
NSFW 全开=宽松通道（Zen: deepseek-v3→glm→kimi）。

## 每智能体模型（M-B 接线）
- `PersonaVM.modelChat = "providerId:model"`，人设编辑页下拉可选；空=跟随全局默认。
- 引擎经 `preferredRoute()` 转成 `RouteRequest.preferProvider/preferModel`；
  单聊与群聊 actor 均传。
- 铁律不变：**full 档永远走宽松通道**，persona 偏好被无条件覆盖（rule #6）；
  preferModel 只在该 provider 的 models 列表里存在时生效，否则回落 role 默认。
- 见 persona-routing.test.ts。

## 传输超时（M-B 修）
- `GenerateOptions.timeoutMs` 可选逐调用截止；未传用传输层默认 60s。
- 原生 CapacitorHttp 不可中断——`raceDeadline` 用**会 reject** 的定时器兜底
  （空壳 setTimeout 曾导致真机测试连接永久卡死）；`testConnection` 固定 15s。
- 见 http-timeout.test.ts。

## 自定义槽位（M-J3 收口）
- ApiConfigPage 可添加 `kind:'custom'` 槽位（label/baseUrl/models 全自填，id 带时间戳
  可多个并存）。`PERMISSIVE_KINDS` 自 M-C1 就含 custom——路由早认，UI 才补上入口。
- 卡片「可作宽松通道」徽标读 `isPermissiveKind()`（service.ts 导出，与路由策略同一份
  集合），不许第二份手写清单。

## TTS 来源（M-J3 解绑，页 /settings/tts）
- 旧形态：`synthesize` 绑死「chat 列表第一个 **enabled** 的 minimax 槽位」——关掉
  MiniMax 聊天=全员静默失声；`ttsModel` 有读点无写点。
- 现在：settings 键 `ttsConfig`（台账 global）三态——缺失=自动（任何**存过密钥**的
  minimax 槽位，enabled 优先但**不再必需**）；`{source:'provider', providerId}` 显式
  绑定某槽位（绑定被删除则回落自动扫描）；`{source:'standalone', baseUrl}` 独立密钥
  （alias `key_tts_standalone`，走 keystore）。`resolveTtsSource()` 是唯一解析点。
- `/settings/tts`：来源三段选择 + ttsModel 写点 + 真合成测试按钮。守卫
  `tests/unit/j3-model-surface.test.ts`。

## 图片生成（M-J3，src/llm/image.ts —— 全仓第二个直连网络的模块）
- OpenAI 兼容 `POST {base}/images/generations`。配置存 settings 键 `imageProvider`
  （台账 global）：`{kind:'siliconflow'|'openai'|'custom', label, baseUrl, keyAlias,
  model, sizes, nsfwCapable?}`，key 走 keystore（rule #2）。预设 SiliconFlow
  （api.siliconflow.cn/v1，Kwai-Kolors/Kolors，国内直连）/ OpenAI / custom；
  入口在 ApiConfigPage 底部分组（无新路由）。
- 传输复用 http.ts 策略：fetch 优先、原生桥兜底、`raceDeadline` 真拒绝；响应
  `b64_json` 优先，`url` 兜底（**立即**再 fetch 成 blob——CDN 链接短命；下载同样
  fetch 优先 + 桥回退 base64）。SiliconFlow 说方言（image_size/batch_size），
  openai/custom 说 OpenAI（size/n/response_format）。
- **铁律 6 分档**：`generateImage(prompt, tier, opts?)` 的 `tier` 必传无默认
  （编译期强制，M-I18 教训）；`tier==='full'` 只放行 `kind==='custom' ∧
  nsfwCapable===true`——SiliconFlow 是国内官方端点，预设在全开档**无条件**拒绝，
  拒绝发生在读 key 与出网**之前**。`isImageGenReady(tier)` 把闸门折进就绪检查，
  调用面（photo-send / moments / 换头像）拿 null 静默回落素材池。守卫：
  `tests/unit/nsfw-callsite.test.ts`（call site 6）+ `tests/unit/image-gen.test.ts`。
- 业务半边在 `src/ai/gen-media.ts`：`generateToLibrary` 动态 import 传输模块
  （启动包棘轮只剩个位数 KB 余量）、生成图落媒体库 `kind:'generated'`、每次生成
  `recordUsage('image')`。`simulate()` 纯函数碰不到它（回填只在 handler 物化时才
  可能生成，守卫钉在 image-gen.test）。

## 验收（router.test.ts / bubbles.test.ts 已覆盖）
- [ ] 正常返回直出；拒答走宽松链并粘性；tier-1 prefill 可救场；全失败出人设拒绝；auth 不 ladder。
- [ ] NDJSON/数组/纯文本/坏 JSON 均能解析出气泡；delay 越界被 clamp。
- [ ] （M2 真机）三家各跑通对话 + 降级路径；全开档零流量流向国内官方端点。

## M-L1：LLM 运行时离开冷启动主包

主包 306.9 → 268.1KB（gz）。拿 source map 把主包的压缩字节归到源文件上，才看清两大块：zod
（53.5KB min）与 LLM 运行时 + 单聊引擎（43.7KB min）。它们几乎都只在「真的要调模型」时才用得到，
却因为页面在渲染时要一两个小函数而整片静态进了首屏。拆法：

| 模块 | 装什么 | 规则 |
|---|---|---|
| `llm/config.ts` | `loadConfig` / `hasUsableProvider` / `withDeadline` / `isPermissiveKind` / `ensureFreshModelDefaults` / `invalidateRouter` | 页面渲染与保存时只从这里拿；不许引入路由器、Provider、bubbles、zod |
| `llm/errors.ts` | `LlmError` | http / tts / 成本闸只要这个类；`types.ts` 为 BubbleSchema 引入了 zod |
| `llm/preflight.ts` | 成本闸的安装点与 `isBudgetError` | 成本闸从主包里的页面安装自己 |
| `llm/preset-data.ts` | 三家预设的描述（纯数据） | 配置页渲染它；Provider 类留在 `presets.ts` |
| `llm/service.ts` | `getRouter` / `testConnection` / `fetchModels` / `diagnoseProvider` | 只在动作发生时 `import()`；仍转导出轻量那一半，老导入点不必全改 |

- **`invalidateRouter` 变成「配置纪元」**：config 里只记一个递增的数，service 的路由器单例记住自己
  建于哪个纪元，纪元变了就重建——于是配置页让路由器失效，却不必导入路由器。
- **剧本的 zod 在 `ai/story-schema.ts`**：`story-script.ts` 只剩纯函数与 `export type`（类型在构建时擦除，
  不带 zod）；`story-gm` 在读/存剧本时懒加载校验器；剧本库列表直接 `JSON.parse`（每一行存进来时都校验过，
  渲染时再跑 zod 只为一行摘要）；生成器在按下「生成」时才加载。
- 守卫：`tests/unit/l1-lean-main.test.ts` 从 `src/main.tsx` 沿**静态 import**（不算 `import type`、不算
  `import()`）走一遍真的导入图，断言引擎、路由器、Provider、类型模块、剧本 schema 与 zod 都走不到；
  走得到就打印整条路径。轻量模块的静态闭包也被逐个检查。变异验证：把发朋友圈页的静态导入加回去，
  报出 `MomentPublishPage → moments-service → moments-engine → engine` 整条链。

