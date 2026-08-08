/**
 * Secret storage for API keys.
 *
 * Web/PWA driver: the key VALUE is encrypted with a non-extractable AES-GCM
 * CryptoKey (generated once, kept in IndexedDB where its material can't be read
 * out) and the ciphertext lives in localStorage. The DB only ever stores a
 * `keyAlias`, never the plaintext key (constitution rule #2).
 *
 * At M3 the APK swaps this module for Android Keystore behind the same API.
 */
import { idbGet, idbPut } from '../db/idb';

const MASTER_ROW_KEY = '__crypto_master';
const LS_PREFIX = 'secret.';

async function getMasterKey(): Promise<CryptoKey> {
  const existing = await idbGet<{ key: string; value: CryptoKey }>('settings', MASTER_ROW_KEY);
  // instanceof, not truthiness: a restore from an old backup could have written
  // a `{}` husk here (CryptoKey JSON-serializes to nothing), and handing that
  // to WebCrypto throws on every call. Regenerating self-heals such devices —
  // previously-saved secrets are lost either way, but saving works again.
  if (existing?.value instanceof CryptoKey) return existing.value;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  // CryptoKey is structured-cloneable; storing it (non-extractable) keeps the
  // material out of JS while letting us encrypt/decrypt later.
  await idbPut('settings', { key: MASTER_ROW_KEY, value: key });
  return key;
}

function toB64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
/** Decode base64 to a fresh ArrayBuffer (a valid BufferSource for WebCrypto). */
function fromB64(s: string): ArrayBuffer {
  const bytes = Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return buf;
}

/** Encrypt and persist a secret under an alias. */
export async function setSecret(alias: string, plaintext: string): Promise<void> {
  const key = await getMasterKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ptBytes = new TextEncoder().encode(plaintext);
  const ptBuf = new ArrayBuffer(ptBytes.byteLength);
  new Uint8Array(ptBuf).set(ptBytes);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, ptBuf);
  const ivBuf = new ArrayBuffer(iv.byteLength);
  new Uint8Array(ivBuf).set(iv);
  const payload = JSON.stringify({ iv: toB64(ivBuf), ct: toB64(ct) });
  localStorage.setItem(LS_PREFIX + alias, payload);
}

/** Decrypt a secret by alias; returns null if absent or undecryptable. */
export async function getSecret(alias: string): Promise<string | null> {
  const raw = localStorage.getItem(LS_PREFIX + alias);
  if (!raw) return null;
  try {
    const { iv, ct } = JSON.parse(raw) as { iv: string; ct: string };
    const key = await getMasterKey();
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(iv) },
      key,
      fromB64(ct),
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

export function hasSecret(alias: string): boolean {
  return localStorage.getItem(LS_PREFIX + alias) != null;
}

export function deleteSecret(alias: string): void {
  localStorage.removeItem(LS_PREFIX + alias);
}
