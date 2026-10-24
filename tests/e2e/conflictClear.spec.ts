import { test, expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { SqliteStore } from '../../src/main/storage';
import type { AppSettings, ConnectionProfile, PersistedQueueRecord, TransferJob } from '../../src/shared/contracts';
import { ftpFixture } from '../fixtures/ftp-server';

let application: ElectronApplication, page: Page, root: string, localRoot: string;
let server: Awaited<ReturnType<typeof ftpFixture>>;
let records: PersistedQueueRecord[];
const original = Buffer.from('Oorspronkelijke herstelbron\r\n');
const staged = Buffer.from([0, 255, 13, 10, 128, 0, 60, 63]);

test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-conflict-clear-'));
  localRoot = path.join(root, 'site');
  await fs.mkdir(localRoot);
  server = await ftpFixture({ supportsMlst: true });
  const profile: ConnectionProfile = { id: 'conflict-server', name: 'Conflictherstel', host: '127.0.0.1', port: server.port, protocol: 'ftp', username: 'test', localRoot, remoteRoot: '/', timeoutMs: 10000, connectionLimit: 2, parallelTransfers: 1, autoReconnect: false, passive: true };
  const record = (id: string, status: TransferJob['status'], direction: 'upload' | 'download' = 'download'): PersistedQueueRecord => ({ kind: 'file', job: {
    id, connectionId: profile.id, direction, localPath: path.join(localRoot, `${id}.bin`), remotePath: `/${id}.bin`,
    status, size: staged.length, transferred: 0, speed: 0, remainingSeconds: null, attempts: 1, createdAt: 1, priority: 50,
    error: status === 'conflict' ? 'Bestandswissel vereist handmatige controle; herstelbestanden blijven bewaard.' : undefined,
  } });
  const localTransaction = record('row-local-transaction', 'conflict');
  localTransaction.transaction = { stage: path.join(localRoot, '.local.ftp-studio-recovery.part'), backup: path.join(localRoot, '.local.ftp-studio-recovery.part.backup'), phase: 'backed-up' };
  await fs.writeFile(localTransaction.transaction.stage, staged);
  await fs.writeFile(localTransaction.transaction.backup!, original);
  const remoteTransaction = record('bulk-remote-transaction', 'conflict', 'upload');
  remoteTransaction.transaction = { stage: '/.remote.ftp-studio-recovery.part', backup: '/.remote.ftp-studio-recovery.part.backup', phase: 'installed' };
  server.files.set(remoteTransaction.transaction.stage, staged);
  server.files.set(remoteTransaction.transaction.backup!, original);
  server.files.set(remoteTransaction.job.remotePath, staged);
  await fs.writeFile(remoteTransaction.job.localPath, original);
  server.files.set('/visible-source.txt', original);
  records = [record('row-plain-conflict', 'conflict'), localTransaction, remoteTransaction, record('bulk-completed', 'completed'), record('bulk-failed', 'failed'), record('bulk-cancelled', 'cancelled'), record('keep-paused', 'paused')];
  // Durable crash/recovery records are seeded through the real SQLite store.
  // Neither IPC handlers, renderer events, nor transfer implementations change.
  const store = new SqliteStore(database());
  try {
    store.queue.commit(records, []);
    store.set('profiles', [profile]);
    const settings: AppSettings = { theme: 'dark', showHidden: false, syncNavigation: false, editorFontSize: 14, wordWrap: true, autoUpload: false, layout: { editorMode: 'code', queueExpanded: true, queueHeight: 250 } };
    store.set('settings', settings);
  } finally { store.close(); }
  await launch();
});

test.afterEach(async () => {
  await application?.close();
  await server?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

function database() { return path.join(root, 'data', 'studio.db'); }
function panel() { return page.locator('.queue-panel'); }
async function jobs() { return page.evaluate(async () => (await window.ftp.invoke('bootstrap', undefined)).queue); }
async function launch() {
  application = await electron.launch({ executablePath: createRequire(path.resolve('package.json'))('electron') as string, args: [path.resolve('.')], env: { ...process.env, FTP_STUDIO_DATA_DIR: path.join(root, 'data') } });
  page = await application.firstWindow();
  await page.waitForSelector('.studio');
  await page.getByRole('combobox', { name: 'Snelverbinden met opgeslagen verbinding', exact: true }).selectOption('conflict-server');
  await page.getByRole('button', { name: 'Verbinden', exact: true }).click();
  await expect(page.locator('.file-pane[aria-label="Serverbestanden"] .file-row[role="option"][data-file-path="/visible-source.txt"]')).toBeVisible();
}
async function assertRecoveryArtifacts() {
  const local = records.find(record => record.job.id === 'row-local-transaction')!;
  const remote = records.find(record => record.job.id === 'bulk-remote-transaction')!;
  expect(await fs.readFile(local.transaction!.stage)).toEqual(staged);
  expect(await fs.readFile(local.transaction!.backup!)).toEqual(original);
  expect(await fs.readFile(remote.job.localPath)).toEqual(original);
  expect(server.files.get(remote.transaction!.stage)).toEqual(staged);
  expect(server.files.get(remote.transaction!.backup!)).toEqual(original);
  expect(server.files.get(remote.job.remotePath)).toEqual(staged);
  for (const command of ['RETR', 'STOR', 'APPE', 'DELE', 'RNFR', 'RNTO']) expect(server.commandCounts.get(command) ?? 0).toBe(0);
}

test('row removal and bulk clear persist across restart while retaining transaction recovery files and paused work', async () => {
  expect(await jobs()).toHaveLength(7);
  const search = panel().getByRole('textbox', { name: 'Wachtrij of log doorzoeken', exact: true });
  for (const id of ['row-plain-conflict', 'row-local-transaction']) {
    await search.fill(id);
    const row = panel().locator(`[data-job-id="${id}"]`);
    await expect(row.locator('.job-status')).toHaveText('Conflict');
    await row.getByRole('button', { name: 'Uit wachtrij verwijderen', exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect.poll(async () => (await jobs()).some(job => job.id === id)).toBe(false);
  }
  await assertRecoveryArtifacts();
  await search.fill('');
  await expect(panel().locator('.queue-filter')).toContainText('5 overdrachten');
  await panel().getByRole('button', { name: 'Afgeronde overdrachten wissen', exact: true }).click();
  await expect.poll(async () => (await jobs()).map(job => job.id)).toEqual(['keep-paused']);
  await expect(panel().locator('.queue-filter')).toContainText('1 overdrachten');
  await assertRecoveryArtifacts();

  await application.close();
  const store = new SqliteStore(database());
  try {
    const durable = store.queue.load();
    expect(durable.map(record => record.job.id).sort()).toEqual(['bulk-remote-transaction', 'keep-paused', 'row-local-transaction']);
    for (const id of ['row-local-transaction', 'bulk-remote-transaction']) {
      const archived = durable.find(record => record.job.id === id)!;
      expect(archived.archived).toBe(true);
      expect(archived.transaction).toEqual(records.find(record => record.job.id === id)!.transaction);
    }
  } finally { store.close(); }

  await launch();
  expect((await jobs()).map(job => job.id)).toEqual(['keep-paused']);
  await expect(panel().locator('[data-job-id="keep-paused"] .job-status')).toHaveText('Gepauzeerd');
  await expect(panel().getByRole('button', { name: 'Uit wachtrij verwijderen', exact: true })).toHaveCount(0);
  await assertRecoveryArtifacts();
});
