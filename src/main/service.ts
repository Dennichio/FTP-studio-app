import path from 'node:path';
import { constants, promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Api, AppSettings, ConnectionProfile, Credentials, DocumentData, FileEntry, KeyValueStore, LogEntry, Project, ReplacementPreview, Snippet, TransferJob, TransferRequest } from '../shared/contracts';
import { RemoteManager } from './remote';
import { TransferQueue, endpointIdentity } from './queue';
import { CredentialVault } from './storage';
import { PreviewServer, mimeTypes } from './preview';
import { PublishPlanner } from '../core/publishing';
import { assertSafeLocalPath, listLocal, mutateLocal, readTextFile, safeSaveTextFile, matchesFilters, isDefaultExcluded, isSensitivePath, boundedRegex, searchProject, previewReplace, applyReplace, mapLocalToRemote } from '../core/workspace';
import { discoverDependencies } from '../core/source';

export const defaultSettings: AppSettings = { theme: 'dark', showHidden: false, syncNavigation: true, editorFontSize: 14, wordWrap: true, autoUpload: false };
export interface NativeActions {
  chooseFolder(): Promise<string | null>; chooseFile(title?: string): Promise<string | null>;
  confirm(title: string, message: string): Promise<boolean>;
  openBrowser(url: string, browser?: 'default' | 'edge' | 'chrome'): Promise<void>;
}
const text = (value: unknown, label: string, max = 32768): string => { if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error(`${label} is ongeldig.`); return value; };
function plainProfile(value: ConnectionProfile): ConnectionProfile {
  const result: ConnectionProfile = { id: text(value.id, 'Profiel-id', 128), name: text(value.name, 'Profielnaam', 200), host: text(value.host, 'Host', 253), port: value.port, protocol: value.protocol, username: text(value.username, 'Gebruikersnaam', 512), localRoot: text(value.localRoot, 'Lokale map'), remoteRoot: text(value.remoteRoot || '/', 'Servermap'), timeoutMs: value.timeoutMs, connectionLimit: value.connectionLimit, parallelTransfers: value.parallelTransfers, autoReconnect: !!value.autoReconnect, passive: value.passive !== false };
  if (!result.id || !result.name || !result.host || !['ftp', 'ftps', 'ftps-implicit', 'sftp'].includes(result.protocol) || !Number.isInteger(result.port) || result.port < 1 || result.port > 65535 || !Number.isInteger(result.parallelTransfers) || result.parallelTransfers < 1 || result.parallelTransfers > 8 || !Number.isInteger(result.connectionLimit) || result.connectionLimit < 1 || result.connectionLimit > 64 || !Number.isInteger(result.timeoutMs) || result.timeoutMs < 1000 || result.timeoutMs > 300000) throw new Error('Ongeldige verbindingsinstellingen.');
  if (value.group) result.group = text(value.group, 'Groep', 200);
  if (value.privateKeyPath) result.privateKeyPath = text(value.privateKeyPath, 'SSH-sleutelpad');
  if (value.hostKeySha256) result.hostKeySha256 = text(value.hostKeySha256, 'SSH-vingerafdruk', 200);
  return result;
}

export class StudioService {
  readonly remote: RemoteManager;
  readonly queue: TransferQueue;
  readonly planner: PublishPlanner;
  readonly previewServer = new PreviewServer();
  private documents = new Map<string, DocumentData>();
  private searches = new Map<string, AbortController>();
  private replacePreviews = new Map<string, ReplacementPreview>();
  private logs: LogEntry[] = [];
  private secrets = new Set<string>();
  private cacheRoot: string;
  constructor(private store: KeyValueStore, private vault: CredentialVault, private dataRoot: string, private native: NativeActions, private emit: (event: 'queue' | 'log' | 'connections', value: unknown) => void) {
    this.cacheRoot = path.join(dataRoot, 'workcache');
    this.remote = new RemoteManager(id => { const credentials = vault.read(id); this.remember(credentials); return credentials; }, this.log, values => emit('connections', values));
    this.planner = new PublishPlanner(this.remote, store);
    this.queue = new TransferQueue(this.remote, store, this.log, jobs => emit('queue', jobs), async job => {
      if (job.sourceSnapshot) await this.planner.recordCompletion(job);
      if (job.direction === 'upload' && job.verifiedRemote) {
        for (const document of this.documents.values()) if (document.remote?.connectionId === job.connectionId && document.remote.path === job.remotePath && document.path === job.localPath && document.remote.endpointKey && document.remote.endpointKey === job.expectedEndpoint) document.remote.original = { ...job.verifiedRemote };
      }
    }, async (request, entry) => {
      if (!request.projectId) return true;
      const project = this.project(request.projectId);
      const remoteRelative = (): string | undefined => {
        const roots = [project.remoteRoot, ...project.environments.filter(e => e.profileId === request.connectionId).map(e => e.remoteRoot)]
          .filter(root => { const rel = path.posix.relative(root, request.remotePath); return rel !== '..' && !rel.startsWith('../') && !path.posix.isAbsolute(rel); })
          .sort((left, right) => right.length - left.length);
        return roots.length ? path.posix.relative(roots[0], request.remotePath) : undefined;
      };
      let relative: string;
      if (request.direction === 'upload') {
        relative = path.relative(project.localRoot, request.localPath).split(path.sep).join('/');
        if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
          if (request.expectedRemote === undefined || !request.localPath.startsWith(this.cacheRoot + path.sep)) return false;
          const mapped = remoteRelative(); if (mapped === undefined) return false;
          relative = mapped;
        }
      } else { const mapped = remoteRelative(); if (mapped === undefined) return false; relative = mapped; }
      const rules = entry.kind === 'directory' ? project.filters.transfer.filter(rule => rule.action === 'exclude') : project.filters.transfer;
      return matchesFilters({ ...entry, relativePath: relative }, rules);
    }, { trustedCacheRoot: this.cacheRoot });
  }
  private remember(credentials?: Credentials): void { for (const secret of [credentials?.password, credentials?.passphrase]) if (secret) this.secrets.add(secret); }
  readonly log = (level: LogEntry['level'], message: string, connectionId?: string): void => {
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) message = message.split(secret).join('[afgeschermd]');
    message = message.replace(/(password|passphrase|PASS|authorization)\s*[:= ]\s*\S+/gi, '$1 [afgeschermd]').replace(/-----BEGIN [\s\S]*?PRIVATE KEY-----[\s\S]*/g, '[privésleutel afgeschermd]');
    const entry = { id: randomUUID(), time: Date.now(), level, message: message.slice(0, 1200), connectionId };
    this.logs.push(entry); if (this.logs.length > 2000) this.logs.splice(0, this.logs.length - 2000); this.emit('log', entry);
  };
  private project(id: string): Project { const value = this.store.get<Project[]>('projects', []).find(p => p.id === id); if (!value) throw new Error('Project bestaat niet.'); return value; }
  private upsert<T extends { id: string }>(key: string, value: T): T { const list = this.store.get<T[]>(key, []).filter(item => item.id !== value.id); list.push(value); this.store.set(key, list); return value; }
  private remove<T extends { id: string }>(key: string, id: string): void { this.store.set(key, this.store.get<T[]>(key, []).filter(item => item.id !== id)); }
  private recoveryList(): DocumentData[] { return this.store.get<DocumentData[]>('recoveries', []); }
  private async openDocument(filename: string, connectionId?: string): Promise<DocumentData> {
    const endpointKey = connectionId ? endpointIdentity(this.remote.profile(connectionId)) : undefined;
    // Renderer owns open-tab reuse. A new open command must re-read actual disk/server
    // metadata, otherwise closing/reopening could silently return a stale workcache.
    const id = randomUUID(); let remote: DocumentData['remote']; let local = filename;
    if (connectionId) {
      const lease = await this.remote.acquire(connectionId, 'navigation');
      try {
        const original = await lease.session.stat(filename);
        if (!original || original.kind !== 'file' || original.size > 8 * 1024 * 1024) throw new Error('Serverbestand is geen tekstbestand tot 8 MB.');
        const directory = path.join(this.cacheRoot, id); await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const basename = path.posix.basename(filename);
        if (!basename || /[<>:"|?*\x00-\x1f\\]/.test(basename) || /[. ]$/.test(basename) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(basename)) throw new Error('Serverbestandsnaam is niet veilig voor de Windows-werkcache.');
        local = path.join(directory, basename);
        await lease.session.download(filename, local, () => {}, new AbortController().signal);
        const after = await lease.session.stat(filename);
        if (!after || after.size !== original.size || after.modifiedAt !== original.modifiedAt || (await fs.stat(local)).size !== original.size) throw new Error('Serverbestand wijzigde tijdens het openen. Probeer opnieuw.');
        if (endpointIdentity(this.remote.profile(connectionId)) !== endpointKey) throw new Error('De verbindingsbestemming wijzigde tijdens het openen. Open het bestand opnieuw.');
        remote = { connectionId, path: filename, endpointKey, original: { size: original.size, modifiedAt: original.modifiedAt, checksum: original.checksum } };
        this.log('info', `Serverbestand geopend: ${filename}`, connectionId);
      } finally { await lease.release(); }
    }
    const file = await readTextFile(local);
    const document: DocumentData = { id, path: path.resolve(local), name: path.basename(local), content: file.content, eol: file.eol, encoding: 'utf8', original: file.snapshot, ...(remote ? { remote } : {}) };
    this.documents.set(id, document); return structuredClone(document);
  }
  async invoke<K extends keyof Api>(command: K, raw: Api[K]['args']): Promise<Api[K]['result']> {
    // IPC sender is separately authenticated in main.ts. The payload is still bounded and commands validated.
    if (JSON.stringify(raw ?? null).length > 12 * 1024 * 1024) throw new Error('Opdracht is te groot.');
    const a = (raw ?? {}) as any;
    let result: unknown;
    switch (command) {
      case 'bootstrap': {
        const recoveries = this.recoveryList();
        for (const d of recoveries) if (!this.documents.has(d.id)) this.documents.set(d.id, { ...d });
        result = { profiles: this.store.get('profiles', []), projects: this.store.get('projects', []), settings: this.store.get('settings', defaultSettings), snippets: this.store.get('snippets', []), connections: this.remote.states(), queue: this.queue.jobs(), logs: this.logs, recoveries }; break;
      }
      case 'chooseFolder': result = await this.native.chooseFolder(); break;
      case 'chooseFile': result = await this.native.chooseFile(a.title); break;
      case 'listLocal': result = await listLocal(text(a.path, 'Pad'), !!a.showHidden, a.filters ?? []); break;
      case 'mutateLocal': {
        if (a.operation === 'delete' && !await this.native.confirm('Lokaal verwijderen', `Definitief verwijderen: ${text(a.path, 'Pad')}?`)) break;
        if (!['mkdir', 'create', 'rename', 'delete', 'copy', 'move'].includes(a.operation)) throw new Error('Onbekende bestandsbewerking.');
        await mutateLocal(a.operation, text(a.path, 'Pad'), a.destination === undefined ? undefined : text(a.destination, 'Bestemming')); break;
      }
      case 'saveProfile': {
        const profile = plainProfile(a.profile); await assertSafeLocalPath(profile.localRoot);
        if (a.credentials && Object.values(a.credentials).some(Boolean)) { this.remember(a.credentials); this.vault.save(profile.id, a.credentials); }
        result = this.upsert('profiles', profile); break;
      }
      case 'deleteProfile': await this.remote.disconnect(text(a.id, 'Profiel')); this.vault.delete(a.id); this.remove('profiles', a.id); break;
      case 'connect': this.remember(a.credentials); result = await this.remote.connect(plainProfile(a.profile), a.credentials && Object.values(a.credentials).some(Boolean) ? a.credentials : undefined); break;
      case 'disconnect': await this.queue.action('pause', this.queue.jobs().filter(j => j.connectionId === a.connectionId).map(j => j.id)); await this.remote.disconnect(text(a.connectionId, 'Verbinding')); break;
      case 'listRemote': case 'statRemote': {
        const lease = await this.remote.acquire(text(a.connectionId, 'Verbinding'), 'navigation');
        try { result = command === 'listRemote' ? await lease.session.list(text(a.path, 'Serverpad')) : await lease.session.stat(text(a.path, 'Serverpad')); this.log('debug', `Metadata gelezen: ${a.path}`, a.connectionId); } finally { await lease.release(); } break;
      }
      case 'mutateRemote': {
        text(a.path, 'Serverpad'); const root = this.remote.profile(a.connectionId).remoteRoot;
        if (path.posix.normalize(a.path) === path.posix.normalize(root) && a.operation !== 'mkdir') throw new Error('De gekoppelde serverhoofdmap kan niet worden gewijzigd.');
        if (['delete', 'chmod'].includes(a.operation) && !await this.native.confirm(a.operation === 'delete' ? 'Serverbestand verwijderen' : 'Serverrechten wijzigen', `${a.path}${a.mode ? ` → ${a.mode}` : ''}${a.recursive ? '\nInclusief alle onderliggende bestanden.' : ''}?`)) break;
        const lease = await this.remote.acquire(a.connectionId, 'navigation');
        try {
          if (a.operation === 'mkdir') await lease.session.mkdir(a.path);
          else if (a.operation === 'rename') await lease.session.rename(a.path, text(a.destination, 'Bestemming'));
          else if (a.operation === 'delete') {
            // Inspect the complete tree before deleting anything. A symlink or an
            // unsafe server listing must not leave a partially deleted selection.
            const removals: { path: string; directory: boolean }[] = [];
            const inspect = async (target: string, depth = 0): Promise<void> => {
              if (depth > 128 || removals.length >= 20000) throw new Error('Te veel items of te diepe mappen voor recursief verwijderen.');
              const entry = await lease.session.stat(target);
              if (!entry || entry.kind === 'symlink') throw new Error('Ontbrekend bestand of symbolische koppeling; niets verwijderd.');
              if (entry.kind === 'directory' && a.recursive) {
                for (const child of await lease.session.list(target)) {
                  if (!child.name || child.name === '.' || child.name === '..' || /[\\/\x00-\x1f\x7f]/.test(child.name) || child.kind === 'symlink') throw new Error('Onveilige servermap; niets verwijderd.');
                  await inspect(path.posix.join(target, child.name), depth + 1);
                }
              }
              removals.push({ path: target, directory: entry.kind === 'directory' });
            };
            await inspect(a.path);
            for (const removal of removals) await lease.session.remove(removal.path, removal.directory);
          }
          else if (a.operation === 'chmod') {
            if (!/^[0-7]{3,4}$/.test(a.mode)) throw new Error('Gebruik Unix-rechten zoals 644 of 755.');
            let count = 0;
            const change = async (target: string): Promise<void> => {
              if (++count > 20000) throw new Error('Te veel items voor recursieve rechtenwijziging.');
              const entry = await lease.session.stat(target); if (!entry || entry.kind === 'symlink') throw new Error('Ontbrekend bestand of symbolische koppeling.');
              if (a.recursive && entry.kind === 'directory') for (const child of await lease.session.list(target)) await change(child.path);
              await lease.session.chmod(target, a.mode);
            }; await change(a.path);
          } else throw new Error('Onbekende serverbewerking.');
          this.log('info', `Serverbewerking ${a.operation}: ${a.path}`, a.connectionId);
        } finally { await lease.release(); } break;
      }
      case 'searchRemote': {
        const controller = new AbortController(); this.searches.get(a.requestId)?.abort(); this.searches.set(text(a.requestId, 'Zoek-id'), controller);
        const matcher = a.query.regex ? boundedRegex(a.query.text, a.query.caseSensitive ? '' : 'i') : null;
        const needle = a.query.caseSensitive ? a.query.text : a.query.text.toLowerCase();
        const entries: FileEntry[] = []; const pending = [text(a.root, 'Zoekmap')]; let scanned = 0;
        try {
          while (pending.length) {
            controller.signal.throwIfAborted(); const folder = pending.pop()!; const lease = await this.remote.acquire(a.connectionId, 'navigation', controller.signal);
            try { for (const entry of await lease.session.list(folder, controller.signal)) {
              if (++scanned > 50000) throw new Error('Zoekopdracht overschrijdt 50.000 items; beperk de zoekmap.');
              if (entry.kind === 'symlink') continue;
              if (matcher ? matcher.test(entry.name) : (a.query.caseSensitive ? entry.name : entry.name.toLowerCase()).includes(needle)) entries.push(entry);
              if (entry.kind === 'directory') pending.push(entry.path);
            } } finally { await lease.release(); }
          } result = entries;
        } finally { this.searches.delete(a.requestId); } break;
      }
      case 'cancelSearch': this.searches.get(a.requestId)?.abort(); break;
      case 'openDocument': result = await this.openDocument(text(a.path, 'Pad'), a.connectionId); break;
      case 'saveDocument': {
        const doc = this.documents.get(a.id); if (!doc) throw new Error('Document is niet geopend.');
        const content = text(a.content, 'Document', 8 * 1024 * 1024);
        const target = a.path ? text(a.path, 'Opslagpad') : doc.path;
        if (target !== doc.path && !await this.native.confirm('Opslaan als', `Document opslaan als ${target}? Een bestaand bestand wordt beschermd tegen overschrijven.`)) throw new Error('Opslaan geannuleerd.');
        const file = await safeSaveTextFile(target, content, target === doc.path ? doc.original : null);
        const updated: DocumentData = { ...doc, path: target, name: path.basename(target), content, original: file.snapshot, eol: file.eol, ...(target !== doc.path ? { remote: undefined } : {}) };
        this.documents.set(doc.id, updated); this.remove('recoveries', doc.id); result = structuredClone(updated); break;
      }
      case 'recoverDocument': {
        const doc = this.documents.get(a.id); if (!doc) throw new Error('Document is niet geopend.');
        this.upsert('recoveries', { ...doc, content: text(a.content, 'Hersteltekst', 8 * 1024 * 1024), recovery: true }); break;
      }
      case 'discardRecovery': this.remove('recoveries', a.id); break;
      case 'enqueue': {
        if (!Array.isArray(a.requests) || a.requests.length > 100000) throw new Error('Ongeldige overdrachtslijst.');
        for (const request of a.requests as TransferRequest[]) {
          const cacheRelative = path.relative(this.cacheRoot, path.resolve(text(request.localPath, 'Lokaal overdrachtspad')));
          if (cacheRelative !== '..' && !cacheRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(cacheRelative)) {
            const document = [...this.documents.values()].find(d => d.path === path.resolve(request.localPath) && d.remote?.connectionId === request.connectionId && d.remote.path === request.remotePath);
            const endpoint = endpointIdentity(this.remote.profile(request.connectionId));
            if (request.direction !== 'upload' || !document?.remote?.endpointKey || document.remote.endpointKey !== endpoint) throw new Error('Het cachebestand hoort niet bij deze bevestigde serverbestemming. Open het serverbestand opnieuw voordat u uploadt.');
            if (request.expectedEndpoint !== undefined && request.expectedEndpoint !== document.remote.endpointKey) throw new Error('De uploadbestemming is gewijzigd sinds de opdracht. Open het document opnieuw.');
            request.expectedEndpoint = document.remote.endpointKey;
            if (!request.projectId) {
              const candidates = this.store.get<Project[]>('projects', []).flatMap(project => [
                ...(project.profileId === request.connectionId ? [{ project, root: project.remoteRoot }] : []),
                ...project.environments.filter(e => e.profileId === request.connectionId).map(e => ({ project, root: e.remoteRoot })),
              ]).filter(candidate => { const rel = path.posix.relative(candidate.root, request.remotePath); return rel !== '..' && !rel.startsWith('../') && !path.posix.isAbsolute(rel); }).sort((a, b) => b.root.length - a.root.length);
              if (candidates.length) {
                if (candidates.some(c => c.root.length === candidates[0].root.length && c.project.id !== candidates[0].project.id)) throw new Error('Meerdere projecten gebruiken deze servermap. Open het juiste project voordat u uploadt.');
                request.projectId = candidates[0].project.id;
              }
            }
            if (request.expectedRemote === undefined) request.expectedRemote = { ...document.remote.original };
          }
          if (request.allowSensitive && !await this.native.confirm('Gevoelig bestand publiceren', `Expliciet toestaan dat gevoelige bestanden uit ${request.localPath} worden gepubliceerd?`)) throw new Error('Publicatie van gevoelige bestanden geannuleerd.');
          if (request.projectId) { const project = this.project(request.projectId); if (project.environments.some(e => e.production && e.profileId === request.connectionId && (request.remotePath === e.remoteRoot || request.remotePath.startsWith(e.remoteRoot.replace(/\/$/, '') + '/'))) && !await this.native.confirm('Publiceren naar productie', `Deze overdracht wijzigt productie: ${request.remotePath}. Doorgaan?`)) throw new Error('Productiepublicatie geannuleerd.'); }
        }
        result = await this.queue.enqueue(a.requests); break;
      }
      case 'queueAction': await this.queue.action(a.action, a.ids, a.priority); break;
      case 'saveProject': {
        const project = a.project as Project; text(project.id, 'Project-id', 128); text(project.name, 'Projectnaam', 200); await assertSafeLocalPath(project.localRoot);
        if (!project.filters || !Array.isArray(project.filters.display) || !Array.isArray(project.filters.transfer) || !Array.isArray(project.filters.sync) || !Array.isArray(project.environments) || !Array.isArray(project.bookmarks)) throw new Error('Projectinstellingen zijn ongeldig.');
        if (project.previewUrl) { const url = new URL(project.previewUrl); if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('Dynamische preview vereist een lokale HTTP(S)-URL zonder aanmeldgegevens.'); }
        result = this.upsert('projects', project); break;
      }
      case 'deleteProject': this.remove('projects', a.id); break;
      case 'saveSettings': {
        const settings = a.settings as AppSettings; if (!['dark', 'light', 'system'].includes(settings.theme) || !Number.isFinite(settings.editorFontSize) || settings.editorFontSize < 9 || settings.editorFontSize > 40) throw new Error('Ongeldige editorinstellingen.'); this.store.set('settings', settings); break;
      }
      case 'saveSnippet': { const snippet = a.snippet as Snippet; text(snippet.id, 'Fragment-id', 128); text(snippet.name, 'Fragmentnaam', 200); text(snippet.body, 'Codefragment', 200000); result = this.upsert('snippets', snippet); break; }
      case 'deleteSnippet': this.remove('snippets', a.id); break;
      case 'searchProject': {
        const controller = new AbortController(); this.searches.set(a.requestId, controller);
        try { result = await searchProject(this.project(a.projectId).localRoot, a.query, controller.signal); } finally { this.searches.delete(a.requestId); } break;
      }
      case 'previewReplace': {
        const changes = await previewReplace(this.project(a.projectId).localRoot, a.query, text(a.replacement, 'Vervanging', 100000));
        this.replacePreviews.clear(); for (const change of changes) this.replacePreviews.set(change.path, change); result = changes; break;
      }
      case 'applyReplace': {
        const changes = a.changes as ReplacementPreview[];
        if (!Array.isArray(changes) || changes.some(c => JSON.stringify(this.replacePreviews.get(c.path)) !== JSON.stringify(c))) throw new Error('Vervangingsvoorbeeld is verlopen of gewijzigd. Maak een nieuw voorbeeld.');
        if (!await this.native.confirm('Projectbreed vervangen', `${changes.length} bestanden wijzigen? Er worden lokale back-ups gemaakt.`)) throw new Error('Vervangen geannuleerd.');
        result = await applyReplace(changes); this.replacePreviews.clear(); break;
      }
      case 'relatedFiles': {
        const project = this.project(a.projectId); const source = await assertSafeLocalPath(a.path, project.localRoot); const related: string[] = [];
        for (const reference of discoverDependencies(a.content, path.extname(source).slice(1))) {
          if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(reference)) continue;
          let decoded: string; try { decoded = decodeURIComponent(reference.split(/[?#]/)[0]); } catch { continue; }
          const candidate = decoded.startsWith('/') ? path.resolve(project.localRoot, '.' + decoded) : path.resolve(path.dirname(source), decoded);
          const relative = path.relative(project.localRoot, candidate);
          if (isSensitivePath(relative) || isDefaultExcluded(relative)) continue;
          try { await assertSafeLocalPath(candidate, project.localRoot); if ((await fs.stat(candidate)).isFile()) related.push(candidate); } catch { /* Missing and outside-root refs are not openable. */ }
        } result = [...new Set(related)]; break;
      }
      case 'createPublishPlan': result = await this.planner.createPlan(this.project(a.projectId), a.connectionId, a); break;
      case 'executePublishPlan': {
        const plan = this.planner.getPlan(a.planId);
        if (plan.production && (!a.productionConfirmed || !await this.native.confirm('Publiceren naar productie', `Geselecteerde wijzigingen nu naar productie publiceren?`))) throw new Error('Productiepublicatie niet bevestigd.');
        result = await this.queue.enqueue(await this.planner.requestsForPlan(a.planId, a.selectedPaths, !!a.productionConfirmed)); break;
      }
      case 'readAsset': {
        const project = this.project(a.projectId); const target = await assertSafeLocalPath(a.path, project.localRoot); const relative = path.relative(project.localRoot, target);
        if (isSensitivePath(relative) || isDefaultExcluded(relative)) throw new Error('Gevoelige of uitgesloten bestanden zijn niet beschikbaar voor preview.');
        const mime = mimeTypes[path.extname(target).toLowerCase()]; if (!mime || /text\/html|text\/javascript|application\/json/.test(mime)) throw new Error('Dit bestandstype kan niet als previewasset worden gelezen.');
        const limit = 8 * 1024 * 1024;
        const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const before = await handle.stat();
          if (!before.isFile() || before.size > limit) throw new Error('Previewasset moet een gewoon bestand tot 8 MB zijn.');
          const chunks: Buffer[] = []; let length = 0;
          while (length <= limit) {
            const buffer = Buffer.allocUnsafe(Math.min(65536, limit + 1 - length));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            length += bytesRead; chunks.push(buffer.subarray(0, bytesRead));
          }
          const after = await handle.stat();
          if (length > limit || length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('Previewasset wijzigde tijdens het lezen.');
          result = { mime, base64: Buffer.concat(chunks, length).toString('base64') };
        } finally { await handle.close(); }
        break;
      }
      case 'preview': {
        const project = this.project(a.projectId); const target = await assertSafeLocalPath(a.path, project.localRoot);
        let url: string;
        if (project.previewUrl && /\.(?:php\d*|phtml)$/i.test(target)) { const relative = path.relative(project.localRoot, target).split(path.sep).map(encodeURIComponent).join('/'); url = new URL(relative, project.previewUrl.endsWith('/') ? project.previewUrl : project.previewUrl + '/').href; }
        else url = await this.previewServer.url(project.localRoot, target);
        if (a.external) await this.native.openBrowser(url, a.browser); result = url; break;
      }
      default: throw new Error('Onbekende desktopopdracht.');
    }
    return result as Api[K]['result'];
  }
  async close(): Promise<void> { for (const controller of this.searches.values()) controller.abort(); await this.queue.close(); await this.remote.close(); await this.previewServer.close(); }
}
