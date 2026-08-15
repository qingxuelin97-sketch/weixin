/**
 * #话题# parsing (M-I15).
 *
 * Moments text may carry WeChat-style topic tags — `#加班日常#` — which the
 * feed renders as tappable links into a per-topic aggregation page. The parser
 * is deliberately strict:
 *
 *   - a tag is `#…#` with 1–12 non-# characters between the marks;
 *   - whitespace-only tags don't count (`# #` is punctuation, not a topic);
 *   - an unpaired `#` is plain text — nothing is guessed at.
 *
 * Pure string functions only, so both the render path (features/) and the
 * generation path (ai/) can share them without a dependency cycle — which is
 * why this lives in `lib/`.
 */

/** Longest tag the UI will link. Longer runs read as text, not a topic. */
export const MAX_TOPIC_LEN = 12;

const TOPIC_RE = /#([^#\n]{1,12})#/g;

/** All distinct topic tags in a text, in first-appearance order (no `#` marks). */
export function parseTopics(text: string | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(TOPIC_RE)) {
    const tag = m[1].trim();
    if (!tag || tag.length > MAX_TOPIC_LEN) continue;
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

/** One rendered run of a post's text: plain prose or a tappable topic. */
export interface TopicSegment {
  kind: 'text' | 'topic';
  /** Plain-text runs carry the raw slice; topic runs carry the tag WITHOUT `#`. */
  value: string;
}

/**
 * Split a post's text into alternating prose / topic segments for rendering.
 * Lossless for prose: joining `kind==='text'` slices plus `#tag#` for topic
 * slices reproduces the input exactly, so the card never rewrites the post.
 */
export function topicSegments(text: string): TopicSegment[] {
  const out: TopicSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(TOPIC_RE)) {
    const tag = m[1].trim();
    const start = m.index ?? 0;
    if (!tag) continue; // `# #` stays inside the surrounding prose run
    if (start > last) out.push({ kind: 'text', value: text.slice(last, start) });
    out.push({ kind: 'topic', value: tag });
    last = start + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', value: text.slice(last) });
  return out;
}

/** Does this text mention the topic (as a real `#tag#`, not a substring)? */
export function hasTopic(text: string | undefined, tag: string): boolean {
  return parseTopics(text).includes(tag);
}
