import { test, expect, type Locator } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { FilterSet } from '../../src/shared/contracts';

let application: ElectronApplication;
let page: Page;
let root: string;
const originalFilters: FilterSet = {
  display: [{ id: 'display-rule', action: 'exclude', field: 'name', operator: 'glob', value: 'hidden*' }],
  transfer: [{ id: 'transfer-rule', action: 'exclude', field: 'path', operator: 'glob', value: '**/draft/**' }],
  sync: [{ id: 'sync-rule', action: 'exclude', field: 'extension', operator: 'equals', value: 'bak' }],
};

test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-filter-profiles-'));
  const site = path.join(root, 'site');
  await fs.mkdir(site);
  await fs.writeFile(path.join(site, 'index.php'), '<?php echo "Filtercontrole";');
  application = await electron.launch({ executablePath: createRequire(path.resolve('package.json'))('electron') as string, args: [path.resolve('.')], env: { ...process.env, FTP_STUDIO_DATA_DIR: path.join(root, 'data') } });
  page = await application.firstWindow();
  await page.waitForSelector('.studio');
  await page.evaluate(async ({ localRoot, filters }) => {
    await window.ftp.invoke('saveProject', { project: { id: 'filter-project', name: 'Filtercontrole', localRoot, remoteRoot: '/', filters, environments: [], bookmarks: [] } });
    const state = await window.ftp.invoke('bootstrap', undefined);
    await window.ftp.invoke('saveSettings', { settings: { ...state.settings, lastProjectId: 'filter-project' } });
  }, { localRoot: site, filters: originalFilters });
  await page.reload();
  await page.waitForSelector('.studio');
});

test.afterEach(async () => {
  await application?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function openSettings() {
  await page.getByRole('button', { name: 'Projectinstellingen', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Projectinstellingen', exact: true });
  await dialog.getByText('Filters en uitsluitingen', { exact: true }).click();
  return dialog;
}

async function scope(dialog: Locator, value: keyof FilterSet) {
  await dialog.getByLabel('Filterbereik', { exact: true }).selectOption(value);
  return dialog.getByLabel('Filterwaarde', { exact: true });
}

async function savedProject() {
  return page.evaluate(async () => (await window.ftp.invoke('bootstrap', undefined)).projects.find(project => project.id === 'filter-project')!);
}

async function saveProject(dialog: Locator) {
  await dialog.getByRole('button', { name: 'Project opslaan', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

async function createProfile(dialog: Locator, name: string) {
  await dialog.getByLabel('Naam nieuw filterprofiel', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: 'Huidige filters als profiel bewaren', exact: true }).click();
  await expect(dialog.getByLabel('Naam geselecteerd filterprofiel', { exact: true })).toHaveValue(name.trim());
}

test('named snapshots preserve independent scopes and require confirmation before replacing rules', async () => {
  const dialog = await openSettings();
  await createProfile(dialog, ' Webpublicatie ');
  await dialog.getByLabel('Naam nieuw filterprofiel', { exact: true }).fill('webpublicatie');
  await dialog.getByRole('button', { name: 'Huidige filters als profiel bewaren', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('Er bestaat al een filterprofiel met deze naam.');

  const changes = { display: 'hidden-edited*', transfer: '**/private/**', sync: 'tmp' };
  for (const key of ['display', 'transfer', 'sync'] as const) await (await scope(dialog, key)).fill(changes[key]);
  await dialog.getByRole('button', { name: 'Filterprofiel toepassen', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Filterprofiel toepassen', exact: true });
  await expect(confirmation).toContainText('weergave, overdracht en synchronisatie');
  await confirmation.getByRole('button', { name: 'Annuleren', exact: true }).click();
  for (const key of ['display', 'transfer', 'sync'] as const) await expect(await scope(dialog, key)).toHaveValue(changes[key]);

  await dialog.getByRole('button', { name: 'Filterprofiel toepassen', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Filters vervangen', exact: true }).click();
  for (const key of ['display', 'transfer', 'sync'] as const) await expect(await scope(dialog, key)).toHaveValue(originalFilters[key][0].value);
  // Editing an applied rule must not mutate the saved snapshot or either other scope.
  await (await scope(dialog, 'display')).fill('after-apply*');
  await saveProject(dialog);
  const saved = await savedProject();
  expect(saved.filterProfiles).toHaveLength(1);
  expect(saved.filterProfiles![0]).toMatchObject({ name: 'Webpublicatie', filters: originalFilters });
  expect(saved.filters.display[0].value).toBe('after-apply*');
  expect(saved.filters.transfer).toEqual(originalFilters.transfer);
  expect(saved.filters.sync).toEqual(originalFilters.sync);

  await page.reload();
  await page.waitForSelector('.studio');
  const reopened = await openSettings();
  await reopened.getByLabel('Opgeslagen filterprofiel', { exact: true }).selectOption({ label: 'Webpublicatie' });
  await expect(reopened.getByLabel('Naam geselecteerd filterprofiel', { exact: true })).toHaveValue('Webpublicatie');
  await reopened.getByRole('button', { name: 'Annuleren', exact: true }).click();
});

test('profile rename and delete persist only when the project is saved, and cancel keeps active rules', async () => {
  let dialog = await openSettings();
  await createProfile(dialog, 'Alleen eigen regels');
  await saveProject(dialog);
  const original = await savedProject();
  const profileId = original.filterProfiles![0].id;

  dialog = await openSettings();
  await dialog.getByLabel('Opgeslagen filterprofiel', { exact: true }).selectOption(profileId);
  await dialog.getByLabel('Naam geselecteerd filterprofiel', { exact: true }).fill('Tijdelijke naam');
  await dialog.getByRole('button', { name: 'Filterprofiel hernoemen', exact: true }).click();
  await (await scope(dialog, 'transfer')).fill('unsaved*');
  await dialog.getByRole('button', { name: 'Filterprofiel verwijderen', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Filterprofiel verwijderen', exact: true })).toHaveCount(0);
  await expect(await scope(dialog, 'transfer')).toHaveValue('unsaved*');
  await dialog.getByRole('button', { name: 'Annuleren', exact: true }).click();
  expect(await savedProject()).toEqual(original);

  dialog = await openSettings();
  await dialog.getByLabel('Opgeslagen filterprofiel', { exact: true }).selectOption(profileId);
  await dialog.getByLabel('Naam geselecteerd filterprofiel', { exact: true }).fill('Hernoemd profiel');
  await dialog.getByRole('button', { name: 'Filterprofiel hernoemen', exact: true }).click();
  await saveProject(dialog);
  expect((await savedProject()).filterProfiles![0]).toMatchObject({ id: profileId, name: 'Hernoemd profiel', filters: originalFilters });
  await page.reload();
  await page.waitForSelector('.studio');
  dialog = await openSettings();
  await dialog.getByLabel('Opgeslagen filterprofiel', { exact: true }).selectOption({ label: 'Hernoemd profiel' });
  await dialog.getByRole('button', { name: 'Filterprofiel verwijderen', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Filterprofiel verwijderen', exact: true });
  await confirmation.getByRole('button', { name: 'Annuleren', exact: true }).click();
  await expect(dialog.getByLabel('Opgeslagen filterprofiel', { exact: true })).toHaveValue(profileId);
  await dialog.getByRole('button', { name: 'Filterprofiel verwijderen', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Verwijderen', exact: true }).click();
  await expect(dialog.getByLabel('Opgeslagen filterprofiel', { exact: true }).locator('option')).toHaveCount(1);
  for (const key of ['display', 'transfer', 'sync'] as const) await expect(await scope(dialog, key)).toHaveValue(originalFilters[key][0].value);
  await saveProject(dialog);
  expect((await savedProject()).filterProfiles).toEqual([]);
  expect((await savedProject()).filters).toEqual(originalFilters);
});

test('pending save and native folder picker freeze the project draft and guard every close route', async () => {
  let dialog = await openSettings();
  await dialog.locator('summary').first().focus();
  await page.keyboard.press('Tab');
  await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement) && document.activeElement?.getAttribute('title') !== 'Sluiten')).toBe(true);
  await createProfile(dialog, 'Tijdens opslaan');
  // Hold the real save response after its handler has persisted the project.
  // The test controls timing only; validation and storage still run unchanged.
  await application.evaluate(({ ipcMain }) => {
    const main = ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> };
    const original = main._invokeHandlers.get('studio:invoke')!;
    let release!: () => void;
    const heldResponse = new Promise<void>(resolve => { release = resolve; });
    (globalThis as unknown as { releaseProjectSave: () => void }).releaseProjectSave = release;
    ipcMain.removeHandler('studio:invoke');
    ipcMain.handle('studio:invoke', async (event, command, args) => {
      const result = await original(event, command, args);
      if (command === 'saveProject') await heldResponse;
      return result;
    });
  });
  await dialog.getByRole('button', { name: 'Project opslaan', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Opslaan…', exact: true })).toBeDisabled();
  for (const control of await dialog.locator('input,select,textarea').all()) await expect(control).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Huidige filters als profiel bewaren', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Filterprofiel toepassen', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Filterprofiel hernoemen', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Filterprofiel verwijderen', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Annuleren', exact: true })).toBeDisabled();
  const closeButton = dialog.getByRole('button', { name: 'Sluiten', exact: true });
  await closeButton.focus();
  await page.keyboard.press('Tab');
  await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Shift+Tab');
  await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await dialog.getByRole('button', { name: 'Sluiten', exact: true }).click();
  await page.locator('.modal-backdrop').click({ position: { x: 1, y: 1 } });
  await expect(dialog).toBeVisible();
  await application.evaluate(() => (globalThis as unknown as { releaseProjectSave: () => void }).releaseProjectSave());
  await expect(dialog).toHaveCount(0);
  expect((await savedProject()).filterProfiles![0].name).toBe('Tijdens opslaan');

  dialog = await openSettings();
  // Supply a delayed cancellation of the native picker, as other desktop tests
  // replace native picker choices; no filesystem or service result is replaced.
  await application.evaluate(({ dialog: nativeDialog }) => {
    nativeDialog.showOpenDialog = async () => new Promise(resolve => {
      (globalThis as unknown as { cancelProjectFolderPicker: () => void }).cancelProjectFolderPicker = () => resolve({ canceled: true, filePaths: [] });
    });
  });
  await dialog.getByRole('button', { name: 'Map kiezen', exact: true }).click();
  await expect(dialog.getByLabel('Projectnaam', { exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Project opslaan', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await dialog.getByRole('button', { name: 'Sluiten', exact: true }).click();
  await expect(dialog).toBeVisible();
  await application.evaluate(() => (globalThis as unknown as { cancelProjectFolderPicker: () => void }).cancelProjectFolderPicker());
  await expect(dialog.getByLabel('Projectnaam', { exact: true })).toBeEnabled();
  await expect(dialog.getByLabel('Lokale hoofdmap', { exact: true })).toHaveValue(path.join(root, 'site'));
  await dialog.getByRole('button', { name: 'Annuleren', exact: true }).click();
});
