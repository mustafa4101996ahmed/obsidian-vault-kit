#!/usr/bin/env node
// Claude Code Stop-hook target. Fires once per ended turn.
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
