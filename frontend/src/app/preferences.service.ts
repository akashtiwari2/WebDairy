import { BackupFrequency } from './backup-schedule';
import { Injectable, signal } from '@angular/core';
export interface Preferences {
  timezone: string;
  theme: 'light' | 'dark' | 'system';
  trash_days: number;
  show_streak?: boolean;
  backup_frequency?: BackupFrequency;
  backup_keep?: number;
}
export const defaults: Preferences = {
  timezone: 'Asia/Kolkata',
  theme: 'system',
  trash_days: 30,
  show_streak: true,
  backup_frequency: 'manual',
  backup_keep: 30,
};
export function validPreferences(value: Preferences): boolean {
  if (
    !value ||
    typeof value.timezone !== 'string' ||
    value.timezone.length > 100 ||
    !['light', 'dark', 'system'].includes(value.theme) ||
    (value.show_streak !== undefined && typeof value.show_streak !== 'boolean') ||
    (value.backup_frequency !== undefined &&
      !['manual', 'daily', 'weekly', 'monthly'].includes(value.backup_frequency)) ||
    (value.backup_keep !== undefined &&
      (!Number.isInteger(value.backup_keep) || value.backup_keep < 3 || value.backup_keep > 100)) ||
    !Number.isInteger(value.trash_days) ||
    value.trash_days < 1 ||
    value.trash_days > 365
  )
    return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value.timezone }).format();
    return true;
  } catch {
    return false;
  }
}
export function todayInZone(zone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
@Injectable({ providedIn: 'root' })
export class PreferencesService {
  readonly value = signal<Preferences>({ ...defaults });
  readonly zones = Intl.supportedValuesOf('timeZone');
  constructor() {
    try {
      const saved = JSON.parse(localStorage.getItem('webdiary-preferences') ?? 'null');
      if (validPreferences(saved)) this.value.set(saved);
    } catch {
      /* Optional local preferences. */
    }
    this.applyTheme();
    window
      .matchMedia('(prefers-color-scheme: dark)')
      .addEventListener('change', () => this.applyTheme());
  }
  set(value: Preferences) {
    if (!validPreferences(value))
      throw new Error('Choose a valid timezone, theme and trash period (1–365 days).');
    this.value.set({ ...value });
    try {
      localStorage.setItem('webdiary-preferences', JSON.stringify(value));
    } catch {
      /* Optional preference. */
    }
    this.applyTheme();
  }
  private applyTheme() {
    const theme = this.value().theme;
    document.documentElement.dataset['theme'] =
      theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : theme;
  }
}
