/**
 * Battery-whitelist wizard knowledge (M-I10). Pure — unit-tested.
 *
 * Chinese OEM ROMs kill backgrounded apps far more aggressively than AOSP, and
 * each hides the exemption switch somewhere different. This module maps
 * Build.MANUFACTURER to (a) the vendor key the Kotlin side uses to pick its
 * intent ladder, and (b) the human steps to read out on the wizard page —
 * because on several ROMs the best we can do is open the right page and tell
 * the user what to tap.
 */

export type Vendor =
  | 'xiaomi'
  | 'huawei'
  | 'oppo'
  | 'vivo'
  | 'samsung'
  | 'oneplus'
  | 'meizu'
  | 'generic';

/** Build.MANUFACTURER (lowercased, trimmed) → vendor key. */
export function detectVendor(manufacturer: string): Vendor {
  const m = manufacturer.trim().toLowerCase();
  if (!m) return 'generic';
  if (m.includes('xiaomi') || m.includes('redmi') || m.includes('poco')) return 'xiaomi';
  if (m.includes('huawei') || m.includes('honor')) return 'huawei';
  if (m.includes('oppo') || m.includes('realme')) return 'oppo';
  if (m.includes('vivo') || m.includes('iqoo')) return 'vivo';
  if (m.includes('samsung')) return 'samsung';
  if (m.includes('oneplus')) return 'oneplus';
  if (m.includes('meizu')) return 'meizu';
  return 'generic';
}

export interface VendorGuide {
  vendor: Vendor;
  /** ROM name shown on the wizard page. */
  label: string;
  /** Ordered steps the user performs after we open the vendor page. */
  steps: string[];
}

const GUIDES: Record<Vendor, VendorGuide> = {
  xiaomi: {
    vendor: 'xiaomi',
    label: 'MIUI / HyperOS（小米、红米）',
    steps: [
      '在「自启动管理」里找到「微信」，允许自启动',
      '设置 → 省电与电池 → 应用智能省电 → 微信 → 选「无限制」',
      '最近任务里下拉本应用卡片，点锁形图标锁定后台',
    ],
  },
  huawei: {
    vendor: 'huawei',
    label: 'EMUI / HarmonyOS（华为、荣耀）',
    steps: [
      '「应用启动管理」里关闭「自动管理」，改为手动并全部允许',
      '设置 → 电池 → 更多电池设置 → 保持网络连接（休眠时）',
      '最近任务里下拉本应用卡片锁定后台',
    ],
  },
  oppo: {
    vendor: 'oppo',
    label: 'ColorOS（OPPO、realme）',
    steps: [
      '「应用自启动」里允许「微信」自启动',
      '设置 → 电池 → 更多 → 应用耗电管理 → 微信 → 允许完全后台行为',
      '最近任务里点应用卡片右上角，选「锁定」',
    ],
  },
  vivo: {
    vendor: 'vivo',
    label: 'OriginOS / FuntouchOS（vivo、iQOO）',
    steps: [
      '「后台高耗电」列表里允许「微信」后台运行',
      'i管家 → 应用管理 → 权限管理 → 自启动 → 允许',
      '最近任务里下拉本应用卡片锁定',
    ],
  },
  samsung: {
    vendor: 'samsung',
    label: 'One UI（三星）',
    steps: [
      '设备维护 → 电池 → 后台使用限制 → 把「微信」加入「不受监控的应用」',
      '确保未开启「深度休眠」该应用',
    ],
  },
  oneplus: {
    vendor: 'oneplus',
    label: 'ColorOS（一加）',
    steps: ['「应用启动管理」允许自启动', '设置 → 电池 → 电池优化 → 微信 → 不优化'],
  },
  meizu: {
    vendor: 'meizu',
    label: 'Flyme（魅族）',
    steps: ['手机管家 → 权限管理 → 后台管理 → 微信 → 允许后台运行'],
  },
  generic: {
    vendor: 'generic',
    label: '原生 / 类原生 Android',
    steps: ['电池优化列表 → 所有应用 → 微信 → 选「不优化」'],
  },
};

export function guideFor(vendor: Vendor): VendorGuide {
  return GUIDES[vendor];
}

export function allVendors(): Vendor[] {
  return Object.keys(GUIDES) as Vendor[];
}
