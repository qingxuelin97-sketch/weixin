import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isRecordingSupported, pickAudioMime, startRecording } from '../../src/lib/recorder';

/**
 * M-I9 recorder — the two contracts that matter:
 *   1. graceful degradation: environments without the APIs get a typed
 *      RecorderError('unsupported'), never a crash mid-press;
 *   2. the mic is RELEASED on every exit path (stop / cancel / permission
 *      denial) — a leaked track is Android's "mic in use" indicator burning
 *      forever, which for a chat app reads as surveillance.
 */

/* ---- Harness: scriptable MediaRecorder + getUserMedia ---- */

class FakeTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  tracks = [new FakeTrack(), new FakeTrack()];
  getTracks() {
    return this.tracks;
  }
}

class FakeMediaRecorder {
  static supported = ['audio/webm;codecs=opus', 'audio/webm'];
  static isTypeSupported(t: string) {
    return FakeMediaRecorder.supported.includes(t);
  }
  static instances: FakeMediaRecorder[] = [];
  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(
    public stream: FakeStream,
    opts?: { mimeType?: string },
  ) {
    this.mimeType = opts?.mimeType ?? 'audio/webm';
    FakeMediaRecorder.instances.push(this);
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob([new Uint8Array([9, 9, 9])], { type: this.mimeType }) });
    this.onstop?.();
  }
}

type GlobalPatch = {
  navigator?: unknown;
  MediaRecorder?: unknown;
};
const g = globalThis as GlobalPatch;
const saved: GlobalPatch = {};

function installFakes(getUserMedia: (c: unknown) => Promise<unknown>) {
  g.navigator = { mediaDevices: { getUserMedia } };
  g.MediaRecorder = FakeMediaRecorder;
}

beforeEach(() => {
  saved.navigator = g.navigator;
  saved.MediaRecorder = g.MediaRecorder;
  FakeMediaRecorder.instances = [];
});

afterEach(() => {
  g.navigator = saved.navigator;
  g.MediaRecorder = saved.MediaRecorder;
  vi.restoreAllMocks();
});

/* ---- Degradation ---- */

describe('feature detection', () => {
  it('a bare node env (no mediaDevices, no MediaRecorder) is unsupported', () => {
    delete g.navigator;
    delete g.MediaRecorder;
    expect(isRecordingSupported()).toBe(false);
    expect(pickAudioMime()).toBe('');
  });

  it('startRecording in an unsupported env rejects with a TYPED error', async () => {
    delete g.navigator;
    delete g.MediaRecorder;
    await expect(startRecording()).rejects.toMatchObject({
      name: 'RecorderError',
      kind: 'unsupported',
    });
  });

  it('prefers webm/opus when the platform offers it', () => {
    installFakes(async () => new FakeStream());
    expect(isRecordingSupported()).toBe(true);
    expect(pickAudioMime()).toBe('audio/webm;codecs=opus');
  });

  it('permission denial maps to kind "denied"; missing device to "busy"', async () => {
    installFakes(async () => {
      throw new DOMException('nope', 'NotAllowedError');
    });
    await expect(startRecording()).rejects.toMatchObject({ kind: 'denied' });
    installFakes(async () => {
      throw new DOMException('nope', 'NotFoundError');
    });
    await expect(startRecording()).rejects.toMatchObject({ kind: 'busy' });
  });
});

/* ---- Lifecycle & mic release ---- */

describe('recording lifecycle', () => {
  it('stop() resolves with the clip and releases every track', async () => {
    const stream = new FakeStream();
    installFakes(async () => stream);
    const h = await startRecording();
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    const blob = await h.stop();
    expect(blob.size).toBeGreaterThan(0);
    expect(blob.type).toContain('audio/webm');
    expect(stream.tracks.every((t) => t.stopped)).toBe(true);
    // Idempotent: a second stop returns the same clip, no throw.
    expect(await h.stop()).toBe(blob);
  });

  it('cancel() discards the clip and still releases the mic', async () => {
    const stream = new FakeStream();
    installFakes(async () => stream);
    const h = await startRecording();
    h.cancel();
    expect(stream.tracks.every((t) => t.stopped)).toBe(true);
  });

  it('the max-duration cap auto-stops and fires the callback', async () => {
    vi.useFakeTimers();
    try {
      const stream = new FakeStream();
      installFakes(async () => stream);
      const onAutoStop = vi.fn();
      const h = await startRecording({ maxMs: 1_000, onAutoStop });
      vi.advanceTimersByTime(1_100);
      expect(onAutoStop).toHaveBeenCalledTimes(1);
      expect(stream.tracks.every((t) => t.stopped)).toBe(true);
      // The handle still yields the recorded-so-far clip after an auto-stop.
      const blob = await h.stop();
      expect(blob.size).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a cancelled recording never leaves an unhandled rejection behind', async () => {
    const stream = new FakeStream();
    installFakes(async () => stream);
    const h = await startRecording();
    h.cancel();
    // Give the microtask queue a beat; an orphaned rejection would trip
    // vitest's unhandled-rejection detector and fail the run.
    await new Promise((r) => setTimeout(r, 10));
    expect(stream.tracks.every((t) => t.stopped)).toBe(true);
  });
});
