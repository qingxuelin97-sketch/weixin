/**
 * 世界书编辑器 (M-I4).
 *
 * Deliberately dialog-driven (I0's imperative prompts) rather than a form
 * page: an entry is four short fields, and the list IS the page. Scope is
 * chosen at creation via action sheet; per-persona entries also surface here
 * (they are the same rows the persona export carries).
 */
import { useEffect, useState } from 'react';
import { SubNav } from '../../components/SubNav';
import { useAppStore } from '../../store/appStore';
import { repo } from '../../db/repo';
import { showActionSheet } from '../../components/dialog';
import { Switch } from '../../components/Switch';
import { type WorldbookEntry } from '../../ai/worldbook';
import { askEntryFields, editWorldbookEntry, newEntry } from './worldbook-edit';
import { useGuard } from '../../app/useGuard';
import './settings.css';

const SCOPE_LABEL = { global: '全局', persona: '角色', conv: '会话' } as const;

export function WorldbookPage() {
  const guard = useGuard();
  const contacts = useAppStore((s) => s.contacts);
  const showToast = useAppStore((s) => s.showToast);
  const [entries, setEntries] = useState<WorldbookEntry[]>([]);

  const reload = () => void repo.getWorldbook().then(setEntries);
  useEffect(reload, []);

  const nameOf = (id?: string) =>
    id ? (contacts.find((c) => c.id === id)?.remark ?? contacts.find((c) => c.id === id)?.name ?? id) : '';

  const addEntry = async () => {
    const fields = await askEntryFields();
    if (!fields) return;
    const ais = contacts.filter((c) => c.type === 'ai');
    const scopeIdx = await showActionSheet({
      title: '生效范围',
      actions: ['所有人（全局）', ...ais.map((c) => `只对 ${c.remark ?? c.name}`)],
    });
    if (scopeIdx == null) return;
    await repo.putWorldbookEntry(
      newEntry(
        fields,
        scopeIdx === 0 ? 'global' : 'persona',
        scopeIdx > 0 ? ais[scopeIdx - 1].id : undefined,
        Date.now(),
      ),
    );
    showToast('已添加');
    reload();
  };

  const editEntry = async (e: WorldbookEntry) => {
    if (await editWorldbookEntry(e)) reload();
  };

  return (
    <>
      <SubNav title="世界书" />
      <div className="page-body settings">
        <div className="settings__group">
          <div className="field">
            <span className="field__hint">
              你写下的关于这个世界的事实——地点、宠物、圈内黑话、共同经历。聊到相关话题时
              她们会「记得」。触发词命中才注入；留空触发词的条目一直生效。
            </span>
          </div>
        </div>

        <div className="settings__group">
          {entries.length === 0 && (
            <div className="field">
              <span className="field__hint">还没有条目</span>
            </div>
          )}
          {entries.map((e, i) => (
            <div
              key={e.id}
              className={`settings__row${i < entries.length - 1 ? ' settings__row--divided' : ''}`}
              onClick={() => void editEntry(e)}
            >
              <span className="settings__label">
                {e.title}
                {e.scope !== 'global' && (
                  <span className="settings__value">
                    {' '}
                    · {SCOPE_LABEL[e.scope]} {nameOf(e.scopeId)}
                  </span>
                )}
              </span>
              <Switch
                on={e.enabled}
                onChange={() => {
                  void repo.putWorldbookEntry({ ...e, enabled: !e.enabled }).then(reload);
                }}
              />
            </div>
          ))}
        </div>

        <button className="btn-primary" onClick={() => guard('worldbook.add', addEntry)}>
          添加条目
        </button>
      </div>
    </>
  );
}
