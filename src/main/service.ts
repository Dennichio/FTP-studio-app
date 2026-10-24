import path from 'node:path';
import { constants, promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Api, AppSettings, ConnectionProfile, Credentials, DocumentComparison, DocumentData, FileEntry, KeyValueStore, LogEntry, Project, ReplacementPreview, RemoteSession, Snippet, TransferJob, TransferRequest } from '../shared/contracts';
import { RemoteManager, createProtocolSession } from './remote';
import { TransferQueue, endpointIdentity } from './queue';
import { CredentialVault } from './storage';
import { PreviewServer, mimeTypes } from './preview';
import { PublishPlanner } from '../core/publishing';
import { assertSafeLocalPath, listLocal, mutateLocal, readTextFile, localSnapshot, safeSaveTextFile, matchesFilters, isDefaultExcluded, isSensitivePath, searchProject, previewReplace, applyReplace, mapLocalToRemote } from '../core/workspace';
import { collectDependencyReferences } from '../core/phpDependencies';
import { searchRemoteEntries } from './remoteSearch';
import { credentialIdentity } from '../core/connectionIdentity';
import { boundedRegex } from '../core/browserWorkspace';
import { checkedRemoteActionPath, prepareRemoteFileAction, removeRemoteActionSource, type PreparedRemoteFile } from './remoteFileActions';
import { compareLocalDocument, compareRemoteDocument } from './documentComparison';

export const defaultSettings: AppSettings = { theme: 'dark', showHidden: false, syncNavigation: true, editorFontSize: 14, wordWrap: true, autoUpload: false };
export interface NativeActions {
  chooseFolder(): Promise<string | null>; chooseFile(title?: string): Promise<string | null>;
  chooseSaveFile(defaultPath: string): Promise<string | null>;
  confirm(title: string, message: string): Promise<boolean>;
  openBrowser(url: string, browser?: 'default' | 'edge' | 'chrome'): Promise<void>;
}
const text = (value: unknown, label: string, max = 32768): string => { if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error(`${label} is ongeldig.`); return value; };
function suppliedCredentials(value: unknown): Credentials | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Ongeldige aanmeldgegevens.');
  const raw = value as Credentials, credentials: Credentials = {};
  for (const key of ['password', 'passphrase'] as const) if (raw[key] !== undefined) credentials[key] = text(raw[key], 'Aanmeldgegeven');
  return Object.keys(credentials).length ? credentials : undefined;
}
function checkedFilters(value: unknown): void {
  if (!value || typeof value !== 'object') throw new Error('Ongeldige filtersets.');
  for (const scope of ['display', 'transfer', 'sync'] as const) {
    const rules = (value as Record<string, unknown>)[scope];
    if (!Array.isArray(rules) || rules.length > 500) throw new Error('Een filterset mag maximaal 500 regels bevatten.');
    const ids = new Set<string>();
    for (const rule of rules) {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error('Ongeldige filterregel.');
      const id = text(rule.id, 'Filterregel-id', 128);
      if (!id.trim() || ids.has(id) || !['include', 'exclude'].includes(rule.action) || !['name', 'extension', 'path', 'directory', 'size', 'modified'].includes(rule.field) || !['glob', 'regex', 'equals', 'gt', 'lt'].includes(rule.operator)) throw new Error('Ongeldige filterregel.');
      ids.add(id);
      const pattern = text(rule.value, 'Filterwaarde', ['glob', 'regex'].includes(rule.operator) ? 256 : 32768);
      if (rule.operator === 'regex') boundedRegex(pattern);
      if (['gt', 'lt'].includes(rule.operator) && (!pattern.trim() || !Number.isFinite(Number(pattern)))) throw new Error('Filtergrens is geen geldig getal.');
    }
  }
}
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
  private fileActions = new Set<AbortController>();
  private fileActionRuns = new Set<Promise<TransferJob[]>>();
  private comparisons = new Set<AbortController>();
  private comparisonRuns = new Set<Promise<DocumentComparison>>();
  private actionSources: Set<string>;
  private actionSourceReconciliation: Promise<void>;
  private testingProfiles = new Set<string>();
  private testSessions = new Set<RemoteSession>();
  private closingTests = new WeakMap<RemoteSession, Promise<void>>();
  private closed = false;
  private replacePreviews = new Map<string, ReplacementPreview>();
  private logs: LogEntry[] = [];
  private secrets = new Set<string>();
  private cacheRoot: string;
  constructor(private store: KeyValueStore, private vault: CredentialVault, private dataRoot: string, private native: NativeActions, private emit: (event: 'queue' | 'log' | 'connections', value: unknown) => void) {
    this.cacheRoot = path.join(dataRoot, 'workcache');
    const sources = store.get<string[]>('remoteActionSources.v1', []);
    if (!Array.isArray(sources) || sources.some(source => typeof source !== 'string')) throw new Error('Ongeldige herstelregistratie voor serverbestandsacties.');
    this.actionSources = new Set(sources);
    this.remote = new RemoteManager(id => {
      const saved = this.store.get<ConnectionProfile[]>('profiles', []).find(profile => profile.id === id);
      const credentials = saved ? vault.read(id, credentialIdentity(saved)) : {};
      this.remember(credentials); return credentials;
    }, this.log, values => emit('connections', values));
    this.planner = new PublishPlanner(this.remote, store);
    this.queue = new TransferQueue(this.remote, store, this.log, jobs => emit('queue', jobs), async job => {
      if (job.sourceSnapshot) await this.planner.recordCompletion(job);
      if (job.direction === 'upload' && job.verifiedRemote) {
        for (const document of this.documents.values()) if (document.remote?.connectionId === job.connectionId && document.remote.path === job.remotePath && document.path === job.localPath && document.remote.endpointKey && document.remote.endpointKey === job.expectedEndpoint) document.remote.original = { ...job.verifiedRemote };
      }
      await this.releaseActionSource(job.localPath);
    }, async (request, entry) => {
      if (!request.projectId) return true;
      const project = this.project(request.projectId);
      const remoteRelative = (): string | undefined => {
        const roots = [project.remoteRoot, ...project.environments.filter(e => e.profileId === request.connectionId).map(e => e.remoteRoot)]
          .filter(root => { const rel = path.posix.relative(root, request.remotePath); return rel !== '..' && !rel.startsWith('../') && !path.posix.isAbsolute(rel); })
          .sort((left, right) => right.length - left.length);
        return roots.length ? path.posix.relative(roots[0], request.remotePath) : undefined;
      };
      let relative: string, filterEntry = entry;
      if (request.direction === 'upload') {
        if (request.expectedRemote !== undefined && request.localPath.startsWith(this.cacheRoot + path.sep)) {
          const mapped = remoteRelative(); if (mapped === undefined) return false;
          relative = mapped;
          filterEntry = { ...entry, name: path.posix.basename(request.remotePath), path: request.remotePath };
        } else {
          relative = path.relative(project.localRoot, request.localPath).split(path.sep).join('/');
          if (request.localRootOverride && (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative))) relative = path.relative(request.localRootOverride, request.localPath).split(path.sep).join('/');
          if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return false;
        }
      } else { const mapped = remoteRelative(); if (mapped === undefined) return false; relative = mapped; }
      const rules = entry.kind === 'directory' ? project.filters.transfer.filter(rule => rule.action === 'exclude') : project.filters.transfer;
      return matchesFilters({ ...filterEntry, relativePath: relative }, rules);
    }, { trustedCacheRoot: this.cacheRoot });
    // Restored jobs never start automatically. Keep every retryable source, and
    // remove only registered completed/orphaned sources left by an interrupted setup.
    const retained = new Set(this.queue.jobs(true).filter(job => job.status !== 'completed').map(job => job.localPath));
    this.actionSourceReconciliation = (async () => {
      for (const source of sources) if (!retained.has(source)) {
        try { await this.releaseActionSource(source); }
        catch (error) { this.log('warning', `Private serverbestandsbron kon niet worden opgeruimd: ${String(error)}`); }
      }
    })();
  }
  private remember(credentials?: Credentials): void { for (const secret of [credentials?.password, credentials?.passphrase]) if (secret) this.secrets.add(secret); }
  private connectionCredentials(profile: ConnectionProfile, raw: unknown): Credentials {
    const supplied = suppliedCredentials(raw);
    if (supplied) return { ...supplied };
    const saved = this.store.get<ConnectionProfile[]>('profiles', []).find(item => item.id === profile.id);
    if (!saved) return {};
    if (credentialIdentity(saved) !== credentialIdentity(profile)) throw new Error('De aanmeldbestemming is gewijzigd. Vul de aanmeldgegevens opnieuw in.');
    return { ...this.vault.read(profile.id, credentialIdentity(profile)) };
  }
  private closeTestSession(session: RemoteSession): Promise<void> {
    const existing = this.closingTests.get(session); if (existing) return existing;
    const pending = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([Promise.resolve().then(() => session.close()), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('De testsessie kon niet tijdig worden gesloten.')), 2000); })]); }
      finally { if (timer) clearTimeout(timer); this.testSessions.delete(session); }
    })();
    this.closingTests.set(session, pending); return pending;
  }
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
  private checkEndpoint(connectionId: string, expected?: string): string {
    const current = endpointIdentity(this.remote.profile(text(connectionId, 'Verbinding')));
    if (expected !== undefined && expected !== current) throw new Error('De serverbestemming is gewijzigd. Vernieuw het paneel en voer de opdracht opnieuw uit.');
    return current;
  }
  private async releaseActionSource(localPath: string): Promise<void> {
    if (!this.actionSources.has(localPath)) return;
    await removeRemoteActionSource(this.cacheRoot, localPath);
    this.actionSources.delete(localPath); this.store.set('remoteActionSources.v1', [...this.actionSources]);
  }
  private async authorizeRemoteFileAction(profile: ConnectionProfile, session: RemoteSession, endpoint: string, source: FileEntry | null, destination: string, projectId?: string): Promise<void> {
    if (!projectId) return;
    const project = this.project(text(projectId, 'Project-id', 128));
    const contained = (root: string, target: string) => { const relative = path.posix.relative(root, target); return relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative); };
    const roots = [...(!project.profileId || project.profileId === profile.id ? [project.remoteRoot] : []), ...project.environments.filter(env => env.profileId === profile.id).map(env => env.remoteRoot)];
    const checkFilters = async (target: string, entry: FileEntry): Promise<void> => {
      const root = roots.filter(root => contained(root, target)).sort((a, b) => b.length - a.length)[0];
      if (!root) throw new Error('Het serverpad hoort niet bij de gekozen projectverbinding.');
      if (!matchesFilters({ ...entry, name: path.posix.basename(target), path: target, relativePath: path.posix.relative(root, target) }, project.filters.transfer)) throw new Error('Dit serverbestand is uitgesloten door de overdrachtsfilters van het project.');
      // Directory exclusions also apply to every descendant of an excluded folder.
      let parent = path.posix.dirname(target);
      while (contained(root, parent) && contained(profile.remoteRoot, parent)) {
        this.checkEndpoint(profile.id, endpoint);
        const ancestor = await session.stat(parent);
        if (!ancestor || ancestor.kind !== 'directory' || !matchesFilters({ ...ancestor, relativePath: path.posix.relative(root, parent) }, project.filters.transfer.filter(rule => rule.action === 'exclude'))) throw new Error('De bovenliggende servermap is onveilig of uitgesloten door de projectfilters.');
        if (parent === path.posix.normalize(root) || parent === '/') break;
        parent = path.posix.dirname(parent);
      }
    };
    if (source) await checkFilters(source.path, source);
    await checkFilters(destination, source || { name: path.posix.basename(destination), path: destination, kind: 'file', size: 0, modifiedAt: null });
    if (project.environments.some(env => env.production && env.profileId === profile.id && contained(env.remoteRoot, destination)) &&
        !await this.native.confirm('Serverbestand op productie aanmaken', `Deze bewerking maakt een nieuw bestand op productie: ${profile.host} · ${destination}. Bestaande bestanden worden niet vervangen.`)) throw new Error('Serverbewerking op productie geannuleerd.');
    this.checkEndpoint(profile.id, endpoint);
  }
  private async enqueueRemoteFileAction(args: Api['createRemoteFile']['args'] | Api['copyRemoteFile']['args'], copy: boolean): Promise<TransferJob[]> {
    const operation = this.runRemoteFileAction(args, copy); this.fileActionRuns.add(operation);
    try { return await operation; } finally { this.fileActionRuns.delete(operation); }
  }
  private async runRemoteFileAction(args: Api['createRemoteFile']['args'] | Api['copyRemoteFile']['args'], copy: boolean): Promise<TransferJob[]> {
    await this.actionSourceReconciliation;
    if (this.closed) throw new Error('De werkruimte is gesloten.');
    const connectionId = text(args.connectionId, 'Verbinding', 128), expectedEndpoint = text(args.expectedEndpoint, 'Serveridentiteit', 4096);
    if (!expectedEndpoint) throw new Error('Een bevestigde serveridentiteit is vereist.');
    const endpoint = this.checkEndpoint(connectionId, expectedEndpoint), profile = this.remote.profile(connectionId);
    const source = checkedRemoteActionPath(profile.remoteRoot, text(args.path, 'Serverpad'));
    const copyArgs = 'destination' in args ? args : undefined;
    if (copy && !copyArgs) throw new Error('Een kopieerbestemming en gecontroleerde bron zijn vereist.');
    const action = copy && copyArgs ? { kind: 'copy' as const, path: source, destination: checkedRemoteActionPath(profile.remoteRoot, text(copyArgs.destination, 'Bestemming')), expectedSource: copyArgs.expectedSource } : { kind: 'create' as const, path: source };
    if (this.fileActions.size >= 4) throw new Error('Er worden al vier serverbestanden voorbereid. Wacht tot die klaar zijn.');
    const controller = new AbortController(); this.fileActions.add(controller);
    let prepared: PreparedRemoteFile | undefined;
    let lease;
    const check = () => { if (this.closed || controller.signal.aborted) throw new DOMException('Serverbewerking geannuleerd.', 'AbortError'); this.checkEndpoint(connectionId, endpoint); };
    try {
      lease = await this.remote.acquire(connectionId, 'transfer', controller.signal); check();
      const session = lease.session;
      prepared = await prepareRemoteFileAction(session, profile, this.cacheRoot, action, controller.signal, check,
        (entry, target) => this.authorizeRemoteFileAction(profile, session, endpoint, entry, target, args.projectId));
      this.actionSources.add(prepared.localPath); this.store.set('remoteActionSources.v1', [...this.actionSources]);
      await lease.release(); lease = undefined; check();
      const jobs = await this.queue.enqueue([{ connectionId, expectedEndpoint: endpoint, direction: 'upload', localPath: prepared.localPath, remotePath: prepared.remotePath,
        expectedLocal: prepared.localSnapshot, expectedRemote: null, overwriteExisting: false, projectId: args.projectId }]);
      if (jobs.length !== 1) throw new Error('Het serverbestand is niet ingepland; controleer de overdrachtsfilters.');
      return jobs;
    } finally {
      try { if (lease) await lease.release(); }
      finally {
        this.fileActions.delete(controller);
        const sourcePath = prepared?.localPath;
        if (sourcePath && !this.queue.jobs().some(job => job.localPath === sourcePath)) await this.releaseActionSource(sourcePath);
      }
    }
  }
  private async openDocument(filename: string, connectionId?: string, expectedEndpoint?: string): Promise<DocumentData> {
    const endpointKey = connectionId ? this.checkEndpoint(connectionId, expectedEndpoint) : undefined;
    // Renderer owns open-tab reuse. A new open command must re-read actual disk/server
    // metadata, otherwise closing/reopening could silently return a stale workcache.
    const id = randomUUID(); let remote: DocumentData['remote']; let local = filename;
    if (connectionId) {
      const lease = await this.remote.acquire(connectionId, 'navigation');
      try {
        this.checkEndpoint(connectionId, endpointKey);
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
  private async compareDocument(id: string): Promise<DocumentComparison> {
    if (this.closed) throw new Error('De werkruimte is gesloten.');
    const registered = this.documents.get(text(id, 'Document-id', 128));
    if (!registered) throw new Error('Document is niet geopend.');
    if (this.comparisons.size >= 4) throw new Error('Er worden al vier documenten vergeleken. Wacht tot die klaar zijn.');
    const document = structuredClone(registered), binding = document.remote;
    const profile = binding ? this.remote.profile(binding.connectionId) : undefined;
    if (binding && !binding.endpointKey) throw new Error('De serveridentiteit van dit document ontbreekt. Open het document opnieuw.');
    if (binding) this.checkEndpoint(binding.connectionId, binding.endpointKey);
    const controller = new AbortController(); this.comparisons.add(controller);
    const check = () => {
      if (this.closed) throw new DOMException('Documentvergelijking geannuleerd.', 'AbortError');
      const current = this.documents.get(document.id);
      if (!current || current.path !== document.path || current.remote?.connectionId !== binding?.connectionId || current.remote?.path !== binding?.path || current.remote?.endpointKey !== binding?.endpointKey) throw new Error('De documentbestemming wijzigde tijdens de vergelijking. Open het bestand opnieuw.');
      if (binding) this.checkEndpoint(binding.connectionId, binding.endpointKey);
    };
    const timer = setTimeout(() => controller.abort(new Error('Documentvergelijking duurde te lang. Probeer opnieuw.')), profile?.timeoutMs ?? 15000);
    const operation = (async () => {
      if (!binding || !profile) return compareLocalDocument(document.path, controller.signal, check);
      const lease = await this.remote.acquire(binding.connectionId, 'transfer', controller.signal);
      try { check(); return await compareRemoteDocument(lease.session, profile.remoteRoot, binding.path, path.join(this.dataRoot, 'comparisons'), controller.signal, check); }
      finally { await lease.release(); }
    })();
    this.comparisonRuns.add(operation);
    const done = () => { clearTimeout(timer); this.comparisons.delete(controller); this.comparisonRuns.delete(operation); };
    void operation.then(done, done);
    let abort: (() => void) | undefined;
    const interrupted = new Promise<never>((_, reject) => { abort = () => reject(controller.signal.reason); controller.signal.addEventListener('abort', abort, { once: true }); });
    try { return await Promise.race([operation, interrupted]); }
    finally { if (abort) controller.signal.removeEventListener('abort', abort); }
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
      case 'chooseSaveFile': result = await this.native.chooseSaveFile(text(a.defaultPath, 'Voorgestelde bestandsnaam')); break;
      case 'listLocal': result = await listLocal(text(a.path, 'Pad'), !!a.showHidden, a.filters ?? []); break;
      case 'mutateLocal': {
        if (a.operation === 'delete' && !await this.native.confirm('Lokaal verwijderen', `Definitief verwijderen: ${text(a.path, 'Pad')}?`)) break;
        if (!['mkdir', 'create', 'rename', 'delete', 'copy', 'move'].includes(a.operation)) throw new Error('Onbekende bestandsbewerking.');
        await mutateLocal(a.operation, text(a.path, 'Pad'), a.destination === undefined ? undefined : text(a.destination, 'Bestemming')); break;
      }
      case 'saveProfile': {
        const profile = plainProfile(a.profile); await assertSafeLocalPath(profile.localRoot);
        const supplied = suppliedCredentials(a.credentials), previous = this.store.get<ConnectionProfile[]>('profiles', []).find(item => item.id === profile.id);
        const changed = !!previous && credentialIdentity(previous) !== credentialIdentity(profile);
        if (changed && !supplied) throw new Error('De aanmeldbestemming is gewijzigd. Vul de aanmeldgegevens opnieuw in voordat u opslaat.');
        if (supplied) {
          this.remember(supplied);
          // Explicit undefined fields replace old secrets atomically within vault.save.
          this.vault.save(profile.id, changed || !previous ? { password: undefined, passphrase: undefined, ...supplied } : supplied, credentialIdentity(profile));
        }
        result = this.upsert('profiles', profile); break;
      }
      case 'deleteProfile': await this.remote.disconnect(text(a.id, 'Profiel')); this.vault.delete(a.id); this.remove('profiles', a.id); break;
      case 'testConnection': {
        if (this.closed) throw new Error('De werkruimte is gesloten.');
        const profile = plainProfile(a.profile);
        if (this.testingProfiles.has(profile.id) || this.testingProfiles.size >= 4) throw new Error('Er loopt al een verbindingstest. Wacht tot die klaar is.');
        this.testingProfiles.add(profile.id);
        let credentials: Credentials = {};
        try {
          credentials = this.connectionCredentials(profile, a.credentials);
          this.remember(credentials);
          const session = await createProtocolSession(profile, credentials);
          this.testSessions.add(session);
          try { if (this.closed) throw new Error('De werkruimte is gesloten.'); await session.list(profile.remoteRoot); if (this.closed) throw new Error('De werkruimte is gesloten.'); }
          finally { await this.closeTestSession(session); }
          this.log('info', `Verbindingstest geslaagd: ${profile.protocol.toUpperCase()} ${profile.host}.`);
        } catch (cause) {
          let message = cause instanceof Error ? cause.message : String(cause);
          for (const secret of [credentials.password, credentials.passphrase].filter((value): value is string => !!value).sort((a, b) => b.length - a.length)) message = message.split(secret).join('[afgeschermd]');
          throw new Error(message);
        } finally { this.testingProfiles.delete(profile.id); }
        break;
      }
      case 'connect': {
        const profile = plainProfile(a.profile), credentials = this.connectionCredentials(profile, a.credentials);
        this.remember(credentials); result = await this.remote.connect(profile, credentials); break;
      }
      case 'disconnect': await this.queue.action('pause', this.queue.jobs().filter(j => j.connectionId === a.connectionId).map(j => j.id)); await this.remote.disconnect(text(a.connectionId, 'Verbinding')); break;
      case 'listRemote': case 'statRemote': {
        const endpoint = this.checkEndpoint(a.connectionId, a.expectedEndpoint);
        const lease = await this.remote.acquire(text(a.connectionId, 'Verbinding'), 'navigation');
        try { this.checkEndpoint(a.connectionId, endpoint); result = command === 'listRemote' ? await lease.session.list(text(a.path, 'Serverpad')) : await lease.session.stat(text(a.path, 'Serverpad')); this.checkEndpoint(a.connectionId, endpoint); this.log('debug', `Metadata gelezen: ${a.path}`, a.connectionId); } finally { await lease.release(); } break;
      }
      case 'mutateRemote': {
        const endpoint = this.checkEndpoint(a.connectionId, a.expectedEndpoint);
        text(a.path, 'Serverpad'); const root = this.remote.profile(a.connectionId).remoteRoot;
        if (path.posix.normalize(a.path) === path.posix.normalize(root) && a.operation !== 'mkdir') throw new Error('De gekoppelde serverhoofdmap kan niet worden gewijzigd.');
        if (['delete', 'chmod'].includes(a.operation) && !await this.native.confirm(a.operation === 'delete' ? 'Serverbestand verwijderen' : 'Serverrechten wijzigen', `${this.remote.profile(a.connectionId).host}: ${a.path}${a.mode ? ` → ${a.mode}` : ''}${a.recursive ? '\nInclusief alle onderliggende bestanden.' : ''}?`)) break;
        this.checkEndpoint(a.connectionId, endpoint);
        const lease = await this.remote.acquire(a.connectionId, 'navigation');
        try {
          this.checkEndpoint(a.connectionId, endpoint);
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
        const endpoint = this.checkEndpoint(a.connectionId, a.expectedEndpoint);
        const requestId = text(a.requestId, 'Zoek-id', 128);
        const controller = new AbortController(); this.searches.get(requestId)?.abort(); this.searches.set(requestId, controller);
        try { result = await searchRemoteEntries(this.remote, a.connectionId, text(a.root, 'Zoekmap'), a.query, controller.signal, endpoint); }
        finally { if (this.searches.get(requestId) === controller) this.searches.delete(requestId); }
        break;
      }
      case 'cancelSearch': this.searches.get(a.requestId)?.abort(); break;
      case 'openDocument': result = await this.openDocument(text(a.path, 'Pad'), a.connectionId, a.expectedEndpoint); break;
      case 'compareDocument': result = await this.compareDocument(a.id); break;
      case 'createRemoteFile': result = await this.enqueueRemoteFileAction(a, false); break;
      case 'copyRemoteFile': result = await this.enqueueRemoteFileAction(a, true); break;
      case 'saveDocument': {
        const doc = this.documents.get(a.id); if (!doc) throw new Error('Document is niet geopend.');
        const content = text(a.content, 'Document', 8 * 1024 * 1024);
        const target = a.path ? text(a.path, 'Opslagpad') : doc.path;
        let expected = target === doc.path ? doc.original : null;
        if (target !== doc.path) {
          try { expected = await localSnapshot(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          if (expected && !await this.native.confirm('Bestaand bestand vervangen', `${target} vervangen? De bestaande versie wordt als lokale reservekopie behouden.`)) throw new Error('Opslaan geannuleerd.');
        }
        const file = await safeSaveTextFile(target, content, expected);
        const updated: DocumentData = { ...doc, path: target, name: path.basename(target), content, original: file.snapshot, eol: file.eol, ...(target !== doc.path ? { remote: undefined } : {}) };
        // Recovery may have advanced while the filesystem save was awaiting I/O.
        // Only the version actually saved is obsolete; rebase newer editor text
        // onto the committed file (including Save As) without changing that text.
        try {
          const recoveries = this.recoveryList();
          if (recoveries.some(recovery => recovery.id === doc.id)) this.store.set('recoveries', recoveries.flatMap(recovery => {
            if (recovery.id !== doc.id) return [recovery];
            return recovery.content === content ? [] : [{ ...updated, content: recovery.content, recovery: true }];
          }));
        } catch (cause) {
          // Keep the old in-memory baseline when durable recovery cannot advance:
          // a subsequent save must revalidate rather than silently assume success.
          throw new Error('Het bestand is op schijf opgeslagen, maar de herstelgegevens konden niet worden bijgewerkt. Nieuwere hersteltekst is behouden; controleer en open het bestand opnieuw.', { cause });
        }
        this.documents.set(doc.id, updated); result = structuredClone(updated); break;
      }
      case 'recoverDocument': {
        const doc = this.documents.get(a.id); if (!doc) throw new Error('Document is niet geopend.');
        this.upsert('recoveries', { ...doc, content: text(a.content, 'Hersteltekst', 8 * 1024 * 1024), recovery: true }); break;
      }
      case 'discardRecovery': this.remove('recoveries', a.id); break;
      case 'enqueue': {
        if (!Array.isArray(a.requests) || a.requests.length > 100000) throw new Error('Ongeldige overdrachtslijst.');
        for (const request of a.requests as TransferRequest[]) {
          if (request.localRootOverride !== undefined) text(request.localRootOverride, 'Lokale overdrachtsmap');
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
      case 'queueAction': {
        const before = a.action === 'clear' ? this.queue.jobs() : [];
        await this.queue.action(a.action, a.ids, a.priority);
        const remaining = new Set(this.queue.jobs(true).map(job => job.localPath));
        for (const job of before) if (!remaining.has(job.localPath)) await this.releaseActionSource(job.localPath);
        break;
      }
      case 'saveProject': {
        const project = a.project as Project; text(project.id, 'Project-id', 128); text(project.name, 'Projectnaam', 200); await assertSafeLocalPath(project.localRoot);
        checkedFilters(project.filters);
        if (!Array.isArray(project.environments) || !Array.isArray(project.bookmarks)) throw new Error('Projectinstellingen zijn ongeldig.');
        if (project.filterProfiles !== undefined) {
          if (!Array.isArray(project.filterProfiles) || project.filterProfiles.length > 100) throw new Error('Maximaal 100 filterprofielen per project.');
          const ids = new Set<string>(), names = new Set<string>();
          for (const profile of project.filterProfiles) {
            if (!profile || typeof profile !== 'object') throw new Error('Ongeldig filterprofiel.');
            text(profile.id, 'Filterprofiel-id', 128); text(profile.name, 'Filterprofielnaam', 120);
            const name = profile.name.trim().toLocaleLowerCase('nl');
            if (!profile.id.trim() || !name || /[\x00-\x1f\x7f]/.test(profile.name) || ids.has(profile.id) || names.has(name)) throw new Error('Ongeldig of dubbel filterprofiel.');
            checkedFilters(profile.filters); ids.add(profile.id); names.add(name);
          }
        }
        if (project.previewUrl) { const url = new URL(project.previewUrl); if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('Dynamische preview vereist een lokale HTTP(S)-URL zonder aanmeldgegevens.'); }
        result = this.upsert('projects', project); break;
      }
      case 'setProjectOpenFiles': {
        const projectId = text(a.projectId, 'Project-id', 128), initial = this.project(projectId);
        if (!Array.isArray(a.paths) || a.paths.length > 200) throw new Error('Maximaal 200 geopende bestanden per project.');
        const paths: string[] = [];
        for (const filename of a.paths) {
          const candidate = text(filename, 'Bestandspad');
          if (!path.isAbsolute(candidate)) throw new Error('Bestandspad moet absoluut zijn.');
          paths.push(await assertSafeLocalPath(candidate, initial.localRoot, true));
        }
        const current = this.project(projectId);
        if (current.localRoot !== initial.localRoot) throw new Error('De projectmap is gewijzigd. Open de bestanden opnieuw.');
        result = this.upsert('projects', { ...current, openFiles: [...new Set(paths)] }); break;
      }
      case 'deleteProject': this.remove('projects', a.id); break;
      case 'saveSettings': {
        const settings = a.settings as AppSettings; if (!['dark', 'light', 'system'].includes(settings.theme) || !Number.isFinite(settings.editorFontSize) || settings.editorFontSize < 9 || settings.editorFontSize > 40) throw new Error('Ongeldige editorinstellingen.'); this.store.set('settings', settings); break;
      }
      case 'saveSnippet': { const snippet = a.snippet as Snippet; text(snippet.id, 'Fragment-id', 128); text(snippet.name, 'Fragmentnaam', 200); text(snippet.body, 'Codefragment', 200000); if (snippet.group !== undefined) { snippet.group = text(snippet.group, 'Fragmentgroep', 120).trim() || undefined; if (snippet.group && /[\x00-\x1f\x7f]/.test(snippet.group)) throw new Error('Fragmentgroep bevat ongeldige tekens.'); } result = this.upsert('snippets', snippet); break; }
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
        const refs = collectDependencyReferences(text(a.content, 'Broncode', 8 * 1024 * 1024), path.extname(source).slice(1));
        const candidates: string[] = refs.fileReferences.map(reference => path.resolve(path.dirname(source), reference));
        for (const reference of refs.urlReferences) {
          if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(reference)) continue;
          let decoded: string;
          try { decoded = decodeURIComponent(reference.split(/[?#]/)[0]); } catch { continue; }
          if (!decoded || /[\\\0]/.test(decoded)) continue;
          candidates.push(decoded.startsWith('/') ? path.resolve(project.localRoot, `.${decoded}`) : path.resolve(path.dirname(source), decoded));
        }
        for (const candidate of candidates) {
          try { await assertSafeLocalPath(candidate, project.localRoot); const relative = path.relative(project.localRoot, candidate); if (isSensitivePath(relative) || isDefaultExcluded(relative)) continue; if ((await fs.stat(candidate)).isFile()) related.push(candidate); } catch { /* Missing and outside-root refs are not openable. */ }
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
  async close(): Promise<void> { this.closed = true; for (const controller of this.searches.values()) controller.abort(); for (const controller of this.fileActions) controller.abort(); for (const controller of this.comparisons) controller.abort(); await Promise.allSettled([...this.testSessions].map(session => this.closeTestSession(session))); await this.queue.close(); await this.remote.close(); await Promise.allSettled([...this.fileActionRuns, ...this.comparisonRuns, this.actionSourceReconciliation]); await this.previewServer.close(); }
}
