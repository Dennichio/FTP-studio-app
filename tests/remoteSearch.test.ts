import { describe, expect, it, vi } from 'vitest';
import type { ConnectionProfile, FileEntry, RemoteAccess, RemoteSession, SearchQuery } from '../src/shared/contracts';
import { endpointIdentity } from '../src/core/connectionIdentity';
import { searchRemoteEntries } from '../src/main/remoteSearch';

const query = (overrides: Partial<SearchQuery> = {}): SearchQuery => ({ text: '', regex: false, caseSensitive: false, ...overrides });
const entry = (absolute: string, kind: FileEntry['kind'] = 'file', size = 10, modifiedAt: number | null = 100): FileEntry => ({ name: absolute.split('/').pop()!, path: absolute, kind, size, modifiedAt, precisionMs: 1000 });
function fixture(tree: Record<string, FileEntry[]>) {
  const profile: ConnectionProfile = { id: 'profile', name: 'Fixture', protocol: 'sftp', host: 'one.example', port: 22, username: 'user', localRoot: '/local', remoteRoot: '/web', timeoutMs: 1000, connectionLimit: 2, parallelTransfers: 1, autoReconnect: false, hostKeySha256: 'test-pin' };
  let active = 0; let peak = 0;
  const list = vi.fn(async (directory: string, signal?: AbortSignal): Promise<FileEntry[]> => { signal?.throwIfAborted(); return tree[directory] ?? []; });
  const download = vi.fn(async () => { throw new Error('Content must never be downloaded'); });
  const upload = vi.fn(async () => { throw new Error('Content must never be uploaded'); });
  const release = vi.fn(async () => { active--; });
  const session: RemoteSession = { list, stat: vi.fn(async () => null), mkdir: vi.fn(async () => {}), rename: vi.fn(async () => {}), remove: vi.fn(async () => {}), chmod: vi.fn(async () => {}), upload, download, close: vi.fn(async () => {}) };
  const acquire = vi.fn(async (_id: string, _purpose: 'navigation' | 'transfer', signal?: AbortSignal) => { signal?.throwIfAborted(); active++; peak = Math.max(peak, active); return { session, release }; });
  const remote: RemoteAccess = { profile: () => profile, acquire };
  return { profile, remote, session, list, acquire, release, download, upload, active: () => active, peak: () => peak };
}

describe('remote listing metadata search', () => {
  it('walks breadth first using one lease per directory and never reads contents', async () => {
    const f = fixture({ '/web': [entry('/web/assets', 'directory'), entry('/web/index.html'), entry('/web/linked', 'symlink')], '/web/assets': [entry('/web/assets/css', 'directory'), entry('/web/assets/logo.png')], '/web/assets/css': [entry('/web/assets/css/main.css')] });
    const results = await searchRemoteEntries(f.remote, 'connection', '/web', query(), new AbortController().signal);
    expect(f.list.mock.calls.map(call => call[0])).toEqual(['/web', '/web/assets', '/web/assets/css']);
    expect(f.acquire).toHaveBeenCalledTimes(3); expect(f.release).toHaveBeenCalledTimes(3); expect(f.peak()).toBe(1); expect(f.active()).toBe(0);
    expect(results.map(item => item.relativePath)).toEqual(['assets', 'assets/css', 'assets/css/main.css', 'assets/logo.png', 'index.html']);
    expect(f.download).not.toHaveBeenCalled(); expect(f.upload).not.toHaveBeenCalled(); expect(f.session.stat).not.toHaveBeenCalled();
  });

  it('applies filename, relative-path, type, size and time filters without pruning subdirectories', async () => {
    const f = fixture({ '/web': [entry('/web/assets', 'directory', 0, null), entry('/web/top.css', 'file', 50, 150)], '/web/assets': [entry('/web/assets/a.css', 'file', 40, 150), entry('/web/assets/b.css', 'file', 60, 150), entry('/web/assets/unknown.css', 'file', 45, null), entry('/web/assets/later.css', 'file', 45, 250), entry('/web/assets/image.png', 'file', 45, 150)] });
    const results = await searchRemoteEntries(f.remote, 'connection', '/web', query({ glob: '*.css', pathGlob: 'assets/*.css', kind: 'file', minSize: 35, maxSize: 50, modifiedAfter: 100, modifiedBefore: 200 }), new AbortController().signal);
    expect(results.map(item => item.relativePath)).toEqual(['assets/a.css']); expect(f.list).toHaveBeenCalledTimes(2);
    const shallow = await searchRemoteEntries(f.remote, 'connection', '/web', query({ recursive: false, kind: 'directory' }), new AbortController().signal);
    expect(shallow.map(item => item.name)).toEqual(['assets']);
  });

  it('allows empty text metadata-only queries and supports safe name regex and literal case choice', async () => {
    const f = fixture({ '/web': [entry('/web/ReadMe.md'), entry('/web/readme.txt'), entry('/web/other.txt')] });
    expect((await searchRemoteEntries(f.remote, 'connection', '/web', query({ text: 'ReadMe', caseSensitive: true }), new AbortController().signal)).map(item => item.name)).toEqual(['ReadMe.md']);
    expect((await searchRemoteEntries(f.remote, 'connection', '/web', query({ text: '^readme.*$', regex: true }), new AbortController().signal))).toHaveLength(2);
    expect((await searchRemoteEntries(f.remote, 'connection', '/web', query({ minSize: 10 }), new AbortController().signal))).toHaveLength(3);
    await expect(searchRemoteEntries(f.remote, 'connection', '/web', query({ text: '(a+)+$', regex: true }), new AbortController().signal)).rejects.toThrow('veilig');
  });

  it('cancels before acquire or during list and releases the active lease', async () => {
    const f = fixture({ '/web': [entry('/web/child', 'directory')], '/web/child': [entry('/web/child/a')] });
    const cancelled = new AbortController(); cancelled.abort();
    await expect(searchRemoteEntries(f.remote, 'connection', '/web', query(), cancelled.signal)).rejects.toThrow(); expect(f.acquire).not.toHaveBeenCalled();
    const controller = new AbortController();
    f.list.mockImplementationOnce(async (_directory, signal) => { controller.abort(); signal?.throwIfAborted(); return []; });
    await expect(searchRemoteEntries(f.remote, 'connection', '/web', query(), controller.signal)).rejects.toThrow(); expect(f.release).toHaveBeenCalledTimes(1); expect(f.active()).toBe(0);
  });

  it('rejects changed endpoint identity before acquisition, after acquisition and after listing', async () => {
    const f = fixture({ '/web': [entry('/web/a.txt')] }); const expected = endpointIdentity(f.profile);
    f.profile.host = 'changed.example'; await expect(searchRemoteEntries(f.remote, 'connection', '/web', query(), new AbortController().signal, expected)).rejects.toThrow('serverbestemming'); expect(f.acquire).not.toHaveBeenCalled();
    f.profile.host = 'one.example'; const acquire = f.acquire.getMockImplementation()!;
    f.acquire.mockImplementationOnce(async (...args) => { const lease = await acquire(...args); f.profile.host = 'changed.example'; return lease; });
    await expect(searchRemoteEntries(f.remote, 'connection', '/web', query(), new AbortController().signal)).rejects.toThrow('serverbestemming'); expect(f.list).not.toHaveBeenCalled(); expect(f.active()).toBe(0);
    f.profile.host = 'one.example'; f.list.mockImplementationOnce(async () => { f.profile.host = 'changed.example'; return [entry('/web/a.txt')]; });
    await expect(searchRemoteEntries(f.remote, 'connection', '/web', query(), new AbortController().signal)).rejects.toThrow('serverbestemming'); expect(f.active()).toBe(0);
  });

  it.each(['../escape', '..', '.', 'nested/name', 'nested\\name', 'bad\nname', '\0'])('rejects malicious server name %j', async name => {
    const f = fixture({ '/web': [{ ...entry('/web/a'), name }] });
    await expect(searchRemoteEntries(f.remote, 'connection', '/web', query(), new AbortController().signal)).rejects.toThrow('onveilige bestandsnaam'); expect(f.active()).toBe(0);
  });

  it('rejects inconsistent server paths, root escapes and duplicate metadata', async () => {
    const f = fixture({ '/web': [{ ...entry('/web/a'), path: '/outside/a' }] });
    await expect(searchRemoteEntries(f.remote, 'connection', '/web', query(), new AbortController().signal)).rejects.toThrow('inconsistent');
    await expect(searchRemoteEntries(f.remote, 'connection', '/web/../private', query(), new AbortController().signal)).rejects.toThrow('buiten');
    f.list.mockResolvedValueOnce([entry('/web/a'), entry('/web/a')]);
    await expect(searchRemoteEntries(f.remote, 'connection', '/web', query(), new AbortController().signal)).rejects.toThrow('dubbele');
  });

  it.each([{ minSize: -1 }, { maxSize: Infinity }, { minSize: 100, maxSize: 1 }, { modifiedAfter: NaN }, { modifiedBefore: 9e15 }, { modifiedAfter: 200, modifiedBefore: 100 }])('validates numeric filter %j before any network access', async invalid => {
    const f = fixture({});
    await expect(searchRemoteEntries(f.remote, 'connection', '/web', query(invalid), new AbortController().signal)).rejects.toThrow(); expect(f.acquire).not.toHaveBeenCalled();
  });

  it('bounds total scanned items across directories even when nothing matches', async () => {
    const children = Array.from({ length: 50_000 }, (_, index) => entry(`/web/child/${index}.txt`));
    const f = fixture({ '/web': [entry('/web/child', 'directory')], '/web/child': children });
    await expect(searchRemoteEntries(f.remote, 'connection', '/web', query({ text: 'no-result' }), new AbortController().signal)).rejects.toThrow('50.000'); expect(f.release).toHaveBeenCalledTimes(2); expect(f.active()).toBe(0);
  });
});
