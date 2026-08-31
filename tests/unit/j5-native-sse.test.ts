import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The Capacitor bridge, stubbed: tests drive the listener side by hand. */
const bridgeMock = vi.hoisted(() => {
  const listeners: Array<(ev: unknown) => void> = [];
  return {
    listeners,
    emit: (ev: unknown) => listeners.forEach((l) => l(ev)),
    sseStart: vi.fn(async (_o: unknown) => {}),
    sseCancel: vi.fn(async (_id: string) => {}),
    addSseLineListener: vi.fn((cb: (ev: unknown) => void) => {
      listeners.push(cb);
      return () => {};
    }),
    sseSupported: vi.fn(() => true),
  };
});
vi.mock('../../src/native/bridge', () => ({
  sseStart: bridgeMock.sseStart,
  sseCancel: bridgeMock.sseCancel,
  addSseLineListener: bridgeMock.addSseLineListener,
  sseSupported: bridgeMock.sseSupported,
}));

import { SseHub, openNativeSse } from '../../src/native/sse-bridge';
import {
  OpenAiCompatibleProvider,
  resetHealCooldown,
  type ProviderConfig,
} from '../../src/llm/openai-compatible';
import {
  setNativeSseTransport,
  type NativeSseTransport,
  type SseStreamHandle,
  type SseStreamRequest,
} from '../../src/llm/sse-transport';
import { type Bubble, LlmError } from '../../src/llm/types';

/**
 * M-J5 — 原生 SSE 流式桥 + 流式收口。
 *
 * 三层各自转红：
 *  ① SseHub：listener 事件流 → 按 id 分发的 AsyncIterable（乱序 id、错误、
 *     取消、背压、真拒绝的超时）；
 *  ② Provider 接线：装了原生 transport 就走桥、一根 fetch 都不碰；4xx 的
 *     错误体被收集并分类（bad_model 自愈因此在流式路径上也能点火）；
 *  ③ 流式收口：fallbackBaseUrl 只在首字节前换域；重试永远发生在首气泡之前，
 *     首气泡之后只有 truncated——降级链的交界一毫米都不许移。
 */

/* ================================ ① SseHub ================================ */

describe('SseHub — listener 事件到 AsyncIterable 的纯逻辑', () => {
  afterEach(() => vi.useRealTimers());

  async function take(lines: AsyncIterable<string>, n: number): Promise<string[]> {
    const out: string[] = [];
    for await (const l of lines) {
      out.push(l);
      if (out.length >= n) break;
    }
    return out;
  }

  it('交错的两条连接各自拿到自己的行，顺序不乱', async () => {
    const hub = new SseHub();
    const a = hub.create('a');
    const b = hub.create('b');
    hub.dispatch({ id: 'a', open: true, status: 200 });
    hub.dispatch({ id: 'b', open: true, status: 200 });
    hub.dispatch({ id: 'a', line: 'a1' });
    hub.dispatch({ id: 'b', line: 'b1' });
    hub.dispatch({ id: 'a', line: 'a2' });
    hub.dispatch({ id: 'a', done: true, status: 200 });
    hub.dispatch({ id: 'b', line: 'b2' });
    hub.dispatch({ id: 'b', done: true, status: 200 });
    await expect(a.opened).resolves.toBe(200);
    const gotA: string[] = [];
    for await (const l of a.lines) gotA.push(l);
    const gotB: string[] = [];
    for await (const l of b.lines) gotB.push(l);
    expect(gotA).toEqual(['a1', 'a2']);
    expect(gotB).toEqual(['b1', 'b2']);
  });

  it('未知/迟到 id 的事件被丢弃，不炸也不串台', () => {
    const hub = new SseHub();
    // A cancelled turn's stragglers, malformed payloads, someone else's id:
    expect(() => {
      hub.dispatch({ id: 'ghost', line: 'x' });
      hub.dispatch({ line: 'no id at all' });
      hub.dispatch(null);
      hub.dispatch('garbage');
    }).not.toThrow();
    expect(hub.size()).toBe(0);
  });

  it('背压：先 pull 后到的行会唤醒挂着的 pull', async () => {
    const hub = new SseHub();
    const ch = hub.create('p');
    hub.dispatch({ id: 'p', open: true, status: 200 });
    const it = ch.lines[Symbol.asyncIterator]();
    const pending = it.next(); // parked BEFORE any line exists
    hub.dispatch({ id: 'p', line: 'late' });
    await expect(pending).resolves.toEqual({ value: 'late', done: false });
  });

  it('error 事件：先排队的行仍然交付，流的结尾才是错误', async () => {
    const hub = new SseHub();
    const ch = hub.create('e');
    hub.dispatch({ id: 'e', open: true, status: 200 });
    hub.dispatch({ id: 'e', line: 'delivered' });
    hub.dispatch({ id: 'e', error: 'conn reset' });
    const it = ch.lines[Symbol.asyncIterator]();
    await expect(it.next()).resolves.toEqual({ value: 'delivered', done: false });
    await expect(it.next()).rejects.toThrow(/conn reset/);
  });

  it('open 之前就 error → opened 这个 promise 被拒绝', async () => {
    const hub = new SseHub();
    const ch = hub.create('x');
    hub.dispatch({ id: 'x', error: 'dns fail' });
    await expect(ch.opened).rejects.toThrow(/dns fail/);
  });

  it('打开超时是真拒绝：无响应头 → opened REJECTS（不是永远挂着）', async () => {
    vi.useFakeTimers();
    const hub = new SseHub(1_000, 60_000);
    const ch = hub.create('t');
    const settled = ch.opened.then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(settled).resolves.toContain('no response head');
  });

  it('读停摆是真拒绝：挂着的 pull 在 stall 窗口后 REJECTS', async () => {
    vi.useFakeTimers();
    const hub = new SseHub(60_000, 2_000);
    const ch = hub.create('s');
    hub.dispatch({ id: 's', open: true, status: 200 });
    const it = ch.lines[Symbol.asyncIterator]();
    const settled = it.next().then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await vi.advanceTimersByTimeAsync(2_001);
    await expect(settled).resolves.toContain('no data');
  });

  it('fail() 注入（abort 路径）：挂着的 pull 立刻被拒绝，无需等原生回包', async () => {
    const hub = new SseHub();
    const ch = hub.create('ab');
    hub.dispatch({ id: 'ab', open: true, status: 200 });
    const it = ch.lines[Symbol.asyncIterator]();
    const pending = it.next();
    hub.fail('ab', new Error('aborted'));
    await expect(pending).rejects.toThrow('aborted');
  });

  it('drop 之后：map 清空（不漏内存）、后续事件被忽略、for-await 早退也会 drop', async () => {
    const hub = new SseHub();
    const ch = hub.create('d');
    hub.dispatch({ id: 'd', open: true, status: 200 });
    hub.dispatch({ id: 'd', line: '1' });
    hub.dispatch({ id: 'd', line: '2' });
    expect(hub.size()).toBe(1);
    // Early break from for-await triggers iterator.return → drop.
    await take(ch.lines, 1);
    expect(hub.size()).toBe(0);
    expect(() => hub.dispatch({ id: 'd', line: 'late' })).not.toThrow();
  });

  it('done 收尾后正常完结，排队的行先于完结交付', async () => {
    const hub = new SseHub();
    const ch = hub.create('ok');
    hub.dispatch({ id: 'ok', open: true, status: 200 });
    hub.dispatch({ id: 'ok', line: 'l1' });
    hub.dispatch({ id: 'ok', done: true, status: 200 });
    const got: string[] = [];
    for await (const l of ch.lines) got.push(l);
    expect(got).toEqual(['l1']);
  });
});

/* ==================== ①.5 openNativeSse — 桥到 hub 的接线 ==================== */

describe('openNativeSse — 事件通道、取消语义、序列化边界', () => {
  beforeEach(() => {
    bridgeMock.sseStart.mockClear();
    bridgeMock.sseCancel.mockClear();
  });

  const lastStart = () =>
    bridgeMock.sseStart.mock.calls.at(-1)![0] as {
      id: string;
      url: string;
      headersJson: string;
      bodyJson: string;
    };

  it('headers/body 各字符串化一次；open 事件回来才拿到 status；行照序流出', async () => {
    const p = openNativeSse({
      url: 'https://gw.example/v1/chat/completions',
      headers: { Authorization: 'Bearer k' },
      body: { model: 'm', stream: true },
    });
    const arg = lastStart();
    expect(arg.url).toBe('https://gw.example/v1/chat/completions');
    expect(JSON.parse(arg.headersJson)).toEqual({ Authorization: 'Bearer k' });
    expect(JSON.parse(arg.bodyJson)).toEqual({ model: 'm', stream: true });
    bridgeMock.emit({ id: arg.id, open: true, status: 200 });
    const h = await p;
    expect(h.status).toBe(200);
    bridgeMock.emit({ id: arg.id, line: 'data: x' });
    bridgeMock.emit({ id: arg.id, done: true, status: 200 });
    const got: string[] = [];
    for await (const l of h.lines) got.push(l);
    expect(got).toEqual(['data: x']);
    h.cancel();
    expect(bridgeMock.sseCancel).toHaveBeenCalledWith(arg.id);
  });

  it('signal.abort → 立刻本地拒绝（不等原生回包）+ sseCancel 通知原生关连接', async () => {
    const ctrl = new AbortController();
    const p = openNativeSse({ url: 'u', headers: {}, body: {}, signal: ctrl.signal });
    const arg = lastStart();
    bridgeMock.emit({ id: arg.id, open: true, status: 200 });
    const h = await p;
    const it = h.lines[Symbol.asyncIterator]();
    const pending = it.next();
    ctrl.abort();
    await expect(pending).rejects.toThrow('aborted');
    expect(bridgeMock.sseCancel).toHaveBeenCalledWith(arg.id);
  });

  it('sseStart 本身被拒（桥超时）→ open promise 拒绝且本地通道被清走', async () => {
    bridgeMock.sseStart.mockRejectedValueOnce(new Error('native sseStart timed out after 8000ms'));
    await expect(openNativeSse({ url: 'u', headers: {}, body: {} })).rejects.toThrow(
      /timed out/,
    );
    // The failed channel must not leak: its id was cancelled + dropped.
    expect(bridgeMock.sseCancel).toHaveBeenCalled();
  });

  it('预先已 abort 的 signal：一个字节都不该发出去', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    bridgeMock.sseStart.mockClear();
    await expect(
      openNativeSse({ url: 'u', headers: {}, body: {}, signal: ctrl.signal }),
    ).rejects.toThrow('aborted');
    expect(bridgeMock.sseStart).not.toHaveBeenCalled();
  });
});

/* ==================== ② provider 接线：原生走桥，不碰 fetch ==================== */

const sseFrame = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`;
const doneFrame = 'data: [DONE]';

function fakeTransport(script: (req: SseStreamRequest) => SseStreamHandle | Promise<SseStreamHandle>) {
  const opens: SseStreamRequest[] = [];
  const transport: NativeSseTransport = {
    available: () => true,
    open: async (req) => {
      opens.push(req);
      return script(req);
    },
  };
  return { transport, opens };
}

function handleOf(status: number, lines: string[], cancel = vi.fn()): SseStreamHandle {
  return {
    status,
    lines: (async function* () {
      for (const l of lines) yield l;
    })(),
    cancel,
  };
}

const provider = (over: Partial<ProviderConfig> = {}) =>
  new OpenAiCompatibleProvider({
    id: 'test',
    kind: 'test',
    baseUrl: 'https://api-a.example/v1',
    getKey: async () => 'k',
    ...over,
  });

async function collect(iter: AsyncIterable<Bubble>): Promise<Bubble[]> {
  const out: Bubble[] = [];
  for await (const b of iter) out.push(b);
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setNativeSseTransport(null);
  resetHealCooldown();
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
});

describe('generateStream 原生路径（M-J5）', () => {
  it('装了原生 transport：整轮流式不发一根 fetch，气泡照常逐条产出', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('native path must not fetch');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const cancel = vi.fn();
    const { transport, opens } = fakeTransport(() =>
      handleOf(
        200,
        [
          sseFrame(JSON.stringify({ type: 'text', content: '来了' }) + '\n'),
          sseFrame(JSON.stringify({ type: 'text', content: '等我' }) + '\n'),
          doneFrame,
        ],
        cancel,
      ),
    );
    setNativeSseTransport(transport);
    const out = await collect(provider().generateStream({ model: 'm', messages: [] }));
    expect(out.map((b) => b.content)).toEqual(['来了', '等我']);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(opens).toHaveLength(1);
    expect(opens[0].url).toBe('https://api-a.example/v1/chat/completions');
    // The provider's auth + body ride the transport verbatim.
    expect(opens[0].headers.Authorization).toBe('Bearer k');
    expect((opens[0].body as { stream?: boolean }).stream).toBe(true);
    // Teardown always happens, even on clean completion.
    expect(cancel).toHaveBeenCalled();
  });

  it('canStream：原生平台 + transport 可用 → true（没有桥仍是 false）', () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
    expect(provider().canStream()).toBe(false); // no bridge: one-shot stays correct
    const { transport } = fakeTransport(() => handleOf(200, []));
    setNativeSseTransport(transport);
    expect(provider().canStream()).toBe(true);
  });

  it('4xx：错误体的行被收集成真实错误信息（auth 不是 unknown），且连接被关掉', async () => {
    const cancel = vi.fn();
    const { transport } = fakeTransport(() =>
      handleOf(401, ['{"error":{"message":"Invalid API key"}}'], cancel),
    );
    setNativeSseTransport(transport);
    let thrown: unknown;
    try {
      await collect(provider().generateStream({ model: 'm', messages: [] }));
    } catch (e) {
      thrown = e;
    }
    expect((thrown as LlmError).kind).toBe('auth');
    expect((thrown as LlmError).message).toContain('Invalid API key');
    expect(cancel).toHaveBeenCalled();
  });

  it('原生流式的 bad_model 自愈：4xx 说模型不在了 → 拉目录 → 换新 id 重连一次', async () => {
    // The catalog GET rides httpJson → (test env) fetch; the STREAM rides the
    // native transport. Both spies below pin which path carried what.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/models')) {
          return new Response(JSON.stringify({ data: [{ id: 'old-2' }, { id: 'new-1' }] }), {
            status: 200,
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    const refreshed = vi.fn();
    const { transport, opens } = fakeTransport((req) => {
      const model = (req.body as { model: string }).model;
      if (model === 'old-1') {
        return handleOf(401, ['{"error":{"type":"ModelError","message":"Model old-1 is not supported"}}']);
      }
      return handleOf(200, [sseFrame(JSON.stringify({ type: 'text', content: '新模型好了' }) + '\n'), doneFrame]);
    });
    setNativeSseTransport(transport);
    const out = await collect(
      provider({ defaultModels: ['old-1'], onCatalogRefresh: refreshed }).generateStream({
        model: 'old-1',
        messages: [],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe('新模型好了');
    expect(opens).toHaveLength(2);
    expect((opens[1].body as { model: string }).model).toBe('old-2'); // closestModel('old-1', …)
    expect(refreshed).toHaveBeenCalledWith(['old-2', 'new-1'], 'old-2');
  });
});

/* ==================== ③ 流式收口：fallbackBaseUrl 与交界 ==================== */

/** Build a fetch Response whose body streams the given chunks. */
function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

const chunkFrame = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n`;

describe('generateStream 的 fallbackBaseUrl（web 路径，M-J5 收口）', () => {
  const cfgWithFallback = () =>
    provider({ fallbackBaseUrl: 'https://api-b.example/v1' });

  it('首字节前网络失败 → 换备用域重试一次，气泡从备用域来', async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (String(url).startsWith('https://api-a.example')) throw new TypeError('network down');
      return streamResponse([chunkFrame(JSON.stringify({ type: 'text', content: '备用域来的' }) + '\n')]);
    });
    vi.stubGlobal('fetch', fetchSpy);
    const out = await collect(cfgWithFallback().generateStream({ model: 'm', messages: [] }));
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe('备用域来的');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[1][0])).toMatch(/^https:\/\/api-b\.example/);
  });

  it('auth 失败不换域：第二个域只会烧同一把坏钥匙', async () => {
    const fetchSpy = vi.fn(
      async () => new Response('{"error":{"message":"Invalid API key"}}', { status: 401 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    await expect(
      collect(cfgWithFallback().generateStream({ model: 'm', messages: [] })),
    ).rejects.toMatchObject({ kind: 'auth' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('降级链交界不动：首气泡之后断流 → truncated，绝不去碰备用域', async () => {
    // One bubble lands, then the connection dies. With a fallback CONFIGURED,
    // the temptation is to re-ask on domain B — but the user has read half the
    // reply; a second request would answer the same turn twice.
    const encoder = new TextEncoder();
    let pulls = 0;
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls === 1) controller.enqueue(encoder.encode(chunkFrame('第一条\n')));
        else controller.error(new Error('conn reset'));
      },
    });
    const fetchSpy = vi.fn(async () => new Response(broken, { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const out: Bubble[] = [];
    let thrown: unknown;
    try {
      for await (const b of cfgWithFallback().generateStream({ model: 'm', messages: [] }))
        out.push(b);
    } catch (e) {
      thrown = e;
    }
    expect(out).toHaveLength(1);
    expect((thrown as LlmError).kind).toBe('truncated');
    expect(fetchSpy).toHaveBeenCalledTimes(1); // the boundary: NO second request
  });

  it('用户 abort 不换域：中断的请求不由备用域替他答完', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const fetchSpy = vi.fn(async () => {
      throw new Error('aborted');
    });
    vi.stubGlobal('fetch', fetchSpy);
    await expect(
      collect(
        cfgWithFallback().generateStream({ model: 'm', messages: [], signal: ctrl.signal }),
      ),
    ).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('web 流式的 bad_model 自愈：401 + Model not supported → 目录 → 新 id 第二连', async () => {
    const posts: string[] = [];
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'old-2' }] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { model: string };
      posts.push(body.model);
      if (body.model === 'old-1') {
        return new Response(
          '{"error":{"type":"ModelError","message":"Model old-1 is not supported"}}',
          { status: 401 },
        );
      }
      return streamResponse([chunkFrame(JSON.stringify({ type: 'text', content: '自愈了' }) + '\n')]);
    });
    vi.stubGlobal('fetch', fetchSpy);
    const out = await collect(
      provider({ defaultModels: ['old-1'] }).generateStream({ model: 'old-1', messages: [] }),
    );
    expect(out[0].content).toBe('自愈了');
    expect(posts).toEqual(['old-1', 'old-2']);
  });
});

/* ==================== 接线守卫：写了没接线 = 没做 ==================== */

const ROOT = resolve(__dirname, '..', '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

describe('M-J5 接线与 Kotlin 侧源码守卫', () => {
  it('main.tsx 在启动时安装原生 transport（否则 canStream 永远问不到桥）', () => {
    const src = read('src/main.tsx');
    expect(src).toMatch(/from '\.\/native\/sse-bridge'/);
    expect(src).toMatch(/installNativeSse\(\)/);
  });

  it('provider 真的从 seam 读 transport，sse-bridge 真的往 seam 写', () => {
    expect(read('src/llm/openai-compatible.ts')).toMatch(/getNativeSseTransport/);
    expect(read('src/native/sse-bridge.ts')).toMatch(/setNativeSseTransport\(/);
  });

  it('SseBridge.kt：OkHttp 流式读、双向超时、事件协议齐全', () => {
    const kt = read('android/app/src/main/java/com/personal/weixinai/aiwx/SseBridge.kt');
    expect(kt).toMatch(/okhttp3/);
    expect(kt).toMatch(/CONNECT_TIMEOUT_S = 20L/);
    expect(kt).toMatch(/READ_TIMEOUT_S = 60L/);
    expect(kt).toMatch(/readUtf8Line/);
    // The four event shapes:
    for (const needle of ['"open"', '"line"', '"done"', '"error"', '"status"']) {
      expect(kt).toContain(needle);
    }
  });

  it('插件类只留转发：sseStart/sseCancel/@destroy 全关，事件走 sseLine', () => {
    const kt = read('android/app/src/main/java/com/personal/weixinai/aiwx/AiwxNativePlugin.kt');
    expect(kt).toMatch(/fun sseStart\(call: PluginCall\)/);
    expect(kt).toMatch(/fun sseCancel\(call: PluginCall\)/);
    expect(kt).toMatch(/notifyListeners\("sseLine"/);
    expect(kt).toMatch(/handleOnDestroy[\s\S]{0,120}?sse\.destroy\(\)/);
    // OkHttp mechanics stay OUT of the plugin monolith.
    expect(kt).not.toMatch(/OkHttpClient/);
  });

  it('gradle 钉死 OkHttp 具体版本（不许飘 +）', () => {
    const gradle = read('android/app/build.gradle');
    expect(gradle).toMatch(/com\.squareup\.okhttp3:okhttp:\d+\.\d+\.\d+/);
    expect(gradle).not.toMatch(/okhttp3:okhttp:[^"']*\+/);
  });

  it('JS 桥超时是真拒绝：sseStart 走 withDeadline，挂起的桥调用不会永远 await', () => {
    const src = read('src/native/bridge.ts');
    expect(src).toMatch(/withDeadline\(plugin\.sseStart/);
    expect(src).toMatch(/withDeadline\(plugin\.sseCancel/);
  });
});
