import { Archive } from './backup-format';
export interface LocalBackup {
  id: string;
  saved_at: string;
  source: string;
  archive: Archive;
  record_versions?: string;
}
export class BackupStore {
  private db?: Promise<IDBDatabase>;
  private database() {
    return (this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('webdiary-encrypted-backups', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('backups', { keyPath: 'id' });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => {
        this.db = undefined;
        reject(
          new Error('Could not save an encrypted local backup. Keep existing data and retry.'),
        );
      };
      r.onblocked = () => reject(new Error('Close the other tab to open backup storage.'));
    }));
  }
  private async transaction<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('backups', mode);
      let result: T;
      const r = run(tx.objectStore('backups'));
      r.onsuccess = () => (result = r.result);
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () =>
        reject(new Error('Encrypted backup storage failed. Existing diary preserved.'));
    });
  }
  async save(archive: Archive, source: string, recordVersions?: string) {
    const backup: LocalBackup = {
      id: crypto.randomUUID(),
      saved_at: new Date().toISOString(),
      source,
      archive,
      ...(recordVersions === undefined ? {} : { record_versions: recordVersions }),
    };
    await this.transaction('readwrite', (s) => s.put(backup));
    return backup;
  }
  async list() {
    return (await this.transaction<LocalBackup[]>('readonly', (s) => s.getAll())).sort((a, b) =>
      b.saved_at.localeCompare(a.saved_at),
    );
  }
  async remove(id: string) {
    await this.transaction('readwrite', (s) => s.delete(id));
  }
}
