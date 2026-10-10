import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import type { ConnectionProfile, DocumentData } from '../src/shared/contracts';
import { StudioService, type NativeActions } from '../src/main/service';
import { SqliteStore, CredentialVault } from '../src/main/storage';
import { ftpFixture } from './fixtures/ftp-server';

const fixtures: Array<{ root: string; service: StudioService; store: SqliteStore; server: Awaited<ReturnType<typeof ftpFixture>> }> = [];
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.service.close(); f.store.close(); await f.server.close(); await fs.rm(f.root, { recursive: true, force: true }); } });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-comparison-live-')), localRoot = path.join(root, 'project'); await fs.mkdir(localRoot);
  const options = { supportsMlst: true, controlNoDelay: true, stallDownload: false }, server = await ftpFixture(options); server.directories.add('/site'); server.files.set('/site/page.html', Buffer.from('<p>original server</p>'));
  const store = new SqliteStore(path.join(root, 'data', 'state.db'));
  const native: NativeActions = { chooseFile: async () => null, chooseSaveFile: async () => null, chooseFolder: async () => null, confirm: async () => false, openBrowser: async () => {} };
  const service = new StudioService(store, new CredentialVault(store, { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('Not used'); }, decryptString: () => { throw new Error('Not used'); } }), path.join(root, 'data'), native, () => {});
  fixtures.push({ root, service, store, server });
  const profile: ConnectionProfile = { id: 'comparison', name: 'Vergelijken', protocol: 'ftp', host: '127.0.0.1', port: server.port, username: 'test', localRoot, remoteRoot: '/site', timeoutMs: 1000, connectionLimit: 6, parallelTransfers: 4, autoReconnect: false, passive: true };
  const state = await service.invoke('connect', { profile, credentials: { password: 'test' } });
  const document = await service.invoke('openDocument', { connectionId: profile.id, expectedEndpoint: state.endpointKey, path: '/site/page.html' });
  return { root, service, store, server, options, profile, document };
}
async function expectPreserved(f: Awaited<ReturnType<typeof fixture>>, document: DocumentData, cache: Buffer, recovery: unknown) {
  expect(await fs.readFile(document.path)).toEqual(cache); expect(f.store.get('recoveries', [])).toEqual(recovery);
  expect(f.service.queue.jobs()).toEqual([]);
  await fs.readdir(path.join(f.root, 'data', 'comparisons')).then(entries => expect(entries).toEqual([]), error => expect(error).toMatchObject({ code: 'ENOENT' }));
}

describe('actual FTP document comparison', () => {
  it('reads changed server text while preserving registered cache, buffer baseline and recovery', async () => {
    const f = await fixture(), changed = Buffer.from('\uFEFF<p>server € gewijzigd</p>\r\n');
    const saved = await f.service.invoke('saveDocument', { id: f.document.id, content: '<p>saved locally, not uploaded</p>' });
    await f.service.invoke('recoverDocument', { id: saved.id, content: '<p>dirty editor buffer</p>' });
    const cache = await fs.readFile(saved.path), recovery = f.store.get('recoveries', []); f.server.files.set('/site/page.html', changed);
    const result = await f.service.invoke('compareDocument', { id: saved.id });
    expect(result).toMatchObject({ path: '/site/page.html', source: 'remote', content: changed.toString('utf8'), eol: 'CRLF', snapshot: { size: changed.length, modifiedAt: 1767225600000, checksum: createHash('sha256').update(changed).digest('hex') } });
    await expectPreserved(f, saved, cache, recovery);
    // Re-registering the same recovery exposes any accidental mutation of the document baseline.
    await f.service.invoke('recoverDocument', { id: saved.id, content: '<p>dirty editor buffer</p>' }); expect(f.store.get('recoveries', [])).toEqual(recovery);
    expect(f.server.files.get('/site/page.html')).toEqual(changed);
  });
  it('rejects a rebound endpoint before reading another server identity', async () => {
    const f = await fixture(), cache = await fs.readFile(f.document.path);
    await f.service.invoke('connect', { profile: { ...f.profile, username: 'another-user' }, credentials: { password: 'test' } });
    const reads = f.server.commandCounts.get('RETR');
    await expect(f.service.invoke('compareDocument', { id: f.document.id })).rejects.toThrow(/serverbestemming is gewijzigd/);
    expect(f.server.commandCounts.get('RETR')).toBe(reads); await expectPreserved(f, f.document, cache, []);
  });
  it('rejects oversized/unknown/symlink metadata before download and invalid UTF-8 after download with cleanup', async () => {
    const f = await fixture(), cache = await fs.readFile(f.document.path), reads = f.server.commandCounts.get('RETR');
    f.server.advertisedSizes.set('/site/page.html', 8 * 1024 * 1024 + 1);
    await expect(f.service.invoke('compareDocument', { id: f.document.id })).rejects.toThrow(/8 MB/);
    f.server.advertisedSizes.delete('/site/page.html');
    f.server.mlstResponses.set('/site/page.html', '250-Listing\r\n type=file;size=22; /site/page.html\r\n250 End');
    await expect(f.service.invoke('compareDocument', { id: f.document.id })).rejects.toThrow(/tijdstempel|modify|metadata/i);
    f.server.mlstResponses.set('/site/page.html', '250-Listing\r\n type=OS.unix=slink;size=22;modify=20260101000000; /site/page.html\r\n250 End');
    await expect(f.service.invoke('compareDocument', { id: f.document.id })).rejects.toThrow(/symbolische|unsupported|bestands/i);
    expect(f.server.commandCounts.get('RETR')).toBe(reads); f.server.mlstResponses.clear(); f.server.files.set('/site/page.html', Buffer.from([255]));
    await expect(f.service.invoke('compareDocument', { id: f.document.id })).rejects.toThrow(/UTF-8/); await expectPreserved(f, f.document, cache, []);
  });
  it('detects an actual source changed after downloading and cleans the temporary bytes', async () => {
    const f = await fixture(), cache = await fs.readFile(f.document.path), acquire = f.service.remote.acquire.bind(f.service.remote);
    vi.spyOn(f.service.remote, 'acquire').mockImplementation(async (...args) => {
      const lease = await acquire(...args), download = lease.session.download.bind(lease.session);
      // Fault injection uses the real transport first, then changes the test server storage.
      return { ...lease, session: { ...lease.session, stat: lease.session.stat.bind(lease.session), list: lease.session.list.bind(lease.session), mkdir: lease.session.mkdir.bind(lease.session), rename: lease.session.rename.bind(lease.session), remove: lease.session.remove.bind(lease.session), chmod: lease.session.chmod.bind(lease.session), upload: lease.session.upload.bind(lease.session), close: lease.session.close.bind(lease.session), download: async (...downloadArgs) => { await download(...downloadArgs); f.server.files.set('/site/page.html', Buffer.from('external change after completed download')); } } };
    });
    await expect(f.service.invoke('compareDocument', { id: f.document.id })).rejects.toThrow(/wijzigde/);
    await expectPreserved(f, f.document, cache, []); expect(f.server.files.get('/site/page.html')?.toString()).toBe('external change after completed download');
  });
  it('times out a stalled actual transfer and removes its scratch source', async () => {
    const f = await fixture(), cache = await fs.readFile(f.document.path); f.options.stallDownload = true;
    await expect(f.service.invoke('compareDocument', { id: f.document.id })).rejects.toThrow(/lang|timeout|onderbroken/i);
    await vi.waitFor(async () => expect(await fs.readdir(path.join(f.root, 'data', 'comparisons'))).toEqual([]));
    await expectPreserved(f, f.document, cache, []);
  });
  it('limits concurrent comparisons and aborts active reads at shutdown with cache preserved', async () => {
    const f = await fixture(), cache = await fs.readFile(f.document.path); f.options.stallDownload = true; f.server.downloadStarted = false;
    const pending = Array.from({ length: 4 }, () => f.service.invoke('compareDocument', { id: f.document.id }));
    const assertions = pending.map(promise => expect(promise).rejects.toThrow());
    await expect(f.service.invoke('compareDocument', { id: f.document.id })).rejects.toThrow(/vier documenten/);
    await vi.waitFor(() => expect(f.server.downloadStarted).toBe(true)); await f.service.close(); await Promise.all(assertions);
    await expectPreserved(f, f.document, cache, []);
  });
});
