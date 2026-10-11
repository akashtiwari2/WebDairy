import { Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { LibraryPanel } from './library-panel';
import { BackupService } from './backup.service';
import { BackupPanel } from './backup-panel';
import { PreferencesService, todayInZone } from './preferences.service';
import { AuthPanel } from './auth-panel';
import { VaultService } from './vault.service';
import { FormsModule } from '@angular/forms';
import { DiaryService, SaveStatus, validCivilDate } from './diary.service';

export function todayInKolkata(now = new Date()): string {
  return todayInZone('Asia/Kolkata', now);
}

@Component({
  selector: 'app-root',
  imports: [FormsModule, AuthPanel, LibraryPanel, BackupPanel],
  templateUrl: './app.html',
  styleUrl: './app.css',
  host: { '[class.diary-mode]': 'diaryView()' },
})
export class App {
  readonly preferences = inject(PreferencesService);
  readonly tools = signal<'diary' | 'library' | 'backup'>('diary');
  readonly calendarOpen = signal(!window.matchMedia('(max-width: 760px)').matches);
  private opened = false;
  readonly diary = inject(DiaryService);
  readonly vault = inject(VaultService);
  readonly backup = inject(BackupService);
  readonly settings = signal(false);
  readonly diaryView = computed(
    () =>
      this.vault.state() === 'unlocked' &&
      this.tools() === 'diary' &&
      !this.settings() &&
      !this.vault.recoveryPurpose(),
  );
  readonly today = signal(todayInZone(this.preferences.value().timezone));
  readonly selected = signal(this.today());
  readonly month = signal(this.today().slice(0, 7));
  readonly entry = computed(() => {
    const state = this.diary.state(this.selected());
    return state.trashed ? { ...state, title: '', body: '' } : state;
  });
  readonly backend = signal('Checking database…');
  readonly dateLabel = computed(() =>
    new Intl.DateTimeFormat('en-IN', { dateStyle: 'full', timeZone: 'UTC' }).format(
      new Date(`${this.selected()}T12:00:00Z`),
    ),
  );
  readonly monthLabel = computed(() =>
    new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
      new Date(`${this.month()}-01T12:00:00Z`),
    ),
  );
  readonly days = computed(() => {
    const firstDate = new Date(`${this.month()}-01T12:00:00Z`);
    const first = firstDate.getUTCDay();
    const lastDate = new Date(firstDate);
    lastDate.setUTCMonth(lastDate.getUTCMonth() + 1);
    lastDate.setUTCDate(0);
    return [
      ...Array.from({ length: first }, () => ''),
      ...Array.from(
        { length: lastDate.getUTCDate() },
        (_, i) => `${this.month()}-${String(i + 1).padStart(2, '0')}`,
      ),
    ];
  });
  readonly statusLabel = computed(
    () =>
      (
        ({
          loading: 'Loading…',
          blank: 'Blank page',
          unsaved: 'Unsaved',
          saving: 'Saving…',
          saved: 'Saved',
          failed: this.entry().deleteRequested
            ? 'Delete failed'
            : this.entry().loaded
              ? 'Save failed'
              : 'Load failed',
          conflict: 'Conflict · draft preserved',
          deleting: 'Deleting…',
        }) satisfies Record<SaveStatus, string>
      )[this.entry().status],
  );
  readonly editable = computed(
    () => this.entry().loaded && !this.entry().deleteRequested && !this.vault.busy(),
  );

  constructor() {
    void this.checkHealth();
    void this.vault.perform(() => this.vault.start());
    effect(() => {
      this.today.set(todayInZone(this.preferences.value().timezone));
      if (this.vault.state() === 'unlocked') {
        if (!this.opened) {
          this.selected.set(this.today());
          this.month.set(this.today().slice(0, 7));
        }
        this.opened = true;
        void this.diary.load(this.selected());
      } else {
        this.opened = false;
        this.settings.set(false);
        this.tools.set('diary');
      }
      if (
        this.vault.state() === 'unlocked' &&
        !this.vault.auth.authenticated() &&
        !this.vault.busy()
      )
        void this.vault.perform(() => this.vault.lock());
    });
    // Midnight changes the Today marker, never the selected date or editor text.
    const marker = setInterval(
      () => this.today.set(todayInZone(this.preferences.value().timezone)),
      30000,
    );
    inject(DestroyRef).onDestroy(() => clearInterval(marker));
  }
  lock() {
    void this.vault.perform(() => this.vault.lock());
  }
  logout() {
    void this.vault.perform(() => this.vault.logout());
  }
  async checkHealth() {
    try {
      const response = await fetch('/api/health');
      const result = await response.json();
      this.backend.set(
        response.ok && result.database === 'ready'
          ? 'Backend & PostgreSQL ready'
          : 'Database unavailable',
      );
    } catch {
      this.backend.set('Backend unavailable');
    }
  }
  edit(title: string, body: string) {
    this.diary.edit(this.selected(), title, body);
  }
  async select(date: string) {
    if (!validCivilDate(date)) return;
    if (date !== this.selected()) void this.diary.save(this.selected());
    this.selected.set(date);
    this.month.set(date.slice(0, 7));
    await this.diary.load(date);
  }
  openTool(tool: 'diary' | 'library' | 'backup') {
    this.settings.set(false);
    this.tools.set(tool);
  }
  openResult(date: string) {
    this.tools.set('diary');
    void this.select(date);
  }
  setMonth(value: string) {
    if (validCivilDate(value + '-01')) this.month.set(value);
  }
  moveMonth(offset: number) {
    const date = new Date(`${this.month()}-01T12:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + offset);
    if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return;
    this.month.set(
      `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`,
    );
  }
  goToday() {
    this.today.set(todayInZone(this.preferences.value().timezone));
    void this.select(this.today());
  }
  async retry() {
    await Promise.all([
      this.diary.retry(this.selected()),
      this.diary.loadDates(),
      this.checkHealth(),
    ]);
  }
  async deleteEntry() {
    const date = this.selected();
    if (
      !window.confirm(
        'Move this entry to encrypted trash and discard unsaved text? You can restore it from Trash.',
      )
    )
      return;
    await this.diary.deleteEntry(date);
  }
  useSavedVersion() {
    const date = this.selected();
    if (window.confirm('Discard your draft and use the currently saved version?'))
      void this.vault.perform(() => this.diary.useSavedVersion(date));
  }
  async overwriteWithDraft() {
    const date = this.selected();
    if (
      window.confirm(
        'Replace the compared saved version with your draft? A newer change will still produce another conflict.',
      )
    )
      await this.diary.overwriteWithDraft(date);
  }
  restoreSavedText() {
    const entry = this.entry();
    this.edit(entry.savedTitle, entry.savedBody);
  }
}
