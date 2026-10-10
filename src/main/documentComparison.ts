import path from 'node:path';
import { constants, promises as fs } from 'node:fs';
import type { DocumentComparison, FileEntry, RemoteSession } from '../shared/contracts';
import { assertSafeLocalPath, readTextFile } from '../core/workspace';

const MAX_BYTES = 8 * 1024 * 1024;
function checked(signal: AbortSignal, checkContext: () => void): void {
  if (signal.aborted) throw signal.reason;
  checkContext();
}

export async function compareLocalDocument(target: string, signal: AbortSignal, checkContext: () => void): Promise<DocumentComparison> {
  checked(signal, checkContext);
  const safe = await assertSafeLocalPath(target), before = await fs.lstat(safe);
  if (!before.isFile() || before.size > MAX_BYTES) throw new Error('Vergelijken ondersteunt alleen gewone UTF-8-tekstbestanden tot 8 MB.');
  const file = await readTextFile(safe);
  checked(signal, checkContext); await assertSafeLocalPath(safe);
  const after = await fs.lstat(safe);
  if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || file.snapshot.size !== before.size || file.snapshot.modifiedAt !== before.mtimeMs) throw new Error('Het schijfbestand wijzigde tijdens de vergelijking. Probeer opnieuw.');
  checked(signal, checkContext);
  return { path: safe, content: file.content, eol: file.eol, snapshot: file.snapshot, source: 'local', checkedAt: Date.now() };
}

function checkedRemotePath(root: string, target: string): string {
  for (const value of [root, target]) if (!value.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(value) || value.split('/').includes('..')) throw new Error('Het vastgelegde serverpad is ongeldig. Open het document opnieuw.');
  const relative = path.posix.relative(path.posix.normalize(root), path.posix.normalize(target));
  if (!relative || relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) throw new Error('Het document valt buiten de gekoppelde serverhoofdmap.');
  return path.posix.normalize(target);
}
function metadata(entry: FileEntry | null): FileEntry {
  if (!entry || entry.kind !== 'file') throw new Error('De serverbron is geen bestaand gewoon bestand; symbolische koppelingen worden geweigerd.');
  if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_BYTES) throw new Error('Vergelijken ondersteunt alleen servertekstbestanden tot 8 MB met een geldige bestandsgrootte.');
  if (entry.modifiedAt === null ? !entry.checksum : !Number.isFinite(entry.modifiedAt)) throw new Error('De serverbron kan niet veilig worden vergeleken: tijdstempel en controlesom ontbreken of zijn ongeldig.');
  return entry;
}

/** Private read-only snapshot; never reuses or changes the document's workcache. */
export async function compareRemoteDocument(session: RemoteSession, root: string, target: string, temporaryRoot: string,
  signal: AbortSignal, checkContext: () => void): Promise<DocumentComparison> {
  const safe = checkedRemotePath(root, target);
  checked(signal, checkContext);
  const before = metadata(await session.stat(safe));
  checked(signal, checkContext);
  await assertSafeLocalPath(temporaryRoot, undefined, true); await fs.mkdir(temporaryRoot, { recursive: true, mode: 0o700 }); await assertSafeLocalPath(temporaryRoot);
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'comparison-')), localPath = path.join(directory, 'source');
  let primary: unknown;
  try {
    const handle = await fs.open(localPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); await handle.close();
    checked(signal, checkContext);
    await session.download(safe, localPath, progress => {
      checked(signal, checkContext);
      if (progress.total !== before.size || !Number.isSafeInteger(progress.transferred) || progress.transferred < 0 || progress.transferred > before.size || progress.transferred > MAX_BYTES) throw new Error('De serverbron wijzigde of groeide tijdens de vergelijking.');
    }, signal);
    checked(signal, checkContext);
    const file = await readTextFile(localPath);
    checked(signal, checkContext);
    const after = metadata(await session.stat(safe));
    if (before.size !== after.size || before.modifiedAt !== after.modifiedAt || before.checksum && before.checksum !== after.checksum || file.snapshot.size !== before.size ||
        before.checksum && file.snapshot.checksum !== before.checksum || after.checksum && file.snapshot.checksum !== after.checksum) throw new Error('De serverbron wijzigde tijdens de vergelijking. Probeer opnieuw.');
    checked(signal, checkContext);
    return { path: safe, content: file.content, eol: file.eol, snapshot: { size: before.size, modifiedAt: before.modifiedAt, checksum: file.snapshot.checksum }, source: 'remote', checkedAt: Date.now() };
  } catch (error) { primary = error; throw error; }
  finally {
    try { await fs.unlink(localPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); await fs.rmdir(directory); }
    catch (error) { throw new AggregateError(primary === undefined ? [error] : [primary, error], 'Tijdelijke vergelijkingsbron kon niet worden opgeruimd.', { cause: primary ?? error }); }
  }
}
