/**
 * 全链路集成测试 (M-J11)：一句话从发出到「她记住了」再到「搜得到」。
 *
 * 这个仓库有 2,000 多条单测，但**没有一条把这条链串起来**：每一环各自绿着，
 * 而链条断在环与环之间的次数比断在环里多——M-I18 那次审计抓到的
 * `sendImages` 只 appendMessage 从不调发送路径，就是典型：两端的单测都是绿的。
 *
 * 所以这里刻意**不 mock repo**。真 IndexedDB（fake-indexeddb）、真 scheduler
 * 队列、真 `extractMemory`、真 `search()`。替换掉的只有两样：
 *   - **网络**（LLM 换成录制好的固定回答）——不然测试要花钱且不确定；
 *   - **store**（zustand 那层是 React 的，与这条链的正确性无关）。
 * 这两处正是「集成」该停下来的边界。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import 'fake-indexeddb/auto';
import { repo } from '../../src/db/repo';
import { enqueue, registerHandler, runDueActions } from '../../src/ai/scheduler';
import { handleMemExtract } from '../../src/ai/handlers';
import { extractMemory } from '../../src/ai/memory';
import { search } from '../../src/lib/search';
import type { HandlerDeps } from '../../src/ai/handlers';
import type { ContactVM, ConversationVM, MessageVM } from '../../src/data/types';
import type { LlmRouter } from '../../src/llm/router';

const T0 = 1_755_500_000_000;
const CONV = 'conv_int';
const WHO = 'ai_int';

/**
 * 录制好的抽取回答。真 `extractMemory` 会去解析它——所以这份 fixture 的**格式**
 * 本身也在被测。
 *
 * 写这份 fixture 时第一版用了 `{text, sensitivity}` 且没有 `evidence_msg_ids`，
 * 测试当场红在「记忆是空的」：真契约是 `fact` + **必须带证据消息 id**（没有
 * 引用的事实一律丢弃，这是记忆层的证据闸）。一个 mock 掉 extractMemory 的
 * 测试会心满意足地绿——而那正是这份文件存在的理由。
 */
const FIXTURE_FACTS = JSON.stringify({
  facts: [
    { fact: '她对香菜过敏，闻到就想吐', importance: 4, evidence_msg_ids: [1] },
    { fact: '她周五晚上要去看牙', importance: 2, evidence_msg_ids: [2] },
  ],
  summary: '聊了吃的和周末安排。',
});

const fakeRouter = {
  complete: async () => ({ text: FIXTURE_FACTS, usage: undefined }),
} as unknown as LlmRouter;

const contact: ContactVM = {
  id: WHO,
  type: 'ai',
  name: '林小雨',
  avatarColor: '#AABBCC',
  avatarText: '雨',
};

const conversation: ConversationVM = {
  id: CONV,
  type: 'single',
  peerId: WHO,
  title: '林小雨',
  avatarColor: '#AABBCC',
  avatarText: '雨',
  isPinned: false,
  isMuted: false,
  unreadCount: 0,
  mentionMe: false,
  lastMsgPreview: '',
  lastMsgAt: T0,
};

/**
 * 真 deps，只有 router 与 store 是替身。
 *
 * `runMemExtract` 在生产里住在 useSchedulerRuntime 且直接读 store，所以这里给
 * 它一个等价实现——但它调的是**真** extractMemory、写的是**真** repo。
 */
function makeDeps(): HandlerDeps {
  return {
    contactById: (id: string) => (id === WHO ? contact : undefined),
    personaFor: () => undefined,
    conversationById: (id: string) => (id === CONV ? conversation : undefined),
    messagesFor: () => [],
    conversationExists: (id: string) => id === CONV,
    getMessages: (convId: string, opts?: { limit?: number; beforeId?: number }) =>
      repo.getMessages(convId, opts),
    getMemory: (id: string) => repo.getMemory(id),
    putConvSummary: (row: Parameters<typeof repo.putConvSummary>[0]) => repo.putConvSummary(row),
    getGlobalTier: async () => 'off' as const,
    now: () => T0,
    runMemExtract: async ({ convId, contactId, uptoMsgId }: { convId: string; contactId: string; uptoMsgId: number }) => {
      const msgs = (await repo.getMessages(convId, { limit: 60 })).filter(
        (m) => m.id <= uptoMsgId && m.type === 'text' && !m.isRecalled,
      );
      // extractMemory 自己就会把通过证据闸的事实写进 repo——这里不再补写一遍，
      // 否则测的就成了「测试自己写的东西」而不是「产品写的东西」。
      const res = await extractMemory(fakeRouter, contactId, msgs, T0, 'off');
      if (res.summary) {
        await repo.putConvSummary({ convId, summary: res.summary, uptoMsgId, updatedAt: T0 });
      }
    },
  } as unknown as HandlerDeps;
}

describe('全链路：发送 → 落库 → 排期 → 抽取 → 记忆可检索', () => {
  beforeAll(async () => {
    await repo.putContact(contact);
    await repo.putConversation(conversation);
    registerHandler('mem_extract', (p) => handleMemExtract(makeDeps(), p));
  });

  it('走完整条链，一步不 mock 存储', async () => {
    /* 1. 用户说话，真的写进库 */
    const mine = await repo.addMessage({
      convId: CONV,
      senderId: 'self',
      type: 'text',
      content: '我不吃香菜，一点都不行',
      status: 'sent',
      createdAt: T0 + 1,
    } as Omit<MessageVM, 'id'>);
    expect(mine.id).toBeGreaterThan(0);

    /* 2. 她回一句，也真的写进库 */
    const hers = await repo.addMessage({
      convId: CONV,
      senderId: WHO,
      type: 'text',
      content: '记住了。那周五吃火锅别放香菜。',
      status: 'sent',
      createdAt: T0 + 2,
    } as Omit<MessageVM, 'id'>);

    /* 3. 排一次记忆抽取——经由真队列，不是直接调 handler */
    await enqueue({
      kind: 'mem_extract',
      fireAt: T0 + 3,
      payload: { convId: CONV, contactId: WHO, uptoMsgId: hers.id },
      now: T0,
    });

    /* 4. 时间到了，队列自己排空 */
    const ran = await runDueActions(T0 + 10);
    expect(ran, '到期的 mem_extract 没有被执行——链条断在调度器这一环').toBeGreaterThan(0);

    /* 5. 她真的记住了（读的是库，不是内存里的什么变量） */
    const facts = await repo.getMemory(WHO);
    expect(facts.map((f) => f.fact).join('｜')).toContain('香菜');

    /* 6. 而且搜得到——M-J10 刚把记忆接进搜索，这是它的第一条端到端验证 */
    const hits = search(
      {
        contacts: [contact],
        conversations: [conversation],
        messages: {},
        moments: [],
        memories: facts.map((f) => ({
          id: f.id,
          subjectId: f.subjectId,
          text: f.fact,
          createdAt: f.createdAt,
        })),
      },
      '香菜',
    );
    const memHit = hits.find((h) => h.kind === 'memory');
    expect(memHit, '记忆写进去了却搜不到——搜索与记忆之间那一环断了').toBeDefined();
    expect(memHit!.title).toBe('林小雨');

    /* 7. 会话摘要也落了库（同一次抽取顺带产出，不额外花 token） */
    const summary = await repo.getConvSummary(CONV);
    expect(summary?.summary).toContain('周末');
  });

  /**
   * 重复执行不翻倍——但要说清它验的到底是什么，别把话说大。
   *
   * 事实 id 是 `mem_<subjectId>_<now>_<序号>`，**由时钟派生，不是由内容派生**。
   * 这个测试注入的是固定的 T0，所以第二次跑算出同一批 id，`putMemory` 按 id
   * upsert，于是不翻倍。它验的是「写入是 upsert 而不是 append」这一条，
   * 以及第二次跑真的走完了整条链没有抛。
   *
   * 它**没有**验生产里的去重：那由 `memext:<convId>` 水位守着，而水位读写住在
   * useSchedulerRuntime 的 runMemExtract 里（它直接读 store），这里的替身没有
   * 复制那段逻辑。真时钟下重复抽取会产生新 id，靠的是水位挡在前面，不是 upsert。
   */
  it('重复执行不会把同一条记忆写成两条（固定时钟下的 upsert 语义）', async () => {
    const before = (await repo.getMemory(WHO)).length;
    await enqueue({
      kind: 'mem_extract',
      fireAt: T0 + 20,
      payload: { convId: CONV, contactId: WHO, uptoMsgId: 999 },
      now: T0,
    });
    await runDueActions(T0 + 30);
    expect((await repo.getMemory(WHO)).length).toBe(before);
  });
});
