# specs/moments.md — 朋友圈

## 为什么这样设计

朋友圈的可信度**几乎全在时间上**。真朋友不会在你发完的瞬间齐刷刷点赞，而是几小时里零零散散
地来，顺序毫无规律，而且大多数人根本不评论。所以本模块把「谁在什么时候反应」（纯函数、种子化、
可单测）与「说了什么」（唯一碰网络的部分）彻底切开——前者决定像不像真的，后者只决定好不好看。

## 验收清单

- [x] 发布：文本 + 选图（0/1/3/4/9），发完立刻回到 feed
- [x] Feed：封面 + 自己头像昵称、动态卡片、1/4/9 三种宫格、赞评块
- [x] 导航栏随滚动由透明渐变为实底（`--nav-alpha` 由真实 scrollTop 驱动，非阈值猜测）
- [x] 用户自己发的动态**也会**被 AI 错峰点赞评论——这才是这个功能的意义
- [x] 评论必须针对帖子内容本身（prompt 里钉入原文），不能是「说得好」这种通用话
- [x] 无条件 SFW
- [ ] 长按点赞菜单的按压动画、下拉刷新（留给打磨阶段）

## 铁律

**朋友圈无条件 SFW**（宪法铁律 6 / `specs/nsfw.md`）。`generateMomentPost` 与
`generateMomentComment` 永远传 `nsfwTier: 'off'`，不看全局档位、不看人设 `nsfwPermit`。
feed 是共享界面，一条越界的帖子是突兀而非「按需开启」。

## 数据

| 表 | 要点 |
|---|---|
| `moments` | `imageRefs` 存**不透明引用**而非 URL，换图不动已存帖子 |
| `moment_likes` | id = `${momentId}:${contactId}`，「一人一赞」由 store 主键保证 |
| `moment_comments` | `replyToCommentId` 支持互回，深度限 2 |

SQLite 里 likes 是复合主键 `(momentId, contactId)`；IndexedDB keyPath 只能单值，
故用合成 id 表达同一个不变量。换驱动时这层对应关系要保住。

## 排期规则（`planReactions`，纯函数）

- 作者永不给自己点赞/评论
- 概率 = 人设 `likeRate`/`commentRate` × 亲密度缩放（affinity 0→0.6x，50→1.0x，100→1.4x）
- 点赞落在发布后 **1min–2h**，评论 **3min–4h**，且**必定晚于本人的赞**（真实顺序如此）
- 每个反应都被推进该人设的 `activeHours`——没人会在凌晨四点给你点赞
- 种子 = `react:${momentId}:${contactId}`：同一条帖子永远吸引同一批人，回填可重放

## 配图槽位

`src/assets/moments/` 是**素材导入槽位**：丢进 PNG/JPG/WebP 即自动启用，不改代码
（`import.meta.glob` 构建期扫描）。目录为空时回落到程序生成的占位渐变，feed 不开天窗。
素材被删后，引用它的旧帖回落到**按文件名哈希选取的稳定占位**——版式不塌、不出现裂图。

占位色写在 `src/data/moments-images.ts`：那是**内容**（同占位头像色），所以放在 `src/data/`
这个颜色检查豁免目录，而不是去放宽豁免规则。

## 已知坑

- **`likesFor`/`commentsFor` 必须返回稳定引用**：store 里按 momentId 建映射，空集合用模块级
  常量。返回新数组 = 无限重渲染 = 生产白屏（见 CLAUDE.md §3.5）。
- **AI 点赞用 `applyLike` 而不是 `toggleLike`**：AI 的反应永远是「加」。曾经的写法是先
  `repo.putLike` 再调 `toggleLike`，结果第二步立刻把刚加的赞又取消了。
- 新增 store 记得 `DB_VERSION` +1（v4 就是为朋友圈加的）。

## M-C2 增补：配图池标签化

`pickImages(seed, count, tags?)`：`tags` 来自 `PersonaVM.imageTags`，按标签过滤
`idb:` 照片池（吃货人设不发健身照）；空标签或过滤后为空 → 回落全池（宁可跑题不可
让人设永远无图）。优先级：运行时媒体库 > 构建期 assets > 渐变占位。同种子同图不变。
