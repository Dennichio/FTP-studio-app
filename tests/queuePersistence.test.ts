import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/main/storage';
import { TransferQueue, endpointIdentity } from '../src/main/queue';
import type { ConnectionProfile, FileEntry, PersistedQueueRecord, RemoteAccess, RemoteSession, TransferJob, TransferProgress } from '../src/shared/contracts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
async function database() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-queue-db-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'state.db'), store = new SqliteStore(filename);
  cleanups.push(() => store.close()); return { root, filename, store };
}
function record(id: string): PersistedQueueRecord {
  return { kind: 'file', endpoint: 'bound-endpoint', readyAt: 123, transaction: { stage: `/site/.${id}.stage`, backup: `/site/.${id}.backup`, phase: 'prepared' }, job: {
    id, direction: 'upload', connectionId: 'server', localPath: `/project/${id}`, remotePath: `/site/${id}`, expectedEndpoint: 'bound-endpoint', status: 'running', size: 3, transferred: 2, speed: 1, remainingSeconds: 1, attempts: 1, createdAt: 1,
    sourceSnapshot: { size: 3, modifiedAt: 1, checksum: 'source' }, expectedRemote: { size: 2, modifiedAt: 2, checksum: 'target' }, verifiedRemote: { size: 3, modifiedAt: 3, checksum: 'verified' },
  } };
}

describe('incremental SQLite queue durability', () => {
  it('migrates legacy records atomically with exact recovery data and stable ordering', async () => {
    const { filename, store } = await database(), records = [record('one'), record('two')];
    store.set('transferQueue.v1', records);
    expect(store.queue.load()).toEqual(records);
    expect(store.get('transferQueue.v1', null)).toBeNull();
    expect(store.get('transferQueue.schema', null)).toBe(2);
    const reopened = new SqliteStore(filename);
    try {
      expect(reopened.queue.load()).toEqual(records);
      reopened.queue.commit([], ['one', 'two']);
      expect(reopened.queue.load()).toEqual([]);
      expect(reopened.get('transferQueue.schema', null)).toBe(2);
    } finally { reopened.close(); }
    expect(store.queue.load()).toEqual([]);
  });
  it('rolls back a failed migration without removing the original queue or retaining partial rows', async () => {
    const { filename, store } = await database(), records = [record('one'), record('reject')];
    store.set('transferQueue.v1', records);
    const inspector = new DatabaseSync(filename);
    try {
      inspector.exec("CREATE TRIGGER reject_migration BEFORE INSERT ON queue_records WHEN NEW.id='reject' BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END;");
      expect(() => store.queue.load()).toThrow(/injected migration failure/);
      expect(store.get('transferQueue.v1', [])).toEqual(records);
      expect(store.get('transferQueue.schema', null)).toBeNull();
      expect(inspector.prepare('SELECT count(*) AS count FROM queue_records').get()?.count).toBe(0);
      inspector.exec('DROP TRIGGER reject_migration');
      expect(store.queue.load()).toEqual(records);
    } finally { inspector.close(); }
  });
  it('refuses malformed or duplicate legacy records without silently discarding recovery data', async () => {
    const { store } = await database();
    for (const legacy of [[record('duplicate'), record('duplicate')], [record('safe'), null], { wrong: true }]) {
      store.set('transferQueue.v1', legacy);
      expect(() => store.queue.load()).toThrow();
      expect(store.get('transferQueue.v1', null)).toEqual(legacy);
      expect(store.get('transferQueue.schema', null)).toBeNull();
    }
  });
  it('updates one row out of a thousand and atomically rolls back failed mixed batches', async () => {
    const { filename, store } = await database();
    const records = Array.from({ length: 1000 }, (_, index) => record(String(index)));
    store.queue.commit(records, []);
    const inspector = new DatabaseSync(filename);
    try {
      inspector.exec('CREATE TABLE writes(id TEXT); CREATE TRIGGER audit_queue AFTER UPDATE ON queue_records BEGIN INSERT INTO writes(id) VALUES (NEW.id); END;');
      const updated = { ...records[500], readyAt: 999 };
      store.queue.commit([updated], []);
      expect(inspector.prepare('SELECT id FROM writes').all()).toEqual([{ id: '500' }]);
      expect(store.queue.load()[500]).toEqual(updated);
      inspector.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON queue_records WHEN OLD.id='2' BEGIN SELECT RAISE(ABORT, 'injected batch failure'); END;");
      expect(() => store.queue.commit([record('new')], ['1', '2'])).toThrow(/injected batch failure/);
      const after = store.queue.load();
      expect(after).toHaveLength(1000); expect(after[1]).toEqual(records[1]); expect(after[2]).toEqual(records[2]);
      expect(after.some(item => item.job.id === 'new')).toBe(false);
      expect(inspector.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
    } finally { inspector.close(); }
  });
  it('reopens every committed transfer phase with unchanged snapshots and recovery paths', async () => {
    const { filename, store } = await database();
    for (const phase of ['prepared', 'backed-up', 'installed'] as const) {
      const value = record('phase'); value.transaction!.phase = phase;
      store.queue.commit([value], []);
      const reopened = new SqliteStore(filename);
      try { expect(reopened.queue.load()).toEqual([value]); } finally { reopened.close(); }
    }
  });
});

async function queueFixture(options: { hold?: Promise<void>; parallel?: number } = {}) {
  const f = await database(), localRoot = path.join(f.root, 'project'); await fs.mkdir(localRoot);
  const profile: ConnectionProfile = { id: 'server', name: 'Local unit fixture', host: 'fixture.invalid', port: 21, protocol: 'ftp', username: 'fixture', localRoot, remoteRoot: '/site', timeoutMs: 1000, parallelTransfers: options.parallel ?? 2, connectionLimit: 8, autoReconnect: false };
  const files = new Map<string, { body: Buffer; modified: number }>(), progressCallbacks: Array<(value: TransferProgress) => void> = [];
  let clock = 1;
  const stat = (target: string): FileEntry | null => target === '/site' ? { name: 'site', path: target, kind: 'directory', size: 0, modifiedAt: 1 } : files.has(target) ? { name: path.posix.basename(target), path: target, kind: 'file', size: files.get(target)!.body.length, modifiedAt: files.get(target)!.modified } : null;
  const session: RemoteSession = {
    list: async () => [], stat: async target => stat(target), mkdir: async () => {}, chmod: async () => {}, close: async () => {},
    rename: vi.fn(async (from, to) => { const item = files.get(from); if (!item || files.has(to)) throw new Error('Unsafe fixture rename'); files.set(to, item); files.delete(from); }),
    remove: async target => { files.delete(target); },
    upload: async (local, target, progress, signal) => {
      files.set(target, { body: await fs.readFile(local), modified: clock++ }); progressCallbacks.push(progress);
      if (options.hold) await Promise.race([options.hold, new Promise<void>((_, reject) => { const abort = () => reject(new DOMException('Aborted', 'AbortError')); if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); })]);
    },
    download: async (remote, local, progress) => { const source = files.get(remote)!; await fs.writeFile(local, source.body); progress({ transferred: source.body.length, total: source.body.length }); },
  };
  const remote: RemoteAccess = { profile: () => ({ ...profile }), acquire: async () => ({ session, release: async () => {} }) };
  const notifications: TransferJob[][] = [];
  const queue = new TransferQueue(remote, f.store, () => {}, jobs => notifications.push(jobs));
  cleanups.push(() => queue.close());
  const enqueue = async (name: string) => { const filename = path.join(localRoot, name); await fs.writeFile(filename, name); return queue.enqueue([{ connectionId: profile.id, localPath: filename, remotePath: `/site/${name}`, direction: 'upload' }]); };
  return { ...f, localRoot, profile, files, remote, session, queue, notifications, progressCallbacks, enqueue };
}
async function until(condition: () => boolean): Promise<void> { for (let count = 0; count < 1000; count++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Fixture did not finish'); }

describe('queue persistence boundaries and bounded notifications', () => {
  it('persists individual job boundaries and emits completed verification before an immediate clear', async () => {
    const f = await queueFixture(), commit = vi.spyOn(f.store.queue, 'commit');
    await f.enqueue('first'); await until(() => f.queue.jobs()[0]?.status === 'completed');
    await new Promise(resolve => setImmediate(resolve));
    const completed = f.queue.jobs()[0];
    const persisted = f.store.queue.load()[0];
    expect(persisted.job.verifiedRemote).toEqual(completed.verifiedRemote);
    expect(persisted.transaction).toBeUndefined();
    expect(commit.mock.calls.every(([changed]) => changed.length <= 1)).toBe(true);
    await f.queue.action('clear');
    const completionEvent = f.notifications.find(jobs => jobs.some(job => job.id === completed.id && job.status === 'completed'));
    expect(completionEvent?.[0].verifiedRemote).toEqual(completed.verifiedRemote);
    expect(completionEvent?.[0].verifiedLocal).toEqual(completed.verifiedLocal);
    expect(f.queue.jobs()).toEqual([]); expect(f.store.queue.load()).toEqual([]);
    await f.queue.close(); expect(f.notifications.at(-1)).toEqual([]);
  });
  it('coalesces progress from eight simultaneous jobs globally and flushes the final state on close', async () => {
    const f = await queueFixture({ parallel: 8, hold: new Promise<void>(() => {}) });
    for (let index = 0; index < 8; index++) await f.enqueue(`file-${index}`);
    await until(() => f.progressCallbacks.length === 8);
    f.notifications.length = 0;
    for (let count = 0; count < 100; count++) for (const progress of f.progressCallbacks) progress({ transferred: 2, total: 6 });
    await new Promise(resolve => setTimeout(resolve, 130));
    expect(f.notifications.length).toBeGreaterThan(0); expect(f.notifications.length).toBeLessThanOrEqual(2);
    expect(f.notifications.at(-1)?.every(job => job.transferred === 2)).toBe(true);
    await f.queue.close(); expect(f.notifications.at(-1)?.every(job => job.status === 'paused')).toBe(true);
  });
  it('fails closed on an enqueue write error and never schedules the uncommitted addition', async () => {
    const f = await queueFixture();
    vi.spyOn(f.store.queue, 'commit').mockImplementation(() => { throw new Error('injected storage outage'); });
    await expect(f.enqueue('uncommitted')).rejects.toThrow(/opslag is mislukt/);
    expect(f.queue.jobs()).toEqual([]); expect(f.store.queue.load()).toEqual([]);
    await expect(f.enqueue('later')).rejects.toThrow(/gesloten/);
    expect(f.session.rename).not.toHaveBeenCalled(); expect(f.progressCallbacks).toEqual([]);
    await f.queue.close();
  });
  it('does not rename a target if persisting its prepared phase fails', async () => {
    const f = await queueFixture(), commit = f.store.queue.commit.bind(f.store.queue);
    vi.spyOn(f.store.queue, 'commit').mockImplementation((changed, removed) => { if (changed.some(item => item.transaction?.phase === 'prepared')) throw new Error('injected prepared failure'); commit(changed, removed); });
    await f.enqueue('protected');
    await until(() => f.queue.jobs()[0]?.status === 'failed');
    await f.queue.close();
    expect(f.session.rename).not.toHaveBeenCalled(); expect(f.files.has('/site/protected')).toBe(false);
    const reopened = new SqliteStore(f.filename);
    try {
      const recovered = new TransferQueue(f.remote, reopened, () => {}, () => {});
      expect(recovered.jobs()[0].status).toBe('paused'); await recovered.close();
    } finally { reopened.close(); }
  });
  it.each([
    ['backed-up', 'prepared'], ['installed', 'backed-up'], ['verified', 'installed'],
  ] as const)('preserves the original and durable recovery paths when writing %s fails', async (failedPhase, durablePhase) => {
    const f = await queueFixture(), original = Buffer.from('original bytes');
    f.files.set('/site/replace', { body: original, modified: 77 });
    const commit = f.store.queue.commit.bind(f.store.queue);
    vi.spyOn(f.store.queue, 'commit').mockImplementation((changed, removed) => {
      if (changed.some(item => failedPhase === 'verified' ? !item.transaction && !!item.job.verifiedRemote : item.transaction?.phase === failedPhase)) throw new Error(`injected ${failedPhase} failure`);
      commit(changed, removed);
    });
    await f.enqueue('replace'); await until(() => f.queue.jobs()[0]?.status === 'conflict'); await f.queue.close();
    const durable = f.store.queue.load()[0];
    expect(durable.transaction?.phase).toBe(durablePhase);
    expect(durable.transaction?.backup).toBeTruthy();
    expect(f.files.get(durable.transaction!.backup!)?.body).toEqual(original);
    await expect(f.queue.action('clear')).rejects.toThrow(/opslag is mislukt/);
    const reopened = new SqliteStore(f.filename);
    try {
      expect(reopened.queue.load()[0].transaction).toEqual(durable.transaction);
      const restored = new TransferQueue(f.remote, reopened, () => {}, () => {});
      expect(restored.jobs()[0].status).toBe('paused'); await restored.action('clear'); expect(restored.jobs()).toHaveLength(1); await restored.close();
    } finally { reopened.close(); }
  });
  it('retains the original local backup when clearing a verified download transaction cannot be persisted', async () => {
    const f = await queueFixture(), original = Buffer.from('original local bytes'), replacement = Buffer.from('downloaded replacement');
    const localPath = path.join(f.localRoot, 'download');
    await fs.writeFile(localPath, original, { mode: 0o640 });
    await fs.chmod(localPath, 0o640);
    f.files.set('/site/download', { body: replacement, modified: 77 });
    const commit = f.store.queue.commit.bind(f.store.queue);
    let rejectedVerification = false;
    vi.spyOn(f.store.queue, 'commit').mockImplementation((changed, removed) => {
      if (changed.some(item => item.job.direction === 'download' && !item.transaction && item.job.verifiedLocal && item.job.verifiedRemote)) {
        rejectedVerification = true; throw new Error('injected download transaction-clear failure');
      }
      commit(changed, removed);
    });
    await f.queue.enqueue([{ connectionId: f.profile.id, localPath, remotePath: '/site/download', direction: 'download' }]);
    await until(() => f.queue.jobs()[0]?.status === 'conflict'); await f.queue.close();
    expect(rejectedVerification).toBe(true);
    const durable = f.store.queue.load()[0];
    expect(durable.transaction?.phase).toBe('installed');
    expect(durable.transaction?.backup).toBeTruthy();
    expect(await fs.readFile(localPath)).toEqual(replacement);
    expect(await fs.readFile(durable.transaction!.stage)).toEqual(replacement);
    expect(await fs.readFile(durable.transaction!.backup!)).toEqual(original);
    expect((await fs.stat(localPath)).mode & 0o777).toBe(0o640);
    expect(durable.job.verifiedLocal).toBeUndefined();
    expect(f.notifications.flat().some(job => job.status === 'completed')).toBe(false);
    const reopened = new SqliteStore(f.filename);
    try {
      expect(reopened.queue.load()[0].transaction).toEqual(durable.transaction);
      const restored = new TransferQueue(f.remote, reopened, () => {}, () => {});
      try {
        expect(restored.jobs()[0].status).toBe('paused');
        await restored.action('resume'); await until(() => restored.jobs()[0].status === 'conflict');
        await restored.action('clear'); expect(restored.jobs()).toHaveLength(1);
        expect(reopened.queue.load()[0].transaction).toEqual(durable.transaction);
        expect(await fs.readFile(durable.transaction!.backup!)).toEqual(original);
        expect(await fs.readFile(localPath)).toEqual(replacement);
      } finally { await restored.close(); }
    } finally { reopened.close(); }
  });
  it('restores active job references when another job fails persistence during an awaited target rename', async () => {
    const f = await queueFixture({ parallel: 2 }), original = Buffer.from('first original');
    f.files.set('/site/first', { body: original, modified: 77 });
    const rename = f.session.rename;
    const originalRename = vi.mocked(rename).getMockImplementation()!;
    let releaseRename!: () => void, heldBackup: string | undefined;
    const renameGate = new Promise<void>(resolve => { releaseRename = resolve; });
    vi.mocked(rename).mockImplementation(async (from, to) => {
      await originalRename(from, to);
      if (from === '/site/first') { heldBackup = to; await renameGate; }
    });
    const commit = f.store.queue.commit.bind(f.store.queue);
    let rejectedSecond = false;
    vi.spyOn(f.store.queue, 'commit').mockImplementation((changed, removed) => {
      if (changed.some(item => item.job.remotePath === '/site/second' && item.transaction?.phase === 'prepared')) {
        rejectedSecond = true; throw new Error('injected concurrent persistence failure');
      }
      commit(changed, removed);
    });
    try {
      await f.enqueue('first'); await until(() => heldBackup !== undefined);
      expect(f.files.has('/site/first')).toBe(false);
      expect(f.files.get(heldBackup!)?.body).toEqual(original);
      await f.enqueue('second');
      await until(() => f.queue.jobs().find(job => job.remotePath === '/site/second')?.status === 'failed');
      expect(rejectedSecond).toBe(true);
      expect(f.queue.jobs().find(job => job.remotePath === '/site/first')?.status).toBe('running');
      releaseRename();
      // The active continuation must update the restored public job, not a detached pre-restore object.
      await until(() => f.queue.jobs().every(job => job.status === 'failed'));
      await f.queue.close();
      expect(f.files.get('/site/first')?.body).toEqual(original);
      expect(f.files.has('/site/second')).toBe(false);
      expect(f.notifications.flat().some(job => job.status === 'completed')).toBe(false);
      const durable = f.store.queue.load().find(item => item.job.remotePath === '/site/first')!;
      expect(durable.transaction?.phase).toBe('prepared');
      expect(durable.transaction?.backup).toBe(heldBackup);
      const reopened = new SqliteStore(f.filename);
      try {
        const restored = new TransferQueue(f.remote, reopened, () => {}, () => {});
        try {
          expect(restored.jobs().every(job => job.status === 'paused')).toBe(true);
          await restored.action('clear'); expect(restored.jobs()).toHaveLength(2);
          expect(reopened.queue.load().find(item => item.job.id === durable.job.id)?.transaction).toEqual(durable.transaction);
          expect(f.files.get('/site/first')?.body).toEqual(original);
        } finally { await restored.close(); }
      } finally { reopened.close(); }
    } finally { releaseRename(); await f.queue.close(); }
  });
  it('restores interrupted transactions paused and preserves them when clear is requested', async () => {
    const f = await queueFixture(); await f.queue.close();
    const value = record('interrupted'); value.endpoint = endpointIdentity(f.profile); value.job.expectedEndpoint = value.endpoint;
    value.job.localPath = path.join(f.localRoot, 'interrupted'); value.job.remotePath = '/site/interrupted'; value.transaction!.phase = 'backed-up';
    f.store.queue.commit([value], []);
    const restored = new TransferQueue(f.remote, f.store, () => {}, () => {});
    try {
      expect(restored.jobs()[0].status).toBe('paused');
      await restored.action('resume'); await until(() => restored.jobs()[0].status === 'conflict');
      await restored.action('clear'); expect(restored.jobs()).toHaveLength(1);
      expect(f.store.queue.load()[0].transaction).toEqual(value.transaction);
      expect(f.session.rename).not.toHaveBeenCalled();
    } finally { await restored.close(); }
  });
});
