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

## 为什么 APK 只能由 CI 产出（M5 实测）

开发容器**永远构建不了 APK**，且不是配置问题：`dl.google.com` 被出网策略 403 拒绝
（`/root/.ccr/README.md` 明令不得绕行），而这一个域名同时提供 Android SDK **和** Google Maven
（AGP + 全部 `androidx.*`）；`maven.google.com` 只是会 301 到同一路径的浏览门面。
Maven Central 可达也没用——AGP 与 androidx 不在那里镜像。
另外容器无 `/dev/kvm`、CPU 无 `vmx/svm`、无 `emulator`/`adb`，**即便能构建也跑不起来**。

GitHub `ubuntu-24.04` runner 自带 SDK（build-tools 34–37、cmdline-tools 12.0，
`ANDROID_HOME=/usr/local/lib/android/sdk`）+ JDK 17，可直连 Google 源。故 `release.yml`
在 CI 构建，`android/` 保持 gitignore、每次现生成。

## 现状（M5）

`.github/workflows/release.yml` 已就位：

- **触发**：`workflow_dispatch`（随时手动出包）或 push tag `v*`。
- **debug APK**：**每次都产出**，零 Secret 依赖，作为 workflow artifact 下载
  （保留 30 天）。这就是当前的真机验收通道。
- **签名 release**：仅当 ①tag 触发 且 ②`ANDROID_KEYSTORE_BASE64` 存在时执行；
  否则显式 `::notice::` 说明跳过原因，**不静默失败**。
- 出包前先跑 typecheck+lint+test——用一个类型都不过的包去占用一轮真机测试太浪费。
- `versionCode = github.run_number`；sed 写不进去会**硬失败**（否则每次都是 versionCode 1，
  Android 将拒绝覆盖升级）。签名前先 `zipalign`（apksigner 能保持对齐但不能引入对齐）。

### debug 包的代价（必须让用户知道）

debug keystore 每次构建都不同 → 签名不一致 → **不能覆盖升级，换版本必须先卸载**，
而卸载会清空本地全部聊天数据。所以：**升级前先在 设置 → 备份与恢复 导出 `.aiwx`**。
想摆脱这条限制，就得配好下面的签名 keystore。

### 用户一次性操作：生成 keystore 并配 4 个 Secret

keystore 是全项目唯一不可逆资产（丢失=只能卸载重装、聊天数据全灭），**只能由用户生成并
保管在自己的密码管理器里**，AI 不代劳、不经手。

```bash
keytool -genkeypair -v \
  -keystore weixin-ai.keystore -alias weixin-ai \
  -keyalg RSA -keysize 4096 -validity 10000
# 记下 keystore 密码与 key 密码，存进密码管理器；文件本体也一并存好
base64 -w0 weixin-ai.keystore   # 输出用于下面第 1 个 Secret
```

在仓库 Settings → Secrets and variables → Actions 添加：

| Secret | 值 |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | 上面 `base64 -w0` 的输出 |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 密码 |
| `ANDROID_KEY_ALIAS` | `weixin-ai`（或你自定的 alias） |
| `ANDROID_KEY_PASSWORD` | key 密码 |

配好后 `git tag v0.5.1 && git push --tags` 即产出签名 APK 并挂到 Release，
Obtainium 指向本仓 Releases 即可一键升级、且**不再需要卸载**。
