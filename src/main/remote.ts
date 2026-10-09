import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, stat as localStat } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import { posix } from 'node:path';
import { Transform } from 'node:stream';
import { finished } from 'node:stream/promises';
import { Client as FtpClient, FileInfo } from 'basic-ftp';
import SftpClient from 'ssh2-sftp-client';
import type { ConnectionProfile, ConnectionState, Credentials, FileEntry, Logger, RemoteAccess, RemoteSession, SessionLease, TransferProgress } from '../shared/contracts';
import { endpointIdentity } from '../core/connectionIdentity';

export type SessionFactory = (profile: ConnectionProfile, credentials: Credentials) => Promise<RemoteSession>;
type Purpose = 'navigation' | 'transfer';
interface Slot { purpose: Purpose; busy: boolean; session?: RemoteSession; opening?: Promise<RemoteSession>; broken: boolean; closing?: Promise<void>; idleTimer?: ReturnType<typeof setTimeout>; }
interface Waiter { purpose: Purpose; signal?: AbortSignal; resolve: (lease: SessionLease) => void; reject: (error: Error) => void; abort?: () => void; }
interface Connection {
  state: ConnectionState; credentials?: Credentials; slots: Set<Slot>; waiters: Waiter[];
  disposed: boolean; pumping: boolean;
}
const TRANSFER_IDLE_MS = 30_000;

function cancelled(): Error { return Object.assign(new Error('Bewerking geannuleerd.'), { name: 'AbortError' }); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'Onbekende verbindingsfout.'; }
function transportFailure(error: unknown): boolean {
  const e = error as { code?: string | number; name?: string; message?: string };
  return e?.name === 'AbortError' || ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENOTCONN', 'ERR_TRANSFER_SIZE', 421, 425, 426].includes(e?.code ?? '') || /connection (?:closed|lost)|not connected|no sftp connection|socket closed|timeout|timed out/i.test(e?.message ?? '');
}
function cleanMessage(error: unknown, credentials?: Credentials): string {
  let message = errorMessage(error);
  for (const secret of [credentials?.password, credentials?.passphrase].filter((value): value is string => !!value).sort((a, b) => b.length - a.length)) message = message.split(secret).join('[afgeschermd]');
  return message.replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, 600);
}
function sanitizedError(error: unknown, credentials?: Credentials): Error {
  const safe = new Error(cleanMessage(error, credentials));
  const original = error as { name?: unknown; code?: unknown };
  const secrets = [credentials?.password, credentials?.passphrase].filter((value): value is string => !!value);
  const safeToken = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) && !secrets.some(secret => value.includes(secret));
  if (safeToken(original?.name)) safe.name = original.name;
  if (typeof original?.code === 'number' || safeToken(original?.code)) Object.assign(safe, { code: original.code });
  return safe;
}
async function closeBounded(session: RemoteSession): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([Promise.resolve().then(() => session.close()).catch(() => undefined), new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function validateProfile(profile: ConnectionProfile): ConnectionProfile {
  if (!profile.id || !profile.host || /[\s\x00-\x1f\x7f]/.test(profile.host) || /[\x00-\x1f\x7f]/.test(profile.username)) throw new Error('Ongeldige host of gebruikersnaam.');
  if (!['ftp', 'ftps', 'ftps-implicit', 'sftp'].includes(profile.protocol)) throw new Error('Onbekend protocol.');
  if (!Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535) throw new Error('Poort moet tussen 1 en 65535 liggen.');
  if (!Number.isInteger(profile.connectionLimit) || profile.connectionLimit < 1 || profile.connectionLimit > 64) throw new Error('Verbindingslimiet moet tussen 1 en 64 liggen.');
  if (!Number.isFinite(profile.timeoutMs) || profile.timeoutMs < 1000 || profile.timeoutMs > 300000) throw new Error('Timeout moet tussen 1 en 300 seconden liggen.');
  const remoteRoot = normalizePath(profile.remoteRoot || '/');
  if (profile.protocol !== 'sftp' && profile.passive === false) throw new Error('Actieve FTP wordt niet ondersteund door basic-ftp. Kies passieve FTP (PASV/EPSV).');
  return { ...profile, remoteRoot };
}

/** A slot includes connecting/closing sessions, so slow handshakes cannot exceed the server limit. */
export class RemoteManager implements RemoteAccess {
  private readonly connections = new Map<string, Connection>();
  private readonly connectVersions = new Map<string, number>();
  private closed = false;
  constructor(private readonly credentials: (profileId: string) => Promise<Credentials> | Credentials, private readonly logger: Logger, private readonly onChange?: (states: ConnectionState[]) => void, private readonly factory: SessionFactory = createProtocolSession) {}

  states(): ConnectionState[] { return [...this.connections.values()].map(c => ({ ...c.state, profile: { ...c.state.profile }, endpointKey: endpointIdentity(c.state.profile) })); }
  profile(id: string): ConnectionProfile {
    const c = this.connections.get(id);
    if (!c || c.disposed) throw new Error('Verbinding bestaat niet.');
    return { ...c.state.profile };
  }
  private emit(): void { this.onChange?.(this.states()); }
  async connect(profile: ConnectionProfile, credentials?: Credentials): Promise<ConnectionState> {
    if (this.closed) throw new Error('Verbindingsbeheer is gesloten.');
    const validated = validateProfile(profile);
    const version = (this.connectVersions.get(validated.id) ?? 0) + 1;
    this.connectVersions.set(validated.id, version);
    await this.disconnect(validated.id);
    if (this.closed || this.connectVersions.get(validated.id) !== version) throw cancelled();
    // A later concurrent connect replaces this record; an old handshake is never published.
    const previous = this.connections.get(validated.id);
    if (previous && !previous.disposed) await this.dispose(previous);
    const c: Connection = { state: { id: validated.id, profile: validated, connected: false }, credentials: credentials && { ...credentials }, slots: new Set(), waiters: [], disposed: false, pumping: false };
    this.connections.set(validated.id, c);
    const slot: Slot = { purpose: 'navigation', busy: false, broken: false };
    c.slots.add(slot);
    let handshakeCredentials = c.credentials;
    try {
      const secret = c.credentials ?? await this.credentials(validated.id);
      handshakeCredentials = secret;
      if (c.disposed || this.closed) throw cancelled();
      c.credentials = { ...secret };
      slot.opening = this.factory({ ...validated }, { ...secret });
      slot.session = await slot.opening;
      if (c.disposed || this.closed || this.connections.get(validated.id) !== c) { await this.drop(c, slot); throw cancelled(); }
      c.state.connected = true;
      this.logger('info', 'Verbinding geopend.', validated.id);
      this.emit();
      return { ...c.state, profile: { ...validated }, endpointKey: endpointIdentity(validated) };
    } catch (error) {
      await this.drop(c, slot);
      c.state.connected = false;
      c.state.error = cleanMessage(error, handshakeCredentials);
      if (!c.disposed) { this.logger('error', 'Verbinding openen mislukt.', validated.id); this.emit(); }
      throw new Error(c.state.error);
    }
  }
  async disconnect(id: string): Promise<void> {
    const c = this.connections.get(id);
    if (!c) return;
    await this.dispose(c);
    if (this.connections.get(id) === c) { this.connections.delete(id); this.emit(); }
  }
  private async dispose(c: Connection): Promise<void> {
    c.disposed = true; c.state.connected = false; c.credentials = undefined;
    for (const w of c.waiters.splice(0)) { this.detach(w); w.reject(new Error('Verbinding gesloten.')); }
    await Promise.all([...c.slots].map(slot => this.drop(c, slot)));
  }
  async close(): Promise<void> { this.closed = true; await Promise.all([...this.connections.keys()].map(id => this.disconnect(id))); }
  acquire(id: string, purpose: Purpose, signal?: AbortSignal): Promise<SessionLease> {
    const c = this.connections.get(id);
    if (!c || c.disposed || this.closed) return Promise.reject(new Error('Verbinding bestaat niet.'));
    if (signal?.aborted) return Promise.reject(cancelled());
    if (!c.state.connected && !c.state.profile.autoReconnect) return Promise.reject(new Error(c.state.error || 'Verbinding verbroken.'));
    return new Promise((resolve, reject) => {
      const w: Waiter = { purpose, signal, resolve, reject };
      w.abort = () => { const i = c.waiters.indexOf(w); if (i >= 0) { c.waiters.splice(i, 1); this.detach(w); reject(cancelled()); void this.pump(c); } };
      signal?.addEventListener('abort', w.abort, { once: true });
      c.waiters.push(w); void this.pump(c);
    });
  }
  private detach(w: Waiter): void { if (w.abort) w.signal?.removeEventListener('abort', w.abort); }
  private clearIdle(slot: Slot): void { if (slot.idleTimer) { clearTimeout(slot.idleTimer); slot.idleTimer = undefined; } }
  private park(c: Connection, slot: Slot): void {
    slot.busy = false;
    this.clearIdle(slot);
    if (slot.purpose !== 'transfer') return;
    slot.idleTimer = setTimeout(() => {
      slot.idleTimer = undefined;
      if (!slot.busy && !slot.broken) void this.drop(c, slot).then(() => this.pump(c));
    }, TRANSFER_IDLE_MS);
    slot.idleTimer.unref();
  }
  private async drop(c: Connection, slot: Slot): Promise<void> {
    this.clearIdle(slot);
    slot.broken = true;
    if (slot.closing) return slot.closing;
    slot.closing = (async () => {
      let session = slot.session;
      if (!session && slot.opening) { try { session = await slot.opening; } catch { /* Failed handshakes have no session to close. */ } }
      if (session) await closeBounded(session);
      c.slots.delete(slot);
    })();
    await slot.closing;
  }
  private eligible(c: Connection, w: Waiter): Slot | 'new' | 'replace' | undefined {
    const limit = c.state.profile.connectionLimit;
    const nav = [...c.slots].find(s => s.purpose === 'navigation');
    const idle = [...c.slots].find(s => s.purpose === w.purpose && !s.busy && !s.broken && s.session);
    if (idle) return idle;
    if (limit === 1 && [...c.slots].some(s => s.purpose !== w.purpose && !s.busy && !s.broken && s.session)) return 'replace';
    if (c.slots.size >= limit) return undefined;
    if (w.purpose === 'navigation') return nav ? undefined : 'new';
    const transfers = [...c.slots].filter(s => s.purpose === 'transfer').length;
    return transfers < (limit === 1 ? 1 : limit - 1) ? 'new' : undefined;
  }
  private async pump(c: Connection): Promise<void> {
    if (c.pumping || c.disposed) return;
    c.pumping = true;
    try {
      while (!c.disposed) {
        if (!c.state.connected && !c.state.profile.autoReconnect) {
          for (const w of c.waiters.splice(0)) { this.detach(w); w.reject(new Error(c.state.error || 'Verbinding verbroken.')); }
          break;
        }
        const index = c.waiters.findIndex(w => this.eligible(c, w) !== undefined);
        if (index < 0) break;
        const w = c.waiters[index]; const choice = this.eligible(c, w)!;
        if (choice === 'replace') { await this.drop(c, [...c.slots].find(s => s.purpose !== w.purpose && !s.busy && !s.broken && s.session)!); continue; }
        c.waiters.splice(index, 1); this.detach(w);
        const slot = choice === 'new' ? { purpose: w.purpose, busy: true, broken: false } as Slot : choice;
        this.clearIdle(slot);
        slot.busy = true;
        if (choice === 'new') c.slots.add(slot);
        // Session establishment runs concurrently, but the reservation was made synchronously.
        void this.deliver(c, slot, w);
      }
    } finally { c.pumping = false; }
  }
  private async deliver(c: Connection, slot: Slot, w: Waiter): Promise<void> {
    let leased = false;
    // Keep credentials in this in-flight scope so disconnect cannot disable error redaction.
    let operationCredentials = c.credentials;
    const abort = () => { if (!leased) w.reject(cancelled()); void this.drop(c, slot).then(() => this.pump(c)); };
    w.signal?.addEventListener('abort', abort, { once: true });
    try {
      if (w.signal?.aborted) throw cancelled();
      if (!slot.session) {
        const secret = c.credentials ?? await this.credentials(c.state.id);
        operationCredentials = secret;
        if (c.disposed || w.signal?.aborted) throw cancelled();
        c.credentials = { ...secret };
        slot.opening = this.factory({ ...c.state.profile }, { ...secret });
        const session = await slot.opening;
        slot.session = session;
        // Abort/disconnect may have removed the reservation while the handshake was pending.
        if (c.disposed || slot.broken || w.signal?.aborted) { await this.drop(c, slot); throw cancelled(); }
      }
      if (c.disposed || w.signal?.aborted || slot.broken) throw cancelled();
      c.state.connected = true; delete c.state.error; this.emit();
      let released = false;
      let activeOperations = 0;
      const wrapped = new Proxy(slot.session, {
        get: (target, key) => {
          if (key === 'close') return async () => { if (released) return; await this.drop(c, slot); void this.pump(c); };
          const method = Reflect.get(target, key);
          if (typeof method !== 'function') return method;
          return async (...args: unknown[]) => {
            if (released || slot.broken || c.disposed) throw new Error('Sessie is gesloten.');
            activeOperations++;
            try { return await method.apply(target, args); }
            catch (error) {
              const safeError = sanitizedError(error, operationCredentials);
              if (slot.purpose === 'transfer' || transportFailure(error)) {
                if (c.slots.has(slot) && !c.disposed) {
                  c.state.error = cleanMessage(error, operationCredentials);
                  if (slot.purpose === 'navigation' || c.state.profile.connectionLimit === 1) c.state.connected = false;
                }
                await this.drop(c, slot); this.emit(); void this.pump(c);
              }
              throw safeError;
            } finally { activeOperations--; }
          };
        }
      });
      leased = true;
      w.resolve({ session: wrapped, release: async () => {
        if (released) return; released = true;
        w.signal?.removeEventListener('abort', abort);
        // A caller releasing an unfinished command cannot make its transport available to another lease.
        if (activeOperations || slot.broken || c.disposed) await this.drop(c, slot);
        else this.park(c, slot);
        await this.pump(c);
      } });
    } catch (error) {
      w.signal?.removeEventListener('abort', abort);
      await this.drop(c, slot);
      if (!c.disposed && !w.signal?.aborted) {
        if (![...c.slots].some(s => s.purpose === 'navigation' && s.session && !s.broken)) c.state.connected = false;
        c.state.error = cleanMessage(error, operationCredentials); this.emit();
      }
      w.reject(w.signal?.aborted ? cancelled() : sanitizedError(error, operationCredentials));
      void this.pump(c);
    }
  }
}

function normalizePath(path: string): string {
  if (typeof path !== 'string' || !path.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(path) || path.split('/').includes('..')) throw new Error('Ongeldig remote pad: absolute paden zonder .., backslashes of controletekens zijn vereist.');
  return posix.normalize(path).replace(/\/$/, '') || '/';
}
function confined(profile: ConnectionProfile, path: string): string {
  const normalized = normalizePath(path); const root = normalizePath(profile.remoteRoot || '/');
  if (root !== '/' && normalized !== root && !normalized.startsWith(root + '/')) throw new Error('Remote pad valt buiten de ingestelde hoofdmap.');
  return normalized;
}
function missing(error: unknown): boolean { return (error as { code?: unknown })?.code === 2 || (error as { code?: unknown })?.code === 'ENOENT'; }
function checkMode(mode: string): void { if (!/^[0-7]{3,4}$/.test(mode)) throw new Error('Rechten moeten 3 of 4 octale cijfers bevatten.'); }
function checkOffset(offset: number): void { if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Ongeldige hervatpositie.'); }

abstract class ProtocolSession implements RemoteSession {
  protected closed = false;
  protected activity: () => void = () => undefined;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(protected readonly profile: ConnectionProfile) {}
  protected run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(cancelled());
    const invoke = async (): Promise<T> => {
      if (this.closed) throw Object.assign(new Error('Verbinding gesloten.'), { code: 'ENOTCONN' });
      if (signal?.aborted) throw cancelled();
      let rejectAbort: ((error: Error) => void) | undefined;
      const abort = () => { void this.close(); rejectAbort?.(cancelled()); };
      signal?.addEventListener('abort', abort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let activeOperation = true;
      const timeout = new Promise<never>((_, reject) => {
        this.activity = () => {
          if (!activeOperation) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => { void this.close(); reject(Object.assign(new Error('Remote verbinding reageert niet binnen de ingestelde timeout.'), { code: 'ETIMEDOUT' })); }, this.profile.timeoutMs);
        };
        this.activity();
      });
      try {
        const active = operation();
        return await Promise.race([active, timeout, ...(signal ? [new Promise<never>((_, reject) => { rejectAbort = reject; if (signal.aborted) abort(); })] : [])]);
      } catch (error) { if (transportFailure(error)) await this.close(); throw error; }
      finally { activeOperation = false; signal?.removeEventListener('abort', abort); if (timer) clearTimeout(timer); this.activity = () => undefined; }
    };
    const result = this.chain.then(invoke); this.chain = result.catch(() => undefined);
    if (!signal) return result;
    let abort: (() => void) | undefined;
    const waiting = new Promise<never>((_, reject) => { abort = () => reject(cancelled()); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); });
    return Promise.race([result, waiting]).finally(() => { if (abort) signal.removeEventListener('abort', abort); });
  }
  protected path(path: string): string { return confined(this.profile, path); }
  abstract list(path: string, signal?: AbortSignal): Promise<FileEntry[]>;
  abstract stat(path: string): Promise<FileEntry | null>;
  abstract mkdir(path: string): Promise<void>;
  abstract rename(from: string, to: string): Promise<void>;
  abstract remove(path: string, directory: boolean): Promise<void>;
  abstract chmod(path: string, mode: string): Promise<void>;
  abstract upload(localPath: string, remotePath: string, onProgress: (progress: TransferProgress) => void, signal: AbortSignal, offset?: number): Promise<void>;
  abstract download(remotePath: string, localPath: string, onProgress: (progress: TransferProgress) => void, signal: AbortSignal, offset?: number): Promise<void>;
  abstract close(): Promise<void>;
}

function childPath(parent: string, name: string): string {
  if (!name || name === '.' || name === '..' || /[\/\\\x00-\x1f\x7f]/.test(name)) throw new Error('Server stuurde een onveilige bestandsnaam.');
  return posix.join(parent, name);
}
function ancestors(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  return parts.map((_, index) => '/' + parts.slice(0, index + 1).join('/'));
}
function refuseLink(entry: FileEntry | null): void { if (entry?.kind === 'symlink') throw new Error('Symbolische koppelingen mogen niet worden gevolgd.'); }
function refuseRoot(profile: ConnectionProfile, path: string): void { if (path === '/' || path === normalizePath(profile.remoteRoot)) throw new Error('De ingestelde hoofdmap mag niet worden verwijderd of hernoemd.'); }
type ByteCounter = Transform & { transferred: number };
function counter(offset: number, total: number, onProgress: (progress: TransferProgress) => void, activity: () => void, close: () => Promise<void>): ByteCounter {
  if (!Number.isSafeInteger(total) || total < 0 || offset > total) throw new Error('Server stuurde een ongeldige bestandsgrootte.');
  onProgress({ transferred: offset, total });
  const stream = new Transform({ transform(chunk, _encoding, callback) {
    if (chunk.length > total - stream.transferred) {
      const error = Object.assign(new Error('Overdracht overschrijdt de aangekondigde bestandsgrootte.'), { code: 'ERR_TRANSFER_SIZE' });
      // Reject before forwarding this chunk: disk writes can never exceed the announced size.
      void close().catch(() => undefined);
      callback(error);
      return;
    }
    stream.transferred += chunk.length;
    try { activity(); onProgress({ transferred: stream.transferred, total }); callback(null, chunk); } catch (error) { callback(error as Error); }
  } }) as ByteCounter;
  stream.transferred = offset;
  return stream;
}
function verifyTransferred(stream: ByteCounter, total: number): void { if (stream.transferred !== total) throw new Error('Bestandsgrootte is tijdens de overdracht gewijzigd.'); }
async function verifyLocalOffset(path: string, offset: number): Promise<void> {
  checkOffset(offset);
  if (offset && (await localStat(path)).size !== offset) throw new Error('Lokale bestandsgrootte wijkt af van de hervatpositie.');
}

/** FTP metadata relies on MLSD/LIST. Servers omitting link types cannot provide race-free containment. */
class FtpSession extends ProtocolSession {
  constructor(profile: ConnectionProfile, private readonly client: FtpClient) { super(profile); }
  private entry(info: FileInfo, parent: string): FileEntry {
    return { name: info.name, path: childPath(parent, info.name), kind: info.isSymbolicLink ? 'symlink' : info.isDirectory ? 'directory' : 'file', size: info.size, modifiedAt: info.modifiedAt?.getTime() ?? null, precisionMs: info.modifiedAt ? 1000 : undefined };
  }
  private async rawStat(path: string): Promise<FileEntry | null> {
    if (path === '/') return { name: '/', path, kind: 'directory', size: 0, modifiedAt: null };
    const infos = await this.client.list(posix.dirname(path));
    this.activity();
    const info = infos.find(entry => entry.name === posix.basename(path));
    return info ? this.entry(info, posix.dirname(path)) : null;
  }
  private async guard(path: string, allowMissing = false): Promise<FileEntry | null> {
    let entry: FileEntry | null = { name: '/', path: '/', kind: 'directory', size: 0, modifiedAt: null };
    for (const component of ancestors(path)) {
      entry = await this.rawStat(component); refuseLink(entry);
      if (!entry) { if (allowMissing) return null; throw Object.assign(new Error('Remote bestand of map bestaat niet.'), { code: 'ENOENT' }); }
      if (component !== path && entry.kind !== 'directory') throw new Error('Een onderdeel van het remote pad is geen map.');
    }
    return entry;
  }
  list(path: string, signal?: AbortSignal): Promise<FileEntry[]> {
    return this.run(async () => {
      const safe = this.path(path); const entry = await this.guard(safe);
      if (entry?.kind !== 'directory') throw new Error('Remote pad is geen map.');
      return (await this.client.list(safe)).filter(info => info.name !== '.' && info.name !== '..').map(info => this.entry(info, safe));
    }, signal);
  }
  stat(path: string): Promise<FileEntry | null> { return this.run(async () => this.guard(this.path(path), true)); }
  mkdir(path: string): Promise<void> { return this.run(async () => { const safe = this.path(path); await this.guard(safe, true); await this.client.ensureDir(safe); await this.client.cd('/'); }); }
  rename(from: string, to: string): Promise<void> { return this.run(async () => {
    const source = this.path(from); const destination = this.path(to); refuseRoot(this.profile, source); refuseRoot(this.profile, destination);
    await this.guard(source); await this.guard(destination, true); await this.client.rename(source, destination);
  }); }
  remove(path: string, directory: boolean): Promise<void> { return this.run(async () => {
    const safe = this.path(path); refuseRoot(this.profile, safe); const entry = await this.guard(safe);
    if (directory !== (entry?.kind === 'directory')) throw new Error('Bestandstype is gewijzigd.');
    // Empty-only deletion: callers must explicitly traverse and confirm recursive deletion.
    if (directory) await this.client.removeEmptyDir(safe); else await this.client.remove(safe);
  }); }
  chmod(path: string, mode: string): Promise<void> { return this.run(async () => { checkMode(mode); const safe = this.path(path); await this.guard(safe); await this.client.send(`SITE CHMOD ${mode} ${safe}`); }); }
  upload(localPath: string, remotePath: string, onProgress: (progress: TransferProgress) => void, signal: AbortSignal, offset = 0): Promise<void> {
    return this.run(async () => {
      checkOffset(offset); const safe = this.path(remotePath); const destination = await this.guard(safe, true);
      if (destination?.kind === 'directory') throw new Error('Uploadbestemming is een map.');
      const total = (await localStat(localPath)).size;
      if (offset > total || (offset > 0 && destination?.size !== offset)) throw new Error('Remote bestandsgrootte wijkt af van de hervatpositie.');
      const progress = counter(offset, total, onProgress, this.activity, () => this.close());
      progress.on('error', () => undefined);
      const source = createReadStream(localPath, { start: offset });
      source.on('error', error => progress.destroy(error)); source.pipe(progress);
      const abort = () => { source.destroy(); progress.destroy(cancelled()); };
      signal.addEventListener('abort', abort, { once: true });
      try { if (offset) await this.client.appendFrom(progress, safe); else await this.client.uploadFrom(progress, safe); verifyTransferred(progress, total); onProgress({ transferred: total, total }); }
      finally { signal.removeEventListener('abort', abort); source.destroy(); progress.destroy(); }
    }, signal);
  }
  download(remotePath: string, localPath: string, onProgress: (progress: TransferProgress) => void, signal: AbortSignal, offset = 0): Promise<void> {
    return this.run(async () => {
      const safe = this.path(remotePath); const entry = await this.guard(safe);
      if (entry?.kind !== 'file') throw new Error('Downloadbron is geen gewoon bestand.');
      await verifyLocalOffset(localPath, offset);
      if (offset > entry.size) throw new Error('Hervatpositie ligt voorbij het remote bestand.');
      const progress = counter(offset, entry.size, onProgress, this.activity, () => this.close());
      const output = createWriteStream(localPath, { flags: offset ? 'r+' : 'w', start: offset });
      progress.on('error', error => output.destroy(error)); output.on('error', error => progress.destroy(error)); progress.pipe(output);
      const done = finished(output); void done.catch(() => undefined);
      const abort = () => { progress.destroy(cancelled()); output.destroy(cancelled()); };
      signal.addEventListener('abort', abort, { once: true });
      try { await this.client.downloadTo(progress, safe, offset); progress.end(); await done; verifyTransferred(progress, entry.size); onProgress({ transferred: entry.size, total: entry.size }); }
      finally { signal.removeEventListener('abort', abort); progress.destroy(); output.destroy(); }
    }, signal);
  }
  async close(): Promise<void> { this.closed = true; this.client.close(); }
}

interface SftpStats { size: number; mode: number; modifyTime: number; isDirectory: boolean; isFile: boolean; isSymbolicLink: boolean; }
class SftpSession extends ProtocolSession {
  constructor(profile: ConnectionProfile, private readonly client: SftpClient) { super(profile); }
  private entry(stats: SftpStats, path: string): FileEntry {
    if (!stats.isSymbolicLink && !stats.isDirectory && !stats.isFile) throw new Error('Speciale remote bestandstypen (FIFO, apparaat of socket) worden niet ondersteund.');
    return { name: posix.basename(path) || '/', path, kind: stats.isSymbolicLink ? 'symlink' : stats.isDirectory ? 'directory' : 'file', size: stats.size, modifiedAt: Number.isFinite(stats.modifyTime) ? stats.modifyTime : null, precisionMs: 1000, permissions: (stats.mode & 0o7777).toString(8).padStart(3, '0') };
  }
  private async rawStat(path: string): Promise<FileEntry | null> { try { const result = this.entry(await this.client.lstat(path), path); this.activity(); return result; } catch (error) { if (missing(error)) return null; throw error; } }
  private async guard(path: string, allowMissing = false): Promise<FileEntry | null> {
    let entry = await this.rawStat('/'); refuseLink(entry);
    for (const component of ancestors(path)) {
      entry = await this.rawStat(component); refuseLink(entry);
      if (!entry) { if (allowMissing) return null; throw Object.assign(new Error('Remote bestand of map bestaat niet.'), { code: 'ENOENT' }); }
      if (component !== path && entry.kind !== 'directory') throw new Error('Een onderdeel van het remote pad is geen map.');
    }
    return entry;
  }
  list(path: string, signal?: AbortSignal): Promise<FileEntry[]> { return this.run(async () => {
    const safe = this.path(path); const directory = await this.guard(safe);
    if (directory?.kind !== 'directory') throw new Error('Remote pad is geen map.');
    const entries: FileEntry[] = [];
    for (const info of (await this.client.list(safe)).filter(info => info.name !== '.' && info.name !== '..')) {
      if (!['l', 'd', '-'].includes(info.type)) throw new Error('Speciale remote bestandstypen (FIFO, apparaat of socket) worden niet ondersteund.');
      const path = childPath(safe, info.name);
      // ssh2-sftp-client can flatten special READDIR entries to '-'; verify their actual mode.
      if (info.type === '-') {
        const actual = await this.rawStat(path);
        if (actual?.kind !== 'file') throw new Error('Remote bestandstype is tijdens het uitlezen gewijzigd.');
      }
      entries.push({ name: info.name, path, kind: info.type === 'l' ? 'symlink' : info.type === 'd' ? 'directory' : 'file', size: info.size, modifiedAt: Number.isFinite(info.modifyTime) ? info.modifyTime : null, precisionMs: 1000, permissions: `${info.rights.user}${info.rights.group}${info.rights.other}` });
    }
    return entries;
  }, signal); }
  stat(path: string): Promise<FileEntry | null> { return this.run(() => this.guard(this.path(path), true)); }
  mkdir(path: string): Promise<void> { return this.run(async () => { const safe = this.path(path); await this.guard(safe, true); await this.client.mkdir(safe, true); }); }
  rename(from: string, to: string): Promise<void> { return this.run(async () => { const source = this.path(from); const destination = this.path(to); refuseRoot(this.profile, source); refuseRoot(this.profile, destination); await this.guard(source); await this.guard(destination, true); await this.client.rename(source, destination); }); }
  remove(path: string, directory: boolean): Promise<void> { return this.run(async () => { const safe = this.path(path); refuseRoot(this.profile, safe); const entry = await this.guard(safe); if (directory !== (entry?.kind === 'directory')) throw new Error('Bestandstype is gewijzigd.'); if (directory) await this.client.rmdir(safe, false); else await this.client.delete(safe, false); }); }
  chmod(path: string, mode: string): Promise<void> { return this.run(async () => { checkMode(mode); const safe = this.path(path); await this.guard(safe); await this.client.chmod(safe, Number.parseInt(mode, 8)); }); }
  upload(localPath: string, remotePath: string, onProgress: (progress: TransferProgress) => void, signal: AbortSignal, offset = 0): Promise<void> {
    return this.run(async () => {
      checkOffset(offset); const safe = this.path(remotePath); const destination = await this.guard(safe, true);
      if (destination?.kind === 'directory') throw new Error('Uploadbestemming is een map.');
      const total = (await localStat(localPath)).size;
      if (offset > total || (offset > 0 && destination?.size !== offset)) throw new Error('Remote bestandsgrootte wijkt af van de hervatpositie.');
      const progress = counter(offset, total, onProgress, this.activity, () => this.close());
      progress.on('error', () => undefined);
      const source = createReadStream(localPath, { start: offset });
      source.on('error', error => progress.destroy(error)); source.pipe(progress);
      const abort = () => { source.destroy(); progress.destroy(cancelled()); }; signal.addEventListener('abort', abort, { once: true });
      try { await this.client.put(progress, safe, { writeStreamOptions: { flags: offset ? 'r+' : 'w', start: offset, autoClose: true } }); verifyTransferred(progress, total); onProgress({ transferred: total, total }); }
      finally { signal.removeEventListener('abort', abort); source.destroy(); progress.destroy(); }
    }, signal);
  }
  download(remotePath: string, localPath: string, onProgress: (progress: TransferProgress) => void, signal: AbortSignal, offset = 0): Promise<void> {
    return this.run(async () => {
      const safe = this.path(remotePath); const entry = await this.guard(safe); if (entry?.kind !== 'file') throw new Error('Downloadbron is geen gewoon bestand.');
      await verifyLocalOffset(localPath, offset); if (offset > entry.size) throw new Error('Hervatpositie ligt voorbij het remote bestand.');
      const progress = counter(offset, entry.size, onProgress, this.activity, () => this.close());
      const output = createWriteStream(localPath, { flags: offset ? 'r+' : 'w', start: offset });
      progress.on('error', error => output.destroy(error)); output.on('error', error => progress.destroy(error)); progress.pipe(output);
      const done = finished(output); void done.catch(() => undefined);
      const abort = () => { progress.destroy(cancelled()); output.destroy(cancelled()); }; signal.addEventListener('abort', abort, { once: true });
      try { await this.client.get(safe, progress, { readStreamOptions: { start: offset, autoClose: true } }); progress.end(); await done; verifyTransferred(progress, entry.size); onProgress({ transferred: entry.size, total: entry.size }); }
      finally { signal.removeEventListener('abort', abort); progress.destroy(); output.destroy(); }
    }, signal);
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    // Destroy the SSH socket after requesting shutdown; no hanging stream survives cancellation.
    const ending = this.client.end();
    const underlying = (this.client as unknown as { client?: { destroy(): void } }).client;
    underlying?.destroy();
    await ending.catch(() => undefined);
  }
}

/** OpenSSH SHA256 pins use unpadded base64; an absent pin intentionally refuses TOFU. */
function fingerprintPin(pin: string | undefined): Buffer | undefined {
  if (!pin) return undefined;
  const encoded = pin.replace(/^SHA256:/i, '').replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]{43}$/.test(encoded)) throw new Error('SSH-hostsleutel moet een SHA256-vingerafdruk in OpenSSH-notatie zijn.');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64').replace(/=+$/, '') !== encoded) throw new Error('Ongeldige SHA256-vingerafdruk.');
  return bytes;
}
export async function createProtocolSession(profile: ConnectionProfile, credentials: Credentials): Promise<RemoteSession> {
  profile = validateProfile(profile);
  if (profile.protocol === 'sftp') {
    const pin = fingerprintPin(profile.hostKeySha256); let observed: string | undefined;
    const client = new SftpClient('FTP Studio');
    try {
      const privateKey = profile.privateKeyPath ? await readFile(profile.privateKeyPath) : undefined;
      if (!privateKey && credentials.password === undefined) throw new Error('SFTP vereist een wachtwoord of een private sleutel.');
      await client.connect({ host: profile.host, port: profile.port, username: profile.username, password: credentials.password, privateKey, passphrase: credentials.passphrase, readyTimeout: profile.timeoutMs, retries: 0,
        hostVerifier: (key: Buffer) => {
          const digest = createHash('sha256').update(key).digest(); observed = `SHA256:${digest.toString('base64').replace(/=+$/, '')}`;
          return !!pin && timingSafeEqual(pin, digest);
        }
      });
      const session = new SftpSession(profile, client);
      const root = await session.stat(profile.remoteRoot);
      if (root?.kind !== 'directory') throw new Error('Remote hoofdmap bestaat niet of is geen map.');
      return session;
    } catch (error) {
      const underlying = (client as unknown as { client?: { destroy(): void } }).client;
      underlying?.destroy(); await client.end().catch(() => undefined);
      if (observed && (!pin || !timingSafeEqual(pin, Buffer.from(observed.slice(7), 'base64')))) throw new Error(`${pin ? 'SSH-hostsleutel wijkt af van de opgeslagen sleutel' : 'Onbekende SSH-hostsleutel'}: ${observed}. Controleer deze vingerafdruk via een vertrouwd kanaal en sla hem op in het profiel.`);
      throw error;
    }
  }
  if (credentials.password && /[\r\n\0]/.test(credentials.password)) throw new Error('FTP-wachtwoord bevat ongeldige controletekens.');
  const client = new FtpClient(profile.timeoutMs);
  try {
    await client.access({ host: profile.host, port: profile.port, user: profile.username, password: credentials.password ?? '', secure: profile.protocol === 'ftps-implicit' ? 'implicit' : profile.protocol === 'ftps', secureOptions: { rejectUnauthorized: true, servername: isIP(profile.host) ? undefined : profile.host, checkServerIdentity: (_hostname, certificate) => checkServerIdentity(profile.host, certificate) } });
    const session = new FtpSession(profile, client);
    const root = await session.stat(profile.remoteRoot);
    if (root?.kind !== 'directory') throw new Error('Remote hoofdmap bestaat niet of is geen map.');
    return session;
  } catch (error) { client.close(); throw error; }
}
