import { test, expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { promises as fs } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ftpFixture } from '../fixtures/ftp-server';

let application: ElectronApplication;
let page: Page;
let root: string;
let server: Awaited<ReturnType<typeof ftpFixture>>;

test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-connections-test-'));
  const site = path.join(root, 'site'); await fs.mkdir(site);
  server = await ftpFixture();
  server.files.set('/welkom.txt', Buffer.from('Werkelijke directe verbinding'));
  application = await electron.launch({ executablePath: createRequire(path.resolve('package.json'))('electron') as string, args: [path.resolve('.')], env: { ...process.env, FTP_STUDIO_DATA_DIR: path.join(root, 'data') } });
  page = await application.firstWindow(); await page.waitForSelector('.studio');
  await page.evaluate(async ({ localRoot, port }) => {
    await window.ftp.invoke('saveProject', { project: { id: 'connections-project', name: 'Verbindingscontrole', localRoot, remoteRoot: '/', filters: { display: [], transfer: [], sync: [] }, environments: [], bookmarks: [] } });
    const state = await window.ftp.invoke('bootstrap', undefined);
    await window.ftp.invoke('saveSettings', { settings: { ...state.settings, lastProjectId: 'connections-project' } });
    for (const [id, name, group] of [['group-a', 'Klantverbinding', 'Klanten'], ['group-b', 'Testverbinding', 'Test'], ['group-c', 'Losse verbinding', undefined]] as const) {
      await window.ftp.invoke('saveProfile', { profile: { id, name, group, host: '127.0.0.1', port, protocol: 'ftp', username: 'test', localRoot, remoteRoot: '/', timeoutMs: 2000, connectionLimit: 2, parallelTransfers: 1, autoReconnect: false, passive: true }, credentials: {} });
    }
  }, { localRoot: site, port: server.port });
  await page.reload(); await page.waitForSelector('.studio');
});
test.afterEach(async () => { await application?.close(); await server?.close(); if (root) await fs.rm(root, { recursive: true, force: true }); });

async function manager() {
  await page.getByRole('button', { name: 'Verbindingsbeheer', exact: true }).first().click();
  return page.getByRole('dialog', { name: 'Verbindingsbeheer', exact: true });
}

test('direct FTP connects through real sockets without saving its profile or password', async () => {
  const form = page.getByRole('form', { name: 'Direct verbinden', exact: true });
  await form.getByLabel('Protocol voor direct verbinden').selectOption('ftp');
  await expect(form.getByLabel('Poort voor direct verbinden')).toHaveValue('21');
  await form.getByLabel('Host voor direct verbinden').fill('127.0.0.1');
  await form.getByLabel('Poort voor direct verbinden').fill(String(server.port));
  await form.getByLabel('Gebruikersnaam voor direct verbinden').fill('test');
  await form.getByLabel('Wachtwoord voor direct verbinden').fill('DirectSecret_e2e_43e7');
  await form.getByRole('button', { name: 'Direct verbinden', exact: true }).click();
  await expect(form.getByLabel('Wachtwoord voor direct verbinden')).toHaveValue('');
  await expect(page.locator('.connection-tab')).toContainText('Direct: 127.0.0.1');
  await expect(page.locator('.file-pane[aria-label="Serverbestanden"] .file-row[role="option"]')).toContainText('welkom.txt');
  const state = await page.evaluate(() => window.ftp.invoke('bootstrap', undefined));
  expect(state.connections).toHaveLength(1);
  expect(state.connections[0].profile.id).not.toMatch(/^group-/);
  expect(state.profiles).toHaveLength(3);
  expect(JSON.stringify({ profiles: state.profiles, logs: state.logs })).not.toContain('DirectSecret_e2e_43e7');
  await form.getByLabel('Protocol voor direct verbinden').selectOption('ftps-implicit');
  await expect(form.getByLabel('Poort voor direct verbinden')).toHaveValue('990');
  await form.getByLabel('Protocol voor direct verbinden').selectOption('sftp');
  await expect(form.getByLabel('Poort voor direct verbinden')).toHaveValue('22');
  await expect(form.getByLabel('SSH-hostvingerafdruk voor direct verbinden')).toBeVisible();
});

test('profile group navigation and connection test leave saved and active profiles unchanged', async () => {
  const dialog = await manager();
  await dialog.getByLabel('Verbindingsgroep bekijken').selectOption('group:Klanten');
  await expect(dialog.locator('.manager-list').getByRole('button', { name: /^Klantverbinding/ })).toBeVisible();
  await expect(dialog.locator('.manager-list').getByRole('button', { name: /^Testverbinding/ })).toHaveCount(0);
  await dialog.getByLabel('Verbindingsgroep bekijken').selectOption('ungrouped');
  await expect(dialog.locator('.manager-list').getByRole('button', { name: /^Losse verbinding/ })).toBeVisible();
  await dialog.getByRole('button', { name: 'Nieuwe verbinding', exact: true }).click();
  await dialog.getByLabel('Naam', { exact: true }).fill('Alleen getest');
  await dialog.getByLabel('Protocol', { exact: true }).selectOption('ftp');
  await dialog.getByLabel('Host', { exact: true }).fill('127.0.0.1');
  await dialog.getByLabel('Poort', { exact: true }).fill(String(server.port));
  await dialog.getByLabel('Gebruikersnaam', { exact: true }).fill('test');
  await dialog.getByLabel('Wachtwoord', { exact: true }).fill('test');
  await expect(dialog.getByLabel('Lokale hoofdmap', { exact: true })).toHaveValue('');
  await dialog.getByRole('button', { name: 'Verbinding testen', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Verbinding getest. De testsessie is gesloten');
  const state = await page.evaluate(() => window.ftp.invoke('bootstrap', undefined));
  expect(state.connections).toHaveLength(0); expect(state.profiles).toHaveLength(3);
  expect(state.profiles.some(profile => profile.name === 'Alleen getest')).toBe(false);
  await dialog.getByLabel('Verbindingsgroep bekijken').selectOption('group:Klanten');
  await dialog.locator('.manager-list').getByRole('button', { name: /^Klantverbinding/ }).click();
  await dialog.getByLabel('Groep', { exact: true }).fill('Productie');
  await dialog.getByRole('button', { name: 'Opslaan', exact: true }).click();
  await expect(dialog.getByLabel('Verbindingsgroep bekijken')).toHaveValue('all');
  await expect(dialog.getByLabel('Verbindingsgroep bekijken').locator('option[value="group:Klanten"]')).toHaveCount(0);
  await dialog.getByLabel('Verbindingsgroep bekijken').selectOption('group:Productie');
  await expect(dialog.locator('.manager-list').getByRole('button', { name: /^Klantverbinding/ })).toBeVisible();
});

test('a real stalled test locks its fields and Escape until timeout without retaining a connection', async () => {
  const sockets = new Set<Socket>();
  const stalled = createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); });
  await new Promise<void>((resolve, reject) => { stalled.once('error', reject); stalled.listen(0, '127.0.0.1', () => { stalled.removeListener('error', reject); resolve(); }); });
  const address = stalled.address(); if (!address || typeof address === 'string') throw new Error('Geen testpoort.');
  try {
    const dialog = await manager();
    await dialog.getByRole('button', { name: 'Nieuwe verbinding', exact: true }).click();
    await dialog.getByLabel('Naam', { exact: true }).fill('Time-outtest');
    await dialog.getByLabel('Protocol', { exact: true }).selectOption('ftp');
    await dialog.getByLabel('Host', { exact: true }).fill('127.0.0.1');
    await dialog.getByLabel('Poort', { exact: true }).fill(String(address.port));
    await dialog.getByLabel('Gebruikersnaam', { exact: true }).fill('test');
    await dialog.getByText('Verbindingsinstellingen', { exact: true }).click();
    await dialog.getByLabel('Time-out (seconden)', { exact: true }).fill('1');
    await dialog.getByRole('button', { name: 'Verbinding testen', exact: true }).click();
    await expect(dialog.getByLabel('Naam', { exact: true })).toBeDisabled();
    await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Naam', { exact: true })).toBeEnabled();
    await expect(dialog.getByRole('status')).not.toHaveText('');
    const state = await page.evaluate(() => window.ftp.invoke('bootstrap', undefined));
    expect(state.connections).toHaveLength(0); expect(state.profiles).toHaveLength(3);
    await expect(dialog.getByLabel('Naam', { exact: true })).toHaveValue('Time-outtest');
  } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => stalled.close(() => resolve())); }
});
