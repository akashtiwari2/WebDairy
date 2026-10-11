import { Sealed } from './vault-crypto';
export interface StoredDraft extends Sealed {
  key: string;
  vault_id: string;
  record_id: string;
  format_version: 1;
}
// Only encrypted payloads and opaque identifiers go into IndexedDB.
export class DraftStore {
  private db?: Promise<IDBDatabase>;
  private database(): Promise<IDBDatabase> {
    return (this.db ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('webdiary-encrypted-drafts', 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore('drafts', { keyPath: 'key' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        this.db = undefined;
        reject(new Error('Encrypted draft storage unavailable.'));
      };
      request.onblocked = () =>
        reject(new Error('Close the other WebDairy tab to open draft storage.'));
    }));
  }
  private async transaction<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('drafts', mode);
      let result: T;
      const request = run(tx.objectStore('drafts'));
      request.onsuccess = () => {
        result = request.result;
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () =>
        reject(new Error('Encrypted draft storage failed. Keep this tab open and retry.'));
    });
  }
  put(draft: StoredDraft) {
    return this.transaction('readwrite', (store) => store.put(draft));
  }
  remove(vault: string, id: string) {
    return this.transaction('readwrite', (store) => store.delete(`${vault}/${id}`));
  }
  async list(vault: string) {
    return (await this.transaction<StoredDraft[]>('readonly', (store) => store.getAll())).filter(
      (d) => d.vault_id === vault,
    );
  }
}
