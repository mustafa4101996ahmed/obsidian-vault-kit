// Shared test harness. Extracted from suite.mjs so a second suite can use the same
// assertions and the same throwaway-HOME discipline rather than growing a second copy.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const IS_WIN = process.platform === 'win32';

// The repo root, derived from this file's own URL rather than process.cwd() --
// the same trick suite.mjs already used before this file existed. A bare
// path.resolve('lib/x.mjs') only finds the right file when the suite happens to be
// run from the repo root; from any other cwd it resolves to nothing. Both new
// suites used to do exactly that, which is why they only worked from one directory.
export const KIT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Turns a repo-relative path into an import specifier that works on every platform.
// A bare absolute path happens to work as one on POSIX, but not on Windows: an
// import of "D:\a\...\lib\platform.mjs" is not valid ESM syntax and Node throws
// before the driver script it's embedded in ever runs. A file:// URL is valid
// everywhere, so every generated driver builds its imports through this instead.
export function moduleUrl(relPath) {
  return pathToFileURL(path.join(KIT, relPath)).href;
}

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
export function makeHome(tag = 'vault-kit-test-', { withoutAgents = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), tag));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  if (withoutAgents) env.PATH = pathWithoutAgents(env.PATH);
  return { home, env };
}

/**
 * The same PATH with every directory holding an agent CLI removed.
 *
 * A throwaway HOME hides `~/.claude` and `~/.codex`, but detection also looks on PATH,
 * so a test asserting "this host is absent" quietly inverts its meaning on a machine
 * where the CLI happens to be installed. That is not hypothetical: installing Codex
 * locally turned four passing assertions red, the mirror of a CI run finding neither
 * agent. A suite whose verdict depends on what the developer has installed is not a
 * suite. Removing the directory is the only way to make a CLI genuinely absent —
 * PATH order cannot hide a binary.
 */
function pathWithoutAgents(current) {
  const sep = IS_WIN ? ';' : ':';
  const names = IS_WIN ? ['claude.cmd', 'claude.exe', 'codex.cmd', 'codex.exe'] : ['claude', 'codex'];
  return (current || '')
    .split(sep)
    .filter((dir) => dir && !names.some((n) => fs.existsSync(path.join(dir, n))))
    .join(sep);
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

// A synchronous sleep for the straight-line teardown below: these are plain scripts,
// not async, so threading a Promise through every call site just to wait a few
// hundred ms isn't worth it. Blocking the main thread on Atomics.wait is fine here --
// Node (unlike a browser) allows it, and nothing else needs to run in the meantime.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Deletes a throwaway HOME, retrying through the Windows window where a process the
 * watchdog just killed hasn't yet released its cwd handle -- and, for a .cmd shim
 * routed through cmd.exe, where the real node grandchild can briefly outlive the
 * killed parent. rmSync then fails with EBUSY even though nothing is wrong: the
 * handle clears on its own within a few hundred ms once the OS reaps the process, so
 * a handful of short retries is enough on every platform this has been seen on.
 *
 * If it still won't go, this warns and RETURNS NORMALLY instead of throwing -- on
 * purpose. The guard this prevents: a fully-green suite reported as failed because
 * the OS was slow to let go of a temp directory, which would point whoever reads the
 * CI log at a product defect that was never there. A suite's verdict belongs to its
 * assertions, not to teardown, and a directory left behind under the system temp dir
 * on an ephemeral CI runner costs nothing. */
export function removeHome(home, { retries = 5, delayMs = 300 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.rmSync(home, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt >= retries) {
        console.warn(`warning: could not remove ${home} (${err.code}): ${err.message}`);
        return;
      }
      sleepSync(delayMs);
    }
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
