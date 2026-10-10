import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { applyReplace, assertSafeLocalPath, boundedRegex, compareEntries, isDefaultExcluded, isSensitivePath, listLocal, localSnapshot, mapLocalToRemote, mapRemoteToLocal, matchesFilters, mutateLocal, previewReplace, readTextFile, safeSaveTextFile, searchProject } from '../src/core/workspace';
import type { FileEntry } from '../src/shared/contracts';

const roots: string[] = [];
async function temp() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-workspace-')); roots.push(root); return root; }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { force: true, recursive: true }))); });

describe('safe local workspace', () => {
  it('blocks symlinks in ancestors and directory trees before mutation', async () => {
    const root = await temp(); const outside = await temp();
    await fs.writeFile(path.join(outside, 'secret'), 'original');
    await fs.symlink(outside, path.join(root, 'link'), 'dir');
    await expect(assertSafeLocalPath(path.join(root, 'link', 'new'), root, true)).rejects.toThrow('koppelingen');
    await expect(mutateLocal('delete', root)).rejects.toThrow('koppelingen');
    expect(await fs.readFile(path.join(outside, 'secret'), 'utf8')).toBe('original');
    await expect(assertSafeLocalPath(outside, root)).rejects.toThrow('buiten');
  });

  it('preserves UTF-8 BOM and EOL and refuses stale optimistic saves', async () => {
    const root = await temp(); const file = path.join(root, 'index.html');
    await fs.writeFile(file, '\uFEFFéén\r\ntwee\r\n');
    const original = await readTextFile(file);
    expect(original.content).toBe('\uFEFFéén\r\ntwee\r\n'); expect(original.eol).toBe('CRLF');
    await safeSaveTextFile(file, `${original.content}drie\r\n`, original.snapshot);
    await expect(safeSaveTextFile(file, 'stale', original.snapshot)).rejects.toThrow('gewijzigd');
    expect(await fs.readFile(file, 'utf8')).toContain('drie');
    expect((await fs.readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    await expect(safeSaveTextFile(file, 'overwrite', null)).rejects.toThrow();
  });

  it('validates the moved original and restores a concurrent writer without losing its bytes', async () => {
    const root = await temp(); const file = path.join(root, 'a.txt'); await fs.writeFile(file, 'original');
    const original = await readTextFile(file); const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === file) await fs.writeFile(file, 'concurrent writer');
      return rename(from, to);
    });
    await expect(safeSaveTextFile(file, 'editor', original.snapshot)).rejects.toThrow('bestandswissel gewijzigd');
    expect(await fs.readFile(file, 'utf8')).toBe('concurrent writer');
  });

  it('uses exclusive install and retains original backup when another writer recreates the destination', async () => {
    const root = await temp(); const file = path.join(root, 'a.txt'); await fs.writeFile(file, 'original');
    const original = await readTextFile(file); const link = fs.link.bind(fs);
    vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
      if (String(to) === file && String(from).endsWith('.tmp')) await fs.writeFile(file, 'concurrent destination', { flag: 'wx' });
      return link(from, to);
    });
    await expect(safeSaveTextFile(file, 'editor', original.snapshot)).rejects.toThrow('Oorspronkelijk bestand veilig');
    expect(await fs.readFile(file, 'utf8')).toBe('concurrent destination');
    const containers = await fs.readdir(path.join(root, '.ftp-studio-backups'));
    expect(await fs.readFile(path.join(root, '.ftp-studio-backups', containers[0], 'a.txt'), 'utf8')).toBe('original');
  });

  it('preserves the conflict, failed rollback cause and backup path when temporary cleanup also fails', async () => {
    const root = await temp(); const file = path.join(root, 'a.txt'); await fs.writeFile(file, 'original');
    const original = await readTextFile(file); const link = fs.link.bind(fs); const remove = fs.rm.bind(fs); let temporaryRemovals = 0;
    vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
      if (String(to) === file && String(from).endsWith('.tmp')) await fs.writeFile(file, 'concurrent destination', { flag: 'wx' });
      return link(from, to);
    });
    vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (String(target).endsWith('.tmp') && ++temporaryRemovals > 1) throw Object.assign(new Error('cleanup denied'), { code: 'EACCES' });
      return remove(target, options);
    });
    let failure: unknown;
    try { await safeSaveTextFile(file, 'editor', original.snapshot); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError); expect((failure as Error).message).toContain('Oorspronkelijk bestand veilig'); expect((failure as Error).message).toContain('opruimfout');
    const conflict = (failure as Error).cause as AggregateError;
    expect(conflict).toBeInstanceOf(AggregateError); expect(conflict.errors).toHaveLength(2); expect(conflict.errors[1]).toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(file, 'utf8')).toBe('concurrent destination');
    const containers = await fs.readdir(path.join(root, '.ftp-studio-backups')); const backup = path.join(root, '.ftp-studio-backups', containers[0], 'a.txt');
    expect((failure as Error).message).toContain(backup); expect(await fs.readFile(backup, 'utf8')).toBe('original');
    const retained = (await fs.readdir(root)).filter(name => name.endsWith('.tmp')); expect(retained).toHaveLength(1); expect(isDefaultExcluded(retained[0])).toBe(true);
  });

  it('preserves an unsupported-hardlink cause if probe cleanup fails', async () => {
    const root = await temp(); const file = path.join(root, 'a.txt'); await fs.writeFile(file, 'original'); const original = await readTextFile(file);
    vi.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('link unsupported'), { code: 'EPERM' }));
    vi.spyOn(fs, 'rm').mockRejectedValue(Object.assign(new Error('cleanup denied'), { code: 'EACCES' }));
    await expect(safeSaveTextFile(file, 'editor', original.snapshot)).rejects.toThrow('vereist hardlinks'); expect(await fs.readFile(file, 'utf8')).toBe('original');
  });

  it('probes unsupported hardlinks before moving an original and preserves permissions in its backup', async () => {
    const root = await temp(); const file = path.join(root, 'a.txt'); await fs.writeFile(file, 'original', { mode: 0o640 });
    const original = await readTextFile(file);
    vi.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('unsupported'), { code: 'EPERM' }));
    await expect(safeSaveTextFile(file, 'editor', original.snapshot)).rejects.toThrow('vereist hardlinks');
    expect(await fs.readFile(file, 'utf8')).toBe('original'); vi.restoreAllMocks();
    await safeSaveTextFile(file, 'editor', original.snapshot);
    const containers = await fs.readdir(path.join(root, '.ftp-studio-backups')); const backup = path.join(root, '.ftp-studio-backups', containers[0], 'a.txt');
    expect(await fs.readFile(backup, 'utf8')).toBe('original');
    if (process.platform !== 'win32') { expect((await fs.stat(backup)).mode & 0o777).toBe(0o640); expect((await fs.stat(file)).mode & 0o777).toBe(0o640); }
  });

  it.skipIf(process.platform === 'win32')('preserves group-write POSIX bits despite a restrictive umask', async () => {
    const root = await temp(); const file = path.join(root, 'group.txt'); await fs.writeFile(file, 'before'); await fs.chmod(file, 0o664);
    const original = await readTextFile(file); const originalMask = process.umask(0o077);
    try { await safeSaveTextFile(file, 'after', original.snapshot); } finally { process.umask(originalMask); }
    expect((await fs.stat(file)).mode & 0o777).toBe(0o664);
    const containers = await fs.readdir(path.join(root, '.ftp-studio-backups'));
    expect((await fs.stat(path.join(root, '.ftp-studio-backups', containers[0], 'group.txt'))).mode & 0o777).toBe(0o664);
  });

  it.skipIf(process.platform === 'win32')('preserves a concurrent permission restriction made while staging', async () => {
    const root = await temp(); const file = path.join(root, 'private.txt'); await fs.writeFile(file, 'original'); await fs.chmod(file, 0o644);
    const original = await readTextFile(file); const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (target, flags, mode) => {
      if (String(target).endsWith('.tmp')) await fs.chmod(file, 0o600);
      return open(target, flags, mode);
    });
    await expect(safeSaveTextFile(file, 'editor', original.snapshot)).rejects.toThrow('Bestandsrechten');
    expect(await fs.readFile(file, 'utf8')).toBe('original'); expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('restores a moved original with newly restricted permissions rather than installing the broader temp', async () => {
    const root = await temp(); const file = path.join(root, 'private.txt'); await fs.writeFile(file, 'original'); await fs.chmod(file, 0o644);
    const original = await readTextFile(file); const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await rename(from, to);
      if (String(from) === file) await fs.chmod(to, 0o600);
    });
    await expect(safeSaveTextFile(file, 'editor', original.snapshot)).rejects.toThrow('Bestandsrechten');
    expect(await fs.readFile(file, 'utf8')).toBe('original'); expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    const containers = await fs.readdir(path.join(root, '.ftp-studio-backups')); const backup = path.join(root, '.ftp-studio-backups', containers[0], 'private.txt');
    expect((await fs.stat(backup)).mode & 0o777).toBe(0o600); expect(await fs.readFile(backup, 'utf8')).toBe('original');
  });

  for (const replaceTarget of [false, true]) {
    it.skipIf(process.platform === 'win32')(`rejects late original-inode chmod without modifying an unrelated target: ${replaceTarget}`, async () => {
      const root = await temp(), file = path.join(root, 'late.txt');
      await fs.writeFile(file, 'original'); await fs.chmod(file, 0o644);
      const original = await readTextFile(file), rename = fs.rename.bind(fs), link = fs.link.bind(fs);
      let backup: string | undefined;
      vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => { await rename(from, to); if (String(from) === file) backup = String(to); });
      vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
        if (String(to) === file) { expect(backup).toBeDefined(); await fs.chmod(backup!, 0o600); }
        await link(from, to);
        if (String(to) === file && replaceTarget) { await fs.unlink(file); await fs.writeFile(file, 'editor'); await fs.chmod(file, 0o666); }
      });
      await expect(safeSaveTextFile(file, 'editor', original.snapshot)).rejects.toThrow('Opslaan vereist controle');
      expect(await fs.readFile(file, 'utf8')).toBe('editor');
      expect((await fs.stat(file)).mode & 0o777).toBe(replaceTarget ? 0o666 : 0o600);
      expect(await fs.readFile(backup!, 'utf8')).toBe('original');
      expect((await fs.stat(backup!)).mode & 0o777).toBe(0o600);
    });
  }

  it('lists metadata with at most sixteen concurrent reads, skips disappearance and preserves sorting', async () => {
    const root = await temp();
    await Promise.all(Array.from({ length: 40 }, (_, index) => fs.writeFile(path.join(root, `${String(index).padStart(2, '0')}.txt`), 'x')));
    await fs.mkdir(path.join(root, 'directory')); const missing = path.join(root, 'gone.txt'); await fs.writeFile(missing, 'x');
    const originalStat = fs.lstat.bind(fs); let active = 0; let peak = 0;
    vi.spyOn(fs, 'lstat').mockImplementation(async target => {
      if (path.dirname(String(target)) !== root) return originalStat(target);
      active++; peak = Math.max(peak, active);
      try {
        await new Promise<void>(resolve => setImmediate(resolve));
        if (String(target) === missing) await fs.unlink(missing);
        return await originalStat(target);
      } finally { active--; }
    });
    const entries = await listLocal(root, true);
    expect(peak).toBeGreaterThan(1); expect(peak).toBeLessThanOrEqual(16); expect(active).toBe(0);
    expect(entries).toHaveLength(41); expect(entries[0].name).toBe('directory');
    expect(entries.slice(1).map(entry => entry.name)).toEqual(Array.from({ length: 40 }, (_, index) => `${String(index).padStart(2, '0')}.txt`));
  });

  it('propagates metadata permission errors instead of silently hiding entries', async () => {
    const root = await temp(); const denied = path.join(root, 'denied.txt'); await fs.writeFile(denied, 'x');
    const originalStat = fs.lstat.bind(fs);
    vi.spyOn(fs, 'lstat').mockImplementation(async target => {
      if (String(target) === denied) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return originalStat(target);
    });
    await expect(listLocal(root, true)).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('stops hashing at the initial file size if a source grows while streaming', async () => {
    const root = await temp(); const file = path.join(root, 'growing.txt'); await fs.writeFile(file, 'x');
    const originalOpen = fs.open.bind(fs); let stream: ReturnType<Awaited<ReturnType<typeof fs.open>>['createReadStream']> | undefined;
    vi.spyOn(fs, 'open').mockImplementation(async (target, flags, mode) => {
      const handle = await originalOpen(target, flags, mode);
      if (String(target) === file) {
        const originalStream = handle.createReadStream.bind(handle);
        vi.spyOn(handle, 'createReadStream').mockImplementation(options => {
          appendFileSync(file, Buffer.alloc(1024 * 1024, 'x'));
          stream = originalStream(options); return stream;
        });
      }
      return handle;
    });
    await expect(localSnapshot(file)).rejects.toThrow('hashcontrole gegroeid');
    expect(stream!.bytesRead).toBeLessThan(1024 * 1024);
  });

  it('never overwrites a concurrent file destination while renaming', async () => {
    const root = await temp(); const source = path.join(root, 'a.txt'); const destination = path.join(root, 'b.txt'); await fs.writeFile(source, 'original');
    const link = fs.link.bind(fs);
    vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
      if (String(to) === destination) await fs.writeFile(destination, 'concurrent', { flag: 'wx' });
      return link(from, to);
    });
    await expect(mutateLocal('rename', source, destination)).rejects.toThrow();
    expect(await fs.readFile(source, 'utf8')).toBe('original'); expect(await fs.readFile(destination, 'utf8')).toBe('concurrent');
  });

  it.skipIf(process.platform === 'win32')('rejects FIFO text/hash/list operations without blocking', async () => {
    const root = await temp(); const fifo = path.join(root, 'pipe');
    try { execFileSync('mkfifo', [fifo]); } catch (error) {
      // Some managed runners report a child wait error after successful fixture creation.
      if (!(await fs.lstat(fifo)).isFIFO()) throw error;
    }
    await expect(readTextFile(fifo)).rejects.toThrow('gewone tekstbestanden'); await expect(localSnapshot(fifo)).rejects.toThrow('gewoon bestand');
    await expect(listLocal(root, true)).rejects.toThrow('Speciaal bestand');
  });

  it.skipIf(process.platform === 'win32')('refuses directory move on platforms without no-replace rename', async () => {
    const root = await temp(); const directory = path.join(root, 'folder'); await fs.mkdir(directory);
    await expect(mutateLocal('rename', directory, path.join(root, 'renamed'))).rejects.toThrow('alleen op Windows');
    expect((await fs.stat(directory)).isDirectory()).toBe(true);
  });

  it('blocks binary files, invalid UTF-8, accidental create overwrite and copy into itself', async () => {
    const root = await temp(); const file = path.join(root, 'binary');
    await fs.writeFile(file, Buffer.from([0, 1])); await expect(readTextFile(file)).rejects.toThrow('Binair');
    await fs.writeFile(file, Buffer.from([255])); await expect(readTextFile(file)).rejects.toThrow('UTF-8');
    await expect(mutateLocal('create', file)).rejects.toThrow();
    await expect(mutateLocal('copy', root, path.join(root, 'child'))).rejects.toThrow('bronmap');
  });

  it('maps Windows and POSIX roots while refusing root escapes', () => {
    expect(mapLocalToRemote('C:\\sites\\demo\\css\\main.css', 'C:\\sites\\demo', '/public')).toBe('/public/css/main.css');
    expect(mapRemoteToLocal('/public/css/main.css', '/public', 'C:\\sites\\demo')).toBe('C:\\sites\\demo\\css\\main.css');
    expect(() => mapLocalToRemote('C:\\sites\\demo-other\\a', 'C:\\sites\\demo', '/public')).toThrow('buiten');
    expect(() => mapRemoteToLocal('/public/../private', '/public', '/tmp/demo')).toThrow('buiten');
    expect(() => mapRemoteToLocal('/public/C:/secret', '/public', 'C:\\sites\\demo')).toThrow();
    expect(mapLocalToRemote('\\\\server\\share\\site\\a.css', '\\\\server\\share\\site', '/web')).toBe('/web/a.css');
    expect(mapRemoteToLocal('/web/a.css', '/web', '\\\\server\\share\\site')).toBe('\\\\server\\share\\site\\a.css');
    expect(() => mapRemoteToLocal('/public/CON.txt', '/public', 'C:\\sites\\demo')).toThrow();
  });

  it('uses hidden visibility, safe glob filters and rejects catastrophic regex patterns', async () => {
    const root = await temp(); await fs.writeFile(path.join(root, '.hidden'), 'x'); await fs.writeFile(path.join(root, 'app.css'), 'a');
    expect((await listLocal(root)).map(entry => entry.name)).toEqual(['app.css']);
    expect(await listLocal(root, true)).toHaveLength(2);
    const entry: FileEntry = { name: 'app.css', path: '/site/styles/app.css', relativePath: 'styles/app.css', kind: 'file', size: 10, modifiedAt: 1 };
    expect(matchesFilters(entry, [{ id: 'a', field: 'path', operator: 'glob', value: '**/*.css', action: 'include' }])).toBe(true);
    expect(matchesFilters({ ...entry, relativePath: 'app.css' }, [{ id: 'a', field: 'path', operator: 'glob', value: '**/*.css', action: 'include' }])).toBe(true);
    expect(matchesFilters(entry, [{ id: 'a', field: 'extension', operator: 'equals', value: 'js', action: 'include' }, { id: 'b', field: 'extension', operator: 'equals', value: 'css', action: 'include' }])).toBe(true);
    expect(() => boundedRegex('(a+)+$')).toThrow('veilig');
    expect(() => boundedRegex('a*a*a*b')).toThrow('veilig');
    expect(() => boundedRegex('a?a?a?a?a?b')).toThrow('veilig');
    expect(boundedRegex('^abc.*$').test('abcdef')).toBe(true);
    expect(isDefaultExcluded('node_modules/pkg/file.js')).toBe(true); expect(isSensitivePath('secrets/private.pem')).toBe(true);
  });

  it('treats unknown timestamp precision conservatively and detects both baseline changes', () => {
    expect(compareEntries({ size: 1, modifiedAt: 3 }, { size: 1, modifiedAt: 2 })).toBe('uncertain');
    expect(compareEntries({ size: 1, modifiedAt: 3, precisionMs: 1 }, { size: 1, modifiedAt: 3, precisionMs: 1000 })).toBe('probably-identical');
    const baseline = { relativePath: 'a', local: { size: 1, modifiedAt: 1, checksum: 'before' }, remote: { size: 1, modifiedAt: 1 }, publishedAt: 1 };
    expect(compareEntries({ size: 1, modifiedAt: 2, checksum: 'after' }, { size: 2, modifiedAt: 2 }, baseline)).toBe('conflict');
  });

  it('searches bounded project text, honours cancellation and never partially applies stale preview', async () => {
    const root = await temp(); const first = path.join(root, 'a.txt'); const second = path.join(root, 'b.txt');
    await fs.writeFile(first, 'hello\nhello\n'); await fs.writeFile(second, 'hello');
    await fs.mkdir(path.join(root, 'node_modules')); await fs.writeFile(path.join(root, 'node_modules', 'ignored'), 'hello'); await fs.writeFile(path.join(root, '.env'), 'hello');
    const query = { text: 'hello', regex: false, caseSensitive: true };
    expect(await searchProject(root, query)).toHaveLength(3);
    const cancelled = new AbortController(); cancelled.abort(); await expect(searchProject(root, query, cancelled.signal)).rejects.toThrow();
    const preview = await previewReplace(root, query, '$literal'); expect(preview).toHaveLength(2);
    await fs.writeFile(second, 'external edit');
    await expect(applyReplace(preview)).rejects.toThrow('verouderd'); expect(await fs.readFile(first, 'utf8')).toBe('hello\nhello\n');
    await fs.writeFile(second, 'hello'); const fresh = await previewReplace(root, query, '$literal');
    expect(await applyReplace(fresh)).toBe(3); expect(await fs.readFile(first, 'utf8')).toBe('$literal\n$literal\n');
    const backups = (await fs.readdir(path.join(root, '.ftp-studio-backups'))).filter(name => name.endsWith('.bak')); expect(backups).toHaveLength(2);
    expect(await fs.readFile(path.join(root, '.ftp-studio-backups', backups.find(name => name.endsWith('a.txt.bak'))!), 'utf8')).toBe('hello\nhello\n');
  });
});
