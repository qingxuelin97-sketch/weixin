/**
 * Wires the scheduler's action handlers to the store and starts the foreground
 * tick. Lives in the app shell so `scheduler.ts` stays dependency-free and
 * unit-testable, while handlers can reach the store/Repo freely.
 */
import { useEffect } from 'react';
import { registerHandler, startScheduler, stopScheduler } from '../ai/scheduler';
import { claimRedPacket, acceptTransfer } from '../ai/money-service';
import { useAppStore } from '../store/appStore';

export function useSchedulerRuntime(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const store = useAppStore.getState();
    const hooks = {
      appendMessage: store.appendMessage,
      updateMessage: store.updateMessage,
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

    startScheduler();
    return () => stopScheduler();
  }, [enabled]);
}
