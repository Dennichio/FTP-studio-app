import { test, expect, type Locator } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ftpFixture } from '../fixtures/ftp-server';

let application: ElectronApplication, page: Page, root: string, site: string;
let server: Awaited<ReturnType<typeof ftpFixture>>;
const localOriginal = '\uFEFFOorspronkelijke schijfregel\r\nOngewijzigde middenregel\r\nLaatste regel\r\n';
const remoteOriginal = '\uFEFFOorspronkelijke serverregel\r\nOngewijzigde servermiddenregel\r\n';
const changedLocal = '\uFEFFExtern gewijzigde schijfversie\r\nOngewijzigde middenregel\r\nLaatste regel\r\n';
const changedRemote = '\uFEFFWerkelijk extern gewijzigde langere serverversie\r\nOngewijzigde servermiddenregel\r\n';

test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-diff-desktop-'));
  site = path.join(root, 'site');
  await fs.mkdir(site);
  await fs.writeFile(path.join(site, 'local.txt'), localOriginal);
  await fs.writeFile(path.join(site, 'format.txt'), '\uFEFFEerste regel\r\nTweede regel\r\n');
  server = await ftpFixture({ supportsMlst: true });
  server.directories.add('/site');
  server.files.set('/site/remote.txt', Buffer.from(remoteOriginal));
  application = await electron.launch({ executablePath: createRequire(path.resolve('package.json'))('electron') as string, args: [path.resolve('.')], env: { ...process.env, FTP_STUDIO_DATA_DIR: path.join(root, 'data') } });
  page = await application.firstWindow();
  await page.waitForSelector('.studio');
  await page.evaluate(async ({ localRoot, port }) => {
    const profile = { id: 'diff-server', name: 'Vergelijkingsserver', host: '127.0.0.1', port, protocol: 'ftp' as const, username: 'test', localRoot, remoteRoot: '/site', timeoutMs: 5000, connectionLimit: 5, parallelTransfers: 4, autoReconnect: false, passive: true };
    await window.ftp.invoke('saveProject', { project: { id: 'diff-project', name: 'Vergelijkingsproject', profileId: profile.id, localRoot, remoteRoot: '/site', filters: { display: [], transfer: [], sync: [] }, environments: [], bookmarks: [] } });
    const state = await window.ftp.invoke('bootstrap', undefined);
    await window.ftp.invoke('saveSettings', { settings: { ...state.settings, lastProjectId: 'diff-project', autoUpload: false, syncNavigation: false, layout: { editorMode: 'code' } } });
    await window.ftp.invoke('connect', { profile, credentials: { password: 'test' } });
  }, { localRoot: site, port: server.port });
  await page.reload();
  await page.waitForSelector('.studio');
});

test.afterEach(async () => {
  if (application) {
    await application.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; }).catch(() => {});
    await application.close();
  }
  await server?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function openFile(side: 'local' | 'remote', name: string) {
  const pane = page.locator(`.file-pane[aria-label="${side === 'local' ? 'Lokale bestanden' : 'Serverbestanden'}"]`);
  await expect(pane.getByRole('listbox')).toHaveAttribute('aria-busy', 'false');
  await pane.getByRole('textbox', { name: 'Bestanden filteren', exact: true }).fill(name);
  await pane.locator('.file-row[role="option"]').filter({ hasText: name }).dblclick();
  await expect(page.locator('.editor-tab.active')).toContainText(name);
  await expect(page.getByRole('textbox', { name: 'Broncode', exact: true })).toBeVisible();
}
async function append(text: string) {
  await page.getByRole('textbox', { name: 'Broncode', exact: true }).focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(text);
  await expect(page.locator('.editor-tab.active .tab-close')).toHaveClass(/dirty/);
}
async function recovery(filename: string, remote = false) {
  return page.evaluate(async ({ filename, remote }) => (await window.ftp.invoke('bootstrap', undefined)).recoveries.find(document => remote ? document.remote?.path === filename : !document.remote && document.path === filename), { filename, remote });
}
async function compare(name: string) {
  await page.getByRole('button', { name: 'Vergelijken met opgeslagen versie', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Bestand vergelijken · ${name}`, exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('status')).not.toContainText('berekenen');
  return dialog;
}
function savedLines(dialog: Locator) { return dialog.locator('.monaco-diff-editor .original .view-lines'); }
function editorLines(dialog: Locator) { return dialog.locator('.monaco-diff-editor .modified .view-lines'); }
async function closeDiff(dialog: Locator) {
  await dialog.getByRole('button', { name: 'Sluiten', exact: true }).last().click();
  await expect(dialog).toHaveCount(0);
}

async function holdFirstComparisonResponse() {
  // Preserve the actual service result. A gate controls only delivery of the
  // first completed comparison response, allowing a deterministic UI race.
  await application.evaluate(({ ipcMain }) => {
    const main = ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> };
    const original = main._invokeHandlers.get('studio:invoke')!;
    let release!: () => void;
    const response = new Promise<void>(resolve => { release = resolve; });
    const timing = { held: false, delivered: 0, release };
    (globalThis as unknown as { pendingDiffComparison: typeof timing }).pendingDiffComparison = timing;
    let first = true;
    ipcMain.removeHandler('studio:invoke');
    ipcMain.handle('studio:invoke', async (event, command, args) => {
      const hold = command === 'compareDocument' && first;
      if (hold) first = false;
      const result = await original(event, command, args);
      if (hold) { timing.held = true; await response; }
      if (command === 'compareDocument') timing.delivered++;
      return result;
    });
  });
}
async function waitHeldComparison() {
  await expect.poll(() => application.evaluate(() => (globalThis as unknown as { pendingDiffComparison: { held: boolean } }).pendingDiffComparison.held)).toBe(true);
}
async function releaseComparison() {
  await application.evaluate(() => (globalThis as unknown as { pendingDiffComparison: { release: () => void } }).pendingDiffComparison.release());
}

test('local comparison shows actual changed disk bytes beside a readonly dirty buffer and keeps stale-save protection', async () => {
  const filename = path.join(site, 'local.txt'), addition = 'EDITOR_LOCAL_UNSAVED';
  await openFile('local', 'local.txt');
  await append(addition);
  await expect.poll(async () => (await recovery(filename))?.content).toBe(localOriginal + addition);
  const before = await recovery(filename);
  await fs.writeFile(filename, changedLocal);
  const started = Date.now();
  const dialog = await compare('local.txt');
  await expect(dialog.getByText('Opgeslagen schijfversie', { exact: true })).toBeVisible();
  await expect(dialog.locator('.document-diff-headings > div').nth(0)).toContainText(`${Buffer.byteLength(changedLocal)} B`);
  await expect(savedLines(dialog)).toContainText('Extern gewijzigde schijfversie');
  await expect(editorLines(dialog)).toContainText('Oorspronkelijke schijfregel');
  await expect(editorLines(dialog)).toContainText(addition);
  await expect(dialog.locator('.document-diff-path')).toHaveText(filename);
  const checkedAt = Date.parse((await dialog.locator('time').getAttribute('datetime'))!);
  expect(checkedAt).toBeGreaterThanOrEqual(started);
  expect(checkedAt).toBeLessThanOrEqual(Date.now());
  await expect(dialog.getByRole('button', { name: 'Volgend verschil', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Volgend verschil', exact: true }).click();
  await dialog.getByRole('button', { name: 'Vorig verschil', exact: true }).click();
  const saved = dialog.getByRole('textbox', { name: /^Opgeslagen schijfversie/ });
  const editor = dialog.getByRole('textbox', { name: /^Uw editorversie/ });
  // Native EditContext exposes a textbox div rather than a textarea. Monaco
  // represents read-only state with aria-autocomplete; typing is checked below.
  await expect(saved).toHaveAttribute('aria-autocomplete', 'none');
  await expect(editor).toHaveAttribute('aria-autocomplete', 'none');
  await application.evaluate(({ clipboard }) => { clipboard.writeText('DIFF_COPY_SENTINEL'); });
  await editor.focus();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Control+C');
  await expect.poll(() => application.evaluate(({ clipboard }) => clipboard.readText())).toContain(addition);
  await page.keyboard.insertText('READONLY_MUST_NOT_APPEAR');
  await expect(editorLines(dialog)).not.toContainText('READONLY_MUST_NOT_APPEAR');
  expect(await fs.readFile(filename, 'utf8')).toBe(changedLocal);
  expect(await recovery(filename)).toMatchObject({ id: before!.id, content: localOriginal + addition, original: before!.original });
  await closeDiff(dialog);
  await expect(page.locator('.editor-tab.active .tab-close')).toHaveClass(/dirty/);
  await page.getByRole('button', { name: 'Opslaan (Ctrl+S)', exact: true }).click();
  await expect(page.locator('.toast')).toContainText(/gewijzigd/i);
  expect(await fs.readFile(filename, 'utf8')).toBe(changedLocal);
  await expect(page.locator('.editor-tab.active .tab-close')).toHaveClass(/dirty/);
  expect(await recovery(filename)).toMatchObject({ id: before!.id, content: localOriginal + addition });
});

test('remote comparison reads fresh FTP bytes without changing workcache, recovery or the guarded upload baseline', async () => {
  const addition = 'EDITOR_REMOTE_UNSAVED';
  await openFile('remote', 'remote.txt');
  const cache = (await page.locator('.editor-tab.active').getAttribute('title'))!;
  await append(addition);
  await expect.poll(async () => (await recovery('/site/remote.txt', true))?.content).toBe(remoteOriginal + addition);
  const before = await recovery('/site/remote.txt', true);
  server.files.set('/site/remote.txt', Buffer.from(changedRemote));
  const downloads = server.commandCounts.get('RETR') ?? 0;
  const dialog = await compare('remote.txt');
  expect(server.commandCounts.get('RETR')).toBe(downloads + 1);
  await expect(dialog.getByText('Opgeslagen serverversie', { exact: true })).toBeVisible();
  await expect(dialog.locator('.document-diff-headings > div').nth(0)).toContainText(`${Buffer.byteLength(changedRemote)} B`);
  await expect(savedLines(dialog)).toContainText('Werkelijk extern gewijzigde langere serverversie');
  await expect(editorLines(dialog)).toContainText('Oorspronkelijke serverregel');
  await expect(editorLines(dialog)).toContainText(addition);
  await expect(dialog.locator('.document-diff-path')).toHaveText('/site/remote.txt');
  await expect(dialog.getByRole('textbox', { name: /^Opgeslagen serverversie/ })).toHaveAttribute('aria-autocomplete', 'none');
  await expect(dialog.getByRole('textbox', { name: /^Uw editorversie/ })).toHaveAttribute('aria-autocomplete', 'none');
  expect(await fs.readFile(cache, 'utf8')).toBe(remoteOriginal);
  expect(server.files.get('/site/remote.txt')).toEqual(Buffer.from(changedRemote));
  expect(await fs.readdir(path.join(root, 'data', 'comparisons'))).toEqual([]);
  expect(await recovery('/site/remote.txt', true)).toMatchObject({ id: before!.id, content: remoteOriginal + addition, remote: { original: before!.remote!.original } });
  await closeDiff(dialog);
  // A fresh recovery write must still record the original opening baseline.
  await append('_AFTER_COMPARE');
  await expect.poll(async () => (await recovery('/site/remote.txt', true))?.content).toBe(remoteOriginal + addition + '_AFTER_COMPARE');
  expect((await recovery('/site/remote.txt', true))?.remote?.original).toEqual(before!.remote!.original);
  await page.getByRole('button', { name: 'Opslaan en uploaden', exact: true }).click();
  await expect.poll(async () => (await page.evaluate(() => window.ftp.invoke('bootstrap', undefined))).queue.find(job => job.remotePath === '/site/remote.txt')?.status).toBe('conflict');
  const job = (await page.evaluate(() => window.ftp.invoke('bootstrap', undefined))).queue.find(item => item.remotePath === '/site/remote.txt')!;
  expect(job.expectedRemote?.size).toBe(before!.remote!.original.size);
  expect(job.expectedRemote?.modifiedAt).toBe(before!.remote!.original.modifiedAt);
  expect(job.expectedRemote?.checksum).toBe(before!.remote!.original.checksum);
  expect(server.files.get('/site/remote.txt')).toEqual(Buffer.from(changedRemote));
});

test('format-only LF/CRLF and UTF-8 BOM differences remain visible without modifying either snapshot', async () => {
  const filename = path.join(site, 'format.txt');
  await openFile('local', 'format.txt');
  await fs.writeFile(filename, 'Eerste regel\nTweede regel\n');
  const dialog = await compare('format.txt');
  const headings = dialog.locator('.document-diff-headings > div');
  await expect(headings.nth(0)).toContainText('LF · UTF-8 zonder BOM');
  await expect(headings.nth(1)).toContainText('CRLF · UTF-8 met BOM');
  await expect(dialog.getByRole('status')).toHaveText('Tekst is gelijk; regelafbrekingen of BOM verschillen.');
  await expect(dialog.getByRole('button', { name: 'Vorig verschil', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Volgend verschil', exact: true })).toBeDisabled();
  expect(await fs.readFile(filename, 'utf8')).toBe('Eerste regel\nTweede regel\n');
  await closeDiff(dialog);
  await expect(page.locator('.editor-tab.active .tab-close')).not.toHaveClass(/dirty/);
  await compare('format.txt');
  await expect(page.getByRole('dialog', { name: 'Bestand vergelijken · format.txt', exact: true }).getByRole('status')).toHaveText('Tekst is gelijk; regelafbrekingen of BOM verschillen.');
});

test('a comparison freezes the requested dirty editor snapshot while later real edits remain in the original buffer', async () => {
  const filename = path.join(site, 'local.txt'), captured = 'CAPTURED_EDITOR_EDIT', later = '_LATER_WHILE_LOADING';
  await openFile('local', 'local.txt');
  await append(captured);
  await holdFirstComparisonResponse();
  await page.getByRole('button', { name: 'Vergelijken met opgeslagen versie', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Bestand vergelijken', exact: true })).toBeVisible();
  await waitHeldComparison();
  // Focus the real underlying Monaco buffer to exercise a content update while
  // the renderer is still awaiting its original comparison request.
  await append(later);
  await expect.poll(async () => (await recovery(filename))?.content).toBe(localOriginal + captured + later);
  await releaseComparison();
  const dialog = page.getByRole('dialog', { name: 'Bestand vergelijken · local.txt', exact: true });
  await expect(dialog).toBeVisible();
  await expect(editorLines(dialog)).toContainText(captured);
  await expect(editorLines(dialog)).not.toContainText(later);
  expect(await fs.readFile(filename, 'utf8')).toBe(localOriginal);
  await closeDiff(dialog);
  await expect(page.locator('.editor-tab.active .tab-close')).toHaveClass(/dirty/);
  await expect(page.locator('.editor-panel-wrapper .monaco-editor .view-lines')).toContainText(captured + later);
  expect((await recovery(filename))?.content).toBe(localOriginal + captured + later);
});

test('canceling a pending real comparison prevents its late response from replacing a newer comparison', async () => {
  const filename = path.join(site, 'local.txt');
  await openFile('local', 'local.txt');
  await append('FIRST_EDITOR_EDIT');
  await holdFirstComparisonResponse();
  await page.getByRole('button', { name: 'Vergelijken met opgeslagen versie', exact: true }).click();
  const loading = page.getByRole('dialog', { name: 'Bestand vergelijken', exact: true });
  await expect(loading).toBeVisible();
  await waitHeldComparison();
  await loading.getByRole('button', { name: 'Sluiten', exact: true }).last().click();
  await expect(loading).toHaveCount(0);
  await append('_NEWER_EDITOR_EDIT');
  await fs.writeFile(filename, 'NIEUWERE_SCHIJFSNAPSHOT\n');
  const latest = await compare('local.txt');
  await expect(savedLines(latest)).toContainText('NIEUWERE_SCHIJFSNAPSHOT');
  await expect(editorLines(latest)).toContainText('FIRST_EDITOR_EDIT_NEWER_EDITOR_EDIT');
  await releaseComparison();
  await expect.poll(() => application.evaluate(() => (globalThis as unknown as { pendingDiffComparison: { delivered: number } }).pendingDiffComparison.delivered)).toBe(2);
  // Cross the IPC roundtrip and a render frame after the held response returns.
  await page.evaluate(async () => { await window.ftp.invoke('bootstrap', undefined); await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
  await expect(latest).toBeVisible();
  await expect(savedLines(latest)).toContainText('NIEUWERE_SCHIJFSNAPSHOT');
  await expect(savedLines(latest)).not.toContainText('Oorspronkelijke schijfregel');
  await expect(editorLines(latest)).toContainText('FIRST_EDITOR_EDIT_NEWER_EDITOR_EDIT');
  await closeDiff(latest);
  await expect(page.getByRole('dialog', { name: /^Bestand vergelijken/ })).toHaveCount(0);
  expect(await fs.readFile(filename, 'utf8')).toBe('NIEUWERE_SCHIJFSNAPSHOT\n');
  await expect(page.locator('.editor-tab.active .tab-close')).toHaveClass(/dirty/);
});
