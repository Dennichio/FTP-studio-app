import type { FileEntry, FileSnapshot, FilterRule, ManifestEntry, ComparisonStatus } from '../shared/contracts';

const extensionOf = (name: string): string => { const index = name.lastIndexOf('.'); return index > 0 ? name.slice(index + 1) : ''; };
const dirnameOf = (value: string): string => { const index = value.lastIndexOf('/'); return index < 0 ? '.' : index === 0 ? '/' : value.slice(0, index); };

interface LocalPath { prefix: string; parts: string[]; windows: boolean; }
const normalizeParts = (value: string): string[] => {
  const parts: string[] = [];
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') parts.pop(); else parts.push(segment);
  }
  return parts;
};
function parseLocal(value: string): LocalPath {
  if (!value || value.includes('\0')) throw new Error('Ongeldig lokaal pad.');
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(value);
  if (windows) {
    const slash = value.replaceAll('\\', '/');
    const drive = /^([a-z]:)\/(.*)$/i.exec(slash);
    if (drive) return { prefix: drive[1], parts: normalizeParts(drive[2]), windows: true };
    const unc = /^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(slash);
    if (!unc || unc[1] === '?' || unc[1] === '.') throw new Error('Ongeldig Windows-pad.');
    return { prefix: `\\\\${unc[1]}\\${unc[2]}`, parts: normalizeParts(unc[3] ?? ''), windows: true };
  }
  if (!value.startsWith('/')) throw new Error('Lokaal pad moet absoluut zijn.');
  return { prefix: '/', parts: normalizeParts(value), windows: false };
}
function relativeParts(target: LocalPath, root: LocalPath): string[] {
  const equal = (a: string, b: string) => root.windows ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (root.windows !== target.windows || !equal(root.prefix, target.prefix) || root.parts.some((part, index) => !target.parts[index] || !equal(part, target.parts[index]))) throw new Error('Lokaal pad valt buiten de projectmap.');
  return target.parts.slice(root.parts.length);
}
export function normalizeRemoteRoot(root: string): string {
  if (!root.startsWith('/') || root.includes('\0') || root.includes('\\')) throw new Error('Remote wortel moet een absoluut POSIX-pad zijn.');
  return `/${normalizeParts(root).join('/')}`;
}
export function mapLocalToRemote(localPath: string, localRoot: string, remoteRoot: string): string {
  const relative = relativeParts(parseLocal(localPath), parseLocal(localRoot));
  const remote = normalizeRemoteRoot(remoteRoot);
  return relative.length ? `${remote === '/' ? '' : remote}/${relative.join('/')}` : remote;
}
export function mapRemoteToLocal(remotePath: string, remoteRoot: string, localRoot: string): string {
  const root = normalizeRemoteRoot(remoteRoot);
  if (!remotePath.startsWith('/') || remotePath.includes('\\') || remotePath.includes('\0')) throw new Error('Ongeldig remote pad.');
  const normalized = normalizeRemoteRoot(remotePath);
  if (normalized !== root && !(root === '/' || normalized.startsWith(`${root}/`))) throw new Error('Remote pad valt buiten de projectmap.');
  const relative = normalized === root ? [] : normalized.slice(root === '/' ? 1 : root.length + 1).split('/');
  const local = parseLocal(localRoot);
  if (relative.some(part => /[:\x00-\x1f]/.test(part) || local.windows && (/[<>"|?*]|[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) throw new Error('Remote bestandsnaam is niet veilig lokaal bruikbaar.');
  const separator = local.windows ? '\\' : '/';
  const segments = [...local.parts, ...relative];
  return local.windows ? `${local.prefix}\\${segments.join(separator)}` : `/${segments.join(separator)}`;
}

export function boundedRegex(expression: string, flags = ''): RegExp {
  if (!expression || expression.length > 256) throw new Error('Reguliere expressie is leeg of te lang (maximaal 256 tekens).');
  // A deliberately bounded subset: no groups/backreferences and at most one unbounded quantifier.
  const skeleton = expression.replace(/\\./g, 'x').replace(/\[(?:\\.|[^\]\\])*\]/g, 'x');
  if (/[()|]/.test(skeleton) || /\\[1-9]/.test(expression) || (skeleton.match(/[*+?]/g)?.length ?? 0) > 1 || /\{[^}]*\}/.test(skeleton) || /[*+?]/.test(skeleton) && !skeleton.startsWith('^'))
    throw new Error('Deze reguliere expressie is niet veilig begrensd; gebruik een eenvoudiger patroon.');
  try { return new RegExp(expression, flags); } catch { throw new Error('Ongeldige reguliere expressie.'); }
}

export function globMatches(glob: string, value: string): boolean {
  if (glob.length > 256) throw new Error('Globpatroon is te lang.');
  if (value.length > 32768) throw new Error('Filterwaarde is te lang.');
  glob = glob.toLowerCase(); value = value.toLowerCase();
  let previous = new Uint8Array(value.length + 1); previous[0] = 1;
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    const next = new Uint8Array(value.length + 1);
    const double = char === '*' && glob[i + 1] === '*';
    const directories = double && glob[i + 2] === '/';
    if (directories) {
      let reachable = false;
      for (let j = 0; j <= value.length; j++) {
        next[j] = Number(Boolean(previous[j]) || j > 0 && reachable && value[j - 1] === '/');
        reachable ||= Boolean(previous[j]);
      }
      i += 2;
    } else if (char === '*') {
      next[0] = previous[0];
      for (let j = 1; j <= value.length; j++) next[j] = Number(Boolean(previous[j]) || Boolean(next[j - 1]) && (double || value[j - 1] !== '/'));
      if (double) i++;
    } else for (let j = 1; j <= value.length; j++) next[j] = Number(Boolean(previous[j - 1]) && (char === '?' ? value[j - 1] !== '/' : value[j - 1] === char));
    previous = next;
  }
  return Boolean(previous[value.length]);
}

export function isDefaultExcluded(value: string): boolean {
  return /(^|[/\\])(\.git|\.svn|\.hg|node_modules|\.idea|\.vscode|coverage|\.ftp-studio-backups)([/\\]|$)/i.test(value) || /(^|[/\\])(?:\.DS_Store|Thumbs\.db|\.ftp-studio-.*\.tmp)$/.test(value);
}
export function isSensitivePath(value: string): boolean {
  return /(^|[/\\])(?:\.env(?:\..*)?|\.aws|\.ssh|credentials(?:\.[^/\\]*)?|id_(?:rsa|ed25519|ecdsa)|.*\.(?:pem|key|p12|pfx)|\.npmrc|\.netrc)([/\\]|$)/i.test(value);
}

export function matchesFilters(entry: FileEntry, rules: FilterRule[] = []): boolean {
  let hasIncludes = false;
  let included = false;
  for (const rule of rules) {
    if (rule.action === 'include') hasIncludes = true;
    const entryPath = (entry.relativePath ?? entry.path).replaceAll('\\', '/');
    const value = rule.field === 'name' ? entry.name : rule.field === 'extension' ? extensionOf(entry.name) : rule.field === 'directory' ? entry.kind === 'directory' ? entryPath : dirnameOf(entryPath) : rule.field === 'size' ? entry.size : rule.field === 'modified' ? entry.modifiedAt : entryPath;
    let matches = false;
    if (rule.operator === 'gt' || rule.operator === 'lt') {
      const boundary = Number(rule.value);
      if (!Number.isFinite(boundary)) throw new Error('Filtergrens is geen geldig getal.');
      matches = value !== null && (rule.operator === 'gt' ? Number(value) > boundary : Number(value) < boundary);
    } else if (rule.operator === 'equals') matches = String(value) === rule.value;
    else if (rule.operator === 'glob') matches = globMatches(rule.value, String(value));
    else matches = boundedRegex(rule.value).test(String(value).slice(0, 32768));
    if (matches) { if (rule.action === 'exclude') return false; included = true; }
  }
  return !hasIncludes || included;
}

function snapshotMatches(actual: FileSnapshot, expected: FileSnapshot): boolean {
  return expected.checksum ? actual.checksum === expected.checksum : actual.size === expected.size && actual.modifiedAt === expected.modifiedAt;
}
export function compareEntries(local?: FileSnapshot & { precisionMs?: number }, remote?: FileSnapshot & { precisionMs?: number }, baseline?: ManifestEntry): ComparisonStatus {
  if (!local) return remote ? 'remote-only' : 'uncertain';
  if (!remote) return 'local-only';
  if (local.checksum && remote.checksum) return local.checksum === remote.checksum ? 'probably-identical' : baseline ? changedStatus(local, remote, baseline) : 'conflict';
  if (baseline) return changedStatus(local, remote, baseline);
  if (local.modifiedAt === null || remote.modifiedAt === null || !local.precisionMs || !remote.precisionMs) return 'uncertain';
  const difference = local.modifiedAt - remote.modifiedAt;
  const tolerance = Math.max(local.precisionMs, remote.precisionMs);
  if (Math.abs(difference) <= tolerance) return local.size === remote.size ? 'probably-identical' : 'uncertain';
  return difference > 0 ? 'local-newer' : 'remote-newer';
}
function changedStatus(local: FileSnapshot, remote: FileSnapshot, baseline: ManifestEntry): ComparisonStatus {
  if ((!remote.checksum || !baseline.remote.checksum) && (remote.modifiedAt === null || baseline.remote.modifiedAt === null)) return 'uncertain';
  const localChanged = !snapshotMatches(local, baseline.local);
  const remoteChanged = !snapshotMatches(remote, baseline.remote);
  if (localChanged && remoteChanged) return 'conflict';
  if (localChanged) return 'local-newer';
  if (remoteChanged) return 'remote-newer';
  return 'probably-identical';
}

