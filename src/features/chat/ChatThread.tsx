/**
 * 聊天页的线程区 (M-K11，从 ChatPage 抽出)：滚动这件事的全部机关。
 *
 * - 时间条穿插（间隔 > 5 分钟一条居中时间，微信同款）；
 * - 钉底：新气泡到来时贴住最新一条——但向上翻历史（前插）时不贴；内容事后长高
 *   （照片懒加载、字体晚到、气泡重排）且读者本来就在底部附近时重新贴底；
 * - 按需加载更早的历史（M-G2），以「离底部的距离」为锚，前插后不跳；
 * - `?at=<msgId>[&n=nonce]` 锚定（搜索命中 / 引用回跳 / 置顶条，M-I6 / M-J0）：分页
 *   直到目标行存在，滚到居中并闪一下；
 * - 多选模式的勾选圆点与「吞掉一切内部点击」；
 * - 「对方正在输入」气泡。
 *
 * 每条消息**画成什么样**不归这里管：`renderMessage` 由页面给出（MessageBubble 的
 * 二十来个回调都是页面的状态与导航）。这里只负责行的外壳——`data-msg-id`、选择、
 * 闪烁——与外壳之间的滚动。DOM 与拆分前逐节点一致，截图基线一像素不动。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Avatar } from '../../components/Avatar';
import { useMedia } from '../../components/useMedia';
import { useAppStore } from '../../store/appStore';
import { chatTimestamp, shouldShowTimeBar } from '../../lib/time';
import { logError } from '../../lib/errlog';
import { useNow } from '../../lib/useNow';
import type { ContactVM, MessageVM } from '../../data/types';

type Row = { kind: 'time'; ts: number } | { kind: 'msg'; msg: MessageVM };

function withTimeBars(messages: MessageVM[]): Row[] {
  const rows: Row[] = [];
  let prevTs: number | null = null;
  for (const msg of messages) {
    if (shouldShowTimeBar(prevTs, msg.createdAt)) rows.push({ kind: 'time', ts: msg.createdAt });
    rows.push({ kind: 'msg', msg });
    prevTs = msg.createdAt;
  }
  return rows;
}

export interface ChatThreadProps {
  convId: string;
  messages: MessageVM[];
  /** Raw typing flag — any change re-pins to the bottom. */
  isTyping: boolean;
  /** Whose「正在输入」bubble to draw, if any (single chats, outside the rhythm's pauses). */
  typingPeer: ContactVM | undefined;
  showTyping: boolean;
  /** Composer/panel height the transcript must clear (useComposerPanel). */
  bottomInset: number;
  selecting: boolean;
  selected: ReadonlySet<number>;
  /** The message the long-press menu points at: its bubble stays pressed (M-K12). */
  heldId?: number | null;
  onToggleSelect: (id: number) => void;
  /** The bubble for one message, wired by the page. */
  renderMessage: (msg: MessageVM) => ReactNode;
}

export function ChatThread({
  convId,
  messages,
  isTyping,
  typingPeer,
  showTyping,
  bottomInset,
  selecting,
  selected,
  heldId = null,
  onToggleSelect,
  renderMessage,
}: ChatThreadProps) {
  const NOW = useNow();
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Interleave time bars (WeChat shows a centered time when the gap > 5 min).
  const rows = useMemo(() => withTimeBars(messages), [messages]);

  // Photo messages resolve through the lazy media registry (M-G1): ask for the
  // blobs this transcript actually shows, and re-render when they land.
  // Custom stickers (M-I15) are `idb:` refs too, so they prime the same way.
  useMedia(
    useMemo(
      () =>
        messages
          .filter(
            (m) =>
              m.type === 'image' ||
              (m.type === 'sticker' && m.content?.startsWith('idb:')),
          )
          .map((m) => m.content),
      [messages],
    ),
  );

  // Keep the view pinned to the newest message as bubbles arrive — but not
  // when the growth came from loading OLDER messages, which prepends.
  const pinToBottom = useRef(true);
  useEffect(() => {
    if (!pinToBottom.current) {
      pinToBottom.current = true;
      return;
    }
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows.length, isTyping, bottomInset]);

  /**
   * Re-anchor when the CONTENT grows without the message count changing.
   *
   * The effect above fires on `rows.length`, which misses everything that
   * changes height after the fact: a photo finishing its lazy load, an emoji
   * falling back to a font that arrives late, a bubble rewrapping. Each of
   * those pushes the newest message below the fold and leaves it there — the
   * view was anchored to a height that no longer exists.
   *
   * Only re-anchors when the reader is already ~at the bottom, so it can never
   * yank someone who has scrolled up to read history.
   */
  useEffect(() => {
    const el = scrollRef.current;
    const inner = listRef.current;
    if (!el || !inner || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [convId]);

  // Older history, on demand (M-G2). Hydration holds a flat 200 per
  // conversation and everything before that was unreachable — in the database,
  // invisible to both scrolling and search.
  const loadOlderMessages = useAppStore((s) => s.loadOlderMessages);
  const openConversation = useAppStore((s) => s.openConversation);

  // Threads are fetched on open, not at startup (M-G2). `threadReady` is a
  // real readiness signal rather than test scaffolding: the page now paints
  // before its messages exist, so anything that needs to observe the settled
  // thread — the golden screenshots, and a future scroll-restore — has to be
  // able to tell "still loading" from "loaded and empty".
  const threadReady = useAppStore((s) => s.hasThread(convId));
  useEffect(() => {
    void openConversation(convId).catch((e) => logError('chat.open', e));
  }, [convId, openConversation]);
  const [atTop, setAtTop] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadOlder = async () => {
    const el = scrollRef.current;
    if (!el || loadingOlder || atTop) return;
    setLoadingOlder(true);
    // Anchor on the distance from the BOTTOM: prepending changes scrollHeight,
    // and restoring scrollTop directly would jump the reader to a random spot.
    const fromBottom = el.scrollHeight - el.scrollTop;
    pinToBottom.current = false;
    try {
      const n = await loadOlderMessages(convId);
      if (n === 0) setAtTop(true);
      requestAnimationFrame(() => {
        const cur = scrollRef.current;
        if (cur) cur.scrollTop = cur.scrollHeight - fromBottom;
      });
    } finally {
      setLoadingOlder(false);
    }
  };

  // 搜索命中锚定 (M-I6): `?at=<msgId>` — a search hit lands here, pages history
  // in until the target row exists, scrolls it to center and flashes it once.
  // Keyed so re-renders don't re-run the jump, but a NEW hit in the same
  // conversation does.
  const [searchParams] = useSearchParams();
  const atParam = searchParams.get('at');
  // Nonce (M-J0): a quote tap on the SAME message twice must re-anchor, so the
  // jump key includes it — without it the anchoredKey guard eats the second tap.
  const atNonce = searchParams.get('n') ?? '';
  const [flashId, setFlashId] = useState<number | null>(null);
  const anchoredKey = useRef<string | null>(null);
  useEffect(() => {
    const at = atParam ? Number(atParam) : NaN;
    if (!Number.isFinite(at) || !threadReady) return;
    const key = `${convId}:${at}:${atNonce}`;
    if (anchoredKey.current === key) return;
    anchoredKey.current = key;
    let alive = true;
    void (async () => {
      // Page older history in until the target is present. Two stop rules
      // besides success: the top of history, and an oldest-loaded row already
      // older than the target — that means the message was deleted, and paging
      // further would walk the whole thread for nothing.
      for (let guard = 0; guard < 40; guard++) {
        const list = useAppStore.getState().messagesFor(convId);
        if (list.some((m) => m.id === at)) break;
        if (list.length && list[0].id <= at) return;
        pinToBottom.current = false;
        const n = await loadOlderMessages(convId, 200);
        if (!alive || n === 0) return;
      }
      if (!alive) return;
      pinToBottom.current = false;
      requestAnimationFrame(() => {
        const el = scrollRef.current?.querySelector(`[data-msg-id="${at}"]`);
        if (el) {
          (el as HTMLElement).scrollIntoView({ block: 'center' });
          setFlashId(at);
        }
      });
    })().catch((e) => logError('chat.anchor', e));
    return () => {
      alive = false;
    };
  }, [convId, atParam, atNonce, threadReady, loadOlderMessages]);

  return (
    <div
      ref={scrollRef}
      data-thread-ready={threadReady ? '1' : '0'}
      onScroll={(e) => {
        if (e.currentTarget.scrollTop <= 8) void loadOlder();
      }}
      className="chat-page__scroll"
      style={{ paddingBottom: bottomInset }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="chat-page__messages" ref={listRef}>
        {/* Top-of-history affordance. Silent when there is nothing more:
            WeChat shows no marker at the start of a thread either. */}
        {loadingOlder && <div className="chat-page__older">正在加载更早的消息…</div>}
        {rows.map((row) =>
          row.kind === 'time' ? (
            <div className="msg-time" key={`t${row.ts}`}>
              {chatTimestamp(row.ts, NOW)}
            </div>
          ) : (
            <div
              key={row.msg.id}
              data-msg-id={row.msg.id}
              className={
                [
                  selecting && 'msg-selectable',
                  flashId === row.msg.id && 'msg-anchor-flash',
                  heldId === row.msg.id && 'msg-held',
                ]
                  .filter(Boolean)
                  .join(' ') || undefined
              }
              onAnimationEnd={
                flashId === row.msg.id
                  ? // Child animations (bubble entrances) bubble up too — only
                    // the flash itself may clear the flag.
                    (e) => e.animationName === 'msg-anchor-flash' && setFlashId(null)
                  : undefined
              }
              onClickCapture={
                selecting
                  ? (e) => {
                      // Selection swallows every inner tap — a checkbox mode
                      // that still opens red packets is a trap.
                      e.stopPropagation();
                      if (row.msg.type !== 'system' && !row.msg.isRecalled)
                        onToggleSelect(row.msg.id);
                    }
                  : undefined
              }
            >
              {selecting && row.msg.type !== 'system' && !row.msg.isRecalled && (
                <span
                  className={`msg-select-dot${selected.has(row.msg.id) ? ' msg-select-dot--on' : ''}`}
                  aria-hidden
                />
              )}
              {renderMessage(row.msg)}
            </div>
          ),
        )}
        {showTyping && (
          <div className="msg-row msg--enter" aria-label="对方正在输入">
            <div className="msg-row__avatar">
              <Avatar
                color={typingPeer?.avatarColor ?? 'var(--color-brand)'}
                text={typingPeer?.avatarText ?? '?'}
                imageRef={typingPeer?.avatarRef}
                size={40}
              />
            </div>
            <div className="msg-row__col">
              <div className="msg-row__body">
                <div className="bubble bubble--other typing-bubble">
                  <span className="typing-bubble__dot" />
                  <span className="typing-bubble__dot" />
                  <span className="typing-bubble__dot" />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
