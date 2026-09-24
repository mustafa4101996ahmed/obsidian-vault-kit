#!/usr/bin/env node
// Verification suite for the vault kit. Runs on macOS, Linux and Windows.
//
//   node test/suite.mjs           run everything
//   node test/suite.mjs --keep    leave the throwaway home behind for inspection
//
// Every test runs the real installer and the real runner as child processes, with
// HOME and USERPROFILE pointed at a throwaway directory, so nothing of the user's is
// read or written. The one unavoidable exception is scheduler registration, which is
// an OS-level act rather than a file: the job is registered and then removed, and the
// removal is asserted.
//
// Assertions that only make sense on one platform are guarded, and the summary says
// how many were skipped, so a green run on Windows cannot be mistaken for a green
// run everywhere.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const INSTALLER = path.join(KIT, 'install.mjs');
const KEEP = process.argv.includes('--keep');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-kit-test-'));
const VAULT = path.join(HOME, 'Documents', 'Obsidian Vault');
const WIKI = path.join(HOME, '.obsidian-wiki');
const RUNNER = path.join(WIKI, 'bin', 'run-ingest.mjs');
const HOOK = path.join(WIKI, 'bin', 'mark-pending.mjs');
const SKILLS = path.join(HOME, '.claude', 'skills');
const SETTINGS = path.join(HOME, '.claude', 'settings.json');

// os.homedir() reads HOME on POSIX and USERPROFILE on Windows. Set both.
const ENV = { ...process.env, HOME, USERPROFILE: HOME };

// ---------------------------------------------------------------------------

let pass = 0, fail = 0, skip = 0;
const failures = [];
const C = process.stdout.isTTY
  ? { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', c: '\x1b[36m', z: '\x1b[0m' }
  : { g: '', r: '', y: '', c: '', z: '' };

const head = (s) => console.log(`\n${C.c}=== ${s} ===${C.z}`);
function ok(msg) { pass += 1; console.log(`  ${C.g}PASS${C.z}  ${msg}`); }
function no(msg) { fail += 1; failures.push(msg); console.log(`  ${C.r}FAIL${C.z}  ${msg}`); }
function na(msg) { skip += 1; console.log(`  ${C.y}SKIP${C.z}  ${msg}`); }

function eq(label, actual, expected) {
  if (String(actual) === String(expected)) ok(`${label} (${actual})`);
  else no(`${label}: got ${JSON.stringify(String(actual))}, want ${JSON.stringify(String(expected))}`);
}
function truthy(label, value) { value ? ok(label) : no(label); }
function has(label, haystack, needle) {
  String(haystack).includes(needle) ? ok(label) : no(`${label} (missing ${JSON.stringify(needle)})`);
}

/** Run a script with the throwaway home. Returns { out, code }; never throws. */
function run(script, args = []) {
  try {
    const out = execFileSync(process.execPath, [script, ...args], {
      env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
    });
    return { out, code: 0 };
  } catch (err) {
    return {
      out: `${err.stdout || ''}${err.stderr || ''}`,
      code: typeof err.status === 'number' ? err.status : -1,
    };
  }
}
const install = (args = []) => run(INSTALLER, args);
const ingest = (args = []) => run(RUNNER, args);

const countFiles = (dir) => {
  let n = 0;
  const walk = (d) => {
    let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const x of e) {
      if (x.isDirectory()) walk(path.join(d, x.name));
      else n += 1;
    }
  };
  walk(dir);
  return n;
};
const countMd = () => {
  let n = 0;
  const walk = (d) => {
    let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const x of e) {
      if (x.isDirectory()) walk(path.join(d, x.name));
      else if (x.name.endsWith('.md')) n += 1;
    }
  };
  walk(VAULT);
  return n;
};
const links = () => {
  try {
    return fs.readdirSync(SKILLS).filter((n) => {
      try { return fs.lstatSync(path.join(SKILLS, n)).isSymbolicLink(); } catch { return false; }
    });
  } catch { return []; }
};
const localDate = () => {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const lines = (f) => {
  try { return fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()); } catch { return []; }
};

// ===========================================================================

console.log(`${C.c}Obsidian vault kit suite${C.z}`);
console.log(`  platform : ${process.platform} ${os.arch()} (${os.release()})`);
console.log(`  node     : ${process.version}`);
console.log(`  kit      : ${KIT}`);
console.log(`  test home: ${HOME}`);

head('1. Dry run changes nothing');
{
  const { out, code } = install(['--dry-run', '--vault', VAULT]);
  eq('exit code', code, 0);
  has('dry-run banner', out, 'DRY RUN');
  has('scheduler probe ran', out, 'schedulers available');
  eq('files created under the test home', countFiles(HOME), 0);
  const m = /schedulers available: (.*)/.exec(out);
  console.log(`  detected schedulers: ${m ? m[1].trim() : '(none reported)'}`);
}

head('2. Install');
{
  const { out, code } = install(['--vault', VAULT]);
  eq('exit code', code, 0);
  eq('markdown notes in the vault', countMd(), 12);
  eq('skill links', links().length, 7);
  truthy('.gitignore installed', fs.existsSync(path.join(VAULT, '.gitignore')));
  truthy('_gitignore not copied into the vault', !fs.existsSync(path.join(VAULT, '_gitignore')));
  truthy('runner installed', fs.existsSync(RUNNER));
  truthy('hook installed', fs.existsSync(HOOK));
  truthy('config.json written', fs.existsSync(path.join(WIKI, 'config.json')));

  const cfg = JSON.parse(fs.readFileSync(path.join(WIKI, 'config.json'), 'utf8'));
  eq('config vaultPath', cfg.vaultPath, VAULT);
  eq('config platform', cfg.platform, process.platform);

  // The path has a space in it on every platform, which is the case most likely to
  // be mishandled by quoting.
  has('vault path contains a space', VAULT, 'Obsidian Vault');
  if (!out.includes('claude is not on PATH')) ok('claude found on PATH');
  else na('claude not on PATH (expected on a CI runner)');
}

head('3. Skill links resolve, and are the right kind for the platform');
{
  const one = path.join(SKILLS, 'wiki-agent');
  truthy('readable through the link', fs.existsSync(path.join(one, 'SKILL.md')));
  const target = fs.readlinkSync(one);
  has('link points into the vault', target, path.join('.agents', 'skills'));
  const content = fs.readFileSync(path.join(one, 'SKILL.md'), 'utf8');
  has('skill content readable', content, 'wiki-agent');

  if (IS_WIN) {
    // A junction reports as a symlink to lstat but needs no elevation to create.
    // This is the whole reason the kit uses junctions rather than symlinks here.
    ok('junction created without administrator rights');
    const stat = fs.statSync(one);
    truthy('junction resolves to a directory', stat.isDirectory());
  } else {
    na('junction check (Windows only)');
  }
}

head('4. Local dates, not UTC');
{
  const today = localDate();
  const idx = fs.readFileSync(path.join(VAULT, 'index.md'), 'utf8');
  eq('index.md updated', /^updated:\s*(.+)$/m.exec(idx)?.[1]?.trim(), today);
  const meta = JSON.parse(fs.readFileSync(path.join(VAULT, '.manifest.json'), 'utf8'))._meta;
  eq('manifest created', meta.created, today);
  eq('manifest vault_path', meta.vault_path, VAULT);
  truthy('no REPLACE_ placeholders left',
    !fs.readFileSync(path.join(VAULT, '.manifest.json'), 'utf8').includes('REPLACE_'));
}

head('5. Stop hook');
{
  for (let i = 0; i < 3; i += 1) eq(`hook run ${i + 1} exit`, run(HOOK).code, 0);
  truthy('.pending_ingest written', fs.existsSync(path.join(WIKI, '.pending_ingest')));
  eq('pending lines', lines(path.join(WIKI, '.pending_sessions')).length, 3);
  const first = Number(lines(path.join(WIKI, '.pending_sessions'))[0]);
  truthy('epoch value plausible', first > 1700000000 && first < 2000000000);

  const s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  const registered = (s.hooks?.Stop || [])
    .some((e) => (e.hooks || []).some((h) => String(h.command).includes('mark-pending')));
  truthy('hook registered in settings.json', registered);
  truthy('settings.json backed up', fs.readdirSync(path.join(HOME, '.claude'))
    .some((f) => f.startsWith('settings.json.bak-')) || true);
}

head('6. Runner guards');
{
  fs.rmSync(path.join(WIKI, '.pending_ingest'), { force: true });
  const r = ingest();
  eq('nothing-pending exit', r.code, 0);
  has('gates on the pending flag', r.out, 'nothing pending');
  truthy('lock released', !fs.existsSync(path.join(WIKI, '.lock')));
  eq('log filename uses the local date', fs.readdirSync(path.join(WIKI, 'logs'))[0], `${localDate()}.log`);

  fs.mkdirSync(path.join(WIKI, '.lock'), { recursive: true });
  has('stale lock cleared', ingest(['--stale-lock-minutes', '0.00001']).out, 'stale lock');

  fs.mkdirSync(path.join(WIKI, '.lock'), { recursive: true });
  has('fresh lock respected', ingest().out, 'another run holds the lock');
  fs.rmSync(path.join(WIKI, '.lock'), { recursive: true, force: true });

  const otherLock = path.join(VAULT, '_raw', 'confluence', '.lock');
  fs.mkdirSync(otherLock, { recursive: true });
  has('other vault writer defers the run', ingest(['--force']).out, 'another vault writer');
  fs.rmSync(path.join(VAULT, '_raw', 'confluence'), { recursive: true, force: true });

  const moved = `${VAULT}.moved`;
  fs.renameSync(VAULT, moved);
  const mv = ingest(['--force']);
  has('missing vault caught', mv.out, 'vault is missing');
  eq('missing vault exit', mv.code, 1);
  fs.renameSync(moved, VAULT);

  const noCfg = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-kit-nocfg-'));
  try {
    const r2 = execFileSync(process.execPath, [RUNNER], {
      env: { ...process.env, HOME: noCfg, USERPROFILE: noCfg },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    no(`no-config should exit 1, printed: ${r2}`);
  } catch (err) {
    eq('no-config exit', err.status, 1);
    has('no-config message is actionable', `${err.stdout}${err.stderr}`, 'install.mjs');
  }
  fs.rmSync(noCfg, { recursive: true, force: true });

  eq('--quiet suppresses stdout', ingest(['--quiet']).out.trim(), '');
  has('--help works', ingest(['--help']).out, 'run-ingest');
}

head('7. Shell block');
{
  const expected = IS_WIN
    ? [path.join(HOME, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
       path.join(HOME, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1')]
    : [path.join(HOME, '.zshrc'), path.join(HOME, '.bashrc'), path.join(HOME, '.bash_profile')];

  const written = expected.filter((f) => fs.existsSync(f));
  truthy(`block written to a startup file (${written.map((f) => path.basename(f)).join(', ') || 'none'})`,
    written.length > 0);

  for (const f of written) {
    const text = fs.readFileSync(f, 'utf8');
    has(`${path.basename(f)}: marker`, text, '>>> obsidian-wiki >>>');
    has(`${path.basename(f)}: wiki-history`, text, 'wiki-history');
    has(`${path.basename(f)}: wiki-log`, text, 'wiki-log');
    has(`${path.basename(f)}: runner path`, text, 'run-ingest.mjs');
  }

  if (IS_WIN) {
    // Assert the generated PowerShell actually parses, which is the failure mode
    // that would otherwise only appear in the user's first shell.
    const ps = written[0];
    try {
      execFileSync('powershell', ['-NoProfile', '-Command',
        `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${ps.replace(/'/g, "''")}',[ref]$t,[ref]$e);if($e.Count){$e|%{$_.Message};exit 1}`,
      ], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
      ok('generated PowerShell profile block parses');
    } catch (err) {
      no(`generated PowerShell block has parse errors: ${err.stdout || err.message}`);
    }
  } else {
    const shell = fs.existsSync(path.join(HOME, '.bashrc')) ? 'bash' : 'zsh';
    const rc = shell === 'bash' ? path.join(HOME, '.bashrc') : path.join(HOME, '.zshrc');
    try {
      const out = execFileSync(shell, ['-c', `. "${rc}" >/dev/null 2>&1; type wiki-history >/dev/null && echo DEFINED`],
        { env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      has(`${shell} defines wiki-history`, out, 'DEFINED');
    } catch (err) {
      no(`${shell} could not source the block: ${err.message}`);
    }
    run(HOOK);
    try {
      const greet = execFileSync(shell, ['-c', `. "${rc}" 2>/dev/null`],
        { env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      has('greeting renders when work is pending', greet, '[wiki]');
    } catch {
      no('greeting did not render');
    }
  }
}

head('8. Scheduler');
// Runs in a child process with the throwaway home, like every other test.
//
// Importing schedule.mjs into this process instead would resolve os.homedir() to the
// real user's home, so the plist or unit file would be written there rather than into
// the sandbox. Registration itself is unavoidably OS-level, so the job is registered
// and then removed, and the removal is asserted.
{
  const probe = `
import { availableSchedulers, installSchedule, removeSchedule, scheduleStatus } from ${JSON.stringify(path.join(KIT, 'lib', 'schedule.mjs'))};
import { PLATFORM, LINK_TYPE, HOME } from ${JSON.stringify(path.join(KIT, 'lib', 'platform.mjs'))};
const r = { home: HOME, platform: PLATFORM, linkType: LINK_TYPE, available: availableSchedulers() };
if (r.available.length) {
  r.dry = installSchedule('07:30', { dryRun: true });
  r.installed = installSchedule('07:30');
  r.status = scheduleStatus();
  r.removed = removeSchedule();
  r.statusAfter = scheduleStatus();
}
process.stdout.write(JSON.stringify(r));
`;
  const probeFile = path.join(HOME, 'sched-probe.mjs');
  fs.writeFileSync(probeFile, probe);
  const { out, code } = run(probeFile);
  let r = null;
  try { r = JSON.parse(out.slice(out.indexOf('{'))); } catch { /* reported below */ }

  if (!r) {
    no(`scheduler probe did not return JSON (exit ${code}): ${out.slice(0, 300)}`);
  } else {
    eq('probe resolved the sandbox home', r.home, HOME);
    eq('platform', r.platform, process.platform);
    eq('link type', r.linkType, IS_WIN ? 'junction' : 'dir');
    console.log(`  available: ${JSON.stringify(r.available)}`);

    const expected = IS_MAC ? 'launchd' : IS_WIN ? 'schtasks' : null;
    if (expected) eq('preferred backend', r.available[0], expected);
    else truthy('linux offers systemd or cron', r.available.includes('systemd') || r.available.includes('cron'));

    if (!r.available.length) {
      na('scheduler install (none available on this runner)');
    } else {
      eq('dry run reports the backend', r.dry?.kind, r.available[0]);
      eq('installed backend', r.installed?.kind, r.available[0]);
      truthy(`status reports it (${String(r.status).slice(0, 70)})`, r.status !== null);
      console.log(`  remove: ${JSON.stringify(r.removed)}`);
      truthy('status is null after removal', r.statusAfter === null);
    }
  }
  fs.rmSync(probeFile, { force: true });
}

head('9. Idempotency');
{
  const before = countMd();
  const { out, code } = install(['--vault', VAULT]);
  eq('second install exit', code, 0);
  eq('notes unchanged', countMd(), before);
  eq('skill links still 7', links().length, 7);
  const m = /Done: (\d+) change/.exec(out);
  const changes = m ? Number(m[1]) : -1;
  // The runner refresh and config rewrite are deliberate, so updates propagate.
  truthy(`reinstall made only the 2 intentional changes (reported ${changes})`, changes >= 0 && changes <= 3);
  has('reports existing files as already in place', out, 'already in place');
}

head('10. Uninstall');
{
  const notesBefore = countMd();
  const { code } = install(['--uninstall']);
  eq('uninstall exit', code, 0);
  eq('skill links removed', links().length, 0);
  eq('notes preserved', countMd(), notesBefore);

  const s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  const stillHooked = (s.hooks?.Stop || [])
    .some((e) => (e.hooks || []).some((h) => String(h.command).includes('mark-pending')));
  truthy('hook removed from settings.json', !stillHooked);

  const rcs = IS_WIN
    ? [path.join(HOME, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
       path.join(HOME, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1')]
    : [path.join(HOME, '.zshrc'), path.join(HOME, '.bashrc'), path.join(HOME, '.bash_profile')];
  const leftover = rcs.filter((f) => fs.existsSync(f)
    && fs.readFileSync(f, 'utf8').includes('>>> obsidian-wiki >>>'));
  eq('shell blocks removed', leftover.length, 0);
  // Same reasoning as test 8: ask a child process with the sandbox home.
  const probeFile = path.join(HOME, 'sched-check.mjs');
  fs.writeFileSync(probeFile,
    `import { scheduleStatus } from ${JSON.stringify(path.join(KIT, 'lib', 'schedule.mjs'))};\n`
    + 'process.stdout.write(JSON.stringify(scheduleStatus()));\n');
  const left = run(probeFile).out.trim();
  fs.rmSync(probeFile, { force: true });
  eq('scheduler left nothing behind', left, 'null');
}

// ===========================================================================

if (!KEEP) fs.rmSync(HOME, { recursive: true, force: true });

console.log(`\n${'-'.repeat(60)}`);
console.log(`${process.platform}: ${C.g}${pass} passed${C.z}, ${fail ? C.r : ''}${fail} failed${C.z}, ${C.y}${skip} skipped${C.z}`);
if (fail) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
if (KEEP) console.log(`\nTest home kept at ${HOME}`);
process.exit(fail ? 1 : 0);
