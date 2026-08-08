import { describe, it, expect } from 'vitest';
import {
  parseBackup,
  serializeBackup,
  backupFilename,
  BACKUP_VERSION,
  type BackupFile,
} from '../../src/lib/backup';
import {
  canPregenerateBody,
  displayBody,
  notificationId,
  NO_PREVIEW_BODY,
  type NotifyKind,
} from '../../src/lib/notify';

const NOW = new Date(2026, 7, 8, 14, 30, 0).getTime();

function file(over: Partial<BackupFile> = {}): BackupFile {
  return {
    manifest: {
      version: BACKUP_VERSION,
      schemaVersion: 4,
      createdAt: NOW,
      counts: { contacts: 3, messages: 12 },
      omitted: {},
    },
    stores: { contacts: [{ id: 'a' }], messages: [] },
    ...over,
  };
}

describe('backup serialization', () => {
  it('round-trips a backup unchanged', () => {
    const original = file();
    expect(parseBackup(serializeBackup(original))).toEqual(original);
  });

  it('rejects text that is not JSON', () => {
    expect(() => parseBackup('not json at all')).toThrow(/有效的备份格式/);
  });

  it('rejects JSON that is not a backup', () => {
    expect(() => parseBackup(JSON.stringify({ hello: 'world' }))).toThrow(/manifest/);
  });

  it('rejects a backup with a corrupt version field', () => {
    const bad = JSON.stringify({ manifest: { version: 'one' }, stores: {} });
    expect(() => parseBackup(bad)).toThrow(/版本信息损坏/);
  });

  it('refuses a backup from a newer app version rather than half-reading it', () => {
    const future = file();
    future.manifest.version = BACKUP_VERSION + 1;
    expect(() => parseBackup(serializeBackup(future))).toThrow(/更新的版本/);
  });

  it('accepts a backup from an older version', () => {
    const old = file();
    old.manifest.version = 0;
    expect(() => parseBackup(serializeBackup(old))).not.toThrow();
  });

  it('preserves empty stores as empty, not missing', () => {
    // An absent store means "leave it alone"; an empty one means "wipe it".
    // Conflating the two would silently keep data the user meant to clear.
    const parsed = parseBackup(serializeBackup(file()));
    expect(parsed.stores.messages).toEqual([]);
    expect('messages' in parsed.stores).toBe(true);
  });
});

describe('backupFilename', () => {
  it('is sortable and carries the extension', () => {
    expect(backupFilename(NOW)).toBe('weixin-ai-20260808-1430.aiwx');
  });

  it('zero-pads single-digit parts', () => {
    const early = new Date(2026, 0, 3, 9, 5, 0).getTime();
    expect(backupFilename(early)).toBe('weixin-ai-20260103-0905.aiwx');
  });
});

describe('notification content grading', () => {
  it('allows a pre-written body only for time-anchored kinds', () => {
    expect(canPregenerateBody('greeting')).toBe(true);
    expect(canPregenerateBody('festival')).toBe(true);
    expect(canPregenerateBody('promise')).toBe(true);
    // A follow-up quotes a conversation that may have moved on by delivery time.
    expect(canPregenerateBody('followup')).toBe(false);
  });

  it('shows the real text for a time-anchored notification', () => {
    expect(displayBody({ kind: 'greeting', body: '早安' })).toBe('早安');
  });

  it('hides the text of a conversation-dependent notification', () => {
    expect(displayBody({ kind: 'followup', body: '你昨天说的那个事' })).toBe(NO_PREVIEW_BODY);
  });

  it('never leaks a body through the no-preview path', () => {
    const secret = '这句话不该出现在锁屏上';
    expect(displayBody({ kind: 'followup', body: secret })).not.toContain(secret);
  });
});

describe('notificationId', () => {
  it('is stable for the same key', () => {
    expect(notificationId('hb:ai_lin:1')).toBe(notificationId('hb:ai_lin:1'));
  });

  it('differs across keys', () => {
    expect(notificationId('a')).not.toBe(notificationId('b'));
  });

  it('stays inside the 32-bit range the native API accepts', () => {
    for (const k of ['a', 'hb:ai_lin:99999', '很长的中文键值'.repeat(20)]) {
      const id = notificationId(k);
      expect(Number.isInteger(id)).toBe(true);
      expect(id).toBeGreaterThanOrEqual(0);
      expect(id).toBeLessThan(2_147_483_647);
    }
  });
});

describe('every notify kind is graded', () => {
  it('covers the full union', () => {
    const kinds: NotifyKind[] = ['greeting', 'festival', 'promise', 'followup'];
    for (const k of kinds) expect(typeof canPregenerateBody(k)).toBe('boolean');
  });
});
