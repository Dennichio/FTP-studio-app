import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Uses the built-in Node 24 TS transformer. No dependency downloads or mock production modules.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const url = new URL(specifier, context.parentURL);
      if (!/\.[mc]?[jt]sx?$/.test(url.pathname) && existsSync(fileURLToPath(url) + '.ts')) return nextResolve(url.href + '.ts', context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && /\.(?:ts|mts)$/.test(new URL(url).pathname)) return { format: 'module', source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), { mode: 'transform', sourceUrl: url }), shortCircuit: true };
    return nextLoad(url, context);
  },
});
await import('../tests/offline-checks.mts');
