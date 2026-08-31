/**
 * 群语音通话 (M-J6c)。
 *
 * 单聊通话的骨架（CallSession）+ 群聊的灵魂（谁接话由调度决定）。设计要点：
 *
 *   - **成本闸**：每轮（开场/你说完一句）只有 **1 个演员发声** = 1 次 LLM 生成。
 *     「导演」是零成本纯函数（pickCallSpeaker，种子化加权轮盘），不是一次 LLM
 *     调用——通话对延迟敏感，一次导演往返就把接话速度打到出戏。
 *   - **每个人还是自己**：发言者的 system 走 buildCallSystem（她的记忆/心情/
 *     目标/纪念日全在），只把殿后的场景块换成群语音场景（在线名单 + 接话规矩）。
 *     同一个人在群语音里和在群文字里是同一颗脑子（M-J1 纪律）。
 *   - **铁律 6 分人**：tier 逐发言者推导（effectiveTier(globalTier, permit)），
 *     全开档成员的台词退字幕（callTtsAllowed），入站 ASR 闸用全场最严 tier。
 *   - 铁律 4：时间由 now() 注入；随机全部 seededRng。
 *   - 通话轮次不落聊天消息；挂断落一条 type:'call' + 纪要（与单聊同构）。
 */
import type { PersonaVM, ContactVM, MessageVM, NsfwTierVM } from '../data/types';
import type { Bubble } from '../llm/types';
import type { LlmRouter, NsfwTier, GenerateContext } from '../llm/router';
import {
  buildCallSystem,
  callTtsAllowed,
  summarizeCall,
  extractCallPromises,
  type CallTurn,
  type CallTtsBackend,
} from './call-script';
import { effectiveTier, preferredRoute } from './engine';
import { renderTranscript } from './render-msg';
import { getConvState, putConvState } from './conv-state';
import { getRouter } from '../llm/service';
import { isTtsAvailable, DEFAULT_VOICE } from '../llm/tts';
import { ensureVoiceAudio, playVoice, stopVoice } from '../lib/voice';
import { seededRng } from '../lib/money';
import { repo } from '../db/repo';
import { logError } from '../lib/errlog';
import { sensitivityForTier } from '../lib/nsfw-tier';

/** 群语音上限：宫格放得下、轮盘有意义、成本可控。超出的成员"没接"。 */
export const GROUP_CALL_MAX_MEMBERS = 6;

/** 一轮最多几路 LLM 生成——转红测试钉死这个数字（导演是纯函数，不计）。 */
export const GROUP_CALL_GEN_PER_ROUND = 1;

const CALL_CONTEXT_WINDOW = 14;

export interface GroupCallMember {
  contact: ContactVM;
  persona: PersonaVM;
}

const tierRank: Record<NsfwTier, number> = { off: 0, ambiguous: 1, full: 2 };

/** 全场最严 tier（入站 ASR 闸、纪要调用用它）。 */
export function strictestTier(tiers: NsfwTier[]): NsfwTier {
  return tiers.reduce((a, b) => (tierRank[b] > tierRank[a] ? b : a), 'off' as NsfwTier);
}

/**
 * 零成本"导演"：谁接话。加权轮盘（proactivity 越高越爱说），刚说过话的
 * 减半再减半（别独角戏），被点名的几乎必接（"小雨你说呢"）。种子化：
 * 同一 seed 同一结果，测试与回放皆可确定。
 */
export function pickCallSpeaker(opts: {
  members: ReadonlyArray<{ id: string; name: string; proactivity: number }>;
  lastSpeakerId?: string;
  userText?: string;
  seed: string;
}): string {
  const { members, lastSpeakerId, userText, seed } = opts;
  if (members.length === 0) throw new Error('pickCallSpeaker: empty roster');
  const weights = members.map((m) => {
    let w = 0.5 + Math.max(0, Math.min(1, m.proactivity));
    if (m.id === lastSpeakerId) w *= 0.35;
    if (userText && m.name && userText.includes(m.name)) w *= 25;
    return w;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = seededRng(seed)() * total;
  for (let i = 0; i < members.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return members[i].id;
  }
  return members[members.length - 1].id;
}

/** 群语音场景块（替换 CALL_SCENE 殿后）。 */
export function groupCallScene(title: string, names: string[], selfName: string): string {
  return `# 当前场景补充
你们正在群语音通话中（群「${title}」，线上：${names.join('、')}、对方）：
- 这是打电话不是打字：口语短句、有语气词，一次 1~2 句就够，别抢话也别演讲。
- 对话里「某某：」开头的是群里其他人说的话；没有名字前缀的是对方（${selfName}）在说。
- 你只代表你自己：别替别人说话、别一次演完全场、别报自己的名字。
- 只输出 {"type":"text","content":"..."} 气泡；不发表情图片、不写动作描写。`;
}

export interface GroupCallSessionOpts {
  convId: string;
  /** 群名（场景块用）。 */
  title: string;
  /** 上线的 AI 成员（调用方按 GROUP_CALL_MAX_MEMBERS 截断）。 */
  members: GroupCallMember[];
  globalTier: NsfwTierVM;
  /** 接通前的群聊上下文。 */
  recent: MessageVM[];
  now: () => number;
  onLine: (turn: CallTurn) => void;
  onSpeaking?: (speaking: boolean) => void;
  /** 谁在说（宫格高亮）；null = 没人在说。 */
  onSpeakingId?: (id: string | null) => void;
  onReady?: (voiceOn: boolean) => void;
  router?: LlmRouter;
  tts?: CallTtsBackend;
  pace?: (text: string) => number;
}

const DEFAULT_TTS: CallTtsBackend = {
  available: isTtsAvailable,
  ensure: ensureVoiceAudio,
  play: playVoice,
  stop: stopVoice,
};

/**
 * 一通群语音的状态机。与 CallSession 同一 host 接口（call-host 的
 * HostableCallSession）：holdFloor / setMuted / userSaid / finalize / end。
 */
export class GroupCallSession {
  readonly turns: CallTurn[] = [];
  /** 全场最严 tier——入站 ASR 闸与纪要走它（铁律 6 取严不取宽）。 */
  readonly tier: NsfwTier;
  voiceOn = false;

  private ctrl: AbortController | null = null;
  private ended = false;
  private muted = false;
  private round = 0;
  private lastSpeakerId: string | undefined;
  private startedAt = 0;
  private finalizePromise: Promise<string> | null = null;
  private readonly memberTier = new Map<string, NsfwTier>();
  private readonly systems = new Map<string, string>();

  constructor(private o: GroupCallSessionOpts) {
    for (const m of o.members) {
      this.memberTier.set(m.contact.id, effectiveTier(o.globalTier, m.persona.nsfwPermit));
    }
    this.tier = strictestTier([...this.memberTier.values()]);
  }

  get isMuted(): boolean {
    return this.muted;
  }

  private nameOf(m: GroupCallMember): string {
    return m.contact.remark ?? m.contact.name;
  }

  async start(): Promise<void> {
    if (this.ended || this.o.members.length === 0) return;
    this.startedAt = this.o.now();
    const tts = this.o.tts ?? DEFAULT_TTS;
    // 能力位：有 TTS 就能出声；逐句还要过发言者自己的 callTtsAllowed。
    this.voiceOn = (await tts.available().catch(() => false)) && this.tier !== 'full';
    this.o.onReady?.(this.voiceOn);
    await this.respond(
      '群语音刚接通，大家都在。你先开口招呼一声（"喂喂能听到吗""都在啊"这类），一两句就好。',
    );
  }

  holdFloor(): void {
    if (this.ended) return;
    this.ctrl?.abort();
    this.ctrl = null;
    (this.o.tts ?? DEFAULT_TTS).stop();
    this.o.onSpeaking?.(false);
    this.o.onSpeakingId?.(null);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (m) (this.o.tts ?? DEFAULT_TTS).stop();
  }

  async userSaid(text: string): Promise<void> {
    const t = text.trim();
    if (!t || this.ended) return;
    const turn: CallTurn = { speaker: 'self', text: t, at: this.o.now() };
    this.turns.push(turn);
    this.o.onLine(turn);
    await this.respond('对方刚在群语音里说了最后那句话。你接话回应，口语短句，别复述对方的话。', t);
  }

  finalize(): Promise<string> {
    this.finalizePromise ??= this.runFinalize().catch((e) => {
      logError('groupcall.finalize', e);
      return '';
    });
    return this.finalizePromise;
  }

  end(): void {
    if (this.ended) return;
    void this.finalize();
    this.ended = true;
    this.ctrl?.abort();
    (this.o.tts ?? DEFAULT_TTS).stop();
    this.o.onSpeaking?.(false);
    this.o.onSpeakingId?.(null);
  }

  /** 一轮 = 纯函数点将 + 恰好一次生成 + 逐句播出（成本闸就在这个形状里）。 */
  private async respond(directive: string, userText?: string): Promise<void> {
    this.ctrl?.abort();
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    this.round += 1;
    const speaker = this.pickSpeaker(userText);
    if (!speaker) return;
    try {
      const lines = await this.generate(speaker, directive, ctrl.signal);
      const sTier = this.memberTier.get(speaker.contact.id) ?? 'off';
      const speakAloud = this.voiceOn && !this.muted && callTtsAllowed(sTier);
      if (speakAloud) {
        const tts = this.o.tts ?? DEFAULT_TTS;
        for (const l of lines.slice(1)) {
          void tts.ensure(l, speaker.persona.ttsVoice ?? DEFAULT_VOICE).catch(() => {});
        }
      }
      for (const line of lines) {
        if (ctrl.signal.aborted || this.ended) return;
        const turn: CallTurn = {
          speaker: 'peer',
          text: line,
          at: this.o.now(),
          speakerId: speaker.contact.id,
          speakerName: this.nameOf(speaker),
        };
        this.turns.push(turn);
        this.lastSpeakerId = speaker.contact.id;
        this.o.onLine(turn);
        this.o.onSpeaking?.(true);
        this.o.onSpeakingId?.(speaker.contact.id);
        await this.speak(line, speaker, speakAloud, ctrl.signal);
        this.o.onSpeaking?.(false);
        this.o.onSpeakingId?.(null);
      }
    } catch (e) {
      this.o.onSpeaking?.(false);
      this.o.onSpeakingId?.(null);
      if (ctrl.signal.aborted || this.ended) return;
      logError('groupcall.respond', e);
      const turn: CallTurn = {
        speaker: 'peer',
        text: '喂？好像有点卡，你们还在吗',
        at: this.o.now(),
        speakerId: speaker.contact.id,
        speakerName: this.nameOf(speaker),
      };
      this.turns.push(turn);
      this.o.onLine(turn);
    }
  }

  private pickSpeaker(userText?: string): GroupCallMember | undefined {
    if (this.o.members.length === 0) return undefined;
    const id = pickCallSpeaker({
      members: this.o.members.map((m) => ({
        id: m.contact.id,
        name: this.nameOf(m),
        proactivity: m.persona.proactivity,
      })),
      lastSpeakerId: this.lastSpeakerId,
      userText,
      seed: `gcall:${this.o.convId}:${this.round}:${this.startedAt}`,
    });
    return this.o.members.find((m) => m.contact.id === id);
  }

  /** 发言者的 system 惰性组装一次（每人一份，整通电话内缓存）。 */
  private async systemFor(m: GroupCallMember): Promise<string> {
    const hit = this.systems.get(m.contact.id);
    if (hit) return hit;
    const names = this.o.members.filter((x) => x !== m).map((x) => this.nameOf(x));
    const sys = await buildCallSystem({
      peer: m.contact,
      persona: m.persona,
      tier: this.memberTier.get(m.contact.id) ?? 'off',
      recent: this.o.recent,
      now: this.o.now(),
      convId: this.o.convId,
      scene: groupCallScene(this.o.title, names, '用户'),
    });
    this.systems.set(m.contact.id, sys);
    return sys;
  }

  private async generate(
    m: GroupCallMember,
    directive: string,
    signal: AbortSignal,
  ): Promise<string[]> {
    const router = this.o.router ?? (await getRouter());
    const tier = this.memberTier.get(m.contact.id) ?? 'off';
    const names = new Map(this.o.members.map((x) => [x.contact.id, this.nameOf(x)]));
    const context = renderTranscript(this.o.recent.slice(-CALL_CONTEXT_WINDOW), {
      nameOf: (id) => (id === 'self' ? '用户' : (names.get(id) ?? 'TA')),
    });
    const system =
      (await this.systemFor(m)) + (context ? `\n\n# 接通前群里刚聊过\n${context}` : '');
    const messages = [
      { role: 'system' as const, content: `${system}\n\n# 本次开口\n${directive}` },
      ...this.turns.map((t) => {
        if (t.speaker === 'self') return { role: 'user' as const, content: t.text };
        return t.speakerId === m.contact.id
          ? { role: 'assistant' as const, content: t.text }
          : { role: 'user' as const, content: `${t.speakerName ?? 'TA'}：${t.text}` };
      }),
    ];
    const ctx: GenerateContext = {
      personaRefusal: () => [
        { type: 'text', content: '喂？好像有点卡，你们还在吗' } satisfies Bubble,
      ],
      prefixPrefill: tier !== 'off' ? '嗯' : undefined,
    };
    const bubbles: Bubble[] = [];
    for await (const b of router.generate(
      { role: 'chat', nsfwTier: tier, ...preferredRoute(m.persona.modelChat) },
      { messages, signal },
      ctx,
      `gcall:${this.o.convId}`,
    )) {
      bubbles.push(b);
    }
    return bubbles
      .filter((b) => b.type === 'text' || b.type === 'voice')
      .map((b) => b.content.trim())
      .filter(Boolean)
      .slice(0, 2);
  }

  private async speak(
    line: string,
    m: GroupCallMember,
    aloud: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const tts = this.o.tts ?? DEFAULT_TTS;
    if (aloud) {
      const audio = await tts
        .ensure(line, m.persona.ttsVoice ?? DEFAULT_VOICE)
        .catch(() => null);
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
    }
    const ms = this.o.pace ? this.o.pace(line) : Math.min(Math.max(800, line.length * 180), 4000);
    await new Promise<void>((resolve) => {
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

  private async runFinalize(): Promise<string> {
    const turns = [...this.turns];
    if (turns.length === 0) return '';
    const durationMs = Math.max(0, this.o.now() - (this.startedAt || this.o.now()));
    const summary = await summarizeCall({
      convId: this.o.convId,
      peerName: this.o.title,
      tier: this.tier,
      turns,
      durationMs,
      router: this.o.router,
    });
    await recordGroupCallOutcome({
      convId: this.o.convId,
      summary,
      promises: extractCallPromises(turns),
      spokeIds: [...new Set(turns.filter((t) => t.speakerId).map((t) => t.speakerId!))],
      now: this.o.now(),
      tier: this.tier,
    });
    return summary;
  }
}

/**
 * 群语音纪要三落（与单聊 recordCallOutcome 同构，按群改道）：
 *   - conv-state 承诺通道（群会话的「说好了周五聚」）；
 *   - conv_summaries 滚动摘要；
 *   - **每个开过口的成员**记一条 memory_facts（她记得这通群语音聊了什么；
 *     没说话的成员不记——她"没接"或全程潜水，不该凭空长记忆）。
 */
export async function recordGroupCallOutcome(opts: {
  convId: string;
  summary: string;
  promises: string[];
  spokeIds: string[];
  now: number;
  tier: NsfwTier;
}): Promise<void> {
  const { convId, summary, promises, spokeIds, now, tier } = opts;
  const entries = (promises.length ? promises : summary ? [summary] : []).map((s) =>
    s.trim().slice(0, 30),
  );
  if (entries.length === 0) return;
  const prev = await getConvState(convId);
  const merged = [...entries, ...prev.promises.filter((p) => !entries.includes(p))].slice(0, 2);
  await putConvState(convId, { ...prev, promises: merged, updatedAt: now });

  const line = (summary || entries[0]).trim().slice(0, 50);
  if (!line) return;
  for (const id of spokeIds.slice(0, GROUP_CALL_MAX_MEMBERS)) {
    try {
      await repo.putMemory({
        id: `mem_gcall_${convId}_${id}_${now}`,
        subjectId: id,
        fact: `群语音里聊到：${line}`.slice(0, 50),
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
      logError('groupcall.memory', e);
    }
  }
  try {
    const prevSummary = await repo.getConvSummary(convId);
    const combined = [prevSummary?.summary?.trim(), `刚开了群语音：${line}`]
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
    logError('groupcall.summaryRow', e);
  }
}
