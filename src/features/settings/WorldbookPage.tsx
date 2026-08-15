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
import { showActionSheet, showConfirm, showPrompt } from '../../components/dialog';
import { Switch } from '../../components/Switch';
import { clampEntry, type WorldbookEntry } from '../../ai/worldbook';
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
    const title = await showPrompt({ title: '条目名称', placeholder: '例：她的猫', maxLength: 20 });
    if (!title?.trim()) return;
    const content = await showPrompt({
      title: '设定内容',
      placeholder: '例：她养了一只叫年糕的橘猫，很凶',
      maxLength: 200,
    });
    if (!content?.trim()) return;
    const keywords = await showPrompt({
      title: '触发词（用、隔开）',
      placeholder: '留空 = 一直生效',
      allowEmpty: true,
    });
    if (keywords == null) return;
    const ais = contacts.filter((c) => c.type === 'ai');
    const scopeIdx = await showActionSheet({
      title: '生效范围',
      actions: ['所有人（全局）', ...ais.map((c) => `只对 ${c.remark ?? c.name}`)],
    });
    if (scopeIdx == null) return;
    const entry = clampEntry({
      id: `wb_${Date.now().toString(36)}`,
      title: title.trim(),
      content: content.trim(),
      keywords: keywords.split(/[、,，\s]+/).filter(Boolean),
      scope: scopeIdx === 0 ? 'global' : 'persona',
      ...(scopeIdx > 0 ? { scopeId: ais[scopeIdx - 1].id } : {}),
      priority: 50,
      enabled: true,
      createdAt: Date.now(),
    });
    await repo.putWorldbookEntry(entry);
    showToast('已添加');
    reload();
  };

  const editEntry = async (e: WorldbookEntry) => {
    const idx = await showActionSheet({
      title: e.title,
      actions: ['改内容', '改触发词', e.enabled ? '停用' : '启用', { label: '删除', danger: true }],
    });
    if (idx == null) return;
    if (idx === 0) {
      const content = await showPrompt({ title: '设定内容', initial: e.content, maxLength: 200 });
      if (content?.trim()) await repo.putWorldbookEntry(clampEntry({ ...e, content }));
    } else if (idx === 1) {
      const kw = await showPrompt({
        title: '触发词（用、隔开，留空=一直生效）',
        initial: e.keywords.join('、'),
        allowEmpty: true,
      });
      if (kw != null) {
        await repo.putWorldbookEntry(
          clampEntry({ ...e, keywords: kw.split(/[、,，\s]+/).filter(Boolean) }),
        );
      }
    } else if (idx === 2) {
      await repo.putWorldbookEntry({ ...e, enabled: !e.enabled });
    } else if (idx === 3) {
      const ok = await showConfirm({
        title: '删除条目',
        body: `「${e.title}」将被删除。`,
        confirmText: '删除',
        danger: true,
      });
      if (ok) await repo.deleteWorldbookEntry(e.id);
    }
    reload();
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
