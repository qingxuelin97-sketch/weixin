import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderMessageBody } from '../../src/ai/render-msg';
import { stickerGlyph, STICKER_VOCAB, STICKER_LABELS } from '../../src/data/stickers';
import { resolvePhotoBubble, photoDirective, resetPhotoMemory } from '../../src/ai/photo-send';
import type { MessageVM } from '../../src/data/types';

/**
 * The four chat-page bugs (M-H0).
 *
 * All four had been shipping for months, all four are hit daily, and none of
 * three separate audits found them — because those audits read structure,
 * wiring and performance, while these only appear if you follow one user
 * action all the way through. Hence the source-level assertions below: the
 * failure mode for three of them is "the code stops early", which no
 * behavioural test of the remaining path can see.
 */

const src = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8');

const msg = (over: Partial<MessageVM>): MessageVM =>
  ({
    id: 1,
    convId: 'c1',
    senderId: 'self',
    type: 'text',
    content: '好啊',
    status: 'sent',
    createdAt: 1_755_400_000_000,
    ...over,
  }) as MessageVM;

describe('W1 · a quoted reply survives, in both chat types', () => {
  it('the quote is built — and the chip cleared — before anything branches on chat type', () => {
    // The original bug exactly: the group branch returned at line 256 while
    // `quoteMeta` was constructed at 276, so quoting in a group dropped the
    // quote AND never ran `setQuote(null)` — the chip then stayed wedged in
    // the composer for the rest of the session.
    //
    // M-K11 moved both branches into the lazy send pipeline, so the guard
    // follows the code to both halves: the PAGE builds the quote and clears
    // the chip before handing off (and no longer branches at all), and the
    // PIPELINE passes the quote into the group AND the single call.
    const page = src('src/features/chat/ChatPage.tsx');
    const fn = page.slice(page.indexOf('const send = async'));
    const send = fn.slice(0, fn.indexOf('\n  };'));
    const quoteBuilt = send.indexOf('const quoteMeta =');
    const chipCleared = send.indexOf('setQuote(null)');
    const handoff = send.indexOf('.sendText(convId, text, quoteMeta)');
    expect(quoteBuilt).toBeGreaterThan(-1);
    expect(handoff, '发送没有交给管线的 sendText').toBeGreaterThan(-1);
    expect(
      quoteBuilt < handoff && chipCleared > -1 && chipCleared < handoff,
      'quoteMeta 必须在交给管线之前构造、引用条在那之前清掉，否则群里引用会被丢弃且引用条永久卡住',
    ).toBe(true);
    expect(send, '页面不该再自己按会话类型分支——两个分支都在管线里').not.toContain("conv.type === 'group'");

    const pipe = src('src/features/chat/send-pipeline.ts');
    const p0 = pipe.slice(pipe.indexOf('export async function sendText'));
    const sendText = p0.slice(0, p0.indexOf('\n}\n'));
    expect(sendText, '群聊分支丢了引用').toMatch(/sendGroupMessage\([^;]*quoteMeta\)/);
    expect(sendText, '单聊分支丢了引用').toMatch(/sendUserMessage\([^;]*quoteMeta\)/);
  });

  it('the model can actually see what was quoted', () => {
    // The UI drew the quote block all along, so this read as the model
    // ignoring the quote rather than as the quote never being sent.
    const body = renderMessageBody(msg({ meta: { quote: '林小雨: 明天几点出发' } }));
    expect(body).toContain('明天几点出发');
    expect(body).toContain('好啊');
  });

  it('clips a long quote instead of replaying a whole paragraph', () => {
    const body = renderMessageBody(msg({ meta: { quote: '很'.repeat(200) } }));
    expect(body.length).toBeLessThan(80);
    expect(body).toContain('…');
  });

  it('leaves an unquoted message exactly as it was', () => {
    expect(renderMessageBody(msg({}))).toBe('好啊');
  });
});

describe('W2 · sending a photo asks for a reply', () => {
  it('sendImages reaches a generation path, not just the store', () => {
    const page = src('src/features/chat/ChatPage.tsx');
    const fn = page.slice(page.indexOf('const sendImages ='));
    const body = fn.slice(0, fn.indexOf('\n  };'));
    // It used to end at `appendMessage`, so **she never answered a picture** —
    // and every richer plan for images was downstream of a reply nobody asked
    // for. M-J7a 把「请求回复」抽成了共享尾巴 requestReplyToLatest（语音消息
    // 复用同一条），所以这里认帮手调用，另断言帮手本身真的通到引擎。
    expect(
      body.includes('requestReplyToLatest'),
      'sendImages 必须在落库后请求一次回复，否则发图永远等不到回应',
    ).toBe(true);
    const helper = page.slice(page.indexOf('const requestReplyToLatest ='));
    const helperBody = helper.slice(0, helper.indexOf('\n  };'));
    // M-K11: the helper hands off to the lazy pipeline's replyToNewest, and
    // THAT is what must reach both engines.
    expect(helperBody, 'requestReplyToLatest 没有交给管线').toContain('.replyToNewest(convId)');
    const pipe = src('src/features/chat/send-pipeline.ts');
    const p0 = pipe.slice(pipe.indexOf('export async function replyToNewest'));
    const tail = p0.slice(0, p0.indexOf('\n}\n'));
    expect(
      tail.includes('replyToLatest(') && tail.includes('replyToLatestInGroup('),
      'replyToNewest 必须真的通到单聊/群聊引擎，否则抽出来的是个空壳',
    ).toBe(true);
  });

  it('the engine can reply without inventing a user message', async () => {
    const engine = src('src/ai/engine.ts');
    expect(engine).toContain('export async function replyToLatest');
    // The alternative — appending a fake text message to trigger a reply —
    // would put words in the user's mouth and into long-term memory.
    expect(engine).toContain('alreadyPersisted');
  });
});

describe('W3 · a failed send says so, and can be retried', () => {
  it('something actually produces status: failed', () => {
    // Dead enum since M1: declared in types.ts and schema.ts, written nowhere,
    // so a send that failed looked exactly like one that worked.
    const engine = src('src/ai/engine.ts');
    expect(engine).toContain("status: 'failed'");
  });

  it('the failure replaces the system bubble rather than joining it', () => {
    const engine = src('src/ai/engine.ts');
    // Two error UIs for one failure is worse than one; and a system line sits
    // in the transcript — and in the model's context — narrating a network
    // error forever, with no way to act on it.
    expect(engine).not.toContain('消息没能送达');
  });

  it('the bubble offers the retry', () => {
    const bubble = src('src/features/chat/MessageBubble.tsx');
    expect(bubble).toContain("msg.status === 'failed'");
    expect(bubble).toContain('onRetry');
  });
});

describe('W4 · stickers render as stickers', () => {
  it('translates a semantic label to a glyph', () => {
    expect(stickerGlyph('开心')).toBe(STICKER_VOCAB['开心']);
    expect(stickerGlyph('笑哭')).toBe(STICKER_VOCAB['笑哭']);
  });

  it('never renders an off-vocabulary label as text', () => {
    // The bug: `content` was printed directly at 64px, so a label the model
    // invented arrived as enormous Chinese characters.
    const out = stickerGlyph('欲言又止');
    expect(out).not.toContain('欲');
    expect(out).toBe('🙂');
  });

  it('accepts a raw emoji, because older rows store them directly', () => {
    expect(stickerGlyph('🎉')).toBe('🎉');
    expect(stickerGlyph('')).toBe('🙂');
  });

  it('the prompt advertises exactly what the renderer can draw', () => {
    // Both ends of the contract from one table, so they cannot drift: the
    // model was previously told "content 为语义标签" with no vocabulary at all.
    const prompt = src('src/ai/prompt.ts');
    expect(prompt).toContain('STICKER_LABELS');
    for (const label of Object.keys(STICKER_VOCAB)) {
      expect(STICKER_LABELS).toContain(label);
    }
  });
});

/* ==================== she can send a photo too (M-H1) ==================== */

/**
 * `image` has been a valid bubble type since M1 and playback always handled
 * it — but nothing produced one, because a model cannot name a file. It can
 * only describe what it wants to show, so something has to resolve that
 * against the user's own pool.
 */
describe('an image bubble becomes a real photo, or gracefully becomes words', () => {
  beforeEach(() => resetPhotoMemory());

  const persona = { contactId: 'ai_lin', imageTags: [] as string[] };
  const bubble = (content: string) => ({ type: 'image' as const, content });

  it('resolves to a pool ref and keeps the description as the caption', () => {
    const out = resolvePhotoBubble(bubble('刚烤的饼干'), persona, 'c1', 's1');
    expect(out).not.toBeNull();
    expect(out!.ref).toMatch(/^(idb:|img:|ph:)/);
    expect(out!.caption).toBe('刚烤的饼干');
  });

  it('avoids repeating the photo it just sent', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const out = resolvePhotoBubble(bubble(`第${i}张`), persona, 'c1', `s${i}`);
      if (out) seen.add(out.ref);
    }
    // Sending the identical picture twice in a row is the tell that there is a
    // pool behind her rather than a life.
    expect(seen.size).toBeGreaterThan(1);
  });

  it('only advertises the capability when a pool exists', () => {
    // Offering an ability she cannot exercise just produces image bubbles that
    // all degrade back to text.
    const line = photoDirective(persona);
    expect(typeof line).toBe('string');
    if (line) expect(line).toContain('image');
  });

  it('her caption is what the model sees later, not the media handle', () => {
    const body = renderMessageBody(
      msg({ senderId: 'ai_lin', type: 'image', content: 'idb:abc', meta: { caption: '刚烤的饼干' } }),
    );
    expect(body).toContain('刚烤的饼干');
    // The internal id must never reach the model — it would echo it back.
    expect(body).not.toContain('idb:');
    expect(body).not.toContain('abc');
  });

  it('a user photo still says something via its library tags', () => {
    const body = renderMessageBody(msg({ type: 'image', content: 'idb:x', meta: { tags: ['聊天'] } }));
    expect(body).toContain('聊天');
  });
});
