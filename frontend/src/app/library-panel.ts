import { Component, DestroyRef, computed, inject, output, signal } from '@angular/core';
import { moods } from './vault-crypto';
import { FormsModule } from '@angular/forms';
import { DiaryService } from './diary.service';
import { VaultService } from './vault.service';
import { PreferencesService } from './preferences.service';
@Component({
  selector: 'app-library-panel',
  imports: [FormsModule],
  templateUrl: './library-panel.html',
})
export class LibraryPanel {
  readonly diary = inject(DiaryService);
  readonly vault = inject(VaultService);
  readonly preferences = inject(PreferencesService);
  readonly open = output<string>();
  readonly tab = signal<'search' | 'trash'>('search');
  readonly query = signal('');
  readonly mood = signal('');
  readonly tag = signal('');
  readonly moods = moods;
  readonly from = signal('');
  readonly until = signal('');
  readonly alternative = signal('');
  readonly previewId = signal('');
  readonly tick = signal(Date.now());
  readonly results = computed(() => {
    const query = this.query().trim().toLocaleLowerCase();
    return [...this.diary.states().values()]
      .filter(
        (s) =>
          !s.trashed &&
          (s.title.trim() || s.body.trim()) &&
          (!this.from() || s.date >= this.from()) &&
          (!this.until() || s.date <= this.until()) &&
          (!this.mood() || s.mood === this.mood()) &&
          (!this.tag().trim() ||
            (s.tags ?? []).some(
              (t) => t.toLocaleLowerCase() === this.tag().trim().toLocaleLowerCase(),
            )) &&
          (!query ||
            (s.title + '\n' + s.body + '\n' + (s.tags ?? []).join(' '))
              .toLocaleLowerCase()
              .includes(query)),
      )
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((s) => {
        const index = Math.max(0, s.body.toLocaleLowerCase().indexOf(query) - 40);
        return { ...s, excerpt: s.body.slice(index, index + 160) };
      });
  });
  readonly trash = computed(() =>
    [...this.diary.trash().values()].sort((a, b) =>
      (b.trashed_at ?? b.updated_at).localeCompare(a.trashed_at ?? a.updated_at),
    ),
  );
  readonly expired = computed(() => {
    const cutoff = this.tick() - this.preferences.value().trash_days * 86400000;
    return this.trash().filter((s) => Date.parse(s.trashed_at ?? s.updated_at) <= cutoff);
  });
  readonly selected = computed(() => this.diary.trash().get(this.previewId()));
  readonly occupied = computed(() => {
    const date = this.alternative() || this.selected()?.date;
    const state = date ? this.diary.states().get(date) : undefined;
    return state && (state.revision > 0 || state.title.trim() || state.body.trim())
      ? state
      : undefined;
  });
  constructor() {
    const timer = setInterval(() => this.tick.set(Date.now()), 60000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }
  timestamp(value: string) {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: this.preferences.value().timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  }
  inspect(id: string) {
    this.previewId.set(id);
    this.alternative.set('');
    this.tick.set(Date.now());
  }
  restore(id: string) {
    const source = this.diary.trash().get(id);
    if (!source) return;
    const date = this.alternative() || source.date;
    void this.vault.perform(async () => {
      await this.diary.restoreTrash(id, date);
      this.previewId.set('');
      this.open.emit(date);
    });
  }
  purge(id: string) {
    if (
      !window.confirm(
        'Permanently delete this trash entry? Its current record and draft will be removed. Earlier backup files can still contain it.',
      )
    )
      return;
    void this.vault.perform(async () => {
      await this.diary.purgeTrash(id);
      this.previewId.set('');
    });
  }
  purgeExpired() {
    this.tick.set(Date.now());
    const ids = this.expired().map((s) => s.id);
    if (
      !ids.length ||
      !window.confirm(
        `Permanently delete ${ids.length} expired trash entries? Older backups may still contain them.`,
      )
    )
      return;
    void this.vault.perform(async () => {
      for (const id of ids) await this.diary.purgeTrash(id);
      this.previewId.set('');
    });
  }
}
