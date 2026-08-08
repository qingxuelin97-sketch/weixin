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
  actionExists,
} from '../ai/scheduler';
import { claimRedPacket, acceptTransfer } from '../ai/money-service';
import { sendProactiveMessage } from '../ai/engine';
import { sendGroupProactiveMessage } from '../ai/group-engine';
import { scheduleHeartbeat, shouldNudge } from '../ai/heartbeat';
import { getEdge, effectiveAffinity, heartbeatAffinityMul } from '../ai/relationship';
import { noteProactiveSent, getAgentState } from '../ai/agent-state';
import { extractMemory, maintainMemory } from '../ai/memory';
import { getExtractMarker, setExtractMarker } from '../ai/memory-service';
import { moodOf, moodParams } from '../lib/mood';
import { shouldFollowUpAfterRecall, recallFollowUpLine } from '../lib/recall';
import { runMomentPost, runMomentLike, runMomentComment, scheduleNextMoment } from '../ai/moments-service';
import { runBackfill } from '../ai/backfill';
import { runAgentDm, planNextDm, type DmPlan } from '../ai/agent-dm';
import { Capacitor } from '@capacitor/core';
import { getRouter } from '../llm/service';
import { seededRng } from '../lib/money';
import { playMessageSound, resumeAudio } from '../lib/sound';
import { requestPermission } from '../lib/notify';
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
        const stamp = at ?? action.fireAt;
        await hooks.appendMessage({
          convId,
          senderId: peer.id,
          type: 'text',
          content: body,
          status: 'sent',
          createdAt: stamp,
        });
        // Stamped so a backfilled past message stays silent; a live one dings.
        playMessageSound(stamp);
      } else {
        const tier = (await repo.getSetting<NsfwTierVM>('nsfwGlobalTier')) ?? 'off';
        const nudge = payload.nudge === true;
        await sendProactiveMessage(convId, peer, persona, tier, hooks, at, { nudge });
      }
      // Anti-spam bookkeeping: two unanswered reaches in a row → 24h cooldown.
      const state = await noteProactiveSent(contactId, Date.now());
      // Chain the next one, paced by the live relationship + today's mood.
      const now = Date.now();
      const edge = await getEdge('self', contactId, now);
      const last = s.messagesFor(convId).at(-1)?.createdAt;
      await scheduleHeartbeat(persona, convId, now, last, {
        affinityMul: heartbeatAffinityMul(effectiveAffinity(edge, persona.affinityInit)),
        proactMul: moodParams(moodOf(contactId, now).key).proactMul,
        notBefore: state.cooldownUntil || undefined,
      });
    });

    // Post-conversation memory pass: extract stable facts + a rolling summary
    // in ONE cheap role:'memory' call, then retire stale trivia. This is the
    // loop that makes chats actually produce memory (dead code since M2).
    registerHandler('mem_extract', async (payload) => {
      const convId = String(payload.convId ?? '');
      const contactId = String(payload.contactId ?? '');
      const upto = Number(payload.uptoMsgId ?? 0);
      if (!convId || !contactId || !upto) return;
      const marker = await getExtractMarker(convId);
      if (upto <= marker) return; // a later run already covered this span
      const msgs = (await repo.getMessages(convId, { limit: 60 })).filter(
        (m) => m.id > marker && m.id <= upto && m.type === 'text' && !m.isRecalled,
      );
      if (msgs.length === 0) return;
      const router = await getRouter();
      const res = await extractMemory(router, contactId, msgs, Date.now());
      if (res.summary) {
        await repo.putConvSummary({
          convId,
          summary: res.summary,
          uptoMsgId: upto,
          updatedAt: Date.now(),
        });
      }
      // Marker advances even when nothing was worth keeping — the span is done.
      await setExtractMarker(convId, upto);
      await maintainMemory(contactId, Date.now());
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
          playMessageSound(Date.now());
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

    // First-run notification ask (H1: requestPermission existed since M4 with
    // zero callers — Android 13+ notifications were fully inert). Delayed a few
    // seconds so the dialog doesn't collide with the launch moment; one-shot
    // forever via the notifyAsked setting; the settings row can re-trigger it.
    const askTimer = setTimeout(() => {
      void (async () => {
        if (!Capacitor.isNativePlatform()) return;
        if (await repo.getSetting<boolean>('notifyAsked')) return;
        const granted = await requestPermission();
        await repo.putSetting('notifyGranted', granted);
        await repo.putSetting('notifyAsked', true);
      })().catch(() => {});
    }, 4_000);

    return () => {
      clearTimeout(askTimer);
      stopScheduler();
    };
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
let lastPassAt = 0;
let passInFlight = false;

async function foregroundPass(): Promise<void> {
  // One gate for BOTH triggers (the mount-time pass and appStateChange): two
  // passes seconds apart carry different `now`s → different action ids → the
  // same absence fabricated twice (bug M5). In-flight guard for the same race.
  const t = Date.now();
  if (passInFlight || t - lastPassAt < 3_000) return;
  passInFlight = true;
  lastPassAt = t;
  try {
    await runForegroundPass();
  } finally {
    passInFlight = false;
  }
}

async function runForegroundPass(): Promise<void> {
  const s = useAppStore.getState();
  const now = Date.now();

  // 0) Re-arm audio: Android suspends the AudioContext on every backgrounding,
  //    and a suspended context swallows chimes without erroring (bug #6).
  resumeAudio();

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
      const edge = await getEdge('self', persona.contactId, now);
      const state = await getAgentState(persona.contactId);
      await scheduleHeartbeat(persona, conv.id, now, conv.lastMsgAt, {
        affinityMul: heartbeatAffinityMul(effectiveAffinity(edge, persona.affinityInit)),
        proactMul: moodParams(moodOf(persona.contactId, now).key).proactMul,
        notBefore: state.cooldownUntil || undefined,
      });
    }
    if (!(await hasPendingFor('moment_post', persona.contactId))) {
      await scheduleNextMoment(persona, now);
    }

    // Nudge: their last message sat unanswered for 6–48h. One per ignored
    // message EVER — the id is checked against all statuses, because enqueue
    // upserts and would otherwise revive a completed nudge as pending.
    const last = s.messagesFor(conv.id).at(-1);
    if (last && shouldNudge(last, persona, now)) {
      const nudgeId = `nudge_${conv.id}_${last.id}`;
      if (!(await actionExists(nudgeId))) {
        const delay = (5 + seededRng(nudgeId)() * 25) * 60_000;
        await enqueue({
          kind: 'heartbeat',
          fireAt: now + delay,
          payload: { contactId: persona.contactId, convId: conv.id, nudge: true },
          now,
          id: nudgeId,
        });
      }
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
