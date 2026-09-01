/**
 * `.aiwx` 备份的可选加密 (M-J10)。
 *
 * 明文备份里躺着**全部隐藏私信**（AI↔AI 的那些会话）、全部记忆事实、全部朋友圈。
 * 这个 App 花了很大力气让隐藏会话不泄漏到任何用户可见面（`search()` 内部过滤、
 * 收藏页、通知、导出预览逐个审过），而导出一份明文 JSON 到手机的下载目录，
 * 一次就把那些努力全部绕过去了。这是仓库里最后一处「导出即泄漏」。
 *
 * 与 `keystore.ts` 的关系：**没有关系，而且必须没有**。keystore 用一把
 * `extractable: false` 的设备本机主密钥封 API key，那把钥匙的全部价值就在于它
 * 出不去；这里的密钥是从用户口令现场派生的，用完就扔。两者共用一把钥匙会
 * 立刻毁掉前者（备份要能在另一台设备上解开＝密钥必须可导出）。
 * `__crypto_master` 那一行仍然由 `isPortableSettingRow` 行级排除——加密不是
 * 把它带上的理由，而且带上了也没用：另一台设备的 IndexedDB 里放一把别人的
 * CryptoKey 只会让 keystore 永久解不开。
 *
 * 格式（信封本身是明文 JSON，这样 `parseBackup` 之前就能认出它并去要口令）：
 *   { aiwx: 'enc', v: 1, kdf: 'PBKDF2-SHA256', iter, salt, iv, ct }
 * salt/iv/ct 都是 base64。
 */

/** 信封标记。旧的明文包没有这个字段，据此区分。 */
const ENVELOPE_TAG = 'enc';
const ENVELOPE_VERSION = 1;

/**
 * PBKDF2 轮数。
 *
 * 10 万在手机 WebView 上大约几百毫秒——**慢**是这里唯一的功能。用户一年导几次
 * 备份，等半秒无感；而对着一个离线文件暴力猜口令的人，每猜一次都要付同样的
 * 半秒。调低它等于把这个功能变成装饰。
 */
const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const IV_BYTES = 12; // AES-GCM 的标准长度

const b64 = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  // 分块拼接：几十 MB 的备份一次 String.fromCharCode(...bytes) 会爆栈。
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
};

const unb64 = (s: string): Uint8Array => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

interface Envelope {
  aiwx: typeof ENVELOPE_TAG;
  v: number;
  kdf: string;
  iter: number;
  salt: string;
  iv: string;
  ct: string;
}

/**
 * 这段文本是加密包吗？
 *
 * 恢复流程**先问这个再决定要不要要口令**——反过来（先解析失败再猜是不是加密的）
 * 会把「文件损坏」和「需要口令」两种情况混成一句话，而用户对这两句的反应完全
 * 不同：一个去找口令，一个去找另一个备份文件。
 */
export function isEncryptedBackup(text: string): boolean {
  try {
    const o = JSON.parse(text) as Partial<Envelope>;
    return o?.aiwx === ENVELOPE_TAG && typeof o.ct === 'string';
  } catch {
    return false;
  }
}

async function deriveKey(passphrase: string, salt: Uint8Array, iter: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations: iter, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false, // 派生出来的这把也不必可导出——它只在本次调用里用一次
    ['encrypt', 'decrypt'],
  );
}

/** 空口令不是「不加密」，是用户按错了。调用方应该在这之前就拦住。 */
export class EmptyPassphraseError extends Error {
  constructor() {
    super('口令不能为空');
  }
}

/** 口令错 / 文件被改过。AES-GCM 认证失败时区分不了这两者，也不必区分。 */
export class BadPassphraseError extends Error {
  constructor() {
    super('口令不对，或备份文件已损坏');
  }
}

export async function encryptBackup(plaintext: string, passphrase: string): Promise<string> {
  if (!passphrase) throw new EmptyPassphraseError();
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    new TextEncoder().encode(plaintext),
  );
  const env: Envelope = {
    aiwx: ENVELOPE_TAG,
    v: ENVELOPE_VERSION,
    kdf: 'PBKDF2-SHA256',
    iter: PBKDF2_ITERATIONS,
    salt: b64(salt),
    iv: b64(iv),
    ct: b64(ct),
  };
  return JSON.stringify(env);
}

/**
 * 解开一个加密包。
 *
 * `iter` 从**文件里**读而不是用常量：调高轮数之后，旧文件还得能开。这是加密
 * 格式最容易埋的一个坑——把参数写死在代码里，等于让每次调参都作废一批备份。
 */
export async function decryptBackup(text: string, passphrase: string): Promise<string> {
  if (!passphrase) throw new EmptyPassphraseError();
  let env: Envelope;
  try {
    env = JSON.parse(text) as Envelope;
  } catch {
    throw new Error('文件不是有效的备份格式');
  }
  if (env?.aiwx !== ENVELOPE_TAG) throw new Error('这不是一个加密备份');
  if (env.v > ENVELOPE_VERSION) {
    throw new Error(`加密备份来自更新的版本（v${env.v}），请先升级 App`);
  }
  const key = await deriveKey(passphrase, unb64(env.salt), env.iter || PBKDF2_ITERATIONS);
  let pt: ArrayBuffer;
  try {
    pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(env.iv) as unknown as BufferSource },
      key,
      unb64(env.ct) as unknown as BufferSource,
    );
  } catch {
    // GCM 的认证失败。**不要**在这里返回半截明文——错口令必须是一次干净的
    // 失败，而不是一个能被写回数据库的损坏包。
    throw new BadPassphraseError();
  }
  return new TextDecoder().decode(pt);
}
