import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PublishPlanner } from '../src/core/publishing';
import { localSnapshot } from '../src/core/workspace';
import type { ConnectionProfile, FileEntry, KeyValueStore, Project, RemoteAccess, RemoteSession, TransferJob } from '../src/shared/contracts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { force: true, recursive: true }))); });
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-publish-')); roots.push(root);
  const profile: ConnectionProfile = { id: 'profile', name: 'test', host: 'localhost', port: 22, protocol: 'sftp', username: 'test', localRoot: root, remoteRoot: '/', timeoutMs: 1000, connectionLimit: 2, parallelTransfers: 1, autoReconnect: false };
  const project: Project = { id: 'project', name: 'Project', localRoot: root, profileId: profile.id, remoteRoot: '/web', filters: { display: [], transfer: [], sync: [] }, environments: [{ id: 'prod', name: 'Productie', profileId: profile.id, remoteRoot: '/production', production: true }], bookmarks: [] };
  const entries = new Map<string, FileEntry>();
  const values = new Map<string, unknown>();
  const store: KeyValueStore = { get: <T>(key: string, fallback: T) => (values.get(key) ?? fallback) as T, set: (key, value) => { values.set(key, value); }, delete: key => { values.delete(key); } };
  const session: RemoteSession = { list: async directory => [...entries.values()].filter(entry => path.posix.dirname(entry.path) === directory), stat: async target => entries.get(target) ?? null, mkdir: async () => {}, rename: async () => {}, remove: async () => { throw new Error('Must never delete'); }, chmod: async () => {}, upload: async () => {}, download: async () => {}, close: async () => {} };
  const remote: RemoteAccess = { profile: () => profile, acquire: async () => ({ session, release: async () => {} }) };
  return { root, project, profile, entries, values, planner: new PublishPlanner(remote, store) };
}

describe('conservative publish planning', () => {
  it('refuses a plan when the same profile id is rebound to another endpoint', async () => {
    const { root, project, profile, planner } = await setup(); await fs.writeFile(path.join(root, 'a.txt'), 'a');
    const plan = await planner.createPlan(project, 'connection', { direction: 'upload', includeDependencies: false });
    profile.host = 'different-host.invalid';
    await expect(planner.requestsForPlan(plan.id, ['a.txt'], true)).rejects.toThrow(/serverbestemming/);
  });
  it('shows exclusions and unknown timestamp conflicts and never creates deletion requests', async () => {
    const { root, project, entries, planner } = await setup();
    await fs.writeFile(path.join(root, 'local.txt'), 'local'); await fs.writeFile(path.join(root, '.env'), 'secret'); await fs.writeFile(path.join(root, 'shared.txt'), 'same');
    entries.set('/web/shared.txt', { name: 'shared.txt', path: '/web/shared.txt', kind: 'file', size: 4, modifiedAt: Date.now() });
    entries.set('/web/remote.txt', { name: 'remote.txt', path: '/web/remote.txt', kind: 'file', size: 6, modifiedAt: 1 });
    const plan = await planner.createPlan(project, 'connection', { direction: 'both', includeDependencies: false });
    expect(plan.items.find(item => item.relativePath === '.env')?.excluded).toBe(true);
    expect(plan.items.find(item => item.relativePath === 'shared.txt')?.action).toBe('conflict');
    expect(plan.items.find(item => item.relativePath === 'local.txt')?.action).toBe('upload');
    expect(plan.items.find(item => item.relativePath === 'remote.txt')?.action).toBe('download');
    await expect(planner.requestsForPlan(plan.id, ['.env'], true)).rejects.toThrow();
    await expect(planner.requestsForPlan(plan.id, ['shared.txt'], true)).rejects.toThrow();
    const requests = await planner.requestsForPlan(plan.id, ['local.txt', 'remote.txt'], true);
    expect(requests.map(request => request.direction)).toEqual(['upload', 'download']);
    expect(requests[0].expectedRemote).toBeNull(); expect(requests[1].expectedLocal).toBeNull();
  });

  it('expands static dependencies inside the project without selecting external assets', async () => {
    const { root, project, planner } = await setup();
    await fs.writeFile(path.join(root, 'index.html'), '<link rel="stylesheet" href="style.css"><script src="https://example.test/remote.js"></script>');
    await fs.writeFile(path.join(root, 'style.css'), 'body { background: url(image.png); }'); await fs.writeFile(path.join(root, 'image.png'), 'image'); await fs.writeFile(path.join(root, 'other.txt'), 'other');
    const plan = await planner.createPlan(project, 'connection', { direction: 'upload', includeDependencies: true, paths: ['index.html'] });
    expect(plan.items.filter(item => item.selected).map(item => item.relativePath)).toEqual(['image.png', 'index.html', 'style.css']);
    expect(plan.items.find(item => item.relativePath === 'image.png')?.dependency).toBe(true);
    await expect(planner.createPlan(project, 'connection', { direction: 'upload', includeDependencies: true, paths: ['../outside'] })).rejects.toThrow('buiten');
  });

  it('requires production confirmation and refuses local changes after plan creation', async () => {
    const { root, project, planner } = await setup(); const file = path.join(root, 'a.txt'); await fs.writeFile(file, 'a');
    const plan = await planner.createPlan(project, 'connection', { direction: 'upload', includeDependencies: false, environmentId: 'prod' });
    expect(plan.items[0].remotePath).toBe('/production/a.txt');
    await expect(planner.requestsForPlan(plan.id, ['a.txt'], false)).rejects.toThrow('productie');
    await fs.writeFile(file, 'changed'); await expect(planner.requestsForPlan(plan.id, ['a.txt'], true)).rejects.toThrow('gewijzigd');
  });

  it('does not prune nested include matches and rejects mismatched connection roots', async () => {
    const { root, project, profile, planner } = await setup();
    await fs.mkdir(path.join(root, 'styles')); await fs.writeFile(path.join(root, 'styles', 'a.css'), 'body{}'); await fs.writeFile(path.join(root, 'styles', 'other.txt'), 'x');
    project.filters.transfer = [{ id: 'css', field: 'path', operator: 'glob', value: '**/*.css', action: 'include' }];
    const plan = await planner.createPlan(project, 'connection', { direction: 'upload', includeDependencies: false });
    expect(plan.items.find(item => item.relativePath === 'styles/a.css')?.selected).toBe(true);
    expect(plan.items.find(item => item.relativePath === 'styles/other.txt')?.excluded).toBe(true);
    profile.remoteRoot = '/sandbox';
    await expect(planner.createPlan(project, 'connection', { direction: 'upload', includeDependencies: false })).rejects.toThrow('buiten');
  });

  it('updates only a successful transfer manifest and scopes it to the target environment', async () => {
    const { root, project, entries, planner, values } = await setup(); const file = path.join(root, 'a.txt'); await fs.writeFile(file, 'abc');
    const plan = await planner.createPlan(project, 'connection', { direction: 'upload', includeDependencies: false });
    const [request] = await planner.requestsForPlan(plan.id, ['a.txt'], true);
    const job: TransferJob = { ...request, id: 'job', status: 'failed', size: 3, transferred: 0, speed: 0, remainingSeconds: null, attempts: 1, createdAt: 1, sourceSnapshot: await localSnapshot(file) };
    await planner.recordCompletion(job); expect(values.size).toBe(0);
    entries.set('/web/a.txt', { name: 'a.txt', path: '/web/a.txt', kind: 'file', size: 3, modifiedAt: 123, precisionMs: 1000 });
    await planner.recordCompletion({ ...job, status: 'completed', transferred: 3, verifiedRemote: { size: 3, modifiedAt: 123 }, verifiedLocal: job.sourceSnapshot }); expect(values.size).toBe(1);
    const unchanged = await planner.createPlan(project, 'connection', { direction: 'both', includeDependencies: false });
    expect(unchanged.items[0].action).toBe('skip');
    await fs.writeFile(file, 'changed'); const changed = await planner.createPlan(project, 'connection', { direction: 'both', includeDependencies: false });
    expect(changed.items[0].action).toBe('upload');
    const production = await planner.createPlan(project, 'connection', { direction: 'upload', includeDependencies: false, environmentId: 'prod' });
    expect(production.items[0].action).toBe('upload'); expect(production.items[0].remote).toBeUndefined();
  });

  it('refuses to adopt a same-size concurrent remote writer into the manifest', async () => {
    const { root, project, entries, planner, values } = await setup(); const file = path.join(root, 'a.txt'); await fs.writeFile(file, 'abc');
    const plan = await planner.createPlan(project, 'connection', { direction: 'upload', includeDependencies: false });
    const [request] = await planner.requestsForPlan(plan.id, ['a.txt'], true);
    const verifiedLocal = await localSnapshot(file);
    const job: TransferJob = { ...request, id: 'job', status: 'completed', size: 3, transferred: 3, speed: 0, remainingSeconds: null, attempts: 1, createdAt: 1, sourceSnapshot: verifiedLocal, verifiedLocal, verifiedRemote: { size: 3, modifiedAt: 123 } };
    entries.set('/web/a.txt', { name: 'a.txt', path: '/web/a.txt', kind: 'file', size: 3, modifiedAt: 456, precisionMs: 1000 });
    await expect(planner.recordCompletion(job)).rejects.toThrow('na overdracht gewijzigd'); expect(values.size).toBe(0);
    entries.set('/web/a.txt', { name: 'a.txt', path: '/web/a.txt', kind: 'file', size: 3, modifiedAt: 123, precisionMs: 1000, checksum: 'unapproved' });
    await expect(planner.recordCompletion({ ...job, verifiedRemote: { size: 3, modifiedAt: 123, checksum: job.sourceSnapshot!.checksum } })).rejects.toThrow('na overdracht gewijzigd'); expect(values.size).toBe(0);
    await expect(planner.recordCompletion({ ...job, verifiedRemote: undefined })).rejects.toThrow('geen bevestigde'); expect(values.size).toBe(0);
  });

  it('refuses a same-size local writer after completed download', async () => {
    const { root, project, entries, planner, values } = await setup();
    entries.set('/web/a.txt', { name: 'a.txt', path: '/web/a.txt', kind: 'file', size: 3, modifiedAt: 123, precisionMs: 1000 });
    const plan = await planner.createPlan(project, 'connection', { direction: 'download', includeDependencies: false });
    const [request] = await planner.requestsForPlan(plan.id, ['a.txt'], true);
    await fs.writeFile(path.join(root, 'a.txt'), 'abc'); const verifiedLocal = await localSnapshot(path.join(root, 'a.txt'));
    const job: TransferJob = { ...request, id: 'job', status: 'completed', size: 3, transferred: 3, speed: 0, remainingSeconds: null, attempts: 1, createdAt: 1, sourceSnapshot: { size: 3, modifiedAt: 123 }, verifiedLocal, verifiedRemote: { size: 3, modifiedAt: 123 } };
    await fs.writeFile(path.join(root, 'a.txt'), 'xyz');
    await expect(planner.recordCompletion(job)).rejects.toThrow('Lokaal bestand is na overdracht gewijzigd'); expect(values.size).toBe(0);
  });
});
