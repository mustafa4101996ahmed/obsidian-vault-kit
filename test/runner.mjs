#!/usr/bin/env node
// Codex host support: the end-to-end runner test. Split out of test/codex.mjs
// because it is the slow one (the watchdog test alone costs ~95s of wall clock)
// and the only section that spawns the real runner end to end against a stub --
// a clean seam for keeping the fast checks separate from this one. Runs
// alongside test/suite.mjs; see that file for the throwaway-HOME convention
// every child-process test here follows.

import fs from 'node:fs';
import path from 'node:path';
import { eq, has, head, KIT, makeHome, removeHome, run, summary, truthy } from './harness.mjs';

head('1. The runner, against a codex stub');

{
  const { home, env } = makeHome('vault-kit-run-');
  const vault = path.join(home, 'Documents', 'Obsidian Vault');
  const wiki = path.join(home, '.obsidian-wiki');

  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const inst = run(path.join(KIT, 'install.mjs'), ['--vault', vault, '--host', 'codex', '--no-git'], env);
  eq('install for codex exits clean', inst.code, 0);

  // A stub that proves it was invoked, then moves the ledger and the log so the
  // runner's verification has something real to find.
  const marker = path.join(home, 'argv.txt');
  const worker = path.join(home, 'agent.mjs');
  fs.writeFileSync(worker, `
import fs from 'node:fs';
import path from 'node:path';
fs.writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join('\\n'));
const vault = ${JSON.stringify(vault)};
const mf = path.join(vault, '.manifest.json');
const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
m.sources = m.sources || [];
m.sources.push({ source_path: 'stub/rollout.jsonl', source_type: 'codex_rollout',
  ingested_at: new Date().toISOString(), pages_created: ['concepts/stub.md'] });
fs.writeFileSync(mf, JSON.stringify(m, null, 2));
const log = path.join(vault, 'log.md');
let t = fs.readFileSync(log, 'utf8');
t = t.replace('# Wiki Log', '# Wiki Log\\n\\n- [' + new Date().toISOString() + '] CODEX_HISTORY_INGEST sessions=1 pages_created=1');
fs.writeFileSync(log, t);
console.log('stub codex: ingested 1 session');
`);

  let stub;
  if (process.platform === 'win32') {
    stub = path.join(home, 'codex.cmd');
    fs.writeFileSync(stub, `@echo off\r\n"${process.execPath}" "${worker}" %*\r\n`);
  } else {
    stub = path.join(home, 'codex');
    fs.writeFileSync(stub, `#!/bin/sh\nexec "${process.execPath}" "${worker}" "$@"\n`);
    fs.chmodSync(stub, 0o755);
  }

  const cfgPath = path.join(wiki, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.hosts.codex.exe = stub;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  run(path.join(wiki, 'bin', 'mark-pending.mjs'), [], env);
  const r = run(path.join(wiki, 'bin', 'run-ingest.mjs'), [], env);

  eq('the runner exits clean', r.code, 0);
  truthy('the codex stub was spawned', fs.existsSync(marker));
  if (fs.existsSync(marker)) {
    const argv = fs.readFileSync(marker, 'utf8');
    has('it ran exec', argv, 'exec');
    has('it streamed json', argv, '--json');
    has('it was sandboxed to the workspace', argv, 'workspace-write');
    has('it was pointed at the vault', argv, '--cd');
    has('it was told to ingest codex history', argv, 'codex');
    truthy('no --session-id was passed', !argv.includes('--session-id'));
    truthy('no -p was passed', !argv.split('\n').includes('-p'));
  }
  has('the headline came from a CODEX log line', r.out, 'CODEX_HISTORY_INGEST');
  truthy('the pending flag cleared', !fs.existsSync(path.join(wiki, '.pending_ingest')));

  // A stub that exits zero having changed nothing is still a failure.
  fs.writeFileSync(worker, "console.log('stub codex: did nothing');\n");
  run(path.join(wiki, 'bin', 'mark-pending.mjs'), [], env);
  const r2 = run(path.join(wiki, 'bin', 'run-ingest.mjs'), [], env);
  eq('a no-op codex run exits non-zero', r2.code, 1);
  has('and is reported as a failure', r2.out, 'without updating .manifest.json');
  eq('and leaves the queue intact', fs.readFileSync(path.join(wiki, '.pending_sessions'), 'utf8').trim().split('\n').length, 1);

  // A stub that goes quiet must be killed, not waited on forever.
  //
  // This is the only direct test of the watchdog in the repo, and the guard exists
  // because a run once sat on a single model call for 100 minutes. The interval is
  // fixed at 60 seconds, so this costs about 95 seconds of wall clock -- worth it for
  // the one guard nothing else exercises.
  fs.writeFileSync(worker, `
console.log('stub codex: starting');
setTimeout(() => { console.log('too late'); }, 300000);
`);
  run(path.join(wiki, 'bin', 'mark-pending.mjs'), [], env);
  const started = Date.now();
  // The watchdog's own detection window can run right up against harness.mjs's
  // default 120s execFileSync timeout (60s check interval x up to 2 checks to
  // detect a stall that started just after a check ran). Left at the default, the
  // harness can kill run-ingest.mjs itself before its internal watchdog gets to log
  // and exit cleanly, which would make this test flaky rather than a real check.
  const r3 = run(path.join(wiki, 'bin', 'run-ingest.mjs'), ['--stall-minutes', '1'], env, { timeout: 170000 });
  const tookSeconds = (Date.now() - started) / 1000;

  truthy('a silent run is killed, not waited on', r3.code !== 0);
  // Of this stall test's four assertions, this is the one that carries the real
  // weight: the other three would still pass even if the internal watchdog were
  // deleted outright, because harness.mjs's own execFileSync timeout would
  // eventually kill the hung process with a similar exit code, elapsed time, and
  // untouched queue. Only 'made no progress' is logged exclusively by the
  // watchdog's own code path -- do not "simplify" this one away.
  has('the watchdog says why', r3.out, 'made no progress');
  truthy(`it was killed promptly (took ${Math.round(tookSeconds)}s, under 180)`, tookSeconds < 180);
  // 2, not 1: the no-op run above already left one turn queued (asserted above), and
  // this scenario marks one more before running. A failed run -- stalled or not --
  // must never drop either: fail() exits before the queue is ever touched.
  eq('a killed run leaves the queue intact',
    fs.readFileSync(path.join(wiki, '.pending_sessions'), 'utf8').trim().split('\n').length, 2);

  removeHome(home);
}

summary();
