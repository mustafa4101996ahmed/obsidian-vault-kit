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

head('7. Installing for a chosen host');

{
  const { home, env } = makeHome('vault-kit-inst-');
  const vault = path.join(home, 'Documents', 'Obsidian Vault');

  // Pretend Codex is installed: a home directory is enough for detection.
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });

  const installer = path.resolve('install.mjs');
  const r = run(installer, ['--vault', vault, '--host', 'codex', '--no-git'], env);
  eq('install exits clean', r.code, 0);
  has('it names the host it wired up', r.out, 'Codex CLI');

  const cfg = JSON.parse(fs.readFileSync(path.join(home, '.obsidian-wiki', 'config.json'), 'utf8'));
  eq('the engine is codex', cfg.engine, 'codex');
  truthy('codex is in the hosts map', Boolean(cfg.hosts.codex));
  truthy('claude was not wired up', !cfg.hosts.claude);
  truthy('no model is pinned for codex', !cfg.hosts.codex.model);

  truthy('the codex Stop hook exists', fs.existsSync(path.join(home, '.codex', 'hooks.json')));
  truthy('skills were linked into codex', fs.existsSync(path.join(home, '.codex', 'skills', 'wiki-agent')));
  truthy('nothing was written to ~/.claude', !fs.existsSync(path.join(home, '.claude', 'settings.json')));

  // Naming an absent host is an error, not a silent skip.
  const { home: home2, env: env2 } = makeHome('vault-kit-absent-');
  const r2 = run(installer, ['--vault', path.join(home2, 'v'), '--host', 'codex', '--no-git'], env2);
  truthy('installing for an absent host fails', r2.code !== 0);
  has('and says how to install it', r2.out, 'npm install -g @openai/codex');

  // An --engine that is genuinely installed but excluded by --host is a different
  // failure than "not installed" -- confusing the two sends the user to `npm
  // install` something they already have.
  {
    const { home: home4, env: env4 } = makeHome('vault-kit-engine-mismatch-');
    fs.mkdirSync(path.join(home4, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(home4, '.codex'), { recursive: true });
    const r5 = run(installer,
      ['--vault', path.join(home4, 'v'), '--host', 'claude', '--engine', 'codex', '--no-git'], env4);
    truthy('an installed-but-excluded engine fails', r5.code !== 0);
    has('it says Codex is installed but not included', r5.out,
      'is installed, but --host claude does not include it');
    truthy('it does not also say Codex is not installed', !r5.out.includes('is not installed'));
    fs.rmSync(home4, { recursive: true, force: true });
  }

  // A genuinely absent --engine still gets the install hint -- confirms the two
  // messages above did not collapse into one.
  {
    const { home: home5, env: env5 } = makeHome('vault-kit-engine-absent-');
    const r6 = run(installer, ['--vault', path.join(home5, 'v'), '--engine', 'codex', '--no-git'], env5);
    truthy('a genuinely absent engine fails', r6.code !== 0);
    has('and still carries the install hint', r6.out, 'npm install -g @openai/codex');
    fs.rmSync(home5, { recursive: true, force: true });
  }

  // Both hosts on one machine: two hook sets, two link sets, one source of truth.
  const { home: home3, env: env3 } = makeHome('vault-kit-both-');
  fs.mkdirSync(path.join(home3, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home3, '.codex'), { recursive: true });
  const vault3 = path.join(home3, 'v');
  const r4 = run(installer, ['--vault', vault3, '--host', 'both', '--no-git'], env3);
  eq('a dual-host install exits clean', r4.code, 0);

  const cfg3 = JSON.parse(fs.readFileSync(path.join(home3, '.obsidian-wiki', 'config.json'), 'utf8'));
  eq('both hosts are in the config', Object.keys(cfg3.hosts).sort().join(','), 'claude,codex');
  eq('claude is the engine when both are present', cfg3.engine, 'claude');
  eq('claude keeps a pinned model', cfg3.hosts.claude.model, 'sonnet');
  truthy('codex still has none', !cfg3.hosts.codex.model);

  for (const dir of ['.claude', '.codex']) {
    const hooksName = dir === '.claude' ? 'settings.json' : 'hooks.json';
    const h = JSON.parse(fs.readFileSync(path.join(home3, dir, hooksName), 'utf8'));
    has(`${dir} got a Stop hook`, JSON.stringify(h.hooks.Stop), 'mark-pending.mjs');
    truthy(`${dir} got skill links`, fs.existsSync(path.join(home3, dir, 'skills', 'wiki-agent')));
  }
  truthy('both link sets resolve to the one vault copy',
    fs.realpathSync(path.join(home3, '.claude', 'skills', 'wiki-agent'))
    === fs.realpathSync(path.join(home3, '.codex', 'skills', 'wiki-agent')));

  fs.rmSync(home3, { recursive: true, force: true });

  // Uninstall cleans the codex side and leaves an unrelated hook alone.
  const hooksFile = path.join(home, '.codex', 'hooks.json');
  const hooks = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  hooks.hooks.PreToolUse = [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo theirs' }] }];
  fs.writeFileSync(hooksFile, JSON.stringify(hooks, null, 2));

  // A symlink the user made by hand into a DIFFERENT vault must survive uninstall:
  // matching by vault, not merely by the '.agents/skills' path shape, is the whole
  // point of the fix. Junction on Windows, symlink elsewhere -- same rule linkSkills
  // itself follows, so no admin rights are needed to create it here either.
  const foreignVault = path.join(home, 'other-vault');
  const foreignSkill = path.join(foreignVault, '.agents', 'skills', 'mine');
  fs.mkdirSync(foreignSkill, { recursive: true });
  fs.writeFileSync(path.join(foreignSkill, 'SKILL.md'), '---\nname: mine\ndescription: x\n---\n');
  const foreignLink = path.join(home, '.codex', 'skills', 'mine');
  fs.symlinkSync(foreignSkill, foreignLink, process.platform === 'win32' ? 'junction' : 'dir');

  const r3 = run(installer, ['--uninstall'], env);
  eq('uninstall exits clean', r3.code, 0);
  const left = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  truthy('our Stop hook is gone', !left.hooks.Stop);
  truthy("their PreToolUse hook is not", Boolean(left.hooks.PreToolUse));
  truthy('codex skill links are gone', !fs.existsSync(path.join(home, '.codex', 'skills', 'wiki-agent')));
  truthy('a foreign vault\'s symlink survives uninstall', fs.existsSync(foreignLink));
  truthy('the vault survives an uninstall', fs.existsSync(path.join(vault, 'index.md')));

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(home2, { recursive: true, force: true });
}

head('8. The runner, against a codex stub');

{
  const { home, env } = makeHome('vault-kit-run-');
  const vault = path.join(home, 'Documents', 'Obsidian Vault');
  const wiki = path.join(home, '.obsidian-wiki');

  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const inst = run(path.resolve('install.mjs'), ['--vault', vault, '--host', 'codex', '--no-git'], env);
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
  has('the watchdog says why', r3.out, 'made no progress');
  truthy(`it was killed promptly (took ${Math.round(tookSeconds)}s, under 180)`, tookSeconds < 180);
  // 2, not 1: the no-op run above already left one turn queued (asserted above), and
  // this scenario marks one more before running. A failed run -- stalled or not --
  // must never drop either: fail() exits before the queue is ever touched.
  eq('a killed run leaves the queue intact',
    fs.readFileSync(path.join(wiki, '.pending_sessions'), 'utf8').trim().split('\n').length, 2);

  fs.rmSync(home, { recursive: true, force: true });
}

summary();
