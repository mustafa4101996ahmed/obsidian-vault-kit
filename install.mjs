#!/usr/bin/env node
// Installs the Obsidian vault kit on macOS, Linux or Windows.
//
//   node install.mjs --dry-run              show everything, change nothing
//   node install.mjs                        install, schedule left off
//   node install.mjs --schedule 19:00       install and turn on the daily ingest
//   node install.mjs --vault "D:\Vault"     put the vault somewhere else
//   node install.mjs --uninstall            remove hook, shell block, schedule, links
//
// Safe to run more than once. Nothing is overwritten without a backup, and every
// step says whether it changed anything or found it already done.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_VAULT, IS_WIN, WIKI_DIR,
  has, platformLabel, readConfig, which, writeConfig,
} from './lib/platform.mjs';
import { HOSTS, detectHosts, hostById, resolveEngine } from './lib/host.mjs';
import { copyIfAbsent, installGitignore, installRunner, linkSkills, migrateContract, stampManifest, stampSeedDates } from './lib/vault.mjs';
import { hookCommand, installStopHook, removeStopHook } from './lib/hooks.mjs';
import { installShellBlocks, removeShellBlocks } from './lib/shell.mjs';
import { availableSchedulers, installSchedule, removeSchedule, scheduleStatus } from './lib/schedule.mjs';

const KIT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SCAFFOLD = path.join(KIT_ROOT, 'vault-scaffold');

// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run') || argv.includes('-n');
const UNINSTALL = argv.includes('--uninstall');
const HELP = argv.includes('--help') || argv.includes('-h');
const NO_GIT = argv.includes('--no-git');
const VAULT = strArg('--vault') || DEFAULT_VAULT;
const HOST_SPEC = strArg('--host') || 'auto';
const ENGINE_REQ = strArg('--engine');
const MODEL = strArg('--model');   // was: || 'sonnet'. Per-host defaults now apply.
const SCHEDULE = strArg('--schedule');

function strArg(name) {
  const i = argv.indexOf(name);
  return i !== -1 && i < argv.length - 1 ? argv[i + 1] : null;
}

if (HELP) {
  process.stdout.write(`
Obsidian vault kit installer

  node install.mjs [options]

  --dry-run, -n         show what would happen, change nothing
  --vault <path>        where the vault goes (default: ${DEFAULT_VAULT})
  --host <spec>         which agent to wire up: auto (default), claude, codex, both
  --engine <id>         which agent runs the daily ingest (default: claude if present)
  --schedule <HH:MM>    also turn on the daily ingest at this time
  --model <name>        model the ingest uses (default: sonnet for Claude, the host's own default for Codex)
  --no-git              skip initialising the vault as a git repo
  --uninstall           remove the hook, shell block, schedule and skill links
  --help, -h            this text

The vault's notes are never touched by an uninstall.
`);
  process.exit(0);
}

// ---------------------------------------------------------------------------

const changed = [];
const skipped = [];
const warned = [];

const c = process.stdout.isTTY
  ? { cy: '\x1b[36m', gn: '\x1b[32m', gy: '\x1b[90m', yl: '\x1b[33m', mg: '\x1b[35m', z: '\x1b[0m' }
  : { cy: '', gn: '', gy: '', yl: '', mg: '', z: '' };

const step = (m) => console.log(`\n${c.cy}>> ${m}${c.z}`);
const did = (m) => { changed.push(m); console.log(`   ${c.gn}+${c.z} ${m}`); };
const already = (m) => { skipped.push(m); console.log(`   ${c.gy}= ${m}${c.z}`); };
const warn = (m) => { warned.push(m); console.log(`   ${c.yl}! ${m}${c.z}`); };
const plan = (m) => console.log(`   ${c.mg}~ would: ${m}${c.z}`);

if (DRY) console.log(`${c.mg}DRY RUN: nothing will be written.${c.z}`);

// ===========================================================================

if (UNINSTALL) {
  step('Removing Stop hooks');
  for (const host of HOSTS) {
    try { console.log(`   ${host.id}: ${removeStopHook(host)}`); } catch (e) { warn(e.message); }
  }

  step('Removing the shell block');
  const sh = removeShellBlocks();
  if (!sh.length) already('no shell block found');
  for (const r of sh) did(`${r.status}: ${r.file}`);

  step('Removing the daily schedule');
  for (const line of removeSchedule()) console.log(`   ${line}`);

  step('Removing skill links');
  // Scope removal to the vault this install actually manages. Matching any path
  // containing '.agents/skills' would also delete a link the user made by hand into
  // a different vault, which uninstall has no business touching.
  let vaultScope = null;
  try { vaultScope = readConfig()?.vaultPath || null; } catch { /* unreadable config */ }

  let removedLinks = 0;
  for (const host of HOSTS) {
    if (!fs.existsSync(host.skillsDir)) continue;
    for (const entry of fs.readdirSync(host.skillsDir)) {
      const p = path.join(host.skillsDir, entry);
      try {
        const st = fs.lstatSync(p);
        if (!st.isSymbolicLink()) continue;
        const target = fs.readlinkSync(p);
        // A relative target resolves against the link's own directory, not the
        // process cwd — the same resolution lib/vault.mjs uses to detect
        // points-elsewhere, so the two agree on what a link points at.
        const absTarget = path.resolve(path.dirname(p), target);
        const isOurs = vaultScope
          ? absTarget.startsWith(path.resolve(vaultScope) + path.sep)
          : target.includes(path.join('.agents', 'skills'));
        if (!isOurs) continue;
        fs.rmSync(p, { recursive: true, force: true });
        removedLinks += 1;
      } catch { /* leave anything we cannot read */ }
    }
  }
  console.log(`   ${removedLinks} skill link(s) removed`);

  console.log(`\n${c.gy}------------------------------------------------------------${c.z}`);
  console.log('Uninstalled. Your vault and its notes were not touched.');
  console.log(`The vault is still at its location; ${WIKI_DIR} still holds your logs.`);
  process.exit(0);
}

// ===========================================================================
step('Checking prerequisites');
// ===========================================================================

console.log(`   platform: ${platformLabel()}`);
console.log(`   node:     ${process.version} (${process.execPath})`);

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

// An engine has to be one of the hosts we are wiring up. Distinguish that from
// "not installed": telling someone to install Codex when they already have it
// sends them round a loop they have already been round.
if (ENGINE_REQ) {
  const wanted = hostById(ENGINE_REQ);
  if (!wanted) {
    console.error(`\nUnknown --engine "${ENGINE_REQ}". Known: ${HOSTS.map((h) => h.id).join(', ')}`);
    process.exit(1);
  }
  if (!targets.some((h) => h.id === wanted.id)) {
    const row = detected.find((d) => d.host.id === wanted.id);
    if (row && row.present) {
      console.error(`\n${wanted.label} is installed, but --host ${HOST_SPEC} does not include it.`);
      console.error(`Use --host both, or --host ${wanted.id}, to make it the engine.`);
    } else {
      console.error(`\n${wanted.label} is not installed, so it cannot be the engine. Install it first:\n  ${wanted.installHint}`);
    }
    process.exit(1);
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

const gitAvailable = has('git');
if (!gitAvailable) warn('git is not on PATH; the vault will not be version-controlled.');

const schedulers = availableSchedulers();
console.log(`   schedulers available: ${schedulers.length ? schedulers.join(', ') : 'none'}`);
if (!schedulers.length) {
  warn('No scheduler available on this system. The ingest will need running by hand');
  warn('with `wiki-history`. Everything else works normally.');
}

if (!fs.existsSync(SCAFFOLD)) {
  console.error(`\nScaffold missing at ${SCAFFOLD}. Is this the kit root?`);
  process.exit(1);
}

// ===========================================================================
step(`Creating the vault at ${VAULT}`);
// ===========================================================================

if (fs.existsSync(VAULT) && fs.readdirSync(VAULT).length > 0) {
  warn('That folder already exists and is not empty.');
  warn('Existing files are never overwritten; only missing ones are added.');
}

const copied = copyIfAbsent(SCAFFOLD, VAULT, { dryRun: DRY, skip: ['_gitignore'] });
if (DRY) {
  plan(`create ${copied.dirs.length} directories and ${copied.created.length} files`);
  if (copied.kept.length) plan(`keep ${copied.kept.length} existing file(s) untouched`);
} else if (copied.created.length || copied.dirs.length) {
  did(`${copied.created.length} file(s) written, ${copied.dirs.length} directory(ies) created`);
  if (copied.kept.length) already(`${copied.kept.length} existing file(s) kept as they were`);
} else {
  already(`vault complete (${copied.kept.length} file(s) already in place)`);
}

const contract = migrateContract(VAULT, { dryRun: DRY });
if (contract === 'moved') did('CLAUDE.md moved to AGENTS.md, your edits kept (backup alongside)');
else if (contract === 'both-present') already('AGENTS.md is the contract (CLAUDE.md left as it is)');
else if (contract === 'would-move') plan('move CLAUDE.md to AGENTS.md and leave a pointer');

const gi = installGitignore(SCAFFOLD, VAULT, { dryRun: DRY });
if (gi === 'installed') did('.gitignore installed');
else if (gi === 'kept-existing') already('.gitignore (kept yours)');
else if (gi === 'would-install') plan('install _gitignore as .gitignore');

const ms = stampManifest(VAULT, { dryRun: DRY });
if (ms === 'stamped') did('vault path stamped into .manifest.json');
else if (ms === 'already-stamped') already('.manifest.json already stamped');
else if (ms === 'would-stamp') plan('stamp the vault path into .manifest.json');

const dated = stampSeedDates(VAULT, { dryRun: DRY });
if (dated.length) {
  if (DRY) plan(`date-stamp ${dated.length} seed page(s)`);
  else did(`date-stamped ${dated.length} seed page(s)`);
}

// ===========================================================================
step('Installing the automation');
// ===========================================================================

if (DRY) {
  plan(`copy bin/ and lib/ to ${WIKI_DIR}`);
  plan('write config.json');
} else {
  const r = installRunner(KIT_ROOT, WIKI_DIR, { dryRun: false });
  did(`runner installed to ${r.destBin}`);
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
  did('config.json written');
}

// ===========================================================================
step(`Linking skills into ${targets.map((h) => h.label).join(' and ') || 'no agent'}`);
// ===========================================================================
// Junctions on Windows, symlinks elsewhere. Neither needs administrator rights.
// The vault stays the single source of truth: edit the skill in the vault.

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

// ===========================================================================
step('Registering the Stop hook');
// ===========================================================================

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

// Settled by the Task 1 spike (which could not run codex here, so it took the
// conservative branch): Codex enforces per-hook trust, so an installed hook is not
// necessarily a firing hook, and a hook that never fires means the vault silently
// stops growing. Say so rather than report success.
const codexHookTrustNote = 'Codex requires this hook to be trusted before it fires. '
  + 'Run `codex` once and approve the hook, then check ~/.codex/config.toml has a '
  + 'trusted_hash for it. Until then the daily ingest is never triggered.';
if (codexHookTrustNote && targets.some((h) => h.id === 'codex') && !DRY) {
  warn(codexHookTrustNote);
}

// ===========================================================================
step('Adding the shell block');
// ===========================================================================

const runnerPath = path.join(WIKI_DIR, 'bin', 'run-ingest.mjs');
for (const r of installShellBlocks(process.execPath, runnerPath, { dryRun: DRY })) {
  if (r.status === 'added') did(`${r.label}: ${r.file}`);
  else if (r.status === 'present') already(`${r.label} (already present)`);
  else plan(`append the block to ${r.file}`);
}

// ===========================================================================
step('Version-controlling the vault');
// ===========================================================================

if (NO_GIT || !gitAvailable) {
  already('git skipped');
} else if (DRY) {
  plan(`git init in ${VAULT}`);
} else if (fs.existsSync(path.join(VAULT, '.git'))) {
  already('vault is already a git repo');
} else {
  try {
    const git = (a) => execFileSync('git', a, { cwd: VAULT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    git(['init', '--quiet']);
    git(['add', '-A']);
    let identity = '';
    try { identity = git(['config', 'user.email']).trim(); } catch { /* unset */ }
    if (identity) {
      git(['commit', '--quiet', '-m', 'Initial vault scaffold from obsidian-vault-kit']);
      did('git repo initialised with an initial commit');
    } else {
      did('git repo initialised (files staged, not committed)');
      warn('No git identity set, so nothing was committed. Set one, then commit:');
      warn('  git config --global user.name "Your Name"');
      warn('  git config --global user.email "you@example.com"');
    }
  } catch (err) {
    warn(`git init did not complete: ${err.message.split('\n')[0]}`);
  }
}

// ===========================================================================
step('Daily schedule');
// ===========================================================================

if (!SCHEDULE) {
  already('not enabled (turn it on later: node install.mjs --schedule 19:00)');
  const existing = scheduleStatus();
  if (existing) already(`existing schedule found -> ${existing}`);
} else {
  try {
    const r = installSchedule(SCHEDULE, { dryRun: DRY });
    if (r.kind === null) warn('no scheduler available; run `wiki-history` by hand instead');
    else if (DRY) plan(`${r.action} ${r.kind}: ${r.target}`);
    else did(`${r.kind}: daily ingest at ${SCHEDULE}`);
  } catch (err) {
    warn(`could not schedule: ${err.message}`);
  }
}

// ===========================================================================

console.log(`\n${c.gy}------------------------------------------------------------${c.z}`);
console.log(`${DRY ? 'Dry run' : 'Done'}: ${changed.length} change(s), ${skipped.length} already in place, ${warned.length} warning(s)`);

if (warned.length) {
  console.log(`\n${c.yl}Warnings to deal with:${c.z}`);
  for (const w of warned) console.log(`  ${c.yl}!${c.z} ${w}`);
}

if (!DRY) {
  const shellHint = IS_WIN ? 'a new PowerShell window' : 'a new terminal';
  console.log(`
Next, in order:

  1. Open ${shellHint}                 loads wiki-history and the greeting
  2. Open the vault in Obsidian          "Open folder as vault":
                                         ${VAULT}
  3. Install the two community plugins   Settings > Community plugins > Browse:
                                         nexus-ai-chat-importer, infranodus-graph-view
  4. Ingest your first document:
         cd "${VAULT}"
         ${engine.exe}
         > /obsidian-wiki-ingest    then point it at a file in _raw/

  5. Once you have some ${engine.label} history:
         wiki-history --force

Full walkthrough: SETUP-GUIDE.md
`);
}
