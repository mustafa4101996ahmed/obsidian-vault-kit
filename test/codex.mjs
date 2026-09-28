#!/usr/bin/env node
// Codex host support. Runs alongside test/suite.mjs; see that file for the
// throwaway-HOME convention every child-process test here follows.

import fs from 'node:fs';
import path from 'node:path';
import { eq, has, head, makeHome, run, summary, truthy } from './harness.mjs';

const { HOSTS, hostById, detectHosts, resolveEngine } = await import('../lib/host.mjs');

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

head('2. Invocation arguments');

const args = { prompt: 'INGEST', model: 'sonnet', sessionId: 'abc-123', vault: '/v' };
const ca = claude.buildArgs(args);
has('Claude gets -p', ca.join(' '), '-p');
has('Claude pins the session id', ca.join(' '), '--session-id');
has('Claude keeps its tool allowlist', ca.join(' '), '--allowedTools');
has('Claude keeps acceptEdits', ca.join(' '), 'acceptEdits');
truthy('Claude receives the prompt', ca.includes('INGEST'));

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

head('4. Config migration');

{
  const { home, env } = makeHome('vault-kit-cfg-');
  const wiki = path.join(home, '.obsidian-wiki');
  fs.mkdirSync(wiki, { recursive: true });

  // The shape every existing install has on disk today.
  fs.writeFileSync(path.join(wiki, 'config.json'), JSON.stringify({
    vaultPath: path.join(home, 'Documents', 'Obsidian Vault'),
    claudeExe: '/usr/local/bin/claude',
    model: 'sonnet',
    platform: process.platform,
    installed: '2026-01-01T00:00:00.000Z',
  }, null, 2));

  // Read it in a child process, because platform.mjs resolves HOME at module load.
  const reader = path.join(home, 'read.mjs');
  fs.writeFileSync(reader, `
import { readConfig } from ${JSON.stringify(path.resolve('lib/platform.mjs'))};
console.log(JSON.stringify(readConfig()));
`);
  const r = run(reader, [], env);
  eq('the reader exits clean', r.code, 0);
  const cfg = JSON.parse(r.out.trim().split('\n').pop());

  truthy('a legacy config gains a hosts map', Boolean(cfg.hosts));
  eq('the legacy claudeExe becomes the claude host exe', cfg.hosts.claude.exe, '/usr/local/bin/claude');
  eq('the legacy model becomes the claude host model', cfg.hosts.claude.model, 'sonnet');
  eq('the engine defaults to claude', cfg.engine, 'claude');
  truthy('no codex host is invented', !cfg.hosts.codex);
  truthy('vaultPath survives', cfg.vaultPath.includes('Obsidian Vault'));

  // A new-shape config is returned untouched.
  fs.writeFileSync(path.join(wiki, 'config.json'), JSON.stringify({
    vaultPath: '/v', engine: 'codex',
    hosts: { codex: { exe: '/usr/local/bin/codex' } },
  }, null, 2));
  const r2 = run(reader, [], env);
  const cfg2 = JSON.parse(r2.out.trim().split('\n').pop());
  eq('a new-shape engine is respected', cfg2.engine, 'codex');
  eq('a new-shape host exe is respected', cfg2.hosts.codex.exe, '/usr/local/bin/codex');
  truthy('claude is not invented for a codex-only install', !cfg2.hosts.claude);

  // An array hosts field is unusable and must not pass the guard.
  fs.writeFileSync(path.join(wiki, 'config.json'), JSON.stringify({
    vaultPath: '/v',
    hosts: [],
  }, null, 2));
  const r3 = run(reader, [], env);
  const cfg3 = JSON.parse(r3.out.trim().split('\n').pop());
  truthy('hosts: [] is migrated to a plain object', typeof cfg3.hosts === 'object' && !Array.isArray(cfg3.hosts));
  eq('hosts: [] gains a claude entry', cfg3.hosts.claude.exe, 'claude');
  eq('hosts: [] engine defaults to claude', cfg3.engine, 'claude');

  // An empty hosts object is self-contradictory: engine has no entry to point to.
  fs.writeFileSync(path.join(wiki, 'config.json'), JSON.stringify({
    vaultPath: '/v',
    hosts: {},
  }, null, 2));
  const r4 = run(reader, [], env);
  const cfg4 = JSON.parse(r4.out.trim().split('\n').pop());
  eq('hosts: {} is migrated to have a claude entry', cfg4.hosts.claude.exe, 'claude');
  eq('hosts: {} engine defaults to claude', cfg4.engine, 'claude');
  truthy('the engine exists in hosts, not pointing at nothing', cfg4.hosts[cfg4.engine] !== undefined);

  // Legacy configs without a model key must not gain a spurious model: undefined.
  fs.writeFileSync(path.join(wiki, 'config.json'), JSON.stringify({
    vaultPath: path.join(home, 'Documents', 'Obsidian Vault'),
    claudeExe: '/usr/local/bin/claude',
    platform: process.platform,
    installed: '2026-01-01T00:00:00.000Z',
  }, null, 2));
  const r5 = run(reader, [], env);
  const cfg5 = JSON.parse(r5.out.trim().split('\n').pop());
  truthy('a legacy config without model does not get one', !('model' in cfg5.hosts.claude));

  fs.rmSync(home, { recursive: true, force: true });
}

summary();
