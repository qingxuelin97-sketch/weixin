import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pinyinInitialOf, OTHER_INITIAL } from '../../src/lib/pinyin-initial';

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/**
 * A-Z 索引的数据侧 (M-I18).
 *
 * The index rail has been real since M-I6 — touch-drag, section anchors, the
 * lot — but every contact the app creates was written with `pinyinInitial:
 * '#'`. Real letters existed only on the four seeded contacts, so a week of
 * use left the rail showing "↑ ☆ #" plus four letters: a control that looks
 * functional and files every new person under 其它.
 */
describe('pinyinInitialOf', () => {
  it('maps common surnames to their real initial', () => {
    const cases: Array<[string, string]> = [
      ['林小雨', 'L'],
      ['陈叔', 'C'],
      ['阿达', 'A'],
      ['猫饼', 'M'],
      ['王伟', 'W'],
      ['张三', 'Z'],
      ['欧阳娜', 'O'],
      ['孙悦', 'S'],
      ['韩梅梅', 'H'],
      ['郭靖', 'G'],
    ];
    for (const [name, want] of cases) {
      expect(pinyinInitialOf(name), name).toBe(want);
    }
  });

  it('uppercases latin names and files everything else under #', () => {
    expect(pinyinInitialOf('ada')).toBe('A');
    expect(pinyinInitialOf('Bob')).toBe('B');
    expect(pinyinInitialOf('123')).toBe(OTHER_INITIAL);
    expect(pinyinInitialOf('🐱')).toBe(OTHER_INITIAL);
    expect(pinyinInitialOf('')).toBe(OTHER_INITIAL);
    expect(pinyinInitialOf('   ')).toBe(OTHER_INITIAL);
  });

  it('is stable — the same name always lands in the same section', () => {
    expect(pinyinInitialOf('林小雨')).toBe(pinyinInitialOf('林小雨'));
  });
});

describe('每条建联系人的路径都推导首字母', () => {
  // Add a fourth creation path without deriving an initial and this turns red.
  const CREATORS = [
    'src/features/contacts/NewContactPage.tsx',
    'src/features/contacts/PersonaGeneratePage.tsx',
    'src/ai/group-build.ts',
  ];

  for (const rel of CREATORS) {
    it(`${rel} derives pinyinInitial instead of hard-coding #`, () => {
      const src = read(rel);
      expect(src).toMatch(/pinyinInitial:\s*pinyinInitialOf\(/);
      expect(src).not.toMatch(/pinyinInitial:\s*'#'/);
    });
  }
});

/**
 * 长按菜单的开启闸门 (M-I18). The gate still asked the I5-era question — is
 * there copy / recall / regenerate? — while the menu had since grown 收藏,
 * 转发 and 多选, which apply to every type. So a long press on a photo, a
 * voice clip, a location, a link or a card did nothing at all, which reads as
 * a broken gesture; it is also why most of the favorites page's type filters
 * could never collect anything.
 */
describe('长按菜单对所有消息类型开启', () => {
  it('opens for anything that is still a message', () => {
    const src = read('src/features/chat/ChatPage.tsx');
    expect(src).toMatch(/if \(m\.type !== 'system' && !m\.isRecalled\) setMenu\(/);
    // The old type-narrow condition must be gone from the gate.
    expect(src).not.toMatch(/if \(hasCopy \|\| canRecall\(m, Date\.now\(\)\) \|\| canRegen\)/);
  });

  it('still gates each menu ITEM individually', () => {
    const src = read('src/features/chat/ChatPage.tsx');
    // Copy only for text with content; recall only inside its window.
    expect(src).toMatch(/menu\.msg\.type === 'text' && menu\.msg\.content/);
    expect(src).toMatch(/canRecall\(menu\.msg, Date\.now\(\)\)/);
  });
});

/** 资料页补全 (M-I18): remark had a dozen readers and zero writers. */
describe('联系人资料页', () => {
  const src = read('src/features/contacts/ContactProfilePage.tsx');

  it('can set a remark, and clearing it is allowed', () => {
    expect(src).toContain('备注名');
    expect(src).toMatch(/putContact\(\{ \.\.\.contact, remark:/);
    expect(src).toContain('allowEmpty: true');
  });

  it('links to the person’s moments album', () => {
    expect(src).toMatch(/moments\/album\/\$\{contactId\}/);
  });
});
