#!/usr/bin/env node
// Agent history -> wiki ingest.
//
// Runs unattended: once a day from the scheduler, or on demand with --force.
//
//   run-ingest.mjs           ingest if any Claude turn has ended since the last run
//   run-ingest.mjs --force   ingest regardless of the pending flag
//   run-ingest.mjs --help
//
// Log: ~/.obsidian-wiki/logs/<date>.log
//
// Almost all of this file is guards. Every one of them exists because something went
// wrong without it. Read the comment before removing one.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  CONFIG_PATH, LOCK_PATH, LOG_DIR,
  PENDING_FLAG, PENDING_SESSIONS, RUN_STARTED, WIKI_DIR,
  localDateStamp, platformLabel, readConfig,
} from '../lib/platform.mjs';
import { HOSTS, hostById } from '../lib/host.mjs';
import { notify } from '../lib/notify.mjs';
import { buildPrompt } from '../lib/prompt.mjs';

const args = process.argv.slice(2);
const FORCE = args.includes('--force') || args.includes('-f');
const HELP = args.includes('--help') || args.includes('-h');

const STALL_MINUTES = numArg('--stall-minutes', 20);
const STALE_LOCK_MINUTES = numArg('--stale-lock-minutes', 180);

function numArg(name, fallback) {
  const i = args.indexOf(name);
  if (i === -1 || i === args.length - 1) return fallback;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

if (HELP) {
  process.stdout.write(`
run-ingest  -  ingest agent history into the Obsidian vault

  run-ingest.mjs                  ingest if turns are pending, otherwise exit
  run-ingest.mjs --force          ingest regardless
  run-ingest.mjs --stall-minutes N        watchdog threshold (default 20)
  run-ingest.mjs --stale-lock-minutes N   lock age before it is assumed crashed (default 180)

Log: ${path.join(LOG_DIR, '<date>.log')}
Config: ${CONFIG_PATH}
`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Logging: everything this script reports lands in today's log, appended.
// ---------------------------------------------------------------------------

fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG = path.join(LOG_DIR, `${localDateStamp()}.log`);

const QUIET = args.includes('--quiet') || args.includes('-q');

function log(line = '') {
  try {
    fs.appendFileSync(LOG, `${line}\n`);
  } catch { /* a log we cannot write must not end the run */ }
  // Echo unless asked not to. Gating on isTTY made the run silent through a pipe,
  // which hid its output from anything that captured it, tests included.
  if (!QUIET) process.stdout.write(`${line}\n`);
}

/** Local wall-clock for the log banner, so it matches the filename it sits in. */
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${localDateStamp(d)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------
// Lock. Directory creation is the atomic test-and-set: mkdir fails if it exists.
// Two concurrent runs would both write .manifest.json and one set of updates
// would be lost. A lock older than STALE_LOCK_MINUTES is from a crashed run.
// ---------------------------------------------------------------------------

let holdsLock = false;

function acquireLock() {
  try {
    fs.mkdirSync(LOCK_PATH);
    holdsLock = true;
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    let ageMin = 0;
    try {
      ageMin = (Date.now() - fs.statSync(LOCK_PATH).ctimeMs) / 60000;
    } catch {
      return false;
    }
    if (ageMin > STALE_LOCK_MINUTES) {
      log(`clearing a stale lock (${ageMin.toFixed(0)} minutes old; a previous run crashed)`);
      fs.rmSync(LOCK_PATH, { recursive: true, force: true });
      fs.mkdirSync(LOCK_PATH);
      holdsLock = true;
      return true;
    }
    log('another run holds the lock; exiting');
    return false;
  }
}

function releaseLock() {
  if (!holdsLock) return;
  try { fs.rmSync(LOCK_PATH, { recursive: true, force: true }); } catch { /* best effort */ }
  holdsLock = false;
}

function fail(reason) {
  log(`FAILED: ${reason}`);
  notify(`Failed: ${reason}. Log: ${LOG}`);
  releaseLock();
  process.exit(1);
}

// Release the lock however we leave, including on Ctrl-C.
process.on('exit', releaseLock);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { releaseLock(); process.exit(130); });
}

// ---------------------------------------------------------------------------

function countLines(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return raw.split('\n').filter((l) => l.trim() !== '').length;
  } catch {
    return 0;
  }
}

/**
 * Recent writes to any transcript belonging to this session.
 *
 * The session id is searched for rather than the project directory name being
 * rebuilt from the vault path: that name is produced by folding path separators
 * into hyphens, which is lossy (a space in "Obsidian Vault" and a hyphen in a real
 * folder name become the same character) and differs between platforms. Searching
 * cannot be wrong; reconstructing can.
 *
 * Subagents write their own transcript files, so delegated work counts as activity.
 *
 * sessionsDir is passed in rather than assumed, because it differs per host: Claude
 * keeps transcripts under ~/.claude/projects, Codex under ~/.codex/sessions.
 */
function sessionActiveSince(sessionsDir, sessionId, cutoffMs) {
  let found = false;
  const walk = (dir, depth) => {
    if (found || depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p, depth + 1);
      } else if (e.isFile() && e.name.endsWith('.jsonl')) {
        const base = path.basename(e.name, '.jsonl');
        const inSessionDir = path.basename(dir) === sessionId;
        if (base !== sessionId && !inSessionDir) continue;
        try {
          if (fs.statSync(p).mtimeMs > cutoffMs) found = true;
        } catch { /* vanished mid-walk */ }
      }
    }
  };
  walk(sessionsDir, 0);
  return found;
}

async function main() {
  log('');
  log(`=== ${stamp()} run-ingest${FORCE ? ' --force' : ''} on ${platformLabel()}`);

  const cfg = readConfig();
  if (!cfg) {
    // Not a failure worth notifying about: the kit simply is not installed.
    process.stderr.write(`No config at ${CONFIG_PATH}.\nRun install.mjs from the vault kit first.\n`);
    log(`no config at ${CONFIG_PATH}; run install.mjs first`);
    process.exit(1);
  }

  const vault = cfg.vaultPath;

  const engine = hostById(cfg.engine) || hostById('claude');
  const engineCfg = (cfg.hosts && cfg.hosts[engine.id]) || {};
  const engineExe = engineCfg.exe || engine.exe;
  // Falls back to the host's own default, not a bare null: Claude has no usable
  // default of its own and must always get a --model, while Codex's default is
  // null on purpose (see lib/host.mjs) so a legacy config missing the key still
  // behaves exactly as it did before Codex support existed.
  const model = engineCfg.model || engine.defaultModel;

  // Every host the install wired up contributes a history source, whichever one is
  // doing the running. That is what makes one schedule right for a machine with
  // both agents on it. The host descriptors travel alongside the plain historyArg
  // strings because buildArgs needs each source's sessionsDir, not just its name,
  // to grant read access to it -- see CLAUDE.buildArgs in lib/host.mjs.
  const wiredHosts = HOSTS.filter((h) => cfg.hosts && cfg.hosts[h.id]);
  const sourceHosts = wiredHosts.length ? wiredHosts : [engine];
  const sources = sourceHosts.map((h) => h.historyArg);

  if (!fs.existsSync(vault)) fail(`the vault is missing at ${vault}`);

  if (!acquireLock()) process.exit(0);

  // Another writer on the vault causes the same lost-update problem. Exiting is
  // safe: the pending flag is untouched, so the work stays queued.
  const rawDir = path.join(vault, '_raw');
  if (fs.existsSync(rawDir)) {
    const other = findLockUnder(rawDir);
    if (other) {
      log(`another vault writer holds ${other}; exiting with work still pending`);
      process.exit(0);
    }
  }

  if (!fs.existsSync(PENDING_FLAG) && !FORCE) {
    log('nothing pending');
    process.exit(0);
  }

  // The Stop hook appends one line per ended turn. Record the count now, so turns
  // that end while this run works stay pending for the next one.
  if (!fs.existsSync(PENDING_SESSIONS)) fs.writeFileSync(PENDING_SESSIONS, '');
  const mark = countLines(PENDING_SESSIONS);
  log(`pending turns at start: ${mark}`);

  fs.writeFileSync(RUN_STARTED, new Date().toISOString());
  const startedMs = fs.statSync(RUN_STARTED).mtimeMs;

  const sessionId = randomUUID();
  const hostArgs = engine.buildArgs({ prompt: buildPrompt(sources), model, sessionId, vault, sourceHosts });

  // Windows will not let Node spawn a .cmd or .bat directly: the mitigation for the
  // 2024 argument-injection issue blocks it, and npm's global installs -- Claude's
  // and Codex's alike -- are exactly those shims. Route them through the command
  // interpreter, quoting the arguments ourselves so a prompt full of spaces survives
  // intact.
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

  const exitCode = await new Promise((resolve) => {
    const child = spawn(exe, spawnArgs, spawnOpts);

    // The agent's own output goes to the log and, unless silenced, to the terminal.
    // Sending it only to the log made `wiki-history` sit silent for minutes with the
    // agent working invisibly behind it.
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

    child.on('error', (err) => {
      clearInterval(watchdog);
      log(`could not start ${exe}: ${err.code || ''} ${err.message}`);
      resolve(-1);
    });

    child.on('close', (code) => {
      clearInterval(watchdog);
      resolve(killed ? -2 : (code ?? -1));
    });
  });

  if (exitCode === -2) fail(`the run stalled and was stopped (session ${sessionId})`);
  if (exitCode === -1) fail(`could not run ${engineExe} (session ${sessionId})`);
  if (exitCode !== 0) fail(`${engine.label} exited ${exitCode} (session ${sessionId})`);

  // A run that stamped nothing did not ingest, whatever its exit code says. This is
  // the guard that catches a pipeline reporting success having done no work, which
  // is the failure that otherwise goes unnoticed for weeks.
  const manifest = path.join(vault, '.manifest.json');
  let manifestMs = 0;
  try { manifestMs = fs.statSync(manifest).mtimeMs; } catch { /* absent */ }
  if (manifestMs <= startedMs) fail('the run finished without updating .manifest.json');

  // Consume exactly the turns this run covered.
  const all = safeLines(PENDING_SESSIONS);
  const remaining = all.slice(mark);
  fs.writeFileSync(PENDING_SESSIONS, remaining.length ? remaining.join('\n') + '\n' : '');
  if (remaining.length === 0) {
    try { fs.rmSync(PENDING_FLAG, { force: true }); } catch { /* ignore */ }
    log('pending queue cleared');
  } else {
    log(`${remaining.length} turn(s) arrived during the run and stay pending`);
  }

  const headline = newestLogEntry(path.join(vault, 'log.md')) || 'history ingest finished';
  log(`done: ${headline}`);
  notify(headline);
}

function safeLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
  } catch {
    return [];
  }
}

function findLockUnder(dir, depth = 0) {
  if (depth > 3) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === '.lock') return path.join(dir, e.name);
    const deeper = findLockUnder(path.join(dir, e.name), depth + 1);
    if (deeper) return deeper;
  }
  return null;
}

/**
 * Newest log.md entry by timestamp, wherever the run filed it.
 *
 * The tags come from the host registry rather than being hardcoded, because a
 * Codex-only run writes CODEX_HISTORY_INGEST and would otherwise fall through to
 * the generic headline, making a real ingest look like a run that did nothing —
 * and the notification is the only thing most users ever see.
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

main().catch((err) => {
  fail(err && err.stack ? err.stack.split('\n')[0] : String(err));
});
