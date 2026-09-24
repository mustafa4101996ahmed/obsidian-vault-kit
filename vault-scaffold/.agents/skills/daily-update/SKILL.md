---
name: daily-update
description: >
  Run the daily wiki maintenance cycle: check all source freshness, update the index, and regenerate hot.md.
  Use this skill when the user says "/daily-update", "run the daily update", "update everything", "morning sync",
  "refresh the wiki index", or when triggered by the launchd cron at 9 AM. Also use to set up or verify the
  cron + terminal notification infrastructure for the first time ("set up the daily cron", "install the
  terminal notification", "how do I get the morning reminder?").
---

# Daily Update — Wiki Maintenance Cycle

You run a lightweight maintenance pass over the wiki: check source freshness, refresh the index, update hot.md, and write the state file that the terminal notification reads.

## Before You Start

1. Read `~/.obsidian-wiki/config` to get `OBSIDIAN_VAULT_PATH` and `OBSIDIAN_WIKI_REPO`.
2. Read `$OBSIDIAN_VAULT_PATH/.manifest.json`.

## Modes

### Run Mode (default — triggered by cron or `/daily-update`)

Execute the maintenance cycle:

**Step 1: Source freshness check**

Compare each source in `.manifest.json` against its file's modification time. Classify as:
- **Fresh** — `mtime ≤ ingested_at`
- **Stale** — `mtime > ingested_at` (new content exists, not yet ingested)
- **Missing** — source file no longer exists

**Exclude from freshness check:** `archive/`, `memory/`, `.agents/`, `.claude/`, `.obsidian/`  
Pages in `archive/` have `lifecycle: archived` — they are intentionally static and should never be flagged as stale.

**Step 2: Index refresh**

Read `$OBSIDIAN_VAULT_PATH/index.md`. If any pages in the vault are missing from the index (or vice versa), update the index. Use the following command to enumerate vault pages, then reconcile against the index:

```bash
find $OBSIDIAN_VAULT_PATH -name "*.md" \
  -not -path "*/_*" \
  -not -path "*/archive/*" \
  -not -path "*/.agents/*" \
  -not -path "*/.claude/*" \
  -not -path "*/.obsidian/*" \
  -not -path "*/docs/superpowers/*"
```

**Step 3: hot.md update**

Read `hot.md`. If it's >48h old based on its `updated:` frontmatter, regenerate it: read the 10 most recently modified wiki pages and write a fresh ~500-word semantic snapshot of what the wiki covers. This keeps the next session's context warm without a full vault crawl.

**Step 4: Write state**

```bash
mkdir -p ~/.obsidian-wiki
date +%s > ~/.obsidian-wiki/.last_update
echo "<stale_count>" > ~/.obsidian-wiki/.pending_delta
```

**Step 5: Spawn impl-validator**

After the cycle, spawn `impl-validator` as a subagent:

```
impl-validator check:
  goal: "Daily wiki maintenance — index reconciled, hot.md refreshed, state file written"
  artifacts:
    - $OBSIDIAN_VAULT_PATH/index.md
    - $OBSIDIAN_VAULT_PATH/hot.md
    - ~/.obsidian-wiki/.last_update
    - ~/.obsidian-wiki/.pending_delta
  checks:
    - Does .last_update contain a recent Unix timestamp (within the last 60 seconds)?
    - Does .pending_delta contain a non-negative integer?
    - Does hot.md have an updated: frontmatter field set to today?
    - Does index.md list at least as many pages as exist in the vault?
```

Apply any FAILs before logging.

**Step 6: Graph health check**

Run this Python snippet (or equivalent) to count orphan and dead-end pages. Exclude `archive/`, `memory/`, `.agents/`, `.claude/`, `.obsidian/`, `docs/`, `entities/design-systems/`, and infrastructure files (`CLAUDE.md`, `index.md`, `hot.md`, `log.md`).

```python
import os, re
from collections import defaultdict

# enumerate wiki pages (same exclusions as find command above)
# build inbound/outbound maps from [[wikilinks]]
# orphans = pages with 0 inbound; deadends = pages with 0 outbound
```

Target: **0 orphans, 0 dead-ends**. If either count is non-zero, list the pages by name for the report — do not fix them automatically, just surface them.

**Step 7: Log**

Append to `$OBSIDIAN_VAULT_PATH/log.md`:
```
- [TIMESTAMP] DAILY-UPDATE fresh=N stale=N missing=N index_added=N hot_refreshed=true|false orphans=N deadends=N
```

**Step 8: Report to user**

```
## Daily Wiki Update

- Sources: N fresh · N stale · N missing
- Index: N pages (N added, N removed)
- hot.md: refreshed / up to date
- Graph: N orphans · N dead-ends  ← list pages if non-zero

Stale sources (run to sync):
  /wiki-history-ingest claude   — N sessions since last ingest
  /wiki-history-ingest codex    — N sessions since last ingest
```

### Setup Mode (triggered by "set up the daily run" or "install the shell notification")

Scheduling is not this skill's job — the kit installs it. Do not hand-write a scheduled task here.

**Windows (this vault's platform):** `install.ps1` in the vault kit registers the scheduled task and
writes the PowerShell profile block. If the user wants the daily run turned on, point them at:

```powershell
# from the cloned kit
.\install.ps1 -EnableSchedule

# check what is registered
Get-ScheduledTask -TaskName "ObsidianWikiDailyIngest" | Get-ScheduledTaskInfo

# run it now, without waiting for the schedule
& "$env:USERPROFILE\.obsidian-wiki\run-ingest.ps1" -Force
```

**Verify it actually worked** — a scheduled task that reports success while ingesting nothing is the
failure mode that hides longest. Confirm all three:

1. `$env:USERPROFILE\.obsidian-wiki\logs\<today>.log` has a run block with a newer timestamp
2. `.manifest.json` mtime moved
3. `$env:USERPROFILE\.obsidian-wiki\.pending_sessions` shrank

If the log shows a run but the manifest did not move, the run failed silently: read the log, do not
re-run blind.

**macOS or Linux:** the equivalent is a `launchd` plist or a cron entry invoking `run-ingest.sh`.
The kit ships the Windows path only; adapt from `automation/run-ingest.ps1` if the vault moves
platform.
