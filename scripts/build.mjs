import { build } from 'esbuild';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
await rm('dist', { recursive: true, force: true });
await mkdir('dist/main', { recursive: true });
await mkdir('dist/renderer', { recursive: true });
await build({ entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.cjs', bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['electron', 'ssh2', 'ssh2-sftp-client', 'basic-ftp'], sourcemap: true });
await build({ entryPoints: ['src/main/preload.ts'], outfile: 'dist/main/preload.cjs', bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['electron'], sourcemap: true });
await build({ entryPoints: ['src/renderer/main.tsx'], outfile: 'dist/renderer/app.js', bundle: true, platform: 'browser', target: 'chrome136', format: 'iife', sourcemap: true, minify: true, loader: { '.ttf': 'file', '.woff': 'file', '.woff2': 'file', '.svg': 'file' }, define: { 'process.env.NODE_ENV': '"production"' }, assetNames: 'assets/[name]-[hash]' });
await build({ entryPoints: ['monaco-editor/esm/vs/editor/editor.worker.js'], outfile: 'dist/renderer/editor.worker.js', bundle: true, platform: 'browser', target: 'chrome136', format: 'iife', minify: true });
for (const language of ['html', 'css', 'json', 'typescript']) {
  const name = language === 'typescript' ? 'ts' : language;
  await build({ entryPoints: [`monaco-editor/esm/vs/language/${language}/${name}.worker.js`], outfile: `dist/renderer/${name}.worker.js`, bundle: true, platform: 'browser', target: 'chrome136', format: 'iife', minify: true });
}
const nonce = randomBytes(24).toString('base64');
const csp = `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; frame-src about:; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'`;
const html = (await readFile('src/renderer/index.html', 'utf8')).replace('./main.tsx', './app.js').replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="ftp-preview-nonce" content="${nonce}">`).replace('</head>', '<link rel="stylesheet" href="./app.css"></head>');
await writeFile('dist/renderer/index.html', html);
console.log('FTP Studio desktop en editor gebouwd.');
