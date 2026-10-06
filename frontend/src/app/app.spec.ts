import { TestBed } from '@angular/core/testing';
import { App, todayInKolkata } from './app';

 describe('Diary calendar scaffold', () => {
 beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok:true,json:async () => ({database:'ready'})}));
  await TestBed.configureTestingModule({imports:[App]}).compileComponents();
 });
 afterEach(() => vi.unstubAllGlobals());
 it('preserves a future-day draft while navigating without changing its date', () => {
  const app = TestBed.createComponent(App).componentInstance;
  app.select('2030-10-20'); app.title = 'Sample future plan'; app.body = 'Synthetic text';
  app.select('2020-02-29'); app.select('2030-10-20');
  expect(app.title).toBe('Sample future plan'); expect(app.body).toBe('Synthetic text');
  expect(app.selected()).toBe('2030-10-20');
 });
 it('supports leap day and does not create drafts on empty visits', () => {
  const app = TestBed.createComponent(App).componentInstance;
  app.select('2024-02-29'); expect(app.days().filter(Boolean)).toHaveLength(29);
  app.select('2024-03-01'); expect(Object.keys(app.drafts())).toHaveLength(0);
 });
 it('retains title-only drafts', () => {
  const app = TestBed.createComponent(App).componentInstance;
  app.title = 'Sample title'; const date = app.selected(); app.select('2031-01-01'); app.select(date);
  expect(app.title).toBe('Sample title'); expect(app.body).toBe('');
 });
 it('uses Kolkata civil date near UTC midnight', () => {
  expect(todayInKolkata(new Date('2026-10-06T20:00:00Z'))).toBe('2026-10-07');
 });
 it('shows the scaffold limitation and checks backend readiness', async () => {
  const fixture = TestBed.createComponent(App); await fixture.whenStable();
  expect(fixture.nativeElement.textContent).toContain('disappear on refresh');
  expect(fixture.componentInstance.backend()).toBe('Backend & PostgreSQL ready');
 });
 it('reports database failure rather than readiness', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok:false,json:async () => ({database:'not-ready'})}));
  const fixture = TestBed.createComponent(App); await fixture.whenStable();
  expect(fixture.componentInstance.backend()).toBe('Database unavailable');
 });
 });
