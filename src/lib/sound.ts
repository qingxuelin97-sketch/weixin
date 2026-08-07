/**
 * Notification sound.
 *
 * NOTE ON THE ASSET: WeChat's exact "叮" chime is a Tencent-owned audio asset;
 * we do NOT bundle it in the repo (that would redistribute copyrighted audio).
 * Instead this module SYNTHESIZES a clean, royalty-free two-tone chime via the
 * Web Audio API. If you want the exact WeChat sound for personal use, drop your
 * own file at `public/sounds/message.mp3` (extract it from your own install) —
 * this module will prefer it automatically and fall back to the synth if absent.
 */

const ENABLED_KEY = 'sound.messageEnabled';
const USER_FILE = '/sounds/message.mp3';

let audioCtx: AudioContext | null = null;
let userFileAvailable: boolean | null = null; // null = not yet probed
let userAudio: HTMLAudioElement | null = null;
let unlocked = false;

function isEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setMessageSoundEnabled(on: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}

export function isMessageSoundEnabled(): boolean {
  return isEnabled();
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

/** Synthesize a short, gentle two-note "message" chime (no copyrighted asset). */
function synthChime(c: AudioContext): void {
  const now = c.currentTime;
  const master = c.createGain();
  master.gain.value = 0.0001;
  master.connect(c.destination);
  // Two quick notes (a rising minor third), soft sine timbre.
  const notes = [
    { f: 987.77, t: 0 }, // B5
    { f: 1174.66, t: 0.09 }, // D6
  ];
  for (const n of notes) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = n.f;
    const start = now + n.t;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(0.22, start + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
    osc.connect(g);
    g.connect(master);
    osc.start(start);
    osc.stop(start + 0.24);
  }
  master.gain.setValueAtTime(1, now);
}

/** Play the incoming-message notification sound (respects the enabled setting). */
export function playMessageSound(): void {
  if (!isEnabled()) return;
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
  if (c.state === 'suspended') void c.resume();
  try {
    synthChime(c);
  } catch {
    /* ignore audio errors */
  }
}
