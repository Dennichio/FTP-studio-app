import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StudioService, type NativeActions } from '../src/main/service';
import { CredentialVault, SqliteStore } from '../src/main/storage';
import type { ConnectionProfile, DocumentData, RemoteSession } from '../src/shared/contracts';
import { endpointIdentity } from '../src/core/connectionIdentity';

const fixtures: Array<{ root: string; service: StudioService; store: SqliteStore }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) { await f.service.close(); f.store.close(); await fs.rm(f.root, { recursive: true, force: true }); }
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-save-recovery-'));
  const store = new SqliteStore(path.join(root, 'data', 'state.db'));
  const native: NativeActions = { chooseFile: async () => null, chooseFolder: async () => null, chooseSaveFile: async () => null, confirm: async () => true, openBrowser: async () => {} };
  const vault = new CredentialVault(store, { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('Unused'); }, decryptString: () => { throw new Error('Unused'); } });
  const service = new StudioService(store, vault, path.join(root, 'data'), native, () => {});
  fixtures.push({ root, service, store });
  const filename = path.join(root, 'original.html'), original = '\uFEFF<p>original</p>\r\n';
  await fs.writeFile(filename, original);
  const doc = await service.invoke('openDocument', { path: filename });
  return { root, store, service, filename, original, doc };
}
// Execute the real atomic installation, then hold its return while recovery IPC
// runs. The save algorithm, disk bytes, snapshots and SQLite remain real.
function holdInstallation(target: string) {
  const originalLink = fs.link.bind(fs);
  let release!: () => void, installed!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { installed = resolve; });
  const spy = vi.spyOn(fs, 'link').mockImplementation(async (source, destination) => {
    await originalLink(source, destination);
    if (destination === target) { installed(); await gate; }
  });
  return { reached, release, restore: () => spy.mockRestore() };
}

describe('document save and newer recovery ordering', () => {
  it.each([false, true])('rebases newer recovery after real file installation (Save As: %s)', async saveAs => {
    const f = await fixture(), target = saveAs ? path.join(f.root, 'copy.html') : f.filename;
    const requested = '\uFEFF<p>saved</p>\r\n', newer = '\uFEFF<p>typed while saving €</p>\r\n';
    await f.service.invoke('recoverDocument', { id: f.doc.id, content: requested });
    const hold = holdInstallation(target);
    const saving = f.service.invoke('saveDocument', { id: f.doc.id, content: requested, ...(saveAs ? { path: target } : {}) });
    try {
      await hold.reached;
      expect(await fs.readFile(target)).toEqual(Buffer.from(requested));
      await f.service.invoke('recoverDocument', { id: f.doc.id, content: newer });
      hold.release();
      const saved = await saving;
      const recovery = f.store.get<DocumentData[]>('recoveries', [])[0];
      expect(recovery).toEqual({ ...saved, content: newer, recovery: true });
      expect(recovery.path).toBe(target); expect(recovery.original).toEqual(saved.original);
      expect(recovery.remote).toBeUndefined();
      expect(await fs.readFile(target)).toEqual(Buffer.from(requested));
      if (saveAs) expect(await fs.readFile(f.filename)).toEqual(Buffer.from(f.original));
      // The next save uses the newly installed baseline and clears only this
      // matching recovery, proving the rebased snapshot is usable.
      const final = await f.service.invoke('saveDocument', { id: f.doc.id, content: newer });
      expect(final.path).toBe(target); expect(await fs.readFile(target)).toEqual(Buffer.from(newer));
      expect(f.store.get('recoveries', [])).toEqual([]);
    } finally { hold.release(); await saving.catch(() => {}); hold.restore(); }
  });
  it('clears recovery matching the saved text while retaining unrelated document recovery', async () => {
    const f = await fixture(), secondPath = path.join(f.root, 'second.html'); await fs.writeFile(secondPath, 'second');
    const second = await f.service.invoke('openDocument', { path: secondPath });
    await f.service.invoke('recoverDocument', { id: second.id, content: 'unrelated unsaved' });
    await f.service.invoke('recoverDocument', { id: f.doc.id, content: 'saved text' });
    await f.service.invoke('saveDocument', { id: f.doc.id, content: 'saved text' });
    expect(f.store.get<DocumentData[]>('recoveries', []).map(doc => [doc.id, doc.content])).toEqual([[second.id, 'unrelated unsaved']]);
  });
  it.each([false, true])('rebases remote-document recovery with the correct binding (Save As: %s)', async saveAs => {
    const f = await fixture();
    const profile: ConnectionProfile = { id: 'server', name: 'Fixture', host: 'fixture.invalid', port: 21, protocol: 'ftp', username: 'fixture', localRoot: f.root, remoteRoot: '/site', timeoutMs: 1000, connectionLimit: 2, parallelTransfers: 1, autoReconnect: false };
    const remotePath = '/site/page.html', remoteSnapshot = { size: Buffer.byteLength(f.original), modifiedAt: 1234 };
    const session: RemoteSession = {
      stat: async () => ({ name: 'page.html', path: remotePath, kind: 'file', ...remoteSnapshot }),
      list: async () => [], download: async (_remote, local) => { await fs.writeFile(local, f.original); },
      upload: async () => { throw new Error('Saving must not upload'); }, mkdir: async () => {}, rename: async () => {}, remove: async () => {}, chmod: async () => {}, close: async () => {},
    };
    vi.spyOn(f.service.remote, 'profile').mockReturnValue(profile);
    vi.spyOn(f.service.remote, 'acquire').mockResolvedValue({ session, release: async () => {} });
    const doc = await f.service.invoke('openDocument', { path: remotePath, connectionId: profile.id, expectedEndpoint: endpointIdentity(profile) });
    const target = saveAs ? path.join(f.root, 'detached.html') : doc.path;
    const hold = holdInstallation(target), requested = '\uFEFF<p>saved remote buffer</p>\r\n', newer = requested + '<!-- newer -->\r\n';
    const saving = f.service.invoke('saveDocument', { id: doc.id, content: requested, ...(saveAs ? { path: target } : {}) });
    try {
      await hold.reached;
      await f.service.invoke('recoverDocument', { id: doc.id, content: newer });
      hold.release(); const saved = await saving;
      const recovery = f.store.get<DocumentData[]>('recoveries', [])[0];
      expect(recovery).toEqual({ ...saved, content: newer, recovery: true });
      expect(recovery.path).toBe(target);
      expect(recovery.remote).toEqual(saveAs ? undefined : doc.remote);
      if (!saveAs) expect(recovery.remote?.original).toEqual(remoteSnapshot);
      expect(await fs.readFile(target)).toEqual(Buffer.from(requested));
      if (saveAs) expect(await fs.readFile(doc.path)).toEqual(Buffer.from(f.original));
    } finally { hold.release(); await saving.catch(() => {}); hold.restore(); }
  });
  it('preserves durable newer recovery and fails closed if rebasing cannot be committed', async () => {
    const f = await fixture(), requested = 'saved', newer = 'newer unsaved';
    const hold = holdInstallation(f.filename);
    const saving = f.service.invoke('saveDocument', { id: f.doc.id, content: requested });
    try {
      await hold.reached;
      await f.service.invoke('recoverDocument', { id: f.doc.id, content: newer });
      const durable = f.store.get('recoveries', []), set = f.store.set.bind(f.store);
      vi.spyOn(f.store, 'set').mockImplementation((key, value) => { if (key === 'recoveries') throw new Error('injected durable write failure'); set(key, value); });
      const rejected = expect(saving).rejects.toThrow(/op schijf opgeslagen.*herstelgegevens/);
      hold.release(); await rejected;
      expect(await fs.readFile(f.filename, 'utf8')).toBe(requested);
      expect(f.store.get('recoveries', [])).toEqual(durable);
      await expect(f.service.invoke('saveDocument', { id: f.doc.id, content: newer })).rejects.toThrow(/buiten de editor gewijzigd/);
      expect(f.store.get('recoveries', [])).toEqual(durable);
    } finally { hold.release(); await saving.catch(() => {}); hold.restore(); }
  });
});
