import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, Menu } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import type { Api } from '../shared/contracts';
import { SqliteStore, CredentialVault } from './storage';
import { StudioService } from './service';

app.setName('FTP Studio');
if (!app.requestSingleInstanceLock()) app.quit();
let window: BrowserWindow | undefined;
let service: StudioService | undefined;
let store: SqliteStore | undefined;
let closing = false;
const indexPath = path.resolve(__dirname, '../renderer/index.html');
const indexUrl = pathToFileURL(indexPath).href;

async function confirm(title: string, message: string): Promise<boolean> {
  const options: Electron.MessageBoxOptions = { type: 'warning', title, message, buttons: ['Annuleren', 'Doorgaan'], defaultId: 0, cancelId: 0, noLink: true };
  const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
  return result.response === 1;
}
async function openBrowser(url: string, browser: 'default' | 'edge' | 'chrome' = 'default'): Promise<void> {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) throw new Error('Alleen lokale preview-URL’s zijn toegestaan.');
  if (browser === 'default') { await shell.openExternal(url); return; }
  if (process.platform !== 'win32') throw new Error('Het kiezen van Edge of Chrome is alleen beschikbaar op Windows.');
  const relative = browser === 'edge' ? 'Microsoft/Edge/Application/msedge.exe' : 'Google/Chrome/Application/chrome.exe';
  const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']].filter((root): root is string => !!root);
  for (const root of roots) {
    const executable = path.join(root, relative);
    try { await fs.access(executable); } catch { continue; }
    await new Promise<void>((resolve, reject) => { const child = spawn(executable, [url], { detached: true, stdio: 'ignore', windowsHide: false, shell: false }); child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); }); }); return;
  }
  throw new Error(`${browser === 'edge' ? 'Microsoft Edge' : 'Google Chrome'} is niet gevonden. Kies de standaardbrowser.`);
}
async function start(): Promise<void> {
  const dataRoot = process.env.FTP_STUDIO_DATA_DIR || app.getPath('userData');
  await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });
  store = new SqliteStore(path.join(dataRoot, 'studio.db'));
  const bounds = store.get<{ width: number; height: number }>('windowBounds', { width: 1540, height: 980 });
  window = new BrowserWindow({ width: Math.max(1100, Math.min(3000, bounds.width)), height: Math.max(720, Math.min(2000, bounds.height)), minWidth: 1050, minHeight: 680, title: 'FTP Studio', backgroundColor: '#15171b', show: false, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, spellcheck: false, devTools: !app.isPackaged } });
  Menu.setApplicationMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.on('will-download', event => event.preventDefault());
  window.webContents.on('will-prevent-unload', event => {
    // Native synchronous prompt is intentional: Electron requires deciding before this event returns.
    const answer = dialog.showMessageBoxSync(window!, { type: 'warning', title: 'Niet-opgeslagen wijzigingen', message: 'Er staan nog gewijzigde documenten open. Sluiten met lokale herstelkopieën?', detail: 'Kies Annuleren om eerst op te slaan. Herstelkopieën bevatten de laatst automatisch bewaarde bewerkingen.', buttons: ['Annuleren', 'Sluiten'], defaultId: 0, cancelId: 0 });
    if (answer === 1) event.preventDefault();
  });
  service = new StudioService(store, new CredentialVault(store, safeStorage), dataRoot, {
    chooseFolder: async () => { const result = await dialog.showOpenDialog(window!, { title: 'Lokale projectmap kiezen', properties: ['openDirectory', 'createDirectory'] }); return result.canceled ? null : result.filePaths[0] ?? null; },
    chooseFile: async title => { const result = await dialog.showOpenDialog(window!, { title: title || 'Bestand kiezen', properties: ['openFile'] }); return result.canceled ? null : result.filePaths[0] ?? null; },
    confirm, openBrowser,
  }, (event, value) => { if (window && !window.isDestroyed()) window.webContents.send(`studio:${event}`, value); });
  ipcMain.handle('studio:invoke', async (event, command: keyof Api, args: unknown) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== indexUrl) throw new Error('Desktopopdracht van onbekende bron geweigerd.');
    try { return await service!.invoke(command, args as never); }
    catch (error) { const message = error instanceof Error ? error.message : 'Onbekende fout.'; service!.log('error', message); throw new Error(message); }
  });
  window.on('resize', () => { if (window && !window.isMaximized()) { const { width, height } = window.getBounds(); store?.set('windowBounds', { width, height }); } });
  window.on('closed', () => { window = undefined; });
  window.once('ready-to-show', () => window?.show());
  await window.loadFile(indexPath);
  if (process.env.FTP_STUDIO_SMOKE === '1') setTimeout(() => { void window?.webContents.executeJavaScript('window.ftp.invoke("bootstrap").then(x => ({projects:x.projects.length, theme:x.settings.theme}))').then(result => { console.log('FTP_STUDIO_SMOKE_OK', JSON.stringify(result)); app.quit(); }).catch(error => { console.error('FTP_STUDIO_SMOKE_FAILED', String(error)); app.exit(1); }); }, 500);
}
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
app.whenReady().then(start).catch(async error => { console.error('FTP Studio kon niet starten:', error instanceof Error ? error.message : 'Onbekende fout'); await dialog.showMessageBox({ type: 'error', title: 'FTP Studio', message: 'FTP Studio kon niet starten.', detail: error instanceof Error ? error.message : 'Onbekende fout' }); app.exit(1); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (closing || !service) return;
  event.preventDefault();
  // Let the renderer's beforeunload confirmation finish before shutting down the engine.
  if (window && !window.isDestroyed()) { window.close(); return; }
  closing = true;
  void service.close().finally(() => { store?.close(); store = undefined; app.quit(); });
});
