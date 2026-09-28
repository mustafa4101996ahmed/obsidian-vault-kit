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

  buildArgs({ prompt, model, sessionId }) {
    return [
      '-p', prompt,
      '--model', model,
      '--setting-sources', 'project,local',
      '--strict-mcp-config',
      '--permission-mode', 'acceptEdits',
      '--add-dir', this.sessionsDir,
      '--session-id', sessionId,
      '--allowedTools', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'Agent', 'TodoWrite',
      'Bash(python:*)', 'Bash(python3:*)', 'Bash(node:*)', 'Bash(ls:*)',
      'Bash(date:*)', 'Bash(wc:*)', 'Bash(cp:*)', 'Bash(stat:*)', 'Bash(find:*)',
      '--disallowedTools', `Edit(${this.home.split(path.sep).join('/')}/**)`,
    ];
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

  buildArgs({ prompt, model, vault }) {
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
