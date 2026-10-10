import { test, expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { promises as fs } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

let application: ElectronApplication, page: Page, root: string;
test.afterEach(async () => { if (application) await application.close(); if (root) await fs.rm(root, { recursive: true, force: true }); });

test('split gestures cancel without saving, keyboard clamps, and committed width survives real reload', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-split-ui-'));
  const site = path.join(root, 'site'), filename = path.join(site, 'index.html');
  await fs.mkdir(site); await fs.writeFile(filename, '<!doctype html><html><head><title>Split</title></head><body><p>Preview</p></body></html>');
  application = await electron.launch({ executablePath: createRequire(path.resolve('package.json'))('electron') as string, args: [path.resolve('.')], env: { ...process.env, FTP_STUDIO_DATA_DIR: path.join(root, 'data') } });
  page = await application.firstWindow(); await page.waitForSelector('.studio');
  await page.evaluate(async ({ site, filename }) => {
    await window.ftp.invoke('saveProject', { project: { id: 'split-project', name: 'Split', localRoot: site, remoteRoot: '/', filters: { display: [], transfer: [], sync: [] }, environments: [], bookmarks: [], openFiles: [filename] } });
    const state = await window.ftp.invoke('bootstrap', undefined);
    await window.ftp.invoke('saveSettings', { settings: { ...state.settings, lastProjectId: 'split-project', layout: { editorMode: 'split', editorSplitPercent: 45 } } });
  }, { site, filename });
  await page.reload();
  const handle = page.getByRole('separator', { name: 'Code- en canvasbreedte aanpassen', exact: true });
  await expect(handle).toHaveAttribute('aria-valuenow', '45');
  const persisted = () => {
    const db = new DatabaseSync(path.join(root, 'data', 'studio.db'), { readOnly: true });
    try { return JSON.parse(String(db.prepare('SELECT value FROM settings WHERE key = ?').get('settings')!.value)).layout.editorSplitPercent as number; }
    finally { db.close(); }
  };
  const drag = async () => {
    await handle.evaluate(element => element.addEventListener('pointerdown', event => { (element as HTMLElement).dataset.testPointerId = String((event as PointerEvent).pointerId); }, { once: true }));
    const rect = (await handle.boundingBox())!;
    await page.mouse.move(rect.x + rect.width / 2, rect.y + 10); await page.mouse.down();
    await page.mouse.move(rect.x + 60, rect.y + 10);
    await expect(handle).not.toHaveAttribute('aria-valuenow', String(persisted()));
  };
  for (const cancel of ['pointercancel', 'escape', 'windowblur', 'modechange']) {
    await drag(); expect(persisted()).toBe(45);
    if (cancel === 'pointercancel') await handle.dispatchEvent('pointercancel', { pointerId: Number(await handle.getAttribute('data-test-pointer-id')), isPrimary: true });
    else if (cancel === 'escape') await page.keyboard.press('Escape');
    else if (cancel === 'windowblur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    else await page.getByRole('button', { name: 'Code', exact: true }).evaluate(element => (element as HTMLButtonElement).click());
    await page.mouse.up();
    await expect(page.locator('body')).not.toHaveClass(/resizing-columns/);
    if (cancel === 'modechange') await page.getByRole('button', { name: 'Split', exact: true }).click();
    await expect(handle).toHaveAttribute('aria-valuenow', '45'); expect(persisted()).toBe(45);
  }
  await handle.focus(); await page.keyboard.down('ArrowRight');
  await expect(handle).toHaveAttribute('aria-valuenow', '46'); expect(persisted()).toBe(45);
  await page.keyboard.press('Escape'); await page.keyboard.up('ArrowRight');
  await expect(handle).toHaveAttribute('aria-valuenow', '45'); expect(persisted()).toBe(45);
  await page.keyboard.press('End'); await page.keyboard.press('ArrowRight');
  await expect(handle).toHaveAttribute('aria-valuenow', '70'); await expect.poll(persisted).toBe(70);
  await page.keyboard.press('Home'); await page.keyboard.press('ArrowLeft');
  await expect(handle).toHaveAttribute('aria-valuenow', '25'); await expect.poll(persisted).toBe(25);
  await drag(); await page.mouse.up();
  const committed = Number(await handle.getAttribute('aria-valuenow'));
  expect(committed).toBeGreaterThan(25); await expect.poll(persisted).toBe(committed);
  await page.reload(); await expect(handle).toHaveAttribute('aria-valuenow', String(committed));
  await expect(page.locator('body')).not.toHaveClass(/resizing-columns/);
  expect(await fs.readFile(filename, 'utf8')).toContain('<p>Preview</p>');
});
