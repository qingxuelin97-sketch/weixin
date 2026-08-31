# android/ 入库与再生成策略（M-I10）

自 M-I10 起 `android/` **入库**。原因：重原生四件套（悬浮气泡、RemoteInput 直接回复、
来电全屏通知、桌面小组件）都是手写 Kotlin + 手改 Manifest/Gradle，`npx cap add android`
现场生成的裸模板不再等价于我们的原生工程——CI 若继续现生成，等于每次都把手写层扔掉。

## 三类文件

| 类 | 例 | 处置 |
|---|---|---|
| **模板原样**（`cap add` 生成后未改） | `gradlew`、`variables.gradle`、`res/mipmap-*`、`styles.xml`、splash 图 | 入库，升级 Capacitor 时可整体换新 |
| **模板+手改**（在模板文件上叠加了我们的行） | `app/build.gradle`（kotlin 插件 + jvmTarget 21）、`android/build.gradle`（kotlin classpath）、`AndroidManifest.xml`（权限/组件/深链）、`MainActivity.kt`（替换模板 `.java`，注册插件） | 入库；升级时需**三方对比**（见下） |
| **纯手写**（模板里根本没有） | `app/src/main/java/com/personal/weixinai/aiwx/*.kt`、`res/**/aiwx_*`、`res/drawable/ic_stat_aiwx.xml`、`app/src/debug/**` | 入库；升级时原样保留 |
| **生成物**（`cap sync` 产出，含本机 pnpm 路径） | `capacitor.settings.gradle`、`app/capacitor.build.gradle`、`app/src/main/assets/public/`、`assets/capacitor.config.json`、`assets/capacitor.plugins.json`、`res/xml/config.xml`、`capacitor-cordova-android-plugins/` | **不入库**（`android/.gitignore` 收口），CI 每次 `npx cap sync android` 重新生成 |

手改文件里我们自己的行都带 `AIWX`/`M-I10` 注释，方便日后 diff 认领。

## CI 的规则（三条流水线一致）

```yaml
# 只 sync，不 add——`cap add` 会用裸模板覆盖手写层：
- run: npx cap sync android
```

`tests/unit/native-wiring.test.ts` 会在任何 workflow 出现 `cap add android` 时转红。

## 升级 Capacitor 主版本时的再生成流程

1. 升级 npm 依赖（`@capacitor/*` 全家对齐同一主版本——宪法陷阱：插件必须与 core 同主版本）。
2. 在**临时目录**生成新模板对照：
   ```bash
   cd $(mktemp -d) && npm init -y >/dev/null
   npm i @capacitor/cli@<新版本> @capacitor/core@<新版本> @capacitor/android@<新版本>
   npx cap init tmp com.personal.weixinai --web-dir=w && mkdir w && npx cap add android
   ```
3. 用 `diff -ru` 对比新模板与本仓 `android/`：
   - 「模板原样」类：直接采纳新模板。
   - 「模板+手改」类：把新模板拿来，再把带 `AIWX` 注释的行重新叠上去。
   - 「纯手写」类（`aiwx/`、`aiwx_*` 资源、`src/debug/`）：不动。
4. 本容器**编译不了**（`dl.google.com` 被 403，宪法陷阱），验证只能靠：
   `pnpm build && npx cap sync android`（本容器可跑）→ push → CI `release.yml` 出包
   → `device-test.yml` 模拟器断言全绿。
5. JDK 版本盯紧 `app/capacitor.build.gradle`（生成物）里的 `JavaVersion`——它变了，
   `app/build.gradle` 里的 `kotlinOptions.jvmTarget` 和 CI 的 `setup-java` 要跟着变。

## 本地全新 checkout 后

```bash
pnpm install && pnpm build && npx cap sync android
```

之后 `android/` 才是一个完整可构建的工程（生成物就位）。不 sync 直接开 gradle 会因
缺 `capacitor.settings.gradle` 报错——这是设计使然，不是损坏。
