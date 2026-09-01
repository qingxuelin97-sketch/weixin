/**
 * @ 提及的解析 (M-J7).
 *
 * 这份文件真正在守的是一条**不变量**：切出来的片段拼回去必须一字不差等于原文。
 * 「高亮功能把消息吃掉半句」是这类改造最典型的翻车方式，而且极难在肉眼走查里
 * 发现——少的那半句本来就不在你的注意范围内。所以下面每组用例都顺手断言一次
 * 往返相等，最后还有一条随机串的属性测试专门管它。
 */
import { describe, it, expect } from 'vitest';
import { splitMentions, hasMention, MENTION_ALL, type Mentionable } from '../../src/lib/mention';

const people: Mentionable[] = [
  { id: 'self', name: '我' },
  { id: 'ai_a', name: '小雨' },
  { id: 'ai_b', name: '小雨儿' },
  { id: 'ai_c', name: '阿甲' },
];

/** 拼回去必须等于原文——每条用例都过一遍。 */
const roundTrips = (text: string, list: Mentionable[] = people) =>
  splitMentions(text, list)
    .map((s) => s.text)
    .join('') === text;

describe('splitMentions', () => {
  it('认出名单里的人，并给出可跳转的 id', () => {
    const segs = splitMentions('@小雨 在吗', people);
    expect(segs[0]).toEqual({ kind: 'mention', text: '@小雨', id: 'ai_a' });
    expect(segs[1]).toEqual({ kind: 'text', text: ' 在吗' });
    expect(roundTrips('@小雨 在吗')).toBe(true);
  });

  /**
   * 中文没有词边界，这是不用正则的全部理由。「@ 后面到空格为止」的写法在这句
   * 上会把整句都当成人名，于是整条消息变成一个点了跳错地方的蓝色链接。
   */
  it('没有空格分隔也能正确断句', () => {
    const segs = splitMentions('@小雨我们走吧', people);
    expect(segs).toEqual([
      { kind: 'mention', text: '@小雨', id: 'ai_a' },
      { kind: 'text', text: '我们走吧' },
    ]);
    expect(roundTrips('@小雨我们走吧')).toBe(true);
  });

  it('最长优先：@小雨儿 整个命中长名字，不切出残字', () => {
    const segs = splitMentions('@小雨儿 你好', people);
    expect(segs[0]).toEqual({ kind: 'mention', text: '@小雨儿', id: 'ai_b' });
    // 短名字先匹配的话这里会剩一个孤零零的「儿」。
    expect(segs[1]).toEqual({ kind: 'text', text: ' 你好' });
    expect(roundTrips('@小雨儿 你好')).toBe(true);
  });

  it('@ 一个不在群里的名字就是普通文字（不做点了没反应的假链接）', () => {
    const segs = splitMentions('@张三 你好', people);
    expect(segs).toEqual([{ kind: 'text', text: '@张三 你好' }]);
    expect(hasMention('@张三 你好', people)).toBe(false);
  });

  it('@所有人 高亮但没有 id——没有一个人的资料页可以打开', () => {
    const segs = splitMentions(`@${MENTION_ALL} 明天集合`, people);
    expect(segs[0]).toEqual({ kind: 'mention', text: '@所有人', id: '' });
    expect(roundTrips(`@${MENTION_ALL} 明天集合`)).toBe(true);
  });

  it('一句话里多个 @ 全部认出来', () => {
    const t = '@小雨 和 @阿甲 都来一下';
    const segs = splitMentions(t, people);
    expect(segs.filter((s) => s.kind === 'mention').map((s) => s.text)).toEqual(['@小雨', '@阿甲']);
    expect(roundTrips(t)).toBe(true);
  });

  it('连续两个 @ 之间不吞字', () => {
    const t = '@小雨@阿甲';
    expect(splitMentions(t, people)).toEqual([
      { kind: 'mention', text: '@小雨', id: 'ai_a' },
      { kind: 'mention', text: '@阿甲', id: 'ai_c' },
    ]);
    expect(roundTrips(t)).toBe(true);
  });

  it('孤零零一个 @、以及结尾的 @，都当普通字符', () => {
    expect(splitMentions('@', people)).toEqual([{ kind: 'text', text: '@' }]);
    expect(splitMentions('邮箱 a@b 行吗', people)).toEqual([
      { kind: 'text', text: '邮箱 a@b 行吗' },
    ]);
    expect(splitMentions('说完了 @', people)).toEqual([{ kind: 'text', text: '说完了 @' }]);
  });

  it('空名单 / 空文本不炸', () => {
    expect(splitMentions('@小雨 在吗', [])).toEqual([{ kind: 'text', text: '@小雨 在吗' }]);
    expect(splitMentions('', people)).toEqual([]);
  });

  it('名单里有空名字也不会把每个 @ 都吃掉', () => {
    // 一个 name 为空串的成员（残缺数据）会让 startsWith('') 恒真——那样
    // 每个 @ 都变成一个零长度、指向幽灵 id 的提及。
    //
    // 用「@张三」而不是「@小雨」是这条用例的关键：名单按长度降序排，空名字
    // 永远排在最后，所以只要有任何真名字先命中，守卫就没被走到——我第一版
    // 写的就是 @小雨，拿掉守卫照样全绿。要让守卫真的挨到判决，就得挑一个
    // **没有任何真名字命中**的 @。
    const broken: Mentionable[] = [{ id: 'ghost', name: '' }, ...people];
    expect(splitMentions('@张三 在吗', broken)).toEqual([
      { kind: 'text', text: '@张三 在吗' },
    ]);
    // 真名字仍然照常命中。
    expect(splitMentions('@小雨 在吗', broken)[0]).toEqual({
      kind: 'mention',
      text: '@小雨',
      id: 'ai_a',
    });
  });

  /**
   * 往返不变量的属性测试。种子化，不用 Math.random（铁律 4）——用一个固定的
   * 线性同余生成器造串，跑挂了能原样复现。
   */
  it('随机串的往返一定相等（不吞字不造字）', () => {
    let seed = 20260901;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const alphabet = ['@', '小', '雨', '儿', '阿', '甲', '我', ' ', 'a', '，', '所', '有', '人'];
    for (let i = 0; i < 500; i++) {
      const len = Math.floor(rnd() * 14);
      let t = '';
      for (let j = 0; j < len; j++) t += alphabet[Math.floor(rnd() * alphabet.length)];
      expect(roundTrips(t), `往返不相等：${JSON.stringify(t)}`).toBe(true);
    }
  });
});
