/**
 * Provider preset descriptors — pure data (M-L1, split out of presets.ts).
 *
 * base_url and models are user-editable — nothing is hardcoded past these
 * defaults (Zen's catalog rotates; MiniMax's TTS/model ids version every few
 * months). The provider CLASSES stay in presets.ts; this file must not import
 * any LLM runtime module, because the config page (cold-start bundle) reads it.
 */

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
