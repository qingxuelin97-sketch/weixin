import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 一个 BEM 块只能有一个功能域主人 (M-I18).
 *
 * M-I13 added a 名片 message bubble and called its block `.contact-card`. That
 * name was already taken: `ContactProfilePage` has carried
 * `className="page-body contacts contact-card"` since M-B, with `contacts.css`
 * owning its BEM children (`__head`, `__avatar`, `__name`…). Two features then
 * owned one name, and `chat.css`'s new BLOCK rule — `width: 232px;
 * overflow: hidden; padding: 0` — matched the profile page's body. Same
 * specificity, bundled later, so it won.
 *
 * The profile page became a 232px column with bare shell beside it, and
 * `overflow: hidden` beat `.page-body`'s `overflow-y: auto`, so it could not
 * scroll at all — 「记忆管理」/「删除联系人」 unreachable for any contact with a
 * long persona. The golden froze the broken layout as the baseline (I13 merged
 * before that shot was first taken), so the screenshot gate could never see it.
 *
 * Two independent agents each invented a "contact card"; neither could see the
 * other, and reviewing either diff alone shows nothing wrong. Only a whole-repo
 * invariant catches that shape, so this checks the repo, not the diff.
 *
 * Scope is deliberately BEM ownership, not "cross-feature class use":
 * `settings.css` is used as a de-facto shared widget library across features
 * (noted as debt in the M-G audit, still true), and `src/styles/motion.css`
 * layers animation onto blocks other sheets own. Both are intentional; two
 * FEATURES claiming one namespace never is.
 */

const ROOT = join(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.css')) out.push(p);
  }
  return out;
}

const rel = (f: string) => f.slice(ROOT.length + 1);
/** 'src/features/chat/chat.css' → 'chat'. Non-feature sheets are layers, not owners. */
const featureOf = (f: string): string | null =>
  /^src\/features\/([^/]+)\//.exec(rel(f))?.[1] ?? null;

/** BEM blocks this sheet defines children for: `.foo__bar { … }` ⇒ owns `foo`. */
function namespacesIn(file: string): Set<string> {
  const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  return new Set([...css.matchAll(/\.([A-Za-z0-9-]+?)__[A-Za-z0-9_-]+/g)].map((m) => m[1]));
}

describe('一个 BEM 块只能有一个功能域主人', () => {
  it('no two features own the same block name', () => {
    const owners = new Map<string, Set<string>>();
    for (const css of walk(join(ROOT, 'src'))) {
      const feature = featureOf(css);
      if (!feature) continue;
      for (const ns of namespacesIn(css)) {
        if (!owners.has(ns)) owners.set(ns, new Set());
        owners.get(ns)!.add(`${feature} (${rel(css)})`);
      }
    }
    const shared = [...owners.entries()]
      .filter(([, fs]) => fs.size > 1)
      .map(([ns, fs]) => `.${ns} 被 ${[...fs].sort().join(' 和 ')} 同时认领`);

    expect(
      shared,
      '两个功能域各自认领了同一个块名。后加载的样式表会赢，而两边的作者都看不见' +
        '对方——I13 的名片气泡就是这样把联系人资料页压成 232px 且不可滚动的，' +
        '而且被 golden 当成基线固化了下来。给新块换个名字，别共用。',
    ).toEqual([]);
  });

  it('still sees the namespaces it is supposed to be watching', () => {
    // Without this, a regex that stopped matching would make the check above
    // pass by finding nothing at all — the vacuous-green shape this round has
    // now hit twice.
    const ns = namespacesIn(join(ROOT, 'src/features/contacts/contacts.css'));
    expect([...ns].sort()).toEqual(['contact-card', 'contacts', 'persona-gen']);
  });
});
