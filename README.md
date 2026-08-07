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

## 当前进度：M1（地基壳）

已完成：设计 token 体系、Drizzle 数据 schema v1、LLM 适配层（N 槽位 + 三家预设 + 路由/降级）、
分层 prompt 组装、微信外壳 UI（TabBar / 会话列表 / 单聊静态 / 通讯录 / 发现 / 我）、键盘⇄面板
三态原型、Playwright golden 截图管线 + vitest（42 例）、CI。

**待用户/真机验证的熔断门**（见 PLAN "第 1 周熔断门"）：a) 真机 2 万条消息滚动性能；
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
