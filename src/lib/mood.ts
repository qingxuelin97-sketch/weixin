/**
 * Daily mood — zero storage, zero LLM.
 *
 * A persona wakes up in a mood each day, seeded on (contactId, dayBucket): the
 * same day always rolls the same mood, so offline backfill replays exactly and
 * the user can notice "she's been off all day" as a consistent fact, not noise.
 *
 * Deliberately NOT event-driven emotion: reacting to conversation content would
 * need an LLM extraction pass per exchange — cost and complexity V1 doesn't
 * repay. A day-level tint is enough for the reader to project a mood arc, which
 * is how fiction works anyway.
 */
import { seededRng } from './money';

export interface Mood {
  key: 'calm' | 'happy' | 'annoyed' | 'tired' | 'excited' | 'down';
  /** One line for the prompt's scene layer. */
  line: string;
}

const MOODS: Array<{ mood: Mood; weight: number }> = [
  { mood: { key: 'calm', line: '你今天心情平平常常。' }, weight: 40 },
  { mood: { key: 'happy', line: '你今天心情不错，说话比平时轻快。' }, weight: 20 },
  { mood: { key: 'annoyed', line: '你今天有点烦，回话偶尔带点没耐心，但不冲朋友撒气。' }, weight: 12 },
  { mood: { key: 'tired', line: '你今天挺累的，回复更短，偶尔敷衍一下。' }, weight: 15 },
  { mood: { key: 'excited', line: '你今天有点兴奋，话比平时多，容易跑题。' }, weight: 8 },
  { mood: { key: 'down', line: '你今天情绪有点低，不主动展开话题，但朋友问起会说。' }, weight: 5 },
];

const TOTAL_WEIGHT = MOODS.reduce((n, m) => n + m.weight, 0);

/** The persona's mood for the day containing `ts`. Pure and replayable. */
export function moodOf(contactId: string, ts: number): Mood {
  const dayBucket = Math.floor(ts / 86_400_000);
  let roll = seededRng(`mood:${contactId}:${dayBucket}`)() * TOTAL_WEIGHT;
  for (const { mood, weight } of MOODS) {
    roll -= weight;
    if (roll < 0) return mood;
  }
  return MOODS[0].mood;
}
