import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore, CredentialVault } from '../src/main/storage';
import { TransferQueue } from '../src/main/queue';
import { mapLocalToRemote, mapRemoteToLocal, matchesFilters, compareEntries, boundedRegex } from '../src/core/browserWorkspace';
import { readTextFile, safeSaveTextFile, assertSafeLocalPath, previewReplace, applyReplace } from '../src/core/workspace';

test('Windows, UNC and POSIX navigation stays within paired roots', () => {
  assert.equal(mapLocalToRemote('C:\\Websites\\Site\\images\\icons', 'C:\\Websites\\Site', '/public_html'), '/public_html/images/icons');
  assert.equal(mapRemoteToLocal('/public_html/images/icons', '/public_html', 'C:\\Websites\\Site'), 'C:\\Websites\\Site\\images\\icons');
  assert.throws(() => mapLocalToRemote('C:\\Websites\\Other', 'C:\\Websites\\Site', '/public_html'));
  assert.throws(() => mapRemoteToLocal('/public_html/../private', '/public_html', '/tmp/site'));
  assert.equal(mapLocalToRemote('\\\\server\\share\\site\\css', '\\\\server\\share\\site', '/site'), '/site/css');
});
test('uncertain metadata stays uncertain and filter excludes prevail', () => {
  assert.equal(compareEntries({ size: 10, modifiedAt: null }, { size: 10, modifiedAt: null }), 'uncertain');
  assert.equal(matchesFilters({ name: '.env', path: '/.env', kind: 'file', size: 10, modifiedAt: 1 }, [{ id: 'a', field: 'name', operator: 'glob', value: '*', action: 'include' }, { id: 'b', field: 'name', operator: 'equals', value: '.env', action: 'exclude' }]), false);
  assert.throws(() => boundedRegex('(a+)+$'));
});
test('SQLite survives reopening and refuses unsafe credential encryption', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-offline-store-'));
  try {
    let store = new SqliteStore(path.join(root, 'studio.db')); store.set('test', { nested: [1, 2] }); store.close();
    store = new SqliteStore(path.join(root, 'studio.db')); assert.deepEqual(store.get('test', null), { nested: [1, 2] });
    const vault = new CredentialVault(store, { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text', encryptString: value => Buffer.from(value), decryptString: value => value.toString() });
    assert.throws(() => vault.save('profile', { password: 'test-secret' }), /Veilige systeemopslag/);
    assert.equal(store.get('credential:profile', null), null); store.close();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('UTF8 BOM, CRLF, optimistic edits and replacement previews preserve work', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-offline-edit-'));
  try {
    const filename = path.join(root, 'index.html'); await fs.writeFile(filename, '\ufeff<p>oud</p>\r\n');
    const first = await readTextFile(filename); assert.equal(first.eol, 'CRLF'); assert.ok(first.content.startsWith('\ufeff'));
    await safeSaveTextFile(filename, first.content.replace('oud', 'nieuw'), first.snapshot);
    await assert.rejects(safeSaveTextFile(filename, 'stale', first.snapshot), /gewijzigd/);
    const preview = await previewReplace(root, { text: 'nieuw', regex: false, caseSensitive: true }, 'klaar'); assert.equal(preview.length, 1);
    await fs.writeFile(filename, 'external writer');
    await assert.rejects(applyReplace(preview), /gewijzigd/); assert.equal(await fs.readFile(filename, 'utf8'), 'external writer');
    await fs.symlink(filename, path.join(root, 'linked.html')); await assert.rejects(assertSafeLocalPath(path.join(root, 'linked.html')), /koppeling/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('persisted running transfers restore paused without acquiring a remote session', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-offline-queue-'));
  const store = new SqliteStore(path.join(root, 'studio.db'));
  try {
    store.set('transferQueue.v1', [{ kind: 'file', job: { id: 'interrupted', status: 'running', direction: 'upload', connectionId: 'offline', localPath: '/file', remotePath: '/file', size: 100, transferred: 50, speed: 10, remainingSeconds: 5, attempts: 1, createdAt: 1 } }]);
    let acquisitions = 0;
    const queue = new TransferQueue({ profile: () => { throw new Error('must not connect'); }, acquire: async () => { acquisitions++; throw new Error('must not connect'); } }, store, () => {}, () => {});
    assert.equal(queue.jobs()[0].status, 'paused'); assert.equal(acquisitions, 0); await queue.close();
  } finally { store.close(); await fs.rm(root, { recursive: true, force: true }); }
});
