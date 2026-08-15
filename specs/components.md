# 通用组件层（M-I0）

## 为什么现在才有

七个里程碑里全仓没有一个共享浮层原语：5 处 `window.prompt`（Android 上弹原生浏览器
对话框，是穿帮最狠的一种）、20 份复制粘贴的 switch span、8 个各自发明 z-index 的
fixed 浮层（30/50/60/70/80/90/100/1000）、硬件返回键完全没接（真机上任何页面按返回
= 退出 App）。

## 组成

| 件 | 文件 | 形态 |
|---|---|---|
| 对话框服务 | `src/components/dialog.tsx` | **命令式**：`await showConfirm(…)` / `showPrompt(…)` / `showActionSheet(…)`；`<DialogHost/>` 在 App 壳挂一次 |
| Switch | `src/components/Switch.tsx` | 受控组件；**类名与旧 span 字节相同**（golden 不动），补 `role="switch"` 与焦点 |
| dismiss 栈 | `src/app/dismiss-stack.ts` | 模块级栈；浮层挂载时 `pushDismiss(close)`，卸载时反注册 |
| 返回键 | `src/app/useBackButton.ts` | 顶层浮层 → 页面栈 pop → tab 根最小化（**永不 exitApp**，微信是最小化） |
| 浮层皮肤 | `src/components/overlay.css` | 微信样式对话框/动作面板；z 只用 token |
| z 层级 | `tokens.css` `--z-*` | shell 10 / msg-menu 30 / list-overlay 50 / picker 60 / forward 70 / viewer 80 / call 90 / rp-open 100 / dialog 120 / toast 1000 |

## 设计决定

- **命令式 API 而不是 `<Modal open>`**：被替换的 5 个调用点全是流程中段要答案的代码
  （`const name = prompt(…)`）。保持命令形是迁移能一次做完的原因；组件式会让每个流程
  围绕状态重写，迁移会卡在一半。
- **单槽 + 队列**：对话框天然模态，第二个请求排队而不是叠两层遮罩。
- **取消永远 resolve**（false/null），包括返回键取消与 `dismissAllDialogs()`——悬空的
  Promise 是用户看不见的冻结流程。
- **dismiss 栈是模块级不是 Context**：来电浮层和调度器代码在组件树外也要能开浮层。

## 验收（tests/unit/components.test.ts，改坏即转红）

- `src/features/` 下 `window.prompt/confirm/alert` 零命中。
- feature/component CSS 里 z-index > 5 的裸数字零命中（>5 豁免局部文档流层叠）。
- 手写 switch span 模板零命中。
- 三个破坏性删除入口（会话列表/会话详情/素材库）都 import showConfirm。
- App 壳挂了 DialogHost 与 useBackButton。
- dismiss 栈：逆序弹出、反注册后不可弹、close 抛错不断链。

## 已知边界

- Sheet 拖拽关闭在 I8 补（本期 Sheet 只有动画开合）。
- 长按菜单两份实现（chat-list / MessageBubble）在本期后段收敛为 LongPressMenu。
