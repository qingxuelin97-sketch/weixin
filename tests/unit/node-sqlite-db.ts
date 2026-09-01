/**
 * A REAL SQLite engine behind `SqlDb` (M-J10).
 *
 * Until now the SqliteRepo's only opponent in tests was `FakeSqlDb` — 206
 * lines of hand-written pattern matching over exactly the statements the
 * driver happens to emit today. That fake is genuinely useful (it fails loudly
 * when the driver emits SQL it does not recognise, which is how it kept the
 * two drivers honest about parameter shapes), but it cannot tell you the one
 * thing you most want to know: **does this SQL do what SQL does?**
 *
 * Things only a real engine can catch, all of which have bitten this repo's
 * IndexedDB side at some point:
 *   - `ORDER BY` on a TEXT column sorting lexicographically when the code
 *     assumes numeric order (`'10' < '9'`);
 *   - a `WHERE id < ?` cursor being inclusive/exclusive by one row;
 *   - `DELETE FROM messages WHERE conv_id = ?` silently matching nothing
 *     because the column is actually named `convId`;
 *   - an INTEGER PRIMARY KEY not behaving like the rowid the schema assumes
 *     (「rowid 序 == 时间序」 is a load-bearing invariant here).
 *
 * `node:sqlite` ships with Node 22 and needs no dependency, so this costs the
 * bundle nothing and the install nothing. It is test-only: the app still talks
 * to @capacitor-community/sqlite on device, and this adapter exists purely to
 * put the driver's own SQL in front of a parser that will actually argue.
 */
import { createRequire } from 'node:module';
import type { SqlDb } from '../../src/db/sqlite';

/**
 * Loaded through createRequire, not a static import: Vite resolves `node:x`
 * against its own bundled list of Node builtins, and `sqlite` (new in Node 22)
 * is not on it — a plain `import 'node:sqlite'` fails with
 * "Failed to load url sqlite". createRequire hands the specifier to Node
 * itself, which does know about it.
 */
interface Stmt {
  run(...values: unknown[]): { changes?: number | bigint; lastInsertRowid?: number | bigint };
  all(...values: unknown[]): unknown[];
}
interface Db {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => Db;
};

export class NodeSqlDb implements SqlDb {
  private db: Db;

  constructor() {
    // ':memory:' — each test gets a private database and nothing touches disk.
    this.db = new DatabaseSync(':memory:');
  }

  async execute(statements: string): Promise<unknown> {
    // exec() runs a whole script, which is exactly what the driver's schema
    // bootstrap sends. A syntax error throws here rather than being ignored,
    // which is the entire point of using a real engine.
    this.db.exec(statements);
    return {};
  }

  async run(
    statement: string,
    values: unknown[] = [],
  ): Promise<{ changes?: { changes?: number; lastId?: number } }> {
    const stmt = this.db.prepare(statement);
    const r = stmt.run(...values);
    return {
      changes: {
        changes: Number(r.changes ?? 0),
        lastId: Number(r.lastInsertRowid ?? 0),
      },
    };
  }

  async query(
    statement: string,
    values: unknown[] = [],
  ): Promise<{ values?: Array<Record<string, unknown>> }> {
    const stmt = this.db.prepare(statement);
    return { values: stmt.all(...values) as Array<Record<string, unknown>> };
  }

  close(): void {
    this.db.close();
  }
}
