/**
 * 聊天输入偏好 (M-K4)：设备级、同步可读，存 localStorage（与提示音开关同一类，
 * 不进 .aiwx 备份——它是这台手机上的打字习惯，不是关系资产）。
 */
const ENTER_KEY = 'chat.enterToSend';

/**
 * 回车键发送消息。默认**开**：这是本 App 一直以来的行为（微信手机端默认关），
 * 改默认值会让老用户一按回车发现消息没出去。关掉后回车换行，只有「发送」键发。
 */
export function enterToSend(): boolean {
  try {
    return localStorage.getItem(ENTER_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setEnterToSend(on: boolean): void {
  try {
    localStorage.setItem(ENTER_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}
