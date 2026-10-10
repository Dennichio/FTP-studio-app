import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import type { ConnectionProfile, FileEntry, FileSnapshot, RemoteSession } from '../src/shared/contracts';
import { checkedRemoteActionPath, prepareRemoteFileAction, removeRemoteActionSource } from '../src/main/remoteFileActions';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-remote-action-unit-')); roots.push(root);
  const cache = path.join(root, 'workcache'), bytes = Buffer.from([0, 255, 128, 13, 10, 65]);
  const profile: ConnectionProfile = { id: 'test', name: 'Test', protocol: 'ftp', host: 'localhost', port: 21, username: 'test', localRoot: root, remoteRoot: '/site', timeoutMs: 1000, connectionLimit: 2, parallelTransfers: 1, autoReconnect: false, passive: true };
  const entries = new Map<string, FileEntry>([
    ['/site', { name: 'site', path: '/site', kind: 'directory', size: 0, modifiedAt: 1000 }],
    ['/site/source.bin', { name: 'source.bin', path: '/site/source.bin', kind: 'file', size: bytes.length, modifiedAt: 1000 }],
  ]);
  const session: RemoteSession = {
    stat: vi.fn(async target => entries.get(target) || null), list: vi.fn(async () => []),
    download: vi.fn(async (_remote, local, progress, signal) => { if (signal.aborted) throw new DOMException('Aborted', 'AbortError'); await fs.writeFile(local, bytes); progress({ transferred: bytes.length, total: bytes.length }); }),
    upload: vi.fn(async () => {}), mkdir: vi.fn(async () => {}), rename: vi.fn(async () => {}), remove: vi.fn(async () => {}), chmod: vi.fn(async () => {}), close: vi.fn(async () => {}),
  };
  const expected: FileSnapshot = { size: bytes.length, modifiedAt: 1000 };
  const prepare = (action: Parameters<typeof prepareRemoteFileAction>[3], check = () => {}, authorize = async () => {}) => prepareRemoteFileAction(session, profile, cache, action, new AbortController().signal, check, authorize);
  return { root, cache, bytes, profile, entries, session, expected, prepare };
}

describe('private remote action preparation', () => {
  it('creates exclusive empty private bytes without issuing a server mutation', async () => {
    const f = await fixture(); const prepared = await f.prepare({ kind: 'create', path: '/site/new.html' });
    expect(await fs.readFile(prepared.localPath)).toEqual(Buffer.alloc(0)); expect(prepared.localSnapshot.size).toBe(0);
    expect(path.dirname(path.dirname(prepared.localPath))).toBe(f.cache);
    expect(path.basename(prepared.localPath)).toBe('new.html');
    expect(f.session.upload).not.toHaveBeenCalled(); expect(f.session.rename).not.toHaveBeenCalled(); expect(f.session.mkdir).not.toHaveBeenCalled(); expect(f.session.remove).not.toHaveBeenCalled();
    await removeRemoteActionSource(f.cache, prepared.localPath); expect(await fs.readdir(f.cache)).toEqual([]);
  });
  it('preserves binary bytes in a private copy and leaves the source unchanged', async () => {
    const f = await fixture(); const original = structuredClone(f.entries.get('/site/source.bin'));
    const prepared = await f.prepare({ kind: 'copy', path: '/site/source.bin', destination: '/site/copy.bin', expectedSource: f.expected });
    expect(await fs.readFile(prepared.localPath)).toEqual(f.bytes);
    expect(prepared.localSnapshot.checksum).toBe(createHash('sha256').update(f.bytes).digest('hex'));
    expect(f.entries.get('/site/source.bin')).toEqual(original); expect(f.entries.has('/site/copy.bin')).toBe(false);
    expect(f.session.upload).not.toHaveBeenCalled();
  });
  it.each(['/outside/a', '/site/../a', '/site/a\\b', '/site/a\r\nDELE /', '/site', '/site/.env', '/site/secrets.txt', '/site/.git/config', '/site/private.key', '/site/backups/a'])('rejects unsafe or excluded path %s before reading bytes', async target => {
    const f = await fixture(); await expect(f.prepare({ kind: 'create', path: target })).rejects.toThrow(); expect(f.session.download).not.toHaveBeenCalled(); expect(f.session.upload).not.toHaveBeenCalled();
  });
  it('also refuses sensitive paths inside an explicitly selected sensitive root', () => {
    expect(() => checkedRemoteActionPath('/.ssh', '/.ssh/config')).toThrow(/gevoelig/);
  });
  it.each(['CON.txt', 'unsafe:name.css', 'trailing.'])('refuses unsafe Windows cache basename %s before any source download', async name => {
    const f = await fixture();
    await expect(f.prepare({ kind: 'copy', path: '/site/source.bin', destination: '/site/' + name, expectedSource: f.expected })).rejects.toThrow(/Windows-werkcache/);
    expect(f.session.download).not.toHaveBeenCalled();
  });
  it('refuses a symlink parent, an existing destination and a missing parent', async () => {
    const f = await fixture();
    f.entries.set('/site/link', { name: 'link', path: '/site/link', kind: 'symlink', size: 0, modifiedAt: 1000 });
    await expect(f.prepare({ kind: 'create', path: '/site/link/new' })).rejects.toThrow(/Symbolische/);
    await expect(f.prepare({ kind: 'create', path: '/site/source.bin' })).rejects.toThrow(/bestaat al/);
    await expect(f.prepare({ kind: 'create', path: '/site/missing/new' })).rejects.toThrow(/bovenliggende/);
    expect(f.session.mkdir).not.toHaveBeenCalled();
  });
  it('refuses directory sources, stale metadata and an uncomparable timestamp', async () => {
    const f = await fixture(); const action = { kind: 'copy' as const, path: '/site/source.bin', destination: '/site/copy.bin', expectedSource: { ...f.expected, modifiedAt: 999 } };
    await expect(f.prepare(action)).rejects.toThrow(/gewijzigd/);
    await expect(f.prepare({ ...action, path: '/site', expectedSource: { size: 0, modifiedAt: 1000 } })).rejects.toThrow();
    f.entries.get('/site/source.bin')!.modifiedAt = null;
    await expect(f.prepare({ ...action, expectedSource: { size: f.bytes.length, modifiedAt: null } })).rejects.toThrow(/tijdstempel/);
    expect(f.session.download).not.toHaveBeenCalled();
  });
  it('accepts a source checksum with an unavailable timestamp and verifies actual bytes', async () => {
    const f = await fixture(); const checksum = createHash('sha256').update(f.bytes).digest('hex');
    Object.assign(f.entries.get('/site/source.bin')!, { modifiedAt: null, checksum });
    const prepared = await f.prepare({ kind: 'copy', path: '/site/source.bin', destination: '/site/copy.bin', expectedSource: { size: f.bytes.length, modifiedAt: null, checksum } });
    expect(prepared.localSnapshot.checksum).toBe(checksum);
  });
  it('rejects a source changed during download and removes its private preparation', async () => {
    const f = await fixture(); vi.mocked(f.session.download).mockImplementation(async (_remote, local) => { await fs.writeFile(local, f.bytes); f.entries.get('/site/source.bin')!.modifiedAt = 2000; });
    await expect(f.prepare({ kind: 'copy', path: '/site/source.bin', destination: '/site/copy.bin', expectedSource: f.expected })).rejects.toThrow(/gewijzigd/);
    expect(await fs.readdir(f.cache)).toEqual([]); expect(f.session.upload).not.toHaveBeenCalled();
  });
  it('rejects a destination created during download without changing it', async () => {
    const f = await fixture(); const existing = { name: 'copy.bin', path: '/site/copy.bin', kind: 'file' as const, size: 999, modifiedAt: 2000 };
    vi.mocked(f.session.download).mockImplementation(async (_remote, local) => { await fs.writeFile(local, f.bytes); f.entries.set('/site/copy.bin', existing); });
    await expect(f.prepare({ kind: 'copy', path: '/site/source.bin', destination: '/site/copy.bin', expectedSource: f.expected })).rejects.toThrow(/tijdens de voorbereiding/);
    expect(f.entries.get('/site/copy.bin')).toEqual(existing); expect(await fs.readdir(f.cache)).toEqual([]);
  });
  it('refuses changed endpoint context after confirmation without downloading', async () => {
    const f = await fixture(); let changed = false;
    await expect(f.prepare({ kind: 'copy', path: '/site/source.bin', destination: '/site/copy.bin', expectedSource: f.expected }, () => { if (changed) throw new Error('Endpoint changed'); }, async () => { changed = true; })).rejects.toThrow('Endpoint changed');
    expect(f.session.download).not.toHaveBeenCalled();
  });
  it('rejects a symlink cache root without writing outside the private directory', async () => {
    const f = await fixture(), outside = path.join(f.root, 'outside'); await fs.mkdir(outside); await fs.symlink(outside, f.cache, 'dir');
    await expect(f.prepare({ kind: 'create', path: '/site/new' })).rejects.toThrow(/Symbolische/); expect(await fs.readdir(outside)).toEqual([]);
  });
  it('removes no ordinary project source when given a path outside the action cache', async () => {
    const f = await fixture(), filename = path.join(f.root, 'payload'); await fs.writeFile(filename, f.bytes);
    await removeRemoteActionSource(f.cache, filename); expect(await fs.readFile(filename)).toEqual(f.bytes);
  });
});
