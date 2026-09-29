#!/usr/bin/env node
// Codex host support, end to end: config migration, per-host hooks and skill links,
// installing for a chosen host, the vault contract, and the skills the router promises.
// Every test here drives the real installer as a child process against a throwaway HOME.
// The in-process registry tests live in test/host.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { eq, has, head, KIT, makeHome, moduleUrl, removeHome, run, summary, truthy } from './harness.mjs';

const { HOSTS, hostById } = await import('../lib/host.mjs');

head('1. Config migration');

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
import { readConfig } from ${JSON.stringify(moduleUrl('lib/platform.mjs'))};
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

  removeHome(home);
}

head('2. Stop hooks, per host');

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
import { hostById } from ${JSON.stringify(moduleUrl('lib/host.mjs'))};
import { installStopHook, removeStopHook, hookCommand } from ${JSON.stringify(moduleUrl('lib/hooks.mjs'))};
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

  removeHome(home);
}

head('3. Skill links, per host');

{
  const { home, env } = makeHome('vault-kit-link-');

  const vault = path.join(home, 'v');
  for (const s of ['wiki-agent', 'daily-update']) {
    fs.mkdirSync(path.join(vault, '.agents', 'skills', s), { recursive: true });
    fs.writeFileSync(path.join(vault, '.agents', 'skills', s, 'SKILL.md'), `---\nname: ${s}\ndescription: x\n---\n`);
  }

  const driver = path.join(home, 'link.mjs');
  fs.writeFileSync(driver, `
import { HOSTS } from ${JSON.stringify(moduleUrl('lib/host.mjs'))};
import { linkSkills } from ${JSON.stringify(moduleUrl('lib/vault.mjs'))};
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

  removeHome(home);
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
import { linkSkills } from ${JSON.stringify(moduleUrl('lib/vault.mjs'))};
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

  removeHome(home);
}

head('4. Installing for a chosen host');

{
  const { home, env } = makeHome('vault-kit-inst-');
  const vault = path.join(home, 'Documents', 'Obsidian Vault');

  // Pretend Codex is installed: a home directory is enough for detection.
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });

  const installer = path.join(KIT, 'install.mjs');
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

  // Naming an absent host is an error, not a silent skip. withoutAgents strips the
  // agent CLIs off PATH, because a throwaway HOME alone does not make a host absent on
  // a machine where it is installed -- which silently inverted this assertion once.
  const { home: home2, env: env2 } = makeHome('vault-kit-absent-', { withoutAgents: true });
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
    removeHome(home4);
  }

  // A genuinely absent --engine still gets the install hint -- confirms the two
  // messages above did not collapse into one.
  {
    const { home: home5, env: env5 } = makeHome('vault-kit-engine-absent-', { withoutAgents: true });
    const r6 = run(installer, ['--vault', path.join(home5, 'v'), '--engine', 'codex', '--no-git'], env5);
    truthy('a genuinely absent engine fails', r6.code !== 0);
    has('and still carries the install hint', r6.out, 'npm install -g @openai/codex');
    removeHome(home5);
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

  removeHome(home3);

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

  removeHome(home);
  removeHome(home2);
}

head('5. The vault contract moves to AGENTS.md');

{
  const { home, env } = makeHome('vault-kit-contract-');
  const vault = path.join(home, 'v');
  fs.mkdirSync(vault, { recursive: true });

  // A contract the user has edited. Losing their edit would be the bug.
  fs.writeFileSync(path.join(vault, 'CLAUDE.md'), '# Vault contract\n\nMY OWN RULE: never file under areas/.\n');

  const driver = path.join(home, 'contract.mjs');
  fs.writeFileSync(driver, `
import { migrateContract } from ${JSON.stringify(moduleUrl('lib/vault.mjs'))};
console.log(migrateContract(${JSON.stringify(vault)}));
`);

  eq('an edited CLAUDE.md is moved', run(driver, [], env).out.trim(), 'moved');
  has('the edit survives in AGENTS.md', fs.readFileSync(path.join(vault, 'AGENTS.md'), 'utf8'), 'MY OWN RULE');
  has('CLAUDE.md becomes a pointer', fs.readFileSync(path.join(vault, 'CLAUDE.md'), 'utf8'), 'AGENTS.md');
  truthy('the original was backed up',
    fs.readdirSync(vault).some((f) => f.startsWith('CLAUDE.md.bak-')));
  eq('running again is a no-op', run(driver, [], env).out.trim(), 'both-present');

  removeHome(home);
}

{
  // The block above calls migrateContract directly and proves nothing about install
  // order. copyIfAbsent used to run first, which fills in any scaffold file missing
  // from an existing vault -- AGENTS.md included -- before migrateContract ever looks.
  // That leaves migrateContract seeing both files "present" and moving nothing, so the
  // user's edited CLAUDE.md is stranded as Claude's contract while Codex reads the
  // freshly-copied boilerplate. Only running the real installer catches that ordering
  // bug; a direct call to migrateContract cannot see it.
  const { home, env } = makeHome('vault-kit-contract-upgrade-');
  const vault = path.join(home, 'v');
  fs.mkdirSync(vault, { recursive: true });
  // A home directory is enough for detection, same convention as section 7.
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });

  const SENTINEL = 'MY OWN RULE: never file under areas/.';
  fs.writeFileSync(path.join(vault, 'CLAUDE.md'), `# Vault contract\n\n${SENTINEL}\n`);

  const installer = path.join(KIT, 'install.mjs');
  const r = run(installer, ['--vault', vault, '--host', 'codex', '--no-git'], env);
  eq('install exits clean over an existing edited CLAUDE.md', r.code, 0);

  const agents = fs.readFileSync(path.join(vault, 'AGENTS.md'), 'utf8');
  const claude = fs.readFileSync(path.join(vault, 'CLAUDE.md'), 'utf8');

  has("the user's edit became AGENTS.md's content", agents, SENTINEL);
  truthy('the pointer left behind does not carry the edit', !claude.includes(SENTINEL));
  has('CLAUDE.md points at AGENTS.md', claude, 'AGENTS.md');
  truthy('the original was backed up',
    fs.readdirSync(vault).some((f) => f.startsWith('CLAUDE.md.bak-')));
  // The tell for the ordering bug: if copyIfAbsent ran first, this scaffold-only
  // heading would be sitting in AGENTS.md instead of the user's real contract.
  truthy('no scaffold boilerplate landed in AGENTS.md instead of the edit',
    !agents.includes('Graph Health Rules'));

  removeHome(home);
}

head('6. Every source the router names is shipped');

{
  const skills = path.join(KIT, 'vault-scaffold/.agents/skills');
  const router = fs.readFileSync(path.join(skills, 'wiki-history-ingest', 'SKILL.md'), 'utf8');

  // The runner asks for a source by name; a row pointing at a skill that is not
  // here means the daily run routes to nothing and the vault stops growing.
  // Coupled: a router pointing `codex` at the wrong skill would still pass a bare "mentions codex" test.
  eq('the codex row routes to codex-history-ingest', /\|\s*`codex`\s*\|\s*`([^`]+)`\s*\|/.exec(router)?.[1], 'codex-history-ingest');

  const skill = fs.readFileSync(path.join(skills, 'codex-history-ingest', 'SKILL.md'), 'utf8');
  has('it declares its name', skill, 'name: codex-history-ingest');
  has('it has a description Codex can route on', skill, 'description:');
  has('it reads the Codex sessions directory', skill, '.codex');
  has('it writes the log tag the runner greps for', skill, 'CODEX_HISTORY_INGEST');
  truthy('no personal paths leaked in', !/\/Users\/[a-z]+\//i.test(skill));
  truthy('no dependency on a skill the kit does not ship', !skill.includes('llm-wiki/SKILL.md'));
  truthy('the reference file is shipped',
    fs.existsSync(path.join(skills, 'codex-history-ingest', 'references', 'codex-data-format.md')));
}

summary();
