// @vitest-environment jsdom
/**
 * 资料页 / 聊天信息页精修 (M-K8)。
 *
 * 写在最前面的是数据上的真问题：种子把人数写死进了群的**名字**——「周末爬山小分队(5)」。
 * 会话列表里出现了微信不会有的「(5)」，模型的 prompt 把它当成群名的一部分，加人减人
 * 之后它还永远是 5。人数改成派生（成员 + 自己），老安装那一行在水合时订正一次——
 * 只订正种子原文，用户改过的名字不碰。
 *
 * 其余是版式：资料页是灰底白 cell 分组（此前 `.contacts` 把整页刷白，分组之间什么都
 * 没有）、昵称、朋友圈缩略图、人设成行、两个动作在底部带图标、危险操作是红字 cell。
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, cleanup, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { groupHeadcount } from '../../src/lib/group-headcount';
import { fixLegacySeedTitles, LEGACY_SEED_GROUP, useAppStore } from '../../src/store/appStore';
import { repo } from '../../src/db/repo';
import { seedConversations } from '../../src/data/seed';
import { ContactProfilePage } from '../../src/features/contacts/ContactProfilePage';
import { ChatInfoPage } from '../../src/features/chat/ChatInfoPage';
import type { ContactVM, ConversationVM, PersonaVM } from '../../src/data/types';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

afterEach(cleanup);
beforeEach(() => {
  window.matchMedia ??= ((q: string) =>
    ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
});

describe('群人数是派生的，不写进群名', () => {
  it('成员加上你自己；已不存在的联系人不算', () => {
    const alive = new Set(['a', 'b', 'c']);
    expect(groupHeadcount(['a', 'b', 'c', 'gone'], (id) => alive.has(id))).toBe(4);
    expect(groupHeadcount(undefined, () => true)).toBe(1);
  });

  it('种子里没有任何会话名带着「(数字)」尾巴', () => {
    const baked = seedConversations.filter((c) => /\(\d+\)$/.test(c.title)).map((c) => c.title);
    expect(baked).toEqual([]);
  });

  const legacy = (title: string): ConversationVM =>
    ({ ...seedConversations.find((c) => c.id === LEGACY_SEED_GROUP.id)!, title }) as ConversationVM;

  it('老安装：种子原文订正一次并写回存储；第二次什么都不做', async () => {
    const out = await fixLegacySeedTitles([legacy(LEGACY_SEED_GROUP.title)]);
    expect(out[0].title).toBe(LEGACY_SEED_GROUP.fixed);
    expect((await repo.getConversations()).find((c) => c.id === LEGACY_SEED_GROUP.id)?.title).toBe(
      LEGACY_SEED_GROUP.fixed,
    );
    const again = [legacy(LEGACY_SEED_GROUP.fixed)];
    expect(await fixLegacySeedTitles(again)).toBe(again); // untouched, same reference
  });

  it('用户改过的群名一个字都不碰（哪怕也带着括号）', async () => {
    const mine = [legacy('爬山群(5)')];
    expect(await fixLegacySeedTitles(mine)).toBe(mine);
  });

  it('水合真的调用了订正（写了没接线 = 没做）', () => {
    expect(read('src/store/appStore.ts')).toMatch(/const conversations = await fixLegacySeedTitles\(storedConvs\)/);
  });
});

/* ------------------------------ 页面 ------------------------------ */

const contact = (id: string, name: string, over: Partial<ContactVM> = {}): ContactVM =>
  ({ id, name, type: 'ai', avatarText: name[0], avatarColor: 'var(--color-brand)', ...over }) as ContactVM;
const persona = { core: '25 岁插画师，嘴硬心软。', nsfwPermit: false } as PersonaVM;
const conv = (over: Partial<ConversationVM>): ConversationVM => ({
  id: 'c',
  type: 'single',
  title: '',
  avatarColor: 'var(--color-brand)',
  avatarText: '群',
  isPinned: false,
  isMuted: false,
  unreadCount: 0,
  mentionMe: false,
  lastMsgPreview: '',
  lastMsgAt: 0,
  ...over,
});

function setStore(contacts: ContactVM[], conversations: ConversationVM[]) {
  const byId = new Map(contacts.map((c) => [c.id, c]));
  useAppStore.setState({
    contacts,
    conversations,
    contactById: (id: string) => byId.get(id),
    conversationById: (id: string) => conversations.find((c) => c.id === id),
    personaFor: (id: string) => (byId.has(id) ? persona : undefined),
  });
}

const at = async (path: string, route: string, el: React.ReactElement) => {
  await act(async () => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={route} element={el} />
        </Routes>
      </MemoryRouter>,
    );
  });
};

describe('资料页（微信 8.0 版式）', () => {
  it('备注之下显示「昵称：本名」；没有备注时不显示', async () => {
    setStore([contact('ai_lin', '林小雨', { remark: '小雨' })], []);
    await at('/contact/ai_lin', '/contact/:contactId', <ContactProfilePage />);
    expect(document.querySelector('.contact-card__name')?.textContent).toBe('小雨');
    expect(screen.getByText('昵称：林小雨')).toBeTruthy();
    cleanup();
    setStore([contact('ai_lin', '林小雨')], []);
    await at('/contact/ai_lin', '/contact/:contactId', <ContactProfilePage />);
    expect(screen.queryByText(/^昵称：/)).toBeNull();
  });

  it('发消息 / 音视频通话在底部、带图标；删除联系人是最后一条红字 cell', async () => {
    setStore([contact('ai_lin', '林小雨')], []);
    await at('/contact/ai_lin', '/contact/:contactId', <ContactProfilePage />);
    const groups = [...document.querySelectorAll('.contact-card > .settings__group')];
    const last = groups.at(-1)!;
    const actions = groups.at(-2)!;
    expect(last.querySelector('.settings__row--danger')?.textContent).toBe('删除联系人');
    const rows = [...actions.querySelectorAll('.contact-card__action')];
    expect(rows.map((r) => r.textContent)).toEqual(['发消息', '音视频通话']);
    for (const r of rows) expect(r.querySelector('svg'), `${r.textContent} 没有图标`).not.toBeNull();
    // 旧的「语音通话」与边框按钮式的删除都不该再出现。
    expect(screen.queryByText('语音通话')).toBeNull();
    expect(document.querySelector('.btn-ghost')).toBeNull();
  });

  it('人设成了一行（并且就是去编辑人设的入口）', async () => {
    setStore([contact('ai_lin', '林小雨')], []);
    await at('/contact/ai_lin', '/contact/:contactId', <ContactProfilePage />);
    expect(document.querySelector('.contact-card__core')?.textContent).toBe(persona.core);
    expect(screen.queryByText('编辑人设')).toBeNull();
  });

  it('灰底：资料页不再被联系人列表的白底刷白（否则分组之间什么都没有）', () => {
    const css = read('src/features/contacts/contacts.css').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toMatch(/\.contacts\.contact-card\s*\{\s*background:\s*var\(--color-page-bg\)/);
  });
});

describe('聊天信息页', () => {
  const people = [contact('a', 'A'), contact('b', 'B'), contact('c', 'C')];

  it('群聊标题带人数：成员 + 自己，已删的不算', async () => {
    setStore(people, [conv({ id: 'g', type: 'group', title: '饭搭子', memberIds: ['a', 'b', 'c', 'gone'] })]);
    await at('/chat/g/info', '/chat/:convId/info', <ChatInfoPage />);
    expect(screen.getByText('聊天信息(4)')).toBeTruthy();
    expect(document.querySelector('.settings__row--danger')?.textContent).toBe('退出群聊');
  });

  it('单聊标题不带人数；「查找聊天内容」是微信 8.0 的说法', async () => {
    setStore(people, [conv({ id: 's', type: 'single', title: 'A', peerId: 'a' })]);
    await at('/chat/s/info', '/chat/:convId/info', <ChatInfoPage />);
    expect(screen.getByText('聊天信息')).toBeTruthy();
    expect(screen.getByText('查找聊天内容')).toBeTruthy();
    expect(screen.queryByText('查找聊天记录')).toBeNull();
    expect(document.querySelector('.settings__row--danger')?.textContent).toBe('删除该聊天');
  });
});
