# spec: 数据架构

**文件**：`src/db/schema.ts`（Drizzle，数据唯一真源）。驱动无关：APK=@capacitor-community/sqlite，
Web/PWA=wa-sqlite/OPFS。

## 全局约定
- `messages.id` = INTEGER autoincrement（rowid）；其余表 TEXT UUID。
- 金额整数「分」；时间 epoch ms；易变结构进 `*Json` 列（演进免迁移，解析须容忍未知键）。

## 关键不变量
1. **rowid 序 == 时间序**（每会话内）：回填只许插入"晚于该会话最后一条"的时间，或经"收集
   全部事件→按时间戳全排序→单事务顺插"。破坏此不变量则游标分页错乱。
2. 游标分页：`WHERE conv_id=? AND id<:cursor ORDER BY id DESC LIMIT 30`，复合索引
   `(conv_id,id)`，**禁 OFFSET**；首屏 20 条。
3. 撤回 = `is_recalled` 标志位 UPDATE 原行（保序 + 保留原文供"先发后撤"），不新增占位行。
4. 会话列表渲染零 join：`conversations` 冗余 `last_msg_preview/last_msg_at/unread_count`；
   未读走冗余列，永不 COUNT。
5. 图片 `meta` 预存 `w/h + thumbRef`，根治倒序滚动跳动。
6. `scheduled_actions` 是时间演化引擎的持久化心脏（心跳/赞评/抢红包/撤回/回填），杀进程不丢。
7. 真 key 绝不入库：只存 `providers.key_alias`；真值在系统安全存储。

## 媒体布局
`files/media/{avatar|sticker|chat_img|chat_thumb|moment|voice|tts|bg}/…`。
`voice/` = 消息本体永久；`tts/` = 内容寻址缓存（hash(voice+text+params)），LRU 500MB/30 天。
DB 存相对路径。

## 备份 `.aiwx`
ZIP{manifest, VACUUM INTO 快照 db, media 可选}。两档（仅数据 MB 级 / 全量）；恢复=整库替换 +
留守快照；开启过 NSFW 的库导出强制口令 + AES-GCM。迁移：`PRAGMA user_version` 链式脚本，
迁移前自动快照。

## 验收
- [ ] `splitLuckyPacket` 守恒 + 确定性（见 money.test.ts）。
- [ ] 万级消息游标分页无跳动、60fps（M1 熔断门 a，真机）。
- [ ] 杀进程重启 scheduled_actions 不丢（M2）。

## media 表（v5，M-C2 运行时媒体库）

`{ id, kind: 'avatar'|'photo', tags: string[], mime, blob: Blob, createdAt }`，
IndexedDB store `media`（`DB_VERSION=5`）。这是**真机唯一可行**的素材通道——APK 由
CI 构建，`src/assets/` 构建期槽位在设备上永远不可达。

- ref 体系新增 `idb:<id>`（`resolveImageRef` 同步解析，经 `data/media-registry` 的
  进程级 objectURL 注册表；启动水合时 prime，删除时 revoke）。
- `ContactVM.avatarRef` / `PersonaVM.imageTags` 由它支撑；`PersonaVM` 加字段必须走
  `makePersona()`（§3.5）。
- 备份：blob 以 `blobB64` 进 `.aiwx`（JSON 会把 Blob 变 `{}`——与 CryptoKey 同类陷阱），
  恢复时还原；导出可选排除（备份页开关）。恢复后需重启让注册表重新 prime。
- Repo 接口：`getMedia(kind?) / getMediaItem / putMedia / deleteMedia`。

## SQLite 原生驱动 + 迁移（M-I17）

**Repo 接口一字未改**——这正是它存在的意义。新增：

- `src/db/sqlite.ts`：`SqliteRepo implements Repo`。布局 = 每个 store 一张
  `(key TEXT PRIMARY KEY, data TEXT)` JSON 表（沿用「JSON 列演进」约定），
  **唯 `messages` 保留 INTEGER AUTOINCREMENT 主键**——rowid 序==时间序、
  `beforeId` 游标语义与 IDB 版逐字节等价（差分测试 tests/unit/sqlite-repo.test.ts）。
  media blob 以 `blobB64` 进 TEXT 列，读时还原。索引查询走 `json_extract`
  表达式索引。`SqlDb` 是 @capacitor-community/sqlite@^7 连接的最小切面，
  测试注入内存模拟（tests/unit/fake-sqlite.ts，超出文法即抛错）。
- `src/db/driver.ts`：驱动选择。**Web 永远 IDB**；原生且迁移标志
  （IDB settings `sqliteMigratedAt`）已置位才换 SQLite。`repo` 变为委派代理
  （`setRepoImpl`），调用方零改动。另暴露按 store 的 raw 分发
  （`readStoreRows` 等）——备份必须经它读「活」的那份数据。
- **store 的家**：Repo 服务的 17 个 store 迁移后归 SQLite；
  `scheduled_actions`（scheduler 直读）、`tts_cache`（voice 直读）、
  `story_*`（story-gm 直读）的活数据**始终在 IDB**；`__crypto_master`
  行永远留在 IDB（keystore 直读，instanceof CryptoKey 校验）。
- `src/db/migrate-to-sqlite.ts`：一次性**复制**（绝不删源）。分批、进度回调、
  可中断续跑（per-store 完成 + messages id 水位）、行数校验通过才置标志；
  失败/中断自动留在 IDB。CryptoKey 行与迁移自身的 bookkeeping 行行级排除。
  回退 = 清标志（数据仍在 IDB 原处）。

## 备份 `.aiwx` v3（M-I17 增量 / M-I18 正确性）

**完整规格见 `specs/backup.md`**。与本文件的不变量相关的只有两条，改动时必须同时看：

- **删除只能用墓碑表达**（`file.tombstones[store] = [主键…]`），恢复时先删后写。
  删一行不会给幸存行重新编号，所以不变量 1（`rowid 序 == 时间序`）不受影响；
  **禁止**用「压缩/重排 id 区间」表达删除——那会改 id，游标分页立刻错乱。
  消息的墓碑必须还原成**数字**主键（删 `"7"` 是空操作，墓碑会静默失效）。
- **可变表不能用水位判断**。messages 的 `meta`（转账收款状态）、`isRecalled`、
  `status` 都是对旧行的**原地改写**，id 与 createdAt 都不变。判据是逐行内容哈希
  （`RowDigest`，存本机 `backupRowDigest`，永不进包）；哈希对 key 排序后计算，
  因为 SQLite 读回是 `{...JSON.parse(data), id}` 而 IDB 是存入顺序。
- 设备本地行（`__crypto_master` / 货架 / 通知权限 / 引擎标志…）走
  `src/lib/device-local.ts` 那**一份**清单：导出滤掉、恢复保本机，有守卫测试。
