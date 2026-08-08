/**
 * Wires the scheduler's action handlers to the store and starts the foreground
 * tick. Lives in the app shell so `scheduler.ts` stays dependency-free and
 * unit-testable, while handlers can reach the store/Repo freely.
 */
import { useEffect } from 'react';
import {
  registerHandler,
  startScheduler,
  stopScheduler,
  hasPendingFor,
  hasPendingOfKind,
  duePending,
  enqueue,
} from '../ai/scheduler';
import { claimRedPacket, acceptTransfer } from '../ai/money-service';
import { sendProactiveMessage } from '../ai/engine';
import { sendGroupProactiveMessage } from '../ai/group-engine';
import { scheduleHeartbeat } from '../ai/heartbeat';
import { shouldFollowUpAfterRecall, recallFollowUpLine } from '../lib/recall';
import { runMomentPost, runMomentLike, runMomentComment, scheduleNextMoment } from '../ai/moments-service';
import { runBackfill } from '../ai/backfill';
import { runAgentDm, planNextDm, type DmPlan } from '../ai/agent-dm';
import { getRouter } from '../llm/service';
import { syncNotifications } from '../ai/notify-service';
import { useForegroundLifecycle } from './useForegroundLifecycle';
import type { SimContact, SimGroup } from '../ai/simulate';
import { repo } from '../db/repo';
import { useAppStore } from '../store/appStore';
import type { NsfwTierVM } from '../data/types';

export function useSchedulerRuntime(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const store = useAppStore.getState();
    const hooks = {
      appendMessage: store.appendMessage,
      updateMessage: store.updateMessage,
      setTyping: store.setTyping,
      now: () => Date.now(),
    };

    // An AI member grabs a share of a red packet.
    registerHandler('rp_grab', async (payload) => {
      const contactId = String(payload.contactId ?? '');
      const rpId = String(payload.rpId ?? '');
      if (!contactId || !rpId) return;
      const who = useAppStore.getState().contactById(contactId);
      await claimRedPacket(rpId, contactId, who?.remark ?? who?.name ?? contactId, hooks);
    });

    // The peer accepts a transfer the user sent.
    registerHandler('transfer_accept', async (payload) => {
      const transferId = String(payload.transferId ?? '');
      if (transferId) await acceptTransfer(transferId, hooks);
    });

    // An AI reaches out on its own, then queues its next one.
    registerHandler('heartbeat', async (payload, action) => {
      const contactId = String(payload.contactId ?? '');
      const convId = String(payload.convId ?? '');
      const at = typeof payload.at === 'number' ? payload.at : undefined;
      const body = typeof payload.body === 'string' ? payload.body : undefined;
      if (!contactId || !convId) return;
      const s = useAppStore.getState();
      const peer = s.contactById(contactId);
      const persona = s.personaFor(contactId);
      if (!peer || !persona) return;

      if (body) {
        // A notification may already have shown this exact text on the lock
        // screen. Persist it verbatim, stamped at the time it was advertised —
        // regenerating here would contradict what the user already read.
        await hooks.appendMessage({
          convId,
          senderId: peer.id,
          type: 'text',
          content: body,
          status: 'sent',
          createdAt: at ?? action.fireAt,
        });
      } else {
        const tier = (await repo.getSetting<NsfwTierVM>('nsfwGlobalTier')) ?? 'off';
        await sendProactiveMessage(convId, peer, persona, tier, hooks, at);
      }
      // Chain the next one so the rhythm continues.
      const last = s.messagesFor(convId).at(-1)?.createdAt;
      await scheduleHeartbeat(persona, convId, Date.now(), last);
    });

    // Flip a sent message to recalled (the send-then-recall drama's second act).
    // Idempotent: a re-fired action finds isRecalled already true and stops.
    registerHandler('recall', async (payload) => {
      const msgId = Number(payload.msgId);
      const convId = String(payload.convId ?? '');
      if (!msgId || !convId) return;
      const s = useAppStore.getState();
      const msg = s.messagesFor(convId).find((m) => m.id === msgId);
      if (!msg || msg.isRecalled) return;
      await s.updateMessage({ ...msg, isRecalled: true });

      // The cover line — sometimes they can't leave the recall alone.
      if (msg.senderId !== 'self' && shouldFollowUpAfterRecall(msgId)) {
        const persona = s.personaFor(msg.senderId);
        if (persona) {
          await hooks.appendMessage({
            convId,
            senderId: msg.senderId,
            type: 'text',
            content: recallFollowUpLine(persona, msgId),
            status: 'sent',
            createdAt: Date.now(),
          });
        }
      }
    });

    // A group member says something unprompted (offline backfill chatter).
    registerHandler('group_msg', async (payload, action) => {
      const convId = String(payload.convId ?? '');
      const contactId = String(payload.contactId ?? '');
      const at = typeof payload.at === 'number' ? payload.at : action.fireAt;
      if (!convId || !contactId) return;
      const s = useAppStore.getState();
      const conv = s.conversationById(convId);
      const persona = s.personaFor(contactId);
      if (!conv || conv.type !== 'group' || !persona) return;

      const members = (conv.memberIds ?? []).map((id) => {
        const c = s.contactById(id);
        return { contactId: id, name: c?.remark ?? c?.name ?? id, persona: s.personaFor(id) };
      });
      const speaker = members.find((m) => m.contactId === contactId);
      if (!speaker?.persona) return;

      const tier = (await repo.getSetting<NsfwTierVM>('nsfwGlobalTier')) ?? 'off';
      const hint = typeof payload.hint === 'string' ? payload.hint : undefined;
      await sendGroupProactiveMessage(conv, speaker, members, tier, hooks, s.contactById, at, hint);
    });

    // Two agents have a private exchange the user never sees; its gossip lands
    // in both memories and maybe spills a starter into their shared group.
    registerHandler('agent_dm', async (payload) => {
      const plan: DmPlan = {
        a: String(payload.a ?? ''),
        b: String(payload.b ?? ''),
        groupId: String(payload.groupId ?? ''),
        fireAt: Number(payload.fireAt ?? Date.now()),
      };
      if (!plan.a || !plan.b || !plan.groupId) return;
      const s = useAppStore.getState();
      const router = await getRouter();
      await runAgentDm(plan, {
        getPersona: s.personaFor,
        getContact: s.contactById,
        getConversation: (id) => repo.getConversation(id),
        addConversation: s.addConversation,
        appendMessage: s.appendMessage,
        putMemory: (f) => repo.putMemory(f),
        getMemoryFacts: (id) => repo.getMemory(id),
        getGroupMessages: (id) => repo.getMessages(id, { limit: 8 }),
        getMoments: () => repo.getMoments({ limit: 10 }),
        complete: async (messages, convKey) =>
          (await router.complete({ role: 'chat', nsfwTier: 'off' }, { messages }, {}, convKey)).text,
        enqueueGroupSpill: async (groupId, speakerId, hint, at) => {
          await enqueue({
            kind: 'group_msg',
            fireAt: at,
            payload: { convId: groupId, contactId: speakerId, hint },
            now: Date.now(),
            id: `dmspill_${groupId}_${speakerId}_${at}`,
          });
        },
        now: () => Date.now(),
      });
      // Chain the next session regardless of outcome — one failed exchange
      // must not end the whole mechanism.
      await scheduleNextAgentDm();
    });

    const momentsHooks = {
      addMoment: store.addMoment,
      applyLike: store.applyLike,
      addComment: store.addComment,
      now: () => Date.now(),
    };

    // An AI publishes a post, which in turn queues the reactions it draws.
    registerHandler('moment_post', async (payload) => {
      const contactId = String(payload.contactId ?? '');
      const at = typeof payload.at === 'number' ? payload.at : undefined;
      const s = useAppStore.getState();
      const peer = s.contactById(contactId);
      const persona = s.personaFor(contactId);
      if (!peer || !persona) return;
      await runMomentPost(persona, peer, s.contacts, s.personaFor, momentsHooks, at);
    });

    registerHandler('moment_like', async (payload) => {
      const momentId = String(payload.momentId ?? '');
      const contactId = String(payload.contactId ?? '');
      const at = typeof payload.at === 'number' ? payload.at : undefined;
      if (momentId && contactId) await runMomentLike(momentId, contactId, momentsHooks, at);
    });

    registerHandler('moment_comment', async (payload) => {
      const momentId = String(payload.momentId ?? '');
      const contactId = String(payload.contactId ?? '');
      const at = typeof payload.at === 'number' ? payload.at : undefined;
      if (!momentId || !contactId) return;
      const s = useAppStore.getState();
      const commenter = s.contactById(contactId);
      const persona = s.personaFor(contactId);
      if (!commenter || !persona) return;
      const moment = await repo.getMoment(momentId);
      if (!moment) return;
      const author = s.contactById(moment.authorId);
      const authorName =
        moment.authorId === 'self' ? '你' : (author?.remark ?? author?.name ?? '朋友');
      await runMomentComment(momentId, commenter, persona, authorName, momentsHooks, at);
    });

    startScheduler();
    void foregroundPass();

    return () => stopScheduler();
  }, [enabled]);

  // Every return to the foreground repeats the pass. Before M5 this ran only
  // once at hydrate, so on a phone — where background→foreground is the normal
  // path and the WebView never remounts — backfill effectively never fired.
  useForegroundLifecycle(enabled, { onForeground: foregroundPass });
}

/**
 * Backfill the gap, top up missing schedules, and rebuild the OS notifications.
 * Safe to run repeatedly: the barrier bounds the backfill window and every
 * enqueue uses a stable id, so a second pass adds nothing the first already did.
 */
async function foregroundPass(): Promise<void> {
  const s = useAppStore.getState();
  const now = Date.now();

  // 1) Backfill what "happened" while away. First, so the fabricated past is
  //    queued before any future scheduling looks at it.
  const singles = s.conversations.flatMap<SimContact>((c) => {
    if (c.type !== 'single' || !c.peerId) return [];
    const persona = s.personaFor(c.peerId);
    if (!persona) return [];
    return [{ contactId: c.peerId, convId: c.id, persona, lastMsgAt: c.lastMsgAt }];
  });
  const groups = s.conversations.flatMap<SimGroup>((c) => {
    if (c.type !== 'group') return [];
    const memberIds = (c.memberIds ?? []).filter((id) => s.personaFor(id));
    if (memberIds.length === 0) return [];
    return [{ convId: c.id, memberIds, lastMsgAt: c.lastMsgAt }];
  });
  try {
    await runBackfill(now, { singles, groups });
  } catch {
    // A failed backfill must never block startup — the app still works, it
    // just doesn't show a fabricated absence this time.
  }

  // 2) Seed each persona's first heartbeat and Moments post. Without this
  //    neither feature ever fires — nothing else enqueues the first one.
  for (const conv of s.conversations) {
    if (conv.type !== 'single' || !conv.peerId) continue;
    const persona = s.personaFor(conv.peerId);
    if (!persona) continue;
    if (!(await hasPendingFor('heartbeat', persona.contactId))) {
      await scheduleHeartbeat(persona, conv.id, now, conv.lastMsgAt);
    }
    if (!(await hasPendingFor('moment_post', persona.contactId))) {
      await scheduleNextMoment(persona, now);
    }
  }

  // 3) Seed the first AI↔AI DM session if none is queued.
  try {
    if (!(await hasPendingOfKind('agent_dm'))) await scheduleNextAgentDm();
  } catch {
    /* chemistry is a bonus; never block the foreground path on it */
  }

  // 4) Rebuild the lock-screen notifications from the (now current) queue.
  try {
    await syncNotifications(await duePending(Number.MAX_SAFE_INTEGER), s.contacts, now);
  } catch {
    /* notifications are a bonus; never let them break the foreground path */
  }
}


/**
 * Queue the next AI↔AI DM session. The 8–20h seeded gap inside planNextDm is
 * the entire daily budget — no counter needed. No-op when no two persona-backed
 * agents share a group.
 */
async function scheduleNextAgentDm(): Promise<void> {
  const s = useAppStore.getState();
  const roster = s.contacts
    .filter((c) => c.type === 'ai')
    .flatMap((c) => {
      const persona = s.personaFor(c.id);
      return persona ? [{ contactId: c.id, persona }] : [];
    });
  const groups = s.conversations
    .filter((c) => c.type === 'group' && !c.isHidden)
    .map((c) => ({ convId: c.id, memberIds: c.memberIds ?? [] }));
  const now = Date.now();
  const plan = planNextDm(roster, groups, now, 'dm');
  if (!plan) return;
  await enqueue({
    kind: 'agent_dm',
    fireAt: plan.fireAt,
    payload: { ...plan },
    now,
    id: `dm_${plan.a}_${plan.b}_${plan.fireAt}`,
  });
}
