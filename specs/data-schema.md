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
