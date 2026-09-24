// Creating the vault, and linking its skills into Claude Code.
//
// The guiding rule: never overwrite. Someone re-running the installer over a vault
// they have been using for months must lose nothing.

import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_SKILLS, LINK_TYPE, IS_WIN, localDateStamp } from './platform.mjs';

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
 * Link each skill in the vault into Claude Code's skills directory.
 *
 * Junctions on Windows, symlinks elsewhere. A junction needs no administrator
 * rights and no Developer Mode, which a Windows symlink does. The vault stays the
 * single source of truth either way: edit the skill in the vault, not the link.
 *
 * A real directory already sitting at the link path is never touched, because it
 * may be a skill the user wrote themselves.
 */
export function linkSkills(vaultPath, { dryRun = false } = {}) {
  const srcRoot = path.join(vaultPath, '.agents', 'skills');
  if (!fs.existsSync(srcRoot)) return [];

  const results = [];
  if (!dryRun) fs.mkdirSync(CLAUDE_SKILLS, { recursive: true });

  for (const entry of fs.readdirSync(srcRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const target = path.join(srcRoot, name);
    const link = path.join(CLAUDE_SKILLS, name);

    let existing = null;
    try {
      existing = fs.lstatSync(link);
    } catch { /* nothing there */ }

    if (existing) {
      if (existing.isSymbolicLink()) {
        let points = null;
        try { points = fs.readlinkSync(link); } catch { /* unreadable */ }
        const same = points && path.resolve(path.dirname(link), points) === path.resolve(target);
        results.push({ name, status: same ? 'present' : 'points-elsewhere', points });
      } else {
        results.push({ name, status: 'real-directory' });
      }
      continue;
    }

    if (dryRun) {
      results.push({ name, status: 'would-link' });
      continue;
    }

    try {
      fs.symlinkSync(target, link, LINK_TYPE);
      results.push({ name, status: 'linked' });
    } catch (err) {
      // Last resort: copy. The cost is that edits no longer flow both ways.
      try {
        fs.cpSync(target, link, { recursive: true });
        results.push({ name, status: 'copied', reason: err.code || err.message });
      } catch (err2) {
        results.push({ name, status: 'failed', reason: err2.code || err2.message });
      }
    }
  }
  return results;
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
