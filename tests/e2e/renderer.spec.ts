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
let site: string;
const original = '\uFEFF<!doctype html>\r\n<html><head><title>Werkelijke renderercontrole</title></head>\r\n<body><h1>Originele kop</h1><p>Oorspronkelijk</p></body></html>\r\n';

test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-renderer-test-'));
  site = path.join(root, 'site');
  await fs.mkdir(site);
  await fs.mkdir(path.join(site, 'submap'));
  await fs.writeFile(path.join(site, 'index.html'), original);
  await fs.writeFile(path.join(site, 'other.html'), '<!doctype html><html><head><title>Ander document</title></head><body><p>Anders</p></body></html>');
  await fs.writeFile(path.join(site, 'submap', 'nested.html'), '<p>Werkelijk bestand in submap</p>');
  // Real files exercise the filesystem and renderer window; no IPC mocks or invented listings.
  for (let start = 0; start < 1400; start += 40) {
    await Promise.all(Array.from({ length: Math.min(40, 1400 - start) }, (_, offset) => fs.writeFile(path.join(site, `item-${String(start + offset).padStart(4, '0')}.txt`), '')));
  }
  application = await electron.launch({ executablePath: createRequire(import.meta.url)('electron') as string, args: [path.resolve('.')], env: { ...process.env, FTP_STUDIO_DATA_DIR: path.join(root, 'data') } });
  page = await application.firstWindow();
  await page.waitForSelector('.studio');
  await page.evaluate(async localRoot => {
    await window.ftp.invoke('saveProject', { project: { id: 'renderer-project', name: 'Renderercontrole', localRoot, remoteRoot: '/site', filters: { display: [], transfer: [], sync: [] }, environments: [], bookmarks: [] } });
    const state = await window.ftp.invoke('bootstrap', undefined);
    await window.ftp.invoke('saveSettings', { settings: { ...state.settings, lastProjectId: 'renderer-project', layout: { editorMode: 'code', browserHeight: 302, queueHeight: 205 } } });
  }, site);
  await page.reload();
  await page.waitForSelector('.file-pane[aria-label="Lokale bestanden"] .file-row[role="option"]');
});
test.afterEach(async () => {
  if (application) { await application.evaluate(({dialog})=>{dialog.showMessageBoxSync=()=>1;}).catch(()=>{});await application.close(); }
  if (root) await fs.rm(root, { recursive: true, force: true });
});

function localPane() { return page.locator('.file-pane[aria-label="Lokale bestanden"]'); }
async function openFile(name: string) {
  await localPane().getByRole('textbox', { name: 'Bestanden filteren' }).fill(name);
  await localPane().locator('.file-row[role="option"]').filter({ hasText: name }).dblclick();
  await expect(page.locator('.editor-tab.active')).toContainText(name);
  await expect(page.locator('.monaco-editor')).toBeVisible();
}

test('large real folders keep bounded DOM rows, exact metadata and full selection', async () => {
  const pane = localPane();
  await expect(pane.locator('.file-filter>span')).toHaveText('1403');
  expect(await pane.locator('.file-row[role="option"]').count()).toBeLessThan(60);
  await expect(pane.locator('.table-head')).toContainText('Type');
  await expect(pane.locator('.file-row[role="option"]').first()).toContainText(/\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}:\d{2}/);
  const list = pane.getByRole('listbox');
  await list.focus(); await page.keyboard.press('End');
  await expect(pane.locator('.file-row.selected')).toContainText('other.html');
  expect(await pane.locator('.file-row[role="option"]').count()).toBeLessThan(60);
  await page.keyboard.press('Control+A');
  await expect(pane.locator('.pane-foot')).toContainText('1403 geselecteerd');
  await pane.getByRole('textbox', { name: 'Bestanden filteren' }).fill('nested-not-present');
  await expect(pane.locator('.pane-empty')).toContainText('Geen bestanden gevonden');
});

test('real Monaco tabs retain undo, BOM and CRLF when source is edited and saved', async () => {
  await openFile('index.html');
  const editor = page.locator('.monaco-editor textarea.inputarea');
  await editor.focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('<!-- Bewaarde wijziging -->');
  await expect(page.locator('.editor-tab.active .tab-close')).toHaveClass(/dirty/);
  await openFile('other.html');
  await page.locator('.editor-tab').filter({ hasText: 'index.html' }).click();
  await editor.focus(); await page.keyboard.press('Control+Z');
  await expect(page.locator('.editor-tab.active .tab-close')).not.toHaveClass(/dirty/);
  await page.keyboard.press('Control+Shift+Z'); await page.keyboard.press('Control+S');
  await expect.poll(async () => fs.readFile(path.join(site, 'index.html'), 'utf8')).toContain('<!-- Bewaarde wijziging -->');
  const saved = await fs.readFile(path.join(site, 'index.html'), 'utf8');
  expect(saved.startsWith('\uFEFF')).toBe(true);
  expect(saved.replace(/\r\n/g, '')).not.toContain('\n');
  await expect(page.locator('.editor-tab.active .tab-close')).not.toHaveClass(/dirty/);
});

test('panel hide and maximize choices persist through actual desktop reload', async () => {
  await page.getByRole('button', { name: 'Beeld', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Paneelindeling' });
  await dialog.getByRole('button', { name: 'Bestanden verbergen', exact: true }).click();
  await dialog.getByRole('button', { name: 'Sluiten', exact: true }).last().click();
  await expect(localPane()).not.toBeVisible();
  await expect.poll(async () => page.evaluate(async () => (await window.ftp.invoke('bootstrap', undefined)).settings.layout?.browserHidden)).toBe(true);
  await page.reload(); await page.waitForSelector('.studio');
  await expect(localPane()).not.toBeVisible();
  await page.getByRole('button', { name: 'Beeld', exact: true }).click();
  await page.getByRole('dialog', { name: 'Paneelindeling' }).getByRole('button', { name: 'Alle panelen herstellen', exact: true }).click();
  await page.getByRole('dialog', { name: 'Paneelindeling' }).getByRole('button', { name: 'Sluiten', exact: true }).last().click();
  await expect(localPane()).toBeVisible();
  await page.getByRole('button', { name: 'Bestandspaneel maximaliseren', exact: true }).click();
  await expect(page.locator('.file-browsers')).toHaveClass(/maximized/);
  await expect(page.locator('.editor-panel-wrapper')).not.toBeVisible();
  await page.getByRole('button', { name: 'Bestandspaneel herstellen', exact: true }).click();
  await expect(page.locator('.editor-panel-wrapper')).toBeVisible();
});

 test('Save As uses the native destination and leaves the original UTF-8 source intact',async()=>{
  await openFile('index.html');
  const target=path.join(site,'saved-copy.html');
  // Replace only the OS picker response inside the real Electron process; all file/service/IPC work stays real.
  await application.evaluate(({dialog},filename)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:filename});},target);
  await page.getByRole('button',{name:'Opslaan als… (Ctrl+Shift+S)',exact:true}).click();
  await expect(page.locator('.editor-tab.active')).toContainText('saved-copy.html');
  expect(await fs.readFile(target,'utf8')).toBe(original);
  expect(await fs.readFile(path.join(site,'index.html'),'utf8')).toBe(original);
 });

 test('real connection tabs preserve separate local and remote paths without stale selections',async()=>{
  const serverA=await ftpFixture(),serverB=await ftpFixture();
  serverA.directories.add('/site');serverA.directories.add('/site/a');serverA.files.set('/site/a/only-a.txt',Buffer.from('A'));
  serverB.directories.add('/site');serverB.directories.add('/site/b');serverB.files.set('/site/b/only-b.txt',Buffer.from('B'));
  try{
   await page.evaluate(async args=>{
    for(const [id,name,port] of [['renderer-a','Server A',args.portA],['renderer-b','Server B',args.portB]] as const){
     await window.ftp.invoke('connect',{profile:{id,name,host:'127.0.0.1',port,protocol:'ftp',username:'test',localRoot:args.site,remoteRoot:'/site',timeoutMs:5000,connectionLimit:5,parallelTransfers:4,autoReconnect:false,passive:true},credentials:{password:'test'}});
    }
   },{portA:serverA.port,portB:serverB.port,site});
   await page.locator('.connection-tab').filter({hasText:'Server A'}).click();
   const uploadTarget=page.locator('.file-pane[aria-label="Serverbestanden"]');
   await expect(uploadTarget.getByRole('listbox')).toHaveAttribute('aria-busy','false');
   await localPane().getByRole('textbox',{name:'Bestanden filteren'}).fill('other.html');
   await localPane().locator('.file-row[role="option"]').dragTo(uploadTarget.locator('.file-filter'));
   await expect.poll(()=>serverA.files.get('/site/other.html')?.toString()).toContain('Ander document');
   await expect(page.locator('.queue-panel')).toBeVisible();
   await localPane().getByRole('textbox',{name:'Bestanden filteren'}).fill('');
   await localPane().getByRole('textbox',{name:'Lokaal pad'}).fill(path.join(site,'submap'));
   await localPane().getByRole('textbox',{name:'Lokaal pad'}).press('Enter');
   const remote=page.locator('.file-pane[aria-label="Serverbestanden"]');
   await remote.getByRole('textbox',{name:'Serverpad'}).fill('/site/a');await remote.getByRole('textbox',{name:'Serverpad'}).press('Enter');
   await expect(remote.locator('.file-row[role="option"]')).toContainText('only-a.txt');
   await remote.locator('.file-row[role="option"]').click();
   await page.locator('.connection-tab').filter({hasText:'Server B'}).click();
   await expect(remote.locator('.file-row.selected')).toHaveCount(0);
   await remote.getByRole('textbox',{name:'Serverpad'}).fill('/site/b');await remote.getByRole('textbox',{name:'Serverpad'}).press('Enter');
   await expect(remote.locator('.file-row[role="option"]')).toContainText('only-b.txt');
   await page.locator('.connection-tab').filter({hasText:'Server A'}).click();
   await expect(localPane().getByRole('textbox',{name:'Lokaal pad'})).toHaveValue(path.join(site,'submap'));
   await expect(remote.getByRole('textbox',{name:'Serverpad'})).toHaveValue('/site/a');
   await expect(remote.locator('.file-row[role="option"]')).toContainText('only-a.txt');
   await page.locator('.connection-tab').filter({hasText:'Server B'}).click();
   await expect(localPane().getByRole('textbox',{name:'Lokaal pad'})).toHaveValue(site);
   await expect(remote.getByRole('textbox',{name:'Serverpad'})).toHaveValue('/site/b');
  }finally{
   await page.evaluate(async()=>{await window.ftp.invoke('disconnect',{connectionId:'renderer-a'});await window.ftp.invoke('disconnect',{connectionId:'renderer-b'});}).catch(()=>{});
   await serverA.close();await serverB.close();
  }
 });
