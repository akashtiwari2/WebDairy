import { Component, input, signal, inject, effect } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { VaultService } from './vault.service';
@Component({
  selector: 'app-auth-panel',
  imports: [FormsModule],
  templateUrl: './auth-panel.html',
  styles: [
    `
      :host {
        display: block;
      }
      .panel {
        max-width: 560px;
        padding: 28px;
        background: white;
        border: 1px solid #d6dfd1;
        border-radius: 14px;
        margin: 0 auto 24px;
      }
      h2 {
        font:
          28px Georgia,
          serif;
      }
      label {
        display: block;
        margin: 16px 0;
        font-size: 14px;
      }
      input {
        display: block;
        width: 100%;
        padding: 10px;
        box-sizing: border-box;
        margin-top: 6px;
        border: 1px solid #9eae9a;
        border-radius: 6px;
      }
      input[type='checkbox'] {
        display: inline;
        width: auto;
      }
      button {
        padding: 10px 16px;
        margin: 6px 6px 6px 0;
        border: 1px solid #9eae9a;
        border-radius: 6px;
        background: #edf2e9;
        color: #34523b;
      }
      p {
        line-height: 1.6;
        font-size: 14px;
      }
      code {
        display: block;
        overflow-wrap: anywhere;
        padding: 16px;
        background: #f0eede;
        user-select: all;
      }
      .hint {
        color: #5d6659;
        font-size: 12px;
      }
    `,
  ],
})
export class AuthPanel {
  readonly v = inject(VaultService);
  readonly settings = input(false);
  readonly recovering = signal(false);
  loginPassword = '';
  passphrase = '';
  confirmation = '';
  current = '';
  recoveryInput = '';
  savedOffline = false;
  constructor() {
    effect(() => {
      this.v.state();
      this.settings();
      this.clear();
      this.recovering.set(false);
    });
  }
  private clear() {
    this.loginPassword = '';
    this.passphrase = '';
    this.confirmation = '';
    this.current = '';
    this.recoveryInput = '';
    this.savedOffline = false;
  }
  async setup() {
    const login = this.loginPassword,
      pass = this.passphrase,
      confirm = this.confirmation;
    this.clear();
    await this.v.perform(async () => {
      if (pass !== confirm) throw new Error('Passphrases do not match.');
      await this.v.beginSetup(login, pass);
    });
  }
  async login() {
    const password = this.loginPassword;
    this.clear();
    await this.v.perform(() => this.v.login(password));
  }
  async unlock() {
    const pass = this.passphrase;
    this.clear();
    await this.v.perform(() => this.v.unlock(pass));
  }
  async verify() {
    const secret = this.recoveryInput,
      saved = this.savedOffline;
    this.clear();
    await this.v.perform(async () => {
      if (!saved) throw new Error('Save the recovery key offline before continuing.');
      await this.v.confirmRecovery(secret);
    });
  }
  async recover() {
    const secret = this.recoveryInput,
      pass = this.passphrase,
      confirm = this.confirmation;
    this.clear();
    await this.v.perform(async () => {
      if (pass !== confirm) throw new Error('Passphrases do not match.');
      await this.v.recover(secret, pass);
      this.recovering.set(false);
    });
  }
  async changePass() {
    const current = this.current,
      pass = this.passphrase,
      confirm = this.confirmation;
    this.clear();
    await this.v.perform(async () => {
      if (pass !== confirm) throw new Error('Passphrases do not match.');
      await this.v.changePassphrase(current, pass);
    });
  }
  async rotate() {
    const current = this.current;
    this.clear();
    await this.v.perform(() => this.v.rotateRecovery(current));
  }
  async changeLogin() {
    const current = this.current,
      next = this.loginPassword;
    this.clear();
    await this.v.perform(() => this.v.changeLogin(current, next));
  }
  cancel() {
    this.clear();
    this.v.cancelRecovery();
  }
  retry() {
    void this.v.perform(() => this.v.start());
  }
  logout() {
    void this.v.perform(() => this.v.logout());
  }
}
