/**
 * Bubble → message materialization for the M-I13 rich types.
 *
 * A model's bubble names an INTENT in plain text ("我在这" + a place name, a
 * friend to introduce, a file name, an article title, "掷个骰子"). The stored
 * message needs a structured `meta` the renderer and the projection layer can
 * read. This module is the one translation, shared by the single-chat and
 * group engines so the two cannot drift — the exact failure mode that made
 * every earlier per-engine mapping (sticker/voice/text) live in two copies.
 *
 * Pure and deterministic: no storage, no clock, no Math.random. Everything
 * seeded derives from (convId, at, salt) — constitution rule #4 — so a replay
 * materializes byte-identical messages.
 */
import type { Bubble } from '../llm/types';
import type { MessageType } from '../data/types';
import { seededRng } from '../lib/money';
import { gameSeed, rollDice, rollRps } from '../lib/game';

/** What a materialized bubble becomes: the appendMessage fields it decides. */
export interface MaterializedMsg {
  type: MessageType;
  content: string;
  meta?: Record<string, unknown>;
}

/** A resolvable contact for name-card bubbles. */
export interface CardContact {
  contactId: string;
  name: string;
  wxid?: string;
  avatarColor?: string;
  avatarText?: string;
}

export interface MaterializeCtx {
  convId: string;
  /** The message's timestamp — the deterministic half of every seed. */
  at: number;
  /** Bubble index within the turn, so two throws in one reply differ. */
  index?: number;
  /**
   * Resolve a display name to a real contact. Only names that resolve become
   * cards — a card pointing at nobody would 404 on tap, so an unresolvable
   * name degrades to a text bubble (she just *mentions* the person).
   */
  resolveContact?: (name: string) => CardContact | undefined;
}

/**
 * Split "标题|摘要"-style content on the first separator. Models are told to
 * use '|', but they improvise ('｜', '——', newline) — accept the lot.
 */
function splitPair(content: string): { head: string; tail?: string } {
  const t = content.trim();
  const m = t.match(/^(.*?)(?:\||｜|——|\n)(.*)$/s);
  if (!m) return { head: t };
  const head = m[1].trim();
  const tail = m[2].trim();
  return head ? { head, tail: tail || undefined } : { head: t };
}

/** Extension of a file name, lowercase without the dot; '' when none. */
export function fileExt(name: string): string {
  const m = name.match(/\.([A-Za-z0-9]{1,8})$/);
  return m ? m[1].toLowerCase() : '';
}

/**
 * A plausible size for a prop file, seeded — the same fake contract is the
 * same number of bytes forever. Bounded 18KB..9.8MB: small enough to be a
 * document, big enough to look real.
 */
export function fakeFileSize(seed: string): number {
  const r = seededRng(seed)();
  return 18_000 + Math.floor(r * 9_800_000);
}

/** "2.3MB" / "356KB" — how a file card labels its size. */
export function humanSize(bytes: number): string {
  const b = Math.max(0, Math.trunc(bytes));
  if (b >= 1_000_000) return `${(b / 1_000_000).toFixed(1)}MB`;
  if (b >= 1_000) return `${Math.round(b / 1_000)}KB`;
  return `${b}B`;
}

/**
 * Materialize one M-I13 bubble into message fields.
 *
 * Returns null for every type this module does NOT own (text/voice/sticker/
 * image/recall) — the engines keep their existing paths for those, and a null
 * here can never silently swallow a bubble.
 */
export function materializeBubble(b: Bubble, ctx: MaterializeCtx): MaterializedMsg | null {
  const content = (b.content ?? '').trim();
  switch (b.type) {
    case 'location': {
      // "地名|详细地址" or just the place name. Empty degrades to text ('' would
      // render an anonymous map card, which reads as a glitch, not a place).
      if (!content) return null;
      const { head, tail } = splitPair(content);
      return {
        type: 'location',
        content: head.slice(0, 40),
        meta: { name: head.slice(0, 40), ...(tail ? { address: tail.slice(0, 80) } : {}) },
      };
    }

    case 'contact': {
      const target = content && ctx.resolveContact?.(content);
      if (!target) {
        // She "recommends" someone the app doesn't know: say it in words.
        return content ? { type: 'text', content } : null;
      }
      return {
        type: 'contact_card',
        content: target.name,
        meta: {
          contactId: target.contactId,
          name: target.name,
          ...(target.wxid ? { wxid: target.wxid } : {}),
          ...(target.avatarColor ? { avatarColor: target.avatarColor } : {}),
          ...(target.avatarText ? { avatarText: target.avatarText } : {}),
        },
      };
    }

    case 'file': {
      if (!content) return null;
      const fileName = content.slice(0, 60);
      const sizeBytes = fakeFileSize(`file:${ctx.convId}:${ctx.at}:${fileName}`);
      const ext = fileExt(fileName);
      return {
        type: 'file',
        content: fileName,
        meta: { fileName, sizeBytes, ...(ext ? { ext } : {}) },
      };
    }

    case 'link': {
      if (!content) return null;
      const { head, tail } = splitPair(content);
      return {
        type: 'link',
        content: head.slice(0, 60),
        meta: { title: head.slice(0, 60), ...(tail ? { summary: tail.slice(0, 120) } : {}) },
      };
    }

    case 'dice': {
      const result = rollDice(gameSeed(ctx.convId, ctx.at, ctx.index ?? 0));
      return { type: 'game', content: '', meta: { game: 'dice', result } };
    }

    case 'rps': {
      const result = rollRps(gameSeed(ctx.convId, ctx.at, ctx.index ?? 0));
      return { type: 'game', content: '', meta: { game: 'rps', result } };
    }

    default:
      return null;
  }
}

/**
 * The set the engines route through `materializeBubble`. Exported so a future
 * bubble type can't be added to `BUBBLE_TYPES` without either landing here or
 * consciously extending an engine (the wiring test checks membership).
 */
export const MATERIALIZED_BUBBLE_TYPES: ReadonlySet<Bubble['type']> = new Set([
  'location',
  'contact',
  'file',
  'link',
  'dice',
  'rps',
]);
