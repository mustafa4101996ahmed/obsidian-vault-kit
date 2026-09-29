#!/usr/bin/env node
// Codex host support: the end-to-end runner test. Split out of test/codex.mjs
// because it is the slow one (the watchdog test alone costs ~95s of wall clock)
// and the only section that spawns the real runner end to end against a stub --
// a clean seam for keeping the fast checks separate from this one. Runs
// alongside test/suite.mjs; see that file for the throwaway-HOME convention
// every child-process test here follows.

import fs from 'node:fs';
import path from 'node:path';
import { eq, has, head, IS_WIN, KIT, lines, localDate, makeHome, removeHome, run, summary, truthy } from './harness.mjs';

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

head('2. The full runner path, end to end, against a Claude stub');
// The one seam nothing else covers: run-ingest.mjs actually spawning an agent, capturing
// its output, seeing the manifest move, draining the pending queue and reporting.
//
// The agent is stubbed, not mocked away: a real executable that writes a manifest row and
// a log.md line the way the skill does. Model judgement is not what this tests -- that is
// covered by having run the real ingest on real documents. This tests the plumbing around
// it, which is where the guards live.
//
// On Windows the stub is a .cmd, because that is the shape npm's global installs take. If
// the runner cannot spawn one, this test is meant to fail and say so.
{
  const { home, env } = makeHome('vault-kit-claude-run-');
  const vault = path.join(home, 'Documents', 'Obsidian Vault');
  const wiki = path.join(home, '.obsidian-wiki');
  const hook = path.join(wiki, 'bin', 'mark-pending.mjs');
  const runHere = (script, args = []) => run(script, args, env);
  const ingest = (args = []) => runHere(path.join(wiki, 'bin', 'run-ingest.mjs'), args);

  // Install with auto-detection rather than --host claude: that works both here, where
  // Claude is on PATH, and on a CI runner where neither agent exists and the installer
  // wires up the default host instead. Naming an absent host is a hard error by design.
  eq('install exits clean', runHere(path.join(KIT, 'install.mjs'), ['--vault', vault, '--no-git']).code, 0);
  const stubDir = path.join(home, 'stub');
  fs.mkdirSync(stubDir, { recursive: true });
  const marker = path.join(home, 'stub-ran.txt');

  // What the stub does: prove it was invoked, then touch the ledger and the log so the
  // runner's verification has something real to find.
  const workerJs = path.join(stubDir, 'agent.mjs');
  fs.writeFileSync(workerJs, `
import fs from 'node:fs';
import path from 'node:path';
fs.writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join('\\n'));
const vault = ${JSON.stringify(vault)};
const mf = path.join(vault, '.manifest.json');
const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
m.sources = m.sources || [];
m.sources.push({
  source_path: 'stub/session.jsonl', source_type: 'claude_transcript',
  ingested_at: new Date().toISOString(), pages_created: ['concepts/stub.md'],
});
fs.writeFileSync(mf, JSON.stringify(m, null, 2));
const log = path.join(vault, 'log.md');
let t = fs.readFileSync(log, 'utf8');
t = t.replace('# Wiki Log', '# Wiki Log\\n\\n- [' + new Date().toISOString() + '] CLAUDE-HISTORY sessions=1 pages_created=1');
fs.writeFileSync(log, t);
console.log('stub agent: ingested 1 session');
`);

  let stubExe;
  if (IS_WIN) {
    stubExe = path.join(stubDir, 'claude.cmd');
    fs.writeFileSync(stubExe, `@echo off\r\n"${process.execPath}" "${workerJs}" %*\r\n`);
  } else {
    stubExe = path.join(stubDir, 'claude');
    fs.writeFileSync(stubExe, `#!/bin/sh\nexec "${process.execPath}" "${workerJs}" "$@"\n`);
    fs.chmodSync(stubExe, 0o755);
  }

  const cfgPath = path.join(wiki, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  // The runner reads cfg.hosts[engine.id].exe, not the legacy flat cfg.claudeExe --
  // the installer always writes a hosts map, so readConfig's claudeExe migration never
  // triggers here. Setting the old field would leave this test spawning the *real*
  // claude binary headless against a throwaway vault: minutes of wall clock, real
  // token spend, possibly a hang.
  const realExe = cfg.hosts.claude.exe;
  cfg.hosts.claude.exe = stubExe;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  // Queue three turns, as the Stop hook would.
  fs.rmSync(path.join(wiki, '.pending_sessions'), { force: true });
  for (let i = 0; i < 3; i += 1) runHere(hook);
  eq('queued turns before the run', lines(path.join(wiki, '.pending_sessions')).length, 3);

  const manifestBefore = fs.statSync(path.join(vault, '.manifest.json')).mtimeMs;
  const r = ingest();

  eq('runner exit code', r.code, 0);
  truthy('the agent was actually spawned', fs.existsSync(marker));
  if (!fs.existsSync(marker)) {
    // Without this the failure says only "not spawned", which hides the reason.
    console.log('       runner said:');
    for (const l of r.out.split('\n').filter(Boolean).slice(-8)) console.log(`         ${l}`);
  }
  if (fs.existsSync(marker)) {
    const argv = fs.readFileSync(marker, 'utf8');
    has('agent received -p', argv, '-p');
    has('agent received the skill instruction', argv, 'wiki-history-ingest');
    has('agent received --permission-mode', argv, 'acceptEdits');
    has('agent received a session id', argv, '--session-id');
  }
  has("agent's output reached the terminal", r.out, 'stub agent: ingested 1 session');
  const runLog = path.join(wiki, 'logs', `${localDate()}.log`);
  has("agent's output reached the log file", fs.readFileSync(runLog, 'utf8'), 'stub agent: ingested 1 session');
  truthy('manifest moved', fs.statSync(path.join(vault, '.manifest.json')).mtimeMs > manifestBefore);
  truthy('manifest-stamp check passed (no failure reported)', !r.out.includes('without updating .manifest.json'));
  has('headline taken from log.md', r.out, 'CLAUDE-HISTORY');
  eq('pending queue drained', lines(path.join(wiki, '.pending_sessions')).length, 0);
  truthy('pending flag cleared', !fs.existsSync(path.join(wiki, '.pending_ingest')));
  truthy('lock released', !fs.existsSync(path.join(wiki, '.lock')));

  // And the inverse: an agent that exits clean but changes nothing must be a failure.
  fs.writeFileSync(workerJs, "console.log('stub agent: did nothing at all');\n");
  runHere(hook);
  const r2 = ingest();
  eq('a no-op run exits non-zero', r2.code, 1);
  has('a no-op run is reported as a failure', r2.out, 'without updating .manifest.json');
  eq('a failed run leaves the queue intact', lines(path.join(wiki, '.pending_sessions')).length, 1);

  cfg.hosts.claude.exe = realExe;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  removeHome(home);
}

summary();
