// @vitest-environment jsdom
/**
 * 测试革命 (M-J11)：16k 行 .tsx 第一次真的被渲染。
 *
 * Why MessageBubble first, out of ~60 components: it is the single widest
 * projection surface in the app — every one of the 15 message types ends up
 * here — and it has already produced this exact class of bug. The M-I18 audit
 * found the favourites page rendering the literal string 「[rp]」 for a red
 * packet: an internal enum name on screen, in a second renderer that had
 * quietly fallen behind the first. Nothing failed. There was no test that
 * rendered anything.
 *
 * So the load-bearing case here is the sweep at the bottom: render EVERY
 * message type and assert (a) no raw type name, `[object Object]` or
 * `undefined` reaches the DOM, and (b) each type renders through ITS OWN
 * branch, identified by a class only that branch emits.
 *
 * (b) exists because (a) alone is not enough, which I found out by deleting the
 * `file` branch and watching the sweep stay green: the switch's fallback is
 * `msg.content ?? \`[${msg.type}]\``, so a card type that happens to carry
 * content degrades to a plain text bubble — the filename renders, nothing
 * looks broken to a string assertion, and the card is simply gone. That is the
 * silent version of the 「[rp]」 bug, and only the class check catches it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, cleanup } from '@testing-library/react';
import { MessageBubble } from '../../src/features/chat/MessageBubble';
import type { MessageVM, MessageType, ContactVM } from '../../src/data/types';

afterEach(cleanup);

const T0 = 1_754_600_000_000;

const peer: ContactVM = {
  id: 'ai_a',
  type: 'ai',
  name: '林小雨',
  avatarColor: '#AABBCC',
  avatarText: '雨',
};

const msg = (over: Partial<MessageVM> & { type: MessageType }): MessageVM => ({
  id: 1,
  convId: 'c1',
  senderId: 'ai_a',
  status: 'sent',
  // A fixed past timestamp: `fresh` (the pop-in animation) keys off Date.now(),
  // and a "just arrived" message would add a class that has nothing to do with
  // what is being asserted here.
  createdAt: T0 - 600_000,
  ...over,
});

const draw = (m: MessageVM) =>
  render(<MessageBubble msg={m} sender={peer} isSelf={m.senderId === 'self'} />);

describe('MessageBubble 渲染', () => {
  it('文本气泡显示文字本身', () => {
    draw(msg({ type: 'text', content: '在吗' }));
    expect(screen.getByText('在吗')).toBeTruthy();
  });

  it('系统行居中且不带头像（拍一拍就是这种）', () => {
    const { container } = draw(
      msg({ type: 'system', senderId: 'system', content: '你拍了拍"林小雨"的脑袋' }),
    );
    expect(screen.getByText('你拍了拍"林小雨"的脑袋')).toBeTruthy();
    expect(container.querySelector('.msg-system')).toBeTruthy();
    expect(container.querySelector('.msg-row__avatar')).toBeNull();
  });

  it('撤回的消息显示撤回提示，而不是原文', () => {
    draw(msg({ type: 'text', content: '说错了', isRecalled: true }));
    expect(screen.queryByText('说错了')).toBeNull();
    expect(screen.getByText(/撤回了一条消息/)).toBeTruthy();
  });

  it('语音气泡按时长撑宽，并显示秒数', () => {
    const { container } = draw(msg({ type: 'voice', meta: { durationMs: 8000 } }));
    expect(screen.getByText('8″')).toBeTruthy();
    const bubble = container.querySelector('.bubble--voice') as HTMLElement | null;
    expect(bubble).toBeTruthy();
    // 60 + 8*8 = 124px（比 2 秒的宽，这是「一眼看出多长」的全部意义）
    expect(bubble!.style.width).toBe('124px');
  });

  it('语音的转写只在展开后出现', () => {
    draw(msg({ type: 'voice', content: '晚上吃什么', meta: { durationMs: 3000 } }));
    expect(screen.queryByText('晚上吃什么')).toBeNull();
    cleanup();
    draw(
      msg({
        type: 'voice',
        content: '晚上吃什么',
        meta: { durationMs: 3000, voiceTextShown: true },
      }),
    );
    expect(screen.getByText('晚上吃什么')).toBeTruthy();
  });

  it('翻译挂在气泡下方，原文仍在（M-J7）', () => {
    draw(msg({ type: 'text', content: 'how are you', meta: { translation: '你好吗' } }));
    expect(screen.getByText('how are you')).toBeTruthy();
    expect(screen.getByText('你好吗')).toBeTruthy();
  });

  it('通话记录：视频与语音文案相同，图标不同（真微信就是这样）', () => {
    const { container: voice } = draw(
      msg({ type: 'call', meta: { direction: 'out', durationMs: 65_000 } }),
    );
    expect(screen.getByText('通话时长 01:05')).toBeTruthy();
    const voiceIcon = voice.querySelector('.call-bubble svg')?.innerHTML ?? '';
    cleanup();
    const { container: video } = draw(
      msg({ type: 'call', meta: { direction: 'out', durationMs: 65_000, video: true } }),
    );
    expect(screen.getByText('通话时长 01:05')).toBeTruthy();
    const videoIcon = video.querySelector('.call-bubble svg')?.innerHTML ?? '';
    expect(videoIcon).not.toBe(voiceIcon);
  });

  it('红包显示祝福语，不是内部类型名', () => {
    draw(msg({ type: 'rp', meta: { greeting: '恭喜发财' } }));
    expect(screen.getByText('恭喜发财')).toBeTruthy();
    expect(screen.getByText('微信红包')).toBeTruthy();
  });

  it('专属红包在气泡上就写明是给谁的（旁人不必点开才被拒）', () => {
    draw(msg({ type: 'rp', meta: { mode: 'exclusive', exclusiveName: '阿甲' } }));
    expect(screen.getByText(/专属红包.*阿甲/)).toBeTruthy();
  });

  it('自己发的失败消息带重发入口', () => {
    const { container } = render(
      <MessageBubble
        msg={msg({ type: 'text', senderId: 'self', content: '发不出去', status: 'failed' })}
        sender={peer}
        isSelf
        onRetry={() => {}}
      />,
    );
    expect(container.querySelector('.msg-failed')).toBeTruthy();
  });

  it('群聊里显示对方昵称，单聊不显示', () => {
    draw(msg({ type: 'text', content: 'hi' }));
    expect(screen.queryByText('林小雨')).toBeNull();
    cleanup();
    render(
      <MessageBubble msg={msg({ type: 'text', content: 'hi' })} sender={peer} isSelf={false} showNickname />,
    );
    expect(screen.getByText('林小雨')).toBeTruthy();
  });
});

/* ==================================================================== */
/* 全类型清扫——这一条才是这个文件存在的理由                              */
/* ==================================================================== */

/** Minimal but plausible meta for each type, so every branch actually renders. */
const SAMPLES: Record<MessageType, Partial<MessageVM>> = {
  text: { content: '一句话' },
  image: { content: 'ph:sunset' },
  voice: { meta: { durationMs: 4000 } },
  sticker: { content: '开心' },
  rp: { meta: { greeting: '恭喜发财' } },
  transfer: { meta: { amountFen: 1250 } },
  call: { meta: { direction: 'out', durationMs: 30_000 } },
  system: { senderId: 'system', content: '系统提示' },
  merged: { meta: { title: '群聊的聊天记录', items: [{ name: '阿甲', body: '在', at: T0 }] } },
  location: { content: '西湖', meta: { name: '西湖', address: '杭州市' } },
  contact_card: { meta: { contactId: 'ai_b', name: '阿乙', avatarColor: '#123456', avatarText: '乙' } },
  file: { content: '合同.pdf', meta: { fileName: '合同.pdf', sizeBytes: 2048, ext: 'pdf' } },
  link: { content: '一篇文章', meta: { title: '一篇文章', summary: '摘要' } },
  game: { meta: { game: 'dice', result: 4 } },
  group_bill: {
    meta: {
      billId: 'b1',
      title: '烧烤',
      totalFen: 9000,
      parts: [{ id: 'ai_a', name: '阿甲', oweFen: 3000 }],
      paidIds: [],
    },
  },
};

const ALL_TYPES = Object.keys(SAMPLES) as MessageType[];

/**
 * A selector only that type's own branch produces. Types whose branch IS the
 * plain bubble (text, system) are listed as such deliberately — the point is
 * that every entry is a decision, not that every entry is a card.
 */
const OWN_BRANCH: Record<MessageType, string> = {
  text: '.bubble',
  image: '.msg-image, .msg-image-wrap',
  voice: '.bubble--voice',
  sticker: '.msg-sticker, .msg-sticker-img',
  rp: '.money-bubble',
  transfer: '.money-bubble',
  call: '.call-bubble',
  system: '.msg-system',
  merged: '.merged-card__title',
  location: '.loc-card__name',
  contact_card: '.namecard__main',
  file: '.file-card__main',
  link: '.link-card__title',
  game: '.msg-game',
  group_bill: '.bill-card',
};

/**
 * The union's members, read out of the source. A magic count here would have
 * been the usual thing and the usual mistake: it says nothing about WHICH type
 * is missing, and the first person to add one just bumps the number. Scanning
 * `MessageType` means a new type with no sample fails this test **by name**.
 */
function declaredMessageTypes(): string[] {
  const src = readFileSync(resolve(__dirname, '../../src/data/types.ts'), 'utf8');
  const start = src.indexOf('export type MessageType');
  // Comments FIRST: several members are documented with prose that contains a
  // semicolon (「content = 地名; meta: …」), and cutting at the first `;` in the
  // raw text silently truncated the union to its first nine members — a scan
  // that looks like it works and quietly checks two thirds of the list.
  const withoutComments = src.slice(start, start + 4000).replace(/\/\*[\s\S]*?\*\//g, '');
  const body = withoutComments.slice(0, withoutComments.indexOf(';'));
  return [...body.matchAll(/\|\s*'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('全类型清扫：内部名字不许上屏', () => {
  it('SAMPLES 覆盖了 MessageType 的每一个成员（新增类型必须在这里露面）', () => {
    const declared = declaredMessageTypes();
    expect(declared.length).toBeGreaterThan(10); // 守卫不能空转
    expect([...ALL_TYPES].sort()).toEqual([...declared].sort());
  });

  for (const type of ALL_TYPES) {
    it(`${type}: 渲染出人话，不含类型名/[object Object]/undefined`, () => {
      const { container } = draw(msg({ type, ...SAMPLES[type] } as MessageVM));
      const text = container.textContent ?? '';
      // 这三条正是 M-I18 审计在收藏页抓到的那一类（字面量「[rp]」上了屏）。
      expect(text).not.toContain('[object Object]');
      expect(text).not.toContain('undefined');
      expect(text).not.toContain(`[${type}]`);
      // 而且必须真的画出了东西——空 div 也能通过上面三条。
      expect(container.querySelector('.msg-row, .msg-system')).toBeTruthy();
      // 关键的一条：必须走的是**它自己那个分支**。少了分支时 switch 的兜底
      // （content ?? [type]）会把带内容的卡片降级成一个普通文字气泡，
      // 上面三条全部照过——这正是「[rp]」那个 bug 的静默版本。
      expect(
        container.querySelector(OWN_BRANCH[type]),
        `${type} 没走自己的渲染分支（${OWN_BRANCH[type]} 不存在）——大概率被兜底成了纯文字气泡`,
      ).toBeTruthy();
    });
  }
});
