import { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { IconBack, IconMore, IconVoice, IconEmoji, IconPlus } from '../../components/icons';
import { MessageBubble } from './MessageBubble';
import { ComposerPanels } from './ComposerPanels';
import { useComposerPanel } from './useComposerPanel';
import { useAppStore } from '../../store/appStore';
import { chatTimestamp, shouldShowTimeBar } from '../../lib/time';
import type { MessageVM } from '../../data/types';
import './chat.css';

const NOW = 1_754_500_000_000;

export function ChatPage() {
  const { convId = '' } = useParams();
  const navigate = useNavigate();
  const conv = useAppStore((s) => s.conversationById(convId));
  const messages = useAppStore((s) => s.messagesFor(convId));
  const contactById = useAppStore((s) => s.contactById);
  const composer = useComposerPanel();
  const [draft, setDraft] = useState('');

  // Interleave time bars (WeChat shows a centered time when the gap > 5 min).
  const rows = useMemo(() => withTimeBars(messages), [messages]);

  if (!conv) {
    return (
      <div className="chat-page">
        <div className="chat-page__missing">会话不存在</div>
      </div>
    );
  }

  return (
    <div className="chat-page" onClick={() => composer.mode !== 'none' && composer.closeAll()}>
      <header className="navbar chat-nav">
        <button className="navbar__left navbar__btn" aria-label="返回" onClick={() => navigate(-1)}>
          <IconBack />
        </button>
        <div className="navbar__title chat-nav__title">{conv.title}</div>
        <button className="navbar__right navbar__btn" aria-label="更多">
          <IconMore />
        </button>
      </header>

      <div
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
            <IconVoice />
          </button>
          <textarea
            ref={composer.inputRef}
            className="composer__input"
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={composer.openKeyboard}
            placeholder=""
          />
          <button className="composer__icon" aria-label="表情" onClick={composer.toggleEmoji}>
            <IconEmoji />
          </button>
          {draft.trim() ? (
            <button className="composer__send" onClick={() => setDraft('')}>
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
