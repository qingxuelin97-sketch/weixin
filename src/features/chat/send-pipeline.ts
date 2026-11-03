/**
 * 聊天页的发送管线 (M-K11)：「她怎么回」的全部编排。
 *
 * 单聊/群聊发送、回复最新一条、重新生成、斗图、离开时的记忆抽取、翻译、话筒档位
 * ——凡是要碰引擎（单聊 engine / 群聊 director / 记忆 / 翻译）的路径都住在这里。
 *
 * **为什么单独一个模块、而且只许懒加载**：引擎树（prompt 分层、记忆、导演、二十几个
 * 指令模块）以前经 ChatPage 的静态 import 整棵进了冷启动主包，而 App 从打开到会话
 * 列表一个字都不会生成。ChatPage 现在只 `import()` 这个文件，并在进聊天页时预取——
 * 第一次发送时它早已就绪。守卫：`tests/unit/k11-chat-split.test.ts`（ChatPage 对这里
 * 与引擎都没有静态导入）。
 *
 * 状态一律在**调用时**从 store 现读（`useAppStore.getState()`），不吃渲染时的闭包。
 * 原来的 askReply / retrySend 本来就是这么写的；requestReplyToLatest 用渲染时的 conv，
 * 发图途中会话被改名/改成员时会拿到旧值——三条尾巴现在是同一个 `replyToNewest`。
 */
import { useAppStore } from '../../store/appStore';
import { repo } from '../../db/repo';
import { sendUserMessage, replyToLatest, regenerateLastTurn, effectiveTier } from '../../ai/engine';
import { sendGroupMessage, replyToLatestInGroup } from '../../ai/group-engine';
import type { GroupMember } from '../../ai/director';
import { maybeScheduleMemExtract } from '../../ai/memory-service';
import { translateText } from '../../ai/translate';
import { battleReply, stickerStreak } from '../../ai/sticker-battle';
import { agentStickerPool } from '../../ai/sticker-taste';
import { enqueue } from '../../ai/scheduler';
import { tierOfConversation } from '../../lib/nsfw-tier';
import { seededRng } from '../../lib/money';
import type { ConversationVM, NsfwTierVM } from '../../data/types';

type QuoteMeta = { quote: string; quoteId: number };

const globalTierSetting = async (): Promise<NsfwTierVM> =>
  (await repo.getSetting<NsfwTierVM>('nsfwGlobalTier')) ?? 'off';

/** The engine's write-back hooks, bound to the store's own actions. */
function hooks() {
  const s = useAppStore.getState();
  return {
    appendMessage: s.appendMessage,
    updateMessage: s.updateMessage,
    setTyping: s.setTyping,
    now: () => Date.now(),
  };
}

/** A group's cast as the director wants it: remark wins over name. */
function membersOf(conv: ConversationVM): GroupMember[] {
  const s = useAppStore.getState();
  return (conv.memberIds ?? []).map((id) => {
    const c = s.contactById(id);
    return { contactId: id, name: c?.remark ?? c?.name ?? id, persona: s.personaFor(id) };
  });
}

/**
 * Send what the user typed. Group: the director stages a cast; single: one
 * persona replies.
 *
 * The quote rides into BOTH branches. It used to be built after the group
 * branch had already returned, so quoting in a group dropped the quote and
 * wedged the chip in the composer (chat-ops W1). The page now builds it and
 * clears the chip before calling here; this function's job is to pass it on.
 */
export async function sendText(convId: string, text: string, quoteMeta?: QuoteMeta): Promise<void> {
  const s = useAppStore.getState();
  const conv = s.conversationById(convId);
  if (!conv) return;
  const tier = await globalTierSetting();
  if (conv.type === 'group') {
    await sendGroupMessage(conv, text, membersOf(conv), tier, hooks(), s.contactById, quoteMeta);
    return;
  }
  const peer = conv.peerId ? s.contactById(conv.peerId) : undefined;
  const persona = conv.peerId ? s.personaFor(conv.peerId) : undefined;
  if (!peer || !persona) {
    // No persona card configured yet — record the user's message rather than drop it.
    await s.appendMessage({
      convId,
      senderId: 'self',
      type: 'text',
      content: text,
      status: 'sent',
      createdAt: Date.now(),
    });
    return;
  }
  await sendUserMessage(convId, text, peer, persona, tier, hooks(), quoteMeta);
}

/**
 * She answers whatever is now newest in the thread — the shared tail of every
 * "user sent something that isn't typed text" path (photos, voice clips,
 * games, locations, cards, files) and of a retried send. One round for the
 * whole batch: three photos are one turn, not three.
 */
export async function replyToNewest(convId: string): Promise<void> {
  const s = useAppStore.getState();
  const conv = s.conversationById(convId);
  if (!conv) return;
  const tier = await globalTierSetting();
  if (conv.type === 'group') {
    await replyToLatestInGroup(conv, membersOf(conv), tier, hooks(), s.contactById);
    return;
  }
  const peer = conv.peerId ? s.contactById(conv.peerId) : undefined;
  const persona = conv.peerId ? s.personaFor(conv.peerId) : undefined;
  if (peer && persona) await replyToLatest(convId, peer, persona, tier, hooks());
}

/**
 * 重新生成 / 让她重说 (M-E6): replace her last turn, optionally steered. Only
 * single chats — the page only offers it on the AI's own newest turn there.
 */
export async function regenerate(convId: string, steer?: string): Promise<void> {
  const s = useAppStore.getState();
  const peerId = s.conversationById(convId)?.peerId;
  if (!peerId) return;
  const peer = s.contactById(peerId);
  const persona = s.personaFor(peerId);
  if (!peer || !persona) return;
  const tier = await globalTierSetting();
  await regenerateLastTurn(
    convId,
    peer,
    persona,
    tier,
    { ...hooks(), deleteMessage: s.deleteMessage },
    steer,
  );
}

/**
 * 斗图 (M-I15 single, M-J2 group): the user's sticker has landed as row
 * `savedId`; roll the seeded gate (constitution #4) and on a hit queue a
 * wordless comeback, else fall through to an ordinary reply so the sticker
 * still gets answered in words.
 *
 * The comeback's BEAT rides scheduled_actions (铁律 5), not a setTimeout: it
 * produces a real message, and a bare timer was a second time-evolution path —
 * back out of the chat inside those 0.8–2.5s and the reply evaporated while
 * `stickerStreak` had already counted the round. The decision here is seeded
 * and complete, so the queued row carries the finished move. `sticker_reply`
 * is a FAST_KIND — the beat is the point.
 */
export async function stickerRound(convId: string, savedId: number, ref: string): Promise<void> {
  const s = useAppStore.getState();
  const conv = s.conversationById(convId);
  if (!conv) return;
  const tail = s.messagesFor(convId);
  const streak = stickerStreak(tail.map((m) => m.type));

  if (conv.type === 'single' && conv.peerId) {
    const peer = s.contactById(conv.peerId);
    const persona = s.personaFor(conv.peerId);
    if (!peer || !persona) return;
    const pool = await agentStickerPool(conv.peerId).catch(() => [] as string[]);
    // 表情使用率 (M-I18) rides in from the persona: 高冷的人设 barely joins a
    // sticker war, 话痨爱斗图的 almost always does.
    const reply = battleReply({ seed: `${convId}:${savedId}`, streak, rate: persona.stickerRate }, pool, ref);
    if (reply) {
      const fireAt = Date.now() + reply.delayMs;
      await enqueue({
        kind: 'sticker_reply',
        fireAt,
        payload: { convId, contactId: peer.id, content: reply.content, at: fireAt },
        now: Date.now(),
        id: `stkbattle_${convId}_${savedId}`,
      });
      return;
    }
    await replyToLatest(convId, peer, persona, await globalTierSetting(), hooks());
    return;
  }

  if (conv.type === 'group') {
    const members = membersOf(conv);
    // 群斗图 (M-J2): a group is where sticker wars actually happen. Same
    // seeded, zero-LLM decision as the single branch; a few members "reach for
    // their phone" in seeded order and the first hit posts the comeback.
    const order = [...members]
      .filter((m) => m.persona)
      .sort(
        (a, b) =>
          seededRng(`gbattle:${convId}:${savedId}:${a.contactId}`)() -
          seededRng(`gbattle:${convId}:${savedId}:${b.contactId}`)(),
      )
      .slice(0, 3);
    for (const m of order) {
      const pool = await agentStickerPool(m.contactId).catch(() => [] as string[]);
      const reply = battleReply(
        { seed: `${convId}:${savedId}:${m.contactId}`, streak, rate: m.persona?.stickerRate },
        pool,
        ref,
      );
      if (reply) {
        const fireAt = Date.now() + reply.delayMs;
        await enqueue({
          kind: 'sticker_reply',
          fireAt,
          payload: { convId, contactId: m.contactId, content: reply.content, at: fireAt },
          now: Date.now(),
          id: `stkbattle_${convId}_${savedId}`,
        });
        return;
      }
    }
    await replyToLatestInGroup(conv, members, await globalTierSetting(), hooks(), s.contactById);
  }
}

/**
 * Leaving the chat = the conversation went quiet → queue ONE memory extraction
 * if enough new material accumulated (M-D2 loop trigger).
 *
 * Groups remember too (M-E4). The subject is the CONVERSATION, not a person:
 * 「群里说下周要一起吃饭」belongs to the group, and every member should be able
 * to refer to it — and a group demands more material per round (the flag).
 */
export async function memExtractOnLeave(convId: string): Promise<void> {
  const c = useAppStore.getState().conversationById(convId);
  if (c?.type === 'single' && c.peerId) {
    await maybeScheduleMemExtract(convId, c.peerId, Date.now());
  } else if (c?.type === 'group' && !c.isHidden) {
    await maybeScheduleMemExtract(convId, convId, Date.now(), { group: true });
  }
}

/**
 * 翻译 (M-J7). 铁律 6: the message body IS conversation content, so the tier is
 * always DERIVED from who is in the room — never made up at the call site.
 */
export async function translateMessage(convId: string, text: string): Promise<string | null> {
  const s = useAppStore.getState();
  const conv = s.conversationById(convId);
  const memberIds =
    conv?.type === 'group' ? (conv.memberIds ?? []) : conv?.peerId ? [conv.peerId] : [];
  const tier = await tierOfConversation(memberIds, s.personaFor).catch(() => 'off' as const);
  const out = await translateText(text, tier, convId);
  return out || null;
}

/**
 * Tier of THIS conversation, for the microphone (M-I18). Derived exactly like
 * the send path does it (global setting × this persona's permit), so 铁律 6
 * covers speech going OUT the same way it covers prompts.
 */
export async function micTierFor(convId: string): Promise<'off' | 'ambiguous' | 'full'> {
  const s = useAppStore.getState();
  const global = await globalTierSetting();
  const c = s.conversationById(convId);
  const permit = c?.type === 'single' && c.peerId ? (s.personaFor(c.peerId)?.nsfwPermit ?? false) : false;
  return effectiveTier(global, permit);
}
