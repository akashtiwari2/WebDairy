export type BackupFrequency = 'manual' | 'daily' | 'weekly' | 'monthly';
export function backupDue(frequency: BackupFrequency, lastSnapshot: string, now: number): boolean {
  if (frequency === 'manual') return false;
  const interval = { daily: 86400000, weekly: 7 * 86400000, monthly: 30 * 86400000 }[frequency];
  const previous = Date.parse(lastSnapshot);
  return !Number.isFinite(previous) || previous > now + 60000 || now - previous >= interval;
}
