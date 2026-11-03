// @vitest-environment jsdom
/**
 * 首次体验 (M-K9)。
 *
 * 最要紧的一条写在最前面：**老安装永远不许看见引导页**——用户本人的手机就是一个
 * 老安装。所以判据只认「这次水合才写进的种子」（freshInstall），并且只在根路由上拦。
 *
 * 第二要紧的：第一条问候是一行一次性的 heartbeat。它必须被 isChainOneOff 认出来——
 * 否则它开火时会给这个人再续一条心跳链，正是本轮刚修掉的分叉病。
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

let providerReady = false;
vi.mock('../../src/llm/service', async (orig) => ({
  ...(await orig<typeof import('../../src/llm/service')>()),
  hasUsableProvider: async () => providerReady,
}));

import {
  GREETING_DELAY_MS,
  ONBOARDED_KEY,
  isOnboarded,
  markOnboarded,
  scheduleWelcomeGreeting,
  shouldOnboard,
  welcomeGreetingId,
} from '../../src/features/welcome/welcome';
import { WelcomePage } from '../../src/features/welcome/WelcomePage';
import { isChainOneOff, payloadOf, pendingActions } from '../../src/ai/scheduler';
import { useAppStore } from '../../src/store/appStore';
import type { ContactVM, ConversationVM, PersonaVM } from '../../src/data/types';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

afterEach(cleanup);
beforeEach(() => localStorage.clear());

describe('谁会看见引导页', () => {
  it('只有全新安装、且这台设备没走过引导', () => {
    expect(shouldOnboard(true, false)).toBe(true);
    expect(shouldOnboard(true, true)).toBe(false);
    expect(shouldOnboard(false, false)).toBe(false); // 老安装：永远不
  });

  it('「走过引导」记在本机，跳过也算', () => {
    expect(isOnboarded()).toBe(false);
    markOnboarded();
    expect(localStorage.getItem(ONBOARDED_KEY)).toBe('1');
    expect(isOnboarded()).toBe(true);
  });

  it('freshInstall 只由「这次水合写了种子」决定；只有根路由会送人去引导页', () => {
    const store = read('src/store/appStore.ts');
    expect(store).toMatch(/const freshInstall = await repo\.isEmpty\(\);\s*if \(freshInstall\) \{/);
    const app = read('src/App.tsx');
    expect(app).toContain('<Route path="/" element={<RootRedirect />} />');
    expect(app).toMatch(/shouldOnboard\(freshInstall, isOnboarded\(\)\) \? '\/welcome' : '\/chats'/);
    // 不许在别处 navigate 到引导页——那会把深链、测试、手输路由都截走。
    expect(app.match(/'\/welcome'/g)?.length).toBe(1);
  });
});

describe('第一条问候', () => {
  it('一行一次性 heartbeat：带 at、约 4 秒后落地、不续链', async () => {
    const now = 1_760_000_000_000;
    expect(await scheduleWelcomeGreeting('ai_lin', 'conv_lin', now)).toBe(true);
    const row = (await pendingActions()).find((a) => a.id === welcomeGreetingId('ai_lin'))!;
    expect(row.kind).toBe('heartbeat');
    expect(row.fireAt).toBe(now + GREETING_DELAY_MS);
    const p = payloadOf(row)!;
    expect(p).toMatchObject({ contactId: 'ai_lin', convId: 'conv_lin', at: now + GREETING_DELAY_MS });
    expect(isChainOneOff(p), '问候若被当成链上的一环，开火时会给她再接一条心跳链').toBe(true);
    expect(p.body, '不许预写台词——要她现在用模型写').toBeUndefined();
  });

  it('一辈子一次：再排一次什么都不做', async () => {
    expect(await scheduleWelcomeGreeting('ai_ada', 'conv_ada', 1)).toBe(true);
    expect(await scheduleWelcomeGreeting('ai_ada', 'conv_ada', 2)).toBe(false);
  });
});

/* ------------------------------ 页面 ------------------------------ */

const contact = (id: string, name: string): ContactVM =>
  ({ id, name, type: 'ai', avatarText: name[0], avatarColor: 'var(--color-brand)' }) as ContactVM;
const conv = (id: string, peerId: string): ConversationVM => ({
  id,
  type: 'single',
  peerId,
  title: '',
  avatarColor: 'var(--color-brand)',
  avatarText: '',
  isPinned: false,
  isMuted: false,
  unreadCount: 0,
  mentionMe: false,
  lastMsgPreview: '',
  lastMsgAt: 0,
});

async function open(url: string) {
  useAppStore.setState({
    contacts: [contact('ai_x', '小雪'), contact('ai_y', '阿杨')],
    conversations: [conv('conv_x', 'ai_x'), conv('conv_y', 'ai_y')],
    personaFor: (id: string) => ({ core: id === 'ai_y' ? '退休的老钓友。爱讲古。' : '插画师。' }) as PersonaVM,
  });
  await act(async () => {
    render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/welcome" element={<WelcomePage />} />
          <Route path="/chats" element={<div>会话列表</div>} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

describe('引导页', () => {
  it('第一步：没接模型时给出「去接一个」；接上了显示已接上', async () => {
    providerReady = false;
    await open('/welcome');
    expect(screen.getByText('先接上一个模型')).toBeTruthy();
    expect(screen.getByText('去接一个 ›')).toBeTruthy();
    cleanup();
    providerReady = true;
    await open('/welcome');
    expect(screen.getByText('已接上模型')).toBeTruthy();
  });

  it('第二步：列出朋友、一句自我介绍，点选谁先来', async () => {
    providerReady = true;
    await open('/welcome?step=2');
    expect(screen.getByText('退休的老钓友。')).toBeTruthy();
    const radios = screen.getAllByRole('radio');
    expect(radios[0].getAttribute('aria-checked')).toBe('true'); // 默认第一位
    await act(async () => {
      fireEvent.click(screen.getByText('阿杨'));
    });
    expect(screen.getAllByRole('radio')[1].getAttribute('aria-checked')).toBe('true');
  });

  it('第三步「进入微信」：接了模型 → 记下已引导、给选中的人排问候、回会话列表', async () => {
    providerReady = true;
    await open('/welcome?step=3&who=ai_y');
    expect(screen.getByText('阿杨马上会来找你')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText('进入微信'));
    });
    // The greeting is written (IndexedDB) BEFORE leaving, so wait for the hop.
    expect(await screen.findByText('会话列表')).toBeTruthy();
    expect(isOnboarded()).toBe(true);
    const row = (await pendingActions()).find((a) => a.id === welcomeGreetingId('ai_y'));
    expect(row && payloadOf(row)?.convId).toBe('conv_y');
  });

  it('没接模型：说清楚之后会怎样，不排问候（否则第一句就是人设化的「信号不太好」）', async () => {
    providerReady = false;
    await open('/welcome?step=3&who=ai_x');
    expect(screen.getByText('接上模型之后，他们会自己来找你')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText('进入微信'));
    });
    expect(await screen.findByText('会话列表')).toBeTruthy();
    expect((await pendingActions()).some((a) => a.id === welcomeGreetingId('ai_x'))).toBe(false);
  });

  it('跳过：记下已引导、直接回列表、不排问候', async () => {
    providerReady = true;
    await open('/welcome?step=2&who=ai_x');
    await act(async () => {
      fireEvent.click(screen.getByText('跳过'));
    });
    expect(await screen.findByText('会话列表')).toBeTruthy();
    expect(isOnboarded()).toBe(true);
    expect((await pendingActions()).some((a) => a.id === welcomeGreetingId('ai_x'))).toBe(false);
  });
});
