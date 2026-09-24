# Architecture

Read this when something has broken and the troubleshooting table in the setup guide wasn't enough.
It explains what each piece does and, more usefully, why each guard exists.

## Five layers

```
  1. VAULT            %USERPROFILE%\Documents\Obsidian Vault
     ├─ notes, sorted into zones by shape
     ├─ CLAUDE.md          the contract: zones, frontmatter, graph rules
     ├─ .manifest.json     the ingest ledger
     └─ .agents\skills\    the skills, version-controlled with the notes
                │
  2. SKILLS      └─ junctions ─→ %USERPROFILE%\.claude\skills\
                                 (what Claude Code actually loads)
                │
  3. TRIGGER     Claude Stop hook ─→ mark-pending.ps1
                                     writes .pending_ingest + one line per turn
                │
  4. RUNNER      Task Scheduler (daily) ─→ run-ingest.ps1
                 or `wiki-history` by hand    │
                                              └─→ claude -p, headless,
                                                  running /wiki-history-ingest
                │
  5. LEDGER      .manifest.json  ← every processed file gets a row
```

## 1. The vault

The folders sort by shape, not subject. `CLAUDE.md` is the authority: change a rule there and every
skill follows it, because every skill reads it at the start of a session.

`index.md`, `hot.md` and `log.md` are generated. `daily-update` writes the first two between marker
comments; ingest runs append to the third. Editing them by hand is harmless but pointless, because
the next run overwrites.

`_raw/` is excluded from Obsidian's search via `.obsidian/app.json`, and from git via `.gitignore`.
Source files land there and stay there. It exists so a half-distilled PDF doesn't pollute search
results.

## 2. Skills, and why junctions

The skill definitions live inside the vault at `.agents\skills\`. Claude Code only looks in
`%USERPROFILE%\.claude\skills\`, so the installer creates a directory junction per skill pointing
back into the vault.

The vault is therefore the single source of truth, and skills get version-controlled alongside the
notes they operate on. Edit the copy in the vault.

Junctions rather than symbolic links because a symlink on Windows needs either administrator rights
or Developer Mode, and a junction needs neither. If a junction can't be created the installer falls
back to copying and says so; the cost of the fallback is that edits no longer flow both ways.

## 3. The trigger

Claude Code fires a `Stop` hook at the end of every turn. The hook runs `mark-pending.ps1`, which
does two things:

- `touch`es `.pending_ingest`, the flag the runner gates on
- appends one epoch second to `.pending_sessions`, one line per turn

The second file is what makes the run safe to interrupt. The runner counts the lines before it
starts, and afterwards removes only that many. A turn that ends while the ingest is working stays
queued for the next run instead of being silently marked done.

`mark-pending.ps1` swallows all its own errors on purpose. A hook that throws interrupts the user's
session. Losing one marker costs a delayed ingest; a broken hook costs a working session.

## 4. The runner

`run-ingest.ps1` is a wrapper around one headless Claude invocation. Nearly all of it is guards.

**The lock.** Creating a directory is atomic, so `New-Item -ItemType Directory` is the test-and-set:
it fails if another run holds it. Two concurrent runs would both write `.manifest.json` and one set of
updates would be lost. A lock older than 180 minutes belongs to a crashed run and is cleared.

**The other-writer check.** Anything else writing the vault at the same time causes the same lost
update. The runner looks for a `.lock` directory anywhere under `_raw/` and exits if it finds one.
Exiting is safe: the pending flag is untouched, so the work stays queued.

**The pending gate.** No flag and no `-Force` means exit immediately. This is what lets the scheduled
task run every day at no cost on the days nothing happened.

**The watchdog.** A run that stops writing transcripts for 20 minutes is hung, not thinking. The
original macOS version of this script was added after a run sat on a single model call for 100
minutes. The check looks for recent writes to any `.jsonl` belonging to this session id, including
files written by subagents, so delegated work counts as activity.

Note the session id is used to *find* the transcript rather than rebuilding the project directory
name from the vault path. Claude Code names those directories by folding path separators into
hyphens, which is lossy: a space in `Obsidian Vault` and a hyphen in a real folder name both come out
as the same character, and the encoding differs between Windows and Unix. Searching for the id
cannot be wrong; reconstructing the path can.

**The manifest stamp.** The guard that matters most. After Claude exits zero, the runner checks
whether `.manifest.json` is newer than the run's start marker. If it isn't, the run is a failure
regardless of its exit code, because a run that recorded nothing ingested nothing. A pipeline that
reports success while doing nothing will go unnoticed for weeks.

**Pending arithmetic.** Only the lines counted at the start are consumed. If the file is then empty
the flag is removed; if not, the remaining count is logged and stays queued.

## 5. The ledger

`.manifest.json` is the only record of what has been read. Two rules govern it, and both exist
because they were broken once.

**Every processed file gets a row, including files that produced no page**, with a `note` saying why.
A file with no row looks new on every future run, so it gets re-read forever.

**Rows are upserted by `source_path`, never blind-appended.** Duplicate rows for one path mean the
file reports fresh or stale depending on which row is read first, and the same file can end up filed
under two different source types.

`_meta` holds the vault path, the schema version, and the timestamp of the last run.

## Failure modes, ranked by how long they hide

| Failure | How you notice | Guard |
|---|---|---|
| Run reports success, ingested nothing | Weeks later, wondering why the vault is thin | Manifest stamp check |
| Two writers, one loses its updates | Never, without the check | Lock plus other-writer check |
| Duplicate manifest rows | Files re-ingested or skipped at random | Upsert by path |
| Turn lost during a run | Never | Pending line arithmetic |
| Claude hangs on a model call | The task still running hours later | 20-minute watchdog |
| Stop hook throws | Immediately, and painfully | Hook swallows its own errors |
| Missing frontmatter `summary` | Note absent from the index though the file exists | `daily-update` reports it |
| Orphan note, nothing links to it | You never find the note again | Graph health rules, rule 1 |

## Changing things

| To change | Edit |
|---|---|
| Zones, frontmatter, graph rules | `CLAUDE.md` in the vault |
| The model ingests use | `model` in `%USERPROFILE%\.obsidian-wiki\config.json` |
| Vault location | Re-run `install.ps1 -VaultPath ...`, then fix `vaultPath` in `config.json` |
| Watchdog or stale-lock timeouts | `-StallMinutes` / `-StaleLockMinutes` on `run-ingest.ps1` |
| Schedule time | `.\install.ps1 -EnableSchedule -ScheduleTime HH:mm` |
| What the daily run asks Claude to do | The `$prompt` here-string in `run-ingest.ps1` |

## Moving off Windows

The vault and the skills are platform-neutral: markdown and JSON throughout. Only the automation
layer is Windows-specific. To move it, port `run-ingest.ps1` (the logic is about 120 lines once the
comments come out) and swap Task Scheduler for a launchd plist on macOS or a cron entry or systemd
user timer on Linux. The `Stop` hook becomes a one-line shell command.
