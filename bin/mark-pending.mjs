#!/usr/bin/env node
// Stop-hook target, shared by both hosts (Claude Code and Codex CLI). Fires once per
// ended turn.
//
// Records that there is work for the next ingest: a flag file the runner gates on,
// and one line per turn so the runner can consume exactly what it covered and leave
// anything that arrived mid-run still pending.
//
// Must stay fast and must never fail. A hook that throws interrupts the session, and
// losing one marker costs only a delayed ingest.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// The ingest's own final turn must not queue another ingest.
//
// Claude Code escapes this by accident of configuration: the runner passes
// --setting-sources project,local, so the user-level settings holding this hook are
// never loaded. Codex has no equivalent -- ~/.codex/hooks.json is always read, and a
// live run confirmed the Stop hook does fire -- so without this guard the flag written
// here would be written by the very run that just cleared it. It would never clear
// again, and every scheduled run would do a full ingest forever, which is exactly the
// promise the kit makes in reverse: a day with nothing pending is supposed to cost
// nothing.
//
// The runner sets this on the agent it spawns; hook processes inherit it.
if (process.env.OBSIDIAN_WIKI_INGEST === '1') process.exit(0);

try {
  const dir = path.join(os.homedir(), '.obsidian-wiki');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.pending_ingest'), '');
  // Seconds since the epoch, computed arithmetically so no locale or date-format
  // setting can change the result.
  fs.appendFileSync(path.join(dir, '.pending_sessions'), `${Math.floor(Date.now() / 1000)}\n`);
} catch {
  // Silent by design. See the note above.
}

process.exit(0);
