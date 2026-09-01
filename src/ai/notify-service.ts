/**
 * Turning queued actions into lock-screen notifications.
 *
 * `src/lib/notify.ts` had no caller at all until now — it was written in M4 and
 * left unwired, so the whole pre-scheduled-notification feature was inert. This
 * module is the missing half.
 *
 * THE CONSISTENCY RULE (specs/backfill.md) is what shapes the design: whatever a
 * notification displays must already exist as a real message with
 * `createdAt === fireAt`. The user may read it on the lock screen and open the
 * app minutes later; different text, or the same text at a different time, is the
 * most jarring possible tell.
 *
 * Satisfying that without a server means the body has to be known *at schedule
 * time*. Rather than burn an LLM call on every foreground to invent one, this
 * uses `PersonaVM.greeting` — a hand-written, persona-specific opener that has
 * been sitting in the schema (and in every seed row) unread since M2. It is
 * time-anchored by nature, so it is still true whenever it fires.
 *
 * Heartbeats WITHOUT a pre-written body stay `followup`: they'd quote a
 * conversation that may have moved on, so they ship with no preview.
 *
 * MOMENTS REACTIONS (M-I15): queued likes/comments on the USER's own posts
 * notify too — that is the half of 朋友圈 that reaches you when the app is
 * closed. Grading:
 *   - a like's body is the ACT ("赞了你的朋友圈"), fully known at schedule
 *     time → kind 'reaction', preview shown;
 *   - a comment's text is GENERATED at fire time → kind 'followup', so it
 *     ships as "[你收到一条消息]" and can never contradict what actually lands.
 * Only the user's own posts qualify — being told a friend liked some third
 * friend's post is noise, and the momentId allowlist is built by the caller
 * from stored self-authored rows, so no other surface can widen it.
 */
import type { ScheduledAction } from './scheduler';
import type { ContactVM } from '../data/types';
import type { ScheduledActionKind as ActionKind } from '../db/schema';
import { FALLBACK_AVATAR_TINT } from '../data/persona-defaults';
import type { NotifyKind } from '../lib/notify';
import {
  notificationId,
  scheduleNotifications,
  cancelAll,
  canPregenerateBody,
  type ScheduledNotification,
} from '../lib/notify';

/** Don't bother the OS with things further out than this. */
const HORIZON_MS = 24 * 3_600_000;

/* ==================================================================== */
/* 通知表态台账 (M-J4a)                                                  */
/* ==================================================================== */

export type NotifyStance = { via: 'eligible' } | { via: 'silent'; why: string };

/**
 * 每个排期 kind 对「App 关着时该不该出通知」的表态——M-J 侦察结论 #3 的
 * 永久修复：此前 21 种 kind 里只有 4 种出通知，她转账/打电话/群里说话在
 * App 关闭时全部无声，而且新增 kind 默认就是无声的，没人会想起来问。
 *
 * 现在这份台账是 `Record<ActionKind, …>`：加 kind 不表态直接编译不过；
 * 守卫测试再断言键集合与 SCHEDULED_ACTION_KINDS 完全相等。
 *
 * eligible 的准入门槛是**一致性铁律**（见文件头）：通知内容必须在排期时刻
 * 就完全可知，且落地物（消息/记录）在用户点开时必然存在（回填物化）。
 * 内容 fire 时才定的，最多给 followup 档「[你收到一条消息]」；连「会不会
 * 发生」都 fire 时才定的，一律 silent——通知说了却没发生，是最响的穿帮。
 */
export const NOTIFY_STANCE: Record<ActionKind, NotifyStance> = {
  heartbeat: { via: 'eligible' }, // 预写 greeting 可逐字展示；无预写降 followup
  moment_like: { via: 'eligible' }, // 赞的"动作"即内容，排期时刻全知（仅自己的帖）
  moment_comment: { via: 'eligible' }, // 评论文本 fire 时生成 → followup 档
  moment_repost: { via: 'eligible' }, // 同赞：转发动作全知
  ai_money: { via: 'eligible' }, // 红包/转账/群收款三分支都在 payload 里定死
  ai_call: { via: 'eligible' }, // 「给你打过语音电话」——过去式措辞，点开进聊天页而非响铃页
  bill_pay: { via: 'eligible' }, // 谁付了群收款在开单时刻就定死（装死的根本不排）
  group_msg: { via: 'eligible' }, // 内容 fire 时生成 → followup 档，标题用群名
  group_chatter: { via: 'eligible' }, // 同上；静默期避让可能让单条落空，followup 档承受得起
  moment_post: {
    via: 'silent',
    why: '真微信不推送好友新动态——朋友圈是你去看的，不是它来找你的。保真优先。',
  },
  agent_dm: {
    via: 'silent',
    why: '隐藏 AI↔AI 私信面。任何通知都是不可逆的穿帮泄漏（红测钉死零产出）。',
  },
  recall: {
    via: 'silent',
    why: '真微信撤回不出新通知；而且撤回的是哪条、成不成功都是 fire 时才定的。',
  },
  mem_extract: { via: 'silent', why: '纯内部记忆管线，没有用户可见落地物。' },
  story_tick: {
    via: 'silent',
    why: '剧情节拍失败会暂停自续链（M-G0 的修复点），预告一个可能没发生的节拍必穿帮；离线节拍由回填物化，回来自然看到。',
  },
  auto_backup: { via: 'silent', why: '纯内部备份任务，成功本就该无感。' },
  rp_grab: {
    via: 'silent',
    why: 'payload 只有 rpId+抢包人，排期时刻判不出包是不是用户发的——把 AI 抢 AI 红包也报给你就是噪音。扩展路径：仿 selfMomentIds 传自发包 allowlist。',
  },
  transfer_accept: {
    via: 'silent',
    why: 'payload 只有 transferId，无收款人无会话可显示；结果消息由回填物化。',
  },
  transfer_return: { via: 'silent', why: '同 transfer_accept：payload 只有 id。' },
  rp_return: { via: 'silent', why: '同 transfer_accept：payload 只有 id。' },
  joint_plan: {
    via: 'silent',
    why: 'payload 携带隐藏 DM 编排面（dmId/a/b），且物化与否 fire 时才定——泄漏风险大于价值。',
  },
  group_event: {
    via: 'silent',
    why: '多阶段状态机（提议/RSVP/事件日/事后），每阶段内容与成败 fire 时才定。',
  },
  agent_forward: {
    via: 'silent',
    why: '转发是否通过隐藏来源检查 fire 时才定；预告一条可能被拒的转发必穿帮。',
  },
  agent_invite: { via: 'silent', why: '提议卡内容 fire 时生成，且用户在场才有意义。' },
  sticker_reply: {
    via: 'silent',
    why: '秒级斗图节拍，只在用户正看着聊天页时才会排——给盯着屏幕的人弹横幅是骚扰。',
  },
};

/** The fixed like line. The act is the content; nothing here can go stale. */
export const LIKE_NOTIFY_BODY = '赞了你的朋友圈';

/** Same grading logic as a like: the repost ACT is fully known at schedule time. */
export const REPOST_NOTIFY_BODY = '转发了你的朋友圈';

/** Money acts (M-J4a): the branch is fixed in the payload at schedule time. */
export const MONEY_NOTIFY_BODY: Record<'rp' | 'transfer' | 'bill', string> = {
  rp: '给你发了一个红包',
  transfer: '给你转了一笔钱',
  bill: '发起了群收款',
};

/** Past-tense on purpose: tapping hours later must read as a missed call. */
export const CALL_NOTIFY_BODY = '给你打过语音电话';

export const BILL_PAY_NOTIFY_BODY = '支付了群收款';

export interface NotifiableAction {
  id: string;
  kind: string;
  fireAt: number;
  /** Absent for group-titled kinds (group_msg/group_chatter) — `title` rules. */
  contactId?: string;
  /** Pre-resolved title (group name); wins over contactId resolution. */
  title?: string;
  /**
   * The conversation this belongs to (M-J4). The route already encodes it, but
   * the native snapshot needs it as a field: MessagingStyle keys its stacked
   * history and its dynamic shortcut on the conversation, not on a URI.
   */
  convId?: string;
  /** Pre-written text; present only when it can be shown verbatim. */
  body?: string;
  /** Explicit grading for non-heartbeat kinds (M-I15); heartbeats derive theirs. */
  notifyKind?: NotifyKind;
  /**
   * Where a tap should land (M-I18).
   *
   * The moments kinds already had to read `momentId` off the payload for the
   * self-authored allowlist — and then dropped it, so the notification landed
   * on whatever screen the app was last on and the user got to scroll the feed
   * looking for the post someone had just reacted to. Heartbeats carry `convId`
   * for the same reason: a proactive-message notification that opens the chat
   * LIST is the same defect, one screen shallower.
   */
  route?: string;
}

/** `aiwx://moments?at=<id>` — the feed, anchored on one post. */
export const momentsRoute = (momentId: string): string =>
  `aiwx://moments?at=${encodeURIComponent(momentId)}`;

/** `aiwx://chat/<convId>` — the same shape the Kotlin side builds for live ones. */
export const chatRoute = (convId: string): string => `aiwx://chat/${encodeURIComponent(convId)}`;

export interface NotifiableOpts {
  /**
   * Moments the USER authored — the allowlist for like/comment notifications.
   * Absent = no moments notifications at all (the pre-I15 behavior), which is
   * also the safe default for any caller that has no feed context.
   */
  selfMomentIds?: ReadonlySet<string>;
  /**
   * Resolve a convId to its VISIBLE group title (M-J4a). The caller builds it
   * from store conversations excluding isHidden rows — so a hidden conv id in
   * a payload resolves to nothing and the row silently drops. Absent = group
   * kinds don't notify (safe default for callers without conv context).
   */
  groupTitleOf?: (convId: string) => string | undefined;
}

/** Parse the queue rows into the minimum this module needs. Bad rows are skipped. */
export function toNotifiable(
  actions: ScheduledAction[],
  opts: NotifiableOpts = {},
): NotifiableAction[] {
  const out: NotifiableAction[] = [];
  for (const a of actions) {
    if (a.status !== 'pending') continue;
    // 台账是唯一准入（M-J4a）：不认识的 kind（台账外）和表态 silent 的都出局。
    if (NOTIFY_STANCE[a.kind as ActionKind]?.via !== 'eligible') continue;
    const isMomentKind =
      a.kind === 'moment_like' || a.kind === 'moment_comment' || a.kind === 'moment_repost';
    try {
      const p = JSON.parse(a.payloadJson) as {
        contactId?: unknown;
        convId?: unknown;
        body?: unknown;
        momentId?: unknown;
        kind?: unknown;
      };
      const convId = typeof p.convId === 'string' && p.convId ? p.convId : undefined;

      // 群标题类（发言人 fire 时才定，标题只能是群名）。
      if (a.kind === 'group_msg' || a.kind === 'group_chatter') {
        if (!convId) continue;
        const title = opts.groupTitleOf?.(convId);
        if (!title) continue; // 没群名 = 没上下文（或隐藏会话）——静默出局
        out.push({
          id: a.id,
          kind: a.kind,
          fireAt: a.fireAt,
          title,
          convId,
          notifyKind: 'followup',
          route: chatRoute(convId),
        });
        continue;
      }

      if (typeof p.contactId !== 'string') continue;
      if (isMomentKind) {
        // Only reactions to the user's OWN posts, and only when the caller
        // could actually verify authorship against stored rows.
        if (typeof p.momentId !== 'string' || !opts.selfMomentIds?.has(p.momentId)) continue;
        out.push({
          id: a.id,
          kind: a.kind,
          fireAt: a.fireAt,
          contactId: p.contactId,
          // The momentId was already in hand for the allowlist check above and
          // used to stop here — which is why tapping the notification could not
          // find the post it was about.
          route: momentsRoute(p.momentId),
          ...(a.kind === 'moment_like'
            ? { body: LIKE_NOTIFY_BODY, notifyKind: 'reaction' as const }
            : a.kind === 'moment_repost'
              ? { body: REPOST_NOTIFY_BODY, notifyKind: 'reaction' as const }
              : { notifyKind: 'followup' as const }),
        });
        continue;
      }

      // 动作即内容类（M-J4a）：分支在排期时刻定死，可逐字展示。
      if (a.kind === 'ai_money' || a.kind === 'ai_call' || a.kind === 'bill_pay') {
        if (!convId) continue;
        const body =
          a.kind === 'ai_call'
            ? CALL_NOTIFY_BODY
            : a.kind === 'bill_pay'
              ? BILL_PAY_NOTIFY_BODY
              : MONEY_NOTIFY_BODY[
                  p.kind === 'transfer' ? 'transfer' : p.kind === 'bill' ? 'bill' : 'rp'
                ];
        out.push({
          id: a.id,
          kind: a.kind,
          fireAt: a.fireAt,
          contactId: p.contactId,
          body,
          convId,
          notifyKind: 'reaction',
          // 来电也进聊天页：几小时后才点开的"来电"通知落在响铃页是个陷阱。
          route: chatRoute(convId),
        });
        continue;
      }

      out.push({
        id: a.id,
        kind: a.kind,
        fireAt: a.fireAt,
        contactId: p.contactId,
        body: typeof p.body === 'string' && p.body.trim() ? p.body : undefined,
        ...(convId ? { convId, route: chatRoute(convId) } : {}),
      });
    } catch {
      /* malformed payload — not worth failing the whole sync over */
    }
  }
  return out;
}

/**
 * Build the notification list. Pure, so the grading and horizon rules are
 * unit-testable without touching the OS.
 *
 * @param nameOf resolve a contact id to its display name (the notification title)
 */
export function buildNotifications(
  actions: NotifiableAction[],
  nameOf: (contactId: string) => string | undefined,
  now: number,
): ScheduledNotification[] {
  const out: ScheduledNotification[] = [];
  // followup 归并（M-J4a）：同一会话的多条「[你收到一条消息]」内容一模一样，
  // 叠三条就是骚扰——每条路由只留最早那条。有正文的（greeting/reaction）
  // 各是各的信息，不归并。
  const followupSeen = new Set<string>();
  for (const a of [...actions].sort((x, y) => x.fireAt - y.fireAt)) {
    if (a.fireAt <= now) continue; // already due — the live tick handles it
    if (a.fireAt - now > HORIZON_MS) continue;
    const title = a.title ?? (a.contactId ? nameOf(a.contactId) : undefined);
    if (!title) continue; // contact deleted since the action was queued
    const kind = a.notifyKind ?? (a.body ? 'greeting' : 'followup');
    if (kind === 'followup' && !a.body && a.route) {
      if (followupSeen.has(a.route)) continue;
      followupSeen.add(a.route);
    }
    out.push({
      id: notificationId(a.id),
      title,
      // A pre-written greeting can be shown verbatim; anything else must not be.
      // `displayBody()` enforces this again at delivery — belt and braces,
      // because a leaked preview is not a recoverable mistake.
      body: a.body ?? '',
      fireAt: a.fireAt,
      kind,
      ...(a.route ? { route: a.route } : {}),
    });
  }
  return out.sort((x, y) => x.fireAt - y.fireAt);
}

/* ==================================================================== */
/* 原生唤醒快照 (M-J4)                                                    */
/* ==================================================================== */

/** One already-final row for the native snapshot (mirrors native/bridge WakeRow). */
export interface WakeRow {
  id: string;
  fireAt: number;
  title: string;
  body: string;
  convId: string;
  route: string;
  tint: string;
}

/**
 * Project the queue into rows Kotlin can deliver while the process is dead.
 *
 * **Derived from `buildNotifications`, deliberately** — not from a second walk
 * over the actions. Horizon, dedup, the "already due belongs to the live tick"
 * rule and above all the CONTENT GRADING therefore cannot drift between the
 * in-app path and the background one. A snapshot that graded independently
 * would eventually show a preview the app itself would have withheld, which is
 * the exact failure the consistency rule exists to prevent.
 *
 * `body: ''` is the no-preview grade, passed through as an empty string rather
 * than as the literal 「[你收到一条消息]」: the wording belongs to the platform
 * layer, and Kotlin substitutes it. Nothing here ever invents a line.
 */
export function buildWakeRows(
  actions: NotifiableAction[],
  nameOf: (contactId: string) => string | undefined,
  tintOf: (contactId: string) => string | undefined,
  now: number,
): WakeRow[] {
  const byNotifId = new Map<number, NotifiableAction>();
  for (const a of actions) byNotifId.set(notificationId(a.id), a);
  const out: WakeRow[] = [];
  for (const n of buildNotifications(actions, nameOf, now)) {
    const a = byNotifId.get(n.id);
    // A row with no conversation has nowhere to stack its history and no
    // shortcut to key on — the moments kinds land here and stay in the
    // plugin's own pre-scheduled path, which is what already handles them.
    if (!a?.convId) continue;
    out.push({
      id: a.id,
      fireAt: n.fireAt,
      title: n.title,
      // Second application of the same gate (belt and braces, as in
      // buildNotifications' own comment): anything not showable is empty.
      body: canPregenerateBody(n.kind) ? n.body : '',
      convId: a.convId,
      route: n.route ?? chatRoute(a.convId),
      tint: (a.contactId ? tintOf(a.contactId) : undefined) ?? FALLBACK_AVATAR_TINT,
    });
  }
  return out;
}

/**
 * Rebuild the OS notification set from the queue. Called on every foreground:
 * whatever was pending was written against a world the user has now moved past.
 *
 * @returns how many the platform actually accepted (0 on web — it cannot
 *          schedule ahead, and saying otherwise would be a lie)
 */
export async function syncNotifications(
  actions: ScheduledAction[],
  contacts: ContactVM[],
  now: number,
  opts: NotifiableOpts = {},
): Promise<number> {
  await cancelAll();
  const nameOf = (id: string) => {
    const c = contacts.find((x) => x.id === id);
    return c ? (c.remark ?? c.name) : undefined;
  };
  const items = buildNotifications(toNotifiable(actions, opts), nameOf, now);
  if (items.length === 0) return 0;
  return scheduleNotifications(items, now);
}
