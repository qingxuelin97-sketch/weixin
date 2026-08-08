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

### 升级演练清单（首个签名包必做一次）

第一次从签名包升级到下一个签名包时，按此单验证"数据不死"闭环真的成立：

1. 装第一个签名 APK（此时从 debug 包迁移仍需卸载重装——先导出 `.aiwx` 恢复进来）。
2. 使用几天：聊出新消息、发个红包、让 AI 发条朋友圈。
3. 打新 tag 出第二个签名 APK，直接覆盖安装（`adb install -r` 或 Obtainium 升级）。
4. 打开验证：历史消息在、记忆在、零钱余额对、朋友圈在、API key 仍可用（keystore 未损）。
5. 任何一项丢失 = 签名链路有问题，立即回报；全过 = 从此告别"升级即清库"。

⚠️ keystore 文件与两个密码丢失是**不可逆**的：无法再发可覆盖升级的包。
除密码管理器外，keystore 文件本体再留一份离线备份（如导出到网盘私密目录）。

---

## 静态浏览器链接（GitHub Pages）与「远端源 APK」

### 为什么有这两样

用户怀疑「App 发不出 API 请求，是不是因为页面不是由服务器提供的」。为验证这条假设，
增加了两个工作流：

| 工作流 | 产物 | 作用 |
|---|---|---|
| `.github/workflows/pages.yml` | `https://qingxuelin97-sketch.github.io/weixin/` | 真·服务器提供的 https 链接，浏览器直接开 |
| `.github/workflows/apk-remote.yml` | debug APK（artifact） | WebView 从上面那个 https 源加载，而不是包内 `dist/` |

实现方式：`capacitor.config.ts` 读 `CAP_SERVER_URL` 环境变量 → 有值就填 Capacitor 的
`server.url`。**不设这个变量时配置逐字节等同于以前**，`release.yml` 出的正常包不受任何影响。

`vite.config.ts` 同时加了 `base: './'`：同一份 `dist/` 既要能在根路径下跑（Capacitor 的
`http://localhost/`），又要能在子路径下跑（Pages 的 `/weixin/`）。因为 App 用的是
`HashRouter`，document 路径永远不变，相对路径不会漂。

### 这个实验能证明什么、不能证明什么

**不能证明的（重要）**：换成远端源**不会改变 API 请求的走法**。
`src/llm/http.ts` 是按 `Capacitor.isNativePlatform()` 选传输的，装成 APK 后这个判断恒为
真，无论 HTML 从哪儿加载，请求一律走 **CapacitorHttp 原生桥**（不经 WebView、不受 CORS
限制）。所以如果原本就是原生桥在报错，远端源 APK 会**一模一样地**报同一个错。

**能证明的**：
- 手机到供应商域名的网络通不通（浏览器里打开 Pages 链接直接试）。
- WebView 能否加载并运行这个应用（排除包内资源损坏、路径错等）。
- 浏览器路径（`fetch`）与原生路径（原生桥）的报错是否不同——这恰恰是最有用的信号：
  **浏览器报 CORS / 原生正常**，说明分流逻辑是对的；**两边都报同一个网络错**，
  说明问题在网络或 key/endpoint，而不在"有没有服务器"。

⚠️ 浏览器里的 CORS 报错**不是** APK 的病因。DeepSeek 等端点不回 CORS 头，浏览器直连必失败——
原生桥的存在正是为了绕开这一点（见 `src/llm/http.ts` 顶部注释）。

### 远端源 APK 的三条代价（装之前必须知道）

1. **离线打不开**：页面每次从网上拉，没网就是白屏。
2. **与正常包数据不互通**：WebView 的 IndexedDB / localStorage 按**源**隔离，
   `https://…github.io` 与 `http://localhost` 是两套独立存储，聊天记录、API key 都不共享。
   换包前先 设置 → 备份与恢复 导出 `.aiwx`。
3. debug 签名每次构建都不同 → 不能覆盖升级，换版本要先卸载。

排查结束后回到 `release.yml` 出的正常包即可，无需改任何代码。

### Pages 首次启用：必须人手开一次

**实测（run #1）**：`actions/configure-pages@v5` 的 `enablement: true` 在本仓**无效**——
Actions 的 `GITHUB_TOKEN` 即便给了 `pages: write` 也建不了站点，报
`Create Pages site failed: Resource not accessible by integration`。
开发容器里也绕不过去：agent 代理直接拒绝 `/repos/*/pages` 这条 API 路径。

所以首次启用**只能由仓库管理员在网页上点一次**：

> Settings → Pages → Build and deployment → Source 选 **GitHub Actions** → 重跑 `pages.yml`。

`pages.yml` 已把这条指引写进 `::error::`，失败时直接照做即可，不用再翻日志。

若启用后 deploy 报「部署分支不被允许」：
Settings → Environments → `github-pages` → Deployment branches 放行对应分支
（本排查分支是 `claude/api-static-link-test-*`）。
