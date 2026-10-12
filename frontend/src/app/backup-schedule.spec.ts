import { backupDue } from './backup-schedule';
import { validPreferences, defaults } from './preferences.service';
describe('Scheduled Drive backups', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  it('runs only due schedules, including catch-up after a missed unlocked session', () => {
    expect(backupDue('manual', '', now)).toBe(false);
    expect(backupDue('daily', '', now)).toBe(true);
    expect(backupDue('daily', new Date(now + 86400000).toISOString(), now)).toBe(true);
    expect(backupDue('daily', new Date(now - 86399999).toISOString(), now)).toBe(false);
    expect(backupDue('daily', new Date(now - 86400000).toISOString(), now)).toBe(true);
    expect(backupDue('weekly', new Date(now - 8 * 86400000).toISOString(), now)).toBe(true);
    expect(backupDue('monthly', new Date(now - 29 * 86400000).toISOString(), now)).toBe(false);
    expect(backupDue('monthly', new Date(now - 31 * 86400000).toISOString(), now)).toBe(true);
  });
  it('preserves older backup preferences and rejects unsafe retention or frequency', () => {
    expect(validPreferences({ timezone: 'Asia/Kolkata', theme: 'light', trash_days: 30 })).toBe(
      true,
    );
    expect(validPreferences({ ...defaults, backup_keep: 2 })).toBe(false);
    expect(validPreferences({ ...defaults, backup_keep: 101 })).toBe(false);
    expect(validPreferences({ ...defaults, backup_frequency: 'invalid' } as any)).toBe(false);
  });
});
