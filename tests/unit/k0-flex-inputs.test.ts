/**
 * 「＋」按钮被输入框挤出屏幕 (M-K0 顺手抓到的真 bug)。
 *
 * flex 子项默认 `min-width: auto`，而 `<input>` / `<textarea>` 的最小内容宽是
 * 「20 个平均字宽」（size / cols 的默认值）。平均字宽取主字体：Roboto 下约 9px，
 * 20 个字 180px，放得下；系统字体是宽体 CJK 时（本容器实测，MiSans / HarmonyOS
 * 这类厂商字体同理）能到 340px——聊天页的输入框于是把右边的「＋」整个顶出
 * 屏幕。不报错、不溢出滚动条，按钮只是不见了；CI 的字体恰好够窄，所以 golden
 * 也一直是绿的。
 *
 * 规则：一个会被 flex 撑开的输入框（`flex: 1` 之类）必须同时允许收缩——
 * 写 `min-width: 0`，或者给出明确的 `width`。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(__dirname, '../../');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

function walk(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const e of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, ext));
    else if (ext.test(e.name)) out.push(p);
  }
  return out;
}

/** 挂在 <input>/<textarea> 上的 class 名（取元素开标签里第一个 className 字面量）。 */
function inputClasses(): Set<string> {
  const set = new Set<string>();
  for (const f of walk('src', /\.tsx$/)) {
    const src = read(f);
    for (const m of src.matchAll(/<(input|textarea)\b/g)) {
      // 开标签里的属性可能带 `=>`，所以不按 `>` 截，而是截到下一个元素开头或自闭合。
      const rest = src.slice(m.index! + m[0].length, m.index! + 700);
      const end = rest.search(/\/>|\n\s*<[A-Za-z]/);
      const tag = end === -1 ? rest : rest.slice(0, end);
      const cls = tag.match(/className="([^"]+)"/);
      if (cls) for (const c of cls[1].split(/\s+/)) set.add(c);
    }
  }
  return set;
}

type Rule = { file: string; selector: string; body: string };

function cssRules(): Rule[] {
  const rules: Rule[] = [];
  for (const f of walk('src', /\.css$/)) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const sel of m[1].split(',')) rules.push({ file: f, selector: sel.trim(), body: m[2] });
    }
  }
  return rules;
}

/** 选择器的最后一个复合选择器是否落在输入框上。 */
function targetsInput(selector: string, classes: Set<string>): boolean {
  const last = selector.split(/[\s>+~]+/).filter(Boolean).pop() ?? '';
  if (/^(input|textarea)\b/.test(last)) return true;
  return [...last.matchAll(/\.([\w-]+)/g)].some((c) => classes.has(c[1]));
}

const grows = (body: string) => /(^|[;\s])flex:\s*1\b|flex-grow:\s*[1-9]/.test(body);
const canShrink = (body: string) =>
  /min-width:\s*0\b/.test(body) || /(^|[;\s])width:\s*[^;]+/.test(body.replace(/(min|max)-width/g, ''));

describe('flex 里的输入框必须能缩', () => {
  const classes = inputClasses();

  it('解析器没有失明：认出了输入框的 class，也扫到了组合器那条规则', () => {
    expect(classes.has('composer__input')).toBe(true);
    expect(classes.has('money-form__input')).toBe(true);
    const composer = cssRules().filter((r) => r.selector === '.composer__input');
    expect(composer.length).toBeGreaterThan(0);
  });

  it('每个 flex 撑开的输入框都声明了 min-width: 0（或明确宽度）', () => {
    const offenders = cssRules()
      .filter((r) => targetsInput(r.selector, classes) && grows(r.body) && !canShrink(r.body))
      .map((r) => `${r.file}: ${r.selector}`);
    expect(
      offenders,
      '输入框的最小内容宽是 20 个字宽；宽体字体下它会把同一行的按钮顶出屏幕',
    ).toEqual([]);
  });

  it('聊天页组合器：输入框外面那层 pill 也必须能缩（它才是被分配宽度的 flex 子项）', () => {
    const pill = cssRules().find((r) => r.selector === '.composer__pill');
    expect(pill, '.composer__pill 规则不见了').toBeDefined();
    expect(pill!.body).toMatch(/min-width:\s*0\b/);
  });
});
