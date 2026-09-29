// Shared test harness. Extracted from suite.mjs so a second suite can use the same
// assertions and the same throwaway-HOME discipline rather than growing a second copy.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const IS_WIN = process.platform === 'win32';

let pass = 0; let fail = 0; let skip = 0;
const failures = [];

// Exported (beyond what the task interface requires) so suite.mjs's one plain banner
// line can keep its original colour instead of being reshaped to fit head()'s format.
export const C = process.stdout.isTTY
  ? { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', c: '\x1b[36m', z: '\x1b[0m' }
  : { g: '', r: '', y: '', c: '', z: '' };

export const head = (s) => console.log(`\n${C.c}=== ${s} ===${C.z}`);
export function ok(msg) { pass += 1; console.log(`  ${C.g}PASS${C.z}  ${msg}`); }
export function no(msg) { fail += 1; failures.push(msg); console.log(`  ${C.r}FAIL${C.z}  ${msg}`); }
export function na(msg) { skip += 1; console.log(`  ${C.y}SKIP${C.z}  ${msg}`); }

// Strict equality prevents coercion bugs: String(number) would silently pass a number
// vs string mismatch. All call sites compare like with like, so we tighten here.
export function eq(label, actual, expected) {
  if (actual === expected) ok(`${label} (${actual})`);
  else no(`${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}
export function truthy(label, value) { value ? ok(label) : no(label); }
export function has(label, haystack, needle) {
  String(haystack).includes(needle) ? ok(label) : no(`${label} (missing ${JSON.stringify(needle)})`);
}

// For an fs call (readlinkSync, statSync, ...) that throws ENOENT when the thing it
// reads was never created. Without this, a missing file crashes the whole suite with
// an uncaught exception instead of failing one assertion -- hiding every test after
// it behind a single line in the CI log.
export function tryOrNull(fn) { try { return fn(); } catch { return null; } }

/** has(), but a null value (from tryOrNull) fails as `label (note)` instead of
 * being stringified into "null" and compared against needle. */
export function hasOrNull(label, value, needle, note) {
  if (value === null) no(`${label} (${note})`);
  else has(label, value, needle);
}

/** A throwaway HOME, with USERPROFILE set too because os.homedir() reads it on Windows. */
export function makeHome(tag = 'vault-kit-test-') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), tag));
  return { home, env: { ...process.env, HOME: home, USERPROFILE: home } };
}

export function run(script, args = [], env = process.env, { timeout = 120000 } = {}) {
  try {
    const out = execFileSync(process.execPath, [script, ...args], {
      encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], timeout,
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? -1, out: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

export function summary(label = process.platform) {
  console.log(`\n${'-'.repeat(60)}`);
  console.log(`${label}: ${C.g}${pass} passed${C.z}, ${fail ? C.r : ''}${fail} failed${C.z}, ${C.y}${skip} skipped${C.z}`);
  if (fail) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(fail ? 1 : 0);
}
