import assert from 'node:assert/strict';
import { existsSync, readFileSync, promises as fs } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// Real workspace implementation, real temporary files, deterministic concurrent chmod.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const url = new URL(specifier, context.parentURL);
      if (!/\.[mc]?[jt]sx?$/.test(url.pathname) && existsSync(fileURLToPath(url) + '.ts')) return next(url.href + '.ts', context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.ts')) return { format: 'module', source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), { mode: 'transform', sourceUrl: url }), shortCircuit: true };
    return next(url, context);
  },
});

if (process.platform === 'win32') {
  console.log('SKIP POSIX chmod/umask checks on Windows; ACL, ownership and Windows attribute preservation are unproven.');
} else {
  const { readTextFile, safeSaveTextFile } = await import('../src/core/workspace.ts');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-permissions-offline-'));
  const originalOpen = fs.open.bind(fs);
  const originalRename = fs.rename.bind(fs);
  const originalLink = fs.link.bind(fs);
  const originalMask = process.umask();
  let passed = 0;
  try {
    const file = path.join(root, 'group.txt');
    await fs.writeFile(file, 'original'); await fs.chmod(file, 0o664);
    const original = await readTextFile(file);
    process.umask(0o077);
    try { await safeSaveTextFile(file, 'editor', original.snapshot); } finally { process.umask(originalMask); }
    assert.equal((await fs.stat(file)).mode & 0o777, 0o664);
    passed++; console.log('PASS basic POSIX permission bits survive restrictive umask');

    const staged = path.join(root, 'stage-private.txt');
    await fs.writeFile(staged, 'original'); await fs.chmod(staged, 0o644);
    const stageOriginal = await readTextFile(staged);
    fs.open = async (target, flags, mode) => {
      if (String(target).endsWith('.tmp')) await fs.chmod(staged, 0o600);
      return originalOpen(target, flags, mode);
    };
    await assert.rejects(safeSaveTextFile(staged, 'editor', stageOriginal.snapshot), /Bestandsrechten/);
    assert.equal(await fs.readFile(staged, 'utf8'), 'original'); assert.equal((await fs.stat(staged)).mode & 0o777, 0o600);
    fs.open = originalOpen;
    passed++; console.log('PASS concurrent staging chmod is preserved and save is refused');

    const moved = path.join(root, 'move-private.txt');
    await fs.writeFile(moved, 'original'); await fs.chmod(moved, 0o644);
    const moveOriginal = await readTextFile(moved);
    fs.rename = async (from, to) => {
      await originalRename(from, to);
      if (String(from) === moved) await fs.chmod(to, 0o600);
    };
    await assert.rejects(safeSaveTextFile(moved, 'editor', moveOriginal.snapshot), /Bestandsrechten/);
    assert.equal(await fs.readFile(moved, 'utf8'), 'original'); assert.equal((await fs.stat(moved)).mode & 0o777, 0o600);
    fs.rename = originalRename;
    const containers = await fs.readdir(path.join(root, '.ftp-studio-backups'));
    let retainedBackup;
    for (const container of containers) {
      const candidate = path.join(root, '.ftp-studio-backups', container, 'move-private.txt');
      if (existsSync(candidate)) retainedBackup = candidate;
    }
    assert(retainedBackup); assert.equal((await fs.stat(retainedBackup)).mode & 0o777, 0o600); assert.equal(await fs.readFile(retainedBackup, 'utf8'), 'original');
    passed++; console.log('PASS moved-original chmod triggers exclusive restore with restricted mode and retained backup');
    for (const replaceTarget of [false, true]) {
      const late = path.join(root, replaceTarget ? 'late-other-writer.txt' : 'late-private.txt');
      await fs.writeFile(late, 'original'); await fs.chmod(late, 0o644);
      const before = await readTextFile(late);
      let lateBackup;
      fs.rename = async (from, to) => { await originalRename(from, to); if (String(from) === late) lateBackup = String(to); };
      fs.link = async (from, to) => {
        if (String(to) === late) { assert(lateBackup); await fs.chmod(lateBackup, 0o600); }
        await originalLink(from, to);
        if (String(to) === late && replaceTarget) {
          await fs.unlink(late); await fs.writeFile(late, 'editor'); await fs.chmod(late, 0o666);
        }
      };
      await assert.rejects(safeSaveTextFile(late, 'editor', before.snapshot), /Opslaan vereist controle/);
      fs.rename = originalRename; fs.link = originalLink;
      assert.equal(await fs.readFile(late, 'utf8'), 'editor');
      assert.equal((await fs.stat(late)).mode & 0o777, replaceTarget ? 0o666 : 0o600);
      assert.equal(await fs.readFile(lateBackup, 'utf8'), 'original');
      assert.equal((await fs.stat(lateBackup)).mode & 0o777, 0o600);
      passed++; console.log(replaceTarget ? 'PASS late restriction never chmods an unrelated replacement pathname' : 'PASS late original-inode restriction rejects saving and restricts the installed owned inode');
    }
    console.log(`${passed} native POSIX permission checks passed. Vitest, Windows ACLs, owner and Windows attributes were not tested.`);
  } finally {
    fs.open = originalOpen; fs.rename = originalRename; fs.link = originalLink; process.umask(originalMask);
    await fs.rm(root, { recursive: true, force: true });
  }
}
