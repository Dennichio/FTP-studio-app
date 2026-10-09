import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import type { KeyValueStore, Credentials } from '../shared/contracts';

/** Durable transactions, never a partially-written JSON queue after a crash. */
export class SqliteStore implements KeyValueStore {
  private db: DatabaseSync;
  constructor(filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;');
    try { chmodSync(filename, 0o600); } catch { /* Windows uses user directory ACLs. */ }
  }
  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? JSON.parse(String(row.value)) as T : structuredClone(fallback);
  }
  set<T>(key: string, value: T): void { this.db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  delete(key: string): void { this.db.prepare('DELETE FROM settings WHERE key = ?').run(key); }
  close(): void { this.db.close(); }
}
export interface SecretEncryption { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string; getSelectedStorageBackend?(): string; }
export class CredentialVault {
  constructor(private store: KeyValueStore, private encryption: SecretEncryption) {}
  private available(): void {
    if (!this.encryption.isEncryptionAvailable() || this.encryption.getSelectedStorageBackend?.() === 'basic_text') throw new Error('Veilige systeemopslag is niet beschikbaar. Aanmeldgegevens kunnen alleen tijdelijk worden gebruikt.');
  }
  save(id: string, credentials: Credentials): void {
    this.available();
    const previous = this.read(id);
    const value: Credentials = { ...previous, ...credentials };
    this.store.set(`credential:${id}`, this.encryption.encryptString(JSON.stringify(value)).toString('base64'));
  }
  read(id: string): Credentials {
    const encoded = this.store.get<string | null>(`credential:${id}`, null);
    if (!encoded) return {};
    this.available();
    try { return JSON.parse(this.encryption.decryptString(Buffer.from(encoded, 'base64'))) as Credentials; }
    catch { throw new Error('Opgeslagen aanmeldgegevens kunnen niet worden ontsleuteld voor deze Windows-gebruiker.'); }
  }
  delete(id: string): void { this.store.delete(`credential:${id}`); }
}
