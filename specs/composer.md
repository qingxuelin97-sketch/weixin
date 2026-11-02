# spec: 组合器（键盘/表情/+号面板三态）

**文件**：`src/features/chat/useComposerPanel.ts`、`ComposerPanels.tsx`、`chat.css`。
**这是全项目最难 UI 点，也是 M1 熔断门 c。**

## 目标
键盘 ⇄ 表情/+号面板切换**零跳变**（输入栏不闪不跳）。

## 机制
- 状态机 `mode: none | keyboard | emoji | plus`。
- 输入栏底部留白 `bottomInset = max(keyboardH, panelH)`。
- **面板高度锁定为最近测得的键盘高度**（`panelHeight`，持久化到 localStorage）——升起面板恰好
  回填键盘让出的空间，故切换零跳变。
- 高度来源：原生走 Capacitor Keyboard 事件（`resize:none`，见 capacitor.config.ts）；
  Web/WKWebView 走 `visualViewport` resize。调用方只拿 `bottomInset` + `mode`。
- 切面板时 `blur()` 收键盘但不清 caret（re-focus 无缝）；点聊天区空白 `closeAll()`。

## 「＋」面板（M-K1）
- 微信 8.0 版式：64 见方白底圆角块 + 深灰线性图标（`src/components/panel-icons.tsx`，手绘 SVG、
  28 视框、1.7 线宽统一）+ 12px 灰字标签；4×2 一页，左右滑（scroll-snap）翻页，底部分页点。
- **单聊 / 群聊各一套**（`plusPages(isGroup)`）：第一页 相册 · 拍摄 · 视频通话|语音通话 · 位置 ·
  红包 · 转账|群收款 · 语音输入 · 收藏；第二页 个人名片 · 文件。钱那一格按场景换，不再把对方
  场景用不了的格子灰着摆。
- **没有死格**：每个 key 在 ChatPage 的 onAction 里都有分支（守卫：`k1-plus-panel.test.tsx`）。
  拍摄 = 带 `capture` 的系统选择器、走相册同一条发图管线；语音输入 = 底部 sheet 里一整条按住
  说话、松开转文字落进输入框（无 onClip 即 I9 的转写契约，按钮文案随之是「松开 结束」）；
  个人名片 = 选一个 AI 好友发 `contact_card`（与她推荐人时同一个 `contactCardPayload`）；
  文件 = 只记名字与大小的道具卡（M-I13 的契约：不存本体、不交给模型）。

## 验收
- [ ] （真机，熔断门 c）键盘→表情→+号→键盘循环切换，输入栏 0 跳变；首次键盘高未知用兜底
      280px，实测后锁定。
- [ ] Web 端 `visualViewport` 路径下面板高度合理、消息列表被顶起、点空白收起。
- [ ] golden：`composer-emoji` / `composer-plus` 截图稳定（已入基线）。
- [x] 「＋」面板每格有图标、有分支；单聊/群聊两套（`k1-plus-panel.test.tsx`，两条变异验证）。

## 已知坑
- **输入框所在的 flex 子项必须 `min-width: 0`**（M-K0）：textarea 的最小内容宽是 20 个平均字宽，
  宽体 CJK 系统字体下会把「＋」整个顶出屏幕（守卫：`k0-flex-inputs.test.ts`）。
- 首次未测到键盘高时用 `DEFAULT_PANEL_HEIGHT`，实测 >120px 才覆盖并持久化。
- 桌面浏览器无 `visualViewport` 键盘事件——面板仍可开合（用锁定/兜底高度），仅无真键盘联动。
