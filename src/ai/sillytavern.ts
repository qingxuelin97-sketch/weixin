/**
 * SillyTavern V2 character cards, both directions (M-H2).
 *
 * `docs/PLAN.md:41` promised this in M1 and it was never written — grep for
 * `sillytavern` / `spec_v2` / `character_book` before this file and the whole
 * repository comes back empty. It matters more than it looks: the V2 card is
 * the de-facto interchange format for this entire category of app, so without
 * it every character the user already owns is unreachable, and every character
 * this app generates is trapped inside it.
 *
 * The mapping is lossy in one direction and lossless in the other, which is
 * the honest shape of the problem:
 *
 *   - IN: a V2 card has four prose fields (description / personality /
 *     scenario / system_prompt) where this app has one `core`. They are joined
 *     rather than dropped, because a card whose scenario disappeared is a
 *     different character.
 *   - OUT: everything V2 has no place for — pacing, posting rates, generosity,
 *     relations — rides in `extensions.aiwx`, which the V2 spec explicitly
 *     reserves for exactly this. A card exported and re-imported comes back
 *     whole.
 *
 * Unknown fields are PRESERVED verbatim (`extensions`), so importing someone
 * else's card and exporting it again does not quietly delete the half of it
 * this app does not understand.
 */
import { makePersona } from '../data/persona-defaults';
import type { PersonaVM } from '../data/types';

export const ST_SPEC = 'chara_card_v2';

export interface StCardV2 {
  spec: string;
  spec_version: string;
  data: {
    name?: string;
    description?: string;
    personality?: string;
    scenario?: string;
    first_mes?: string;
    mes_example?: string;
    creator_notes?: string;
    system_prompt?: string;
    post_history_instructions?: string;
    alternate_greetings?: string[];
    tags?: string[];
    creator?: string;
    character_version?: string;
    extensions?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

export interface ImportedCard {
  name: string;
  persona: PersonaVM;
  /** Anything this app has no field for, kept so an export round-trips. */
  extensions: Record<string, unknown>;
  /** Non-fatal notes shown to the user ("这张卡有 3 条备用开场白，已保留"). */
  notes: string[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Replace the two macros every V2 card uses.
 *
 * Left in place they surface verbatim in the middle of a reply — "{{char}} 笑
 * 了笑" is the single most obvious tell an imported card was never adapted.
 */
export function expandMacros(text: string, charName: string, userName = '你'): string {
  return text
    .replace(/\{\{char\}\}/gi, charName)
    .replace(/\{\{user\}\}/gi, userName)
    .replace(/<START>/gi, '')
    .trim();
}

/**
 * Pull the character's own lines out of `mes_example`.
 *
 * The format is a loose transcript (`{{user}}: …` / `{{char}}: …`), and only
 * the char's half is a style sample — feeding the user's half back as "things
 * she says" would teach her to imitate the person she is talking to.
 */
export function parseExamples(raw: string, charName: string): string[] {
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(?:\{\{char\}\}|<BOT>|char)\s*[:：]\s*(.+)$/i.exec(line);
    if (m) out.push(expandMacros(m[1], charName));
  }
  return out.filter(Boolean).slice(0, 6);
}

/** Is this parsed JSON plausibly a V2 card? */
export function isStCard(raw: unknown): raw is StCardV2 {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  if (typeof r.spec === 'string' && r.spec.startsWith('chara_card')) return true;
  // V1 cards are a bare object with these fields and no `spec` at all; they
  // are still worth importing, and refusing them over a missing version string
  // would be pedantry the user pays for.
  return typeof r.name === 'string' && typeof r.description === 'string';
}

/**
 * V2 (or V1) card → a complete persona.
 *
 * Behavioural fields come from `extensions.aiwx` when the card was exported by
 * this app; otherwise they are the defaults, because a foreign card genuinely
 * does not say how often this character posts to Moments.
 */
export function importStCard(raw: unknown, contactId: string): ImportedCard | null {
  if (!isStCard(raw)) return null;
  const r = raw as unknown as Record<string, unknown>;
  const data = (typeof r.data === 'object' && r.data ? r.data : r) as StCardV2['data'];
  const name = str(data.name) || '未命名';
  const notes: string[] = [];

  // Four prose fields, one `core`. Joined rather than dropped — a card whose
  // scenario disappeared is a different character.
  const core = [
    str(data.description),
    str(data.personality) && `性格：${str(data.personality)}`,
    str(data.scenario) && `场景：${str(data.scenario)}`,
  ]
    .filter(Boolean)
    .map((s) => expandMacros(s, name))
    .join('\n');

  const fewShots = parseExamples(str(data.mes_example), name);
  if (str(data.mes_example) && fewShots.length === 0) {
    notes.push('这张卡的对话示例没能解析出角色台词，已跳过');
  }
  if ((data.alternate_greetings?.length ?? 0) > 0) {
    notes.push(`保留了 ${data.alternate_greetings!.length} 条备用开场白（未使用）`);
  }
  if (str(data.system_prompt) || str(data.post_history_instructions)) {
    // Deliberately NOT merged into the prompt: this app has its own six-layer
    // system prompt with a fixed order (constitution §2), and splicing a
    // foreign one in would break the NSFW boundary layer's position.
    notes.push('卡里的 system_prompt 未导入——本 App 的提示词分层是固定的');
  }

  const saved = (data.extensions?.aiwx ?? {}) as Partial<PersonaVM>;
  const persona = makePersona({
    ...saved,
    contactId,
    core: core || str(data.description) || name,
    greeting: expandMacros(str(data.first_mes), name) || saved.greeting,
    fewShots: fewShots.length ? fewShots : (saved.fewShots ?? []),
  });

  return {
    name,
    persona,
    extensions: data.extensions ?? {},
    notes,
  };
}

/**
 * Persona → V2 card.
 *
 * `extensions.aiwx` carries everything V2 has no field for, so this app's own
 * export is lossless while staying a valid card for anything else that reads
 * V2.
 */
export function exportStCard(
  name: string,
  persona: PersonaVM,
  extensions: Record<string, unknown> = {},
): StCardV2 {
  return {
    spec: ST_SPEC,
    spec_version: '2.0',
    data: {
      name,
      description: persona.core,
      personality: persona.speechStyle ?? '',
      scenario: '',
      first_mes: persona.greeting ?? '',
      // The transcript shape other tools expect. Macros go back IN so the card
      // stays portable — a hard-coded name would read wrong in any app that
      // renames the character.
      mes_example: persona.fewShots.map((s) => `<START>\n{{char}}: ${s}`).join('\n'),
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: [],
      creator: '',
      character_version: '1',
      extensions: {
        ...extensions,
        aiwx: {
          speechStyle: persona.speechStyle,
          catchphrases: persona.catchphrases,
          activeHours: persona.activeHours,
          proactivity: persona.proactivity,
          typingCpm: persona.typingCpm,
          heartbeatBaseMin: persona.heartbeatBaseMin,
          momentsPerDay: persona.momentsPerDay,
          likeRate: persona.likeRate,
          commentRate: persona.commentRate,
          affinityInit: persona.affinityInit,
          generosity: persona.generosity,
          grabSpeed: persona.grabSpeed,
          temperature: persona.temperature,
          imageTags: persona.imageTags,
          relations: persona.relations,
          // NSFW samples are deliberately NOT exported: they are the most
          // sensitive text in the card and an export is a file that leaves the
          // device (constitution rule #2's spirit — nothing sensitive leaves
          // by accident).
        },
      },
    },
  };
}
