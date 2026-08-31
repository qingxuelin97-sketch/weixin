# ASR 语音输入（按住说话）——M-I9

聊天输入框右侧麦克风 = 微信「按住说话」。按住录音 → 全屏浮层（绿泡波形）→
上滑取消 → 松开转写 → **文字落输入框，可改后发**（绝不直接发送）。

## 模块

| 文件 | 职责 |
|---|---|
| `src/llm/asr.ts` | OpenAI 兼容 `/audio/transcriptions` 客户端 + 预设 + 配置持久化 |
| `src/lib/recorder.ts` | getUserMedia + MediaRecorder（webm/opus 优先）封装 |
| `src/features/chat/VoiceInput.tsx` | 按住说话手势 + 全屏录音浮层 + 转写编排 |
| `src/features/chat/voice-input.css` | 浮层样式（纯 CSS 动画） |
| `src/features/settings/AsrConfigPage.tsx` | 设置 → 语音输入（端点/模型/key/测试） |

## 设计要点（与全仓约束的对应关系）

- **key 只走 keystore（铁律 2）**：settings 行 `asrConfig` 只存 `keyAlias`
  （`key_asr_<kind>`），真 key 经 `setSecret` 加密落本机。
- **传输策略与 http.ts 一致**：fetch 优先（真机也如此，M-D 判定），CapacitorHttp
  桥只作 no-CORS 网关的兜底。桥上传用 `dataType:'formData'` + base64 音频
  （Android 侧 `writeFormDataRequestBody` 原生支持）。
- **原生桥超时必须真拒绝（陷阱清单）**：桥路径包在 `raceDeadline`（从 http.ts
  导出复用，会 reject 的定时器）里；`tests/unit/asr.test.ts` 用「永不 settle 的桥」
  锁死这条。
- **协议级失败不换通道**：401/429/5xx/解析失败说明字节已到达——换桥重传只会翻倍
  计费，不会改判。只有 network/timeout 才落到桥兜底。
- **浮层动画禁 rAF**：波形 13 根柱 = CSS keyframes + 负 `animation-delay` 错峰；
  转写中三点同理。截图门禁只能冻结 CSS/WAAPI。
- **浮层进 dismiss 栈**：`useDismissable(phase!=='idle', cancelAll)`——硬件返回键
  取消录音而不是退出聊天页。
- **优雅降级**：无 MediaRecorder → toast「当前环境不支持录音」；未配置 →
  toast 指路设置页（**先查配置再开麦**，不许录完 30 秒才告诉用户发不出去）；
  权限拒绝/占用 → RecorderError 分类文案。原始报错永不上屏（friendlyAsrError）。
- **麦克风必须每条路径都释放**：stop/cancel/error/60s 自动截断全部走
  `releaseMic()`——泄漏的 track = Android 常亮「麦克风使用中」= 穿帮。
- **手势**：按钮 `setPointerCapture`，零 document 监听；上滑 >90px 进入取消态
  （红泡）；<600ms 判「说话时间太短」；60s 自动收口。

## 预设

SiliconFlow（国内直连，SenseVoice）/ OpenAI（whisper/4o-transcribe）/
Groq（whisper-turbo）/ 自定义。全部 OpenAI multipart 形状；模型 id 用户可改
（目录会轮换，不硬编码为真理）。

## 验收清单

- [ ] 无配置按住 → 提示指路设置页，不开麦
- [ ] 配置后按住 → 浮层绿泡波形；上滑变红「松开取消」；松开落字进输入框
- [ ] 设置页「测试识别」走真实上传（静音 WAV，确定性字节）
- [ ] 断网/超时/401 → 各自的人话 toast
- [ ] 转红：ChatPage 无「语音输入暂未开放」stub；VoiceInput 无 rAF；
      桥路径挂死时有界拒绝；未配置时 transcribe 不发任何请求
