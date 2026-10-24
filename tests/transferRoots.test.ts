import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ConnectionProfile, FileEntry, KeyValueStore, PersistedQueueRecord, RemoteAccess, RemoteSession, TransferRequest } from '../src/shared/contracts';
import { endpointIdentity, TransferQueue } from '../src/main/queue';
import { SqliteStore } from '../src/main/storage';

class Store implements KeyValueStore {
  values = new Map<string, unknown>();
  fail = false;
  get<T>(key: string, fallback: T): T { return structuredClone(this.values.get(key) ?? fallback) as T; }
  set<T>(key: string, value: T): void { if (this.fail) throw new Error('Disk unavailable'); this.values.set(key, structuredClone(value)); }
  delete(key: string): void { this.values.delete(key); }
  records(): PersistedQueueRecord[] { return this.get('transferQueue.v1', []); }
}

// Real temporary files exercise the complete queue transaction on both sides.
class DiskRemote implements RemoteAccess {
  failTransfer = false;
  transfers = 0;
  mutations = 0;
  config: ConnectionProfile;
  constructor(private directory: string, localRoot: string) {
    this.config = { id: 'connection', name: 'Test', host: 'test.invalid', port: 21, protocol: 'ftp', username: 'test', localRoot, remoteRoot: '/site', timeoutMs: 1000, connectionLimit: 1, parallelTransfers: 1, autoReconnect: false };
  }
  profile(): ConnectionProfile { return this.config; }
  disk(target: string): string {
    const relative = path.posix.relative('/site', target);
    if (relative.startsWith('..') || path.posix.isAbsolute(relative)) throw new Error('Remote root escape');
    return path.join(this.directory, relative);
  }
  async entry(target: string): Promise<FileEntry | null> {
    try {
      const stat = await fs.lstat(this.disk(target));
      return { name: path.posix.basename(target), path: target, kind: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file', size: stat.size, modifiedAt: stat.mtimeMs };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async acquire() {
    const copy = async (source: string, destination: string, progress: (value: { transferred: number; total: number }) => void, signal: AbortSignal) => {
      this.transfers++;
      if (this.failTransfer) throw new Error('Temporary connection failure');
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      this.mutations++;
      await fs.copyFile(source, destination);
      const size = (await fs.stat(source)).size;
      progress({ transferred: size, total: size });
    };
    const session: RemoteSession = {
      stat: target => this.entry(target),
      list: async target => Promise.all((await fs.readdir(this.disk(target))).map(async name => (await this.entry(path.posix.join(target, name)))!)),
      mkdir: async target => { this.mutations++; await fs.mkdir(this.disk(target)); },
      rename: async (from, to) => { this.mutations++; await fs.rename(this.disk(from), this.disk(to)); },
      remove: async target => { this.mutations++; await fs.unlink(this.disk(target)); },
      chmod: async (target, mode) => { this.mutations++; await fs.chmod(this.disk(target), Number.parseInt(mode, 8)); },
      upload: (local, remote, progress, signal) => copy(local, this.disk(remote), progress, signal),
      download: (remote, local, progress, signal) => copy(this.disk(remote), local, progress, signal),
      close: async () => {},
    };
    return { session, release: async () => {} };
  }
}

const roots: string[] = [], queues: TransferQueue[] = [];
async function fixture(cache = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-roots-')); roots.push(root);
  const profileRoot = path.join(root, 'profile'), chosenRoot = path.join(root, 'chosen'), remoteRoot = path.join(root, 'remote'), cacheRoot = path.join(root, 'document-store');
  await Promise.all([profileRoot, chosenRoot, remoteRoot, cacheRoot].map(directory => fs.mkdir(directory)));
  const remote = new DiskRemote(remoteRoot, profileRoot), store = new Store();
  const createQueue = () => {
    const queue = new TransferQueue(remote, store, () => {}, () => {}, undefined, undefined, cache ? { trustedCacheRoot: cacheRoot } : {});
    queues.push(queue); return queue;
  };
  const queue = createQueue();
  const request = (direction: 'upload' | 'download', name = 'file.txt'): TransferRequest => ({ connectionId: 'connection', direction, localPath: path.join(chosenRoot, name), remotePath: `/site/${name}`, localRootOverride: chosenRoot });
  return { root, profileRoot, chosenRoot, remoteRoot, cacheRoot, remote, store, queue, createQueue, request };
}
async function settled(queue: TransferQueue): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (queue.jobs().every(job => ['completed', 'failed', 'conflict', 'cancelled'].includes(job.status))) {
      // Terminal persistence precedes release of the active lease.
      await new Promise(resolve => setTimeout(resolve, 5)); return;
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Queue did not settle');
}
afterEach(async () => {
  for (const queue of queues.splice(0)) await queue.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('explicit local transfer roots', () => {
  it.each(['upload', 'download'] as const)('completes an external %s and preserves its root across restart and retry', async direction => {
    const f = await fixture(), request = f.request(direction);
    await fs.writeFile(direction === 'upload' ? request.localPath : f.remote.disk(request.remotePath), 'exact bytes');
    f.remote.failTransfer = true;
    await f.queue.enqueue([request]); await settled(f.queue);
    expect(f.queue.jobs()[0].status).toBe('failed');
    expect(f.store.records()[0].job.localRootOverride).toBe(f.chosenRoot);
    await f.queue.close();
    const restored = f.createQueue();
    expect(restored.jobs()[0].localRootOverride).toBe(f.chosenRoot);
    request.localRootOverride = f.profileRoot; request.localPath = path.join(f.profileRoot, 'unrelated.txt');
    f.remote.failTransfer = false;
    await restored.action('retry'); await settled(restored);
    expect(restored.jobs()[0].status).toBe('completed');
    expect(await fs.readFile(direction === 'upload' ? f.remote.disk('/site/file.txt') : path.join(f.chosenRoot, 'file.txt'), 'utf8')).toBe('exact bytes');
    expect(await fs.readdir(f.profileRoot)).toEqual([]);
  });

  it('keeps the profile boundary when a manual root was not supplied', async () => {
    const f = await fixture(), request = f.request('upload');
    await fs.writeFile(request.localPath, 'source'); delete request.localRootOverride;
    await expect(f.queue.enqueue([request])).rejects.toThrow(/buiten de verbindingsmap/);
    expect(f.remote.transfers).toBe(0);
  });

  it('rejects nonabsolute, missing, file and escaping roots without side effects', async () => {
    const f = await fixture(), request = f.request('upload'); await fs.writeFile(request.localPath, 'source');
    for (const localRootOverride of ['relative', path.join(f.root, 'missing'), request.localPath, f.profileRoot]) {
      await expect(f.queue.enqueue([{ ...request, localRootOverride }])).rejects.toThrow();
    }
    expect(f.queue.jobs()).toEqual([]); expect(f.remote.mutations).toBe(0);
  });

  it('retains remote root confinement for a manual local root', async () => {
    const f = await fixture(), request = f.request('upload'); await fs.writeFile(request.localPath, 'source');
    await expect(f.queue.enqueue([{ ...request, remotePath: '/elsewhere/file.txt' }])).rejects.toThrow(/externe pad valt buiten/);
    expect(f.remote.transfers).toBe(0);
  });

  it('rejects symlink roots, symlink children and a root swapped before retry', async () => {
    const f = await fixture(), request = f.request('upload'); await fs.writeFile(request.localPath, 'source');
    const link = path.join(f.root, 'linked'); await fs.symlink(f.chosenRoot, link, 'dir');
    await expect(f.queue.enqueue([{ ...request, localRootOverride: link, localPath: path.join(link, 'file.txt') }])).rejects.toThrow(/Symbolische koppeling/);
    const child = path.join(f.chosenRoot, 'linked.txt'); await fs.symlink(request.localPath, child);
    await expect(f.queue.enqueue([{ ...request, localPath: child }])).rejects.toThrow(/Symbolische koppeling/);
    f.remote.failTransfer = true; await f.queue.enqueue([request]); await settled(f.queue);
    await fs.rename(f.chosenRoot, `${f.chosenRoot}-original`); await fs.symlink(`${f.chosenRoot}-original`, f.chosenRoot, 'dir');
    f.remote.failTransfer = false; const transfers = f.remote.transfers;
    await f.queue.action('retry'); await settled(f.queue);
    expect(f.queue.jobs()[0].status).toBe('failed'); expect(f.queue.jobs()[0].error).toMatch(/Symbolische koppeling/);
    expect(f.remote.transfers).toBe(transfers);
  });

  it('expands external directories while retaining secret and excluded-directory filters', async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.chosenRoot, 'folder')); await fs.mkdir(path.join(f.chosenRoot, 'folder', '.git'));
    await fs.writeFile(path.join(f.chosenRoot, 'folder', 'public.txt'), 'public');
    await fs.writeFile(path.join(f.chosenRoot, 'folder', '.env'), 'private');
    await fs.writeFile(path.join(f.chosenRoot, 'folder', '.git', 'config'), 'private');
    await f.queue.enqueue([f.request('upload', 'folder')]); await settled(f.queue);
    expect(f.queue.jobs().map(job => [job.status, job.localRootOverride])).toEqual([['completed', f.chosenRoot]]);
    expect(await fs.readdir(f.remote.disk('/site/folder'))).toEqual(['public.txt']);
    await expect(f.queue.enqueue([{ ...f.request('upload', 'folder/.git/config'), localRootOverride: path.join(f.chosenRoot, 'folder', '.git') }])).rejects.toThrow(/uitgesloten/);
    const secretRoot = path.join(f.chosenRoot, '.ssh'); await fs.mkdir(secretRoot); await fs.writeFile(path.join(secretRoot, 'config'), 'private');
    await expect(f.queue.enqueue([{ ...f.request('upload'), localRootOverride: secretRoot, localPath: path.join(secretRoot, 'config') }])).rejects.toThrow(/uitgesloten/);
  });

  it('rejects manual root access to trusted document cache, including recursive traversal', async () => {
    const f = await fixture(true), cached = path.join(f.cacheRoot, 'file.txt'); await fs.writeFile(cached, 'cache');
    await expect(f.queue.enqueue([{ ...f.request('upload'), localPath: cached, localRootOverride: f.cacheRoot, expectedRemote: null }])).rejects.toThrow(/bewaakte documentupload/);
    await expect(f.queue.enqueue([{ ...f.request('upload'), localPath: f.root, localRootOverride: f.root, remotePath: '/site/all' }])).rejects.toThrow(/bewaakte documentupload/);
    expect(f.queue.jobs()).toEqual([]); expect(f.remote.transfers).toBe(0);
    const guarded = { ...f.request('upload'), localPath: cached, expectedRemote: null }; delete guarded.localRootOverride;
    await f.queue.enqueue([guarded]); await settled(f.queue);
    expect(f.queue.jobs()[0].status).toBe('completed');
  });
});

describe('clearing recovery conflicts', () => {
  it('persists hidden recovery records and explicit roots in SQLite across reopening', async () => {
    const f = await fixture(), filename = path.join(f.root, 'queue.db');
    const record: PersistedQueueRecord = { kind: 'file', endpoint: endpointIdentity(f.remote.config), job: { ...f.request('download'), id: 'recover', status: 'conflict', size: 3, transferred: 3, speed: 0, remainingSeconds: null, attempts: 1, createdAt: 1 }, transaction: { stage: path.join(f.chosenRoot, '.stage'), backup: path.join(f.chosenRoot, '.backup'), phase: 'backed-up' } };
    const store = new SqliteStore(filename); store.queue.commit([record], []);
    const queue = new TransferQueue(f.remote, store, () => {}, () => {});
    try { await queue.action('clear'); expect(queue.jobs()).toEqual([]); }
    finally { await queue.close(); store.close(); }
    const reopened = new SqliteStore(filename);
    const restored = new TransferQueue(f.remote, reopened, () => {}, () => {});
    try {
      expect(restored.jobs()).toEqual([]);
      expect(reopened.queue.load()).toEqual([{ ...record, archived: true }]);
      await restored.action('retry', ['recover']);
      expect(f.remote.transfers).toBe(0);
    } finally { await restored.close(); reopened.close(); }
  });

  it.each(['upload', 'download'] as const)('archives a %s conflict durably without touching its original, stage or backup', async direction => {
    const f = await fixture(); await f.queue.close();
    const request = f.request(direction), stage = direction === 'upload' ? '/site/.recovery.part' : path.join(f.chosenRoot, '.recovery.part');
    const backup = `${stage}.backup`, disk = (value: string) => direction === 'upload' ? f.remote.disk(value) : value;
    const target = direction === 'upload' ? request.remotePath : request.localPath;
    await Promise.all([[target, 'current'], [stage, 'new'], [backup, 'original']].map(([file, content]) => fs.writeFile(disk(file), content)));
    const record: PersistedQueueRecord = { kind: 'file', endpoint: endpointIdentity(f.remote.config), job: { ...request, id: 'recover', status: 'conflict', size: 3, transferred: 3, speed: 0, remainingSeconds: null, attempts: 1, createdAt: 1 }, transaction: { stage, backup, phase: 'backed-up' } };
    f.store.set('transferQueue.v1', [record]); const restored = f.createQueue();
    await restored.action('clear', ['recover']);
    expect(restored.jobs()).toEqual([]);
    expect(f.store.records()).toEqual([{ ...record, archived: true }]);
    await restored.close(); const again = f.createQueue();
    expect(again.jobs()).toEqual([]); await again.action('retry', ['recover']); await again.action('clear');
    expect(f.store.records()).toEqual([{ ...record, archived: true }]); expect(f.remote.mutations).toBe(0);
    expect(await Promise.all([target, stage, backup].map(file => fs.readFile(disk(file), 'utf8')))).toEqual(['current', 'new', 'original']);
  });

  it('keeps a recovery conflict visible if its archive cannot be persisted', async () => {
    const f = await fixture(); await f.queue.close();
    const record: PersistedQueueRecord = { kind: 'file', job: { ...f.request('download'), id: 'recover', status: 'conflict', size: 0, transferred: 0, speed: 0, remainingSeconds: null, attempts: 1, createdAt: 1 }, transaction: { stage: path.join(f.chosenRoot, '.stage'), phase: 'prepared' } };
    f.store.set('transferQueue.v1', [record]); const restored = f.createQueue(); f.store.fail = true;
    await expect(restored.action('clear')).rejects.toThrow(/Duurzame wachtrijopslag/);
    expect(restored.jobs().map(job => job.id)).toEqual(['recover']); expect(f.store.records()).toEqual([record]);
  });
});
