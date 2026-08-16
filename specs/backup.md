# spec: 备份与恢复（.aiwx）

**文件**：`src/lib/backup.ts`（信封 + 增量 + 恢复）/ `src/lib/device-local.ts`（设备本地行
唯一清单）/ `src/lib/backup-history.ts`（货架）/ `src/ai/auto-backup.ts`（自动备份，走
`scheduled_actions`）/ `src/features/settings/BackupPage.tsx`（UI）。
转红测试：`tests/unit/i18-backup.test.ts`、`tests/unit/backup-v2.test.ts`、
`tests/unit/backup-crypto.test.ts`、`tests/screenshot/backup-e2e.spec.ts`。

> 本文取代 `specs/backfill.md` 三、与 `specs/data-schema.md`「备份 v2」两处的分散描述，
> 那两处只保留指针。

没有服务器：设备丢了聊天记录就没了。导出是这个 App **唯一**的持久性保障，所以宁可偏向
完整——全部 store、一个 JSON 信封、不做静默省略。

---

## 0. 版本

| 版本 | 内容 |
|---|---|
| v1 | 全量快照。无 `mode` 字段视为 full，仍可恢复。 |
| v2 (M-I17) | 增量包（按水位）+ 备份历史货架 + 自动备份。 |
| v3 (M-I18) | **逐行内容哈希**判据 + **删除墓碑** + 增量路径的快照/标记/回滚 + 设备本地行统一清单。 |

`BACKUP_VERSION = 3`；比本机新的包直接拒收（不半读）。旧包一律照常恢复。

## 1. 存储分两类

**快照 store**（每个包整份带走、恢复时整表替换）：contacts / personas / conversations /
memory_facts / conv_summaries / scheduled_actions / providers / settings / red_packets /
rp_claims / transfers / worldbook / favorites / story_*。
它们小，而且**可变**——整份快照永远正确，不需要任何差分记账。转账/红包的状态位就在
`transfers` / `red_packets` 里，所以那两张表天然没有 I18-1 的问题。

**增量 store**（`WATERMARK_FIELDS`，按差分带走）：messages / moments / moment_likes /
moment_comments / wallet_tx / media。它们大，全量重发才是问题。

## 2. 为什么水位不够（I18-1 / I18-2）

水位（「只带 id/createdAt 大于上次的行」）是对 **append-only 表**成立的摘要。上面六张表
没有一张真是 append-only：

- **就地改写**：转账气泡写入时 `meta.status='pending'`，几天后收款时被**原地改成**
  `'accepted'`（id 不变、createdAt 不变）。撤回改 `isRecalled`，重发改 `status`。
  v2 只手工特判了 `isRecalled` 一种——那是 bug 的形状，不是修法。
  后果：恢复后转账气泡永远停在「待收款」，而 `wallet_tx` 里钱已经进来了。
- **删除**：增量包只能 upsert，说不出「这行没了」。用户删掉的消息/朋友圈/评论、
  取消的赞，在 [全量 + 增量] 恢复后**全部复活**。

### 判据的选择：逐行内容哈希（`RowDigest`）

`RowDigest = { [store]: { [主键字符串]: 32 位哈希 } }`，在**切包时**由同一批行算出，
和水位一起存在**本机** settings（`backupRowDigest`，属设备本地行，永不进包）。

下一个包：
- **带走**哈希变了或基准里没有的行 → 覆盖新增、撤回、收款、重发、任何原地编辑；
- **墓碑**基准里有、现在没有的主键 → `file.tombstones[store] = [id, …]`。

**为什么不是行内 `updatedAt`**：`updatedAt` 要在每一处写入点正确打戳（engine / handlers /
money-service / UI 共几十处，还跨两种驱动），漏掉的那一处**不报错、只是永久静默丢数据**
——正是本轮要修的这一类。哈希是从状态本身导出的，没有调用点可以漏。
**为什么不是整表快照**：那等于取消增量。
**代价**：每行每次备份一次 `stableStringify`，本机一份约 15 B/行的映射；32 位哈希要
在**同一个 id 的前后内容上**撞车才会藏住一次编辑（每次编辑 2⁻³²），可以接受。

细节：
- 哈希用 **key 排序后**的 stringify。SQLite 读回消息是 `{...JSON.parse(data), id}`，
  IDB 读回是存入顺序——不归一的话，刚迁移完的设备切增量会把整部历史判成「全变了」。
- `media` 只哈希元数据 + 字节长度，不读 blob 本体。媒体行写入后不再编辑，
  而每晚重算 60MB 的哈希比它要省的备份还贵。
- 没有基准（v2 链、或上次没读这个 store）→ 退回 v2 水位规则、且**不发任何墓碑**。
  凭水位臆造墓碑会删掉一切「早于水位」的行。安全方向永远是**多带、不删**。

### 墓碑与 rowid 不变量

删一行**不会**给任何幸存行重新编号，所以 `rowid 序 == 时间序`（`specs/data-schema.md`
不变量 1）不受影响。恢复时**先删后写**，且消息的墓碑按 store 的真实主键类型还原
（messages 是数字；删 `"7"` 是空操作，墓碑会静默失效）。
**禁止**用「重排 / 压缩 id 区间」表达删除——那会改 id，游标分页立刻错乱。

## 3. 设备本地行：一份显式清单

`src/lib/device-local.ts` 是**唯一**那份清单：**导出滤掉、恢复保本机**。
每项写明 `home`（`idb` = 驱动选定前就被直读，或根本进不了 TEXT 列；`live` = 走当前驱动）
与理由。守卫测试把各模块的真常量和清单对拍，改名漏登记会红。

| key | why |
|---|---|
| `__crypto_master` | CryptoKey 序列化成 `{}`，写回即永久损坏 keystore（H3） |
| `restoreInProgress` | 描述本机正在进行的恢复 |
| `backupHistory` | 货架指向本机 `backups/` 下的真实文件 |
| `backupWatermarks` / `backupRowDigest` | 本机上一个包的基准 |
| `autoBackupCounter` | 本机全量/增量节奏 |
| `lastBackupAt` | 本机最近导出时间（「该备份了」提醒） |
| `sqliteMigratedAt` / `sqliteMigrateProgress` | 本机存储引擎事实 |
| `notifyAsked` / `notifyGranted` | **系统权限事实**，不是用户数据 |

反例：`autoBackupFreq` 是**用户偏好**，照常进包。

被它挡住的三个真 bug：
1. **H3** 主密钥空壳写回 → keystore 永久损坏。
2. **I18-3 货架自我覆盖**：货架自己在导出的 settings 里，恢复整表替换 → 列出已删除的
   文件，并丢掉**刚用来恢复的那个条目**。
3. **I18-6 权限事实随包走**：换机后新机 POST_NOTIFICATIONS 其实是拒绝的，恢复来的
   `true` 让首启动弹窗被跳过、设置页显示「已开启」、通知**永久失效**。

恢复时的写回分两路：`live` 行走驱动，`idb` 行走 `idbPut`（且**任何** CryptoKey 行只走
IDB——迁移后的设备上 settings 是 TEXT 列）。IDB 那一路最后写，保证主密钥胜出。

## 4. 恢复：整库替换，两条路径同等护栏

这是单机数据，系统里没有任何冲突解决；合并两份分叉历史会把消息交错进一段从未发生过的
对话。所以恢复是替换。确认界面按**真实行数**展示，不是光秃秃的是/否。

两条路径（`restoreBackup` 全量 / `applyIncrementalBackup` 增量）现在都：

1. **先快照**（`exportBackup`）——选错文件可回滚；
2. **两阶段**：阶段一只解码与暂存（损坏的 base64、schema 不认的行在这里炸，此时**一行
   都还没动**）；阶段二才破坏性写入；
3. **写 `restoreInProgress` 标记**再动手。清 `settings` 会连标记一起清掉，所以清完立刻补写
   ——否则它要覆盖的崩溃窗口正好没被覆盖；
4. **失败即尽力回滚**（IndexedDB 没有跨 store 事务，只能尽力，但那是「恢复失败」与
   「全没了」的区别），回滚**连基准一起还原**（失败的恢复什么也没改变）；
5. 成功后清标记、`clearBackupState()`（本机数据已不再是货架基准所描述的那份，下次自动备份
   必须是全量）、重置 `lastForegroundAt` 屏障（否则下次前台 pass 会把整段空档「回填」成
   编出来的活动）。
6. **一个 store 一个事务**（M-I18）：写回走 `writeStoreRows`（IDB 侧是
   `idbBulkPut`，整批一个事务），不是逐行 `writeStoreRow`。`writeStoreRows` 自 I17 就写好了
   且零调用方——而恢复正是它存在的理由：四万条消息=四万个事务，慢到足以让 Android 在
   `media` 中途回收 WebView，也就是上面 §5 那个「中断可知」要报的场景本身。
   失败语义不变（逐行循环本来也是第一次抛错就整体中止并回滚）。

v2 的增量路径走的是同样的 clear+write，却**既不写标记、也不快照、也不回滚**：链中途一个
被截断的包会静默拿走联系人 / 会话 / 设置（I18-5）。

**多包链**（备份历史里恢复）：把基础全量的那一份快照传给链上每个增量
（`applyIncrementalBackup(file, now, { snapshot })`），于是中途失败**回到按下恢复之前**，
而不是停在两版历史之间；顺带整条链只重编码一次媒体库，而不是每包一次。

## 5. 中断可知（I18-4）

`restoreInProgress` 从 I17 起就在写，但**没有任何人读**（宪法 §3.5「写了没接线 = 没做」）。
60MB 恢复写到 media 时 WebView 被系统回收，留下的库**看起来是好的**，用户只会一次丢一段
地慢慢发现。现在两处接线，都复用已有 UI，不新建第二套通知系统：

- **启动 pass**（`useSchedulerRuntime`，延迟 1.5s）：`showConfirm` 弹一次。
  「我已了解」清标记；「稍后再看」保留。
- **备份页**：常驻警告块，直到确认。

标记本身在设备本地行清单里，所以**恢复来的包不可能伪造一次中断**。

## 6. 货架与自动备份

- **货架**：元数据在 settings KV `backupHistory`（不加 IDB store），内容经
  `@capacitor/filesystem` 存 `backups/`。条目只含**聚合行数与大小**——隐藏会话
  （AI↔AI 私信）内容不可能经此页泄漏。恢复链解析 `resolveRestoreChain`（纯函数）。
- **自动备份**：scheduled kind `auto_backup`，`registerChainedHandler`（先续链后干活）。
  频率 关/每日/每周；每 `FULL_EVERY=7` 次一个全量，其余增量；新全量落地后清理更旧的自动
  条目。id 按周期索引稳定，守卫防复活。
  **基准两半必须同时具备**：只有水位没有哈希 → 退化成 v2 行为 → 就是本轮要修的 bug，
  所以此时强制走全量。
- **守卫看的是状态，不是存在性**（M-I18）：`scheduleNext` 原先用 `actionExists(id)`，
  而 `cancelled` 行也「存在」。`setAutoBackupFreq` 恰好是**先取消再重排**，同一周期内
  重算出来的 id 就是它刚取消掉的那个 id —— 于是在设置页把「每天」再点一次（或
  每天→每周→每天），链就断了；`ensureAutoBackupScheduled` 也救不回来（它只在没有 pending
  时补，然后撞上同一个守卫）。结果：自动备份**永久静默停止**，而设置页还写着「每天」。
  现在判据是 `actionStatus(id) === 'done'` —— 只有真的备份过的周期才跳过，取消掉的重建。
  正向时钟下 done 分支其实不可达（done 行的 fireAt ≤ 执行时刻 ≤ now，而新 id 属于
  now 之后的周期），留着是防时钟倒退。这是 CLAUDE.md「`enqueue` 按 id upsert」那条陷阱的
  **反面**：一次性动作要问「有没有过」，自续链要问「是不是干完了」。
- **水位只在文件真的落到货架之后才前进**（`commitBackupState`，I18-7）：手动导出旧代码
  `recordBackup(...).catch(() => {})` 吞掉失败却照样推进水位，之后的自动增量就挂在一个
  **货架上不存在的全量**之上——恢复链解析不出来，静默缺一段。失败时 UI 明说
  「未能存入备份历史，后续自动备份会重新做一次全量」。

## 7. 刻意排除（写进 `manifest.omitted`，恢复时可解释）

- `providers` 的 key 字段：**API key 永不出设备**（宪法铁律 2）。只导出 `keyAlias`。
- `tts_cache`：合成音频可按原文重新合成。
- 设备本地行：见 §3。
- `media`（用户在导出开关里关掉时）：也要说出来——悬空的头像/图片 ref 否则读起来像丢数据。

## 8. 隐藏会话

隐藏会话（AI↔AI 私信）**是数据，必须进包**——丢了就丢了八卦层的历史。但它**不得出现在
任何用户可见面**：货架条目只有聚合数字，manifest 里没有标题也没有正文。新增可见面
（导出预览、通知、年度报告）时都要再问一遍这句。

## 验收

- [x] 转账收款后切增量 + 恢复，气泡仍是 `accepted`，且与账本一致（金额整数分）。
- [x] 删除的消息 / 赞 / 朋友圈 / 评论，恢复后**不复活**；幸存行 id 不被重编号。
- [x] 货架元数据恢复后不回退，刚用来恢复的条目还在；旧包里的货架行写不回来。
- [x] 中断的恢复在下次启动被告知；完成的恢复不误报；标记不进包。
- [x] 增量链中途失败回滚到恢复前，联系人/会话/设置/基准都不丢。
- [x] `notifyAsked` / `notifyGranted` 不进包，恢复保本机的答案。
- [x] 手动导出货架写失败时水位**不前进**。
- [x] 设备本地行清单守卫：各模块真常量必须都在清单上。
- [x] v2 / v1 包仍可恢复（无 digest 时退回水位规则、不发墓碑）。
- [x] `tests/screenshot/backup-e2e.spec.ts`：导出 → 清库 → 恢复 → 逐行全等（含消息自增 id）。
