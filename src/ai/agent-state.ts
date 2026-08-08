/**
 * Per-agent runtime state (M-D1, activates the long-dead agent_state concept):
 * anti-spam bookkeeping for proactivity. An AI that reached out twice with no
 * reply STOPS for 24h — pestering is the opposite of humanization, and until
 * now nothing enforced it across heartbeats.
 *
 * Settings-backed (`agent_state:<id>` rows), no new object store.
 */
import { repo } from '../db/repo';

export interface AgentState {
  /** Consecutive proactive messages since the user last replied. */
  consec: number;
  /** No proactive contact before this timestamp (0 = no cooldown). */
  cooldownUntil: number;
}

const COOLDOWN_MS = 24 * 3_600_000;
const MAX_CONSEC = 2;

const keyOf = (contactId: string) => `agent_state:${contactId}`;

export async function getAgentState(contactId: string): Promise<AgentState> {
  return (await repo.getSetting<AgentState>(keyOf(contactId))) ?? { consec: 0, cooldownUntil: 0 };
}

/** Call when a proactive message (heartbeat/nudge) actually lands. */
export async function noteProactiveSent(contactId: string, now: number): Promise<AgentState> {
  const s = await getAgentState(contactId);
  const consec = s.consec + 1;
  const next: AgentState = {
    consec,
    cooldownUntil: consec >= MAX_CONSEC ? now + COOLDOWN_MS : s.cooldownUntil,
  };
  await repo.putSetting(keyOf(contactId), next);
  return next;
}

/** Call when the user replies to this AI — forgiveness is immediate. */
export async function noteUserReplied(contactId: string): Promise<void> {
  const s = await getAgentState(contactId);
  if (s.consec === 0 && s.cooldownUntil === 0) return;
  await repo.putSetting(keyOf(contactId), { consec: 0, cooldownUntil: 0 });
}
