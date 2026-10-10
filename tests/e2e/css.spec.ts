import { test, expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
let application: ElectronApplication, page: Page, root: string, site: string;
const html = '<!doctype html>\r\n<html><head><link rel="stylesheet" href="style.css?v=4"><style>button { border-radius: 8px; }</style></head><body><button class="primary">Eerste</button><button class="primary">Tweede</button></body></html>\r\n';
const css = '/* Bron behouden */\r\n.primary { color: rgb(255, 0, 0) !important; padding: 8px; }\r\n';
test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ftp-css-desktop-')); site = path.join(root, 'site'); await fs.mkdir(site);
  await fs.writeFile(path.join(site, 'index.html'), html); await fs.writeFile(path.join(site, 'style.css'), css);
  application = await electron.launch({ executablePath: createRequire(path.resolve('package.json'))('electron') as string, args: [path.resolve('.')], env: {...process.env, FTP_STUDIO_DATA_DIR:path.join(root,'data')} });
  page = await application.firstWindow(); await page.waitForSelector('.studio');
  await page.evaluate(async localRoot => {
    await window.ftp.invoke('saveProject',{project:{id:'css-project',name:'CSS desktop',localRoot,remoteRoot:'/',filters:{display:[],transfer:[],sync:[]},environments:[],bookmarks:[]}});
    const state=await window.ftp.invoke('bootstrap',undefined);
    await window.ftp.invoke('saveSettings',{settings:{...state.settings,lastProjectId:'css-project',layout:{editorMode:'split'}}});
  },site);
  await page.reload();await page.waitForSelector('.studio');
});
test.afterEach(async()=>{if(application){await application.evaluate(({dialog})=>{dialog.showMessageBoxSync=()=>1;}).catch(()=>{});await application.close();}if(root)await fs.rm(root,{recursive:true,force:true});});

test('visual selection locates external CSS, reviews shared impact and preserves original source',async()=>{
 const local=page.locator('.file-pane[aria-label="Lokale bestanden"]');
 await local.locator('.file-row[role="option"]').filter({hasText:'index.html'}).dblclick();
 const canvas=page.frameLocator('iframe[title="Veilige websitepreview"]');
 await expect(canvas.getByRole('button',{name:'Eerste',exact:true})).toHaveCSS('color','rgb(255, 0, 0)');
 await canvas.getByRole('button',{name:'Eerste',exact:true}).click();
 await page.getByRole('button',{name:'CSS van geselecteerd element',exact:true}).click();
 const rules=page.getByLabel('CSS-regel');
 await expect(rules.locator('option')).toHaveCount(3);
 const external=await rules.locator('option').filter({hasText:'.primary · style.css:2'}).getAttribute('value');
 expect(external).toBeTruthy();await rules.selectOption(external!);
 await expect(page.getByText('2 elementen in dit document passen bij deze selector.',{exact:true})).toBeVisible();
 await page.getByRole('textbox',{name:'CSS color',exact:true}).fill('rgb(0, 128, 0)');
 await page.getByRole('textbox',{name:'CSS color',exact:true}).press('Tab');
 const review=page.getByRole('group',{name:'CSS-wijziging controleren'});
 await expect(review).toContainText('2 passende elementen');
 expect(await fs.readFile(path.join(site,'style.css'),'utf8')).toBe(css);
 await expect(canvas.getByRole('button',{name:'Eerste',exact:true})).toHaveCSS('color','rgb(255, 0, 0)');
 await review.getByRole('button',{name:'Wijziging toepassen',exact:true}).click();
 await expect(page.locator('.editor-tab').filter({hasText:'style.css'}).locator('.tab-close')).toHaveClass(/dirty/);
 await expect(canvas.getByRole('button',{name:'Tweede',exact:true})).toHaveCSS('color','rgb(0, 128, 0)');
 expect(await fs.readFile(path.join(site,'style.css'),'utf8')).toBe(css);
 await rules.selectOption(external!);
 await page.getByRole('button',{name:'Naar CSS-bron',exact:true}).click();
 await expect(page.locator('.editor-tab.active')).toContainText('style.css');
 await expect(page.locator('.statusbar')).toContainText('Ln 2,');
 await page.getByRole('button',{name:'Opslaan (Ctrl+S)',exact:true}).click();
 await expect(page.locator('.editor-tab').filter({hasText:'style.css'}).locator('.tab-close')).not.toHaveClass(/dirty/);
 await expect.poll(async()=>{
  try{return await fs.readFile(path.join(site,'style.css'),'utf8');}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
 }).toBe(css.replace('rgb(255, 0, 0)','rgb(0, 128, 0)'));
 expect(await fs.readFile(path.join(site,'index.html'),'utf8')).toBe(html);
 await page.locator('.editor-tab').filter({hasText:'index.html'}).click();
 await expect(page.getByLabel('Preview-browser')).toHaveValue('default');
 await expect(canvas.getByRole('button',{name:'Eerste',exact:true})).toHaveCSS('color','rgb(0, 128, 0)');
 await canvas.getByRole('button',{name:'Eerste',exact:true}).click();await page.getByRole('button',{name:'CSS van geselecteerd element',exact:true}).click();await rules.selectOption(external!);
 await fs.mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/FTP-Studio-desktop.png'});
});
