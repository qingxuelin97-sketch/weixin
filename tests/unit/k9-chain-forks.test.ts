/**
 * 分叉的自续链 (M-K9，做首次引导时撞见的)。
 *
 * 自续链（心跳、AI 发帖、AI↔AI 私信）每一环开火前先续下一环。问题在于这三个 kind
 * 还有**一次性**的行：nudge（被晾着的那条消息的一次性追问）和离线回填（规划好的
 * 过去事件，payload 里带 `at`）。续链那一步对它们照跑——于是一次 nudge、一次长时间
 * 离开之后的回填，都会在原链之外再接出一条链。同一个人身上跑着两三条心跳链，她的
 * 主动消息就越晾越多；24 小时冷却只是把它们隔开，只有恰好撞上同一个 fireAt id 时才
 * 偶然合并。
 *
 * 修两处：续链步骤跳过一次性行；前台一遍剪掉存量的分叉（每条链只留最早的一环）。
 * 另一半同样要紧：一次性行不再续链之后，它们也不许再被算作「链已就位」——否则
 * 它一开火，这条链就没了，没人重新挂。
 */
import { describe, it, expect } from 'vitest';
import { chainHeartbeat, chainMomentPost, chainAgentDm, type HandlerDeps } from '../../src/ai/handlers';
import { forkedChains, isChainOneOff, isPendingForIn, type ScheduledAction } from '../../src/ai/scheduler';
import { makePersona } from '../../src/data/persona-defaults';
import type { ContactVM, ConversationVM } from '../../src/data/types';

function deps(calls: string[]): HandlerDeps {
  return {
    contactById: (id: string) => ({ id, name: id, type: 'ai' }) as ContactVM,
    personaFor: (id: string) => makePersona({ contactId: id, core: 'c' }),
    conversationById: (id: string) => ({ id, type: 'single', lastMsgAt: 0 }) as ConversationVM,
    conversationExists: () => true,
    chainHeartbeat: async (p: { contactId: string }) => void calls.push(`hb:${p.contactId}`),
    chainMomentPost: async (p: { contactId: string }) => void calls.push(`post:${p.contactId}`),
    chainAgentDm: async () => void calls.push('dm'),
  } as unknown as HandlerDeps;
}

describe('一次性行不续链', () => {
  it('链上的环照常续', async () => {
    const calls: string[] = [];
    await chainHeartbeat(deps(calls), { contactId: 'ai_a', convId: 'c_a' });
    await chainMomentPost(deps(calls), { contactId: 'ai_a' });
    await chainAgentDm(deps(calls), { a: 'ai_a', b: 'ai_b', fireAt: 1 });
    expect(calls).toEqual(['hb:ai_a', 'post:ai_a', 'dm']);
  });

  it('nudge 与回填的行一个都不续', async () => {
    const calls: string[] = [];
    await chainHeartbeat(deps(calls), { contactId: 'ai_a', convId: 'c_a', nudge: true });
    await chainHeartbeat(deps(calls), { contactId: 'ai_a', convId: 'c_a', at: 123 });
    await chainMomentPost(deps(calls), { contactId: 'ai_a', at: 123 });
    await chainAgentDm(deps(calls), { a: 'ai_a', b: 'ai_b', fireAt: 123, at: 123 });
    expect(calls).toEqual([]);
  });

  it('判据：nudge 或带 at；活链的 payload 形状一个都不命中', () => {
    expect(isChainOneOff({ nudge: true })).toBe(true);
    expect(isChainOneOff({ at: 0 })).toBe(true);
    expect(isChainOneOff({ contactId: 'a', convId: 'c', body: '在吗' })).toBe(false); // heartbeat link
    expect(isChainOneOff({ contactId: 'a' })).toBe(false); // moment_post link
    expect(isChainOneOff({ a: 'x', b: 'y', groupId: 'g', fireAt: 5 })).toBe(false); // agent_dm link
  });
});

const row = (id: string, kind: ScheduledAction['kind'], fireAt: number, payload: Record<string, unknown>) =>
  ({ id, kind, fireAt, status: 'pending', payloadJson: JSON.stringify(payload), createdAt: 0 }) satisfies ScheduledAction;

describe('「链已就位」不算一次性行', () => {
  it('只有回填行 / nudge 在等着时，心跳链算没挂上', () => {
    const pending = [
      row('bf_heartbeat_ai_a_1', 'heartbeat', 1, { contactId: 'ai_a', convId: 'c', at: 1 }),
      row('nudge_c_9', 'heartbeat', 2, { contactId: 'ai_a', convId: 'c', nudge: true }),
    ];
    expect(isPendingForIn(pending, 'heartbeat', 'ai_a')).toBe(false);
    pending.push(row('hb_ai_a_3', 'heartbeat', 3, { contactId: 'ai_a', convId: 'c' }));
    expect(isPendingForIn(pending, 'heartbeat', 'ai_a')).toBe(true);
  });
});

describe('剪掉存量的分叉', () => {
  it('同一个人的心跳链只留最早的一环；不同人互不影响；一次性行不动', () => {
    const pending = [
      row('hb_a_30', 'heartbeat', 30, { contactId: 'ai_a', convId: 'c_a' }),
      row('hb_a_10', 'heartbeat', 10, { contactId: 'ai_a', convId: 'c_a' }),
      row('hb_a_20', 'heartbeat', 20, { contactId: 'ai_a', convId: 'c_a' }),
      row('hb_b_50', 'heartbeat', 50, { contactId: 'ai_b', convId: 'c_b' }),
      row('nudge_x', 'heartbeat', 5, { contactId: 'ai_a', convId: 'c_a', nudge: true }),
      row('bf_heartbeat_ai_a_1', 'heartbeat', 1, { contactId: 'ai_a', convId: 'c_a', at: 1 }),
    ];
    expect([...forkedChains(pending)].sort()).toEqual(['hb_a_20', 'hb_a_30']);
  });

  it('发帖链按人、私信链按整个名单', () => {
    const pending = [
      row('mpost_a_1', 'moment_post', 1, { contactId: 'ai_a' }),
      row('mpost_a_2', 'moment_post', 2, { contactId: 'ai_a' }),
      row('mpost_b_3', 'moment_post', 3, { contactId: 'ai_b' }),
      row('dm_7', 'agent_dm', 7, { a: 'ai_a', b: 'ai_b', fireAt: 7 }),
      row('dm_4', 'agent_dm', 4, { a: 'ai_b', b: 'ai_c', fireAt: 4 }),
      row('bf_agent_dm_x', 'agent_dm', 2, { a: 'ai_a', b: 'ai_c', fireAt: 2, at: 2 }),
    ];
    expect([...forkedChains(pending)].sort()).toEqual(['dm_7', 'mpost_a_2']);
  });

  it('不是自续链的 kind 一律不管（聚会的相位链、群聊脉搏都有自己的 id 规矩）', () => {
    const pending = [
      row('ge_1', 'group_event', 1, { convId: 'g' }),
      row('ge_2', 'group_event', 2, { convId: 'g' }),
    ];
    expect(forkedChains(pending).size).toBe(0);
  });
});

describe('接线（写了没接线 = 没做）', () => {
  it('前台一遍真的剪分叉，并且用剪过的待办集合往下判断；私信链按「链」判就位', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '../../src/app/useSchedulerRuntime.ts'), 'utf8');
    expect(src).toMatch(/const forked = forkedChains\(loaded\)/);
    expect(src).toMatch(/cancelPendingWhere\(\(_p, a\) => forked\.has\(a\.id\)\)/);
    expect(src).toMatch(/const pending = forked\.size \? loaded\.filter/);
    expect(src).toContain("hasPendingChainOfKind('agent_dm')");
    expect(src).toContain('chain: (p) => chainAgentDmStep(deps, p)');
  });
});
