// Registering the Claude Code Stop hook.
//
// The hook fires at the end of every turn and records that an ingest has work to do.
// Merging into settings.json is the most dangerous thing the installer does, so:
// back up first, preserve every existing key and hook, and never add a duplicate.

import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_HOME, CLAUDE_SETTINGS } from './platform.mjs';

const FINGERPRINT = 'mark-pending.mjs';

/**
 * Add the Stop hook if it is not already there.
 * Returns 'added' | 'present' | 'would-add'.
 */
export function installStopHook(command, { dryRun = false } = {}) {
  let settings = {};
  const exists = fs.existsSync(CLAUDE_SETTINGS);

  if (exists) {
    const raw = fs.readFileSync(CLAUDE_SETTINGS, 'utf8');
    try {
      settings = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `${CLAUDE_SETTINGS} is not valid JSON (${err.message}). `
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

  if (exists) {
    fs.copyFileSync(CLAUDE_SETTINGS, `${CLAUDE_SETTINGS}.bak-${stamp()}`);
  } else {
    fs.mkdirSync(CLAUDE_HOME, { recursive: true });
  }

  stop.push({
    matcher: '',
    hooks: [{ type: 'command', command, timeout: 5 }],
  });
  hooks.Stop = stop;
  settings.hooks = hooks;

  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  return 'added';
}

/** Remove the hook this kit added, leaving every other hook in place. */
export function removeStopHook() {
  if (!fs.existsSync(CLAUDE_SETTINGS)) return 'no-settings';
  const settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));
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

  if (kept.length === stop.length
      && JSON.stringify(kept) === JSON.stringify(stop)) {
    return 'not-present';
  }

  fs.copyFileSync(CLAUDE_SETTINGS, `${CLAUDE_SETTINGS}.bak-${stamp()}`);
  if (kept.length) settings.hooks.Stop = kept;
  else delete settings.hooks.Stop;
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  return 'removed';
}

/** The command string the hook runs, absolute so a minimal PATH cannot break it. */
export function hookCommand(nodeExe, wikiDir) {
  const script = path.join(wikiDir, 'bin', 'mark-pending.mjs');
  return `"${nodeExe}" "${script}"`;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}
