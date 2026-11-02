/**
 * 金额键盘的输入规则 (M-K3)，纯函数。
 *
 * 微信转账页用自己的数字键盘而不是系统键盘：系统数字键盘各家 ROM 长得不一样，
 * 有的没有小数点、有的会弹出全键盘，而钱这件事容不得「输进去的不是你以为的」。
 * 规则只有四条，与微信一致：
 *   1. 至多一个小数点，小数点后至多两位（「分」是最小单位，铁律 3）；
 *   2. 开头的 0 只能跟着小数点（不会出现 "007"）；空串直接按「.」得到 "0."；
 *   3. 整数部分至多 6 位（单笔转账的模拟上限是 999,999.99 元）；
 *   4. 退格删最后一个字符。
 */
export type AmountKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '.' | 'del';

export const MAX_INT_DIGITS = 6;

export function applyAmountKey(amount: string, key: AmountKey): string {
  if (key === 'del') return amount.slice(0, -1);
  if (key === '.') {
    if (amount.includes('.')) return amount;
    return amount === '' ? '0.' : `${amount}.`;
  }
  const dot = amount.indexOf('.');
  if (dot >= 0) {
    return amount.length - dot - 1 >= 2 ? amount : amount + key;
  }
  if (amount === '0') return key;
  if (amount.length >= MAX_INT_DIGITS) return amount;
  return amount + key;
}
