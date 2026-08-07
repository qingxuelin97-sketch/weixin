/**
 * Seed data for M1 UI development. Realistic enough to calibrate the session list
 * and chat page against real-device screenshots. Replaced by live SQLite in M2.
 * Timestamps are fixed offsets from a stable base so golden screenshots are stable.
 */
import type { ContactVM, ConversationVM, MessageVM } from './types';

// Stable base time (no Date.now) so screenshot goldens never drift.
const BASE = 1_754_500_000_000; // ~2025-08
const min = 60_000;
const hr = 60 * min;

const tint = (c: string) => c;

export const seedContacts: ContactVM[] = [
  { id: 'self', type: 'self', name: '我', avatarColor: tint('#4c6ef5'), avatarText: '我', wxid: 'my_wxid_2024' },
  {
    id: 'ai_lin',
    type: 'ai',
    name: '林小雨',
    remark: '林小雨',
    avatarColor: '#f783ac',
    avatarText: '雨',
    signature: '记得吃饭 🍚',
    pinyinInitial: 'L',
    wxid: 'linxiaoyu',
  },
  {
    id: 'ai_chen',
    type: 'ai',
    name: '陈叔',
    avatarColor: '#3bc9db',
    avatarText: '陈',
    signature: '钓鱼去了',
    pinyinInitial: 'C',
  },
  {
    id: 'ai_ada',
    type: 'ai',
    name: 'Ada',
    avatarColor: '#9775fa',
    avatarText: 'A',
    signature: 'code & coffee',
    pinyinInitial: 'A',
  },
  {
    id: 'ai_mao',
    type: 'ai',
    name: '毛球',
    avatarColor: '#ffa94d',
    avatarText: '毛',
    signature: '喵',
    pinyinInitial: 'M',
  },
];

const c = (id: string) => seedContacts.find((x) => x.id === id)!;

export const seedConversations: ConversationVM[] = [
  {
    id: 'conv_lin',
    type: 'single',
    peerId: 'ai_lin',
    title: '林小雨',
    avatarColor: c('ai_lin').avatarColor,
    avatarText: '雨',
    isPinned: true,
    isMuted: false,
    unreadCount: 2,
    mentionMe: false,
    lastMsgPreview: '那家店我下午去看过啦',
    lastMsgAt: BASE - 3 * min,
  },
  {
    id: 'conv_group',
    type: 'group',
    title: '周末爬山小分队(4)',
    avatarColor: '#74c0fc',
    avatarText: '群',
    memberAvatars: [
      { color: '#f783ac', text: '雨' },
      { color: '#3bc9db', text: '陈' },
      { color: '#9775fa', text: 'A' },
      { color: '#ffa94d', text: '毛' },
    ],
    isPinned: true,
    isMuted: true,
    unreadCount: 12,
    mentionMe: true,
    announcement: '本周六早 7 点山脚集合，记得带水和防晒！',
    lastMsgPreview: 'Ada: [链接] 周六天气看起来不错',
    lastMsgAt: BASE - 20 * min,
  },
  {
    id: 'conv_chen',
    type: 'single',
    peerId: 'ai_chen',
    title: '陈叔',
    avatarColor: c('ai_chen').avatarColor,
    avatarText: '陈',
    isPinned: false,
    isMuted: false,
    unreadCount: 0,
    mentionMe: false,
    lastMsgPreview: '[语音]',
    lastMsgAt: BASE - 2 * hr,
  },
  {
    id: 'conv_ada',
    type: 'single',
    peerId: 'ai_ada',
    title: 'Ada',
    avatarColor: c('ai_ada').avatarColor,
    avatarText: 'A',
    isPinned: false,
    isMuted: false,
    unreadCount: 0,
    mentionMe: false,
    draft: '这个 bug 我觉得',
    lastMsgPreview: '好的，那就明天上线',
    lastMsgAt: BASE - 5 * hr,
  },
  {
    id: 'conv_mao',
    type: 'single',
    peerId: 'ai_mao',
    title: '毛球',
    avatarColor: c('ai_mao').avatarColor,
    avatarText: '毛',
    isPinned: false,
    isMuted: false,
    unreadCount: 0,
    mentionMe: false,
    lastMsgPreview: '喵喵喵',
    lastMsgAt: BASE - 26 * hr,
  },
];

export const seedMessages: Record<string, MessageVM[]> = {
  conv_lin: [
    m(1, 'conv_lin', 'ai_lin', 'text', '在吗', BASE - 40 * min),
    m(2, 'conv_lin', 'ai_lin', 'text', '中午吃了没', BASE - 39 * min),
    m(3, 'conv_lin', 'self', 'text', '刚吃完，你呢', BASE - 38 * min),
    m(4, 'conv_lin', 'ai_lin', 'text', '我也是哈哈', BASE - 38 * min),
    m(5, 'conv_lin', 'ai_lin', 'voice', '', BASE - 30 * min, { durationMs: 4200, played: false }),
    m(6, 'conv_lin', 'self', 'text', '你上次说的那家咖啡店叫啥来着', BASE - 12 * min),
    m(7, 'conv_lin', 'ai_lin', 'rp', '', BASE - 8 * min, { greeting: '请你喝咖啡～', opened: false }),
    m(8, 'conv_lin', 'self', 'transfer', '', BASE - 6 * min, {
      amountFen: 60000,
      status: 'accepted',
      statusText: '已收款',
    }),
    m(9, 'conv_lin', 'ai_lin', 'text', '那家店我下午去看过啦', BASE - 3 * min, {
      quote: '我：你上次说的那家咖啡店叫啥来着',
    }),
    m(10, 'conv_lin', 'ai_lin', 'text', '超好喝，改天带你去', BASE - 3 * min),
  ],
  conv_group: [
    m(20, 'conv_group', 'ai_chen', 'text', '周六天气预报出了，晴', BASE - 55 * min),
    m(21, 'conv_group', 'ai_lin', 'text', '太好了！我把装备都备齐了', BASE - 52 * min),
    m(22, 'conv_group', 'ai_chen', 'rp', '', BASE - 50 * min, {
      greeting: '恭喜发财，大吉大利',
      opened: false,
    }),
    m(23, 'conv_group', 'ai_mao', 'text', '谢谢陈叔！', BASE - 49 * min),
    m(24, 'conv_group', 'ai_mao', 'sticker', '🐱', BASE - 49 * min),
    m(25, 'conv_group', 'self', 'text', '我也抢到了哈哈', BASE - 48 * min),
    m(26, 'conv_group', 'ai_ada', 'text', '@我 记得带充电宝，我上次差点失联', BASE - 20 * min),
  ],
};

function m(
  id: number,
  convId: string,
  senderId: string,
  type: MessageVM['type'],
  content: string,
  createdAt: number,
  meta?: Record<string, unknown>,
): MessageVM {
  return { id, convId, senderId, type, content, createdAt, status: 'sent', ...(meta ? { meta } : {}) };
}
