/**
 * ChatPage 拆分 (M-K11)：线程 / 发送管线 / 组合器。
 *
 * 两半守卫。**形状**那一半管的是「冷启动不为引擎付费」——它和 K10 的三条一样，
 * 一句话就能被悄悄加回来、加回来的那一刻没有任何功能会坏：ChatPage（或 store）
 * 重新静态 import 一个引擎函数，整棵引擎树就回到主包。棘轮最终也会红，但它只说
 * 「多了 6KB」，不说是哪一行。
 *
 * **行为**那一半管的是搬家本身：发送管线把五份几乎一样的「群聊走导演、单聊走引擎」
 * 收成了一份，这里把每条路由钉住——引用在两种会话里都带上、斗图命中走队列不走
 * 计时器、未命中照常回复、没有人设卡时消息照样落库。引擎与群聊导演在这里是桩：
 * 被测的是编排，不是生成。
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const calls: Array<[string, ...unknown[]]> = [];
vi.mock('../../src/ai/engine', () => ({
  sendUserMessage: vi.fn(async (...a: unknown[]) => void calls.push(['sendUserMessage', ...a])),
  replyToLatest: vi.fn(async (...a: unknown[]) => void calls.push(['replyToLatest', ...a])),
  regenerateLastTurn: vi.fn(async (...a: unknown[]) => void calls.push(['regenerateLastTurn', ...a])),
  effectiveTier: (g: string, permit: boolean) => (permit ? g : 'off'),
}));
vi.mock('../../src/ai/group-engine', () => ({
  sendGroupMessage: vi.fn(async (...a: unknown[]) => void calls.push(['sendGroupMessage', ...a])),
  replyToLatestInGroup: vi.fn(async (...a: unknown[]) => void calls.push(['replyToLatestInGroup', ...a])),
}));
vi.mock('../../src/ai/scheduler', async (orig) => ({
  ...(await orig<typeof import('../../src/ai/scheduler')>()),
  enqueue: vi.fn(async (opts: unknown) => void calls.push(['enqueue', opts])),
}));
vi.mock('../../src/ai/sticker-taste', async (orig) => ({
  ...(await orig<typeof import('../../src/ai/sticker-taste')>()),
  agentStickerPool: async () => [],
}));

import { useAppStore } from '../../src/store/appStore';
import * as pipeline from '../../src/features/chat/send-pipeline';
import { battleReply } from '../../src/ai/sticker-battle';
import type { ContactVM, ConversationVM, PersonaVM } from '../../src/data/types';

const ROOT = resolve(__dirname, '../../');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
/** 宪法 3.5：先剥注释——解释「为什么不静态导入」的注释本身就含有那句导入。 */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
function staticImports(src: string): string[] {
  return [...src.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map(
    (m) => m[1],
  );
}
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('冷启动不为引擎付费（形状）', () => {
  const page = code('src/features/chat/ChatPage.tsx');

  it('ChatPage 对引擎栈没有任何静态导入', () => {
    const banned = [
      './send-pipeline',
      '../../app/ai-runtime',
      '../../ai/engine',
      '../../ai/group-engine',
      '../../ai/memory-service',
      '../../ai/translate',
      '../../ai/sticker-battle',
    ];
    const hits = staticImports(page).filter((s) => banned.includes(s));
    expect(hits, '这些静态导入会把整棵引擎树拖回冷启动主包').toEqual([]);
  });

  it('ChatPage 只经 ai-runtime 这一个动态入口拿管线', () => {
    expect(page).toContain("import('../../app/ai-runtime').then((m) => m.chat)");
    const runtime = code('src/app/ai-runtime.ts');
    expect(runtime).toContain("export * as chat from '../features/chat/send-pipeline'");
    expect(runtime).toContain("export * from './useSchedulerRuntime'");
  });

  it('全 src 没有任何地方静态导入 ai-runtime（它必须始终是动态入口）', () => {
    const hits = walk('src').filter((f) =>
      staticImports(code(f)).some((s) => /(^|\/)ai-runtime$/.test(s)),
    );
    expect(hits).toEqual([]);
  });

  /**
   * 引擎的静态导入方台账。每一个都必须本身就在懒加载的那一侧——
   * store 曾经为了一个 abortConversation 把整棵树钉在主包里（现在走 ai/inflight）。
   */
  const ENGINE_IMPORTERS: Record<string, string> = {
    'src/app/useSchedulerRuntime.ts': '调度运行时，K10 起只经 ai-runtime 动态加载',
    'src/native/reply-drain.ts': '通知回复排空，只被调度运行时引用',
    'src/features/chat/send-pipeline.ts': '聊天页发送管线，只经 ai-runtime 动态加载',
  };
  it('ai/ 之外静态导入 ai/engine 的文件都在台账上，且都在懒加载一侧', () => {
    const found = walk('src')
      .filter((f) => !f.startsWith('src/ai/'))
      .filter((f) => staticImports(code(f)).some((s) => /(^|\/)ai\/engine$/.test(s)))
      .sort();
    expect(found).toEqual(Object.keys(ENGINE_IMPORTERS).sort());
  });

  it('store 从 ai/inflight 拿 abortConversation，不碰 ai/engine', () => {
    const store = code('src/store/appStore.ts');
    expect(staticImports(store)).toContain('../ai/inflight');
    expect(staticImports(store)).not.toContain('../ai/engine');
  });

  it('ChatPage 不再长回两千行（拆出的三块各管一件事）', () => {
    const lines = read('src/features/chat/ChatPage.tsx').split('\n').length;
    expect(lines, 'ChatPage 又长回去了——新东西先想想它属于线程、管线还是组合器').toBeLessThanOrEqual(1500);
  });
});

/* ------------------------------ 行为 ------------------------------ */

const convBase = {
  avatarColor: 'var(--color-brand)',
  avatarText: '林',
  isPinned: false,
  isMuted: false,
  unreadCount: 0,
  mentionMe: false,
  lastMsgPreview: '',
  lastMsgAt: 0,
};
const CONV_SINGLE: ConversationVM = { ...convBase, id: 'c_lin', type: 'single', title: '林小雨', peerId: 'ai_lin' };
const CONV_GROUP: ConversationVM = {
  ...convBase,
  id: 'g_1',
  type: 'group',
  title: '饭搭子',
  memberIds: ['ai_lin', 'ai_ada'],
};
const contact = (id: string, name: string): ContactVM =>
  ({ id, name, type: 'ai', avatarText: name[0], avatarColor: 'var(--color-brand)' }) as ContactVM;
const persona = (over: Partial<PersonaVM> = {}): PersonaVM => ({ stickerRate: 1, nsfwPermit: false, ...over }) as PersonaVM;

let personas: Record<string, PersonaVM | undefined>;
beforeEach(() => {
  calls.length = 0;
  personas = { ai_lin: persona(), ai_ada: persona() };
  useAppStore.setState({
    conversations: [CONV_SINGLE, CONV_GROUP],
    contacts: [contact('ai_lin', '林小雨'), contact('ai_ada', 'Ada')],
    messages: {},
    personaFor: (id: string) => personas[id],
    appendMessage: vi.fn(async (m) => {
      calls.push(['appendMessage', m]);
      return { ...m, id: 1 };
    }),
  });
});

describe('发送管线（行为）', () => {
  const QUOTE = { quote: 'Ada: 明天几点', quoteId: 7 };

  it('单聊：引用随消息交给单聊引擎', async () => {
    await pipeline.sendText('c_lin', '好啊', QUOTE);
    const [name, convId, text, , , , , quote] = calls.find((c) => c[0] === 'sendUserMessage')!;
    expect([name, convId, text, quote]).toEqual(['sendUserMessage', 'c_lin', '好啊', QUOTE]);
  });

  it('群聊：引用同样带上（W1 那个「群里引用被吞」不许回来），成员按备注优先', async () => {
    await pipeline.sendText('g_1', '好啊', QUOTE);
    const call = calls.find((c) => c[0] === 'sendGroupMessage')!;
    expect(call[2]).toBe('好啊');
    expect(call.at(-1)).toEqual(QUOTE);
    expect((call[3] as Array<{ contactId: string; name: string }>).map((m) => m.name)).toEqual(['林小雨', 'Ada']);
  });

  it('还没有人设卡：消息照样落库，不调引擎', async () => {
    personas.ai_lin = undefined;
    await pipeline.sendText('c_lin', '在吗');
    expect(calls.map((c) => c[0])).toEqual(['appendMessage']);
    expect((calls[0][1] as { content: string }).content).toBe('在吗');
  });

  it('replyToNewest 按会话类型分流到两个引擎', async () => {
    await pipeline.replyToNewest('c_lin');
    await pipeline.replyToNewest('g_1');
    expect(calls.map((c) => c[0])).toEqual(['replyToLatest', 'replyToLatestInGroup']);
  });

  it('会话不存在：什么都不做', async () => {
    await pipeline.sendText('nope', 'x');
    await pipeline.replyToNewest('nope');
    expect(calls).toEqual([]);
  });

  /** 找一个让单聊斗图命中 / 不命中的 savedId（种子化，铁律 4）。 */
  const savedIdWhere = (hit: boolean) => {
    for (let id = 1; id < 500; id++) {
      if (Boolean(battleReply({ seed: `c_lin:${id}`, streak: 1, rate: 1 }, [], '捂脸')) === hit) return id;
    }
    throw new Error('no seed');
  };

  it('斗图命中：回击走 scheduled_actions（铁律 5），不调引擎', async () => {
    useAppStore.setState({ messages: { c_lin: [{ id: 1, convId: 'c_lin', senderId: 'self', type: 'sticker', content: '捂脸', status: 'sent', createdAt: 0 }] } });
    const id = savedIdWhere(true);
    await pipeline.stickerRound('c_lin', id, '捂脸');
    const q = calls.find((c) => c[0] === 'enqueue')?.[1] as { kind: string; id: string } | undefined;
    expect(q?.kind).toBe('sticker_reply');
    expect(q?.id).toBe(`stkbattle_c_lin_${id}`);
    expect(calls.some((c) => c[0] === 'replyToLatest')).toBe(false);
  });

  it('斗图没命中：照常让她用文字回', async () => {
    useAppStore.setState({ messages: { c_lin: [{ id: 1, convId: 'c_lin', senderId: 'self', type: 'sticker', content: '捂脸', status: 'sent', createdAt: 0 }] } });
    await pipeline.stickerRound('c_lin', savedIdWhere(false), '捂脸');
    expect(calls.map((c) => c[0])).toEqual(['replyToLatest']);
  });

  it('话筒档位：人设不许可 = off，与发送路径同一条推导', async () => {
    expect(await pipeline.micTierFor('c_lin')).toBe('off');
    expect(await pipeline.micTierFor('g_1')).toBe('off');
  });
});
