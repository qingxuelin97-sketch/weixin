/**
 * 微信保真 III (M-J7) red-guards：拍一拍 / 清空聊天记录 / 消息翻译。
 *
 *   1. 拍一拍是纯函数 + 队列：文案模板、是否回拍、延迟全部种子化可重放
 *      （铁律 4），回拍走 scheduled_actions 而不是 setTimeout（铁律 5）；
 *   2. 清空 ≠ 删除：消息与滚动摘要没了，会话/联系人/人设/记忆都还在；
 *   3. 翻译的缓存长在消息 meta 上，不是第二个 settings 键（无主、无界、
 *      级联找不到——这三条正是它被改掉的原因）；
 *   4. 接线扫描：双击头像、清空入口、翻译菜单项、后缀设置四条都真接上了。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import 'fake-indexeddb/auto';
import { patLine, shouldPatBack, patBackDelayMs, PAT_SUFFIX_MAX } from '../../src/ai/pat';
import { translateText } from '../../src/ai/translate';
import { NOTIFY_STANCE } from '../../src/ai/notify-service';
import { SCHEDULED_ACTION_KINDS } from '../../src/db/schema';
import { ACTION_LLM_BOUND } from '../../src/ai/cost-gate';
import { repo } from '../../src/db/repo';
import type { LlmRouter } from '../../src/llm/router';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

describe('拍一拍', () => {
  it('文案是模板：名字加引号，后缀属于被拍的人', () => {
    expect(patLine('你', '小雨', '的脑袋')).toBe('你拍了拍"小雨"的脑袋');
    expect(patLine('小雨', '你', '')).toBe('小雨拍了拍"你"');
  });

  it('后缀超长被截断（微信客户端也是这么做的）', () => {
    const long = '啊'.repeat(50);
    const line = patLine('你', '小雨', long);
    expect(line.length).toBe('你拍了拍"小雨"'.length + PAT_SUFFIX_MAX);
  });

  it('回不回拍、隔多久，同种子同结果（可重放）', () => {
    const p = { proactivity: 0.5, typingCpm: 200 };
    expect(shouldPatBack(p, 's1')).toBe(shouldPatBack(p, 's1'));
    expect(patBackDelayMs(p, 's1')).toBe(patBackDelayMs(p, 's1'));
  });

  it('主动性高的人更爱回拍，但两头都不是必然', () => {
    const seeds = Array.from({ length: 200 }, (_, i) => `s${i}`);
    const shy = seeds.filter((s) => shouldPatBack({ proactivity: 0 }, s)).length;
    const chatty = seeds.filter((s) => shouldPatBack({ proactivity: 1 }, s)).length;
    expect(chatty).toBeGreaterThan(shy);
    expect(shy).toBeGreaterThan(0); // 最内向的也偶尔回
    expect(chatty).toBeLessThan(seeds.length); // 最热情的也偶尔不回
  });

  it('延迟落在几秒内——用户还在看着这一屏', () => {
    for (const s of ['a', 'b', 'c', 'd']) {
      const ms = patBackDelayMs({ typingCpm: 200 }, s);
      expect(ms).toBeGreaterThanOrEqual(1200);
      expect(ms).toBeLessThanOrEqual(5000);
    }
  });

  it('pat_back 进了三本台账（kind / 成本闸 / 通知表态）', () => {
    expect(SCHEDULED_ACTION_KINDS).toContain('pat_back');
    expect(ACTION_LLM_BOUND.pat_back).toBe(false); // 一句模板，零生成
    expect(NOTIFY_STANCE.pat_back.via).toBe('silent'); // 真微信的拍一拍不出通知
  });

  it('回拍走队列而不是 setTimeout（离开聊天页也不会丢）', () => {
    const src = read('src/features/chat/ChatPage.tsx');
    const fn = src.slice(src.indexOf('const patPeer'));
    const body = fn.slice(0, 2200);
    expect(body).toContain("kind: 'pat_back'");
    expect(body).not.toContain('setTimeout');
  });
});

describe('清空聊天记录 ≠ 删除该聊天', () => {
  beforeEach(async () => {
    await repo.putConversation({
      id: 'conv_clr',
      type: 'single',
      peerId: 'ai_x',
      title: '小雨',
      avatarColor: '#000000',
      avatarText: '雨',
      isPinned: false,
      isMuted: false,
      unreadCount: 0,
      lastMsgAt: 1,
      lastMsgPreview: 'hi',
      mentionMe: false,
    });
  });

  it('消息与滚动摘要清空，会话行本身留下', async () => {
    await repo.addMessage({
      convId: 'conv_clr',
      senderId: 'self',
      type: 'text',
      content: '在吗',
      status: 'sent',
      createdAt: 2,
    });
    await repo.putConvSummary({ convId: 'conv_clr', summary: '聊过', uptoMsgId: 0, updatedAt: 2 });
    await repo.clearMessages('conv_clr');
    expect(await repo.getMessages('conv_clr')).toEqual([]);
    expect(await repo.getConvSummary('conv_clr')).toBeFalsy();
    // 关键区别：会话还在（删除该聊天才会连这行一起没）。
    expect(await repo.getConversation('conv_clr')).toBeTruthy();
  });
});

describe('翻译', () => {
  it('铁律 6：tier 原样传给路由器，调用点不自造', async () => {
    const seen: Array<string | undefined> = [];
    const router = {
      async complete(req: { nsfwTier?: string }) {
        seen.push(req.nsfwTier);
        return { text: 'hello', finishReason: 'stop' as const, raw: null };
      },
      async *generate() {},
    } as unknown as LlmRouter;
    expect(await translateText('你好', 'full', 'c1', router)).toBe('hello');
    expect(seen).toEqual(['full']);
  });

  it('空文本不发请求；失败返回 undefined 而不是把错误当译文', async () => {
    let calls = 0;
    const router = {
      async complete() {
        calls++;
        throw new Error('boom');
      },
      async *generate() {},
    } as unknown as LlmRouter;
    expect(await translateText('   ', 'off', 'c1', router)).toBeUndefined();
    expect(calls).toBe(0);
    expect(await translateText('你好', 'off', 'c1', router)).toBeUndefined();
    expect(calls).toBe(1);
  });

  it('缓存长在消息 meta 上，不是第二个 settings 键', () => {
    const src = read('src/ai/translate.ts');
    // 无主（内容哈希键没有归属，级联删不掉她的话）、无界、且与 meta 重复。
    expect(src).not.toContain('putSetting');
    expect(src).not.toContain('getSetting');
    expect(read('src/features/chat/ChatPage.tsx')).toContain('translation: out');
  });
});

describe('接线扫描（写了没接线 = 没做）', () => {
  it('双击对方头像触发拍一拍', () => {
    expect(read('src/features/chat/MessageBubble.tsx')).toContain('onDoubleClick');
    expect(read('src/features/chat/ChatPage.tsx')).toContain('onAvatarPat=');
  });

  it('聊天信息页有清空入口，且与删除是两个动作', () => {
    const src = read('src/features/chat/ChatInfoPage.tsx');
    expect(src).toContain('清空聊天记录');
    expect(src).toContain('clearMessages(conv.id)');
    expect(src).toContain('deleteConversation(conv.id)');
  });

  it('长按菜单有翻译，且译文渲染在气泡下方', () => {
    expect(read('src/features/chat/ChatPage.tsx')).toContain("label: m.meta?.translation ? '收起翻译' : '翻译'");
    expect(read('src/features/chat/MessageBubble.tsx')).toContain('msg-translation');
  });

  it('个人信息页能设拍一拍后缀', () => {
    const src = read('src/features/me/ProfilePage.tsx');
    expect(src).toContain('PAT_SUFFIX_KEY');
    expect(src).toContain('putSetting(PAT_SUFFIX_KEY');
  });
});
