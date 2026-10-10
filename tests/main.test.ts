import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore, CredentialVault } from '../src/main/storage';
import { StudioService, type NativeActions } from '../src/main/service';
import type { ConnectionProfile, FileEntry, Project, RemoteSession } from '../src/shared/contracts';

const fixtures: Array<{ root: string; store: SqliteStore; service: StudioService }> = [];
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.service.close(); f.store.close(); await fs.rm(f.root, { recursive: true, force: true }); } });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-main-')), localRoot = path.join(root, 'project'); await fs.mkdir(localRoot);
  const store = new SqliteStore(path.join(root, 'data', 'state.db'));
  const native: NativeActions = { chooseFile: vi.fn(async () => null), chooseSaveFile: vi.fn(async () => null), chooseFolder: vi.fn(async () => null), confirm: vi.fn(async () => true), openBrowser: vi.fn(async () => {}) };
  const service = new StudioService(store, new CredentialVault(store, { isEncryptionAvailable: () => false, encryptString: () => { throw Error('Unavailable'); }, decryptString: () => { throw Error('Unavailable'); } }), path.join(root, 'data'), native, () => {});
  const project: Project = { id: 'project', name: 'Test', localRoot, remoteRoot: '/site', profileId: 'connection', filters: { display: [], transfer: [], sync: [] }, environments: [], bookmarks: [] };
  await service.invoke('saveProject', { project }); fixtures.push({ root, store, service });
  return { root, localRoot, service, store, native, project };
}
function remote(service: StudioService, localRoot: string, entries: Record<string, FileEntry>) {
  const profile: ConnectionProfile = { id: 'connection', name: 'Test', host: 'localhost', port: 22, username: 'test', protocol: 'sftp', localRoot, remoteRoot: '/site', parallelTransfers: 2, connectionLimit: 2, timeoutMs: 1000, autoReconnect: false };
  const session: RemoteSession = { stat: vi.fn(async target => entries[target] ?? null), list: vi.fn(async target => Object.values(entries).filter(e => e.path !== target && path.posix.dirname(e.path) === target)), remove: vi.fn(async () => {}), mkdir: vi.fn(async () => {}), rename: vi.fn(async () => {}), chmod: vi.fn(async () => {}), upload: vi.fn(async () => {}), download: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  vi.spyOn(service.remote, 'profile').mockReturnValue(profile); vi.spyOn(service.remote, 'acquire').mockImplementation(async () => ({ session, release: async () => {} })); return session;
}
function entry(target: string, kind: FileEntry['kind']): FileEntry { return { name: path.posix.basename(target), path: target, kind, size: 0, modifiedAt: 1 }; }

describe('desktop backend with isolated SQLite and filesystem', () => {
  it('refuses destructive work when a profile is rebound while native confirmation is open', async () => {
    const f = await fixture(); const session = remote(f.service, f.localRoot, { '/site/a.txt': entry('/site/a.txt', 'file') });
    const profile = f.service.remote.profile('connection');
    vi.mocked(f.native.confirm).mockImplementation(async () => { profile.host = 'another-server.invalid'; return true; });
    await expect(f.service.invoke('mutateRemote', { connectionId: 'connection', operation: 'delete', path: '/site/a.txt' })).rejects.toThrow(/serverbestemming is gewijzigd/);
    expect(session.remove).not.toHaveBeenCalled();
  });
  it('preserves UTF-8 BOM/CRLF and rejects overwriting external modifications', async () => {
    const f = await fixture(), filename = path.join(f.localRoot, 'index.html'), original = '\uFEFF<p>one</p>\r\n'; await fs.writeFile(filename, original);
    const doc = await f.service.invoke('openDocument', { path: filename }); expect(doc.content).toBe(original); expect(doc.eol).toBe('CRLF');
    await f.service.invoke('recoverDocument', { id: doc.id, content: original.replace('one', 'edit') });
    await fs.writeFile(filename, '<p>external version</p>');
    await expect(f.service.invoke('saveDocument', { id: doc.id, content: 'ours' })).rejects.toThrow(/buiten de editor gewijzigd/);
    expect(await fs.readFile(filename, 'utf8')).toBe('<p>external version</p>'); expect((await f.service.invoke('bootstrap', undefined)).recoveries[0].content).toContain('edit');
  });
  it('saves exact document content and clears recovery only after successful saving', async () => {
    const f = await fixture(), filename = path.join(f.localRoot, 'index.html'); await fs.writeFile(filename, '<p>one</p>'); const doc = await f.service.invoke('openDocument', { path: filename });
    const content = '<p>two</p>\r\n'; await f.service.invoke('recoverDocument', { id: doc.id, content }); const saved = await f.service.invoke('saveDocument', { id: doc.id, content });
    expect(saved.content).toBe(content); expect(await fs.readFile(filename, 'utf8')).toBe(content); expect((await f.service.invoke('bootstrap', undefined)).recoveries).toEqual([]);
  });
  it('saves a new local copy and requires confirmation before replacing an existing file', async () => {
    const f = await fixture(), original = path.join(f.localRoot, 'original.html'), target = path.join(f.localRoot, 'copy.html');
    await fs.writeFile(original, '<p>original</p>');
    const doc = await f.service.invoke('openDocument', { path: original });
    await fs.writeFile(target, '<p>existing</p>');
    vi.mocked(f.native.confirm).mockResolvedValueOnce(false);
    await expect(f.service.invoke('saveDocument', { id: doc.id, path: target, content: '<p>copy</p>' })).rejects.toThrow('geannuleerd');
    expect(await fs.readFile(target, 'utf8')).toBe('<p>existing</p>');
    const saved = await f.service.invoke('saveDocument', { id: doc.id, path: target, content: '<p>copy</p>' });
    expect(saved.path).toBe(target); expect(saved.remote).toBeUndefined();
    expect(await fs.readFile(original, 'utf8')).toBe('<p>original</p>');
    expect(await fs.readFile(target, 'utf8')).toBe('<p>copy</p>');
    const backupRoot = path.join(f.localRoot, '.ftp-studio-backups');
    const backups = await fs.readdir(backupRoot);
    expect(backups).toHaveLength(1);
    expect(await fs.readFile(path.join(backupRoot, backups[0], 'copy.html'), 'utf8')).toBe('<p>existing</p>');
  });
  it('refuses Save As when the destination changes during overwrite confirmation', async () => {
    const f = await fixture(), original = path.join(f.localRoot, 'original.html'), target = path.join(f.localRoot, 'copy.html');
    await fs.writeFile(original, 'source'); await fs.writeFile(target, 'target');
    const doc = await f.service.invoke('openDocument', { path: original });
    vi.mocked(f.native.confirm).mockImplementationOnce(async () => { await fs.writeFile(target, 'external writer'); return true; });
    await expect(f.service.invoke('saveDocument', { id: doc.id, path: target, content: 'my copy' })).rejects.toThrow();
    expect(await fs.readFile(target, 'utf8')).toBe('external writer');
    expect(await fs.readFile(original, 'utf8')).toBe('source');
  });
  it('bounds previewasset types and project paths', async () => {
    const f = await fixture(); await fs.writeFile(path.join(f.localRoot, 'main.css'), 'p{color:red}'); await fs.writeFile(path.join(f.localRoot, '.env'), 'PASSWORD'); await fs.writeFile(path.join(f.root, 'outside.css'), 'outside'); await fs.writeFile(path.join(f.localRoot, 'app.js'), 'alert(1)');
    const asset = await f.service.invoke('readAsset', { projectId: f.project.id, path: path.join(f.localRoot, 'main.css') }); expect(Buffer.from(asset.base64, 'base64').toString()).toBe('p{color:red}');
    for (const filename of [path.join(f.localRoot, '.env'), path.join(f.root, 'outside.css'), path.join(f.localRoot, 'app.js')]) await expect(f.service.invoke('readAsset', { projectId: f.project.id, path: filename })).rejects.toThrow();
    await fs.mkdir(path.join(f.localRoot, 'directory.css')); await expect(f.service.invoke('readAsset', { projectId: f.project.id, path: path.join(f.localRoot, 'directory.css') })).rejects.toThrow(/gewoon bestand/);
  });
  it('rejects replacement preview tampering and respects native cancellation', async () => {
    const f = await fixture(), filename = path.join(f.localRoot, 'file.txt'); await fs.writeFile(filename, 'before');
    const changes = await f.service.invoke('previewReplace', { projectId: f.project.id, query: { text: 'before', regex: false, caseSensitive: true }, replacement: 'after' });
    await expect(f.service.invoke('applyReplace', { changes: changes.map(c => ({ ...c, after: 'tampered' })) })).rejects.toThrow(/verlopen of gewijzigd/);
    vi.mocked(f.native.confirm).mockResolvedValue(false); await expect(f.service.invoke('applyReplace', { changes })).rejects.toThrow(/geannuleerd/); expect(await fs.readFile(filename, 'utf8')).toBe('before');
  });
  it('preflights recursive deletion and removes children before their parent', async () => {
    const f = await fixture(); const session = remote(f.service, f.localRoot, { '/site/folder': entry('/site/folder', 'directory'), '/site/folder/inner': entry('/site/folder/inner', 'directory'), '/site/folder/inner/a.txt': entry('/site/folder/inner/a.txt', 'file') });
    await f.service.invoke('mutateRemote', { connectionId: 'connection', operation: 'delete', path: '/site/folder', recursive: true });
    expect(vi.mocked(session.remove).mock.calls).toEqual([['/site/folder/inner/a.txt', false], ['/site/folder/inner', true], ['/site/folder', true]]);
  });
  it('refuses a symlink anywhere in a delete selection before removing any item', async () => {
    const f = await fixture(); const session = remote(f.service, f.localRoot, { '/site/folder': entry('/site/folder', 'directory'), '/site/folder/a.txt': entry('/site/folder/a.txt', 'file'), '/site/folder/z': entry('/site/folder/z', 'symlink') });
    await expect(f.service.invoke('mutateRemote', { connectionId: 'connection', operation: 'delete', path: '/site/folder', recursive: true })).rejects.toThrow(/Onveilige/); expect(session.remove).not.toHaveBeenCalled();
  });
  it('applies project transfer filters to workcache uploads', async () => {
    const f = await fixture(); f.project.filters.transfer.push({ id: 'exclude', action: 'exclude', field: 'path', operator: 'glob', value: '**/*.css' }); await f.service.invoke('saveProject', { project: f.project });
    const session = remote(f.service, f.localRoot, { '/': entry('/', 'directory'), '/site': entry('/site', 'directory'), '/site/main.css': { ...entry('/site/main.css', 'file'), size: 3 } });
    vi.mocked(session.download).mockImplementation(async (_remote, local) => { await fs.writeFile(local, 'p{}'); });
    const document = await f.service.invoke('openDocument', { connectionId: 'connection', path: '/site/main.css' });
    const jobs = await f.service.invoke('enqueue', { requests: [{ projectId: f.project.id, connectionId: 'connection', direction: 'upload', localPath: document.path, remotePath: '/site/main.css', expectedRemote: document.remote!.original }] });
    expect(jobs).toEqual([]); expect(session.upload).not.toHaveBeenCalled();
  });
  it('rejects uploading a cached document after its profile points at a different endpoint', async () => {
    const f = await fixture(); const session = remote(f.service, f.localRoot, { '/site/main.css': { ...entry('/site/main.css', 'file'), size: 3 } });
    vi.mocked(session.download).mockImplementation(async (_remote, local) => { await fs.writeFile(local, 'p{}'); });
    const document = await f.service.invoke('openDocument', { connectionId: 'connection', path: '/site/main.css' });
    expect(document.remote?.endpointKey).toBeTruthy();
    vi.mocked(f.service.remote.profile).mockReturnValue({ ...f.service.remote.profile('connection'), host: 'different.invalid' });
    await expect(f.service.invoke('enqueue', { requests: [{ projectId: f.project.id, connectionId: 'connection', direction: 'upload', localPath: document.path, remotePath: '/site/main.css', expectedRemote: document.remote!.original }] })).rejects.toThrow(/bevestigde serverbestemming/);
    expect(session.upload).not.toHaveBeenCalled();
  });
  it('applies download filters relative to a selected environment root', async () => {
    const f = await fixture(); f.project.environments.push({ id: 'other', name: 'Other', profileId: 'connection', remoteRoot: '/deployment', production: false }); f.project.filters.transfer.push({ id: 'exclude', field: 'path', operator: 'equals', value: 'secret.css', action: 'exclude' }); await f.service.invoke('saveProject', { project: f.project });
    const session = remote(f.service, f.localRoot, { '/': entry('/', 'directory'), '/deployment': entry('/deployment', 'directory'), '/deployment/secret.css': { ...entry('/deployment/secret.css', 'file'), size: 3 } });
    vi.mocked(f.service.remote.profile).mockReturnValue({ ...f.service.remote.profile('connection'), remoteRoot: '/' });
    const jobs = await f.service.invoke('enqueue', { requests: [{ projectId: f.project.id, connectionId: 'connection', direction: 'download', localPath: path.join(f.localRoot, 'secret.css'), remotePath: '/deployment/secret.css' }] });
    expect(jobs).toEqual([]); expect(session.download).not.toHaveBeenCalled();
  });
  it('does not enqueue production requests when native confirmation is cancelled', async () => {
    const f = await fixture(); f.project.environments.push({ id: 'prod', name: 'Production', production: true, profileId: 'connection', remoteRoot: '/site' }); await f.service.invoke('saveProject', { project: f.project });
    vi.mocked(f.native.confirm).mockResolvedValue(false); const enqueue = vi.spyOn(f.service.queue, 'enqueue');
    await expect(f.service.invoke('enqueue', { requests: [{ projectId: f.project.id, connectionId: 'connection', direction: 'upload', localPath: path.join(f.localRoot, 'a'), remotePath: '/site/a' }] })).rejects.toThrow(/geannuleerd/); expect(enqueue).not.toHaveBeenCalled();
  });
});


describe('PHP related-file protection', () => {
  it('keeps literal paths and suppresses sensitive, excluded and escaping include targets', async () => {
    const f = await fixture(), filename = path.join(f.localRoot, 'index.php');
    const content = '<?php require __DIR__ . "/part%23.inc"; include ".env"; include "../outside.php"; include "node_modules/dev.php"; ?> <link rel="stylesheet" href="style%20sheet.css?v=1">';
    await fs.writeFile(filename, content);
    await fs.writeFile(path.join(f.localRoot, 'part%23.inc'), '<?php /* included */');
    await fs.writeFile(path.join(f.localRoot, '.env'), 'TEST_SECRET=fixture');
    await fs.writeFile(path.join(f.root, 'outside.php'), '<?php /* outside */');
    await fs.mkdir(path.join(f.localRoot, 'node_modules'));
    await fs.writeFile(path.join(f.localRoot, 'node_modules', 'dev.php'), '<?php');
    await fs.writeFile(path.join(f.localRoot, 'style sheet.css'), 'p{color:red}');
    const files = await f.service.invoke('relatedFiles', { projectId: f.project.id, path: filename, content });
    expect(files.sort()).toEqual([path.join(f.localRoot, 'part%23.inc'), path.join(f.localRoot, 'style sheet.css')].sort());
    expect(await fs.readFile(filename, 'utf8')).toBe(content);
  });
});

describe('project filter validation and open-file updates', () => {
  const rule = { id: 'rule', action: 'exclude' as const, field: 'path' as const, operator: 'glob' as const, value: '**/*.tmp' };
  it.each([null, { ...rule, value: 42 }, { ...rule, action: 'unknown' }, { ...rule, field: 'unknown' }, { ...rule, operator: 'unknown' }, { ...rule, id: '' }, { ...rule, value: '*'.repeat(257) }])('rejects malformed active and saved filter rules before persistence: %j', async malformed => {
    const f = await fixture();
    const filters = { display: [malformed], transfer: [], sync: [] } as unknown as Project['filters'];
    for (const update of [{ filters }, { filterProfiles: [{ id: 'filter', name: 'Filter', filters }] }]) {
      await expect(f.service.invoke('saveProject', { project: { ...f.project, ...update } })).rejects.toThrow();
      expect((await f.service.invoke('bootstrap', undefined)).projects).toEqual([f.project]);
    }
  });
  it('rejects duplicate names and bounded rule-count violations', async () => {
    const f = await fixture();
    await expect(f.service.invoke('saveProject', { project: { ...f.project, filterProfiles: [{ id: 'one', name: ' Web ', filters: f.project.filters }, { id: 'two', name: 'web', filters: f.project.filters }] } })).rejects.toThrow(/dubbel/);
    await expect(f.service.invoke('saveProject', { project: { ...f.project, filters: { ...f.project.filters, sync: Array.from({ length: 501 }, (_, index) => ({ ...rule, id: String(index) })) } } })).rejects.toThrow(/500/);
  });
  it('updates only openFiles and preserves the latest project settings and independent filter scopes', async () => {
    const f = await fixture(), filters = { display: [rule], transfer: [{ ...rule, id: 'transfer', value: '*.map' }], sync: [{ ...rule, id: 'sync', value: '*.log' }] };
    const changed = { ...f.project, name: 'Updated', filters, filterProfiles: [{ id: 'preset', name: 'Web', filters }] };
    const filename = path.join(f.localRoot, 'open.html');
    const pending = f.service.invoke('setProjectOpenFiles', { projectId: f.project.id, paths: [filename, filename] });
    // This durable update lands while open-file path validation awaits the filesystem.
    f.store.set('projects', [changed]);
    const updated = await pending;
    expect(updated).toEqual({ ...changed, openFiles: [filename] });
    expect((await f.service.invoke('bootstrap', undefined)).projects).toEqual([updated]);
    await expect(f.service.invoke('setProjectOpenFiles', { projectId: f.project.id, paths: [path.join(f.root, 'outside.html')] })).rejects.toThrow(/buiten/);
    expect((await f.service.invoke('bootstrap', undefined)).projects).toEqual([updated]);
  });
});
