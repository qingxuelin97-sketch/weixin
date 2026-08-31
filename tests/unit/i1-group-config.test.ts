import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
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
import {
  repo,
  DELETE_CONTACT_CASCADE,
  SETTINGS_KEY_CASCADE,
  REL_PAIR_SEP,
} from '../../src/db/repo';
import { STORES, idbGetAll } from '../../src/db/idb';
import { replyTargetAuthor } from '../../src/features/moments/MomentCard';
import type {
  ConversationVM,
  MessageVM,
  PersonaVM,
  MomentCommentVM,
} from '../../src/data/types';

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
// Knob wiring — 写了没接线 = 没做.
// ---------------------------------------------------------------------------

describe('the knobs are actually wired', () => {
  const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8');

  it('group engine feeds the cfg line into actor prompts', () => {
    const src = read('src/ai/group-engine.ts');
    expect(src).toContain("from './group-config'");
    expect(src).toContain('groupCfgDirective');
  });

  it('the foreground pass hands the activity multiplier to simulate', () => {
    const src = read('src/app/useSchedulerRuntime.ts');
    expect(src).toContain('getGroupCfg');
    expect(src).toContain('activityMultiplier');
  });

  it('the activity knob reaches the director prefilter, not just the planner', () => {
    // It shipped reading into simulate() and the prompt only — the live path
    // ignored it entirely, so 冷清 and 热闹 behaved identically on screen.
    const src = read('src/ai/group-engine.ts');
    expect(src).toContain('prefilterKnobs');
    expect(src).toMatch(/prefilter\([^)]*prefilterKnobs\(cfg\)\)/);
    // …and the round reads the row ONCE: the prompt line comes off the same
    // `cfg`, not a second settings round-trip mid-turn.
    expect(src).toContain('groupCfgLine(cfg)');
  });

  it('a template can be applied when RECONFIGURING an existing group', () => {
    const src = read('src/features/contacts/GroupGeneratePage.tsx');
    // The block used to be gated behind `{!rebuildConvId && (…)}`, which put
    // the one-tap presets out of reach of the only flow that already HAS a
    // room to shape — reachable from 聊天信息 › 一键重新配置本群.
    expect(src).not.toMatch(/\{!rebuildConvId && \([\s\S]{0,400}GROUP_TEMPLATES/);
    expect(src).toContain('GROUP_TEMPLATES.map');
    expect(read('src/features/chat/ChatInfoPage.tsx')).toContain('group-generate?rebuild=');
    // On that path a template is a MOOD ("用这套气质重配"), not a roster: the
    // room keeps its own head count, or "reconfigure" would silently shrink a
    // twelve-person group to a template's four.
    expect(src).toMatch(/if \(!rebuildConvId\) setSize\(t\.size\)/);
  });

  it('the group ＋ no longer jumps to CREATE-a-group', () => {
    expect(read('src/features/chat/ChatInfoPage.tsx')).not.toContain("navigate('/group-new')");
  });

  it('the profile card owns the delete-contact entry', () => {
    const src = read('src/features/contacts/ContactProfilePage.tsx');
    expect(src).toContain('deleteContact');
    expect(src).toContain('showConfirm');
  });
});

describe('offline pacing respects the activity knob', () => {
  const mkGroup = (activity?: number) => ({
    convId: 'g1',
    memberIds: ['a', 'b', 'c', 'd'],
    lastMsgAt: 0,
    ...(activity != null ? { activity } : {}),
  });

  it('a lively room plans more, a quiet room plans fewer — never zero', async () => {
    const { simulate, MIN_GROUP_GAP_MS } = await import('../../src/ai/simulate');
    const from = T0;
    const to = T0 + 8 * 3_600_000; // 8h absence
    const count = (activity?: number) =>
      simulate(from, to, { singles: [], groups: [mkGroup(activity)] }, 'seed').events.filter(
        (e) => e.kind === 'group_msg',
      );
    const quiet = count(0.3);
    const normal = count(undefined);
    const lively = count(1.6);
    expect(quiet.length).toBeGreaterThanOrEqual(1); // quiet is not dead
    expect(quiet.length).toBeLessThanOrEqual(normal.length);
    expect(lively.length).toBeGreaterThanOrEqual(normal.length);
    // The ≤2-per-15min bar is enforced by SPACING, which no knob may relax.
    for (const events of [quiet, normal, lively]) {
      const ats = events.map((e) => e.at).sort((a, b) => a - b);
      for (let i = 1; i < ats.length; i++) {
        expect(ats[i] - ats[i - 1]).toBeGreaterThanOrEqual(MIN_GROUP_GAP_MS);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// deleteContact — the cascade and its ledger.
// ---------------------------------------------------------------------------

/* --------------------------------------------------------------------------
 * A static scan of every settings key the app writes.
 *
 * `DELETE_CONTACT_CASCADE.settings = 'cascade'` is one word covering a KV store
 * that does the work of a dozen tables — which is why `agent_state:`,
 * `goal_told:`, `giftAt:`, `callAt:`, `memext:` and `groupNick:` all survived
 * contact deletion for a year: shipping a per-contact key required neither a
 * new object store nor a ledger edit, so no guard could notice.
 *
 * So the keys get scanned out of the source and matched against
 * `SETTINGS_KEY_CASCADE`. An unregistered prefix is red on the commit that adds
 * it, which is the only moment anyone remembers what deletion should mean.
 * ------------------------------------------------------------------------ */

const SRC_ROOT = resolve(__dirname, '../../src');

/** Every .ts/.tsx under src/, sorted for determinism. */
function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...srcFiles(p));
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out.sort();
}

/**
 * The argument list of the call whose `(` follows `from`, split at top level.
 * String literals are skipped whole so a comma or brace inside one cannot
 * confuse the depth counter.
 */
function callArgs(text: string, from: number): string[] {
  const open = text.indexOf('(', from);
  if (open < 0) return [];
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) {
        args.push(text.slice(start, i).trim());
        return args;
      }
    } else if (ch === ',' && depth === 1) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  return args;
}

type ScannedKey =
  /** A whole key, written as a literal (`'nsfwGlobalTier'`). */
  | { kind: 'key'; value: string }
  /** The static head of a template key (`` `affect:${id}` `` → 'affect:'). */
  | { kind: 'prefix'; value: string }
  /** A key expression this scan cannot follow — must be an accepted dynamic one. */
  | { kind: 'unresolved'; value: string };

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;
const CALL_RE = /^([A-Za-z_$][\w$]*)\s*\(/;
const fileCache = new Map<string, string>();
const readSrc = (f: string): string => {
  if (!fileCache.has(f)) fileCache.set(f, readFileSync(f, 'utf8'));
  return fileCache.get(f)!;
};

function moduleOf(file: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  const base = resolve(dirname(file), spec);
  return [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find((c) => existsSync(c));
}

/** Resolve a MODULE-LEVEL `const`/`let`/`function` to the first literal it yields. */
function resolveName(name: string, file: string, depth: number): ScannedKey | undefined {
  if (depth > 5) return undefined;
  const src = readSrc(file);
  // Anchored at column 0: a key builder is module-level, and matching indented
  // declarations picks up unrelated locals that happen to share the name.
  const def = new RegExp(
    `(?:^|\\n)(?:export\\s+)?(?:const|let|function)\\s+${name}\\b([^\\n]*(?:\\n[^\\n]*){0,3})`,
  ).exec(src);
  if (def) {
    const lit = /(`[^`]*`|'[^']*'|"[^"]*")/.exec(def[1]);
    return lit ? headOf(lit[1], file, depth) : undefined;
  }
  for (const im of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
    const names = im[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim());
    if (!names.includes(name)) continue;
    const mod = moduleOf(file, im[2]);
    if (mod) return resolveName(name, mod, depth + 1);
  }
  return undefined;
}

/** Classify one key expression. */
function headOf(expr: string, file: string, depth = 0): ScannedKey | undefined {
  const e = expr.trim();
  if (e.startsWith("'") || e.startsWith('"')) return { kind: 'key', value: e.slice(1, -1) };
  if (e.startsWith('`')) {
    const body = e.slice(1, e.lastIndexOf('`'));
    const at = body.indexOf('${');
    if (at < 0) return { kind: 'key', value: body };
    let head = body.slice(0, at);
    if (head === '' && depth < 4) {
      // `${PREFIX}${a}:${b}` — the prefix is a named constant; follow it once.
      const close = body.indexOf('}');
      const inner = body.slice(2, close).trim();
      if (IDENT_RE.test(inner)) {
        const r = resolveName(inner, file, depth + 1);
        if (r?.kind === 'key') {
          const rest = body.slice(close + 1);
          const next = rest.indexOf('${');
          head = r.value + (next < 0 ? rest : rest.slice(0, next));
        }
      }
    }
    return { kind: 'prefix', value: head };
  }
  if (IDENT_RE.test(e)) {
    return resolveName(e, file, depth + 1) ?? { kind: 'unresolved', value: e };
  }
  const call = CALL_RE.exec(e);
  if (call) return resolveName(call[1], file, depth + 1) ?? { kind: 'unresolved', value: call[1] };
  // Anything else (a method DECLARATION's `key: string`, a spread, …) is noise.
  return undefined;
}

function scanSettingsKeys(): { registered: string[]; unresolved: string[] } {
  const registered = new Set<string>();
  const unresolved = new Set<string>();
  const take = (r: ScannedKey | undefined) => {
    if (!r) return;
    if (r.kind === 'unresolved') unresolved.add(r.value);
    else registered.add(r.value);
  };
  for (const file of srcFiles(SRC_ROOT)) {
    const src = readSrc(file);
    for (const m of src.matchAll(/\b(?:get|put)Setting\b/g)) {
      const args = callArgs(src, m.index);
      if (args.length) take(headOf(args[0], file));
    }
    // Rows written straight into the settings store, bypassing putSetting —
    // the keystore's master key and the restore/migration flags do this.
    for (const m of src.matchAll(/\b(?:idbGet|idbPut|writeStoreRow)\b/g)) {
      const args = callArgs(src, m.index);
      if (args.length < 2 || !/^['"]settings['"]$/.test(args[0])) continue;
      let keyExpr = args[1];
      if (keyExpr.startsWith('{')) {
        const km = /\bkey\s*(?::\s*([^,}]+)|[,}])/.exec(keyExpr);
        if (!km) continue;
        keyExpr = (km[1] ?? 'key').trim();
      }
      take(headOf(keyExpr, file));
    }
  }
  return { registered: [...registered].sort(), unresolved: [...unresolved].sort() };
}

/**
 * Key expressions that are genuinely dynamic, all inside the storage plumbing
 * itself: `key`/`row` are the Repo's own generic accessors, `rowKey` is the
 * cascade iterating the ledger. A NEW name showing up here means someone
 * started building settings keys somewhere the scan cannot see — decide what
 * deletion means for it, then add it here.
 */
const DYNAMIC_KEY_EXPRS = ['key', 'row', 'rowKey'];

describe('the deleteContact ledger', () => {
  it('classifies exactly the stores that exist', () => {
    // Add a store to idb.ts without deciding what contact deletion means for
    // it and this turns red. That is the point.
    const storeNames = STORES.map((s) => s.name).sort();
    expect(Object.keys(DELETE_CONTACT_CASCADE).sort()).toEqual(storeNames);
  });

  it('classifies exactly the settings keys the source writes', () => {
    const { registered, unresolved } = scanSettingsKeys();
    // Sanity: the scan must actually be finding things. A refactor that breaks
    // the scanner would otherwise "pass" by finding nothing at all.
    expect(registered.length).toBeGreaterThan(20);
    expect(registered).toContain('agent_state:');
    expect(unresolved).toEqual(DYNAMIC_KEY_EXPRS);
    expect(registered).toEqual(Object.keys(SETTINGS_KEY_CASCADE).sort());
  });

  it('states a reason for every key, and never files a scoped key as global', () => {
    const scanned = new Map(
      // Re-scan classified: a `prefix:` head means the key carries an id.
      (() => {
        const out: Array<[string, 'key' | 'prefix']> = [];
        for (const file of srcFiles(SRC_ROOT)) {
          const src = readSrc(file);
          for (const m of src.matchAll(/\b(?:get|put)Setting\b/g)) {
            const args = callArgs(src, m.index);
            const r = args.length ? headOf(args[0], file) : undefined;
            if (r && r.kind !== 'unresolved') out.push([r.value, r.kind]);
          }
        }
        return out;
      })(),
    );
    for (const [key, rule] of Object.entries(SETTINGS_KEY_CASCADE)) {
      expect(rule.why.length, `${key} needs a reason`).toBeGreaterThan(3);
      if (scanned.get(key) === 'prefix') {
        // `foo:${id}` is per-entity by construction. Filing it as 'global'
        // would be the one-word way to opt out of the cascade.
        expect(rule.scope, `${key} is a templated key`).not.toBe('global');
      }
      // The other one-word opt-out: keep the scope honest but mark the row
      // exempt. A key that carries an id in its NAME has no reason to outlive
      // that id — if one ever does, THIS line is where the case gets argued.
      if (rule.scope !== 'global') expect(rule.row, `${key} is per-entity`).toBe('cascade');
      // …and a global row has no id in its key for the cascade to match on, so
      // 'cascade' there would be a lie that quietly does nothing.
      else expect(rule.row, `${key} is a global row`).toBe('exempt');
    }
  });

  /**
   * Rows whose VALUE is an id-keyed map need bespoke surgery, so each one needs
   * its own test. There are two, and both have one below. A third turns this
   * red until someone writes its test too.
   */
  it('pins the rows that need per-entry surgery', () => {
    const withEntries = Object.entries(SETTINGS_KEY_CASCADE)
      .filter(([, r]) => r.entries)
      .map(([k]) => k)
      .sort();
    expect(withEntries).toEqual(['groupNick:', 'rel_edges']);
  });

  it('refuses to delete the user', async () => {
    await expect(repo.deleteContact('self')).rejects.toThrow();
    await expect(repo.deleteContact('user')).rejects.toThrow();
  });

  it('both drivers route through the one shared cascade', () => {
    // The IDB and SQLite drivers supply primitives; neither may grow a cascade
    // of its own, or the two halves of the app start forgetting different
    // things about the same deleted person.
    for (const f of ['src/db/repo.ts', 'src/db/sqlite.ts']) {
      const src = readFileSync(resolve(__dirname, '../..', f), 'utf8');
      expect(src, f).toContain('deleteContactCascade(this, {');
    }
    expect(readFileSync(resolve(SRC_ROOT, 'db/sqlite.ts'), 'utf8')).toContain(
      "import { deleteContactCascade",
    );
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
    // A story run with the victim CAST in it (M-I7 casting × M-I18 cascade).
    const { putSave } = await import('../../src/ai/story-gm');
    await putSave({
      id: 'save_cast', scriptId: 'sc1', nodeId: 'n1', vars: {}, seq: 3, turnsInNode: 0,
      convId: 'conv_g', bindings: { hero: VICTIM, sidekick: FRIEND },
      effectiveLevel: 0, isActive: true, createdAt: T0, updatedAt: T0, history: [],
    } as never);
    await putSave({
      id: 'save_other', scriptId: 'sc1', nodeId: 'n1', vars: {}, seq: 1, turnsInNode: 0,
      convId: 'conv_g', bindings: { hero: FRIEND },
      effectiveLevel: 0, isActive: true, createdAt: T0, updatedAt: T0, history: [],
    } as never);
    // Rolling summary of the dying thread, a persona-scoped worldbook entry,
    // and a favorited message of theirs — the three cascade stores the original
    // fixture never populated, so "cascade" was untested for them.
    await repo.putConvSummary({ convId: 'conv_v', summary: '聊过火锅', uptoMsgId: 1, updatedAt: T0 });
    await repo.putWorldbookEntry({
      id: 'wb_v', title: '她的设定', keywords: [], content: 'x', scope: 'persona',
      scopeId: VICTIM, priority: 50, enabled: true, createdAt: T0, updatedAt: T0,
    } as never);
    await repo.putFavorite({
      id: 'fav_v', msgId: 1, convId: 'conv_v', senderId: VICTIM, senderName: '要删的',
      convTitle: '要删的', type: 'text', content: 'hi', createdAt: T0, favedAt: T0,
    });
    // A reply to the victim's comment: the cascade takes the target away, and
    // the card must not fall back to 「我 回复 我」 (M-I18).
    await repo.putComment({
      id: 'c_reply', momentId: 'm_f', authorId: 'self', text: '同意',
      replyToCommentId: 'c_v', createdAt: T0 + 1,
    } as never);

    // One row per CASCADE-marked settings prefix, generated from the ledger
    // itself — registering a new prefix automatically gets it exercised here.
    for (const [prefix, rule] of Object.entries(SETTINGS_KEY_CASCADE)) {
      if (rule.row !== 'cascade') continue;
      if (rule.scope === 'contact') {
        await repo.putSetting(`${prefix}${VICTIM}`, { seeded: VICTIM });
        await repo.putSetting(`${prefix}${FRIEND}`, { seeded: FRIEND });
      } else if (rule.scope === 'conv') {
        await repo.putSetting(`${prefix}conv_v`, { seeded: 'conv_v' });
        await repo.putSetting(`${prefix}conv_g`, { seeded: 'conv_g' });
      } else if (rule.scope === 'pair') {
        await repo.putSetting(`${prefix}${VICTIM}:${FRIEND}`, { seeded: 1 });
        await repo.putSetting(`${prefix}${FRIEND}:${VICTIM}`, { seeded: 1 });
        await repo.putSetting(`${prefix}${FRIEND}:self`, { seeded: 1 });
      }
    }
    // 群昵称: the GROUP survives the deletion, so this row survives with it —
    // but the dead member's alias inside it must not.
    await repo.putSetting('groupNick:conv_g', { [VICTIM]: '小删', [FRIEND]: '小留' });

    // Relationship edges, written through the REAL engine so the test proves
    // the actual read path (one settings row holding every pair).
    const { recordRelEvent } = await import('../../src/ai/relationship');
    for (let i = 0; i < 5; i++) {
      await recordRelEvent('self', VICTIM, 'user_reply', T0, 20);
      await recordRelEvent('self', VICTIM, 'rp_received', T0, 20);
    }
    await recordRelEvent(FRIEND, VICTIM, 'dm_gossip', T0, 20);
    await recordRelEvent('self', FRIEND, 'user_reply', T0, 20);
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

  /**
   * The story save is the one cascade store that must NOT be emptied: a run is
   * hours of play, and losing an actor is not losing the story. Unbind + stop,
   * so I7's own `missingBindings` gate offers re-casting instead of letting the
   * GM write directives for a persona that no longer exists.
   */
  it('unbinds the victim from story runs and stops them, without destroying the save', async () => {
    await repo.deleteContact(VICTIM);
    const { getSave } = await import('../../src/ai/story-gm');

    const cast = (await getSave('save_cast'))!;
    expect(cast).toBeDefined(); // progress survives
    expect(Object.values(cast.bindings)).not.toContain(VICTIM);
    expect(cast.bindings.sidekick).toBe(FRIEND); // co-star untouched
    expect(cast.isActive).toBe(false);
    expect(cast.seq).toBe(3); // the rest of the row survived the write-back

    // A run they were never in keeps playing.
    const other = (await getSave('save_other'))!;
    expect(other.isActive).toBe(true);
    expect(other.bindings.hero).toBe(FRIEND);
  });

  /**
   * The store ledger used to be checked by NAME only — every store was
   * classified, and nothing verified that a 'cascade' classification did
   * anything. One probe per cascade store, and the probe map must cover exactly
   * the cascade-marked stores, so a new one cannot be declared handled without
   * proving it.
   */
  it('every store marked cascade really loses the victim', async () => {
    /** Residue detectors: true = the victim is still in that store. */
    const probes: Record<string, () => Promise<boolean>> = {
      contacts: async () => !!(await repo.getContact(VICTIM)),
      personas: async () => !!(await repo.getPersona(VICTIM)),
      conversations: async () =>
        (await repo.getConversations()).some(
          (c) => c.peerId === VICTIM || (c.memberIds ?? []).includes(VICTIM),
        ),
      messages: async () => (await repo.getMessages('conv_v', { limit: 50 })).length > 0,
      memory_facts: async () => (await repo.getMemory(VICTIM)).length > 0,
      conv_summaries: async () => !!(await repo.getConvSummary('conv_v')),
      scheduled_actions: async () => {
        const { pendingActions } = await import('../../src/ai/scheduler');
        return (await pendingActions()).some((a) => a.payloadJson.includes(VICTIM));
      },
      // The strong form: no settings row may mention the victim in its KEY or
      // anywhere in its VALUE. That is what catches the map-in-a-row leaks
      // (rel_edges, groupNick) which no key-name check can see.
      settings: async () =>
        (await idbGetAll<{ key: string; value: unknown }>('settings')).some(
          (r) => r.key.includes(VICTIM) || JSON.stringify(r.value ?? null).includes(VICTIM),
        ),
      moments: async () => (await repo.getMoments()).some((m) => m.authorId === VICTIM),
      moment_likes: async () => (await repo.getLikes('m_f')).some((l) => l.contactId === VICTIM),
      moment_comments: async () =>
        (await repo.getComments('m_f')).some((c) => c.authorId === VICTIM),
      story_saves: async () => {
        const { getSave } = await import('../../src/ai/story-gm');
        return Object.values((await getSave('save_cast'))?.bindings ?? {}).includes(VICTIM);
      },
      worldbook: async () => (await repo.getWorldbook()).some((w) => w.scopeId === VICTIM),
      favorites: async () =>
        (await idbGetAll<{ senderId: string }>('favorites')).some((f) => f.senderId === VICTIM),
    };
    const cascadeStores = Object.entries(DELETE_CONTACT_CASCADE)
      .filter(([, v]) => v === 'cascade')
      .map(([k]) => k)
      .sort();
    expect(Object.keys(probes).sort()).toEqual(cascadeStores);

    // Every probe must see the victim BEFORE the cascade — a probe that always
    // reads false would pass the after-check while testing nothing.
    for (const store of cascadeStores) {
      expect(await probes[store](), `${store}: fixture never seeded the victim`).toBe(true);
    }
    await repo.deleteContact(VICTIM);
    for (const store of cascadeStores) {
      expect(await probes[store](), `${store}: victim survived deleteContact`).toBe(false);
    }
  });

  /**
   * Every prefix the ledger marks 'cascade' is exercised straight from the
   * ledger, so registering a key is what tests it. `agent_state:` (I-H1's
   * anti-spam cooldown) and `goal_told:` (I14's once-ever ending ledger) are
   * the two the hand-written whitelist forgot.
   */
  it('clears every settings prefix the ledger marks cascade, and nobody else’s', async () => {
    await repo.deleteContact(VICTIM);
    for (const [prefix, rule] of Object.entries(SETTINGS_KEY_CASCADE)) {
      if (rule.row !== 'cascade') continue;
      if (rule.scope === 'contact') {
        expect(await repo.getSetting(`${prefix}${VICTIM}`), prefix).toBeUndefined();
        expect(await repo.getSetting(`${prefix}${FRIEND}`), prefix).toBeDefined();
      } else if (rule.scope === 'conv') {
        // conv_v died with the victim; conv_g (the group) outlives them.
        expect(await repo.getSetting(`${prefix}conv_v`), prefix).toBeUndefined();
        expect(await repo.getSetting(`${prefix}conv_g`), prefix).toBeDefined();
      } else if (rule.scope === 'pair') {
        expect(await repo.getSetting(`${prefix}${VICTIM}:${FRIEND}`), prefix).toBeUndefined();
        expect(await repo.getSetting(`${prefix}${FRIEND}:${VICTIM}`), prefix).toBeUndefined();
        expect(await repo.getSetting(`${prefix}${FRIEND}:self`), prefix).toBeDefined();
      }
    }
  });

  it('drops the dead member from the group nickname map, keeping the survivors', async () => {
    await repo.deleteContact(VICTIM);
    const nicks = await repo.getSetting<Record<string, string>>('groupNick:conv_g');
    expect(nicks).toBeDefined();
    expect(nicks![VICTIM]).toBeUndefined();
    expect(nicks![FRIEND]).toBe('小留');
  });

  /**
   * rel_edges is ONE settings row holding EVERY pair, so a row-key cascade can
   * only either miss it entirely (what happened) or wipe the whole graph. It
   * has to be per-edge surgery.
   */
  it('cuts the victim out of rel_edges per edge, leaving the rest of the graph', async () => {
    const { getEdge, getAllEdges, pairKey } = await import('../../src/ai/relationship');
    const before = (await getEdge('self', VICTIM, T0))!;
    expect(before.fam).toBeGreaterThan(5); // a real, accumulated relationship

    await repo.deleteContact(VICTIM);

    expect(await getEdge('self', VICTIM, T0)).toBeUndefined();
    expect(await getEdge(FRIEND, VICTIM, T0)).toBeUndefined();
    // The survivors' bond is untouched — the row itself must not be deleted.
    expect(await getEdge('self', FRIEND, T0)).toBeDefined();
    const all = await getAllEdges(T0);
    expect(Object.keys(all)).toContain(pairKey('self', FRIEND));
    expect(Object.keys(all).some((k) => k.split(REL_PAIR_SEP).includes(VICTIM))).toBe(false);
  });

  /**
   * The end-to-end reason edge residue matters. Seed ids are FIXED: empty the
   * app and `appStore` re-seeds `ai_lin` & co. verbatim. A surviving edge means
   * the NEW 林 starts life with the DEAD 林's familiarity and affinity — old
   * friend heartbeat pacing and like odds on day one.
   */
  it('a contact re-created under the same id inherits nothing', async () => {
    const { getEdge, effectiveAffinity } = await import('../../src/ai/relationship');
    await repo.deleteContact(VICTIM);

    await repo.putContact({
      id: VICTIM, type: 'ai', name: '新来的', avatarColor: 'var(--wx-a)', avatarText: '新',
      pinyinInitial: 'X', wxid: VICTIM,
    });
    await repo.putPersona(makePersona({ contactId: VICTIM, core: 'brand new' }));

    const edge = await getEdge('self', VICTIM, T0);
    expect(edge).toBeUndefined();
    // Falls back to the persona's own starting affinity, not the dead one's.
    expect(effectiveAffinity(edge, 20)).toBe(20);
    // …and none of the dead one's per-contact bookkeeping came back with them.
    expect(await repo.getSetting(`agent_state:${VICTIM}`)).toBeUndefined();
    expect(await repo.getSetting(`goal_told:${VICTIM}`)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Dangling comment replies (M-I18).
// ---------------------------------------------------------------------------

describe('a reply whose target is gone', () => {
  const mk = (id: string, authorId: string, replyToCommentId?: string): MomentCommentVM =>
    ({ id, momentId: 'm', authorId, text: 't', createdAt: 0, replyToCommentId }) as MomentCommentVM;

  it('resolves a live target', () => {
    const target = mk('c1', 'ai_lin');
    const reply = mk('c2', 'self', 'c1');
    expect(replyTargetAuthor([target, reply], reply)).toBe('ai_lin');
  });

  it('renders as a plain comment when the target was cascaded away', () => {
    // 「我 回复 我：同意」 was the old output — a sentence WeChat never writes.
    const reply = mk('c2', 'self', 'c1');
    expect(replyTargetAuthor([reply], reply)).toBeUndefined();
  });

  it('leaves non-replies alone', () => {
    const plain = mk('c1', 'self');
    expect(replyTargetAuthor([plain], plain)).toBeUndefined();
  });
});
