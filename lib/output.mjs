// How the daily run's output reaches a person, and how much of it is kept.
//
// Pure functions, deliberately not inside bin/run-ingest.mjs: that file runs a real
// ingest the moment it is imported, so anything living there cannot be unit-tested
// without a guard around its own entry point. Keeping these here means the tests can
// just import them.

import fs from 'node:fs';
import path from 'node:path';

/** A single day's log stops growing past this. See capNote(). */
export const LOG_MAX_BYTES = 10 * 1024 * 1024;

/** Daily logs older than this are removed at the start of each run. */
export const LOG_KEEP_DAYS = 90;

/**
 * One short line for a person, from one line of a host's event stream.
 *
 * Claude's `-p` prints a final message and little else, so its output is echoed as it
 * comes. Codex's `--json` prints a structured event per step instead, and echoing that
 * verbatim means watching raw JSON scroll past for the length of the run. The raw
 * stream still goes to the log, so nothing is lost by making the terminal readable.
 *
 * Returns null for a blank line, and passes a non-JSON line through untouched — that
 * is where a real error surfaces, and reformatting it would be the one place this
 * function could do damage.
 */
export function condenseEvent(line) {
  const text = String(line).trim();
  if (!text) return null;
  if (!text.startsWith('{')) return text;

  let event;
  try {
    event = JSON.parse(text);
  } catch {
    return text;
  }

  const type = typeof event.type === 'string' ? event.type : 'event';
  const detail = firstString(event.message, event.text, event.item?.text, event.item?.title, event.item?.type);
  if (!detail) return `  · ${type}`;
  return `  · ${type}: ${detail.replace(/\s+/g, ' ').slice(0, 100)}`;
}

function firstString(...candidates) {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}

/**
 * Remove daily logs older than keepDays.
 *
 * A single day's file is bounded by LOG_MAX_BYTES, but the number of files was not
 * bounded by anything: a machine running this for years accumulates one per day
 * forever. Never throws — a log directory that cannot be tidied is not a reason to
 * skip an ingest. Returns the number removed, so the runner can say so.
 */
export function pruneLogs(dir, keepDays = LOG_KEEP_DAYS) {
  const cutoff = Date.now() - keepDays * 86400000;
  let removed = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!name.endsWith('.log')) continue;
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs >= cutoff) continue;
      fs.rmSync(file, { force: true });
      removed += 1;
    } catch { /* unreadable or already gone; leave it */ }
  }
  return removed;
}

/** The single line written into a log that has hit its cap. */
export function capNote(bytes = LOG_MAX_BYTES) {
  return `\n[log reached ${bytes} bytes; the rest of this run's agent output is not recorded here]\n`;
}
