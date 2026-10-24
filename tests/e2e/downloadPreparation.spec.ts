import { test, expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ftpFixture } from '../fixtures/ftp-server';

let application: ElectronApplication, page: Page, root: string, localRoot: string;
let server: Awaited<ReturnType<typeof ftpFixture>>;
let holdListing: ((directory: string) => Promise<void>) | undefined;
let releaseListing: (() => void) | undefined;
const binaryBytes = Buffer.from([0, 255, 13, 10, 195, 171, 128, 0, 60, 63, 112, 104, 112]);
const textBytes = Buffer.from('Echte recursieve download\r\n');

test.beforeEach(async () => {
  holdListing = undefined;
  releaseListing = undefined;
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-download-preparation-'));
  localRoot = path.join(root, 'downloads');
  await fs.mkdir(localRoot);
  server = await ftpFixture({ supportsMlst: true, beforeList: async directory => { await holdListing?.(directory); } });
  for (const directory of ['/bundle', '/bundle/nested', '/backup']) server.directories.add(directory);
  server.files.set('/bundle/readme.txt', textBytes);
  server.files.set('/bundle/nested/source.bin', binaryBytes);
  server.files.set('/single.bin', binaryBytes);
  server.files.set('/backup/excluded.txt', Buffer.from('Standaard uitgesloten map'));
  application = await electron.launch({ executablePath: createRequire(path.resolve('package.json'))('electron') as string, args: [path.resolve('.')], env: { ...process.env, FTP_STUDIO_DATA_DIR: path.join(root, 'data') } });
  page = await application.firstWindow();
  await page.waitForSelector('.studio');
  // A saved connection supplies a local root without creating or activating a project.
  await page.evaluate(async ({ localRoot, port }) => {
    await window.ftp.invoke('saveProfile', { profile: { id: 'download-server', name: 'Downloadtest', host: '127.0.0.1', port, protocol: 'ftp', username: 'test', localRoot, remoteRoot: '/', timeoutMs: 30000, connectionLimit: 3, parallelTransfers: 2, autoReconnect: false, passive: true } });
    const state = await window.ftp.invoke('bootstrap', undefined);
    await window.ftp.invoke('saveSettings', { settings: { ...state.settings, syncNavigation: false, layout: { editorMode: 'code', queueHidden: true } } });
  }, { localRoot, port: server.port });
  await page.reload();
  await page.waitForSelector('.studio');
  await page.getByRole('combobox', { name: 'Snelverbinden met opgeslagen verbinding', exact: true }).selectOption('download-server');
  await page.getByRole('button', { name: 'Verbinden', exact: true }).click();
  await expect(remote().getByRole('listbox')).toHaveAttribute('aria-busy', 'false');
  await expect(row('/bundle')).toBeVisible();
  await expect(page.locator('.file-pane[aria-label="Lokale bestanden"]').getByRole('listbox')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.titlebar-project')).toHaveText('Geen project geopend');
  const state = await page.evaluate(() => window.ftp.invoke('bootstrap', undefined));
  expect(state.projects).toEqual([]);
  expect(state.queue).toEqual([]);
  const close = page.locator('.toast').getByRole('button', { name: 'Melding sluiten', exact: true });
  if (await close.count()) await close.click();
});

test.afterEach(async () => {
  releaseListing?.();
  await application?.close();
  await server?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

function remote() { return page.locator('.file-pane[aria-label="Serverbestanden"]'); }
function local() { return page.locator('.file-pane[aria-label="Lokale bestanden"]'); }
function row(filename: string) { return remote().locator(`.file-row[role="option"][data-file-path=${JSON.stringify(filename)}]`); }
async function navigateLocal(directory: string) {
  const address = local().getByRole('textbox', { name: 'Lokaal pad', exact: true });
  await address.fill(directory);
  await address.press('Enter');
  await expect(local().getByRole('listbox')).toHaveAttribute('aria-busy', 'false');
  await expect(address).toHaveValue(directory);
}
function preparation() { return page.locator('.queue-panel').getByRole('status'); }
async function queue() { return page.evaluate(async () => (await window.ftp.invoke('bootstrap', undefined)).queue); }
async function downloadFromContext(filename: string) {
  await row(filename).click({ button: 'right' });
  await remote().locator('.context-menu').getByRole('button', { name: 'Downloaden naar lokaal', exact: true }).click();
}
async function completed(paths: string[]) {
  await expect.poll(async () => (await queue()).map(job => ({ remotePath: job.remotePath, direction: job.direction, status: job.status })).sort((a, b) => a.remotePath.localeCompare(b.remotePath))).toEqual(
    [...paths].sort((a, b) => a.localeCompare(b)).map(remotePath => ({ remotePath, direction: 'download', status: 'completed' })),
  );
  await expect(page.locator('.queue-panel .job-status')).toHaveText(paths.map(() => 'Voltooid'));
  await expect(preparation()).toHaveCount(0);
}

test('directory context download shows preparation before real FTP listing completes and prevents duplicates', async () => {
  let listingCount = 0;
  const listingGate = new Promise<void>(resolve => { releaseListing = resolve; });
  holdListing = async directory => {
    if (directory === '/bundle') { listingCount++; await listingGate; }
  };
  await downloadFromContext('/bundle');
  await expect.poll(() => listingCount).toBe(1);
  await expect(preparation()).toBeVisible();
  await expect(preparation()).toContainText('Download voorbereiden');
  await page.locator('.queue-panel').getByRole('button', { name: 'Paneel inklappen', exact: true }).click();
  await expect(preparation()).toBeVisible();
  await expect(preparation()).toContainText('voorbereiden');
  await page.locator('.queue-panel').getByRole('button', { name: 'Paneel uitklappen', exact: true }).click();
  await expect(preparation()).toContainText('Download voorbereiden');
  await expect(page.locator('.queue-panel .job-row')).toHaveCount(0);
  expect(await queue()).toEqual([]);
  expect(server.commandCounts.get('RETR') ?? 0).toBe(0);
  const toolbar = remote().getByRole('button', { name: 'Selectie downloaden', exact: true });
  await expect(toolbar).toBeDisabled();
  await row('/bundle').click({ button: 'right' });
  const context = remote().locator('.context-menu').getByRole('button', { name: 'Downloaden naar lokaal', exact: true });
  await expect(context).toBeDisabled();
  // Native click attempts on both disabled controls must leave the one real
  // listing and the empty queue intact until the server releases its response.
  await toolbar.evaluate((button: HTMLButtonElement) => button.click());
  await context.evaluate((button: HTMLButtonElement) => button.click());
  expect(listingCount).toBe(1);
  expect(await queue()).toEqual([]);
  await page.locator('.queue-panel').getByRole('button', { name: /^Overdrachtswachtrij/ }).click();
  releaseListing!();
  await expect(page.locator('.toast')).toContainText('2 overdrachtsopdrachten ingepland.');
  await completed(['/bundle/readme.txt', '/bundle/nested/source.bin']);
  expect(await fs.readFile(path.join(localRoot, 'bundle', 'readme.txt'))).toEqual(textBytes);
  expect(await fs.readFile(path.join(localRoot, 'bundle', 'nested', 'source.bin'))).toEqual(binaryBytes);
  expect(server.commandCounts.get('RETR')).toBe(2);
  expect(listingCount).toBe(1);
  await expect(toolbar).toBeEnabled();
});

test('single file toolbar download completes without an active project and preserves binary bytes', async () => {
  await row('/single.bin').click();
  await remote().getByRole('button', { name: 'Selectie downloaden', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('1 overdrachtsopdrachten ingepland.');
  await completed(['/single.bin']);
  expect(await fs.readFile(path.join(localRoot, 'single.bin'))).toEqual(binaryBytes);
  expect(server.commandCounts.get('RETR')).toBe(1);
  await expect(page.locator('.titlebar-project')).toHaveText('Geen project geopend');
});

test('excluded backup directory reports zero planned downloads without creating local files', async () => {
  await downloadFromContext('/backup');
  await expect(page.locator('.toast')).toContainText('Geen overdrachten ingepland');
  await expect(page.locator('.toast')).toContainText('uitgesloten');
  await expect(preparation()).toHaveCount(0);
  expect(await queue()).toEqual([]);
  expect(await fs.readdir(localRoot)).toEqual([]);
  expect(server.commandCounts.get('RETR') ?? 0).toBe(0);
  await expect(remote().getByRole('button', { name: 'Selectie downloaden', exact: true })).toBeEnabled();
});

test('manual download uses the browsed sibling directory outside the saved local root', async () => {
  const sibling = path.join(root, 'other-downloads');
  await fs.mkdir(sibling);
  await navigateLocal(sibling);
  await row('/single.bin').click();
  await remote().getByRole('button', { name: 'Selectie downloaden', exact: true }).click();
  await completed(['/single.bin']);
  expect(await fs.readFile(path.join(sibling, 'single.bin'))).toEqual(binaryBytes);
  expect(await fs.readdir(localRoot)).toEqual([]);
  const state = await page.evaluate(() => window.ftp.invoke('bootstrap', undefined));
  expect(state.queue[0].localPath).toBe(path.join(sibling, 'single.bin'));
  expect(state.profiles.find(profile => profile.id === 'download-server')?.localRoot).toBe(localRoot);
  expect(state.projects).toEqual([]);
});

test('manual upload reads the browsed sibling directory outside the saved local root', async () => {
  const sibling = path.join(root, 'other-uploads');
  await fs.mkdir(sibling);
  const source = path.join(sibling, 'outside-root.bin');
  await fs.writeFile(source, binaryBytes);
  await navigateLocal(sibling);
  const sourceRow = local().locator(`.file-row[role="option"][data-file-path=${JSON.stringify(source)}]`);
  await expect(sourceRow).toBeVisible();
  await sourceRow.click();
  await local().getByRole('button', { name: 'Selectie uploaden', exact: true }).click();
  await expect.poll(async () => (await queue()).map(job => ({ direction: job.direction, localPath: job.localPath, remotePath: job.remotePath, status: job.status }))).toEqual([
    { direction: 'upload', localPath: source, remotePath: '/outside-root.bin', status: 'completed' },
  ]);
  await expect(page.locator('.queue-panel .job-status')).toHaveText(['Voltooid']);
  expect(server.files.get('/outside-root.bin')).toEqual(binaryBytes);
  expect(await fs.readFile(source)).toEqual(binaryBytes);
  expect(await fs.readdir(localRoot)).toEqual([]);
  const state = await page.evaluate(() => window.ftp.invoke('bootstrap', undefined));
  expect(state.profiles.find(profile => profile.id === 'download-server')?.localRoot).toBe(localRoot);
  expect(state.projects).toEqual([]);
});

async function preparePhotoSelection() {
  const directory = path.join(root, 'photos');
  await fs.mkdir(directory);
  const photos = Array.from({ length: 33 }, (_, index) => ({
    name: `batch-${String(index).padStart(3, '0')}.jpg`,
    bytes: Buffer.concat([Buffer.from([255, 216, index]), binaryBytes, Buffer.from([255, 217])]),
  }));
  await Promise.all(photos.map(photo => fs.writeFile(path.join(directory, photo.name), photo.bytes)));
  await navigateLocal(directory);
  const list = local().getByRole('listbox');
  await expect(local().locator('.pane-foot')).toContainText('33 bestanden');
  await list.focus();
  await page.keyboard.press('Control+a');
  await expect(local().locator('.pane-foot')).toContainText('33 geselecteerd');
  return { directory, photos };
}

test('photo uploads start through real FTP while later batch metadata is still being prepared', async () => {
  test.setTimeout(90000);
  const { photos } = await preparePhotoSelection();
  let held = false;
  const gate = new Promise<void>(resolve => { releaseListing = resolve; });
  server.beforeStat = async target => {
    if (target === '/batch-032.jpg') { held = true; await gate; }
  };
  await local().getByRole('button', { name: 'Selectie uploaden', exact: true }).click();
  await expect.poll(() => held, { timeout: 30000 }).toBe(true);
  await expect.poll(async () => (await queue()).length).toBe(32);
  await expect(preparation()).toContainText('Upload voorbereiden');
  await expect(preparation()).toContainText('32 overdrachtsopdrachten ingepland');
  await expect.poll(() => server.files.has('/batch-000.jpg'), { timeout: 30000 }).toBe(true);
  expect(server.files.get('/batch-000.jpg')).toEqual(photos[0].bytes);
  expect(server.files.has('/batch-032.jpg')).toBe(false);
  await expect(local().getByRole('button', { name: 'Selectie uploaden', exact: true })).toBeDisabled();
  releaseListing!();
  await expect(page.locator('.toast')).toContainText('33 overdrachtsopdrachten ingepland.');
  await expect.poll(async () => (await queue()).filter(job => job.status === 'completed').length, { timeout: 45000 }).toBe(33);
  expect((await queue()).every(job => job.direction === 'upload')).toBe(true);
  for (const photo of photos) expect(server.files.get('/' + photo.name)).toEqual(photo.bytes);
  await expect(preparation()).toHaveCount(0);
});

test('a conflict in a later photo batch reports earlier planned uploads and preserves the existing server file', async () => {
  test.setTimeout(90000);
  const { directory, photos } = await preparePhotoSelection();
  const preserved = Buffer.from('Bestaande foto blijft exact bewaard');
  // Add the target after the initial listing. The actual preflight must still
  // inspect it, while earlier batches may already be transferring.
  server.files.set('/batch-032.jpg', preserved);
  let held = false;
  const gate = new Promise<void>(resolve => { releaseListing = resolve; });
  server.beforeStat = async target => {
    if (target === '/batch-032.jpg') { held = true; await gate; }
  };
  await local().getByRole('button', { name: 'Selectie uploaden', exact: true }).click();
  await expect.poll(() => held, { timeout: 30000 }).toBe(true);
  await expect.poll(async () => (await queue()).length).toBe(32);
  // A real filesystem change during preparation makes the final selected
  // source a directory; the existing remote file must block that upload.
  const changedSource = path.join(directory, 'batch-032.jpg');
  await fs.unlink(changedSource);
  await fs.mkdir(changedSource);
  releaseListing!();
  await expect(page.locator('.toast')).toContainText('32 overdrachtsopdrachten zijn al ingepland');
  await expect(page.locator('.toast')).toContainText('De resterende selectie is niet ingepland');
  await expect.poll(async () => (await queue()).filter(job => job.status === 'completed').length, { timeout: 45000 }).toBe(32);
  expect(await queue()).toHaveLength(32);
  for (const photo of photos.slice(0, 32)) expect(server.files.get('/' + photo.name)).toEqual(photo.bytes);
  expect(server.files.get('/batch-032.jpg')).toEqual(preserved);
  await expect(preparation()).toHaveCount(0);
});
