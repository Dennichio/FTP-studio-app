import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StudioService, type NativeActions } from '../src/main/service';
import { CredentialVault, SqliteStore } from '../src/main/storage';
import type { ConnectionProfile, PersistedQueueRecord, Project } from '../src/shared/contracts';
import { ftpFixture } from './fixtures/ftp-server';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-manual-service-'));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, 'data'), localRoot = path.join(root, 'project');
  await fs.mkdir(localRoot);
  const store = new SqliteStore(path.join(dataRoot, 'state.db'));
  cleanup.push(async () => store.close());
  const createService = () => {
    const native: NativeActions = { chooseFile: async () => null, chooseSaveFile: async () => null, chooseFolder: async () => null, confirm: async () => true, openBrowser: async () => {} };
    const vault = new CredentialVault(store, { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('No saved credentials'); }, decryptString: () => { throw new Error('No saved credentials'); } });
    const service = new StudioService(store, vault, dataRoot, native, () => {});
    cleanup.push(() => service.close());
    return service;
  };
  return { root, dataRoot, localRoot, store, createService };
}

describe('manual transfer service boundaries', () => {
  it.each(['outside', 'inside'] as const)('applies custom project path filters with a chosen root %s the project', async location => {
    const f = await fixture();
    const server = await ftpFixture({ supportsMlst: true, controlNoDelay: true });
    cleanup.push(() => server.close());
    server.directories.add('/site');
    const service = f.createService();
    const profile: ConnectionProfile = { id: 'manual', name: 'Manual', host: '127.0.0.1', port: server.port, protocol: 'ftp', username: 'test', localRoot: f.localRoot, remoteRoot: '/site', timeoutMs: 2000, connectionLimit: 2, parallelTransfers: 1, autoReconnect: false, passive: true };
    const state = await service.invoke('connect', { profile, credentials: { password: 'test' } });
    const project: Project = { id: 'project', name: 'Project', profileId: profile.id, localRoot: f.localRoot, remoteRoot: '/site', filters: { display: [], sync: [], transfer: [{ id: 'only-text-in-album', action: 'include', field: 'path', operator: 'glob', value: 'album/*.txt' }] }, environments: [], bookmarks: [] };
    await service.invoke('saveProject', { project });
    const chosen = location === 'outside' ? path.join(f.root, 'external') : path.join(f.localRoot, 'album');
    const directory = location === 'outside' ? path.join(chosen, 'album') : chosen;
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'allowed.txt'), 'allowed bytes');
    await fs.writeFile(path.join(directory, 'excluded.bin'), 'excluded bytes');
    const jobs = await service.invoke('enqueue', { requests: ['allowed.txt', 'excluded.bin'].map(name => ({ connectionId: profile.id, expectedEndpoint: state.endpointKey, projectId: project.id, direction: 'upload' as const, localRootOverride: chosen, localPath: path.join(directory, name), remotePath: `/site/${name}`, expectedRemote: null })) });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].remotePath).toBe('/site/allowed.txt');
    await vi.waitFor(() => expect(service.queue.jobs()[0].status).toBe('completed'), { timeout: 10000 });
    expect(server.files.get('/site/allowed.txt')).toEqual(Buffer.from('allowed bytes'));
    expect(server.files.has('/site/excluded.bin')).toBe(false);
  });

  it('retains a registered recovery source when clearing its conflict and reconciling after restart', async () => {
    const f = await fixture(), cacheRoot = path.join(f.dataRoot, 'workcache');
    const source = path.join(cacheRoot, 'remote-action-recovery', 'source.txt');
    const orphan = path.join(cacheRoot, 'remote-action-orphan', 'source.txt');
    await Promise.all([source, orphan].map(async filename => { await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, filename === source ? 'recoverable original' : 'orphan'); }));
    const record: PersistedQueueRecord = { kind: 'file', job: { id: 'recovery', connectionId: 'disconnected', direction: 'upload', localPath: source, remotePath: '/site/source.txt', status: 'conflict', size: 20, transferred: 20, speed: 0, remainingSeconds: null, attempts: 1, createdAt: 1 }, transaction: { stage: '/site/.stage', backup: '/site/.backup', phase: 'backed-up' } };
    f.store.queue.commit([record], []);
    f.store.set('remoteActionSources.v1', [source, orphan]);
    const service = f.createService();
    await vi.waitFor(() => expect(f.store.get('remoteActionSources.v1', [])).toEqual([source]));
    await expect(fs.stat(orphan)).rejects.toMatchObject({ code: 'ENOENT' });
    await service.invoke('queueAction', { action: 'clear', ids: ['recovery'] });
    expect(service.queue.jobs()).toEqual([]);
    expect(f.store.queue.load()).toEqual([{ ...record, archived: true }]);
    expect(f.store.get('remoteActionSources.v1', [])).toEqual([source]);
    expect(await fs.readFile(source, 'utf8')).toBe('recoverable original');
    await service.close();
    // A second orphan makes completion of startup reconciliation observable.
    await fs.mkdir(path.dirname(orphan), { recursive: true }); await fs.writeFile(orphan, 'new orphan');
    f.store.set('remoteActionSources.v1', [source, orphan]);
    const restarted = f.createService();
    await vi.waitFor(() => expect(f.store.get('remoteActionSources.v1', [])).toEqual([source]));
    expect(restarted.queue.jobs()).toEqual([]);
    expect(restarted.queue.jobs(true).map(job => job.id)).toEqual(['recovery']);
    expect(await fs.readFile(source, 'utf8')).toBe('recoverable original');
    expect(f.store.queue.load()).toEqual([{ ...record, archived: true }]);
  });
});
