#!/usr/bin/env node
// The host registry, in process: descriptors, invocation arguments, detection and
// engine choice. Nothing here spawns a child or needs a throwaway HOME, which is the
// seam -- everything that does lives in test/codex.mjs.

import path from 'node:path';
import { eq, has, head, summary, truthy } from './harness.mjs';

const { HOSTS, hostById, detectHosts, resolveEngine } = await import('../lib/host.mjs');
const { buildPrompt } = await import('../lib/prompt.mjs');
const { LOG_MAX_BYTES, capNote, condenseEvent, pruneLogs } = await import('../lib/output.mjs');
const { treeKillCommand } = await import('../lib/platform.mjs');

head('1. The host registry');

eq('two hosts are registered', HOSTS.length, 2);
eq('Claude is first, because it is the tested path', HOSTS[0].id, 'claude');
eq('Codex is second', HOSTS[1].id, 'codex');
truthy('an unknown id resolves to null', hostById('nope') === null);
eq('hostById finds Codex', hostById('codex').label, 'Codex CLI');

const claude = hostById('claude');
const codex = hostById('codex');

has('Claude home is ~/.claude', claude.home, '.claude');
has('Codex home is ~/.codex', codex.home, '.codex');
has('Claude hooks live in settings.json', claude.hooksFile, 'settings.json');
has('Codex hooks live in hooks.json', codex.hooksFile, 'hooks.json');
has('Claude sessions live in projects/', claude.sessionsDir, 'projects');
has('Codex sessions live in sessions/', codex.sessionsDir, 'sessions');
eq('Claude watches transcripts', claude.watchdog, 'transcript');
eq('Codex watches stdout, having no session id to pin', codex.watchdog, 'stdout');
eq('Claude routes the claude history source', claude.historyArg, 'claude');
eq('Codex routes the codex history source', codex.historyArg, 'codex');
eq('Claude defaults to sonnet: it has no usable default of its own and must always get a --model', claude.defaultModel, 'sonnet');
eq("Codex has no default model: pinning one would rot and override the user's own config", codex.defaultModel, null);

head('2. Invocation arguments');

const args = { prompt: 'INGEST', model: 'sonnet', sessionId: 'abc-123', vault: '/v' };
const ca = claude.buildArgs(args);
has('Claude gets -p', ca.join(' '), '-p');
has('Claude pins the session id', ca.join(' '), '--session-id');
has('Claude keeps its tool allowlist', ca.join(' '), '--allowedTools');
has('Claude keeps acceptEdits', ca.join(' '), 'acceptEdits');
truthy('Claude receives the prompt', ca.includes('INGEST'));

// A config missing the model key (legacy, or Claude with no model configured) must
// never reach the CLI as the literal argument "--model null" -- see section 4 for
// the migration test that a missing key stays missing.
const caNoModel = claude.buildArgs({ prompt: 'P', model: null, sessionId: 's', vault: '/v' });
truthy('no bare "null" reaches the Claude CLI when no model is configured', !caNoModel.join(' ').includes('null'));
truthy('and --model is omitted entirely, not emitted with a null value', !caNoModel.includes('--model'));

const caWithModel = claude.buildArgs({ prompt: 'P', model: 'sonnet', sessionId: 's', vault: '/v' });
const modelFlagAt = caWithModel.indexOf('--model');
truthy('a configured model is still passed as --model <name>', modelFlagAt !== -1 && caWithModel[modelFlagAt + 1] === 'sonnet');

const xa = codex.buildArgs({ ...args, model: null });
eq('Codex runs exec', xa[0], 'exec');
has('Codex streams JSON so stdout is the activity signal', xa.join(' '), '--json');
has('Codex confines writes to the workspace', xa.join(' '), 'workspace-write');
has('Codex is pointed at the vault', xa.join(' '), '--cd');
has('Codex tolerates a non-git vault', xa.join(' '), '--skip-git-repo-check');
truthy('no model flag when no model is configured', !xa.includes('-m'));
truthy('the prompt is the last argument', xa[xa.length - 1] === 'INGEST');
truthy('Codex never gets a session id it has no flag for', !xa.includes('--session-id'));

const xm = codex.buildArgs({ ...args, model: 'gpt-5-codex' });
truthy('a configured model is passed with -m', xm.includes('-m') && xm.includes('gpt-5-codex'));

// Group 1: an unreadable source produces no rows while the other pass still stamps
// the manifest, so every source needs its own --add-dir, not just the engine's own.
const twoSource = claude.buildArgs({ ...args, sourceHosts: [claude, codex] });
truthy('two --add-dir flags, one per source session dir', twoSource.filter((a) => a === '--add-dir').length === 2 && twoSource.includes(claude.sessionsDir) && twoSource.includes(codex.sessionsDir));
eq('single-source args still get exactly one --add-dir', ca.filter((a) => a === '--add-dir').length, 1);
truthy('Codex never emits --add-dir: it would make session history writable', !codex.buildArgs({ ...args, sourceHosts: [claude, codex] }).includes('--add-dir'));
truthy('buildPrompt names claude before codex', /claude[\s\S]*codex/.test(buildPrompt(['claude', 'codex'])));

head('3. Detection and engine choice');

const detected = detectHosts();
eq('one row per registered host', detected.length, 2);
truthy('every row reports presence', detected.every((d) => typeof d.present === 'boolean'));

const both = [{ host: claude, present: true }, { host: codex, present: true }];
const onlyCodex = [{ host: claude, present: false }, { host: codex, present: true }];

eq('with both present the engine defaults to claude', resolveEngine(both, null).id, 'claude');
eq('with only codex present it is the engine', resolveEngine(onlyCodex, null).id, 'codex');
eq('an explicit request wins', resolveEngine(both, 'codex').id, 'codex');

let threw = null;
try { resolveEngine(onlyCodex, 'claude'); } catch (err) { threw = err.message; }
truthy('requesting an absent host throws', threw !== null);
has('and says how to install it', threw || '', 'npm install');

threw = null;
try { resolveEngine(both, 'gemini'); } catch (err) { threw = err.message; }
truthy('requesting an unknown host throws', threw !== null);

head('4. Condensing an event stream');
// Codex streams one JSON event per line. Echoing it verbatim means watching raw JSON
// scroll past for the whole run, so the terminal gets one readable line per event while
// the log keeps the raw stream.

eq('an event becomes one short line', condenseEvent('{"type":"turn.started"}'), '  \u00b7 turn.started');
has('a message is included', condenseEvent('{"type":"agent_message","text":"ok"}'), 'agent_message: ok');
has('an item type stands in when there is no text',
  condenseEvent('{"type":"item.completed","item":{"type":"shell"}}'), 'item.completed: shell');
eq('a blank line is dropped', condenseEvent('   '), null);

// The line that matters most: anything that is not JSON is where a real error surfaces,
// so it passes through untouched rather than being reformatted or swallowed.
eq('a non-JSON line passes through', condenseEvent('error: something broke'), 'error: something broke');
eq('malformed JSON passes through rather than vanishing', condenseEvent('{"type":'), '{"type":');

truthy('a long message is truncated, not echoed whole',
  condenseEvent(JSON.stringify({ type: 'agent_message', text: 'x'.repeat(500) })).length < 140);
truthy('newlines inside a message cannot break the one-line-per-event shape',
  !condenseEvent('{"type":"agent_message","text":"a\\nb"}').includes('\n'));

head('5. Bounding the logs');

{
  const fsx = await import('node:fs');
  const osx = await import('node:os');
  const dir = fsx.mkdtempSync(path.join(osx.tmpdir(), 'vault-kit-logs-'));
  const old = path.join(dir, '2020-01-01.log');
  const fresh = path.join(dir, '2999-01-01.log');
  const other = path.join(dir, 'notes.txt');
  for (const f of [old, fresh, other]) fsx.writeFileSync(f, 'x');
  fsx.utimesSync(old, new Date('2020-01-01'), new Date('2020-01-01'));

  eq('one stale log removed', pruneLogs(dir, 90), 1);
  truthy('the stale log is gone', !fsx.existsSync(old));
  truthy('a recent log is kept', fsx.existsSync(fresh));
  truthy('a non-log file is never touched', fsx.existsSync(other));
  eq('a missing directory is not an error', pruneLogs(path.join(dir, 'nope'), 90), 0);

  has('the cap note names the limit', capNote(), String(LOG_MAX_BYTES));
  fsx.rmSync(dir, { recursive: true, force: true });
}

head('6. Killing a stalled agent on Windows');
// The watchdog's kill has to reach the real agent. On Windows the agent is usually a
// .cmd shim launched through cmd.exe, so killing the child kills the interpreter and
// leaves the node grandchild running -- the watchdog then reports stopping something
// that is still going. isWin is injected here because this branch cannot otherwise be
// tested anywhere but Windows.

{
  const win = treeKillCommand(4321, { isWin: true });
  eq('Windows kills the tree with taskkill', win.file, 'taskkill');
  truthy('it targets the pid', win.args.includes('/PID') && win.args.includes('4321'));
  truthy('it includes the children', win.args.includes('/T'));
  truthy('it forces', win.args.includes('/F'));
  eq('the pid is passed as a string, as execFile requires', typeof win.args[win.args.indexOf('/PID') + 1], 'string');
  eq('POSIX needs no tree kill, because nothing stands between us and the agent',
    treeKillCommand(4321, { isWin: false }), null);
}

summary();
