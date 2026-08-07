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

## 验收（router.test.ts / bubbles.test.ts 已覆盖）
- [ ] 正常返回直出；拒答走宽松链并粘性；tier-1 prefill 可救场；全失败出人设拒绝；auth 不 ladder。
- [ ] NDJSON/数组/纯文本/坏 JSON 均能解析出气泡；delay 越界被 clamp。
- [ ] （M2 真机）三家各跑通对话 + 降级路径；全开档零流量流向国内官方端点。
