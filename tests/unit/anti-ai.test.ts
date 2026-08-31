import { describe, it, expect } from 'vitest';
import {
  normalize,
  similarity,
  isRepeat,
  isAssistantSpeak,
  scrubBubbles,
  styleNote,
  ownLines,
} from '../../src/ai/anti-ai';

/**
 * Anti-AI-tone v2 (M-H1).
 *
 * V1 is a block of rules in the system prompt. Rules are all this app had,
 * which means nothing ever looked at what she actually produced — and the
 * tells that survive a rule are precisely the ones that only exist ACROSS
 * turns: the same sentence reworded, a catchphrase that became a tic, every
 * message ending on the same particle.
 */

describe('two lines that are the same line', () => {
  it('sees through punctuation and spacing', () => {
    expect(normalize('好 的，那 就 这样！')).toBe('好的那就这样');
    expect(similarity('今天真的好累啊', '今天真的好累')).toBeGreaterThan(0.7);
  });

  it('catches a near-verbatim repeat', () => {
    expect(isRepeat('那我们明天下午三点见', ['那我们明天下午三点见面'])).toBe(true);
    expect(isRepeat('我今天真的累死了', ['我今天真的累死了。'])).toBe(true);
  });

  it('deliberately lets a loose reworking through', () => {
    // 「累死了」vs「太累了」 mean the same thing and 「去上班」vs「去上课」 do not,
    // and character overlap cannot tell those two cases apart — the pair that
    // means the same overlaps LESS than the pair that does not. So the bar
    // stays high enough to only catch near-verbatim repeats: a wrongly dropped
    // line is invisible to the user and unrecoverable, while a repetitive one
    // is merely repetitive.
    expect(isRepeat('我今天真的累死了', ['我今天真的太累了'])).toBe(false);
    expect(isRepeat('我明天去上课', ['我明天去上班'])).toBe(false);
  });

  it('leaves short interjections alone', () => {
    // People do say "嗯" twice. Policing that produces a character who cannot
    // agree with you twice in a row.
    expect(isRepeat('哈哈哈', ['哈哈哈'])).toBe(false);
    expect(isRepeat('好', ['好'])).toBe(false);
  });

  it('does not confuse two different sentences of similar shape', () => {
    expect(isRepeat('明天我要去看牙医', ['昨天我妈来了一趟'])).toBe(false);
  });
});

describe('assistant-speak that got past the rules', () => {
  it('recognises the classics', () => {
    expect(isAssistantSpeak('作为一个AI，我不能这么说')).toBe(true);
    expect(isAssistantSpeak('我理解你的感受，这确实很难')).toBe(true);
    expect(isAssistantSpeak('还有什么可以帮你的吗')).toBe(true);
    expect(isAssistantSpeak('希望这能帮助到你')).toBe(true);
  });

  it('does not eat ordinary sentences', () => {
    // A dropped line the user never sees is worse than a stiff one they do:
    // the first reads as the app being broken.
    expect(isAssistantSpeak('我理解啊，那你打算怎么办')).toBe(false);
    expect(isAssistantSpeak('总之我先去睡了')).toBe(false);
    expect(isAssistantSpeak('有问题随时说')).toBe(false);
  });
});

describe('scrubbing a turn', () => {
  const t = (content: string) => ({ type: 'text', content });

  it('drops a bubble that repeats what she just said', () => {
    const out = scrubBubbles([t('我今天真的累死了'), t('明天再说吧')], ['我今天真的累死了']);
    expect(out.map((b) => b.content)).toEqual(['明天再说吧']);
  });

  it('drops a bubble that repeats the bubble beside it', () => {
    // Saying one thing twice inside a single turn is the commonest form, and
    // the only one a "don't repeat yourself" prompt rule cannot see.
    const out = scrubBubbles([t('那我们明天下午三点见'), t('那我们明天下午三点见面')], []);
    expect(out).toHaveLength(1);
  });

  it('never empties a turn', () => {
    // A reply that does not arrive reads as the app being broken; a repetitive
    // one only reads as her being repetitive.
    const out = scrubBubbles([t('作为一个AI我不能这么说')], []);
    expect(out).toHaveLength(1);
  });

  it('leaves stickers, photos and money alone', () => {
    const out = scrubBubbles([{ type: 'sticker', content: '开心' }, { type: 'image', content: 'x' }], [
      '开心',
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('the habit note fed back into the next prompt', () => {
  const rep = (s: string, n: number) => Array.from({ length: n }, () => s);

  it('says nothing until there is a habit to name', () => {
    expect(styleNote(['在吗', '嗯'], ['哈哈哈'])).toBe('');
  });

  it('names an overused catchphrase', () => {
    const note = styleNote(
      ['哈哈哈那也太好笑了', '哈哈哈真的假的', '哈哈哈我也是', '行吧那就这样'],
      ['哈哈哈'],
    );
    expect(note).toContain('哈哈哈');
    expect(note).toContain('先别用');
  });

  it('names a repeated opening', () => {
    const note = styleNote(['其实我觉得还好', '其实也没那么难', '其实你可以试试', '嗯嗯知道了']);
    expect(note).toContain('其实');
    expect(note).toContain('开头');
  });

  it('names a particle she has stopped varying', () => {
    const note = styleNote(['是这样的呢', '我也去过呢', '好像不太行呢', '那可不一定呢']);
    expect(note).toContain('呢');
  });

  it('notices when everything she writes is an essay', () => {
    const note = styleNote(
      rep(
        '这个事情其实要分成好几个方面来看，首先是时间安排上的问题，其次还有预算能不能批下来，最后才轮到到底谁去做',
        5,
      ),
    );
    expect(note).toContain('短一点');
  });

  it('stays at two lines — it rides on every single turn', () => {
    const note = styleNote(
      ['其实我觉得还好呢', '其实也没那么难呢', '其实你可以试试呢', '其实无所谓呢'],
      ['其实'],
    );
    expect(note.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(2);
  });
});

describe('pulling her own lines out of a transcript', () => {
  it('takes only her text and voice, and only what still exists', () => {
    const msgs = [
      { senderId: 'self', type: 'text', content: '在吗' },
      { senderId: 'ai_lin', type: 'text', content: '在' },
      { senderId: 'ai_lin', type: 'sticker', content: '开心' },
      { senderId: 'ai_lin', type: 'text', content: '撤回了', isRecalled: true },
      { senderId: 'ai_lin', type: 'voice', content: '刚吃完饭' },
    ];
    // A sticker is not a sentence; a recalled line is not something she said.
    expect(ownLines(msgs, 'ai_lin')).toEqual(['在', '刚吃完饭']);
  });
});
