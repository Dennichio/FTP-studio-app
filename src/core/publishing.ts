import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FileEntry, FileSnapshot, KeyValueStore, ManifestEntry, Project, PublishItem, PublishPlan, RemoteAccess, TransferJob, TransferRequest } from '../shared/contracts';
import { discoverDependencies } from './source';
import { endpointIdentity } from './connectionIdentity';
import { assertSafeLocalPath, compareEntries, isDefaultExcluded, isSensitivePath, listLocal, localSnapshot, mapLocalToRemote, mapRemoteToLocal, matchesFilters, normalizeRemoteRoot, readTextFile } from './workspace';

export interface PublishOptions { direction: 'upload' | 'download' | 'both'; includeDependencies: boolean; paths?: string[]; environmentId?: string; }
interface PlanContext { plan: PublishPlan; project: Project; remoteRoot: string; manifestKey: string; endpoint: string; }
interface PendingTransfer { context: PlanContext; item: PublishItem; }
const snapshot = (entry: FileEntry): FileSnapshot => ({ size: entry.size, modifiedAt: entry.modifiedAt, ...(entry.checksum ? { checksum: entry.checksum } : {}) });

/** Planning never deletes. Baselines belong to a project, connection and target root. */
export class PublishPlanner {
  private plans = new Map<string, PlanContext>();
  private pending = new Map<string, PendingTransfer>();
  constructor(private remote: RemoteAccess, private store: KeyValueStore) {}

  async createPlan(project: Project, connectionId: string, options: PublishOptions): Promise<PublishPlan> {
    const profile = this.remote.profile(connectionId);
    const endpoint = endpointIdentity(profile);
    const environment = options.environmentId ? project.environments.find(item => item.id === options.environmentId) : undefined;
    if (options.environmentId && !environment) throw new Error('Publicatieomgeving bestaat niet.');
    if (environment ? environment.profileId !== profile.id : project.profileId && project.profileId !== profile.id) throw new Error('Verbinding hoort niet bij deze publicatieomgeving.');
    const remoteRoot = normalizeRemoteRoot(environment?.remoteRoot ?? project.remoteRoot);
    const localRoot = await assertSafeLocalPath(project.localRoot);
    mapLocalToRemote(localRoot, profile.localRoot, '/');
    mapRemoteToLocal(remoteRoot, profile.remoteRoot, localRoot);
    const manifestKey = `publish-manifest:${project.id}:${profile.id}:${environment?.id ?? 'default'}:${encodeURIComponent(remoteRoot)}:${encodeURIComponent(endpoint)}`;
    const baseline = this.store.get<Record<string, ManifestEntry>>(manifestKey, {});
    const local = new Map<string, FileEntry>();
    const remote = new Map<string, FileEntry>();
    let count = 0;
    const excluded = (relative: string, entry: FileEntry) => {
      const forEntry = (rules: Project['filters']['transfer']) => entry.kind === 'directory' ? rules.filter(rule => rule.action === 'exclude') : rules;
      return isDefaultExcluded(relative) || isSensitivePath(relative) || !matchesFilters({ ...entry, relativePath: relative }, forEntry(project.filters.transfer)) || !matchesFilters({ ...entry, relativePath: relative }, forEntry(project.filters.sync));
    };
    async function walkLocal(directory: string): Promise<void> {
      for (const entry of await listLocal(directory, true)) {
        if (++count > 20000) throw new Error('Publicatieplan bevat meer dan 20.000 items.');
        const relative = path.relative(localRoot, entry.path).split(path.sep).join('/');
        entry.relativePath = relative;
        local.set(relative, entry);
        if (entry.kind === 'directory' && !excluded(relative, entry)) await walkLocal(entry.path);
      }
    }
    await walkLocal(localRoot);
    const lease = await this.remote.acquire(connectionId, 'navigation');
    try {
      async function walkRemote(directory: string): Promise<void> {
        for (const raw of await lease.session.list(directory)) {
          if (++count > 40000) throw new Error('Publicatieplan bevat te veel remote items.');
          if (!raw.name || raw.name === '.' || raw.name === '..' || /[/\\\0]/.test(raw.name)) throw new Error('Server retourneerde een onveilige bestandsnaam.');
          const remotePath = path.posix.join(directory, raw.name);
          const localPath = mapRemoteToLocal(remotePath, remoteRoot, localRoot);
          const relative = path.relative(localRoot, localPath).split(path.sep).join('/');
          const entry = { ...raw, path: remotePath, relativePath: relative };
          remote.set(relative, entry);
          if (entry.kind === 'directory' && !excluded(relative, entry)) await walkRemote(remotePath);
        }
      }
      await walkRemote(remoteRoot);
    } finally { await lease.release(); }

    let selected: Set<string> | undefined;
    const dependencies = new Set<string>();
    if (options.paths?.length) {
      selected = new Set(options.paths.map(value => {
        const absolute = path.isAbsolute(value) ? value : path.resolve(localRoot, value);
        const remotePath = mapLocalToRemote(absolute, localRoot, remoteRoot);
        return path.posix.relative(remoteRoot, remotePath);
      }));
      // Selected directories mean their descendants, never arbitrary path prefixes.
      for (const relative of new Set([...local.keys(), ...remote.keys()])) {
        if ([...selected].some(parent => parent === '' || relative.startsWith(`${parent}/`))) selected.add(relative);
      }
      if (options.includeDependencies) {
        const queue = [...selected];
        for (let index = 0; index < queue.length; index++) {
          if (queue.length > 20000) throw new Error('Te veel gerelateerde bestanden.');
          const relative = queue[index];
          const entry = local.get(relative);
          if (!entry || entry.kind !== 'file' || excluded(relative, entry) || !/\.(?:html?|php|css|[cm]?jsx?|tsx?)$/i.test(relative) || entry.size > 2 * 1024 * 1024) continue;
          const content = (await readTextFile(entry.path)).content;
          for (const reference of discoverDependencies(content, path.extname(relative).slice(1))) {
            if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(reference)) continue;
            const plain = reference.split(/[?#]/)[0];
            if (!plain) continue;
            let decoded: string;
            try { decoded = decodeURIComponent(plain); } catch { continue; }
            if (decoded.includes('\\') || decoded.includes('\0')) continue;
            const absolute = decoded.startsWith('/') ? path.resolve(localRoot, `.${decoded}`) : path.resolve(path.dirname(entry.path), decoded);
            let dep: string;
            try { dep = path.posix.relative(remoteRoot, mapLocalToRemote(absolute, localRoot, remoteRoot)); } catch { continue; }
            if (!local.has(dep) || selected.has(dep)) continue;
            dependencies.add(dep); selected.add(dep); queue.push(dep);
          }
        }
      }
    }
    const items: PublishItem[] = [];
    for (const relative of [...new Set([...local.keys(), ...remote.keys()])].sort()) {
      const localEntry = local.get(relative);
      const remoteEntry = remote.get(relative);
      const localPath = path.join(localRoot, ...relative.split('/'));
      const remotePath = mapLocalToRemote(localPath, localRoot, remoteRoot);
      const item: PublishItem = { relativePath: relative, localPath, remotePath, action: 'skip', reason: '', selected: false, ...(dependencies.has(relative) ? { dependency: true } : {}) };
      const unsafe = [localEntry, remoteEntry].some(entry => entry && (entry.kind === 'symlink' || excluded(relative, entry)));
      if (unsafe) { item.excluded = true; item.reason = 'Uitgesloten door veiligheidsregels of projectfilters.'; items.push(item); continue; }
      if (localEntry?.kind === 'directory' || remoteEntry?.kind === 'directory') {
        if (localEntry && remoteEntry && localEntry.kind !== remoteEntry.kind) { item.action = 'conflict'; item.reason = 'Bestand en map komen niet overeen.'; }
        else item.reason = 'Mappen worden als bovenliggende map van bestanden aangemaakt; lege mappen hebben geen bestandsoverdracht.';
        items.push(item); continue;
      }
      if (localEntry) item.local = await localSnapshot(localPath);
      if (remoteEntry) item.remote = snapshot(remoteEntry);
      const status = compareEntries(localEntry && { ...item.local!, precisionMs: localEntry.precisionMs }, remoteEntry && { ...item.remote!, precisionMs: remoteEntry.precisionMs }, baseline[relative]);
      if (status === 'conflict' || status === 'uncertain') { item.action = 'conflict'; item.reason = status === 'conflict' ? 'Beide versies zijn gewijzigd of verschillen.' : 'Tijdstempel of vergelijking is onvoldoende betrouwbaar.'; }
      else if (status === 'probably-identical') item.reason = 'Waarschijnlijk gelijk aan de laatst gepubliceerde versie.';
      else if (status === 'local-only' || status === 'local-newer') {
        if (options.direction !== 'download') { item.action = 'upload'; item.reason = status === 'local-only' ? 'Alleen lokaal aanwezig.' : 'Lokale versie is gewijzigd.'; }
        else item.reason = 'Lokale versie wordt niet overschreven door download.';
      } else {
        if (options.direction !== 'upload') { item.action = 'download'; item.reason = status === 'remote-only' ? 'Alleen remote aanwezig.' : 'Remote versie is gewijzigd.'; }
        else item.reason = 'Remote versie wordt niet overschreven door upload.';
      }
      item.selected = (item.action === 'upload' || item.action === 'download') && (!selected || selected.has(relative));
      items.push(item);
    }
    const plan: PublishPlan = { id: randomUUID(), projectId: project.id, connectionId, ...(environment ? { environmentId: environment.id } : {}), production: environment?.production ?? false, items, createdAt: Date.now() };
    if (endpointIdentity(this.remote.profile(connectionId)) !== endpoint) throw new Error('De verbindingsbestemming wijzigde tijdens het maken van het publicatieplan. Maak een nieuw plan.');
    this.plans.set(plan.id, { plan, project: structuredClone(project), remoteRoot, manifestKey, endpoint });
    if (this.plans.size > 100) this.plans.delete(this.plans.keys().next().value!);
    return structuredClone(plan);
  }

  getPlan(id: string): PublishPlan {
    const context = this.plans.get(id);
    if (!context) throw new Error('Publicatieplan bestaat niet of is verlopen.');
    return structuredClone(context.plan);
  }

  async requestsForPlan(id: string, selectedPaths: string[], productionConfirmed: boolean): Promise<TransferRequest[]> {
    const context = this.plans.get(id);
    if (!context) throw new Error('Publicatieplan bestaat niet of is verlopen.');
    if (context.plan.production && !productionConfirmed) throw new Error('Publicatie naar productie vereist expliciete bevestiging.');
    if (endpointIdentity(this.remote.profile(context.plan.connectionId)) !== context.endpoint) throw new Error('De serverbestemming is sinds het publicatieplan gewijzigd. Maak een nieuw plan.');
    if (Date.now() - context.plan.createdAt > 30 * 60 * 1000) throw new Error('Publicatieplan is verlopen; maak een nieuw plan.');
    const requests: TransferRequest[] = [];
    const registrations: { request: TransferRequest; pending: PendingTransfer }[] = [];
    for (const relative of new Set(selectedPaths)) {
      const item = context.plan.items.find(entry => entry.relativePath === relative);
      if (!item || item.excluded || item.action === 'conflict' || item.action === 'skip') throw new Error(`Publicatie-item kan niet worden uitgevoerd: ${relative}.`);
      await assertSafeLocalPath(item.localPath, context.project.localRoot, item.action === 'download');
      if (item.local && (await localSnapshot(item.localPath)).checksum !== item.local.checksum) throw new Error(`Lokaal bestand is gewijzigd sinds het plan: ${relative}.`);
      const request: TransferRequest = { connectionId: context.plan.connectionId, projectId: context.plan.projectId, expectedEndpoint: context.endpoint, direction: item.action, localPath: item.localPath, remotePath: item.remotePath, expectedLocal: item.local ?? null, expectedRemote: item.remote ?? null };
      registrations.push({ request, pending: { context, item } });
      requests.push(request);
    }
    for (const registration of registrations) this.pending.set(this.transferKey(registration.request), registration.pending);
    return requests;
  }

  async recordCompletion(job: TransferJob): Promise<void> {
    if (job.status !== 'completed') return;
    const key = this.transferKey(job);
    const pending = this.pending.get(key);
    if (!pending) return;
    if (endpointIdentity(this.remote.profile(job.connectionId)) !== pending.context.endpoint || job.expectedEndpoint !== pending.context.endpoint) throw new Error('De serverbestemming is gewijzigd; publicatiemanifest blijft ongewijzigd.');
    if (!job.verifiedRemote) throw new Error('Overdracht heeft geen bevestigde remote momentopname; manifest blijft ongewijzigd.');
    if (!job.verifiedLocal?.checksum) throw new Error('Overdracht heeft geen bevestigde lokale controlehash; manifest blijft ongewijzigd.');
    // Validate both endpoints after successful transfer before recording a baseline.
    const local = await localSnapshot(job.localPath);
    const verifiedLocal = job.verifiedLocal;
    if (local.size !== verifiedLocal.size || local.modifiedAt !== verifiedLocal.modifiedAt || local.checksum !== verifiedLocal.checksum)
      throw new Error('Lokaal bestand is na overdracht gewijzigd; publicatiemanifest blijft ongewijzigd.');
    const lease = await this.remote.acquire(job.connectionId, 'navigation');
    let remoteEntry: FileEntry | null;
    try {
      if (endpointIdentity(this.remote.profile(job.connectionId)) !== pending.context.endpoint) throw new Error('De serverbestemming is tijdens de controle gewijzigd.');
      remoteEntry = await lease.session.stat(job.remotePath);
    } finally { await lease.release(); }
    if (!remoteEntry || remoteEntry.kind !== 'file' || local.size !== remoteEntry.size) throw new Error('Overdracht voltooid maar publicatiemanifest kon niet worden bevestigd.');
    const verifiedRemote = job.verifiedRemote;
    if (remoteEntry.size !== verifiedRemote.size || remoteEntry.modifiedAt !== verifiedRemote.modifiedAt || verifiedRemote.checksum && remoteEntry.checksum !== verifiedRemote.checksum)
      throw new Error('Remote bestand is na overdracht gewijzigd; publicatiemanifest blijft ongewijzigd.');
    if (remoteEntry.checksum && remoteEntry.checksum !== local.checksum) throw new Error('Remote controlehash wijkt af; publicatiemanifest blijft ongewijzigd.');
    if (job.sourceSnapshot?.checksum && local.checksum !== job.sourceSnapshot.checksum) throw new Error('Lokaal bestand is na overdracht gewijzigd; manifest blijft ongewijzigd.');
    if (job.direction === 'upload' && pending.item.local?.checksum && local.checksum !== pending.item.local.checksum) throw new Error('Lokale bron is gewijzigd sinds publicatieplanning; manifest blijft ongewijzigd.');
    const manifest = this.store.get<Record<string, ManifestEntry>>(pending.context.manifestKey, {});
    manifest[pending.item.relativePath] = { relativePath: pending.item.relativePath, local: { ...verifiedLocal }, remote: { ...verifiedRemote }, publishedAt: Date.now() };
    this.store.set(pending.context.manifestKey, manifest);
    this.pending.delete(key);
  }

  private transferKey(request: TransferRequest): string { return JSON.stringify([request.projectId, request.connectionId, request.direction, request.localPath, request.remotePath]); }
}
