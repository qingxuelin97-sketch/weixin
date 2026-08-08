/**
 * Wires the scheduler's action handlers to the store and starts the foreground
 * tick. Lives in the app shell so `scheduler.ts` stays dependency-free and
 * unit-testable, while handlers can reach the store/Repo freely.
 */
import { useEffect } from 'react';
import { registerHandler, startScheduler, stopScheduler, hasPendingFor } from '../ai/scheduler';
import { claimRedPacket, acceptTransfer } from '../ai/money-service';
import { sendProactiveMessage } from '../ai/engine';
import { scheduleHeartbeat } from '../ai/heartbeat';
import { runMomentPost, runMomentLike, runMomentComment, scheduleNextMoment } from '../ai/moments-service';
import { runBackfill } from '../ai/backfill';
import type { SimContact } from '../ai/simulate';
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
    registerHandler('heartbeat', async (payload) => {
      const contactId = String(payload.contactId ?? '');
      const convId = String(payload.convId ?? '');
      const at = typeof payload.at === 'number' ? payload.at : undefined;
      if (!contactId || !convId) return;
      const s = useAppStore.getState();
      const peer = s.contactById(contactId);
      const persona = s.personaFor(contactId);
      if (!peer || !persona) return;
      const tier = (await repo.getSetting<NsfwTierVM>('nsfwGlobalTier')) ?? 'off';
      await sendProactiveMessage(convId, peer, persona, tier, hooks, at);
      // Chain the next one so the rhythm continues.
      await scheduleHeartbeat(persona, convId, Date.now());
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

    void (async () => {
      const s = useAppStore.getState();
      const now = Date.now();

      // 1) Backfill what "happened" while the app was closed. Runs first so the
      //    fabricated past is queued before any future scheduling looks at it.
      const singles = s.conversations.flatMap<SimContact>((c) => {
        if (c.type !== 'single' || !c.peerId) return [];
        const persona = s.personaFor(c.peerId);
        if (!persona) return [];
        return [{ contactId: c.peerId, convId: c.id, persona, lastMsgAt: c.lastMsgAt }];
      });
      try {
        await runBackfill(now, { singles, groups: [] });
      } catch {
        // A failed backfill must never block startup — the app still works,
        // it just doesn't show a fabricated absence this launch.
      }

      // 2) Seed each persona's first heartbeat and first Moments post. Without
      //    this neither feature ever fires — nothing else enqueues the first one.
      for (const conv of s.conversations) {
        if (conv.type !== 'single' || !conv.peerId) continue;
        const persona = s.personaFor(conv.peerId);
        if (!persona) continue;
        if (!(await hasPendingFor('heartbeat', persona.contactId))) {
          await scheduleHeartbeat(persona, conv.id, now);
        }
        if (!(await hasPendingFor('moment_post', persona.contactId))) {
          await scheduleNextMoment(persona, now);
        }
      }
    })();

    return () => stopScheduler();
  }, [enabled]);
}
