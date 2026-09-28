# Codex Host Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the kit install and run under OpenAI Codex CLI as well as Claude Code, from one codebase, with hosts detected automatically.

**Architecture:** A new `lib/host.mjs` holds one descriptor per agent host — exe, home, skills dir, hooks file, sessions dir, `buildArgs()`, watchdog strategy — the way `lib/schedule.mjs` already holds four scheduler backends behind one interface. The five files that currently hard-code Claude Code lose their `CLAUDE_*` imports and take a host instead. `lib/platform.mjs` keeps OS knowledge only.

**Tech Stack:** Node 22, ESM, zero dependencies. No test framework: `test/suite.mjs` is a hand-rolled runner that spawns the real installer and runner against a throwaway `HOME`.

**Spec:** `docs/superpowers/specs/2026-09-29-codex-host-support-design.md`

## Global Constraints

- Zero runtime dependencies. Node built-ins only.
- Keep every file under 500 lines. `test/suite.mjs` is at 514 and must come **down**, not up — Task 2 extracts its harness.
- Must work on macOS, Linux and Windows. Windows gets junctions, not symlinks, and `.cmd` shims routed through `cmd.exe`.
- Every existing install must keep working with no re-run: config migrates on read.
- Do not change Claude Code path behaviour. Its `--allowedTools` allowlist, its transcript watchdog and its schedule stay byte-identical in effect.
- Local date for filenames and `updated` fields; UTC for timestamps written into vault content.
- Codex model stays **absent** by default so Codex's own configured default applies. Never pin a `gpt-5.x` string.
- Verified Codex invocation, use exactly this: `codex exec --json --sandbox workspace-write --cd <vault> --skip-git-repo-check [-m <model>] "<prompt>"`
- Verified Codex paths: hooks at `~/.codex/hooks.json`, skills at `~/.codex/skills/`, sessions at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
- Commit after every task. Conventional-style subject lines, no `Co-Authored-By` trailer.

---

### Task 1: Spike — does a hooks.json Stop hook fire without being trusted?

Codex records per-hook trust in `config.toml` (`enabled`, `trusted_hash`) and ships a `--dangerously-bypass-hook-trust` flag, so the gate is enforced, not advisory. An untrusted Stop hook never fires, the pending flag is never written, and the vault silently stops growing. That is the worst failure class this kit has, so it gets settled before anything is built around it.

**Files:**
- Modify: `docs/superpowers/specs/2026-09-29-codex-host-support-design.md` (record the answer in the Open risk section)

**Interfaces:**
- Consumes: nothing.
- Produces: a documented answer that Task 6 turns into installer output. Task 6's `codexHookTrustNote` string is written from this result.

- [ ] **Step 1: Get a Codex CLI to test against**

`codex` is not on the development machine. Either:

```bash
npm install -g @openai/codex && codex --version
```

or run steps 2–4 on a machine that already has it. If neither is possible, skip to Step 5 and take the conservative branch.

- [ ] **Step 2: Write a Stop hook by hand and watch for it**

```bash
mkdir -p ~/.codex
cat > /tmp/hook-probe.sh <<'SH'
#!/bin/sh
date -u +%FT%TZ >> /tmp/hook-probe.log
SH
chmod +x /tmp/hook-probe.sh
cat > ~/.codex/hooks.json <<'JSON'
{
  "description": "hook trust probe",
  "hooks": {
    "Stop": [ { "matcher": "", "hooks": [ { "type": "command", "command": "/tmp/hook-probe.sh", "timeout": 5 } ] } ]
  }
}
JSON
rm -f /tmp/hook-probe.log
```

- [ ] **Step 3: Run one Codex turn and check**

```bash
codex exec --skip-git-repo-check "say hello and stop"
cat /tmp/hook-probe.log 2>/dev/null || echo "HOOK DID NOT FIRE"
grep -A3 '\[hooks' ~/.codex/config.toml 2>/dev/null || echo "no hook state in config.toml"
```

Note three things: whether the log file appeared, whether Codex printed anything about trusting a hook, and whether a `trusted_hash` entry was written to `config.toml`.

- [ ] **Step 4: Repeat in an interactive session**

`codex exec` is not the case that matters — the brother's own interactive turns are. Start `codex`, send one message, exit, and check `/tmp/hook-probe.log` again. Record whether a prompt appeared.

- [ ] **Step 5: Record the answer in the spec**

Replace the Open risk section's final two paragraphs with what actually happened. Write one of these three outcomes verbatim, so Task 6 has a string to print:

- Fires unprompted → `codexHookTrustNote = null`
- Prompts once on next start → `codexHookTrustNote = 'Codex will ask you to trust the Stop hook the first time you start it. Approve it, or the daily ingest never gets triggered.'`
- Silently inactive until trusted → `codexHookTrustNote = 'Codex requires this hook to be trusted before it fires. Run `codex` once and approve the hook, then check ~/.codex/config.toml has a trusted_hash for it. Until then the daily ingest is never triggered.'`

- [ ] **Step 6: Clean up the probe**

```bash
rm -f ~/.codex/hooks.json /tmp/hook-probe.sh /tmp/hook-probe.log
```

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/specs/2026-09-29-codex-host-support-design.md
git commit -m "Settle whether a Codex Stop hook fires before it is trusted"
```

---

### Task 2: The host registry, and a shared test harness

**Files:**
- Create: `lib/host.mjs`
- Create: `test/harness.mjs`
- Create: `test/codex.mjs`
- Modify: `lib/platform.mjs` (delete the four `CLAUDE_*` constants, lines 19–22)
- Modify: `test/suite.mjs` (import the harness instead of defining it; brings the file under 500 lines)
- Modify: `.github/workflows/ci.yml` (run the new suite)

**Interfaces:**
- Consumes: `HOME`, `IS_WIN`, `which` from `lib/platform.mjs`.
- Produces, all named exactly as later tasks use them:
  - `HOSTS` — array, Claude first.
  - `hostById(id)` → descriptor or `null`.
  - `detectHosts()` → `[{ host, exe, present }]`, one row per member of `HOSTS`.
  - `resolveEngine(detected, requested)` → descriptor; throws `Error` on an unknown or absent request.
  - Descriptor fields: `id`, `label`, `exe`, `home`, `skillsDir`, `sessionsDir`, `hooksFile`, `historyArg`, `logTag`, `installHint`, `watchdog`, `buildArgs({ prompt, model, sessionId, vault })`.
  - From `test/harness.mjs`: `makeHome()`, `ok`, `no`, `na`, `eq`, `truthy`, `has`, `head`, `run`, `summary()`.

- [ ] **Step 1: Write the failing test**

Create `test/codex.mjs`. It runs `lib/host.mjs` in-process — no child processes needed for this task.

```js
#!/usr/bin/env node
// Codex host support. Runs alongside test/suite.mjs; see that file for the
// throwaway-HOME convention every child-process test here follows.

import fs from 'node:fs';
import path from 'node:path';
import { eq, has, head, makeHome, run, summary, truthy } from './harness.mjs';

const { HOSTS, hostById, detectHosts, resolveEngine } = await import('../lib/host.mjs');

head('1. The host registry');

eq('two hosts are registered', HOSTS.length, 2);
eq('Claude is first, because it is the tested path', HOSTS[0].id, 'claude');
eq('Codex is second', HOSTS[1].id, 'codex');
truthy('an unknown id resolves to null', hostById('nope') === null);
eq('hostById finds Codex', hostById('codex').label, 'Codex CLI');

const claude = hostById('claude');
const codex = hostById('codex');

has('Claude home is ~/.claude', claude.home, '.claude');
has('Codex home is ~/.codex', codex.home, '.codex');
has('Claude hooks live in settings.json', claude.hooksFile, 'settings.json');
has('Codex hooks live in hooks.json', codex.hooksFile, 'hooks.json');
has('Claude sessions live in projects/', claude.sessionsDir, 'projects');
has('Codex sessions live in sessions/', codex.sessionsDir, 'sessions');
eq('Claude watches transcripts', claude.watchdog, 'transcript');
eq('Codex watches stdout, having no session id to pin', codex.watchdog, 'stdout');
eq('Claude routes the claude history source', claude.historyArg, 'claude');
eq('Codex routes the codex history source', codex.historyArg, 'codex');

head('2. Invocation arguments');

const args = { prompt: 'INGEST', model: 'sonnet', sessionId: 'abc-123', vault: '/v' };
const ca = claude.buildArgs(args);
has('Claude gets -p', ca.join(' '), '-p');
has('Claude pins the session id', ca.join(' '), '--session-id');
has('Claude keeps its tool allowlist', ca.join(' '), '--allowedTools');
has('Claude keeps acceptEdits', ca.join(' '), 'acceptEdits');
truthy('Claude receives the prompt', ca.includes('INGEST'));

const xa = codex.buildArgs({ ...args, model: null });
eq('Codex runs exec', xa[0], 'exec');
has('Codex streams JSON so stdout is the activity signal', xa.join(' '), '--json');
has('Codex confines writes to the workspace', xa.join(' '), 'workspace-write');
has('Codex is pointed at the vault', xa.join(' '), '--cd');
has('Codex tolerates a non-git vault', xa.join(' '), '--skip-git-repo-check');
truthy('no model flag when no model is configured', !xa.includes('-m'));
truthy('the prompt is the last argument', xa[xa.length - 1] === 'INGEST');
truthy('Codex never gets a session id it has no flag for', !xa.includes('--session-id'));

const xm = codex.buildArgs({ ...args, model: 'gpt-5-codex' });
truthy('a configured model is passed with -m', xm.includes('-m') && xm.includes('gpt-5-codex'));

head('3. Detection and engine choice');

const detected = detectHosts();
eq('one row per registered host', detected.length, 2);
truthy('every row reports presence', detected.every((d) => typeof d.present === 'boolean'));

const both = [{ host: claude, present: true }, { host: codex, present: true }];
const onlyCodex = [{ host: claude, present: false }, { host: codex, present: true }];

eq('with both present the engine defaults to claude', resolveEngine(both, null).id, 'claude');
eq('with only codex present it is the engine', resolveEngine(onlyCodex, null).id, 'codex');
eq('an explicit request wins', resolveEngine(both, 'codex').id, 'codex');

let threw = null;
try { resolveEngine(onlyCodex, 'claude'); } catch (err) { threw = err.message; }
truthy('requesting an absent host throws', threw !== null);
has('and says how to install it', threw || '', 'npm install');

threw = null;
try { resolveEngine(both, 'gemini'); } catch (err) { threw = err.message; }
truthy('requesting an unknown host throws', threw !== null);

summary();
```

- [ ] **Step 2: Extract the shared harness so both suites use one copy**

Create `test/harness.mjs` by moving the helpers out of `test/suite.mjs` verbatim — the colour table, `head`, `ok`, `no`, `na`, `eq`, `truthy`, `has`, `run`, and the counters. Add `makeHome()` for the throwaway-`HOME` setup and `summary()` for the exit-code tail.

```js
// Shared test harness. Extracted from suite.mjs so a second suite can use the same
// assertions and the same throwaway-HOME discipline rather than growing a second copy.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const IS_WIN = process.platform === 'win32';

let pass = 0; let fail = 0; let skip = 0;
const failures = [];

const C = process.stdout.isTTY
  ? { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', c: '\x1b[36m', z: '\x1b[0m' }
  : { g: '', r: '', y: '', c: '', z: '' };

export const head = (s) => console.log(`\n${C.c}=== ${s} ===${C.z}`);
export function ok(msg) { pass += 1; console.log(`  ${C.g}PASS${C.z}  ${msg}`); }
export function no(msg) { fail += 1; failures.push(msg); console.log(`  ${C.r}FAIL${C.z}  ${msg}`); }
export function na(msg) { skip += 1; console.log(`  ${C.y}SKIP${C.z}  ${msg}`); }

export function eq(label, actual, expected) {
  if (actual === expected) ok(label);
  else no(`${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}
export function truthy(label, value) { value ? ok(label) : no(label); }
export function has(label, haystack, needle) {
  String(haystack).includes(needle) ? ok(label) : no(`${label} (missing ${JSON.stringify(needle)})`);
}

/** A throwaway HOME, with USERPROFILE set too because os.homedir() reads it on Windows. */
export function makeHome(tag = 'vault-kit-test-') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), tag));
  return { home, env: { ...process.env, HOME: home, USERPROFILE: home } };
}

export function run(script, args = [], env = process.env) {
  try {
    const out = execFileSync(process.execPath, [script, ...args], {
      encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'],
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
```

Then delete those definitions from `test/suite.mjs` and import them instead. `suite.mjs` keeps its own `HOME`/`VAULT`/`WIKI` constants and its `run` wrapper that passes `ENV`; only the assertion helpers and the summary move.

- [ ] **Step 3: Run the new test to verify it fails**

Run: `node test/codex.mjs`
Expected: FAIL — `Cannot find module '../lib/host.mjs'`

Also run `node test/suite.mjs` and expect it still green, proving the extraction was behaviour-neutral.

- [ ] **Step 4: Write lib/host.mjs**

```js
// The only module that knows which agent CLI it is talking to.
//
// Everything else takes a host descriptor and stays agent-neutral. If you are adding
// a third host, this file is the one you touch — the same contract lib/schedule.mjs
// holds for schedulers and lib/platform.mjs holds for operating systems.

import fs from 'node:fs';
import path from 'node:path';
import { HOME, which } from './platform.mjs';

const claudeHome = path.join(HOME, '.claude');
const codexHome = path.join(HOME, '.codex');

/**
 * Claude Code. Confines the agent by enumerating tools, and its -p stdout stays
 * silent until the end, so activity has to be read from transcript mtimes.
 */
export const CLAUDE = {
  id: 'claude',
  label: 'Claude Code',
  exe: 'claude',
  home: claudeHome,
  skillsDir: path.join(claudeHome, 'skills'),
  sessionsDir: path.join(claudeHome, 'projects'),
  hooksFile: path.join(claudeHome, 'settings.json'),
  historyArg: 'claude',
  logTag: 'CLAUDE',
  installHint: 'npm install -g @anthropic-ai/claude-code',
  watchdog: 'transcript',

  buildArgs({ prompt, model, sessionId }) {
    return [
      '-p', prompt,
      '--model', model,
      '--setting-sources', 'project,local',
      '--strict-mcp-config',
      '--permission-mode', 'acceptEdits',
      '--add-dir', this.sessionsDir,
      '--session-id', sessionId,
      '--allowedTools', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'Agent', 'TodoWrite',
      'Bash(python:*)', 'Bash(python3:*)', 'Bash(node:*)', 'Bash(ls:*)',
      'Bash(date:*)', 'Bash(wc:*)', 'Bash(cp:*)', 'Bash(stat:*)', 'Bash(find:*)',
      '--disallowedTools', `Edit(${this.home.split(path.sep).join('/')}/**)`,
    ];
  },
};

/**
 * Codex CLI. Confines the agent by sandbox rather than by tool name, which is
 * coarser: workspace-write permits writes to the working directory, so --cd puts
 * that at the vault. exec defaults its approval policy to Never, so unattended
 * needs no dangerous flag.
 *
 * There is no --session-id, so the transcript scan the Claude path uses cannot
 * work here. --json makes stdout an event stream instead, which is a better stall
 * signal anyway: it cannot be fooled by an unrelated session writing a rollout.
 */
export const CODEX = {
  id: 'codex',
  label: 'Codex CLI',
  exe: 'codex',
  home: codexHome,
  skillsDir: path.join(codexHome, 'skills'),
  sessionsDir: path.join(codexHome, 'sessions'),
  hooksFile: path.join(codexHome, 'hooks.json'),
  historyArg: 'codex',
  logTag: 'CODEX',
  installHint: 'npm install -g @openai/codex',
  watchdog: 'stdout',

  buildArgs({ prompt, model, vault }) {
    const args = [
      'exec',
      '--json',
      '--sandbox', 'workspace-write',
      '--cd', vault,
      // --no-git vaults are supported, and exec otherwise refuses to run outside a repo.
      '--skip-git-repo-check',
    ];
    // No default model on purpose: a pinned gpt-5.x string would rot, and would
    // override whatever the user's own config already chose.
    if (model) args.push('-m', model);
    args.push(prompt);
    return args;
  },
};

/** Claude first: it is the tested path, and the default engine when both are present. */
export const HOSTS = [CLAUDE, CODEX];

export function hostById(id) {
  return HOSTS.find((h) => h.id === id) || null;
}

/**
 * Which hosts this machine has. A host counts as present if its CLI is on PATH or
 * its home directory exists — the second case catches a shell whose PATH the
 * scheduler does not inherit.
 */
export function detectHosts() {
  return HOSTS.map((host) => {
    const exe = which(host.exe);
    let homeExists = false;
    try { homeExists = fs.existsSync(host.home); } catch { /* unreadable */ }
    return { host, exe, present: Boolean(exe) || homeExists };
  });
}

/**
 * Which host runs the headless ingest. Defaults to the only present host, and to
 * Claude when both are present, because that is the path with the most miles on it.
 */
export function resolveEngine(detected, requested) {
  const present = detected.filter((d) => d.present);

  if (requested) {
    const host = hostById(requested);
    if (!host) {
      throw new Error(`unknown host "${requested}"; known hosts: ${HOSTS.map((h) => h.id).join(', ')}`);
    }
    const row = detected.find((d) => d.host.id === host.id);
    if (!row || !row.present) {
      throw new Error(`${host.label} is not installed, so it cannot be the engine. Install it first:\n  ${host.installHint}`);
    }
    return host;
  }

  if (!present.length) return CLAUDE;
  const claudeRow = present.find((d) => d.host.id === 'claude');
  return claudeRow ? claudeRow.host : present[0].host;
}
```

- [ ] **Step 5: Delete the four moved constants from lib/platform.mjs**

Remove lines 19–22 (`CLAUDE_HOME`, `CLAUDE_SKILLS`, `CLAUDE_PROJECTS`, `CLAUDE_SETTINGS`). Leave `WIKI_DIR` on line 18 and everything below untouched. Update the file's header comment: it says "this file plus lib/schedule.mjs are the two you touch" for a new OS — add that `lib/host.mjs` is where a new agent goes.

The build will now fail in four places (`lib/hooks.mjs`, `lib/vault.mjs`, `bin/run-ingest.mjs`, `install.mjs`). Tasks 4–7 fix them. To keep the tree green between tasks, do Step 5 as part of Task 4 instead if you are committing per task — note it there and skip it here.

- [ ] **Step 6: Run both tests to verify they pass**

Run: `node test/codex.mjs && node test/suite.mjs`
Expected: both PASS. `wc -l test/suite.mjs` should now be under 500.

- [ ] **Step 7: Add the new suite to CI**

In `.github/workflows/ci.yml`, the `Suite` step becomes:

```yaml
      - name: Suite
        run: node test/suite.mjs

      - name: Codex host suite
        run: node test/codex.mjs
```

The existing `Syntax check every module` step already globs `test/*.mjs`, so it picks up the new files with no change.

- [ ] **Step 8: Commit**

```bash
git add lib/host.mjs lib/platform.mjs test/harness.mjs test/codex.mjs test/suite.mjs .github/workflows/ci.yml
git commit -m "Put agent knowledge in one file, the way platform.mjs holds the OS"
```

---

### Task 3: Config gains hosts and an engine, migrating on read

**Files:**
- Modify: `lib/platform.mjs` (`readConfig`, at the end of the file)
- Test: `test/codex.mjs` (new section 4)

**Interfaces:**
- Consumes: `hostById` from `lib/host.mjs`.
- Produces: `readConfig()` returns a config that always has `hosts` (object keyed by host id, each `{ exe, model? }`) and `engine` (a host id string), whatever shape is on disk.

- [ ] **Step 1: Write the failing test**

Append to `test/codex.mjs`, before `summary()`:

```js
head('4. Config migration');

{
  const { home, env } = makeHome('vault-kit-cfg-');
  const wiki = path.join(home, '.obsidian-wiki');
  fs.mkdirSync(wiki, { recursive: true });

  // The shape every existing install has on disk today.
  fs.writeFileSync(path.join(wiki, 'config.json'), JSON.stringify({
    vaultPath: path.join(home, 'Documents', 'Obsidian Vault'),
    claudeExe: '/usr/local/bin/claude',
    model: 'sonnet',
    platform: process.platform,
    installed: '2026-01-01T00:00:00.000Z',
  }, null, 2));

  // Read it in a child process, because platform.mjs resolves HOME at module load.
  const reader = path.join(home, 'read.mjs');
  fs.writeFileSync(reader, `
import { readConfig } from ${JSON.stringify(path.resolve('lib/platform.mjs'))};
console.log(JSON.stringify(readConfig()));
`);
  const r = run(reader, [], env);
  eq('the reader exits clean', r.code, 0);
  const cfg = JSON.parse(r.out.trim().split('\n').pop());

  truthy('a legacy config gains a hosts map', Boolean(cfg.hosts));
  eq('the legacy claudeExe becomes the claude host exe', cfg.hosts.claude.exe, '/usr/local/bin/claude');
  eq('the legacy model becomes the claude host model', cfg.hosts.claude.model, 'sonnet');
  eq('the engine defaults to claude', cfg.engine, 'claude');
  truthy('no codex host is invented', !cfg.hosts.codex);
  truthy('vaultPath survives', cfg.vaultPath.includes('Obsidian Vault'));

  // A new-shape config is returned untouched.
  fs.writeFileSync(path.join(wiki, 'config.json'), JSON.stringify({
    vaultPath: '/v', engine: 'codex',
    hosts: { codex: { exe: '/usr/local/bin/codex' } },
  }, null, 2));
  const r2 = run(reader, [], env);
  const cfg2 = JSON.parse(r2.out.trim().split('\n').pop());
  eq('a new-shape engine is respected', cfg2.engine, 'codex');
  eq('a new-shape host exe is respected', cfg2.hosts.codex.exe, '/usr/local/bin/codex');
  truthy('claude is not invented for a codex-only install', !cfg2.hosts.claude);

  fs.rmSync(home, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node test/codex.mjs`
Expected: FAIL — `a legacy config gains a hosts map`, because `readConfig` returns the file verbatim.

- [ ] **Step 3: Migrate in readConfig**

Replace `readConfig` in `lib/platform.mjs`:

```js
/**
 * The config, with the host map filled in.
 *
 * Installs made before Codex support carry a flat claudeExe/model pair. They are
 * migrated in memory rather than rewritten, so a user who never re-runs the
 * installer keeps working; the next install.mjs writes the new shape.
 */
export function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`config at ${CONFIG_PATH} is not valid JSON: ${err.message}`);
  }

  if (!cfg.hosts || typeof cfg.hosts !== 'object') {
    const claude = { exe: cfg.claudeExe || 'claude' };
    if (cfg.model) claude.model = cfg.model;
    cfg.hosts = { claude };
  }
  if (!cfg.engine) {
    cfg.engine = cfg.hosts.claude ? 'claude' : Object.keys(cfg.hosts)[0] || 'claude';
  }
  return cfg;
}
```

Note this needs no import from `lib/host.mjs` — keeping `platform.mjs` free of agent knowledge. The host ids appear only as the string keys they already are on disk.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node test/codex.mjs`
Expected: PASS, section 4 included.

- [ ] **Step 5: Commit**

```bash
git add lib/platform.mjs test/codex.mjs
git commit -m "Migrate the config on read, so an old install needs no re-run"
```

---

### Task 4: Hooks take a host

Both hosts nest their hooks under a root `hooks` key — Claude inside `settings.json` alongside unrelated settings, Codex as the whole of `hooks.json`. So the merge logic is already correct for both; only the path changes.

**Files:**
- Modify: `lib/hooks.mjs` (whole file: signatures gain a host)
- Modify: `lib/platform.mjs` (delete lines 19–22, the four `CLAUDE_*` constants, if Task 2 Step 5 deferred it)
- Test: `test/codex.mjs` (new section 5)

**Interfaces:**
- Consumes: descriptor fields `hooksFile`, `home`, `label` from Task 2.
- Produces:
  - `installStopHook(host, command, { dryRun })` → `'added' | 'present' | 'would-add'`
  - `removeStopHook(host)` → `'removed' | 'not-present' | 'no-settings'`
  - `hookCommand(nodeExe, wikiDir)` → unchanged, still host-neutral.

- [ ] **Step 1: Write the failing test**

Append to `test/codex.mjs`:

```js
head('5. Stop hooks, per host');

{
  const { home, env } = makeHome('vault-kit-hook-');

  // A hooks.json that already has an unrelated hook. Losing it would be the bug.
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'hooks.json'), JSON.stringify({
    description: 'mine',
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] },
  }, null, 2));

  const driver = path.join(home, 'hook.mjs');
  fs.writeFileSync(driver, `
import { hostById } from ${JSON.stringify(path.resolve('lib/host.mjs'))};
import { installStopHook, removeStopHook, hookCommand } from ${JSON.stringify(path.resolve('lib/hooks.mjs'))};
const host = hostById(process.argv[2]);
const action = process.argv[3];
const cmd = hookCommand(process.execPath, '/w');
if (action === 'add') console.log(installStopHook(host, cmd));
else console.log(removeStopHook(host));
`);

  eq('the codex hook is added', run(driver, ['codex', 'add'], env).out.trim(), 'added');
  eq('adding twice is a no-op', run(driver, ['codex', 'add'], env).out.trim(), 'present');

  const written = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8'));
  eq('the Stop event has one entry', written.hooks.Stop.length, 1);
  has('the entry runs mark-pending', written.hooks.Stop[0].hooks[0].command, 'mark-pending.mjs');
  eq('the hook is a command hook', written.hooks.Stop[0].hooks[0].type, 'command');
  truthy('the unrelated PreToolUse hook survived', Boolean(written.hooks.PreToolUse));
  eq('the description survived', written.description, 'mine');
  truthy('hooks.json was backed up first',
    fs.readdirSync(path.join(home, '.codex')).some((f) => f.startsWith('hooks.json.bak-')));

  eq('the codex hook is removed', run(driver, ['codex', 'remove'], env).out.trim(), 'removed');
  const after = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8'));
  truthy('removing ours leaves theirs alone', Boolean(after.hooks.PreToolUse));
  truthy('the emptied Stop key is dropped', !after.hooks.Stop);

  eq('removing from a host with no file says so', run(driver, ['claude', 'remove'], env).out.trim(), 'no-settings');

  fs.rmSync(home, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node test/codex.mjs`
Expected: FAIL — `installStopHook` still takes `(command, opts)` and writes `CLAUDE_SETTINGS`.

- [ ] **Step 3: Rewrite lib/hooks.mjs to take a host**

Change the header comment from "Registering the Claude Code Stop hook" to "Registering a host's Stop hook", then:

```js
import fs from 'node:fs';
import path from 'node:path';

const FINGERPRINT = 'mark-pending.mjs';

/**
 * Add the Stop hook to one host if it is not already there.
 *
 * Both hosts nest their hooks under a root `hooks` key — Claude inside settings.json
 * next to unrelated settings, Codex as the whole of hooks.json — so one merge serves
 * both. Merging into a user's own config is the most dangerous thing the installer
 * does, so: back up first, preserve every existing key and hook, never duplicate.
 *
 * Returns 'added' | 'present' | 'would-add'.
 */
export function installStopHook(host, command, { dryRun = false } = {}) {
  const file = host.hooksFile;
  let settings = {};
  const exists = fs.existsSync(file);

  if (exists) {
    const raw = fs.readFileSync(file, 'utf8');
    try {
      settings = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `${file} is not valid JSON (${err.message}). `
        + 'Fix or move it, then re-run; refusing to overwrite it.',
      );
    }
  }

  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const stop = Array.isArray(hooks.Stop) ? hooks.Stop : [];

  const already = stop.some((entry) => {
    const inner = Array.isArray(entry?.hooks) ? entry.hooks : [];
    return inner.some((h) => typeof h?.command === 'string' && h.command.includes(FINGERPRINT));
  });

  if (already) return 'present';
  if (dryRun) return 'would-add';

  if (exists) fs.copyFileSync(file, `${file}.bak-${stamp()}`);
  else fs.mkdirSync(path.dirname(file), { recursive: true });

  stop.push({ matcher: '', hooks: [{ type: 'command', command, timeout: 5 }] });
  hooks.Stop = stop;
  settings.hooks = hooks;

  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return 'added';
}

/** Remove the hook this kit added from one host, leaving every other hook in place. */
export function removeStopHook(host) {
  const file = host.hooksFile;
  if (!fs.existsSync(file)) return 'no-settings';
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  const stop = Array.isArray(settings?.hooks?.Stop) ? settings.hooks.Stop : [];

  const kept = stop
    .map((entry) => {
      const inner = Array.isArray(entry?.hooks) ? entry.hooks : [];
      const keep = inner.filter(
        (h) => !(typeof h?.command === 'string' && h.command.includes(FINGERPRINT)),
      );
      return keep.length ? { ...entry, hooks: keep } : null;
    })
    .filter(Boolean);

  if (kept.length === stop.length && JSON.stringify(kept) === JSON.stringify(stop)) {
    return 'not-present';
  }

  fs.copyFileSync(file, `${file}.bak-${stamp()}`);
  if (kept.length) settings.hooks.Stop = kept;
  else delete settings.hooks.Stop;
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return 'removed';
}
```

`hookCommand(nodeExe, wikiDir)` and `stamp()` stay exactly as they are. Delete the `import { CLAUDE_HOME, CLAUDE_SETTINGS }` line.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node test/codex.mjs`
Expected: PASS. `node test/suite.mjs` will FAIL here — its section 5 still calls the old signature and `install.mjs` is not updated yet. That is expected; Task 6 makes it green again. Do not commit a red `suite.mjs` if you are gating on green: fold Tasks 4, 5 and 6 into one commit in that case.

- [ ] **Step 5: Commit**

```bash
git add lib/hooks.mjs lib/platform.mjs test/codex.mjs
git commit -m "Take a host in the hook installer, since both nest hooks the same way"
```

---

### Task 5: Link skills into every host

**Files:**
- Modify: `lib/vault.mjs` (`linkSkills`, lines 102–162)
- Test: `test/codex.mjs` (new section 6)

**Interfaces:**
- Consumes: descriptor field `skillsDir` from Task 2; `LINK_TYPE` from `lib/platform.mjs`.
- Produces: `linkSkills(vaultPath, hosts, { dryRun })` where `hosts` is an array of descriptors. Result rows gain `host` (the host id) alongside the existing `name`, `status`, and optional `points`/`reason`.

- [ ] **Step 1: Write the failing test**

Append to `test/codex.mjs`:

```js
head('6. Skill links, per host');

{
  const { home, env } = makeHome('vault-kit-link-');

  const vault = path.join(home, 'v');
  for (const s of ['wiki-agent', 'daily-update']) {
    fs.mkdirSync(path.join(vault, '.agents', 'skills', s), { recursive: true });
    fs.writeFileSync(path.join(vault, '.agents', 'skills', s, 'SKILL.md'), `---\nname: ${s}\ndescription: x\n---\n`);
  }

  const driver = path.join(home, 'link.mjs');
  fs.writeFileSync(driver, `
import { HOSTS } from ${JSON.stringify(path.resolve('lib/host.mjs'))};
import { linkSkills } from ${JSON.stringify(path.resolve('lib/vault.mjs'))};
console.log(JSON.stringify(linkSkills(${JSON.stringify(vault)}, HOSTS)));
`);
  const r = run(driver, [], env);
  eq('the linker exits clean', r.code, 0);
  const rows = JSON.parse(r.out.trim().split('\n').pop());

  eq('two skills times two hosts', rows.length, 4);
  truthy('every row names its host', rows.every((x) => x.host === 'claude' || x.host === 'codex'));
  eq('claude got both skills', rows.filter((x) => x.host === 'claude').length, 2);
  eq('codex got both skills', rows.filter((x) => x.host === 'codex').length, 2);
  truthy('all four linked', rows.every((x) => x.status === 'linked'));

  for (const dir of ['.claude', '.codex']) {
    const link = path.join(home, dir, 'skills', 'wiki-agent');
    truthy(`${dir}/skills/wiki-agent exists`, fs.existsSync(link));
    truthy(`${dir} link is a link, not a copy`, fs.lstatSync(link).isSymbolicLink());
    has(`${dir} link resolves into the vault`, fs.realpathSync(link), path.join('.agents', 'skills'));
  }

  // Re-linking is idempotent.
  const rows2 = JSON.parse(run(driver, [], env).out.trim().split('\n').pop());
  truthy('a second run reports them present', rows2.every((x) => x.status === 'present'));

  fs.rmSync(home, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node test/codex.mjs`
Expected: FAIL — `two skills times two hosts` gets 2, not 4.

- [ ] **Step 3: Loop over hosts in linkSkills**

In `lib/vault.mjs`, change the import from `CLAUDE_SKILLS, LINK_TYPE, IS_WIN, localDateStamp` to `LINK_TYPE, IS_WIN, localDateStamp`, then replace `linkSkills`:

```js
/**
 * Link each skill in the vault into every host's skills directory.
 *
 * Junctions on Windows, symlinks elsewhere. A junction needs no administrator
 * rights and no Developer Mode, which a Windows symlink does. The vault stays the
 * single source of truth for every host on the machine: edit the skill in the
 * vault, not the link.
 *
 * A real directory already sitting at a link path is never touched, because it may
 * be a skill the user wrote themselves.
 */
export function linkSkills(vaultPath, hosts, { dryRun = false } = {}) {
  const srcRoot = path.join(vaultPath, '.agents', 'skills');
  if (!fs.existsSync(srcRoot)) return [];

  const names = fs.readdirSync(srcRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const results = [];
  for (const host of hosts) {
    if (!dryRun) fs.mkdirSync(host.skillsDir, { recursive: true });
    for (const name of names) {
      results.push({ host: host.id, ...linkOne(srcRoot, host.skillsDir, name, dryRun) });
    }
  }
  return results;
}

/** One skill into one host's skills directory. Extracted so the loop above reads. */
function linkOne(srcRoot, skillsDir, name, dryRun) {
  const target = path.join(srcRoot, name);
  const link = path.join(skillsDir, name);

  let existing = null;
  try { existing = fs.lstatSync(link); } catch { /* nothing there */ }

  if (existing) {
    if (existing.isSymbolicLink()) {
      let points = null;
      try { points = fs.readlinkSync(link); } catch { /* unreadable */ }
      const same = points && path.resolve(path.dirname(link), points) === path.resolve(target);
      return { name, status: same ? 'present' : 'points-elsewhere', points };
    }
    return { name, status: 'real-directory' };
  }

  if (dryRun) return { name, status: 'would-link' };

  try {
    fs.symlinkSync(target, link, LINK_TYPE);
    return { name, status: 'linked' };
  } catch (err) {
    // Last resort: copy. The cost is that edits no longer flow both ways.
    try {
      fs.cpSync(target, link, { recursive: true });
      return { name, status: 'copied', reason: err.code || err.message };
    } catch (err2) {
      return { name, status: 'failed', reason: err2.code || err2.message };
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node test/codex.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/vault.mjs test/codex.mjs
git commit -m "Link the vault's skills into every host on the machine"
```

---

### Task 6: The installer wires up each detected host

**Files:**
- Modify: `install.mjs` (help text lines 45–61; uninstall block lines 85–120; prerequisites lines 124–144; config write lines 190–202; skills step lines 205–224; hook step lines 226–238; final next-steps lines 305–330)
- Test: `test/suite.mjs` (sections 2, 5, 10 take the new signatures); `test/codex.mjs` (new section 7)

**Interfaces:**
- Consumes: `detectHosts`, `resolveEngine`, `hostById`, `HOSTS` from Task 2; `installStopHook(host, …)`/`removeStopHook(host)` from Task 4; `linkSkills(vault, hosts, …)` from Task 5.
- Produces: config on disk in the Task 3 shape — `{ vaultPath, engine, hosts: { <id>: { exe, model? } }, platform, installed }`.

- [ ] **Step 1: Write the failing test**

Append to `test/codex.mjs`:

```js
head('7. Installing for a chosen host');

{
  const { home, env } = makeHome('vault-kit-inst-');
  const vault = path.join(home, 'Documents', 'Obsidian Vault');

  // Pretend Codex is installed: a home directory is enough for detection.
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });

  const installer = path.resolve('install.mjs');
  const r = run(installer, ['--vault', vault, '--host', 'codex', '--no-git'], env);
  eq('install exits clean', r.code, 0);
  has('it names the host it wired up', r.out, 'Codex CLI');

  const cfg = JSON.parse(fs.readFileSync(path.join(home, '.obsidian-wiki', 'config.json'), 'utf8'));
  eq('the engine is codex', cfg.engine, 'codex');
  truthy('codex is in the hosts map', Boolean(cfg.hosts.codex));
  truthy('claude was not wired up', !cfg.hosts.claude);
  truthy('no model is pinned for codex', !cfg.hosts.codex.model);

  truthy('the codex Stop hook exists', fs.existsSync(path.join(home, '.codex', 'hooks.json')));
  truthy('skills were linked into codex', fs.existsSync(path.join(home, '.codex', 'skills', 'wiki-agent')));
  truthy('nothing was written to ~/.claude', !fs.existsSync(path.join(home, '.claude', 'settings.json')));

  // Naming an absent host is an error, not a silent skip.
  const { home: home2, env: env2 } = makeHome('vault-kit-absent-');
  const r2 = run(installer, ['--vault', path.join(home2, 'v'), '--host', 'codex', '--no-git'], env2);
  truthy('installing for an absent host fails', r2.code !== 0);
  has('and says how to install it', r2.out, 'npm install -g @openai/codex');

  // Both hosts on one machine: two hook sets, two link sets, one source of truth.
  const { home: home3, env: env3 } = makeHome('vault-kit-both-');
  fs.mkdirSync(path.join(home3, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home3, '.codex'), { recursive: true });
  const vault3 = path.join(home3, 'v');
  const r4 = run(installer, ['--vault', vault3, '--host', 'both', '--no-git'], env3);
  eq('a dual-host install exits clean', r4.code, 0);

  const cfg3 = JSON.parse(fs.readFileSync(path.join(home3, '.obsidian-wiki', 'config.json'), 'utf8'));
  eq('both hosts are in the config', Object.keys(cfg3.hosts).sort().join(','), 'claude,codex');
  eq('claude is the engine when both are present', cfg3.engine, 'claude');
  eq('claude keeps a pinned model', cfg3.hosts.claude.model, 'sonnet');
  truthy('codex still has none', !cfg3.hosts.codex.model);

  for (const dir of ['.claude', '.codex']) {
    const hooksName = dir === '.claude' ? 'settings.json' : 'hooks.json';
    const h = JSON.parse(fs.readFileSync(path.join(home3, dir, hooksName), 'utf8'));
    has(`${dir} got a Stop hook`, JSON.stringify(h.hooks.Stop), 'mark-pending.mjs');
    truthy(`${dir} got skill links`, fs.existsSync(path.join(home3, dir, 'skills', 'wiki-agent')));
  }
  truthy('both link sets resolve to the one vault copy',
    fs.realpathSync(path.join(home3, '.claude', 'skills', 'wiki-agent'))
    === fs.realpathSync(path.join(home3, '.codex', 'skills', 'wiki-agent')));

  fs.rmSync(home3, { recursive: true, force: true });

  // Uninstall cleans the codex side and leaves an unrelated hook alone.
  const hooksFile = path.join(home, '.codex', 'hooks.json');
  const hooks = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  hooks.hooks.PreToolUse = [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo theirs' }] }];
  fs.writeFileSync(hooksFile, JSON.stringify(hooks, null, 2));

  const r3 = run(installer, ['--uninstall'], env);
  eq('uninstall exits clean', r3.code, 0);
  const left = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  truthy('our Stop hook is gone', !left.hooks.Stop);
  truthy("their PreToolUse hook is not", Boolean(left.hooks.PreToolUse));
  truthy('codex skill links are gone', !fs.existsSync(path.join(home, '.codex', 'skills', 'wiki-agent')));
  truthy('the vault survives an uninstall', fs.existsSync(path.join(vault, 'index.md')));

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(home2, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node test/codex.mjs`
Expected: FAIL — `install exits clean` gets a non-zero code, because `install.mjs` still imports the deleted `CLAUDE_SETTINGS`.

- [ ] **Step 3: Rewrite the installer's host handling**

Imports at the top of `install.mjs`:

```js
import {
  DEFAULT_VAULT, IS_WIN, WIKI_DIR,
  has, platformLabel, which, writeConfig,
} from './lib/platform.mjs';
import { HOSTS, detectHosts, hostById, resolveEngine } from './lib/host.mjs';
```

New flags beside the existing ones:

```js
const HOST_SPEC = strArg('--host') || 'auto';
const ENGINE_REQ = strArg('--engine');
const MODEL = strArg('--model');   // was: || 'sonnet'. Per-host defaults now apply.
```

Help text gains two lines:

```
  --host <spec>         which agent to wire up: auto (default), claude, codex, both
  --engine <id>         which agent runs the daily ingest (default: claude if present)
```

Host selection, placed in the prerequisites step in place of the `which('claude')` block:

```js
const detected = detectHosts();
for (const d of detected) {
  if (d.present) console.log(`   ${d.host.id.padEnd(9)}${d.exe || `${d.host.home} (no CLI on PATH)`}`);
}

let targets;
if (HOST_SPEC === 'auto') {
  targets = detected.filter((d) => d.present).map((d) => d.host);
  if (!targets.length) {
    warn('No agent CLI found. Install one:');
    for (const h of HOSTS) warn(`  ${h.label}: ${h.installHint}`);
    warn('Install continues, but the automation cannot run until one is available.');
  }
} else if (HOST_SPEC === 'both') {
  targets = HOSTS.slice();
} else {
  const host = hostById(HOST_SPEC);
  if (!host) {
    console.error(`\nUnknown --host "${HOST_SPEC}". Known: auto, both, ${HOSTS.map((h) => h.id).join(', ')}`);
    process.exit(1);
  }
  targets = [host];
}

// A hook wired to a missing CLI looks installed and never fires, so an explicit
// request for an absent host is an error rather than a silent skip.
if (HOST_SPEC !== 'auto') {
  for (const host of targets) {
    const row = detected.find((d) => d.host.id === host.id);
    if (!row || !row.present) {
      console.error(`\n${host.label} is not installed. Install it first:\n  ${host.installHint}`);
      process.exit(1);
    }
  }
}

let engine;
try {
  engine = resolveEngine(detected.filter((d) => targets.includes(d.host)), ENGINE_REQ);
} catch (err) {
  console.error(`\n${err.message}`);
  process.exit(1);
}
console.log(`   engine:   ${engine.label}`);
```

Config write, replacing the `writeConfig({...})` call:

```js
  const hosts = {};
  for (const host of targets) {
    const row = detected.find((d) => d.host.id === host.id);
    const entry = { exe: (row && row.exe) || host.exe };
    // Claude needs a model; Codex uses its own configured default unless told otherwise.
    const model = MODEL && host.id === engine.id ? MODEL : (host.id === 'claude' ? 'sonnet' : null);
    if (model) entry.model = model;
    hosts[host.id] = entry;
  }
  writeConfig({
    vaultPath: VAULT,
    engine: engine.id,
    hosts,
    platform: process.platform,
    installed: new Date().toISOString(),
  });
```

Skills step, replacing its `linkSkills` call and label:

```js
step(`Linking skills into ${targets.map((h) => h.label).join(' and ') || 'no agent'}`);
const links = linkSkills(DRY ? SCAFFOLD : VAULT, targets, { dryRun: DRY });
if (!links.length) warn('no skills found to link');
for (const l of links) {
  const tag = `${l.host}/${l.name}`;
  if (l.status === 'linked') did(`skill ${tag}`);
  else if (l.status === 'present') already(`skill ${tag} (already linked)`);
  else if (l.status === 'would-link') plan(`link skill ${tag}`);
  else if (l.status === 'copied') warn(`skill ${tag} copied, not linked (${l.reason}); edits will not flow back`);
  else if (l.status === 'real-directory') warn(`skill ${tag} exists as a real folder; left alone`);
  else if (l.status === 'points-elsewhere') warn(`skill ${tag} links to ${l.points}; left alone`);
  else warn(`skill ${tag}: ${l.status} ${l.reason || ''}`);
}
```

Hook step, one per host:

```js
step('Registering the Stop hook');
const cmd = hookCommand(process.execPath, WIKI_DIR);
for (const host of targets) {
  try {
    const r = installStopHook(host, cmd, { dryRun: DRY });
    if (r === 'added') did(`${host.label} Stop hook added (${host.hooksFile} backed up first)`);
    else if (r === 'present') already(`${host.label} Stop hook (already present)`);
    else plan(`add Stop hook to ${host.hooksFile}`);
  } catch (err) {
    warn(err.message);
  }
}
```

Uninstall block, looping over every host rather than just Claude:

```js
if (UNINSTALL) {
  step('Removing Stop hooks');
  for (const host of HOSTS) {
    try { console.log(`   ${host.id}: ${removeStopHook(host)}`); } catch (e) { warn(e.message); }
  }

  // …shell block, schedule: unchanged…

  step('Removing skill links');
  let removedLinks = 0;
  for (const host of HOSTS) {
    if (!fs.existsSync(host.skillsDir)) continue;
    for (const entry of fs.readdirSync(host.skillsDir)) {
      const p = path.join(host.skillsDir, entry);
      try {
        const st = fs.lstatSync(p);
        if (!st.isSymbolicLink()) continue;
        const target = fs.readlinkSync(p);
        if (!target.includes(path.join('.agents', 'skills'))) continue;
        fs.rmSync(p, { recursive: true, force: true });
        removedLinks += 1;
      } catch { /* leave anything we cannot read */ }
    }
  }
  console.log(`   ${removedLinks} skill link(s) removed`);
  // …summary: unchanged…
}
```

- [ ] **Step 4: Print the hook-trust note from Task 1**

Immediately after the hook loop, add — using whichever of the three strings Task 1 recorded:

```js
// Settled by the Task 1 spike. Codex enforces per-hook trust, so an installed hook
// is not necessarily a firing hook, and a hook that never fires means the vault
// silently stops growing. Say so rather than report success.
// Paste one of the three exact strings from Task 1, Step 5 here — whichever
// outcome the spike observed. Do not leave it null unless the spike showed the
// hook fires unprompted.
const codexHookTrustNote = null;
if (codexHookTrustNote && targets.some((h) => h.id === 'codex') && !DRY) {
  warn(codexHookTrustNote);
}
```

- [ ] **Step 5: Update the final next-steps text**

The closing block hardcodes `claude` as the command to run. Make it the engine's:

```js
  4. Ingest your first document:
         cd "${VAULT}"
         ${engine.exe}
         > /obsidian-wiki-ingest    then point it at a file in _raw/

  5. Once you have some ${engine.label} history:
         wiki-history --force
```

- [ ] **Step 6: Update the existing suite for the new signatures**

`test/suite.mjs` sections 2, 5 and 10 assert on `~/.claude` paths and the old config keys. Change:

- section 2's config assertions from `cfg.claudeExe` to `cfg.hosts.claude.exe`
- section 5's `installStopHook` driver to pass a host
- section 10's uninstall assertion to expect the per-host output line `claude: removed`

Leave every other assertion alone — the Claude path's behaviour has not changed.

- [ ] **Step 7: Run everything to verify it passes**

Run: `node test/codex.mjs && node test/suite.mjs`
Expected: both PASS on macOS, Linux and Windows.

- [ ] **Step 8: Commit**

```bash
git add install.mjs test/suite.mjs test/codex.mjs
git commit -m "Wire up every detected host, and refuse to fake one that is absent"
```

---

### Task 7: The runner picks an engine and watches it correctly

**Files:**
- Modify: `bin/run-ingest.mjs` (imports lines 20–24; `sessionActiveSince` lines 144–181; `PROMPT` lines 183–192; `main()` lines 205–275; watchdog lines 286–299; failure messages lines 313–315; `newestLogEntry` lines 360–372)
- Test: `test/codex.mjs` (new section 8)

**Interfaces:**
- Consumes: `hostById`, `resolveEngine`, `detectHosts` from Task 2; migrated config from Task 3; descriptor fields `buildArgs`, `watchdog`, `label`, `exe`, `historyArg`, `logTag`.
- Produces: no exported API — this is the end of the chain.

- [ ] **Step 1: Write the failing test**

Append to `test/codex.mjs`:

```js
head('8. The runner, against a codex stub');

{
  const { home, env } = makeHome('vault-kit-run-');
  const vault = path.join(home, 'Documents', 'Obsidian Vault');
  const wiki = path.join(home, '.obsidian-wiki');

  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const inst = run(path.resolve('install.mjs'), ['--vault', vault, '--host', 'codex', '--no-git'], env);
  eq('install for codex exits clean', inst.code, 0);

  // A stub that proves it was invoked, then moves the ledger and the log so the
  // runner's verification has something real to find.
  const marker = path.join(home, 'argv.txt');
  const worker = path.join(home, 'agent.mjs');
  fs.writeFileSync(worker, `
import fs from 'node:fs';
import path from 'node:path';
fs.writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join('\\n'));
const vault = ${JSON.stringify(vault)};
const mf = path.join(vault, '.manifest.json');
const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
m.sources = m.sources || [];
m.sources.push({ source_path: 'stub/rollout.jsonl', source_type: 'codex_rollout',
  ingested_at: new Date().toISOString(), pages_created: ['concepts/stub.md'] });
fs.writeFileSync(mf, JSON.stringify(m, null, 2));
const log = path.join(vault, 'log.md');
let t = fs.readFileSync(log, 'utf8');
t = t.replace('# Wiki Log', '# Wiki Log\\n\\n- [' + new Date().toISOString() + '] CODEX_HISTORY_INGEST sessions=1 pages_created=1');
fs.writeFileSync(log, t);
console.log('stub codex: ingested 1 session');
`);

  let stub;
  if (process.platform === 'win32') {
    stub = path.join(home, 'codex.cmd');
    fs.writeFileSync(stub, `@echo off\r\n"${process.execPath}" "${worker}" %*\r\n`);
  } else {
    stub = path.join(home, 'codex');
    fs.writeFileSync(stub, `#!/bin/sh\nexec "${process.execPath}" "${worker}" "$@"\n`);
    fs.chmodSync(stub, 0o755);
  }

  const cfgPath = path.join(wiki, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.hosts.codex.exe = stub;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  run(path.join(wiki, 'bin', 'mark-pending.mjs'), [], env);
  const r = run(path.join(wiki, 'bin', 'run-ingest.mjs'), [], env);

  eq('the runner exits clean', r.code, 0);
  truthy('the codex stub was spawned', fs.existsSync(marker));
  if (fs.existsSync(marker)) {
    const argv = fs.readFileSync(marker, 'utf8');
    has('it ran exec', argv, 'exec');
    has('it streamed json', argv, '--json');
    has('it was sandboxed to the workspace', argv, 'workspace-write');
    has('it was pointed at the vault', argv, '--cd');
    has('it was told to ingest codex history', argv, 'codex');
    truthy('no --session-id was passed', !argv.includes('--session-id'));
    truthy('no -p was passed', !argv.split('\n').includes('-p'));
  }
  has('the headline came from a CODEX log line', r.out, 'CODEX_HISTORY_INGEST');
  truthy('the pending flag cleared', !fs.existsSync(path.join(wiki, '.pending_ingest')));

  // A stub that exits zero having changed nothing is still a failure.
  fs.writeFileSync(worker, "console.log('stub codex: did nothing');\n");
  run(path.join(wiki, 'bin', 'mark-pending.mjs'), [], env);
  const r2 = run(path.join(wiki, 'bin', 'run-ingest.mjs'), [], env);
  eq('a no-op codex run exits non-zero', r2.code, 1);
  has('and is reported as a failure', r2.out, 'without updating .manifest.json');
  eq('and leaves the queue intact', fs.readFileSync(path.join(wiki, '.pending_sessions'), 'utf8').trim().split('\n').length, 1);

  fs.rmSync(home, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node test/codex.mjs`
Expected: FAIL — `the runner exits clean` is non-zero; the runner still imports the deleted `CLAUDE_PROJECTS`.

- [ ] **Step 3: Select the engine and build its arguments**

Imports:

```js
import {
  CONFIG_PATH, LOCK_PATH, LOG_DIR,
  PENDING_FLAG, PENDING_SESSIONS, RUN_STARTED, WIKI_DIR,
  localDateStamp, platformLabel, readConfig,
} from '../lib/platform.mjs';
import { HOSTS, hostById } from '../lib/host.mjs';
```

In `main()`, replace the `claudeExe`/`model` lines:

```js
  const vault = cfg.vaultPath;

  const engine = hostById(cfg.engine) || hostById('claude');
  const engineCfg = (cfg.hosts && cfg.hosts[engine.id]) || {};
  const engineExe = engineCfg.exe || engine.exe;
  const model = engineCfg.model || null;

  // Every host the install wired up contributes a history source, whichever one
  // is doing the running. That is what makes one schedule right for a machine
  // with both agents on it.
  const sources = HOSTS.filter((h) => cfg.hosts && cfg.hosts[h.id]).map((h) => h.historyArg);
  if (!sources.length) sources.push(engine.historyArg);
```

and the spawn setup:

```js
  const sessionId = randomUUID();
  const hostArgs = engine.buildArgs({ prompt: buildPrompt(sources), model, sessionId, vault });

  let exe = engineExe;
  let spawnArgs = hostArgs;
  const spawnOpts = { cwd: vault, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true };

  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(engineExe)) {
    const quote = (a) => `"${String(a).replace(/"/g, '""')}"`;
    exe = process.env.COMSPEC || 'cmd.exe';
    spawnArgs = ['/d', '/s', '/c', `"${[engineExe, ...hostArgs].map(quote).join(' ')}"`];
    spawnOpts.windowsVerbatimArguments = true;
    log(`routing through ${path.basename(exe)}: ${path.basename(engineExe)} is a batch shim`);
  }

  log(`starting ${engine.label} (session ${sessionId}, model ${model || 'host default'}, sources ${sources.join('+')})`);
```

- [ ] **Step 4: Make the prompt enumerate its sources**

Replace the `PROMPT` constant with a function:

```js
/**
 * The router takes one source per invocation, so a machine with both agents gets
 * one pass each. The manifest-stamp guard is unaffected: it asks only whether
 * .manifest.json moved, so one pass doing real work still proves the run ingested.
 */
function buildPrompt(sources) {
  return [
    `Use the wiki-history-ingest skill once for each of these sources, in order: ${sources.join(', ')}.`,
    "For each source, ingest every transcript and memory file that the manifest's per-file",
    'sources rows show as new or modified. Work unattended: do not ask questions;',
    'make the call and record it in the log.md entry, which goes directly under the',
    "'# Wiki Log' heading (newest first). If the delta is large, have read-only",
    'subagents digest groups of sessions while you stay the only writer to the vault.',
    'Every timestamp you write must come from a real clock reading in UTC, never an',
    'estimate.',
  ].join(' ');
}
```

- [ ] **Step 5: Make the watchdog per-host**

`sessionActiveSince` takes the directory to walk, since it is no longer always `CLAUDE_PROJECTS`:

```js
function sessionActiveSince(sessionsDir, sessionId, cutoffMs) {
  // …body unchanged, except the final line…
  walk(sessionsDir, 0);
  return found;
}
```

Track stdout activity in the sink, and branch in the interval:

```js
    let lastOutputMs = Date.now();
    const sink = (buf) => {
      lastOutputMs = Date.now();
      try { fs.appendFileSync(LOG, buf); } catch { /* ignore */ }
      if (!QUIET) process.stdout.write(buf);
    };
    child.stdout.on('data', sink);
    child.stderr.on('data', sink);

    // Watchdog. A run that stops making progress for STALL_MINUTES is hung, not
    // thinking: an earlier version of this pipeline once sat on a single model call
    // for 100 minutes.
    //
    // How progress is measured differs by host. Claude's -p stdout stays silent
    // until the end, so transcript mtimes are the only signal, and subagent
    // transcripts count. Codex streams a JSON event per step and has no
    // --session-id to find a transcript by, so its stdout is both the available
    // signal and the better one: an unrelated interactive session cannot fake it.
    let killed = false;
    const watchdog = setInterval(() => {
      if (child.exitCode !== null) return;
      const cutoff = Date.now() - STALL_MINUTES * 60000;
      const active = engine.watchdog === 'stdout'
        ? lastOutputMs > cutoff
        : sessionActiveSince(engine.sessionsDir, sessionId, cutoff);
      if (active) return;
      log(`watchdog: ${engine.label} made no progress for ${STALL_MINUTES} minutes; stopping it`);
      killed = true;
      child.kill();
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 30000);
    }, 60000);
```

- [ ] **Step 6: Name the host in failures, and widen the headline match**

```js
  if (exitCode === -2) fail(`the run stalled and was stopped (session ${sessionId})`);
  if (exitCode === -1) fail(`could not run ${engineExe} (session ${sessionId})`);
  if (exitCode !== 0) fail(`${engine.label} exited ${exitCode} (session ${sessionId})`);
```

`newestLogEntry` hardcodes `CLAUDE`, so a Codex-only run would silently fall back to the generic headline. Build the pattern from the registry's log tags instead:

```js
/**
 * Newest log.md entry by timestamp, wherever the run filed it.
 *
 * The tags come from the host registry rather than being hardcoded, because a
 * Codex-only run writes CODEX_HISTORY_INGEST and would otherwise fall through to
 * the generic headline, making a real ingest look like a run that did nothing.
 */
function newestLogEntry(logMd) {
  const tags = HOSTS.map((h) => h.logTag).join('|');
  const pattern = new RegExp(`^- \\[[^\\]]*\\]\\s*(${tags})`, 'i');
  try {
    const lines = fs.readFileSync(logMd, 'utf8').split('\n')
      .filter((l) => pattern.test(l))
      .sort()
      .reverse();
    if (!lines.length) return null;
    return lines[0].slice(2).slice(0, 168);
  } catch {
    return null;
  }
}
```

Also update the file's header comment and `--help` text: it says "Claude-history -> wiki ingest" and "ingest Claude Code history", which is no longer true. Make both read "agent history".

- [ ] **Step 7: Test that the stdout watchdog actually fires**

This is the only direct test of the watchdog in the repo, and the guard exists because
a run once sat on a single model call for 100 minutes. The watchdog interval is fixed at
60 seconds, so this costs about 95 seconds of wall clock. Worth it.

Append to `test/codex.mjs`, inside section 8 before the cleanup:

```js
  // A stub that goes quiet must be killed, not waited on forever.
  fs.writeFileSync(worker, `
console.log('stub codex: starting');
setTimeout(() => { console.log('too late'); }, 300000);
`);
  run(path.join(wiki, 'bin', 'mark-pending.mjs'), [], env);
  const started = Date.now();
  const r3 = run(path.join(wiki, 'bin', 'run-ingest.mjs'), ['--stall-minutes', '1'], env);
  const tookSeconds = (Date.now() - started) / 1000;

  truthy('a silent run is killed, not waited on', r3.code !== 0);
  has('the watchdog says why', r3.out, 'made no progress');
  truthy(`it was killed promptly (took ${Math.round(tookSeconds)}s, under 180)`, tookSeconds < 180);
  eq('a killed run leaves the queue intact',
    fs.readFileSync(path.join(wiki, '.pending_sessions'), 'utf8').trim().split('\n').length, 1);
```

- [ ] **Step 8: Run everything to verify it passes**

Run: `node test/codex.mjs && node test/suite.mjs`
Expected: both PASS. `test/codex.mjs` now takes roughly two minutes because of Step 7.

- [ ] **Step 9: Commit**

```bash
git add bin/run-ingest.mjs test/codex.mjs
git commit -m "Run the ingest on whichever agent is the engine, watched its own way"
```

---

### Task 8: AGENTS.md becomes the vault contract

Claude reads `CLAUDE.md`; Codex reads `AGENTS.md`. `copyIfAbsent` would skip an existing vault and leave Codex with no contract at all, and `ARCHITECTURE.md` actively tells people to edit `CLAUDE.md`, so existing copies are modified and must not be lost.

**Files:**
- Create: `vault-scaffold/AGENTS.md` (the current `CLAUDE.md` content, verbatim)
- Modify: `vault-scaffold/CLAUDE.md` (becomes a pointer)
- Modify: `lib/vault.mjs` (new `migrateContract()`)
- Modify: `install.mjs` (call it in the vault step)
- Test: `test/codex.mjs` (new section 9)

**Interfaces:**
- Consumes: nothing new.
- Produces: `migrateContract(vaultPath, { dryRun })` → `'moved' | 'both-present' | 'nothing-to-do' | 'would-move'`.

- [ ] **Step 1: Write the failing test**

Append to `test/codex.mjs`:

```js
head('9. The vault contract moves to AGENTS.md');

{
  const { home, env } = makeHome('vault-kit-contract-');
  const vault = path.join(home, 'v');
  fs.mkdirSync(vault, { recursive: true });

  // A contract the user has edited. Losing their edit would be the bug.
  fs.writeFileSync(path.join(vault, 'CLAUDE.md'), '# Vault contract\n\nMY OWN RULE: never file under areas/.\n');

  const driver = path.join(home, 'contract.mjs');
  fs.writeFileSync(driver, `
import { migrateContract } from ${JSON.stringify(path.resolve('lib/vault.mjs'))};
console.log(migrateContract(${JSON.stringify(vault)}));
`);

  eq('an edited CLAUDE.md is moved', run(driver, [], env).out.trim(), 'moved');
  has('the edit survives in AGENTS.md', fs.readFileSync(path.join(vault, 'AGENTS.md'), 'utf8'), 'MY OWN RULE');
  has('CLAUDE.md becomes a pointer', fs.readFileSync(path.join(vault, 'CLAUDE.md'), 'utf8'), 'AGENTS.md');
  truthy('the original was backed up',
    fs.readdirSync(vault).some((f) => f.startsWith('CLAUDE.md.bak-')));
  eq('running again is a no-op', run(driver, [], env).out.trim(), 'both-present');

  fs.rmSync(home, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node test/codex.mjs`
Expected: FAIL — `migrateContract` is not exported.

- [ ] **Step 3: Add migrateContract to lib/vault.mjs**

```js
const CONTRACT_POINTER = `# Vault contract

The contract this vault runs on lives in **AGENTS.md** — zones, frontmatter, graph
rules, all of it. Read that file; edit that file.

This pointer exists because Claude Code looks for CLAUDE.md and Codex looks for
AGENTS.md. One authority, two names, no drift.
`;

/**
 * Make AGENTS.md the vault's contract, keeping any edits the user made to CLAUDE.md.
 *
 * copyIfAbsent would skip an existing vault entirely and leave Codex with no
 * contract at all, and ARCHITECTURE.md tells people to edit CLAUDE.md, so those
 * edits are real and must survive. Moving rather than copying is what keeps one
 * authority instead of two files that drift.
 */
export function migrateContract(vaultPath, { dryRun = false } = {}) {
  const claudeMd = path.join(vaultPath, 'CLAUDE.md');
  const agentsMd = path.join(vaultPath, 'AGENTS.md');
  const hasClaude = fs.existsSync(claudeMd);
  const hasAgents = fs.existsSync(agentsMd);

  if (hasAgents && hasClaude) return 'both-present';
  if (!hasClaude) return 'nothing-to-do';
  if (dryRun) return 'would-move';

  fs.copyFileSync(claudeMd, `${claudeMd}.bak-${stampName()}`);
  fs.renameSync(claudeMd, agentsMd);
  fs.writeFileSync(claudeMd, CONTRACT_POINTER);
  return 'moved';
}

function stampName() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}
```

- [ ] **Step 4: Split the scaffold's contract into the two files**

```bash
git mv vault-scaffold/CLAUDE.md vault-scaffold/AGENTS.md
```

Then write `vault-scaffold/CLAUDE.md` with exactly the `CONTRACT_POINTER` text above, so a fresh vault and a migrated one look identical.

Grep the scaffold's skills for references to the old name and update them — the contract is read at the start of every session, so a skill pointing at the wrong file is a real break:

```bash
grep -rn "CLAUDE\.md" vault-scaffold/ docs/ README.md SETUP-GUIDE.md
```

- [ ] **Step 5: Call it from the installer**

In the vault step of `install.mjs`, after the `copyIfAbsent` block:

```js
const contract = migrateContract(VAULT, { dryRun: DRY });
if (contract === 'moved') did('CLAUDE.md moved to AGENTS.md, your edits kept (backup alongside)');
else if (contract === 'both-present') already('AGENTS.md is the contract (CLAUDE.md left as it is)');
else if (contract === 'would-move') plan('move CLAUDE.md to AGENTS.md and leave a pointer');
```

Add `migrateContract` to the `lib/vault.mjs` import list at the top of `install.mjs`.

- [ ] **Step 6: Run everything to verify it passes**

Run: `node test/codex.mjs && node test/suite.mjs`
Expected: both PASS. `test/suite.mjs` asserts on scaffold file counts in section 2; if a count changed, update it — one file became two.

- [ ] **Step 7: Commit**

```bash
git add vault-scaffold/AGENTS.md vault-scaffold/CLAUDE.md lib/vault.mjs install.mjs test/codex.mjs test/suite.mjs
git commit -m "Make AGENTS.md the contract, without losing anyone's edits"
```

---

### Task 9: Ship the codex-history-ingest skill

The router in `wiki-history-ingest` sends `codex` to a skill the repo does not ship, so a Codex daily run would route to nothing.

**Files:**
- Create: `vault-scaffold/.agents/skills/codex-history-ingest/SKILL.md`
- Create: `vault-scaffold/.agents/skills/codex-history-ingest/references/codex-data-format.md`
- Test: `test/codex.mjs` (new section 10)

**Interfaces:**
- Consumes: nothing in code. The runner reaches it only through the router by name.
- Produces: a skill directory the `wiki-history-ingest` router's `codex` row resolves to.

- [ ] **Step 1: Write the failing test**

Append to `test/codex.mjs`:

```js
head('10. Every source the router names is shipped');

{
  const skills = path.resolve('vault-scaffold/.agents/skills');
  const router = fs.readFileSync(path.join(skills, 'wiki-history-ingest', 'SKILL.md'), 'utf8');

  // The runner asks for a source by name; a row pointing at a skill that is not
  // here means the daily run routes to nothing and the vault stops growing.
  truthy('the router routes codex', /\|\s*`codex`\s*\|/.test(router));
  truthy('codex-history-ingest is shipped', fs.existsSync(path.join(skills, 'codex-history-ingest', 'SKILL.md')));

  const skill = fs.readFileSync(path.join(skills, 'codex-history-ingest', 'SKILL.md'), 'utf8');
  has('it declares its name', skill, 'name: codex-history-ingest');
  has('it has a description Codex can route on', skill, 'description:');
  has('it reads the Codex sessions directory', skill, '.codex');
  has('it writes the log tag the runner greps for', skill, 'CODEX_HISTORY_INGEST');
  truthy('no personal paths leaked in', !/\/Users\/[a-z]+\//i.test(skill));
  truthy('no dependency on a skill the kit does not ship', !skill.includes('llm-wiki/SKILL.md'));
  truthy('the reference file is shipped',
    fs.existsSync(path.join(skills, 'codex-history-ingest', 'references', 'codex-data-format.md')));
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node test/codex.mjs`
Expected: FAIL — `codex-history-ingest is shipped`.

- [ ] **Step 3: Copy the skill in from a working vault**

```bash
mkdir -p vault-scaffold/.agents/skills/codex-history-ingest/references
cp ~/Documents/Obsidian\ Vault/.agents/skills/codex-history-ingest/SKILL.md \
   vault-scaffold/.agents/skills/codex-history-ingest/SKILL.md
cp ~/Documents/Obsidian\ Vault/.agents/skills/codex-history-ingest/references/codex-data-format.md \
   vault-scaffold/.agents/skills/codex-history-ingest/references/codex-data-format.md
```

- [ ] **Step 4: Adapt it the way claude-history-ingest was adapted**

Four edits, matching what the shipped `claude-history-ingest` already does. Read that file first and follow it:

1. **Config resolution.** Replace the "follow the Config Resolution Protocol in `llm-wiki/SKILL.md`" step with the inline version `claude-history-ingest` uses: read `~/.obsidian-wiki/config.json` if present, else default `OBSIDIAN_VAULT_PATH` to `~/Documents/Obsidian Vault`; the Codex history path defaults to `~/.codex`.
2. **Personal paths out.** Replace every `/Users/muzzy/...` example with a neutral one (`/home/sam/code/my-app`), and add the Windows spelling beside it.
3. **Windows paths in.** Sessions are at `~/.codex/sessions/YYYY/MM/DD/`; give the `%USERPROFILE%\.codex\sessions\...` form too.
4. **No cross-vault references.** Grep for other skill names and keep only ones this repo ships:

```bash
grep -n "llm-wiki\|/Users/\|confluence\|case-study" vault-scaffold/.agents/skills/codex-history-ingest/SKILL.md
ls vault-scaffold/.agents/skills/
```

Keep the `CODEX_HISTORY_INGEST` log-line format exactly as it is — Task 7's headline regex greps for that tag.

- [ ] **Step 5: Run everything to verify it passes**

Run: `node test/codex.mjs && node test/suite.mjs`
Expected: both PASS. The suite's scaffold file-count assertions in section 2 will need the two new files added.

- [ ] **Step 6: Commit**

```bash
git add vault-scaffold/.agents/skills/codex-history-ingest test/codex.mjs test/suite.mjs
git commit -m "Ship the codex history skill the router already promised"
```

---

### Task 10: Documentation catches up

**Files:**
- Modify: `docs/ARCHITECTURE.md` (five-layer diagram; platform-boundaries section; changing-things table; failure-modes table; porting section)
- Modify: `SETUP-GUIDE.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything Tasks 2–9 built.
- Produces: nothing code depends on.

- [ ] **Step 1: Update the five-layer diagram**

Layer 2 currently says "symlink (unix) / junction (windows) -> ~/.claude/skills/ (what Claude Code actually loads)". It becomes one link set per detected host:

```
  2. SKILLS      `- symlink (unix) / junction (windows) ->
                      ~/.claude/skills/   (Claude Code)
                      ~/.codex/skills/    (Codex CLI)
                    one set per installed host; the vault stays the source of truth
                |
  3. TRIGGER     Stop hook, per host  -> bin/mark-pending.mjs
                   ~/.claude/settings.json  |  ~/.codex/hooks.json
                                     writes .pending_ingest + one line per turn
                |
  4. RUNNER      scheduler (daily) -> bin/run-ingest.mjs
                 or `wiki-history` by hand    |
                                              `-> the engine host, headless,
                                                  running wiki-history-ingest
                                                  once per installed source
```

Also change `CLAUDE.md the contract` to `AGENTS.md the contract` in layer 1, and the line "Layers 1, 3 and 5 are identical on every platform" — layer 3 now differs by host as well as being platform-neutral. Say so.

- [ ] **Step 2: Add a "Porting to another agent" section**

Next to the existing "Porting to another platform", written in the same voice:

```markdown
## Porting to another agent

One file knows which agent CLI it is talking to: `lib/host.mjs`. Add a descriptor with
the host's home directory, skills directory, hooks file, sessions directory, the
`wiki-history-ingest` source name it maps to, the log tag its skill writes, and a
`buildArgs()` that produces an unattended invocation. Then ship a history-ingest skill
for it, because the router will route to it by name and a missing skill means the daily
run does nothing.

Two things to get right, both learned the hard way on Codex:

**How you tell whether the run is still alive.** Claude Code's `-p` stdout is silent
until the end, so progress can only be read from transcript mtimes, and subagent
transcripts have to count. Codex has no `--session-id` to find a transcript by, so
there is nothing to scan — but `--json` makes stdout an event stream, which is the
better signal anyway: an unrelated interactive session cannot fake it. Pick whichever
signal the host actually gives you and say which in the descriptor's `watchdog` field.

**How tightly the agent is confined, and whether you can say so honestly.** Claude Code
takes a per-command allowlist. Codex has no equivalent: it confines by sandbox, so
`workspace-write` plus `--cd <vault>` is the closest thing, which permits reads the
Claude path forbids. That is a real difference in what the kit promises, so it is
written down here rather than glossed.

If you find yourself editing a second file to add an agent, the abstraction has leaked,
and the fix is to move the agent-specific part into `lib/host.mjs` rather than spread it
further.
```

- [ ] **Step 3: Add the new failure modes**

Two rows in the failure-modes table, placed by how long they hide:

```markdown
| Codex hook installed but never trusted | Weeks later: the vault stopped growing and nothing errored | Installer prints the trust step instead of reporting success |
| Codex-only run's headline looks empty | The notification says "history ingest finished" on a real ingest | `newestLogEntry` builds its pattern from every host's log tag |
```

And in the changing-things table:

```markdown
| Which agent runs the daily ingest | `engine` in `~/.obsidian-wiki/config.json`, or `install.mjs --engine codex` |
| Which agents get a hook and skill links | `install.mjs --host auto\|claude\|codex\|both` |
```

- [ ] **Step 4: Update SETUP-GUIDE.md**

Add a Codex path beside the Claude one — the install command, what `~/.codex/hooks.json` gets, what to expect from the hook-trust step per Task 1, and how to verify: run a turn, check `~/.obsidian-wiki/.pending_ingest` appears, then `wiki-history --force`.

Add troubleshooting rows: *nothing happens after a Codex turn* (check the hook is in `hooks.json` and trusted in `config.toml`); *codex exits complaining about a git repo* (the runner passes `--skip-git-repo-check`, so this means an old Codex — upgrade); *the ingest cannot write the vault* (check `--cd` points at the vault and the sandbox is `workspace-write`).

- [ ] **Step 5: Update README.md**

One requirements line, since this is the file a new user reads first:

```markdown
**You need** Node 22+, Obsidian, and one agent CLI — either
[Claude Code](https://claude.com/claude-code) or [Codex](https://github.com/openai/codex).
The installer detects which you have. If you have both, it wires up both and ingests
both histories on one daily run.
```

Check the README's own walkthrough for `claude` as a literal command and make it agent-neutral where it is describing the kit rather than a specific host.

- [ ] **Step 6: Verify the docs match the code**

```bash
grep -rn "CLAUDE\.md\|~/.claude/skills\|claudeExe" README.md SETUP-GUIDE.md docs/ARCHITECTURE.md
```

Every hit should be either deliberate (describing the Claude host specifically) or fixed. Then run everything once more:

```bash
node test/codex.mjs && node test/suite.mjs
for f in install.mjs lib/*.mjs bin/*.mjs test/*.mjs; do node --check "$f" || echo "SYNTAX $f"; done
wc -l install.mjs lib/*.mjs bin/*.mjs test/*.mjs | sort -n | tail -5
```

The last command guards the 500-line rule.

- [ ] **Step 7: Commit**

```bash
git add README.md SETUP-GUIDE.md docs/ARCHITECTURE.md
git commit -m "Document the second host, including where it is weaker than the first"
```

---

## Verification before calling it done

- [ ] `node test/suite.mjs` green on macOS, Linux and Windows (CI matrix covers all three)
- [ ] `node test/codex.mjs` green on all three
- [ ] A legacy flat config still runs the ingest with no re-install
- [ ] `install.mjs --dry-run --host both` changes nothing and names both hosts
- [ ] `install.mjs --uninstall` leaves an unrelated hook in each host's config intact
- [ ] Every file under 500 lines
- [ ] On a machine with Codex: a real turn writes `.pending_ingest`, and `wiki-history --force` ingests Codex history into the vault
