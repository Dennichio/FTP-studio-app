import { test, expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ftpFixture } from '../fixtures/ftp-server';

let application: ElectronApplication, page: Page, root: string, site: string;
let server: Awaited<ReturnType<typeof ftpFixture>>;
const exactBytes = Buffer.from([0, 255, 13, 10, 60, 63, 112, 104, 112, 32, 195, 171, 0, 128]);
const existingBytes = Buffer.from('Oorspronkelijke bron blijft behouden');
const destinationBytes = Buffer.from('Bestaand doel mag nooit verdwijnen');
const dirtyBytes = Buffer.from('Werkelijk geopend serverbestand\r\n');

test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-remote-files-ui-'));
  site = path.join(root, 'site');
  await fs.mkdir(site);
  server = await ftpFixture({ supportsMlst: true });
  for (const directory of ['/site', '/site/destination', '/site/bundle', '/site/bundle/nested', '/site/node_modules', '/outside']) server.directories.add(directory);
  for (const [filename, bytes] of [
    ['/site/source.bin', exactBytes], ['/site/existing.txt', existingBytes], ['/site/destination/existing.txt', destinationBytes],
    ['/site/move.txt', Buffer.from('Verplaatsen zonder bronverlies')], ['/site/dirty.txt', dirtyBytes],
    ['/site/bundle/nested/child.txt', Buffer.from('Geneste inhoud blijft exact')],
    ['/site/.env', Buffer.from('TEST_SECRET=lokale-testfixture')], ['/site/blocked.txt', Buffer.from('Projectfilter')],
    ['/site/node_modules/package.txt', Buffer.from('Standaarduitsluiting')],
  ] as const) server.files.set(filename, bytes);
  application = await electron.launch({ executablePath: createRequire(path.resolve('package.json'))('electron') as string, args: [path.resolve('.')], env: { ...process.env, FTP_STUDIO_DATA_DIR: path.join(root, 'data') } });
  page = await application.firstWindow();
  await page.waitForSelector('.studio');
  await page.evaluate(async ({ localRoot, port }) => {
    const profile = { id: 'remote-files-server', name: 'Serverbestanden test', host: '127.0.0.1', port, protocol: 'ftp' as const, username: 'test', localRoot, remoteRoot: '/site', timeoutMs: 5000, connectionLimit: 5, parallelTransfers: 4, autoReconnect: false, passive: true };
    await window.ftp.invoke('saveProject', { project: { id: 'remote-files-project', name: 'Serverbestanden', profileId: profile.id, localRoot, remoteRoot: '/site', filters: { display: [], transfer: [{ id: 'blocked-transfer', action: 'exclude', field: 'name', operator: 'equals', value: 'blocked.txt' }], sync: [] }, environments: [], bookmarks: [] } });
    const state = await window.ftp.invoke('bootstrap', undefined);
    await window.ftp.invoke('saveSettings', { settings: { ...state.settings, lastProjectId: 'remote-files-project', showHidden: true, syncNavigation: false, layout: { editorMode: 'code' } } });
    await window.ftp.invoke('connect', { profile, credentials: { password: 'test' } });
  }, { localRoot: site, port: server.port });
  await page.reload();
  await expect(remote().getByRole('listbox')).toHaveAttribute('aria-busy', 'false');
  await expect(row('/site/source.bin')).toBeVisible();
});

test.afterEach(async () => {
  if (application) {
    await application.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; }).catch(() => {});
    await application.close();
  }
  await server?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

function remote() { return page.locator('.file-pane[aria-label="Serverbestanden"]'); }
function row(filename: string) { return remote().locator(`.file-row[role="option"][data-file-path=${JSON.stringify(filename)}]`); }
// Select by the actual full-path attribute; names can legitimately repeat in
// unrelated folders and the table may virtualize rows.
async function visibleRow(filename: string) {
  await expect(remote().getByRole('listbox')).toHaveAttribute('aria-busy', 'false');
  await remote().getByRole('textbox', { name: 'Bestanden filteren', exact: true }).fill(path.posix.basename(filename));
  const entry = row(filename);
  await expect(entry).toBeVisible();
  return entry;
}
async function clearNotice() {
  const close = page.locator('.toast').getByRole('button', { name: 'Melding sluiten', exact: true });
  if (await close.count()) await close.click();
}
async function createFile(name: string) {
  await clearNotice();
  await remote().getByRole('button', { name: 'Nieuw bestand', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Nieuw bestand', exact: true });
  await dialog.getByLabel('Waarde', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: 'Bevestigen', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
async function startAction(filename: string, action: 'copy' | 'move') {
  await clearNotice();
  await (await visibleRow(filename)).click({ button: 'right' });
  await remote().locator('.context-menu').getByRole('button', { name: action === 'copy' ? 'Kopiëren naar…' : 'Verplaatsen naar…', exact: true }).click();
}
async function actionTo(filename: string, action: 'copy' | 'move', destination: string) {
  await startAction(filename, action);
  const dialog = page.getByRole('dialog', { name: action === 'copy' ? 'Serverbestanden kopiëren' : 'Serveritems verplaatsen', exact: true });
  await expect(dialog).toContainText('Bestaande doelbestanden worden niet vervangen.');
  await dialog.getByLabel('Waarde', { exact: true }).fill(destination);
  await dialog.getByRole('button', { name: 'Bevestigen', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
async function navigateRemote(filename: string) {
  await remote().getByRole('textbox', { name: 'Bestanden filteren', exact: true }).fill('');
  await remote().getByLabel('Serverpad', { exact: true }).fill(filename);
  await remote().getByLabel('Serverpad', { exact: true }).press('Enter');
  await expect(remote().getByRole('listbox')).toHaveAttribute('aria-busy', 'false');
}
async function queue() { return page.evaluate(async () => (await window.ftp.invoke('bootstrap', undefined)).queue); }
async function completed(filename: string) {
  await expect.poll(async () => (await queue()).find(job => job.remotePath === filename)?.status).toBe('completed');
  await expect(page.locator('.queue-panel .job-row').filter({ hasText: filename }).locator('.job-status')).toHaveText('Voltooid');
}
function writeCommands() { return { stor: server.commandCounts.get('STOR') ?? 0, rename: server.commandCounts.get('RNTO') ?? 0, delete: server.commandCounts.get('DELE') ?? 0 }; }

test('remote Nieuw bestand creates an empty queued upload and refuses an existing target without loss', async () => {
  await createFile('new-empty.txt');
  await completed('/site/new-empty.txt');
  expect(server.files.get('/site/new-empty.txt')).toEqual(Buffer.alloc(0));
  expect((await queue()).find(job => job.remotePath === '/site/new-empty.txt')).toMatchObject({ direction: 'upload', expectedRemote: null, size: 0, transferred: 0, status: 'completed' });
  const writes = writeCommands(), jobs = (await queue()).length;
  await createFile('existing.txt');
  await expect(page.locator('.toast')).toContainText(/bestaat al/i);
  expect(server.files.get('/site/existing.txt')).toEqual(existingBytes);
  expect((await queue()).length).toBe(jobs);
  expect(writeCommands()).toEqual(writes);
});

test('remote file copy queues exact binary bytes and never clobbers an existing destination', async () => {
  await actionTo('/site/source.bin', 'copy', '/site/destination');
  await completed('/site/destination/source.bin');
  expect(server.files.get('/site/source.bin')).toEqual(exactBytes);
  expect(server.files.get('/site/destination/source.bin')).toEqual(exactBytes);
  const writes = writeCommands(), jobs = (await queue()).length;
  await actionTo('/site/source.bin', 'copy', '/site/destination');
  await expect(page.locator('.toast')).toContainText(/bestaat al/i);
  expect(server.files.get('/site/source.bin')).toEqual(exactBytes);
  expect(server.files.get('/site/destination/source.bin')).toEqual(exactBytes);
  expect((await queue()).length).toBe(jobs);
  expect(writeCommands()).toEqual(writes);
  await actionTo('/site/existing.txt', 'copy', '/site/destination');
  await expect(page.locator('.toast')).toContainText(/bestaat al/i);
  expect(server.files.get('/site/existing.txt')).toEqual(existingBytes);
  expect(server.files.get('/site/destination/existing.txt')).toEqual(destinationBytes);
  expect((await queue()).length).toBe(jobs);
});

test('remote copy refuses sensitive paths, standard exclusions and project transfer exclusions', async () => {
  const writes = writeCommands();
  for (const filename of ['/site/.env', '/site/blocked.txt']) {
    const bytes = Buffer.from(server.files.get(filename)!);
    await actionTo(filename, 'copy', '/site/destination');
    await expect(page.locator('.toast')).toContainText(/gevoelig|uitgesloten|filter/i);
    expect(server.files.get(filename)).toEqual(bytes);
    expect(server.files.has('/site/destination/' + path.posix.basename(filename))).toBe(false);
  }
  await navigateRemote('/site/node_modules');
  await actionTo('/site/node_modules/package.txt', 'copy', '/site/destination');
  await expect(page.locator('.toast')).toContainText(/gevoelig|uitgesloten|filter/i);
  expect(server.files.get('/site/node_modules/package.txt')).toEqual(Buffer.from('Standaarduitsluiting'));
  expect(server.files.has('/site/destination/package.txt')).toBe(false);
  expect(await queue()).toEqual([]);
  expect(writeCommands()).toEqual(writes);
});

test('remote moves preserve files and folder descendants and reject outside-root or occupied targets', async () => {
  await actionTo('/site/move.txt', 'move', '/site/destination');
  await expect.poll(() => server.files.has('/site/move.txt')).toBe(false);
  await expect(row('/site/move.txt')).toHaveCount(0);
  await expect(remote().getByRole('listbox')).toHaveAttribute('aria-busy', 'false');
  expect(server.files.get('/site/destination/move.txt')).toEqual(Buffer.from('Verplaatsen zonder bronverlies'));
  await actionTo('/site/bundle', 'move', '/site/destination');
  await expect.poll(() => server.directories.has('/site/bundle')).toBe(false);
  await expect(row('/site/bundle')).toHaveCount(0);
  await expect(remote().getByRole('listbox')).toHaveAttribute('aria-busy', 'false');
  expect(server.directories.has('/site/destination/bundle')).toBe(true);
  expect(server.directories.has('/site/destination/bundle/nested')).toBe(true);
  expect(server.files.get('/site/destination/bundle/nested/child.txt')).toEqual(Buffer.from('Geneste inhoud blijft exact'));
  expect(server.files.has('/site/bundle/nested/child.txt')).toBe(false);
  const writes = writeCommands();
  await actionTo('/site/existing.txt', 'move', '/site/destination');
  await expect(page.locator('.toast')).toContainText(/bestaat al/i);
  expect(server.files.get('/site/existing.txt')).toEqual(existingBytes);
  expect(server.files.get('/site/destination/existing.txt')).toEqual(destinationBytes);
  await actionTo('/site/existing.txt', 'move', '/outside');
  await expect(page.locator('.toast')).toContainText(/buiten|hoofdmap|projectmap/i);
  expect(server.files.get('/site/existing.txt')).toEqual(existingBytes);
  expect(server.files.has('/outside/existing.txt')).toBe(false);
  expect(writeCommands()).toEqual(writes);
});

test('a dirty remote Monaco buffer blocks file moves and an open descendant blocks folder moves', async () => {
  await (await visibleRow('/site/dirty.txt')).dblclick();
  await expect(page.locator('.editor-tab.active')).toContainText('dirty.txt');
  const code = page.getByRole('textbox', { name: 'Broncode', exact: true });
  await code.focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('Niet-opgeslagen echte edit');
  await expect(page.locator('.editor-tab.active .tab-close')).toHaveClass(/dirty/);
  const writes = writeCommands();
  await startAction('/site/dirty.txt', 'move');
  await expect(page.locator('.toast')).toContainText('Sla de geopende bestanden op voordat u ze verplaatst.');
  await expect(page.getByRole('dialog', { name: 'Serveritems verplaatsen', exact: true })).toHaveCount(0);
  expect(server.files.get('/site/dirty.txt')).toEqual(dirtyBytes);
  expect(server.files.has('/site/destination/dirty.txt')).toBe(false);
  await expect(page.locator('.editor-tab.active .tab-close')).toHaveClass(/dirty/);
  expect(writeCommands()).toEqual(writes);

  await navigateRemote('/site/bundle/nested');
  await (await visibleRow('/site/bundle/nested/child.txt')).dblclick();
  await expect(page.locator('.editor-tab.active')).toContainText('child.txt');
  await navigateRemote('/site');
  await startAction('/site/bundle', 'move');
  await expect(page.locator('.toast')).toContainText('Sluit geopende bestanden in deze mappen voordat u ze verplaatst.');
  await expect(page.getByRole('dialog', { name: 'Serveritems verplaatsen', exact: true })).toHaveCount(0);
  expect(server.directories.has('/site/bundle')).toBe(true);
  expect(server.files.get('/site/bundle/nested/child.txt')).toEqual(Buffer.from('Geneste inhoud blijft exact'));
  expect(writeCommands()).toEqual(writes);
});

test('edits made while a completed server move or rename awaits its response keep the original dirty buffer and recovery', async () => {
  for (const scenario of [
    { action: 'move', source: '/site/dirty.txt', target: '/site/destination/dirty.txt', bytes: dirtyBytes },
    { action: 'rename', source: '/site/move.txt', target: '/site/renamed.txt', bytes: Buffer.from('Verplaatsen zonder bronverlies') },
  ] as const) {
    await (await visibleRow(scenario.source)).dblclick();
    const activeTab = page.locator('.editor-tab.active');
    await expect(activeTab).toContainText(path.posix.basename(scenario.source));
    await expect(activeTab.locator('.tab-close')).not.toHaveClass(/dirty/);
    const oldEditorPath = await activeTab.getAttribute('title');
    const renames = server.commandCounts.get('RNTO') ?? 0;
    // Await the original IPC handler first: FTP rename, service validation and
    // logging all complete normally. Only its response to the renderer waits.
    await application.evaluate(({ ipcMain }, source) => {
      const main = ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> };
      const original = main._invokeHandlers.get('studio:invoke')!;
      let release!: () => void;
      const heldResponse = new Promise<void>(resolve => { release = resolve; });
      const timing = { held: false, release: () => {
        ipcMain.removeHandler('studio:invoke');
        ipcMain.handle('studio:invoke', original);
        release();
      } };
      (globalThis as unknown as { pendingRemotePathChange: typeof timing }).pendingRemotePathChange = timing;
      ipcMain.removeHandler('studio:invoke');
      ipcMain.handle('studio:invoke', async (event, command, args) => {
        const result = await original(event, command, args);
        if (command === 'mutateRemote' && args?.operation === 'rename' && args.path === source) {
          timing.held = true;
          await heldResponse;
        }
        return result;
      });
    }, scenario.source);
    if (scenario.action === 'move') await actionTo(scenario.source, 'move', '/site/destination');
    else {
      await clearNotice();
      await (await visibleRow(scenario.source)).click({ button: 'right' });
      await remote().locator('.context-menu').getByRole('button', { name: 'Naam wijzigen', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Naam wijzigen', exact: true });
      await dialog.getByLabel('Waarde', { exact: true }).fill(path.posix.basename(scenario.target));
      await dialog.getByRole('button', { name: 'Bevestigen', exact: true }).click();
      await expect(dialog).toHaveCount(0);
    }
    await expect.poll(() => application.evaluate(() => (globalThis as unknown as { pendingRemotePathChange: { held: boolean } }).pendingRemotePathChange.held)).toBe(true);
    expect(server.files.has(scenario.source)).toBe(false);
    expect(server.files.get(scenario.target)).toEqual(scenario.bytes);
    expect(server.commandCounts.get('RNTO')).toBe(renames + 1);

    const addition = `Echte edit tijdens ${scenario.action}`;
    const code = page.getByRole('textbox', { name: 'Broncode', exact: true });
    await code.focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText(addition);
    await expect(activeTab.locator('.tab-close')).toHaveClass(/dirty/);
    const expectedContent = scenario.bytes.toString('utf8') + addition;
    const recovery = () => page.evaluate(async source => (await window.ftp.invoke('bootstrap', undefined)).recoveries.find(document => document.remote?.path === source), scenario.source);
    // Wait for the actual automatic recovery write before releasing the rename
    // response, so a misplaced discardRecovery would be observable afterwards.
    await expect.poll(async () => (await recovery())?.content).toBe(expectedContent);
    const before = await recovery();
    expect(before?.remote?.path).toBe(scenario.source);
    await application.evaluate(() => (globalThis as unknown as { pendingRemotePathChange: { release: () => void } }).pendingRemotePathChange.release());
    await expect(page.locator('.toast')).toContainText('Nieuwere editorwijzigingen blijven open onder het oude pad');
    await expect(activeTab).toHaveAttribute('title', oldEditorPath!);
    await expect(activeTab.locator('.tab-close')).toHaveClass(/dirty/);
    await expect(page.locator('.monaco-editor .view-lines')).toContainText(addition);
    await expect(row(scenario.source)).toHaveCount(0);
    const retained = await recovery();
    expect(retained).toMatchObject({ id: before!.id, content: expectedContent, remote: { path: scenario.source } });
    expect(server.files.get(scenario.target)).toEqual(scenario.bytes);
    expect(server.files.has(scenario.source)).toBe(false);
    expect(await queue()).toEqual([]);
  }
});
