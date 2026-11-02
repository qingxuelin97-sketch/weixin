// @vitest-environment jsdom
/**
 * 设置树分页 (M-K4)。
 *
 * 拆页最容易出的事不是「新页面画错了」，而是**某个入口在搬家时丢了**——一个开关从
 * 旧页删掉、却没在新页出现，用户就再也找不到它，而所有测试照样绿（旧页本来就没测
 * 每一行）。所以这里把旧设置页的每一个入口列成清单，断言它在新树里有且仍可达。
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatSettingsPage } from '../../src/features/settings/SettingsSections';
import { enterToSend } from '../../src/lib/chat-prefs';

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

describe('旧设置页的每个入口在新树里都还在', () => {
  const root = read('src/features/settings/SettingsPage.tsx');
  const sections = read('src/features/settings/SettingsSections.tsx');
  const tree = root + sections;

  /** M-K3 末的设置页（一张长清单）上每一个入口：路由，或开关的文案。 */
  const ROUTES = [
    '/settings/api',
    '/settings/asr',
    '/settings/tts',
    '/settings/dark-mode',
    '/story',
    '/settings/media',
    '/settings/storage',
    '/settings/worldbook',
    '/settings/env',
    '/settings/notify-test',
    '/settings/native',
    '/settings/backup',
  ];
  const SWITCHES = ['让 TA 看得见图片', '已读回执', '锁屏通知', '声音', '振动'];

  it('每条旧路由都有一个入口（LinkRow to=）', () => {
    const lost = ROUTES.filter((r) => !tree.includes(`to="${r}"`));
    expect(lost, '这些设置在搬家时丢了入口').toEqual([]);
  });

  it('每个旧开关都还在', () => {
    expect(SWITCHES.filter((l) => !tree.includes(`label="${l}"`))).toEqual([]);
  });

  it('内容分级（NSFW）三档还在，写的仍是 nsfwGlobalTier', () => {
    expect(sections).toContain("putSetting('nsfwGlobalTier'");
    expect(sections).toMatch(/off.*ambiguous.*full/s);
  });

  it('根页的四个分页都挂上了路由', () => {
    const app = read('src/App.tsx');
    for (const p of ['/settings/ai', '/settings/notify', '/settings/chat', '/settings/general']) {
      expect(root, `设置首页没有去 ${p} 的入口`).toContain(`to="${p}"`);
      expect(app, `${p} 没有挂路由`).toContain(`path="${p}"`);
    }
  });
});

describe('回车键发送消息', () => {
  it('默认开（保住一直以来的行为）；关掉后组合器的回车只换行', () => {
    expect(enterToSend()).toBe(true);
    render(
      <MemoryRouter>
        <ChatSettingsPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('回车键发送消息'));
    expect(enterToSend()).toBe(false);
    const chat = read('src/features/chat/ChatPage.tsx');
    expect(chat).toMatch(/e\.key === 'Enter' && !e\.shiftKey && enterToSend\(\)/);
  });
});
