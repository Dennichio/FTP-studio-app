/**
 * Real loopback FTP benchmark. Requires the installed application dependencies and Node 24+.
 * Run: node --no-warnings scripts/benchmark-transfers.mts
 * Small smoke run: node --no-warnings scripts/benchmark-transfers.mts --quick
 * No external server, credentials, network download, or dependency installation is used.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { ConnectionProfile, KeyValueStore, QueuePersistence, RemoteSession, TransferJob, TransferRequest } from '../src/shared/contracts';

const { values } = parseArgs({ options: {
  help: { type: 'boolean', short: 'h' }, quick: { type: 'boolean' },
  parallel: { type: 'string', default: '1,2,4,8' }, direction: { type: 'string', default: 'both' },
  scenario: { type: 'string', default: 'both' }, 'control-no-delay': { type: 'boolean', default: false }, mlst: { type: 'boolean', default: false }, store: { type: 'string', default: 'memory' },
  'small-count': { type: 'string' }, 'small-bytes': { type: 'string', default: '4096' },
  'large-count': { type: 'string' }, 'large-bytes': { type: 'string', default: '1048576' },
  'timeout-ms': { type: 'string', default: '600000' }, output: { type: 'string' },
} });
if (values.help) {
  console.log(`Gebruik: node --no-warnings scripts/benchmark-transfers.mts [opties]
  --parallel 1,2,4,8        Aantal parallelle overdrachten; standaard alle vier
  --direction both         upload, download of both
  --scenario both          small, large of both; draait alleen de gekozen dataset
  --control-no-delay       TCP_NODELAY op fixture-controlverbindingen (standaard uit)
  --mlst                   Ondersteun verse single-item MLST in de testserver
  --store memory           memory of sqlite; sqlite gebruikt het productiejournaal
  --small-count 1000       Kleine bestanden per scenario (standaard 1.000)
  --small-bytes 4096       Bytes per klein bestand
  --large-count 16         Grote bestanden per scenario
  --large-bytes 1048576    Bytes per groot bestand
  --timeout-ms 600000      Maximale tijd per scenario
  --output PAD             JSON-resultaat; standaard benchmark-results/ftp-DATUM.json
  --quick                  Rooktest: 8 kleine + 2 grote bestanden; geen 1.000-bestandentest

Echte TCP-verbindingen naar 127.0.0.1 en tijdelijke lokale bestanden.
De FTP-testserver bewaart data in geheugen; dit meet geen internet- of serverdiskprestaties.
Memory gebruikt JSON-snapshots; sqlite gebruikt echte incrementele WAL/FULL-transacties.
TCP_NODELAY verandert alleen de lokale fixture, niet de productieclient. Rapporteer beide modi apart.
Eén run op een gedeelde ontwikkelhost toont geen optimaal productieprofiel.`);
  process.exit(0);
}

function integer(value: string | undefined, fallback: number, label: string, maximum: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`Ongeldige waarde voor ${label}: ${value}`);
  return parsed;
}
const parallelisms = [...new Set(values.parallel!.split(',').map(value => integer(value, 1, 'parallel', 8)))];
if (!['upload', 'download', 'both'].includes(values.direction!)) throw new Error('direction moet upload, download of both zijn.');
if (!['small', 'large', 'both'].includes(values.scenario!)) throw new Error('scenario moet small, large of both zijn.');
if (!['memory', 'sqlite'].includes(values.store!)) throw new Error('store moet memory of sqlite zijn.');
const directions: Array<'upload' | 'download'> = values.direction === 'both' ? ['upload', 'download'] : [values.direction as 'upload' | 'download'];
const allScenarios = [
  { name: 'grote-bestanden', count: integer(values['large-count'], values.quick ? 2 : 16, 'large-count', 10_000), bytes: integer(values['large-bytes'], 1048576, 'large-bytes', 64 * 1024 * 1024) },
  { name: 'kleine-bestanden', count: integer(values['small-count'], values.quick ? 8 : 1000, 'small-count', 10_000), bytes: integer(values['small-bytes'], 4096, 'small-bytes', 1024 * 1024) },
];
const scenarios = allScenarios.filter(scenario => values.scenario === 'both' || scenario.name === (values.scenario === 'small' ? 'kleine-bestanden' : 'grote-bestanden'));
for (const scenario of scenarios) if (scenario.bytes * scenario.count > 512 * 1024 * 1024) throw new Error('De dataset mag maximaal 512 MiB per scenario zijn.');
const timeoutMs = integer(values['timeout-ms'], 600000, 'timeout-ms', 3_600_000);
const output = path.resolve(values.output ?? path.join('benchmark-results', `ftp-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));

// The application uses extensionless TypeScript imports. Resolve/transform those without adding tsx/ts-node.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const url = new URL(specifier, context.parentURL);
      if (existsSync(fileURLToPath(url) + '.ts')) return next(url.href + '.ts', context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.ts')) return { format: 'module', source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), { mode: 'transform' }), shortCircuit: true };
    return next(url, context);
  },
});
const [{ RemoteManager, createProtocolSession }, { TransferQueue }, { ftpFixture }, { SqliteStore }] = await Promise.all([
  import('../src/main/remote.ts'), import('../src/main/queue.ts'), import('../tests/fixtures/ftp-server.ts'), import('../src/main/storage.ts'),
]);

class JsonMemoryStore implements KeyValueStore {
  values = new Map<string, string>(); writes = 0; serializedBytes = 0; serializationMs = 0;
  get<T>(key: string, fallback: T): T { const saved = this.values.get(key); return saved === undefined ? fallback : JSON.parse(saved); }
  set<T>(key: string, value: T): void {
    const started = performance.now(), serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('Wachtrijopslag bevat een niet-serialiseerbare waarde.');
    this.serializationMs += performance.now() - started;
    this.writes++; this.serializedBytes += Buffer.byteLength(serialized); this.values.set(key, serialized);
  }
  delete(key: string): void { this.values.delete(key); }
  close(): void {}
}
class MeasuredSqliteStore implements KeyValueStore {
  private inner: InstanceType<typeof SqliteStore>;
  readonly queue: QueuePersistence;
  writes = 0; serializedBytes = 0; serializationMs = 0; commitMs = 0;
  constructor(filename: string) {
    this.inner = new SqliteStore(filename);
    this.queue = {
      load: () => this.inner.queue.load(),
      commit: (upserts, removed) => {
        if (upserts.length || removed.length) {
          // Counting serializes only the changed records once more; measured
          // runtime includes this instrumentation overhead, separately reported.
          const countStarted = performance.now();
          this.serializedBytes += upserts.reduce((bytes, record) => bytes + Buffer.byteLength(JSON.stringify(record)), 0);
          this.serializationMs += performance.now() - countStarted;
          const started = performance.now();
          this.inner.queue.commit(upserts, removed);
          this.commitMs += performance.now() - started; this.writes++;
        } else this.inner.queue.commit(upserts, removed);
      },
    };
  }
  get<T>(key: string, fallback: T): T { return this.inner.get(key, fallback); }
  set<T>(key: string, value: T): void { this.inner.set(key, value); }
  delete(key: string): void { this.inner.delete(key); }
  close(): void { this.inner.close(); }
}
type Scenario = typeof scenarios[number];
type Direction = typeof directions[number];
function percentile(samples: number[], fraction: number): number | null {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}
function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }

async function benchmark(scenario: Scenario, parallel: number, direction: Direction) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-studio-benchmark-'));
  const localRoot = path.join(directory, 'local'); await fs.mkdir(localRoot);
  const server = await ftpFixture({ controlNoDelay: values['control-no-delay'], supportsMlst: values.mlst }); server.directories.add('/payload');
  const profile: ConnectionProfile = { id: 'benchmark-loopback', name: 'Loopback-benchmark', host: '127.0.0.1', port: server.port,
    protocol: 'ftp', username: 'benchmark', localRoot, remoteRoot: '/payload', timeoutMs: 15000,
    parallelTransfers: parallel, connectionLimit: parallel + 1, autoReconnect: false, passive: true };
  const stats = { sessionOpens: 0, liveSessions: 0, peakSessions: 0, activeTransfers: 0, peakTransfers: 0, operations: {} as Record<string, number> };
  const remote = new RemoteManager(() => ({ password: 'local-benchmark-only' }), () => {}, undefined, async (config, credentials) => {
    stats.sessionOpens++; stats.liveSessions++; stats.peakSessions = Math.max(stats.peakSessions, stats.liveSessions);
    let session: RemoteSession;
    try { session = await createProtocolSession(config, credentials); } catch (error) { stats.liveSessions--; throw error; }
    let closed = false;
    return new Proxy(session, { get(target, key) {
      const method = Reflect.get(target, key);
      if (typeof method !== 'function') return method;
      if (key === 'close') return async () => { if (closed) return; closed = true; try { await target.close(); } finally { stats.liveSessions--; } };
      return async (...args: unknown[]) => {
        stats.operations[String(key)] = (stats.operations[String(key)] ?? 0) + 1;
        const transfer = key === 'upload' || key === 'download';
        if (transfer) { stats.activeTransfers++; stats.peakTransfers = Math.max(stats.peakTransfers, stats.activeTransfers); }
        try { return await method.apply(target, args); } finally { if (transfer) stats.activeTransfers--; }
      };
    } });
  });
  const store = values.store === 'sqlite' ? new MeasuredSqliteStore(path.join(directory, 'queue.db')) : new JsonMemoryStore();
  let resolveComplete!: () => void;
  const complete = new Promise<void>(resolve => { resolveComplete = resolve; });
  let notifications = 0;
  const queue = new TransferQueue(remote, store, () => {}, jobs => {
    notifications++;
    if (jobs.length === scenario.count && jobs.every(job => ['completed', 'failed', 'conflict', 'cancelled'].includes(job.status))) resolveComplete();
  });
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let memoryTimer: ReturnType<typeof setInterval> | undefined;
  let navigationTimer: ReturnType<typeof setInterval> | undefined;
  let pendingNavigation: Promise<void> | undefined;
  const navigationSamples: number[] = [], navigationErrors: string[] = [];
  const delays = monitorEventLoopDelay({ resolution: 20 });
  try {
    const expected = new Map<string, string>(), requests: TransferRequest[] = [];
    // Dataset setup is intentionally outside the measured interval and bounds open file handles.
    for (let index = 0; index < scenario.count; index++) {
      const name = `bestand-${String(index).padStart(5, '0')}.bin`;
      const bytes = Buffer.alloc(scenario.bytes, index % 251);
      bytes.write(name.slice(0, Math.min(name.length, bytes.length)), 0, 'ascii');
      const remotePath = `/payload/${name}`, localPath = path.join(localRoot, name);
      expected.set(name, digest(bytes));
      if (direction === 'upload') await fs.writeFile(localPath, bytes); else server.files.set(remotePath, bytes);
      requests.push({ connectionId: profile.id, direction, localPath, remotePath, priority: 10 });
    }
    await remote.connect(profile);
    const probeNavigation = () => {
      if (pendingNavigation) return;
      pendingNavigation = (async () => {
        const started = performance.now(); let lease;
        try { lease = await remote.acquire(profile.id, 'navigation'); await lease.session.list('/payload'); navigationSamples.push(performance.now() - started); }
        catch (error) { navigationErrors.push(error instanceof Error ? error.message : String(error)); }
        finally { try { await lease?.release(); } catch (error) { navigationErrors.push(error instanceof Error ? error.message : String(error)); } }
      })().finally(() => { pendingNavigation = undefined; });
    };
    const beforeCpu = process.cpuUsage(), beforeUtilization = performance.eventLoopUtilization();
    const baselineRss = process.memoryUsage().rss; let peakRss = baselineRss;
    delays.enable();
    memoryTimer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 25);
    navigationTimer = setInterval(probeNavigation, 500);
    const started = performance.now();
    const expiry = new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error(`Scenario overschrijdt ${timeoutMs} ms.`)), timeoutMs); });
    const jobs = await Promise.race([queue.enqueue(requests), expiry]);
    const enqueueMs = performance.now() - started;
    if (jobs.length !== scenario.count) throw new Error(`Onverwacht aantal jobs: ${jobs.length}/${scenario.count}.`);
    await Promise.race([complete, expiry]);
    await queue.close();
    const totalMs = performance.now() - started, cpu = process.cpuUsage(beforeCpu);
    const utilization = performance.eventLoopUtilization(beforeUtilization);
    clearTimeout(watchdog); watchdog = undefined;
    clearInterval(navigationTimer); navigationTimer = undefined;
    clearInterval(memoryTimer); memoryTimer = undefined;
    peakRss = Math.max(peakRss, process.memoryUsage().rss); delays.disable();
    await pendingNavigation;
    const failed = queue.jobs().filter(job => job.status !== 'completed');
    if (failed.length) throw new Error(`${failed.length} overdrachten mislukt: ${failed.slice(0, 3).map(job => job.error).join('; ')}`);
    if (navigationErrors.length) throw new Error(`Navigatieproef mislukt: ${navigationErrors[0]}`);
    // Verify every output byte through SHA-256 outside the timed interval.
    for (const request of requests) {
      const bytes = direction === 'upload' ? server.files.get(request.remotePath) : await fs.readFile(request.localPath);
      if (!bytes || digest(bytes) !== expected.get(path.basename(request.localPath))) throw new Error(`Inhoudscontrole mislukt: ${request.localPath}`);
    }
    if ([...server.files.keys()].some(name => name.includes('.ftp-studio-'))) throw new Error('Tijdelijke serverbestanden zijn na succes achtergebleven.');
    if (stats.peakTransfers > parallel || stats.peakSessions > profile.connectionLimit) throw new Error('Gemeten paralleliteit overschrijdt de ingestelde limiet.');
    const bytes = scenario.count * scenario.bytes;
    return { scenario: scenario.name, direction, parallel, controlNoDelay: !!values['control-no-delay'], mlst: !!values.mlst, store: values.store, files: scenario.count, fileBytes: scenario.bytes, bytes,
      enqueueMs, transferMs: totalMs - enqueueMs, totalMs, filesPerSecond: scenario.count / (totalMs / 1000), mebibytesPerSecond: bytes / 1048576 / (totalMs / 1000),
      cpuMs: (cpu.user + cpu.system) / 1000, eventLoopUtilization: utilization.utilization,
      eventLoopDelayP99Ms: delays.percentile(99) / 1e6, eventLoopDelayMaxMs: delays.max / 1e6,
      baselineRssBytes: baselineRss, peakRssBytes: peakRss, queueNotifications: notifications,
      persistence: { backend: values.store, writes: store.writes, serializedBytes: store.serializedBytes, serializationMs: store.serializationMs, ...(store instanceof MeasuredSqliteStore ? { commitMs: store.commitMs } : {}) },
      navigation: { samples: navigationSamples.length, p50Ms: percentile(navigationSamples, 0.5), p95Ms: percentile(navigationSamples, 0.95), maxMs: navigationSamples.length ? Math.max(...navigationSamples) : null, errors: navigationErrors },
      protocol: { sessionOpens: stats.sessionOpens, peakSessions: stats.peakSessions, peakTransfers: stats.peakTransfers, operations: stats.operations, commands: Object.fromEntries(server.commandCounts) }, verifiedFiles: requests.length };
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (memoryTimer) clearInterval(memoryTimer);
    if (navigationTimer) clearInterval(navigationTimer);
    delays.disable();
    await queue.close(); await pendingNavigation; await remote.close(); await server.close(); store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const report = { startedAt: new Date().toISOString(), environment: { node: process.version, platform: process.platform, release: os.release(), architecture: process.arch, logicalCpus: os.cpus().length },
  limitations: ['Alle verbindingen lopen via TCP naar 127.0.0.1; geen internetmeting.', 'FTP-serverdata staan in RAM; lokale staging gebruikt echte tijdelijke bestanden.', values.store === 'sqlite' ? 'Echte SQLite WAL/FULL-transacties; volume-instrumentatie serialiseert gewijzigde records één extra keer.' : 'Wachtrijopslag serialiseert JSON in geheugen; SQLite- en opslag-fsynckosten zijn niet inbegrepen.', 'Geen TLS/SSH-overhead, Windows-validatie of productieservercompatibiliteitsclaim.', 'Per scenario één gemeten run; geen statistische betrouwbaarheidsintervallen.', 'Gedeelde ontwikkelhost: andere processen kunnen de metingen beïnvloeden; geen optimaal productieprofiel afgeleid.', 'FTP-control-TCP_NODELAY is een expliciete fixture-instelling; resultaten meten mede lokale roundtrip- en delayed-ACK-effecten. TCP_NODELAY verandert uitsluitend de testserver, niet de productieclient.'],
  configuration: { controlNoDelay: !!values['control-no-delay'], mlst: !!values.mlst, store: values.store, scenario: values.scenario, directions, parallelisms, datasets: scenarios, timeoutMs },
  quick: !!values.quick, results: [] as Awaited<ReturnType<typeof benchmark>>[], error: undefined as string | undefined };
console.log('Loopback FTP-benchmark: echte TCP, tijdelijke lokale bestanden, alle uitvoerbestanden gecontroleerd met SHA-256.');
console.log(`Fixture control TCP_NODELAY: ${values['control-no-delay'] ? 'aan' : 'uit (oorspronkelijk gedrag)'}. Dataset: ${values.scenario}. Eén run per geval op een gedeelde ontwikkelhost; geen productie-optimum.`);
console.log(`Metadata MLST: ${!!values.mlst}; opslag: ${values.store}.`);
if (values.quick) console.log('Rooktestmodus: dit is geen benchmark met 1.000 bestanden.');
await fs.mkdir(path.dirname(output), { recursive: true });
try {
  for (const scenario of scenarios) for (const direction of directions) for (const parallel of parallelisms) {
    console.log(`Start: ${scenario.name}, ${direction}, ${parallel} parallel, ${scenario.count} bestanden × ${scenario.bytes} bytes.`);
    const result = await benchmark(scenario, parallel, direction); report.results.push(result);
    await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(`Voltooid: ${(result.totalMs / 1000).toFixed(2)} s; ${result.filesPerSecond.toFixed(1)} bestanden/s; inplannen ${(result.enqueueMs / 1000).toFixed(2)} s; ${result.protocol.sessionOpens} sessies.`);
  }
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.error(`Benchmark afgebroken: ${report.error}`); process.exitCode = 1;
} finally { console.log(`Resultaat: ${output}`); }
