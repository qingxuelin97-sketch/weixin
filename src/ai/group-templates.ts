/**
 * One-tap group presets (M-I1).
 *
 * A template is a STARTING POINT for the generate flow, not a canned group:
 * it fills the brief, size, topics and knobs, and the blueprint call still
 * invents the actual people. Pure data — the UI lists it, the generate page
 * consumes it, nothing here talks to the network.
 */
import type { GroupCfg } from './group-config';

export interface GroupTemplate {
  id: string;
  name: string;
  /** One-line pitch shown under the name. */
  tagline: string;
  /** Seed brief handed to the blueprint call (user can edit before spending). */
  brief: string;
  size: number;
  topics: string[];
  activity: GroupCfg['activity'];
  spice: GroupCfg['spice'];
}

export const GROUP_TEMPLATES: GroupTemplate[] = [
  {
    id: 'besties',
    name: '闺蜜团',
    tagline: '无话不说，也无话可藏',
    brief:
      '四五个认识十年以上的闺蜜，一个毒舌、一个恋爱脑、一个事业狂、一个躺平主义。互相拆台但谁出事第一个到。',
    size: 4,
    topics: ['八卦', '恋爱吐槽', '拼单', '深夜emo'],
    activity: 3,
    spice: 2,
  },
  {
    id: 'classmates',
    name: '老同学',
    tagline: '毕业多年，各奔东西',
    brief:
      '大学宿舍群，毕业五年。有人创业小成、有人考公上岸、有人还在换工作，混得不一样但谁也不服谁。常怀旧，偶尔约饭永远约不成。',
    size: 6,
    topics: ['怀旧', '约饭', '工作吐槽', '房价'],
    activity: 2,
    spice: 2,
  },
  {
    id: 'coworkers',
    name: '同事摸鱼群',
    tagline: '老板不在的那个群',
    brief:
      '同一家公司的小团体群（没有领导）。白天摸鱼吐槽甲方和老板，谁开会谁倒霉，下班约奶茶。说话有分寸但阴阳怪气一流。',
    size: 5,
    topics: ['摸鱼', '吐槽老板', '奶茶拼单', '八卦'],
    activity: 2,
    spice: 2,
  },
  {
    id: 'netfriends',
    name: '网友群',
    tagline: '现实里没见过面',
    brief:
      '因为共同爱好认识的网友群，天南海北，谁也没见过谁。聊得极熟但各自生活成谜，偶尔有人消失几天又若无其事回来。',
    size: 6,
    topics: ['梗图', '追剧', '深夜话题'],
    activity: 2,
    spice: 1,
  },
  {
    id: 'gaming',
    name: '开黑群',
    tagline: '上号！',
    brief:
      '固定开黑的游戏群，技术参差不齐。有大腿、有混子、有指挥。输了互相甩锅，赢了全是自己牛。天天喊上号，真上号的没几个。',
    size: 5,
    topics: ['上号', '版本更新', '甩锅', '战绩'],
    activity: 3,
    spice: 3,
  },
  {
    id: 'family',
    name: '亲戚群',
    tagline: '相亲相爱一家人',
    brief:
      '亲戚群：长辈爱发养生文章和早安表情，表哥表姐们各忙各的偶尔冒泡，过年过节最热闹。有长辈的关心，也有躲不开的催婚催娃。',
    size: 6,
    topics: ['养生', '节日祝福', '家长里短'],
    activity: 1,
    spice: 0,
  },
  {
    id: 'hobby',
    name: '兴趣小组',
    tagline: '为一件事聚在一起',
    brief:
      '周末骑行/爬山/摄影的兴趣小组，组织者热心肠，有装备党、有技术流、有纯凑热闹的。平时冷清，约活动前两天炸出所有人。',
    size: 5,
    topics: ['约活动', '装备', '路线', '晒照'],
    activity: 1,
    spice: 1,
  },
];

export function templateById(id: string): GroupTemplate | undefined {
  return GROUP_TEMPLATES.find((t) => t.id === id);
}
