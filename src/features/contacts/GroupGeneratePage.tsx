/**
 * "帮我建一个 12 人的大学同学群" (M-H2).
 *
 * The most expensive screen in the app: one blueprint call plus one call per
 * member. Three things follow from that and are visible in the UI rather than
 * hidden behind a spinner —
 *
 *   - the count is stated before anything is spent ("约 13 次模型调用");
 *   - the blueprint is previewed and can be regenerated before any card is
 *     written, because the roster is the cheap thing to get right;
 *   - the build reports which member it is on and can be stopped, and what it
 *     already made is kept (`buildGroup` resumes from the same state).
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { useAppStore } from '../../store/appStore';
import { getRouter } from '../../llm/service';
import { globalTier } from '../../lib/nsfw-tier';
import { logError } from '../../lib/errlog';
import { extractJson } from '../../ai/generate-chain';
import { generateBlueprint, MIN_MEMBERS, MAX_MEMBERS, type GroupBlueprint } from '../../ai/group-generate';
import {
  buildGroup,
  newBuildState,
  rebuildState,
  isBuildComplete,
  buildStateKey,
  ACTIVE_BUILD_KEY,
  LEGACY_BUILD_STATE_KEY,
  type BuildState,
} from '../../ai/group-build';
import { putGroupCfg } from '../../ai/group-config';
import { GROUP_TEMPLATES, type GroupTemplate } from '../../ai/group-templates';
import { repo } from '../../db/repo';
import { generatePersona } from '../../ai/persona-generate';
import { listRegisteredMedia } from '../../data/media-registry';
import '../settings/settings.css';
import './contacts.css';

const TONE_LABEL: Record<string, string> = { warm: '亲近', cool: '不对付', neutral: '一般' };

export function GroupGeneratePage() {
  const navigate = useNavigate();
  const contacts = useAppStore((s) => s.contacts);
  const putContact = useAppStore((s) => s.putContact);
  const putPersona = useAppStore((s) => s.putPersona);
  const personaFor = useAppStore((s) => s.personaFor);
  const addConversation = useAppStore((s) => s.addConversation);
  const patchConversation = useAppStore((s) => s.patchConversation);
  const appendMessage = useAppStore((s) => s.appendMessage);
  const showToast = useAppStore((s) => s.showToast);

  // 一键重新配置 (M-I1): ?rebuild=<convId> binds the whole flow to an EXISTING
  // group — same blueprint chain, but matched members are reused, the roster
  // is unioned, and the seeded history is floored at the room's newest message.
  const [params] = useSearchParams();
  const rebuildConvId = params.get('rebuild') ?? '';
  const rebuildConv = useAppStore((s) =>
    rebuildConvId ? s.conversationById(rebuildConvId) : undefined,
  );

  const [brief, setBrief] = useState('');
  const [size, setSize] = useState(8);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [bp, setBp] = useState<GroupBlueprint | null>(null);
  const stateRef = useRef<BuildState | null>(null);
  const cancelRef = useRef(false);
  /** Template picked before generating — its knobs land on the built group. */
  const tplRef = useRef<GroupTemplate | null>(null);

  // Rebuild mode opens sized to the room it is reconfiguring.
  useEffect(() => {
    if (rebuildConv?.memberIds?.length) {
      setSize(Math.min(Math.max(rebuildConv.memberIds.length, MIN_MEMBERS), MAX_MEMBERS));
    }
  }, [rebuildConv]);

  // An unfinished build from a previous visit. The contacts it already made
  // are in the database; without this the user would generate — and pay for —
  // a second copy of every one of them. States are keyed per conversation
  // (M-I1); the active pointer names the one this page should offer to resume.
  // Pre-I1 installs may still hold the old singleton row — migrate it once.
  useEffect(() => {
    void (async () => {
      let saved = await repo.getSetting<string>(ACTIVE_BUILD_KEY).then((convId) =>
        convId ? repo.getSetting<BuildState>(buildStateKey(convId)) : undefined,
      );
      if (!saved) {
        const legacy = await repo.getSetting<BuildState>(LEGACY_BUILD_STATE_KEY);
        if (legacy?.blueprint?.members?.length) {
          await repo.putSetting(buildStateKey(legacy.convId), legacy);
          await repo.putSetting(ACTIVE_BUILD_KEY, legacy.convId);
          await repo.putSetting(LEGACY_BUILD_STATE_KEY, undefined);
          saved = legacy;
        }
      }
      if (!saved?.blueprint?.members?.length || isBuildComplete(saved)) return;
      // A parked NEW-group build must not hijack a rebuild flow (and vice
      // versa) — resume only the state that targets this page's conversation.
      if (rebuildConvId && saved.convId !== rebuildConvId) return;
      stateRef.current = saved;
      setBp(saved.blueprint);
      setSize(saved.blueprint.members.length);
    })().catch(() => {});
  }, [rebuildConvId]);

  const complete = async (
    key: string,
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    opts: { json?: boolean; maxTokens?: number },
  ) => {
    const router = await getRouter();
    // Rule #6: the tier comes from the global setting, never declared here.
    const tier = await globalTier();
    return (
      await router.complete(
        { role: 'reasoning', nsfwTier: tier },
        { messages, json: opts.json, maxTokens: opts.maxTokens, temperature: 0.9 },
        {},
        key,
      )
    ).text;
  };

  const planIt = async () => {
    if (!brief.trim() || busy) return;
    setBusy(true);
    setError('');
    setBp(null);
    try {
      const out = await generateBlueprint(brief.trim(), size, {
        complete: (m, o) => complete('group-bp', m, o),
        onProgress: setProgress,
      });
      if (!out.ok || !out.value) {
        setError(out.error ?? '生成失败');
        return;
      }
      setBp(out.value);
      let fresh: BuildState;
      if (rebuildConvId && rebuildConv) {
        // Bind blueprint members to the room's current roster by name: a
        // matched member reuses their paid-for card; only new people cost.
        const existingByName: Record<string, string> = {};
        for (const id of rebuildConv.memberIds ?? []) {
          const c = useAppStore.getState().contactById(id);
          if (c) existingByName[c.remark ?? c.name] = id;
        }
        fresh = rebuildState(out.value, rebuildConvId, existingByName, Date.now());
      } else {
        fresh = newBuildState(out.value, Date.now());
      }
      stateRef.current = fresh;
      await repo.putSetting(ACTIVE_BUILD_KEY, fresh.convId).catch(() => {});
    } catch (e) {
      logError('group.blueprint', e);
      setError(e instanceof Error ? e.message : '生成失败');
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  const build = async () => {
    const state = stateRef.current;
    if (!state || busy) return;
    setBusy(true);
    setError('');
    cancelRef.current = false;
    const knownTags = [...new Set(listRegisteredMedia('photo').flatMap((m) => m.tags ?? []))];
    try {
      const out = await buildGroup(state, {
        generateCard: async ({ brief: memberBrief, contactId, takenNames }) => {
          const card = await generatePersona(
            memberBrief,
            { complete: (m, o) => complete(`group-card:${contactId}`, m, o) },
            {
              contactId,
              knownTags,
              takenNames: [...takenNames, ...contacts.map((c) => c.remark ?? c.name)],
            },
          );
          return card.ok && card.value ? card.value.persona : null;
        },
        generateHistory: async (blueprint) => {
          const roster = blueprint.members.map((m) => `${m.key}=${m.name}`).join('、');
          const raw = await complete(
            'group-history',
            [
              {
                role: 'system',
                content:
                  '给这个微信群写 8-14 条「已经发生过」的聊天记录。只输出 JSON 数组：' +
                  '[{"speaker":"成员key","text":"这条消息"}]。' +
                  '要求：口语、短、像真人在群里说话；有来有回，不是每人说一句就没了；' +
                  '不要旁白、不要时间戳、不要@用户本人。',
              },
              {
                role: 'user',
                content: `群名：${blueprint.title}\n成员：${roster}\n常聊：${blueprint.topics.join('、')}`,
              },
            ],
            { json: true, maxTokens: 1200 },
          );
          const parsed = extractJson(raw);
          return Array.isArray(parsed)
            ? (parsed as Array<{ speaker?: unknown; text?: unknown }>).flatMap((l) =>
                typeof l?.speaker === 'string' && typeof l?.text === 'string'
                  ? [{ speaker: l.speaker, text: l.text }]
                  : [],
              )
            : [];
        },
        putContact,
        putPersona,
        getPersona: personaFor,
        // On a rebuild the row already exists in the store list — patch it so
        // the in-memory entry updates too (addConversation dedupes and would
        // leave the stale title on screen).
        addConversation: async (c) => {
          if (rebuildConvId && useAppStore.getState().conversationById(c.id)) {
            await patchConversation(c.id, c);
          } else {
            await addConversation(c);
          }
        },
        appendMessage,
        getConversation: (id) => repo.getConversation(id),
        // Newest real message = the floor for fabricated backlog (rowid order
        // == time order). getMessages returns chronological, limit 1 = newest.
        latestMessageAt: async (id) =>
          (await repo.getMessages(id, { limit: 1 }))[0]?.createdAt,
        // Checkpoint after every member, so a reload does not turn 7 paid-for
        // cards into 7 duplicate contacts on the next attempt.
        saveState: async (s) => {
          await repo.putSetting(buildStateKey(s.convId), s).catch(() => {});
        },
        now: () => Date.now(),
        onProgress: (note, done, total) => setProgress(`${note}（${done}/${total}）`),
        cancelled: () => cancelRef.current,
      });
      if (out.created.length === 0) {
        setError('一个成员都没能生成——检查 API 配置后重试');
        return;
      }
      showToast(
        out.skipped.length ? `建好了，${out.skipped.length} 人没写成，可再点一次续写` : '群建好了',
      );
      if (!cancelRef.current) {
        await repo
          .putSetting(buildStateKey(state.convId), { ...state, historyDone: true })
          .catch(() => {});
        await repo.putSetting(ACTIVE_BUILD_KEY, '').catch(() => {});
        // A picked template carries knobs — they belong to the built room.
        const tpl = tplRef.current;
        if (tpl) {
          await putGroupCfg(out.convId, {
            activity: tpl.activity,
            spice: tpl.spice,
            topics: tpl.topics,
          }).catch(() => {});
        }
        navigate(`/chat/${out.convId}`, { replace: true });
      }
    } catch (e) {
      logError('group.build', e);
      setError(e instanceof Error ? e.message : '生成失败');
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  return (
    <>
      <SubNav title={rebuildConvId ? '重新配置群聊' : 'AI 代写群聊'} />
      <div className="page-body settings">
        {rebuildConvId && (
          <div className="settings__group">
            <div className="field">
              <span className="field__hint">
                正在重新配置「{rebuildConv?.title ?? rebuildConvId}」——名字对得上的现有成员
                直接沿用（不重复付费），新名字才会生成新人；现有聊天记录不动。
              </span>
            </div>
          </div>
        )}

        {!rebuildConvId && (
          <div className="settings__group">
            <div className="settings__group-title">一键模板（可改再生成）</div>
            {GROUP_TEMPLATES.map((t) => (
              <div
                key={t.id}
                className="settings__row settings__row--divided"
                onClick={() => {
                  tplRef.current = t;
                  setBrief(t.brief);
                  setSize(t.size);
                }}
              >
                <span className="settings__label">{t.name}</span>
                <span className="settings__value">{t.tagline}</span>
              </div>
            ))}
          </div>
        )}

        <div className="settings__group">
          <div className="settings__group-title">这是个什么群</div>
          <div className="field field--divided">
            <textarea
              className="field__textarea"
              value={brief}
              maxLength={200}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="例：大学宿舍群，毕业五年，有人创业有人躺平，每次聚会都吵架"
            />
          </div>
          <div className="field">
            <span className="field__label">群里有 {size} 个人（不含你）</span>
            <input
              type="range"
              min={MIN_MEMBERS}
              max={MAX_MEMBERS}
              step={1}
              value={size}
              onChange={(e) => setSize(Number(e.target.value))}
            />
            <div className="field__hint">
              约 {size + 2} 次模型调用（1 次群蓝图 + {size} 张人设卡 + 1 次聊天记录）。
              中途可以停，已经写好的人不会重复付费。
            </div>
          </div>
        </div>

        <div className="settings__group">
          <button className="btn-primary" disabled={busy || !brief.trim()} onClick={() => void planIt()}>
            {busy && !bp ? progress || '生成中…' : bp ? '重新生成群蓝图' : '先生成群蓝图（1 次调用）'}
          </button>
          {error && <div className="field__hint">{error}</div>}
        </div>

        {bp && (
          <>
            <div className="settings__group">
              <div className="settings__group-title">{bp.title}</div>
              {bp.announcement && <div className="field__hint">公告：{bp.announcement}</div>}
              <div className="field__hint">常聊：{bp.topics.join('、') || '日常'}</div>
              {bp.members.map((m) => (
                <div key={m.key} className="field field--divided">
                  <span className="field__label">{m.name}</span>
                  <div className="field__hint">{m.brief}</div>
                </div>
              ))}
            </div>

            <div className="settings__group">
              <div className="settings__group-title">他们之间</div>
              {bp.relations.slice(0, 12).map((r, i) => {
                const from = bp.members.find((m) => m.key === r.from)?.name ?? r.from;
                const to = bp.members.find((m) => m.key === r.to)?.name ?? r.to;
                return (
                  <div key={`${r.from}-${r.to}-${i}`} className="field__hint">
                    · {from} → {to}（{TONE_LABEL[r.tone] ?? r.tone}）{r.text}
                  </div>
                );
              })}
            </div>

            <div className="settings__group">
              <button className="btn-primary" disabled={busy} onClick={() => void build()}>
                {busy
              ? progress || '正在建群…'
              : Object.keys(stateRef.current?.made ?? {}).length > 0
                ? `继续建群（还差 ${bp.members.length - Object.keys(stateRef.current!.made).length} 人）`
                : `建群（约 ${bp.members.length + 1} 次调用）`}
              </button>
              {busy && (
                <button
                  className="btn-ghost"
                  onClick={() => {
                    cancelRef.current = true;
                    showToast('停在当前这个人之后');
                  }}
                >
                  停下
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
