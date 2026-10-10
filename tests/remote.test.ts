import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client as FtpClient } from 'basic-ftp';
import SftpClient from 'ssh2-sftp-client';
import { createHash, createPrivateKey } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteManager, createProtocolSession } from '../src/main/remote';
import type { ConnectionProfile, RemoteSession } from '../src/shared/contracts';
import { ftpFixture } from './fixtures/ftp-server';
import { sftpFixture } from './fixtures/sftp-server';
import { untrustedTlsFixture } from './fixtures/tls-server';

const profile: ConnectionProfile = { id: 'test', name: 'Test', host: '127.0.0.1', port: 21, protocol: 'ftp', username: 'test', localRoot: '/', remoteRoot: '/', timeoutMs: 2000, connectionLimit: 3, parallelTransfers: 2, autoReconnect: true, passive: true };
function fakeSession(): RemoteSession {
  return { list: vi.fn(async () => []), stat: vi.fn(async () => null), mkdir: vi.fn(async () => undefined), rename: vi.fn(async () => undefined), remove: vi.fn(async () => undefined), chmod: vi.fn(async () => undefined), upload: vi.fn(async () => undefined), download: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
}
function deferred<T>() { let resolve!: (v: T) => void; let reject!: (e: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const managers: RemoteManager[] = [];
function manager(factory = vi.fn(async () => fakeSession())) { const m = new RemoteManager(() => ({ password: 'secret' }), vi.fn(), undefined, factory); managers.push(m); return m; }
afterEach(async () => { await Promise.all(managers.splice(0).map(m => m.close())); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('bounded session manager', () => {
  it('reserves navigation and never exceeds the limit while transfers wait', async () => {
    const sessions: RemoteSession[] = [];
    const factory = vi.fn(async () => { const session = fakeSession(); sessions.push(session); return session; });
    const m = manager(factory); await m.connect(profile);
    const a = await m.acquire('test', 'transfer'); const b = await m.acquire('test', 'transfer');
    let delivered = false; const waiting = m.acquire('test', 'transfer').then(lease => { delivered = true; return lease; });
    const nav = await m.acquire('test', 'navigation');
    expect(factory).toHaveBeenCalledTimes(3); expect(delivered).toBe(false);
    await nav.session.list('/'); await nav.release(); expect(delivered).toBe(false);
    await a.release(); const c = await waiting;
    expect(sessions[1].close).not.toHaveBeenCalled(); expect(factory).toHaveBeenCalledTimes(3);
    expect(a.session).not.toBe(b.session); expect(b.session).not.toBe(c.session);
    await b.release(); await c.release();
  });
  it('reuses one independent worker session across one hundred tiny transfers', async () => {
    const sessions: RemoteSession[] = []; const factory = vi.fn(async () => { const session = fakeSession(); sessions.push(session); return session; });
    const m = manager(factory); await m.connect(profile);
    for (let index = 0; index < 100; index++) { const lease = await m.acquire('test', 'transfer'); await lease.session.stat(`/tiny-${index}`); await lease.release(); }
    expect(factory).toHaveBeenCalledTimes(2); expect(sessions[0].stat).not.toHaveBeenCalled(); expect(sessions[1].stat).toHaveBeenCalledTimes(100); expect(sessions[1].close).not.toHaveBeenCalled();
    const nav = await m.acquire('test', 'navigation'); await nav.session.list('/'); expect(sessions[0].list).toHaveBeenCalledTimes(1); await nav.release();
    await m.close(); expect(sessions[1].close).toHaveBeenCalledTimes(1);
  });
  it('expires idle workers without closing a borrowed session or preventing fresh work', async () => {
    vi.useFakeTimers(); const sessions: RemoteSession[] = []; const factory = vi.fn(async () => { const session = fakeSession(); sessions.push(session); return session; });
    const m = manager(factory); await m.connect({ ...profile, autoReconnect: false });
    const first = await m.acquire('test', 'transfer'); await first.release(); await vi.advanceTimersByTimeAsync(29_000);
    const borrowed = await m.acquire('test', 'transfer'); await vi.advanceTimersByTimeAsync(2000); expect(sessions[1].close).not.toHaveBeenCalled();
    await borrowed.session.list('/'); await borrowed.release(); await vi.advanceTimersByTimeAsync(29_999); expect(sessions[1].close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(sessions[1].close).toHaveBeenCalledTimes(1);
    const fresh = await m.acquire('test', 'transfer'); expect(factory).toHaveBeenCalledTimes(3); await fresh.release();
  });
  it('counts an expired worker until close finishes and never lends the closing slot', async () => {
    vi.useFakeTimers(); const closing = deferred<void>(); const worker = fakeSession(); vi.mocked(worker.close).mockImplementation(() => closing.promise);
    const factory = vi.fn(async () => fakeSession()).mockImplementationOnce(async () => fakeSession()).mockImplementationOnce(async () => worker);
    const m = manager(factory); await m.connect({ ...profile, connectionLimit: 2 }); const first = await m.acquire('test', 'transfer'); await first.release();
    await vi.advanceTimersByTimeAsync(30_000); expect(worker.close).toHaveBeenCalledTimes(1);
    let delivered = false; const next = m.acquire('test', 'transfer').then(lease => { delivered = true; return lease; });
    await Promise.resolve(); expect(delivered).toBe(false); expect(factory).toHaveBeenCalledTimes(2);
    closing.resolve(); const fresh = await next; expect(factory).toHaveBeenCalledTimes(3); await fresh.session.list('/'); await fresh.release();
  });
  it('ignores stale close, release and cancellation after a worker has been reused', async () => {
    const worker = fakeSession(); const factory = vi.fn(async () => fakeSession()).mockImplementationOnce(async () => fakeSession()).mockImplementationOnce(async () => worker);
    const m = manager(factory); await m.connect(profile); const controller = new AbortController();
    const old = await m.acquire('test', 'transfer', controller.signal); await old.release(); const current = await m.acquire('test', 'transfer');
    await old.session.close(); await old.release(); controller.abort(); await current.session.list('/');
    expect(worker.close).not.toHaveBeenCalled(); expect(factory).toHaveBeenCalledTimes(2); await current.release();
    await expect(old.session.list('/')).rejects.toThrow('Sessie is gesloten');
  });
  it('discards a worker after an ordinary failed command while preserving a usable profile', async () => {
    const dirty = fakeSession(); vi.mocked(dirty.stat).mockRejectedValue(Object.assign(new Error('Permission denied'), { code: 550 }));
    const factory = vi.fn(async () => fakeSession()).mockImplementationOnce(async () => fakeSession()).mockImplementationOnce(async () => dirty);
    const m = manager(factory); await m.connect({ ...profile, connectionLimit: 1, autoReconnect: false }); const lease = await m.acquire('test', 'transfer');
    await expect(lease.session.stat('/')).rejects.toThrow('Permission denied'); await lease.release(); expect(dirty.close).toHaveBeenCalledTimes(1);
    expect(m.states()[0].connected).toBe(true); const fresh = await m.acquire('test', 'transfer'); expect(factory).toHaveBeenCalledTimes(3); await fresh.release();
  });
  it('keeps a tainted lease operational for rollback, then discards it at release', async () => {
    const files = new Map([['/original', 'original bytes'], ['/staged', 'new bytes']]); const worker = fakeSession();
    vi.mocked(worker.rename).mockImplementation(async (from, to) => {
      if (from === '/staged') throw Object.assign(new Error('Installation denied'), { code: 550 });
      const bytes = files.get(from); if (bytes === undefined) throw new Error('Missing source'); files.set(to, bytes); files.delete(from);
    });
    vi.mocked(worker.stat).mockImplementation(async path => files.has(path) ? { name: path.slice(1), path, kind: 'file', size: files.get(path)!.length, modifiedAt: 0 } : null);
    const factory = vi.fn(async () => fakeSession()).mockImplementationOnce(async () => fakeSession()).mockImplementationOnce(async () => worker);
    const m = manager(factory); await m.connect(profile); const lease = await m.acquire('test', 'transfer');
    await lease.session.rename('/original', '/backup'); await expect(lease.session.rename('/staged', '/original')).rejects.toThrow('Installation denied');
    expect(worker.close).not.toHaveBeenCalled(); expect(await lease.session.stat('/backup')).not.toBeNull(); await lease.session.rename('/backup', '/original');
    expect(files.get('/original')).toBe('original bytes'); expect(files.has('/backup')).toBe(false);
    await lease.release(); expect(worker.close).toHaveBeenCalledTimes(1); const next = await m.acquire('test', 'transfer'); expect(factory).toHaveBeenCalledTimes(3); await next.release();
  });
  it('does not treat an unfinished operation failing during intentional close as a lost connection', async () => {
    const operation = deferred<null>(); const closing = deferred<void>(); const oldWorker = fakeSession();
    vi.mocked(oldWorker.stat).mockImplementation(() => operation.promise);
    vi.mocked(oldWorker.close).mockImplementation(() => { operation.reject(Object.assign(new Error('Closed while releasing'), { code: 'ENOTCONN' })); return closing.promise; });
    const factory = vi.fn(async () => fakeSession()).mockImplementationOnce(async () => fakeSession()).mockImplementationOnce(async () => oldWorker);
    const m = manager(factory); await m.connect({ ...profile, connectionLimit: 1, autoReconnect: false }); const old = await m.acquire('test', 'transfer');
    const running = old.session.stat('/'); const assertion = expect(running).rejects.toThrow('Closed while releasing'); const releasing = old.release();
    await vi.waitFor(() => expect(oldWorker.close).toHaveBeenCalledTimes(1)); expect(m.states()[0].connected).toBe(true);
    const pendingReplacement = m.acquire('test', 'transfer'); closing.resolve(); await releasing; const replacement = await pendingReplacement; await assertion;
    expect(m.states()[0].connected).toBe(true); await replacement.session.stat('/'); await replacement.release();
  });
  it('does not let an operation failing after release disconnect its replacement', async () => {
    const failing = deferred<null>(); const oldWorker = fakeSession(); vi.mocked(oldWorker.stat).mockImplementation(() => failing.promise);
    const factory = vi.fn(async () => fakeSession()).mockImplementationOnce(async () => fakeSession()).mockImplementationOnce(async () => oldWorker);
    const m = manager(factory); await m.connect({ ...profile, connectionLimit: 1, autoReconnect: false }); const old = await m.acquire('test', 'transfer');
    const running = old.session.stat('/'); const assertion = expect(running).rejects.toThrow('Old connection closed'); await old.release(); expect(oldWorker.close).toHaveBeenCalledTimes(1);
    const fresh = await m.acquire('test', 'transfer'); await fresh.session.stat('/'); failing.reject(Object.assign(new Error('Old connection closed'), { code: 'ECONNRESET' })); await assertion;
    expect(m.states()[0].connected).toBe(true); await fresh.session.list('/'); await fresh.release(); const next = await m.acquire('test', 'transfer'); await next.release();
    expect(factory).toHaveBeenCalledTimes(3);
  });
  it('serializes transfers and navigation fairly at limit one', async () => {
    const sessions: RemoteSession[] = []; let active = 0; let maxActive = 0;
    const factory = vi.fn(async () => { active++; maxActive = Math.max(active, maxActive); const session = fakeSession(); session.close = vi.fn(async () => { active--; }); sessions.push(session); return session; });
    const m = manager(factory); await m.connect({ ...profile, connectionLimit: 1 });
    const navigation = await m.acquire('test', 'navigation');
    const order: string[] = [];
    const transferP = m.acquire('test', 'transfer').then(x => { order.push('transfer'); return x; });
    const nextNavP = m.acquire('test', 'navigation').then(x => { order.push('navigation'); return x; });
    await navigation.release(); const transfer = await transferP;
    expect(order).toEqual(['transfer']); expect(sessions[0].close).toHaveBeenCalledTimes(1);
    await transfer.release(); const nextNav = await nextNavP;
    expect(order).toEqual(['transfer', 'navigation']); expect(maxActive).toBe(1);
    await nextNav.release();
  });
  it('removes an aborted waiter without blocking the next waiter', async () => {
    const m = manager(); await m.connect({ ...profile, connectionLimit: 1 });
    const lease = await m.acquire('test', 'navigation'); const controller = new AbortController();
    const cancelled = m.acquire('test', 'transfer', controller.signal); const assertion = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    const next = m.acquire('test', 'navigation'); controller.abort(); await assertion;
    await lease.release(); await (await next).release();
  });
  it('counts an aborted handshake until it has finished and closed', async () => {
    const handshaking = deferred<RemoteSession>(); const newSession = fakeSession();
    const factory = vi.fn(async () => fakeSession()); factory.mockImplementationOnce(async () => fakeSession()).mockImplementationOnce(() => handshaking.promise);
    const m = manager(factory); await m.connect({ ...profile, connectionLimit: 2 }); const controller = new AbortController();
    const acquisition = m.acquire('test', 'transfer', controller.signal); const assertion = expect(acquisition).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2)); controller.abort(); await assertion;
    const waiting = m.acquire('test', 'transfer'); await Promise.resolve(); expect(factory).toHaveBeenCalledTimes(2);
    handshaking.resolve(newSession); const lease = await waiting;
    expect(newSession.close).toHaveBeenCalled(); expect(factory).toHaveBeenCalledTimes(3); await lease.release();
  });
  it('does not publish a handshake after disconnect', async () => {
    const handshaking = deferred<RemoteSession>(); const late = fakeSession();
    const factory = vi.fn(() => handshaking.promise); const m = manager(factory); const connecting = m.connect(profile); const assertion = expect(connecting).rejects.toThrow(/geannuleerd/);
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1)); const disconnecting = m.disconnect('test');
    handshaking.resolve(late); await assertion; await disconnecting;
    expect(m.states()).toEqual([]); expect(late.close).toHaveBeenCalled();
  });
  it('discards broken navigation and reconnects only on the next acquisition', async () => {
    const broken = fakeSession(); vi.mocked(broken.list).mockRejectedValue(Object.assign(new Error('Connection closed'), { code: 'ECONNRESET' }));
    const factory = vi.fn(async () => fakeSession()).mockImplementationOnce(async () => broken);
    const m = manager(factory); await m.connect(profile); const lease = await m.acquire('test', 'navigation');
    await expect(lease.session.list('/')).rejects.toThrow('Connection closed'); expect(broken.close).toHaveBeenCalledTimes(1);
    expect(m.states()[0].connected).toBe(false); expect(factory).toHaveBeenCalledTimes(1); await lease.release();
    const next = await m.acquire('test', 'navigation'); expect(factory).toHaveBeenCalledTimes(2); await next.release();
  });
  it('does not reconnect a broken profile when automatic reconnect is disabled', async () => {
    const broken = fakeSession(); vi.mocked(broken.list).mockRejectedValue(Object.assign(new Error('Connection closed'), { code: 'ECONNRESET' }));
    const factory = vi.fn(async () => broken); const m = manager(factory); await m.connect({ ...profile, autoReconnect: false });
    const lease = await m.acquire('test', 'navigation'); await expect(lease.session.list('/')).rejects.toThrow(); await lease.release();
    await expect(m.acquire('test', 'navigation')).rejects.toThrow(); expect(factory).toHaveBeenCalledTimes(1);
  });
  it('keeps leases idempotent and rejects operations after release', async () => {
    const m = manager(); await m.connect(profile); const lease = await m.acquire('test', 'transfer');
    await lease.release(); await lease.release(); await expect(lease.session.list('/')).rejects.toThrow('Sessie is gesloten');
  });
  it('isolates cloned profiles by their profile ids', async () => {
    const m = manager(); await m.connect({ ...profile, connectionLimit: 1 }); await m.connect({ ...profile, id: 'second', connectionLimit: 1 });
    const first = await m.acquire('test', 'navigation'); const second = await m.acquire('second', 'navigation');
    await m.disconnect('test'); await second.session.list('/'); expect(m.states().map(x => x.id)).toEqual(['second']); await first.release(); await second.release();
  });
  it('redacts credential failures and never writes secrets to logs', async () => {
    const logger = vi.fn(); const m = new RemoteManager(() => ({ password: 'VERY_SECRET' }), logger, undefined, vi.fn(async () => { throw new Error('Server echoed VERY_SECRET'); })); managers.push(m);
    await expect(m.connect(profile)).rejects.toThrow('[afgeschermd]'); expect(JSON.stringify(logger.mock.calls)).not.toContain('VERY_SECRET'); expect(JSON.stringify(m.states())).not.toContain('VERY_SECRET');
  });
  it('sanitizes operation failures before callers can persist or log them, preserving error identity', async () => {
    const logger = vi.fn(); const session = fakeSession();
    vi.mocked(session.stat).mockRejectedValue(Object.assign(new Error('Server echoed PASSWORD_SECRET and PASSPHRASE_SECRET'), { code: 550, name: 'FTPError' }));
    const m = new RemoteManager(() => ({ password: 'PASSWORD_SECRET', passphrase: 'PASSPHRASE_SECRET' }), logger, undefined, vi.fn(async () => session)); managers.push(m);
    await m.connect(profile); const lease = await m.acquire('test', 'navigation');
    try {
      let caught: unknown; try { await lease.session.stat('/'); } catch (error) { caught = error; }
      expect(caught).toMatchObject({ code: 550, name: 'FTPError', message: 'Server echoed [afgeschermd] and [afgeschermd]' });
      const persistedQueueError = { status: 'failed', error: (caught as Error).message };
      logger('error', persistedQueueError.error, 'test');
      const serialized = JSON.stringify({ persistedQueueError, logs: logger.mock.calls, states: m.states() });
      expect(serialized).not.toContain('PASSWORD_SECRET'); expect(serialized).not.toContain('PASSPHRASE_SECRET'); expect((caught as Error).stack).not.toContain('PASSWORD_SECRET');
    } finally { await lease.release(); }
  });
  it('still redacts an in-flight failure after disconnect clears stored credentials', async () => {
    const failing = deferred<null>(); const session = fakeSession(); vi.mocked(session.stat).mockImplementation(() => failing.promise);
    const m = new RemoteManager(() => ({ password: 'IN_FLIGHT_SECRET' }), vi.fn(), undefined, vi.fn(async () => session)); managers.push(m);
    await m.connect(profile); const lease = await m.acquire('test', 'navigation');
    const operation = lease.session.stat('/'); const assertion = expect(operation).rejects.toThrow('echo [afgeschermd]');
    await m.disconnect('test'); failing.reject(new Error('echo IN_FLIGHT_SECRET')); await assertion; await lease.release();
  });
});

describe('protocol security', () => {
  it('rejects active FTP and CR/LF in FTP commands before any socket is opened', async () => {
    const access = vi.spyOn(FtpClient.prototype, 'access');
    await expect(createProtocolSession({ ...profile, passive: false }, {})).rejects.toThrow('Actieve FTP');
    await expect(createProtocolSession({ ...profile, username: 'user\r\nDELE /' }, {})).rejects.toThrow('gebruikersnaam');
    await expect(createProtocolSession(profile, { password: 'pass\r\nDELE /' })).rejects.toThrow('controletekens'); expect(access).not.toHaveBeenCalled();
  });
  it.each(['ftps', 'ftps-implicit'] as const)('requires valid TLS certificates for %s', async protocol => {
    const access = vi.spyOn(FtpClient.prototype, 'access').mockResolvedValue({ code: 230, message: 'OK' });
    const session = await createProtocolSession({ ...profile, protocol }, {});
    expect(access).toHaveBeenCalledWith(expect.objectContaining({ secure: protocol === 'ftps' ? true : 'implicit', secureOptions: expect.objectContaining({ rejectUnauthorized: true, checkServerIdentity: expect.any(Function) }) })); await session.close();
  });
  it.each([undefined, 'SHA256:' + Buffer.alloc(32).toString('base64').replace(/=+$/, '')])('rejects unknown or mismatched host keys with the observed fingerprint', async pin => {
    const publicKey = Buffer.from('test-public-key'); const expected = 'SHA256:' + createHash('sha256').update(publicKey).digest('base64').replace(/=+$/, '');
    vi.spyOn(SftpClient.prototype, 'connect').mockImplementation(async config => { const verifier = config.hostVerifier as (key: Buffer) => boolean; expect(verifier(publicKey)).toBe(false); throw new Error('Host denied'); });
    vi.spyOn(SftpClient.prototype, 'end').mockResolvedValue(true);
    await expect(createProtocolSession({ ...profile, protocol: 'sftp', hostKeySha256: pin }, { password: 'secret' })).rejects.toThrow(expected);
  });
  it('accepts an exact SHA256 pin and preserves password/key passphrase options', async () => {
    const publicKey = Buffer.from('trusted-public-key'); const hostKeySha256 = 'SHA256:' + createHash('sha256').update(publicKey).digest('base64').replace(/=+$/, '');
    const connect = vi.spyOn(SftpClient.prototype, 'connect').mockImplementation(async config => { expect((config.hostVerifier as (key: Buffer) => boolean)(publicKey)).toBe(true); return {} as never; });
    vi.spyOn(SftpClient.prototype, 'lstat').mockResolvedValue({ size: 0, mode: 0o40755, modifyTime: 0, accessTime: 0, uid: 0, gid: 0, isDirectory: true, isFile: false, isBlockDevice: false, isCharacterDevice: false, isSymbolicLink: false, isFIFO: false, isSocket: false });
    vi.spyOn(SftpClient.prototype, 'end').mockResolvedValue(true);
    const session = await createProtocolSession({ ...profile, protocol: 'sftp', hostKeySha256 }, { password: 'secret', passphrase: 'key-secret' });
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ password: 'secret', passphrase: 'key-secret', retries: 0 })); await session.close();
  });
  it('refuses root escapes, injected paths, unsafe server names and symlink ancestors', async () => {
    vi.spyOn(FtpClient.prototype, 'access').mockResolvedValue({ code: 230, message: 'OK' });
    const listing = vi.spyOn(FtpClient.prototype, 'list').mockImplementation(async path => {
      if (path === '/') return [{ name: 'root', size: 0, isDirectory: true, isSymbolicLink: false }] as never;
      if (path === '/root') return [{ name: 'link', size: 1, isDirectory: false, isSymbolicLink: true }] as never;
      return [];
    });
    const session = await createProtocolSession({ ...profile, remoteRoot: '/root' }, {});
    await expect(session.list('/outside')).rejects.toThrow('hoofdmap'); await expect(session.stat('/root/../secret')).rejects.toThrow('Ongeldig');
    await expect(session.stat('/root/a\r\nDELE /')).rejects.toThrow('Ongeldig'); await expect(session.stat('/root/link/file')).rejects.toThrow('Symbolische');
    listing.mockImplementation(async path => path === '/' ? [{ name: 'root', size: 0, isDirectory: true, isSymbolicLink: false }] as never : [{ name: '../outside', size: 0, isDirectory: false, isSymbolicLink: false }] as never);
    await expect(session.list('/root')).rejects.toThrow('onveilige bestandsnaam'); await session.close();
  });
});

describe('real passive FTP sessions', () => {
  it('lists, streams, resumes and mutates through a local FTP server', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ftp-studio-remote-')); const server = await ftpFixture();
    let session: RemoteSession | undefined;
    try {
      session = await createProtocolSession({ ...profile, port: server.port }, { password: 'test' });
      const bytes = Buffer.from('streaming transfer '.repeat(10000)); const source = join(directory, 'source'); const destination = join(directory, 'destination'); await writeFile(source, bytes);
      const uploaded: number[] = []; await session.upload(source, '/file.txt', p => uploaded.push(p.transferred), new AbortController().signal);
      expect(server.files.get('/file.txt')).toEqual(bytes); expect(uploaded.at(-1)).toBe(bytes.length);
      expect((await session.list('/'))[0]).toMatchObject({ name: 'file.txt', kind: 'file', size: bytes.length });
      await session.download('/file.txt', destination, () => undefined, new AbortController().signal); expect(await readFile(destination)).toEqual(bytes);
      server.files.set('/partial.txt', bytes.subarray(0, 11)); await session.upload(source, '/partial.txt', () => undefined, new AbortController().signal, 11); expect(server.files.get('/partial.txt')).toEqual(bytes);
      await writeFile(destination, bytes.subarray(0, 13)); await session.download('/file.txt', destination, () => undefined, new AbortController().signal, 13); expect(await readFile(destination)).toEqual(bytes);
      await expect(session.upload(source, '/partial.txt', () => undefined, new AbortController().signal, 10)).rejects.toThrow('hervatpositie');
      await expect(session.rename('/partial.txt', '/file.txt')).rejects.toThrow('Doel bestaat al'); expect(server.files.get('/file.txt')).toEqual(bytes); expect(server.files.get('/partial.txt')).toEqual(bytes);
      await session.rename('/partial.txt', '/renamed.txt'); expect(await session.stat('/partial.txt')).toBeNull();
      await session.chmod('/renamed.txt', '644'); await session.remove('/renamed.txt', false); expect(await session.stat('/renamed.txt')).toBeNull();
      await session.mkdir('/folder'); await session.remove('/folder', true);
    } finally { await session?.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it('cancels a blocked transfer by closing its protocol socket', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ftp-studio-abort-')); const server = await ftpFixture({ stallDownload: true });
    const session = await createProtocolSession({ ...profile, port: server.port }, { password: 'test' }); server.files.set('/blocked', Buffer.from('blocked transfer'));
    try {
      const controller = new AbortController(); const downloading = session.download('/blocked', join(directory, 'destination'), () => undefined, controller.signal);
      const assertion = expect(downloading).rejects.toMatchObject({ name: 'AbortError' });
      await vi.waitFor(() => expect(server.downloadStarted).toBe(true)); controller.abort(); await assertion;
      await expect(session.list('/')).rejects.toThrow('gesloten');
    } finally { await session.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
  });
});

describe('real SFTP sessions', () => {
  it('authenticates with an encrypted private key and rejects a wrong key passphrase', async () => {
    const server = await sftpFixture(); const directory = await mkdtemp(join(tmpdir(), 'ftp-studio-key-auth-')); let session: RemoteSession | undefined;
    try {
      const privateKeyPath = join(directory, 'user-key.pem'); const passphrase = 'fixture-key-passphrase';
      const encryptedKey = createPrivateKey(server.userPrivateKey).export({ type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase }); await writeFile(privateKeyPath, encryptedKey, { mode: 0o600 });
      const ssh = { ...profile, protocol: 'sftp' as const, port: server.port, hostKeySha256: server.fingerprint, privateKeyPath };
      await expect(createProtocolSession(ssh, { passphrase: 'wrong-passphrase' })).rejects.toThrow(/key|passphrase|decrypt/i);
      session = await createProtocolSession(ssh, { passphrase }); expect(await session.list('/')).toEqual([]);
    } finally { await session?.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it('checks the host fingerprint before sending credentials', async () => {
    const server = await sftpFixture();
    try {
      const ssh = { ...profile, protocol: 'sftp' as const, port: server.port };
      await expect(createProtocolSession(ssh, { password: 'test' })).rejects.toThrow(server.fingerprint);
      await expect(createProtocolSession({ ...ssh, hostKeySha256: 'SHA256:' + Buffer.alloc(32).toString('base64').replace(/=+$/, '') }, { password: 'test' })).rejects.toThrow('wijkt af');
      expect(server.authentications).toBe(0);
      const session = await createProtocolSession({ ...ssh, hostKeySha256: server.fingerprint }, { password: 'test' });
      expect(server.authentications).toBeGreaterThan(0); expect(await session.list('/')).toEqual([]); await session.close();
    } finally { await server.close(); }
  });
  it('streams and resumes files and refuses symlink traversal over SSH', async () => {
    const server = await sftpFixture(); const directory = await mkdtemp(join(tmpdir(), 'ftp-studio-sftp-')); let session: RemoteSession | undefined;
    try {
      session = await createProtocolSession({ ...profile, protocol: 'sftp', port: server.port, hostKeySha256: server.fingerprint }, { password: 'test' });
      const bytes = Buffer.from('SFTP stream '.repeat(12000)); const source = join(directory, 'source'); const destination = join(directory, 'destination'); await writeFile(source, bytes);
      const progress: number[] = []; await session.upload(source, '/file', p => progress.push(p.transferred), new AbortController().signal);
      expect(server.files.get('/file')).toEqual(bytes); expect(progress.at(-1)).toBe(bytes.length);
      await session.download('/file', destination, () => undefined, new AbortController().signal); expect(await readFile(destination)).toEqual(bytes);
      server.files.set('/partial', bytes.subarray(0, 17)); await session.upload(source, '/partial', () => undefined, new AbortController().signal, 17); expect(server.files.get('/partial')).toEqual(bytes);
      await writeFile(destination, bytes.subarray(0, 19)); await session.download('/file', destination, () => undefined, new AbortController().signal, 19); expect(await readFile(destination)).toEqual(bytes);
      server.links.add('/link'); await expect(session.stat('/link/secret')).rejects.toThrow('Symbolische');
      expect((await session.list('/')).find(e => e.name === 'link')?.kind).toBe('symlink');
      await expect(session.rename('/partial', '/file')).rejects.toThrow('Doel bestaat al'); expect(server.files.get('/file')).toEqual(bytes); expect(server.files.get('/partial')).toEqual(bytes);
      await session.rename('/partial', '/renamed'); await session.chmod('/renamed', '644'); await session.remove('/renamed', false); expect(await session.stat('/renamed')).toBeNull();
    } finally { await session?.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
  });
});

describe('real FTPS certificate validation', () => {
  it.each(['ftps', 'ftps-implicit'] as const)('rejects an untrusted certificate before credentials for %s', async protocol => {
    const server = await untrustedTlsFixture(protocol === 'ftps-implicit');
    try {
      await expect(createProtocolSession({ ...profile, protocol, port: server.port }, { password: 'never-send' })).rejects.toThrow(/certificate|self.signed/i);
      expect(server.receivedCredentials).toBe(false);
    } finally { await server.close(); }
  });
});

describe('stream and special-file regressions', () => {
  it.each(['ftp', 'sftp'] as const)('stops an oversized %s stream before it can exceed the advertised disk size', async protocol => {
    const server = protocol === 'ftp' ? await ftpFixture() : await sftpFixture();
    const directory = await mkdtemp(join(tmpdir(), 'ftp-studio-size-bound-')); const destination = join(directory, 'destination');
    const hostKeySha256 = 'fingerprint' in server ? server.fingerprint : undefined;
    let session: RemoteSession | undefined;
    try {
      session = await createProtocolSession({ ...profile, protocol, port: server.port, hostKeySha256 }, { password: 'test' });
      server.files.set('/growing', Buffer.alloc(8 * 1024 * 1024, 65)); server.advertisedSizes.set('/growing', 16);
      const progress: number[] = [];
      await expect(session.download('/growing', destination, p => progress.push(p.transferred), new AbortController().signal)).rejects.toThrow();
      const written = await stat(destination).then(info => info.size, error => { if (error.code === 'ENOENT') return 0; throw error; });
      expect(written).toBeLessThanOrEqual(16); expect(progress.every(bytes => bytes <= 16)).toBe(true);
      await expect(session.list('/')).rejects.toThrow(/gesloten/i);
    } finally { await session?.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it.each([0o010644, 0o020644, 0o060644, 0o140644])('rejects SFTP special mode %o in stat, list and download', async mode => {
    const server = await sftpFixture(); const directory = await mkdtemp(join(tmpdir(), 'ftp-studio-special-file-')); let session: RemoteSession | undefined;
    const get = vi.spyOn(SftpClient.prototype, 'get');
    try {
      session = await createProtocolSession({ ...profile, protocol: 'sftp', port: server.port, hostKeySha256: server.fingerprint }, { password: 'test' });
      server.specialModes.set('/special', mode);
      await expect(session.stat('/special')).rejects.toThrow('Speciale remote bestandstypen');
      await expect(session.list('/')).rejects.toThrow('Speciale remote bestandstypen');
      await expect(session.download('/special', join(directory, 'destination'), () => undefined, new AbortController().signal)).rejects.toThrow('Speciale remote bestandstypen');
      expect(get).not.toHaveBeenCalled();
      await expect(stat(join(directory, 'destination'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await session?.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
