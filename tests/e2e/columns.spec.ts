import { test, expect, type Locator } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { promises as fs } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { AppSettings } from '../../src/shared/contracts';
import { ftpFixture } from '../fixtures/ftp-server';

let application: ElectronApplication, page: Page, root: string, site: string;
let server: Awaited<ReturnType<typeof ftpFixture>>;
const remoteWidths = [210, 60, 75, 150, 44];

test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-columns-ui-'));
  site = path.join(root, 'site');
  await fs.mkdir(site);
  // Real sizes and filesystem entries exercise sorting and bounded virtualization.
  for (let start = 0; start < 1200; start += 40) {
    await Promise.all(Array.from({ length: 40 }, (_, offset) => {
      const index = start + offset;
      return fs.writeFile(path.join(site, `item-${String(index).padStart(4, '0')}.txt`), Buffer.alloc(index));
    }));
  }
  server = await ftpFixture();
  server.directories.add('/site');
  server.files.set('/site/remote.txt', Buffer.from('Werkelijk serverbestand'));
  application = await electron.launch({ executablePath: createRequire(path.resolve('package.json'))('electron') as string, args: [path.resolve('.')], env: { ...process.env, FTP_STUDIO_DATA_DIR: path.join(root, 'data') } });
  page = await application.firstWindow();
  await page.waitForSelector('.studio');
  await page.evaluate(async ({ localRoot, port, columns }) => {
    const profile = { id: 'columns-server', name: 'Kolomcontrole', host: '127.0.0.1', port, protocol: 'ftp' as const, username: 'test', localRoot, remoteRoot: '/site', timeoutMs: 5000, connectionLimit: 5, parallelTransfers: 4, autoReconnect: false, passive: true };
    await window.ftp.invoke('saveProject', { project: { id: 'columns-project', name: 'Kolomcontrole', profileId: profile.id, localRoot, remoteRoot: '/site', filters: { display: [], transfer: [], sync: [] }, environments: [], bookmarks: [] } });
    const state = await window.ftp.invoke('bootstrap', undefined);
    await window.ftp.invoke('saveSettings', { settings: { ...state.settings, lastProjectId: 'columns-project', syncNavigation: false, layout: { browserHeight: 330, editorMode: 'code', fileColumns: { remote: columns } } } });
    await window.ftp.invoke('connect', { profile, credentials: { password: 'test' } });
  }, { localRoot: site, port: server.port, columns: remoteWidths });
  await page.reload();
  await expect(local().locator('.file-filter > span')).toHaveText('1200');
  await expect(remote().getByRole('listbox')).toHaveAttribute('aria-busy', 'false');
  await expect(remote().getByRole('option')).toContainText('remote.txt');
});

test.afterEach(async () => {
  if (application) await application.close();
  await server?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

function local() { return page.locator('.file-pane[aria-label="Lokale bestanden"]'); }
function remote() { return page.locator('.file-pane[aria-label="Serverbestanden"]'); }
function nameHandle() { return local().getByRole('separator', { name: 'Breedte kolom Naam', exact: true }); }
function sqliteSettings(): AppSettings {
  const inspector = new DatabaseSync(path.join(root, 'data', 'studio.db'), { readOnly: true });
  try { return JSON.parse(String(inspector.prepare('SELECT value FROM settings WHERE key = ?').get('settings')!.value)); }
  finally { inspector.close(); }
}
async function template(row: Locator) { return row.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').map(Number.parseFloat)); }
async function startDrag(handle: Locator) {
  const bounds = await handle.boundingBox();
  expect(bounds).not.toBeNull();
  const point = { x: bounds!.x + bounds!.width / 2, y: bounds!.y + bounds!.height / 2 };
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  return point;
}
async function resizeName(delta: number) {
  const point = await startDrag(nameHandle());
  await page.mouse.move(point.x + delta, point.y, { steps: 5 });
  await page.mouse.up();
}

test('pointer resizing commits once at release, shares row widths and survives SQLite reload independently per pane', async () => {
  const defaultWidths = await template(local().locator('.table-head'));
  const originalWindow = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 900));
  await expect.poll(async () => (await template(local().locator('.table-head')))[0]).not.toBe(defaultWidths[0]);
  await expect(local()).not.toHaveClass(/file-columns-custom/);
  expect(await template(remote().locator('.table-head'))).toEqual(remoteWidths);
  await application.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setSize(bounds.width, bounds.height), originalWindow);
  await expect.poll(() => template(local().locator('.table-head'))).toEqual(defaultWidths);
  const point = await startDrag(nameHandle());
  await page.mouse.move(point.x + 130, point.y, { steps: 6 });
  await expect(nameHandle()).toHaveAttribute('aria-valuenow', String(Math.round(defaultWidths[0]) + 130));
  expect(sqliteSettings().layout?.fileColumns?.local).toBeUndefined();
  expect(await template(remote().locator('.table-head'))).toEqual(remoteWidths);
  await page.mouse.up();
  const expected = defaultWidths.map(Math.round);
  expected[0] += 130;
  await expect.poll(() => sqliteSettings().layout?.fileColumns?.local).toEqual(expected);
  expect(sqliteSettings().layout?.fileColumns?.remote).toEqual(remoteWidths);
  expect(await template(local().getByRole('option').first())).toEqual(expected);
  await page.reload();
  await expect(local().locator('.file-filter > span')).toHaveText('1200');
  expect(await template(local().locator('.table-head'))).toEqual(expected);
  expect(await template(local().getByRole('option').first())).toEqual(expected);
  expect(await template(remote().locator('.table-head'))).toEqual(remoteWidths);
  expect(sqliteSettings().layout?.fileColumns).toEqual({ local: expected, remote: remoteWidths });
});

test('keyboard repeats commit on keyup, Escape cancels a drag, and limits and reset preserve the other pane', async () => {
  const initial = Math.round((await template(local().locator('.table-head')))[0]);
  const point = await startDrag(nameHandle());
  await page.mouse.move(point.x + 100, point.y);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(nameHandle()).toHaveAttribute('aria-valuenow', String(initial));
  expect(sqliteSettings().layout?.fileColumns?.local).toBeUndefined();
  await nameHandle().focus();
  await page.keyboard.down('ArrowRight');
  await page.keyboard.down('ArrowRight');
  await expect(nameHandle()).toHaveAttribute('aria-valuenow', String(initial + 20));
  expect(sqliteSettings().layout?.fileColumns?.local).toBeUndefined();
  await page.keyboard.up('ArrowRight');
  await expect.poll(() => sqliteSettings().layout?.fileColumns?.local?.[0]).toBe(initial + 20);
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(() => sqliteSettings().layout?.fileColumns?.local?.[0]).toBe(initial + 60);
  await page.keyboard.press('Home');
  await expect(nameHandle()).toHaveAttribute('aria-valuenow', '105');
  await page.keyboard.press('ArrowLeft');
  await expect(nameHandle()).toHaveAttribute('aria-valuenow', '105');
  await page.keyboard.press('End');
  await expect(nameHandle()).toHaveAttribute('aria-valuenow', '1600');
  await page.keyboard.press('ArrowRight');
  await expect(nameHandle()).toHaveAttribute('aria-valuenow', '1600');
  await expect(local().locator('.file-row.selected')).toHaveCount(0);
  await local().getByRole('button', { name: 'Kolombreedtes herstellen', exact: true }).click();
  await expect.poll(() => sqliteSettings().layout?.fileColumns?.local).toEqual([]);
  await expect(local().getByRole('button', { name: 'Kolombreedtes herstellen', exact: true })).toBeDisabled();
  expect(await template(remote().locator('.table-head'))).toEqual(remoteWidths);
  await page.reload();
  await expect(local().locator('.file-filter > span')).toHaveText('1200');
  await expect(local()).not.toHaveClass(/file-columns-custom/);
  expect(await template(remote().locator('.table-head'))).toEqual(remoteWidths);
});

test('resizing preserves sorted selection and bounded rows while horizontal and vertical scrolling stay aligned', async () => {
  const pane = local(), list = pane.getByRole('listbox');
  await pane.getByRole('button', { name: 'Naam', exact: true }).click();
  const first = pane.getByRole('option').first();
  await expect(first).toContainText('item-1199.txt');
  await first.click();
  await resizeName(220);
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await expect(first).toContainText('item-1199.txt');
  await list.focus();
  await page.keyboard.press('End');
  const last = pane.locator('.file-row.selected');
  await expect(last).toContainText('item-0000.txt');
  await expect(last).toHaveAttribute('aria-posinset', '1200');
  await expect(last).toHaveAttribute('aria-setsize', '1200');
  expect(await pane.getByRole('option').count()).toBeLessThan(60);
  await expect.poll(() => list.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await list.evaluate(element => { element.scrollLeft = element.scrollWidth - element.clientWidth; });
  await expect.poll(() => list.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  expect(await template(last)).toEqual(await template(pane.locator('.table-head')));
  const columnX = await pane.evaluate(element => {
    const header = element.querySelector('.table-head')!.children[3].getBoundingClientRect();
    const selected = element.querySelector('.file-row.selected')!.children[3].getBoundingClientRect();
    return { header: header.x, selected: selected.x };
  });
  expect(Math.abs(columnX.header - columnX.selected)).toBeLessThan(1);
  await list.focus();
  await page.keyboard.press('Control+A');
  await expect(pane.locator('.pane-foot')).toContainText('1200 geselecteerd');
  await pane.getByRole('textbox', { name: 'Bestanden filteren', exact: true }).fill('item-0600.txt');
  await expect(pane.getByRole('option')).toHaveCount(1);
  await expect(pane.getByRole('option')).toContainText('item-0600.txt');
  await expect(pane.getByRole('option')).toHaveAttribute('aria-selected', 'true');
  expect(await template(pane.getByRole('option'))).toEqual(await template(pane.locator('.table-head')));
});
