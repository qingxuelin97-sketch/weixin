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
| dismiss 桥 | `src/app/useDismissable.ts` | 声明式挂接：`useDismissable(open, close)`；close 走 ref，内联箭头不抖栈序 |
| Sheet | `src/components/Sheet.tsx` | 受控底部容器（标题+可滚 body）；有实内容的面板用它，纯选项列表用 showActionSheet |
| 长按手势 | `src/components/useLongPress.ts` | 唯一的 LONG_PRESS_MS；10px 容差半径 + fired 防误触 + 右键回退 |
| 长按菜单 | `src/components/LongPressMenu.tsx` + `long-press-menu.css` | 唯一的菜单 DOM/皮肤/消失行为；`layout='row'`（气泡上的胶囊）\| `'column'`（列表行上的竖排） |
| 徽章 | `src/components/Badge.tsx` | 未读数/红点/角标的唯一实现：0 不渲染、>99 显示 99+、dot 只留框；**类名由调用点传入**（皮肤仍归 feature，golden 不动） |
| 浮层皮肤 | `src/components/overlay.css` | 微信样式对话框/动作面板/sheet；z 只用 token |
| z 层级 | `tokens.css` `--z-*` | shell 10 / 长按菜单 30 / list-overlay 50 / picker 60 / sheet 70 / viewer 80 / call 90 / rp-open 100 / dialog 120 / toast 1000 |

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
- `LONG_PRESS_MS =` 全仓只允许出现在 `useLongPress.ts`。
- Sheet 有真实消费者；`forward-mask` 手写浮层零残留。
- 条件渲染的浮层（Sheet/ImageViewer/MediaPicker/LongPressMenu/会话列表 ＋ 浮层/组合器面板）
  全部登记 dismiss 栈。
- `<Badge/>` ≥4 个消费者；`src/features`+`src/app` 里 `<span>` 直接写徽章类名零命中。
- `msg-menu` / `conv-menu` 两套手写菜单零残留（`--z-msg-menu` 这个 token 名保留）；
  两个消费者都渲染 `<LongPressMenu/>`，聊天页不再自己挂 document pointerdown 监听。
- Sheet 与 `useComposerPanel` **互不 import**（源码级断言，两边各一条）；Sheet 不得
  从 `src/features` import 任何东西。

## 已知边界

- Sheet 拖拽关闭在 I8 补（本期 Sheet 只有动画开合）。
- 长按**菜单**已在 I18 收编：DOM、皮肤、遮罩、dismiss 登记全归 `LongPressMenu`。
  两处外观有分歧的地方一律以**聊天气泡那份**为准（深色胶囊 + 白字 + on-color 分隔线
  + 6px 圆角 + 14px），所以会话列表的浅色卡片和它的红色「删除该聊天」都不在了——
  真机上微信的会话长按菜单本来就是深色全白字。差异只剩**轴向**：气泡上横排、
  列表行上竖排（`layout` prop），因为这是用途决定的，不是各画各的。
- 两处的**行为**现在也一样：透明遮罩吃掉那一下"点外面"（以前聊天页是 document
  捕获监听，点外面会顺手点到底下的东西）、选中即执行即关闭、只登记一次 dismiss。
