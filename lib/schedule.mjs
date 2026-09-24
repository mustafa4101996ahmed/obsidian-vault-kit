// Daily scheduling, per platform.
//
// Four backends, one interface. Each one must: run daily at a chosen time, run as
// the logged-in user, catch up if the machine was asleep at the appointed time, and
// be removable without residue.
//
// A missed ingest is an ingest never done, so catch-up matters more than punctuality.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  HOME, IS_WIN, WIKI_DIR, schedulerKinds, which, has,
} from './platform.mjs';

export const TASK_NAME = 'ObsidianWikiDailyIngest';
const LAUNCHD_LABEL = 'com.obsidian-wiki.daily-ingest';
const SYSTEMD_UNIT = 'obsidian-wiki-ingest';

const LAUNCHD_PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const SYSTEMD_DIR = path.join(HOME, '.config', 'systemd', 'user');
const CRON_MARKER = '# obsidian-wiki daily ingest';

function runner() {
  return path.join(WIKI_DIR, 'bin', 'run-ingest.mjs');
}

function nodeExe() {
  // Absolute path: a scheduler runs with a minimal PATH that rarely includes nvm.
  return process.execPath;
}

function parseTime(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time).trim());
  if (!m) throw new Error(`time must be HH:MM, got "${time}"`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`time out of range: "${time}"`);
  return { hour, minute };
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

// ---------------------------------------------------------------------------
// launchd (macOS)
// ---------------------------------------------------------------------------

function installLaunchd({ hour, minute }, dryRun) {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeExe()}</string>
    <string>${runner()}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>${hour}</integer>
    <key>Minute</key><integer>${minute}</integer>
  </dict>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>${path.join(WIKI_DIR, 'logs', 'launchd.out')}</string>
  <key>StandardErrorPath</key><string>${path.join(WIKI_DIR, 'logs', 'launchd.err')}</string>
</dict>
</plist>
`;
  if (dryRun) return { kind: 'launchd', action: 'would write', target: LAUNCHD_PLIST };

  fs.mkdirSync(path.dirname(LAUNCHD_PLIST), { recursive: true });
  fs.mkdirSync(path.join(WIKI_DIR, 'logs'), { recursive: true });
  fs.writeFileSync(LAUNCHD_PLIST, plist);

  const uid = process.getuid();
  // bootout first so a re-install replaces rather than stacks. Both commands are
  // expected to fail when nothing is loaded yet.
  try { sh('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`]); } catch { /* not loaded */ }
  try {
    sh('launchctl', ['bootstrap', `gui/${uid}`, LAUNCHD_PLIST]);
  } catch {
    // bootstrap is unavailable on older macOS; load is the legacy equivalent.
    sh('launchctl', ['load', '-w', LAUNCHD_PLIST]);
  }
  return { kind: 'launchd', action: 'registered', target: LAUNCHD_PLIST };
}

function removeLaunchd() {
  const uid = process.getuid();
  try { sh('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`]); } catch { /* not loaded */ }
  try { sh('launchctl', ['unload', LAUNCHD_PLIST]); } catch { /* not loaded */ }
  if (fs.existsSync(LAUNCHD_PLIST)) fs.rmSync(LAUNCHD_PLIST);
  return 'launchd job removed';
}

function statusLaunchd() {
  if (!fs.existsSync(LAUNCHD_PLIST)) return null;
  try {
    const out = sh('launchctl', ['list', LAUNCHD_LABEL]);
    return `launchd: loaded (${LAUNCHD_PLIST})${out.includes('LastExitStatus') ? '' : ''}`;
  } catch {
    return `launchd: plist present but not loaded (${LAUNCHD_PLIST})`;
  }
}

// ---------------------------------------------------------------------------
// systemd user timer (Linux)
// ---------------------------------------------------------------------------

function installSystemd({ hour, minute }, dryRun) {
  const service = `[Unit]
Description=Ingest Claude Code history into the Obsidian vault

[Service]
Type=oneshot
ExecStart=${nodeExe()} ${runner()}
`;
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  const timer = `[Unit]
Description=Daily Claude history ingest

[Timer]
OnCalendar=*-*-* ${hh}:${mm}:00
# Run on the next boot if the machine was off at the scheduled time.
Persistent=true

[Install]
WantedBy=timers.target
`;
  const svcPath = path.join(SYSTEMD_DIR, `${SYSTEMD_UNIT}.service`);
  const timerPath = path.join(SYSTEMD_DIR, `${SYSTEMD_UNIT}.timer`);

  if (dryRun) return { kind: 'systemd', action: 'would write', target: timerPath };

  fs.mkdirSync(SYSTEMD_DIR, { recursive: true });
  fs.writeFileSync(svcPath, service);
  fs.writeFileSync(timerPath, timer);
  sh('systemctl', ['--user', 'daemon-reload']);
  sh('systemctl', ['--user', 'enable', '--now', `${SYSTEMD_UNIT}.timer`]);
  return { kind: 'systemd', action: 'registered', target: timerPath };
}

function removeSystemd() {
  try { sh('systemctl', ['--user', 'disable', '--now', `${SYSTEMD_UNIT}.timer`]); } catch { /* not enabled */ }
  for (const f of [`${SYSTEMD_UNIT}.service`, `${SYSTEMD_UNIT}.timer`]) {
    const p = path.join(SYSTEMD_DIR, f);
    if (fs.existsSync(p)) fs.rmSync(p);
  }
  try { sh('systemctl', ['--user', 'daemon-reload']); } catch { /* best effort */ }
  return 'systemd timer removed';
}

function statusSystemd() {
  const timerPath = path.join(SYSTEMD_DIR, `${SYSTEMD_UNIT}.timer`);
  if (!fs.existsSync(timerPath)) return null;
  try {
    const out = sh('systemctl', ['--user', 'list-timers', `${SYSTEMD_UNIT}.timer`, '--no-pager']);
    const line = out.split('\n').find((l) => l.includes(SYSTEMD_UNIT));
    return `systemd: ${line ? line.trim() : 'timer installed'}`;
  } catch {
    return `systemd: unit present, state unknown (${timerPath})`;
  }
}

// ---------------------------------------------------------------------------
// cron (Linux fallback)
// ---------------------------------------------------------------------------

function readCrontab() {
  try {
    return sh('crontab', ['-l']);
  } catch {
    return '';
  }
}

function writeCrontab(text) {
  execFileSync('crontab', ['-'], { input: text.endsWith('\n') ? text : text + '\n', stdio: ['pipe', 'ignore', 'pipe'] });
}

function stripCron(text) {
  return text
    .split('\n')
    .filter((l) => !l.includes(CRON_MARKER) && !l.includes(runner()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

function installCron({ hour, minute }, dryRun) {
  const line = `${minute} ${hour} * * * "${nodeExe()}" "${runner()}"  ${CRON_MARKER}`;
  if (dryRun) return { kind: 'cron', action: 'would add', target: line };
  const next = stripCron(readCrontab()).trimEnd();
  writeCrontab(`${next}\n${line}\n`);
  return { kind: 'cron', action: 'registered', target: line };
}

function removeCron() {
  const current = readCrontab();
  if (!current.includes(CRON_MARKER) && !current.includes(runner())) return 'no cron entry found';
  writeCrontab(stripCron(current));
  return 'cron entry removed';
}

function statusCron() {
  const current = readCrontab();
  const line = current.split('\n').find((l) => l.includes(CRON_MARKER) || l.includes(runner()));
  return line ? `cron: ${line.trim()}` : null;
}

// ---------------------------------------------------------------------------
// schtasks (Windows)
// ---------------------------------------------------------------------------

function installSchtasks({ hour, minute }, dryRun) {
  const hhmm = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const cmd = `"${nodeExe()}" "${runner()}"`;
  const args = ['/Create', '/TN', TASK_NAME, '/TR', cmd, '/SC', 'DAILY', '/ST', hhmm, '/F'];
  if (dryRun) return { kind: 'schtasks', action: 'would create', target: `${TASK_NAME} at ${hhmm}` };
  sh('schtasks', args);
  return { kind: 'schtasks', action: 'registered', target: `${TASK_NAME} at ${hhmm}` };
}

function removeSchtasks() {
  try {
    sh('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']);
    return 'scheduled task removed';
  } catch {
    return 'no scheduled task found';
  }
}

function statusSchtasks() {
  try {
    const out = sh('schtasks', ['/Query', '/TN', TASK_NAME, '/FO', 'LIST']);
    const next = out.split('\n').find((l) => /Next Run Time/i.test(l));
    return `schtasks: ${TASK_NAME}${next ? ' | ' + next.trim() : ' registered'}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Install the daily schedule using the best backend this platform offers.
 * Throws only on a malformed time; an absent scheduler returns a null kind so the
 * caller can tell the user to run it by hand.
 */
export function installSchedule(time = '19:00', { dryRun = false } = {}) {
  const at = parseTime(time);
  const kinds = schedulerKinds();
  if (kinds.length === 0) {
    return { kind: null, action: 'unavailable', target: null };
  }
  const kind = kinds[0];
  switch (kind) {
    case 'launchd': return installLaunchd(at, dryRun);
    case 'systemd': return installSystemd(at, dryRun);
    case 'cron': return installCron(at, dryRun);
    case 'schtasks': return installSchtasks(at, dryRun);
    default: return { kind: null, action: 'unavailable', target: null };
  }
}

/** Remove every schedule this kit may have installed, whichever backend was used. */
export function removeSchedule() {
  const done = [];
  if (IS_WIN) {
    if (has('schtasks')) done.push(removeSchtasks());
  } else {
    if (has('launchctl')) done.push(removeLaunchd());
    if (has('systemctl') && fs.existsSync(path.join(SYSTEMD_DIR, `${SYSTEMD_UNIT}.timer`))) {
      done.push(removeSystemd());
    }
    if (has('crontab')) done.push(removeCron());
  }
  return done.length ? done : ['no scheduler available'];
}

/** Human-readable state of any installed schedule, or null if none is installed. */
export function scheduleStatus() {
  const checks = IS_WIN
    ? [statusSchtasks]
    : [statusLaunchd, statusSystemd, statusCron];
  for (const check of checks) {
    try {
      const r = check();
      if (r) return r;
    } catch { /* try the next backend */ }
  }
  return null;
}

/** What this platform could use, for reporting during install. */
export function availableSchedulers() {
  return schedulerKinds();
}

export { which };
