import { build } from 'esbuild';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
// Monaco ships its own DOMPurify source. npm overrides alone do not replace it.
// Resolve this exact import to the explicitly pinned, patched runtime package.
const patchedMonacoSanitizer = {
  name: 'patched-monaco-sanitizer',
  setup(builder) {
    builder.onResolve({ filter: /dompurify\/dompurify\.js$/ }, async args => {
      if (!args.importer.replaceAll('\\', '/').endsWith('/monaco-editor/esm/vs/base/browser/domSanitize.js')) return;
      return builder.resolve('dompurify', { kind: 'import-statement', resolveDir: process.cwd() });
    });
  }
};
await rm('dist', { recursive: true, force: true });
await mkdir('dist/main', { recursive: true });
await mkdir('dist/renderer', { recursive: true });
await build({ entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.cjs', bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['electron', 'ssh2', 'ssh2-sftp-client', 'basic-ftp'], sourcemap: true });
await build({ entryPoints: ['src/main/preload.ts'], outfile: 'dist/main/preload.cjs', bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['electron'], sourcemap: true });
const renderer = await build({ entryPoints: ['src/renderer/main.tsx'], outfile: 'dist/renderer/app.js', bundle: true, platform: 'browser', target: 'chrome136', format: 'iife', sourcemap: true, minify: true, metafile: true, plugins: [patchedMonacoSanitizer], loader: { '.ttf': 'file', '.woff': 'file', '.woff2': 'file', '.svg': 'file' }, define: { 'process.env.NODE_ENV': '"production"' }, assetNames: 'assets/[name]-[hash]' });
const bundled = Object.keys(renderer.metafile.inputs).map(input => input.replaceAll('\\', '/'));
if (bundled.some(input => input.includes('/monaco-editor/esm/vs/base/browser/dompurify/')) || !bundled.some(input => input.endsWith('/dompurify/dist/purify.es.mjs'))) {
  throw new Error('De renderer gebruikt niet uitsluitend de bijgewerkte DOMPurify-afhankelijkheid.');
}
const sanitizerVersion = JSON.parse(await readFile('node_modules/dompurify/package.json', 'utf8')).version;
if (sanitizerVersion !== '3.4.16') throw new Error('Controleer de gewijzigde DOMPurify-versie vóór publicatie.');
await writeFile('dist/renderer/dependency-inputs.json', JSON.stringify({ dompurify: sanitizerVersion, inputs: bundled.filter(input => input.includes('dompurify')) }, null, 2));
async function buildWorker(entry, outfile) {
  const worker = await build({ entryPoints: [entry], outfile, bundle: true, platform: 'browser', target: 'chrome136', format: 'iife', minify: true, metafile: true });
  if (Object.keys(worker.metafile.inputs).some(input => input.replaceAll('\\', '/').includes('/dompurify/'))) {
    throw new Error('Een editorworker importeert onverwacht een browser-sanitizer. Controleer deze dependency vóór publicatie.');
  }
}
await buildWorker('monaco-editor/esm/vs/editor/editor.worker.js', 'dist/renderer/editor.worker.js');
for (const language of ['html', 'css', 'json', 'typescript']) {
  const name = language === 'typescript' ? 'ts' : language;
  await buildWorker(`monaco-editor/esm/vs/language/${language}/${name}.worker.js`, `dist/renderer/${name}.worker.js`);
}
const nonce = randomBytes(24).toString('base64');
const csp = `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; frame-src about:; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'`;
const html = (await readFile('src/renderer/index.html', 'utf8')).replace('./main.tsx', './app.js').replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="ftp-preview-nonce" content="${nonce}">`).replace('</head>', '<link rel="stylesheet" href="./app.css"></head>');
await writeFile('dist/renderer/index.html', html);
console.log('FTP Studio desktop en editor gebouwd.');
