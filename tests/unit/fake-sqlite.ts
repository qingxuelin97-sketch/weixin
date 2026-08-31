/**
 * In-memory stand-in for @capacitor-community/sqlite's SQLiteDBConnection,
 * implementing exactly the SQL grammar src/db/sqlite.ts emits (and throwing on
 * anything else, so a driver change that drifts from the fake turns tests red
 * instead of silently passing). This is the injectable "内存模拟实现" the I17
 * plan calls for: the native plugin cannot run in this container, so the SQL
 * text + parameter contract is what gets exercised.
 */
import type { SqlDb } from '../../src/db/sqlite';

interface MsgRow {
  id: number;
  convId: string;
  data: string;
}

export class FakeSqlDb implements SqlDb {
  /** kv tables: name → key → data. Insertion order is irrelevant (sorted). */
  kv = new Map<string, Map<string, string>>();
  messages = new Map<number, MsgRow>();
  seq = 0;
  created = new Set<string>();

  private table(name: string): Map<string, string> {
    if (!this.created.has(name)) throw new Error(`no such table: ${name}`);
    let t = this.kv.get(name);
    if (!t) {
      t = new Map();
      this.kv.set(name, t);
    }
    return t;
  }

  async execute(statements: string): Promise<unknown> {
    for (const raw of statements.split('\n')) {
      const stmt = raw.trim().replace(/;$/, '');
      if (!stmt) continue;
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(stmt)) continue;
      let m = stmt.match(/^CREATE TABLE IF NOT EXISTS "?([\w]+)"?\s/i);
      if (m) {
        this.created.add(m[1]);
        continue;
      }
      m = stmt.match(/^CREATE INDEX IF NOT EXISTS /i);
      if (m) continue;
      throw new Error(`FakeSqlDb.execute: unsupported statement: ${stmt}`);
    }
    return {};
  }

  async run(
    statement: string,
    values: unknown[] = [],
  ): Promise<{ changes?: { changes?: number; lastId?: number } }> {
    const stmt = statement.trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(stmt)) return {};

    let m = stmt.match(/^INSERT OR REPLACE INTO messages \(id, conv_id, data\) VALUES \(\?, \?, \?\)$/);
    if (m) {
      const [id, convId, data] = values as [number, string, string];
      this.mustHave('messages');
      this.messages.set(Number(id), { id: Number(id), convId, data });
      this.seq = Math.max(this.seq, Number(id));
      return { changes: { changes: 1, lastId: Number(id) } };
    }
    m = stmt.match(/^INSERT INTO messages \(conv_id, data\) VALUES \(\?, \?\)$/);
    if (m) {
      const [convId, data] = values as [string, string];
      this.mustHave('messages');
      const id = ++this.seq;
      this.messages.set(id, { id, convId, data });
      return { changes: { changes: 1, lastId: id } };
    }
    m = stmt.match(/^UPDATE messages SET conv_id = \?, data = \? WHERE id = \?$/);
    if (m) {
      const [convId, data, id] = values as [string, string, number];
      const row = this.messages.get(Number(id));
      if (row) this.messages.set(Number(id), { id: Number(id), convId, data });
      return { changes: { changes: row ? 1 : 0 } };
    }
    m = stmt.match(/^DELETE FROM messages WHERE id = \?$/);
    if (m) {
      const n = this.messages.delete(Number(values[0])) ? 1 : 0;
      return { changes: { changes: n } };
    }
    m = stmt.match(/^DELETE FROM messages WHERE conv_id = \?$/);
    if (m) {
      let n = 0;
      for (const [id, row] of [...this.messages]) {
        if (row.convId === values[0]) {
          this.messages.delete(id);
          n++;
        }
      }
      return { changes: { changes: n } };
    }
    m = stmt.match(/^DELETE FROM "?(\w+)"?$/);
    if (m) {
      if (m[1] === 'messages') {
        const n = this.messages.size;
        this.messages.clear();
        return { changes: { changes: n } };
      }
      const t = this.table(m[1]);
      const n = t.size;
      t.clear();
      return { changes: { changes: n } };
    }
    m = stmt.match(/^INSERT OR REPLACE INTO "?(\w+)"? \(key, data\) VALUES \(\?, \?\)$/);
    if (m) {
      this.table(m[1]).set(String(values[0]), String(values[1]));
      return { changes: { changes: 1 } };
    }
    m = stmt.match(/^DELETE FROM "?(\w+)"? WHERE key = \?$/);
    if (m) {
      const n = this.table(m[1]).delete(String(values[0])) ? 1 : 0;
      return { changes: { changes: n } };
    }
    throw new Error(`FakeSqlDb.run: unsupported statement: ${stmt}`);
  }

  async query(
    statement: string,
    values: unknown[] = [],
  ): Promise<{ values?: Array<Record<string, unknown>> }> {
    const stmt = statement.trim();

    let m = stmt.match(/^SELECT id, data FROM messages ORDER BY id ASC$/);
    if (m) {
      return { values: this.sortedMsgs().map(({ id, data }) => ({ id, data })) };
    }
    m = stmt.match(
      /^SELECT id, data FROM messages WHERE conv_id = \?( AND id < \?)? ORDER BY id (ASC|DESC)( LIMIT \??1?)?$/,
    );
    if (m) {
      const convId = String(values[0]);
      const before = m[1] ? Number(values[1]) : undefined;
      const desc = m[2] === 'DESC';
      const limit = m[3]
        ? m[3].includes('?')
          ? Number(values[m[1] ? 2 : 1])
          : 1
        : Infinity;
      let rows = this.sortedMsgs().filter((r) => r.convId === convId);
      if (before != null) rows = rows.filter((r) => r.id < before);
      if (desc) rows = rows.reverse();
      return { values: rows.slice(0, limit).map(({ id, data }) => ({ id, data })) };
    }
    m = stmt.match(/^SELECT COUNT\(\*\) AS n FROM "?(\w+)"?$/);
    if (m) {
      const n = m[1] === 'messages' ? this.messages.size : this.table(m[1]).size;
      return { values: [{ n }] };
    }
    m = stmt.match(/^SELECT data FROM "?(\w+)"? ORDER BY key ASC$/);
    if (m) {
      const t = this.table(m[1]);
      const keys = [...t.keys()].sort();
      return { values: keys.map((k) => ({ data: t.get(k)! })) };
    }
    m = stmt.match(/^SELECT data FROM "?(\w+)"? WHERE key = \?$/);
    if (m) {
      const data = this.table(m[1]).get(String(values[0]));
      return { values: data == null ? [] : [{ data }] };
    }
    m = stmt.match(/^SELECT data FROM "?(\w+)"? WHERE json_extract\(data,'\$\.(\w+)'\) = \?$/);
    if (m) {
      const t = this.table(m[1]);
      const out: Array<Record<string, unknown>> = [];
      for (const data of t.values()) {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        if (parsed[m[2]] === values[0]) out.push({ data });
      }
      return { values: out };
    }
    m = stmt.match(
      /^SELECT data FROM "?(\w+)"?( WHERE json_extract\(data,'\$\.(\w+)'\) < \?)? ORDER BY json_extract\(data,'\$\.(\w+)'\) DESC(, key DESC)? LIMIT \?$/,
    );
    if (m) {
      const t = this.table(m[1]);
      const beforeField = m[3];
      const orderField = m[4];
      const keyTiebreak = Boolean(m[5]);
      const before = beforeField ? Number(values[0]) : undefined;
      const limit = Number(values[beforeField ? 1 : 0]);
      let rows = [...t.entries()].map(([key, data]) => ({
        key,
        data,
        v: Number((JSON.parse(data) as Record<string, unknown>)[orderField] ?? 0),
      }));
      if (before != null) rows = rows.filter((r) => r.v < before);
      rows.sort((a, b) =>
        b.v - a.v || (keyTiebreak ? (a.key < b.key ? 1 : a.key > b.key ? -1 : 0) : 0),
      );
      return { values: rows.slice(0, limit).map((r) => ({ data: r.data })) };
    }
    throw new Error(`FakeSqlDb.query: unsupported statement: ${stmt}`);
  }

  private mustHave(name: string): void {
    if (!this.created.has(name)) throw new Error(`no such table: ${name}`);
  }

  private sortedMsgs(): MsgRow[] {
    return [...this.messages.values()].sort((a, b) => a.id - b.id);
  }
}
