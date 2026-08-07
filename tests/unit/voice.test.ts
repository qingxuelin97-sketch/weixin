import { describe, it, expect } from 'vitest';
import { audioKey } from '../../src/lib/voice';

describe('audioKey', () => {
  it('is stable for identical input (a resend must hit the cache, not re-bill)', () => {
    expect(audioKey('在吗', 'female-shaonv')).toBe(audioKey('在吗', 'female-shaonv'));
  });

  it('differs when the text differs', () => {
    expect(audioKey('在吗', 'female-shaonv')).not.toBe(audioKey('在吗？', 'female-shaonv'));
  });

  it('differs when the voice differs (same line, different persona)', () => {
    expect(audioKey('在吗', 'female-shaonv')).not.toBe(audioKey('在吗', 'male-qn-qingse'));
  });

  it('differs when the emotion differs', () => {
    expect(audioKey('好啊', 'female-shaonv', 'happy')).not.toBe(
      audioKey('好啊', 'female-shaonv', 'sad'),
    );
  });

  it('treats no-emotion and empty-emotion as the same clip', () => {
    expect(audioKey('好啊', 'female-shaonv')).toBe(audioKey('好啊', 'female-shaonv', ''));
  });

  it('produces a filesystem/idb-safe key', () => {
    expect(audioKey('带 空格 和标点！?', 'v')).toMatch(/^tts_[0-9a-f]+_\d+$/);
  });
});
