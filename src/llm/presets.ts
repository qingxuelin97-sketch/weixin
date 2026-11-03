/**
 * First-class provider presets. Each is a normal OpenAI-compatible slot with
 * calibrated defaults; the user can add more custom slots. base_url and models
 * are user-editable — nothing is hardcoded past these defaults (Zen's catalog
 * rotates; MiniMax's TTS/model ids version every few months).
 */
import { OpenAiCompatibleProvider, type ProviderConfig } from './openai-compatible';
import type { GenerateOptions } from './types';

// The preset DATA lives in ./preset-data (M-L1): the API config page renders
// it, and importing it from here dragged the provider classes (and through
// them the transport and zod) into the cold-start bundle.
export { PRESETS, type PresetDescriptor } from './preset-data';

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
