/**
 * Wires the scheduler's action handlers to the store and starts the foreground
 * tick. Lives in the app shell so `scheduler.ts` stays dependency-free and
 * unit-testable, while handlers can reach the store/Repo freely.
 */
import { useEffect } from 'react';
import {
  registerHandler,
  registerChainedHandler,
  setHandlerErrorSink,
  gcActions,
  startScheduler,
  stopScheduler,
  hasPendingOfKind,
  pendingActions,
  isPendingForIn,
  enqueue,
  actionExists,
} from '../ai/scheduler';
import { claimRedPacket, acceptTransfer } from '../ai/money-service';
import { runGift, considerGift, considerCall, considerGroupGift } from '../ai/gift-service';
import { sendProactiveMessage } from '../ai/engine';
import { sendGroupProactiveMessage } from '../ai/group-engine';
import { scheduleHeartbeat, shouldNudge } from '../ai/heartbeat';
import { getEdge, effectiveAffinity, heartbeatAffinityMul } from '../ai/relationship';
import { noteProactiveSent, getAgentState } from '../ai/agent-state';
import { extractMemory, maintainMemory } from '../ai/memory';
import { getExtractMarker, setExtractMarker } from '../ai/memory-service';
import { tierFor, maxTier, globalTier, tierOfConversation, redactForTier } from '../lib/nsfw-tier';
import { renderTranscript } from '../ai/render-msg';
import { logError } from '../lib/errlog';
import { moodOf, moodParams } from '../lib/mood';
import { affectFor, recordAffect } from '../lib/affect';
import { noteDrift, driftedPersona } from '../ai/drift';
import { shouldFollowUpAfterRecall, recallFollowUpLine } from '../lib/recall';
import {
  runMomentPost,
  runMomentLike,
  runMomentComment,
  runMomentRepost,
  scheduleNextMoment,
} from '../ai/moments-service';
import { runBackfill } from '../ai/backfill';
import { chainAutoBackup, runAutoBackup, ensureAutoBackupScheduled } from '../ai/auto-backup';
import { runAgentDm, planNextDm, type DmPlan } from '../ai/agent-dm';
import { chainNextBeat, runStoryBeat, seedBuiltinScripts } from '../ai/story-service';
import { judgePrompt, parseJudgement } from '../ai/story-gm';
import {
  type HandlerDeps,
  handleRpGrab,
  handleTransferAccept,
  handleRecall,
  handleGroupMsg,
  handleMemExtract,
  handleMomentLike,
  handleMomentComment,
  handleHeartbeat,
  handleAgentDm,
  handleMomentPost,
  handleMomentRepost,
  handleAiMoney,
  handleAiCall,
  handleJointPlan,
  handleAgentForward,
  handleAgentInvite,
  handleGroupEvent,
  chainGroupEvent as chainGroupEventStep,
  chainHeartbeat as chainHeartbeatStep,
  chainAgentDm as chainAgentDmStep,
  chainMomentPost as chainMomentPostStep,
} from '../ai/handlers';
import { Capacitor } from '@capacitor/core';
import { getRouter } from '../llm/service';
import { seededRng } from '../lib/money';
import { playMessageSound, resumeAudio } from '../lib/sound';
import { requestPermission } from '../lib/notify';
import { syncNotifications } from '../ai/notify-service';
import { drainNativeReplies } from '../native/reply-drain';
import { syncWidget } from '../native/widget-sync';
import { startBackgroundNotify } from '../native/background-notify';
import { useForegroundLifecycle } from './useForegroundLifecycle';
import type { SimContact, SimGroup } from '../ai/simulate';
import { getGroupCfg, activityMultiplier } from '../ai/group-config';
import { maybeGroupEvent } from '../ai/group-events';
import { maybeGroupInvite } from '../ai/agent-invite';
import { repo } from '../db/repo';
import { useAppStore } from '../store/appStore';

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

    // Handlers live in ai/handlers.ts as plain functions; this bag is the only
    // place they touch the store, the repo, or the network. Registration is all
    // that remains here.
    const deps: HandlerDeps = {
      contactById: (id) => useAppStore.getState().contactById(id),
      personaFor: (id) => useAppStore.getState().personaFor(id),
      conversationById: (id) => useAppStore.getState().conversationById(id),
      messagesFor: (id) => useAppStore.getState().messagesFor(id),
      conversationExists: (id) => useAppStore.getState().conversations.some((c) => c.id === id),

      hooks,
      updateMessage: (m) => useAppStore.getState().updateMessage(m),

      getMessages: (convId, opts) => repo.getMessages(convId, opts),
      getMemory: (id) => repo.getMemory(id),
      putConvSummary: (row) => repo.putConvSummary(row),
      getGlobalTier: globalTier,
      getMoment: (id) => repo.getMoment(id),

      getRouter,
      now: () => Date.now(),

      // Social fabric (M-I3).
      addMoment: (m) => useAppStore.getState().addMoment(m),
      enqueue: async (opts) => {
        await enqueue({ ...opts, now: Date.now() });
      },
      visibleConvWithUser: (contactId) =>
        useAppStore
          .getState()
          .conversations.find(
            (c) => c.type === 'single' && c.peerId === contactId && !c.isHidden,
          ),

      claimRedPacket: (rpId, contactId, name, h) => claimRedPacket(rpId, contactId, name, h),
      acceptTransfer: (transferId, h) => acceptTransfer(transferId, h),
      sendProactiveMessage,
      sendGroupProactiveMessage,
      runMemExtract,
      runAgentDm: (plan) => runDmSession(plan),
      runMomentPost: async (persona, peer, at) => {
        const s = useAppStore.getState();
        await runMomentPost(persona, peer, s.contacts, s.personaFor, momentsHooks, at);
      },
      // A call can only ring while the app is open — a WebView cannot wake the
      // screen — so this is a plain store write, and returns whether it took.
      ringUser: (convId, contactId, reason) => {
        const st = useAppStore.getState();
        // Never ring over a call already in progress, and never while the user
        // is typing in that very conversation: a call is a synchronous demand
        // for attention, and the worst possible moment for one is mid-sentence.
        if (st.incomingCall || st.activeConvId === convId) return false;
        st.setIncomingCall({ convId, contactId, reason, at: Date.now() });
        return true;
      },
      runGift: (p) =>
        runGift(p, {
          hooks,
          // Everyone in the room except the sender may grab a group packet;
          // in a single chat this is empty and only the user can open it.
          grabbers: (convId, senderId) => {
            const s = useAppStore.getState();
            const conv = s.conversationById(convId);
            if (conv?.type !== 'group') return [];
            return (conv.memberIds ?? [])
              .filter((id) => id !== senderId && id !== 'self')
              .map((id) => ({ contactId: id, persona: s.personaFor(id) }));
          },
          contactById: (id) => useAppStore.getState().contactById(id),
          now: () => Date.now(),
        }),
      runMomentLike: (momentId, contactId, at) =>
        runMomentLike(momentId, contactId, momentsHooks, at),
      runMomentComment: (momentId, commenter, persona, authorName, at) =>
        runMomentComment(momentId, commenter, persona, authorName, momentsHooks, at),
      runMomentRepost: async (momentId, reposter, persona, at) => {
        const s = useAppStore.getState();
        await runMomentRepost(momentId, reposter, persona, s.contacts, s.personaFor, momentsHooks, at);
      },

      chainHeartbeat: async (persona, convId, lastMsgAt) => {
        // Anti-spam bookkeeping: two unanswered reaches in a row → 24h cooldown.
        const now = Date.now();
        const state = await noteProactiveSent(persona.contactId, now);
        const edge = await getEdge('self', persona.contactId, now);
        // Pacing now answers to how she FEELS, not only to the day's dice: the
        // affect pulse rides the same proactMul the mood already used (M-E3).
        const { params } = await affectFor(persona.contactId, now);
        // Proactivity drifts (M-H1): being answered teaches her that reaching
        // out works, and being ignored teaches her the opposite.
        await scheduleHeartbeat(await driftedPersona(persona, now), convId, now, lastMsgAt, {
          affinityMul: heartbeatAffinityMul(effectiveAffinity(edge, persona.affinityInit)),
          proactMul: params.proactMul,
          notBefore: state.cooldownUntil || undefined,
        });
      },
      chainAgentDm: scheduleNextAgentDm,
      chainMomentPost: (persona) => scheduleNextMoment(persona, Date.now()),

      playMessageSound,
      shouldFollowUpAfterRecall,
      recallFollowUpLine,
    };

    const momentsHooks = {
      addMoment: store.addMoment,
      applyLike: store.applyLike,
      addComment: store.addComment,
      now: () => Date.now(),
    };

    // Failures inside a handler are dropped (never retried into a loop) — but
    // they are no longer silent, which is how "她突然不说话了" stayed invisible.
    setHandlerErrorSink(logError);

    registerHandler('rp_grab', (p) => handleRpGrab(deps, p));
    registerHandler('transfer_accept', (p) => handleTransferAccept(deps, p));
    registerHandler('recall', (p) => handleRecall(deps, p));
    registerHandler('group_msg', (p, a) => handleGroupMsg(deps, p, a));
    registerHandler('mem_extract', (p) => handleMemExtract(deps, p));
    registerHandler('moment_like', (p) => handleMomentLike(deps, p));
    registerHandler('moment_comment', (p) => handleMomentComment(deps, p));
    registerHandler('moment_repost', (p) => handleMomentRepost(deps, p));
    registerHandler('ai_money', (p) => handleAiMoney(deps, p));
    registerHandler('ai_call', (p) => handleAiCall(deps, p));
    // Social fabric (M-I3): hatched by a completed agent DM, fired here.
    registerHandler('joint_plan', (p) => handleJointPlan(deps, p));
    registerHandler('agent_forward', (p) => handleAgentForward(deps, p));
    registerHandler('agent_invite', (p) => handleAgentInvite(deps, p));

    // Story mode's beat (M-E5, chained in M-G0).
    //
    // This comment used to claim the handler was chained while the code below
    // called plain `registerHandler`, and `runStoryBeat` queued its successor
    // on its LAST line — after the group generation that can time out. Since
    // the scheduler marks a row done before running it and drops handler
    // errors without retrying, one flaky LLM call ended the story forever.
    registerChainedHandler('story_tick', {
      chain: (p) => chainNextBeat(p, Date.now()),
      work: async (p) => {
        const saveId = String(p.saveId ?? '');
        if (!saveId) return;
        await runStoryBeat(saveId, {
          appendMessage: (m) => useAppStore.getState().appendMessage(m),
          playBeat: async (convId, directives, goal) => {
            const st = useAppStore.getState();
            const c = st.conversationById(convId);
            if (!c) return;
            const members = (c.memberIds ?? []).map((id) => {
              const ct = st.contactById(id);
              return {
                contactId: id,
                name: ct?.remark ?? ct?.name ?? id,
                persona: st.personaFor(id),
              };
            });
            const speaker = members.find((m) => directives[m.contactId]);
            if (!speaker?.persona) return;
            // The GM's beat rides in as the director hint — per character, and
            // ONLY that character's own instruction (never the whole script).
            await sendGroupProactiveMessage(
              c,
              speaker,
              members,
              await globalTier(),
              hooks,
              st.contactById,
              Date.now(),
              `${goal}｜${directives[speaker.contactId]}`.slice(0, 200),
            );
          },
          judgeTriggers: async (convId, goal, pending) => {
            const st = useAppStore.getState();
            const c = st.conversationById(convId);
            if (!c) return undefined;
            // Rule #6: this prompt carries the transcript, so the tier comes
            // from the CONVERSATION's participants — never from a constant
            // here. `tierOfConversation` is the authority for exactly this.
            const tier = await tierOfConversation(c.memberIds ?? [], st.personaFor);
            const nameOf = (id: string) => {
              const ct = st.contactById(id);
              return ct?.remark ?? ct?.name ?? id;
            };
            const tail = st.messagesFor(convId).length
              ? st.messagesFor(convId).slice(-12)
              : await repo.getMessages(convId, { limit: 12 });
            // Same discipline as the director (director.ts:231-237): above
            // 'off' the words never leave in full, so the judgement stays
            // honest even when a permissive channel is unavailable.
            const recent =
              tier === 'off'
                ? renderTranscript(tail, { nameOf, maxChars: 120 })
                : redactForTier(tail, nameOf);
            const router = await getRouter();
            const res = await router.complete(
              { role: 'director', nsfwTier: tier },
              {
                messages: [{ role: 'user', content: judgePrompt(goal, recent, pending) }],
                temperature: 0.2,
                // The whole answer is one integer. Capping it here is what
                // keeps the soft track from costing anything meaningful.
                maxTokens: 8,
              },
              {},
              `story:${convId}`,
            );
            return parseJudgement(res.text, pending);
          },
          contactById: (id) => useAppStore.getState().contactById(id),
          now: () => Date.now(),
        });
      },
    });

    // Self-chaining kinds: the successor is queued BEFORE the work that can
    // fail, so one bad night does not end the chain forever (see scheduler.ts).
    registerChainedHandler('heartbeat', {
      chain: (p) => chainHeartbeatStep(deps, p),
      work: (p, a) => handleHeartbeat(deps, p, a),
    });
    registerChainedHandler('agent_dm', {
      chain: () => chainAgentDmStep(deps),
      work: (p) => handleAgentDm(deps, p),
    });
    registerChainedHandler('moment_post', {
      chain: (p) => chainMomentPostStep(deps, p),
      work: (p) => handleMomentPost(deps, p),
    });
    // 聚会 arc (M-I3): propose → rsvp → aftermath. Chained so one flaky call
    // costs one phase, not the whole event.
    registerChainedHandler('group_event', {
      chain: (p) => chainGroupEventStep(deps, p),
      work: (p) => handleGroupEvent(deps, p),
    });
    // Periodic backups (M-I17): the successor is queued before the export, so
    // one failed write costs one package, never the habit.
    registerChainedHandler('auto_backup', {
      chain: () => chainAutoBackup(Date.now()),
      work: async () => {
        await runAutoBackup(Date.now());
      },
    });

    startScheduler();
    void foregroundPass();

    // M-I10: while backgrounded-but-alive, freshly generated messages surface
    // natively (RemoteInput notification / bubble / occasional incoming call).
    const stopBackgroundNotify = startBackgroundNotify();

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
      stopBackgroundNotify();
      stopScheduler();
    };
  }, [enabled]);

  // Every return to the foreground repeats the pass. Before M5 this ran only
  // once at hydrate, so on a phone — where background→foreground is the normal
  // path and the WebView never remounts — backfill effectively never fired.
  // Backgrounding pushes the widget's last look at the world (M-I10) — this is
  // the freshest state the launcher can ever get before the process freezes.
  useForegroundLifecycle(enabled, {
    onForeground: foregroundPass,
    onBackground: () => void syncWidget(),
  });
}

/**
 * The memory pass proper. Lives here rather than in handlers.ts because it is
 * the one handler that owns a rule of its own: rule #6 says this transcript's
 * tier is derived from the conversation, never declared — with no permissive
 * channel the router throws and the extraction is SKIPPED, not downgraded.
 */
async function runMemExtract(args: {
  convId: string;
  contactId: string;
  uptoMsgId: number;
}): Promise<void> {
  const { convId, contactId, uptoMsgId } = args;
  const marker = await getExtractMarker(convId);
  if (uptoMsgId <= marker) return; // a later run already covered this span
  const msgs = (await repo.getMessages(convId, { limit: 60 })).filter(
    (m) => m.id > marker && m.id <= uptoMsgId && m.type === 'text' && !m.isRecalled,
  );
  if (msgs.length === 0) return;
  // Rule #6 again, and the group case is NOT the single case: for a group,
  // `contactId` is the conversation id, so personaFor() answers undefined and a
  // naive tierFor() would declare 'off' for a transcript that may be full-tier.
  // The tier of a group's material is the max over its members' permits.
  const store = useAppStore.getState();
  const conv = store.conversationById(convId);
  const g = await globalTier();
  const tier =
    conv?.type === 'group'
      ? maxTier(g, (conv.memberIds ?? []).map(store.personaFor))
      : tierFor(g, store.personaFor(contactId));
  const router = await getRouter();
  const now = Date.now();
  const res = await extractMemory(router, contactId, msgs, now, tier);
  if (res.summary) {
    await repo.putConvSummary({ convId, summary: res.summary, uptoMsgId, updatedAt: now });
  }
  // Marker advances even when nothing was worth keeping — the span is done.
  await setExtractMarker(convId, uptoMsgId);
  await maintainMemory(contactId, now);
}

/** One AI↔AI DM session, with the store/repo wiring runAgentDm expects. */
async function runDmSession(plan: DmPlan): Promise<boolean> {
  const s = useAppStore.getState();
  const router = await getRouter();
  return runAgentDm(plan, {
    getPersona: s.personaFor,
    getContact: s.contactById,
    getConversation: (id) => repo.getConversation(id),
    addConversation: s.addConversation,
    appendMessage: s.appendMessage,
    putMemory: (f) => repo.putMemory(f),
    getMemoryFacts: (id) => repo.getMemory(id),
    getGroupMessages: (id) => repo.getMessages(id, { limit: 8 }),
    getMoments: () => repo.getMoments({ limit: 10 }),
    complete: async (messages, convKey, tier) =>
      (await router.complete({ role: 'chat', nsfwTier: tier ?? 'off' }, { messages }, {}, convKey))
        .text,
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
    getGlobalTier: globalTier,
  });
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

  // 0.5) M-I10: drain notification-shade replies (RemoteInput → SharedPreferences
  //      queue) through the NORMAL send paths, BEFORE backfill — the user's own
  //      words are the strongest signal the world below should build on.
  //      drainNativeReplies never throws and is a no-op on web.
  await drainNativeReplies();

  // 1) Backfill what "happened" while away. First, so the fabricated past is
  //    queued before any future scheduling looks at it.
  const singles = s.conversations.flatMap<SimContact>((c) => {
    if (c.type !== 'single' || !c.peerId) return [];
    const persona = s.personaFor(c.peerId);
    if (!persona) return [];
    return [{ contactId: c.peerId, convId: c.id, persona, lastMsgAt: c.lastMsgAt }];
  });
  const groupsBase = s.conversations.flatMap<SimGroup>((c) => {
    if (c.type !== 'group') return [];
    const memberIds = (c.memberIds ?? []).filter((id) => s.personaFor(id));
    if (memberIds.length === 0) return [];
    return [{ convId: c.id, memberIds, lastMsgAt: c.lastMsgAt }];
  });
  // The per-group activity knob rides in from here (M-I1): simulate() is pure
  // and must not read storage, so the impure edge attaches the multiplier.
  const groups = await Promise.all(
    groupsBase.map(async (g) => ({
      ...g,
      activity: activityMultiplier(await getGroupCfg(g.convId)),
    })),
  );
  // Posts that predate the absence, for belated 赞评 (M-I5). Newest few only.
  const recentMoments = await repo
    .getMoments({ limit: 8 })
    .then((ms) => ms.map((m) => ({ id: m.id, authorId: m.authorId, createdAt: m.createdAt })))
    .catch(() => []);
  try {
    await runBackfill(now, { singles, groups, recentMoments });
  } catch (e) {
    // A failed backfill must never block startup — the app still works, it
    // just doesn't show a fabricated absence this time. But it must not fail
    // INVISIBLY either: this is the core of offline evolution and it makes LLM
    // calls, so a silent catch made "she went quiet for a day" and "backfill
    // threw every single time" look identical from both the UI and the log.
    logError('backfill', e);
  }

  // 1.5) Group events (M-I3): each group rolls its seeded weekly dice. The
  // plan is deterministic, so the actionExists guard is what makes asking on
  // every foreground pass safe — the same event id upserts, and a COMPLETED
  // event must not be re-queued (CLAUDE.md: enqueue upserts by id).
  for (const g of groupsBase) {
    try {
      const ev = maybeGroupEvent(g.convId, g.memberIds, now);
      if (!ev) continue;
      if (await actionExists(`${ev.id}_propose`)) continue;
      await enqueue({
        kind: 'group_event',
        fireAt: ev.proposeAt,
        payload: {
          convId: g.convId,
          eventId: ev.id,
          initiator: ev.initiator,
          activity: ev.activity,
          phase: 'propose',
          at: ev.proposeAt,
        },
        now,
        id: `${ev.id}_propose`,
      });
    } catch (e) {
      logError('gevt.schedule', e);
    }
  }

  // 1.6) Group proposals (M-I3): a friend with two mutual AI friends who do
  // not already share a room with her occasionally suggests forming one.
  // Same discipline as events: seeded weekly, stable id, actionExists guard.
  const groupRosters = s.conversations
    .filter((c) => c.type === 'group' && !c.isHidden)
    .map((c) => c.memberIds ?? []);
  for (const c of singles) {
    try {
      const relationAiIds = Object.keys(c.persona.relations).filter(
        (id) => id !== 'user' && s.personaFor(id),
      );
      const inv = maybeGroupInvite(c.contactId, relationAiIds, groupRosters, now);
      if (!inv) continue;
      if (await actionExists(inv.id)) continue;
      await enqueue({
        kind: 'agent_invite',
        fireAt: inv.fireAt,
        payload: {
          contactId: c.contactId,
          friend1: inv.friends[0],
          friend2: inv.friends[1],
          at: inv.fireAt,
        },
        now,
        id: inv.id,
      });
    } catch (e) {
      logError('ainv.schedule', e);
    }
  }

  // 2) Seed each persona's first heartbeat and Moments post. Without this
  //    neither feature ever fires — nothing else enqueues the first one.
  //
  //    The pending set is read ONCE for the whole loop. It used to be two
  //    indexed-less queries per conversation, so returning to the app scanned
  //    the whole action store 2×N times and JSON.parsed every row on each pass.
  //    Rows queued inside this loop are tracked locally so the checks below
  //    still see them — the snapshot must not go stale mid-loop.
  const pending = await pendingActions();
  const queuedHere = new Set<string>();
  const alreadyQueued = (kind: 'heartbeat' | 'moment_post', contactId: string) =>
    queuedHere.has(`${kind}:${contactId}`) || isPendingForIn(pending, kind, contactId);

  for (const conv of s.conversations) {
    if (conv.type !== 'single' || !conv.peerId) continue;
    const persona = s.personaFor(conv.peerId);
    if (!persona) continue;
    if (!alreadyQueued('heartbeat', persona.contactId)) {
      queuedHere.add(`heartbeat:${persona.contactId}`);
      const edge = await getEdge('self', persona.contactId, now);
      const state = await getAgentState(persona.contactId);
      await scheduleHeartbeat(await driftedPersona(persona, now), conv.id, now, conv.lastMsgAt, {
        affinityMul: heartbeatAffinityMul(effectiveAffinity(edge, persona.affinityInit)),
        proactMul: moodParams(moodOf(persona.contactId, now).key).proactMul,
        notBefore: state.cooldownUntil || undefined,
      });
    }
    if (!alreadyQueued('moment_post', persona.contactId)) {
      queuedHere.add(`moment_post:${persona.contactId}`);
      await scheduleNextMoment(persona, now);
    }

    // Would she send you something today? Planned here rather than on a chain
    // of its own because a gift is a REACTION — to the date, to a fight, to you
    // having a bad day — and this pass already runs whenever the app is looked
    // at. The planner says no on almost every call (see money-motive).
    try {
      const tail = s.messagesFor(conv.id);
      const recent = tail.length ? tail.slice(-30) : await repo.getMessages(conv.id, { limit: 30 });
      await considerGift({ conv, persona, now, recent });
      // …and, far more rarely, whether she would actually ring you. A call is
      // the most intrusive thing this app can do — see call-motive for the
      // stack of reasons not to.
      await considerCall({ conv, persona, now, recent });
    } catch (e) {
      // Never let the money path block the rest of the foreground pass.
      logError('gift.plan', e);
    }

    // Nudge: their last message sat unanswered for 6–48h. One per ignored
    // message EVER — the id is checked against all statuses, because enqueue
    // upserts and would otherwise revive a completed nudge as pending.
    // Read through, not from the store: threads load on open (M-G2), so the
    // nudge would otherwise only ever consider conversations the user had
    // already visited this session — i.e. exactly the ones not being ignored.
    const last =
      s.messagesFor(conv.id).at(-1) ?? (await repo.getMessages(conv.id, { limit: 1 })).at(-1);
    if (last && shouldNudge(last, persona, now)) {
      const nudgeId = `nudge_${conv.id}_${last.id}`;
      if (!(await actionExists(nudgeId))) {
        // Being ignored is supposed to hurt: `user_ignored` has been defined
        // and weighted in affect.ts since M-E3 with NO producer anywhere, so
        // the one negative signal the user generates by doing nothing has
        // never once fired. This is the moment it means something — her
        // message has sat unanswered for 6–48h — and the `actionExists` guard
        // above makes it exactly once per ignored message.
        void recordAffect(persona.contactId, 'user_ignored', now).catch(() => {});
        void noteDrift(persona.contactId, 'user_ignored', now);
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

  // 2.5) A festival packet in a group. Festivals only — an apology or a
  //      "you seem down" packet in front of eight people is a different and
  //      much worse gesture, so `planGroupGift` refuses everything else.
  for (const conv of s.conversations) {
    if (conv.type !== 'group') continue;
    const members = (conv.memberIds ?? []).flatMap((id) => {
      const persona = s.personaFor(id);
      return persona ? [{ contactId: id, persona }] : [];
    });
    if (members.length === 0) continue;
    try {
      await considerGroupGift({ conv, members, now, facts: [] });
    } catch (e) {
      logError('gift.plan.group', e);
    }
  }

  // 3) Seed the first AI↔AI DM session if none is queued.
  try {
    if (!(await hasPendingOfKind('agent_dm'))) await scheduleNextAgentDm();
  } catch (e) {
    // Never blocks the foreground path — but if this throws every pass, the
    // entire AI↔AI chemistry layer is dead and nothing else would ever say so.
    logError('agentdm.seed', e);
    /* chemistry is a bonus; never block the foreground path on it */
  }

  // 3.4) Seed the built-in example scripts. Idempotent, and re-adds one the
  //      user deleted — the examples are the working reference for "write me a
  //      story", so having none is a worse default than having two.
  try {
    await seedBuiltinScripts(now);
  } catch (e) {
    logError('story.seed', e);
  }

  // 3.45) Auto-backup chain (M-I17): the settings page starts it, but a
  //       restore, a cancelled row or an old install must not silently end the
  //       habit — re-seed whenever the setting says one should exist.
  try {
    await ensureAutoBackupScheduled(now);
  } catch (e) {
    logError('autoBackup.schedule', e);
  }

  // 3.5) Retire settled rows. The queue was append-only since M4: the store grew
  //      forever and the once-a-second `duePending` scanned all of it. Cheap,
  //      idempotent, and safely outside every once-ever action's window.
  try {
    await gcActions(now);
  } catch (e) {
    logError('gcActions', e);
  }

  // 4) Rebuild the lock-screen notifications from the (now current) queue.
  try {
    // Notifications are scheduled from every PENDING action, not the due ones
    // — so this asks for the pending set directly. It used to call
    // `duePending(MAX_SAFE_INTEGER)`, whose upper-bound key range then covered
    // the entire index: v6 added `byFireAt` precisely to stop this read being
    // a full scan, and that one argument handed the optimisation straight back.
    //
    // 朋友圈赞评通知 (M-I15): the allowlist of the user's own posts rides in so
    // queued likes/comments on THEM notify too — built from stored rows here,
    // the one place with feed context, so notify-service itself stays pure.
    const selfMomentIds = new Set(
      (await repo.getMoments({ limit: 60 }).catch(() => []))
        .filter((m) => m.authorId === 'self')
        .map((m) => m.id),
    );
    await syncNotifications(await pendingActions(), s.contacts, now, { selfMomentIds });
  } catch (e) {
    // Notifications are the app's only presence while it is closed, and the
    // plugin-proxy bug that cost three weeks of dead device builds was hidden
    // by exactly this shape of catch. Still non-fatal, now never invisible.
    logError('notify.sync', e);
  }

  // 5) M-I10: refresh the home-screen widget from the now-current world.
  //    (Also pushed on backgrounding; never throws, no-op on web.)
  await syncWidget();
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
