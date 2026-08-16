/**
 * 朋友圈 v2 (M-I15): topics, reposts (and their leak rule), visitor hints,
 * the news badge, serial goal posts, and the notification grading extension.
 */
import { describe, it, expect } from 'vitest';
import { parseTopics, topicSegments, hasTopic } from '../../src/lib/topics';
import {
  repostExcerpt,
  buildRepost,
  canRepost,
  repostMoment,
  REPOST_EXCERPT_MAX,
} from '../../src/ai/moment-repost';
import { recentVisitor, visitorLine, VISIT_TTL_MS } from '../../src/ai/moments-visitors';
import { collectMomentsNews } from '../../src/ai/moments-news';
import {
  maybeTopicTag,
  goalSeriesLine,
  planRepost,
  TOPIC_POOLS,
  GENERIC_TOPICS,
  TOPIC_TAG_RATE,
  REPOST_RATE,
  REPOST_MIN_AFFINITY,
  type ReactorInfo,
} from '../../src/ai/moments-engine';
import {
  toNotifiable,
  buildNotifications,
  LIKE_NOTIFY_BODY,
  REPOST_NOTIFY_BODY,
  momentsRoute,
} from '../../src/ai/notify-service';
import { displayBody, NO_PREVIEW_BODY, canPregenerateBody } from '../../src/lib/notify';
import { parseDeepLink } from '../../src/native/deep-link';
import type { GoalState } from '../../src/ai/goals';
import type { ScheduledAction } from '../../src/ai/scheduler';
import type { MomentVM, MomentLikeVM, MomentCommentVM } from '../../src/data/types';

const NOW = new Date(2025, 7, 6, 12, 0, 0).getTime();
const HOUR = 3_600_000;

function moment(over: Partial<MomentVM> = {}): MomentVM {
  return {
    id: 'm1',
    authorId: 'a',
    text: '今天天气不错',
    imageRefs: [],
    isNsfw: false,
    createdAt: NOW - HOUR,
    ...over,
  };
}

/* ------------------------------- topics ------------------------------- */

describe('topic parsing', () => {
  it('finds tags and strips the # marks', () => {
    expect(parseTopics('加班到现在 #打工人# 求安慰')).toEqual(['打工人']);
  });

  it('dedupes and keeps first-appearance order', () => {
    expect(parseTopics('#a# 和 #b# 再 #a#')).toEqual(['a', 'b']);
  });

  it('ignores an unpaired # and whitespace-only tags', () => {
    expect(parseTopics('价格是 #5')).toEqual([]);
    expect(parseTopics('前后# #后面')).toEqual([]);
  });

  it('ignores tags longer than the cap', () => {
    expect(parseTopics(`#${'字'.repeat(13)}#`)).toEqual([]);
  });

  it('handles undefined text', () => {
    expect(parseTopics(undefined)).toEqual([]);
  });

  it('segments losslessly around tags', () => {
    const text = '早起 #自律打卡# 完成，继续 #减肥日常# 冲';
    const segs = topicSegments(text);
    const rebuilt = segs.map((s) => (s.kind === 'topic' ? `#${s.value}#` : s.value)).join('');
    expect(rebuilt).toBe(text);
    expect(segs.filter((s) => s.kind === 'topic').map((s) => s.value)).toEqual([
      '自律打卡',
      '减肥日常',
    ]);
  });

  it('hasTopic demands the real #tag#, not a substring', () => {
    expect(hasTopic('我在 #减肥日常# 里', '减肥日常')).toBe(true);
    expect(hasTopic('我的减肥日常很苦', '减肥日常')).toBe(false);
  });
});

/* ------------------------------- reposts ------------------------------- */

describe('repost building', () => {
  it('quotes the source with a snapshot derived from the source only', () => {
    const src = moment({ text: '被裁了，喝酒去' });
    const rp = buildRepost(src, { authorId: 'self', text: '抱抱', now: NOW });
    expect(rp).not.toBeNull();
    expect(rp!.repostOf).toBe('m1');
    expect(rp!.repostAuthorId).toBe('a');
    expect(rp!.repostExcerpt).toBe('被裁了，喝酒去');
    expect(rp!.imageRefs).toEqual([]);
  });

  it('caps the excerpt', () => {
    const long = '长'.repeat(200);
    expect(repostExcerpt({ text: long, imageRefs: [] }).length).toBe(REPOST_EXCERPT_MAX + 1); // +… mark
  });

  it('uses an image placeholder for a textless original', () => {
    expect(repostExcerpt({ text: undefined, imageRefs: ['ph:0'] })).toBe('[图片]');
  });

  it('collapses a chain to the root — reposting a repost quotes the original', () => {
    const middle = moment({
      id: 'm2',
      authorId: 'b',
      text: '同感',
      repostOf: 'm1',
      repostAuthorId: 'a',
      repostExcerpt: '被裁了，喝酒去',
    });
    const rp = buildRepost(middle, { authorId: 'self', text: '', now: NOW });
    expect(rp!.repostOf).toBe('m1');
    expect(rp!.repostAuthorId).toBe('a');
    expect(rp!.repostExcerpt).toBe('被裁了，喝酒去');
  });

  it('refuses reposting your own root post', () => {
    expect(buildRepost(moment({ authorId: 'self' }), { authorId: 'self', text: 'x', now: NOW })).toBeNull();
  });

  it('refuses an NSFW-flagged source', () => {
    expect(canRepost(moment({ isNsfw: true }))).toBe(false);
  });
});

describe('repost leak rule (转红)', () => {
  it('refuses a source that is not in the stored feed — hidden content cannot ride a quote', async () => {
    // The attacker "holds" a moment object stuffed with hidden-DM content, but
    // the service only accepts an ID and re-reads storage: nothing stored,
    // nothing quoted.
    const added: MomentVM[] = [];
    const rp = await repostMoment(
      'dm_secret_row',
      { authorId: 'self', text: '看看这个', now: NOW },
      { getMoment: async () => undefined, addMoment: async (m) => void added.push(m) },
    );
    expect(rp).toBeNull();
    expect(added).toEqual([]);
  });

  it('derives the quote from the STORED row, whatever the caller believes', async () => {
    const stored = moment({ text: '公开的内容' });
    const added: MomentVM[] = [];
    const rp = await repostMoment(
      'm1',
      { authorId: 'self', text: '转一下', now: NOW },
      { getMoment: async (id) => (id === 'm1' ? stored : undefined), addMoment: async (m) => void added.push(m) },
    );
    expect(rp!.repostExcerpt).toBe('公开的内容');
    expect(added).toHaveLength(1);
    // No field of the stored repost carries anything but feed-derived content.
    expect(added[0].repostExcerpt).toBe('公开的内容');
  });
});

/* ---------------------------- AI repost planner ---------------------------- */

describe('planRepost (AI 转发)', () => {
  const reactor = (id: string, affinity = 80): ReactorInfo => ({
    contactId: id,
    likeRate: 0.5,
    commentRate: 0.25,
    affinity,
    activeHours: [[9, 23]],
  });
  const crowd = ['a', 'b', 'c'].map((id) => reactor(id));

  it('is deterministic', () => {
    expect(planRepost('m1', 'self', NOW, crowd, 's')).toEqual(
      planRepost('m1', 'self', NOW, crowd, 's'),
    );
  });

  it('only ever fires on USER posts — agents never boost each other', () => {
    for (let i = 0; i < 200; i++) {
      expect(planRepost(`m${i}`, 'a', NOW, crowd, 's')).toBeNull();
    }
  });

  it('is rare, near the configured rate', () => {
    let hits = 0;
    const n = 800;
    for (let i = 0; i < n; i++) if (planRepost(`m${i}`, 'self', NOW, crowd, 's')) hits++;
    expect(hits / n).toBeGreaterThan(REPOST_RATE - 0.05);
    expect(hits / n).toBeLessThan(REPOST_RATE + 0.05);
  });

  it('only close friends repost', () => {
    const cold = ['a', 'b'].map((id) => reactor(id, REPOST_MIN_AFFINITY - 10));
    for (let i = 0; i < 300; i++) {
      expect(planRepost(`m${i}`, 'self', NOW, cold, 's')).toBeNull();
    }
  });

  it('lands after the post, later than a like would', () => {
    for (let i = 0; i < 300; i++) {
      const p = planRepost(`m${i}`, 'self', NOW, crowd, 's');
      if (!p) continue;
      expect(p.at).toBeGreaterThan(NOW + 29 * 60_000);
      expect(['a', 'b', 'c']).toContain(p.contactId);
    }
  });
});

/* ------------------------------- visitors ------------------------------- */

describe('feed visitors', () => {
  const ids = ['a', 'b', 'c'];

  it('is deterministic for the same hour', () => {
    expect(recentVisitor(ids, NOW)).toEqual(recentVisitor(ids, NOW));
    expect(recentVisitor(ids, NOW + 60_000)).toEqual(recentVisitor(ids, NOW));
  });

  it('never visits with no candidates', () => {
    expect(recentVisitor([], NOW)).toBeNull();
  });

  it('names a real candidate, in the past, within the TTL', () => {
    let seen = 0;
    for (let h = 0; h < 200; h++) {
      const v = recentVisitor(ids, NOW + h * HOUR);
      if (!v) continue;
      seen++;
      expect(ids).toContain(v.contactId);
      expect(v.at).toBeLessThanOrEqual(NOW + h * HOUR);
      expect(NOW + h * HOUR - v.at).toBeLessThanOrEqual(VISIT_TTL_MS);
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('is genuinely low-frequency — most hours show nobody', () => {
    let seen = 0;
    for (let h = 0; h < 400; h++) if (recentVisitor(ids, NOW + h * HOUR)) seen++;
    expect(seen / 400).toBeLessThan(0.5);
    expect(seen / 400).toBeGreaterThan(0.02);
  });

  it('writes the hint line', () => {
    expect(visitorLine('小雨')).toBe('小雨 刚看过你的朋友圈');
  });
});

/* ------------------------------- news badge ------------------------------- */

describe('moments news', () => {
  const mine = moment({ id: 'mm', authorId: 'self' });
  const theirs = moment({ id: 'mt', authorId: 'a' });
  const like = (id: string, momentId: string, who: string, at: number): MomentLikeVM => ({
    id,
    momentId,
    contactId: who,
    createdAt: at,
  });
  const comment = (id: string, momentId: string, who: string, at: number): MomentCommentVM => ({
    id,
    momentId,
    authorId: who,
    text: 'hi',
    createdAt: at,
  });

  it('counts only reactions to the user’s own posts', () => {
    const news = collectMomentsNews(
      [mine, theirs],
      { mm: [like('l1', 'mm', 'a', NOW)], mt: [like('l2', 'mt', 'b', NOW)] },
      {},
      0,
    );
    expect(news.count).toBe(1);
    expect(news.actorId).toBe('a');
  });

  it('ignores the user’s own reactions and anything before seenAt', () => {
    const news = collectMomentsNews(
      [mine],
      { mm: [like('l1', 'mm', 'self', NOW), like('l2', 'mm', 'a', NOW - 2 * HOUR)] },
      { mm: [comment('c1', 'mm', 'b', NOW)] },
      NOW - HOUR,
    );
    expect(news.count).toBe(1);
    expect(news.items[0].kind).toBe('comment');
  });

  it('is empty with no own posts', () => {
    expect(collectMomentsNews([theirs], {}, {}, 0).count).toBe(0);
  });

  it('newest actor fronts the badge', () => {
    const news = collectMomentsNews(
      [mine],
      { mm: [like('l1', 'mm', 'a', NOW - HOUR), like('l2', 'mm', 'b', NOW)] },
      {},
      0,
    );
    expect(news.actorId).toBe('b');
    expect(news.items.map((i) => i.actorId)).toEqual(['b', 'a']);
  });
});

/* ---------------------- serial goal posts & topic gate ---------------------- */

function goalState(over: Partial<GoalState> = {}): GoalState {
  return {
    contactId: 'a',
    cycle: 0,
    domain: 'study',
    title: '准备考一个证',
    status: 'active',
    milestoneIndex: 1,
    stage: '刷完了第一轮网课',
    progress: 0.4,
    startedAt: NOW - 20 * 24 * HOUR,
    milestones: [
      { text: '报了名，教材刚到手', at: NOW - 10 * 24 * HOUR, reached: true },
      { text: '刷完了第一轮网课', at: NOW - 24 * HOUR, reached: true },
      { text: '', at: NOW + 10 * 24 * HOUR, reached: false },
    ],
    ...over,
  };
}

describe('goal series line (连续剧式发帖)', () => {
  it('says nothing before the second milestone — episode one has no callback', () => {
    expect(goalSeriesLine(goalState({ milestoneIndex: 0 }))).toBe('');
    expect(goalSeriesLine(goalState({ milestoneIndex: -1 }))).toBe('');
  });

  it('references the goal and the PREVIOUS stage from the second on', () => {
    const line = goalSeriesLine(goalState());
    expect(line).toContain('准备考一个证');
    expect(line).toContain('报了名，教材刚到手');
  });

  it('says nothing once the goal has ended', () => {
    expect(goalSeriesLine(goalState({ status: 'completed' }))).toBe('');
  });
});

describe('topic tag gate', () => {
  it('is deterministic per seed', () => {
    expect(maybeTopicTag('study', 's1')).toBe(maybeTopicTag('study', 's1'));
  });

  it('tags a seeded minority of posts, near the configured rate', () => {
    let tagged = 0;
    const n = 800;
    for (let i = 0; i < n; i++) if (maybeTopicTag(undefined, `s${i}`)) tagged++;
    expect(tagged / n).toBeGreaterThan(TOPIC_TAG_RATE - 0.08);
    expect(tagged / n).toBeLessThan(TOPIC_TAG_RATE + 0.08);
  });

  it('draws goal posts from the domain pool and plain posts from the generic one', () => {
    for (let i = 0; i < 300; i++) {
      const g = maybeTopicTag('health', `g${i}`);
      if (g) expect(TOPIC_POOLS.health).toContain(g);
      const p = maybeTopicTag(undefined, `p${i}`);
      if (p) expect(GENERIC_TOPICS).toContain(p);
    }
  });
});

/* ------------------------- moments notifications ------------------------- */

function action(over: Partial<ScheduledAction> & { payload?: unknown } = {}): ScheduledAction {
  const { payload, ...rest } = over;
  return {
    id: 'ml_1',
    fireAt: NOW + HOUR,
    kind: 'moment_like',
    payloadJson: JSON.stringify(payload ?? { momentId: 'mm', contactId: 'a' }),
    status: 'pending',
    createdAt: NOW,
    ...rest,
  };
}

describe('moments reaction notifications (尊重内容分级)', () => {
  const nameOf = (id: string) => (id === 'a' ? '林小雨' : undefined);
  const selfMomentIds = new Set(['mm']);

  it('stays silent without the self-post allowlist (the pre-I15 default)', () => {
    expect(toNotifiable([action()])).toEqual([]);
  });

  it('notifies a like on YOUR post with the act as the preview', () => {
    const items = buildNotifications(toNotifiable([action()], { selfMomentIds }), nameOf, NOW);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('林小雨');
    expect(items[0].kind).toBe('reaction');
    expect(displayBody(items[0])).toBe(LIKE_NOTIFY_BODY);
  });

  it('never notifies reactions to OTHER people’s posts', () => {
    const a = action({ payload: { momentId: 'mt', contactId: 'a' } });
    expect(toNotifiable([a], { selfMomentIds })).toEqual([]);
  });

  it('notifies a repost of YOUR post with the act as the preview', () => {
    const a = action({ kind: 'moment_repost' });
    const items = buildNotifications(toNotifiable([a], { selfMomentIds }), nameOf, NOW);
    expect(items[0].kind).toBe('reaction');
    expect(displayBody(items[0])).toBe(REPOST_NOTIFY_BODY);
  });

  it('grades a comment as no-preview — its text is generated at fire time', () => {
    const a = action({ kind: 'moment_comment' });
    const items = buildNotifications(toNotifiable([a], { selfMomentIds }), nameOf, NOW);
    expect(items[0].kind).toBe('followup');
    expect(displayBody(items[0])).toBe(NO_PREVIEW_BODY);
  });

  it('reaction is a pre-generatable grade; followup remains not', () => {
    expect(canPregenerateBody('reaction')).toBe(true);
    expect(canPregenerateBody('followup')).toBe(false);
  });

  it('skips a moment payload with no momentId', () => {
    const a = action({ payload: { contactId: 'a' } });
    expect(toNotifiable([a], { selfMomentIds })).toEqual([]);
  });

  it('heartbeat grading is untouched by the new option', () => {
    const hb = action({
      kind: 'heartbeat',
      id: 'hb1',
      payload: { contactId: 'a', convId: 'c', body: '早安' },
    });
    const [n] = buildNotifications(toNotifiable([hb], { selfMomentIds }), nameOf, NOW);
    expect(n.kind).toBe('greeting');
    expect(displayBody(n)).toBe('早安');
  });
});

/**
 * 通知落点 (M-I18).
 *
 * `toNotifiable` had the momentId in hand for the self-post allowlist and then
 * dropped it, and `ScheduledNotification` had no destination field at all — so
 * a pre-scheduled notification opened the app at wherever it last was. For a
 * 赞/评 that means the user is told someone reacted to their post and then has
 * to go find which one. The live notifications (background-notify) always
 * carried `aiwx://chat/<convId>`; this is the scheduled half catching up.
 */
describe('a reaction notification knows which post it is about', () => {
  const nameOf = (id: string) => (id === 'a' ? '林小雨' : undefined);
  const selfMomentIds = new Set(['mm']);

  it('carries an anchored moments route through to the scheduled item', () => {
    const [n] = buildNotifications(toNotifiable([action()], { selfMomentIds }), nameOf, NOW);
    expect(
      n.route,
      '朋友圈通知没有落点——点进去只能自己在feed里翻找那一条',
    ).toBe('aiwx://moments?at=mm');
  });

  it('every moments kind gets one, comments included', () => {
    for (const kind of ['moment_like', 'moment_comment', 'moment_repost'] as const) {
      const [n] = buildNotifications(
        toNotifiable([action({ kind })], { selfMomentIds }),
        nameOf,
        NOW,
      );
      expect(n.route).toBe('aiwx://moments?at=mm');
    }
  });

  it('a momentId with URL-hostile characters survives the round trip', () => {
    const a = action({ payload: { momentId: 'mo/1?x=2&y', contactId: 'a' } });
    const [n] = buildNotifications(
      toNotifiable([a], { selfMomentIds: new Set(['mo/1?x=2&y']) }),
      nameOf,
      NOW,
    );
    const route = parseDeepLink(n.route!);
    expect(route).toBe('/moments?at=mo%2F1%3Fx%3D2%26y');
    expect(new URLSearchParams(route!.split('?')[1]).get('at')).toBe('mo/1?x=2&y');
  });

  it('a heartbeat opens its own chat, not the chat list', () => {
    const hb = action({
      kind: 'heartbeat',
      id: 'hb1',
      payload: { contactId: 'a', convId: 'conv_a', body: '早安' },
    });
    const [n] = buildNotifications(toNotifiable([hb], { selfMomentIds }), nameOf, NOW);
    expect(n.route).toBe('aiwx://chat/conv_a');
    expect(parseDeepLink(n.route!)).toBe('/chat/conv_a');
  });

  it('a heartbeat with no convId simply has no route, rather than a broken one', () => {
    const hb = action({ kind: 'heartbeat', id: 'hb2', payload: { contactId: 'a' } });
    const [n] = buildNotifications(toNotifiable([hb], { selfMomentIds }), nameOf, NOW);
    expect(n.route).toBeUndefined();
  });

  it('the route still has to pass the deep-link allowlist', () => {
    // A notification payload is not more trusted than any other intent: it goes
    // back in through the same gate. /moments had to be added to it.
    expect(parseDeepLink(momentsRoute('mm'))).toBe('/moments?at=mm');
    expect(parseDeepLink('aiwx://moments/secret')).toBeNull();
    expect(parseDeepLink('aiwx://settings/keys')).toBeNull();
  });
});
