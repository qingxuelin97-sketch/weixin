import { describe, it, expect } from 'vitest';
import { parseDeepLink, convIdOfRoute } from '../../src/native/deep-link';

/**
 * aiwx:// deep links (M-I10). The exported VIEW intent-filter means ANY app on
 * the device can throw a URI at us — the allowlist is a security boundary, not
 * a convenience, so the rejection cases matter as much as the happy paths.
 */
describe('parseDeepLink', () => {
  it('routes the surfaces the native layer actually produces', () => {
    expect(parseDeepLink('aiwx://chat/conv_lin')).toBe('/chat/conv_lin');
    expect(parseDeepLink('aiwx://chats')).toBe('/chats');
    expect(parseDeepLink('aiwx://call/conv_lin?incoming=1')).toBe('/call/conv_lin?incoming=1');
    expect(parseDeepLink('aiwx://call/conv_lin?incoming=1&accept=1')).toBe(
      '/call/conv_lin?incoming=1&accept=1',
    );
    expect(parseDeepLink('aiwx://settings/battery')).toBe('/settings/battery');
    expect(parseDeepLink('aiwx://settings/native')).toBe('/settings/native');
  });

  it('keeps URL-encoded conv ids intact for the router to decode', () => {
    expect(parseDeepLink('aiwx://chat/conv%20with%20space')).toBe('/chat/conv%20with%20space');
  });

  it('tolerates surrounding whitespace and a trailing slash', () => {
    expect(parseDeepLink('  aiwx://chat/c1  ')).toBe('/chat/c1');
    expect(parseDeepLink('aiwx://chat/c1/')).toBe('/chat/c1');
  });

  it('rejects everything off the allowlist — near misses included', () => {
    expect(parseDeepLink('aiwx://persona/ai_lin')).toBeNull(); // dev page: never deep-linkable
    expect(parseDeepLink('aiwx://settings/api')).toBeNull(); // key config: never deep-linkable
    expect(parseDeepLink('aiwx://chat')).toBeNull(); // missing id
    expect(parseDeepLink('aiwx://chat/a/b')).toBeNull(); // extra segment
    expect(parseDeepLink('aiwx://')).toBeNull();
    expect(parseDeepLink('')).toBeNull();
  });

  it('rejects other schemes (Capacitor reports https universal links too)', () => {
    expect(parseDeepLink('https://example.com/chat/c1')).toBeNull();
    expect(parseDeepLink('weixin://chat/c1')).toBeNull();
    expect(parseDeepLink('javascript:alert(1)')).toBeNull();
  });

  it('drops fragments — the app is a HashRouter, a smuggled #/route must die here', () => {
    expect(parseDeepLink('aiwx://chat/c1#/settings/api')).toBe('/chat/c1');
  });
});

describe('convIdOfRoute', () => {
  it('recovers the conv id from chat and call routes, decoding as the router would', () => {
    expect(convIdOfRoute('/chat/c1')).toBe('c1');
    expect(convIdOfRoute('/call/c1?incoming=1')).toBe('c1');
    expect(convIdOfRoute('/chat/conv%20x')).toBe('conv x');
    expect(convIdOfRoute('/chats')).toBeNull();
  });
});
