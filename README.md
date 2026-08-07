# 微信 AI（个人自用）

个人自用（不商用、不公开）的「AI 微信」App：1:1 复刻微信大陆版 8.x 前端，核心是可任意配置
的智能体（充当好友/群友）+ 智能单聊/群聊/朋友圈 +（V3）剧情模式 + NSFW 开关。local-first，
数据全本地、无自建服务器、API key 自填。

技术栈：**Vite + React 18 + TypeScript strict + Capacitor 7**（Android APK 优先，iOS/异地走
同源 PWA）。规划见 [`docs/PLAN.md`](docs/PLAN.md)，约束见 [`CLAUDE.md`](CLAUDE.md)。

## 快速开始

```bash
pnpm install
pnpm dev            # 开发服务器 http://localhost:5173
pnpm build          # 类型检查 + 生产构建
pnpm test           # 纯函数单测（vitest）
pnpm test:screenshot # golden 截图回归（Playwright）
pnpm lint           # eslint + 硬编码颜色检查
```

## 当前进度：M1 完成 · M2 单聊拟真核心完成

- **M1 地基**：设计 token（已按真机截图采样校准）、数据 schema、LLM 适配层（N 槽位 + 三家预设
  + 路由/三级降级）、分层 prompt、微信外壳 UI、键盘⇄面板三态、golden 截图管线 + vitest、CI。
- **M2 核心**：IndexedDB 持久化（Repo 接口，M3 换原生 SQLite 不动调用方）、设置页 / API 与模型页
  （密钥 WebCrypto 加密存本机）/ 人设编辑页、单聊引擎（多气泡打字延迟播放 + 可打断 + 人设化兜底）、
  记忆打分注入 + 证据链抽取、心跳排期、NSFW 三级开关、提示音。共 60 个单测。

### 怎么开始用

1. `pnpm dev` → 「我」→ 设置 → **API 与模型** → 添加 DeepSeek 预设 → 贴上你的 key → 测试连接。
2. 「通讯录」点任一好友可编辑人设卡（简介 / 说话风格 / 说话样例 / 主动性 / 打字速度…）。
3. 回到会话列表点开聊天即可对话。没配 key 时会走人设化兜底话术，不会报错。

**待真机验证的熔断门**（见 PLAN "第 1 周熔断门"）：a) 真机 2 万条消息滚动性能；
b) CapacitorHttp 大陆直连三家 API；c) 真机键盘⇄面板零跳变。≥2 项失败则整体转 Flutter。

## 目录

```
src/styles  设计 token（tokens.css 唯一可写死颜色处）
src/db      Drizzle schema（数据唯一真源）
src/llm     LLM 适配层
src/ai      AI 业务纯逻辑（prompt 组装等）
src/lib     通用纯函数（money/time）
src/features 各页面/功能
specs/      每个 feature 的验收清单与设计要点
docs/PLAN.md 总体规划
```

## 素材需求

见 `docs/PLAN.md` 末尾：需要 18 张真机截图（前 6 张最优先）+ 若干生图 PNG（AI 头像库、朋友圈
配图池等）。图标与气泡不需生图（手写 SVG + CSS）。
