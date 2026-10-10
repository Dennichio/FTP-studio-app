import path from 'node:path';
import { constants, promises as fs } from 'node:fs';
import type { ConnectionProfile, FileEntry, FileSnapshot, RemoteSession } from '../shared/contracts';
import { assertSafeLocalPath, isDefaultExcluded, isSensitivePath, localSnapshot } from '../core/workspace';

const PREFIX = 'remote-action-';
function safeCacheName(name: string): boolean {
  return !!name && !/[<>:"|?*\x00-\x1f\\]/.test(name) && !/[. ]$/.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}
type Action = { kind: 'create'; path: string } | { kind: 'copy'; path: string; destination: string; expectedSource: FileSnapshot };
export interface PreparedRemoteFile { localPath: string; remotePath: string; localSnapshot: FileSnapshot; }

/** Match both workspace exclusions and the transfer queue's stricter secret/path gates. */
export function checkedRemoteActionPath(root: string, value: string): string {
  const normalize = (input: string): string => {
    if (!input.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(input) || input.split('/').includes('..')) throw new Error('Gebruik een absoluut serverpad zonder .., backslashes of controletekens.');
    return path.posix.normalize(input).replace(/\/$/, '') || '/';
  };
  const base = normalize(root), target = normalize(value);
  if (target === base || base !== '/' && !target.startsWith(base + '/')) throw new Error('Een bestand moet binnen de gekoppelde serverhoofdmap liggen.');
  const blocked = target.split('/').some(part => ['cache', '.cache', 'backups', 'backup', '.vs'].includes(part.toLowerCase()) ||
    /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?)$/i.test(part) || /\.(?:pem|key|p12|pfx|kdbx)$/i.test(part));
  if (blocked || isDefaultExcluded(target) || isSensitivePath(target)) throw new Error('Dit serverpad is gevoelig of uitgesloten van overdracht.');
  return target;
}

async function inspectedEntry(session: RemoteSession, root: string, target: string): Promise<FileEntry | null> {
  let current = path.posix.normalize(root).replace(/\/$/, '') || '/';
  const parts = path.posix.relative(current, target).split('/');
  const base = await session.stat(current);
  if (!base || base.kind !== 'directory') throw new Error('De serverhoofdmap is geen veilige bestaande map.');
  for (let index = 0; index < parts.length; index++) {
    current = path.posix.join(current, parts[index]);
    const entry = await session.stat(current);
    if (entry?.kind === 'symlink') throw new Error('Symbolische koppelingen mogen niet worden gevolgd.');
    if (index === parts.length - 1) return entry;
    if (!entry || entry.kind !== 'directory') throw new Error('De bovenliggende servermap moet bestaan en veilig zijn.');
  }
  return null;
}

function checkedSource(entry: FileEntry | null, expected: FileSnapshot): FileEntry {
  if (!entry || entry.kind !== 'file') throw new Error('Kopiëren ondersteunt alleen een bestaand gewoon serverbestand.');
  if (!expected || !Number.isSafeInteger(expected.size) || expected.size < 0 || expected.modifiedAt !== null && !Number.isFinite(expected.modifiedAt) ||
      expected.modifiedAt === null && !expected.checksum || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error('De bron kan niet veilig worden vergeleken: geldige grootte en tijdstempel of controlesom zijn vereist.');
  if (entry.size !== expected.size || entry.modifiedAt !== expected.modifiedAt || expected.checksum && entry.checksum !== expected.checksum) throw new Error('Het serverbronbestand is gewijzigd. Vernieuw het paneel en plan opnieuw in.');
  return entry;
}

/** Only prepares private bytes. Remote publication always belongs to TransferQueue. */
export async function prepareRemoteFileAction(session: RemoteSession, profile: ConnectionProfile, cacheRoot: string, action: Action,
  signal: AbortSignal, checkContext: () => void, authorize: (source: FileEntry | null, destination: string) => Promise<void>): Promise<PreparedRemoteFile> {
  const check = () => { if (signal.aborted) throw new DOMException('Serverbewerking geannuleerd.', 'AbortError'); checkContext(); };
  const sourcePath = checkedRemoteActionPath(profile.remoteRoot, action.path);
  const destination = action.kind === 'copy' ? checkedRemoteActionPath(profile.remoteRoot, action.destination) : sourcePath;
  const basename = path.posix.basename(destination);
  if (!safeCacheName(basename)) throw new Error('Serverbestandsnaam is niet veilig voor de Windows-werkcache.');
  if (action.kind === 'copy' && sourcePath === destination) throw new Error('Bron en bestemming moeten verschillen.');
  check();
  const source = action.kind === 'copy' ? checkedSource(await inspectedEntry(session, profile.remoteRoot, sourcePath), action.expectedSource) : null;
  if (await inspectedEntry(session, profile.remoteRoot, destination)) throw new Error('Het serverdoel bestaat al; deze bewerking overschrijft niets.');
  check(); await authorize(source, destination); check();
  if (action.kind === 'copy') checkedSource(await inspectedEntry(session, profile.remoteRoot, sourcePath), action.expectedSource);
  check();
  await assertSafeLocalPath(cacheRoot, undefined, true);
  await fs.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  await assertSafeLocalPath(cacheRoot);
  const directory = await fs.mkdtemp(path.join(cacheRoot, PREFIX));
  const localPath = path.join(directory, basename);
  let prepared = false;
  try {
    const handle = await fs.open(localPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.close(); check();
    if (action.kind === 'copy') {
      await session.download(sourcePath, localPath, () => check(), signal);
      check(); checkedSource(await inspectedEntry(session, profile.remoteRoot, sourcePath), action.expectedSource);
    }
    const bytes = await localSnapshot(localPath); check();
    if (action.kind === 'copy' && (bytes.size !== action.expectedSource.size || action.expectedSource.checksum && bytes.checksum !== action.expectedSource.checksum)) throw new Error('De private kopie wijkt af van de gecontroleerde serverbron.');
    if (await inspectedEntry(session, profile.remoteRoot, destination)) throw new Error('Het serverdoel is tijdens de voorbereiding aangemaakt; niets overschreven.');
    check(); prepared = true;
    return { localPath, remotePath: destination, localSnapshot: bytes };
  } finally { if (!prepared) { await fs.unlink(localPath).catch(() => {}); await fs.rmdir(directory).catch(() => {}); } }
}

export async function removeRemoteActionSource(cacheRoot: string, localPath: string): Promise<void> {
  const directory = path.dirname(localPath);
  if (path.dirname(directory) !== path.resolve(cacheRoot) || !path.basename(directory).startsWith(PREFIX) || !safeCacheName(path.basename(localPath))) return;
  try {
    await assertSafeLocalPath(localPath, cacheRoot);
    if (!(await fs.lstat(localPath)).isFile()) throw new Error('De private overdrachtsbron is geen gewoon bestand.');
    await fs.unlink(localPath); await fs.rmdir(directory);
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
}
