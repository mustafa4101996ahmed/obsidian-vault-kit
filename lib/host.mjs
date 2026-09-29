// The only module that knows which agent CLI it is talking to.
//
// Everything else takes a host descriptor and stays agent-neutral. If you are adding
// a third host, this file is the one you touch — the same contract lib/schedule.mjs
// holds for schedulers and lib/platform.mjs holds for operating systems.

import fs from 'node:fs';
import path from 'node:path';
import { HOME, which } from './platform.mjs';

const claudeHome = path.join(HOME, '.claude');
const codexHome = path.join(HOME, '.codex');

/**
 * Claude Code. Confines the agent by enumerating tools, and its -p stdout stays
 * silent until the end, so activity has to be read from transcript mtimes.
 */
export const CLAUDE = {
  id: 'claude',
  label: 'Claude Code',
  exe: 'claude',
  home: claudeHome,
  skillsDir: path.join(claudeHome, 'skills'),
  sessionsDir: path.join(claudeHome, 'projects'),
  hooksFile: path.join(claudeHome, 'settings.json'),
  historyArg: 'claude',
  logTag: 'CLAUDE',
  installHint: 'npm install -g @anthropic-ai/claude-code',
  watchdog: 'transcript',
  // Claude Code has no usable model default of its own -- unlike Codex, it needs an
  // explicit --model to run at all, so the registry pins one rather than leaving
  // the runner to guess or, worse, pass a missing value through.
  defaultModel: 'sonnet',

  buildArgs({ prompt, model, sessionId, sourceHosts }) {
    // One --add-dir per source host's sessions directory, not just this engine's
    // own. Without this, a machine ingesting more than one history in a single pass
    // can only read whichever host is running headless: the other source's
    // transcripts stay unreadable, that source's pass produces no rows, and the
    // pass that COULD read still stamps .manifest.json -- so the run exits 0 and
    // reports success having silently ingested only half of what it claimed.
    // Deduped so the common single-host case still emits exactly one --add-dir, as
    // it always has.
    const dirs = [...new Set((sourceHosts && sourceHosts.length ? sourceHosts : [this]).map((h) => h.sessionsDir))];
    const args = [
      '-p', prompt,
      '--setting-sources', 'project,local',
      '--strict-mcp-config',
      '--permission-mode', 'acceptEdits',
      ...dirs.flatMap((dir) => ['--add-dir', dir]),
      '--session-id', sessionId,
      '--allowedTools', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'Agent', 'TodoWrite',
      'Bash(python:*)', 'Bash(python3:*)', 'Bash(node:*)', 'Bash(ls:*)',
      'Bash(date:*)', 'Bash(wc:*)', 'Bash(cp:*)', 'Bash(stat:*)', 'Bash(find:*)',
      '--disallowedTools', `Edit(${this.home.split(path.sep).join('/')}/**)`,
    ];
    // Guards against the literal string "--model null" reaching the CLI. The
    // registry's defaultModel should make model always truthy here, but a config
    // could still slip an empty string through, and "null"/"" are not model names
    // any CLI understands -- better to omit the flag than hand it a bad value.
    if (model) args.push('--model', model);
    return args;
  },
};

/**
 * Codex CLI. Confines the agent by sandbox rather than by tool name, which is
 * coarser: workspace-write permits writes to the working directory, so --cd puts
 * that at the vault. exec defaults its approval policy to Never, so unattended
 * needs no dangerous flag.
 *
 * There is no --session-id, so the transcript scan the Claude path uses cannot
 * work here. --json makes stdout an event stream instead, which is a better stall
 * signal anyway: it cannot be fooled by an unrelated session writing a rollout.
 */
export const CODEX = {
  id: 'codex',
  label: 'Codex CLI',
  exe: 'codex',
  home: codexHome,
  skillsDir: path.join(codexHome, 'skills'),
  sessionsDir: path.join(codexHome, 'sessions'),
  hooksFile: path.join(codexHome, 'hooks.json'),
  historyArg: 'codex',
  logTag: 'CODEX',
  installHint: 'npm install -g @openai/codex',
  watchdog: 'stdout',
  // Unlike Claude, Codex runs fine with no --model at all, so pinning one here
  // would only rot as OpenAI ships new model names, and would override whatever
  // the user's own Codex config already chose.
  defaultModel: null,
  // Settled by the Task 1 spike (which could not run codex here, so it took the
  // conservative branch): Codex enforces per-hook trust, so an installed hook is
  // not necessarily a firing hook, and a hook that never fires means the vault
  // silently stops growing. install.mjs warns on every string here for every host
  // it wires up, so a caveat like this lives on the descriptor, not hardcoded by
  // host id in install.mjs.
  // Settled by running the real CLI, not by reading its source: with this hook in
  // ~/.codex/hooks.json a normal run does not fire it and records no trust state, while
  // the same run with --dangerously-bypass-hook-trust does fire it. So the hook we write
  // is correct and trust is genuinely the gate. What we could not establish is how a user
  // grants it, because a non-interactive run never prompts -- so this says that plainly
  // rather than inventing a procedure.
  installNotes: [
    'Codex will not fire this hook until it trusts it, so the daily ingest is not '
    + 'triggered yet. Start `codex` once interactively and approve the hook. The hook '
    + 'itself is verified correct - it fires under --dangerously-bypass-hook-trust - '
    + 'but what grants trust was not, because a non-interactive run never prompts.',
  ],

  buildArgs({ prompt, model, vault, sourceHosts }) {
    // sourceHosts is accepted, for call-shape symmetry with CLAUDE.buildArgs, and
    // deliberately never becomes an --add-dir here. That flag grants WRITE access
    // under workspace-write, and handing it another host's sessions directory would
    // make that history mutable by this run, not merely readable. Codex can already
    // read outside the directory it writes to under workspace-write, so a second
    // source's history needs no extra flag at all. If this asymmetry with Claude
    // looks like an oversight, it isn't -- see docs/ARCHITECTURE.md.
    const args = [
      'exec',
      '--json',
      '--sandbox', 'workspace-write',
      '--cd', vault,
      // --no-git vaults are supported, and exec otherwise refuses to run outside a repo.
      '--skip-git-repo-check',
    ];
    // No default model on purpose: a pinned gpt-5.x string would rot, and would
    // override whatever the user's own config already chose.
    if (model) args.push('-m', model);
    args.push(prompt);
    return args;
  },
};

/** Claude first: it is the tested path, and the default engine when both are present. */
export const HOSTS = [CLAUDE, CODEX];

export function hostById(id) {
  return HOSTS.find((h) => h.id === id) || null;
}

/**
 * Which hosts this machine has. A host counts as present if its CLI is on PATH or
 * its home directory exists — the second case catches a shell whose PATH the
 * scheduler does not inherit.
 */
export function detectHosts() {
  return HOSTS.map((host) => {
    const exe = which(host.exe);
    let homeExists = false;
    try { homeExists = fs.existsSync(host.home); } catch { /* unreadable */ }
    return { host, exe, present: Boolean(exe) || homeExists };
  });
}

/**
 * Which host runs the headless ingest. Defaults to the only present host, and to
 * Claude when both are present, because that is the path with the most miles on it.
 */
export function resolveEngine(detected, requested) {
  const present = detected.filter((d) => d.present);

  if (requested) {
    const host = hostById(requested);
    if (!host) {
      throw new Error(`unknown host "${requested}"; known hosts: ${HOSTS.map((h) => h.id).join(', ')}`);
    }
    const row = detected.find((d) => d.host.id === host.id);
    if (!row || !row.present) {
      throw new Error(`${host.label} is not installed, so it cannot be the engine. Install it first:\n  ${host.installHint}`);
    }
    return host;
  }

  if (!present.length) return CLAUDE;
  const claudeRow = present.find((d) => d.host.id === 'claude');
  return claudeRow ? claudeRow.host : present[0].host;
}
