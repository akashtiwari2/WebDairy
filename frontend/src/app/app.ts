import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

type Draft = { title: string; body: string };
export function todayInKolkata(now = new Date()): string {
 const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
 const value = (type: string) => parts.find(part => part.type === type)!.value;
 return `${value('year')}-${value('month')}-${value('day')}`;
}

@Component({ selector: 'app-root', imports: [FormsModule], templateUrl: './app.html', styleUrl: './app.css' })
export class App {
 readonly today = signal(todayInKolkata());
 readonly selected = signal(this.today());
 readonly month = signal(this.today().slice(0, 7));
 readonly drafts = signal<Record<string, Draft>>({});
 readonly backend = signal('Checking database…');
 title = '';
 body = '';
 readonly dateLabel = computed(() => new Intl.DateTimeFormat('en-IN', {dateStyle:'full', timeZone:'UTC'}).format(new Date(`${this.selected()}T12:00:00Z`)));
 readonly monthLabel = computed(() => new Intl.DateTimeFormat('en-IN', {month:'long', year:'numeric', timeZone:'UTC'}).format(new Date(`${this.month()}-01T12:00:00Z`)));
 readonly days = computed(() => {
  const [year, month] = this.month().split('-').map(Number);
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return [...Array.from({length:first}, () => ''), ...Array.from({length:count}, (_, i) => `${this.month()}-${String(i+1).padStart(2, '0')}`)];
 });
 constructor() { void this.checkHealth(); }
 async checkHealth() {
  try {
   const response = await fetch('/api/health');
   const result = await response.json();
   this.backend.set(response.ok && result.database === 'ready' ? 'Backend & PostgreSQL ready' : 'Database unavailable');
  } catch { this.backend.set('Backend unavailable'); }
 }
 keepDraft() {
  const current = {...this.drafts()};
  if (this.title || this.body) current[this.selected()] = {title:this.title, body:this.body};
  else delete current[this.selected()];
  this.drafts.set(current);
 }
 select(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  this.keepDraft();
  this.selected.set(date);
  this.month.set(date.slice(0, 7));
  const draft = this.drafts()[date];
  this.title = draft?.title ?? '';
  this.body = draft?.body ?? '';
 }
 moveMonth(offset: number) {
  const [year, month] = this.month().split('-').map(Number);
  const date = new Date(Date.UTC(year, month-1+offset, 1));
  this.month.set(`${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}`);
 }
 goToday() { this.today.set(todayInKolkata()); this.select(this.today()); }
}
