import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  IconBack,
  IconMore,
  IconVoiceCircle,
  IconMicSmall,
  IconEmoji,
  IconPlus,
} from '../../components/icons';
import { Avatar } from '../../components/Avatar';
import { MessageBubble } from './MessageBubble';
import { ImageViewer } from '../../components/ImageViewer';
import { registerMedia } from '../../data/media-registry';
import { ComposerPanels } from './ComposerPanels';
import { useComposerPanel } from './useComposerPanel';
import { storyRunning } from '../../ai/story-service';
import type { StorySaveRow } from '../../ai/story-gm';
import { useAppStore } from '../../store/appStore';
import { regenerateLastTurn } from '../../ai/engine';
import { useGuard } from '../../app/useGuard';
import { chatTimestamp, shouldShowTimeBar } from '../../lib/time';
import { hasUsableProvider } from '../../llm/service';
import { sendUserMessage } from '../../ai/engine';
import { maybeScheduleMemExtract } from '../../ai/memory-service';
import { sendGroupMessage } from '../../ai/group-engine';
import { acceptTransfer } from '../../ai/money-service';
import type { GroupMember } from '../../ai/director';
import { repo } from '../../db/repo';
import { canRecall } from '../../lib/recall';
import type { MessageVM, NsfwTierVM } from '../../data/types';
import './chat.css';
import '../settings/settings.css';
import { useNow } from '../../lib/useNow';

export function ChatPage() {
  const guard = useGuard();
  const NOW = useNow();
  const { convId = '' } = useParams();
  const navigate = useNavigate();
  const conv = useAppStore((s) => s.conversationById(convId));
  const messages = useAppStore((s) => s.messagesFor(convId));
  const contactById = useAppStore((s) => s.contactById);
  const personaFor = useAppStore((s) => s.personaFor);
  const appendMessage = useAppStore((s) => s.appendMessage);
  const updateMessage = useAppStore((s) => s.updateMessage);
  const setTyping = useAppStore((s) => s.setTyping);
  const setActiveConv = useAppStore((s) => s.setActiveConv);
  const patchConversation = useAppStore((s) => s.patchConversation);
  const showToast = useAppStore((s) => s.showToast);
  const isTyping = useAppStore((s) => Boolean(s.typing[convId]));
  // Being *in* this conversation zeroes its badge, so no per-conv exception here.
  const totalUnread = useAppStore((s) =>
    s.conversations.reduce((n, c) => n + (c.isMuted || c.isHidden ? 0 : c.unreadCount), 0),
  );
  const composer = useComposerPanel();
  const [draft, setDraft] = useState('');
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const scrollRef = useRef<HTMLDivElement>(null);

  // Presence: entering clears unread + mentions; leaving parks unsent text as
  // the conversation's draft (route param changes don't remount this component).
  // `hydrated` is a dep so a cold boot straight into a chat still gets both.
  const hydrated = useAppStore((s) => s.hydrated);
  useEffect(() => {
    void setActiveConv(convId);
    setDraft(useAppStore.getState().conversationById(convId)?.draft ?? '');
    return () => {
      void setActiveConv(null);
      const text = draftRef.current.trim() || undefined;
      const cur = useAppStore.getState().conversationById(convId);
      if (cur && (cur.draft || undefined) !== text) void patchConversation(convId, { draft: text });
    };
  }, [convId, hydrated, setActiveConv, patchConversation]);

  // 防呆 (#5/#16): a chat with no usable provider looks "broken" — every send
  // gets the persona refusal line. Say why, and link straight to the fix.
  const [noProvider, setNoProvider] = useState(false);
  useEffect(() => {
    let alive = true;
    void hasUsableProvider()
      .then((ok) => alive && setNoProvider(!ok))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [convId]);

  /** Long-press context menu: which message, anchored where. */
  const [menu, setMenu] = useState<{ msg: MessageVM; x: number; y: number } | null>(null);
  const [quote, setQuote] = useState<{ msgId: number; text: string } | null>(null);
  const [forwarding, setForwarding] = useState<MessageVM | null>(null);
  const allConversations = useAppStore((s) => s.conversations);
  const deleteMessage = useAppStore((s) => s.deleteMessage);
  const albumInputRef = useRef<HTMLInputElement>(null);

  // Leaving the chat = the conversation went quiet → queue ONE memory
  // extraction if enough new material accumulated (M-D2 loop trigger).
  useEffect(() => {
    return () => {
      const c = useAppStore.getState().conversationById(convId);
      if (c?.type === 'single' && c.peerId) {
        void maybeScheduleMemExtract(convId, c.peerId, Date.now()).catch(() => {});
      } else if (c?.type === 'group' && !c.isHidden) {
        // Groups remember too (M-E4). The subject is the CONVERSATION, not a
        // person: "群里说下周要一起吃饭" belongs to the group, and every member
        // should be able to refer to it. Without this the group had no memory at
        // all — every round started from the last 30 messages and nothing else.
        void maybeScheduleMemExtract(convId, convId, Date.now()).catch(() => {});
      }
    };
  }, [convId]);
  useEffect(() => {
    if (!menu) return;
    // Any further interaction dismisses the menu, WeChat-style.
    const close = () => setMenu(null);
    document.addEventListener('pointerdown', close, { capture: true });
    return () => document.removeEventListener('pointerdown', close, { capture: true });
  }, [menu]);

  const recallOwn = async (msg: MessageVM) => {
    setMenu(null);
    if (!canRecall(msg, Date.now())) return;
    await updateMessage({ ...msg, isRecalled: true });
  };
  const copyText = (msg: MessageVM) => {
    setMenu(null);
    if (msg.content) void navigator.clipboard?.writeText(msg.content).catch(() => {});
  };

  /**
   * 重新生成 (M-E6). An AI going out of character is a certainty, not an edge
   * case, and until now there was no way to correct it in the moment — the
   * options were live with it or delete the conversation. A bad line left
   * standing also poisons every later turn, since it stays in the context.
   */
  const regenerate = async (steer?: string) => {
    setMenu(null);
    const c = useAppStore.getState().conversationById(convId);
    const peerId = c?.peerId;
    if (!peerId) return;
    const peerC = contactById(peerId);
    const persona = useAppStore.getState().personaFor(peerId);
    if (!peerC || !persona) return;
    const tier = (await repo.getSetting<NsfwTierVM>('nsfwGlobalTier')) ?? 'off';
    await regenerateLastTurn(
      convId,
      peerC,
      persona,
      tier,
      {
        appendMessage,
        updateMessage,
        setTyping,
        now: () => Date.now(),
        deleteMessage,
      },
      steer,
    );
  };

  // Interleave time bars (WeChat shows a centered time when the gap > 5 min).
  const rows = useMemo(() => withTimeBars(messages), [messages]);

  // Keep the view pinned to the newest message as bubbles arrive.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows.length, isTyping, composer.bottomInset]);

  // Is a story playing here? Re-checked as the transcript grows, which is also
  // when a run ends or pauses. Never throws into the page: an unreadable save
  // row means "no banner", not a blank chat.
  const [story, setStory] = useState<StorySaveRow | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void storyRunning(convId)
      .then((s) => {
        if (alive) setStory(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [convId, rows.length]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !conv) return;
    setDraft('');
    const globalTier = (await repo.getSetting<NsfwTierVM>('nsfwGlobalTier')) ?? 'off';
    const hooks = { appendMessage, updateMessage, setTyping, now: () => Date.now() };

    // Group: the director stages a cast; single: one persona replies.
    if (conv.type === 'group') {
      const members: GroupMember[] = (conv.memberIds ?? []).map((id) => {
        const c = contactById(id);
        return { contactId: id, name: c?.remark ?? c?.name ?? id, persona: personaFor(id) };
      });
      await sendGroupMessage(conv, text, members, globalTier, hooks, contactById);
      return;
    }

    const peerId = conv.peerId;
    const peer = peerId ? contactById(peerId) : undefined;
    const persona = peerId ? personaFor(peerId) : undefined;

    if (!peer || !persona) {
      // No persona card configured yet — record the user's message rather than drop it.
      await appendMessage({
        convId,
        senderId: 'self',
        type: 'text',
        content: text,
        status: 'sent',
        createdAt: Date.now(),
      });
      return;
    }

    const quoteMeta = quote ? { quote: quote.text } : undefined;
    setQuote(null);
    await sendUserMessage(convId, text, peer, persona, globalTier, hooks, quoteMeta);
  };

  /**
   * 相册发图：system file picker → import into the media library (photo pool,
   * 标签"聊天") → send as an image message whose content is the `idb:` ref.
   * Persisting through the library (not a one-off blob) keeps a single media
   * path — the ref survives backup/restore like every other ref.
   */
  const sendImages = async (files: FileList | null) => {
    if (!files?.length || !conv) return;
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) continue;
      const item = {
        id: crypto.randomUUID(),
        kind: 'photo' as const,
        tags: ['聊天'],
        mime: f.type,
        blob: f as Blob,
        createdAt: Date.now(),
      };
      await repo.putMedia(item);
      registerMedia(item.id, { url: URL.createObjectURL(f), kind: 'photo', tags: item.tags });
      await appendMessage({
        convId,
        senderId: 'self',
        type: 'image',
        content: `idb:${item.id}`,
        status: 'sent',
        createdAt: Date.now(),
      });
    }
  };

  /**
   * Ordered image refs + a per-message position map. The map (not indexOf on
   * the ref) picks the viewer's start: two messages can legitimately share one
   * ref (re-sent library photo), and indexOf would open at the first one.
   */
  const { imageRefs, imageIndexByMsgId } = useMemo(() => {
    const refs: string[] = [];
    const byId = new Map<number, number>();
    for (const r of rows) {
      if (r.kind === 'time') continue;
      const m = (r as { msg: MessageVM }).msg;
      if (m.type !== 'image' || m.isRecalled || !m.content) continue;
      byId.set(m.id, refs.length);
      refs.push(m.content);
    }
    return { imageRefs: refs, imageIndexByMsgId: byId };
  }, [rows]);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const onImageTap = (msg: MessageVM) => {
    setViewerIndex(imageIndexByMsgId.get(msg.id) ?? 0);
  };

  /** Red packet → open/detail; a pending transfer from the peer → accept it. */
  const onMoneyTap = (msg: MessageVM) => {
    if (msg.type === 'rp') {
      const rpId = msg.meta?.rpId as string | undefined;
      if (rpId) navigate(`/rp/open/${rpId}`);
      return;
    }
    if (msg.type === 'transfer') {
      const transferId = msg.meta?.transferId as string | undefined;
      const status = msg.meta?.status as string | undefined;
      if (transferId && status === 'pending' && msg.senderId !== 'self') {
        void acceptTransfer(transferId, {
          appendMessage,
          updateMessage,
          now: () => Date.now(),
        });
      }
    }
  };

  if (!conv) {
    return (
      <div className="chat-page">
        <div className="chat-page__missing">会话不存在</div>
      </div>
    );
  }

  const isGroup = conv.type === 'group';
  const peerContact = conv.peerId ? contactById(conv.peerId) : undefined;

  return (
    <div className="chat-page" onClick={() => composer.mode !== 'none' && composer.closeAll()}>
      <header className="navbar chat-nav">
        <div className="navbar__left">
          <button className="navbar__btn chat-nav__back" aria-label="返回" onClick={() => navigate(-1)}>
            <IconBack />
            {totalUnread > 0 && (
              <span className="chat-nav__unread">{totalUnread > 99 ? '99+' : totalUnread}</span>
            )}
          </button>
        </div>
        <div className="navbar__title chat-nav__title">
          {isTyping ? '对方正在输入…' : conv.title}
        </div>
        <div className="navbar__right">
          <button className="navbar__btn" aria-label="更多" onClick={() => navigate(`/chat/${convId}/info`)}>
            <IconMore />
          </button>
        </div>
      </header>

      {noProvider && (
        <div
          className="chat-banner hairline-bottom"
          role="button"
          onClick={(e) => {
            e.stopPropagation();
            navigate('/settings/api');
          }}
        >
          未配置 API key，对方无法回复 · 点此去配置 ›
        </div>
      )}

      {isGroup && conv.announcement && (
        <div className="group-announce hairline-bottom" onClick={(e) => e.stopPropagation()}>
          <span className="group-announce__icon" aria-hidden>
            💬
          </span>
          <span className="group-announce__text">{conv.announcement}</span>
        </div>
      )}

      {/* A story playing in this conversation (M-G0). `storyRunning` shipped in
          M-E5 describing itself as "used to gate the UI" and had zero callers,
          so the only sign a story was running was grey narration in the
          transcript — and a story that STOPPED looked exactly like one that had
          simply gone quiet. */}
      {story && (
        <div className="group-announce hairline-bottom" onClick={(e) => e.stopPropagation()}>
          <span className="group-announce__icon" aria-hidden>
            {story.stalledAt ? '⏸' : '🎬'}
          </span>
          <span className="group-announce__text">
            {story.stalledAt ? '剧情已暂停——多次生成失败，去剧情页可以继续' : '剧情进行中'}
          </span>
          <button
            className="group-announce__action"
            onClick={() => navigate('/story')}
          >
            {story.stalledAt ? '去处理' : '查看'}
          </button>
        </div>
      )}

      <div
        ref={scrollRef}
        className="chat-page__scroll"
        style={{ paddingBottom: composer.bottomInset }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="chat-page__messages">
          {rows.map((row) =>
            row.kind === 'time' ? (
              <div className="msg-time" key={`t${row.ts}`}>
                {chatTimestamp(row.ts, NOW)}
              </div>
            ) : (
              <MessageBubble
                key={row.msg.id}
                msg={row.msg}
                sender={contactById(row.msg.senderId)}
                isSelf={row.msg.senderId === 'self'}
                showNickname={isGroup}
                onMoneyTap={onMoneyTap}
                onImageTap={onImageTap}
                onLongPress={(m, x, y) => {
                  // Only open when there is at least one action — an empty
                  // capsule reads as breakage.
                  const hasCopy = m.type === 'text' && Boolean(m.content);
                  const canRegen =
                    m.senderId !== 'self' && !isGroup && messages.at(-1)?.id === m.id;
                  if (hasCopy || canRecall(m, Date.now()) || canRegen) setMenu({ msg: m, x, y });
                }}
                onReEdit={(m) => setDraft(m.content ?? '')}
              />
            ),
          )}
          {isTyping && !isGroup && (
            <div className="msg-row msg--enter" aria-label="对方正在输入">
              <div className="msg-row__avatar">
                <Avatar
                  color={peerContact?.avatarColor ?? 'var(--color-brand)'}
                  text={peerContact?.avatarText ?? '?'}
                  imageRef={peerContact?.avatarRef}
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

      {menu && (
        <div
          className="msg-menu"
          role="menu"
          style={{
            left: Math.min(menu.x, window.innerWidth - 130),
            top: Math.max(menu.y - 48, 52),
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {menu.msg.type === 'text' && menu.msg.content && (
            <button role="menuitem" onClick={() => copyText(menu.msg)}>
              复制
            </button>
          )}
          {canRecall(menu.msg, Date.now()) && (
            <button role="menuitem" onClick={() => void recallOwn(menu.msg)}>
              撤回
            </button>
          )}
          {menu.msg.type === 'text' && menu.msg.content && !menu.msg.isRecalled && (
            <button
              role="menuitem"
              onClick={() => {
                const who = menu.msg.senderId === 'self' ? '我' : (contactById(menu.msg.senderId)?.remark ?? contactById(menu.msg.senderId)?.name ?? '');
                setQuote({ msgId: menu.msg.id, text: `${who}: ${(menu.msg.content ?? '').slice(0, 40)}` });
                setMenu(null);
              }}
            >
              引用
            </button>
          )}
          {/* Only on the AI's own last turn: regenerating anything else would
              rewrite history rather than correct the newest line. */}
          {menu.msg.senderId !== 'self' &&
            !isGroup &&
            !menu.msg.isRecalled &&
            messages.at(-1)?.senderId === menu.msg.senderId && (
              <>
                <button role="menuitem" onClick={() => guard('chat.regenerate', () => regenerate())}>
                  重新生成
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    const steer = window.prompt('想让她怎么改？（例：别这么客套 / 短一点）');
                    setMenu(null);
                    if (steer?.trim()) guard('chat.steer', () => regenerate(steer.trim()));
                  }}
                >
                  让她重说
                </button>
              </>
            )}
          {['text', 'image', 'sticker'].includes(menu.msg.type) && !menu.msg.isRecalled && (
            <button
              role="menuitem"
              onClick={() => {
                setForwarding(menu.msg);
                setMenu(null);
              }}
            >
              转发
            </button>
          )}
          <button
            role="menuitem"
            onClick={() => {
              const m = menu.msg;
              setMenu(null);
              void deleteMessage(convId, m.id).catch(() => showToast('删除失败'));
            }}
          >
            删除
          </button>
        </div>
      )}

      {forwarding && (
        <div className="forward-mask" onClick={() => setForwarding(null)}>
          <div className="forward-panel" onClick={(e) => e.stopPropagation()}>
            <div className="forward-panel__title">发送给</div>
            {allConversations
              .filter((c) => !c.isHidden && c.id !== convId)
              .map((c) => (
                <div
                  key={c.id}
                  className="settings__row settings__row--divided"
                  onClick={() => {
                    const m = forwarding;
                    setForwarding(null);
                    void appendMessage({
                      convId: c.id,
                      senderId: 'self',
                      type: m.type,
                      content: m.content,
                      ...(m.meta ? { meta: { ...m.meta } } : {}),
                      status: 'sent',
                      createdAt: Date.now(),
                    }).then(() => showToast(`已转发给 ${c.title}`));
                  }}
                >
                  <span className="settings__label">{c.title}</span>
                </div>
              ))}
          </div>
        </div>
      )}

      <div
        className="composer"
        style={{ paddingBottom: composer.mode === 'none' ? 'var(--safe-bottom)' : 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        {quote && (
          <div className="composer__quote">
            <span className="composer__quote-text">{quote.text}</span>
            <button className="composer__quote-x" aria-label="取消引用" onClick={() => setQuote(null)}>
              ×
            </button>
          </div>
        )}
        <div className="composer__bar">
          <button className="composer__icon" aria-label="语音" onClick={() => showToast('语音消息暂未开放')}>
            <IconVoiceCircle />
          </button>
          <div className="composer__pill">
            <textarea
              ref={composer.inputRef}
              className="composer__input"
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={composer.openKeyboard}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send().catch((err) => showToast(`发送失败：${err instanceof Error ? err.message : String(err)}`));
                }
              }}
              placeholder=""
            />
            <button className="composer__mic" aria-label="语音输入" onClick={() => showToast('语音输入暂未开放')}>
              <IconMicSmall />
            </button>
          </div>
          <button className="composer__icon" aria-label="表情" onClick={composer.toggleEmoji}>
            <IconEmoji />
          </button>
          {draft.trim() ? (
            <button className="composer__send" onClick={() => void send().catch((err) => showToast(`发送失败：${err instanceof Error ? err.message : String(err)}`))}>
              发送
            </button>
          ) : (
            <button className="composer__icon" aria-label="更多" onClick={composer.togglePlus}>
              <IconPlus />
            </button>
          )}
        </div>
        <ComposerPanels
          mode={composer.mode}
          height={composer.panelHeight}
          // WeChat has no group transfer either — greyed, not hidden.
          disabledKeys={isGroup ? ['transfer'] : []}
          onAction={(key) => {
            if (key === 'redpacket') navigate(`/rp/send/${convId}`);
            else if (key === 'transfer' && conv.type === 'single') navigate(`/transfer/${convId}`);
            else if (key === 'call' && conv.type === 'single') navigate(`/call/${convId}`);
            else if (key === 'album') albumInputRef.current?.click();
            else showToast('暂未开放');
          }}
          onEmoji={(e) => setDraft((d) => d + e)}
          onEmojiDelete={() => setDraft((d) => Array.from(d).slice(0, -1).join(''))}
        />
        <input
          ref={albumInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void sendImages(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      {viewerIndex != null && imageRefs.length > 0 && (
        <ImageViewer refs={imageRefs} index={viewerIndex} onClose={() => setViewerIndex(null)} />
      )}
    </div>
  );
}

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
