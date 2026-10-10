import { test, expect, type Locator } from '@playwright/test';
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
let server: Awaited<ReturnType<typeof ftpFixture>>;
const connectionId = 'publishing-fixture';
const projectId = 'publishing-project';
const sourceFiles: Record<string, string> = {
  'index.php': '\uFEFF<?php\r\nrequire_once __DIR__ . "/parts/header.inc";\r\ninclude ".env"; include "node_modules/dev.php";\r\n?><link rel="stylesheet" href="styles/main.css?v=4"><script type="module" src="app.js"></script>\r\n',
  'parts/header.inc': '<?php include "footer.php"; ?><header>Werkelijke publicatie</header>\r\n',
  'parts/footer.php': '<?php /* statische include zonder uitvoering */ ?>\r\n',
  'styles/main.css': '@import "theme.css";\r\n.hero { background: url("../assets/background.png"); }\r\n',
  'styles/theme.css': '/* behouden */\r\n.hero { color: red !important; }\r\n',
  'assets/background.png': 'fixture asset bytes',
  'app.js': 'import "./module.js";\r\n',
  'module.js': 'export { value } from "./leaf.js";\r\n',
  'leaf.js': 'export const value = 42;\r\n',
  '.env': 'FIXTURE_SECRET=not-for-publication\r\n',
  'node_modules/dev.php': '<?php /* excluded development dependency */',
  'unrelated.txt': 'Niet automatisch geselecteerd',
  'race.txt': 'Lokale geplande versie\r\n',
  'production.txt': 'Alleen na bevestiging\r\n',
};
const dependencies = ['app.js', 'assets/background.png', 'index.php', 'leaf.js', 'module.js', 'parts/footer.php', 'parts/header.inc', 'styles/main.css', 'styles/theme.css'];

test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-publishing-desktop-'));
  site = path.join(root, 'site');
  for (const [relative, content] of Object.entries(sourceFiles)) {
    const filename = path.join(site, relative);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, content);
  }
  server = await ftpFixture({ supportsMlst: true, controlNoDelay: true });
  server.directories.add('/site'); server.directories.add('/production');
  application = await electron.launch({ executablePath: createRequire(path.resolve('package.json'))('electron') as string, args: [path.resolve('.')], env: { ...process.env, FTP_STUDIO_DATA_DIR: path.join(root, 'data') } });
  page = await application.firstWindow(); await page.waitForSelector('.studio');
  await page.evaluate(async args => {
    const profile = { id: args.connectionId, name: 'Publicatie testserver', protocol: 'ftp' as const, host: '127.0.0.1', port: args.port, username: 'test', localRoot: args.site, remoteRoot: '/', timeoutMs: 5000, connectionLimit: 4, parallelTransfers: 2, autoReconnect: false, passive: true };
    await window.ftp.invoke('connect', { profile, credentials: { password: 'test' } });
    await window.ftp.invoke('saveProject', { project: {
      id: args.projectId, name: 'Publicatiecontrole', profileId: args.connectionId, localRoot: args.site, remoteRoot: '/site',
      filters: { display: [], transfer: [], sync: [] }, bookmarks: [],
      environments: [{ id: 'production-fixture', name: 'Productie fixture', profileId: args.connectionId, remoteRoot: '/production', production: true }],
    } });
    const state = await window.ftp.invoke('bootstrap', undefined);
    await window.ftp.invoke('saveSettings', { settings: { ...state.settings, lastProjectId: args.projectId, showHidden: true, syncNavigation: false, layout: { editorMode: 'code', queueExpanded: true } } });
  }, { site, port: server.port, connectionId, projectId });
  await page.reload(); await page.waitForSelector('.studio');
  await expect(page.getByRole('button', { name: 'Publiceren', exact: true })).toBeEnabled();
  await expect(page.locator('.file-pane[aria-label="Lokale bestanden"]').getByRole('listbox')).toHaveAttribute('aria-busy', 'false');
});

test.afterEach(async () => {
  if (application) await application.close().catch(() => {});
  if (server) await server.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function selectedPlan(filename: string, environment?: string): Promise<Locator> {
  const local = page.locator('.file-pane[aria-label="Lokale bestanden"]');
  await local.getByRole('textbox', { name: 'Bestanden filteren' }).fill(filename);
  await local.locator('.file-row[role="option"]').filter({ hasText: filename }).click();
  await expect(local.locator('.file-row.selected')).toHaveCount(1);
  await page.getByRole('button', { name: 'Publiceren', exact: true }).click();
  const setup = page.getByRole('dialog', { name: 'Project publiceren', exact: true });
  await setup.getByLabel('Bestanden', { exact: true }).selectOption('selection');
  if (environment) await setup.getByLabel('Omgeving', { exact: true }).selectOption(environment);
  await expect(setup.getByLabel('Gerelateerde CSS, scripts, afbeeldingen en statische PHP-includes opnemen')).toBeChecked();
  await setup.getByRole('button', { name: 'Vergelijken en plan maken', exact: true }).click();
  const plan = page.getByRole('dialog', { name: 'Publicatieplan controleren', exact: true });
  await expect(plan).toBeVisible();
  return plan;
}
async function completedJobs(count: number) {
  await expect.poll(async () => page.evaluate(async () => (await window.ftp.invoke('bootstrap', undefined)).queue.filter(job => job.projectId === 'publishing-project').map(job => job.status))).toEqual(Array.from({ length: count }, () => 'completed'));
}

test('selected PHP page publishes its actual transitive CSS and JS dependencies while excluding secrets and unrelated files', async () => {
  const plan = await selectedPlan('index.php');
  for (const relative of dependencies) await expect(plan.getByRole('checkbox', { name: `${relative} selecteren`, exact: true })).toBeChecked();
  for (const relative of ['.env', 'node_modules']) {
    const checkbox = plan.getByRole('checkbox', { name: `${relative} selecteren`, exact: true });
    await expect(checkbox).toBeDisabled(); await expect(checkbox).not.toBeChecked();
  }
  await expect(plan.getByRole('checkbox', { name: 'node_modules/dev.php selecteren', exact: true })).toHaveCount(0);
  await expect(plan.getByRole('checkbox', { name: 'unrelated.txt selecteren', exact: true })).not.toBeChecked();
  await expect(plan.locator('.publish-item').filter({ hasText: 'parts/header.inc' })).toContainText('afhankelijkheid');
  await plan.getByText(/meldingen over afhankelijkheden/).click();
  await expect(plan.locator('details.notice')).toContainText('uitgesloten');
  expect(server.files.size).toBe(0); // Comparing and selecting never uploads.
  await plan.getByRole('button', { name: `${dependencies.length} bestanden overdragen`, exact: true }).click();
  await expect(plan).toHaveCount(0); await completedJobs(dependencies.length);
  expect([...server.files.keys()].sort()).toEqual(dependencies.map(relative => `/site/${relative}`).sort());
  for (const relative of dependencies) {
    expect(server.files.get(`/site/${relative}`)).toEqual(Buffer.from(sourceFiles[relative]));
    expect(await fs.readFile(path.join(site, relative))).toEqual(Buffer.from(sourceFiles[relative]));
  }
  await expect(page.locator('.queue-panel .job-row')).toHaveCount(dependencies.length);
});

test('a server file appearing after plan review becomes a queue conflict and is never overwritten', async () => {
  const plan = await selectedPlan('race.txt');
  await expect(plan.getByRole('checkbox', { name: 'race.txt selecteren', exact: true })).toBeChecked();
  const arrived = Buffer.from('Een andere gebruiker maakte dit serverbestand na de vergelijking.');
  server.files.set('/site/race.txt', arrived);
  await plan.getByRole('button', { name: '1 bestanden overdragen', exact: true }).click();
  await expect(plan).toHaveCount(0);
  await expect.poll(async () => page.evaluate(async () => (await window.ftp.invoke('bootstrap', undefined)).queue.find(job => job.remotePath === '/site/race.txt')?.status)).toBe('conflict');
  await expect(page.locator('.queue-panel .job-row').filter({ hasText: 'race.txt' })).toContainText('Conflict');
  expect(server.files.get('/site/race.txt')).toEqual(arrived);
  expect(server.commandCounts.get('STOR') ?? 0).toBe(0);
  expect(await fs.readFile(path.join(site, 'race.txt'), 'utf8')).toBe(sourceFiles['race.txt']);
});

test('production transfer requires exact typed confirmation and an affirmative native decision', async () => {
  // Only the OS confirmation response is controlled. The renderer, IPC, plan,
  // queue, local files and loopback FTP connection execute their real code.
  await application.evaluate(({ dialog }) => {
    const state = globalThis as typeof globalThis & { publishingConfirmation?: { response: number; titles: string[] } };
    state.publishingConfirmation = { response: 0, titles: [] };
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as { title?: string };
      state.publishingConfirmation!.titles.push(options.title || '');
      return { response: state.publishingConfirmation!.response, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  });
  const plan = await selectedPlan('production.txt', 'production-fixture');
  await expect(plan).toContainText('U publiceert naar productie.');
  const execute = plan.getByRole('button', { name: '1 bestanden overdragen', exact: true });
  const confirmation = plan.getByLabel('Typ PUBLICEREN om deze overdracht te bevestigen');
  await expect(execute).toBeDisabled();
  await confirmation.fill('publiceren'); await expect(execute).toBeDisabled();
  await confirmation.fill('PUBLICEREN'); await expect(execute).toBeEnabled();
  await execute.click();
  await expect(plan.locator('.modal-feedback')).toContainText('Productiepublicatie niet bevestigd');
  expect(server.files.size).toBe(0);
  expect(await page.evaluate(async () => (await window.ftp.invoke('bootstrap', undefined)).queue)).toEqual([]);
  expect(await application.evaluate(() => (globalThis as typeof globalThis & { publishingConfirmation: { titles: string[] } }).publishingConfirmation.titles)).toEqual(['Publiceren naar productie']);
  await application.evaluate(() => { (globalThis as typeof globalThis & { publishingConfirmation: { response: number } }).publishingConfirmation.response = 1; });
  await execute.click(); await expect(plan).toHaveCount(0); await completedJobs(1);
  expect([...server.files.keys()]).toEqual(['/production/production.txt']);
  expect(server.files.get('/production/production.txt')).toEqual(Buffer.from(sourceFiles['production.txt']));
});
