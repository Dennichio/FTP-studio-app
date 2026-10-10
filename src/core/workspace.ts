import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { FileEntry, FileSnapshot, FilterRule, SearchQuery, SearchResult, ReplacementPreview } from '../shared/contracts';

import { boundedRegex, globMatches, isDefaultExcluded, isSensitivePath, matchesFilters } from './browserWorkspace';
export { boundedRegex, isDefaultExcluded, isSensitivePath, matchesFilters, compareEntries, mapLocalToRemote, mapRemoteToLocal, normalizeRemoteRoot } from './browserWorkspace';

const MAX_FILE = 8 * 1024 * 1024;
export const checksum = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

/** Reject symlinks in every existing ancestor, including the selected root. */
export async function assertSafeLocalPath(target: string, root?: string, allowMissing = false): Promise<string> {
  if (!target || target.includes('\0')) throw new Error('Ongeldig lokaal pad.');
  const resolved = path.resolve(target);
  if (root) {
    const relative = path.relative(path.resolve(root), resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Pad valt buiten de projectmap.');
  }
  const parts = resolved.slice(path.parse(resolved).root.length).split(path.sep).filter(Boolean);
  let cursor = path.parse(resolved).root;
  for (let index = 0; index < parts.length; index++) {
    cursor = path.join(cursor, parts[index]);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error('Symbolische koppelingen worden geweigerd.');
      if (index < parts.length - 1 && !stat.isDirectory()) throw new Error('Een bovenliggend pad is geen map.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissing) return resolved;
      throw error;
    }
  }
  return resolved;
}

export async function listLocal(target: string, showHidden = false, filters: FilterRule[] = []): Promise<FileEntry[]> {
  const directory = await assertSafeLocalPath(target);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const result: FileEntry[] = [];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(16, entries.length) }, async () => {
    while (nextIndex < entries.length) {
      const item = entries[nextIndex++];
      if (!showHidden && item.name.startsWith('.')) continue;
      const full = path.join(directory, item.name);
      let stat;
      try { stat = await fs.lstat(full); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()) throw new Error(`Speciaal bestand wordt geweigerd: ${item.name}.`);
      const entry: FileEntry = { name: item.name, path: full, relativePath: item.name, kind: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file', size: stat.size, modifiedAt: stat.mtimeMs, precisionMs: 1 };
      if (matchesFilters(entry, filters)) result.push(entry);
    }
  });
  const settled = await Promise.allSettled(workers);
  const failed = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected');
  if (failed) throw failed.reason;
  return result.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name));
}

async function rejectTreeLinks(target: string): Promise<void> {
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink()) throw new Error('Symbolische koppelingen worden geweigerd.');
  if (!stat.isFile() && !stat.isDirectory()) throw new Error('Speciale bestanden worden geweigerd.');
  if (stat.isDirectory()) for (const child of await fs.readdir(target)) await rejectTreeLinks(path.join(target, child));
}

export async function mutateLocal(operation: 'mkdir' | 'create' | 'rename' | 'delete' | 'copy' | 'move', target: string, destination?: string): Promise<void> {
  const source = await assertSafeLocalPath(target, undefined, operation === 'mkdir' || operation === 'create');
  if (operation === 'mkdir') { await fs.mkdir(source); return; }
  if (operation === 'create') { const handle = await fs.open(source, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); await handle.close(); return; }
  await rejectTreeLinks(source);
  if (source === path.parse(source).root) throw new Error('De schijfwortel kan niet worden gewijzigd.');
  if (operation === 'delete') { await fs.rm(source, { recursive: true }); return; }
  if (!destination) throw new Error('Bestemmingspad ontbreekt.');
  const dest = await assertSafeLocalPath(destination, undefined, true);
  try { await fs.lstat(dest); throw new Error('Bestemming bestaat al.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const relative = path.relative(source, dest);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) throw new Error('Bestemming ligt in de bronmap.');
  if (operation === 'copy') await fs.cp(source, dest, { recursive: true, force: false, errorOnExist: true });
  else if ((await fs.lstat(source)).isDirectory()) {
    // Win32 MoveFileEx cannot replace an existing directory. POSIX rename can.
    if (process.platform !== 'win32') throw new Error('Veilig hernoemen of verplaatsen van mappen is alleen op Windows beschikbaar. Kopieer de map en verwijder de bron afzonderlijk.');
    await fs.rename(source, dest);
  } else await moveFileExclusive(source, dest);
}

async function backupLocation(target: string, label: string): Promise<string> {
  const directory = path.join(path.dirname(target), '.ftp-studio-backups');
  await assertSafeLocalPath(directory, undefined, true);
  try { await fs.mkdir(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await assertSafeLocalPath(directory);
  if (!(await fs.lstat(directory)).isDirectory()) throw new Error('Reservekopiepad is geen map.');
  const container = path.join(directory, `${label}-${randomUUID()}`);
  await fs.mkdir(container, { mode: 0o700 });
  return path.join(container, path.basename(target));
}

async function probeHardlink(source: string, directory: string): Promise<void> {
  const probe = path.join(directory, `.ftp-studio-${randomUUID()}.tmp`);
  let failure: unknown;
  try { await fs.link(source, probe); } catch (error) {
    failure = new Error(`Veilige bestandswissel vereist hardlinks op hetzelfde bestandssysteem: ${(error as NodeJS.ErrnoException).code ?? 'niet ondersteund'}.`, { cause: error });
    throw failure;
  } finally { await cleanupTemporary(probe, failure); }
}

async function cleanupTemporary(target: string, primary?: unknown): Promise<void> {
  try { await fs.rm(target, { force: true }); } catch (error) {
    const cleanupMessage = `Tijdelijk bestand is behouden na opruimfout: ${target}.`;
    if (primary !== undefined) throw new AggregateError([primary, error], `${primary instanceof Error ? primary.message : String(primary)} ${cleanupMessage}`, { cause: primary });
    throw new Error(cleanupMessage, { cause: error });
  }
}

async function restoreExclusive(backup: string, target: string): Promise<{ restored: true } | { restored: false; error: unknown }> {
  try { await assertSafeLocalPath(target, undefined, true); await fs.link(backup, target); return { restored: true }; }
  catch (error) { return { restored: false, error }; }
}

async function moveFileExclusive(source: string, destination: string): Promise<void> {
  const expected = await localSnapshot(source);
  await probeHardlink(source, path.dirname(destination));
  const backup = await backupLocation(source, 'move');
  let moved = false;
  try {
    await assertSafeLocalPath(source);
    await assertSafeLocalPath(destination, undefined, true);
    await fs.rename(source, backup); moved = true;
    if (!snapshotMatches(await localSnapshot(backup), expected)) throw new Error('Bronbestand is tijdens het verplaatsen gewijzigd.');
    await fs.link(backup, destination);
    // Keep the moved original as a recovery copy; never unlink a newly-created source pathname.
  } catch (error) {
    if (moved) {
      const restored = await restoreExclusive(backup, source);
      if (!restored.restored) throw new AggregateError([error, restored.error], `Verplaatsen afgebroken; bron en bestemming zijn niet overschreven. Oorspronkelijk bestand behouden in ${backup}.`, { cause: error });
    }
    throw error;
  }
}

export interface TextFile { content: string; snapshot: FileSnapshot; eol: 'LF' | 'CRLF'; encoding: 'utf8'; }
export async function readTextFile(target: string): Promise<TextFile> {
  const safe = await assertSafeLocalPath(target);
  if (!(await fs.lstat(safe)).isFile()) throw new Error('Alleen gewone tekstbestanden kunnen worden geopend.');
  const handle = await fs.open(safe, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('Alleen tekstbestanden tot 8 MB kunnen worden geopend.');
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const value of handle.createReadStream({ autoClose: false })) {
      const chunk = Buffer.from(value);
      length += chunk.length;
      if (length > MAX_FILE) throw new Error('Bestand werd groter dan 8 MB tijdens het lezen.');
      if (length > stat.size) throw new Error('Bestand is tijdens het lezen gegroeid.');
      chunks.push(chunk);
    }
    const finalStat = await handle.stat();
    if (finalStat.size !== stat.size || finalStat.mtimeMs !== stat.mtimeMs) throw new Error('Bestand is tijdens het lezen gewijzigd.');
    const buffer = Buffer.concat(chunks, length);
    if (buffer.includes(0)) throw new Error('Binair bestand kan niet als tekst worden geopend.');
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); } catch { throw new Error('Bestand is geen geldige UTF-8-tekst.'); }
    return { content, snapshot: { size: buffer.length, modifiedAt: stat.mtimeMs, checksum: checksum(buffer) }, eol: content.includes('\r\n') ? 'CRLF' : 'LF', encoding: 'utf8' };
  } finally { await handle.close(); }
}

export async function localSnapshot(target: string): Promise<FileSnapshot> {
  const safe = await assertSafeLocalPath(target);
  if (!(await fs.lstat(safe)).isFile()) throw new Error('Pad is geen gewoon bestand.');
  const handle = await fs.open(safe, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Pad is geen bestand.');
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > stat.size) throw new Error('Bestand is tijdens de hashcontrole gegroeid.');
      hash.update(chunk);
    }
    const current = await handle.stat();
    if (current.size !== stat.size || current.mtimeMs !== stat.mtimeMs || bytes !== stat.size) throw new Error('Bestand is tijdens de hashcontrole gewijzigd.');
    return { size: stat.size, modifiedAt: stat.mtimeMs, checksum: hash.digest('hex') };
  } finally { await handle.close(); }
}

function snapshotMatches(actual: FileSnapshot, expected: FileSnapshot): boolean {
  return expected.checksum ? actual.checksum === expected.checksum : actual.size === expected.size && actual.modifiedAt === expected.modifiedAt;
}
export async function safeSaveTextFile(target: string, content: string, expected?: FileSnapshot | null): Promise<TextFile> {
  if (Buffer.byteLength(content) > MAX_FILE) throw new Error('Tekstbestand is groter dan 8 MB.');
  const safe = await assertSafeLocalPath(target, undefined, true);
  let mode = 0o600;
  let saveExpected = expected;
  try {
    const original = await localSnapshot(safe);
    mode = (await fs.stat(safe)).mode & 0o777;
    if (expected === null || expected && !snapshotMatches(original, expected)) throw new Error('Bestand is buiten de editor gewijzigd; opslaan geblokkeerd.');
    saveExpected ??= original;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || expected) throw error;
    saveExpected = null;
  }
  const temp = path.join(path.dirname(safe), `.ftp-studio-${randomUUID()}.tmp`);
  let backup: string | undefined;
  let originalMoved = false;
  let installed = false;
  let failure: unknown;
  let stageHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    // Retain the owned inode through commit. A later pathname may belong to
    // another writer and must never be chmod'ed as part of our recovery.
    stageHandle = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    await stageHandle.writeFile(content, 'utf8');
    // open(mode) is masked by process.umask; restore the intended POSIX mode explicitly.
    await stageHandle.chmod(mode);
    await stageHandle.sync();
    await assertSafeLocalPath(safe, undefined, true);
    if (saveExpected) { const current = await localSnapshot(safe); if (!snapshotMatches(current, saveExpected)) throw new Error('Bestand is tijdens het opslaan gewijzigd.'); }
    // Verify support before taking the original out of the way.
    await probeHardlink(temp, path.dirname(safe));
    if (saveExpected) {
      backup = await backupLocation(safe, 'save');
      const currentPermissions = await fs.lstat(safe);
      if (!currentPermissions.isFile() || (currentPermissions.mode & 0o777) !== mode) throw new Error('Bestandsrechten zijn tijdens het opslaan gewijzigd; huidig bestand is behouden.');
      await fs.rename(safe, backup); originalMoved = true;
      if (!snapshotMatches(await localSnapshot(backup), saveExpected)) throw new Error('Bestand is tijdens de bestandswissel gewijzigd.');
      const backupPermissions = await fs.lstat(backup);
      if (!backupPermissions.isFile() || (backupPermissions.mode & 0o777) !== mode) throw new Error('Bestandsrechten zijn tijdens de bestandswissel gewijzigd; oorspronkelijke rechten worden behouden.');
    }
    await assertSafeLocalPath(safe, undefined, true);
    await fs.link(temp, safe); installed = true;
    const saved = await readTextFile(safe);
    if (saved.snapshot.checksum !== checksum(content)) throw new Error('Bestand is na installatie door een andere schrijver gewijzigd.');
    if (backup && saveExpected && !snapshotMatches(await localSnapshot(backup), saveExpected)) throw new Error('Oorspronkelijke bestand is tijdens het opslaan gewijzigd; reservekopie blijft behouden.');
    if (backup) {
      const finalPermissions = await fs.lstat(backup);
      if (!finalPermissions.isFile() || (finalPermissions.mode & 0o777) !== mode) {
        // A process holding the original inode can restrict it even after rename.
        // Never report success or leave our inode broader than the detected mode.
        const ownedPermissions = await stageHandle.stat();
        await stageHandle.chmod((ownedPermissions.mode & 0o777) & (finalPermissions.isFile() ? finalPermissions.mode & 0o777 : 0o600));
        await stageHandle.sync();
        throw new Error('Bestandsrechten zijn tijdens de laatste opslagstap gewijzigd; de nieuwe versie is beperkt en de reservekopie is behouden.');
      }
    }
    return saved;
  } catch (error) {
    failure = error;
    if (originalMoved && backup) {
      // Once installed, the destination may belong to another writer: do not remove it.
      if (installed) failure = new Error(`Opslaan vereist controle; huidig bestand is behouden. Oorspronkelijk bestand veilig in ${backup}.`, { cause: error });
      else {
        const restored = await restoreExclusive(backup, safe);
        if (!restored.restored) failure = new AggregateError([error, restored.error], `Opslaan afgebroken; huidig bestand is behouden. Oorspronkelijk bestand veilig in ${backup}.`, { cause: error });
      }
    }
    throw failure;
  } finally {
    // Preserve the original failure and still clean up when closing fails.
    let closeFailure: unknown;
    try { await stageHandle?.close(); } catch (error) {
      closeFailure = failure === undefined ? error : new AggregateError([failure, error], failure instanceof Error ? failure.message : 'Opslaan en sluiten mislukt.', { cause: failure });
    }
    await cleanupTemporary(temp, closeFailure ?? failure);
    if (closeFailure !== undefined) throw closeFailure;
  }
}

export async function walkProject(root: string, signal?: AbortSignal): Promise<FileEntry[]> {
  const safeRoot = await assertSafeLocalPath(root);
  const files: FileEntry[] = [];
  let count = 0;
  async function visit(directory: string): Promise<void> {
    signal?.throwIfAborted();
    for (const item of await listLocal(directory, true)) {
      if (++count > 20000) throw new Error('Project bevat meer dan 20.000 items; beperk de zoekmap.');
      signal?.throwIfAborted();
      item.relativePath = path.relative(safeRoot, item.path).split(path.sep).join('/');
      if (isDefaultExcluded(item.relativePath) || isSensitivePath(item.relativePath)) continue;
      if (item.kind === 'directory') await visit(item.path);
      else files.push(item);
    }
  }
  await visit(safeRoot);
  return files;
}

function queryRegex(query: SearchQuery): RegExp {
  if (!query.text) throw new Error('Zoektekst ontbreekt.');
  if (query.text.length > 8192) throw new Error('Zoektekst is te lang (maximaal 8.192 tekens).');
  return query.regex ? boundedRegex(query.text, query.caseSensitive ? 'g' : 'gi') : new RegExp(query.text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'), query.caseSensitive ? 'g' : 'gi');
}
async function searchFiles(root: string, query: SearchQuery, signal?: AbortSignal): Promise<{ path: string; text: TextFile }[]> {
  queryRegex(query);
  const files = await walkProject(root, signal);
  const results: { path: string; text: TextFile }[] = [];
  let bytes = 0;
  for (const item of files) {
    signal?.throwIfAborted();
    if (item.kind !== 'file' || item.size > 2 * 1024 * 1024 || query.glob && !globMatches(query.glob, item.relativePath!)) continue;
    bytes += item.size;
    if (bytes > 64 * 1024 * 1024) throw new Error('Zoekopdracht overschrijdt 64 MB; beperk het bestandspatroon.');
    try { results.push({ path: item.path, text: await readTextFile(item.path) }); } catch (error) {
      if (!/Binair bestand|geldige UTF-8/.test(String(error))) throw error;
    }
  }
  return results;
}
export async function searchProject(root: string, query: SearchQuery, signal?: AbortSignal): Promise<SearchResult[]> {
  const regex = queryRegex(query);
  const results: SearchResult[] = [];
  for (const file of await searchFiles(root, query, signal)) {
    signal?.throwIfAborted();
    const lines = file.text.content.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (line.length > 32768) throw new Error('Regel is te lang voor veilig zoeken.');
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(line))) {
        results.push({ path: file.path, line: index + 1, column: match.index + 1, text: line, length: match[0].length });
        if (results.length > 10000) throw new Error('Meer dan 10.000 zoekresultaten; verfijn de zoekopdracht.');
        if (!match[0].length) regex.lastIndex++;
      }
    });
  }
  return results;
}
export async function previewReplace(root: string, query: SearchQuery, replacement: string, signal?: AbortSignal): Promise<ReplacementPreview[]> {
  if (Buffer.byteLength(replacement) > 1024 * 1024) throw new Error('Vervangende tekst is groter dan 1 MB.');
  const changes: ReplacementPreview[] = [];
  for (const file of await searchFiles(root, query, signal)) {
    signal?.throwIfAborted();
    let count = 0;
    const regex = queryRegex(query);
    let afterBytes = file.text.snapshot.size;
    const replacementBytes = Buffer.byteLength(replacement);
    if (file.text.content.split(/\r?\n/).some(line => line.length > 32768)) throw new Error('Regel is te lang voor veilig vervangen.');
    // Literal replacement is deliberate: dollar syntax never silently rewrites text.
    const after = file.text.content.split(/(?<=\n)/).map(line => line.replace(regex, (match: string) => {
      count++;
      afterBytes += replacementBytes - Buffer.byteLength(match);
      if (afterBytes > MAX_FILE) throw new Error('Vervanging maakt bestand groter dan 8 MB.');
      return replacement;
    })).join('');
    if (count && after !== file.text.content) changes.push({ path: file.path, before: file.text.content, after, checksum: file.text.snapshot.checksum!, count });
    if (changes.length > 1000) throw new Error('Vervangen is beperkt tot 1.000 bestanden per opdracht.');
  }
  return changes;
}

export async function applyReplace(changes: ReplacementPreview[]): Promise<number> {
  if (changes.length > 1000) throw new Error('Vervangen is beperkt tot 1.000 bestanden.');
  const seen = new Set<string>();
  const snapshots = new Map<string, FileSnapshot>();
  for (const change of changes) {
    const safe = await assertSafeLocalPath(change.path);
    if (seen.has(safe) || isSensitivePath(safe) || isDefaultExcluded(safe)) throw new Error('Ongeldig of dubbel vervangingspad.');
    seen.add(safe);
    const original = await readTextFile(safe);
    if (original.snapshot.checksum !== change.checksum || checksum(change.before) !== change.checksum) throw new Error('Vervangingsvoorbeeld is verouderd; geen bestanden gewijzigd.');
    if (Buffer.byteLength(change.after) > MAX_FILE) throw new Error('Vervanging maakt bestand te groot.');
    snapshots.set(change.path, original.snapshot);
  }
  const backupId = `${Date.now()}-${randomUUID()}`;
  for (const change of changes) {
    const backupDirectory = path.join(path.dirname(change.path), '.ftp-studio-backups');
    await assertSafeLocalPath(backupDirectory, undefined, true);
    await fs.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    await safeSaveTextFile(path.join(backupDirectory, `${backupId}-${path.basename(change.path)}.bak`), change.before, null);
  }
  // Validate the entire batch again before the first write.
  for (const change of changes) if ((await localSnapshot(change.path)).checksum !== change.checksum) throw new Error('Bestand is gewijzigd; vervanging geblokkeerd.');
  const applied: ReplacementPreview[] = [];
  try {
    for (const change of changes) { await safeSaveTextFile(change.path, change.after, snapshots.get(change.path)); applied.push(change); }
  } catch (error) {
    const failures: string[] = [];
    for (const change of applied.reverse()) {
      try { await safeSaveTextFile(change.path, change.before, { size: Buffer.byteLength(change.after), modifiedAt: null, checksum: checksum(change.after) }); }
      catch { failures.push(change.path); }
    }
    if (failures.length) throw new Error(`Vervanging afgebroken; herstel uit .ftp-studio-backups vereist voor: ${failures.join(', ')}.`);
    throw error;
  }
  return changes.reduce((total, change) => total + change.count, 0);
}
