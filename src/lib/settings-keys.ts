/**
 * Shared settings-key constants (M-J0).
 *
 * I18's rule was "settings 键一名一处", yet the backfill barrier key existed as
 * FOUR independent spellings: a private const in ai/backfill.ts, two hardcoded
 * strings in lib/backup.ts's restore paths, and the ledger row in db/repo.ts.
 * The restore→backfill contract (specs/backfill.md: "恢复完成后必须重置
 * lastForegroundAt 屏障") hinged on those spellings agreeing by luck.
 *
 * Lives in lib/ because both sides need it and the dependency direction only
 * allows ai → lib, never lib → ai. Keys used by exactly one module stay local
 * to that module; only keys that form a CONTRACT between modules belong here.
 */

/**
 * The offline-backfill barrier: epoch ms of the last foreground pass. Written
 * by ai/backfill.ts on every foreground; reset by lib/backup.ts after restore
 * and after the SQLite migration so the next launch backfills from "now", not
 * from the snapshot's ancient timestamp.
 */
export const BACKFILL_BARRIER_KEY = 'lastForegroundAt';
