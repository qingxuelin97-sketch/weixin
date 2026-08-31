/**
 * 通话 v2（M-I16）：接通之后她真的说话。
 *
 * M5 的通话壳只有计时器——"接通"与"挂断"之间是纯剧场。本模块补上中间那段：
 * 接通后生成开场台词，你按住说话（或打字）之后她逐句应答；台词逐句走 TTS
 * 播放，没有 TTS（或全开档禁声）时优雅降级为字幕模式。
 *
 * 硬约束（与单聊引擎一字不差地同源）：
 *   - tier 一律由 `effectiveTier(globalTier, persona.nsfwPermit)` 推导，调用点
 *     不得自造（specs/nsfw.md 的调用点禁令）；台词生成走 `getRouter()`，全开档
 *     由路由器锁死宽松通道，国内官方端点连降级兜底都不是。
 *   - **全开档禁用 TTS**：露骨文本永不出境到 MiniMax（`callTtsAllowed`），
 *     台词退为字幕。与 engine.voiceMeta 的 `ttsSkipped:'nsfw'` 同一条铁律。
 *   - 可打断：挂断/插话 = AbortController，未播队列直接丢弃（引擎的可打断设计）。
 *   - 通话轮次**不落聊天消息**（微信通话内容不进聊天记录）；挂断只落一条
 *     type:'call' 纪要（meta 带时长 + summary），承诺进 conv-state 的待办通道。
 *   - 时间由 `now()` 注入；本模块不读挂钟、不掷非种子随机（铁律 4）。
 */
import type { PersonaVM, ContactVM, MessageVM, NsfwTierVM } from '../data/types';
import type { Bubble } from '../llm/types';
import type { LlmRouter, NsfwTier, GenerateContext } from '../llm/router';
import { assembleSystemPrompt } from './prompt';
import { toPersonaView, effectiveTier, preferredRoute } from './engine';
import { selectFactsForInjection } from './memory';
import { renderTurns, humanDuration } from './render-msg';
import { getConvState, putConvState } from './conv-state';
import { getRouter } from '../llm/service';
import { isTtsAvailable, DEFAULT_VOICE } from '../llm/tts';
import { ensureVoiceAudio, playVoice, stopVoice } from '../lib/voice';
import { repo } from '../db/repo';
import { logError } from '../lib/errlog';
import { moodOf } from '../lib/mood';
import { affectFor, affectLine } from '../lib/affect';
import { lifelineAt, lifelineDirective, personaEpoch } from './lifeline';
import { goalDirective } from './goals';
import { goalStateFor } from './goal-service';
import { occasionsFor, occasionDirective, firstSpokeAt } from './occasions';
import { sensitivityForTier } from '../lib/nsfw-tier';

/* ==================================================================== */
/* 台词与场景                                                            */
/* ==================================================================== */

export interface CallTurn {
  speaker: 'self' | 'peer';
  text: string;
  at: number;
  /** 群语音 (M-J6c)：peer 行标注是谁说的；单聊通话恒缺省。 */
  speakerId?: string;
  speakerName?: string;
}

/** 铁律 6 的通话面：全开档台词绝不送 MiniMax TTS，退为字幕。 */
export function callTtsAllowed(tier: NsfwTier): boolean {
  return tier !== 'full';
}

/** 通话上下文取最近这么多条聊天消息（打电话的人记得刚聊过什么）。 */
const CALL_CONTEXT_WINDOW = 12;

/**
 * 场景补充块。追加在 `assembleSystemPrompt` 之后——六层顺序是宪法，新内容
 * 只往末尾加（与 engine 的 extraDirective 同一纪律），场景层由此注明
 * 「正在语音通话中」。
 */
const CALL_SCENE = `# 当前场景补充
你们正在语音通话中（不是打字聊天）：
- 你说的话是"嘴上说出来"的口语：短句、有语气词，一次 1~3 句就够。
- 只输出 {"type":"text","content":"..."} 气泡；不发表情包、不发图片、不写动作描写。
- 像真的在打电话：接话要快，别念稿子，别总结对话。`;

/** direction='in' 表示是她拨给你的（incoming）。 */
export function openerDirective(direction: 'in' | 'out'): string {
  return direction === 'in'
    ? '这通语音电话是你主动拨给对方的，对方刚接起来。你先开口，自然说清为什么打来（或者就是想听听声音），别客套。'
    : '对方刚拨通了你的语音电话，你接起来了。你先开口（"喂""怎么啦"这类），顺着你们最近聊的内容自然往下说。';
}

const REPLY_DIRECTIVE = '对方刚在电话里说了最后那句话，直接接话回应，口语短句，别重复对方的话。';

/**
 * 组装通话的 system prompt：persona + 关系 + NSFW 边界 + 记忆 + 场景，
 * 全部复用 `assembleSystemPrompt`（层序不动），场景补充块殿后。
 *
 * 同脑 (M-J1)：接电话的和发微信的是同一个人——mood/affect 进场景层，
 * lifeline → goal → occasion 依引擎惯例追加在 scene 之后、通话补充块之前。
 * 此前通话只有 persona+关系+记忆：同一天里她在聊天里备考、心情低落，
 * 电话一接却对两件事都毫无知觉。
 */
export async function buildCallSystem(opts: {
  peer: ContactVM;
  persona: PersonaVM;
  tier: NsfwTier;
  recent: MessageVM[];
  now: number;
  /** 会话 id（周年纪念锚点用）；缺省只跳过 anniversary，不影响其他层。 */
  convId?: string;
  /** 场景补充块覆盖（群语音换成群场景）；层序不动，只换殿后那一块。 */
  scene?: string;
}): Promise<string> {
  const { peer, persona, tier, recent, now } = opts;
  let facts: Awaited<ReturnType<typeof repo.getMemory>> = [];
  try {
    facts = await repo.getMemory(peer.id);
  } catch {
    /* 没有记忆也要能接电话 */
  }
  const query = recent
    .slice(-4)
    .map((m) => m.content ?? '')
    .join(' ')
    .slice(0, 200);
  const memory = selectFactsForInjection(facts, now, { surface: 'single', tier, query });
  // 关系层只带"用户是谁"——通话是两个人的事，社交图谱的其余部分留给聊天。
  const userRel = persona.relations?.user?.trim();
  // 心情 + 情绪脉冲，与引擎同一条线（affectFor 失败退回纯 mood）。
  const mood = moodOf(peer.id, now);
  const moodLine = await affectFor(peer.id, now)
    .then(({ affect }) => affectLine(mood.line, affect))
    .catch(() => mood.line);
  let system = assembleSystemPrompt({
    persona: toPersonaView(persona, peer.remark ?? peer.name),
    relations: userRel ? { user: userRel } : undefined,
    nsfwTier: tier,
    memory: memory.pinned.length || memory.topK.length ? memory : undefined,
    scene: { kind: 'single', now: new Date(now), moodLine },
  });
  const arcLine = lifelineDirective(lifelineAt(persona, now, personaEpoch(peer.id)));
  if (arcLine) system += `\n\n${arcLine}`;
  let goalLine = '';
  try {
    goalLine = goalDirective(await goalStateFor(peer.id, now), now);
  } catch {
    /* 目标层读不出来也要能接电话 */
  }
  if (goalLine) system += `\n\n${goalLine}`;
  const occasionLine = occasionDirective(
    occasionsFor({
      now,
      facts,
      firstMsgAt: opts.convId ? await firstSpokeAt(opts.convId).catch(() => undefined) : undefined,
    }),
  );
  if (occasionLine) system += `\n\n${occasionLine}`;
  return `${system}\n\n${opts.scene ?? CALL_SCENE}`;
}

/* ==================================================================== */
/* 通话会话                                                              */
/* ==================================================================== */

/** TTS 后端可注入（测试替身），默认接 voice.ts 的缓存+播放。 */
export interface CallTtsBackend {
  available: () => Promise<boolean>;
  ensure: (
    text: string,
    voiceId?: string,
    emotion?: string,
  ) => Promise<{ key: string; durationMs: number } | null>;
  play: (key: string, onEnded?: () => void) => Promise<boolean>;
  stop: () => void;
}

const DEFAULT_TTS: CallTtsBackend = {
  available: isTtsAvailable,
  ensure: ensureVoiceAudio,
  play: playVoice,
  stop: stopVoice,
};

export interface CallSessionOpts {
  convId: string;
  peer: ContactVM;
  persona: PersonaVM;
  globalTier: NsfwTierVM;
  /** 'in' = 她拨给你（incoming）；'out' = 你拨给她。 */
  direction: 'in' | 'out';
  /** 接通前的聊天上下文（近 N 条，调用方从 repo 取）。 */
  recent: MessageVM[];
  /** 注入的时钟——本模块自己不读挂钟。 */
  now: () => number;
  /** 每产生一句台词/一句你的话，推给 UI 上字幕。 */
  onLine: (turn: CallTurn) => void;
  /** 她"正在说话"的指示（字幕气泡/波形用）。 */
  onSpeaking?: (speaking: boolean) => void;
  /** voiceOn 定档时回调（start() 内、开场台词生成前）。 */
  onReady?: (voiceOn: boolean) => void;
  /** 测试注入；缺省走 getRouter()。 */
  router?: LlmRouter;
  tts?: CallTtsBackend;
  /** 字幕模式下每句的停留时长（测试传 () => 0 免等待）。 */
  pace?: (text: string) => number;
}

/**
 * 一通电话的对话状态机。台词只存在于内存（微信通话内容不进聊天记录），
 * 挂断后由调用方用 `summarizeCall` + `recordCallOutcome` 落纪要。
 */
export class CallSession {
  readonly turns: CallTurn[] = [];
  readonly tier: NsfwTier;
  /** start() 之后有效：false = 字幕模式（无 TTS key 或全开档禁声）。 */
  voiceOn = false;

  private ctrl: AbortController | null = null;
  private ended = false;
  /** 用户手动静音（切字幕模式）；与 voiceOn（能力）无关（M-J6）。 */
  private muted = false;
  private system = '';
  private startedAt = 0;
  private finalizePromise: Promise<string> | null = null;

  constructor(private o: CallSessionOpts) {
    // tier 在此推导一次，之后所有 LLM 调用都用它——调用点不得自造。
    this.tier = effectiveTier(o.globalTier, o.persona.nsfwPermit);
  }

  /** 接通：定档 voiceOn → 组装 system → 她先开口。 */
  async start(): Promise<void> {
    if (this.ended) return;
    this.startedAt = this.o.now();
    const tts = this.o.tts ?? DEFAULT_TTS;
    this.voiceOn = callTtsAllowed(this.tier) && (await tts.available().catch(() => false));
    this.o.onReady?.(this.voiceOn);
    this.system = await buildCallSystem({
      peer: this.o.peer,
      persona: this.o.persona,
      tier: this.tier,
      recent: this.o.recent,
      now: this.o.now(),
      convId: this.o.convId,
    });
    await this.respond(openerDirective(this.o.direction));
  }

  /**
   * Barge-in（M-J6）：你按下说话键的**瞬间**她闭嘴。此前打断要等
   * 录完 → 一次 ASR 往返 → userSaid 里的 abort——两三秒里两个人同时在说话，
   * 是整个通话里最出戏的时刻。半双工：按住期间她的在飞生成与播放全部废弃，
   * 会话不结束，松手转写完她照常接话。
   */
  holdFloor(): void {
    if (this.ended) return;
    this.ctrl?.abort();
    this.ctrl = null;
    (this.o.tts ?? DEFAULT_TTS).stop();
    this.o.onSpeaking?.(false);
  }

  /** 通话中把她静音/取消静音。静音立即停播当前句，后续句走字幕停留。 */
  setMuted(m: boolean): void {
    this.muted = m;
    if (m) (this.o.tts ?? DEFAULT_TTS).stop();
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** 你说了一句（ASR 转写或打字）：入上下文，她接话。打断她没说完的队列。 */
  async userSaid(text: string): Promise<void> {
    const t = text.trim();
    if (!t || this.ended) return;
    const turn: CallTurn = { speaker: 'self', text: t, at: this.o.now() };
    this.turns.push(turn);
    this.o.onLine(turn);
    await this.respond(REPLY_DIRECTIVE);
  }

  /**
   * 纪要落库（M-J1），幂等：第一次调用起跑，之后的调用（挂断分支、卸载分支、
   * 双击挂断）都拿同一个 promise——纪要绝不双写。返回纪要文本（空串 = 没
   * 什么可记）。挂断按钮之外的退出路径（返回手势→组件卸载→`end()`）此前
   * 根本不落纪要：电话里说好的事像没说过一样。
   */
  finalize(): Promise<string> {
    this.finalizePromise ??= this.runFinalize().catch((e) => {
      logError('call.finalize', e);
      return '';
    });
    return this.finalizePromise;
  }

  private async runFinalize(): Promise<string> {
    const turns = [...this.turns];
    if (turns.length === 0) return '';
    const durationMs = Math.max(0, this.o.now() - (this.startedAt || this.o.now()));
    const summary = await summarizeCall({
      convId: this.o.convId,
      peerName: this.o.peer.remark ?? this.o.peer.name,
      tier: this.tier,
      turns,
      durationMs,
      router: this.o.router,
    });
    await recordCallOutcome(
      this.o.convId,
      this.o.peer.id,
      summary,
      extractCallPromises(turns),
      this.o.now(),
      this.tier,
    );
    return summary;
  }

  /** 挂断：先落纪要（幂等、异步、不阻塞），再停掉一切在飞的生成与播放。 */
  end(): void {
    if (this.ended) return;
    // 纪要先行：turns 的快照在 finalize 里取，end 不清空它们，所以卸载路径
    // （CallPage cleanup 只调 end()）也一样落纪要——这正是 M-J1 修的洞。
    void this.finalize();
    this.ended = true;
    this.ctrl?.abort();
    (this.o.tts ?? DEFAULT_TTS).stop();
    this.o.onSpeaking?.(false);
  }

  /** 生成一轮她的话并逐句播出。新一轮开始即打断上一轮（引擎的可打断设计）。 */
  private async respond(directive: string): Promise<void> {
    this.ctrl?.abort();
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    try {
      const lines = await this.generate(directive, ctrl.signal);
      // 句间预取（M-J6）：单聊引擎「气泡到达即预热」的同一招搬进通话。此前
      // speak() 串行 ensure→play，每两句之间必然插进一次完整合成往返的静默，
      // 通话感被切碎。ensure 是内容寻址缓存，fire-and-forget 即可；播到第 n
      // 句时第 n+1 句多半已经在缓存里了。
      if (this.voiceOn && !this.muted) {
        const tts = this.o.tts ?? DEFAULT_TTS;
        for (const l of lines.slice(1)) {
          void tts.ensure(l, this.o.persona.ttsVoice ?? DEFAULT_VOICE).catch(() => {});
        }
      }
      for (const line of lines) {
        if (ctrl.signal.aborted || this.ended) return;
        const turn: CallTurn = { speaker: 'peer', text: line, at: this.o.now() };
        this.turns.push(turn);
        this.o.onLine(turn);
        this.o.onSpeaking?.(true);
        await this.speak(line, ctrl.signal);
        this.o.onSpeaking?.(false);
      }
    } catch (e) {
      this.o.onSpeaking?.(false);
      if (ctrl.signal.aborted || this.ended) return;
      logError('call.respond', e);
      // 路由器整条降级链都没走通——人设化兜底，绝不让原始报错上字幕。
      const turn: CallTurn = { speaker: 'peer', text: this.fallbackLine(), at: this.o.now() };
      this.turns.push(turn);
      this.o.onLine(turn);
    }
  }

  private fallbackLine(): string {
    const pet = this.o.persona.catchphrases?.[0];
    return pet ? `${pet}…喂？信号好像不太好` : '喂？信号好像不太好，你说话我这边听不清';
  }

  /** 一次台词生成：system(+directive) + 聊天近况 + 通话轮次 → 文本行。 */
  private async generate(directive: string, signal: AbortSignal): Promise<string[]> {
    const router = this.o.router ?? (await getRouter());
    const messages = [
      { role: 'system' as const, content: `${this.system}\n\n# 本次开口\n${directive}` },
      ...renderTurns(this.o.recent.slice(-CALL_CONTEXT_WINDOW), 'self', { includeVoiceText: true }),
      ...this.turns.map((t) => ({
        role: t.speaker === 'self' ? ('user' as const) : ('assistant' as const),
        content: t.text,
      })),
    ];
    const ctx: GenerateContext = {
      personaRefusal: () => [{ type: 'text', content: this.fallbackLine() } satisfies Bubble],
      prefixPrefill: this.tier !== 'off' ? '嗯' : undefined,
    };
    const bubbles: Bubble[] = [];
    for await (const b of router.generate(
      { role: 'chat', nsfwTier: this.tier, ...preferredRoute(this.o.persona.modelChat) },
      { messages, signal },
      ctx,
      `call:${this.o.convId}`,
    )) {
      bubbles.push(b);
    }
    return bubbles
      .filter((b) => b.type === 'text' || b.type === 'voice')
      .map((b) => b.content.trim())
      .filter(Boolean)
      .slice(0, 4);
  }

  /**
   * 播一句：有声走 TTS（合成+缓存+播放，播完为止，可被挂断打断）；
   * 字幕模式按句长停留。
   */
  private async speak(line: string, signal: AbortSignal): Promise<void> {
    const tts = this.o.tts ?? DEFAULT_TTS;
    if (this.voiceOn && !this.muted) {
      const audio = await tts.ensure(line, this.o.persona.ttsVoice ?? DEFAULT_VOICE).catch(() => null);
      if (signal.aborted) return;
      if (audio) {
        await new Promise<void>((resolve) => {
          let settled = false;
          const settle = () => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            resolve();
          };
          const onAbort = () => {
            tts.stop();
            settle();
          };
          signal.addEventListener('abort', onAbort, { once: true });
          void tts
            .play(audio.key, settle)
            .then((ok) => {
              if (!ok) settle();
            })
            .catch(settle);
        });
        return;
      }
      // 合成失败：这一句静默退为字幕停留，通话不中断。
    }
    const ms = this.o.pace ? this.o.pace(line) : Math.min(Math.max(800, line.length * 180), 4000);
    await sleep(ms, signal);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

/* ==================================================================== */
/* 挂断后的纪要                                                          */
/* ==================================================================== */

/**
 * 承诺样式的台词（"周五见""我给你带"）。比 conv-state 的 PROMISE_RE 多认
 * "说好/约好/周X"——电话里定下的事大多是时间地点。
 */
const CALL_PROMISE_RE =
  /(我(?:会|来|去|给你|帮你)|等我|回头|说好|约好|(?:明|后)天|周[一二三四五六日天末]|下次|到时候?)/;

export function extractCallPromises(turns: CallTurn[]): string[] {
  const out: string[] = [];
  for (const t of turns) {
    const text = t.text.trim();
    if (text.length < 4) continue;
    const clipped = text.slice(0, 30);
    if (CALL_PROMISE_RE.test(text) && !out.includes(clipped)) out.push(clipped);
  }
  return out.slice(0, 2);
}

/** 规则式纪要兜底——LLM 不可用时挂断也要有交代。纯函数。 */
export function ruleSummary(turns: CallTurn[], durationMs: number): string {
  const promised = extractCallPromises(turns);
  if (promised.length) return `电话里说好：${promised[0]}`;
  const last = [...turns].reverse().find((t) => t.text.trim().length >= 4);
  if (last) return `电话里聊到：${last.text.trim().slice(0, 24)}`;
  return `通了 ${humanDuration(durationMs)} 电话`;
}

const SUMMARY_SYSTEM =
  '把下面这通微信语音通话压缩成一句话纪要（30 字以内），优先记下双方的约定/承诺/待办' +
  '（时间、地点、答应做的事）；没有约定就概括聊了什么。只输出纪要本身，不要引号不要前缀。';

/**
 * 通话纪要：一次 LLM 调用（role=memory，tier 沿用通话推导值——通话原文携带
 * 会话内容，铁律 6 同样覆盖），失败落回规则式摘要。
 */
export async function summarizeCall(opts: {
  convId: string;
  peerName: string;
  tier: NsfwTier;
  turns: CallTurn[];
  durationMs: number;
  router?: LlmRouter;
}): Promise<string> {
  const { turns, durationMs } = opts;
  if (turns.length === 0) return '';
  try {
    const router = opts.router ?? (await getRouter());
    const transcript = turns
      .map((t) => `${t.speaker === 'self' ? '我' : (t.speakerName ?? opts.peerName)}: ${t.text}`)
      .join('\n')
      .slice(0, 3000);
    const r = await router.complete(
      { role: 'memory', nsfwTier: opts.tier },
      {
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM },
          { role: 'user', content: transcript },
        ],
      },
      {},
      `call:${opts.convId}`,
    );
    const line = r.text.trim().split('\n')[0]?.trim();
    if (line) return line.slice(0, 40);
  } catch (e) {
    logError('call.summarize', e);
  }
  return ruleSummary(turns, durationMs);
}

/**
 * 纪要落 conv-state 的承诺/待办通道：「电话里说好了周五见」从此可被后续
 * 聊天引用（convStateDirective 的"之前说过"行）。承诺优先；一条没有时
 * 用纪要本身垫上。上限与 conv-state 的 MAX_PROMISES 对齐（2）。
 *
 * 同脑扩容 (M-J1)：一通电话此前只在 conv-state 留两条承诺——记忆层对它
 * 一无所知，第二天聊天时那通电话就像没打过。现在同一次落库还写：
 *   - `memory_facts` 一条（importance 3，evidenceMsgIds 空——通话轮次
 *     本来就不落消息，没有可引的 msgId；sensitivity 按通话 tier 分级，
 *     全开档的纪要绝不流入朋友圈/群 prompt 的注入白名单）；
 *   - `conv_summaries` 的滚动摘要，让「上次你们聊到」也覆盖电话。
 */
export async function recordCallOutcome(
  convId: string,
  contactId: string,
  summary: string,
  promises: string[],
  now: number,
  tier: NsfwTier = 'off',
): Promise<void> {
  const entries = (promises.length ? promises : summary ? [summary] : []).map((s) =>
    s.trim().slice(0, 30),
  );
  if (entries.length === 0) return;
  const prev = await getConvState(convId);
  const merged = [...entries, ...prev.promises.filter((p) => !entries.includes(p))].slice(0, 2);
  await putConvState(convId, { ...prev, promises: merged, updatedAt: now });

  const line = (summary || entries[0]).trim().slice(0, 50);
  if (!line) return;
  try {
    await repo.putMemory({
      id: `mem_call_${convId}_${now}`,
      subjectId: contactId,
      fact: line.startsWith('电话') ? line : `电话里聊到：${line}`.slice(0, 50),
      importance: 3,
      sensitivity: sensitivityForTier(tier),
      evidenceMsgIds: [],
      status: 'confirmed',
      isPinned: false,
      createdAt: now,
      source: 'chat',
      confidence: 0.9,
    });
  } catch (e) {
    logError('call.memory', e);
  }
  try {
    const prevSummary = await repo.getConvSummary(convId);
    const combined = [prevSummary?.summary?.trim(), `刚通了电话：${line}`]
      .filter(Boolean)
      .join('；')
      .slice(-80);
    await repo.putConvSummary({
      convId,
      summary: combined,
      uptoMsgId: prevSummary?.uptoMsgId ?? 0,
      updatedAt: now,
    });
  } catch (e) {
    logError('call.summaryRow', e);
  }
}
