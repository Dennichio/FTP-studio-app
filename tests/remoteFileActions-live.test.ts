import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SqliteStore, CredentialVault } from '../src/main/storage';
import { StudioService, type NativeActions } from '../src/main/service';
import type { ConnectionProfile, FilterRule, Project } from '../src/shared/contracts';
import { ftpFixture } from './fixtures/ftp-server';

const fixtures: Array<{ root: string; service: StudioService; store: SqliteStore; server: Awaited<ReturnType<typeof ftpFixture>> }> = [];
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.service.close(); f.store.close(); await f.server.close(); await fs.rm(f.root, { recursive: true, force: true }); } });
async function fixture(options: Parameters<typeof ftpFixture>[0] = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-file-actions-live-')), localRoot = path.join(root, 'project'); await fs.mkdir(localRoot);
  const server = await ftpFixture(options); server.directories.add('/site'); server.directories.add('/site/sub');
  const store = new SqliteStore(path.join(root, 'data', 'state.db'));
  const native: NativeActions = { chooseFile: vi.fn(async () => null), chooseSaveFile: vi.fn(async () => null), chooseFolder: vi.fn(async () => null), confirm: vi.fn(async () => true), openBrowser: vi.fn(async () => {}) };
  const service = new StudioService(store, new CredentialVault(store, { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('No credentials persisted in this fixture'); }, decryptString: () => { throw new Error('No credentials persisted in this fixture'); } }), path.join(root, 'data'), native, () => {});
  fixtures.push({ root, server, store, service });
  const profile: ConnectionProfile = { id: 'files', name: 'Bestandsacties', host: '127.0.0.1', port: server.port, protocol: 'ftp', username: 'test', localRoot, remoteRoot: '/site', timeoutMs: 2000, connectionLimit: 2, parallelTransfers: 1, autoReconnect: false, passive: true };
  const state = await service.invoke('connect', { profile, credentials: { password: 'test' } });
  const endpoint = state.endpointKey!;
  const project: Project = { id: 'files-project', name: 'Bestandsacties', profileId: profile.id, localRoot, remoteRoot: '/site', filters: { display: [], transfer: [], sync: [] }, environments: [], bookmarks: [] };
  await service.invoke('saveProject', { project });
  return { root, server, store, service, native, profile, endpoint, project };
}

describe('real queued server file actions', () => {
  it('creates an empty file and copies exact binary bytes through staging with the source intact', async () => {
    const f = await fixture(), bytes = Buffer.from([0, 255, 128, 239, 187, 191, 13, 10, 17]);
    f.server.files.set('/site/source.bin', bytes);
    const source = await f.service.invoke('statRemote', { connectionId: f.profile.id, expectedEndpoint: f.endpoint, path: '/site/source.bin' });
    const [created] = await f.service.invoke('createRemoteFile', { connectionId: f.profile.id, expectedEndpoint: f.endpoint, path: '/site/new.html', projectId: f.project.id });
    const [copied] = await f.service.invoke('copyRemoteFile', { connectionId: f.profile.id, expectedEndpoint: f.endpoint, path: '/site/source.bin', destination: '/site/sub/copy.bin', expectedSource: { size: source!.size, modifiedAt: source!.modifiedAt }, projectId: f.project.id });
    expect(created.expectedRemote).toBeNull(); expect(copied.expectedRemote).toBeNull(); expect(copied.overwriteExisting).toBe(false);
    await vi.waitFor(() => { expect(f.service.queue.jobs().find(job => job.id === created.id)?.status).toBe('completed'); expect(f.service.queue.jobs().find(job => job.id === copied.id)?.status).toBe('completed'); }, { timeout: 10000 });
    expect(f.server.files.get('/site/new.html')).toEqual(Buffer.alloc(0)); expect(f.server.files.get('/site/sub/copy.bin')).toEqual(bytes); expect(f.server.files.get('/site/source.bin')).toEqual(bytes);
    await vi.waitFor(() => expect(f.store.get('remoteActionSources.v1', [])).toEqual([]));
    expect(await fs.readdir(path.join(f.root, 'data', 'workcache'))).toEqual([]);
    expect(await fs.readdir(f.profile.localRoot)).toEqual([]);
    await expect(f.service.invoke('createRemoteFile', { connectionId: f.profile.id, expectedEndpoint: f.endpoint, path: '/site/new.html' })).rejects.toThrow(/bestaat al/);
    expect(f.server.files.get('/site/new.html')).toEqual(Buffer.alloc(0));
  });
  it('rejects stale endpoints and stale sources without publishing anything', async () => {
    const f = await fixture(); f.server.files.set('/site/source.bin', Buffer.from('actual bytes'));
    await expect(f.service.invoke('createRemoteFile', { connectionId: f.profile.id, expectedEndpoint: 'old endpoint', path: '/site/new' })).rejects.toThrow(/serverbestemming is gewijzigd/);
    await expect(f.service.invoke('copyRemoteFile', { connectionId: f.profile.id, expectedEndpoint: f.endpoint, path: '/site/source.bin', destination: '/site/new', expectedSource: { size: 999, modifiedAt: 0 } })).rejects.toThrow(/gewijzigd/);
    expect(f.service.queue.jobs()).toEqual([]); expect(f.server.files.has('/site/new')).toBe(false);
  });
  it.each<FilterRule>([
    { id: 'css-name', action: 'include', field: 'name', operator: 'glob', value: '*.css' },
    { id: 'css-extension', action: 'include', field: 'extension', operator: 'equals', value: 'css' },
  ])('uses the remote filename for queued create/copy filters ($field)', async rule => {
    const f = await fixture(); f.server.files.set('/site/source.css', Buffer.from('body { color: red; }'));
    await f.service.invoke('saveProject', { project: { ...f.project, filters: { ...f.project.filters, transfer: [rule] } } });
    const source = await f.service.invoke('statRemote', { connectionId: f.profile.id, path: '/site/source.css' });
    const [created] = await f.service.invoke('createRemoteFile', { connectionId: f.profile.id, expectedEndpoint: f.endpoint, path: '/site/new.css', projectId: f.project.id });
    const [copied] = await f.service.invoke('copyRemoteFile', { connectionId: f.profile.id, expectedEndpoint: f.endpoint, path: '/site/source.css', destination: '/site/copied.css', expectedSource: { size: source!.size, modifiedAt: source!.modifiedAt }, projectId: f.project.id });
    expect(path.basename(created.localPath)).toBe('new.css'); expect(path.basename(copied.localPath)).toBe('copied.css');
    await vi.waitFor(() => { expect(f.service.queue.jobs().find(job => job.id === created.id)?.status).toBe('completed'); expect(f.service.queue.jobs().find(job => job.id === copied.id)?.status).toBe('completed'); }, { timeout: 10000 });
    expect(f.server.files.get('/site/new.css')).toEqual(Buffer.alloc(0)); expect(f.server.files.get('/site/copied.css')).toEqual(f.server.files.get('/site/source.css'));
  });
  it('cleans private preparation if queue registration fails before a durable job exists', async () => {
    const f = await fixture(); vi.spyOn(f.service.queue, 'enqueue').mockRejectedValueOnce(new Error('Queue registration failed'));
    await expect(f.service.invoke('createRemoteFile', { connectionId: f.profile.id, expectedEndpoint: f.endpoint, path: '/site/new.txt' })).rejects.toThrow('Queue registration failed');
    expect(f.service.queue.jobs()).toEqual([]); expect(f.store.get('remoteActionSources.v1', [])).toEqual([]);
    expect(await fs.readdir(path.join(f.root, 'data', 'workcache'))).toEqual([]); expect(f.server.files.has('/site/new.txt')).toBe(false);
  });
  it('maps trusted-cache paths to the remote target even when the project root contains workcache', async () => {
    const f = await fixture(); f.server.files.set('/site/sub/source.css', Buffer.from('body { color: blue; }'));
    await f.service.invoke('saveProject', { project: { ...f.project, localRoot: f.root, filters: { ...f.project.filters, transfer: [{ id: 'remote-path', action: 'include', field: 'path', operator: 'glob', value: 'sub/*.css' }] } } });
    const source = await f.service.invoke('statRemote', { connectionId: f.profile.id, path: '/site/sub/source.css' });
    const [created] = await f.service.invoke('createRemoteFile', { connectionId: f.profile.id, expectedEndpoint: f.endpoint, path: '/site/sub/new.css', projectId: f.project.id });
    const [copied] = await f.service.invoke('copyRemoteFile', { connectionId: f.profile.id, expectedEndpoint: f.endpoint, path: '/site/sub/source.css', destination: '/site/sub/copied.css', expectedSource: { size: source!.size, modifiedAt: source!.modifiedAt }, projectId: f.project.id });
    await vi.waitFor(() => { expect(f.service.queue.jobs().find(job => job.id === created.id)?.status).toBe('completed'); expect(f.service.queue.jobs().find(job => job.id === copied.id)?.status).toBe('completed'); }, { timeout: 10000 });
    expect(f.server.files.get('/site/sub/new.css')).toEqual(Buffer.alloc(0)); expect(f.server.files.get('/site/sub/copied.css')).toEqual(f.server.files.get('/site/sub/source.css'));
  });
  it('refuses an endpoint replaced during production confirmation before creating a queue job', async () => {
    const f = await fixture(); await f.service.invoke('saveProject', { project: { ...f.project, environments: [{ id: 'production', name: 'Productie', profileId: f.profile.id, remoteRoot: '/site', production: true }] } });
    vi.mocked(f.native.confirm).mockImplementationOnce(async () => { await f.service.invoke('connect', { profile: { ...f.profile, username: 'changed-user' }, credentials: { password: 'test' } }); return true; });
    await expect(f.service.invoke('createRemoteFile', { connectionId: f.profile.id, expectedEndpoint: f.endpoint, path: '/site/new.txt', projectId: f.project.id })).rejects.toThrow(/serverbestemming is gewijzigd/);
    expect(f.service.queue.jobs()).toEqual([]); expect(f.server.files.has('/site/new.txt')).toBe(false);
  });
  it('applies source, target and ancestor project exclusions before queue publication', async () => {
    const f = await fixture(); f.server.files.set('/site/source.bin', Buffer.from('source'));
    const source = await f.service.invoke('statRemote', { connectionId: f.profile.id, path: '/site/source.bin' });
    const copy = { connectionId: f.profile.id, expectedEndpoint: f.endpoint, path: '/site/source.bin', destination: '/site/copied.bin', expectedSource: { size: source!.size, modifiedAt: source!.modifiedAt }, projectId: f.project.id };
    for (const value of ['source.bin', 'copied.bin']) {
      await f.service.invoke('saveProject', { project: { ...f.project, filters: { ...f.project.filters, transfer: [{ id: 'exclude', action: 'exclude', field: 'path', operator: 'equals', value }] } } });
      await expect(f.service.invoke('copyRemoteFile', copy)).rejects.toThrow(/uitgesloten/);
    }
    f.server.directories.add('/site/sub/deeper');
    await f.service.invoke('saveProject', { project: { ...f.project, filters: { ...f.project.filters, transfer: [{ id: 'exclude', action: 'exclude', field: 'directory', operator: 'equals', value: 'sub' }] } } });
    await expect(f.service.invoke('createRemoteFile', { connectionId: f.profile.id, expectedEndpoint: f.endpoint, path: '/site/sub/deeper/new', projectId: f.project.id })).rejects.toThrow(/uitgesloten/);
    expect(f.service.queue.jobs()).toEqual([]); expect(f.server.files.has('/site/copied.bin')).toBe(false);
  });
  it('respects production cancellation and retains a target created during confirmation', async () => {
    const f = await fixture(); await f.service.invoke('saveProject', { project: { ...f.project, environments: [{ id: 'production', name: 'Productie', profileId: f.profile.id, remoteRoot: '/site', production: true }] } });
    vi.mocked(f.native.confirm).mockResolvedValueOnce(false);
    const request = { connectionId: f.profile.id, expectedEndpoint: f.endpoint, path: '/site/new', projectId: f.project.id };
    await expect(f.service.invoke('createRemoteFile', request)).rejects.toThrow(/geannuleerd/);
    vi.mocked(f.native.confirm).mockImplementationOnce(async () => { f.server.files.set('/site/new', Buffer.from('external version')); return true; });
    await expect(f.service.invoke('createRemoteFile', request)).rejects.toThrow(/tijdens de voorbereiding/);
    expect(f.server.files.get('/site/new')?.toString()).toBe('external version'); expect(f.service.queue.jobs()).toEqual([]);
  });
  it('keeps the external cache upload authorization strict and never cleans an ordinary source', async () => {
    const f = await fixture(), filename = path.join(f.profile.localRoot, 'local.txt'); await fs.writeFile(filename, 'original local source');
    const [ordinary] = await f.service.invoke('enqueue', { requests: [{ connectionId: f.profile.id, expectedEndpoint: f.endpoint, direction: 'upload', localPath: filename, remotePath: '/site/local.txt', expectedRemote: null }] });
    await vi.waitFor(() => expect(f.service.queue.jobs().find(job => job.id === ordinary.id)?.status).toBe('completed'), { timeout: 10000 });
    expect(await fs.readFile(filename, 'utf8')).toBe('original local source');
    const fakeCache = path.join(f.root, 'data', 'workcache', 'remote-action-unregistered', 'payload'); await fs.mkdir(path.dirname(fakeCache), { recursive: true }); await fs.writeFile(fakeCache, 'unregistered bytes');
    await expect(f.service.invoke('enqueue', { requests: [{ connectionId: f.profile.id, expectedEndpoint: f.endpoint, direction: 'upload', localPath: fakeCache, remotePath: '/site/unregistered', expectedRemote: null }] })).rejects.toThrow(/cachebestand hoort niet/);
    expect(f.server.files.has('/site/unregistered')).toBe(false); expect(await fs.readFile(fakeCache, 'utf8')).toBe('unregistered bytes');
  });
  it('aborts a real stalled copy at service shutdown without creating a target', async () => {
    const f = await fixture({ stallDownload: true }); f.server.files.set('/site/source.bin', Buffer.from('stalled source'));
    const source = await f.service.invoke('statRemote', { connectionId: f.profile.id, path: '/site/source.bin' });
    const copying = f.service.invoke('copyRemoteFile', { connectionId: f.profile.id, expectedEndpoint: f.endpoint, path: '/site/source.bin', destination: '/site/copied.bin', expectedSource: { size: source!.size, modifiedAt: source!.modifiedAt } });
    const assertion = expect(copying).rejects.toThrow();
    await vi.waitFor(() => expect(f.server.downloadStarted).toBe(true)); await f.service.close(); await assertion;
    expect(f.server.files.has('/site/copied.bin')).toBe(false); expect(f.service.queue.jobs()).toEqual([]);
    expect(await fs.readdir(path.join(f.root, 'data', 'workcache'))).toEqual([]);
  });
});
