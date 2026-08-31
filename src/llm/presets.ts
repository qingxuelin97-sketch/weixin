/**
 * First-class provider presets. Each is a normal OpenAI-compatible slot with
 * calibrated defaults; the user can add more custom slots. base_url and models
 * are user-editable — nothing is hardcoded past these defaults (Zen's catalog
 * rotates; MiniMax's TTS/model ids version every few months).
 */
import { OpenAiCompatibleProvider, type ProviderConfig } from './openai-compatible';
import type { GenerateOptions } from './types';

export interface PresetDescriptor {
  kind: string;
  label: string;
  baseUrl: string;
  fallbackBaseUrl?: string;
  defaultModels: string[];
  /** Which model to use for each routing role by default. */
  roleDefaults: Partial<Record<'chat' | 'director' | 'memory' | 'reasoning', string>>;
  note?: string;
}

export const PRESETS: Record<string, PresetDescriptor> = {
  deepseek: {
    kind: 'deepseek',
    label: 'DeepSeek（国内直连）',
    baseUrl: 'https://api.deepseek.com',
    defaultModels: ['deepseek-chat', 'deepseek-reasoner'],
    roleDefaults: {
      chat: 'deepseek-chat',
      director: 'deepseek-chat',
      memory: 'deepseek-chat',
      reasoning: 'deepseek-reasoner',
    },
    note: '稳定前缀吃上下文缓存；官方端点有内容审核，全开档勿走此路由。',
  },
  minimax: {
    kind: 'minimax',
    label: 'MiniMax（国内直连，含 TTS）',
    baseUrl: 'https://api.minimaxi.com/v1',
    defaultModels: ['MiniMax-M2.5', 'MiniMax-M2'],
    roleDefaults: { chat: 'MiniMax-M2.5' },
    note: 'TTS 走 /t2a_v2（见 tts.ts）。输入/输出双侧审核（1026/1027）。模型目录会更新，用「拉取模型列表」同步。',
  },
  zen: {
    kind: 'zen',
    label: 'OpenCode Zen（走代理，宽松通道）',
    baseUrl: 'https://opencode.ai/zen/v1',
    defaultModels: ['big-pickle', 'deepseek-v4-flash-free', 'mimo-v2.5-free'],
    roleDefaults: { chat: 'big-pickle' },
    note: '精选网关、目录轮换快（旧 id 会报 model not supported）——配好 key 后先「拉取模型列表」。作为 NSFW 全开档默认宽松通道。大陆需代理。',
  },
};

/**
 * DeepSeek's prefix continuation (assistant message with prefix:true) is a beta
 * feature served ONLY under /beta — the stable endpoint 400s on it. Route those
 * requests to /beta/chat/completions and everything else to the stable path.
 */
export class DeepSeekProvider extends OpenAiCompatibleProvider {
  protected override endpoint(base: string, opts?: GenerateOptions): string {
    const root = base.replace(/\/$/, '').replace(/\/beta$/, '');
    if (opts?.messages.some((m) => m.prefix)) return `${root}/beta/chat/completions`;
    return `${root}/chat/completions`;
  }
  // Only DeepSeek understands the prefix flag (the base class strips it).
  // Flag the ALREADY-BUILT messages by index instead of rebuilding from
  // opts.messages: the base class may have expanded content into multi-part
  // (text + image_url) form, and a rebuild silently drops the image parts.
  protected override buildBody(opts: GenerateOptions): Record<string, unknown> {
    const body = super.buildBody(opts);
    const built = body.messages as Array<Record<string, unknown>>;
    body.messages = built.map((m, i) => (opts.messages[i]?.prefix ? { ...m, prefix: true } : m));
    return body;
  }
}

/** MiniMax wraps chat in the OpenAI shape but needs a group-id header for some deployments. */
export class MiniMaxProvider extends OpenAiCompatibleProvider {
  protected override buildBody(opts: GenerateOptions): Record<string, unknown> {
    const body = super.buildBody(opts);
    // MiniMax rejects response_format on some models; keep JSON via prompt instead.
    delete body.response_format;
    return body;
  }
}

/** Factory: build the right provider class for a config's kind. */
export function makeProvider(
  cfg: ProviderConfig,
): OpenAiCompatibleProvider {
  if (cfg.kind === 'minimax') return new MiniMaxProvider(cfg);
  if (cfg.kind === 'deepseek') return new DeepSeekProvider(cfg);
  return new OpenAiCompatibleProvider(cfg);
}
