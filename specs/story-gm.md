# spec: 剧情模式 / GM（V3 实现，V1 仅预埋）

**状态**：V3 才实现。V1 只做**零返工预埋**，勿在 V1/V2 花实现精力。

## V1 预埋（已就位，勿动）
- `messages.story_script_id` + `story_seq` 标签列。
- `memory_facts.source='story'` + `story_save_id`（回档级联清除，防"记忆穿越"）。
- `story_scripts` / `story_saves` 表（schema 已建）。
- 会话级 Provider 覆盖能力（成人剧情走宽松通道）。

## V3 形态（裁决）
分层：主体=独立剧情会话（GM 驻场），世界感=廉价"涟漪钩子"（节点效果写长期记忆 / 触发发朋友圈）。
**不做全 App 世界事件模式**（爆炸半径大）。首发=线性节拍表 + GM 注入，DAG 分支编辑器无限期后置。

## 管线
串行 **GM → 导演 → 演员**，共用全局队列：GM 管剧情走向 + 改写各角色剧情段 prompt（不分配发言权）；
导演照常管谁发言/节奏（输入追加当前节点 goal 摘要）；旁白=灰色系统消息。

## Schema（字段级，V3 落地时按此实现）
```
Script{script_id, title, genre, nsfw_level:0|1|2, cast:[{char_id,role,secret}], vars, entry, nodes:[Node]}
Node{id, goal, directives:[{char_id,instruction,reveal,forbid}],
     triggers:[{when:"expr:vars.x>=3"|"llm:...", to, effects:{vars,mem_write,moment}}],
     timeout:{turns,to}, on_enter:{narrate,scene}}
```
触发双轨：expr 本地求值优先，未命中才让 GM 判 `llm:` 软条件。directives 按角色隔离注入
（绝不给角色整本剧本）。本地校验 DAG 无环 + 全可达。

## 一句话生成剧本（三步链）
大纲（logline+角色秘密+3-6 幕）→ JSON mode 结构化 → 本地校验+自修复≤2 次。成人题材且全开档
→ 整条生成链走宽松通道。

## 存档/回溯
节点跳转自动快照 `{node, vars, 消息游标, 各角色滑窗摘要}`；回档按 `(script_id,seq)` 级联撤销
mem_write 与朋友圈帖，否则角色"记得未来"。

## NSFW
生效档 = min(全局,剧本) 启动时锁定快照；成人节点须挂 vars 门槛 + `sfw_alt` 替代文案，禁 entry 直达。
