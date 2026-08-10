import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { repo } from '../../src/db/repo';
import { makePolicy, type ResolvedConfig } from '../../src/llm/service';
import { LlmRouter, type RoutingPolicy, type RoutePlan, type RouteRequest } from '../../src/llm/router';
import type { ChatProvider, GenerateOptions, CompletionResult, Bubble } from '../../src/llm/types';
import type { ProviderVM, MessageVM } from '../../src/data/types';
import { makePersona } from '../../src/data/persona-defaults';
import { extractMemory, selectFactsForInjection } from '../../src/ai/memory';
import { callDirector } from '../../src/ai/director';
import { runAgentDm, type DmDeps, type DmPlan } from '../../src/ai/agent-dm';
import {
  tierFor,
  maxTier,
  sensitivityForTier,
  mayInjectFact,
  redactForTier,
} from '../../src/lib/nsfw-tier';

/**
 * G0 — the gate the whole M-E round sits behind.
 *
 * `nsfw-closure.test.ts` proves the ROUTER honours constitution rule #6. This
 * file proves the CALL SITES tell it the truth. That distinction is the entire
 * bug: M-C1 closed the routing set, then M-D2 walked around it by hard-coding
 * `nsfwTier: 'off'` in three background jobs that each carry verbatim chat
 * content. The router was never wrong; it was lied to.
 *
 * These tests drive the real `makePolicy` and record which provider each call
 * actually lands on. A regression here means explicit text is being posted to a
 * domestic official endpoint — the one failure in this repo that is externally
 * observable and cannot be taken back.
 */

const DOMESTIC_KINDS = ['deepseek', 'minimax'];

const prov = (id: string, kind: ProviderVM['kind'], models: string[]): ProviderVM => ({
  id,
  kind,
  label: id,
  baseUrl: `https://${id}.test/v1`,
  keyAlias: `key_${id}`,
  models,
  enabled: true,
});

/** Mainland-typical setup: DeepSeek for everyday work, Zen as the permissive lane. */
const CONFIG: ResolvedConfig = {
  providers: [
    prov('prov_deepseek', 'deepseek', ['deepseek-chat']),
    prov('prov_minimax', 'minimax', ['MiniMax-M2.5']),
    prov('prov_zen', 'zen', ['big-pickle']),
  ],
  defaultProviderId: 'prov_deepseek',
  nsfwProviderId: 'prov_zen',
};

interface Landing {
  role: RouteRequest['role'];
  tier: RouteRequest['nsfwTier'];
  providerId: string;
  providerKind: string;
  /** The prompt text that would have gone over the wire. */
  sent: string;
}

class StubProvider implements ChatProvider {
  constructor(
    public readonly id: string,
    public readonly kind: string,
    private reply: string,
    private sink: (sent: string) => void,
  ) {}
  async complete(opts: GenerateOptions): Promise<CompletionResult> {
    this.sink(opts.messages.map((m) => m.content ?? '').join('\n'));
    return { text: this.reply, finishReason: 'stop' };
  }
  async *generate(): AsyncIterable<Bubble> {
    /* unused */
  }
  async listModels() {
    return [];
  }
}

/**
 * A router over the REAL policy whose providers are swapped for stubs at the
 * last moment — so routing decisions are genuine but nothing leaves the process.
 */
function recordingRouter(reply: string, cfg: ResolvedConfig = CONFIG) {
  const landings: Landing[] = [];
  const real = makePolicy(cfg);
  const policy: RoutingPolicy = {
    plan(req): RoutePlan {
      const p = real.plan(req);
      const wrap = (pv: ChatProvider) =>
        new StubProvider(pv.id, pv.kind, reply, (sent) =>
          landings.push({
            role: req.role,
            tier: req.nsfwTier,
            providerId: pv.id,
            providerKind: pv.kind,
            sent,
          }),
        );
      return {
        provider: wrap(p.provider),
        model: p.model,
        fallbacks: p.fallbacks.map((f) => ({ provider: wrap(f.provider), model: f.model })),
      };
    },
  };
  return { router: new LlmRouter(policy), landings };
}

const EXPLICIT = '这是一段全开档才会出现的露骨原文，绝不能出现在国内官方端点上';

function msg(id: number, senderId: string, content: string): MessageVM {
  return {
    id,
    convId: 'c_full',
    senderId,
    type: 'text',
    content,
    status: 'sent',
    createdAt: 1_754_600_000_000 + id * 1000,
  };
}

beforeEach(async () => {
  await repo.putSetting('nsfwGlobalTier', 'full');
});

/* ------------------------------------------------------------------ */

describe('call site 1 — extractMemory (the M-D2 breach)', () => {
  it('routes a full-tier transcript to the permissive channel, never domestic', async () => {
    const { router, landings } = recordingRouter(
      JSON.stringify({ facts: [{ fact: '用户的偏好', importance: 4, evidence_msg_ids: [1] }] }),
    );
    await extractMemory(router, 'ai_full', [msg(1, 'self', EXPLICIT)], 1_754_600_100_000, 'full');

    expect(landings).toHaveLength(1);
    expect(landings[0].tier).toBe('full');
    expect(DOMESTIC_KINDS).not.toContain(landings[0].providerKind);
    expect(landings[0].providerId).toBe('prov_zen');
    // The transcript really is the explicit text — this is not a vacuous pass.
    expect(landings[0].sent).toContain(EXPLICIT);
  });

  it('an off-tier chat still uses the cheap default provider (no over-correction)', async () => {
    const { router, landings } = recordingRouter(JSON.stringify({ facts: [] }));
    await extractMemory(router, 'ai_sfw', [msg(1, 'self', '今天下雨了')], 1_754_600_100_000, 'off');
    expect(landings[0].providerId).toBe('prov_deepseek');
  });

  it('with no permissive channel configured, full-tier extraction fails instead of leaking', async () => {
    const { router, landings } = recordingRouter(JSON.stringify({ facts: [] }), {
      providers: [prov('prov_deepseek', 'deepseek', ['deepseek-chat'])],
      defaultProviderId: 'prov_deepseek',
    });
    await expect(
      extractMemory(router, 'ai_full', [msg(1, 'self', EXPLICIT)], 1_754_600_100_000, 'full'),
    ).rejects.toThrow(/宽松通道/);
    // Skipping the extraction entirely is the correct outcome — silence beats a leak.
    expect(landings).toEqual([]);
  });

  it('stamps extracted facts with the source tier so the injection whitelist can hold', async () => {
    const { router } = recordingRouter(
      JSON.stringify({ facts: [{ fact: '一件私密的事', importance: 5, evidence_msg_ids: [1] }] }),
    );
    const { facts } = await extractMemory(
      router,
      'ai_grade',
      [msg(1, 'self', EXPLICIT)],
      1_754_600_100_000,
      'full',
    );
    expect(facts[0].sensitivity).toBe('nsfw');
  });
});

describe('call site 2 — callDirector (group transcript)', () => {
  const members = [
    { contactId: 'ai_a', name: '小雨', persona: makePersona({ contactId: 'ai_a', core: 'c' }) },
    { contactId: 'ai_b', name: 'Ada', persona: makePersona({ contactId: 'ai_b', core: 'c' }) },
  ];
  const ctxBase = {
    candidates: members,
    recent: [msg(1, 'ai_a', EXPLICIT)],
    nameOf: (id: string) => (id === 'ai_a' ? '小雨' : 'Ada'),
  };

  it('a full-tier group casts on the permissive channel', async () => {
    const { router, landings } = recordingRouter(
      JSON.stringify({ silence: false, speakers: [{ agentId: 'ai_a', priority: 1 }] }),
    );
    await callDirector(router, { ...ctxBase, tier: 'full' }, 'g1');
    expect(landings).toHaveLength(1);
    expect(DOMESTIC_KINDS).not.toContain(landings[0].providerKind);
  });

  it('redacts the transcript above off-tier — casting needs who spoke, not the words', async () => {
    const { router, landings } = recordingRouter(
      JSON.stringify({ silence: false, speakers: [{ agentId: 'ai_a', priority: 1 }] }),
    );
    await callDirector(router, { ...ctxBase, tier: 'full' }, 'g1');
    expect(landings[0].sent).not.toContain(EXPLICIT);
    expect(landings[0].sent).toContain('小雨');
  });

  it('off-tier still sends the full transcript (director quality is unchanged)', async () => {
    const { router, landings } = recordingRouter(
      JSON.stringify({ silence: false, speakers: [{ agentId: 'ai_a', priority: 1 }] }),
    );
    await callDirector(
      router,
      { ...ctxBase, recent: [msg(1, 'ai_a', '晚上吃啥')], tier: 'off' },
      'g1',
    );
    expect(landings[0].sent).toContain('晚上吃啥');
    expect(landings[0].providerId).toBe('prov_deepseek');
  });
});

describe('call site 3 — runAgentDm (hidden, and therefore trace-free)', () => {
  const plan: DmPlan = { a: 'ai_x', b: 'ai_y', groupId: 'g1', fireAt: 1_754_700_000_000 };

  function deps(over: Partial<DmDeps> = {}): { deps: DmDeps; tiers: Array<string | undefined> } {
    const tiers: Array<string | undefined> = [];
    const base: DmDeps = {
      getPersona: (id) =>
        makePersona({ contactId: id, core: 'c', nsfwPermit: id === 'ai_x' }),
      getContact: (id) => ({ id, type: 'ai', name: id, avatarColor: '#000', avatarText: 'x' }),
      getConversation: async () => undefined,
      addConversation: async () => {},
      appendMessage: async (m) => ({ ...m, id: 1 }) as MessageVM,
      putMemory: async () => {},
      getMemoryFacts: async () => [],
      getGroupMessages: async () => [msg(1, 'ai_x', EXPLICIT)],
      getMoments: async () => [],
      complete: async (_m, _k, tier) => {
        tiers.push(tier);
        return '{"speaker":"A","text":"嗨"}\n{"speaker":"B","text":"嗯"}';
      },
      enqueueGroupSpill: async () => {},
      now: () => 1_754_700_000_000,
      getGlobalTier: async () => 'full',
      ...over,
    };
    return { deps: base, tiers };
  }

  it('derives the tier from the participants rather than declaring off', async () => {
    const { deps: d, tiers } = deps();
    expect(await runAgentDm(plan, d)).toBe(true);
    // ai_x holds a permit and the global tier is full → the DM material is full.
    expect(tiers).toEqual(['full']);
  });

  it('stays off when neither participant holds a permit', async () => {
    const { deps: d, tiers } = deps({
      getPersona: (id) => makePersona({ contactId: id, core: 'c', nsfwPermit: false }),
    });
    await runAgentDm(plan, d);
    expect(tiers).toEqual(['off']);
  });

  it('the declared tier lands on a permissive provider end to end', async () => {
    const { router, landings } = recordingRouter('{"speaker":"A","text":"嗨"}\n{"speaker":"B","text":"嗯"}');
    const { deps: d } = deps({
      // Exactly how useSchedulerRuntime wires it.
      complete: async (messages, convKey, tier) =>
        (await router.complete({ role: 'chat', nsfwTier: tier ?? 'off' }, { messages }, {}, convKey))
          .text,
    });
    await runAgentDm(plan, d);
    expect(landings).toHaveLength(1);
    expect(DOMESTIC_KINDS).not.toContain(landings[0].providerKind);
  });
});

/* ------------------------------------------------------------------ */

describe('tier derivation is centralised (call sites cannot invent one)', () => {
  const permit = makePersona({ contactId: 'p', core: 'c', nsfwPermit: true });
  const noPermit = makePersona({ contactId: 'n', core: 'c', nsfwPermit: false });

  it('a persona without a permit pins the tier to off regardless of the global setting', () => {
    expect(tierFor('full', noPermit)).toBe('off');
    expect(tierFor('full', undefined)).toBe('off');
    expect(tierFor('full', permit)).toBe('full');
  });

  it('a group takes the tier of its most-permitted member', () => {
    expect(maxTier('full', [noPermit, permit])).toBe('full');
    expect(maxTier('full', [noPermit, noPermit])).toBe('off');
    expect(maxTier('off', [permit])).toBe('off'); // the global setting still caps it
  });

  it('grades sensitivity by the tier the material came from', () => {
    expect(sensitivityForTier('off')).toBe('normal');
    expect(sensitivityForTier('ambiguous')).toBe('sensitive');
    expect(sensitivityForTier('full')).toBe('nsfw');
  });

  it('redaction keeps speaker attribution and drops the words', () => {
    const out = redactForTier([msg(1, 'ai_a', EXPLICIT)], () => '小雨', 6);
    expect(out).toContain('小雨');
    expect(out).not.toContain(EXPLICIT);
    expect(out).toContain('…');
  });
});

describe('memory injection whitelist (specs/nsfw.md, finally implemented)', () => {
  it('nsfw facts reach single chat at full tier only', () => {
    expect(mayInjectFact('nsfw', 'single', 'full')).toBe(true);
    expect(mayInjectFact('nsfw', 'single', 'ambiguous')).toBe(false);
    for (const s of ['group', 'moments', 'director', 'dm'] as const) {
      expect(mayInjectFact('nsfw', s, 'full')).toBe(false);
    }
  });

  it('sensitive facts need any non-off tier, single chat only', () => {
    expect(mayInjectFact('sensitive', 'single', 'ambiguous')).toBe(true);
    expect(mayInjectFact('sensitive', 'single', 'off')).toBe(false);
    expect(mayInjectFact('sensitive', 'group', 'full')).toBe(false);
  });

  it('normal facts go anywhere — the common path is untouched', () => {
    for (const s of ['single', 'group', 'moments', 'director', 'dm'] as const) {
      expect(mayInjectFact('normal', s, 'off')).toBe(true);
      expect(mayInjectFact(undefined, s, 'off')).toBe(true);
    }
  });

  it('the selector actually applies it: an nsfw fact never reaches a Moments prompt', () => {
    const now = 1_754_600_000_000;
    const facts = [
      {
        id: 'f1',
        subjectId: 'ai_a',
        fact: '用户喜欢喝美式',
        importance: 3,
        sensitivity: 'normal' as const,
        evidenceMsgIds: [1],
        status: 'confirmed' as const,
        isPinned: false,
        createdAt: now,
      },
      {
        id: 'f2',
        subjectId: 'ai_a',
        fact: '一件私密的事',
        importance: 5,
        sensitivity: 'nsfw' as const,
        evidenceMsgIds: [2],
        // Pinned AND top-importance: it would win both slots without the gate.
        status: 'confirmed' as const,
        isPinned: true,
        createdAt: now,
      },
    ];
    const moments = selectFactsForInjection(facts, now, { surface: 'moments', tier: 'full' });
    expect(moments.pinned).toEqual([]);
    expect([...moments.pinned, ...moments.topK]).not.toContain('一件私密的事');

    const single = selectFactsForInjection(facts, now, { surface: 'single', tier: 'full' });
    expect(single.pinned).toContain('一件私密的事');
  });
});
