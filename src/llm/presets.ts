/**
 * First-class provider presets. Each is a normal OpenAI-compatible slot with
 * calibrated defaults; the user can add more custom slots. base_url and models
 * are user-editable — nothing is hardcoded past these defaults (Zen's catalog
 * rotates; MiniMax's TTS/model ids version every few months).
 */
import { OpenAiCompatibleProvider, type ProviderConfig } from './openai-compatible';
import type { GenerateOptions, CompletionResult } from './types';

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
    defaultModels: ['MiniMax-Text-01', 'abab6.5s-chat'],
    roleDefaults: { chat: 'MiniMax-Text-01' },
    note: 'TTS 走 /t2a_v2（见 tts.ts）。输入/输出双侧审核（1026/1027）。',
  },
  zen: {
    kind: 'zen',
    label: 'OpenCode Zen（走代理，宽松通道）',
    baseUrl: 'https://opencode.ai/zen/v1',
    defaultModels: ['deepseek-v3', 'glm-4.6', 'kimi-k2'],
    roleDefaults: { chat: 'deepseek-v3' },
    note: '精选网关、目录会轮换；作为 NSFW 全开档默认宽松通道。大陆需代理。',
  },
};

/** MiniMax wraps chat in the OpenAI shape but needs a group-id header for some deployments. */
export class MiniMaxProvider extends OpenAiCompatibleProvider {
  protected override buildBody(opts: GenerateOptions): Record<string, unknown> {
    const body = super.buildBody(opts);
    // MiniMax rejects response_format on some models; keep JSON via prompt instead.
    delete body.response_format;
    return body;
  }
  protected override extract(data: unknown): CompletionResult {
    return super.extract(data);
  }
}

/** Factory: build the right provider class for a config's kind. */
export function makeProvider(
  cfg: ProviderConfig,
): OpenAiCompatibleProvider {
  if (cfg.kind === 'minimax') return new MiniMaxProvider(cfg);
  return new OpenAiCompatibleProvider(cfg);
}
