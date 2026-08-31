import { describe, it, expect } from 'vitest';
import { detectVendor, guideFor, allVendors } from '../../src/native/battery';

/** Battery-whitelist wizard knowledge (M-I10). */
describe('detectVendor', () => {
  it('maps the big Chinese OEM families, sub-brands included', () => {
    expect(detectVendor('Xiaomi')).toBe('xiaomi');
    expect(detectVendor('POCO')).toBe('xiaomi');
    expect(detectVendor('HUAWEI')).toBe('huawei');
    expect(detectVendor('HONOR')).toBe('huawei');
    expect(detectVendor('OPPO')).toBe('oppo');
    expect(detectVendor('realme')).toBe('oppo');
    expect(detectVendor('vivo')).toBe('vivo');
    expect(detectVendor('iQOO')).toBe('vivo');
    expect(detectVendor('samsung')).toBe('samsung');
    expect(detectVendor('OnePlus')).toBe('oneplus');
    expect(detectVendor('Meizu')).toBe('meizu');
  });

  it('unknown / emulator manufacturers degrade to generic, never throw', () => {
    expect(detectVendor('Google')).toBe('generic');
    expect(detectVendor('unknown')).toBe('generic');
    expect(detectVendor('')).toBe('generic');
    expect(detectVendor('  ')).toBe('generic');
  });
});

describe('guideFor', () => {
  it('every vendor has a label and at least one human step', () => {
    for (const v of allVendors()) {
      const g = guideFor(v);
      expect(g.vendor).toBe(v);
      expect(g.label.length).toBeGreaterThan(0);
      expect(g.steps.length).toBeGreaterThan(0);
      for (const s of g.steps) expect(s.trim().length).toBeGreaterThan(0);
    }
  });
});
