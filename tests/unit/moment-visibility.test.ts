/**
 * 朋友圈可见范围 (M-I19).
 *
 * The feature's whole value is negative — things that must NOT happen — so the
 * suite is written as leak tests. The one that matters most is「她评论了一条你
 * 设置成不给她看的动态」: an excluded contact must plan exactly zero reactions,
 * live and offline alike.
 *
 * The other half is WHERE the rule lives. `search()` filters hidden
 * conversations inside itself precisely so a forgetful caller cannot leak; this
 * follows that precedent, and the driver-level cases below are what prove the
 * filter is in the data layer rather than in whichever component happens to
 * render a feed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  canSeeMoment,
  visibleMoments,
  normalizeVisibility,
  withoutContact,
  audienceCandidates,
  audienceLabel,
} from '../../src/lib/moment-visibility';
import { planReactions, planRepost, type ReactorInfo } from '../../src/ai/moments-engine';
import { simulate, type SimContact, type SimInput } from '../../src/ai/simulate';
import { IdbRepo } from '../../src/db/repo';
import { SqliteRepo, ensureSqliteSchema } from '../../src/db/sqlite';
import { FakeSqlDb } from './fake-sqlite';
import { openDB, _closeDbForTests } from '../../src/db/idb';
import { makePersona } from '../../src/data/persona-defaults';
import type { ContactVM, MomentVM, MomentVisibility, PersonaVM } from '../../src/data/types';

const HOUR = 3_600_000;
const NOON = new Date(2025, 7, 6, 12, 0, 0).getTime();

const post = (over: Partial<MomentVM> = {}): MomentVM => ({
  id: 'm1',
  authorId: 'self',
  imageRefs: [],
  isNsfw: false,
  text: '今天好累',
  createdAt: NOON,
  ...over,
});

const vis = (mode: MomentVisibility['mode'], ids: string[] = []): MomentVisibility => ({ mode, ids });

const contact = (id: string, type: ContactVM['type'] = 'ai'): ContactVM => ({
  id,
  type,
  name: id,
  avatarColor: 'c',
  avatarText: 'x',
});

/* ------------------------------ the predicate ------------------------------ */

describe('canSeeMoment', () => {
  it('treats a row with no audience as 公开 (every pre-M-I19 post)', () => {
    expect(canSeeMoment(post(), 'ai_a')).toBe(true);
  });

  it('公开 is visible to everyone', () => {
    expect(canSeeMoment(post({ visibility: vis('public') }), 'ai_a')).toBe(true);
  });

  it('私密 is visible to nobody but the author', () => {
    const m = post({ visibility: vis('private') });
    expect(canSeeMoment(m, 'ai_a')).toBe(false);
    expect(canSeeMoment(m, 'ai_b')).toBe(false);
    // The author still sees it — 私密 is a diary, not a write-only hole.
    expect(canSeeMoment(m, 'self')).toBe(true);
  });

  it('部分可见 is a whitelist', () => {
    const m = post({ visibility: vis('include', ['ai_a']) });
    expect(canSeeMoment(m, 'ai_a')).toBe(true);
    expect(canSeeMoment(m, 'ai_b')).toBe(false);
  });

  it('不给谁看 is a blacklist', () => {
    const m = post({ visibility: vis('exclude', ['ai_a']) });
    expect(canSeeMoment(m, 'ai_a')).toBe(false);
    expect(canSeeMoment(m, 'ai_b')).toBe(true);
  });

  it('fails CLOSED on an audience it cannot read', () => {
    // A row written by a future version, or corrupted in a restore. Publishing
    // something the user meant to restrict is the unrecoverable direction.
    const m = post({ visibility: { mode: 'sometimes' as never, ids: [] } });
    expect(canSeeMoment(m, 'ai_a')).toBe(false);
  });
});

describe('visibleMoments', () => {
  it('can only ever REMOVE rows', () => {
    // The one way a visibility filter turns into a leak is by growing into a
    // fetcher. Subset-ness is the invariant that catches that.
    const rows = [
      post({ id: 'm1' }),
      post({ id: 'm2', visibility: vis('private') }),
      post({ id: 'm3', visibility: vis('include', ['ai_a']) }),
      post({ id: 'm4', visibility: vis('exclude', ['ai_a']) }),
    ];
    for (const viewer of ['self', 'ai_a', 'ai_b']) {
      const out = visibleMoments(rows, viewer);
      expect(out.length).toBeLessThanOrEqual(rows.length);
      for (const m of out) expect(rows).toContain(m);
    }
  });

  it('shows the author everything they wrote', () => {
    const rows = [post({ id: 'm1', visibility: vis('private') }), post({ id: 'm2' })];
    expect(visibleMoments(rows, 'self').map((m) => m.id)).toEqual(['m1', 'm2']);
  });
});

describe('normalizeVisibility', () => {
  it('collapses 公开 to the absent state', () => {
    expect(normalizeVisibility(vis('public', []))).toBeUndefined();
    expect(normalizeVisibility(undefined)).toBeUndefined();
  });

  it('a whitelist of nobody IS 私密, never 公开', () => {
    expect(normalizeVisibility(vis('include', []))).toEqual({ mode: 'private', ids: [] });
  });

  it('a blacklist of nobody is just 公开', () => {
    expect(normalizeVisibility(vis('exclude', []))).toBeUndefined();
  });

  it('drops the author and de-duplicates', () => {
    expect(normalizeVisibility(vis('include', ['ai_a', 'ai_a', 'self']))).toEqual({
      mode: 'include',
      ids: ['ai_a'],
    });
  });
});

describe('audienceLabel', () => {
  it('names each mode the way WeChat does', () => {
    expect(audienceLabel(undefined)).toBe('公开');
    expect(audienceLabel(vis('public'))).toBe('公开');
    expect(audienceLabel(vis('private'))).toBe('私密');
    expect(audienceLabel(vis('include', ['a']))).toBe('部分可见');
    expect(audienceLabel(vis('exclude', ['a']))).toBe('不给谁看');
  });
});

describe('audienceCandidates', () => {
  it('offers AI contacts only — never the user, never a non-person row', () => {
    const out = audienceCandidates([contact('ai_a'), contact('self', 'self'), contact('ai_b')]);
    expect(out.map((c) => c.id)).toEqual(['ai_a', 'ai_b']);
  });

  it('is derived from CONTACTS, so a hidden DM thread can never enter the picker', () => {
    // The picker takes ContactVM[]. Conversations — the rows that carry
    // `isHidden` — are structurally not an input here, which is what keeps the
    // AI↔AI private threads out of a user-visible surface (CLAUDE.md §3.5).
    const contacts = [contact('ai_a'), contact('ai_b')];
    const out = audienceCandidates(contacts);
    for (const c of out) expect(c.type).toBe('ai');
    expect(out.some((c) => c.id.startsWith('dm_'))).toBe(false);
  });
});

/* ------------------------- the planner (the big one) ------------------------ */

const reactor = (id: string, over: Partial<ReactorInfo> = {}): ReactorInfo => ({
  contactId: id,
  // Everyone reacts to everything, so a zero can only come from the audience.
  likeRate: 1,
  commentRate: 1,
  affinity: 100,
  activeHours: [[0, 24]],
  ...over,
});

describe('planReactions honours 可见范围', () => {
  const crowd = ['ai_a', 'ai_b', 'ai_c'].map((id) => reactor(id));

  it('plans ZERO reactions for someone the post is hidden from', () => {
    const planned = planReactions(post({ visibility: vis('exclude', ['ai_a']) }), crowd, 's');
    expect(planned.filter((p) => p.contactId === 'ai_a')).toEqual([]);
    // …while everyone else still reacts, so this is a filter and not an outage.
    expect(planned.some((p) => p.contactId === 'ai_b')).toBe(true);
  });

  it('plans reactions ONLY for the whitelist under 部分可见', () => {
    const planned = planReactions(post({ visibility: vis('include', ['ai_b']) }), crowd, 's');
    expect(new Set(planned.map((p) => p.contactId))).toEqual(new Set(['ai_b']));
  });

  it('a 私密 post draws nothing at all', () => {
    expect(planReactions(post({ visibility: vis('private') }), crowd, 's')).toEqual([]);
  });

  it('leaves 公开 posts exactly as they were before M-I19', () => {
    const before = planReactions(post(), crowd, 's');
    const after = planReactions(post({ visibility: vis('public') }), crowd, 's');
    expect(after).toEqual(before);
    expect(before.length).toBeGreaterThan(0);
  });

  it('does not merely re-roll the dice — the excluded person is dropped, the rest keep their times', () => {
    // If the filter had been applied by consuming rng draws differently, the
    // survivors' schedules would shift. Same seed, same times.
    const open = planReactions(post(), crowd, 's');
    const closed = planReactions(post({ visibility: vis('exclude', ['ai_a']) }), crowd, 's');
    expect(closed).toEqual(open.filter((p) => p.contactId !== 'ai_a'));
  });
});

describe('planRepost honours 可见范围', () => {
  const crowd = ['ai_a', 'ai_b', 'ai_c'].map((id) => reactor(id, { affinity: 90 }));

  it('never reposts a restricted post, whoever can see it', () => {
    // A repost republishes your words to an audience you never chose, so it
    // refuses ALL restricted posts rather than just checking the reposter.
    for (const mode of ['private', 'include', 'exclude'] as const) {
      for (let i = 0; i < 200; i++) {
        const m = post({ id: `m${i}`, visibility: vis(mode, ['ai_a']) });
        expect(planRepost(m, crowd, 's')).toBeNull();
      }
    }
  });

  it('still reposts 公开 posts (the refusal is targeted, not a kill switch)', () => {
    let hits = 0;
    for (let i = 0; i < 200; i++) if (planRepost(post({ id: `m${i}` }), crowd, 's')) hits++;
    expect(hits).toBeGreaterThan(0);
  });
});

/* ------------------------------ offline (simulate) -------------------------- */

describe('simulate honours 可见范围', () => {
  const persona = (id: string): PersonaVM =>
    makePersona({ contactId: id, core: 'c', likeRate: 1, commentRate: 1, activeHours: [[0, 24]] });
  const singles: SimContact[] = ['ai_a', 'ai_b'].map((id) => ({
    contactId: id,
    convId: `conv_${id}`,
    persona: persona(id),
  }));
  const base = (visibility?: MomentVisibility): SimInput => ({
    singles,
    groups: [],
    recentMoments: [
      { id: 'm1', authorId: 'self', createdAt: NOON - 10 * HOUR, ...(visibility ? { visibility } : {}) },
    ],
  });

  it('backfills belated 赞评 on a 公开 post', () => {
    const plan = simulate(NOON - 8 * HOUR, NOON, base(), 's');
    expect(plan.events.some((e) => e.momentId === 'm1')).toBe(true);
  });

  it('never backfills a reaction from someone the post is hidden from', () => {
    const plan = simulate(NOON - 8 * HOUR, NOON, base(vis('exclude', ['ai_a'])), 's');
    const onPost = plan.events.filter((e) => e.momentId === 'm1');
    expect(onPost.some((e) => e.contactId === 'ai_a')).toBe(false);
  });

  it('a 私密 post draws nothing across the whole absence', () => {
    const plan = simulate(NOON - 8 * HOUR, NOON, base(vis('private')), 's');
    expect(plan.events.filter((e) => e.momentId === 'm1')).toEqual([]);
  });
});

/* --------------- the filter is in the DATA layer, not in the UI -------------- */

describe('可见范围 is enforced by the Repo drivers', () => {
  let idb: IdbRepo;
  let sq: SqliteRepo;

  const rows = [
    post({ id: 'm_open', createdAt: NOON - 3 * HOUR }),
    post({ id: 'm_priv', createdAt: NOON - 2 * HOUR, visibility: vis('private') }),
    post({ id: 'm_only_b', createdAt: NOON - HOUR, visibility: vis('include', ['ai_b']) }),
    post({ id: 'm_not_a', createdAt: NOON, visibility: vis('exclude', ['ai_a']) }),
  ];

  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    _closeDbForTests();
    await openDB();
    idb = new IdbRepo();
    const fake = new FakeSqlDb();
    await ensureSqliteSchema(fake);
    sq = new SqliteRepo(fake);
    for (const m of rows) {
      await idb.putMoment(m);
      await sq.putMoment(m);
    }
  });

  it('hands the user their whole feed, restricted posts included', async () => {
    for (const r of [idb, sq]) {
      const ids = (await r.getMoments()).map((m) => m.id).sort();
      expect(ids).toEqual(['m_not_a', 'm_only_b', 'm_open', 'm_priv']);
    }
  });

  it('hands an agent viewer only what she may see — both drivers agree', async () => {
    for (const r of [idb, sq]) {
      const a = (await r.getMoments({ viewer: 'ai_a' })).map((m) => m.id).sort();
      const b = (await r.getMoments({ viewer: 'ai_b' })).map((m) => m.id).sort();
      expect(a).toEqual(['m_open']);
      expect(b).toEqual(['m_not_a', 'm_only_b', 'm_open']);
    }
  });

  it('filters the album page read too (个人相册页)', async () => {
    for (const r of [idb, sq]) {
      expect((await r.getMomentsByAuthor('self')).length).toBe(4);
      expect((await r.getMomentsByAuthor('self', 'ai_a')).map((m) => m.id)).toEqual(['m_open']);
    }
  });
});

describe('deleteContact scrubs the audience lists', () => {
  it('removes the dead contact surgically, leaving the living ones', () => {
    const m = post({ visibility: vis('exclude', ['ai_a', 'ai_b']) });
    expect(withoutContact(m, 'ai_a')?.visibility).toEqual({ mode: 'exclude', ids: ['ai_b'] });
  });

  it('reports "nothing to do" for a post that never named them', () => {
    expect(withoutContact(post(), 'ai_a')).toBeNull();
    expect(withoutContact(post({ visibility: vis('exclude', ['ai_b']) }), 'ai_a')).toBeNull();
  });

  it('a whitelist emptied by the deletion becomes 私密, NOT 公开', () => {
    // Losing the last person you shared with must never publish the post.
    const m = post({ visibility: vis('include', ['ai_a']) });
    expect(withoutContact(m, 'ai_a')?.visibility).toEqual({ mode: 'private', ids: [] });
  });

  it('runs as part of the real deleteContact cascade', async () => {
    globalThis.indexedDB = new IDBFactory();
    _closeDbForTests();
    await openDB();
    const repo = new IdbRepo();
    await repo.putContact(contact('ai_a'));
    await repo.putContact(contact('ai_b'));
    await repo.putMoment(post({ id: 'm1', visibility: vis('exclude', ['ai_a', 'ai_b']) }));
    await repo.deleteContact('ai_a');
    // ai_b is still alive and still excluded — the row was operated on, not
    // dropped, exactly like the `rel_edges` / `groupNick:` surgery.
    const after = await repo.getMoment('m1');
    expect(after?.visibility).toEqual({ mode: 'exclude', ids: ['ai_b'] });
  });
});

describe('the store mirrors the cascade', () => {
  it('scrubs audience lists in the in-memory feed too', () => {
    // The repo cascade rewrites the stored row; an open feed renders from the
    // store. Without the mirror, 「部分可见·<死者>」 keeps showing until reload —
    // the same reason the repost-snapshot scrub is mirrored here (M-I15).
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'store', 'appStore.ts'),
      'utf8',
    );
    expect(src).toContain('withoutContact');
  });
});

/* ------------------ the UI is NOT where the rule lives (guard) --------------- */

describe('no feature component holds the visibility invariant', () => {
  it('leaves the filtering to lib/db/ai — a component that filters is a component that forgets', () => {
    // `audienceLabel` (a label) is fine on a card; `canSeeMoment` /
    // `visibleMoments` (the rule) must not be. If a future change moves the
    // check into a page, the next read path added elsewhere silently leaks.
    const root = join(__dirname, '..', '..', 'src', 'features');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name)) {
          const src = readFileSync(p, 'utf8');
          if (/\b(canSeeMoment|visibleMoments)\b/.test(src)) offenders.push(p);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
