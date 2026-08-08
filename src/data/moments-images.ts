/**
 * Moments image pool + the asset import slot.
 *
 * A post stores opaque `imageRefs`, never URLs, so the art backing a ref can be
 * swapped without rewriting stored posts. Two kinds of ref exist:
 *
 *   `ph:<n>`    procedurally-rendered placeholder (a CSS gradient, no file)
 *   `img:<name>` a real picture from src/assets/moments/
 *
 * THE IMPORT SLOT: drop .png/.jpg/.webp files into `src/assets/moments/` and they
 * are picked up automatically by the glob below — no code change. Once at least
 * one file exists, `pickImages()` draws from real art and stops handing out
 * placeholders. Until then the placeholders keep the feed looking populated.
 *
 * Colors here are CONTENT (like the placeholder avatar tints), which is why this
 * lives in src/data/ — the one tree exempt from the no-hardcoded-colors guard.
 */
import { seededRng } from '../lib/money';

/** Vite resolves this at build time; empty object until the user adds files. */
const ASSETS = import.meta.glob('../assets/moments/*.{png,jpg,jpeg,webp}', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

/** `img:` ref → resolved URL, keyed by bare filename. */
const ASSET_BY_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(ASSETS).map(([path, url]) => [path.split('/').pop() as string, url]),
);

export const ASSET_NAMES = Object.keys(ASSET_BY_NAME).sort();
export const hasRealAssets = ASSET_NAMES.length > 0;

/**
 * Placeholder gradient pairs. Muted, photo-ish tones — the feed should read as
 * "photos I haven't loaded" rather than a color-swatch demo.
 */
const PLACEHOLDER_GRADIENTS: Array<[string, string]> = [
  ['#8FA9C4', '#C9D6E3'], // overcast sky
  ['#C4A88F', '#E8D9C6'], // sand
  ['#7FA88C', '#C3DCC9'], // foliage
  ['#C48F9B', '#E9CDD4'], // dusk pink
  ['#9B8FC4', '#D3CCE9'], // lavender
  ['#C4B98F', '#E7E1C4'], // wheat
  ['#8FC4C0', '#C6E4E2'], // sea glass
  ['#B08FA0', '#DCC7D1'], // mauve
  ['#A8A8A8', '#DCDCDC'], // grayscale
];

export const PLACEHOLDER_COUNT = PLACEHOLDER_GRADIENTS.length;

/** All refs offerable in the publish picker. */
export function availableRefs(): string[] {
  if (hasRealAssets) return ASSET_NAMES.map((n) => `img:${n}`);
  return PLACEHOLDER_GRADIENTS.map((_, i) => `ph:${i}`);
}

/**
 * What a ref renders as. Placeholders have no URL — the caller paints
 * `background` instead of an <img>.
 */
export function resolveImageRef(ref: string): { url?: string; background?: string } {
  if (ref.startsWith('img:')) {
    const url = ASSET_BY_NAME[ref.slice(4)];
    if (url) return { url };
    // Asset was removed after a post referenced it — fall through to a stable
    // placeholder so the grid keeps its shape instead of showing a broken image.
    return { background: gradientFor(hashRef(ref) % PLACEHOLDER_COUNT) };
  }
  const n = Number(ref.slice(3));
  return { background: gradientFor(Number.isFinite(n) ? n % PLACEHOLDER_COUNT : 0) };
}

function gradientFor(i: number): string {
  const [a, b] = PLACEHOLDER_GRADIENTS[Math.abs(i) % PLACEHOLDER_COUNT];
  return `linear-gradient(135deg, ${a} 0%, ${b} 100%)`;
}

function hashRef(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Deterministically pick `count` distinct refs for a seed — same persona + same
 * post always gets the same pictures, so a replayed timeline looks identical.
 */
export function pickImages(seed: string, count: number): string[] {
  const pool = availableRefs();
  if (count <= 0 || pool.length === 0) return [];
  const rng = seededRng(seed);
  const remaining = [...pool];
  const out: string[] = [];
  for (let i = 0; i < count && remaining.length > 0; i++) {
    out.push(remaining.splice(Math.floor(rng() * remaining.length), 1)[0]);
  }
  return out;
}
