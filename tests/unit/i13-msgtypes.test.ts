import { describe, it, expect } from 'vitest';
import { renderMessageBody, renderTranscript } from '../../src/ai/render-msg';
import {
  materializeBubble,
  fakeFileSize,
  fileExt,
  humanSize,
  MATERIALIZED_BUBBLE_TYPES,
} from '../../src/ai/bubble-materialize';
import { cardResolver } from '../../src/ai/engine';
import { parseBubbles } from '../../src/llm/bubbles';
import { BUBBLE_TYPES } from '../../src/llm/types';
import { assembleSystemPrompt } from '../../src/ai/prompt';
import {
  gameSeed,
  rollDice,
  rollRps,
  rpsCompare,
  describeGame,
  diceResult,
  rpsResult,
  RPS_LABELS,
} from '../../src/lib/game';
import { gameDirective } from '../../src/ai/game-react';
import { previewOf } from '../../src/store/appStore';
import type { ContactVM, MessageVM } from '../../src/data/types';

/**
 * M-I13: the four rich message types + 表情游戏.
 *
 * The two invariants under test are the module's whole reason to exist:
 *  1. the model NEVER sees `[object]` (or an internal id) for any new type —
 *     every one has a real projection;
 *  2. every seeded thing (file sizes, game results) derives from the message's
 *     own deterministic attributes, so a replay reproduces it exactly.
 */

const T0 = 1_754_900_000_000;

function msg(over: Partial<MessageVM> & Pick<MessageVM, 'type'>): MessageVM {
  return {
    id: 1,
    convId: 'c1',
    senderId: 'self',
    status: 'sent',
    createdAt: T0,
    ...over,
  } as MessageVM;
}

// ---------------------------------------------------------------------------
// Projections: what the model sees.
// ---------------------------------------------------------------------------

describe('render-msg projections for M-I13 types', () => {
  it('projects a location with its name and address', () => {
    const body = renderMessageBody(
      msg({ type: 'location', content: '老地方咖啡', meta: { name: '老地方咖啡', address: '中山路 12 号' } }),
    );
    expect(body).toContain('位置');
    expect(body).toContain('老地方咖啡');
    expect(body).toContain('中山路 12 号');
    expect(body).not.toContain('[object');
  });

  it('projects a contact card by display name, never by internal id', () => {
    const body = renderMessageBody(
      msg({ type: 'contact_card', content: '小雨', meta: { contactId: 'ai_yu', name: '小雨' } }),
    );
    expect(body).toContain('名片');
    expect(body).toContain('小雨');
    // The tell that would let the model echo ids into dialogue.
    expect(body).not.toContain('ai_yu');
  });

  it('projects a file with name and human-readable size', () => {
    const body = renderMessageBody(
      msg({ type: 'file', content: '合同.pdf', meta: { fileName: '合同.pdf', sizeBytes: 2_300_000 } }),
    );
    expect(body).toContain('合同.pdf');
    expect(body).toContain('2.3MB');
  });

  it('projects a link with title and summary', () => {
    const body = renderMessageBody(
      msg({ type: 'link', content: '一篇文章', meta: { title: '一篇文章', summary: '讲了三件事' } }),
    );
    expect(body).toContain('《一篇文章》');
    expect(body).toContain('讲了三件事');
  });

  it('projects a dice throw with its point — "对方掷了骰子 3 点" is answerable', () => {
    const body = renderMessageBody(msg({ type: 'game', meta: { game: 'dice', result: 3 } }));
    expect(body).toContain('骰子');
    expect(body).toContain('3 点');
  });

  it('projects a rps throw with its hand label', () => {
    const body = renderMessageBody(msg({ type: 'game', meta: { game: 'rps', result: 2 } }));
    expect(body).toContain('布');
  });

  it('never re-rolls at projection time: the stored result is the projected result', () => {
    // Two projections of the same row must be identical strings.
    const row = msg({ type: 'game', meta: { game: 'dice', result: 5 } });
    expect(renderMessageBody(row)).toBe(renderMessageBody(row));
    expect(renderMessageBody(row)).toContain('5 点');
  });

  it('recalled rich messages read as recalled, not as their card', () => {
    const body = renderMessageBody(
      msg({ type: 'link', meta: { title: '秘密文章' }, isRecalled: true }),
    );
    expect(body).toBe('[撤回了一条消息]');
    expect(body).not.toContain('秘密');
  });

  it('survives rich rows with no meta at all', () => {
    for (const type of ['location', 'contact_card', 'file', 'link', 'game'] as const) {
      expect(() => renderMessageBody(msg({ type }))).not.toThrow();
      expect(renderMessageBody(msg({ type }))).not.toContain('[object');
    }
  });

  it('rich types survive transcripts alongside everything else', () => {
    const out = renderTranscript([
      msg({ id: 1, type: 'text', content: '看这个' }),
      msg({ id: 2, type: 'link', meta: { title: '标题党' } }),
      msg({ id: 3, type: 'game', senderId: 'ai_a', meta: { game: 'rps', result: 0 } }),
    ]);
    expect(out).toContain('标题党');
    expect(out).toContain('石头');
  });
});

// ---------------------------------------------------------------------------
// Materialization: bubble → message fields.
// ---------------------------------------------------------------------------

const CTX = { convId: 'c1', at: T0 };

describe('materializeBubble', () => {
  it('splits "地名|地址" location content into meta', () => {
    const m = materializeBubble({ type: 'location', content: '公司楼下|科技园路 8 号' }, CTX)!;
    expect(m.type).toBe('location');
    expect(m.content).toBe('公司楼下');
    expect(m.meta).toMatchObject({ name: '公司楼下', address: '科技园路 8 号' });
  });

  it('keeps a bare place name without inventing an address', () => {
    const m = materializeBubble({ type: 'location', content: '我家' }, CTX)!;
    expect(m.meta).toEqual({ name: '我家' });
  });

  it('resolves a contact bubble to a card with the snapshot identity', () => {
    const resolveContact = () => ({
      contactId: 'ai_b',
      name: '阿北',
      wxid: 'abei_01',
      avatarColor: '#abc',
      avatarText: '北',
    });
    const m = materializeBubble({ type: 'contact', content: '阿北' }, { ...CTX, resolveContact })!;
    expect(m.type).toBe('contact_card');
    expect(m.meta).toMatchObject({ contactId: 'ai_b', name: '阿北', wxid: 'abei_01' });
  });

  it('degrades an unresolvable contact bubble to plain text — a card to nowhere would 404', () => {
    const m = materializeBubble({ type: 'contact', content: '不存在的人' }, CTX)!;
    expect(m.type).toBe('text');
    expect(m.content).toBe('不存在的人');
  });

  it('gives a file a deterministic seeded size — the same contract weighs the same forever', () => {
    const a = materializeBubble({ type: 'file', content: '合同.docx' }, CTX)!;
    const b = materializeBubble({ type: 'file', content: '合同.docx' }, CTX)!;
    expect(a.meta!.sizeBytes).toBe(b.meta!.sizeBytes);
    expect(a.meta!.ext).toBe('docx');
    const other = materializeBubble({ type: 'file', content: '攻略.pdf' }, CTX)!;
    expect(other.meta!.sizeBytes).not.toBe(a.meta!.sizeBytes);
  });

  it('splits link "标题|摘要" and tolerates a title-only link', () => {
    const m = materializeBubble({ type: 'link', content: '猫为什么踩奶|其实是幼年习惯' }, CTX)!;
    expect(m.meta).toMatchObject({ title: '猫为什么踩奶', summary: '其实是幼年习惯' });
    const bare = materializeBubble({ type: 'link', content: '只有标题' }, CTX)!;
    expect(bare.meta).toEqual({ title: '只有标题' });
  });

  it('rolls dice/rps from (convId, at, index) — deterministic and in range', () => {
    const d1 = materializeBubble({ type: 'dice', content: '' }, { ...CTX, index: 0 })!;
    const d2 = materializeBubble({ type: 'dice', content: '' }, { ...CTX, index: 0 })!;
    expect(d1.meta!.result).toBe(d2.meta!.result);
    expect(d1.type).toBe('game');
    expect(d1.meta!.game).toBe('dice');
    const n = d1.meta!.result as number;
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(6);

    const r = materializeBubble({ type: 'rps', content: '' }, { ...CTX, index: 1 })!;
    expect(r.meta!.game).toBe('rps');
    expect(r.meta!.result).toBeGreaterThanOrEqual(0);
    expect(r.meta!.result).toBeLessThanOrEqual(2);
  });

  it('two throws in one turn can differ (the index is part of the seed)', () => {
    const results = new Set(
      Array.from({ length: 12 }, (_, i) =>
        materializeBubble({ type: 'dice', content: '' }, { ...CTX, index: i })!.meta!.result,
      ),
    );
    expect(results.size).toBeGreaterThan(1);
  });

  it('returns null for every type the engines own themselves', () => {
    for (const type of ['text', 'voice', 'sticker', 'image', 'recall'] as const) {
      expect(materializeBubble({ type, content: 'x' }, CTX)).toBeNull();
      expect(MATERIALIZED_BUBBLE_TYPES.has(type)).toBe(false);
    }
  });

  it('covers exactly the M-I13 half of BUBBLE_TYPES — a new bubble type must pick a side', () => {
    for (const type of BUBBLE_TYPES) {
      const owned = MATERIALIZED_BUBBLE_TYPES.has(type);
      const legacy = ['text', 'voice', 'sticker', 'image', 'recall'].includes(type);
      expect(owned !== legacy, `bubble type "${type}" 必须且只能属于一边`).toBe(true);
    }
  });
});

describe('file helpers', () => {
  it('fileExt handles names with and without extensions', () => {
    expect(fileExt('合同.PDF')).toBe('pdf');
    expect(fileExt('README')).toBe('');
    expect(fileExt('a.b.tar')).toBe('tar');
  });

  it('fakeFileSize is bounded and seeded', () => {
    const s = fakeFileSize('seed');
    expect(s).toBe(fakeFileSize('seed'));
    expect(s).toBeGreaterThanOrEqual(18_000);
    expect(s).toBeLessThan(10_000_000);
  });

  it('humanSize reads like a file manager', () => {
    expect(humanSize(2_300_000)).toBe('2.3MB');
    expect(humanSize(356_000)).toBe('356KB');
    expect(humanSize(120)).toBe('120B');
  });
});

// ---------------------------------------------------------------------------
// cardResolver: which names become cards.
// ---------------------------------------------------------------------------

describe('cardResolver', () => {
  const contacts: ContactVM[] = [
    { id: 'self', type: 'self', name: '我', avatarColor: '#111', avatarText: '我' },
    { id: 'ai_a', type: 'ai', name: '林晚', remark: '晚晚', avatarColor: '#222', avatarText: '林', wxid: 'lin_w' },
    { id: 'ai_b', type: 'ai', name: '阿北', avatarColor: '#333', avatarText: '北' },
  ];

  it('matches by remark or real name', () => {
    const resolve = cardResolver(contacts, 'ai_b');
    expect(resolve('晚晚')?.contactId).toBe('ai_a');
    expect(resolve('林晚')?.contactId).toBe('ai_a');
    expect(resolve('晚晚')?.wxid).toBe('lin_w');
  });

  it('never cards the user or the speaker themself', () => {
    const resolve = cardResolver(contacts, 'ai_a');
    expect(resolve('我')).toBeUndefined();
    expect(resolve('林晚')).toBeUndefined(); // the speaker introducing herself = bug
    expect(resolve('不认识')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The game module: the seeds ARE the contract.
// ---------------------------------------------------------------------------

describe('lib/game', () => {
  it('the same (convId, at, salt) always lands the same throw', () => {
    const seed = gameSeed('c9', T0, 2);
    expect(rollDice(seed)).toBe(rollDice(seed));
    expect(rollRps(seed)).toBe(rollRps(seed));
  });

  it('different timestamps roll independently (not all the same face)', () => {
    const faces = new Set(Array.from({ length: 30 }, (_, i) => rollDice(gameSeed('c9', T0 + i * 1000))));
    expect(faces.size).toBeGreaterThan(2);
    for (const f of faces) {
      expect(f).toBeGreaterThanOrEqual(1);
      expect(f).toBeLessThanOrEqual(6);
    }
  });

  it('rps results stay in the label table', () => {
    for (let i = 0; i < 20; i++) {
      const r = rollRps(gameSeed('c', T0 + i));
      expect(RPS_LABELS[r]).toBeDefined();
    }
  });

  it('rpsCompare knows who beats whom', () => {
    expect(rpsCompare(0, 1)).toBe(1); // 石头胜剪刀
    expect(rpsCompare(1, 2)).toBe(1); // 剪刀胜布
    expect(rpsCompare(2, 0)).toBe(1); // 布胜石头
    expect(rpsCompare(1, 0)).toBe(-1);
    expect(rpsCompare(2, 2)).toBe(0);
  });

  it('clamps tampered stored results instead of crashing a render', () => {
    expect(diceResult(99)).toBe(1);
    expect(diceResult('x')).toBe(1);
    expect(rpsResult(-3)).toBe(0);
    expect(describeGame('dice', 4)).toContain('4 点');
  });
});

// ---------------------------------------------------------------------------
// The parse path: models can actually emit these.
// ---------------------------------------------------------------------------

describe('parseBubbles with M-I13 types', () => {
  it('accepts every new type via NDJSON', () => {
    const out = parseBubbles(
      [
        '{"type":"location","content":"老地方"}',
        '{"type":"contact","content":"阿北"}',
        '{"type":"file","content":"攻略.pdf"}',
        '{"type":"link","content":"标题|摘要"}',
        '{"type":"dice","content":""}',
        '{"type":"rps","content":""}',
      ].join('\n'),
    );
    expect(out.map((b) => b.type)).toEqual(['location', 'contact', 'file', 'link', 'dice', 'rps']);
  });

  it('tolerates a game bubble with NO content field — the model must not pick its own number', () => {
    const out = parseBubbles('{"type":"dice"}');
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('dice');
    expect(out[0].content).toBe('');
  });

  it('repair keeps a declared rich type instead of downgrading it to text', () => {
    // `text` alias field + a valid new type: the repair path must not lose it.
    const out = parseBubbles('{"type":"link","text":"好文|真的好"}');
    expect(out[0].type).toBe('link');
    expect(out[0].content).toBe('好文|真的好');
  });
});

// ---------------------------------------------------------------------------
// The prompt tells the model these types exist.
// ---------------------------------------------------------------------------

describe('prompt advertises the M-I13 vocabulary', () => {
  const system = assembleSystemPrompt({
    persona: { name: '小测', core: '测试用人设' },
    nsfwTier: 'off',
    scene: { kind: 'single', now: new Date(T0) },
  });

  it('names every new bubble type', () => {
    for (const t of ['location', 'contact', 'file', 'link', 'dice', 'rps']) {
      expect(system).toContain(t);
    }
  });

  it('forbids the model from announcing its own game result', () => {
    expect(system).toContain('系统随机决定');
  });
});

// ---------------------------------------------------------------------------
// gameDirective: 接梗 without spoiling.
// ---------------------------------------------------------------------------

describe('gameDirective', () => {
  const PEER = 'ai_lin';
  const g = (id: number, senderId: string, game: 'dice' | 'rps', result: number): MessageVM =>
    msg({ id, senderId, type: 'game', meta: { game, result } });
  const t = (id: number, senderId: string, content: string): MessageVM =>
    msg({ id, senderId, type: 'text', content });

  it('tells her the point when the user just threw a die', () => {
    const line = gameDirective([t(1, 'self', '来'), g(2, 'self', 'dice', 5)], PEER);
    expect(line).toContain('5 点');
    expect(line).toContain('dice');
  });

  it('names the hand but FORBIDS calling the outcome on a fresh rps throw', () => {
    const line = gameDirective([g(1, 'self', 'rps', 0)], PEER);
    expect(line).toContain('石头');
    expect(line).toContain('不要评价谁输谁赢');
  });

  it('grants gloating rights once both rps hands are visible', () => {
    // user 出剪刀, she 出石头 → she won. Newest message is user's text.
    const line = gameDirective(
      [g(1, 'self', 'rps', 1), g(2, PEER, 'rps', 0), t(3, 'self', '啊这')],
      PEER,
    );
    expect(line).toContain('你赢了');
    expect(line).toContain('剪刀');
    expect(line).toContain('石头');
  });

  it('calls a dice round by comparing points', () => {
    const line = gameDirective(
      [g(1, 'self', 'dice', 6), g(2, PEER, 'dice', 2), t(3, 'self', '哈哈')],
      PEER,
    );
    expect(line).toContain('你输了');
  });

  it('stays silent when no game is live, and when the round has gone stale', () => {
    expect(gameDirective([t(1, 'self', '在吗')], PEER)).toBe('');
    const stale = [
      g(1, 'self', 'rps', 1),
      g(2, PEER, 'rps', 0),
      t(3, 'self', 'a'),
      t(4, PEER, 'b'),
      t(5, 'self', 'c'),
      t(6, PEER, 'd'),
      t(7, 'self', 'e'),
    ];
    expect(gameDirective(stale, PEER)).toBe('');
  });

  it('does not react to her own throw as if it were a challenge', () => {
    // Newest message is HER die — nothing to respond to yet.
    const line = gameDirective([t(1, 'self', '来'), g(2, PEER, 'dice', 3)], PEER);
    expect(line).not.toContain('对方刚掷了骰子');
  });

  it('ignores recalled throws', () => {
    const recalled = { ...g(2, 'self', 'dice', 6), isRecalled: true };
    expect(gameDirective([t(1, 'self', '来'), recalled], PEER)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Conversation-list previews.
// ---------------------------------------------------------------------------

describe('previewOf for M-I13 types', () => {
  it('labels each rich type', () => {
    expect(previewOf(msg({ type: 'location', content: '公司' }))).toBe('[位置]公司');
    expect(previewOf(msg({ type: 'contact_card', meta: { name: '阿北' } }))).toBe('[名片]阿北');
    expect(previewOf(msg({ type: 'file', meta: { fileName: '合同.pdf' } }))).toBe('[文件]合同.pdf');
    expect(previewOf(msg({ type: 'link', meta: { title: '标题' } }))).toBe('[链接]标题');
    expect(previewOf(msg({ type: 'game', meta: { game: 'dice', result: 2 } }))).toBe('[动画表情]');
    expect(previewOf(msg({ type: 'merged', meta: { title: 'x' } }))).toBe('[聊天记录]');
  });
});
