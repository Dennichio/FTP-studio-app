import { test, expect, type Locator } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

let application: ElectronApplication, page: Page, root: string, site: string;
const movingSource = '<p id=\'moving\' class="card highlighted">Eerste &amp; origineel</p>';
const original = '\uFEFF<!doctype html>\r\n<html>\r\n<head><title>DOM-controle</title></head>\r\n<body>\r\n<!-- Ongewijzigde bron, quotes en witruimte -->\r\n<main id=\'outer\' class="panel wide">\r\n<section id="branch" class=\'nested\'>\r\n' + movingSource + '\r\n<span id="keep">Tweede element</span>\r\n</section>\r\n<script>window.onveilig = "wordt niet uitgevoerd";</script>\r\n</main>\r\n<div id="target" class=\'destination\'><em id="existing">Doel</em></div>\r\n</body>\r\n</html>\r\n';

test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-dom-desktop-'));
  site = path.join(root, 'site');
  await fs.mkdir(site);
  await fs.writeFile(path.join(site, 'index.html'), original);
  await fs.writeFile(path.join(site, 'other.html'), '<!doctype html><html><head><title>Ander</title></head><body><main id="other"><p>Ander document</p></main></body></html>');
  application = await electron.launch({ executablePath: createRequire(path.resolve('package.json'))('electron') as string, args: [path.resolve('.')], env: { ...process.env, FTP_STUDIO_DATA_DIR: path.join(root, 'data') } });
  page = await application.firstWindow();
  await page.waitForSelector('.studio');
  await page.evaluate(async localRoot => {
    await window.ftp.invoke('saveProject', { project: { id: 'dom-project', name: 'DOM desktop', localRoot, remoteRoot: '/', filters: { display: [], transfer: [], sync: [] }, environments: [], bookmarks: [] } });
    const state = await window.ftp.invoke('bootstrap', undefined);
    await window.ftp.invoke('saveSettings', { settings: { ...state.settings, lastProjectId: 'dom-project', layout: { editorMode: 'split' } } });
  }, site);
  await page.reload();
  await page.waitForSelector('.studio');
  await openFile('index.html');
  await page.getByRole('button', { name: 'DOM-structuur', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'DOM-structuur', exact: true })).toBeVisible();
});

test.afterEach(async () => {
  if (application) {
    await application.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; }).catch(() => {});
    await application.close();
  }
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function openFile(name: string) {
  const local = page.locator('.file-pane[aria-label="Lokale bestanden"]');
  await local.getByRole('textbox', { name: 'Bestanden filteren', exact: true }).fill(name);
  await local.locator('.file-row[role="option"]').filter({ hasText: name }).dblclick();
  await expect(page.locator('.editor-tab.active')).toContainText(name);
}
function tree() { return page.getByRole('tree', { name: 'DOM-structuur', exact: true }); }
function item(id: string) { return tree().getByRole('treeitem', { name: new RegExp(` #${id}(?: |$)`) }); }
async function expectFocus(node: Locator) { await expect(node).toBeFocused(); }

test('DOM tree collapses with keyboard and reveals canvas/code selections without changing source', async () => {
  const outer = item('outer'), branch = item('branch'), moving = item('moving');
  const initialCanvas = page.frameLocator('iframe[title="Veilige websitepreview"]');
  await expect(initialCanvas.locator('head > title')).toHaveJSProperty('textContent', 'DOM-controle');
  await expect(initialCanvas.locator('html')).toHaveAttribute('data-ftp-node', `n${original.indexOf('<html>')}`);
  await expect(initialCanvas.locator('head')).toHaveAttribute('data-ftp-node', `n${original.indexOf('<head>')}`);
  await expect(outer).toHaveAttribute('aria-level', '3');
  await expect(moving).toHaveAttribute('aria-label', '‹p› #moving .card .highlighted');
  await outer.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(outer).toHaveAttribute('aria-expanded', 'false');
  await expect(moving).toHaveCount(0);
  // An unrelated editor render keeps the user collapse at the same revision.
  await page.getByLabel('Preview-breedte', { exact: true }).selectOption('768');
  await expect(outer).toHaveAttribute('aria-expanded', 'false');
  await outer.focus();
  await page.keyboard.press('ArrowRight');
  await expect(outer).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowRight');
  await expectFocus(branch);
  await page.keyboard.press('ArrowLeft');
  await expect(branch).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('ArrowDown');
  await expectFocus(tree().getByRole('treeitem', { name: '‹script›', exact: true }));
  await page.keyboard.press('ArrowUp');
  await expectFocus(branch);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expectFocus(moving);
  await page.keyboard.press('Enter');
  await expect(moving).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.monaco-editor .selected-text')).not.toHaveCount(0);
  const canvas = page.frameLocator('iframe[title="Veilige websitepreview"]');
  await expect(canvas.locator('#moving')).toHaveAttribute('data-ftp-selected', '');
  await page.keyboard.press('Home');
  await expectFocus(tree().getByRole('treeitem', { name: '‹html›', exact: true }));
  await page.keyboard.press('End');
  await expectFocus(item('existing'));

  await outer.click();
  await outer.getByRole('button', { name: '‹main› #outer .panel .wide inklappen', exact: true }).click();
  await expect(moving).toHaveCount(0);
  await canvas.locator('#moving').click();
  await expect(outer).toHaveAttribute('aria-expanded', 'true');
  await expect(branch).toHaveAttribute('aria-expanded', 'true');
  await expect(moving).toHaveAttribute('aria-selected', 'true');

  // Cursor movement in the actual Monaco editor selects the source-mapped main
  // element and reopens its collapsed html/body ancestors.
  const body = tree().getByRole('treeitem', { name: '‹body›', exact: true });
  await body.getByRole('button', { name: '‹body› inklappen', exact: true }).click();
  const code = page.getByRole('textbox', { name: 'Broncode', exact: true });
  await code.focus();
  await page.keyboard.press('Control+Home');
  for (let line = 1; line < 6; line++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Home');
  await expect(body).toHaveAttribute('aria-expanded', 'true');
  await expect(outer).toHaveAttribute('aria-selected', 'true');
  expect(await fs.readFile(path.join(site, 'index.html'), 'utf8')).toBe(original);
  await expect(page.locator('.editor-tab.active .tab-close')).not.toHaveClass(/dirty/);

  await outer.getByRole('button', { name: '‹main› #outer .panel .wide inklappen', exact: true }).click();
  await openFile('other.html');
  await expect(item('other')).toBeVisible();
  // With compact markup, a forward Monaco range ends at the child's start.
  // The programmatic highlight must retain the selected parent element.
  await expect(canvas.locator('#other')).toBeVisible();
  await item('other').click();
  await expect(item('other')).toHaveAttribute('aria-selected', 'true');
  await expect(canvas.locator('#other')).toHaveAttribute('data-ftp-selected', '');
  await page.locator('.editor-tab').filter({ hasText: 'index.html' }).click();
  await expect(item('moving')).toBeVisible();
  await expect(item('outer')).toHaveAttribute('aria-expanded', 'true');
});

test('DOM drag respects protected nodes and moves exact source bytes with real Monaco undo', async () => {
  const moving = item('moving'), target = item('target');
  const script = tree().getByRole('treeitem', { name: '‹script›', exact: true });
  await expect(script).toHaveAttribute('draggable', 'false');
  await expect(item('outer')).toHaveAttribute('draggable', 'false');
  await expect(moving).toHaveAttribute('draggable', 'true');
  await moving.dragTo(script);
  await expect(page.locator('.editor-tab.active .tab-close')).not.toHaveClass(/dirty/);
  expect(await fs.readFile(path.join(site, 'index.html'), 'utf8')).toBe(original);

  await moving.dragTo(target);
  await expect(page.locator('.editor-tab.active .tab-close')).toHaveClass(/dirty/);
  const canvas = page.frameLocator('iframe[title="Veilige websitepreview"]');
  await expect(canvas.locator('#target > #moving')).toContainText('Eerste & origineel');
  await expect(canvas.locator('#branch > #moving')).toHaveCount(0);
  // Save to inspect the exact persisted source: no reserialization, quote or
  // whitespace changes, and the UTF-8 BOM/CRLF are retained.
  await page.getByRole('button', { name: 'Opslaan (Ctrl+S)', exact: true }).click();
  const moved = original.replace(movingSource, '').replace('<em id="existing">Doel</em></div>', '<em id="existing">Doel</em>' + movingSource + '</div>');
  await expect.poll(() => fs.readFile(path.join(site, 'index.html'), 'utf8')).toBe(moved);
  const code = page.getByRole('textbox', { name: 'Broncode', exact: true });
  await code.focus();
  await page.keyboard.press('Control+Z');
  await expect(canvas.locator('#branch > #moving')).toContainText('Eerste & origineel');
  await page.keyboard.press('Control+S');
  await expect.poll(() => fs.readFile(path.join(site, 'index.html'), 'utf8')).toBe(original);
});
