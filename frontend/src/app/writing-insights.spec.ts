import { backupHealth, parseTags, recordVersions, writingStreak } from './writing-insights';
import { validatePayload } from './vault-crypto';
import type { LocalBackup } from './backup-store';

describe('Writing insights and private metadata', () => {
  it('counts consecutive saved civil dates across months/leap days, ignoring future dates and duplicates', () => {
    expect(
      writingStreak(
        ['2024-02-28', '2024-02-29', '2024-03-01', '2024-03-01', '2099-01-01'],
        '2024-03-01',
      ),
    ).toEqual({ current: 3, best: 3, total: 3 });
    expect(writingStreak(['2024-02-28', '2024-02-29', '2024-03-01'], '2024-03-02').current).toBe(3);
    expect(writingStreak(['2024-02-28', '2024-02-29', '2024-03-01'], '2024-03-03').current).toBe(0);
    expect(writingStreak([], '2024-03-03')).toEqual({ current: 0, best: 0, total: 0 });
  });
  it('trims and deduplicates tags and validates bounded metadata without breaking old entries', () => {
    expect(parseTags(' Work, Travel, work, , ')).toEqual(['work', 'Travel']);
    expect(() => parseTags('x'.repeat(33))).toThrow();
    expect(() => parseTags(Array.from({ length: 11 }, (_, i) => 'tag' + i).join(','))).toThrow();
    const old = {
      date: '2024-02-29',
      title: 'Title',
      body: 'Body',
      trashed: false,
      created_at: '2024-02-29T00:00:00Z',
      updated_at: '2024-02-29T00:00:00Z',
    };
    expect(validatePayload(old)).toEqual(old);
    expect(validatePayload({ ...old, mood: 'Calm', tags: ['Work'] }).mood).toBe('Calm');
    expect(() => validatePayload({ ...old, tags: ['Work', 'work'] })).toThrow();
    expect(() => validatePayload({ ...old, mood: 'unsupported' } as any)).toThrow();
  });
  it('distinguishes current full browser backups from emergency exports and unrelated vaults', () => {
    const now = Date.parse('2026-10-12T12:00:00Z');
    const copy = (id: string, age: number, source = 'export') =>
      ({
        source,
        saved_at: new Date(now - age).toISOString(),
        archive: { vault_id: id },
      }) as LocalBackup;
    expect(
      backupHealth([copy('other', 0), copy('mine', 0, 'unsaved-text')], 'mine', 0, now).kind,
    ).toBe('missing');
    expect(backupHealth([copy('mine', 3600000)], 'mine', 0, now).kind).toBe('recent');
    expect(backupHealth([copy('mine', 3600000)], 'mine', now, now).kind).toBe('changed');
    expect(backupHealth([copy('mine', 86400000)], 'mine', 0, now).kind).toBe('overdue');
    expect(backupHealth([], 'mine', 0, now).kind).toBe('missing');
    const saved = {
      ...copy('mine', 0),
      record_versions: recordVersions([{ id: 'entry', revision: 1 }]),
    };
    expect(backupHealth([saved], 'mine', 0, now, '').kind).toBe('changed');
    expect(
      backupHealth([saved], 'mine', 0, now, recordVersions([{ id: 'entry', revision: 2 }])).kind,
    ).toBe('changed');
  });
});
