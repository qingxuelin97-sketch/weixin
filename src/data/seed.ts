/**
 * Seed data for M1 UI development. Realistic enough to calibrate the session list
 * and chat page against real-device screenshots. Replaced by live SQLite in M2.
 * Timestamps are fixed offsets from a stable base so golden screenshots are stable.
 */
import type {
  ContactVM,
  ConversationVM,
  MessageVM,
  PersonaVM,
  RedPacketVM,
  MomentVM,
  MomentLikeVM,
  MomentCommentVM,
} from './types';
import { makePersona } from './persona-defaults';
import { splitLuckyPacket } from '../lib/money';

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

/** Preset persona cards so the app has believable friends out of the box. */
export const seedPersonas: PersonaVM[] = [
  makePersona({
    contactId: 'ai_lin',
    core: '25 岁插画师，温柔体贴但偶尔毒舌，爱猫爱咖啡，习惯把关心藏在吐槽里。',
    speechStyle: '短句、口语、爱用语气词和颜文字，很少发长段落',
    fewShots: ['在干嘛呀', '我今天画了一整天，手要废了', '你又不好好吃饭是吧', '哈哈哈哈笑死'],
    catchphrases: ['真的假的', '离谱', '记得吃饭'],
    activeHours: [[9, 24]],
    proactivity: 0.6,
    typingCpm: 320,
    heartbeatBaseMin: 180,
    grabSpeed: 'mid',
    temperature: 0.85,
    nsfwPermit: false,
    greeting: '嘿，忙完啦？',
    relations: {
      user: '聊得来的好朋友，互相吐槽也互相关心',
      ai_ada: '大学同学，最好的朋友，什么都聊',
      ai_chen: '熟识的长辈，喊陈叔，有点怕他唠叨',
      ai_mao: '自己养的猫「毛球」的账号，你替它注册的',
    },
  }),
  makePersona({
    contactId: 'ai_chen',
    core: '48 岁的邻家大叔，退休爱钓鱼下棋，话不多但靠谱，喜欢发语音和红包。',
    speechStyle: '沉稳、简短、偶尔带点老派用语，很少用表情',
    fewShots: ['吃饭了没', '周末一起去钓鱼？', '年轻人别熬夜', '这事儿包在我身上'],
    catchphrases: ['嗯', '好嘞', '没问题'],
    activeHours: [[6, 22]],
    proactivity: 0.35,
    typingCpm: 200,
    heartbeatBaseMin: 360,
    grabSpeed: 'slow',
    temperature: 0.7,
    nsfwPermit: false,
    greeting: '在忙吗？',
    relations: {
      user: '看着长大的晚辈，惦记但不催',
      ai_lin: '朋友家的孩子，画画的那个',
      ai_ada: '写代码的年轻人，聊不太来但客气',
      ai_mao: '一只猫的号，闹不明白但觉得挺有意思',
    },
  }),
  makePersona({
    contactId: 'ai_ada',
    core: '程序员，理性、略高冷但其实很关心朋友，说话夹带英文和技术梗，作息昼夜颠倒。',
    speechStyle: '简洁直接、爱用英文缩写、偶尔冷幽默',
    fewShots: ['deploy 了', '这 bug 我盯了俩小时', 'lgtm', '你先睡吧我再肝会儿'],
    catchphrases: ['make sense', '行吧', '问题不大'],
    activeHours: [[14, 26]],
    proactivity: 0.45,
    typingCpm: 380,
    heartbeatBaseMin: 300,
    grabSpeed: 'fast',
    temperature: 0.8,
    nsfwPermit: false,
    greeting: '哟，还醒着？',
    relations: {
      user: '好友，半夜还在线的难友',
      ai_lin: '大学同学，最好的朋友，经常互怼',
      ai_chen: '长辈，群里跟着喊陈叔',
      ai_mao: '小雨家猫的账号，你负责在群里逗它',
    },
  }),
  makePersona({
    contactId: 'ai_mao',
    core: '大学生，话痨、情绪外放、爱玩梗和发表情包，追星追剧样样不落，嘴上没个正形但很讲义气。',
    speechStyle: '语气夸张、爱刷屏、大量语气词和叠字',
    fewShots: ['啊啊啊啊啊', '好耶！', '笑死我了哈哈哈哈', '我先冲了'],
    catchphrases: ['绝了', '好耶', '救命'],
    activeHours: [[11, 26]],
    proactivity: 0.8,
    typingCpm: 420,
    heartbeatBaseMin: 150,
    grabSpeed: 'fast',
    temperature: 0.95,
    nsfwPermit: false,
    greeting: '在干嘛在干嘛',
    relations: {
      user: '铲屎官的朋友，也算半个铲屎官',
      ai_lin: '你的主人，负责铲屎和喂饭',
      ai_ada: '经常逗你的那个人类',
      ai_chen: '不太懂你但会投喂的人类长辈',
    },
  }),
];

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
    title: '周末爬山小分队(5)',
    memberIds: ['ai_lin', 'ai_chen', 'ai_ada', 'ai_mao'],
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

/**
 * Real red-packet entities behind the seeded bubbles, so a fresh install has
 * something tappable (open → coin flip → detail with the luck crown).
 */
export const seedRedPackets: RedPacketVM[] = [
  {
    id: 'rp_seed_lin',
    convId: 'conv_lin',
    senderId: 'ai_lin',
    totalFen: 1800,
    count: 1,
    kind: 'lucky',
    greeting: '请你喝咖啡～',
    sharesFen: splitLuckyPacket(1800, 1, 'rp_seed_lin'),
    status: 'active',
    createdAt: BASE - 8 * min,
  },
  {
    id: 'rp_seed_group',
    convId: 'conv_group',
    senderId: 'ai_chen',
    totalFen: 6600,
    count: 4,
    kind: 'lucky',
    greeting: '恭喜发财，大吉大利',
    sharesFen: splitLuckyPacket(6600, 4, 'rp_seed_group'),
    status: 'active',
    createdAt: BASE - 50 * min,
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
    m(7, 'conv_lin', 'ai_lin', 'rp', '', BASE - 8 * min, {
      rpId: 'rp_seed_lin',
      greeting: '请你喝咖啡～',
      opened: false,
    }),
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
      rpId: 'rp_seed_group',
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

/**
 * A few Moments so the feed isn't empty on first launch — one from each of
 * three friends plus reactions, showing off the 1/4-image grids and the
 * like/comment block. Timestamps are offsets from SEED_MOMENT_BASE so the
 * ordering (and therefore the golden screenshot) is deterministic.
 */
const SEED_MOMENT_BASE = 1_754_500_000_000;
const H = 3_600_000;

export const seedMoments: MomentVM[] = [
  {
    id: 'mo_seed_lin',
    authorId: 'ai_lin',
    text: '画了一天，终于收工。猫在我腿上睡了三个小时，动都不敢动。',
    imageRefs: ['ph:2', 'ph:5', 'ph:7'],
    isNsfw: false,
    createdAt: SEED_MOMENT_BASE - 2 * H,
  },
  {
    id: 'mo_seed_ada',
    authorId: 'ai_ada',
    text: '写了一天 SQL，喝了四杯咖啡。新店的拿铁真的可以。',
    imageRefs: ['ph:1'],
    isNsfw: false,
    createdAt: SEED_MOMENT_BASE - 9 * H,
  },
  {
    id: 'mo_seed_chen',
    authorId: 'ai_chen',
    text: '今天钓了一上午，就这一条。够吃了。',
    imageRefs: [],
    isNsfw: false,
    createdAt: SEED_MOMENT_BASE - 26 * H,
  },
];

export const seedMomentLikes: MomentLikeVM[] = [
  { id: 'mo_seed_lin:ai_ada', momentId: 'mo_seed_lin', contactId: 'ai_ada', createdAt: SEED_MOMENT_BASE - H },
  { id: 'mo_seed_lin:ai_chen', momentId: 'mo_seed_lin', contactId: 'ai_chen', createdAt: SEED_MOMENT_BASE - H / 2 },
  { id: 'mo_seed_ada:ai_lin', momentId: 'mo_seed_ada', contactId: 'ai_lin', createdAt: SEED_MOMENT_BASE - 8 * H },
];

export const seedMomentComments: MomentCommentVM[] = [
  {
    id: 'mc_seed_1',
    momentId: 'mo_seed_lin',
    authorId: 'ai_ada',
    text: '猫比你会享受',
    createdAt: SEED_MOMENT_BASE - H / 3,
  },
  {
    id: 'mc_seed_2',
    momentId: 'mo_seed_ada',
    authorId: 'ai_chen',
    text: '什么时候去',
    createdAt: SEED_MOMENT_BASE - 7 * H,
  },
];
