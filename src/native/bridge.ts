/**
 * Typed wrappers around the AiwxNative Capacitor plugin (M-I10).
 *
 * TWO REPO-CONSTITUTION TRAPS ARE LOAD-BEARING HERE:
 *
 * 1. The thenable-proxy trap (tests/unit/plugin-proxy.test.ts): a Capacitor
 *    plugin proxy forwards ANY property access — including `.then` — as a
 *    native call, so the proxy must NEVER be a promise's resolution value.
 *    Every export below is a plain async function returning plain data.
 *
 * 2. Native "timeouts" must be REAL rejections: a bridge call can hang forever
 *    (the empty-setTimeout guard once froze the on-device 测试连接 button), so
 *    every call is raced against a timer that actually rejects.
 *
 * On web every function degrades to an inert default instead of throwing —
 * the web build is a first-class target and must never crash over a missing
 * native layer.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

interface AiwxNativePlugin {
  deviceInfo(): Promise<{ manufacturer: string; brand: string; sdkInt: number }>;
  overlayGranted(): Promise<{ granted: boolean }>;
  requestOverlay(): Promise<{ launched: boolean }>;
  showBubble(opts: {
    convId: string;
    title: string;
    text: string;
  }): Promise<{ shown: boolean; reason?: string }>;
  hideBubble(): Promise<void>;
  notifyMessage(opts: {
    convId: string;
    title: string;
    body: string;
    id?: number;
  }): Promise<{ posted: boolean }>;
  notifyCall(opts: { convId: string; name: string; id?: number }): Promise<{ posted: boolean }>;
  cancelNotify(opts: { id: number }): Promise<void>;
  drainReplies(): Promise<{ items: unknown }>;
  batteryIgnored(): Promise<{ ignored: boolean }>;
  requestBatteryIgnore(): Promise<{ launched: boolean }>;
  openBatterySettings(opts: { vendor: string }): Promise<{ opened: string }>;
  updateWidget(opts: {
    unread: number;
    title: string;
    preview: string;
    convId: string;
  }): Promise<void>;
}

const plugin = registerPlugin<AiwxNativePlugin>('AiwxNative');

/** Deadline for any single bridge round-trip. Generous — these are local IPC. */
export const BRIDGE_TIMEOUT_MS = 8_000;

/**
 * Race a native promise against a timer that REJECTS (constitution 3.5: an
 * uncancellable native promise wrapped by a no-op timer awaits forever).
 */
export function withDeadline<T>(p: Promise<T>, label: string, ms = BRIDGE_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`native ${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}

export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

export async function deviceInfo(): Promise<{ manufacturer: string; brand: string; sdkInt: number }> {
  if (!isNative()) return { manufacturer: '', brand: '', sdkInt: 0 };
  const r = await withDeadline(plugin.deviceInfo(), 'deviceInfo');
  return { manufacturer: r.manufacturer ?? '', brand: r.brand ?? '', sdkInt: r.sdkInt ?? 0 };
}

export async function overlayGranted(): Promise<boolean> {
  if (!isNative()) return false;
  try {
    return (await withDeadline(plugin.overlayGranted(), 'overlayGranted')).granted === true;
  } catch {
    return false;
  }
}

export async function requestOverlay(): Promise<boolean> {
  if (!isNative()) return false;
  try {
    return (await withDeadline(plugin.requestOverlay(), 'requestOverlay')).launched === true;
  } catch {
    return false;
  }
}

export async function showBubble(convId: string, title: string, text: string): Promise<boolean> {
  if (!isNative()) return false;
  try {
    return (await withDeadline(plugin.showBubble({ convId, title, text }), 'showBubble')).shown === true;
  } catch {
    return false;
  }
}

export async function hideBubble(): Promise<void> {
  if (!isNative()) return;
  try {
    await withDeadline(plugin.hideBubble(), 'hideBubble');
  } catch {
    /* the bubble auto-hides anyway */
  }
}

export async function notifyMessage(
  convId: string,
  title: string,
  body: string,
  id?: number,
): Promise<boolean> {
  if (!isNative()) return false;
  try {
    const r = await withDeadline(plugin.notifyMessage({ convId, title, body, id }), 'notifyMessage');
    return r.posted === true;
  } catch {
    return false;
  }
}

export async function notifyCall(convId: string, name: string, id?: number): Promise<boolean> {
  if (!isNative()) return false;
  try {
    return (await withDeadline(plugin.notifyCall({ convId, name, id }), 'notifyCall')).posted === true;
  } catch {
    return false;
  }
}

export async function cancelNotify(id: number): Promise<void> {
  if (!isNative()) return;
  try {
    await withDeadline(plugin.cancelNotify({ id }), 'cancelNotify');
  } catch {
    /* best effort */
  }
}

/** Raw drain — validation lives in reply-drain.ts (parseReplyItems). */
export async function drainRepliesRaw(): Promise<unknown> {
  if (!isNative()) return [];
  const r = await withDeadline(plugin.drainReplies(), 'drainReplies');
  return r.items;
}

export async function batteryIgnored(): Promise<boolean> {
  if (!isNative()) return false;
  try {
    return (await withDeadline(plugin.batteryIgnored(), 'batteryIgnored')).ignored === true;
  } catch {
    return false;
  }
}

export async function requestBatteryIgnore(): Promise<boolean> {
  if (!isNative()) return false;
  try {
    return (await withDeadline(plugin.requestBatteryIgnore(), 'requestBatteryIgnore')).launched === true;
  } catch {
    return false;
  }
}

export async function openBatterySettings(vendor: string): Promise<string> {
  if (!isNative()) return 'none';
  try {
    return (await withDeadline(plugin.openBatterySettings({ vendor }), 'openBatterySettings')).opened;
  } catch {
    return 'none';
  }
}

export async function updateWidget(data: {
  unread: number;
  title: string;
  preview: string;
  convId: string;
}): Promise<void> {
  if (!isNative()) return;
  await withDeadline(plugin.updateWidget(data), 'updateWidget');
}
