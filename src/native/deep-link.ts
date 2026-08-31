/**
 * aiwx:// deep-link parsing (M-I10). Pure — unit-tested without Capacitor.
 *
 * Every native re-entry point (bubble tap, notification tap, RemoteInput
 * confirmation, full-screen call, widget) carries an aiwx:// URI built by the
 * Kotlin DeepLink object; this is the single JS-side gate that turns one into
 * an in-app route. ALLOWLISTED routes only: a URI is attacker-ish input (any
 * app on the device can fire a VIEW intent at our exported activity), so an
 * unknown path must navigate nowhere, not "somewhere close".
 */

const SCHEME = /^aiwx:\/\/([^?#]*)(\?[^#]*)?(?:#.*)?$/;

/** Path shapes a native surface is allowed to open. Query is path-agnostic. */
const ALLOWED: RegExp[] = [
  /^\/chats$/,
  /^\/chat\/[^/]+$/,
  /^\/call\/[^/]+$/,
  // 朋友圈赞评通知 (M-I18): tapping one lands on the feed, anchored to the post
  // via `?at=<momentId>` — the same query convention the chat page uses for a
  // search hit. Before this the moments notification had no route at all: it
  // opened the launcher's idea of the app and the user had to find the post.
  /^\/moments$/,
  /^\/settings\/battery$/,
  /^\/settings\/native$/,
];

/**
 * aiwx://chat/abc → "/chat/abc"; aiwx://call/abc?incoming=1 → "/call/abc?incoming=1".
 * Returns null for anything not on the allowlist (including other schemes —
 * e.g. the https:// URLs Capacitor also reports through appUrlOpen).
 */
export function parseDeepLink(url: string): string | null {
  const m = SCHEME.exec(url.trim());
  if (!m) return null;
  const path = '/' + m[1].replace(/\/+$/, '');
  if (!ALLOWED.some((r) => r.test(path))) return null;
  return path + (m[2] ?? '');
}

/** Extract the conv id back out of a parsed /chat/:id or /call/:id route. */
export function convIdOfRoute(route: string): string | null {
  const m = /^\/(?:chat|call)\/([^/?#]+)/.exec(route);
  return m ? decodeURIComponent(m[1]) : null;
}
