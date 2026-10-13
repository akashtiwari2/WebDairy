import { Injectable, effect, inject, signal } from '@angular/core';
import { VaultService } from './vault.service';

// One focused first-run screen; backup replacement is always an explicit choice.
@Injectable({ providedIn: 'root' })
export class StartupService {
  readonly vault = inject(VaultService);
  readonly choice = signal<'welcome' | 'create' | 'restore'>('welcome');
  readonly restoreLocked = signal(false);
  constructor() {
    effect(() => {
      const state = this.vault.state();
      if (state === 'unlocked' || state === 'login') {
        this.choice.set('welcome');
        this.restoreLocked.set(false);
      }
    });
  }
}
