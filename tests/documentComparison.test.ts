import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import type { FileEntry, RemoteSession } from '../src/shared/contracts';
import { compareLocalDocument, compareRemoteDocument } from '../src/main/documentComparison';
import { StudioService, type NativeActions } from '../src/main/service';
import { SqliteStore, CredentialVault } from '../src/main/storage';

const roots: string[] = [], services: Array<{ service: StudioService; store: SqliteStore }> = [];
afterEach(async () => { for (const f of services.splice(0)) { await f.service.close(); f.store.close(); } for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-comparison-unit-')); roots.push(root);
  const bytes = Buffer.from('\uFEFF<p>actueel €</p>\r\n'), target = '/site/page.html', temporary = path.join(root, 'comparisons');
  const entry: FileEntry = { name: 'page.html', path: target, kind: 'file', size: bytes.length, modifiedAt: 1767225600000 };
  const session: RemoteSession = {
    stat: vi.fn(async () => ({ ...entry })), list: vi.fn(async () => []),
    download: vi.fn(async (_remote, local, progress, signal) => { if (signal.aborted) throw signal.reason; await fs.writeFile(local, bytes); progress({ transferred: bytes.length, total: bytes.length }); }),
    upload: vi.fn(async () => {}), mkdir: vi.fn(async () => {}), rename: vi.fn(async () => {}), remove: vi.fn(async () => {}), chmod: vi.fn(async () => {}), close: vi.fn(async () => {}),
  };
  const compare = (check = () => {}) => compareRemoteDocument(session, '/site', target, temporary, new AbortController().signal, check);
  return { root, bytes, target, temporary, entry, session, compare };
}

describe('read-only document comparison snapshots', () => {
  it('preserves exact BOM/UTF-8/CRLF bytes and uses remote metadata with actual byte checksum', async () => {
    const f = await fixture(), result = await f.compare();
    expect(result).toMatchObject({ path: f.target, content: f.bytes.toString('utf8'), eol: 'CRLF', source: 'remote', snapshot: { size: f.bytes.length, modifiedAt: f.entry.modifiedAt, checksum: createHash('sha256').update(f.bytes).digest('hex') } });
    expect(result.checkedAt).toBeGreaterThan(0); expect(await fs.readdir(f.temporary)).toEqual([]);
    expect(f.session.upload).not.toHaveBeenCalled(); expect(f.session.mkdir).not.toHaveBeenCalled(); expect(f.session.rename).not.toHaveBeenCalled(); expect(f.session.remove).not.toHaveBeenCalled();
  });
  it.each([
    { kind: 'symlink' as const }, { kind: 'directory' as const }, { size: 8 * 1024 * 1024 + 1 }, { size: NaN }, { size: -1 }, { modifiedAt: null }, { modifiedAt: NaN },
  ])('fails closed on unsafe or uncomparable source metadata %j', async change => {
    const f = await fixture(); Object.assign(f.entry, change);
    await expect(f.compare()).rejects.toThrow(); expect(f.session.download).not.toHaveBeenCalled();
    await expect(fs.stat(f.temporary)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('accepts checksum-backed metadata without a timestamp and verifies it against actual bytes', async () => {
    const f = await fixture(); f.entry.modifiedAt = null; f.entry.checksum = createHash('sha256').update(f.bytes).digest('hex');
    expect((await f.compare()).snapshot.checksum).toBe(f.entry.checksum); expect(await fs.readdir(f.temporary)).toEqual([]);
  });
  it.each(['/outside/page.html', '/site/../page.html', '/site/page\\.html', '/site/page\n.html'])('refuses an escaped captured path %s', async target => {
    const f = await fixture();
    await expect(compareRemoteDocument(f.session, '/site', target, f.temporary, new AbortController().signal, () => {})).rejects.toThrow();
    expect(f.session.stat).not.toHaveBeenCalled(); expect(f.session.download).not.toHaveBeenCalled();
  });
  it('rejects changed metadata and removes the private comparison source', async () => {
    const f = await fixture();
    vi.mocked(f.session.download).mockImplementation(async (_remote, local, progress) => { await fs.writeFile(local, f.bytes); progress({ transferred: f.bytes.length, total: f.bytes.length }); f.entry.modifiedAt! += 1000; });
    await expect(f.compare()).rejects.toThrow(/wijzigde/); expect(await fs.readdir(f.temporary)).toEqual([]);
  });
  it('refuses a protocol source size changed before streaming any bytes', async () => {
    const f = await fixture(); vi.mocked(f.session.download).mockImplementation(async (_remote, _local, progress) => { progress({ transferred: 0, total: f.entry.size + 1 }); });
    await expect(f.compare()).rejects.toThrow(/wijzigde/); expect(await fs.readdir(f.temporary)).toEqual([]);
  });
  it('rejects checksum mismatch, incomplete bytes, binary data and invalid UTF-8 with cleanup', async () => {
    for (const bytes of [Buffer.from('short'), Buffer.from([0]), Buffer.from([255])]) {
      const f = await fixture(); f.entry.size = bytes.length; f.entry.checksum = '0'.repeat(64);
      vi.mocked(f.session.download).mockImplementation(async (_remote, local) => { await fs.writeFile(local, bytes); });
      await expect(f.compare()).rejects.toThrow(); expect(await fs.readdir(f.temporary)).toEqual([]);
    }
    const f = await fixture(); vi.mocked(f.session.download).mockImplementation(async (_remote, local) => { await fs.writeFile(local, f.bytes.subarray(0, 3)); });
    await expect(f.compare()).rejects.toThrow(/wijzigde/); expect(await fs.readdir(f.temporary)).toEqual([]);
  });
  it('removes preparation after transport failure, context change and abort', async () => {
    const f = await fixture(); vi.mocked(f.session.download).mockImplementation(async (_remote, local) => { await fs.writeFile(local, 'partial'); throw new Error('transport failed'); });
    await expect(f.compare()).rejects.toThrow('transport failed'); expect(await fs.readdir(f.temporary)).toEqual([]);
    let changed = false;
    vi.mocked(f.session.download).mockImplementation(async (_remote, local) => { await fs.writeFile(local, f.bytes); changed = true; });
    await expect(f.compare(() => { if (changed) throw new Error('endpoint changed'); })).rejects.toThrow('endpoint changed'); expect(await fs.readdir(f.temporary)).toEqual([]);
    const controller = new AbortController(); controller.abort();
    await expect(compareRemoteDocument(f.session, '/site', f.target, f.temporary, controller.signal, () => {})).rejects.toThrow(); expect(await fs.readdir(f.temporary)).toEqual([]);
  });
  it('refuses a symlink temporary root without touching its contents', async () => {
    const f = await fixture(), outside = path.join(f.root, 'outside'); await fs.mkdir(outside); await fs.symlink(outside, f.temporary, 'dir');
    await expect(f.compare()).rejects.toThrow(/Symbolische/); expect(await fs.readdir(outside)).toEqual([]);
  });
  it('reads a changed local file without adopting its baseline or changing recovery text', async () => {
    const f = await fixture(), filename = path.join(f.root, 'page.html'); await fs.writeFile(filename, '<p>original</p>');
    const store = new SqliteStore(path.join(f.root, 'data', 'state.db'));
    const native: NativeActions = { chooseFile: async () => null, chooseSaveFile: async () => null, chooseFolder: async () => null, confirm: async () => false, openBrowser: async () => {} };
    const service = new StudioService(store, new CredentialVault(store, { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('Not used'); }, decryptString: () => { throw new Error('Not used'); } }), path.join(f.root, 'data'), native, () => {}); services.push({ store, service });
    const doc = await service.invoke('openDocument', { path: filename }); await service.invoke('recoverDocument', { id: doc.id, content: '<p>dirty buffer</p>' });
    const recovery = store.get('recoveries', []); await fs.writeFile(filename, f.bytes);
    const result = await service.invoke('compareDocument', { id: doc.id }); expect(result).toMatchObject({ source: 'local', content: f.bytes.toString('utf8'), eol: 'CRLF' });
    expect(store.get('recoveries', [])).toEqual(recovery); expect(await fs.readFile(filename)).toEqual(f.bytes);
    await expect(service.invoke('saveDocument', { id: doc.id, content: 'dirty buffer' })).rejects.toThrow(/buiten de editor gewijzigd/);
    await expect(service.invoke('compareDocument', { id: 'unregistered' })).rejects.toThrow(/niet geopend/);
  });
  it('refuses oversized and symlink local sources', async () => {
    const f = await fixture(), filename = path.join(f.root, 'large.txt'), link = path.join(f.root, 'link.txt');
    await fs.writeFile(filename, Buffer.alloc(8 * 1024 * 1024 + 1, 65));
    await expect(compareLocalDocument(filename, new AbortController().signal, () => {})).rejects.toThrow(/8 MB/);
    await fs.symlink(filename, link); await expect(compareLocalDocument(link, new AbortController().signal, () => {})).rejects.toThrow(/Symbolische/);
  });
});
