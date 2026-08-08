/**
 * Notification sound + haptic feedback.
 *
 * NOTE ON THE ASSET: WeChat's exact "叮" chime is a Tencent-owned audio asset;
 * we do NOT bundle it in the repo (that would redistribute copyrighted audio).
 * Instead this module SYNTHESIZES a clean, royalty-free two-tone chime via the
 * Web Audio API. If you want the exact WeChat sound for personal use, drop your
 * own file at `public/sounds/message.mp3` (extract it from your own install) —
 * this module will prefer it automatically and fall back to the synth if absent.
 *
 * ANDROID TRAP (real-device bug #6): the OS re-suspends the AudioContext every
 * time the app backgrounds, and `resume()` is async — scheduling the ~240ms
 * chime window before the resume completes plays into a dead context, i.e.
 * silence. So: resume is awaited before synthesis, and the foreground pass
 * calls `resumeAudio()` because the first unlock is not a lifetime unlock.
 */
import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle } from '@capacitor/haptics';

const ENABLED_KEY = 'sound.messageEnabled';
const VIBRATE_KEY = 'sound.vibrateEnabled';
const USER_FILE = '/sounds/message.mp3';

/** Messages older than this are history being materialized, not news — silent. */
const LIVE_WINDOW_MS = 60_000;

let audioCtx: AudioContext | null = null;
let userFileAvailable: boolean | null = null; // null = not yet probed
let userAudio: HTMLAudioElement | null = null;
let unlocked = false;

function flag(key: string): boolean {
  try {
    return localStorage.getItem(key) !== '0';
  } catch {
    return true;
  }
}
function setFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}

export function setMessageSoundEnabled(on: boolean): void {
  setFlag(ENABLED_KEY, on);
}
export function isMessageSoundEnabled(): boolean {
  return flag(ENABLED_KEY);
}
export function setVibrateEnabled(on: boolean): void {
  setFlag(VIBRATE_KEY, on);
}
export function isVibrateEnabled(): boolean {
  return flag(VIBRATE_KEY);
}

function ctx(): AudioContext | null {
  if (audioCtx) return audioCtx;
  const AC = (window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as
    | typeof AudioContext
    | undefined;
  if (!AC) return null;
  audioCtx = new AC();
  return audioCtx;
}

/**
 * Unlock audio on the first user gesture (mobile browsers require this before
 * any sound can play). Call once from a tap/click handler at app start.
 */
export function unlockAudio(): void {
  if (unlocked) return;
  unlocked = true;
  const c = ctx();
  if (c && c.state === 'suspended') void c.resume();
  // Probe whether the user dropped in their own sound file.
  if (userFileAvailable === null) {
    const a = new Audio(USER_FILE);
    a.addEventListener('canplaythrough', () => {
      userFileAvailable = true;
      userAudio = a;
    });
    a.addEventListener('error', () => {
      userFileAvailable = false;
    });
    a.load();
  }
}

/**
 * Re-arm the context after a background stint. Android suspends it on every
 * backgrounding; the one-shot `unlocked` guard must not stop later resumes.
 */
export function resumeAudio(): void {
  const c = audioCtx;
  if (c && c.state === 'suspended') void c.resume();
}

/** Synthesize a short, bright two-note "message" chime (no copyrighted asset). */
function synthChime(c: AudioContext): void {
  const now = c.currentTime;
  const master = c.createGain();
  master.connect(c.destination);
  // Two quick notes (a rising minor third). A soft triangle fundamental plus a
  // quiet sine an octave up reads "phone chime" and carries over media volume —
  // the pure low-gain sine of v1 was near-inaudible on real speakers (bug #6).
  const notes = [
    { f: 987.77, t: 0 }, // B5
    { f: 1174.66, t: 0.09 }, // D6
  ];
  for (const n of notes) {
    const start = now + n.t;
    for (const [type, mult, peak] of [
      ['triangle', 1, 0.5],
      ['sine', 2, 0.12],
    ] as const) {
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = type;
      osc.frequency.value = n.f * mult;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(peak, start + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
      osc.connect(g);
      g.connect(master);
      osc.start(start);
      osc.stop(start + 0.24);
    }
  }
  master.gain.setValueAtTime(1, now);
}

/**
 * Play the incoming-message notification sound (respects the enabled setting).
 *
 * @param at the message's timestamp: pass it so materialized HISTORY (offline
 * backfill stamping the past) stays silent — only live arrivals ding. Omitting
 * it means "now".
 */
export function playMessageSound(at?: number): void {
  if (at != null && Date.now() - at > LIVE_WINDOW_MS) return;

  // Haptic tick alongside (or instead of) the chime — silent mode still gets
  // feedback, and it never throws the caller.
  if (Capacitor.isNativePlatform() && isVibrateEnabled()) {
    void Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
  }

  if (!isMessageSoundEnabled()) return;
  // Prefer a user-supplied file if present.
  if (userFileAvailable && userAudio) {
    const a = userAudio.cloneNode(true) as HTMLAudioElement;
    void a.play().catch(() => {
      /* autoplay blocked; ignore */
    });
    return;
  }
  const c = ctx();
  if (!c) return;
  void (async () => {
    try {
      // Await the resume — synthesizing into a still-suspended context schedules
      // the whole chime inside a frozen clock and nothing ever sounds.
      if (c.state === 'suspended') await c.resume();
      synthChime(c);
    } catch {
      /* ignore audio errors */
    }
  })();
}
