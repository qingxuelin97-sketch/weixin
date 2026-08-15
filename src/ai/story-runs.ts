/**
 * Runs, casting and the结局画廊 (M-I7) — the pure logic under the story UI.
 *
 * Three concerns share this file because they are three views of the same
 * thing, "a script played more than once by more than one possible cast":
 *
 *  1. **Casting** — the explicit 角色→persona mapping. Until I7 the start
 *     button bound `cast[i]` to `memberIds[i]` — BY ARRAY POSITION. That was a
 *     bug wearing a feature's clothes: reordering a group's member list (or a
 *     roster patch from删人) silently recast the whole play, handing the
 *     detective's secret to whoever happened to be first in the array. Binding
 *     is now an explicit map the user confirms, and every helper here is
 *     order-independent by construction — the red test shuffles the member
 *     array and asserts the binding does not move.
 *
 *  2. **周目 (multi-run)** — run numbering and per-run namespacing. The save
 *     row carries `run`; side-effect tags are namespaced by save id (see
 *     `storyTag`), so playthroughs never bleed into each other.
 *
 *  3. **结局画廊** — which of a script's endings each run reached. Derived
 *     entirely from ended saves; nothing new is persisted for it.
 *
 * Everything here is pure: no clock, no storage, no LLM (constitution rule 4
 * — the UI injects `now`, and nothing here needs randomness at all).
 */
import type { Script, StoryNode } from './story-script';
import { runOf, type StorySaveRow } from './story-gm';

/* ==================================================================== */
/* Casting                                                               */
/* ==================================================================== */

export interface CastingIssue {
  code: 'unbound' | 'duplicate' | 'not_a_member' | 'unknown_char';
  message: string;
  charId?: string;
}

/**
 * Validate an explicit binding against the script and the chosen stage.
 *
 * Everything the start button must refuse: a role nobody plays, one actor in
 * two roles (their two secrets would meet in one prompt — the exact isolation
 * the GM exists to preserve), an actor who is not in the group, and a binding
 * for a role the script does not have (a stale row from an edited script).
 */
export function validateBindings(
  script: Script,
  bindings: Record<string, string>,
  memberIds: string[],
): CastingIssue[] {
  const issues: CastingIssue[] = [];
  const members = new Set(memberIds);
  const castIds = new Set(script.cast.map((c) => c.charId));

  for (const c of script.cast) {
    if (!bindings[c.charId]) {
      issues.push({
        code: 'unbound',
        message: `「${c.role}」还没有人演`,
        charId: c.charId,
      });
    }
  }

  const seen = new Map<string, string>();
  for (const [charId, contactId] of Object.entries(bindings)) {
    if (!castIds.has(charId)) {
      issues.push({
        code: 'unknown_char',
        message: `绑定指向剧本里没有的角色：${charId}`,
        charId,
      });
      continue;
    }
    if (!members.has(contactId)) {
      issues.push({
        code: 'not_a_member',
        message: `扮演「${roleNameOf(script, charId)}」的人不在这个群里`,
        charId,
      });
    }
    const prior = seen.get(contactId);
    if (prior) {
      issues.push({
        code: 'duplicate',
        message: `一个人不能同时演「${roleNameOf(script, prior)}」和「${roleNameOf(script, charId)}」`,
        charId,
      });
    } else {
      seen.set(contactId, charId);
    }
  }
  return issues;
}

/** A role's display name, falling back to the char id. */
export function roleNameOf(script: Script, charId: string): string {
  return script.cast.find((c) => c.charId === charId)?.role ?? charId;
}

/**
 * Suggest a default binding for the casting sheet.
 *
 * Deterministic and ORDER-INDEPENDENT: cast in script order, members sorted by
 * contact id — so shuffling the group's member array (which happens naturally
 * as rosters get patched) produces the byte-same suggestion. The suggestion is
 * only a starting point; the user confirms or reassigns in the sheet, and the
 * run stores the explicit map.
 */
export function suggestBindings(script: Script, memberIds: string[]): Record<string, string> {
  const pool = [...new Set(memberIds)].sort();
  const bindings: Record<string, string> = {};
  for (const c of script.cast) {
    const pick = pool.shift();
    if (!pick) break; // not enough members — validateBindings will say so
    bindings[c.charId] = pick;
  }
  return bindings;
}

/**
 * Reassign one role. Pure helper for the sheet's picker: choosing an actor who
 * already plays another role SWAPS the two roles rather than silently creating
 * the duplicate `validateBindings` would then reject — that is what a person
 * tapping "让她来演" actually means when "她" is already on stage.
 */
export function assignRole(
  bindings: Record<string, string>,
  charId: string,
  contactId: string,
): Record<string, string> {
  const next = { ...bindings };
  const displaced = Object.entries(next).find(([k, v]) => v === contactId && k !== charId);
  if (displaced) {
    const mine = next[charId];
    if (mine) next[displaced[0]] = mine;
    else delete next[displaced[0]];
  }
  next[charId] = contactId;
  return next;
}

/* ==================================================================== */
/* 周目 (multi-run)                                                      */
/* ==================================================================== */

/**
 * The run number the NEXT playthrough of this script gets: one past the
 * highest existing run, counting ended runs too — 第 2 周目 stays 第 2 周目
 * even after 第 1 周目's save row is the only other one left.
 */
export function nextRunNumber(saves: StorySaveRow[], scriptId: string): number {
  let max = 0;
  for (const s of saves) {
    if (s.scriptId !== scriptId) continue;
    max = Math.max(max, runOf(s));
  }
  return max + 1;
}

/** Saves of one script, newest run first — the 周目 list on the detail page. */
export function runsOf(saves: StorySaveRow[], scriptId: string): StorySaveRow[] {
  return saves
    .filter((s) => s.scriptId === scriptId)
    .sort((a, b) => runOf(b) - runOf(a) || b.createdAt - a.createdAt);
}

/** Human-readable run state, used by both list rows and the run page header. */
export function runStateLabel(save: StorySaveRow): string {
  if (save.isActive) return save.stalledAt ? '已暂停' : '进行中';
  return save.endingId ? '已完结' : '已中止';
}

/* ==================================================================== */
/* 结局画廊                                                              */
/* ==================================================================== */

export interface GalleryEntry {
  node: StoryNode;
  /** Runs (of this script) that reached this ending, oldest first. */
  reachedBy: Array<{ run: number; at: number; saveId: string }>;
  unlocked: boolean;
}

/**
 * The gallery: every ending the script defines, and which runs earned it.
 *
 * Locked endings surface as "？？？" in the UI — the gallery must tempt, not
 * spoil. Derivation only; an ending is "reached" exactly when an ended save
 * recorded it via `endRun(save, now, endingId)`.
 */
export function galleryFor(script: Script, saves: StorySaveRow[]): GalleryEntry[] {
  const endings = script.nodes.filter((n) => n.ending);
  const byEnding = new Map<string, GalleryEntry['reachedBy']>();
  for (const s of saves) {
    if (s.scriptId !== script.scriptId || !s.endingId) continue;
    const list = byEnding.get(s.endingId) ?? [];
    list.push({ run: runOf(s), at: s.endedAt ?? s.updatedAt, saveId: s.id });
    byEnding.set(s.endingId, list);
  }
  return endings.map((node) => {
    const reachedBy = (byEnding.get(node.id) ?? []).sort((a, b) => a.at - b.at);
    return { node, reachedBy, unlocked: reachedBy.length > 0 };
  });
}

/** `2/3 结局已解锁` for the script list row. */
export function gallerySummary(entries: GalleryEntry[]): string {
  const unlocked = entries.filter((e) => e.unlocked).length;
  return `${unlocked}/${entries.length} 结局已解锁`;
}
