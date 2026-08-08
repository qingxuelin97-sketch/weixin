/**
 * Wires the scheduler's action handlers to the store and starts the foreground
 * tick. Lives in the app shell so `scheduler.ts` stays dependency-free and
 * unit-testable, while handlers can reach the store/Repo freely.
 */
import { useEffect } from 'react';
import { registerHandler, startScheduler, stopScheduler } from '../ai/scheduler';
import { claimRedPacket, acceptTransfer } from '../ai/money-service';
import { sendProactiveMessage } from '../ai/engine';
import { scheduleHeartbeat, hasPendingHeartbeat } from '../ai/heartbeat';
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

    startScheduler();

    // Seed each persona's first heartbeat. Without this the whole proactive
    // feature never fires — nothing else enqueues one.
    void (async () => {
      const s = useAppStore.getState();
      for (const conv of s.conversations) {
        if (conv.type !== 'single' || !conv.peerId) continue;
        const persona = s.personaFor(conv.peerId);
        if (!persona) continue;
        if (await hasPendingHeartbeat(persona.contactId)) continue;
        await scheduleHeartbeat(persona, conv.id, Date.now());
      }
    })();

    return () => stopScheduler();
  }, [enabled]);
}
