import { readFileSync, existsSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { run } from './queue-assertions.mjs';
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) { const url = new URL(specifier, context.parentURL); if (existsSync(fileURLToPath(url) + '.ts')) return next(url.href + '.ts', context); }
  return next(specifier, context);
}, load(url, context, next) {
  if (url.startsWith('file:') && url.endsWith('.ts')) return { format: 'module', source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), { mode: 'transform' }), shortCircuit: true };
  return next(url, context);
} });
const filename = new URL('../tests/queue.test.ts', import.meta.url);
const code = stripTypeScriptTypes(readFileSync(filename, 'utf8'), { mode: 'transform' })
  .replace("from 'vitest'", `from '${new URL('./queue-assertions.mjs', import.meta.url).href}'`)
  .replace("from '../src/main/queue'", `from '${new URL('../src/main/queue.ts', import.meta.url).href}'`);
await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
await run();
