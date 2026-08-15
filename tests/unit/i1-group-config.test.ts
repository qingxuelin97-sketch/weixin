import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  applyPersonaPatch,
  mergeRelationEdges,
  dropRelationEdge,
  PERSONA_LOCKED_FIELDS,
} from '../../src/data/persona-patch';
import { makePersona, PERSONA_LIMITS } from '../../src/data/persona-defaults';
import { buildGroup, rebuildState, buildStateKey, type BuildDeps } from '../../src/ai/group-build';
import type { GroupBlueprint } from '../../src/ai/group-generate';
import {
  GROUP_CFG_DEFAULTS,
  getGroupCfg,
  putGroupCfg,
  activityMultiplier,
  spiceLine,
} from '../../src/ai/group-config';
import { GROUP_TEMPLATES } from '../../src/ai/group-templates';
import { repo, DELETE_CONTACT_CASCADE } from '../../src/db/repo';
import { STORES } from '../../src/db/idb';
import type { ConversationVM, MessageVM, PersonaVM } from '../../src/data/types';

/**
 * 一键群聊配置 (M-I1), foundation layer.
 *
 * The two failure modes these tests exist for are both SILENT in production:
 * a regeneration flow that routes through makePersona resets every field the
 * generator didn't mention, and a contact deletion that misses a store leaves
 * ghosts that resurface later (or, worse, a hidden AI↔AI DM that leaks).
 */

const T0 = new Date(2026, 6, 1, 12, 0).getTime();

// ---------------------------------------------------------------------------
// applyPersonaPatch — the anti-makePersona.
// ---------------------------------------------------------------------------

describe('applyPersonaPatch', () => {
  const base = makePersona({
    contactId: 'ai_x',
    core: '嘴硬心软的插画师',
    nsfwStyleSamples: ['样本一'],
    modelChat: 'prov:model-x',
    ttsVoice: 'voice-1',
    imageTags: ['插画'],
    relations: { ai_y: '死党', user: '暗恋' },
  });

  it('keeps every field the patch does not mention', () => {
    const { persona } = applyPersonaPatch(base, { core: '新的核心设定' });
    expect(persona.core).toBe('新的核心设定');
    // The makePersona failure mode: these would all have reset to defaults.
    expect(persona.nsfwStyleSamples).toEqual(['样本一']);
    expect(persona.modelChat).toBe('prov:model-x');
    expect(persona.relations).toEqual({ ai_y: '死党', user: '暗恋' });
    expect(persona.proactivity).toBe(base.proactivity);
  });

  it('strips every locked field and reports it', () => {
    const { persona, stripped } = applyPersonaPatch(base, {
      core: 'ok',
      relations: { hacked: '全新关系' },
      nsfwStyleSamples: [],
      modelChat: 'other:model',
      ttsVoice: 'v2',
      imageTags: ['风景'],
      nsfwPermit: true,
      contactId: 'ai_hijack',
    } as Partial<PersonaVM>);
    expect(persona.relations).toEqual(base.relations);
    expect(persona.nsfwStyleSamples).toEqual(['样本一']);
    expect(persona.modelChat).toBe('prov:model-x');
    expect(persona.ttsVoice).toBe('voice-1');
    expect(persona.imageTags).toEqual(['插画']);
    expect(persona.nsfwPermit).toBe(false);
    expect(persona.contactId).toBe('ai_x');
    for (const f of PERSONA_LOCKED_FIELDS) {
      if (f === 'contactId' || f === 'relations' || f === 'nsfwStyleSamples' || f === 'modelChat' || f === 'ttsVoice' || f === 'imageTags' || f === 'nsfwPermit') {
        expect(stripped).toContain(f);
      }
    }
  });

  it('treats null/undefined patch values as absent, not as erasure', () => {
    const { persona } = applyPersonaPatch(base, {
      speechStyle: undefined,
      greeting: null as unknown as string,
    });
    expect(persona.speechStyle).toBe(base.speechStyle);
    expect(persona.greeting).toBe(base.greeting);
  });

  it('clamps merged free text like every other persona write', () => {
    const { persona } = applyPersonaPatch(base, { core: 'x'.repeat(2000) });
    expect(persona.core.length).toBe(PERSONA_LIMITS.core);
  });

  it('never routes through makePersona (source guard)', () => {
    // makePersona backfills defaults — the exact bug this module exists to
    // prevent. Importing it here would reintroduce the reset path silently.
    const src = readFileSync(
      resolve(__dirname, '../../src/data/persona-patch.ts'),
      'utf8',
    );
    // The word appears in the explanatory comment; what must never appear is
    // an actual import binding or call.
    expect(/import\s*\{[^}]*makePersona/.test(src)).toBe(false);
    expect(/makePersona\s*\(/.test(src)).toBe(false);
  });
});

describe('relation edge helpers', () => {
  const p = makePersona({ contactId: 'a', core: 'x', relations: { b: '同事', c: '发小' } });

  it('merges edges without touching unrelated ones', () => {
    const out = mergeRelationEdges(p, { d: '新朋友' });
    expect(out.relations).toEqual({ b: '同事', c: '发小', d: '新朋友' });
  });

  it('drops exactly one edge', () => {
    const out = dropRelationEdge(p, 'b');
    expect(out.relations).toEqual({ c: '发小' });
    // No edge → same object, no pointless write.
    expect(dropRelationEdge(p, 'zzz')).toBe(p);
  });
});

// ---------------------------------------------------------------------------
// Rebuild semantics.
// ---------------------------------------------------------------------------

const bp: GroupBlueprint = {
  title: '新群名',
  announcement: '新公告',
  topics: ['吃饭'],
  members: [
    { key: 'a', name: '阿哲', brief: '开小店的' },
    { key: 'b', name: '新来的', brief: '刚加进来' },
  ],
  relations: [
    { from: 'a', to: 'b', tone: 'warm', text: '带他入伙' },
    { from: 'b', to: 'a', tone: 'warm', text: '前辈' },
  ],
};

describe('rebuilding an existing group', () => {
  it('two builds park their state under different keys', () => {
    // The singleton key meant rebuilding group A clobbered half-built group
    // B's resume ledger — B's paid-for cards became duplicates.
    expect(buildStateKey('conv_1')).not.toBe(buildStateKey('conv_2'));
  });

  it('reuses existing members by name instead of paying for them again', async () => {
    const personas = new Map<string, PersonaVM>();
    personas.set(
      'ai_old_azhe',
      makePersona({ contactId: 'ai_old_azhe', core: '老卡', relations: { ai_outsider: '外面的朋友' } }),
    );
    const state = rebuildState(bp, 'conv_g', { 阿哲: 'ai_old_azhe' }, T0);
    expect(state.made.a).toBe('ai_old_azhe');

    const calls: string[] = [];
    const existingConv: ConversationVM = {
      id: 'conv_g',
      type: 'group',
      title: '旧群名',
      avatarColor: 'var(--wx-a)',
      avatarText: '旧',
      memberIds: ['ai_old_azhe', 'ai_keeper'],
      isPinned: true,
      isMuted: false,
      unreadCount: 3,
      mentionMe: false,
      lastMsgPreview: 'x',
      lastMsgAt: T0 - 1000,
    };
    let savedConv: ConversationVM | null = null;
    const deps: BuildDeps = {
      generateCard: async ({ contactId }) => {
        calls.push(contactId);
        return makePersona({ contactId, core: 'c' });
      },
      generateHistory: async () => [],
      putContact: async () => {},
      putPersona: async (p) => void personas.set(p.contactId, p),
      getPersona: (id) => personas.get(id),
      addConversation: async (c) => void (savedConv = c),
      appendMessage: async (m) => ({ ...m, id: 1 }) as MessageVM,
      saveState: async () => {},
      now: () => T0,
      getConversation: async (id) => (id === 'conv_g' ? existingConv : undefined),
    };
    await buildGroup(state, deps);

    // Only the genuinely new member cost a call.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('_b');

    // Roster is a UNION: the member the blueprint never mentioned stays.
    const conv = savedConv!;
    expect(conv.memberIds).toContain('ai_keeper');
    expect(conv.memberIds).toContain('ai_old_azhe');
    expect(conv.memberIds).toContain(state.made.b);
    // Blueprint's identity lands; the user's own pin state survives.
    expect(conv.title).toBe('新群名');
    expect(conv.isPinned).toBe(true);
    expect(conv.unreadCount).toBe(3);

    // The relations second pass MERGED: the old edge to someone outside the
    // group survived the rebuild. (The old wholesale write erased it.)
    const azhe = personas.get('ai_old_azhe')!;
    expect(azhe.relations.ai_outsider).toBe('外面的朋友');
    expect(azhe.relations[state.made.b]).toBe('带他入伙');
  });

  it('floors seeded history at the newest real message', async () => {
    const stamped: number[] = [];
    const state = rebuildState(bp, 'conv_g', {}, T0);
    const lastReal = T0 - 60_000; // one minute ago
    const deps: BuildDeps = {
      generateCard: async ({ contactId }) => makePersona({ contactId, core: 'c' }),
      generateHistory: async () => [
        { speaker: 'a', text: '早' },
        { speaker: 'b', text: '来了' },
      ],
      putContact: async () => {},
      putPersona: async () => {},
      getPersona: () => undefined,
      addConversation: async () => {},
      appendMessage: async (m) => {
        stamped.push(m.createdAt);
        return { ...m, id: stamped.length } as MessageVM;
      },
      saveState: async () => {},
      now: () => T0,
      latestMessageAt: async () => lastReal,
    };
    await buildGroup(state, deps);
    expect(stamped.length).toBeGreaterThan(0);
    for (const at of stamped) {
      // Never before the newest real row (rowid order == time order), never
      // in the future.
      expect(at).toBeGreaterThan(lastReal);
      expect(at).toBeLessThan(T0);
    }
  });
});

// ---------------------------------------------------------------------------
// Per-group knobs.
// ---------------------------------------------------------------------------

describe('group config knobs', () => {
  it('absent row = the defaults = exactly today\'s behavior', async () => {
    const cfg = await getGroupCfg('conv_never_configured');
    expect(cfg).toEqual(GROUP_CFG_DEFAULTS);
    expect(activityMultiplier(cfg)).toBe(1);
    expect(spiceLine(cfg)).toBe('');
  });

  it('round-trips and clamps corrupt values', async () => {
    await putGroupCfg('conv_k', { activity: 3, spice: 0, topics: ['  骑行 ', '', '追星'] });
    const cfg = await getGroupCfg('conv_k');
    expect(cfg.activity).toBe(3);
    expect(cfg.spice).toBe(0);
    expect(cfg.topics).toEqual(['骑行', '追星']);

    await repo.putSetting('groupCfg:conv_bad', { activity: 99, spice: -3, topics: 'nope' });
    const bad = await getGroupCfg('conv_bad');
    expect(bad.activity).toBe(GROUP_CFG_DEFAULTS.activity);
    expect(bad.spice).toBe(GROUP_CFG_DEFAULTS.spice);
    expect(bad.topics).toEqual([]);
  });

  it('activity is monotonic and quiet is not dead', () => {
    const m = [0, 1, 2, 3].map((activity) => activityMultiplier({ activity: activity as 0 | 1 | 2 | 3 }));
    for (let i = 1; i < m.length; i++) expect(m[i]).toBeGreaterThan(m[i - 1]);
    expect(m[0]).toBeGreaterThan(0);
  });

  it('every template carries valid knobs and a usable brief', () => {
    const ids = new Set<string>();
    for (const t of GROUP_TEMPLATES) {
      expect(ids.has(t.id)).toBe(false);
      ids.add(t.id);
      expect(t.brief.length).toBeGreaterThan(20);
      expect(t.size).toBeGreaterThanOrEqual(4);
      expect(t.size).toBeLessThanOrEqual(20);
      expect([0, 1, 2, 3]).toContain(t.activity);
      expect([0, 1, 2, 3]).toContain(t.spice);
    }
    expect(GROUP_TEMPLATES.length).toBeGreaterThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// deleteContact — the cascade and its ledger.
// ---------------------------------------------------------------------------

describe('the deleteContact ledger', () => {
  it('classifies exactly the stores that exist', () => {
    // Add a store to idb.ts without deciding what contact deletion means for
    // it and this turns red. That is the point.
    const storeNames = STORES.map((s) => s.name).sort();
    expect(Object.keys(DELETE_CONTACT_CASCADE).sort()).toEqual(storeNames);
  });

  it('refuses to delete the user', async () => {
    await expect(repo.deleteContact('self')).rejects.toThrow();
    await expect(repo.deleteContact('user')).rejects.toThrow();
  });
});

describe('deleteContact cascade', () => {
  const VICTIM = 'ai_victim';
  const FRIEND = 'ai_friend';

  beforeEach(async () => {
    // A small world with the victim woven into every cascade store.
    await repo.putContact({
      id: VICTIM, type: 'ai', name: '要删的', avatarColor: 'var(--wx-a)', avatarText: '删',
      pinyinInitial: 'Y', wxid: VICTIM,
    });
    await repo.putContact({
      id: FRIEND, type: 'ai', name: '留下的', avatarColor: 'var(--wx-a)', avatarText: '留',
      pinyinInitial: 'L', wxid: FRIEND,
    });
    await repo.putPersona(makePersona({ contactId: VICTIM, core: 'x' }));
    await repo.putPersona(
      makePersona({ contactId: FRIEND, core: 'y', relations: { [VICTIM]: '老同学', user: '朋友' } }),
    );
    // 1:1 thread + a message in it.
    await repo.putConversation({
      id: 'conv_v', type: 'single', peerId: VICTIM, title: '要删的',
      avatarColor: 'var(--wx-a)', avatarText: '删', isPinned: false, isMuted: false,
      unreadCount: 0, mentionMe: false, lastMsgPreview: '', lastMsgAt: T0,
    });
    await repo.addMessage({
      convId: 'conv_v', senderId: VICTIM, type: 'text', content: 'hi', status: 'sent', createdAt: T0,
    });
    // Hidden DM with the friend.
    await repo.putConversation({
      id: `dm_${FRIEND}_${VICTIM}`, type: 'single', title: '私聊',
      avatarColor: 'var(--wx-a)', avatarText: '私', memberIds: [FRIEND, VICTIM],
      isPinned: false, isMuted: true, isHidden: true, unreadCount: 0, mentionMe: false,
      lastMsgPreview: '', lastMsgAt: T0,
    });
    // Group with both.
    await repo.putConversation({
      id: 'conv_g', type: 'group', title: '群', avatarColor: 'var(--wx-a)', avatarText: '群',
      memberIds: [VICTIM, FRIEND], isPinned: false, isMuted: false, unreadCount: 0,
      mentionMe: false, lastMsgPreview: '', lastMsgAt: T0,
    });
    // Memory, settings, schedule, moments.
    await repo.putMemory({
      id: 'fact_v', subjectId: VICTIM, kind: 'fact', content: '爱吃辣', score: 1,
      createdAt: T0, lastSeenAt: T0,
    } as never);
    await repo.putSetting(`affect:${VICTIM}`, { v: 1 });
    await repo.putSetting(`stance:${VICTIM}:${FRIEND}`, { value: 5, day: 1 });
    await repo.putSetting(`stance:${FRIEND}:${VICTIM}`, { value: -5, day: 1 });
    await repo.putSetting(`relarc:${FRIEND}:${VICTIM}`, { phase: 'warm' });
    await repo.putSetting(`convstate:conv_v`, { promises: [] });
    await repo.putSetting('nsfwGlobalTier', 'off'); // must survive
    const { enqueue } = await import('../../src/ai/scheduler');
    await enqueue({
      kind: 'heartbeat', fireAt: T0 + 1000, payload: { convId: 'conv_v', contactId: VICTIM }, now: T0,
    });
    await enqueue({
      kind: 'heartbeat', fireAt: T0 + 1000, payload: { convId: 'conv_other', contactId: FRIEND }, now: T0,
    });
    await repo.putMoment({
      id: 'm_v', authorId: VICTIM, text: '我的动态', imageRefs: [], isNsfw: false, createdAt: T0,
    });
    await repo.putMoment({
      id: 'm_f', authorId: FRIEND, text: '别人的动态', imageRefs: [], isNsfw: false, createdAt: T0,
    });
    await repo.putLike({ id: `m_f:${VICTIM}`, momentId: 'm_f', contactId: VICTIM, createdAt: T0 });
    await repo.putComment({ id: 'c_v', momentId: 'm_f', authorId: VICTIM, text: '赞', createdAt: T0 });
    await repo.putWalletTx({
      id: 'tx_v', kind: 'rp_out', amountFen: 100, peerId: VICTIM, createdAt: T0,
    } as never);
  });

  it('leaves zero residue in every cascade store', async () => {
    await repo.deleteContact(VICTIM);

    expect(await repo.getContact(VICTIM)).toBeUndefined();
    expect(await repo.getPersona(VICTIM)).toBeUndefined();

    const convs = await repo.getConversations();
    expect(convs.find((c) => c.id === 'conv_v')).toBeUndefined();
    expect(convs.find((c) => c.id === `dm_${FRIEND}_${VICTIM}`)).toBeUndefined();
    const group = convs.find((c) => c.id === 'conv_g')!;
    expect(group.memberIds).toEqual([FRIEND]);

    expect(await repo.getMessages('conv_v', { limit: 10 })).toEqual([]);
    expect(await repo.getMemory(VICTIM)).toEqual([]);

    // The friend forgot the edge but kept everything else.
    const friend = (await repo.getPersona(FRIEND))!;
    expect(VICTIM in friend.relations).toBe(false);
    expect(friend.relations.user).toBe('朋友');

    // Settings: theirs gone, global ones intact.
    expect(await repo.getSetting(`affect:${VICTIM}`)).toBeUndefined();
    expect(await repo.getSetting(`stance:${VICTIM}:${FRIEND}`)).toBeUndefined();
    expect(await repo.getSetting(`stance:${FRIEND}:${VICTIM}`)).toBeUndefined();
    expect(await repo.getSetting(`relarc:${FRIEND}:${VICTIM}`)).toBeUndefined();
    expect(await repo.getSetting('convstate:conv_v')).toBeUndefined();
    expect(await repo.getSetting('nsfwGlobalTier')).toBe('off');

    // Schedule: their rows gone, unrelated pending survives.
    const { pendingActions } = await import('../../src/ai/scheduler');
    const pending = await pendingActions();
    expect(pending.some((a) => a.payloadJson.includes(VICTIM))).toBe(false);
    expect(pending.some((a) => a.payloadJson.includes(FRIEND))).toBe(true);

    // Moments: their post + their social traces gone; others' posts intact.
    expect(await repo.getMoment('m_v')).toBeUndefined();
    expect(await repo.getMoment('m_f')).toBeDefined();
    expect((await repo.getLikes('m_f')).some((l) => l.contactId === VICTIM)).toBe(false);
    expect((await repo.getComments('m_f')).some((c) => c.authorId === VICTIM)).toBe(false);

    // Exempt stores: the money ledger keeps its history.
    const txs = await repo.getWalletTxs();
    expect(txs.some((t) => t.id === 'tx_v')).toBe(true);
  });
});
