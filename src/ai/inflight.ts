/**
 * 单聊的在途回复登记表 (M-K11，从 engine.ts 抽出)。
 *
 * 只为一件事单独成文件：store 的删联系人级联要调 `abortConversation`，而它以前
 * 从 engine.ts 静态导入——就这一行，把整棵引擎树（prompt 分层、记忆、几十个指令
 * 模块）钉在了冷启动主包里，哪怕 App 打开到会话列表一个字都不会生成。登记表本身
 * 只是一个 Map；引擎照旧经由这里认领与释放槽位（并转导出 abortConversation）。
 */

/** Per-conversation in-flight controller so a new send cancels the old reply. */
export const inFlight = new Map<string, AbortController>();

/**
 * Release the slot, but only if it is still ours — a newer send may have taken
 * it over, and deleting unconditionally would let two replies play at once.
 *
 * The slot doubles as the "she is mid-conversation" guard for heartbeats, so a
 * leaked entry does not merely waste a Map key: it permanently silences that
 * AI's proactive messages for the rest of the process. It leaked whenever a
 * storage read threw between claiming the slot and entering the generator's
 * own try/finally — i.e. exactly on the failure paths, where losing her voice
 * is least recoverable and hardest to notice.
 */
export function releaseInFlight(convId: string, ctrl: AbortController): void {
  if (inFlight.get(convId) === ctrl) inFlight.delete(convId);
}

/**
 * Hard-stop whatever this conversation is generating (M-I1).
 *
 * Exists for the deleteContact cascade: a reply that lands AFTER its thread
 * was deleted re-creates message rows for a conversation that no longer has a
 * contact. The map slot is cleared too — this abort is deliberate teardown,
 * not a takeover by a newer send.
 */
export function abortConversation(convId: string): void {
  inFlight.get(convId)?.abort();
  inFlight.delete(convId);
}
