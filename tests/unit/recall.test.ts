import { describe, it, expect } from 'vitest';
import {
  canRecall,
  canReEdit,
  shouldFollowUpAfterRecall,
  recallFollowUpLine,
  RECALL_WINDOW_MS,
} from '../../src/lib/recall';
import { makePersona } from '../../src/data/persona-defaults';
import type { MessageVM } from '../../src/data/types';

const NOW = new Date(2025, 7, 6, 12, 0, 0).getTime();

function msg(over: Partial<MessageVM> = {}): MessageVM {
  return {
    id: 1,
    convId: 'c',
    senderId: 'self',
    type: 'text',
    content: '说错话了',
    status: 'sent',
    createdAt: NOW - 60_000,
    ...over,
  };
}

describe('canRecall', () => {
  it('allows recalling your own recent text message', () => {
    expect(canRecall(msg(), NOW)).toBe(true);
  });

  it('refuses exactly past the 2-minute window', () => {
    expect(canRecall(msg({ createdAt: NOW - RECALL_WINDOW_MS }), NOW)).toBe(true);
    expect(canRecall(msg({ createdAt: NOW - RECALL_WINDOW_MS - 1 }), NOW)).toBe(false);
  });

  it("refuses other people's messages", () => {
    expect(canRecall(msg({ senderId: 'ai_lin' }), NOW)).toBe(false);
  });

  it('refuses an already-recalled message', () => {
    expect(canRecall(msg({ isRecalled: true }), NOW)).toBe(false);
  });

  it('refuses money and call messages — the ledger would contradict the recall', () => {
    for (const type of ['rp', 'transfer', 'call', 'system'] as const) {
      expect(canRecall(msg({ type }), NOW)).toBe(false);
    }
  });

  it('allows voice/image/sticker within the window', () => {
    for (const type of ['voice', 'image', 'sticker'] as const) {
      expect(canRecall(msg({ type }), NOW)).toBe(true);
    }
  });
});

describe('canReEdit', () => {
  it('offers 重新编辑 only for your own recalled text with content', () => {
    expect(canReEdit(msg({ isRecalled: true }))).toBe(true);
    expect(canReEdit(msg({ isRecalled: false }))).toBe(false);
    expect(canReEdit(msg({ isRecalled: true, senderId: 'ai_lin' }))).toBe(false);
    expect(canReEdit(msg({ isRecalled: true, type: 'sticker' }))).toBe(false);
    expect(canReEdit(msg({ isRecalled: true, content: undefined }))).toBe(false);
  });
});

describe('recall follow-up (the drama)', () => {
  it('is deterministic per message id', () => {
    expect(shouldFollowUpAfterRecall(42)).toBe(shouldFollowUpAfterRecall(42));
    const p = makePersona({ contactId: 'a', core: 'c', catchphrases: ['离谱'] });
    expect(recallFollowUpLine(p, 42)).toBe(recallFollowUpLine(p, 42));
  });

  it('fires sometimes but not always across many messages', () => {
    const fired = Array.from({ length: 200 }, (_, i) => shouldFollowUpAfterRecall(i)).filter(
      Boolean,
    ).length;
    expect(fired).toBeGreaterThan(20);
    expect(fired).toBeLessThan(180);
  });

  it('produces a non-empty line, with or without a catchphrase', () => {
    const bare = makePersona({ contactId: 'a', core: 'c' });
    const chatty = makePersona({ contactId: 'a', core: 'c', catchphrases: ['离谱'] });
    for (let i = 0; i < 20; i++) {
      expect(recallFollowUpLine(bare, i).length).toBeGreaterThan(0);
      expect(recallFollowUpLine(chatty, i).length).toBeGreaterThan(0);
    }
  });
});
