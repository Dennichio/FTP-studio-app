import path from 'node:path';
import type { FileEntry, RemoteAccess, SearchQuery } from '../shared/contracts';
import { boundedRegex, globMatches, normalizeRemoteRoot } from '../core/browserWorkspace';
import { endpointIdentity } from '../core/connectionIdentity';

const LIMIT = 50_000;

function validateQuery(query: SearchQuery): void {
  if (typeof query.text !== 'string' || query.text.length > 8192) throw new Error('Zoektekst is ongeldig of langer dan 8.192 tekens.');
  if (typeof query.regex !== 'boolean' || typeof query.caseSensitive !== 'boolean') throw new Error('Zoekinstellingen zijn ongeldig.');
  if (query.recursive !== undefined && typeof query.recursive !== 'boolean') throw new Error('Recursieve zoekinstelling is ongeldig.');
  if (query.kind !== undefined && !['file', 'directory', 'any'].includes(query.kind)) throw new Error('Ongeldig bestandstype voor zoeken.');
  for (const key of ['minSize', 'maxSize', 'modifiedAfter', 'modifiedBefore'] as const) {
    const value = query[key];
    if (value !== undefined && (!Number.isFinite(value) || (key.endsWith('Size') ? value < 0 : !Number.isFinite(new Date(value).getTime()))))
      throw new Error(`Ongeldige zoekgrens: ${key}.`);
  }
  if (query.minSize !== undefined && query.maxSize !== undefined && query.minSize > query.maxSize) throw new Error('Minimumgrootte is groter dan maximumgrootte.');
  if (query.modifiedAfter !== undefined && query.modifiedBefore !== undefined && query.modifiedAfter > query.modifiedBefore) throw new Error('Begindatum ligt na de einddatum.');
  for (const key of ['glob', 'pathGlob'] as const) {
    if (query[key] !== undefined) {
      if (typeof query[key] !== 'string') throw new Error('Bestandspatroon is ongeldig.');
      globMatches(query[key], '');
    }
  }
}

/** Searches listing metadata only; no file contents are read or downloaded. */
export async function searchRemoteEntries(remote: RemoteAccess, connectionId: string, root: string, query: SearchQuery, signal: AbortSignal, expectedEndpoint?: string): Promise<FileEntry[]> {
  signal.throwIfAborted();
  validateQuery(query);
  const expression = query.regex && query.text ? boundedRegex(query.text, query.caseSensitive ? '' : 'i') : undefined;
  const needle = query.caseSensitive ? query.text : query.text.toLowerCase();
  const profile = remote.profile(connectionId);
  const endpoint = endpointIdentity(profile);
  if (expectedEndpoint !== undefined && endpoint !== expectedEndpoint) throw new Error('De serverbestemming is gewijzigd; vernieuw het paneel.');
  const searchRoot = normalizeRemoteRoot(root);
  const allowedRoot = normalizeRemoteRoot(profile.remoteRoot);
  if (allowedRoot !== '/' && searchRoot !== allowedRoot && !searchRoot.startsWith(`${allowedRoot}/`)) throw new Error('Zoekmap valt buiten de verbindingswortel.');
  const checkEndpoint = () => {
    signal.throwIfAborted();
    if (endpointIdentity(remote.profile(connectionId)) !== endpoint) throw new Error('De serverbestemming wijzigde tijdens het zoeken; resultaten zijn verworpen.');
  };
  const directories = [searchRoot];
  const visited = new Set(directories);
  const results: FileEntry[] = [];
  let scanned = 0;
  for (let index = 0; index < directories.length; index++) {
    checkEndpoint();
    const directory = directories[index];
    const lease = await remote.acquire(connectionId, 'navigation', signal);
    try {
      checkEndpoint();
      const entries = await lease.session.list(directory, signal);
      checkEndpoint();
      if (!Array.isArray(entries) || entries.length > LIMIT - scanned) throw new Error('Remote zoekopdracht overschrijdt 50.000 items; beperk de zoekmap.');
      const names = new Set<string>();
      for (const raw of entries) {
        signal.throwIfAborted();
        scanned++;
        if (!raw || typeof raw.name !== 'string' || !raw.name || raw.name.length > 1024 || raw.name === '.' || raw.name === '..' || /[/\\\x00-\x1f\x7f]/.test(raw.name)) throw new Error('Server retourneerde een onveilige bestandsnaam.');
        if (names.has(raw.name)) throw new Error('Server retourneerde dubbele bestandsnamen.');
        names.add(raw.name);
        const absolute = path.posix.join(directory, raw.name);
        if (typeof raw.path !== 'string' || /[\\\x00-\x1f\x7f]/.test(raw.path) || raw.path.split('/').some(segment => segment === '.' || segment === '..') || normalizeRemoteRoot(raw.path) !== absolute) throw new Error('Server retourneerde een onveilig of inconsistent bestandspad.');
        const relativePath = path.posix.relative(searchRoot, absolute);
        if (relativePath.length > 32768 || relativePath === '..' || relativePath.startsWith('../')) throw new Error('Remote zoekpad is ongeldig of te lang.');
        if (raw.kind !== 'file' && raw.kind !== 'directory' && raw.kind !== 'symlink') throw new Error('Server retourneerde een onbekend bestandstype.');
        if (raw.kind === 'symlink') continue;
        if (!Number.isFinite(raw.size) || raw.size < 0) throw new Error('Server retourneerde een ongeldige bestandsgrootte.');
        const modifiedAt = raw.modifiedAt !== null && Number.isFinite(raw.modifiedAt) ? raw.modifiedAt : null;
        const entry: FileEntry = { ...raw, path: absolute, relativePath, modifiedAt };
        if (entry.kind === 'directory' && query.recursive !== false && !visited.has(absolute)) {
          visited.add(absolute); directories.push(absolute);
        }
        // Result filters never determine whether a real directory is visited.
        if (query.kind && query.kind !== 'any' && entry.kind !== query.kind) continue;
        if (query.minSize !== undefined && entry.size < query.minSize || query.maxSize !== undefined && entry.size > query.maxSize) continue;
        if (query.modifiedAfter !== undefined && (modifiedAt === null || modifiedAt < query.modifiedAfter) || query.modifiedBefore !== undefined && (modifiedAt === null || modifiedAt > query.modifiedBefore)) continue;
        if (query.glob !== undefined && !globMatches(query.glob, entry.name) || query.pathGlob !== undefined && !globMatches(query.pathGlob, relativePath)) continue;
        if (query.text && (expression ? !expression.test(entry.name) : !(query.caseSensitive ? entry.name : entry.name.toLowerCase()).includes(needle))) continue;
        results.push(entry);
        if (results.length > LIMIT) throw new Error('Remote zoekopdracht bevat meer dan 50.000 resultaten.');
      }
    } finally { await lease.release(); }
    checkEndpoint();
  }
  checkEndpoint();
  return results.sort((a, b) => (a.relativePath ?? a.path).localeCompare(b.relativePath ?? b.path));
}
