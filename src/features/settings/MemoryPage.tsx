/**
 * Memory management (/memory/:contactId) — bug #2's "记忆系统零界面".
 *
 * Shows everything this agent believes, and hands the user the levers the
 * engine already had: pin (always injected), confirm pending extractions,
 * delete. Gossip-sourced facts (written by AI↔AI DMs) are labeled — knowing
 * WHERE a belief came from is what makes the chemistry legible.
 */
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { useAppStore } from '../../store/appStore';
import { repo } from '../../db/repo';
import type { MemoryFactVM } from '../../data/types';
import { groupByEntity, retention } from '../../ai/entity-graph';
import { useNow } from '../../lib/useNow';
import { useGuard } from '../../app/useGuard';
import './settings.css';

/** DM gossip writes facts with these framings (see agent-dm gossipFacts). */
const GOSSIP_RE = /^(和.+聊到：|听.+说：)/;

export function MemoryPage() {
  const guard = useGuard();
  const { contactId = '' } = useParams();
  const contact = useAppStore((s) => s.contactById(contactId));
  const showToast = useAppStore((s) => s.showToast);
  const [facts, setFacts] = useState<MemoryFactVM[]>([]);

  const reload = async () => {
    const all = await repo.getMemory(contactId);
    // Pinned first, then newest.
    all.sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || b.createdAt - a.createdAt);
    setFacts(all);
  };
  useEffect(() => {
    guard('memory.load', reload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId]);

  const update = async (f: MemoryFactVM, patch: Partial<MemoryFactVM>) => {
    await repo.putMemory({ ...f, ...patch });
    await reload();
  };
  const remove = async (f: MemoryFactVM) => {
    await repo.deleteMemory(f.id);
    showToast('已删除');
    await reload();
  };

  const now = useNow();
  const pending = facts.filter((f) => f.status === 'pending');
  const confirmed = facts.filter((f) => f.status !== 'pending' && f.status !== 'archived');
  // Archived facts are not deleted — a superseded one is how you find out she
  // learned something new, and a wrongly-superseded one has to be recoverable.
  const archived = facts.filter((f) => f.status === 'archived');
  // Grouped by who/what each fact is about, so a memory page with 60 rows is
  // browsable instead of being one undifferentiated list (M-E2).
  const groups = groupByEntity(confirmed);

  const renderFact = (f: MemoryFactVM) => (
    <div key={f.id} className="memory__item">
      <div className="memory__fact">
        {f.isPinned && <span className="memory__pin-mark">📌 </span>}
        {f.fact}
      </div>
      <div className="memory__meta">
        {(f.source === 'hearsay' || GOSSIP_RE.test(f.fact)) && (
          <span className="memory__tag memory__tag--gossip">八卦</span>
        )}
        {f.source === 'chat' && <span className="memory__tag">聊出来的</span>}
        {f.sensitivity !== 'normal' && <span className="memory__tag">{f.sensitivity === 'nsfw' ? '私密' : '敏感'}</span>}
        <span className="memory__date">
          {new Date(f.createdAt).toLocaleDateString('zh-CN')} · 重要度 {f.importance}
          {f.confidence != null && f.confidence < 0.7 ? ' · 听说的，不一定准' : ''}
          {(f.refCount ?? 0) > 0 ? ` · 提过 ${f.refCount} 次` : ''}
          {/* How firmly it is still held, so "她怎么忘了" has a visible answer. */}
          {!f.isPinned && f.status !== 'archived'
            ? ` · 记得 ${Math.round(retention(f, now) * 100)}%`
            : ''}
          {f.supersededBy ? ' · 已被更新的说法取代' : ''}
        </span>
      </div>
      <div className="memory__actions">
        {f.status === 'pending' ? (
          <button className="memory__btn" onClick={() => guard('memory.confirm', () => update(f, { status: 'confirmed' }))}>
            确认
          </button>
        ) : (
          <button className="memory__btn" onClick={() => guard('memory.pin', () => update(f, { isPinned: !f.isPinned }))}>
            {f.isPinned ? '取消置顶' : '置顶'}
          </button>
        )}
        <button className="memory__btn memory__btn--danger" onClick={() => guard('memory.remove', () => remove(f))}>
          删除
        </button>
      </div>
    </div>
  );

  return (
    <>
      <SubNav title={`记忆：${contact?.remark ?? contact?.name ?? contactId}`} />
      <div className="page-body settings">
        {pending.length > 0 && (
          <div className="settings__group">
            <div className="settings__group-title">待确认（引擎自动提取，确认后长期生效）</div>
            {pending.map(renderFact)}
          </div>
        )}
        {groups.map((g) => (
          <div className="settings__group" key={g.entity}>
            <div className="settings__group-title">
              {g.entity === '其他' ? `其他（${g.facts.length}）` : `关于 ${g.entity}（${g.facts.length}）`}
            </div>
            {g.facts.map(renderFact)}
          </div>
        ))}
        {confirmed.length === 0 && pending.length === 0 && (
          <div className="settings__group">
            <div className="settings__group-title">还没有记忆</div>
            <p className="settings__hint">聊得越多，Ta 记住的越多。置顶的记忆每次都会带上。</p>
          </div>
        )}
        {archived.length > 0 && (
          <div className="settings__group">
            <div className="settings__group-title">已淡忘 / 被取代（{archived.length}）</div>
            <p className="settings__hint">
              这些不再进入对话，但没有删除——她记错了或忘早了，可以在这里删掉重新聊起。
            </p>
            {archived.map(renderFact)}
          </div>
        )}
      </div>
    </>
  );
}
