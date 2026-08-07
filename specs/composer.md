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

## 验收
- [ ] （真机，熔断门 c）键盘→表情→+号→键盘循环切换，输入栏 0 跳变；首次键盘高未知用兜底
      280px，实测后锁定。
- [ ] Web 端 `visualViewport` 路径下面板高度合理、消息列表被顶起、点空白收起。
- [ ] golden：`composer-emoji` / `composer-plus` 截图稳定（已入基线）。

## 已知坑
- 首次未测到键盘高时用 `DEFAULT_PANEL_HEIGHT`，实测 >120px 才覆盖并持久化。
- 桌面浏览器无 `visualViewport` 键盘事件——面板仍可开合（用锁定/兜底高度），仅无真键盘联动。
