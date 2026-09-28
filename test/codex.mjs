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

head('5. Stop hooks, per host');

{
  const { home, env } = makeHome('vault-kit-hook-');

  // A hooks.json that already has an unrelated hook. Losing it would be the bug.
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'hooks.json'), JSON.stringify({
    description: 'mine',
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] },
  }, null, 2));

  const driver = path.join(home, 'hook.mjs');
  fs.writeFileSync(driver, `
import { hostById } from ${JSON.stringify(path.resolve('lib/host.mjs'))};
import { installStopHook, removeStopHook, hookCommand } from ${JSON.stringify(path.resolve('lib/hooks.mjs'))};
const host = hostById(process.argv[2]);
const action = process.argv[3];
const cmd = hookCommand(process.execPath, '/w');
if (action === 'add') console.log(installStopHook(host, cmd));
else console.log(removeStopHook(host));
`);

  eq('the codex hook is added', run(driver, ['codex', 'add'], env).out.trim(), 'added');
  eq('adding twice is a no-op', run(driver, ['codex', 'add'], env).out.trim(), 'present');

  const written = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8'));
  eq('the Stop event has one entry', written.hooks.Stop.length, 1);
  has('the entry runs mark-pending', written.hooks.Stop[0].hooks[0].command, 'mark-pending.mjs');
  eq('the hook is a command hook', written.hooks.Stop[0].hooks[0].type, 'command');
  truthy('the unrelated PreToolUse hook survived', Boolean(written.hooks.PreToolUse));
  eq('the description survived', written.description, 'mine');
  truthy('hooks.json was backed up first',
    fs.readdirSync(path.join(home, '.codex')).some((f) => f.startsWith('hooks.json.bak-')));

  eq('the codex hook is removed', run(driver, ['codex', 'remove'], env).out.trim(), 'removed');
  const after = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8'));
  truthy('removing ours leaves theirs alone', Boolean(after.hooks.PreToolUse));
  truthy('the emptied Stop key is dropped', !after.hooks.Stop);

  eq('removing from a host with no file says so', run(driver, ['claude', 'remove'], env).out.trim(), 'no-settings');

  fs.rmSync(home, { recursive: true, force: true });
}

head('6. Skill links, per host');

{
  const { home, env } = makeHome('vault-kit-link-');

  const vault = path.join(home, 'v');
  for (const s of ['wiki-agent', 'daily-update']) {
    fs.mkdirSync(path.join(vault, '.agents', 'skills', s), { recursive: true });
    fs.writeFileSync(path.join(vault, '.agents', 'skills', s, 'SKILL.md'), `---\nname: ${s}\ndescription: x\n---\n`);
  }

  const driver = path.join(home, 'link.mjs');
  fs.writeFileSync(driver, `
import { HOSTS } from ${JSON.stringify(path.resolve('lib/host.mjs'))};
import { linkSkills } from ${JSON.stringify(path.resolve('lib/vault.mjs'))};
console.log(JSON.stringify(linkSkills(${JSON.stringify(vault)}, HOSTS)));
`);
  const r = run(driver, [], env);
  eq('the linker exits clean', r.code, 0);
  const rows = JSON.parse(r.out.trim().split('\n').pop());

  eq('two skills times two hosts', rows.length, 4);
  truthy('every row names its host', rows.every((x) => x.host === 'claude' || x.host === 'codex'));
  eq('claude got both skills', rows.filter((x) => x.host === 'claude').length, 2);
  eq('codex got both skills', rows.filter((x) => x.host === 'codex').length, 2);
  truthy('all four linked', rows.every((x) => x.status === 'linked'));

  for (const dir of ['.claude', '.codex']) {
    const link = path.join(home, dir, 'skills', 'wiki-agent');
    truthy(`${dir}/skills/wiki-agent exists`, fs.existsSync(link));
    truthy(`${dir} link is a link, not a copy`, fs.lstatSync(link).isSymbolicLink());
    has(`${dir} link resolves into the vault`, fs.realpathSync(link), path.join('.agents', 'skills'));
  }

  // Re-linking is idempotent.
  const rows2 = JSON.parse(run(driver, [], env).out.trim().split('\n').pop());
  truthy('a second run reports them present', rows2.every((x) => x.status === 'present'));

  fs.rmSync(home, { recursive: true, force: true });
}

{
  const { home, env } = makeHome('vault-kit-link-fail-');

  const vault = path.join(home, 'v');
  fs.mkdirSync(path.join(vault, '.agents', 'skills', 'wiki-agent'), { recursive: true });
  fs.writeFileSync(path.join(vault, '.agents', 'skills', 'wiki-agent', 'SKILL.md'), '---\nname: wiki-agent\ndescription: x\n---\n');

  // A FILE where codex's skills directory needs to go makes mkdirSync throw
  // portably (EEXIST here, ENOTDIR on some platforms) — a chmod-based block
  // does not work on Windows and may not work when tests run as root.
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'skills'), 'not a directory');

  const driver = path.join(home, 'link-fail.mjs');
  fs.writeFileSync(driver, `
import { linkSkills } from ${JSON.stringify(path.resolve('lib/vault.mjs'))};
const hosts = [
  { id: 'claude', skillsDir: ${JSON.stringify(path.join(home, '.claude', 'skills'))} },
  { id: 'codex', skillsDir: ${JSON.stringify(path.join(home, '.codex', 'skills'))} },
];
console.log(JSON.stringify(linkSkills(${JSON.stringify(vault)}, hosts)));
`);
  const r = run(driver, [], env);
  eq('one host failing does not throw', r.code, 0);
  const rows = JSON.parse(r.out.trim().split('\n').pop());

  const claudeRows = rows.filter((x) => x.host === 'claude');
  const codexRows = rows.filter((x) => x.host === 'codex');
  truthy('the healthy host still linked', claudeRows.length === 1 && claudeRows[0].status === 'linked');
  eq('exactly one row for the broken host', codexRows.length, 1);
  eq('the broken host is reported host-failed', codexRows[0].status, 'host-failed');
  truthy('the failure carries a reason', Boolean(codexRows[0].reason));

  fs.rmSync(home, { recursive: true, force: true });
}

summary();
