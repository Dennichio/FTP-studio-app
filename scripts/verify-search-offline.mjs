import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

// Executes the actual search module using Node 24's TS transformer.
// The remote listing fixtures below are test-only; no production module is mocked.
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

const { searchRemoteEntries } = await import('../src/main/remoteSearch.ts');
const { endpointIdentity } = await import('../src/core/connectionIdentity.ts');
const query = overrides => ({ text: '', regex: false, caseSensitive: false, ...overrides });
const entry = (absolute, kind = 'file', size = 10, modifiedAt = 100) => ({ name: absolute.split('/').pop(), path: absolute, kind, size, modifiedAt });
function fixture(tree) {
  const profile = { id: 'fixture', protocol: 'sftp', host: 'one.example', port: 22, username: 'user', localRoot: '/tmp', remoteRoot: '/web', hostKeySha256: 'pin' };
  const counts = { acquired: 0, released: 0, active: 0, peak: 0, content: 0 };
  const visited = [];
  const f = { profile, counts, visited, onAcquire: undefined, onList: undefined };
  const noContents = async () => { counts.content++; throw new Error('This listing search must never access file contents'); };
  const session = {
    list: async (directory, signal) => { visited.push(directory); await f.onList?.(directory, signal); signal?.throwIfAborted(); return tree[directory] ?? []; },
    download: noContents, upload: noContents, stat: noContents,
  };
  f.remote = {
    profile: () => profile,
    acquire: async (_id, purpose, signal) => {
      assert.equal(purpose, 'navigation'); signal?.throwIfAborted(); counts.acquired++; counts.active++; counts.peak = Math.max(counts.peak, counts.active);
      await f.onAcquire?.();
      return { session, release: async () => { counts.active--; counts.released++; } };
    },
  };
  return f;
}
const signal = () => new AbortController().signal;
let passed = 0;
async function check(name, test) { await test(); passed++; console.log(`PASS ${name}`); }

await check('BFS, filters, unknown timestamps, released leases and no content access', async () => {
  const f = fixture({ '/web': [entry('/web/assets', 'directory', 0, null), entry('/web/top.css', 'file', 40, 150), entry('/web/link', 'symlink')], '/web/assets': [entry('/web/assets/a.css', 'file', 40, 150), entry('/web/assets/unknown.css', 'file', 40, null), entry('/web/assets/image.png', 'file', 40, 150)] });
  const result = await searchRemoteEntries(f.remote, 'connection', '/web', query({ glob: '*.css', pathGlob: 'assets/*.css', kind: 'file', minSize: 35, maxSize: 50, modifiedAfter: 100, modifiedBefore: 200 }), signal());
  assert.deepEqual(result.map(item => item.relativePath), ['assets/a.css']); assert.deepEqual(f.visited, ['/web', '/web/assets']);
  assert.equal(f.counts.acquired, f.counts.released); assert.equal(f.counts.peak, 1); assert.equal(f.counts.active, 0); assert.equal(f.counts.content, 0);
  f.visited.length = 0;
  const shallow = await searchRemoteEntries(f.remote, 'connection', '/web', query({ recursive: false, kind: 'directory' }), signal());
  assert.deepEqual(shallow.map(item => item.name), ['assets']); assert.deepEqual(f.visited, ['/web']);
});

await check('case-sensitive literals and bounded name regex', async () => {
  const f = fixture({ '/web': [entry('/web/ReadMe.md'), entry('/web/readme.txt')] });
  assert.equal((await searchRemoteEntries(f.remote, 'c', '/web', query({ text: 'ReadMe', caseSensitive: true }), signal())).length, 1);
  assert.equal((await searchRemoteEntries(f.remote, 'c', '/web', query({ text: '^readme.*$', regex: true }), signal())).length, 2);
  await assert.rejects(searchRemoteEntries(f.remote, 'c', '/web', query({ text: '(a+)+$', regex: true }), signal()), /veilig/);
});

await check('endpoint changes before acquire, after acquire and after list reject results', async () => {
  const f = fixture({ '/web': [entry('/web/a')] }); const expected = endpointIdentity(f.profile);
  f.profile.host = 'changed.example'; await assert.rejects(searchRemoteEntries(f.remote, 'c', '/web', query(), signal(), expected), /serverbestemming/); assert.equal(f.counts.acquired, 0);
  f.profile.host = 'one.example'; f.onAcquire = async () => { f.profile.host = 'changed.example'; };
  await assert.rejects(searchRemoteEntries(f.remote, 'c', '/web', query(), signal()), /serverbestemming/); assert.equal(f.visited.length, 0); assert.equal(f.counts.active, 0);
  f.profile.host = 'one.example'; f.onAcquire = undefined; f.onList = async () => { f.profile.host = 'changed.example'; };
  await assert.rejects(searchRemoteEntries(f.remote, 'c', '/web', query(), signal()), /serverbestemming/); assert.equal(f.counts.active, 0);
});

await check('cancellation before acquisition and during listing releases the lease', async () => {
  const f = fixture({}); const before = new AbortController(); before.abort();
  await assert.rejects(searchRemoteEntries(f.remote, 'c', '/web', query(), before.signal)); assert.equal(f.counts.acquired, 0);
  const during = new AbortController(); f.onList = async () => { during.abort(); };
  await assert.rejects(searchRemoteEntries(f.remote, 'c', '/web', query(), during.signal)); assert.equal(f.counts.active, 0); assert.equal(f.counts.acquired, f.counts.released);
});

await check('malicious names, inconsistent paths and scope escapes are rejected', async () => {
  for (const name of ['../escape', '.', '..', 'nested/name', 'nested\\name', 'bad\nname', '\0']) {
    const f = fixture({ '/web': [{ ...entry('/web/a'), name }] });
    await assert.rejects(searchRemoteEntries(f.remote, 'c', '/web', query(), signal()), /onveilige/); assert.equal(f.counts.active, 0);
  }
  const f = fixture({ '/web': [{ ...entry('/web/a'), path: '/outside/a' }] });
  await assert.rejects(searchRemoteEntries(f.remote, 'c', '/web', query(), signal()), /inconsistent/);
  await assert.rejects(searchRemoteEntries(f.remote, 'c', '/web/../private', query(), signal()), /buiten/);
});

await check('invalid numeric filters are rejected before acquisition', async () => {
  for (const invalid of [{ minSize: -1 }, { maxSize: Infinity }, { minSize: 100, maxSize: 1 }, { modifiedAfter: NaN }, { modifiedBefore: 9e15 }, { modifiedAfter: 200, modifiedBefore: 100 }]) {
    const f = fixture({}); await assert.rejects(searchRemoteEntries(f.remote, 'c', '/web', query(invalid), signal())); assert.equal(f.counts.acquired, 0);
  }
});

await check('the 50,000 scan bound applies even if no items match', async () => {
  const f = fixture({ '/web': [entry('/web/child', 'directory')], '/web/child': Array.from({ length: 50_000 }, (_, index) => entry(`/web/child/${index}`)) });
  await assert.rejects(searchRemoteEntries(f.remote, 'c', '/web', query({ text: 'no-match' }), signal()), /50.000/); assert.equal(f.counts.active, 0); assert.equal(f.counts.acquired, f.counts.released);
});

console.log(`${passed} native remote-search checks passed. Vitest and live protocol integration were not invoked.`);
