# spec: 构建与分发（零开发环境用户）

## Android（第一交付物）
- CI：push tag `v*` → GH Actions：`pnpm build` → `cap sync` → `assembleRelease` →
  apksigner 签名 → Release 挂 APK。`versionCode = github.run_number`。
- **签名 keystore + 密码存用户密码管理器**——全项目唯一不可逆资产，丢失=只能卸载重装、本地
  聊天数据全灭。keystore base64 存 GH Secrets（4 个）。applicationId 定死。
- 用户侧：装 **Obtainium** 添加本仓 Releases 源，新版自动检测一键装（跟系统代理）。

## iOS（V1 冻结）
无 Mac/无开发者账号场景，V1 不做原生，由 PWA 承接（主屏添加、免签免续签）。实测两周仍不满足
再花 $99 走 TestFlight。禁用企业签/超级签灰产（含 NSFW 记录 + API key）。

## Web/PWA
Cloudflare Pages push 即部署，兼 iOS 兜底入口 + 用户手机秒级 UI 预览台。与 APP 数据定性为
"两台设备"，靠导出/导入互通（V1 必备）。主屏 PWA 不受 Safari 7 天清存储波及；手动清 Safari
数据会连坐 → 导出功能兜底。

## API key 纪律
运行时输入 → Android Keystore / Web WebCrypto 加密 localStorage。首 commit 收口 `.gitignore`；
CLAUDE.md 禁真 key 入代码/日志/fixture；gitleaks pre-commit。私有仓无免费 push protection，
key 入库即去供应商轮换，不洗历史。建议 NSFW 配独立 key。

## 开发期验收
Web：push→Pages 预览链接（分钟级）。Android：CI 出 APK + Obtainium。Playwright golden 截图
是 AI 自检滤网；最终判定权在用户真机截图叠图。

## 现状（M1）
CI 已配 `.github/workflows/ci.yml`（typecheck+lint+test+screenshot）。APK/Pages 发布工作流
待 keystore/托管就绪后补（`release.yml`）。
