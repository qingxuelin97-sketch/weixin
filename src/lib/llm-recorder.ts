/**
 * Opt-in LLM exchange recorder (M-C1). Real-key usage is the only place真实
 * model behavior shows up — recordings become the corpus that parseBubbles
 * hardening and memory-extraction accuracy work (M-C4) run against.
 *
 * Constitution rule #2 containment: entries hold ONLY request/response bodies
 * (model + messages + text). Never headers, never the Authorization key — the
 * key does not appear in any recorded field by construction. Storage is local
 * (localStorage ring buffer); export is a manual user action.
 *
 * Timing uses Date.now() deliberately: this is diagnostics, not engine or
 * replayable logic (rule #4 scopes the ban to those).
 */

export interface LlmExchange {
  /** Wall-clock ms, diagnostics only. */
  at: number;
  providerId: string;
  providerKind: string;
  model: string;
  latencyMs: number;
  request: Array<{ role: string; content: string }>;
  /** Response text (present on success). */
  text?: string;
  finishReason?: string | null;
  /** Normalized error message (present on failure). */
  error?: string;
}

const DATA_KEY = 'aiwx_llm_recordings';
const FLAG_KEY = 'aiwx_llm_recording_on';
const MAX_ENTRIES = 100;

const storage = (): Storage | null =>
  typeof localStorage === 'undefined' ? null : localStorage;

export function isRecordingEnabled(): boolean {
  return storage()?.getItem(FLAG_KEY) === '1';
}

export function setRecordingEnabled(on: boolean): void {
  const s = storage();
  if (!s) return;
  if (on) s.setItem(FLAG_KEY, '1');
  else s.removeItem(FLAG_KEY);
}

export function getRecordings(): LlmExchange[] {
  const s = storage();
  if (!s) return [];
  try {
    return JSON.parse(s.getItem(DATA_KEY) ?? '[]') as LlmExchange[];
  } catch {
    return [];
  }
}

export function clearRecordings(): void {
  storage()?.removeItem(DATA_KEY);
}

/**
 * Containment (CLAUDE.md hidden-conversation rule): AI↔AI hidden-DM traffic
 * must never reach a user-visible surface, and the recording export IS one.
 * The provider tap has no conversation identity, so the DM runner brackets its
 * calls with this counter and the tap drops everything inside the window.
 * (A concurrent user chat inside that window is skipped too — an acceptable
 * loss; leaking a hidden DM is not.)
 */
let suppressDepth = 0;
export function beginRecordingSuppression(): void {
  suppressDepth++;
}
export function endRecordingSuppression(): void {
  suppressDepth = Math.max(0, suppressDepth - 1);
}

/** No-op unless the user turned recording on — zero cost on the hot path. */
export function recordLlmExchange(entry: Omit<LlmExchange, 'at'>): void {
  if (suppressDepth > 0) return;
  if (!isRecordingEnabled()) return;
  const s = storage();
  if (!s) return;
  const all = getRecordings();
  all.push({ at: Date.now(), ...entry });
  // Ring buffer by count, then by quota: drop oldest until the write fits.
  let trimmed = all.slice(-MAX_ENTRIES);
  for (;;) {
    try {
      s.setItem(DATA_KEY, JSON.stringify(trimmed));
      return;
    } catch {
      if (trimmed.length <= 1) return; // storage full beyond help; drop silently
      trimmed = trimmed.slice(Math.ceil(trimmed.length / 4));
    }
  }
}

export function serializeRecordings(): string {
  return JSON.stringify(getRecordings(), null, 2);
}
