/**
 * 聊天记录 viewer (M-I6): the full contents of a 合并转发 card.
 *
 * Reads the card's own meta — the copied lines were SNAPSHOTTED at forward
 * time, exactly like WeChat: later edits or recalls in the source thread do
 * not reach a record that already left it.
 */
import { useParams } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { useAppStore } from '../../store/appStore';
import { chatTimestamp } from '../../lib/time';
import { useNow } from '../../lib/useNow';
import '../settings/settings.css';
import './chat.css';

export function MergedViewPage() {
  const NOW = useNow();
  const { convId = '', msgId = '' } = useParams();
  const msg = useAppStore((s) =>
    s.messagesFor(convId).find((m) => m.id === Number(msgId) && m.type === 'merged'),
  );
  const items = Array.isArray(msg?.meta?.items)
    ? (msg!.meta!.items as Array<{ name?: string; body?: string; at?: number }>)
    : [];
  const title = (msg?.meta?.title as string) || '聊天记录';

  return (
    <>
      <SubNav title={title} />
      <div className="page-body merged-view">
        {!msg && <div className="merged-view__empty">这条聊天记录不存在了</div>}
        {items.map((it, i) => (
          <div key={i} className="merged-view__item hairline-bottom">
            <div className="merged-view__head">
              <span className="merged-view__name">{it.name}</span>
              {typeof it.at === 'number' && (
                <span className="merged-view__time">{chatTimestamp(it.at, NOW)}</span>
              )}
            </div>
            <div className="merged-view__body">{it.body}</div>
          </div>
        ))}
      </div>
    </>
  );
}
