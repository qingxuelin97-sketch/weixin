/**
 * Story mode runtime (M-E5): the GM that walks a script's graph.
 *
 * Pipeline per specs/story-gm.md — serial **GM → director → actors**, all on the
 * one global queue (`story_tick`, a kind reserved since M1 that finally has a
 * handler). The GM owns where the story goes and what each character is doing;
 * the ordinary director still decides who speaks; the actors still write their
 * own lines. Narration is a grey system message.
 *
 * Two invariants carry most of the risk in this feature:
 *
 *  1. **Directives are injected per character, in isolation.** A character is
 *     never handed the script — they receive their own beat, their own secret,
 *     and nothing else. Giving an actor the whole graph is how a mystery gets
 *     spoiled in its second line.
 *
 *  2. **Rollback undoes side effects, not just the cursor.** A node that wrote
 *     a memory or posted to Moments has reached OUTSIDE the story. Restoring a
 *     save without retracting those leaves characters remembering a future that
 *     no longer happens — an irreversible contamination of ordinary chat. Every
 *     story-caused row is tagged `(scriptId, seq)` precisely so it can be found
 *     and removed, and `story-rollback.test.ts` deliberately omits one to prove
 *     the check turns red.
 */
import { idbGet, idbGetAll, idbGetAllByIndex, idbPut, idbDelete } from '../db/idb';
import { repo } from '../db/repo';
import type { MemoryFactVM, MomentVM } from '../data/types';
import {
  type Choice,
  type Script,
  type StoryNode,
  type Trigger,
  type Vars,
  applyVarEffects,
  evaluateTriggers,
  directiveTextFor,
  effectiveStoryLevel,
  parseWhen,
  validateScript,
} from './story-script';

/* ==================================================================== */
/* Persistence shapes                                                    */
/* ==================================================================== */

export interface StoryScriptRow {
  id: string;
  title: string;
  genre?: string;
  nsfwLevel: number;
  /** The validated Script, stored whole. */
  dagJson: string;
  createdAt: number;
  /** 'builtin' rows are re-seeded on upgrade; the rest are the user's. */
  origin?: 'builtin' | 'import' | 'generated';
}

export interface StorySaveRow {
  id: string;
  scriptId: string;
  name?: string;
  /** Current node id. */
  nodeId: string;
  vars: Vars;
  /** Monotonic beat counter. Every side effect is tagged with it. */
  seq: number;
  /** Turns spent in the current node, for `timeout`. */
  turnsInNode: number;
  /** The conversation the story is playing in. */
  convId: string;
  /** Cast binding: script charId → real contactId. */
  bindings: Record<string, string>;
  /** Tier snapshot taken at start; the run never re-reads the global setting. */
  effectiveLevel: number;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
  /** Snapshots for rollback, newest last. */
  history: StorySnapshot[];
  /**
   * 周目 number, 1-based (M-I7). The second run of a script is 第 2 周目.
   * Absent on pre-I7 rows — read through `runOf()`, never as a bare number.
   */
  run?: number;
  /**
   * Named checkpoints the user chose to keep (存档槽, M-I7). A slot is a
   * user-blessed snapshot: restoring one is a rollback to its seq, so a slot
   * can only ever point BACKWARD from the run's current position. Bounded by
   * `MAX_SLOTS`.
   */
  slots?: StorySlot[];
  /** The ending node this run reached, set by `endRun`. Feeds the结局画廊. */
  endingId?: string;
  /** When the run ended (finished OR abandoned). */
  endedAt?: number;
  /**
   * Consecutive beats that threw (almost always an LLM timeout/rate-limit).
   * Reset to 0 by the first beat that completes. Absent on rows written before
   * M-G0 — read it through `stallsOf()`, never as a bare number.
   */
  stalls?: number;
  /**
   * Set once `stalls` crosses `MAX_STALLS`: the run stops chaining new beats
   * instead of burning one LLM call every STORY_TICK_MS forever. The run is
   * still `isActive` — it is paused, not ended, and the user can resume it.
   */
  stalledAt?: number;
  /**
   * The player decision the run is waiting on (V4). While set, the tick chain
   * does not schedule and a landed tick does nothing — the story is PAUSED,
   * deliberately, until the user taps an option on the chat page. The options
   * are snapshotted here (not re-read from the script) so an edited or deleted
   * script cannot re-point a decision the user is already looking at.
   */
  pendingChoice?: PendingChoice;
  /**
   * NG+ marker (V4): this run was started inheriting a finished run's outcome.
   * Feeds the opening narration ("上一周目走到了…") and the run-page badge.
   * The inherited VARS are already merged into `vars` by `makeSave` — this is
   * provenance, not state.
   */
  ngPlus?: { fromRun: number; endingId: string };
}

/** A choice waiting on the player, snapshotted onto the save row (V4). */
export interface PendingChoice {
  /** The node that owns the choice — where the run is standing. */
  nodeId: string;
  prompt: string;
  options: Choice['options'];
  /** When the wait began. */
  at: number;
}

/** Is this run parked on a player decision? */
export function hasPendingChoice(
  save: Pick<StorySaveRow, 'pendingChoice'>,
): boolean {
  return save.pendingChoice != null && Array.isArray(save.pendingChoice.options);
}

/** Consecutive-failure count for a save row, tolerating pre-M-G0 rows. */
export function stallsOf(save: Pick<StorySaveRow, 'stalls'>): number {
  return typeof save.stalls === 'number' && Number.isFinite(save.stalls) ? save.stalls : 0;
}

/** A paused run: still active, but no longer scheduling beats on its own. */
export function isStalled(save: Pick<StorySaveRow, 'stalledAt'>): boolean {
  return typeof save.stalledAt === 'number';
}

/** 周目 number for a save row, tolerating pre-I7 rows (they are run 1). */
export function runOf(save: Pick<StorySaveRow, 'run'>): number {
  return typeof save.run === 'number' && Number.isFinite(save.run) && save.run >= 1
    ? Math.floor(save.run)
    : 1;
}

/**
 * Clear a stalled run's strike state so the chain can be re-opened.
 *
 * Pure — the caller persists and re-schedules. Split this way because the
 * "schedule a fresh tick" half needs the scheduler (story-service), while
 * tests only care that the strikes actually reset.
 */
export function clearStall(save: StorySaveRow, now: number): StorySaveRow {
  const cleared = { ...save, stalls: 0, updatedAt: now };
  delete cleared.stalledAt;
  return cleared;
}

export interface StorySnapshot {
  seq: number;
  nodeId: string;
  vars: Vars;
  /** Newest message id at the moment of the snapshot. */
  msgCursor: number;
  at: number;
}

/**
 * A named checkpoint (存档槽, M-I7). Structurally a snapshot plus identity:
 * the state fields are copied out of the run at save time, NOT referenced into
 * `history` — history is bounded and pruned by rollback, and a slot the user
 * named must not silently die because the ring buffer moved on.
 */
export interface StorySlot {
  id: string;
  /** What the user called it（"表白之前" / "第二结局路线"…）. */
  name: string;
  seq: number;
  nodeId: string;
  vars: Vars;
  /** Newest message id when the slot was written — the rollback watermark. */
  msgCursor: number;
  at: number;
}

/** Slots per run. Enough for save-scumming, bounded so the row stays small. */
export const MAX_SLOTS = 12;

const SCRIPTS = 'story_scripts';
const SAVES = 'story_saves';

/* ==================================================================== */
/* Script storage                                                        */
/* ==================================================================== */

export async function listScripts(): Promise<StoryScriptRow[]> {
  const rows = await idbGetAll<StoryScriptRow>(SCRIPTS);
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getScript(id: string): Promise<Script | null> {
  const row = await idbGet<StoryScriptRow>(SCRIPTS, id);
  if (!row) return null;
  try {
    const parsed = validateScript(JSON.parse(row.dagJson));
    return parsed.script ?? null;
  } catch {
    return null;
  }
}

/**
 * Store a script. Validation is NOT optional — an invalid graph is rejected
 * here rather than stranding a run three scenes in.
 */
export async function saveScript(
  script: unknown,
  origin: StoryScriptRow['origin'],
  now: number,
): Promise<{ ok: true; id: string } | { ok: false; issues: string[] }> {
  const result = validateScript(script);
  if (!result.ok || !result.script) {
    return { ok: false, issues: result.issues.map((i) => i.message) };
  }
  const s = result.script;
  await idbPut<StoryScriptRow>(SCRIPTS, {
    id: s.scriptId,
    title: s.title,
    genre: s.genre,
    nsfwLevel: s.nsfwLevel,
    dagJson: JSON.stringify(s),
    createdAt: now,
    origin,
  });
  return { ok: true, id: s.scriptId };
}

export async function deleteScript(id: string): Promise<void> {
  await idbDelete(SCRIPTS, id);
}

/* ==================================================================== */
/* Save storage                                                          */
/* ==================================================================== */

export async function getSave(id: string): Promise<StorySaveRow | undefined> {
  return idbGet<StorySaveRow>(SAVES, id);
}

export async function listSaves(scriptId?: string): Promise<StorySaveRow[]> {
  // Narrowed by `byScript` when a script is named (M-I18). The index shipped
  // with the store in v6 and had ZERO readers until now — this call site did
  // getAll-then-filter, the exact pattern `bySubject` / `byStatus` / `byRp`
  // were caught in during M-G1. It stayed hidden because the guard meant to
  // catch it searched a corpus that included the file DECLARING the index, so
  // it matched the declaration and passed for everything.
  const rows = scriptId
    ? await idbGetAllByIndex<StorySaveRow>(SAVES, 'byScript', scriptId)
    : await idbGetAll<StorySaveRow>(SAVES);
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function putSave(save: StorySaveRow): Promise<void> {
  await idbPut(SAVES, save);
}

/** The run currently playing in a conversation, if any. */
export async function activeSaveFor(convId: string): Promise<StorySaveRow | undefined> {
  const rows = await idbGetAll<StorySaveRow>(SAVES);
  return rows.find((r) => r.isActive && r.convId === convId);
}

/* ==================================================================== */
/* Starting a run                                                        */
/* ==================================================================== */

export interface StartOptions {
  script: Script;
  convId: string;
  /** script charId → contactId. Missing entries make the run refuse to start. */
  bindings: Record<string, string>;
  globalTier: 'off' | 'ambiguous' | 'full';
  now: number;
  /** 周目 number (M-I7). Callers derive it via `nextRunNumber`; defaults to 1. */
  run?: number;
  /**
   * NG+ (V4): inherit a finished run's outcome. `vars` here are ALREADY
   * whitelisted by the caller (`carriedVars` — the script's `legacy.carry`
   * list); makeSave merges them over the script defaults and records the
   * provenance. Passing unfiltered vars is the bug the V4 test provokes.
   */
  inherit?: { fromRun: number; endingId: string; vars: Vars };
}

export function makeSave(opts: StartOptions): StorySaveRow {
  const { script, now } = opts;
  return {
    id: `save_${script.scriptId}_${now}`,
    scriptId: script.scriptId,
    nodeId: script.entry,
    vars: { ...script.vars, ...(opts.inherit?.vars ?? {}) },
    ...(opts.inherit
      ? { ngPlus: { fromRun: opts.inherit.fromRun, endingId: opts.inherit.endingId } }
      : {}),
    seq: 0,
    turnsInNode: 0,
    convId: opts.convId,
    bindings: opts.bindings,
    run: opts.run ?? 1,
    slots: [],
    // Snapshotted at start and never re-read (specs/story-gm.md): lowering the
    // global setting mid-run must not rewrite a story already in progress, and
    // raising it must not silently escalate one the user started at a lower tier.
    effectiveLevel: effectiveStoryLevel(opts.globalTier, script),
    isActive: true,
    createdAt: now,
    updatedAt: now,
    history: [],
  };
}

/** Every cast member must be bound to a real contact before a run can begin. */
export function missingBindings(script: Script, bindings: Record<string, string>): string[] {
  return script.cast.filter((c) => !bindings[c.charId]).map((c) => c.charId);
}

/* ==================================================================== */
/* The beat                                                              */
/* ==================================================================== */

export interface BeatPlan {
  node: StoryNode;
  /** Grey narration to post on entering this node, if any. */
  narrate?: string;
  /** Per-character directive text, keyed by REAL contactId. Isolated by design. */
  directives: Record<string, string>;
  /** One line for the director: what this beat is for. */
  goal: string;
  /** Set when this beat ends the run. */
  ending: boolean;
}

/** Build the beat for a save's current node. Pure. */
export function planBeat(script: Script, save: StorySaveRow): BeatPlan | null {
  const node = script.nodes.find((n) => n.id === save.nodeId);
  if (!node) return null;
  const directives: Record<string, string> = {};
  for (const d of node.directives) {
    const contactId = save.bindings[d.charId];
    if (!contactId) continue;
    // A role played by the USER (single-chat stories, V4) gets no directive —
    // the person acts for themselves, and printing their secret into any
    // prompt would hand it to the character opposite them.
    if (contactId === 'self') continue;
    const cast = script.cast.find((c) => c.charId === d.charId);
    const text = directiveTextFor(node, save.effectiveLevel, d);
    // The character's own secret rides along — and ONLY in their own prompt.
    directives[contactId] = cast?.secret ? `${text}\n（只有你知道：${cast.secret}）` : text;
  }
  return {
    node,
    narrate: node.onEnter?.narrate,
    directives,
    goal: node.goal,
    ending: node.ending === true,
  };
}

export interface AdvanceResult {
  save: StorySaveRow;
  /** The trigger that fired, if any. */
  fired?: Trigger;
  /** Triggers whose `llm:` condition still needs the GM's judgement. */
  pending: Trigger[];
  /** True when the run just moved to a different node. */
  moved: boolean;
  /** Side effects to materialize (the caller owns storage). */
  effects: { memWrite: Array<{ charId: string; fact: string }>; moment?: { authorId: string; text: string } };
}

/**
 * Advance the run one turn: evaluate local triggers, else count toward timeout.
 *
 * Pure. It decides; the caller materializes. That split is what lets the whole
 * graph walk — including rollback — be tested without a database.
 *
 * `msgCursor` is the newest message id in the run's conversation at this
 * moment. It rides into the snapshot a move takes, and the snapshot is what
 * rollback trims the transcript back to — a cursor of 0 (the pre-I7 default)
 * means "this snapshot cannot trim messages", never "trim everything".
 */
export function advance(
  script: Script,
  save: StorySaveRow,
  now: number,
  msgCursor = 0,
): AdvanceResult {
  const node = script.nodes.find((n) => n.id === save.nodeId);
  const none = { memWrite: [], moment: undefined } as AdvanceResult['effects'];
  if (!node) return { save, pending: [], moved: false, effects: none };

  const { fired, pending } = evaluateTriggers(node, save.vars);
  if (fired)
    return { ...applyTrigger(save, fired, now, msgCursor), fired, pending: [], moved: true };

  const turns = save.turnsInNode + 1;
  if (node.timeout && turns >= node.timeout.turns) {
    // The forced exit. Without it a beat whose condition never comes true traps
    // the run silently — the story just stops responding and nothing says why.
    const timed: Trigger = { when: 'expr:false', to: node.timeout.to };
    return { ...applyTrigger(save, timed, now, msgCursor), fired: timed, pending: [], moved: true };
  }
  return {
    save: { ...save, turnsInNode: turns, updatedAt: now },
    pending,
    moved: false,
    effects: none,
  };
}

/* ==================================================================== */
/* The `llm:` trigger track                                              */
/* ==================================================================== */

/**
 * Judging soft conditions (M-G0).
 *
 * `specs/story-gm.md` specifies two trigger tracks: `expr:` evaluated locally,
 * and `llm:` judged by the GM for things no expression can express ("访客终于
 *说出了实话"). `evaluateTriggers` has always returned the `llm:` ones in a
 * `pending` array and `advance` has always passed it through — and NOTHING in
 * the app ever read it. Every soft condition was a silently discarded edge, so
 * a script that leaned on them just sat in its opening beat until the timeout.
 *
 * The prompt/parse pair is pure so the判定 is testable without a model; the
 * call itself is injected (`StoryHooks.judgeTriggers`), because it carries the
 * conversation transcript and therefore has to route on the conversation's
 * tier, not on the story engine's opinion (constitution rule #6).
 */
export function judgePrompt(goal: string, recent: string, pending: Trigger[]): string {
  const options = pending.map((t, i) => `${i + 1}. ${parseWhen(t.when).kind === 'llm' ? t.when.trim().slice(4).trim() : t.when}`);
  return [
    '你是这场戏的导演，要判断剧情是否可以推进。',
    '',
    `本幕的目标：${goal}`,
    '',
    '刚刚发生的对话：',
    recent || '（还没有对话）',
    '',
    '下面是可能的推进条件，逐条判断哪一条已经**在上面的对话里真实发生**：',
    ...options,
    '',
    '只回一个数字：满足的那一条的编号；如果都还没发生，回 0。不要解释。',
  ].join('\n');
}

/**
 * Parse the GM's verdict. Conservative by construction: anything that is not
 * an in-range index means "not yet".
 *
 * That default matters. A misparse that advances the story skips a beat the
 * author wrote and can strand `vars` the later nodes depend on; a misparse that
 * waits costs one more turn and then hits the node's `timeout`, which is the
 * exit the author already designed for exactly this case.
 */
export function parseJudgement(text: string, pending: Trigger[]): Trigger | undefined {
  const m = /-?\d+/.exec(text ?? '');
  if (!m) return undefined;
  const idx = Number(m[0]);
  if (!Number.isInteger(idx) || idx < 1 || idx > pending.length) return undefined;
  return pending[idx - 1];
}

/** Move to a trigger's destination, snapshotting first. Pure. */
export function applyTrigger(
  save: StorySaveRow,
  trigger: Trigger,
  now: number,
  msgCursor = 0,
): { save: StorySaveRow; effects: AdvanceResult['effects'] } {
  const seq = save.seq + 1;
  const snapshot: StorySnapshot = {
    seq: save.seq,
    nodeId: save.nodeId,
    vars: { ...save.vars },
    msgCursor,
    at: now,
  };
  return {
    save: {
      ...save,
      nodeId: trigger.to,
      vars: applyVarEffects(save.vars, trigger.effects),
      seq,
      turnsInNode: 0,
      updatedAt: now,
      // Bounded: 50 beats of history is more than any script this app will run,
      // and an unbounded array in a row read on every tick grows without limit.
      history: [...save.history, snapshot].slice(-50),
    },
    effects: {
      memWrite: trigger.effects?.memWrite ?? [],
      moment: trigger.effects?.moment,
    },
  };
}

/* ==================================================================== */
/* Player choices (V4)                                                   */
/* ==================================================================== */

/**
 * Park the run on a node's choice. Pure — the caller persists and stops the
 * tick chain (which `chainNextBeat` does by reading `pendingChoice`).
 */
export function openChoice(save: StorySaveRow, node: StoryNode, now: number): StorySaveRow {
  const c = node.choice;
  if (!c) return save;
  return {
    ...save,
    pendingChoice: {
      nodeId: node.id,
      prompt: c.prompt,
      // Copied, not referenced: the save row must stay meaningful even if the
      // script row is edited or deleted while the user thinks it over.
      options: c.options.map((o) => ({ label: o.label, setVars: o.setVars, goto: o.goto })),
      at: now,
    },
    updatedAt: now,
  };
}

/**
 * Apply the player's pick: snapshot, land `setVars`, move to `goto`, clear the
 * wait. Pure; structurally an `applyTrigger` whose trigger is the user's tap —
 * which is exactly what makes a choice replayable and rollback-able like every
 * other move. `msgCursor` is captured BEFORE the「选择」line lands, so rolling
 * back to this beat later returns to the un-chosen moment and asks again.
 */
export function applyChoiceOption(
  save: StorySaveRow,
  optionIndex: number,
  now: number,
  msgCursor = 0,
): { save: StorySaveRow; effects: AdvanceResult['effects'] } | null {
  const pc = save.pendingChoice;
  if (!pc) return null;
  const opt = pc.options[optionIndex];
  if (!opt) return null;
  const stepped = applyTrigger(
    save,
    { when: 'choice', to: opt.goto, effects: opt.setVars ? { vars: opt.setVars } : undefined },
    now,
    msgCursor,
  );
  const cleared = { ...stepped.save };
  delete cleared.pendingChoice;
  return { save: cleared, effects: stepped.effects };
}

/* ==================================================================== */
/* Side effects (the part rollback has to be able to undo)               */
/* ==================================================================== */

/**
 * Story-caused rows carry this tag so rollback can find every one of them.
 *
 * The namespace is the RUN (save id), not the script (M-I7). It used to be the
 * script id, which made two runs of the same script indistinguishable: rolling
 * back 第 2 周目 deleted 第 1 周目's memories and Moments posts too, because
 * `demo#3` said nothing about which playthrough wrote it. Multi-run is only
 * safe because every side effect now carries its own run's namespace.
 */
export function storyTag(runNs: string, seq: number): string {
  return `${runNs}#${seq}`;
}

/** The beat counter parsed out of a story tag, or undefined for a bad tag. */
export function seqOfTag(tag: string | undefined): number | undefined {
  if (!tag) return undefined;
  const at = tag.lastIndexOf('#');
  if (at <= 0) return undefined;
  const seq = Number(tag.slice(at + 1));
  return Number.isFinite(seq) ? seq : undefined;
}

export interface MaterializeDeps {
  putMemory: (f: MemoryFactVM) => Promise<void>;
  putMoment: (m: MomentVM) => Promise<void>;
}

/**
 * Write a beat's side effects, each tagged with `(scriptId, seq)`.
 *
 * The tag is not bookkeeping — it is the ONLY thing that makes rollback
 * possible. An untagged story-written fact is indistinguishable from something
 * the user actually said, and would survive a rollback forever.
 */
export async function materializeEffects(
  save: StorySaveRow,
  effects: AdvanceResult['effects'],
  bindings: Record<string, string>,
  now: number,
  deps: MaterializeDeps,
): Promise<void> {
  // Namespaced by the RUN — see `storyTag` for why the script id was not enough.
  const tag = storyTag(save.id, save.seq);
  for (const [i, w] of effects.memWrite.entries()) {
    const subjectId = bindings[w.charId] ?? w.charId;
    await deps.putMemory({
      id: `story_${tag}_${i}`,
      subjectId,
      fact: w.fact.slice(0, 50),
      importance: 4,
      sensitivity: 'normal',
      evidenceMsgIds: [],
      status: 'confirmed',
      isPinned: false,
      createdAt: now,
      source: 'story',
      confidence: 1,
      refCount: 0,
      storySaveId: save.id,
      storyTag: tag,
    } as MemoryFactVM);
  }
  if (effects.moment) {
    await deps.putMoment({
      id: `story_moment_${tag}`,
      authorId: bindings[effects.moment.authorId] ?? effects.moment.authorId,
      text: effects.moment.text,
      imageRefs: [],
      isNsfw: false,
      createdAt: now,
      storySaveId: save.id,
      storyTag: tag,
    } as MomentVM);
  }
}

/* ==================================================================== */
/* Rollback                                                              */
/* ==================================================================== */

export interface RollbackResult {
  save: StorySaveRow;
  /** Memory facts retracted. */
  memoryRemoved: string[];
  /** Moments posts retracted. */
  momentsRemoved: string[];
  /**
   * Message ids trimmed off the conversation's tail (M-I7). Deleted, leaving
   * rowid holes — NEVER re-timestamped or re-packed: `rowid order == time
   * order` is a constitution invariant, and rewriting `createdAt` to close the
   * gap would be exactly the timestamp inversion it forbids.
   */
  messagesRemoved: number[];
}

/**
 * What a rollback WOULD do — the exact rows, before anything is touched.
 *
 * Shared by the executor (`rollbackTo`) and the dry-run (`planRollback`), so
 * the preview the user confirms and the deletion that then happens can never
 * disagree: they are the same query.
 */
async function collectCascade(
  save: StorySaveRow,
  restoredSeq: number,
  msgCursor: number | undefined,
): Promise<{
  facts: Array<MemoryFactVM & { storyTag?: string }>;
  moments: Array<MomentVM & { storyTag?: string }>;
  messageIds: number[];
}> {
  const facts = (await idbGetAll<MemoryFactVM & { storyTag?: string }>('memory_facts')).filter(
    (f) => isFromRunLaterBeat(f, save, restoredSeq),
  );
  const moments = (await idbGetAll<MomentVM & { storyTag?: string }>('moments')).filter((m) =>
    isFromRunLaterBeat(m, save, restoredSeq),
  );
  // Two independent reasons a message dies, unioned (V4):
  //
  //  - **Watermark**: id past the snapshot's cursor. Catches EVERYTHING after
  //    the restore point, ordinary interjections included — a scene un-happens
  //    whole. A cursor of 0/undefined means the snapshot predates cursor
  //    recording (pre-I7 rows, or a run whose conversation was empty at
  //    start); trimming to 0 would delete the entire thread, so the watermark
  //    contributes nothing for those.
  //  - **Act stamp**: `storySeq > restoredSeq` — the column that had writers
  //    since I7 and, until V4, zero readers. This is what makes 按幕裁剪 real
  //    for zero-cursor snapshots: the undone beats' lines still go, even when
  //    the watermark cannot help. Scoped to THIS run by script id + the run's
  //    own time window, because a second 周目 of the same script in the same
  //    conversation re-counts seq from 0 and must never reach back into the
  //    first one's transcript (`createdAt >= save.createdAt` is that fence).
  const messageIds: number[] = [];
  const rows = await idbGetAllByIndex<{
    id: number;
    createdAt: number;
    storyScriptId?: string;
    storySeq?: number;
  }>('messages', 'byConv', save.convId);
  for (const r of rows) {
    if (typeof r.id !== 'number') continue;
    const pastWatermark = msgCursor != null && msgCursor > 0 && r.id > msgCursor;
    const laterAct =
      r.storyScriptId === save.scriptId &&
      typeof r.storySeq === 'number' &&
      r.storySeq > restoredSeq &&
      r.createdAt >= save.createdAt;
    if (pastWatermark || laterAct) messageIds.push(r.id);
  }
  return { facts, moments, messageIds };
}

/** The dry-run's answer: what would be undone, with enough detail to show. */
export interface RollbackPlan {
  /** The seq the run would land on (snapshot floor of the requested target). */
  restoredSeq: number;
  /** Whether messages can be trimmed at all (a real watermark exists). */
  trimsMessages: boolean;
  memory: Array<{ id: string; fact: string }>;
  moments: Array<{ id: string; text?: string }>;
  messageCount: number;
  /** Named slots that would die because they point past the restored seq. */
  slotsLost: string[];
}

/**
 * Preview a rollback without performing it (M-I7).
 *
 * The confirm dialog used to say "会被一并撤销" in the abstract; this makes it
 * concrete — the exact counts and the memories by name — because agreeing to
 * lose "3 条记忆" is different from agreeing to lose "那个雨夜的访客其实是旧识".
 */
export async function planRollback(save: StorySaveRow, targetSeq: number): Promise<RollbackPlan> {
  const snapshot = [...save.history].reverse().find((h) => h.seq <= targetSeq);
  const restoredSeq = snapshot ? snapshot.seq : save.seq;
  const { facts, moments, messageIds } = await collectCascade(save, restoredSeq, snapshot?.msgCursor);
  return {
    restoredSeq,
    // V4: the act stamp can trim story lines even under a zero-cursor
    // snapshot, so "does anything get cut" is answered by the actual row set,
    // not by whether a watermark exists.
    trimsMessages: (snapshot?.msgCursor ?? 0) > 0 || messageIds.length > 0,
    memory: facts.map((f) => ({ id: f.id, fact: f.fact })),
    moments: moments.map((m) => ({ id: m.id, text: m.text })),
    messageCount: messageIds.length,
    slotsLost: (save.slots ?? []).filter((s) => s.seq > restoredSeq).map((s) => s.name),
  };
}

/**
 * Preview a slot restore (V4). Same rule as `planRollback` — the preview runs
 * the SAME query the execution will — but against the slot's OWN restore
 * point, because that is what `restoreSlot` now lands on. Previewing through
 * `planRollback(save, slot.seq)` would quote the nearest history snapshot's
 * watermark and disagree with the deletion that then happens.
 */
export async function planSlotRestore(
  save: StorySaveRow,
  slotId: string,
): Promise<RollbackPlan | null> {
  const slot = (save.slots ?? []).find((s) => s.id === slotId);
  if (!slot || !canRestoreSlot(save, slot)) return null;
  const { facts, moments, messageIds } = await collectCascade(save, slot.seq, slot.msgCursor);
  return {
    restoredSeq: slot.seq,
    trimsMessages: slot.msgCursor > 0 || messageIds.length > 0,
    memory: facts.map((f) => ({ id: f.id, fact: f.fact })),
    moments: moments.map((m) => ({ id: m.id, text: m.text })),
    messageCount: messageIds.length,
    slotsLost: (save.slots ?? []).filter((s) => s.seq > slot.seq).map((s) => s.name),
  };
}

/**
 * Restore a save to an earlier beat, retracting everything the undone beats did.
 *
 * The cascade is the whole point. Restoring only the cursor leaves a character
 * remembering something that, after the rollback, never happened — and unlike
 * everything else in story mode, that contamination escapes into ordinary chat
 * and cannot be undone by playing on. Anything this RUN wrote with a seq
 * greater than the target is removed, unconditionally, across all three
 * surfaces: memory, Moments, and (M-I7) the transcript itself.
 */
export async function rollbackTo(
  save: StorySaveRow,
  targetSeq: number,
  now: number,
): Promise<RollbackResult> {
  const snapshot = [...save.history].reverse().find((h) => h.seq <= targetSeq);
  return performRestore(save, snapshot, now);
}

/**
 * The state a restore lands on. Two producers: a `history` snapshot (rollback
 * to a past beat) and a 存档槽's OWN captured state (读档, V4) — structurally
 * the same thing, and sharing the executor is what fixed the slot bug: the
 * slot used to be translated into "the nearest history snapshot ≤ its seq",
 * which both ignored the slot's msgCursor AND — when the run had not moved
 * since the slot was written — landed one act EARLIER than the slot itself.
 */
interface RestorePoint {
  seq: number;
  nodeId: string;
  vars: Vars;
  msgCursor: number;
}

async function performRestore(
  save: StorySaveRow,
  point: RestorePoint | undefined,
  now: number,
): Promise<RollbackResult> {
  const restored: StorySaveRow = point
    ? {
        ...save,
        nodeId: point.nodeId,
        vars: { ...point.vars },
        seq: point.seq,
        turnsInNode: 0,
        updatedAt: now,
        // Snapshots at the point's seq or later describe departures from the
        // deleted future (h.seq === point.seq is "how the run LEFT this beat"
        // — a move that just un-happened).
        history: save.history.filter((h) => h.seq < point.seq),
        // Slots pointing INTO the deleted future are dead: their seq no longer
        // exists on this timeline and their msgCursor names trimmed rows.
        slots: (save.slots ?? []).filter((s) => s.seq <= point.seq),
      }
    : { ...save, updatedAt: now };
  if (point) {
    // A wait belonging to a rolled-away moment must not survive; if the
    // restored node itself carries a choice, the next beat re-opens it.
    delete restored.pendingChoice;
  }

  // Every story-tagged row from a later beat OF THIS RUN, across all surfaces.
  // Missing one surface is exactly the failure the tests deliberately provoke.
  // The transcript is trimmed by WATERMARK plus (V4) the per-message ACT STAMP:
  // the undone scenes contain the user's own lines too, and a scene that
  // "un-happens" with the user's half still standing reads like everyone else
  // developed amnesia. Deletion leaves rowid holes; the surviving rows keep
  // their ids and timestamps byte-for-byte (rowid order == time order, §3).
  const { facts, moments, messageIds } = await collectCascade(
    save,
    restored.seq,
    point?.msgCursor,
  );

  const memoryRemoved: string[] = [];
  const momentsRemoved: string[] = [];
  const messagesRemoved: number[] = [];
  for (const f of facts) {
    await repo.deleteMemory(f.id);
    memoryRemoved.push(f.id);
  }
  for (const m of moments) {
    await idbDelete('moments', m.id);
    momentsRemoved.push(m.id);
  }
  for (const id of messageIds) {
    await repo.deleteMessage(id);
    messagesRemoved.push(id);
  }

  await putSave(restored);
  return { save: restored, memoryRemoved, momentsRemoved, messagesRemoved };
}

/* ==================================================================== */
/* Run traces (what a playthrough left behind)                           */
/* ==================================================================== */

export interface RunTraces {
  /** Story-written memory rows still standing, oldest first. */
  facts: Array<MemoryFactVM & { storyTag?: string }>;
  /** Story-caused Moments posts still standing, oldest first. */
  moments: Array<MomentVM & { storyTag?: string }>;
  /** Stamped transcript lines still in the conversation. */
  messageCount: number;
}

/**
 * Everything this run has written that is still standing (M-I7) — the "这一轮
 * 的痕迹" panel. Memory and Moments resolve exactly (run-namespaced tags);
 * messages resolve by script stamp within the run's own conversation and time
 * window, because the message columns are the M1 schema pair (script id + seq)
 * and deliberately stay that way — the watermark, not the stamp, is what
 * rollback trims by, so the stamp only ever feeds bookkeeping like this.
 */
export async function collectRunTraces(save: StorySaveRow): Promise<RunTraces> {
  const { facts, moments } = await collectCascade(save, -1, undefined);
  const rows = await idbGetAllByIndex<{
    id: number;
    storyScriptId?: string;
    createdAt: number;
  }>('messages', 'byConv', save.convId);
  const messageCount = rows.filter(
    (m) => m.storyScriptId === save.scriptId && m.createdAt >= save.createdAt,
  ).length;
  return {
    facts: facts.sort((a, b) => a.createdAt - b.createdAt),
    moments: moments.sort((a, b) => a.createdAt - b.createdAt),
    messageCount,
  };
}

/** Was this row written by a beat later than the one we are rolling back to? */
export function isFromLaterBeat(
  tag: string | undefined,
  runNs: string,
  targetSeq: number,
): boolean {
  if (!tag) return false;
  const at = tag.lastIndexOf('#');
  if (at <= 0) return false;
  if (tag.slice(0, at) !== runNs) return false;
  const seq = seqOfTag(tag);
  return seq !== undefined && seq > targetSeq;
}

/**
 * Does this persisted row belong to a later beat OF THIS RUN?
 *
 * Two ways to belong, because two eras of rows exist: post-I7 rows carry a tag
 * namespaced by the save id; pre-I7 rows were tagged by script id but always
 * carried `storySaveId` — so the save-id column plus the tag's seq identifies
 * them exactly. Neither path ever matches a DIFFERENT run of the same script.
 */
export function isFromRunLaterBeat(
  row: { storyTag?: string; storySaveId?: string },
  save: Pick<StorySaveRow, 'id'>,
  targetSeq: number,
): boolean {
  if (isFromLaterBeat(row.storyTag, save.id, targetSeq)) return true;
  if (row.storySaveId !== save.id) return false;
  const seq = seqOfTag(row.storyTag);
  return seq !== undefined && seq > targetSeq;
}

/* ==================================================================== */
/* Save slots (存档槽, M-I7)                                             */
/* ==================================================================== */

/**
 * Write a named slot capturing the run's CURRENT position. Pure — returns the
 * updated row; the caller persists it. `msgCursor` is the newest message id in
 * the conversation right now, captured by the impure seam.
 */
export function writeSlot(
  save: StorySaveRow,
  name: string,
  msgCursor: number,
  now: number,
): { save: StorySaveRow; slot: StorySlot } {
  const slot: StorySlot = {
    id: `slot_${save.id}_${now}`,
    name: name.trim().slice(0, 20) || `第 ${save.seq} 幕`,
    seq: save.seq,
    nodeId: save.nodeId,
    vars: { ...save.vars },
    msgCursor,
    at: now,
  };
  // Newest last, bounded: the OLDEST slot falls off, because the newest is the
  // one the user just deliberately made.
  const slots = [...(save.slots ?? []), slot].slice(-MAX_SLOTS);
  return { save: { ...save, slots, updatedAt: now }, slot };
}

/** Remove one slot by id. Pure. */
export function dropSlot(save: StorySaveRow, slotId: string, now: number): StorySaveRow {
  return {
    ...save,
    slots: (save.slots ?? []).filter((s) => s.id !== slotId),
    updatedAt: now,
  };
}

/**
 * Can this slot be restored right now? A slot is a rollback target, so it must
 * lie at or before the run's current seq — after a rollback past it, the slot
 * describes a branch of the timeline that no longer exists.
 */
export function canRestoreSlot(save: StorySaveRow, slot: StorySlot): boolean {
  return slot.seq <= save.seq;
}

/**
 * Restore a slot: land on the slot's OWN captured state — seq, node, vars and
 * msgCursor all come from the slot, not from the nearest history snapshot
 * (V4 fix). The old delegation to `rollbackTo(save, slot.seq)` had two real
 * consequences: the slot's msgCursor was never read (a slot saved mid-beat
 * restored the transcript to wherever the previous MOVE left it), and when the
 * run had not moved since the slot was written, the newest snapshot with
 * `seq <= slot.seq` was the one for seq-1 — 读档多回退一幕. The slot itself
 * survives (restoring a checkpoint should not consume it — that is the whole
 * point of a checkpoint).
 */
export async function restoreSlot(
  save: StorySaveRow,
  slotId: string,
  now: number,
): Promise<RollbackResult | { error: string }> {
  const slot = (save.slots ?? []).find((s) => s.id === slotId);
  if (!slot) return { error: '存档槽不存在' };
  if (!canRestoreSlot(save, slot)) return { error: '这个存档在已被回滚掉的时间线上，无法读取' };
  return performRestore(
    save,
    { seq: slot.seq, nodeId: slot.nodeId, vars: slot.vars, msgCursor: slot.msgCursor },
    now,
  );
}

/**
 * End a run. The save stays (it is a record), it simply stops being active.
 * `endingId` names the ending node reached — the结局画廊 unlocks from it; an
 * abandoned run (user pressed 结束) ends without one.
 */
export async function endRun(
  save: StorySaveRow,
  now: number,
  endingId?: string,
): Promise<StorySaveRow> {
  const ended: StorySaveRow = {
    ...save,
    isActive: false,
    updatedAt: now,
    endedAt: now,
    ...(endingId ? { endingId } : {}),
  };
  await putSave(ended);
  return ended;
}
