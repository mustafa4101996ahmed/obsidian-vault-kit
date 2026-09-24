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
  CLAUDE_SETTINGS, CLAUDE_SKILLS, DEFAULT_VAULT, IS_WIN, WIKI_DIR,
  has, platformLabel, which, writeConfig,
} from './lib/platform.mjs';
import { copyIfAbsent, installGitignore, installRunner, linkSkills, stampManifest, stampSeedDates } from './lib/vault.mjs';
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
const MODEL = strArg('--model') || 'sonnet';
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
  --schedule <HH:MM>    also turn on the daily ingest at this time
  --model <name>        model the ingest uses (default: sonnet)
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
  step('Removing the Claude Code Stop hook');
  try { console.log(`   ${removeStopHook()}`); } catch (e) { warn(e.message); }

  step('Removing the shell block');
  const sh = removeShellBlocks();
  if (!sh.length) already('no shell block found');
  for (const r of sh) did(`${r.status}: ${r.file}`);

  step('Removing the daily schedule');
  for (const line of removeSchedule()) console.log(`   ${line}`);

  step('Removing skill links');
  let removedLinks = 0;
  if (fs.existsSync(CLAUDE_SKILLS)) {
    for (const entry of fs.readdirSync(CLAUDE_SKILLS)) {
      const p = path.join(CLAUDE_SKILLS, entry);
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

const claudeExe = which('claude');
if (claudeExe) {
  console.log(`   claude:   ${claudeExe}`);
} else {
  warn('claude is not on PATH. Install Claude Code first:');
  warn('  npm install -g @anthropic-ai/claude-code');
  warn('Install continues, but the automation cannot run until claude is available.');
}

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
  writeConfig({
    vaultPath: VAULT,
    claudeExe: claudeExe || 'claude',
    model: MODEL,
    platform: process.platform,
    installed: new Date().toISOString(),
  });
  did('config.json written');
}

// ===========================================================================
step('Linking skills into Claude Code');
// ===========================================================================
// Junctions on Windows, symlinks elsewhere. Neither needs administrator rights.
// The vault stays the single source of truth: edit the skill in the vault.

const links = linkSkills(DRY ? SCAFFOLD : VAULT, { dryRun: DRY });
if (!links.length) warn('no skills found to link');
for (const l of links) {
  if (l.status === 'linked') did(`skill ${l.name}`);
  else if (l.status === 'present') already(`skill ${l.name} (already linked)`);
  else if (l.status === 'would-link') plan(`link skill ${l.name}`);
  else if (l.status === 'copied') warn(`skill ${l.name} copied, not linked (${l.reason}); edits will not flow back`);
  else if (l.status === 'real-directory') warn(`skill ${l.name} exists as a real folder; left alone`);
  else if (l.status === 'points-elsewhere') warn(`skill ${l.name} links to ${l.points}; left alone`);
  else warn(`skill ${l.name}: ${l.status} ${l.reason || ''}`);
}

// ===========================================================================
step('Registering the Claude Code Stop hook');
// ===========================================================================

const cmd = hookCommand(process.execPath, WIKI_DIR);
try {
  const r = installStopHook(cmd, { dryRun: DRY });
  if (r === 'added') did(`Stop hook added (${CLAUDE_SETTINGS} backed up first)`);
  else if (r === 'present') already('Stop hook (already present)');
  else plan(`add Stop hook to ${CLAUDE_SETTINGS}`);
} catch (err) {
  warn(err.message);
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
         claude
         > /obsidian-wiki-ingest    then point it at a file in _raw/

  5. Once you have some Claude history:
         wiki-history --force

Full walkthrough: SETUP-GUIDE.md
`);
}
