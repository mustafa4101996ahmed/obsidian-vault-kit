// Creating the vault, and linking its skills into Claude Code.
//
// The guiding rule: never overwrite. Someone re-running the installer over a vault
// they have been using for months must lose nothing.

import fs from 'node:fs';
import path from 'node:path';
import { LINK_TYPE, IS_WIN, localDateStamp } from './platform.mjs';

/**
 * Copy a tree, skipping any file that already exists at the destination.
 * Returns what it did so the caller can report per-file.
 */
export function copyIfAbsent(srcRoot, destRoot, { dryRun = false, skip = [] } = {}) {
  const created = [];
  const kept = [];
  const dirs = [];
  const skipSet = new Set(skip);

  const walk = (relDir) => {
    const absSrc = path.join(srcRoot, relDir);
    for (const entry of fs.readdirSync(absSrc, { withFileTypes: true })) {
      const rel = relDir ? path.join(relDir, entry.name) : entry.name;
      if (skipSet.has(rel)) continue;
      const dest = path.join(destRoot, rel);

      if (entry.isDirectory()) {
        if (!fs.existsSync(dest)) {
          dirs.push(rel);
          if (!dryRun) fs.mkdirSync(dest, { recursive: true });
        }
        walk(rel);
      } else if (entry.isFile()) {
        if (fs.existsSync(dest)) {
          kept.push(rel);
        } else {
          created.push(rel);
          if (!dryRun) {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(path.join(srcRoot, rel), dest);
          }
        }
      }
    }
  };

  if (!dryRun) fs.mkdirSync(destRoot, { recursive: true });
  walk('');
  return { created, kept, dirs };
}

/**
 * The scaffold ships its .gitignore as `_gitignore`.
 *
 * A real .gitignore inside the scaffold would apply to the kit's own repository and
 * stop `_raw/` from shipping at all, so it travels under a neutral name.
 *
 * It is read straight from the scaffold and never copied into the vault: doing that
 * and deleting it again made every reinstall report a file change that was not one.
 */
export function installGitignore(scaffoldPath, vaultPath, { dryRun = false } = {}) {
  const template = path.join(scaffoldPath, '_gitignore');
  const target = path.join(vaultPath, '.gitignore');
  if (!fs.existsSync(template)) return 'absent';
  if (fs.existsSync(target)) return 'kept-existing';
  if (dryRun) return 'would-install';
  fs.copyFileSync(template, target);
  return 'installed';
}

/** Write the real vault path into the fresh manifest, replacing the placeholder. */
export function stampManifest(vaultPath, { dryRun = false } = {}) {
  const manifest = path.join(vaultPath, '.manifest.json');
  if (!fs.existsSync(manifest)) return 'absent';
  const raw = fs.readFileSync(manifest, 'utf8');
  if (!raw.includes('REPLACE_VAULT')) return 'already-stamped';
  if (dryRun) return 'would-stamp';
  // JSON.stringify handles the backslash escaping a Windows path needs.
  const replaced = raw.replace('"REPLACE_VAULT"', JSON.stringify(vaultPath));
  fs.writeFileSync(manifest, replaced);
  return 'stamped';
}

/** Replace REPLACE_DATE placeholders in the seed pages with today. */
export function stampSeedDates(vaultPath, { dryRun = false } = {}) {
  const today = localDateStamp();
  const files = [
    'index.md', 'hot.md', 'log.md', path.join('mocs', 'vault-map.md'), '.manifest.json',
  ];
  const touched = [];
  for (const rel of files) {
    const p = path.join(vaultPath, rel);
    if (!fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.includes('REPLACE_DATE')) continue;
    touched.push(rel);
    if (!dryRun) fs.writeFileSync(p, raw.replaceAll('REPLACE_DATE', today));
  }
  return touched;
}

/**
 * Link each skill in the vault into every host's skills directory.
 *
 * Junctions on Windows, symlinks elsewhere. A junction needs no administrator
 * rights and no Developer Mode, which a Windows symlink does. The vault stays the
 * single source of truth for every host on the machine: edit the skill in the
 * vault, not the link.
 *
 * A real directory already sitting at a link path is never touched, because it may
 * be a skill the user wrote themselves.
 */
export function linkSkills(vaultPath, hosts, { dryRun = false } = {}) {
  const srcRoot = path.join(vaultPath, '.agents', 'skills');
  if (!fs.existsSync(srcRoot)) return [];

  const names = fs.readdirSync(srcRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const results = [];
  for (const host of hosts) {
    try {
      if (!dryRun) fs.mkdirSync(host.skillsDir, { recursive: true });
    } catch (err) {
      // One host's unusable skills directory must not discard the rows for hosts that
      // already linked: the links exist on disk, and an installer that says nothing
      // about them leaves the user with a half-wired machine and no way to see it.
      results.push({
        host: host.id,
        name: '(skills directory)',
        status: 'host-failed',
        reason: err.code || err.message,
      });
      continue;
    }
    for (const name of names) {
      results.push({ host: host.id, ...linkOne(srcRoot, host.skillsDir, name, dryRun) });
    }
  }
  return results;
}

/** One skill into one host's skills directory. Extracted so the loop above reads. */
function linkOne(srcRoot, skillsDir, name, dryRun) {
  const target = path.join(srcRoot, name);
  const link = path.join(skillsDir, name);

  let existing = null;
  try { existing = fs.lstatSync(link); } catch { /* nothing there */ }

  if (existing) {
    if (existing.isSymbolicLink()) {
      let points = null;
      try { points = fs.readlinkSync(link); } catch { /* unreadable */ }
      const same = points && path.resolve(path.dirname(link), points) === path.resolve(target);
      return { name, status: same ? 'present' : 'points-elsewhere', points };
    }
    return { name, status: 'real-directory' };
  }

  if (dryRun) return { name, status: 'would-link' };

  try {
    fs.symlinkSync(target, link, LINK_TYPE);
    return { name, status: 'linked' };
  } catch (err) {
    // Last resort: copy. The cost is that edits no longer flow both ways.
    try {
      fs.cpSync(target, link, { recursive: true });
      return { name, status: 'copied', reason: err.code || err.message };
    } catch (err2) {
      return { name, status: 'failed', reason: err2.code || err2.message };
    }
  }
}

/** Copy the runner and hook into ~/.obsidian-wiki/bin, where the scheduler finds them. */
export function installRunner(kitRoot, wikiDir, { dryRun = false } = {}) {
  const srcBin = path.join(kitRoot, 'bin');
  const srcLib = path.join(kitRoot, 'lib');
  const destBin = path.join(wikiDir, 'bin');
  const destLib = path.join(wikiDir, 'lib');

  if (dryRun) return { status: 'would-install', destBin };

  fs.mkdirSync(destBin, { recursive: true });
  fs.mkdirSync(destLib, { recursive: true });
  fs.mkdirSync(path.join(wikiDir, 'logs'), { recursive: true });

  for (const f of fs.readdirSync(srcBin)) {
    fs.copyFileSync(path.join(srcBin, f), path.join(destBin, f));
    if (!IS_WIN) fs.chmodSync(path.join(destBin, f), 0o755);
  }
  for (const f of fs.readdirSync(srcLib)) {
    fs.copyFileSync(path.join(srcLib, f), path.join(destLib, f));
  }
  return { status: 'installed', destBin };
}

const CONTRACT_POINTER = `# Vault contract

The contract this vault runs on lives in **AGENTS.md** — zones, frontmatter, graph
rules, all of it. Read that file; edit that file.

This pointer exists because Claude Code looks for CLAUDE.md and Codex looks for
AGENTS.md. One authority, two names, no drift.
`;

/**
 * Make AGENTS.md the vault's contract, keeping any edits the user made to CLAUDE.md.
 *
 * copyIfAbsent would skip an existing vault entirely and leave Codex with no
 * contract at all, and ARCHITECTURE.md tells people to edit CLAUDE.md, so those
 * edits are real and must survive. Moving rather than copying is what keeps one
 * authority instead of two files that drift.
 */
export function migrateContract(vaultPath, { dryRun = false } = {}) {
  const claudeMd = path.join(vaultPath, 'CLAUDE.md');
  const agentsMd = path.join(vaultPath, 'AGENTS.md');
  const hasClaude = fs.existsSync(claudeMd);
  const hasAgents = fs.existsSync(agentsMd);

  if (hasAgents && hasClaude) return 'both-present';
  if (!hasClaude) return 'nothing-to-do';
  if (dryRun) return 'would-move';

  fs.copyFileSync(claudeMd, `${claudeMd}.bak-${stampName()}`);
  fs.renameSync(claudeMd, agentsMd);
  fs.writeFileSync(claudeMd, CONTRACT_POINTER);
  return 'moved';
}

// Millisecond precision, not seconds: two migrations landing in the same second would
// otherwise produce the same backup name, and copyFileSync has no exclusive-create mode
// to make the second one fail loudly instead of silently overwriting the first backup --
// the one file this task exists to not lose.
function stampName() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, -1);
}
