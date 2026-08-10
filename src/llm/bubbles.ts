/**
 * Parse an AI turn into playable bubbles. Models are asked to emit NDJSON (one
 * JSON bubble per line) OR a JSON array; both are accepted, plus a plain-text
 * fallback so a non-conforming model still produces *a* message rather than an error.
 *
 * A JSON/schema parse failure is itself a refusal signal upstream (see router),
 * but here we always try to salvage a usable bubble.
 */
import { BubbleSchema, type Bubble } from './types';

const MAX_BUBBLES = 8;

/** Extract balanced JSON objects/arrays from arbitrary text (tolerates code fences, prose). */
function stripFences(text: string): string {
  return text
    .replace(/^\s*```(?:json|ndjson)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

/**
 * JSON has null; the schema's optional fields do not accept it. A model that
 * emits `{"type":"voice","content":"…","emotion":null}` — which they do, all the
 * time, because "no emotion" is naturally null — failed validation and fell into
 * the repair path below, which rebuilt it as a plain TEXT bubble. Voice, sticker
 * and image bubbles were being silently downgraded by a null in a field nobody
 * needed. Dropping null-valued keys before validation is the whole fix.
 */
function dropNulls(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v !== null) out[k] = v;
  }
  return out;
}

function coerceBubble(raw: unknown): Bubble | null {
  const parsed = BubbleSchema.safeParse(dropNulls(raw));
  if (parsed.success) return clampBubble(parsed.data);
  // Repair common shapes: {message}/{text} → text bubble.
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const content = o.content ?? o.text ?? o.message ?? o.msg;
    if (typeof content === 'string' && content.trim()) {
      // Keep the declared type when it is a real one: a repair should never be
      // the reason a voice message arrives as text.
      const t = o.type;
      const type =
        typeof t === 'string' && ['text', 'voice', 'sticker', 'image', 'recall'].includes(t)
          ? (t as Bubble['type'])
          : 'text';
      return clampBubble({ type, content: content.trim() });
    }
  }
  return null;
}

function clampBubble(b: Bubble): Bubble {
  // Never trust a model-supplied delay to be sane; cap it.
  if (b.delay != null) b.delay = Math.min(Math.max(b.delay, 0), 8_000);
  return b;
}

/**
 * @param text raw model output
 * @returns 1..MAX_BUBBLES bubbles; falls back to a single text bubble.
 */
export function parseBubbles(text: string): Bubble[] {
  const body = stripFences(text ?? '');
  if (!body) return [];
  const out: Bubble[] = [];

  // 1) Try a single JSON array.
  if (body.startsWith('[')) {
    try {
      const arr = JSON.parse(body);
      if (Array.isArray(arr)) {
        for (const item of arr) {
          const b = coerceBubble(item);
          if (b) out.push(b);
        }
      }
    } catch {
      /* fall through to NDJSON */
    }
  }

  // 2) NDJSON: one object per line.
  if (out.length === 0) {
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (!t || (!t.startsWith('{') && !t.startsWith('['))) continue;
      try {
        const obj = JSON.parse(t);
        if (Array.isArray(obj)) {
          for (const item of obj) {
            const b = coerceBubble(item);
            if (b) out.push(b);
          }
        } else {
          const b = coerceBubble(obj);
          if (b) out.push(b);
        }
      } catch {
        /* skip non-JSON line */
      }
    }
  }

  // 3) Plain-text fallback: split into short bubbles on blank lines, cap length.
  if (out.length === 0) {
    const chunks = body
      .split(/\n{2,}/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, MAX_BUBBLES);
    for (const c of chunks.length ? chunks : [body]) {
      out.push({ type: 'text', content: c });
    }
  }

  return out.slice(0, MAX_BUBBLES);
}

/**
 * Compute a human-like playback delay for a bubble given the persona's typing speed.
 * @param bubble the bubble to time
 * @param typingCpm persona chars-per-minute (default 300)
 * @returns delay in ms before this bubble appears
 */
export function typingDelay(bubble: Bubble, typingCpm = 300): number {
  if (bubble.delay != null) return bubble.delay;
  const base = 600; // reaction time floor
  const perChar = 60_000 / Math.max(typingCpm, 60);
  const len = bubble.type === 'text' ? bubble.content.length : 4;
  const jitter = 0.75 + deterministicJitter(bubble.content) * 0.5; // 0.75..1.25
  return Math.round((base + len * perChar) * jitter);
}

/** Stable pseudo-jitter from content so replays are deterministic (no Math.random). */
function deterministicJitter(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}
