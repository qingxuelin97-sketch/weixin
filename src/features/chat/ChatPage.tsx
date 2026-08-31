import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import {
  IconBack,
  IconMore,
  IconVoiceCircle,
  IconEmoji,
  IconPlus,
} from '../../components/icons';
import { VoiceInputButton } from './VoiceInput';
import { Avatar } from '../../components/Avatar';
import { Badge } from '../../components/Badge';
import { MessageBubble } from './MessageBubble';
import { ImageViewer } from '../../components/ImageViewer';
import { Sheet } from '../../components/Sheet';
import { LongPressMenu, type LongPressMenuItem } from '../../components/LongPressMenu';
import { useDismissable } from '../../app/useDismissable';
import { registerMedia, listRegisteredMedia } from '../../data/media-registry';
import { useMedia } from '../../components/useMedia';
import { recordUserSticker, agentStickerPool } from '../../ai/sticker-taste';
import { battleReply, stickerStreak } from '../../ai/sticker-battle';
import { totalUnread as totalUnreadOf } from '../../lib/unread';
import { enqueue } from '../../ai/scheduler';
import { captureFlipSource, FLIP_KEYS } from '../../lib/flip';
import { logError } from '../../lib/errlog';
import { ComposerPanels } from './ComposerPanels';
import { useComposerPanel } from './useComposerPanel';
import { storyRunning, applyChoice } from '../../ai/story-service';
import type { StorySaveRow } from '../../ai/story-gm';
import { useAppStore } from '../../store/appStore';
import { showPrompt, showConfirm } from '../../components/dialog';
import { regenerateLastTurn } from '../../ai/engine';
import { useGuard } from '../../app/useGuard';
import { chatTimestamp, shouldShowTimeBar } from '../../lib/time';
import { hasUsableProvider } from '../../llm/service';
import { sendUserMessage, replyToLatest, effectiveTier } from '../../ai/engine';
import { maybeScheduleMemExtract } from '../../ai/memory-service';
import { sendGroupMessage, replyToLatestInGroup } from '../../ai/group-engine';
import { acceptTransfer } from '../../ai/money-service';
import { payBill } from '../../ai/bill-service';
import { BillSheet } from './BillSheet';
import { fenToYuan, seededRng } from '../../lib/money';
import type { GroupMember } from '../../ai/director';
import { repo } from '../../db/repo';
import { renderMessageBody } from '../../ai/render-msg';
import { suggestGroupHref } from '../../ai/agent-invite';
import { canRecall } from '../../lib/recall';
import { gameSeed, rollDice, rollRps, type GameKind } from '../../lib/game';
import type { MessageVM, NsfwTierVM } from '../../data/types';
import { typingRhythm } from '../../lib/typing-rhythm';
import './chat.css';
import '../settings/settings.css';
import { useNow } from '../../lib/useNow';

/**
 * Message types the 收藏 menu item is offered for — exactly the ones
 * `FavoriteBody` (features/favorites/FavoritesPage.tsx) knows how to draw.
 * A guard test keeps the two in step; see tests/unit/i18-contacts-gaps.test.ts.
 */
const FAVORITABLE: readonly MessageVM['type'][] = [
  'text',
  'sticker',
  'image',
  'voice',
  'location',
  'contact_card',
  'file',
  'link',
  'merged',
  'game',
];

export function ChatPage() {
  const guard = useGuard();
  const NOW = useNow();
  const { convId = '' } = useParams();
  const navigate = useNavigate();
  const conv = useAppStore((s) => s.conversationById(convId));
  const messages = useAppStore((s) => s.messagesFor(convId));
  const contactById = useAppStore((s) => s.contactById);
  const personaFor = useAppStore((s) => s.personaFor);
  const appendMessage = useAppStore((s) => s.appendMessage);
  const updateMessage = useAppStore((s) => s.updateMessage);
  const setTyping = useAppStore((s) => s.setTyping);
  const setActiveConv = useAppStore((s) => s.setActiveConv);
  const patchConversation = useAppStore((s) => s.patchConversation);
  const showToast = useAppStore((s) => s.showToast);
  const isTyping = useAppStore((s) => Boolean(s.typing[convId]));

  // 输入抖动 (M-I16 在线感): while she is generating, the indicator breathes —
  // 「输入中…停顿…又输入」 on a seeded rhythm (typingRhythm, 铁律 4) instead of
  // burning solid for the whole round trip. The stepper is a UI timer
  // (presentation only, frozen clocks in screenshots never fire it); every
  // duration comes from the seeded pure function.
  const [typingPaused, setTypingPaused] = useState(false);
  useEffect(() => {
    if (!isTyping) {
      setTypingPaused(false);
      return;
    }
    const lastId = useAppStore.getState().messagesFor(convId).at(-1)?.id ?? 0;
    const beats = typingRhythm(`${convId}:${lastId}`);
    let i = 0;
    let t: ReturnType<typeof setTimeout>;
    const step = () => {
      const b = beats[i % beats.length];
      i++;
      setTypingPaused(!b.on);
      t = setTimeout(step, b.ms);
    };
    step();
    return () => clearTimeout(t);
  }, [isTyping, convId]);
  const typingShown = isTyping && !typingPaused;

  // 已读回执 (M-I16, opt-in): WeChat has none, so this ships OFF and lives
  // behind the `readReceipts` settings KV. Purely a projection of data the
  // read-delay mechanism already produces: your last message counts as read
  // once she has replied after it — or is typing right now (the engine's
  // readDelay elapsed, i.e. she "saw" it).
  const [readReceipts, setReadReceipts] = useState(false);
  useEffect(() => {
    void repo
      .getSetting<boolean>('readReceipts')
      .then((v) => setReadReceipts(Boolean(v)))
      .catch(() => {});
  }, []);
  const readMarkId = useMemo(() => {
    if (!readReceipts) return null;
    let lastSelf: MessageVM | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].senderId === 'self') {
        lastSelf = messages[i];
        break;
      }
    }
    if (!lastSelf || lastSelf.status === 'failed') return null;
    const read =
      isTyping ||
      messages.some(
        (m) => m.senderId !== 'self' && m.type !== 'system' && m.createdAt >= lastSelf!.createdAt,
      );
    return read ? lastSelf.id : null;
  }, [messages, readReceipts, isTyping]);
  // Being *in* this conversation zeroes its badge, so no per-conv exception here.
  const totalUnread = useAppStore((s) => totalUnreadOf(s.conversations));
  const composer = useComposerPanel();
  const [draft, setDraft] = useState('');
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const scrollRef = useRef<HTMLDivElement>(null);

  // Presence: entering clears unread + mentions; leaving parks unsent text as
  // the conversation's draft (route param changes don't remount this component).
  // `hydrated` is a dep so a cold boot straight into a chat still gets both.
  const hydrated = useAppStore((s) => s.hydrated);
  useEffect(() => {
    void setActiveConv(convId);
    setDraft(useAppStore.getState().conversationById(convId)?.draft ?? '');
    return () => {
      void setActiveConv(null);
      const text = draftRef.current.trim() || undefined;
      const cur = useAppStore.getState().conversationById(convId);
      if (cur && (cur.draft || undefined) !== text) void patchConversation(convId, { draft: text });
    };
  }, [convId, hydrated, setActiveConv, patchConversation]);

  // 防呆 (#5/#16): a chat with no usable provider looks "broken" — every send
  // gets the persona refusal line. Say why, and link straight to the fix.
  const [noProvider, setNoProvider] = useState(false);
  useEffect(() => {
    let alive = true;
    void hasUsableProvider()
      .then((ok) => alive && setNoProvider(!ok))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [convId]);

  // Tier of THIS conversation, for the microphone (M-I18). Derived exactly
  // like the send path does it (global setting × this persona's permit), so
  // 铁律 6 covers speech going OUT the same way it covers prompts.
  const [micTier, setMicTier] = useState<'off' | 'ambiguous' | 'full'>('off');
  useEffect(() => {
    let alive = true;
    void (async () => {
      const globalTier = (await repo.getSetting<NsfwTierVM>('nsfwGlobalTier')) ?? 'off';
      const c = useAppStore.getState().conversationById(convId);
      const permit = c?.type === 'single' && c.peerId
        ? (useAppStore.getState().personaFor(c.peerId)?.nsfwPermit ?? false)
        : false;
      if (alive) setMicTier(effectiveTier(globalTier, permit));
    })().catch(() => {});
    return () => {
      alive = false;
    };
  }, [convId, hydrated]);

  /** Long-press context menu: which message, anchored where. */
  const [menu, setMenu] = useState<{ msg: MessageVM; x: number; y: number } | null>(null);
  const [quote, setQuote] = useState<{ msgId: number; text: string } | null>(null);
  const [forwarding, setForwarding] = useState<MessageVM | null>(null);
  // 多选 + 合并转发 (M-I6): selection is a message-id set; the bottom action
  // bar replaces the composer while active, and forwarding N messages builds
  // ONE 'merged' card whose meta carries the copied lines.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  /** 群 @ 选择器 (M-I6): open after the user types '@'. */
  const [atPicker, setAtPicker] = useState(false);
  // 群昵称 (M-I6): per-room aliases from chat info; bubbles show the alias by
  // overlaying it as `remark` on the sender the row renders with.
  const [groupNicks, setGroupNicks] = useState<Record<string, string>>({});
  useEffect(() => {
    if (conv?.type !== 'group') return;
    void repo
      .getSetting<Record<string, string>>(`groupNick:${convId}`)
      .then((n) => setGroupNicks(n ?? {}))
      .catch(() => {});
  }, [convId, conv?.type]);
  const senderFor = (senderId: string) => {
    const c = contactById(senderId);
    const nick = groupNicks[senderId];
    return c && nick ? { ...c, remark: nick } : c;
  };
  const [mergedForward, setMergedForward] = useState<{
    title: string;
    items: Array<{ name: string; body: string; at: number }>;
  } | null>(null);
  const toggleSelect = (id: number) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const exitSelect = () => {
    setSelecting(false);
    setSelected(new Set());
  };
  useDismissable(selecting, exitSelect);
  const beginMergedForward = () => {
    const nameFor = (senderId: string) =>
      senderId === 'self'
        ? '我'
        : (contactById(senderId)?.remark ?? contactById(senderId)?.name ?? senderId);
    const items = messages
      .filter((m) => selected.has(m.id) && !m.isRecalled)
      .sort((a, b) => a.id - b.id)
      .map((m) => ({
        name: nameFor(m.senderId),
        body: renderMessageBody(m, { maxChars: 120 }),
        at: m.createdAt,
      }));
    if (items.length === 0) {
      showToast('先选几条消息');
      return;
    }
    setMergedForward({
      title:
        conv?.type === 'group' ? `群聊「${conv.title}」的聊天记录` : `与${conv?.title}的聊天记录`,
      items,
    });
  };
  const allConversations = useAppStore((s) => s.conversations);
  const deleteMessage = useAppStore((s) => s.deleteMessage);
  const albumInputRef = useRef<HTMLInputElement>(null);

  // Leaving the chat = the conversation went quiet → queue ONE memory
  // extraction if enough new material accumulated (M-D2 loop trigger).
  useEffect(() => {
    return () => {
      const c = useAppStore.getState().conversationById(convId);
      if (c?.type === 'single' && c.peerId) {
        void maybeScheduleMemExtract(convId, c.peerId, Date.now()).catch(() => {});
      } else if (c?.type === 'group' && !c.isHidden) {
        // Groups remember too (M-E4). The subject is the CONVERSATION, not a
        // person: "群里说下周要一起吃饭" belongs to the group, and every member
        // should be able to refer to it. Without this the group had no memory at
        // all — every round started from the last 30 messages and nothing else.
        void maybeScheduleMemExtract(convId, convId, Date.now(), { group: true }).catch(() => {});
      }
    };
  }, [convId]);
  // The message menu's scrim, dismiss-stack registration and "any further
  // interaction closes it" behaviour all moved into <LongPressMenu/> (I18) —
  // where the chat list gets exactly the same three, instead of its own.
  useDismissable(composer.mode === 'emoji' || composer.mode === 'plus', composer.closeAll);

  /**
   * Re-send a message whose delivery failed.
   *
   * Reuses the existing row (`updateMessage`) instead of appending a new one:
   * a fresh append would take a new autoincrement id and land the retry AFTER
   * everything that arrived meanwhile, breaking "rowid order == time order"
   * for the reader. The generation path is the normal one, so its in-flight
   * table still guards against two replies racing if you tap twice.
   */
  const retrySend = async (msg: MessageVM) => {
    const c = useAppStore.getState().conversationById(convId);
    if (!c || msg.status !== 'failed') return;
    await updateMessage({ ...msg, status: 'sent' });
    const globalTier = (await repo.getSetting<NsfwTierVM>('nsfwGlobalTier')) ?? 'off';
    const hooks = { appendMessage, updateMessage, setTyping, now: () => Date.now() };
    try {
      if (c.type === 'group') {
        const members: GroupMember[] = (c.memberIds ?? []).map((id) => {
          const ct = contactById(id);
          return { contactId: id, name: ct?.remark ?? ct?.name ?? id, persona: personaFor(id) };
        });
        await replyToLatestInGroup(c, members, globalTier, hooks, contactById);
        return;
      }
      const peer = c.peerId ? contactById(c.peerId) : undefined;
      const persona = c.peerId ? personaFor(c.peerId) : undefined;
      if (peer && persona) await replyToLatest(convId, peer, persona, globalTier, hooks);
    } catch (e) {
      logError('chat.retry', e);
    }
  };

  const recallOwn = async (msg: MessageVM) => {
    setMenu(null);
    if (!canRecall(msg, Date.now())) return;
    await updateMessage({ ...msg, isRecalled: true });
  };
  const copyText = (msg: MessageVM) => {
    setMenu(null);
    if (msg.content) void navigator.clipboard?.writeText(msg.content).catch(() => {});
  };

  /**
   * 重新生成 (M-E6). An AI going out of character is a certainty, not an edge
   * case, and until now there was no way to correct it in the moment — the
   * options were live with it or delete the conversation. A bad line left
   * standing also poisons every later turn, since it stays in the context.
   */
  const regenerate = async (steer?: string) => {
    setMenu(null);
    const c = useAppStore.getState().conversationById(convId);
    const peerId = c?.peerId;
    if (!peerId) return;
    const peerC = contactById(peerId);
    const persona = useAppStore.getState().personaFor(peerId);
    if (!peerC || !persona) return;
    const tier = (await repo.getSetting<NsfwTierVM>('nsfwGlobalTier')) ?? 'off';
    await regenerateLastTurn(
      convId,
      peerC,
      persona,
      tier,
      {
        appendMessage,
        updateMessage,
        setTyping,
        now: () => Date.now(),
        deleteMessage,
      },
      steer,
    );
  };

  // Interleave time bars (WeChat shows a centered time when the gap > 5 min).
  const rows = useMemo(() => withTimeBars(messages), [messages]);

  // Photo messages resolve through the lazy media registry (M-G1): ask for the
  // blobs this transcript actually shows, and re-render when they land.
  // Custom stickers (M-I15) are `idb:` refs too, so they prime the same way.
  useMedia(
    useMemo(
      () =>
        messages
          .filter(
            (m) =>
              m.type === 'image' ||
              (m.type === 'sticker' && m.content?.startsWith('idb:')),
          )
          .map((m) => m.content),
      [messages],
    ),
  );

  // 我的表情 (M-I15): the composer strip's custom stickers. Primed only while
  // the emoji panel is open — the strip is the one place they all draw at once.
  const customStickers = listRegisteredMedia('sticker');
  useMedia(
    useMemo(
      () => (composer.mode === 'emoji' ? customStickers.map((s) => `idb:${s.id}`) : []),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [composer.mode, customStickers.length],
    ),
  );

  // Keep the view pinned to the newest message as bubbles arrive — but not
  // when the growth came from loading OLDER messages, which prepends.
  const pinToBottom = useRef(true);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pinToBottom.current) {
      pinToBottom.current = true;
      return;
    }
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows.length, isTyping, composer.bottomInset]);

  /**
   * Re-anchor when the CONTENT grows without the message count changing.
   *
   * The effect above fires on `rows.length`, which misses everything that
   * changes height after the fact: a photo finishing its lazy load, an emoji
   * falling back to a font that arrives late, a bubble rewrapping. Each of
   * those pushes the newest message below the fold and leaves it there — the
   * view was anchored to a height that no longer exists.
   *
   * Only re-anchors when the reader is already ~at the bottom, so it can never
   * yank someone who has scrolled up to read history.
   */
  useEffect(() => {
    const el = scrollRef.current;
    const inner = listRef.current;
    if (!el || !inner || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [convId]);

  // Older history, on demand (M-G2). Hydration holds a flat 200 per
  // conversation and everything before that was unreachable — in the database,
  // invisible to both scrolling and search.
  const loadOlderMessages = useAppStore((s) => s.loadOlderMessages);
  const openConversation = useAppStore((s) => s.openConversation);

  // Threads are fetched on open, not at startup (M-G2). `threadReady` is a
  // real readiness signal rather than test scaffolding: the page now paints
  // before its messages exist, so anything that needs to observe the settled
  // thread — the golden screenshots, and a future scroll-restore — has to be
  // able to tell "still loading" from "loaded and empty".
  const threadReady = useAppStore((s) => s.hasThread(convId));
  useEffect(() => {
    void openConversation(convId).catch((e) => logError('chat.open', e));
  }, [convId, openConversation]);
  const [atTop, setAtTop] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadOlder = async () => {
    const el = scrollRef.current;
    if (!el || loadingOlder || atTop) return;
    setLoadingOlder(true);
    // Anchor on the distance from the BOTTOM: prepending changes scrollHeight,
    // and restoring scrollTop directly would jump the reader to a random spot.
    const fromBottom = el.scrollHeight - el.scrollTop;
    pinToBottom.current = false;
    try {
      const n = await loadOlderMessages(convId);
      if (n === 0) setAtTop(true);
      requestAnimationFrame(() => {
        const cur = scrollRef.current;
        if (cur) cur.scrollTop = cur.scrollHeight - fromBottom;
      });
    } finally {
      setLoadingOlder(false);
    }
  };

  // 搜索命中锚定 (M-I6): `?at=<msgId>` — a search hit lands here, pages history
  // in until the target row exists, scrolls it to center and flashes it once.
  // Keyed so re-renders don't re-run the jump, but a NEW hit in the same
  // conversation does.
  const [searchParams, setSearchParams] = useSearchParams();
  const atParam = searchParams.get('at');
  // Nonce (M-J0): a quote tap on the SAME message twice must re-anchor, so the
  // jump key includes it — without it the anchoredKey guard eats the second tap.
  const atNonce = searchParams.get('n') ?? '';
  const [flashId, setFlashId] = useState<number | null>(null);
  const anchoredKey = useRef<string | null>(null);
  useEffect(() => {
    const at = atParam ? Number(atParam) : NaN;
    if (!Number.isFinite(at) || !threadReady) return;
    const key = `${convId}:${at}:${atNonce}`;
    if (anchoredKey.current === key) return;
    anchoredKey.current = key;
    let alive = true;
    void (async () => {
      // Page older history in until the target is present. Two stop rules
      // besides success: the top of history, and an oldest-loaded row already
      // older than the target — that means the message was deleted, and paging
      // further would walk the whole thread for nothing.
      for (let guard = 0; guard < 40; guard++) {
        const list = useAppStore.getState().messagesFor(convId);
        if (list.some((m) => m.id === at)) break;
        if (list.length && list[0].id <= at) return;
        pinToBottom.current = false;
        const n = await loadOlderMessages(convId, 200);
        if (!alive || n === 0) return;
      }
      if (!alive) return;
      pinToBottom.current = false;
      requestAnimationFrame(() => {
        const el = scrollRef.current?.querySelector(`[data-msg-id="${at}"]`);
        if (el) {
          (el as HTMLElement).scrollIntoView({ block: 'center' });
          setFlashId(at);
        }
      });
    })().catch((e) => logError('chat.anchor', e));
    return () => {
      alive = false;
    };
  }, [convId, atParam, atNonce, threadReady, loadOlderMessages]);

  // Quote tap (M-J0): jump to the quoted message through the SAME ?at= anchor
  // path the search hits use — one jump implementation, not two.
  const onQuoteTap = (quotedId: number) => {
    setSearchParams({ at: String(quotedId), n: String(Date.now()) }, { replace: true });
  };

  // Is a story playing here? Re-checked as the transcript grows, which is also
  // when a run ends or pauses. Never throws into the page: an unreadable save
  // row means "no banner", not a blank chat.
  const [story, setStory] = useState<StorySaveRow | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void storyRunning(convId)
      .then((s) => {
        if (alive) setStory(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [convId, rows.length]);

  // 剧情抉择 (V4): the run is parked on a player decision — the bottom option
  // bar is how it moves again. The tap lands the vars, jumps the graph and
  // re-opens the tick chain; the「选择」line arrives through the store's own
  // appendMessage, which re-triggers the story refresh above.
  const [choosing, setChoosing] = useState(false);
  const pickChoice = async (index: number) => {
    if (!story || choosing) return;
    setChoosing(true);
    try {
      const updated = await applyChoice(story.id, index, Date.now(), { appendMessage });
      if (updated) setStory(updated);
    } catch (e) {
      logError('story.choice', e);
    } finally {
      setChoosing(false);
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || !conv) return;
    setDraft('');
    const globalTier = (await repo.getSetting<NsfwTierVM>('nsfwGlobalTier')) ?? 'off';
    const hooks = { appendMessage, updateMessage, setTyping, now: () => Date.now() };

    // Built BEFORE the group branch. It used to live after it, so replying with
    // a quote in a group silently dropped the quote AND never ran
    // `setQuote(null)` — the quote chip then stayed wedged in the composer for
    // the rest of the session. The quote menu item has no `isGroup` guard, so
    // this was a fully reachable path, just a broken one.
    // quoteId rides along (M-J0): the schema reserved reply_to_id since M1 but
    // nothing ever wrote it — the collected msgId evaporated right here, which
    // is why quote bubbles could never jump back to their source.
    const quoteMeta = quote ? { quote: quote.text, quoteId: quote.msgId } : undefined;
    setQuote(null);

    // Group: the director stages a cast; single: one persona replies.
    if (conv.type === 'group') {
      const members: GroupMember[] = (conv.memberIds ?? []).map((id) => {
        const c = contactById(id);
        return { contactId: id, name: c?.remark ?? c?.name ?? id, persona: personaFor(id) };
      });
      await sendGroupMessage(conv, text, members, globalTier, hooks, contactById, quoteMeta);
      return;
    }

    const peerId = conv.peerId;
    const peer = peerId ? contactById(peerId) : undefined;
    const persona = peerId ? personaFor(peerId) : undefined;

    if (!peer || !persona) {
      // No persona card configured yet — record the user's message rather than drop it.
      await appendMessage({
        convId,
        senderId: 'self',
        type: 'text',
        content: text,
        status: 'sent',
        createdAt: Date.now(),
      });
      return;
    }

    await sendUserMessage(convId, text, peer, persona, globalTier, hooks, quoteMeta);
  };

  /**
   * Ask the AI side to react to whatever is now newest in the thread —
   * shared by every "user sent something that isn't text" path (photos,
   * games, locations). One round for the whole batch.
   */
  const askReply = async () => {
    const c = useAppStore.getState().conversationById(convId);
    if (!c) return;
    const globalTier = (await repo.getSetting<NsfwTierVM>('nsfwGlobalTier')) ?? 'off';
    const hooks = { appendMessage, updateMessage, setTyping, now: () => Date.now() };
    if (c.type === 'group') {
      const members: GroupMember[] = (c.memberIds ?? []).map((id) => {
        const ct = contactById(id);
        return { contactId: id, name: ct?.remark ?? ct?.name ?? id, persona: personaFor(id) };
      });
      await replyToLatestInGroup(c, members, globalTier, hooks, contactById);
      return;
    }
    const peer = c.peerId ? contactById(c.peerId) : undefined;
    const persona = c.peerId ? personaFor(c.peerId) : undefined;
    if (peer && persona) await replyToLatest(convId, peer, persona, globalTier, hooks);
  };

  /**
   * 表情游戏 (M-I13): send a dice / 猜拳 throw. The result is rolled ONCE,
   * seeded from (convId, createdAt) — rule #4 — and stored in meta, so the
   * face on screen, the projection the model reads, and any future replay
   * all agree. She then gets a normal turn to react to it (接梗).
   */
  const sendGame = async (kind: GameKind) => {
    if (!conv) return;
    composer.closeAll();
    const at = Date.now();
    const result =
      kind === 'dice' ? rollDice(gameSeed(convId, at, 'self')) : rollRps(gameSeed(convId, at, 'self'));
    await appendMessage({
      convId,
      senderId: 'self',
      type: 'game',
      content: '',
      meta: { game: kind, result },
      status: 'sent',
      createdAt: at,
    });
    await askReply();
  };

  /** 位置 (M-I13): the + panel's map card — a place name is all it takes. */
  const sendLocation = async (raw: string) => {
    if (!conv) return;
    const [name, address] = raw.split(/\||｜/).map((s) => s.trim());
    await appendMessage({
      convId,
      senderId: 'self',
      type: 'location',
      content: name.slice(0, 40),
      meta: { name: name.slice(0, 40), ...(address ? { address: address.slice(0, 80) } : {}) },
      status: 'sent',
      createdAt: Date.now(),
    });
    await askReply();
  };

  /**
   * 收藏 (M-I13): snapshot a message into the favorites store. A snapshot —
   * not a reference — so the favorite survives the message (or the whole
   * thread) being deleted, exactly like WeChat. Idempotent by id.
   */
  const favoriteMsg = async (m: MessageVM) => {
    setMenu(null);
    const senderName =
      m.senderId === 'self'
        ? '我'
        : (senderFor(m.senderId)?.remark ?? contactById(m.senderId)?.name ?? '');
    try {
      await repo.putFavorite({
        id: `fav_${m.convId}_${m.id}`,
        msgId: m.id,
        convId: m.convId,
        senderId: m.senderId,
        senderName,
        convTitle: conv?.title ?? '',
        type: m.type,
        content: m.content,
        ...(m.meta ? { meta: { ...m.meta } } : {}),
        createdAt: m.createdAt,
        favedAt: Date.now(),
      });
      showToast('已收藏');
    } catch (e) {
      logError('chat.favorite', e);
      showToast('收藏失败');
    }
  };

  /**
   * 发表情 (M-I15): a custom sticker from「我的表情」sends immediately as a
   * sticker message. Then the 斗图 gate rolls — seeded on the persisted row id
   * (constitution #4) — and on a hit she answers with a sticker of her own,
   * zero LLM cost, after a human "finding the right one" delay. A miss falls
   * through to the ordinary reply path, so a sticker still gets answered in
   * words. Her sticker choice prefers ones she has "collected" from you
   * (sticker-taste), which is what closes the loop of the whole feature.
   */
  const sendSticker = async (ref: string) => {
    if (!conv) return;
    const saved = await appendMessage({
      convId,
      senderId: 'self',
      type: 'sticker',
      content: ref,
      status: 'sent',
      createdAt: Date.now(),
    });
    // Taste ledger: only SENT stickers are collectible. Fire-and-forget.
    void recordUserSticker(ref).catch(() => {});

    const globalTier = (await repo.getSetting<NsfwTierVM>('nsfwGlobalTier')) ?? 'off';
    const hooks = { appendMessage, updateMessage, setTyping, now: () => Date.now() };

    if (conv.type === 'single' && conv.peerId) {
      const peer = contactById(conv.peerId);
      const persona = personaFor(conv.peerId);
      if (!peer || !persona) return;
      const tail = useAppStore.getState().messagesFor(convId);
      const streak = stickerStreak(tail.map((m) => m.type));
      const pool = await agentStickerPool(conv.peerId).catch(() => [] as string[]);
      // 表情使用率 (M-I18) rides in from the persona: 高冷的人设 barely joins a
      // sticker war, 话痨爱斗图的 almost always does.
      const reply = battleReply(
        { seed: `${convId}:${saved.id}`, streak, rate: persona.stickerRate },
        pool,
        ref,
      );
      if (reply) {
        // A wordless round: the sticker IS the reply. Deliberately NOT routed
        // through the engine — no prompt, no tokens, no typing indicator; just
        // the beat of someone scrolling for the right card.
        //
        // The BEAT rides scheduled_actions (铁律 5), not a setTimeout. This
        // produces a real message, so a bare timer was a second time-evolution
        // path with the usual consequence: back out of the chat inside those
        // 0.8–2.5s and the reply evaporated, while `stickerStreak` had already
        // counted the round. The decision above is seeded and complete, so the
        // queued row carries the finished move and can land whenever the queue
        // next drains. `sticker_reply` is a FAST_KIND — the beat is the point.
        const fireAt = Date.now() + reply.delayMs;
        await enqueue({
          kind: 'sticker_reply',
          fireAt,
          payload: { convId, contactId: peer.id, content: reply.content, at: fireAt },
          now: Date.now(),
          id: `stkbattle_${convId}_${saved.id}`,
        });
        return;
      }
      await replyToLatest(convId, peer, persona, globalTier, hooks);
      return;
    }
    if (conv.type === 'group') {
      const members: GroupMember[] = (conv.memberIds ?? []).map((id) => {
        const c = contactById(id);
        return { contactId: id, name: c?.remark ?? c?.name ?? id, persona: personaFor(id) };
      });
      // 群斗图 (M-J2): the battle was single-chat-only, which is backwards —
      // a group is where sticker wars actually happen. Same seeded, zero-LLM
      // decision as the single branch; a few members "reach for their phone"
      // in seeded order and the first hit posts the comeback. A miss falls
      // through to the ordinary director round, so the sticker still lands
      // an answer in words.
      const tail = useAppStore.getState().messagesFor(convId);
      const streak = stickerStreak(tail.map((m) => m.type));
      const order = [...members]
        .filter((m) => m.persona)
        .sort(
          (a, b) =>
            seededRng(`gbattle:${convId}:${saved.id}:${a.contactId}`)() -
            seededRng(`gbattle:${convId}:${saved.id}:${b.contactId}`)(),
        )
        .slice(0, 3);
      for (const m of order) {
        const pool = await agentStickerPool(m.contactId).catch(() => [] as string[]);
        const reply = battleReply(
          { seed: `${convId}:${saved.id}:${m.contactId}`, streak, rate: m.persona?.stickerRate },
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
            id: `stkbattle_${convId}_${saved.id}`,
          });
          return;
        }
      }
      await replyToLatestInGroup(conv, members, globalTier, hooks, contactById);
    }
  };

  /**
   * 相册发图：system file picker → import into the media library (photo pool,
   * 标签"聊天") → send as an image message whose content is the `idb:` ref.
   * Persisting through the library (not a one-off blob) keeps a single media
   * path — the ref survives backup/restore like every other ref.
   */
  const sendImages = async (files: FileList | null) => {
    if (!files?.length || !conv) return;
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) continue;
      const item = {
        id: crypto.randomUUID(),
        kind: 'photo' as const,
        tags: ['聊天'],
        mime: f.type,
        blob: f as Blob,
        createdAt: Date.now(),
      };
      await repo.putMedia(item);
      registerMedia(item.id, { url: URL.createObjectURL(f), kind: 'photo', tags: item.tags });
      await appendMessage({
        convId,
        senderId: 'self',
        type: 'image',
        content: `idb:${item.id}`,
        // The library tags travel with the message so the projection layer has
        // SOMETHING to say about the photo even when vision is off or the
        // model cannot see. `meta.tags` had a rendering branch since M-E1 and
        // no writer at all, which is why every picture read as "[发了一张图片]".
        meta: { tags: item.tags },
        status: 'sent',
        createdAt: Date.now(),
      });
    }

    // …and then actually ask for a reply. Until M-H0 this function stopped at
    // the line above, so **sending a photo never started a generation** — she
    // simply never answered a picture. One reply for the whole batch, after
    // every file is persisted, so sending three photos is one turn not three.
    const globalTier = (await repo.getSetting<NsfwTierVM>('nsfwGlobalTier')) ?? 'off';
    const hooks = { appendMessage, updateMessage, setTyping, now: () => Date.now() };
    if (conv.type === 'group') {
      const members: GroupMember[] = (conv.memberIds ?? []).map((id) => {
        const c = contactById(id);
        return { contactId: id, name: c?.remark ?? c?.name ?? id, persona: personaFor(id) };
      });
      await replyToLatestInGroup(conv, members, globalTier, hooks, contactById);
      return;
    }
    const peer = conv.peerId ? contactById(conv.peerId) : undefined;
    const persona = conv.peerId ? personaFor(conv.peerId) : undefined;
    if (peer && persona) {
      await replyToLatest(convId, peer, persona, globalTier, hooks);
    }
  };

  /**
   * Ordered image refs + a per-message position map. The map (not indexOf on
   * the ref) picks the viewer's start: two messages can legitimately share one
   * ref (re-sent library photo), and indexOf would open at the first one.
   */
  const { imageRefs, imageIndexByMsgId } = useMemo(() => {
    const refs: string[] = [];
    const byId = new Map<number, number>();
    for (const r of rows) {
      if (r.kind === 'time') continue;
      const m = (r as { msg: MessageVM }).msg;
      if (m.type !== 'image' || m.isRecalled || !m.content) continue;
      byId.set(m.id, refs.length);
      refs.push(m.content);
    }
    return { imageRefs: refs, imageIndexByMsgId: byId };
  }, [rows]);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const onImageTap = (msg: MessageVM, el: HTMLElement | null) => {
    // Hand the tapped bubble's rect to the viewer so the photo grows out of it
    // (M-I8, lib/flip.ts). Captured here, at the tap, because the thread keeps
    // scrolling between this and the viewer's first layout.
    captureFlipSource(FLIP_KEYS.imageViewer, el);
    setViewerIndex(imageIndexByMsgId.get(msg.id) ?? 0);
  };

  /** 发起群收款 sheet (M-J8) — opened from the + panel in group chats. */
  const [billSheetOpen, setBillSheetOpen] = useState(false);

  /**
   * 群收款卡片 tap (M-J8): if the USER owes an unpaid share, confirm and pay —
   * wallet debit + settlement through the same `payBill` the queue uses.
   * Already-paid (or not a participant) → the card is informational.
   */
  const onBillTap = (msg: MessageVM) => {
    const billId = msg.meta?.billId as string | undefined;
    if (!billId) return;
    const parts = Array.isArray(msg.meta?.parts)
      ? (msg.meta!.parts as Array<{ id?: string; oweFen?: number }>)
      : [];
    const mine = parts.find((p) => p.id === 'self');
    const paidIds = Array.isArray(msg.meta?.paidIds) ? (msg.meta!.paidIds as string[]) : [];
    if (!mine || typeof mine.oweFen !== 'number' || paidIds.includes('self')) return;
    const initiator = contactById(msg.senderId);
    void showConfirm({
      title: '确认支付',
      body: `向${initiator?.remark ?? initiator?.name ?? '发起人'}支付 ${fenToYuan(mine.oweFen)} 元（${(msg.meta?.title as string) || '群收款'}）？`,
      confirmText: '支付',
      cancelText: '取消',
    }).then((ok) => {
      if (!ok) return;
      void payBill(billId, convId, 'self', {
        appendMessage,
        updateMessage,
        now: () => Date.now(),
      }).catch((e) => {
        logError('bill.pay', e);
        showToast('支付失败，请重试');
      });
    });
  };

  /** Red packet → open/detail; a pending transfer from the peer → accept it. */
  const onMoneyTap = (msg: MessageVM) => {
    if (msg.type === 'rp') {
      const rpId = msg.meta?.rpId as string | undefined;
      if (rpId) navigate(`/rp/open/${rpId}`);
      return;
    }
    if (msg.type === 'transfer') {
      const transferId = msg.meta?.transferId as string | undefined;
      const status = msg.meta?.status as string | undefined;
      if (transferId && status === 'pending' && msg.senderId !== 'self') {
        void acceptTransfer(transferId, {
          appendMessage,
          updateMessage,
          now: () => Date.now(),
        });
      }
    }
  };

  // A hidden conversation renders EXACTLY like a missing one (M-I18).
  //
  // Hidden AI↔AI DMs were filtered everywhere they could be listed — the chat
  // list, search, favorites, notifications, the widget — but never at the one
  // surface that renders a thread from a raw id in the URL. `/chat/dm_a_b` is
  // reachable: the deep-link allowlist passes `^/chat/[^/]+$` by design (it is
  // a pure parser with no store access), so any app on the device firing
  // `aiwx://chat/dm_ai_ada_ai_lin` — or the user simply typing the hash route —
  // used to render the entire private thread between two agents.
  //
  // Guarding HERE and not in the parser is deliberate: this is the choke point
  // every entry path funnels through (deep link, widget tap, notification tap,
  // manual URL, an anchored search jump), so one check covers all of them.
  // Saying "会话不存在" rather than "不可查看" matters too — acknowledging that
  // the thread exists is itself the tell.
  if (!conv || conv.isHidden) {
    return (
      <div className="chat-page">
        <div className="chat-page__missing">会话不存在</div>
      </div>
    );
  }

  const isGroup = conv.type === 'group';
  const peerContact = conv.peerId ? contactById(conv.peerId) : undefined;

  /**
   * The long-press capsule's contents for one message.
   *
   * A list rather than conditional JSX since I18: the menu itself is now
   * <LongPressMenu/> (shared with the chat list), so what stays here is only
   * WHICH actions this message affords — which is the part that is genuinely
   * message-specific. Closing is the menu's job; these handlers no longer have
   * to remember to do it.
   */
  const msgMenuItems = (m: MessageVM): LongPressMenuItem[] => {
    const items: LongPressMenuItem[] = [];
    const isText = m.type === 'text' && Boolean(m.content);
    if (isText) items.push({ label: '复制', onSelect: () => copyText(m) });
    if (canRecall(m, Date.now())) items.push({ label: '撤回', onSelect: () => void recallOwn(m) });
    if (isText && !m.isRecalled) {
      items.push({
        label: '引用',
        onSelect: () => {
          const who =
            m.senderId === 'self'
              ? '我'
              : (contactById(m.senderId)?.remark ?? contactById(m.senderId)?.name ?? '');
          setQuote({ msgId: m.id, text: `${who}: ${(m.content ?? '').slice(0, 40)}` });
        },
      });
    }
    // Only on the AI's own last turn: regenerating anything else would rewrite
    // history rather than correct the newest line.
    if (
      m.senderId !== 'self' &&
      !isGroup &&
      !m.isRecalled &&
      messages.at(-1)?.senderId === m.senderId
    ) {
      items.push({
        label: '重新生成',
        onSelect: () => guard('chat.regenerate', () => regenerate()),
      });
      items.push({
        label: '让她重说',
        onSelect: () => {
          void showPrompt({
            title: '让她重说',
            placeholder: '例：别这么客套 / 短一点',
          }).then((steer) => {
            if (steer?.trim()) guard('chat.steer', () => regenerate(steer.trim()));
          });
        },
      });
    }
    if (
      ['text', 'image', 'sticker', 'location', 'file', 'link', 'contact_card'].includes(m.type) &&
      !m.isRecalled
    ) {
      items.push({ label: '转发', onSelect: () => setForwarding(m) });
    }
    // 收藏 is offered for everything the FAVORITES PAGE can actually render.
    // Real WeChat does not offer it on a red packet, a transfer or a call
    // record either — they are ledger events, not content — so the narrower
    // gate is also the more faithful one. Without it, favouriting a 红包 filed
    // a row whose only renderer is the `default` branch, and the favorites
    // page printed the internal enum: 「[rp]」 (M-I18). The long-press menu was
    // deliberately widened in I18 to open for every type; the second renderer
    // never grew to match, and nothing connected the two.
    if (FAVORITABLE.includes(m.type) && !m.isRecalled) {
      items.push({ label: '收藏', onSelect: () => void favoriteMsg(m) });
    }
    // 转文字 lives HERE, not on double-click (M-J0): WeChat muscle memory is
    // long-press → 转文字, and the old onDoubleClick was undiscoverable on a
    // phone. The reveal persists in meta so it survives re-renders and reloads.
    if (m.type === 'voice' && !m.isRecalled) {
      items.push({
        label: m.meta?.voiceTextShown ? '收起转写' : '转文字',
        onSelect: () =>
          void updateMessage({
            ...m,
            meta: { ...m.meta, voiceTextShown: !m.meta?.voiceTextShown },
          }),
      });
    }
    items.push({
      label: '多选',
      onSelect: () => {
        setSelecting(true);
        setSelected(new Set([m.id]));
      },
    });
    items.push({
      label: '删除',
      onSelect: () => void deleteMessage(convId, m.id).catch(() => showToast('删除失败')),
    });
    return items;
  };

  return (
    <div className="chat-page" onClick={() => composer.mode !== 'none' && composer.closeAll()}>
      <header className="navbar chat-nav">
        <div className="navbar__left">
          <button className="navbar__btn chat-nav__back" aria-label="返回" onClick={() => navigate(-1)}>
            <IconBack />
            <Badge className="chat-nav__unread" count={totalUnread} />
          </button>
        </div>
        <div className="navbar__title chat-nav__title">
          {typingShown ? '对方正在输入…' : conv.title}
        </div>
        <div className="navbar__right">
          <button className="navbar__btn" aria-label="更多" onClick={() => navigate(`/chat/${convId}/info`)}>
            <IconMore />
          </button>
        </div>
      </header>

      {noProvider && (
        <div
          className="chat-banner hairline-bottom"
          role="button"
          onClick={(e) => {
            e.stopPropagation();
            navigate('/settings/api');
          }}
        >
          未配置 API key，对方无法回复 · 点此去配置 ›
        </div>
      )}

      {isGroup && conv.announcement && (
        <div className="group-announce hairline-bottom" onClick={(e) => e.stopPropagation()}>
          <span className="group-announce__icon" aria-hidden>
            💬
          </span>
          <span className="group-announce__text">{conv.announcement}</span>
        </div>
      )}

      {/* A story playing in this conversation (M-G0). `storyRunning` shipped in
          M-E5 describing itself as "used to gate the UI" and had zero callers,
          so the only sign a story was running was grey narration in the
          transcript — and a story that STOPPED looked exactly like one that had
          simply gone quiet. */}
      {story && (
        <div className="group-announce hairline-bottom" onClick={(e) => e.stopPropagation()}>
          <span className="group-announce__icon" aria-hidden>
            {story.stalledAt ? '⏸' : '🎬'}
          </span>
          <span className="group-announce__text">
            {story.stalledAt
              ? '剧情已暂停——多次生成失败，去剧情页可以继续'
              : story.pendingChoice
                ? '剧情正在等你的选择（见下方选项）'
                : '剧情进行中'}
          </span>
          <button
            className="group-announce__action"
            // Straight to THIS run's dashboard (M-I7) — the banner's job is
            // "something is happening here", and the run page is where 继续/
            // 回滚/存档 all live now, not the library list.
            onClick={() => navigate(`/story/run/${story.id}`)}
          >
            {story.stalledAt ? '去处理' : '查看'}
          </button>
        </div>
      )}

      <div
        ref={scrollRef}
        data-thread-ready={threadReady ? '1' : '0'}
        onScroll={(e) => {
          if (e.currentTarget.scrollTop <= 8) void loadOlder();
        }}
        className="chat-page__scroll"
        style={{ paddingBottom: composer.bottomInset }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="chat-page__messages" ref={listRef}>
          {/* Top-of-history affordance. Silent when there is nothing more:
              WeChat shows no marker at the start of a thread either. */}
          {loadingOlder && <div className="chat-page__older">正在加载更早的消息…</div>}
          {rows.map((row) =>
            row.kind === 'time' ? (
              <div className="msg-time" key={`t${row.ts}`}>
                {chatTimestamp(row.ts, NOW)}
              </div>
            ) : (
              <div
                key={row.msg.id}
                data-msg-id={row.msg.id}
                className={
                  [selecting && 'msg-selectable', flashId === row.msg.id && 'msg-anchor-flash']
                    .filter(Boolean)
                    .join(' ') || undefined
                }
                onAnimationEnd={
                  flashId === row.msg.id
                    ? // Child animations (bubble entrances) bubble up too — only
                      // the flash itself may clear the flag.
                      (e) => e.animationName === 'msg-anchor-flash' && setFlashId(null)
                    : undefined
                }
                onClickCapture={
                  selecting
                    ? (e) => {
                        // Selection swallows every inner tap — a checkbox mode
                        // that still opens red packets is a trap.
                        e.stopPropagation();
                        if (row.msg.type !== 'system' && !row.msg.isRecalled)
                          toggleSelect(row.msg.id);
                      }
                    : undefined
                }
              >
                {selecting && row.msg.type !== 'system' && !row.msg.isRecalled && (
                  <span
                    className={`msg-select-dot${selected.has(row.msg.id) ? ' msg-select-dot--on' : ''}`}
                    aria-hidden
                  />
                )}
                <MessageBubble
                  msg={row.msg}
                  sender={senderFor(row.msg.senderId)}
                  isSelf={row.msg.senderId === 'self'}
                  showNickname={isGroup}
                  onMoneyTap={onMoneyTap}
                  onBillTap={onBillTap}
                  onImageTap={onImageTap}
                  onMergedTap={(m) => navigate(`/merged/${convId}/${m.id}`)}
                  onQuoteTap={onQuoteTap}
                  onContactTap={(m) => {
                    const cid = m.meta?.contactId as string | undefined;
                    if (cid && contactById(cid)) navigate(`/contact/${cid}`);
                    else showToast('该联系人已不存在');
                  }}
                  nameOf={(cid) => {
                    const c = contactById(cid);
                    return c ? (c.remark ?? c.name) : undefined;
                  }}
                  // 拉群提议 (M-I3): hand the roster to 发起群聊 pre-ticked. The
                  // AI proposes; the group is only born when the USER taps 完成
                  // on that screen — so this navigates, it never creates a room.
                  onSuggestGroupTap={(_m, memberIds) => {
                    const alive = memberIds.filter((id) => contactById(id));
                    if (alive.length < 2) {
                      showToast('提议里的好友已不存在');
                      return;
                    }
                    navigate(suggestGroupHref(alive));
                  }}
                  onLongPress={(m, x, y) => {
                    if (selecting) return;
                    // Openable on anything that is still a message (M-I18).
                    //
                    // This gate predates I6/I13 and still asked the I5-era
                    // question: is there COPY, RECALL or REGENERATE to offer?
                    // Meanwhile the menu grew 收藏 / 转发 / 多选, which apply to
                    // every type — so long-pressing a photo, a voice clip, a
                    // location, a link or a card did nothing at all, and so did
                    // long-pressing your own message three minutes after
                    // sending it. "Press and nothing happens" reads as a broken
                    // gesture, not a missing feature; it is also why six of the
                    // favorites page's eight type filters could never fill up.
                    if (m.type !== 'system' && !m.isRecalled) setMenu({ msg: m, x, y });
                  }}
                  onReEdit={(m) => setDraft(m.content ?? '')}
                  onRetry={(m) => guard('chat.retry', () => retrySend(m))}
                  readMark={!isGroup && row.msg.id === readMarkId}
                />
              </div>
            ),
          )}
          {typingShown && !isGroup && (
            <div className="msg-row msg--enter" aria-label="对方正在输入">
              <div className="msg-row__avatar">
                <Avatar
                  color={peerContact?.avatarColor ?? 'var(--color-brand)'}
                  text={peerContact?.avatarText ?? '?'}
                  imageRef={peerContact?.avatarRef}
                  size={40}
                />
              </div>
              <div className="msg-row__col">
                <div className="msg-row__body">
                  <div className="bubble bubble--other typing-bubble">
                    <span className="typing-bubble__dot" />
                    <span className="typing-bubble__dot" />
                    <span className="typing-bubble__dot" />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {menu && (
        <LongPressMenu
          at={{ x: menu.x, y: menu.y }}
          label="消息操作"
          onClose={() => setMenu(null)}
          items={msgMenuItems(menu.msg)}
        />
      )}

      {atPicker && conv.type === 'group' && (
        <Sheet open onClose={() => setAtPicker(false)} title="提醒谁看">
          {(conv.memberIds ?? [])
            .map((id) => contactById(id))
            .filter((c): c is NonNullable<typeof c> => Boolean(c))
            .map((c) => (
              <div
                key={c.id}
                className="settings__row settings__row--divided"
                onClick={() => {
                  const name = c.remark ?? c.name;
                  // The '@' that summoned the picker is already in the draft.
                  setDraft((d) => `${d}${name} `);
                  setAtPicker(false);
                  composer.inputRef.current?.focus();
                }}
              >
                <span className="settings__label">{c.remark ?? c.name}</span>
              </div>
            ))}
        </Sheet>
      )}

      {(forwarding || mergedForward) && (
        <Sheet
          open
          onClose={() => {
            setForwarding(null);
            setMergedForward(null);
          }}
          title="发送给"
        >
          {allConversations
            .filter((c) => !c.isHidden && c.id !== convId)
            .map((c) => (
              <div
                key={c.id}
                className="settings__row settings__row--divided"
                onClick={() => {
                  const m = forwarding;
                  const merged = mergedForward;
                  setForwarding(null);
                  setMergedForward(null);
                  if (merged) {
                    void appendMessage({
                      convId: c.id,
                      senderId: 'self',
                      type: 'merged',
                      content: merged.title,
                      meta: { title: merged.title, items: merged.items },
                      status: 'sent',
                      createdAt: Date.now(),
                    }).then(() => {
                      showToast(`已转发给 ${c.title}`);
                      exitSelect();
                    });
                    return;
                  }
                  if (!m) return;
                  void appendMessage({
                    convId: c.id,
                    senderId: 'self',
                    type: m.type,
                    content: m.content,
                    ...(m.meta ? { meta: { ...m.meta } } : {}),
                    status: 'sent',
                    createdAt: Date.now(),
                  }).then(() => showToast(`已转发给 ${c.title}`));
                }}
              >
                <span className="settings__label">{c.title}</span>
              </div>
            ))}
        </Sheet>
      )}

      {selecting && (
        <div className="select-bar" onClick={(e) => e.stopPropagation()}>
          <button
            className="select-bar__action"
            disabled={selected.size === 0}
            onClick={beginMergedForward}
          >
            合并转发（{selected.size}）
          </button>
          <button className="select-bar__cancel" onClick={exitSelect}>
            取消
          </button>
        </div>
      )}

      {/* 剧情抉择条 (V4): the play is waiting on the person holding the phone.
          Sits above the composer so they can still talk in-scene while they
          think — the story only moves when they tap. */}
      {story?.pendingChoice && !selecting && (
        <div className="story-choice" onClick={(e) => e.stopPropagation()}>
          <div className="story-choice__prompt">{story.pendingChoice.prompt}</div>
          <div className="story-choice__options">
            {story.pendingChoice.options.map((o, i) => (
              <button
                key={`${i}-${o.label}`}
                className="story-choice__opt"
                disabled={choosing}
                onClick={() => void pickChoice(i)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div
        className="composer"
        style={{
          paddingBottom: composer.mode === 'none' ? 'var(--safe-bottom)' : 0,
          ...(selecting ? { display: 'none' } : {}),
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {quote && (
          <div className="composer__quote">
            <span className="composer__quote-text">{quote.text}</span>
            <button className="composer__quote-x" aria-label="取消引用" onClick={() => setQuote(null)}>
              ×
            </button>
          </div>
        )}
        <div className="composer__bar">
          <button className="composer__icon" aria-label="语音" onClick={() => showToast('语音消息暂未开放')}>
            <IconVoiceCircle />
          </button>
          <div className="composer__pill">
            <textarea
              ref={composer.inputRef}
              className="composer__input"
              rows={1}
              value={draft}
              onChange={(e) => {
                const next = e.target.value;
                // 群 @ 选择器 (M-I6): typing '@' in a group summons the member
                // picker. Inserted as `@名字 ` — exactly what the director's
                // findMentions matches, so a mention is a REAL summons.
                if (isGroup && next.length > draft.length && next.endsWith('@')) {
                  setAtPicker(true);
                }
                setDraft(next);
              }}
              onFocus={composer.openKeyboard}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send().catch((err) => showToast(`发送失败：${err instanceof Error ? err.message : String(err)}`));
                }
              }}
              placeholder=""
            />
            <VoiceInputButton tier={micTier} onText={(t) => setDraft((d) => (d ? d + t : t))} />
          </div>
          <button className="composer__icon" aria-label="表情" onClick={composer.toggleEmoji}>
            <IconEmoji />
          </button>
          {draft.trim() ? (
            <button className="composer__send btn-morph-in" onClick={() => void send().catch((err) => showToast(`发送失败：${err instanceof Error ? err.message : String(err)}`))}>
              发送
            </button>
          ) : (
            <button className="composer__icon" aria-label="更多" onClick={composer.togglePlus}>
              <IconPlus />
            </button>
          )}
        </div>
        <ComposerPanels
          mode={composer.mode}
          height={composer.panelHeight}
          // WeChat has no group transfer either — greyed, not hidden. 群收款
          // is the mirror image (M-J8): a bill needs a room to split across.
          disabledKeys={isGroup ? ['transfer'] : ['groupbill']}
          onAction={(key) => {
            if (key === 'redpacket') navigate(`/rp/send/${convId}`);
            else if (key === 'transfer' && conv.type === 'single') navigate(`/transfer/${convId}`);
            else if (key === 'groupbill' && isGroup) {
              composer.closeAll();
              setBillSheetOpen(true);
            }
            else if (key === 'call' && conv.type === 'single') navigate(`/call/${convId}`);
            else if (key === 'album') albumInputRef.current?.click();
            else if (key === 'location') {
              composer.closeAll();
              void showPrompt({
                title: '发送位置',
                placeholder: '地名，如：星巴克(中山公园店)',
              }).then((name) => {
                if (name?.trim())
                  void sendLocation(name.trim()).catch((err) => logError('chat.location', err));
              });
            } else if (key === 'fav') navigate('/favorites');
            else showToast('暂未开放');
          }}
          onEmoji={(e) => setDraft((d) => d + e)}
          onEmojiDelete={() => setDraft((d) => Array.from(d).slice(0, -1).join(''))}
          onGame={(kind) => void sendGame(kind).catch((err) => logError('chat.game', err))}
          stickers={customStickers}
          onSticker={(ref) =>
            void sendSticker(ref).catch((err) =>
              showToast(`发送失败：${err instanceof Error ? err.message : String(err)}`),
            )
          }
          onManageStickers={() => navigate('/settings/media')}
        />
        <input
          ref={albumInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void sendImages(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      {viewerIndex != null && imageRefs.length > 0 && (
        <ImageViewer refs={imageRefs} index={viewerIndex} onClose={() => setViewerIndex(null)} />
      )}
      {isGroup && (
        <BillSheet convId={convId} open={billSheetOpen} onClose={() => setBillSheetOpen(false)} />
      )}
    </div>
  );
}

type Row = { kind: 'time'; ts: number } | { kind: 'msg'; msg: MessageVM };

function withTimeBars(messages: MessageVM[]): Row[] {
  const rows: Row[] = [];
  let prevTs: number | null = null;
  for (const msg of messages) {
    if (shouldShowTimeBar(prevTs, msg.createdAt)) rows.push({ kind: 'time', ts: msg.createdAt });
    rows.push({ kind: 'msg', msg });
    prevTs = msg.createdAt;
  }
  return rows;
}
