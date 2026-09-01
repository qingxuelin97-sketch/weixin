/**
 * 数据层完全体 (M-J10) red-guards.
 *
 *   1. SqliteRepo 的 SQL 现在过真引擎（node:sqlite）——见 sqlite-repo.test.ts，
 *      那套等价性套件同时跑 IndexedDB / FakeSqlDb / 真引擎三方对拍。这里守的是
 *      「真引擎这条腿别被人悄悄摘掉」；
 *   2. 体积棘轮拆成主/懒双账本：拆懒终于能换来数字下降（此前总量口径下拆懒
 *      一个字节都不降，是个奖励错误行为的指标）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NodeSqlDb } from './node-sqlite-db';
import { SqliteRepo, ensureSqliteSchema } from '../../src/db/sqlite';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

describe('SqliteRepo 面对真 SQL 引擎', () => {
  it('schema 能被真引擎解析并建起来（此前只有正则假体点过头）', async () => {
    const db = new NodeSqlDb();
    // A syntax error anywhere in the bootstrap script throws here. The fake
    // could not have told us: it pattern-matches statements rather than
    // parsing them, so invalid SQL that merely *looked* right passed for
    // three milestones.
    await expect(ensureSqliteSchema(db)).resolves.not.toThrow();
    db.close();
  });

  it('一条真的往返：写进去、读回来、删掉', async () => {
    const db = new NodeSqlDb();
    await ensureSqliteSchema(db);
    const repo = new SqliteRepo(db);
    await repo.putContact({
      id: 'ai_a',
      type: 'ai',
      name: '阿甲',
      avatarColor: '#000000',
      avatarText: '甲',
    });
    expect((await repo.getContacts()).map((c) => c.id)).toEqual(['ai_a']);
    db.close();
  });

  it('等价性套件真的把三个驱动都跑了（别让真引擎那条腿被摘掉）', () => {
    const src = read('tests/unit/sqlite-repo.test.ts');
    expect(src).toContain('NodeSqlDb');
    expect(src).toContain('real SQLite engine disagrees with IndexedDB');
    // both() 必须喂给三个驱动，否则写操作只落在两个上、读对拍就成了空转。
    const bothFn = src.slice(src.indexOf('const both ='));
    expect(bothFn.slice(0, bothFn.indexOf('};'))).toContain('sqReal');
  });

  it('真引擎只在测试里——它不该出现在任何 src/ 文件中', () => {
    // node:sqlite 是测试替身；App 在设备上仍然走 @capacitor-community/sqlite。
    const driver = read('src/db/sqlite.ts');
    expect(driver).not.toContain('node:sqlite');
  });
});

describe('体积棘轮：主/懒双账本', () => {
  const src = read('scripts/check-bundle-size.mjs');

  it('两本账各有预算，且都会让门禁失败', () => {
    expect(src).toContain('MAIN_BUDGET_KB');
    expect(src).toContain('LAZY_BUDGET_KB');
    expect(src).toContain('if (mainKb > MAIN_BUDGET_KB)');
    expect(src).toContain('if (lazyKb > LAZY_BUDGET_KB)');
  });

  it('主账本按 index.html 引用的入口 chunk + 全部 CSS 划定', () => {
    // 「冷启动要解析什么」不是靠文件名猜的，是 index.html 说了算。
    expect(src).toContain("readFileSync('dist/index.html'");
    expect(src).toContain("f.endsWith('.css') || entryJs.has(f)");
  });

  it('入口找不到时必须失败，不许静默地把 main 记成 0', () => {
    expect(src).toContain('entryJs.size === 0');
  });

  it('写清了为什么单一总量口径是错的指标（后人别再合回去）', () => {
    expect(src).toContain('did not move the number at all');
  });
});
