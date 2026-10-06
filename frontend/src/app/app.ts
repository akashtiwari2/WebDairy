import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DiaryService, SaveStatus, validCivilDate } from './diary.service';

export function todayInKolkata(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

@Component({
  selector: 'app-root',
  imports: [FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  readonly diary = inject(DiaryService);
  readonly today = signal(todayInKolkata());
  readonly selected = signal(this.today());
  readonly month = signal(this.today().slice(0, 7));
  readonly entry = computed(() => this.diary.state(this.selected()));
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
  readonly editable = computed(() => this.entry().loaded && !this.entry().deleteRequested);

  constructor() {
    void this.checkHealth();
    void this.diary.loadDates();
    void this.diary.load(this.selected());
    // Midnight changes the Today marker, never the selected date or editor text.
    const marker = setInterval(() => this.today.set(todayInKolkata()), 30000);
    inject(DestroyRef).onDestroy(() => clearInterval(marker));
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
  moveMonth(offset: number) {
    const date = new Date(`${this.month()}-01T12:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + offset);
    if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return;
    this.month.set(
      `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`,
    );
  }
  goToday() {
    this.today.set(todayInKolkata());
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
        'Delete this sample entry and discard its unsaved text? This permanently deletes the development entry; trash is not implemented yet.',
      )
    )
      return;
    await this.diary.deleteEntry(date);
  }
  useSavedVersion() {
    const date = this.selected();
    if (window.confirm('Discard your draft and use the currently saved version?'))
      this.diary.useSavedVersion(date);
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
