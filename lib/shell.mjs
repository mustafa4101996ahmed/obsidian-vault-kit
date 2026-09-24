// The block the kit adds to your shell startup file.
//
// Gives you three things: a greeting saying how much Claude activity is waiting to
// be ingested, `wiki-history` to run an ingest by hand, and `wiki-log` to read what
// the last run did.
//
// Marker-guarded so installing twice is a no-op, and removable with one edit.

import fs from 'node:fs';
import path from 'node:path';
import { WIKI_DIR, shellTargets } from './platform.mjs';

export const BEGIN = '# >>> obsidian-wiki >>>';
export const END = '# <<< obsidian-wiki <<<';
const PS_BEGIN = '# >>> obsidian-wiki >>>';
const PS_END = '# <<< obsidian-wiki <<<';

function posixBlock(nodeExe, runner) {
  return `${BEGIN}
# Added by the Obsidian vault kit. Remove this block and the two markers to uninstall.
_obsidian_wiki_dir="${WIKI_DIR}"

wiki-history() {
  # wiki-history          ingest only if Claude turns are pending
  # wiki-history --force  ingest regardless
  "${nodeExe}" "${runner}" "$@"
}

wiki-log() {
  # Tail today's ingest log.
  local f="$_obsidian_wiki_dir/logs/$(date +%Y-%m-%d).log"
  if [ -f "$f" ]; then tail -n "\${1:-40}" "$f"; else echo "No ingest log for today yet."; fi
}

_obsidian_wiki_greeting() {
  [ -f "$_obsidian_wiki_dir/.pending_ingest" ] || return 0
  local n=0
  if [ -f "$_obsidian_wiki_dir/.pending_sessions" ]; then
    n=$(wc -l < "$_obsidian_wiki_dir/.pending_sessions" 2>/dev/null | tr -d ' ')
  fi
  printf '[wiki] %s Claude turn(s) since the last history ingest (runs daily; now: wiki-history)\\n' "\${n:-?}"
}
_obsidian_wiki_greeting
${END}
`;
}

function powershellBlock(nodeExe, runner) {
  return `${PS_BEGIN}
# Added by the Obsidian vault kit. Remove this block and the two markers to uninstall.
$script:ObsidianWikiDir = '${WIKI_DIR.replace(/'/g, "''")}'

function wiki-history {
    # wiki-history          ingest only if Claude turns are pending
    # wiki-history -Force   ingest regardless
    param([switch]$Force)
    $a = @('${runner.replace(/'/g, "''")}')
    if ($Force) { $a += '--force' }
    & '${nodeExe.replace(/'/g, "''")}' @a
}

function wiki-log {
    param([int]$Lines = 40)
    $f = Join-Path $script:ObsidianWikiDir ("logs/" + (Get-Date -Format 'yyyy-MM-dd') + ".log")
    if (Test-Path $f) { Get-Content -LiteralPath $f -Tail $Lines }
    else { Write-Host 'No ingest log for today yet.' }
}

if (Test-Path (Join-Path $script:ObsidianWikiDir '.pending_ingest')) {
    $f = Join-Path $script:ObsidianWikiDir '.pending_sessions'
    $n = if (Test-Path $f) { @(Get-Content -LiteralPath $f -ErrorAction SilentlyContinue).Count } else { 0 }
    Write-Host ("[wiki] {0} Claude turn(s) since the last history ingest " -f $n) -NoNewline -ForegroundColor DarkYellow
    Write-Host '(runs daily; now: wiki-history)' -ForegroundColor DarkGray
}
${PS_END}
`;
}

/**
 * Add the block to every shell startup file this platform uses.
 * Existing content is never rewritten: the block is appended, and a file that
 * already carries the marker is left alone.
 */
export function installShellBlocks(nodeExe, runner, { dryRun = false } = {}) {
  const results = [];

  for (const target of shellTargets()) {
    const block = target.kind === 'powershell'
      ? powershellBlock(nodeExe, runner)
      : posixBlock(nodeExe, runner);

    const existing = fs.existsSync(target.file) ? fs.readFileSync(target.file, 'utf8') : null;

    if (existing !== null && existing.includes(BEGIN)) {
      results.push({ ...target, status: 'present' });
      continue;
    }
    if (dryRun) {
      results.push({ ...target, status: 'would-add' });
      continue;
    }

    fs.mkdirSync(path.dirname(target.file), { recursive: true });
    if (existing !== null) {
      fs.copyFileSync(target.file, `${target.file}.bak-${stamp()}`);
    }
    const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(target.file, `${prefix}\n${block}`);
    results.push({ ...target, status: 'added' });
  }

  return results;
}

/** Strip the block from every startup file that has it. */
export function removeShellBlocks() {
  const results = [];
  for (const target of shellTargets()) {
    if (!fs.existsSync(target.file)) continue;
    const text = fs.readFileSync(target.file, 'utf8');
    if (!text.includes(BEGIN)) continue;
    const start = text.indexOf(BEGIN);
    const endIdx = text.indexOf(END, start);
    if (endIdx === -1) {
      results.push({ ...target, status: 'malformed-left-alone' });
      continue;
    }
    fs.copyFileSync(target.file, `${target.file}.bak-${stamp()}`);
    const next = (text.slice(0, start) + text.slice(endIdx + END.length))
      .replace(/\n{3,}/g, '\n\n');
    fs.writeFileSync(target.file, next);
    results.push({ ...target, status: 'removed' });
  }
  return results;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}
