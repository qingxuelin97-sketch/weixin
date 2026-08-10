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

export const BUILTIN_SCRIPTS: Script[] = [RAINY_NIGHT, WEEKEND_PLAN];
