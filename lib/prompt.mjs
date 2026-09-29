// The prompt the daily ingest hands to the agent.
//
// Split out of bin/run-ingest.mjs so it can be imported and unit-tested as a pure
// function without pulling in a script whose top level runs a real ingest.

/**
 * The router takes one source per invocation, so a machine with both agents gets
 * one pass each. The manifest-stamp guard is unaffected: it asks only whether
 * .manifest.json moved, so one pass doing real work still proves the run ingested.
 */
export function buildPrompt(sources) {
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
