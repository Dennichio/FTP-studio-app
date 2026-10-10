import { test, expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ftpFixture } from '../fixtures/ftp-server';

let application: ElectronApplication;
let page: Page;
let root: string;

test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-library-test-'));
  application = await electron.launch({ executablePath: createRequire(path.resolve('package.json'))('electron') as string, args: [path.resolve('.')], env: { ...process.env, FTP_STUDIO_DATA_DIR: path.join(root, 'data') } });
  page = await application.firstWindow();
  await page.waitForSelector('.studio');
  await page.evaluate(async () => {
    for (const snippet of [
      { id: 'library-a', name: 'Bibliotheek navigatie', language: 'html', group: 'Layout', body: '<nav>Zoekbare unieke navigatie</nav>' },
      { id: 'library-b', name: 'Bibliotheek raster', language: 'css', group: 'Layout', body: '.raster { display: grid; }' },
      { id: 'library-c', name: 'Bibliotheek vrij', language: 'javascript', body: 'console.log("los fragment");' },
    ]) await window.ftp.invoke('saveSnippet', { snippet });
  });
  await page.reload(); await page.waitForSelector('.studio');
});
test.afterEach(async () => { await application?.close(); if (root) await fs.rm(root, { recursive: true, force: true }); });

async function library() {
  await page.getByRole('button', { name: 'Codefragmenten', exact: true }).click();
  return page.getByRole('dialog', { name: 'Codefragmenten', exact: true });
}

test('saved groups and source search browse real persisted snippets', async () => {
  const dialog = await library();
  await dialog.getByLabel('Groep bekijken').selectOption('group:Layout');
  await expect(dialog.locator('.manager-list').getByRole('button', { name: /^Bibliotheek/ })).toHaveCount(2);
  await dialog.getByLabel('Fragmenten zoeken').fill('UNIEKE NAVIGATIE');
  await expect(dialog.locator('.manager-list').getByRole('button', { name: /^Bibliotheek/ })).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Bibliotheek navigatie', exact: true }).click();
  await expect(dialog.getByLabel('Broncode')).toHaveValue('<nav>Zoekbare unieke navigatie</nav>');
  await dialog.getByLabel('Fragmenten zoeken').fill('');
  await dialog.getByLabel('Groep bekijken').selectOption('ungrouped');
  await expect(dialog.getByRole('button', { name: 'Bibliotheek vrij', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Bibliotheek navigatie', exact: true })).toHaveCount(0);
});

test('switch, Escape and deletion preserve drafts until explicitly confirmed', async () => {
  const dialog = await library();
  await dialog.getByRole('button', { name: 'Bibliotheek navigatie', exact: true }).click();
  await dialog.getByLabel('Broncode').fill('<nav>Niet opgeslagen</nav>');
  await dialog.getByRole('button', { name: 'Bibliotheek raster', exact: true }).click();
  const guard = page.getByRole('dialog', { name: 'Niet-opgeslagen fragment', exact: true });
  await expect(guard).toBeVisible(); await guard.getByRole('button', { name: 'Annuleren', exact: true }).click();
  await expect(dialog.getByLabel('Broncode')).toHaveValue('<nav>Niet opgeslagen</nav>');
  await dialog.getByRole('button', { name: 'Bibliotheek raster', exact: true }).click();
  await guard.getByRole('button', { name: 'Doorgaan zonder opslaan', exact: true }).click();
  await expect(dialog.getByLabel('Naam')).toHaveValue('Bibliotheek raster');
  await dialog.getByRole('button', { name: 'Bibliotheek navigatie', exact: true }).click();
  await expect(dialog.getByLabel('Broncode')).toHaveValue('<nav>Zoekbare unieke navigatie</nav>');
  await dialog.getByLabel('Broncode').fill('<nav>Bewaar mijn wijziging</nav>');
  await dialog.getByLabel('Groep (optioneel)').fill('Menu');
  await page.keyboard.press('Escape'); await expect(guard).toBeVisible();
  await guard.getByRole('button', { name: 'Opslaan en doorgaan', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const saved = await page.evaluate(async () => (await window.ftp.invoke('bootstrap', undefined)).snippets.find(snippet => snippet.id === 'library-a'));
  expect(saved).toMatchObject({ body: '<nav>Bewaar mijn wijziging</nav>', group: 'Menu' });
  await page.reload(); await page.waitForSelector('.studio');
  const reopened = await library();
  await reopened.getByRole('button', { name: 'Bibliotheek navigatie', exact: true }).click();
  await expect(reopened.getByLabel('Groep (optioneel)')).toHaveValue('Menu');
  await reopened.getByLabel('Groep bekijken').selectOption('group:Menu');
  await reopened.getByLabel('Groep (optioneel)').fill('Navigatie');
  await reopened.getByRole('button', { name: 'Opslaan', exact: true }).click();
  await expect(reopened.getByLabel('Groep bekijken')).toHaveValue('all');
  await expect(reopened.getByLabel('Groep bekijken').locator('option[value="group:Menu"]')).toHaveCount(0);
  await reopened.getByLabel('Groep bekijken').selectOption('group:Navigatie');
  await reopened.getByRole('button', { name: 'Fragment verwijderen', exact: true }).click();
  const deletion = page.getByRole('dialog', { name: 'Fragment verwijderen', exact: true });
  await deletion.getByRole('button', { name: 'Annuleren', exact: true }).click();
  await expect(reopened.getByRole('button', { name: 'Bibliotheek navigatie', exact: true })).toBeVisible();
  await reopened.getByRole('button', { name: 'Fragment verwijderen', exact: true }).click();
  await deletion.getByRole('button', { name: 'Verwijderen', exact: true }).click();
  await expect(reopened.getByLabel('Groep bekijken')).toHaveValue('all');
  await expect(reopened.getByRole('button', { name: 'Bibliotheek navigatie', exact: true })).toHaveCount(0);
  await expect(reopened.getByRole('button', { name: 'Bibliotheek raster', exact: true })).toBeVisible();
});

test('live paused transfers change both priorities and log levels filter independently', async () => {
  const server = await ftpFixture({ stallDownload: true });
  server.files.set('/library-transfer.txt', Buffer.from('Werkelijke wachtrijcontrole'));
  try {
    const [job] = await page.evaluate(async ({ port, localRoot }) => {
      await window.ftp.invoke('connect', { profile: { id: 'library-ftp', name: 'Bibliotheek FTP', host: '127.0.0.1', port, protocol: 'ftp', username: 'test', localRoot, remoteRoot: '/', timeoutMs: 5000, connectionLimit: 2, parallelTransfers: 1, autoReconnect: false, passive: true }, credentials: { password: 'test' } });
      await window.ftp.invoke('listRemote', { connectionId: 'library-ftp', path: '/' });
      return window.ftp.invoke('enqueue', { requests: [{ connectionId: 'library-ftp', direction: 'download', localPath: `${localRoot}/library-transfer.txt`, remotePath: '/library-transfer.txt', priority: 50 }] });
    }, { port: server.port, localRoot: root });
    await expect.poll(() => server.downloadStarted).toBe(true);
    await page.evaluate(id => window.ftp.invoke('queueAction', { action: 'pause', ids: [id] }), job.id);
    await page.getByRole('button', { name: /^Overdrachtswachtrij/ }).click();
    const queue = page.locator('.queue-panel');
    const row = queue.locator('.job-row').filter({ hasText: 'library-transfer.txt' });
    await expect(row).toContainText('Gepauzeerd');
    await row.getByRole('button', { name: 'Lagere prioriteit', exact: true }).click();
    await expect.poll(() => page.evaluate(async id => (await window.ftp.invoke('bootstrap', undefined)).queue.find(item => item.id === id)?.priority, job.id)).toBe(49);
    await row.getByRole('button', { name: 'Hogere prioriteit', exact: true }).click();
    await expect.poll(() => page.evaluate(async id => (await window.ftp.invoke('bootstrap', undefined)).queue.find(item => item.id === id)?.priority, job.id)).toBe(50);
    // A real rejected command generates an error through the main-process logger.
    await page.evaluate(async () => { try { await window.ftp.invoke('statRemote', { connectionId: 'library-ftp', path: '/onveilig/../pad' }); } catch { /* Expected validation failure. */ } });
    await queue.getByRole('button', { name: /^Activiteitenlog/ }).click();
    await queue.getByLabel('Logniveau filteren').selectOption('debug');
    await expect(queue.locator('.log-row')).not.toHaveCount(0);
    await expect(queue.locator('.log-row:not(.debug)')).toHaveCount(0);
    await queue.getByLabel('Wachtrijverbinding filteren').selectOption('library-ftp');
    await expect(queue.locator('.log-row')).not.toHaveCount(0);
    await queue.getByLabel('Logniveau filteren').selectOption('error');
    await queue.getByLabel('Wachtrij of log doorzoeken').fill('Ongeldig remote pad');
    await expect(queue.getByText('Geen meldingen voor dit filter.', { exact: true })).toBeVisible();
    await queue.getByLabel('Wachtrijverbinding filteren').selectOption('all');
    await expect(queue.locator('.log-row.error')).not.toHaveCount(0);
    await expect(queue.locator('.log-row:not(.error)')).toHaveCount(0);
    await queue.getByLabel('Wachtrij of log doorzoeken').fill('');
    await queue.getByRole('button', { name: /^Overdrachtswachtrij/ }).click();
    await expect(row).toBeVisible();
  } finally {
    await page.evaluate(async () => { await window.ftp.invoke('queueAction', { action: 'cancel' }); await window.ftp.invoke('disconnect', { connectionId: 'library-ftp' }); }).catch(() => {});
    await server.close();
  }
});
