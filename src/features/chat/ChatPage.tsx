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
import { MessageBubble } from './MessageBubble';
import { ComposerPanels } from './ComposerPanels';
import { useComposerPanel } from './useComposerPanel';
import { useAppStore } from '../../store/appStore';
import { chatTimestamp, shouldShowTimeBar } from '../../lib/time';
import { sendUserMessage } from '../../ai/engine';
import { repo } from '../../db/repo';
import type { MessageVM, NsfwTierVM } from '../../data/types';
import './chat.css';

// Fixed clock for deterministic golden screenshots; live sends use Date.now().
const NOW = 1_754_500_000_000;

export function ChatPage() {
  const { convId = '' } = useParams();
  const navigate = useNavigate();
  const conv = useAppStore((s) => s.conversationById(convId));
  const messages = useAppStore((s) => s.messagesFor(convId));
  const contactById = useAppStore((s) => s.contactById);
  const personaFor = useAppStore((s) => s.personaFor);
  const appendMessage = useAppStore((s) => s.appendMessage);
  const updateMessage = useAppStore((s) => s.updateMessage);
  const setTyping = useAppStore((s) => s.setTyping);
  const isTyping = useAppStore((s) => Boolean(s.typing[convId]));
  const totalUnread = useAppStore((s) =>
    s.conversations.reduce((n, c) => n + (c.id === convId || c.isMuted ? 0 : c.unreadCount), 0),
  );
  const composer = useComposerPanel();
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Interleave time bars (WeChat shows a centered time when the gap > 5 min).
  const rows = useMemo(() => withTimeBars(messages), [messages]);

  // Keep the view pinned to the newest message as bubbles arrive.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows.length, isTyping, composer.bottomInset]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !conv) return;
    setDraft('');
    const peerId = conv.peerId;
    const peer = peerId ? contactById(peerId) : undefined;
    const persona = peerId ? personaFor(peerId) : undefined;
    const globalTier = (await repo.getSetting<NsfwTierVM>('nsfwGlobalTier')) ?? 'off';

    if (!peer || !persona) {
      // Group chats (and personas not yet configured) land in M3; just record the
      // user's own message rather than silently dropping it.
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

    await sendUserMessage(convId, text, peer, persona, globalTier, {
      appendMessage,
      updateMessage,
      setTyping,
      now: () => Date.now(),
    });
  };

  if (!conv) {
    return (
      <div className="chat-page">
        <div className="chat-page__missing">会话不存在</div>
      </div>
    );
  }

  const isGroup = conv.type === 'group';

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
          <button className="navbar__btn" aria-label="更多">
            <IconMore />
          </button>
        </div>
      </header>

      {isGroup && conv.announcement && (
        <div className="group-announce hairline-bottom" onClick={(e) => e.stopPropagation()}>
          <span className="group-announce__icon" aria-hidden>
            💬
          </span>
          <span className="group-announce__text">{conv.announcement}</span>
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
              />
            ),
          )}
        </div>
      </div>

      <div
        className="composer"
        style={{ paddingBottom: composer.mode === 'none' ? 'var(--safe-bottom)' : 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="composer__bar">
          <button className="composer__icon" aria-label="语音">
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
                  void send();
                }
              }}
              placeholder=""
            />
            <button className="composer__mic" aria-label="语音输入">
              <IconMicSmall />
            </button>
          </div>
          <button className="composer__icon" aria-label="表情" onClick={composer.toggleEmoji}>
            <IconEmoji />
          </button>
          {draft.trim() ? (
            <button className="composer__send" onClick={() => void send()}>
              发送
            </button>
          ) : (
            <button className="composer__icon" aria-label="更多" onClick={composer.togglePlus}>
              <IconPlus />
            </button>
          )}
        </div>
        <ComposerPanels mode={composer.mode} height={composer.panelHeight} />
      </div>
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
