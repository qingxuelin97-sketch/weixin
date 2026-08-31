/**
 * Built-in example scripts (M-E5).
 *
 * One of the three script sources. Their real job is to be a WORKING REFERENCE:
 * "write me a story" produces JSON, and the fastest way to see what good JSON
 * looks like — locally valid, with earned branches and reachable endings — is to
 * read one that already plays. They are seeded on first run and re-seeded on
 * upgrade (origin 'builtin'), so a user who deletes one can get it back.
 */
import type { Script } from './story-script';

/**
 * A two-hander with a real branch: whether the visitor is let in at all
 * depends on a variable the conversation moves, and both endings are reachable.
 * Deliberately SFW (nsfwLevel 0) — the shipped examples must be playable at
 * every setting, including the default.
 */
const RAINY_NIGHT: Script = {
  scriptId: 'builtin_rainy_night',
  title: '雨夜来客',
  genre: '悬疑',
  nsfwLevel: 0,
  cast: [
    { charId: 'host', role: '房东', secret: '你其实认识来访者，但装作不认识' },
    { charId: 'visitor', role: '深夜访客', secret: '你是来确认某件旧事的' },
  ],
  vars: { trust: 0, opened_door: false },
  entry: 'knock',
  nodes: [
    {
      id: 'knock',
      goal: '门外有人敲门，房东要决定开不开',
      onEnter: { narrate: '雨下得很大。有人在敲门。', scene: '深夜，老房子的门口' },
      directives: [
        {
          charId: 'host',
          instruction: '你被敲门声吵醒，隔着门问对方是谁，语气警惕',
          forbid: '不要立刻开门，也不要承认你认识对方',
        },
        {
          charId: 'visitor',
          instruction: '解释你为什么这么晚来，但不要一次说完',
          reveal: '你只说你是来找人的',
        },
      ],
      triggers: [
        {
          when: 'expr:vars.trust >= 2',
          to: 'inside',
          effects: { vars: { opened_door: true } },
        },
      ],
      timeout: { turns: 8, to: 'turned_away' },
    },
    {
      id: 'inside',
      goal: '两人隔着一张桌子，旧事被慢慢摊开',
      onEnter: { narrate: '门开了。屋里只有一盏灯。' },
      directives: [
        {
          charId: 'host',
          instruction: '倒了杯水，试探对方到底知道多少',
          reveal: '可以承认你觉得对方眼熟',
        },
        { charId: 'visitor', instruction: '把你来的真正原因说出来一半' },
      ],
      triggers: [
        {
          when: 'llm:两人都承认了他们其实认识',
          to: 'recognized',
          effects: {
            vars: { trust: 5 },
            memWrite: [{ charId: 'host', fact: '那个雨夜的访客，其实是旧识' }],
          },
        },
      ],
      timeout: { turns: 10, to: 'recognized' },
    },
    {
      id: 'recognized',
      goal: '收束：认出彼此之后，各自决定要不要说破',
      directives: [
        { charId: 'host', instruction: '说一句你憋了很久的话，然后结束这次谈话' },
      ],
      triggers: [],
      ending: true,
    },
    {
      id: 'turned_away',
      goal: '收束：门始终没开，访客在雨里离开',
      onEnter: { narrate: '敲门声停了。窗外只剩雨声。' },
      directives: [{ charId: 'host', instruction: '隔着门说最后一句话' }],
      triggers: [],
      ending: true,
    },
  ],
};

/**
 * A light, low-stakes one — the example for "I just want a scene, not a plot".
 * No secrets, no branch on suspicion; the variable tracks whether they actually
 * decided anything, which is the whole joke.
 */
const WEEKEND_PLAN: Script = {
  scriptId: 'builtin_weekend',
  title: '周末去哪',
  genre: '日常',
  nsfwLevel: 0,
  cast: [
    { charId: 'a', role: '提议的人' },
    { charId: 'b', role: '什么都行的人', secret: '你其实只想待在家' },
  ],
  vars: { decided: false, rounds: 0 },
  entry: 'start',
  nodes: [
    {
      id: 'start',
      goal: '两个人试图决定周末干什么，但谁都不肯先定',
      onEnter: { narrate: '周五晚上。' },
      directives: [
        { charId: 'a', instruction: '提一个具体的去处，语气积极' },
        {
          charId: 'b',
          instruction: '不反对也不答应，把球踢回去',
          forbid: '不要直接说你想待在家',
        },
      ],
      triggers: [
        { when: 'expr:vars.decided == true', to: 'settled' },
        { when: 'llm:其中一个人明确表示不想出门', to: 'stay_home' },
      ],
      timeout: { turns: 8, to: 'stay_home' },
    },
    {
      id: 'settled',
      goal: '收束：真的定下来了',
      directives: [{ charId: 'a', instruction: '确认时间地点，收尾' }],
      triggers: [],
      ending: true,
    },
    {
      id: 'stay_home',
      goal: '收束：谁也没出门',
      onEnter: { narrate: '最后谁也没动。' },
      directives: [{ charId: 'b', instruction: '心满意足地提议点外卖' }],
      triggers: [],
      ending: true,
    },
  ],
};

/**
 * The V3 showcase (M-I7): three roles, a real diamond, three endings, and a
 * legal cycle-with-exit — the smallest script on which every new surface has
 * something to do. The casting sheet has three parts to hand out (two carry
 * secrets), the branch graph draws a fork AND a loop, the 结局画廊 starts at
 * 0/3, and a second 周目 down the other fork is the intended way to play it.
 */
const OLD_FRIENDS: Script = {
  scriptId: 'builtin_reunion',
  title: '同学会前夜',
  genre: '群像',
  nsfwLevel: 0,
  cast: [
    { charId: 'organizer', role: '张罗的人', secret: '你办同学会是为了见一个人' },
    { charId: 'reluctant', role: '不想去的人', secret: '你欠了当年班长一笔没还的钱' },
    { charId: 'peacemaker', role: '和事佬' },
  ],
  vars: { momentum: 0, debt_out: false, quarrel: false },
  entry: 'propose',
  nodes: [
    {
      id: 'propose',
      goal: '有人提议办同学会，另一个人在推脱',
      onEnter: { narrate: '毕业十年，群里突然有人冒了个泡。' },
      directives: [
        { charId: 'organizer', instruction: '热情张罗，定日子定地方，语气不容拒绝' },
        {
          charId: 'reluctant',
          instruction: '找各种理由推脱，但别把话说死',
          forbid: '不要说出你真正不想去的原因',
        },
        { charId: 'peacemaker', instruction: '两边打圆场，顺便回忆一件当年的趣事' },
      ],
      triggers: [
        { when: 'llm:不想去的人松口答应了', to: 'planning', effects: { vars: { momentum: 1 } } },
      ],
      timeout: { turns: 8, to: 'fizzle' },
    },
    {
      id: 'planning',
      goal: '定细节的过程中旧事被翻出来',
      onEnter: { narrate: '日子定下了。可话越聊越深。' },
      directives: [
        { charId: 'organizer', instruction: '状似无意地打听当年那个人的近况' },
        { charId: 'reluctant', instruction: '被问到当年的事，开始闪烁其词' },
        { charId: 'peacemaker', instruction: '察觉气氛不对，试着岔开话题' },
      ],
      triggers: [
        // The reconciliation effect (below) sets momentum to 5, so a group
        // that has already quarreled and made up sails straight through here —
        // the expr track reading a var an earlier effect wrote.
        { when: 'expr:vars.momentum >= 5', to: 'reunion_eve' },
        {
          when: 'llm:欠钱的事被说破了',
          to: 'quarrel',
          effects: { vars: { debt_out: true, quarrel: true } },
        },
      ],
      timeout: { turns: 10, to: 'reunion_eve' },
    },
    {
      id: 'quarrel',
      goal: '翻旧账，谁也不肯先低头',
      onEnter: { narrate: '有些账，十年利息比本金重。' },
      directives: [
        { charId: 'reluctant', instruction: '恼羞成怒，说出这些年不来往的真正委屈' },
        { charId: 'organizer', instruction: '话赶话说重了，但心里已经后悔' },
        { charId: 'peacemaker', instruction: '硬把两人的话往回拉，提当年互相帮过的事' },
      ],
      triggers: [
        // Back edge: a patched-up quarrel returns to planning — the legal
        // cycle-with-exit the validator allows and the graph draws as an arc.
        // momentum 5 is what fast-tracks the second visit to planning.
        {
          when: 'llm:两个人都服软了',
          to: 'planning',
          effects: { vars: { quarrel: false, momentum: 5 } },
        },
        { when: 'llm:彻底撕破脸，有人退群或说出绝交的话', to: 'blowup' },
      ],
      timeout: { turns: 8, to: 'blowup' },
    },
    {
      id: 'reunion_eve',
      goal: '收束：前夜，各怀心事地道晚安',
      onEnter: { narrate: '明晚见。谁都没把最想说的那句发出去。' },
      directives: [
        { charId: 'organizer', instruction: '发一条正式的集合通知，末尾带一句只有你自己懂的话' },
      ],
      triggers: [],
      ending: true,
    },
    {
      id: 'blowup',
      goal: '收束：同学会没办成，群安静了下去',
      onEnter: { narrate: '那个周末，谁也没再说话。' },
      directives: [{ charId: 'peacemaker', instruction: '发最后一条消息，给以后留一扇门' }],
      triggers: [],
      ending: true,
    },
    {
      id: 'fizzle',
      goal: '收束：提议无疾而终',
      onEnter: { narrate: '话题就这么沉下去了，像从来没人提过。' },
      directives: [{ charId: 'organizer', instruction: '自嘲一句，把这页翻过去' }],
      triggers: [],
      ending: true,
    },
  ],
};

export const BUILTIN_SCRIPTS: Script[] = [RAINY_NIGHT, WEEKEND_PLAN, OLD_FRIENDS];
