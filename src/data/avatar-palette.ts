/**
 * Avatar color options for the profile/persona editors. These are DATA (stored
 * per-contact in the DB), not UI theme — which is why hex lives here in
 * src/data/ (exempt from the tokens-only rule) and nowhere else.
 */
export const AVATAR_PALETTE: readonly string[] = [
  '#4c6ef5', // indigo (seed default for self)
  '#f783ac', // pink
  '#3bc9db', // cyan
  '#9775fa', // violet
  '#ffa94d', // orange
  '#69db7c', // green
  '#ff8787', // coral
  '#748ffc', // periwinkle
  '#a9a9a9', // gray
];
