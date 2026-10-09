import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ConnectionProfile, FileEntry, FileSnapshot, KeyValueStore, Logger, RemoteAccess, RemoteSession, TransferJob, TransferRequest } from '../shared/contracts';
import { endpointIdentity } from '../core/connectionIdentity';
export { endpointIdentity } from '../core/connectionIdentity';

const STORE_KEY = 'transferQueue.v1';
const EXCLUDED = new Set(['.git', '.idea', '.vs', 'node_modules', 'cache', '.cache', 'backups', 'backup']);
const MAX_ATTEMPTS = 4;
const MAX_ACTIVE = 32;
const MAX_EXPANSION = 100_000;
const terminal = new Set(['completed', 'failed', 'cancelled', 'conflict']);
type Transaction = { stage: string; backup?: string; phase: 'prepared' | 'backed-up' | 'installed' };
type Record = { job: TransferJob; kind: 'file' | 'directory'; endpoint?: string; readyAt?: number; transaction?: Transaction };
type Running = { controller: AbortController; desired?: 'paused' | 'cancelled'; promise: Promise<void>; committing: boolean };

class Conflict extends Error { override name = 'Conflict'; }
class UnsafePath extends Error { override name = 'UnsafePath'; }

function abort(signal: AbortSignal): void { if (signal.aborted) throw new DOMException('Overdracht onderbroken.', 'AbortError'); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }
function snapshot(entry: FileEntry | null): FileSnapshot | null {
  if (entry && entry.kind !== 'file') throw new Conflict(`Extern pad is geen gewoon bestand: ${entry.path}`);
  return entry ? { size: entry.size, modifiedAt: entry.modifiedAt, ...(entry.checksum ? { checksum: entry.checksum } : {}) } : null;
}
function same(expected: FileSnapshot | null | undefined, actual: FileSnapshot | null): boolean {
  if (expected == null || actual == null) return expected === actual;
  // Size alone cannot establish an unchanged remote version.
  if (expected.modifiedAt === null && !expected.checksum) return false;
  return expected.size === actual.size && expected.modifiedAt === actual.modifiedAt && (!expected.checksum || expected.checksum === actual.checksum);
}
function guard(expected: FileSnapshot | null | undefined, actual: FileSnapshot | null, label: string): void {
  if (expected && expected.modifiedAt === null && !expected.checksum) throw new Conflict(`${label} kan niet veilig worden vergeleken: tijdstempel en controlesom ontbreken.`);
  if (!same(expected, actual)) throw new Conflict(`${label} is sinds het inplannen gewijzigd. Controleer beide versies en plan opnieuw in.`);
}
function sensitive(name: string): boolean {
  return /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?)$/i.test(name) || /\.(?:pem|key|p12|pfx|kdbx)$/i.test(name);
}
function permitted(relative: string, allowSensitive = false): boolean {
  const parts = relative.split(/[\\/]/).filter(Boolean);
  return !parts.some(p => EXCLUDED.has(p.toLowerCase()) || p.includes('.ftp-studio-') || (!allowSensitive && sensitive(p)));
}
function localContained(root: string, target: string): string {
  if (!path.isAbsolute(root) || !path.isAbsolute(target) || target.includes('\0')) throw new UnsafePath('Een absoluut lokaal pad is verplicht.');
  const resolved = path.resolve(target), relative = path.relative(path.resolve(root), resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new UnsafePath('Het lokale pad valt buiten de verbindingsmap.');
  if (process.platform === 'win32' && relative.split(path.sep).some(part => /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new UnsafePath('Onveilige Windows-bestandsnaam.');
  return resolved;
}
async function localSafe(root: string, target: string): Promise<void> {
  const resolved = localContained(root, target);
  let current = path.parse(resolved).root;
  for (const component of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat;
    try { stat = await fs.lstat(current); } catch (error) { if (missing(error)) return; throw error; }
    if (stat.isSymbolicLink()) throw new UnsafePath(`Symbolische koppeling geweigerd: ${current}`);
    if (current !== resolved && !stat.isDirectory()) throw new UnsafePath(`Geen map: ${current}`);
  }
}
function remoteContained(root: string, target: string): string {
  for (const value of [root, target]) {
    if (!value.startsWith('/') || value.includes('\\') || /[\x00-\x1f\x7f]/.test(value) || value.split('/').includes('..')) throw new UnsafePath('Ongeldig extern pad of padontsnapping.');
  }
  const normalizedRoot = path.posix.normalize(root), normalized = path.posix.normalize(target);
  const relative = path.posix.relative(normalizedRoot, normalized);
  if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) throw new UnsafePath('Het externe pad valt buiten de verbindingsmap.');
  return normalized;
}
async function remoteSafe(session: RemoteSession, root: string, target: string): Promise<FileEntry | null> {
  const normalized = remoteContained(root, target);
  const normalizedRoot = path.posix.normalize(root).replace(/\/$/, '') || '/';
  let current = normalizedRoot;
  // The protocol adapter checks ancestors above its root internally; its public API correctly forbids accessing them.
  const parts = path.posix.relative(normalizedRoot, normalized).split('/').filter(Boolean);
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) current = path.posix.join(current, parts[index]);
    const entry = await session.stat(current);
    if (!entry) return null;
    if (entry.kind === 'symlink') throw new UnsafePath(`Externe symbolische koppeling geweigerd: ${current}`);
    if (index < parts.length - 1 && entry.kind !== 'directory') throw new UnsafePath(`Geen externe map: ${current}`);
    if (index === parts.length - 1) return entry;
  }
  return null;
}
async function localSnapshot(root: string, target: string): Promise<FileSnapshot | null> {
  await localSafe(root, target);
  let handle;
  try {
    if (!(await fs.lstat(target)).isFile()) throw new Conflict(`Geen gewoon bestand: ${target}`);
    handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) { if (missing(error)) return null; throw error; }
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Conflict(`Geen gewoon bestand: ${target}`);
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(128 * 1024);
    let bytes = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break;
      if ((bytes += bytesRead) > before.size) throw new Conflict(`Lokaal bestand groeit tijdens controle: ${target}`);
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (bytes !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Conflict(`Lokaal bestand gewijzigd tijdens controle: ${target}`);
    return { size: after.size, modifiedAt: after.mtimeMs, checksum: hash.digest('hex') };
  } finally { await handle.close(); }
}
async function privateSourceCopy(root: string, source: string, destination: string, expectedSize: number): Promise<void> {
  await localSafe(root, source);
  const input = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!(await input.stat()).isFile()) throw new Conflict('De lokale bron is geen gewoon bestand meer.');
    const output = await fs.open(destination, 'wx', 0o600);
    try {
      let bytes = 0;
      for await (const chunk of input.createReadStream({ autoClose: false })) {
        bytes += chunk.length;
        if (bytes > expectedSize) throw new Conflict('De lokale bron groeit tijdens het vastleggen.');
        await output.writeFile(chunk);
      }
    } finally { await output.close(); }
  } finally { await input.close(); }
}
async function ensureLocalDirectory(root: string, directory: string): Promise<void> {
  localContained(root, directory);
  await localSafe(root, root);
  if (!(await fs.lstat(root)).isDirectory()) throw new UnsafePath('De lokale verbindingsmap bestaat niet.');
  const parts = path.relative(path.resolve(root), path.resolve(directory)).split(path.sep).filter(Boolean);
  let current = path.resolve(root);
  for (const part of parts) {
    current = path.join(current, part);
    try { await fs.mkdir(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new UnsafePath(`Onveilige lokale map: ${current}`);
  }
}
async function ensureRemoteDirectory(session: RemoteSession, root: string, directory: string): Promise<void> {
  remoteContained(root, directory);
  let current = path.posix.normalize(root).replace(/\/$/, '') || '/';
  const rootEntry = await session.stat(current);
  if (!rootEntry || rootEntry.kind !== 'directory') throw new UnsafePath('De externe verbindingsmap bestaat niet of is onveilig.');
  for (const part of path.posix.relative(current, directory).split('/').filter(Boolean)) {
    current = path.posix.join(current, part);
    let entry = await session.stat(current);
    if (!entry) {
      // Never create ancestors outside the configured root.
      remoteContained(root, current);
      try { await session.mkdir(current); } catch (error) { if (!await session.stat(current)) throw error; }
      entry = await session.stat(current);
    }
    if (!entry || entry.kind !== 'directory') throw new UnsafePath(`Onveilige externe map: ${current}`);
  }
}

/** Transfers restart from byte zero. A generic protocol lease cannot establish safe resumability. */
export class TransferQueue {
  private records: Record[] = [];
  private running = new Map<string, Running>();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private scheduled = false;

  constructor(private remote: RemoteAccess, private store: KeyValueStore, private logger: Logger,
    private onChange: (jobs: TransferJob[]) => void, private onCompleted?: (job: TransferJob) => Promise<void> | void,
    private include?: (request: TransferRequest, entry: FileEntry) => boolean | Promise<boolean>,
    private options: { trustedCacheRoot?: string } = {}) {
    const saved = store.get<Record[]>(STORE_KEY, []);
    this.records = (Array.isArray(saved) ? saved : []).filter(record => record?.job?.id && ['file', 'directory'].includes(record.kind)).map(record => {
      const copy = structuredClone(record);
      if (!terminal.has(copy.job.status)) {
        copy.job.status = 'paused';
        copy.job.speed = 0;
        copy.job.remainingSeconds = null;
        copy.job.error = 'Hersteld na afsluiten. Hervatten vereist een expliciete opdracht; overdracht begint opnieuw.';
      }
      return copy;
    });
    // Deliberately do not schedule restored records.
    this.persist();
  }

  jobs(): TransferJob[] { return this.records.map(record => structuredClone(record.job)); }

  private localRoot(request: TransferRequest, profileRoot: string): string {
    try { localContained(profileRoot, request.localPath); return profileRoot; } catch (error) {
      const cache = this.options.trustedCacheRoot;
      if (!cache || request.direction !== 'upload' || request.expectedRemote === undefined) throw error;
      const resolved = localContained(cache, request.localPath);
      if (resolved === path.resolve(cache)) throw new UnsafePath('Alleen een afzonderlijk bewaakt cachebestand mag worden geüpload.');
      return cache;
    }
  }

  async enqueue(requests: TransferRequest[]): Promise<TransferJob[]> {
    if (this.closed) throw new Error('De overdrachtswachtrij is gesloten.');
    const additions: Record[] = [];
    let expanded = 0;
    // Expansion is transactional: no partial queue when a later path is unsafe.
    for (const supplied of requests) {
      const request = structuredClone(supplied);
      const profile = this.remote.profile(request.connectionId);
      const endpoint = endpointIdentity(profile);
      if (request.expectedEndpoint !== undefined && request.expectedEndpoint !== endpoint) throw new Conflict('De verbindingsbestemming is gewijzigd. Open het oorspronkelijke document opnieuw voordat u overdraagt.');
      request.expectedEndpoint = endpoint;
      const localRoot = this.localRoot(request, profile.localRoot);
      request.localPath = localContained(localRoot, request.localPath);
      request.remotePath = remoteContained(profile.remoteRoot, request.remotePath);
      await localSafe(localRoot, request.localPath);
      if (localRoot !== profile.localRoot && !(await fs.lstat(request.localPath)).isFile()) throw new UnsafePath('Alleen een afzonderlijk bewaakt cachebestand mag worden geüpload.');
      const lease = await this.remote.acquire(request.connectionId, 'transfer');
      try {
        if (endpointIdentity(this.remote.profile(request.connectionId)) !== endpoint) throw new Conflict('De verbinding is tijdens het inplannen gewijzigd. Probeer opnieuw met de juiste server.');
        const walk = async (item: TransferRequest, nested: boolean): Promise<void> => {
          if (++expanded > MAX_EXPANSION) throw new Error('Te veel bestanden of mappen in één opdracht. Plan kleinere mappen afzonderlijk in.');
          const localRelative = path.relative(localRoot, item.localPath);
          const remoteRelative = path.posix.relative(profile.remoteRoot, item.remotePath);
          if (remoteRelative.split('/').length > 256 || localRelative.split(path.sep).length > 256) throw new UnsafePath('De mapstructuur is te diep.');
          if (!permitted(localRelative, item.allowSensitive) || !permitted(remoteRelative, item.allowSensitive)) return;
          await localSafe(localRoot, item.localPath);
          const remoteEntry = await remoteSafe(lease.session, profile.remoteRoot, item.remotePath);
          let localEntry;
          try { localEntry = await fs.lstat(item.localPath); } catch (error) { if (!missing(error)) throw error; }
          if (localEntry?.isSymbolicLink()) throw new UnsafePath('Lokale symbolische koppelingen worden niet overgedragen.');
          const isDirectory = item.direction === 'upload' ? localEntry?.isDirectory() : remoteEntry?.kind === 'directory';
          if (item.direction === 'upload' && !localEntry || item.direction === 'download' && !remoteEntry) throw new Error(`Bron bestaat niet: ${item.direction === 'upload' ? item.localPath : item.remotePath}`);
          const sourceEntry: FileEntry = item.direction === 'upload'
            ? { name: path.basename(item.localPath), path: item.localPath, relativePath: localRelative, kind: isDirectory ? 'directory' : 'file', size: localEntry!.size, modifiedAt: localEntry!.mtimeMs, precisionMs: 1 }
            : { ...remoteEntry!, relativePath: remoteRelative };
          // Callers decide directory inclusion explicitly; rejecting a directory excludes its subtree.
          if (this.include && !await this.include(structuredClone(item), structuredClone(sourceEntry))) return;
          if (isDirectory) {
            if (item.direction === 'upload' && remoteEntry && remoteEntry.kind !== 'directory' || item.direction === 'download' && localEntry && !localEntry.isDirectory()) throw new Conflict('Een doelbestand blokkeert de bronmap.');
            const children = item.direction === 'upload'
              ? (await fs.readdir(item.localPath, { withFileTypes: true })).map(entry => ({ name: entry.name, kind: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file' }))
              : await lease.session.list(item.remotePath);
            if (!children.length) additions.push(this.makeRecord(item, 'directory', undefined, nested, endpoint));
            for (const child of children) {
              if (!child.name || child.name === '.' || child.name === '..' || /[\\/\x00-\x1f\x7f]/.test(child.name)) throw new UnsafePath('Onveilige bestandsnaam in maplijst.');
              if (!permitted(child.name, item.allowSensitive)) continue;
              if (child.kind === 'symlink') throw new UnsafePath(`Symbolische koppeling geweigerd: ${child.name}`);
              const descendant: TransferRequest = { ...item, localPath: path.join(item.localPath, child.name), remotePath: path.posix.join(item.remotePath, child.name) };
              delete descendant.expectedLocal;
              delete descendant.expectedRemote;
              await walk(descendant, true);
            }
            return;
          }
          if (remoteEntry && remoteEntry.kind !== 'file' || localEntry && !localEntry.isFile()) throw new Conflict('Bron of doel is geen gewoon bestand.');
          const local = await localSnapshot(localRoot, item.localPath);
          if (item.expectedLocal === undefined) item.expectedLocal = local;
          if (item.expectedRemote === undefined) item.expectedRemote = snapshot(remoteEntry);
          const source = item.direction === 'upload' ? local : snapshot(remoteEntry);
          if (!source) throw new Error('Het bronbestand ontbreekt.');
          additions.push(this.makeRecord(item, 'file', source, nested, endpoint));
        };
        await walk(request, false);
      } finally { await lease.release(); }
    }
    if (this.closed) throw new Error('De overdrachtswachtrij is gesloten.');
    this.records.push(...additions);
    this.persist();
    this.schedule();
    return additions.map(record => structuredClone(record.job));
  }

  private makeRecord(request: TransferRequest, kind: Record['kind'], sourceSnapshot: FileSnapshot | undefined, nested: boolean, endpoint: string): Record {
    return { kind, endpoint, job: { ...request, id: randomUUID(), priority: Number.isFinite(request.priority) ? Math.max(0, Math.min(100, request.priority!)) : nested ? 10 : 50,
      status: 'queued', size: sourceSnapshot?.size ?? 0, transferred: 0, speed: 0, remainingSeconds: null, attempts: 0, createdAt: Date.now(), sourceSnapshot } };
  }

  async action(action: 'pause' | 'resume' | 'cancel' | 'retry' | 'clear' | 'priority', ids?: string[], priority?: number): Promise<void> {
    const selected = ids ? new Set(ids) : null;
    const pending: Promise<void>[] = [];
    for (const record of this.records) {
      const job = record.job;
      if (selected && !selected.has(job.id)) continue;
      const active = this.running.get(job.id);
      if (action === 'priority') {
        if (!Number.isFinite(priority)) throw new Error('Een geldige prioriteit is verplicht.');
        job.priority = Math.max(0, Math.min(100, priority!));
      } else if ((action === 'pause' || action === 'cancel') && !terminal.has(job.status)) {
        if (active) {
          active.desired = action === 'pause' ? 'paused' : 'cancelled';
          // Once a verified staged file is being installed, finish or roll back the short transaction.
          // Aborting the lease here would close its socket between moving the original and restoring it.
          if (!active.committing) active.controller.abort();
          pending.push(active.promise);
        } else { job.status = action === 'pause' ? 'paused' : 'cancelled'; job.speed = 0; job.remainingSeconds = null; }
      } else if (action === 'resume' && job.status === 'paused' && !active || action === 'retry' && ['failed', 'cancelled', 'conflict'].includes(job.status) && !active) {
        if (this.closed) throw new Error('De overdrachtswachtrij is gesloten.');
        job.status = 'queued'; job.attempts = 0; job.transferred = 0; job.error = undefined; record.readyAt = undefined;
      }
    }
    if (action === 'clear') this.records = this.records.filter(record => !((!selected || selected.has(record.job.id)) && terminal.has(record.job.status) && !record.transaction && !this.running.has(record.job.id)));
    this.persist();
    await Promise.all(pending);
    this.schedule();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    await this.action('pause');
    await Promise.all([...this.running.values()].map(active => active.promise));
  }

  private persist(): void {
    this.store.set(STORE_KEY, structuredClone(this.records));
    try { this.onChange(this.jobs()); } catch (error) { this.log('warning', `Wachtrijmelding mislukt: ${String(error)}`); }
  }
  private log(level: Parameters<Logger>[0], message: string, connectionId?: string): void {
    try { this.logger(level, message, connectionId); } catch { /* Logging must never change transfer outcomes. */ }
  }
  private schedule(): void {
    if (this.closed || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.pump(); });
  }
  private pump(): void {
    if (this.closed) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const counts = new Map<string, number>();
    for (const record of this.records) if (this.running.has(record.job.id)) counts.set(record.job.connectionId, (counts.get(record.job.connectionId) ?? 0) + 1);
    const waiting = this.records.filter(record => record.job.status === 'queued' && !this.running.has(record.job.id))
      .sort((a, b) => (b.job.priority ?? 50) - (a.job.priority ?? 50) || a.job.createdAt - b.job.createdAt);
    let next = Infinity;
    for (const record of waiting) {
      if ((record.readyAt ?? 0) > Date.now()) { next = Math.min(next, record.readyAt!); continue; }
      if (this.running.size >= MAX_ACTIVE) break;
      let profile;
      try { profile = this.remote.profile(record.job.connectionId); } catch {
        record.job.status = 'failed'; record.job.error = 'De verbinding is niet beschikbaar. Maak verbinding en kies opnieuw proberen.'; this.persist(); continue;
      }
      const limit = Math.max(1, Math.min(MAX_ACTIVE, Math.floor(profile.parallelTransfers || 4), Math.floor(profile.connectionLimit || 4)));
      if ((counts.get(record.job.connectionId) ?? 0) >= limit) continue;
      // Two independently queued writes to one path must not both pass an absent-target guard.
      if (this.records.some(other => this.running.has(other.job.id) && (other.job.localPath === record.job.localPath ||
        other.job.connectionId === record.job.connectionId && other.job.remotePath === record.job.remotePath))) continue;
      counts.set(record.job.connectionId, (counts.get(record.job.connectionId) ?? 0) + 1);
      const active: Running = { controller: new AbortController(), committing: false, promise: Promise.resolve() };
      this.running.set(record.job.id, active);
      active.promise = this.run(record, active).catch(error => {
        // Persistence failures must stop scheduling rather than cause untracked replay.
        this.closed = true;
        this.log('error', `Wachtrij gestopt: ${String(error)}`, record.job.connectionId);
      }).finally(() => { this.running.delete(record.job.id); this.schedule(); });
    }
    if (next < Infinity) this.timer = setTimeout(() => this.schedule(), Math.max(1, next - Date.now()));
  }

  private async run(record: Record, active: Running): Promise<void> {
    const job = record.job, signal = active.controller.signal;
    const profile = this.remote.profile(job.connectionId);
    let localRoot = profile.localRoot;
    job.status = 'running'; job.attempts++; job.transferred = 0; job.speed = 0; job.error = undefined;
    this.persist();
    let lease;
    try {
      abort(signal);
      if (record.transaction) throw new Conflict(`Onderbroken bestandswissel vereist controle. Tijdelijk: ${record.transaction.stage}${record.transaction.backup ? `; originele reservekopie: ${record.transaction.backup}` : ''}. Geen automatische herhaling.`);
      const endpoint = endpointIdentity(profile);
      if (!record.endpoint) throw new Conflict('Deze oudere overdracht heeft geen bevestigde verbindingsbestemming. Plan het bestand opnieuw in.');
      if (record.endpoint !== endpoint || job.expectedEndpoint !== undefined && job.expectedEndpoint !== endpoint) throw new Conflict('De verbindingsbestemming is sinds het inplannen gewijzigd. Controleer host, account, sleutel en hoofdmappen; plan daarna opnieuw in.');
      localRoot = this.localRoot(job, profile.localRoot);
      localContained(localRoot, job.localPath);
      remoteContained(profile.remoteRoot, job.remotePath);
      if (!permitted(path.relative(localRoot, job.localPath), job.allowSensitive) || !permitted(path.posix.relative(profile.remoteRoot, job.remotePath), job.allowSensitive)) throw new UnsafePath('Dit pad is uitgesloten van overdracht.');
      lease = await this.remote.acquire(job.connectionId, 'transfer', signal);
      abort(signal);
      if (endpointIdentity(this.remote.profile(job.connectionId)) !== record.endpoint) throw new Conflict('De verbinding is tijdens het openen van de overdrachtssessie gewijzigd. Plan opnieuw in.');
      if (record.kind === 'directory') {
        if (job.direction === 'upload') {
          await localSafe(localRoot, job.localPath);
          if (!(await fs.lstat(job.localPath)).isDirectory()) throw new Conflict('Bronmap bestaat niet meer.');
          await ensureRemoteDirectory(lease.session, profile.remoteRoot, job.remotePath);
        } else {
          if ((await remoteSafe(lease.session, profile.remoteRoot, job.remotePath))?.kind !== 'directory') throw new Conflict('Externe bronmap bestaat niet meer.');
          await ensureLocalDirectory(localRoot, job.localPath);
        }
      } else if (job.direction === 'upload') await this.upload(record, active, lease.session, localRoot, profile.remoteRoot);
      else await this.download(record, active, lease.session, localRoot, profile.remoteRoot);
      job.status = 'completed'; job.transferred = job.size; job.speed = 0; job.remainingSeconds = 0; job.error = undefined; record.readyAt = undefined;
      this.persist();
      this.log('info', `Overdracht voltooid: ${path.basename(job.localPath)}`, job.connectionId);
      // A manifest hook may need another lease even when the profile allows only one session.
      if (lease) {
        const finishedLease = lease; lease = undefined;
        try { await finishedLease.release(); } catch { this.log('warning', 'Overdrachtssessie kon niet netjes worden afgesloten.', job.connectionId); }
      }
      if (this.onCompleted) {
        try { await this.onCompleted(structuredClone(job)); } catch { this.log('warning', 'Bestand overgedragen; vervolgverwerking is mislukt. De overdracht wordt niet herhaald.', job.connectionId); }
      }
    } catch (error) {
      job.speed = 0; job.remainingSeconds = null;
      if (record.transaction) { job.status = 'conflict'; job.error = `Bestandswissel moet handmatig worden gecontroleerd: ${String(error)}. Tijdelijk: ${record.transaction.stage}${record.transaction.backup ? `; reservekopie: ${record.transaction.backup}` : ''}`; }
      else if (signal.aborted) { job.status = active.desired ?? 'paused'; job.error = job.status === 'paused' ? 'Gepauzeerd. Hervatten start veilig opnieuw vanaf nul.' : 'Geannuleerd.'; }
      else if (error instanceof Conflict) { job.status = 'conflict'; job.error = error.message; }
      else if (!(error instanceof UnsafePath) && profile.autoReconnect && job.attempts < MAX_ATTEMPTS) {
        job.status = 'queued'; record.readyAt = Date.now() + Math.min(30_000, 500 * 2 ** (job.attempts - 1)); job.error = 'Verbinding of overdracht mislukt. Een beperkte herhaalpoging is ingepland.';
      } else { job.status = 'failed'; job.error = error instanceof Error ? error.message : 'Overdracht mislukt.'; }
      this.persist();
      this.log(job.status === 'conflict' ? 'warning' : 'error', job.error ?? 'Overdracht onderbroken.', job.connectionId);
    } finally {
      if (lease) try { await lease.release(); } catch { this.log('warning', 'Overdrachtssessie kon niet netjes worden afgesloten.', job.connectionId); }
    }
  }

  private progress(job: TransferJob): (value: { transferred: number; total: number }) => void {
    const start = Date.now();
    let last = 0;
    return value => {
      const now = Date.now();
      job.transferred = Math.max(job.transferred, Math.min(job.size, Number.isFinite(value.transferred) ? value.transferred : 0));
      job.speed = job.transferred / Math.max(0.05, (now - start) / 1000);
      job.remainingSeconds = job.speed > 0 ? Math.max(0, (job.size - job.transferred) / job.speed) : null;
      if (now - last >= 150) { last = now; try { this.onChange(this.jobs()); } catch { /* Observers do not own the transfer. */ } }
    };
  }

  private async upload(record: Record, active: Running, session: RemoteSession, localRoot: string, remoteRoot: string): Promise<void> {
    const job = record.job, signal = active.controller.signal;
    const localSource = await localSnapshot(localRoot, job.localPath);
    guard(job.sourceSnapshot, localSource, 'Lokale bron');
    guard(job.expectedLocal, localSource, 'Lokale bron');
    const existing = await remoteSafe(session, remoteRoot, job.remotePath);
    if (existing && existing.kind !== 'file') throw new Conflict('Extern doel is geen gewoon bestand.');
    guard(job.expectedRemote, snapshot(existing), 'Extern doel');
    await ensureRemoteDirectory(session, remoteRoot, path.posix.dirname(job.remotePath));
    const token = randomUUID(), stage = path.posix.join(path.posix.dirname(job.remotePath), `.${path.posix.basename(job.remotePath)}.ftp-studio-${token}.part`);
    const backup = `${stage}.backup`;
    if (await remoteSafe(session, remoteRoot, stage) || await remoteSafe(session, remoteRoot, backup)) throw new Conflict('Tijdelijke externe bestandsnaam bestaat al.');
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-studio-upload-'));
    const copy = path.join(temporary, 'source');
    let staged = false;
    try {
      // Upload a private immutable copy, not a source that an editor may alter mid-stream.
      await privateSourceCopy(localRoot, job.localPath, copy, job.size);
      const copySnapshot = await localSnapshot(temporary, copy);
      if (!copySnapshot || copySnapshot.size !== job.sourceSnapshot?.size || copySnapshot.checksum !== job.sourceSnapshot?.checksum) throw new Conflict('De lokale bron veranderde tijdens het vastleggen.');
      guard(job.sourceSnapshot, await localSnapshot(localRoot, job.localPath), 'Lokale bron');
      abort(signal);
      staged = true;
      await session.upload(copy, stage, this.progress(job), signal); // No unsupported offset/resume claim.
      abort(signal);
      const uploaded = await remoteSafe(session, remoteRoot, stage);
      if (!uploaded || uploaded.kind !== 'file' || uploaded.size !== job.size) throw new Error('Groottecontrole van het tijdelijke externe bestand is mislukt.');
      if (uploaded.checksum && uploaded.checksum !== copySnapshot.checksum) throw new Conflict('Controlesom van het tijdelijke externe bestand klopt niet.');
      guard(job.sourceSnapshot, await localSnapshot(localRoot, job.localPath), 'Lokale bron');
      guard(job.expectedRemote, snapshot(await remoteSafe(session, remoteRoot, job.remotePath)), 'Extern doel');
      abort(signal);
      active.committing = true;
      record.transaction = { stage, ...(existing ? { backup } : {}), phase: 'prepared' };
      this.persist();
      try {
        if (existing) {
          await session.rename(job.remotePath, backup);
          record.transaction.phase = 'backed-up'; this.persist();
          guard(job.expectedRemote, snapshot(await remoteSafe(session, remoteRoot, backup)), 'Externe reservekopie');
          if (await remoteSafe(session, remoteRoot, job.remotePath)) throw new Conflict('Het externe doel is tijdens de bestandswissel opnieuw aangemaakt.');
        }
        // Generic FTP/SFTP has no conditional rename: re-stat narrows, but cannot eliminate, a concurrent server writer race.
        await session.rename(stage, job.remotePath);
        record.transaction.phase = 'installed'; this.persist();
        const installed = await remoteSafe(session, remoteRoot, job.remotePath);
        if (!installed || installed.kind !== 'file' || !same(snapshot(uploaded), snapshot(installed))) throw new Conflict('Het geïnstalleerde externe bestand kon niet worden bevestigd.');
        if (installed.checksum && installed.checksum !== copySnapshot.checksum) throw new Conflict('Controlesom van het geïnstalleerde externe bestand klopt niet.');
        job.verifiedRemote = snapshot(installed)!;
        job.verifiedLocal = structuredClone(job.sourceSnapshot!);
        record.transaction = undefined; this.persist();
        if (existing) try { await session.remove(backup, false); } catch { this.log('warning', `Overdracht voltooid; reservekopie bewaard: ${backup}`, job.connectionId); }
      } catch (error) {
        if (existing && record.transaction?.phase === 'backed-up') {
          // Restore only into an absent destination. Never overwrite another writer's version.
          try {
            const old = await remoteSafe(session, remoteRoot, backup);
            if (same(job.expectedRemote, snapshot(old)) && !await remoteSafe(session, remoteRoot, job.remotePath)) {
              await session.rename(backup, job.remotePath);
              guard(job.expectedRemote, snapshot(await remoteSafe(session, remoteRoot, job.remotePath)), 'Hersteld extern doel');
              record.transaction = undefined; this.persist();
            }
          } catch { /* Persisted recovery paths remain available for manual recovery. */ }
        }
        throw error;
      }
    } finally {
      await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
      if (staged && !record.transaction) try { const entry = await remoteSafe(session, remoteRoot, stage); if (entry?.kind === 'file') await session.remove(stage, false); } catch { this.log('warning', `Tijdelijk bestand mogelijk achtergebleven: ${stage}`, job.connectionId); }
    }
  }

  private async download(record: Record, active: Running, session: RemoteSession, localRoot: string, remoteRoot: string): Promise<void> {
    const job = record.job, signal = active.controller.signal;
    const source = await remoteSafe(session, remoteRoot, job.remotePath);
    if (!source || source.kind !== 'file') throw new Conflict('Externe bron is geen gewoon bestand meer.');
    guard(job.sourceSnapshot, snapshot(source), 'Externe bron');
    guard(job.expectedRemote, snapshot(source), 'Externe bron');
    guard(job.expectedLocal, await localSnapshot(localRoot, job.localPath), 'Lokaal doel');
    await ensureLocalDirectory(localRoot, path.dirname(job.localPath));
    const stage = path.join(path.dirname(job.localPath), `.${path.basename(job.localPath)}.ftp-studio-${randomUUID()}.part`), backup = `${stage}.backup`;
    const reserved = await fs.open(stage, 'wx', 0o600); await reserved.close();
    try {
      abort(signal);
      await session.download(job.remotePath, stage, this.progress(job), signal);
      abort(signal);
      await localSafe(localRoot, stage);
      const stagedHandle = await fs.open(stage, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
      try { await stagedHandle.sync(); } finally { await stagedHandle.close(); }
      const downloaded = await localSnapshot(localRoot, stage);
      if (!downloaded || downloaded.size !== job.size) throw new Error('Groottecontrole van het tijdelijke lokale bestand is mislukt.');
      if (source.checksum && downloaded.checksum !== source.checksum) throw new Conflict('Controlesom van het gedownloade bestand klopt niet.');
      const verifiedRemote = snapshot(await remoteSafe(session, remoteRoot, job.remotePath));
      guard(job.sourceSnapshot, verifiedRemote, 'Externe bron');
      if (verifiedRemote?.checksum && downloaded.checksum !== verifiedRemote.checksum) throw new Conflict('Controlesom van de externe bron is tijdens downloaden gewijzigd.');
      guard(job.expectedLocal, await localSnapshot(localRoot, job.localPath), 'Lokaal doel');
      // Refuse unsupported filesystems before moving an existing original out of the way.
      const probe = `${stage}.link-check`;
      try { await fs.link(stage, probe); await fs.unlink(probe); } catch {
        throw new UnsafePath('Deze lokale schijf ondersteunt geen veilige atomische installatie met harde koppelingen. Kies een ondersteunde schijf, bijvoorbeeld NTFS.');
      }
      await localSafe(localRoot, backup);
      try { await fs.lstat(backup); throw new Conflict('Lokale reservekopie bestaat al.'); } catch (error) { if (!missing(error)) throw error; }
      abort(signal);
      active.committing = true;
      record.transaction = { stage, ...(job.expectedLocal ? { backup } : {}), phase: 'prepared' }; this.persist();
      try {
        if (job.expectedLocal) {
          await fs.rename(job.localPath, backup);
          record.transaction.phase = 'backed-up'; this.persist();
          guard(job.expectedLocal, await localSnapshot(localRoot, backup), 'Lokale reservekopie');
          if (await localSnapshot(localRoot, job.localPath)) throw new Conflict('Het lokale doel is tijdens de bestandswissel opnieuw aangemaakt.');
        }
        await localSafe(localRoot, stage);
        await localSafe(localRoot, job.localPath);
        // An exclusive hard-link install is atomic and refuses a destination created after the guard.
        // Both paths are in the same directory/filesystem; the original remains in the backup.
        try { await fs.link(stage, job.localPath); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Conflict('Het lokale doel is tijdens de bestandswissel opnieuw aangemaakt.');
          throw error;
        }
        record.transaction.phase = 'installed'; this.persist();
        const installed = await localSnapshot(localRoot, job.localPath);
        if (!installed || installed.size !== downloaded.size || installed.checksum !== downloaded.checksum) throw new Conflict('Het geïnstalleerde lokale bestand kon niet worden bevestigd.');
        job.verifiedRemote = verifiedRemote!;
        job.verifiedLocal = installed;
        record.transaction = undefined; this.persist();
        if (job.expectedLocal) await fs.unlink(backup).catch(() => this.log('warning', `Lokale reservekopie bewaard: ${backup}`, job.connectionId));
      } catch (error) {
        if (job.expectedLocal && record.transaction?.phase === 'backed-up') {
          try {
            if (same(job.expectedLocal, await localSnapshot(localRoot, backup)) && !await localSnapshot(localRoot, job.localPath)) {
              await fs.link(backup, job.localPath);
              guard(job.expectedLocal, await localSnapshot(localRoot, job.localPath), 'Hersteld lokaal doel');
              await fs.unlink(backup);
              record.transaction = undefined; this.persist();
            }
          } catch { /* Leave all recoverable originals in place on ambiguity. */ }
        }
        throw error;
      }
    } finally {
      if (!record.transaction) { await localSafe(localRoot, stage); await fs.unlink(stage).catch(error => { if (!missing(error)) this.log('warning', `Tijdelijk lokaal bestand bewaard: ${stage}`, job.connectionId); }); }
    }
  }
}
