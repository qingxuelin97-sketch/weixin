import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OpenAiCompatibleProvider } from '../../src/llm/openai-compatible';
import { type Bubble, type LlmError } from '../../src/llm/types';

/**
 * Web-only SSE streaming (M-I5).
 *
 * The contract under test: whole bubbles only (never half a sentence),
 * <think> spans dropped in-stream, a pre-first-bubble failure throws its own
 * kind (so the router can ladder) while a post-output break is reported as
 * `truncated` (the bubbles stand, the turn is closed in character upstream),
 * and the native transport path never grows a stream reader.
 */

const provider = () =>
  new OpenAiCompatibleProvider({
    id: 'test',
    kind: 'test',
    baseUrl: 'https://api.example.com/v1',
    getKey: async () => 'k',
  });

/** Build a fetch Response whose body streams the given chunks. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

const frame = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n`;

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
});

async function collect(iter: AsyncIterable<Bubble>): Promise<Bubble[]> {
  const out: Bubble[] = [];
  for await (const b of iter) out.push(b);
  return out;
}

describe('generateStream', () => {
  it('yields whole bubbles at NDJSON line boundaries, across chunk splits', async () => {
    const line1 = JSON.stringify({ type: 'text', content: '来了来了' });
    const line2 = JSON.stringify({ type: 'text', content: '等我五分钟' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          frame(line1.slice(0, 8)), // a bubble split across two SSE frames
          frame(line1.slice(8) + '\n'),
          frame(line2 + '\n'),
          'data: [DONE]\n',
        ]),
      ),
    );
    const out = await collect(provider().generateStream({ model: 'm', messages: [] }));
    expect(out).toHaveLength(2);
    expect(out[0].content).toBe('来了来了');
    expect(out[1].content).toBe('等我五分钟');
  });

  it('drops <think> spans that stream inline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          frame('<think>要不要用'),
          frame('表情呢</think>'),
          frame('好啦不闹了\n'),
        ]),
      ),
    );
    const out = await collect(provider().generateStream({ model: 'm', messages: [] }));
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe('好啦不闹了');
  });

  it('flushes a final line that never got its newline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([frame('最后一句没换行')])));
    const out = await collect(provider().generateStream({ model: 'm', messages: [] }));
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe('最后一句没换行');
  });

  /** Yields one bubble, then the connection dies on the next read. */
  function brokenAfterFirst(): Response {
    const encoder = new TextEncoder();
    // pull-based: first read delivers a bubble, the next read errors — with
    // start()+error() the queued chunk would be DISCARDED and nothing yields.
    let pulls = 0;
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls === 1) controller.enqueue(encoder.encode(frame('第一条\n')));
        else controller.error(new Error('conn reset'));
      },
    });
    return new Response(broken, { status: 200 });
  }

  it('throws its own kind before the first bubble, so the router can ladder', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await expect(collect(provider().generateStream({ model: 'm', messages: [] }))).rejects.toThrow();
  });

  it('a break AFTER output keeps the bubbles and reports truncation (M-I5)', async () => {
    // Swallowing this is what left a reply hanging in mid-air: the shown
    // bubbles are right, but the caller has to KNOW the turn never finished.
    vi.stubGlobal('fetch', vi.fn(async () => brokenAfterFirst()));
    const out: Bubble[] = [];
    let thrown: unknown;
    try {
      for await (const b of provider().generateStream({ model: 'm', messages: [] })) out.push(b);
    } catch (e) {
      thrown = e;
    }
    expect(out).toHaveLength(1); // what landed, stands
    expect(out[0].content).toBe('第一条');
    expect((thrown as LlmError).kind).toBe('truncated');
  });

  it('a user abort is NOT truncation — nobody tacks "先不说了" onto an interrupted turn', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => brokenAfterFirst()));
    const ctrl = new AbortController();
    const out: Bubble[] = [];
    let thrown: unknown;
    try {
      for await (const b of provider().generateStream({
        model: 'm',
        messages: [],
        signal: ctrl.signal,
      })) {
        out.push(b);
        ctrl.abort(); // a new send lands while she is mid-turn
      }
    } catch (e) {
      thrown = e;
    }
    expect(out).toHaveLength(1);
    expect(thrown).toBeUndefined();
  });

  it('an abnormal finish_reason counts as truncation even on a clean close', async () => {
    // max_tokens cut her off: the socket closed politely, the sentence did not.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          frame('说到一半\n'),
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n`,
          'data: [DONE]\n',
        ]),
      ),
    );
    const out: Bubble[] = [];
    let thrown: unknown;
    try {
      for await (const b of provider().generateStream({ model: 'm', messages: [] })) out.push(b);
    } catch (e) {
      thrown = e;
    }
    expect(out).toHaveLength(1);
    expect((thrown as LlmError).kind).toBe('truncated');
  });

  it('a normal finish_reason=stop stream ends without a truncation marker', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          frame('说完了\n'),
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n`,
          'data: [DONE]\n',
        ]),
      ),
    );
    const out = await collect(provider().generateStream({ model: 'm', messages: [] }));
    expect(out).toHaveLength(1);
  });

  it('canStream says no on native WITHOUT the bridge — CapacitorHttp cannot stream', () => {
    // M-J5: a native platform with the OkHttp bridge installed streams (see
    // j5-native-sse.test.ts). This case pins the other side: no bridge in the
    // seam (old APK, stripped build, tests) → the one-shot path stays the
    // correct transport, and nothing quietly assumes fetch-streaming works.
    expect(provider().canStream()).toBe(true);
    (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
    expect(provider().canStream()).toBe(false);
  });

  it('the native transport never grows a stream reader (source guard)', () => {
    const http = readFileSync(resolve(__dirname, '../../src/llm/http.ts'), 'utf8');
    expect(http.includes('getReader')).toBe(false);
    expect(http.includes('EventSource')).toBe(false);
  });
});
