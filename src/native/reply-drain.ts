/**
 * Draining the native reply queue (M-I10).
 *
 * A RemoteInput reply typed into the notification shade is enqueued by Kotlin
 * (ReplyQueue, SharedPreferences) because no WebView is guaranteed to be
 * running at that moment. THIS is the other half: on every return to the
 * foreground (src/app/useSchedulerRuntime.ts → runForegroundPass, the path
 * useForegroundLifecycle already guarantees), the queue is drained and each
 * item is pushed through the NORMAL send path — sendUserMessage /
 * sendGroupMessage — so a shade reply is indistinguishable from a typed one:
 * same persistence, same relationship bookkeeping, same engine reply.
 *
 * Call declines become the missed-call record the projection layer has had
 * since M5 but nothing ever produced: type 'call', meta {direction:'in'}.
 */
import { sendUserMessage } from '../ai/engine';
import { sendGroupMessage } from '../ai/group-engine';
import type { GroupMember } from '../ai/director';
import { peekRepliesRaw, ackReplies } from './bridge';
import { useAppStore } from '../store/appStore';
import { repo } from '../db/repo';
import { logError } from '../lib/errlog';
import type { NsfwTierVM } from '../data/types';

export interface NativeReplyItem {
  kind: 'reply' | 'call_declined';
  convId: string;
  text?: string;
  at: number;
}

const MAX_ITEMS = 50;
const MAX_TEXT = 2_000;

/**
 * Validate whatever crossed the bridge. Pure. Anything malformed is dropped
 * item-by-item — one corrupt row must not cost the user the rest of the queue.
 */
export function parseReplyItems(raw: unknown): NativeReplyItem[] {
  if (!Array.isArray(raw)) return [];
  const out: NativeReplyItem[] = [];
  for (const it of raw.slice(0, MAX_ITEMS)) {
    if (typeof it !== 'object' || it === null) continue;
    const o = it as Record<string, unknown>;
    const kind = o.kind;
    const convId = o.convId;
    const at = o.at;
    if (kind !== 'reply' && kind !== 'call_declined') continue;
    if (typeof convId !== 'string' || !convId) continue;
    if (typeof at !== 'number' || !Number.isFinite(at)) continue;
    if (kind === 'reply') {
      const text = typeof o.text === 'string' ? o.text.trim().slice(0, MAX_TEXT) : '';
      if (!text) continue;
      out.push({ kind, convId, text, at });
    } else {
      out.push({ kind, convId, at });
    }
  }
  return out;
}

/** Everything dispatch needs, injectable so tests never touch the store. */
export interface ReplyDispatchDeps {
  sendSingle(convId: string, text: string): Promise<void>;
  sendGroup(convId: string, text: string): Promise<void>;
  /** Materialize a declined incoming call as a missed-call record. */
  appendCallDeclined(convId: string, peerId: string, at: number): Promise<void>;
  /** 'single' | 'group' | undefined (unknown conv → item skipped). */
  convType(convId: string): 'single' | 'group' | undefined;
  peerIdOf(convId: string): string | undefined;
}

export interface ReplyDispatchResult {
  drained: number;
  sent: number;
  declinedCalls: number;
  skipped: number;
}

/**
 * Sequentially — a burst of replies to the same conversation must arrive in
 * the order they were typed, and sendUserMessage aborts the previous in-flight
 * generation per conv anyway.
 */
export async function dispatchReplies(
  items: NativeReplyItem[],
  deps: ReplyDispatchDeps,
): Promise<ReplyDispatchResult> {
  const res: ReplyDispatchResult = { drained: items.length, sent: 0, declinedCalls: 0, skipped: 0 };
  for (const item of items) {
    const type = deps.convType(item.convId);
    if (!type) {
      res.skipped++;
      continue;
    }
    try {
      if (item.kind === 'call_declined') {
        const peerId = deps.peerIdOf(item.convId);
        if (type !== 'single' || !peerId) {
          res.skipped++;
          continue;
        }
        await deps.appendCallDeclined(item.convId, peerId, item.at);
        res.declinedCalls++;
      } else if (type === 'group') {
        await deps.sendGroup(item.convId, item.text ?? '');
        res.sent++;
      } else {
        await deps.sendSingle(item.convId, item.text ?? '');
        res.sent++;
      }
    } catch (e) {
      // The queue row is already consumed; losing ONE reply to an engine error
      // beats blocking the whole drain (and the engine already persisted the
      // user's text before any generation could fail).
      logError('native.replyDispatch', e);
      res.skipped++;
    }
  }
  return res;
}

/** The store/engine wiring used in production. */
function storeDeps(): ReplyDispatchDeps {
  return {
    convType: (convId) => {
      const c = useAppStore.getState().conversationById(convId);
      return c ? c.type : undefined;
    },
    peerIdOf: (convId) => useAppStore.getState().conversationById(convId)?.peerId,
    sendSingle: async (convId, text) => {
      const s = useAppStore.getState();
      const conv = s.conversationById(convId);
      const peerId = conv?.peerId;
      const peer = peerId ? s.contactById(peerId) : undefined;
      const persona = peerId ? s.personaFor(peerId) : undefined;
      const hooks = {
        appendMessage: s.appendMessage,
        updateMessage: s.updateMessage,
        setTyping: s.setTyping,
        now: () => Date.now(),
      };
      if (!conv || !peer || !persona) {
        // Mirror ChatPage: no persona card → record the text rather than drop it.
        await s.appendMessage({
          convId,
          senderId: 'self',
          type: 'text',
          content: text,
          status: 'sent',
          createdAt: Date.now(),
        });
        return;
      }
      const globalTier = (await repo.getSetting<NsfwTierVM>('nsfwGlobalTier')) ?? 'off';
      await sendUserMessage(convId, text, peer, persona, globalTier, hooks);
    },
    sendGroup: async (convId, text) => {
      const s = useAppStore.getState();
      const conv = s.conversationById(convId);
      if (!conv) return;
      const members: GroupMember[] = (conv.memberIds ?? []).map((id) => {
        const c = s.contactById(id);
        return { contactId: id, name: c?.remark ?? c?.name ?? id, persona: s.personaFor(id) };
      });
      const globalTier = (await repo.getSetting<NsfwTierVM>('nsfwGlobalTier')) ?? 'off';
      const hooks = {
        appendMessage: s.appendMessage,
        updateMessage: s.updateMessage,
        setTyping: s.setTyping,
        now: () => Date.now(),
      };
      await sendGroupMessage(conv, text, members, globalTier, hooks, s.contactById);
    },
    appendCallDeclined: async (convId, peerId, at) => {
      // The record's createdAt is "now", not the decline moment: rows insert at
      // the tail and rowid order MUST equal time order (constitution 3.5) —
      // a backdated timestamp would corrupt cursor pagination. The decline
      // moment is preserved in meta for display/context purposes.
      await useAppStore.getState().appendMessage({
        convId,
        senderId: peerId,
        type: 'call',
        content: '未接听',
        meta: { direction: 'in', declinedAt: at },
        status: 'sent',
        createdAt: Date.now(),
      });
    },
  };
}

/**
 * Drain + dispatch. Called from runForegroundPass. Never throws: the reply
 * queue is a bonus channel and must not break the foreground path.
 */
export async function drainNativeReplies(): Promise<ReplyDispatchResult> {
  const empty: ReplyDispatchResult = { drained: 0, sent: 0, declinedCalls: 0, skipped: 0 };
  try {
    // Two-phase (M-J0): peek → dispatch → ack. The queue row survives until
    // the dispatch loop has run, so a process kill on re-foreground replays
    // the batch instead of eating it. Malformed rows are acked too — parsing
    // drops them on purpose, and replaying garbage forever helps nobody.
    const raw = await peekRepliesRaw();
    const rawCount = Array.isArray(raw) ? Math.min(raw.length, MAX_ITEMS) : 0;
    const items = parseReplyItems(raw);
    if (rawCount === 0) return empty;
    const res = await dispatchReplies(items, storeDeps());
    await ackReplies(rawCount);
    // One greppable line for the CI emulator loop (device-test.yml asserts it).
    console.log(
      `AIWX-REPLYQ drained=${res.drained} sent=${res.sent} declined=${res.declinedCalls} skipped=${res.skipped}`,
    );
    return res;
  } catch (e) {
    logError('native.replyDrain', e);
    return empty;
  }
}
