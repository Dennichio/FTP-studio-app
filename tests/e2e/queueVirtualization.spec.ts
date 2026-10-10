import { test, expect, type Locator } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { SqliteStore } from '../../src/main/storage';
import type { AppSettings, PersistedQueueRecord } from '../../src/shared/contracts';

let application: ElectronApplication, page: Page, root: string, site: string;
const longError = Array.from({ length: 25 }, (_, index) => `Regel ${index + 1}: controleer de volledige foutmelding <img onerror="window.queueTextExecuted=true"> & oorspronkelijke bron.`).join('\n');

test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-queue-virtual-ui-'));
  site = path.join(root, 'site');
  await fs.mkdir(site);
  await fs.writeFile(path.join(site, 'source.txt'), 'Werkelijke lokale bron');
  // Seed genuine durable recovery/history records, then let the real service
  // restore and mutate them; no renderer events or IPC handlers are replaced.
  const store = new SqliteStore(path.join(root, 'data', 'studio.db'));
  try {
    const records: PersistedQueueRecord[] = Array.from({ length: 2000 }, (_, index) => ({ kind: 'file', job: {
      id: `queue-${String(index).padStart(4, '0')}`, connectionId: index < 1200 || index >= 1600 ? 'group-a' : 'group-b', direction: 'upload',
      localPath: path.join(site, 'source.txt'), remotePath: `/site/${index === 1199 ? 'long-error' : index >= 1600 ? 'paused-a' : index < 1200 ? 'finished-a' : 'finished-b'}-${index}.txt`,
      status: index === 1199 ? 'failed' : index >= 1600 ? 'paused' : 'completed', error: index === 1199 ? longError : undefined,
      size: 22, transferred: index >= 1600 ? 0 : 22, speed: 0, remainingSeconds: null, attempts: 1, createdAt: index + 1, priority: 50,
    } }));
    store.queue.commit(records, []);
    store.set('projects', [{ id: 'queue-project', name: 'Wachtrijcontrole', localRoot: site, remoteRoot: '/site', filters: { display: [], transfer: [], sync: [] }, environments: [], bookmarks: [] }]);
    const settings: AppSettings = { theme: 'dark', showHidden: false, syncNavigation: false, editorFontSize: 14, wordWrap: true, autoUpload: false, lastProjectId: 'queue-project', layout: { editorMode: 'code', browserHeight: 250, queueHeight: 245, queueExpanded: true } };
    store.set('settings', settings);
  } finally { store.close(); }
  application = await electron.launch({ executablePath: createRequire(path.resolve('package.json'))('electron') as string, args: [path.resolve('.')], env: { ...process.env, FTP_STUDIO_DATA_DIR: path.join(root, 'data') } });
  page = await application.firstWindow();
  await page.waitForSelector('.studio');
  await expect(panel().locator('.queue-filter')).toContainText('2000 overdrachten');
});

test.afterEach(async () => {
  await application?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

function panel() { return page.locator('.queue-panel'); }
function search() { return panel().getByLabel('Wachtrij of log doorzoeken', { exact: true }); }
function queueList() { return panel().getByRole('list', { name: 'Overdrachten', exact: true }); }
async function jobs() { return page.evaluate(async () => (await window.ftp.invoke('bootstrap', undefined)).queue); }
async function boundedRows(kind: '.job-row' | '.log-row') {
  await expect.poll(() => panel().locator(kind).count()).toBeGreaterThan(0);
  expect(await panel().locator(kind).count()).toBeLessThan(60);
}
async function firstVisible(list: Locator) {
  return list.evaluate(element => {
    const top = element.getBoundingClientRect().top;
    const row = Array.from(element.querySelectorAll<HTMLElement>('[data-virtual-id]')).find(candidate => candidate.getBoundingClientRect().bottom > top + 1);
    return row ? { id: row.dataset.virtualId!, y: row.getBoundingClientRect().top - top } : null;
  });
}

 test('two thousand persisted jobs stay bounded across keyboard, panel resize and complete filtered clear', async () => {
  await boundedRows('.job-row');
  const list = queueList();
  await list.focus();
  await page.keyboard.press('End');
  const last = panel().locator('[data-virtual-id="queue-1999"]');
  await expect(last).toBeFocused();
  await expect(last).toHaveAttribute('aria-posinset', '2000');
  await expect(last).toHaveAttribute('aria-setsize', '2000');
  await boundedRows('.job-row');
  await page.keyboard.press('Home');
  await expect(panel().locator('[data-virtual-id="queue-0000"]')).toBeFocused();
  const resize = page.getByRole('separator', { name: 'Wachtrijhoogte aanpassen', exact: true });
  const bounds = await resize.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y - 100, { steps: 5 });
  await page.mouse.up();
  await boundedRows('.job-row');
  await panel().getByRole('button', { name: 'Wachtrij maximaliseren', exact: true }).click();
  await boundedRows('.job-row');
  await panel().getByRole('button', { name: 'Wachtrij herstellen', exact: true }).click();
  await panel().getByLabel('Wachtrijverbinding filteren', { exact: true }).selectOption('group-a');
  await expect(panel().locator('.queue-filter')).toContainText('1600 overdrachten');
  await panel().getByRole('button', { name: 'Afgeronde overdrachten wissen', exact: true }).click();
  await expect.poll(async () => (await jobs()).length).toBe(800);
  expect((await jobs()).filter(job => job.connectionId === 'group-a')).toHaveLength(400);
  expect((await jobs()).filter(job => job.connectionId === 'group-b')).toHaveLength(400);
  await expect(panel().locator('.queue-filter')).toContainText('400 overdrachten');
  await boundedRows('.job-row');
});

 test('natural error heights stay readable and same-row Home never steals action focus after a real queue update', async () => {
  await search().fill('long-error');
  await expect(panel().locator('.job-error')).toHaveText(longError);
  const errorMetrics = await panel().locator('.job-error').evaluate(element => ({ overflow: getComputedStyle(element).overflow, whitespace: getComputedStyle(element).whiteSpace, height: element.getBoundingClientRect().height, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
  expect(errorMetrics.overflow).toBe('visible');
  expect(errorMetrics.whitespace).toBe('pre-wrap');
  expect(errorMetrics.height).toBeGreaterThan(200);
  expect(errorMetrics.scrollHeight).toBeLessThanOrEqual(errorMetrics.clientHeight + 1);
  expect(await page.evaluate(() => (window as unknown as { queueTextExecuted?: boolean }).queueTextExecuted)).toBeUndefined();
  await search().fill('paused-a');
  await expect(panel().locator('.queue-filter')).toContainText('400 overdrachten');
  await queueList().focus();
  await page.keyboard.press('Home');
  await expect(panel().locator('[data-virtual-id="queue-1600"]')).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('Tab');
  const resume = panel().locator('[data-job-id="queue-1600"]').getByRole('button', { name: 'Hervatten', exact: true });
  await expect(resume).toBeFocused();
  await page.evaluate(() => window.ftp.invoke('queueAction', { action: 'priority', priority: 100, ids: ['queue-1600'] }));
  await expect.poll(async () => (await jobs()).find(job => job.id === 'queue-1600')?.priority).toBe(100);
  // Await the actual coalesced renderer snapshot, not only durable backend state.
  await expect(panel().locator('[data-job-id="queue-1600"]').getByRole('button', { name: 'Hogere prioriteit', exact: true })).toBeDisabled();
  await expect(resume).toBeFocused();
  // Scrolling away retains the focused action instead of unmounting it.
  await queueList().evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(resume).toBeFocused();
  await boundedRows('.job-row');
  await queueList().focus();
  await page.keyboard.press('End');
  await expect(panel().locator('[data-virtual-id="queue-1999"]')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(panel().locator('[data-job-id="queue-1998"]').getByRole('button', { name: 'Annuleren', exact: true })).toBeFocused();
});

 test('two thousand real filesystem errors keep log text safe, filters independent and bottom reading anchored on resize and prepend', async () => {
  const deepRoot = path.join(site, ...Array.from({ length: 3 }, (_, index) => `lange-map-${index}-${'m'.repeat(120)}`));
  await fs.mkdir(deepRoot, { recursive: true });
  await page.evaluate(async directory => {
    for (let start = 0; start < 2000; start += 40) await Promise.all(Array.from({ length: 40 }, async (_, offset) => {
      const suffix = `${directory}/missing-${String(start + offset).padStart(4, '0')}-<img onerror="window.queueTextExecuted=true">-${'lange-fouttekst-'.repeat(7)}`;
      try { await window.ftp.invoke('listLocal', { path: suffix }); } catch { /* Real missing-path errors are logged by the main process. */ }
    }));
  }, deepRoot);
  await panel().getByRole('button', { name: /^Activiteitenlog/ }).click();
  await expect(panel().locator('.queue-filter')).toContainText('2000 meldingen');
  await boundedRows('.log-row');
  const list = panel().getByRole('list', { name: 'Activiteitenmeldingen', exact: true });
  await list.focus();
  await page.keyboard.press('End');
  await expect(panel().locator('.queue-virtual-row:focus')).toHaveAttribute('aria-posinset', '2000');
  await boundedRows('.log-row');
  await list.evaluate(element => { element.scrollTop = element.scrollHeight - element.clientHeight - 250; });
  const anchor = await firstVisible(list);
  expect(anchor).not.toBeNull();
  const originalBounds = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  await application.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setSize(Math.min(2300, bounds.width + 400), bounds.height), originalBounds);
  await expect.poll(async () => (await firstVisible(list))?.id).toBe(anchor!.id);
  await expect.poll(async () => Math.abs(((await firstVisible(list))?.y ?? 10000) - anchor!.y)).toBeLessThan(3);
  const beforePrepend = await firstVisible(list);
  await page.evaluate(async directory => { try { await window.ftp.invoke('listLocal', { path: `${directory}/new-log-entry` }); } catch { /* Real error prepends one log row. */ } }, deepRoot);
  await expect.poll(async () => (await firstVisible(list))?.id).toBe(beforePrepend!.id);
  await panel().getByLabel('Logniveau filteren', { exact: true }).selectOption('info');
  await expect(panel().getByText('Geen meldingen voor dit filter.', { exact: true })).toBeVisible();
  await panel().getByLabel('Logniveau filteren', { exact: true }).selectOption('error');
  await panel().getByLabel('Wachtrijverbinding filteren', { exact: true }).selectOption('group-a');
  await expect(panel().getByText('Geen meldingen voor dit filter.', { exact: true })).toBeVisible();
  await panel().getByLabel('Wachtrijverbinding filteren', { exact: true }).selectOption('all');
  await search().fill('missing-1000-');
  await expect(panel().locator('.queue-filter')).toContainText('1 meldingen');
  await expect(panel().locator('.log-row')).toContainText('<img onerror="window.queueTextExecuted=true">');
  await expect(panel().locator('.log-row img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { queueTextExecuted?: boolean }).queueTextExecuted)).toBeUndefined();
});
