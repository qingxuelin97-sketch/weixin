import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * specs 索引对账 (M-J0)。
 *
 * 宪法 §4 说得很清楚：「这份索引就是清单本身——`ls specs/` 与它对不上，说明
 * 有人写了 spec 没登记（或写了模块没写 spec）」。但说清楚不等于有人执行——
 * 对账之前从没被机器做过，全靠下一个会话恰好想起来数一遍。这份测试把 §4 那张
 * 表解析出来，与 specs/ 目录逐名对齐，两个方向都要平：
 *
 *   - 磁盘有、表里没有 → 写了 spec 忘登记（索引失去「清单本身」的资格）
 *   - 表里有、磁盘没有 → 登记了名字没写文件（或者改名没同步）
 */

const ROOT = join(__dirname, '..', '..');

/** 解析 CLAUDE.md §4 的两列表格，取第二列并按「·」拆出 spec 名。 */
function specsFromConstitution(): string[] {
  const md = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
  const lines = md.split('\n');
  const head = lines.findIndex((l) => /^\|\s*域\s*\|\s*spec\s*\|/.test(l));
  expect(head, 'CLAUDE.md §4 的「| 域 | spec |」表头没找到——表被改了格式？').toBeGreaterThan(-1);

  const names: string[] = [];
  for (let i = head + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) break; // 表到头了
    const cells = line.split('|').map((c) => c.trim());
    // ['', 域, spec 列, ''] —— 第二个内容格是 spec 列
    const specCell = cells[2] ?? '';
    for (const raw of specCell.split('·')) {
      // 注释走全角/半角括号，如「streaming（Web-only SSE 渐进渲染）」——括号起一律截掉。
      const name = raw.replace(/[（(].*$/u, '').trim();
      if (name) names.push(name);
    }
  }
  return names;
}

function specsOnDisk(): string[] {
  return readdirSync(join(ROOT, 'specs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''));
}

describe('宪法 §4 specs 索引 ↔ specs/ 目录', () => {
  it('表里的每个名字都真有一份 specs/<name>.md', () => {
    const disk = new Set(specsOnDisk());
    const ghosts = specsFromConstitution().filter((n) => !disk.has(n));
    expect(ghosts, '登记了名字但磁盘上没有对应 spec 文件').toEqual([]);
  });

  it('磁盘上的每份 spec 都登记进了 §4 的表', () => {
    const listed = new Set(specsFromConstitution());
    const unlisted = specsOnDisk().filter((n) => !listed.has(n));
    expect(unlisted, '写了 spec 没登记进 CLAUDE.md §4 —— 索引即清单，两处必须同步').toEqual([]);
  });

  it('表里没有重复登记', () => {
    const names = specsFromConstitution();
    expect(new Set(names).size).toBe(names.length);
  });

  it('解析器没有失明（防两个空集合 vacuous 对平）', () => {
    // M-I 轮结束时是 27 份；只压下限不钉死总数，免得每加一份 spec 还要来改这里。
    // 真正的等式由上面两条双向断言保证——这条只证明解析器还在读到真表。
    const names = specsFromConstitution();
    expect(names.length).toBeGreaterThanOrEqual(27);
    // 锚点抽查：表首尾两个域各抽一个，解析器漏行/漏列时最先断。
    expect(names).toContain('design-tokens');
    expect(names).toContain('native-android');
  });
});
