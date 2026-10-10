import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SqliteStore, CredentialVault, type SecretEncryption } from '../src/main/storage';
import { PreviewServer } from '../src/main/preview';
import { StudioService, type NativeActions } from '../src/main/service';
import * as remoteModule from '../src/main/remote';
import type { ConnectionProfile, RemoteSession } from '../src/shared/contracts';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { try { for (const dispose of cleanup.splice(0).reverse()) await dispose(); } finally { vi.restoreAllMocks(); } });
async function directory() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-security-')); cleanup.push(() => fs.rm(root, { recursive: true, force: true })); return root; }
function encryption(): SecretEncryption {
  // Injected encryption exercises vault persistence, not an Electron/DPAPI platform claim.
  const key = randomBytes(32);
  return { isEncryptionAvailable: () => true, encryptString(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]); }, decryptString(value) { const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString(); } };
}

describe('durable settings and protected credential persistence', () => {
  it('round-trips SQLite state across reopening, including deletion', async () => {
    const root = await directory(), filename = path.join(root, 'state.db');
    let store = new SqliteStore(filename); store.set('queue', [{ state: 'paused', path: 'a' }]); store.set('remove', 'old'); store.delete('remove'); store.close();
    store = new SqliteStore(filename); try { expect(store.get('queue', [])).toEqual([{ state: 'paused', path: 'a' }]); expect(store.get('remove', null)).toBeNull(); } finally { store.close(); }
  });
  it('stores ciphertext, preserves an existing password when updating a passphrase, and deletes credentials', async () => {
    const root = await directory(), filename = path.join(root, 'state.db'), store = new SqliteStore(filename), backend = encryption();
    const vault = new CredentialVault(store, backend); vault.save('profile', { password: 'unique-password-very-secret' }); vault.save('profile', { passphrase: 'another-secret-phrase' });
    expect(vault.read('profile')).toEqual({ password: 'unique-password-very-secret', passphrase: 'another-secret-phrase' });
    expect(store.get('credential:profile', '')).not.toContain('unique-password'); store.close();
    expect((await fs.readFile(filename)).includes(Buffer.from('unique-password-very-secret'))).toBe(false);
    const reopened = new SqliteStore(filename); try { const reopenedVault = new CredentialVault(reopened, backend); expect(reopenedVault.read('profile').password).toBe('unique-password-very-secret'); reopenedVault.delete('profile'); expect(reopenedVault.read('profile')).toEqual({}); } finally { reopened.close(); }
  });
  it.each([false, true])('refuses unavailable encryption or the basic_text fallback (%s)', async basicText => {
    const root = await directory(), store = new SqliteStore(path.join(root, 'state.db'));
    try { const backend = encryption(); backend.isEncryptionAvailable = () => basicText; backend.getSelectedStorageBackend = () => 'basic_text'; const vault = new CredentialVault(store, backend); expect(() => vault.save('p', { password: 'secret' })).toThrow(/Veilige systeemopslag/); expect(store.get('credential:p', null)).toBeNull(); } finally { store.close(); }
  });
});

describe('service credential boundaries', () => {
  async function fixture() {
    const root = await directory(), store = new SqliteStore(path.join(root, 'state.db'));
    cleanup.push(() => store.close());
    const vault = new CredentialVault(store, encryption());
    const native: NativeActions = { chooseFile: async () => null, chooseSaveFile: async () => null, chooseFolder: async () => null, confirm: async () => true, openBrowser: async () => {} };
    const service = new StudioService(store, vault, root, native, () => {}); cleanup.push(() => service.close());
    const profile: ConnectionProfile = { id: 'saved', name: 'Saved', protocol: 'sftp', host: 'trusted.invalid', port: 22, username: 'tester', hostKeySha256: `SHA256:${'A'.repeat(43)}`, privateKeyPath: '/trusted/key', localRoot: root, remoteRoot: '/', timeoutMs: 1000, parallelTransfers: 1, connectionLimit: 2, autoReconnect: false, passive: true };
    await service.invoke('saveProfile', { profile, credentials: { password: 'old-password', passphrase: 'old-passphrase' } });
    const connect = vi.spyOn(service.remote, 'connect').mockImplementation(async value => ({ id: value.id, profile: value, connected: true }));
    return { service, profile, store, vault, connect };
  }
  it.each([
    { protocol: 'ftp' }, { host: 'other.invalid' }, { port: 2222 }, { username: 'other' },
    { hostKeySha256: `SHA256:${'B'.repeat(43)}` }, { privateKeyPath: '/other/key' },
  ])('rejects stored credentials after authentication changes: %j', async change => {
    const f = await fixture(), edited = { ...f.profile, ...change } as ConnectionProfile;
    const ciphertext = f.store.get('credential:saved', '');
    for (const command of ['connect', 'testConnection', 'saveProfile'] as const) await expect(f.service.invoke(command, { profile: edited, credentials: {} })).rejects.toThrow(/aanmeldbestemming is gewijzigd/);
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.store.get('credential:saved', '')).toBe(ciphertext);
    expect((await f.service.invoke('bootstrap', undefined)).profiles).toEqual([f.profile]);
  });
  it('allows workspace-only changes and honors an explicit empty password without vault fallback', async () => {
    const f = await fixture(), edited = { ...f.profile, name: 'Renamed', group: 'Group', localRoot: f.profile.localRoot + '/other', remoteRoot: '/other' };
    await f.service.invoke('connect', { profile: edited, credentials: {} });
    expect(f.connect).toHaveBeenLastCalledWith(edited, { password: 'old-password', passphrase: 'old-passphrase' });
    const changed = { ...edited, host: 'other.invalid' };
    await f.service.invoke('connect', { profile: changed, credentials: { password: '' } });
    expect(f.connect).toHaveBeenLastCalledWith(changed, { password: '' });
    await f.service.invoke('connect', { profile: { ...edited, id: 'one-time' } });
    expect(f.connect.mock.calls.at(-1)?.[1]).toEqual({});
  });
  it('replaces all old secrets when a changed authentication destination is explicitly saved', async () => {
    const f = await fixture(), changed = { ...f.profile, host: 'other.invalid' };
    await f.service.invoke('saveProfile', { profile: changed, credentials: { password: 'replacement' } });
    expect(f.vault.read(changed.id)).toEqual({ password: 'replacement' });
    await f.service.invoke('connect', { profile: changed });
    expect(f.connect).toHaveBeenLastCalledWith(changed, { password: 'replacement' });
  });
  it('binds ciphertext to its destination even when the subsequent profile write fails', async () => {
    const f = await fixture(), changed = { ...f.profile, host: 'other.invalid' };
    const set = f.store.set.bind(f.store);
    vi.spyOn(f.store, 'set').mockImplementation((key, value) => { if (key === 'profiles') throw new Error('Injected profile write failure'); set(key, value); });
    await expect(f.service.invoke('saveProfile', { profile: changed, credentials: { password: 'replacement' } })).rejects.toThrow('Injected profile write failure');
    expect(f.vault.read(changed.id)).toEqual({ password: 'replacement' });
    expect((await f.service.invoke('bootstrap', undefined)).profiles).toEqual([f.profile]);
    for (const command of ['connect', 'testConnection'] as const) await expect(f.service.invoke(command, { profile: f.profile })).rejects.toThrow(/niet aan deze bestemming gekoppeld/);
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('requires re-entry for legacy unbound secrets and binds only explicitly supplied replacements', async () => {
    const f = await fixture();
    f.vault.save(f.profile.id, { password: 'legacy-password', passphrase: 'legacy-phrase' });
    await expect(f.service.invoke('connect', { profile: f.profile })).rejects.toThrow(/Vul ze opnieuw in/);
    await f.service.invoke('saveProfile', { profile: f.profile, credentials: { password: 'entered-again' } });
    await f.service.invoke('connect', { profile: f.profile });
    expect(f.connect).toHaveBeenLastCalledWith(f.profile, { password: 'entered-again' });
  });
  it.each(['open', 'list', 'close'])('redacts test errors from %s and always releases the test lock', async phase => {
    const f = await fixture(), cause = new Error('Server echoed old-password and old-passphrase');
    const session = { list: vi.fn(async () => []), close: vi.fn(async () => {}) } as unknown as RemoteSession;
    const factory = vi.spyOn(remoteModule, 'createProtocolSession');
    if (phase === 'open') factory.mockRejectedValue(cause);
    else {
      factory.mockImplementation(async () => ({ ...session }));
      if (phase === 'list') vi.mocked(session.list).mockRejectedValue(cause);
      else vi.mocked(session.close).mockRejectedValue(cause);
    }
    for (let attempt = 0; attempt < 2; attempt++) await expect(f.service.invoke('testConnection', { profile: f.profile })).rejects.toThrow('Server echoed [afgeschermd] and [afgeschermd]');
    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenLastCalledWith(f.profile, { password: 'old-password', passphrase: 'old-passphrase' });
    if (phase !== 'open') expect(session.close).toHaveBeenCalledTimes(2);
  });
  it('closes a late test handshake after shutdown without listing or logging success', async () => {
    const f = await fixture();
    let resolve!: (session: RemoteSession) => void;
    vi.spyOn(remoteModule, 'createProtocolSession').mockImplementation(() => new Promise(done => { resolve = done; }));
    const pending = f.service.invoke('testConnection', { profile: f.profile });
    const rejection = expect(pending).rejects.toThrow(/werkruimte is gesloten/);
    await f.service.close();
    const session = { list: vi.fn(async () => []), close: vi.fn(async () => {}) } as unknown as RemoteSession;
    resolve(session); await rejection;
    expect(session.close).toHaveBeenCalledOnce(); expect(session.list).not.toHaveBeenCalled();
    await expect(f.service.invoke('testConnection', { profile: f.profile })).rejects.toThrow(/werkruimte is gesloten/);
  });
  it('bounds a hanging test close so the test lock and shutdown can finish', async () => {
    const f = await fixture();
    const session = { list: vi.fn(async () => []), close: vi.fn(() => new Promise<void>(() => {})) } as unknown as RemoteSession;
    vi.spyOn(remoteModule, 'createProtocolSession').mockResolvedValue(session);
    vi.useFakeTimers();
    try {
      const rejection = expect(f.service.invoke('testConnection', { profile: f.profile })).rejects.toThrow(/niet tijdig worden gesloten/);
      await vi.advanceTimersByTimeAsync(2000); await rejection;
      await f.service.close(); expect(session.close).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});

describe('real loopback browser preview', () => {
  it('requires its access token, blocks foreign origins, traversal and PHP source, and serves only project assets', async () => {
    const root = await directory(); await fs.writeFile(path.join(root, 'index.html'), '<p>safe preview</p>'); await fs.writeFile(path.join(root, 'asset.css'), 'p{color:red}'); await fs.writeFile(path.join(root, 'secret.php'), '<?php secret();'); await fs.writeFile(path.join(root, '.env'), 'SECRET');
    const server = new PreviewServer(); cleanup.push(() => server.close());
    const tokenUrl = await server.url(root, path.join(root, 'index.html')), origin = new URL(tokenUrl).origin;
    expect((await fetch(origin + '/index.html')).status).toBe(403);
    const entry = await fetch(tokenUrl, { redirect: 'manual' }), cookie = entry.headers.get('set-cookie')!.split(';')[0];
    expect(entry.status).toBe(302); expect(entry.headers.get('set-cookie')).toContain('HttpOnly');
    const page = await fetch(origin + entry.headers.get('location'), { headers: { cookie } }); expect(await page.text()).toContain('safe preview'); expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await fetch(origin + '/asset.css', { headers: { cookie } })).status).toBe(200);
    for (const resource of ['/secret.php', '/.env', '/%2e%2e%2foutside.css']) expect((await fetch(origin + resource, { headers: { cookie } })).status).toBeGreaterThanOrEqual(400);
    expect((await fetch(origin + '/asset.css', { headers: { cookie, origin: 'https://hostile.invalid' } })).status).toBe(403);
    expect((await fetch(origin + '/asset.css', { method: 'POST', headers: { cookie } })).status).toBe(403);
    await expect(server.url(root, path.join(root, 'secret.php'))).rejects.toThrow(/PHP/);
  });
  it('coalesces concurrent starts and gives separate projects non-colliding cookie names', async () => {
    const root = await directory(), other = await directory(); for (const dir of [root, other]) await fs.writeFile(path.join(dir, 'index.html'), '<p>preview</p>');
    const server = new PreviewServer(); cleanup.push(() => server.close());
    const [one, same, two] = await Promise.all([server.url(root, path.join(root, 'index.html')), server.url(root, path.join(root, 'index.html')), server.url(other, path.join(other, 'index.html'))]);
    expect(one).toBe(same);
    const [first, second] = await Promise.all([fetch(one, { redirect: 'manual' }), fetch(two, { redirect: 'manual' })]);
    const cookies = [first, second].map(r => r.headers.get('set-cookie')!.split(';')[0]); expect(cookies[0].split('=')[0]).not.toBe(cookies[1].split('=')[0]);
    for (const url of [one, two]) expect((await fetch(new URL(url).origin + '/index.html', { headers: { cookie: cookies.join('; ') } })).status).toBe(200);
    await server.close(); await expect(server.url(root, path.join(root, 'index.html'))).rejects.toThrow(/gesloten/);
  });
});
