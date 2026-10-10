import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import type { KeyValueStore, Credentials, PersistedQueueRecord, QueuePersistence } from '../shared/contracts';

const LEGACY_QUEUE_KEY = 'transferQueue.v1';
const QUEUE_SCHEMA_KEY = 'transferQueue.schema';
function queueRecordId(record: PersistedQueueRecord): string {
  if (!record || typeof record !== 'object' || !record.job || typeof record.job.id !== 'string' || !record.job.id || !['file', 'directory'].includes(record.kind)) throw new Error('Ongeldig wachtrijrecord; herstelgegevens zijn niet gewijzigd.');
  return record.job.id;
}

/** Durable transactions, never a partially-written JSON queue after a crash. */
export class SqliteStore implements KeyValueStore {
  private db: DatabaseSync;
  private queueInitialized = false;
  readonly queue: QueuePersistence = { load: () => this.loadQueue(), commit: (upserts, removedIds) => this.commitQueue(upserts, removedIds) };
  constructor(filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS queue_records (sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, value TEXT NOT NULL) STRICT;');
    try { chmodSync(filename, 0o600); } catch { /* Windows uses user directory ACLs. */ }
  }
  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? JSON.parse(String(row.value)) as T : structuredClone(fallback);
  }
  set<T>(key: string, value: T): void { this.db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  delete(key: string): void { this.db.prepare('DELETE FROM settings WHERE key = ?').run(key); }
  private transaction(action: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try { action(); this.db.exec('COMMIT'); }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ } throw error; }
  }
  private initializeQueue(): void {
    if (this.queueInitialized) return;
    this.transaction(() => {
      const version = this.get<number | null>(QUEUE_SCHEMA_KEY, null);
      if (version === 2) return;
      if (version !== null) throw new Error('Onbekende wachtrijversie; herstelgegevens zijn niet gewijzigd.');
      const legacy = this.get<PersistedQueueRecord[]>(LEGACY_QUEUE_KEY, []);
      if (!Array.isArray(legacy)) throw new Error('Ongeldige opgeslagen wachtrij; migratie afgebroken.');
      if (this.db.prepare('SELECT 1 FROM queue_records LIMIT 1').get()) throw new Error('Wachtrijmigratie is niet eenduidig; herstelgegevens zijn niet gewijzigd.');
      const ids = new Set<string>(), insert = this.db.prepare('INSERT INTO queue_records(id, value) VALUES (?, ?)');
      for (const record of legacy) {
        const id = queueRecordId(record);
        if (ids.has(id)) throw new Error('Dubbele wachtrij-id; migratie afgebroken.');
        ids.add(id); insert.run(id, JSON.stringify(record));
      }
      this.set(QUEUE_SCHEMA_KEY, 2);
      // One transaction prevents both a partial migration and replay by an old reader.
      this.delete(LEGACY_QUEUE_KEY);
    });
    this.queueInitialized = true;
  }
  private loadQueue(): PersistedQueueRecord[] {
    this.initializeQueue();
    return this.db.prepare('SELECT id, value FROM queue_records ORDER BY sequence').all().map(row => {
      const record = JSON.parse(String(row.value)) as PersistedQueueRecord;
      if (queueRecordId(record) !== row.id) throw new Error('Wachtrij-id wijkt af; herstelgegevens zijn niet gewijzigd.');
      return record;
    });
  }
  private commitQueue(upserts: PersistedQueueRecord[], removedIds: string[]): void {
    this.initializeQueue();
    const ids = new Set<string>(), serialized = upserts.map(record => {
      const id = queueRecordId(record);
      if (ids.has(id)) throw new Error('Dubbele wijziging van een wachtrijrecord.');
      ids.add(id); return { id, value: JSON.stringify(record) };
    });
    for (const id of removedIds) {
      if (typeof id !== 'string' || !id || ids.has(id)) throw new Error('Ongeldige verwijdering van een wachtrijrecord.');
      ids.add(id);
    }
    if (!serialized.length && !removedIds.length) return;
    this.transaction(() => {
      const upsert = this.db.prepare('INSERT INTO queue_records(id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value');
      const remove = this.db.prepare('DELETE FROM queue_records WHERE id = ?');
      for (const row of serialized) upsert.run(row.id, row.value);
      for (const id of removedIds) remove.run(id);
    });
  }
  close(): void { this.db.close(); }
}
export interface SecretEncryption { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string; getSelectedStorageBackend?(): string; }
export class CredentialVault {
  constructor(private store: KeyValueStore, private encryption: SecretEncryption) {}
  private available(): void {
    if (!this.encryption.isEncryptionAvailable() || this.encryption.getSelectedStorageBackend?.() === 'basic_text') throw new Error('Veilige systeemopslag is niet beschikbaar. Aanmeldgegevens kunnen alleen tijdelijk worden gebruikt.');
  }
  save(id: string, credentials: Credentials, identity?: string): void {
    this.available();
    const stored = this.record(id);
    // A new authentication binding must never inherit secrets from another binding
    // or a legacy record that cannot prove which destination owns those secrets.
    const previous = identity === undefined || stored?.identity === identity ? stored?.credentials ?? {} : {};
    const value: Credentials = { ...previous, ...credentials };
    const payload = identity === undefined ? value : { version: 1, identity, credentials: value };
    this.store.set(`credential:${id}`, this.encryption.encryptString(JSON.stringify(payload)).toString('base64'));
  }
  private record(id: string): { identity?: string; credentials: Credentials } | undefined {
    const encoded = this.store.get<string | null>(`credential:${id}`, null);
    if (!encoded) return undefined;
    this.available();
    try {
      const value = JSON.parse(this.encryption.decryptString(Buffer.from(encoded, 'base64')));
      if (value?.version === 1 && typeof value.identity === 'string' && value.credentials && typeof value.credentials === 'object') return { identity: value.identity, credentials: value.credentials as Credentials };
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== undefined) throw new Error('Invalid credential record');
      return { credentials: value as Credentials };
    }
    catch { throw new Error('Opgeslagen aanmeldgegevens kunnen niet worden ontsleuteld voor deze Windows-gebruiker.'); }
  }
  read(id: string, identity?: string): Credentials {
    const stored = this.record(id);
    if (!stored) return {};
    if (identity !== undefined && stored.identity !== identity) throw new Error('Opgeslagen aanmeldgegevens zijn niet aan deze bestemming gekoppeld. Vul ze opnieuw in en sla de verbinding op.');
    return { ...stored.credentials };
  }
  delete(id: string): void { this.store.delete(`credential:${id}`); }
}
