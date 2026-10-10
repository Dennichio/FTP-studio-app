import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SqliteStore, CredentialVault } from '../src/main/storage';
import { StudioService, type NativeActions } from '../src/main/service';
import type { PersistedQueueRecord, TransferStatus } from '../src/shared/contracts';

const fixtures: Array<{ root: string; store: SqliteStore; service?: StudioService }> = [];
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.service?.close(); f.store.close(); await fs.rm(f.root, { recursive: true, force: true }); } });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-file-actions-recovery-'));
  const store = new SqliteStore(path.join(root, 'state.db')), cache = path.join(root, 'workcache');
  const saved: { root: string; store: SqliteStore; service?: StudioService } = { root, store }; fixtures.push(saved);
  const start = () => {
    const native: NativeActions = { chooseFile: async () => null, chooseSaveFile: async () => null, chooseFolder: async () => null, confirm: async () => false, openBrowser: async () => {} };
    saved.service = new StudioService(store, new CredentialVault(store, { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('Not used'); }, decryptString: () => { throw new Error('Not used'); } }), root, native, () => {});
    return saved.service;
  };
  const source = async (id: string) => { const filename = path.join(cache, 'remote-action-' + id, id + '.css'); await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, id); return filename; };
  const record = (id: string, localPath: string, status: TransferStatus): PersistedQueueRecord => ({ kind: 'file', job: { id, connectionId: 'disconnected', direction: 'upload', localPath, remotePath: '/site/' + id + '.css', expectedRemote: null, overwriteExisting: false, status, size: id.length, transferred: 0, speed: 0, remainingSeconds: null, attempts: 0, createdAt: Date.now() } });
  return { root, cache, store, start, source, record };
}

describe('durable private action source lifecycle', () => {
  it('reconciles orphaned/completed registrations without removing an ordinary cache source', async () => {
    const f = await fixture(), orphan = await f.source('orphan'), completed = await f.source('completed'), ordinary = await f.source('ordinary');
    f.store.set('remoteActionSources.v1', [orphan, completed]); f.store.queue.commit([f.record('completed', completed, 'completed')], []);
    f.start(); await vi.waitFor(() => expect(f.store.get('remoteActionSources.v1', [])).toEqual([]));
    await expect(fs.stat(orphan)).rejects.toMatchObject({ code: 'ENOENT' }); await expect(fs.stat(completed)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(ordinary, 'utf8')).toBe('ordinary');
  });
  it('retains paused/conflict/failed/cancelled sources across restart and releases only cleared jobs', async () => {
    const f = await fixture(), states = ['paused', 'conflict', 'failed', 'cancelled'] as const;
    const sources = await Promise.all(states.map(status => f.source(status)));
    f.store.set('remoteActionSources.v1', sources); f.store.queue.commit(states.map((status, i) => f.record(status, sources[i], status)), []);
    let service = f.start(); await service.close(); service = f.start();
    expect(f.store.get('remoteActionSources.v1', [])).toEqual(sources);
    for (let i = 0; i < states.length; i++) expect(await fs.readFile(sources[i], 'utf8')).toBe(states[i]);
    await service.invoke('queueAction', { action: 'clear' });
    expect(service.queue.jobs().map(job => job.id)).toEqual(['paused']); expect(f.store.get('remoteActionSources.v1', [])).toEqual([sources[0]]);
    expect(await fs.readFile(sources[0], 'utf8')).toBe('paused');
    await service.invoke('queueAction', { action: 'cancel', ids: ['paused'] }); await service.invoke('queueAction', { action: 'clear' });
    expect(f.store.get('remoteActionSources.v1', [])).toEqual([]); expect(await fs.readdir(f.cache)).toEqual([]);
  });
});
