// Registering a host's Stop hook.
//
// The hook fires at the end of every turn and records that an ingest has work to do.
// Merging into settings.json is the most dangerous thing the installer does, so:
// back up first, preserve every existing key and hook, and never add a duplicate.

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
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    // Mirrors installStopHook's guard: install.mjs --uninstall now calls this in a
    // loop over every host, so a malformed file here throws a raw SyntaxError
    // instead of the same actionable message installStopHook would have given.
    throw new Error(
      `${file} is not valid JSON (${err.message}). `
      + 'Fix or move it, then re-run; refusing to overwrite it.',
    );
  }
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

/** The command string the hook runs, absolute so a minimal PATH cannot break it. */
export function hookCommand(nodeExe, wikiDir) {
  const script = path.join(wikiDir, 'bin', 'mark-pending.mjs');
  return `"${nodeExe}" "${script}"`;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}
