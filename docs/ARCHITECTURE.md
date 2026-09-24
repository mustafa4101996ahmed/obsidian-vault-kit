# Architecture

Read this when something has broken and the troubleshooting table in the setup guide wasn't enough.
It explains what each piece does and, more usefully, why each guard exists.

## Five layers

```
  1. VAULT            ~/Documents/Obsidian Vault
     |- notes, sorted into zones by shape
     |- CLAUDE.md          the contract: zones, frontmatter, graph rules
     |- .manifest.json     the ingest ledger
     `- .agents/skills/    the skills, version-controlled with the notes
                |
  2. SKILLS      `- symlink (unix) / junction (windows) -> ~/.claude/skills/
                                 (what Claude Code actually loads)
                |
  3. TRIGGER     Claude Stop hook -> bin/mark-pending.mjs
                                     writes .pending_ingest + one line per turn
                |
  4. RUNNER      scheduler (daily) -> bin/run-ingest.mjs
                 or `wiki-history` by hand    |
                                              `-> claude -p, headless,
                                                  running /wiki-history-ingest
                |
  5. LEDGER      .manifest.json  <- every processed file gets a row
```

Layers 1, 3 and 5 are identical on every platform. Layer 2 differs only in link type. Layer 4 differs
only in which scheduler starts it.

## Platform boundaries

Two files know what OS they are on. Everything else is platform-neutral.

`lib/platform.mjs` resolves paths, detects the OS, and probes for capabilities: which notifier exists,
which schedulers are usable, which shell startup files to write. Capability probes run at call time,
so installing `notify-send` later is picked up without reinstalling the kit.

`lib/schedule.mjs` holds four backends behind one interface. Each must run daily as the logged-in
user, catch up if the machine was asleep, and be removable without residue. A missed ingest is an
ingest never done, so catch-up matters more than punctuality — which is why the cron fallback is
ranked last: cron alone cannot catch up.

| | Backend | Catch-up | Needs admin |
|---|---|---|---|
| macOS | launchd user agent | yes | no |
| Linux | systemd user timer (`Persistent=true`) | yes | no |
| Linux | cron | no | no |
| Windows | `schtasks` | yes | no |

When no scheduler is available the install still succeeds and says so: the kit falls back to being run
by hand, which is a degraded mode, not a broken one.

### Dates: local for names, UTC for content

Log filenames and the frontmatter `updated` field use the machine's local date. Timestamps written
into vault content stay UTC, because the ingest skills compare them across machines.

Getting this wrong is not theoretical. An earlier version used `toISOString()` throughout, so east of
Greenwich the log filename and the user's own `date` disagreed for the first hours of every local day,
and `wiki-log` reported no log for a day that had one.

## 1. The vault

The folders sort by shape, not subject. `CLAUDE.md` is the authority: change a rule there and every
skill follows it, because every skill reads it at the start of a session.

`index.md`, `hot.md` and `log.md` are generated. `daily-update` writes the first two between marker
comments; ingest runs append to the third. Editing them by hand is harmless but pointless, because
the next run overwrites.

`_raw/` is excluded from Obsidian's search via `.obsidian/app.json`, and from git via `.gitignore`.
Source files land there and stay there. It exists so a half-distilled PDF doesn't pollute search
results.

## 2. Skills, and how they are linked

The skill definitions live inside the vault at `.agents/skills/`. Claude Code only looks in
`~/.claude/skills/`, so the installer creates one link per skill pointing back into the vault.

The vault is therefore the single source of truth, and skills get version-controlled alongside the
notes they operate on. Edit the copy in the vault.

On Windows that link is a junction rather than a symbolic link, because a Windows symlink needs either
administrator rights or Developer Mode while a junction needs neither. On macOS and Linux it is an
ordinary symlink. If linking fails the installer copies instead and says so; the cost of that fallback
is that edits no longer flow both ways.

## 3. The trigger

Claude Code fires a `Stop` hook at the end of every turn. The hook runs `bin/mark-pending.mjs`, which
does two things:

- writes `.pending_ingest`, the flag the runner gates on
- appends one epoch second to `.pending_sessions`, one line per turn

The second file is what makes the run safe to interrupt. The runner counts the lines before it
starts, and afterwards removes only that many. A turn that ends while the ingest is working stays
queued for the next run instead of being silently marked done.

`mark-pending.mjs` swallows all its own errors on purpose. A hook that throws interrupts the user's
session. Losing one marker costs a delayed ingest; a broken hook costs a working session.

## 4. The runner

`bin/run-ingest.mjs` is a wrapper around one headless Claude invocation. Nearly all of it is guards.

**The lock.** Creating a directory is atomic, so `fs.mkdirSync` is the test-and-set:
it fails if another run holds it. Two concurrent runs would both write `.manifest.json` and one set of
updates would be lost. A lock older than 180 minutes belongs to a crashed run and is cleared.

**The other-writer check.** Anything else writing the vault at the same time causes the same lost
update. The runner looks for a `.lock` directory anywhere under `_raw/` and exits if it finds one.
Exiting is safe: the pending flag is untouched, so the work stays queued.

**The pending gate.** No flag and no `--force` means exit immediately. This is what lets the scheduled
job run every day at no cost on the days nothing happened.

**The watchdog.** A run that stops writing transcripts for 20 minutes is hung, not thinking. The guard
was added after a run sat on a single model call for 100 minutes. The check looks for recent writes to any `.jsonl` belonging to this session id, including
files written by subagents, so delegated work counts as activity.

Note the session id is used to *find* the transcript rather than rebuilding the project directory
name from the vault path. Claude Code names those directories by folding path separators into
hyphens, which is lossy: a space in `Obsidian Vault` and a hyphen in a real folder name both come out
as the same character, and the encoding differs between platforms. Searching for the id
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
| The model ingests use | `model` in `~/.obsidian-wiki/config.json` |
| Vault location | Re-run `node install.mjs --vault ...` |
| Watchdog or stale-lock timeouts | `--stall-minutes` / `--stale-lock-minutes` on `run-ingest.mjs` |
| Schedule time | `node install.mjs --schedule HH:MM` |
| What the daily run asks Claude to do | the `PROMPT` array in `bin/run-ingest.mjs` |

## Porting to another platform

Add a branch to `lib/platform.mjs` for path resolution, notifier and scheduler detection, then a
backend to `lib/schedule.mjs`. Nothing else should need touching: the vault, the skills, the runner's
guards and the ledger are all platform-neutral by construction.

If you find yourself editing a third file to add a platform, that is a sign the abstraction has
leaked, and the fix is to move the platform-specific part into one of those two rather than spread it
further.
