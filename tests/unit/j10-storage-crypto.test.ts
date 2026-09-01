/**
 * 数据层完全体 (M-J10)：存储用量 + 备份加密。
 *
 * 备份加密那一组是重点。它守的不是「能加能解」——那是任何一个 AES 例子都能过的
 * ——而是三条**失败时的行为**：
 *   1. 口令错了必须是一次干净的失败，绝不能返回半截明文让调用方写回数据库；
 *   2. 加密不能变成「顺便把设备本机密钥也带上」的借口（`__crypto_master` 出去
 *      一次，另一台设备的 keystore 就永久解不开）；
 *   3. KDF 轮数必须从**文件里**读，否则将来调参会作废一批旧备份。
 */
import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import {
  BadPassphraseError,
  EmptyPassphraseError,
  decryptBackup,
  encryptBackup,
  isEncryptedBackup,
} from '../../src/lib/backup-crypto';
import { repo } from '../../src/db/repo';

const SECRET = JSON.stringify({
  manifest: { version: 3, schemaVersion: 8, createdAt: 1, counts: {}, omitted: {} },
  stores: { messages: [{ id: 1, content: '这句话不该出现在密文里' }] },
});

describe('备份加密', () => {
  it('往返：加密再解密拿回一模一样的字节', async () => {
    const enc = await encryptBackup(SECRET, 'hunter22');
    expect(await decryptBackup(enc, 'hunter22')).toBe(SECRET);
  });

  it('密文里看不到原文（听起来废话，但写错 nonce/复用 key 就会漏）', async () => {
    const enc = await encryptBackup(SECRET, 'hunter22');
    expect(enc).not.toContain('这句话不该出现在密文里');
    expect(enc).not.toContain('messages');
  });

  it('同一份明文两次加密的密文不同（salt/iv 每次新生成）', async () => {
    const a = await encryptBackup(SECRET, 'hunter22');
    const b = await encryptBackup(SECRET, 'hunter22');
    expect(a).not.toBe(b);
    // 但两个都能用同一个口令解开。
    expect(await decryptBackup(b, 'hunter22')).toBe(SECRET);
  });

  /**
   * 最重要的一条。GCM 认证失败时**必须抛**，绝不能返回一段解出来的垃圾——
   * 恢复流程拿到字符串就会去 parseBackup，一个「像 JSON 的垃圾」比一次干净的
   * 失败危险得多：它会覆盖用户的真数据。
   */
  it('口令错 = 抛 BadPassphraseError，绝不返回半截明文', async () => {
    const enc = await encryptBackup(SECRET, 'hunter22');
    await expect(decryptBackup(enc, 'hunter23')).rejects.toBeInstanceOf(BadPassphraseError);
  });

  it('密文被改一个字节也认证失败（不是只校验口令）', async () => {
    const enc = await encryptBackup(SECRET, 'hunter22');
    const env = JSON.parse(enc) as { ct: string };
    // 翻掉密文最后一个 base64 字符——GCM 的 tag 应该发现。
    const flipped = env.ct.slice(0, -1) + (env.ct.endsWith('A') ? 'B' : 'A');
    const tampered = JSON.stringify({ ...JSON.parse(enc), ct: flipped });
    await expect(decryptBackup(tampered, 'hunter22')).rejects.toBeInstanceOf(BadPassphraseError);
  });

  it('空口令是「按错了」不是「不加密」', async () => {
    await expect(encryptBackup(SECRET, '')).rejects.toBeInstanceOf(EmptyPassphraseError);
    await expect(decryptBackup('{}', '')).rejects.toBeInstanceOf(EmptyPassphraseError);
  });

  it('认得出加密包，也认得出明文包（恢复流程据此决定要不要问口令）', async () => {
    expect(isEncryptedBackup(await encryptBackup(SECRET, 'x1234567'))).toBe(true);
    expect(isEncryptedBackup(SECRET)).toBe(false);
    expect(isEncryptedBackup('不是 JSON')).toBe(false);
  });

  /**
   * KDF 轮数写死在代码里 = 将来调高轮数就作废一批旧备份。这条钉住「从文件读」。
   */
  it('轮数从文件里读，不是用当前常量', async () => {
    const enc = await encryptBackup(SECRET, 'hunter22');
    const env = JSON.parse(enc) as { iter: number };
    expect(env.iter).toBeGreaterThanOrEqual(100_000);
    // 把文件的轮数改掉后必须解不开——说明解密真的用了文件里那个值，
    // 而不是无视它直接拿常量。
    const wrongIter = JSON.stringify({ ...JSON.parse(enc), iter: 1000 });
    await expect(decryptBackup(wrongIter, 'hunter22')).rejects.toBeInstanceOf(BadPassphraseError);
  });

  /**
   * 加密不是把设备本机密钥带出去的借口。`__crypto_master` 是一把
   * `extractable:false` 的 CryptoKey，它一旦被写进备份并在另一台设备上恢复，
   * 那台机器的 keystore 就永久解不开（CLAUDE.md 的 CryptoKey 陷阱）。
   * 排除仍然由 `isPortableSettingRow` 行级完成，与加不加密无关。
   */
  it('设备本机密钥行仍然被排除（加密不改变这条）', async () => {
    const { isPortableSettingRow } = await import('../../src/lib/device-local');
    expect(isPortableSettingRow({ key: '__crypto_master', value: {} })).toBe(false);
    expect(isPortableSettingRow({ key: 'autoBackupFreq', value: 'daily' })).toBe(true);
  });
});

describe('存储用量', () => {
  it('报告里每个 store 都有行数，且键集合与 STORES 一致', async () => {
    const { STORES } = await import('../../src/db/idb');
    const r = await repo.storageReport();
    expect(r.stores.map((s) => s.name).sort()).toEqual(STORES.map((s) => s.name).sort());
    for (const s of r.stores) expect(s.rows).toBeGreaterThanOrEqual(0);
  });

  it('拿不到 estimate() 时返回 0/0，而不是编一个「还早着呢」', async () => {
    // jsdom 没有 navigator.storage.estimate；这正是被测的那条路径。
    const r = await repo.storageReport();
    expect(r.usage).toBe(0);
    expect(r.quota).toBe(0);
  });

  it('媒体按 kind 聚合，字节数从 blob.size 来', async () => {
    await repo.putMedia({
      id: 'm_test_1',
      kind: 'photo',
      tags: [],
      mime: 'image/png',
      blob: new Blob([new Uint8Array(1234)]),
      createdAt: 1,
    });
    const r = await repo.storageReport();
    const photo = r.media.find((m) => m.kind === 'photo');
    expect(photo?.count).toBeGreaterThanOrEqual(1);
    expect(photo?.bytes).toBeGreaterThanOrEqual(1234);
  });
});
