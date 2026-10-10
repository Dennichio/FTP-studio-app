import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ConnectionProfile, FileEntry, KeyValueStore, RemoteAccess, RemoteSession, SessionLease, TransferJob, TransferProgress, TransferRequest } from '../src/shared/contracts';
import { TransferQueue, endpointIdentity } from '../src/main/queue';

class MemoryStore implements KeyValueStore {
  values = new Map<string, unknown>();
  get<T>(key: string, fallback: T): T { return structuredClone(this.values.get(key) ?? fallback) as T; }
  set<T>(key: string, value: T): void { this.values.set(key, structuredClone(value)); }
  delete(key: string): void { this.values.delete(key); }
}
type RemoteFile = { kind: 'file' | 'directory' | 'symlink'; data: Buffer; modifiedAt: number; permissions?: string };
class MemoryRemote implements RemoteAccess {
  files = new Map<string, RemoteFile>();
  config: ConnectionProfile;
  sessions = 0;
  releases = 0;
  active = 0;
  maximumActive = 0;
  calls: string[] = [];
  signals: AbortSignal[] = [];
  renames: [string, string][] = [];
  removals: string[] = [];
  chmodCalls: Array<[string, string]> = [];
  chmodFailure = false;
  failures = 0;
  hold?: Promise<void>;
  afterUpload?: () => Promise<void>;
  afterDownload?: () => Promise<void>;
  beforeRename?: (from: string, to: string) => Promise<void>;
  time = 100;
  constructor(localRoot: string, overrides: Partial<ConnectionProfile> = {}) {
    this.config = { id: 'connection', name: 'Test', host: 'test.invalid', port: 21, protocol: 'ftp', username: 'test', localRoot, remoteRoot: '/site', timeoutMs: 1000, connectionLimit: 4, parallelTransfers: 4, autoReconnect: false, ...overrides };
    this.directory('/'); this.directory('/site');
  }
  profile(): ConnectionProfile { return this.config; }
  put(target: string, content: string | Buffer): void { this.files.set(target, { kind: 'file', data: Buffer.from(content), modifiedAt: this.time++ }); }
  directory(target: string): void { this.files.set(target, { kind: 'directory', data: Buffer.alloc(0), modifiedAt: this.time++ }); }
  entry(target: string): FileEntry | null {
    const item = this.files.get(target);
    return item ? { name: path.posix.basename(target), path: target, kind: item.kind, size: item.data.length, modifiedAt: item.modifiedAt, permissions: item.permissions } : null;
  }
  async acquire(_connectionId: string, _purpose: 'navigation' | 'transfer', signal?: AbortSignal): Promise<SessionLease> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    this.sessions++;
    let released = false;
    const session: RemoteSession = {
      list: async target => [...this.files.keys()].filter(key => key !== target && path.posix.dirname(key) === target).map(key => this.entry(key)!),
      stat: async target => {
        if (target !== this.config.remoteRoot && !target.startsWith(`${this.config.remoteRoot}/`)) throw new Error('Stat outside configured remote root');
        return this.entry(target);
      },
      mkdir: async target => { this.directory(target); },
      rename: async (from, to) => {
        this.renames.push([from, to]);
        await this.beforeRename?.(from, to);
        const original = this.files.get(from);
        if (!original) throw new Error('Source missing');
        if (this.files.has(to)) throw new Error('Server does not support overwrite rename');
        this.files.set(to, original); this.files.delete(from);
      },
      remove: async target => { this.removals.push(target); this.files.delete(target); },
      chmod: async (target, mode) => {
        this.chmodCalls.push([target, mode]);
        if (this.chmodFailure) throw new Error('Permission denied while setting staged mode');
        const entry = this.files.get(target); if (!entry) throw new Error('Source missing'); entry.permissions = mode;
      },
      upload: async (local, remote, progress, abort, offset) => {
        expect(offset).toBeUndefined();
        await this.transfer(path.basename(remote), abort, async () => {
          const content = await fs.readFile(local);
          this.put(remote, content);
          progress({ transferred: content.length, total: content.length });
          await this.afterUpload?.();
        });
      },
      download: async (remote, local, progress, abort, offset) => {
        expect(offset).toBeUndefined();
        await this.transfer(path.basename(remote), abort, async () => {
          const content = this.files.get(remote)?.data;
          if (!content) throw new Error('Source missing');
          await fs.writeFile(local, content);
          progress({ transferred: content.length, total: content.length });
          await this.afterDownload?.();
        });
      },
      close: async () => {},
    };
    return { session, release: async () => { expect(released).toBe(false); released = true; this.releases++; } };
  }
  private async transfer(name: string, signal: AbortSignal, work: () => Promise<void>): Promise<void> {
    this.signals.push(signal);
    this.active++; this.maximumActive = Math.max(this.maximumActive, this.active); this.calls.push(name);
    try {
      if (this.failures > 0) { this.failures--; throw new Error('Network unavailable'); }
      if (this.hold) {
        await new Promise<void>((resolve, reject) => {
          const cancelled = () => reject(new DOMException('Aborted', 'AbortError'));
          signal.addEventListener('abort', cancelled, { once: true });
          if (signal.aborted) cancelled();
          this.hold!.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancelled));
        });
      }
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      await work();
    } finally { this.active--; }
  }
}
const fixtures: { root: string; queue: TransferQueue }[] = [];
async function fixture(overrides: Partial<ConnectionProfile> = {}, onCompleted?: (job: TransferJob) => Promise<void>, include?: (request: TransferRequest, entry: FileEntry) => boolean | Promise<boolean>, options: { trustedCacheRoot?: string } = {}): Promise<{ root: string; remote: MemoryRemote; store: MemoryStore; queue: TransferQueue; upload: (name: string, content?: string) => Promise<TransferRequest>; download: (name: string, content?: string) => TransferRequest }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-queue-test-'));
  const remote = new MemoryRemote(root, overrides), store = new MemoryStore();
  const queue = new TransferQueue(remote, store, () => {}, () => {}, onCompleted, include, options);
  fixtures.push({ root, queue });
  return { root, remote, store, queue,
    upload: async (name, content = name) => {
      await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await fs.writeFile(path.join(root, name), content);
      return { connectionId: 'connection', direction: 'upload', localPath: path.join(root, name), remotePath: `/site/${name}` };
    },
    download: (name, content = name) => {
      remote.put(`/site/${name}`, content);
      return { connectionId: 'connection', direction: 'download', localPath: path.join(root, name), remotePath: `/site/${name}` };
    },
  };
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
}
async function eventually(condition: () => boolean, timeout = 5000): Promise<void> {
  const started = Date.now();
  while (!condition()) { if (Date.now() - started > timeout) throw new Error('Condition not reached before timeout'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function done(queue: TransferQueue): Promise<void> { await eventually(() => queue.jobs().every(job => ['completed', 'failed', 'conflict', 'cancelled'].includes(job.status))); }
afterEach(async () => { for (const fixture of fixtures.splice(0)) { await fixture.queue.close(); await fs.rm(fixture.root, { recursive: true, force: true }); } });

describe('TransferQueue', () => {
  it('rejects a cached request whose server identity changed before enqueue', async () => {
    const f = await fixture(); const request = await f.upload('cached.html');
    const expectedEndpoint = endpointIdentity(f.remote.config); f.remote.config.host = 'another-server.invalid';
    await expect(f.queue.enqueue([{ ...request, expectedEndpoint }])).rejects.toThrow(/verbindingsbestemming is gewijzigd/);
    expect(f.remote.sessions).toBe(0);
  });
  it('refuses a restored job when its profile id now points to another account', async () => {
    const f = await fixture(); await f.queue.enqueue([await f.upload('saved.txt')]); await done(f.queue); await f.queue.close();
    const records = f.store.get<any[]>('transferQueue.v1', []); records[0].job.status = 'paused'; f.store.set('transferQueue.v1', records);
    f.remote.config.username = 'another-account';
    const restored = new TransferQueue(f.remote, f.store, () => {}, () => {}); fixtures.push({ root: f.root, queue: restored });
    const calls = f.remote.calls.length; await restored.action('resume'); await done(restored);
    expect(restored.jobs()[0].status).toBe('conflict'); expect(f.remote.calls.length).toBe(calls);
  });
  it('rechecks server identity after an awaited session acquisition', async () => {
    const f = await fixture(); const originalAcquire = f.remote.acquire.bind(f.remote); let count = 0;
    f.remote.acquire = async (...args) => { const lease = await originalAcquire(...args); if (++count === 2) f.remote.config.host = 'changed-during-connect.invalid'; return lease; };
    await f.queue.enqueue([await f.upload('guarded.txt')]); await done(f.queue);
    expect(f.queue.jobs()[0].status).toBe('conflict'); expect(f.remote.calls).toHaveLength(0);
  });
  it('expands folders, excludes development/secrets by default and creates empty folders', async () => {
    const f = await fixture();
    await f.upload('bundle/index.html', '<html>ok</html>');
    await f.upload('bundle/node_modules/lib.js');
    await f.upload('bundle/.git/config');
    await f.upload('bundle/.env.production', 'SECRET');
    await f.upload('bundle/private.pem', 'PRIVATE');
    await fs.mkdir(path.join(f.root, 'bundle/empty'));
    const jobs = await f.queue.enqueue([{ connectionId: 'connection', direction: 'upload', localPath: path.join(f.root, 'bundle'), remotePath: '/site/bundle' }]);
    expect(jobs).toHaveLength(2);
    expect(jobs.every(job => job.priority === 10)).toBe(true);
    await done(f.queue);
    expect(f.queue.jobs().every(job => job.status === 'completed')).toBe(true);
    expect(f.remote.files.get('/site/bundle/index.html')?.data.toString()).toContain('ok');
    expect(f.remote.files.get('/site/bundle/empty')?.kind).toBe('directory');
    expect([...f.remote.files.keys()].some(key => key.includes('.env') || key.includes('.pem') || key.includes('node_modules'))).toBe(false);
  });

  it('requires explicit allowSensitive and does not bypass development filters', async () => {
    const f = await fixture();
    const request = await f.upload('.env', 'SECRET');
    expect(await f.queue.enqueue([request])).toHaveLength(0);
    const [job] = await f.queue.enqueue([{ ...request, allowSensitive: true }]);
    await done(f.queue);
    expect(f.queue.jobs().find(item => item.id === job.id)?.status).toBe('completed');
    expect(f.remote.files.get('/site/.env')?.data.toString()).toBe('SECRET');
  });

  it('supports nested confined remote roots without requesting forbidden ancestors', async () => {
    const f = await fixture({ remoteRoot: '/site/nested/root' });
    f.remote.directory('/site/nested'); f.remote.directory('/site/nested/root');
    const request = await f.upload('sub/index.html'); request.remotePath = '/site/nested/root/sub/index.html';
    await f.queue.enqueue([request]); await done(f.queue);
    expect(f.queue.jobs()[0].status).toBe('completed');
    expect(f.remote.files.get(request.remotePath)?.data.toString()).toBe('sub/index.html');
  });

  it('applies an async custom predicate to recursive upload files and directory subtrees', async () => {
    const seen: string[] = [];
    const f = await fixture({}, undefined, async (_request, entry) => {
      seen.push(`${entry.kind}:${entry.relativePath}`);
      return entry.kind === 'directory' ? entry.name !== 'excluded' : entry.name.endsWith('.html');
    });
    await f.upload('bundle/keep/index.html');
    await f.upload('bundle/keep/skip.txt');
    await f.upload('bundle/excluded/private.html');
    await f.upload('bundle/.env', 'secret');
    await f.queue.enqueue([{ connectionId: 'connection', direction: 'upload', localPath: path.join(f.root, 'bundle'), remotePath: '/site/bundle', projectId: 'project' }]);
    await done(f.queue);
    expect(f.queue.jobs()).toHaveLength(1);
    expect(f.remote.files.get('/site/bundle/keep/index.html')?.kind).toBe('file');
    expect(seen).toContain('directory:bundle/excluded');
    expect(seen).not.toContain('file:bundle/excluded/private.html');
    expect(seen).not.toContain('file:bundle/.env');
  });

  it('applies a custom predicate recursively to remote download folders', async () => {
    const f = await fixture({}, undefined, (_request, entry) => entry.kind === 'directory' ? entry.name !== 'excluded' : entry.name.endsWith('.html'));
    f.remote.directory('/site/bundle'); f.remote.directory('/site/bundle/keep'); f.remote.directory('/site/bundle/excluded');
    f.remote.put('/site/bundle/keep/index.html', 'included');
    f.remote.put('/site/bundle/keep/skip.txt', 'skip');
    f.remote.put('/site/bundle/excluded/private.html', 'skip');
    await f.queue.enqueue([{ connectionId: 'connection', direction: 'download', localPath: path.join(f.root, 'bundle'), remotePath: '/site/bundle' }]);
    await done(f.queue);
    expect(f.queue.jobs()).toHaveLength(1);
    expect(await fs.readFile(path.join(f.root, 'bundle/keep/index.html'), 'utf8')).toBe('included');
    expect(await fs.readdir(path.join(f.root, 'bundle'))).toEqual(['keep']);
    expect(await fs.readdir(path.join(f.root, 'bundle/keep'))).toEqual(['index.html']);
  });

  it('rejects an entire recursive no-replace download if any nested target already exists', async () => {
    const f = await fixture();
    f.remote.directory('/site/bundle'); f.remote.directory('/site/bundle/nested');
    f.remote.put('/site/bundle/new.txt', 'new remote file');
    f.remote.put('/site/bundle/nested/existing.txt', 'remote replacement');
    await f.upload('bundle/nested/existing.txt', 'local original');
    await expect(f.queue.enqueue([{ connectionId: 'connection', direction: 'download', localPath: path.join(f.root, 'bundle'), remotePath: '/site/bundle', overwriteExisting: false, expectedLocal: null }])).rejects.toThrow('overschrijven');
    expect(f.queue.jobs()).toHaveLength(0); expect(f.remote.calls).toHaveLength(0);
    expect(await fs.readFile(path.join(f.root, 'bundle/nested/existing.txt'), 'utf8')).toBe('local original');
    expect(await fs.readdir(path.join(f.root, 'bundle'))).toEqual(['nested']);
  });

  it('allows directory merges while guarding every no-replace descendant against a later writer', async () => {
    const f = await fixture();
    f.remote.directory('/site/bundle'); f.remote.directory('/site/bundle/nested');
    f.remote.put('/site/bundle/nested/file.txt', 'downloaded');
    await fs.mkdir(path.join(f.root, 'bundle/nested'), { recursive: true });
    const target = path.join(f.root, 'bundle/nested/file.txt');
    f.remote.afterDownload = async () => { await fs.writeFile(target, 'created by another writer'); };
    const [job] = await f.queue.enqueue([{ connectionId: 'connection', direction: 'download', localPath: path.join(f.root, 'bundle'), remotePath: '/site/bundle', overwriteExisting: false }]);
    expect(job.expectedLocal).toBe(null); expect(job.overwriteExisting).toBe(false);
    await done(f.queue); expect(f.queue.jobs()[0].status).toBe('conflict');
    expect(await fs.readFile(target, 'utf8')).toBe('created by another writer');
  });

  it('rejects existing no-replace upload targets and preserves supplied source guards', async () => {
    const f = await fixture(); const upload = await f.upload('no-replace.txt', 'local');
    f.remote.put(upload.remotePath, 'server original');
    await expect(f.queue.enqueue([{ ...upload, overwriteExisting: false }])).rejects.toThrow('overschrijven');
    expect(f.remote.files.get(upload.remotePath)?.data.toString()).toBe('server original');
    const download = f.download('new-download.txt', 'source');
    const sourceGuard = { size: 999, modifiedAt: 0 };
    const [job] = await f.queue.enqueue([{ ...download, overwriteExisting: false, expectedRemote: sourceGuard }]);
    expect(job.expectedRemote).toEqual(sourceGuard); expect(job.expectedLocal).toBe(null);
    await done(f.queue); expect(f.queue.jobs()[0].status).toBe('conflict'); expect(f.remote.calls).toHaveLength(0);
  });

  it('narrowly authorizes guarded single-file cache uploads without broadening local access', async () => {
    const cache = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-queue-cache-'));
    const f = await fixture({}, undefined, undefined, { trustedCacheRoot: cache });
    fixtures.push({ root: cache, queue: f.queue });
    await fs.mkdir(path.join(cache, 'document'));
    const cached = path.join(cache, 'document/index.html'); await fs.writeFile(cached, 'edited remotely');
    f.remote.put('/site/index.html', 'old');
    const expectedRemote = { size: 3, modifiedAt: f.remote.entry('/site/index.html')!.modifiedAt };
    const request: TransferRequest = { connectionId: 'connection', direction: 'upload', localPath: cached, remotePath: '/site/index.html', expectedRemote };
    await expect(f.queue.enqueue([{ ...request, expectedRemote: undefined }])).rejects.toThrow('buiten');
    await expect(f.queue.enqueue([{ ...request, direction: 'download' }])).rejects.toThrow('buiten');
    await expect(f.queue.enqueue([{ ...request, localPath: path.join(cache, 'document') }])).rejects.toThrow('afzonderlijk');
    await expect(f.queue.enqueue([{ ...request, localPath: path.join(cache, '../untrusted.html') }])).rejects.toThrow('buiten');
    await fs.symlink(cached, path.join(cache, 'link.html'));
    await expect(f.queue.enqueue([{ ...request, localPath: path.join(cache, 'link.html') }])).rejects.toThrow('koppeling');
    await f.queue.enqueue([request]); await done(f.queue);
    expect(f.queue.jobs()[0].status).toBe('completed');
    expect(f.remote.files.get('/site/index.html')?.data.toString()).toBe('edited remotely');
  });

  it('emits the exact verified remote version instead of a later completion-hook re-stat', async () => {
    let completed: TransferJob | undefined;
    const f = await fixture({}, async job => { completed = job; f.remote.put(job.remotePath, 'later edit'); });
    const request = await f.upload('version.txt', 'ours');
    await f.queue.enqueue([request]); await done(f.queue); await f.queue.close();
    expect(completed?.verifiedRemote?.size).toBe(4);
    expect(completed?.verifiedRemote?.modifiedAt).toBe(f.remote.entry('/site/version.txt')!.modifiedAt! - 1);
    expect(f.queue.jobs()[0].verifiedRemote).toEqual(completed?.verifiedRemote);
  });

  it('prioritizes manual jobs and caps transfers at the profile limit', async () => {
    const f = await fixture({ parallelTransfers: 2 });
    const gate = deferred(); f.remote.hold = gate.promise;
    const requests = await Promise.all(Array.from({ length: 8 }, (_, i) => f.upload(`${i}.txt`)));
    requests[6].priority = 100; requests[7].priority = 100;
    requests.forEach((request, i) => { if (i < 6) request.priority = 10; });
    await f.queue.enqueue(requests);
    await eventually(() => f.remote.active === 2);
    expect(f.remote.calls.slice(0, 2).map(name => name.match(/\.(\d)\.txt\./)?.[1]).sort()).toEqual(['6', '7']);
    expect(f.remote.maximumActive).toBe(2);
    gate.resolve(); await done(f.queue);
    expect(f.remote.maximumActive).toBe(2);
    await f.queue.close(); expect(f.remote.releases).toBe(f.remote.sessions);
  });

  it('applies consecutive priority deltas to durable current values without intervening UI snapshots and clamps boundaries', async () => {
    const f = await fixture(); f.remote.hold = new Promise<void>(() => {});
    await f.queue.enqueue([await f.upload('selected.txt'), await f.upload('unchanged.txt')]);
    await f.queue.close();
    const notifications: TransferJob[][] = [];
    const restored = new TransferQueue(f.remote, f.store, () => {}, jobs => notifications.push(jobs));
    fixtures.push({ root: f.root, queue: restored });
    const displayed = restored.jobs(), selected = displayed[0].id;
    const assertPriority = (expected: number) => {
      expect(restored.jobs()[0].priority).toBe(expected);
      expect(f.store.get<Array<{ job: TransferJob }>>('transferQueue.v1', [])[0].job.priority).toBe(expected);
      expect(restored.jobs()[1].priority).toBe(50);
      expect(displayed[0].priority).toBe(50);
      expect(notifications).toEqual([]);
    };
    expect(displayed.every(job => job.status === 'paused')).toBe(true);
    await restored.action('lowerPriority', [selected]); assertPriority(49);
    await restored.action('raisePriority', [selected]); assertPriority(50);
    await restored.action('raisePriority', [selected]); assertPriority(51);
    await restored.action('priority', [selected], 0);
    await restored.action('lowerPriority', [selected]); assertPriority(0);
    await restored.action('raisePriority', [selected]); assertPriority(1);
    await restored.action('priority', [selected], 100);
    await restored.action('raisePriority', [selected]); assertPriority(100);
    await restored.action('lowerPriority', [selected]); assertPriority(99);
  });

  it('uses four transfers when the profile leaves parallelism unspecified', async () => {
    const f = await fixture({ parallelTransfers: 0, connectionLimit: 10 });
    const gate = deferred(); f.remote.hold = gate.promise;
    await f.queue.enqueue(await Promise.all(Array.from({ length: 6 }, (_, i) => f.upload(`${i}.txt`))));
    await eventually(() => f.remote.active === 4);
    expect(f.remote.maximumActive).toBe(4);
    gate.resolve(); await done(f.queue);
  });

  it('serializes duplicate destinations so the second sees a conflict', async () => {
    const f = await fixture(); const request = await f.upload('duplicate.txt');
    await f.queue.enqueue([request, request]); await done(f.queue);
    expect(f.queue.jobs().map(job => job.status)).toEqual(['completed', 'conflict']);
    expect(f.remote.calls).toHaveLength(1);
  });

  it('preserves an existing server file using a verified backup when overwrite rename is unsupported', async () => {
    const f = await fixture(); const request = await f.upload('page.html', 'new version');
    f.remote.put('/site/page.html', 'original');
    await f.queue.enqueue([request]); await done(f.queue);
    expect(f.queue.jobs()[0].status).toBe('completed');
    expect(f.remote.files.get('/site/page.html')?.data.toString()).toBe('new version');
    expect(f.remote.renames[0][0]).toBe('/site/page.html');
    expect(f.remote.renames[0][1]).toMatch(/\.backup$/);
    expect(f.remote.removals).not.toContain('/site/page.html');
    expect([...f.remote.files.keys()].filter(key => key.includes('.ftp-studio-'))).toHaveLength(0);
  });

  it('preserves a reliable existing remote mode on the staged replacement', async () => {
    const f = await fixture(); const request = await f.upload('private.html', 'new content');
    f.remote.put(request.remotePath, 'original'); f.remote.files.get(request.remotePath)!.permissions = '0600';
    await f.queue.enqueue([request]); await done(f.queue);
    expect(f.queue.jobs()[0].status).toBe('completed');
    expect(f.remote.files.get(request.remotePath)?.permissions).toBe('0600');
    expect(f.remote.chmodCalls).toHaveLength(1);
    expect(f.remote.chmodCalls[0][0]).toMatch(/\.part$/);
    expect(f.remote.chmodCalls[0][1]).toBe('0600');
  });

  it('leaves the original remote file untouched when applying its mode fails', async () => {
    const f = await fixture(); const request = await f.upload('private.html', 'new content');
    f.remote.put(request.remotePath, 'original'); f.remote.files.get(request.remotePath)!.permissions = '0640'; f.remote.chmodFailure = true;
    await f.queue.enqueue([request]); await done(f.queue);
    expect(f.queue.jobs()[0].status).toBe('failed');
    expect(f.remote.files.get(request.remotePath)?.data.toString()).toBe('original');
    expect(f.remote.files.get(request.remotePath)?.permissions).toBe('0640');
    expect(f.remote.renames).toHaveLength(0);
  });

  it('does not overwrite a concurrent remote permission change', async () => {
    const f = await fixture(); const request = await f.upload('private.html', 'new content');
    f.remote.put(request.remotePath, 'original'); f.remote.files.get(request.remotePath)!.permissions = '0640';
    f.remote.afterUpload = async () => { f.remote.files.get(request.remotePath)!.permissions = '0600'; };
    await f.queue.enqueue([request]); await done(f.queue);
    expect(f.queue.jobs()[0].status).toBe('conflict');
    expect(f.remote.files.get(request.remotePath)?.data.toString()).toBe('original');
    expect(f.remote.files.get(request.remotePath)?.permissions).toBe('0600');
    expect(f.remote.renames).toHaveLength(0);
  });

  it('restores the original after a staging rename failure', async () => {
    const f = await fixture(); const request = await f.upload('page.html', 'new version');
    f.remote.put('/site/page.html', 'original');
    f.remote.beforeRename = async from => { if (from.endsWith('.part')) throw new Error('Simulated install failure'); };
    await f.queue.enqueue([request]); await done(f.queue);
    expect(f.queue.jobs()[0].status).toBe('failed');
    expect(f.remote.files.get('/site/page.html')?.data.toString()).toBe('original');
    expect(f.remote.removals).not.toContain('/site/page.html');
  });

  it('retains the original backup if another writer creates the destination during commit', async () => {
    const f = await fixture(); const request = await f.upload('page.html', 'ours');
    f.remote.put('/site/page.html', 'original');
    f.remote.beforeRename = async from => { if (from.endsWith('.part')) { f.remote.put('/site/page.html', 'other writer'); throw new Error('Race'); } };
    await f.queue.enqueue([request]); await done(f.queue);
    expect(f.queue.jobs()[0].status).toBe('conflict');
    expect(f.remote.files.get('/site/page.html')?.data.toString()).toBe('other writer');
    expect([...f.remote.files.entries()].find(([key]) => key.endsWith('.backup'))?.[1].data.toString()).toBe('original');
    expect(f.queue.jobs()[0].error).toContain('reservekopie');
  });

  it('detects source edits during upload, preserving the remote original', async () => {
    const f = await fixture(); const request = await f.upload('source.txt', 'before');
    f.remote.put('/site/source.txt', 'server original');
    f.remote.afterUpload = async () => { await fs.writeFile(request.localPath, 'after!'); };
    await f.queue.enqueue([request]); await done(f.queue);
    expect(f.queue.jobs()[0].status).toBe('conflict');
    expect(f.remote.files.get('/site/source.txt')?.data.toString()).toBe('server original');
  });

  it('detects remote target edits during upload and retains the other writer', async () => {
    const f = await fixture(); const request = await f.upload('target.txt', 'ours');
    f.remote.put('/site/target.txt', 'before');
    f.remote.afterUpload = async () => { f.remote.put('/site/target.txt', 'new server version'); };
    await f.queue.enqueue([request]); await done(f.queue);
    expect(f.queue.jobs()[0].status).toBe('conflict');
    expect(f.remote.files.get('/site/target.txt')?.data.toString()).toBe('new server version');
  });

  it('refuses to install a truncated temporary upload', async () => {
    const f = await fixture(); const request = await f.upload('size.txt', 'complete source');
    f.remote.put('/site/size.txt', 'original');
    f.remote.afterUpload = async () => {
      const stage = [...f.remote.files.keys()].find(key => key.endsWith('.part'))!;
      f.remote.put(stage, 'short');
    };
    await f.queue.enqueue([request]); await done(f.queue);
    expect(f.queue.jobs()[0].status).toBe('failed');
    expect(f.remote.files.get('/site/size.txt')?.data.toString()).toBe('original');
    expect(f.remote.renames).toHaveLength(0);
  });

  it('honors caller-supplied snapshots instead of replacing stale guards', async () => {
    const f = await fixture(); const request = await f.upload('stale.txt');
    request.expectedLocal = { size: 123456, modifiedAt: 0 };
    await f.queue.enqueue([request]); await done(f.queue);
    expect(f.queue.jobs()[0].status).toBe('conflict'); expect(f.remote.calls).toHaveLength(0);
  });

  it('downloads atomically, retaining local edits made during download', async () => {
    const f = await fixture(); const request = f.download('download.txt', 'remote content');
    await fs.writeFile(request.localPath, 'old local');
    f.remote.afterDownload = async () => { await fs.writeFile(request.localPath, 'edited locally'); };
    await f.queue.enqueue([request]); await done(f.queue);
    expect(f.queue.jobs()[0].status).toBe('conflict');
    expect(await fs.readFile(request.localPath, 'utf8')).toBe('edited locally');
    expect((await fs.readdir(f.root)).filter(name => name.includes('.ftp-studio-'))).toHaveLength(0);
  });

  it('detects remote source edits during download', async () => {
    const f = await fixture(); const request = f.download('download.txt', 'remote content');
    await fs.writeFile(request.localPath, 'old local');
    f.remote.afterDownload = async () => { f.remote.put('/site/download.txt', 'changed while downloading'); };
    await f.queue.enqueue([request]); await done(f.queue);
    expect(f.queue.jobs()[0].status).toBe('conflict');
    expect(await fs.readFile(request.localPath, 'utf8')).toBe('old local');
  });

  it('replaces an existing local target after all guards pass', async () => {
    const f = await fixture(); const request = f.download('download.txt', 'remote content');
    await fs.writeFile(request.localPath, 'old local');
    await f.queue.enqueue([request]); await done(f.queue);
    expect(f.queue.jobs()[0].status).toBe('completed');
    expect(await fs.readFile(request.localPath, 'utf8')).toBe('remote content');
    expect(f.queue.jobs()[0].verifiedLocal?.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(f.queue.jobs()[0].verifiedLocal?.size).toBe(Buffer.byteLength('remote content'));
    expect(f.queue.jobs()[0].verifiedRemote?.modifiedAt).toBe(f.remote.entry(request.remotePath)!.modifiedAt);
    expect(await fs.readdir(f.root)).toEqual(['download.txt']);
  });

  it('preserves the existing local access mode when installing a download', async () => {
    const f = await fixture(); const request = f.download('permissions.txt', 'downloaded');
    await fs.writeFile(request.localPath, 'original'); await fs.chmod(request.localPath, 0o664);
    const expectedMode = (await fs.stat(request.localPath)).mode & 0o777;
    await f.queue.enqueue([request]); await done(f.queue);
    expect(f.queue.jobs()[0].status).toBe('completed');
    expect((await fs.stat(request.localPath)).mode & 0o777).toBe(expectedMode);
    expect(await fs.readFile(request.localPath, 'utf8')).toBe('downloaded');
  });

  it('leaves the existing local file untouched when staged chmod fails', async () => {
    const f = await fixture(); const request = f.download('permissions.txt', 'downloaded');
    await fs.writeFile(request.localPath, 'original');
    const handle = await fs.open(request.localPath, 'r'), prototype = Object.getPrototypeOf(handle);
    await handle.close();
    const originalChmod = prototype.chmod;
    prototype.chmod = async () => { throw Object.assign(new Error('Staged chmod denied'), { code: 'EACCES' }); };
    try {
      await f.queue.enqueue([request]); await done(f.queue);
      expect(f.queue.jobs()[0].status).toBe('failed');
      expect(await fs.readFile(request.localPath, 'utf8')).toBe('original');
      expect(await fs.readdir(f.root)).toEqual(['permissions.txt']);
    } finally { prototype.chmod = originalChmod; }
  });

  it('pauses/cancels running work, releases sessions and resumes from zero', async () => {
    const f = await fixture(); const gate = deferred(); f.remote.hold = gate.promise;
    const [job] = await f.queue.enqueue([await f.upload('pause.txt')]);
    await eventually(() => f.remote.active === 1);
    await f.queue.action('pause', [job.id]);
    expect(f.queue.jobs()[0].status).toBe('paused'); expect(f.remote.active).toBe(0);
    gate.resolve(); f.remote.hold = undefined;
    await f.queue.action('resume', [job.id]); await done(f.queue);
    expect(f.queue.jobs()[0].status).toBe('completed'); expect(f.remote.calls).toHaveLength(2);
    const secondGate = deferred(); f.remote.hold = secondGate.promise;
    const [cancelled] = await f.queue.enqueue([await f.upload('cancel.txt')]);
    await eventually(() => f.remote.active === 1);
    await f.queue.action('cancel', [cancelled.id]); secondGate.resolve();
    expect(f.queue.jobs().find(item => item.id === cancelled.id)?.status).toBe('cancelled');
    expect(f.remote.files.has('/site/cancel.txt')).toBe(false);
  });

  it('finishes an already-started commit instead of aborting its rollback-capable lease', async () => {
    const f = await fixture(); const request = await f.upload('commit.txt', 'new');
    f.remote.put('/site/commit.txt', 'old');
    const entered = deferred(), release = deferred();
    f.remote.beforeRename = async from => { if (from.endsWith('.part')) { entered.resolve(); await release.promise; } };
    const [job] = await f.queue.enqueue([request]); await entered.promise;
    const cancellation = f.queue.action('cancel', [job.id]);
    expect(f.remote.signals[0].aborted).toBe(false);
    release.resolve(); await cancellation; await done(f.queue);
    expect(f.queue.jobs()[0].status).toBe('completed');
    expect(f.remote.files.get('/site/commit.txt')?.data.toString()).toBe('new');
  });

  it('bounds exponential automatic retries and stops after four attempts', async () => {
    const f = await fixture({ autoReconnect: true }); f.remote.failures = 20;
    await f.queue.enqueue([await f.upload('retry.txt')]); await done(f.queue);
    expect(f.queue.jobs()[0]).toMatchObject({ status: 'failed', attempts: 4 });
    expect(f.remote.calls).toHaveLength(4);
  }, 10_000);

  it('does not retry automatically when autoReconnect is disabled', async () => {
    const f = await fixture(); f.remote.failures = 1;
    const [job] = await f.queue.enqueue([await f.upload('retry.txt')]); await done(f.queue);
    expect(f.queue.jobs()[0]).toMatchObject({ status: 'failed', attempts: 1 });
    await f.queue.action('retry', [job.id]); await done(f.queue);
    expect(f.queue.jobs()[0].status).toBe('completed');
  });

  it('restores queued/running records paused and blocks ambiguous commit replay', async () => {
    const f = await fixture(); const gate = deferred(); f.remote.hold = gate.promise;
    await f.queue.enqueue([await f.upload('restore.txt')]); await eventually(() => f.remote.active === 1);
    const saved = f.store.get<{ job: TransferJob; kind: 'file'; transaction?: unknown }[]>('transferQueue.v1', []);
    await f.queue.close(); gate.resolve();
    saved[0].job.status = 'running';
    saved[0].transaction = { stage: '/site/.interrupted.part', backup: '/site/.original.backup', phase: 'backed-up' };
    f.store.set('transferQueue.v1', saved);
    const restored = new TransferQueue(f.remote, f.store, () => {}, () => {}); fixtures.push({ root: f.root, queue: restored });
    expect(restored.jobs()[0].status).toBe('paused');
    const calls = f.remote.calls.length;
    await new Promise(resolve => setTimeout(resolve, 20)); expect(f.remote.calls).toHaveLength(calls);
    await restored.action('resume'); await done(restored);
    expect(restored.jobs()[0].status).toBe('conflict'); expect(restored.jobs()[0].error).toContain('.original.backup');
    expect(f.remote.calls).toHaveLength(calls);
    await restored.action('clear');
    expect(restored.jobs()).toHaveLength(1);
    expect(restored.jobs()[0].error).toContain('.original.backup');
  });

  it('does not retransmit when a post-completion hook fails', async () => {
    const f = await fixture({ autoReconnect: true }, async () => { throw new Error('Manifest store failed'); });
    await f.queue.enqueue([await f.upload('hook.txt')]); await done(f.queue);
    expect(f.queue.jobs()[0]).toMatchObject({ status: 'completed', attempts: 1 }); expect(f.remote.calls).toHaveLength(1);
  });

  it('rejects local escape, symlinks and remote traversal before enqueue', async () => {
    const f = await fixture(); const request = await f.upload('safe.txt');
    await expect(f.queue.enqueue([{ ...request, localPath: path.join(f.root, '../outside.txt') }])).rejects.toThrow('buiten');
    await expect(f.queue.enqueue([{ ...request, remotePath: '/site/../outside.txt' }])).rejects.toThrow('padontsnapping');
    await fs.symlink(request.localPath, path.join(f.root, 'link.txt'));
    await expect(f.queue.enqueue([{ ...request, localPath: path.join(f.root, 'link.txt') }])).rejects.toThrow('koppeling');
    f.remote.files.set('/site/link', { kind: 'symlink', data: Buffer.alloc(0), modifiedAt: 0 });
    await expect(f.queue.enqueue([{ ...request, remotePath: '/site/link/file.txt' }])).rejects.toThrow('koppeling');
    expect(f.queue.jobs()).toHaveLength(0);
  });

  it('returns copies of jobs and clears only selected terminal jobs', async () => {
    const f = await fixture(); const jobs = await f.queue.enqueue([await f.upload('one.txt'), await f.upload('two.txt')]); await done(f.queue);
    const copies = f.queue.jobs(); copies[0].status = 'failed';
    expect(f.queue.jobs()[0].status).toBe('completed');
    await f.queue.action('clear', [jobs[0].id]); expect(f.queue.jobs().map(job => job.id)).toEqual([jobs[1].id]);
  });
});
