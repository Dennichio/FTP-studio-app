// A narrow Node assert adapter for queue.test.ts when npm/Vitest is unavailable.
// This is explicitly not a Vitest execution or a replacement for the complete suite.
import assert from 'node:assert/strict';
const cases = []; let cleanup = async () => {};
export const afterEach = fn => { cleanup = fn; };
export const describe = (_name, fn) => fn();
export const it = (name, fn) => cases.push({ name, fn });
export function expect(actual) {
  return {
    toBe: expected => assert.equal(actual, expected),
    toBeUndefined: () => assert.equal(actual, undefined),
    toEqual: expected => assert.deepEqual(actual, expected),
    toHaveLength: expected => assert.equal(actual.length, expected),
    toContain: expected => assert(actual.includes(expected)),
    toMatch: expected => assert.match(actual, expected),
    toMatchObject: expected => { for (const [key, value] of Object.entries(expected)) assert.deepEqual(actual[key], value); },
    not: { toContain: expected => assert(!actual.includes(expected)) },
    rejects: { toThrow: expected => assert.rejects(actual, error => typeof expected === 'string' ? error.message.includes(expected) : expected.test(error.message)) },
  };
}
export async function run() {
  let failed = 0;
  for (const { name, fn } of cases) { try { await fn(); console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}`, error); } finally { await cleanup(); } }
  console.log(`${cases.length - failed}/${cases.length} queue test bodies passed using Node assert; Vitest not invoked.`);
  process.exitCode = failed ? 1 : 0;
}
