import { describe, it, expect } from 'vitest';
import {
  validateBlueprint,
  relationsFor,
  stampHistory,
  type GroupBlueprint,
} from '../../src/ai/group-generate';
import {
  buildGroup,
  newBuildState,
  isBuildComplete,
  avatarColor,
  type BuildDeps,
} from '../../src/ai/group-build';
import { narrowCandidates, prefilter, MAX_DIRECTOR_CANDIDATES } from '../../src/ai/director';
import { groupMessageBudget } from '../../src/ai/simulate';
import { makePersona } from '../../src/data/persona-defaults';
import type { MessageVM, PersonaVM } from '../../src/data/types';

/**
 * AI-written large群聊 (M-H2).
 *
 * A twelve-person group is one blueprint call plus twelve card calls — the
 * most expensive single operation in this app. Two classes of test here:
 *
 *   1. the blueprint's relation matrix, because an inconsistent one fails
 *      NOWHERE. It just produces a group where two members are having
 *      different conversations about each other forever.
 *   2. the scale gates, because a twenty-person group breaks three parameters
 *      that were calibrated when "group" meant four AI friends.
 */

const T0 = new Date(2026, 4, 10, 12, 0).getTime();

const blueprint = (over: Partial<GroupBlueprint> = {}): unknown => ({
  title: '苟富贵勿相忘',
  announcement: '周五老地方',
  topics: ['吃饭', '吐槽老板'],
  members: [
    { key: 'a', name: '阿哲', brief: '开小店的，话最多' },
    { key: 'b', name: '老王', brief: '程序员，闷' },
    { key: 'c', name: '小雨', brief: '插画师，和阿哲熟' },
    { key: 'd', name: '大鹏', brief: '销售，爱起哄' },
  ],
  relations: [
    { from: 'a', to: 'c', tone: 'warm', text: '发小' },
    { from: 'c', to: 'a', tone: 'warm', text: '从小一起长大' },
    { from: 'b', to: 'd', tone: 'neutral', text: '同事' },
    { from: 'd', to: 'b', tone: 'neutral', text: '认识' },
  ],
  ...over,
});

describe('the relation matrix', () => {
  it('accepts a consistent one', () => {
    expect(validateBlueprint(blueprint(), 4).ok).toBe(true);
  });

  it('rejects one-sided enmity', () => {
    // The failure this catches is invisible at runtime: A treats B as a rival
    // while B thinks they are fine, forever, with no error anywhere.
    const raw = blueprint({
      relations: [
        { from: 'a', to: 'b', tone: 'cool', text: '看不惯' },
        { from: 'b', to: 'a', tone: 'warm', text: '挺好的' },
        { from: 'c', to: 'd', tone: 'neutral', text: '还行' },
        { from: 'd', to: 'c', tone: 'neutral', text: '还行' },
      ],
    } as never);
    const out = validateBlueprint(raw, 4);
    expect(out.ok).toBe(false);
    expect(out.issues.some((i) => i.code === 'rel_asymmetric')).toBe(true);
    // The message has to name the two people, or the repair round is guesswork.
    expect(out.issues[0].message).toContain('阿哲');
  });

  it('allows asymmetric WARMTH, because people are like that', () => {
    const raw = blueprint({
      relations: [
        { from: 'a', to: 'b', tone: 'warm', text: '拿他当好哥们' },
        { from: 'b', to: 'a', tone: 'neutral', text: '普通同事' },
        { from: 'c', to: 'd', tone: 'warm', text: '好朋友' },
        { from: 'd', to: 'c', tone: 'warm', text: '好朋友' },
      ],
    } as never);
    expect(validateBlueprint(raw, 4).ok).toBe(true);
  });

  it('refuses a room where everyone hates everyone', () => {
    const rels = [];
    for (const [x, y] of [['a', 'b'], ['b', 'a'], ['c', 'd'], ['d', 'c'], ['a', 'c'], ['c', 'a'], ['b', 'd'], ['d', 'b']]) {
      rels.push({ from: x, to: y, tone: 'cool', text: '不对付' });
    }
    const out = validateBlueprint(blueprint({ relations: rels } as never), 4);
    expect(out.ok).toBe(false);
    expect(out.issues.some((i) => i.code === 'too_hostile')).toBe(true);
  });

  it('rejects duplicate names, which would make every mention ambiguous', () => {
    const raw = blueprint({
      members: [
        { key: 'a', name: '阿哲', brief: 'x1234' },
        { key: 'b', name: '阿哲', brief: 'y1234' },
        { key: 'c', name: '小雨', brief: 'z1234' },
        { key: 'd', name: '大鹏', brief: 'w1234' },
      ],
    } as never);
    expect(validateBlueprint(raw, 4).issues.some((i) => i.code === 'dup_name')).toBe(true);
  });

  it('rejects the wrong number of members', () => {
    expect(validateBlueprint(blueprint(), 12).issues.some((i) => i.code === 'size')).toBe(true);
  });

  it('drops relations pointing at people who do not exist', () => {
    const raw = blueprint({
      relations: [
        { from: 'a', to: 'zzz', tone: 'warm', text: '?' },
        { from: 'a', to: 'c', tone: 'warm', text: '发小' },
        { from: 'c', to: 'a', tone: 'warm', text: '发小' },
        { from: 'b', to: 'd', tone: 'neutral', text: '同事' },
      ],
    } as never);
    const out = validateBlueprint(raw, 4);
    expect(out.value?.relations.every((r) => r.to !== 'zzz')).toBe(true);
  });

  it('gives each member their own side of the matrix', () => {
    const bp = validateBlueprint(blueprint(), 4).value!;
    expect(relationsFor(bp, 'a')).toEqual({ c: '发小' });
  });
});

describe('the fabricated backlog', () => {
  it('never lands before the conversation’s newest message', () => {
    // A row inserted now with an older stamp inverts `rowid order == time
    // order`, and the cursor pagination built on it starts returning pages out
    // of order (CLAUDE.md §3.5).
    const floor = T0 - 60_000;
    const out = stampHistory(
      [
        { speaker: 'a', text: '1' },
        { speaker: 'b', text: '2' },
      ],
      T0,
      floor,
    );
    expect(out.every((l) => l.at > floor)).toBe(true);
    expect(out.every((l) => l.at < T0)).toBe(true);
  });

  it('runs forward in time', () => {
    const out = stampHistory(
      Array.from({ length: 8 }, (_, i) => ({ speaker: 'a', text: `${i}` })),
      T0,
      undefined,
    );
    for (let i = 1; i < out.length; i++) expect(out[i].at).toBeGreaterThanOrEqual(out[i - 1].at);
  });
});

describe('building the group', () => {
  const bp = validateBlueprint(blueprint(), 4).value!;
  const personas = new Map<string, PersonaVM>();

  const deps = (over: Partial<BuildDeps> = {}): BuildDeps => ({
    generateCard: async ({ contactId }) => makePersona({ contactId, core: 'c' }),
    generateHistory: async () => [
      { speaker: 'a', text: '来了来了' },
      { speaker: 'zzz', text: '我不存在' },
    ],
    putContact: async () => {},
    putPersona: async (p) => void personas.set(p.contactId, p),
    getPersona: (id) => personas.get(id),
    addConversation: async () => {},
    appendMessage: async (m) => ({ ...m, id: 1 }) as MessageVM,
    saveState: async () => {},
    now: () => T0,
    ...over,
  });

  it('creates everyone and wires the relations to REAL contact ids', () => {
    personas.clear();
    const state = newBuildState(bp, T0);
    return buildGroup(state, deps()).then((out) => {
      expect(out.created).toHaveLength(4);
      const aId = state.made.a;
      const cId = state.made.c;
      // A relations map keyed by blueprint key would silently resolve to
      // nothing in the prompt layer — the group would have no chemistry and
      // no error to explain it.
      expect(personas.get(aId)!.relations[cId]).toBe('发小');
    });
  });

  it('skips a member whose card fails instead of losing the other eleven', async () => {
    personas.clear();
    const state = newBuildState(bp, T0);
    let n = 0;
    const out = await buildGroup(
      state,
      deps({
        generateCard: async ({ contactId }) => {
          n++;
          return n === 2 ? null : makePersona({ contactId, core: 'c' });
        },
      }),
    );
    expect(out.created).toHaveLength(3);
    expect(out.skipped).toEqual(['老王']);
    expect(state.failed).toEqual(['b']);
  });

  it('does not pay twice for a member it already made', async () => {
    personas.clear();
    const state = newBuildState(bp, T0);
    await buildGroup(state, deps());
    let calls = 0;
    await buildGroup(
      state,
      deps({
        generateCard: async ({ contactId }) => {
          calls++;
          return makePersona({ contactId, core: 'c' });
        },
      }),
    );
    // Twelve members is twelve calls; re-running after a network drop must
    // continue, not restart.
    expect(calls).toBe(0);
  });

  it('stops between members when cancelled', async () => {
    personas.clear();
    const state = newBuildState(bp, T0);
    let n = 0;
    await buildGroup(
      state,
      deps({
        generateCard: async ({ contactId }) => {
          n++;
          return makePersona({ contactId, core: 'c' });
        },
        cancelled: () => n >= 2,
      }),
    );
    expect(Object.keys(state.made).length).toBeLessThan(4);
  });

  it('drops history lines from speakers who were never created', async () => {
    personas.clear();
    const sent: string[] = [];
    const state = newBuildState(bp, T0);
    await buildGroup(
      state,
      deps({
        appendMessage: async (m) => {
          sent.push(m.content ?? '');
          return { ...m, id: 1 } as MessageVM;
        },
      }),
    );
    expect(sent).toEqual(['来了来了']);
  });

  it('knows when a build is finished, so a reload does not re-offer it', async () => {
    personas.clear();
    const state = newBuildState(bp, T0);
    expect(isBuildComplete(state)).toBe(false);
    await buildGroup(state, deps());
    // Without this the page would re-offer a finished build, and "继续" would
    // create a second copy of everyone already paid for.
    expect(isBuildComplete(state)).toBe(true);
  });

  it('gives members different avatar colours', () => {
    const seen = new Set([0, 1, 2, 3].map(avatarColor));
    // Twelve identical squares is the fastest way to make a generated group
    // feel generated.
    expect(seen.size).toBe(4);
  });
});

describe('the scale gates a 20-person group would otherwise break', () => {
  const members = Array.from({ length: 20 }, (_, i) => ({
    contactId: `ai_${i}`,
    name: `成员${i}`,
    persona: makePersona({ contactId: `ai_${i}`, core: 'c', activeHours: [[0, 24]] }),
  }));
  const msg = (senderId: string, i: number): MessageVM =>
    ({
      id: i,
      convId: 'g',
      senderId,
      type: 'text',
      content: 'x',
      status: 'sent',
      createdAt: T0 - (10 - i) * 60_000,
    }) as MessageVM;

  it('hands the director at most six roster lines', () => {
    // The director runs on EVERY group message and quotes one line per
    // candidate; twenty lines per turn is the single most expensive thing a
    // big group does.
    const out = prefilter(members, [msg('self', 9)], T0, 'seed');
    expect(out.candidates.length).toBeLessThanOrEqual(MAX_DIRECTOR_CANDIDATES);
  });

  it('keeps whoever is mid-conversation in the shortlist', () => {
    // Dropping the two people who were just talking is the one narrowing
    // choice that would read as broken.
    const tail = [msg('ai_17', 7), msg('ai_18', 8), msg('self', 9)];
    const short = narrowCandidates(members, tail, 'seed');
    const ids = short.map((m) => m.contactId);
    expect(ids).toContain('ai_17');
    expect(ids).toContain('ai_18');
  });

  it('does not always pick the same six', () => {
    const a = narrowCandidates(members, [], 'seed-a').map((m) => m.contactId);
    const b = narrowCandidates(members, [], 'seed-b').map((m) => m.contactId);
    expect(a.join()).not.toBe(b.join());
  });

  it('lets a big room tick over faster while it is asleep — but not much', () => {
    const hour = 3_600_000;
    const small = groupMessageBudget(T0, T0 + 8 * hour, 4);
    const big = groupMessageBudget(T0, T0 + 8 * hour, 20);
    // Coming back after eight hours to a twenty-person group and finding two
    // messages reads as a dead room…
    expect(big).toBeGreaterThan(small);
    // …and finding a hundred reads as a stress test.
    expect(big).toBeLessThanOrEqual(small * 3);
  });
});
