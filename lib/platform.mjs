// The only module that knows which operating system it is running on.
//
// Everything else in the kit imports from here and stays platform-neutral. If you
// are porting to a new OS, this file plus lib/schedule.mjs are the two you touch.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PLATFORM = process.platform;
export const IS_WIN = PLATFORM === 'win32';
export const IS_MAC = PLATFORM === 'darwin';
export const IS_LINUX = PLATFORM === 'linux';

export const HOME = os.homedir();

export const WIKI_DIR = path.join(HOME, '.obsidian-wiki');
export const CLAUDE_HOME = path.join(HOME, '.claude');
export const CLAUDE_SKILLS = path.join(CLAUDE_HOME, 'skills');
export const CLAUDE_PROJECTS = path.join(CLAUDE_HOME, 'projects');
export const CLAUDE_SETTINGS = path.join(CLAUDE_HOME, 'settings.json');

export const CONFIG_PATH = path.join(WIKI_DIR, 'config.json');
export const LOCK_PATH = path.join(WIKI_DIR, '.lock');
export const PENDING_FLAG = path.join(WIKI_DIR, '.pending_ingest');
export const PENDING_SESSIONS = path.join(WIKI_DIR, '.pending_sessions');
export const RUN_STARTED = path.join(WIKI_DIR, '.run-started');
export const LOG_DIR = path.join(WIKI_DIR, 'logs');

export const DEFAULT_VAULT = path.join(HOME, 'Documents', 'Obsidian Vault');

/** Windows junctions need no administrator rights; symlinks do. */
export const LINK_TYPE = IS_WIN ? 'junction' : 'dir';

/**
 * Today's date in the machine's own timezone, as YYYY-MM-DD.
 *
 * Deliberately not toISOString().slice(0,10): that is UTC, so east of Greenwich the
 * log filename and the user's `date` disagree for the first hours of every local day,
 * and `wiki-log` reports no log for a day that has one.
 *
 * Timestamps written *into* vault content stay UTC. This is only for names and dates
 * a person reads.
 */
export function localDateStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function platformLabel() {
  if (IS_MAC) return `macOS (${os.arch()})`;
  if (IS_WIN) return `Windows (${os.arch()})`;
  if (IS_LINUX) return `Linux (${os.arch()})`;
  return `${PLATFORM} (${os.arch()})`;
}

/** Absolute path to an executable on PATH, or null. Never throws. */
export function which(cmd) {
  try {
    const finder = IS_WIN ? 'where' : 'which';
    const out = execFileSync(finder, [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return first || null;
  } catch {
    return null;
  }
}

/** True if a command exists on PATH. */
export function has(cmd) {
  return which(cmd) !== null;
}

/**
 * Which shell's startup file should carry the kit's block.
 *
 * Returns every shell we can sensibly write to, because a user may well move
 * between bash and zsh on the same machine and expect `wiki-history` in both.
 */
export function shellTargets() {
  const targets = [];

  if (IS_WIN) {
    // Windows PowerShell 5.1 and PowerShell 7 read different profile paths.
    const docs = path.join(HOME, 'Documents');
    targets.push({
      kind: 'powershell',
      file: path.join(docs, 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
      label: 'Windows PowerShell 5.1 profile',
    });
    targets.push({
      kind: 'powershell',
      file: path.join(docs, 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
      label: 'PowerShell 7 profile',
    });
    return targets;
  }

  // Unix: write to the rc files that already exist, plus the one $SHELL implies.
  const candidates = [
    { kind: 'zsh', file: path.join(HOME, '.zshrc'), label: 'zsh' },
    { kind: 'bash', file: path.join(HOME, '.bashrc'), label: 'bash' },
  ];
  if (IS_MAC) {
    // macOS Terminal starts bash as a login shell, which reads .bash_profile.
    candidates.push({ kind: 'bash', file: path.join(HOME, '.bash_profile'), label: 'bash (login)' });
  }

  const shellEnv = process.env.SHELL || '';
  for (const c of candidates) {
    const exists = fs.existsSync(c.file);
    const isCurrent = shellEnv.includes(c.kind);
    if (exists || isCurrent) targets.push(c);
  }

  // Nothing exists and $SHELL is unset: a fresh account, a container, a cron
  // environment. Choose a shell that is actually installed, preferring the
  // platform's own default (zsh on macOS since Catalina, bash on Linux).
  //
  // Picking blind put a .zshrc on a Linux box with no zsh installed, so the block
  // was never read and `wiki-history` did not exist.
  if (targets.length === 0) {
    for (const kind of IS_MAC ? ['zsh', 'bash'] : ['bash', 'zsh']) {
      if (!has(kind)) continue;
      const pick = candidates.find((c) => c.kind === kind);
      if (pick) { targets.push(pick); break; }
    }
  }
  return targets;
}

/**
 * How this platform can show a desktop notification, or null if it cannot.
 * Resolved once at call time so an installed notifier is picked up without reinstalling.
 */
export function notifierKind() {
  if (IS_MAC) return has('osascript') ? 'osascript' : null;
  if (IS_LINUX) return has('notify-send') ? 'notify-send' : null;
  if (IS_WIN) return has('powershell') || has('pwsh') ? 'powershell' : null;
  return null;
}

/**
 * Which scheduler this platform can use, most preferred first.
 * Returns [] when none is available, which is not fatal: the kit falls back to
 * being run by hand and says so.
 */
export function schedulerKinds() {
  if (IS_MAC) return has('launchctl') ? ['launchd'] : [];
  if (IS_WIN) return has('schtasks') ? ['schtasks'] : [];
  if (IS_LINUX) {
    const kinds = [];
    // systemd --user needs a running user manager, not merely the binary.
    if (has('systemctl')) {
      try {
        execFileSync('systemctl', ['--user', 'is-system-running'], {
          stdio: 'ignore',
          timeout: 5000,
        });
        kinds.push('systemd');
      } catch {
        // is-system-running exits non-zero for 'degraded' and 'starting' too, which
        // are both usable. Treat a reachable user bus as good enough.
        try {
          execFileSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore', timeout: 5000 });
          kinds.push('systemd');
        } catch { /* no user bus; fall through to cron */ }
      }
    }
    if (has('crontab')) kinds.push('cron');
    return kinds;
  }
  return [];
}

export function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`config at ${CONFIG_PATH} is not valid JSON: ${err.message}`);
  }
}

export function writeConfig(cfg) {
  fs.mkdirSync(WIKI_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}
