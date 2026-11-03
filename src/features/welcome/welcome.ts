/**
 * 首次体验 (M-K9) 的规则与问候排期。页面只管画；会不会出现、问候怎么排都在这里。
 * 设计见 specs/onboarding.md。
 */
import { actionExists, enqueue } from '../../ai/scheduler';

/** localStorage：这台设备走完（或跳过）了引导。与 ui.theme 同类，不进 settings、不进备份。 */
export const ONBOARDED_KEY = 'ui.onboarded';
/** 进入会话列表之后多久，第一条问候落地。人刚回到列表，角标亮起、提示音响。 */
export const GREETING_DELAY_MS = 4_000;

/**
 * 只给全新安装看——仓库是这次水合才写进种子的，且这台设备没走过引导。
 * 已经在用的人（仓库非空）永远不会被拦住。
 */
export function shouldOnboard(freshInstall: boolean, onboarded: boolean): boolean {
  return freshInstall && !onboarded;
}

export function isOnboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARDED_KEY) === '1';
  } catch {
    // Storage blocked: never trap anyone in a guide they cannot mark as done.
    return true;
  }
}

export function markOnboarded(): void {
  try {
    localStorage.setItem(ONBOARDED_KEY, '1');
  } catch {
    /* best effort — a guide that shows twice beats one that blocks */
  }
}

export const welcomeGreetingId = (contactId: string) => `welcome_${contactId}`;

/**
 * 第一条问候：一行一次性的 heartbeat（铁律 5：随时间发生的事只走 scheduled_actions）。
 *
 * - payload 带 `at`（= fireAt）：按 `isChainOneOff` 是一次性行——不续链，也不被当成
 *   「这个人的心跳链已就位」（M-K9 修的分叉病正出在这里）；handler 用它给消息盖时间戳。
 * - 没有预写 body：handler 走 sendProactiveMessage，她用接上的模型、按自己的人设现在开口。
 * - id 固定、排之前问 `actionExists`：一辈子一次（宪法 2，enqueue 按 id upsert）。
 *
 * 返回是否真的排上了。
 */
export async function scheduleWelcomeGreeting(
  contactId: string,
  convId: string,
  now: number,
): Promise<boolean> {
  const id = welcomeGreetingId(contactId);
  if (await actionExists(id)) return false;
  const fireAt = now + GREETING_DELAY_MS;
  await enqueue({
    kind: 'heartbeat',
    fireAt,
    payload: { contactId, convId, at: fireAt, welcome: true },
    now,
    id,
  });
  return true;
}
