import { test, expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
let application: ElectronApplication;
let page: Page;
let root: string;

test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-desktop-test-'));
  const site = path.join(root, 'site'); await fs.mkdir(site);
  await fs.writeFile(path.join(site, 'index.html'), '<!doctype html><html><head><title>Werkelijke desktoptest</title></head><body><h1>Mijn website</h1><p>Origineel</p></body></html>');
  await fs.writeFile(path.join(site, 'style.css'), 'h1 { color: red !important; }');
  application = await electron.launch({ executablePath: createRequire(import.meta.url)('electron') as string, args: [path.resolve('.')], env: { ...process.env, FTP_STUDIO_DATA_DIR: path.join(root, 'data') } });
  page = await application.firstWindow(); await page.waitForSelector('.studio');
  await page.evaluate(async localRoot => {
    await window.ftp.invoke('saveProject', { project: { id: 'test-project', name: 'Desktoptest', localRoot, remoteRoot: '/site', filters: { display: [], transfer: [], sync: [] }, environments: [], bookmarks: [] } });
    const state = await window.ftp.invoke('bootstrap', undefined); await window.ftp.invoke('saveSettings', { settings: { ...state.settings, lastProjectId: 'test-project' } });
  }, site);
  await page.reload(); await page.waitForSelector('.studio');
});
test.afterEach(async () => { await application?.close(); if (root) await fs.rm(root, { recursive: true, force: true }); });

test('desktop boots from actual SQLite and displays real local file metadata', async () => {
  await expect(page.getByText('Desktoptest', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('index.html', { exact: true }).first()).toBeVisible();
  const capabilities = await page.evaluate(() => ({ bridge: typeof window.ftp.invoke, node: typeof (window as unknown as { require?: unknown }).require }));
  expect(capabilities).toEqual({ bridge: 'function', node: 'undefined' });
  const files = await page.evaluate(localRoot => window.ftp.invoke('listLocal', { path: localRoot }), path.join(root, 'site'));
  expect(files.find(f => f.name === 'index.html')?.modifiedAt).toBeGreaterThan(0);
});

test('real document recovery and stale save checks preserve external edits', async () => {
  const filename = path.join(root, 'site', 'index.html');
  const document = await page.evaluate(filename => window.ftp.invoke('openDocument', { path: filename }), filename);
  await page.evaluate(id => window.ftp.invoke('recoverDocument', { id, content: '<p>Herstelbaar werk</p>' }), document.id);
  await fs.writeFile(filename, '<p>Extern gewijzigd</p>');
  const error = await page.evaluate(async id => { try { await window.ftp.invoke('saveDocument', { id, content: '<p>Verouderde edit</p>' }); return ''; } catch (error) { return String(error); } }, document.id);
  expect(error).toContain('gewijzigd'); expect(await fs.readFile(filename, 'utf8')).toBe('<p>Extern gewijzigd</p>');
  const recoveries = await page.evaluate(async () => (await window.ftp.invoke('bootstrap', undefined)).recoveries);
  expect(recoveries.find(d => d.id === document.id)?.content).toContain('Herstelbaar werk');
});

test('isolated child frame has no desktop bridge, Node, or parent bridge access', async () => {
  await page.evaluate(async () => {
    const frame = document.createElement('iframe'); frame.name = 'isolation-probe'; frame.sandbox.add('allow-scripts'); frame.srcdoc = '<p>Geïsoleerd</p>';
    const loaded = new Promise<void>(resolve => { frame.onload = () => resolve(); }); document.body.append(frame); await loaded;
  });
  const frame = page.frame({ name: 'isolation-probe' }); expect(frame).not.toBeNull();
  const capabilities = await frame!.evaluate(() => {
    let parentBridge = false; try { parentBridge = !!(parent as unknown as { ftp?: unknown }).ftp; } catch { /* Opaque origin. */ }
    return { bridge: typeof window.ftp, node: typeof (window as unknown as { require?: unknown }).require, parentBridge };
  });
  expect(capabilities).toEqual({ bridge: 'undefined', node: 'undefined', parentBridge: false });
});
