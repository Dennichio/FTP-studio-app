import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SqliteStore, CredentialVault, type SecretEncryption } from '../src/main/storage';
import { PreviewServer } from '../src/main/preview';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
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
