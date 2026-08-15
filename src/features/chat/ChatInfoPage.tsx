/**
 * 聊天信息（M-D3）。The chat page's "…" finally goes somewhere: single chats get
 * the member header + find/pin/mute/delete rows; groups add the member grid,
 * editable group name and announcement. Every control is real — toggles write
 * through patchConversation, delete really deletes.
 */
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { Avatar } from '../../components/Avatar';
import { useAppStore } from '../../store/appStore';
import { showConfirm, showPrompt, showActionSheet } from '../../components/dialog';
import { getGroupCfg, putGroupCfg, type GroupCfg } from '../../ai/group-config';
import { repo } from '../../db/repo';
import { humanizePersona } from '../../ai/humanize';
import { applyPersonaPatch } from '../../data/persona-patch';
import { HumanizeDiffSheet } from '../settings/HumanizeDiffSheet';
import { getRouter } from '../../llm/service';
import { globalTier } from '../../lib/nsfw-tier';
import { storyRunning } from '../../ai/story-service';
import { runOf, type StorySaveRow } from '../../ai/story-gm';
import { logError } from '../../lib/errlog';
import type { PersonaVM } from '../../data/types';
import { useGuard } from '../../app/useGuard';
import '../settings/settings.css';
import './chat.css';
import { Switch } from '../../components/Switch';

const ACTIVITY_LABELS = ['冷清', '偏静', '正常', '热闹'] as const;
const SPICE_LABELS = ['和气', '正常', '敢拌嘴', '火药味'] as const;

export function ChatInfoPage() {
  const guard = useGuard();
  const { convId = '' } = useParams();
  const navigate = useNavigate();
  const conv = useAppStore((s) => s.conversationById(convId));
  const contactById = useAppStore((s) => s.contactById);
  const contacts = useAppStore((s) => s.contacts);
  const personaFor = useAppStore((s) => s.personaFor);
  const putPersona = useAppStore((s) => s.putPersona);
  const patchConversation = useAppStore((s) => s.patchConversation);
  const deleteConversation = useAppStore((s) => s.deleteConversation);
  const showToast = useAppStore((s) => s.showToast);
  const [, bump] = useState(0);
  /** Tapping a member removes them instead of opening their card. */
  const [removeMode, setRemoveMode] = useState(false);
  /** 整群拟人化 (M-I2): generated patches awaiting per-member review. */
  const [batch, setBatch] = useState<{
    items: Array<{ id: string; name: string; patch: Partial<PersonaVM> }>;
    idx: number;
  } | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  /** Per-group knobs (M-I1); null until loaded, absent row = defaults. */
  const [cfg, setCfg] = useState<GroupCfg | null>(null);
  /** A story playing in THIS group (M-I7): surfaces the run-page entry row. */
  const [storyRun, setStoryRun] = useState<StorySaveRow | undefined>(undefined);
  const isGroupConv = conv?.type === 'group';
  useEffect(() => {
    if (!isGroupConv) return;
    let alive = true;
    void getGroupCfg(convId).then((c) => alive && setCfg(c));
    void storyRunning(convId)
      .then((s) => alive && setStoryRun(s))
      .catch((e) => logError('chatinfo.story', e));
    return () => {
      alive = false;
    };
  }, [convId, isGroupConv]);
  // 群昵称 (M-I6): per-room display aliases, settings KV `groupNick:<convId>`.
  // The chat page reads the same row to label bubbles — an alias here is an
  // alias everywhere in this room, and nowhere outside it.
  const [nicks, setNicks] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!isGroupConv) return;
    void repo.getSetting<Record<string, string>>(`groupNick:${convId}`).then((n) => setNicks(n ?? {}));
  }, [convId, isGroupConv]);

  if (!conv) {
    return (
      <>
        <SubNav title="聊天信息" />
        <div className="page-body settings">
          <div className="field">
            <span className="field__hint">会话不存在</span>
          </div>
        </div>
      </>
    );
  }

  const isGroup = conv.type === 'group';
  const memberIds = isGroup ? (conv.memberIds ?? []) : conv.peerId ? [conv.peerId] : [];
  const members = memberIds
    .map((id) => contactById(id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c));

  const toggle = async (key: 'isPinned' | 'isMuted') => {
    await patchConversation(conv.id, { [key]: !conv[key] });
    bump((n) => n + 1);
  };

  const editGroupName = async () => {
    const next = await showPrompt({ title: '群聊名称', initial: conv.title, maxLength: 16 });
    if (next?.trim()) {
      await patchConversation(conv.id, { title: next.trim().slice(0, 16) });
      bump((n) => n + 1);
    }
  };

  const editAnnouncement = async () => {
    const next = await showPrompt({
      title: '群公告',
      initial: conv.announcement ?? '',
      // Clearing the announcement is a legitimate edit, not a cancel.
      allowEmpty: true,
    });
    if (next != null) {
      await patchConversation(conv.id, { announcement: next.trim() || undefined });
      bump((n) => n + 1);
    }
  };

  /** 加人: pick from AI contacts not already in the room. Fixes the old "＋"
      that jumped to CREATE-a-group from inside an existing group. */
  const addMember = async () => {
    const candidates = contacts.filter(
      (c) => c.type === 'ai' && !memberIds.includes(c.id),
    );
    if (candidates.length === 0) {
      showToast('没有可以拉进来的联系人了');
      return;
    }
    const idx = await showActionSheet({
      title: '添加成员',
      actions: candidates.map((c) => c.remark ?? c.name),
    });
    if (idx == null) return;
    const chosen = candidates[idx];
    await patchConversation(conv.id, { memberIds: [...memberIds, chosen.id] });
    showToast(`已添加 ${chosen.remark ?? chosen.name}`);
    bump((n) => n + 1);
  };

  /** 移出群聊 — the member leaves THIS room; the contact itself survives. */
  const removeMember = async (id: string, name: string) => {
    const ok = await showConfirm({
      title: '移出群聊',
      body: `将「${name}」移出本群？TA 的联系人和聊天记录都还在。`,
      confirmText: '移出',
      danger: true,
    });
    if (!ok) return;
    await patchConversation(conv.id, { memberIds: memberIds.filter((m) => m !== id) });
    showToast('已移出');
    bump((n) => n + 1);
  };

  /**
   * 整群拟人化 (M-I2): sequential per member, each generation seeing the
   * catchphrases already taken by the others — the distinctiveness constraint
   * that stops a generated group from sounding like one person in five hats.
   * Every member then gets their own diff sheet; skipping one costs nothing.
   */
  const humanizeGroup = async () => {
    if (batchBusy) return;
    const ais = members.filter((m) => personaFor(m.id));
    if (ais.length === 0) {
      showToast('群里没有可拟人化的成员');
      return;
    }
    const ok = await showConfirm({
      title: '整群拟人化',
      body: `逐个改写 ${ais.length} 名成员的人设（约 ${ais.length} 次模型调用）。每人一张对照单，逐字段可选，不满意可跳过。`,
      confirmText: '开始',
    });
    if (!ok) return;
    setBatchBusy(true);
    try {
      const router = await getRouter();
      // Rule #6: derived tier, never declared at the call site.
      const tier = await globalTier();
      const generated: string[] = [];
      const items: Array<{ id: string; name: string; patch: Partial<PersonaVM> }> = [];
      for (const m of ais) {
        const persona = personaFor(m.id)!;
        const name = m.remark ?? m.name;
        showToast(`正在改写「${name}」（${items.length + 1}/${ais.length}）`);
        // Siblings = everyone ELSE's existing voice + everything generated so
        // far this run. The member's own current catchphrases are fair to keep.
        const siblings = [
          ...ais.filter((x) => x.id !== m.id).flatMap((x) => personaFor(x.id)?.catchphrases ?? []),
          ...generated,
        ];
        try {
          const out = await humanizePersona(
            persona,
            name,
            'medium',
            {
              complete: async (messages, opts) =>
                (
                  await router.complete(
                    { role: 'reasoning', nsfwTier: tier },
                    { messages, json: opts.json, maxTokens: opts.maxTokens, temperature: 0.9 },
                    {},
                    `humanize:${m.id}`,
                  )
                ).text,
            },
            { siblingCatchphrases: siblings },
          );
          if (out.ok && out.value) {
            items.push({ id: m.id, name, patch: out.value });
            generated.push(...(out.value.catchphrases ?? []));
          }
        } catch (err) {
          logError('group.humanize', err); // one failed member must not sink the batch
        }
      }
      if (items.length === 0) {
        showToast('一个都没改成——检查 API 配置后重试');
        return;
      }
      setBatch({ items, idx: 0 });
    } finally {
      setBatchBusy(false);
    }
  };
  const advanceBatch = () =>
    setBatch((b) => (b && b.idx + 1 < b.items.length ? { ...b, idx: b.idx + 1 } : null));

  const saveCfg = async (next: GroupCfg) => {
    setCfg(next);
    await putGroupCfg(convId, next);
  };

  const editNicks = async () => {
    const ms = members;
    if (ms.length === 0) return;
    const idx = await showActionSheet({
      title: '改谁的群昵称',
      actions: ms.map((m) => {
        const nick = nicks[m.id];
        return nick ? `${m.remark ?? m.name}（现：${nick}）` : (m.remark ?? m.name);
      }),
    });
    if (idx == null) return;
    const m = ms[idx];
    const next = await showPrompt({
      title: `${m.remark ?? m.name} 的群昵称`,
      initial: nicks[m.id] ?? '',
      placeholder: '留空恢复本名',
      maxLength: 12,
      allowEmpty: true,
    });
    if (next == null) return;
    const map = { ...nicks };
    if (next.trim()) map[m.id] = next.trim();
    else delete map[m.id];
    setNicks(map);
    await repo.putSetting(`groupNick:${convId}`, map);
  };

  const editTopics = async () => {
    if (!cfg) return;
    const next = await showPrompt({
      title: '这个群平时聊什么',
      initial: cfg.topics.join('、'),
      placeholder: '用、隔开，最多 5 个',
      allowEmpty: true,
    });
    if (next == null) return;
    await saveCfg({ ...cfg, topics: next.split(/[、,，\s]+/).filter(Boolean).slice(0, 5) });
  };

  const removeChat = async () => {
    // The old row destroyed the whole thread on a single tap — the only
    // destructive action in the app with no confirmation at all.
    const ok = await showConfirm({
      title: isGroup ? '退出群聊' : '删除该聊天',
      body: isGroup ? '退出后本群的聊天记录将被删除，且无法恢复。' : '聊天记录将被删除，且无法恢复。',
      confirmText: isGroup ? '退出' : '删除',
      danger: true,
    });
    if (!ok) return;
    await deleteConversation(conv.id);
    showToast('已删除');
    navigate('/', { replace: true });
  };

  return (
    <>
      <SubNav title="聊天信息" />
      <div className="page-body settings">
        <div className="settings__group">
          <div className="chatinfo-members">
            {members.map((m) => (
              <div
                key={m.id}
                className="chatinfo-member"
                onClick={() =>
                  removeMode
                    ? void removeMember(m.id, m.remark ?? m.name)
                    : navigate(`/contact/${m.id}`)
                }
                role="button"
              >
                <Avatar color={m.avatarColor} text={m.avatarText} imageRef={m.avatarRef} size={52} />
                <span className="chatinfo-member__name">
                  {removeMode ? `－${m.remark ?? m.name}` : (m.remark ?? m.name)}
                </span>
              </div>
            ))}
            <div className="chatinfo-member" onClick={() => guard('chatinfo.add', addMember)} role="button">
              <div className="chatinfo-member__add">＋</div>
              <span className="chatinfo-member__name">&nbsp;</span>
            </div>
            {isGroup && members.length > 1 && (
              <div
                className="chatinfo-member"
                onClick={() => setRemoveMode((v) => !v)}
                role="button"
              >
                <div className="chatinfo-member__add">{removeMode ? '完成' : '－'}</div>
                <span className="chatinfo-member__name">&nbsp;</span>
              </div>
            )}
          </div>
        </div>

        {isGroup && (
          <div className="settings__group">
            <div className="settings__row settings__row--divided" onClick={() => guard('chatinfo.rename', editGroupName)}>
              <span className="settings__label">群聊名称</span>
              <span className="settings__value">{conv.title}</span>
              <span className="settings__chevron">›</span>
            </div>
            <div className="settings__row" onClick={() => guard('chatinfo.announce', editAnnouncement)}>
              <span className="settings__label">群公告</span>
              <span className="settings__value">{conv.announcement ? conv.announcement.slice(0, 10) : '未设置'}</span>
              <span className="settings__chevron">›</span>
            </div>
          </div>
        )}

        {isGroup && cfg && (
          <div className="settings__group">
            <div className="settings__group-title">群聊风格</div>
            <div className="field field--divided">
              <span className="field__label">活跃度</span>
              <div className="segmented" style={{ margin: 0 }}>
                {ACTIVITY_LABELS.map((label, i) => (
                  <button
                    key={label}
                    className={`segmented__item${cfg.activity === i ? ' segmented__item--active' : ''}`}
                    onClick={() => void saveCfg({ ...cfg, activity: i as GroupCfg['activity'] })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="field field--divided">
              <span className="field__label">火药味</span>
              <div className="segmented" style={{ margin: 0 }}>
                {SPICE_LABELS.map((label, i) => (
                  <button
                    key={label}
                    className={`segmented__item${cfg.spice === i ? ' segmented__item--active' : ''}`}
                    onClick={() => void saveCfg({ ...cfg, spice: i as GroupCfg['spice'] })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings__row settings__row--divided" onClick={() => void editNicks()}>
              <span className="settings__label">成员群昵称</span>
              <span className="settings__value">
                {Object.keys(nicks).length ? `${Object.keys(nicks).length} 人已设` : '未设置'}
              </span>
              <span className="settings__chevron">›</span>
            </div>
            <div className="settings__row" onClick={() => void editTopics()}>
              <span className="settings__label">常聊话题</span>
              <span className="settings__value">
                {cfg.topics.length ? cfg.topics.join('、').slice(0, 12) : '未设置'}
              </span>
              <span className="settings__chevron">›</span>
            </div>
          </div>
        )}

        {isGroup && storyRun && (
          <div className="settings__group">
            <div
              className="settings__row"
              onClick={() => navigate(`/story/run/${storyRun.id}`)}
            >
              <span className="settings__label">剧情</span>
              <span className="settings__value">
                第 {runOf(storyRun)} 周目 · 第 {storyRun.seq} 幕
                {storyRun.stalledAt ? ' · 已暂停' : ''}
              </span>
              <span className="settings__chevron">›</span>
            </div>
          </div>
        )}

        {isGroup && (
          <div className="settings__group">
            <div
              className="settings__row settings__row--divided"
              onClick={() => navigate(`/group-generate?rebuild=${encodeURIComponent(conv.id)}`)}
            >
              <span className="settings__label">一键重新配置本群</span>
              <span className="settings__chevron">›</span>
            </div>
            <div className="settings__row" onClick={() => guard('chatinfo.humanize', humanizeGroup)}>
              <span className="settings__label">{batchBusy ? '正在逐个改写…' : '整群拟人化'}</span>
              <span className="settings__value">每人单独确认</span>
              <span className="settings__chevron">›</span>
            </div>
          </div>
        )}

        <div className="settings__group">
          <div
            className="settings__row settings__row--divided"
            onClick={() => navigate('/search')}
          >
            <span className="settings__label">查找聊天记录</span>
            <span className="settings__chevron">›</span>
          </div>
          <div className="settings__row settings__row--divided" onClick={() => guard('chatinfo.pin', () => toggle('isPinned'))}>
            <span className="settings__label">置顶聊天</span>
            <Switch on={conv.isPinned} onChange={() => guard('chatinfo.pin', () => toggle('isPinned'))} />
          </div>
          <div className="settings__row" onClick={() => guard('chatinfo.mute', () => toggle('isMuted'))}>
            <span className="settings__label">消息免打扰</span>
            <Switch on={conv.isMuted} onChange={() => guard('chatinfo.mute', () => toggle('isMuted'))} />
          </div>
        </div>

        <button className="btn-ghost" onClick={() => guard('chatinfo.delete', removeChat)}>
          {isGroup ? '退出群聊' : '删除该聊天'}
        </button>
      </div>

      {batch && (() => {
        const cur = batch.items[batch.idx];
        const orig = personaFor(cur.id);
        if (!orig) return null;
        return (
          <HumanizeDiffSheet
            key={cur.id}
            open
            original={orig}
            patch={cur.patch}
            onClose={advanceBatch}
            onApply={(accepted) => {
              const { persona } = applyPersonaPatch(orig, accepted);
              void putPersona(persona).then(() => {
                showToast(`已更新「${cur.name}」（${batch.idx + 1}/${batch.items.length}）`);
              });
              advanceBatch();
            }}
          />
        );
      })()}
    </>
  );
}
