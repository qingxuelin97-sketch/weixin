import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 铁律 4 全域纯度守卫 (M-J0)。
 *
 * 此前的守卫是点状的：social-fabric.test.ts 盯 4 个文件、goals-drift.test.ts
 * 盯 2 个——每次都是踩过坑才补一个名字，而新文件天生不在任何名单上。这份测试
 * 反过来：**src/ai/ 的每个文件默认必须纯**（不读挂钟、不掷真骰子），要用
 * Date.now / Math.random 必须来这里的白名单登记数量与理由，新文件不表态即转红。
 * 与 SETTINGS_KEY_CASCADE / 路由台账同构：缺省是拒绝，例外要署名。
 *
 * 为什么盯这两个调用：离线回填与红包拆分的可回放性完全建立在「时间外部注入、
 * 随机走 seededRng(seed)」上。一处偷读挂钟，回放就不可确定，且没有任何测试
 * 会红——它只在「离线两天回来补出的时间线每次都不一样」时以体感穿帮。
 *
 * 扫描规则：逐行正则，跳过纯注释行（以 // 或 * 或 /* 起头）——注释里*提到*
 * Date.now() 是合法的（往往正是在解释为什么不能用它）。代码行尾的注释不豁免，
 * 宁可误伤让人改写注释，也不给真调用留藏身处。
 */

const AI_DIR = join(__dirname, '..', '..', 'src', 'ai');

/**
 * 白名单：文件 → 允许的命中次数与理由。次数钉死——scheduler.ts 里再多出第二个
 * Date.now，哪怕文件在名单上也转红。
 */
const PURITY_WHITELIST: Record<string, { dateNow: number; mathRandom: number; why: string }> = {
  'scheduler.ts': {
    dateNow: 1,
    mathRandom: 0,
    why:
      'startScheduler(now = () => Date.now()) 的参数默认值——这正是铁律 4 说的' +
      '「时间由外部注入」的注入口本身：生产走真挂钟，测试与回放传假钟。' +
      '除这一处默认值外，scheduler 内部一律用注入进来的 now()。',
  },
};

function scan(file: string): { dateNow: number; mathRandom: number } {
  let dateNow = 0;
  let mathRandom = 0;
  for (const line of readFileSync(join(AI_DIR, file), 'utf8').split('\n')) {
    const t = line.trimStart();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
    if (/Date\.now\s*\(/.test(line)) dateNow++;
    if (/Math\.random\s*\(/.test(line)) mathRandom++;
  }
  return { dateNow, mathRandom };
}

describe('铁律 4 — src/ai/ 全域纯度（新文件不表态即转红）', () => {
  const files = readdirSync(AI_DIR).filter((f) => f.endsWith('.ts'));

  it('目录还在被扫（防路径改名后 vacuous 全绿）', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('每个文件要么干净，要么在白名单上且命中次数分毫不差', () => {
    const violations: string[] = [];
    for (const f of files) {
      const got = scan(f);
      const allowed = PURITY_WHITELIST[f] ?? { dateNow: 0, mathRandom: 0 };
      if (got.dateNow !== allowed.dateNow) {
        violations.push(
          `${f}: Date.now × ${got.dateNow}（白名单允许 ${allowed.dateNow}）——时间必须外部注入`,
        );
      }
      if (got.mathRandom !== allowed.mathRandom) {
        violations.push(
          `${f}: Math.random × ${got.mathRandom}（白名单允许 ${allowed.mathRandom}）——随机必须走 seededRng(seed)`,
        );
      }
    }
    expect(violations, '铁律 4：要么改用注入的 now()/seededRng，要么来白名单登记并写明理由').toEqual([]);
  });

  it('白名单没有幽灵行（登记的文件必须存在——改名/删除要同步）', () => {
    const have = new Set(files);
    const ghosts = Object.keys(PURITY_WHITELIST).filter((f) => !have.has(f));
    expect(ghosts).toEqual([]);
  });
});
