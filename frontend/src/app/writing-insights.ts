import { validCivilDate } from './vault-crypto';
import type { LocalBackup } from './backup-store';

export function parseTags(text: string): string[] {
  const tags = [
    ...new Map(
      text
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => [t.toLocaleLowerCase(), t]),
    ).values(),
  ];
  if (tags.length > 10 || tags.some((t) => Array.from(t).length > 32))
    throw new Error('Use up to 10 tags, each at most 32 characters.');
  return tags;
}
function previous(date: string): string {
  const day = new Date(date + 'T12:00:00Z');
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}
export function writingStreak(dates: Iterable<string>, today: string) {
  const days = [...new Set([...dates].filter((d) => validCivilDate(d) && d <= today))].sort();
  let best = 0,
    run = 0,
    last = '';
  for (const date of days) {
    run = previous(date) === last ? run + 1 : 1;
    best = Math.max(best, run);
    last = date;
  }
  const written = new Set(days);
  let current = 0,
    date = written.has(today) ? today : previous(today);
  while (written.has(date)) {
    current++;
    date = previous(date);
  }
  return { current, best, total: days.length };
}
// Opaque IDs/revisions only; dates, mood, tags and text remain encrypted.
export function recordVersions(records: Iterable<{ id: string; revision: number }>): string {
  return [...records]
    .filter((r) => r.revision > 0)
    .map((r) => `${r.id}:${r.revision}`)
    .sort()
    .join('|');
}
export function backupHealth(
  copies: LocalBackup[],
  vaultId: string,
  latestEdit: number,
  now: number,
  versions?: string,
) {
  const backup = copies
    .filter(
      (b) =>
        b.archive.vault_id === vaultId &&
        ['export', 'before-restore'].includes(b.source) &&
        Number.isFinite(Date.parse(b.saved_at)) &&
        Date.parse(b.saved_at) <= now,
    )
    .sort((a, b) => b.saved_at.localeCompare(a.saved_at))[0];
  if (!backup) return { label: 'No full backup yet', savedAt: '', kind: 'missing' };
  const date = Date.parse(backup.saved_at);
  if (now - date >= 86400000)
    return {
      label: 'Backup overdue · older than 24 hours',
      savedAt: backup.saved_at,
      kind: 'overdue',
    };
  if (
    latestEdit > date ||
    (versions !== undefined &&
      backup.record_versions !== undefined &&
      versions !== backup.record_versions)
  )
    return { label: 'New changes since backup', savedAt: backup.saved_at, kind: 'changed' };
  return { label: 'Recent browser backup', savedAt: backup.saved_at, kind: 'recent' };
}
