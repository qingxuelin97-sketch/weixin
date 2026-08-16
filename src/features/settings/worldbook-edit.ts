/**
 * The worldbook entry dialogs, in one place (M-I18).
 *
 * They are used from two screens now — the global list (设置 → 世界书) and the
 * per-character section on the persona editor — and an entry is four fields
 * with four clamping rules. Two copies of that would drift within a milestone:
 * one would learn about a new field, the other would keep writing rows without
 * it, and `clampEntry` would silently paper over the difference.
 *
 * Dialog-driven on purpose (I0's imperative prompts): the list IS the page.
 */
import { showActionSheet, showConfirm, showPrompt } from '../../components/dialog';
import { repo } from '../../db/repo';
import { clampEntry, type WorldbookEntry } from '../../ai/worldbook';

export interface EntryFields {
  title: string;
  content: string;
  keywords: string[];
}

/** 、／,／，／空白 all separate triggers — nobody remembers which one it wants. */
export function splitKeywords(raw: string): string[] {
  return raw.split(/[、,，\s]+/).filter(Boolean);
}

/**
 * Ask for the three authored fields. Null = the user backed out at any step,
 * and backing out must not leave half an entry behind.
 */
export async function askEntryFields(): Promise<EntryFields | null> {
  const title = await showPrompt({ title: '条目名称', placeholder: '例：她的猫', maxLength: 20 });
  if (!title?.trim()) return null;
  const content = await showPrompt({
    title: '设定内容',
    placeholder: '例：她养了一只叫年糕的橘猫，很凶',
    maxLength: 200,
  });
  if (!content?.trim()) return null;
  const keywords = await showPrompt({
    title: '触发词（用、隔开）',
    placeholder: '留空 = 一直生效',
    allowEmpty: true,
  });
  if (keywords == null) return null;
  return { title: title.trim(), content: content.trim(), keywords: splitKeywords(keywords) };
}

/** A fresh, clamped row in the given scope. */
export function newEntry(
  fields: EntryFields,
  scope: WorldbookEntry['scope'],
  scopeId: string | undefined,
  now: number,
): WorldbookEntry {
  return clampEntry({
    id: `wb_${now.toString(36)}`,
    title: fields.title,
    content: fields.content,
    keywords: fields.keywords,
    scope,
    ...(scopeId ? { scopeId } : {}),
    priority: 50,
    enabled: true,
    createdAt: now,
  });
}

/**
 * The edit action sheet. Returns whether anything was written, so the caller
 * knows whether its list needs reloading.
 */
export async function editWorldbookEntry(e: WorldbookEntry): Promise<boolean> {
  const idx = await showActionSheet({
    title: e.title,
    actions: ['改内容', '改触发词', e.enabled ? '停用' : '启用', { label: '删除', danger: true }],
  });
  if (idx == null) return false;
  if (idx === 0) {
    const content = await showPrompt({ title: '设定内容', initial: e.content, maxLength: 200 });
    if (!content?.trim()) return false;
    await repo.putWorldbookEntry(clampEntry({ ...e, content }));
    return true;
  }
  if (idx === 1) {
    const kw = await showPrompt({
      title: '触发词（用、隔开，留空=一直生效）',
      initial: e.keywords.join('、'),
      allowEmpty: true,
    });
    if (kw == null) return false;
    await repo.putWorldbookEntry(clampEntry({ ...e, keywords: splitKeywords(kw) }));
    return true;
  }
  if (idx === 2) {
    await repo.putWorldbookEntry({ ...e, enabled: !e.enabled });
    return true;
  }
  const ok = await showConfirm({
    title: '删除条目',
    body: `「${e.title}」将被删除。`,
    confirmText: '删除',
    danger: true,
  });
  if (ok) await repo.deleteWorldbookEntry(e.id);
  return Boolean(ok);
}
