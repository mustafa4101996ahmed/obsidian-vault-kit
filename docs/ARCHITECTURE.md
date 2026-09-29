# Architecture

Read this when something has broken and the troubleshooting table in the setup guide wasn't enough.
It explains what each piece does and, more usefully, why each guard exists.

## Five layers

```
  1. VAULT            ~/Documents/Obsidian Vault
     |- notes, sorted into zones by shape
     |- AGENTS.md          the contract: zones, frontmatter, graph rules
     |- .manifest.json     the ingest ledger
     `- .agents/skills/    the skills, version-controlled with the notes
                |
  2. SKILLS      `- symlink (unix) / junction (windows) ->
                      ~/.claude/skills/   (Claude Code)
                      ~/.codex/skills/    (Codex CLI)
                    one set per installed host; the vault stays the source of truth
                |
  3. TRIGGER     Stop hook, per host  -> bin/mark-pending.mjs
                   ~/.claude/settings.json  |  ~/.codex/hooks.json
                                     writes .pending_ingest + one line per turn
                |
  4. RUNNER      scheduler (daily) -> bin/run-ingest.mjs
                 or `wiki-history` by hand    |
                                              `-> the engine host, headless,
                                                  running wiki-history-ingest
                                                  once per installed source
                |
  5. LEDGER      .manifest.json  <- every processed file gets a row
```

Layers 1 and 5 are identical on every platform and every host. Layer 2 differs by platform only in
link type, and now differs by host in which directories get the links. Layer 3 stays
platform-neutral, but it is no longer host-neutral: the hook lives in a different file, under a
different key, per host — which is why one merge routine in `lib/hooks.mjs` installs both. Layer 4
differs by platform only in which scheduler starts it, and by host in which agent it runs headless.

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

The folders sort by shape, not subject. `AGENTS.md` is the authority: change a rule there and every
skill follows it, because every skill reads it at the start of a session. `CLAUDE.md` is a pointer to
it, kept only because Claude Code looks for that name; edit `AGENTS.md`, not the pointer.

`index.md`, `hot.md` and `log.md` are generated. `daily-update` writes the first two between marker
comments; ingest runs append to the third. Editing them by hand is harmless but pointless, because
the next run overwrites.

`_raw/` is excluded from Obsidian's search via `.obsidian/app.json`, and from git via `.gitignore`.
Source files land there and stay there. It exists so a half-distilled PDF doesn't pollute search
results.

## 2. Skills, and how they are linked

The skill definitions live inside the vault at `.agents/skills/`. Claude Code looks only in
`~/.claude/skills/`, and Codex only in `~/.codex/skills/` — neither reads the vault directly — so the
installer creates one link per skill, per installed host, pointing back into the vault.

The vault is therefore the single source of truth, and skills get version-controlled alongside the
notes they operate on. Edit the copy in the vault.

On Windows that link is a junction rather than a symbolic link, because a Windows symlink needs either
administrator rights or Developer Mode while a junction needs neither. On macOS and Linux it is an
ordinary symlink. If linking fails the installer copies instead and says so; the cost of that fallback
is that edits no longer flow both ways.

## 3. The trigger

Claude Code and Codex each fire a `Stop` hook at the end of every turn — Claude's lives in
`~/.claude/settings.json`, Codex's in `~/.codex/hooks.json`, both nested under a root `hooks` key,
which is why one merge routine in `lib/hooks.mjs` installs both. The hook runs `bin/mark-pending.mjs`,
which does two things:

- writes `.pending_ingest`, the flag the runner gates on
- appends one epoch second to `.pending_sessions`, one line per turn

The second file is what makes the run safe to interrupt. The runner counts the lines before it
starts, and afterwards removes only that many. A turn that ends while the ingest is working stays
queued for the next run instead of being silently marked done.

`mark-pending.mjs` swallows all its own errors on purpose. A hook that throws interrupts the user's
session. Losing one marker costs a delayed ingest; a broken hook costs a working session.

## 4. The runner

`bin/run-ingest.mjs` is a wrapper around one headless invocation of the engine host — Claude or
Codex. Nearly all of it is guards.

**The lock.** Creating a directory is atomic, so `fs.mkdirSync` is the test-and-set:
it fails if another run holds it. Two concurrent runs would both write `.manifest.json` and one set of
updates would be lost. A lock older than 180 minutes belongs to a crashed run and is cleared.

**The other-writer check.** Anything else writing the vault at the same time causes the same lost
update. The runner looks for a `.lock` directory anywhere under `_raw/` and exits if it finds one.
Exiting is safe: the pending flag is untouched, so the work stays queued.

**The pending gate.** No flag and no `--force` means exit immediately. This is what lets the scheduled
job run every day at no cost on the days nothing happened.

**The watchdog.** A run that stops making progress for 20 minutes is hung, not thinking. The guard
was added after a run sat on a single model call for 100 minutes. For Claude, progress means a recent
write to any `.jsonl` belonging to this session id, including files written by subagents, so
delegated work counts as activity. Codex has no session id and no transcript to scan, so its watchdog
reads its own `--json` stdout stream instead — see *Porting to another agent* for why that turned out
to be the better signal anyway.

Note the session id is used to *find* the transcript rather than rebuilding the project directory
name from the vault path. Claude Code names those directories by folding path separators into
hyphens, which is lossy: a space in `Obsidian Vault` and a hyphen in a real folder name both come out
as the same character, and the encoding differs between platforms. Searching for the id
cannot be wrong; reconstructing the path can.

**The manifest stamp.** The guard that matters most. After the engine exits zero, the runner checks
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
| Engine ingests only its own history if the prompt loses a source | The vault accrues one agent's history and not the other's, while every run reports success | `CLAUDE.buildArgs` grants one `--add-dir` per source host's sessions directory, not just the engine's own |
| Codex hook installed but never trusted | Weeks later: the vault stopped growing and nothing errored | Installer prints the trust step instead of reporting success |
| Every notification read the log's own placeholder text | Indefinitely — every run's headline said the same generic line, whether or not the ingest worked | `log.md`'s line-format examples have the leading `- ` marker removed, so they can't out-sort a real entry |
| Two writers, one loses its updates | Never, without the check | Lock plus other-writer check |
| Codex-only run's headline looks empty | The notification says "history ingest finished" on a real ingest | `newestLogEntry` builds its pattern from every host's log tag |
| Duplicate manifest rows | Files re-ingested or skipped at random | Upsert by path |
| Turn lost during a run | Never | Pending line arithmetic |
| The engine hangs on a model call | The task still running hours later | 20-minute watchdog |
| Stop hook throws | Immediately, and painfully | Hook swallows its own errors |
| Notification silently not shown | Never, if you trusted the banner | Headline is written to the log before notify() is called |
| Missing frontmatter `summary` | Note absent from the index though the file exists | `daily-update` reports it |
| Orphan note, nothing links to it | You never find the note again | Graph health rules, rule 1 |

## Changing things

| To change | Edit |
|---|---|
| Zones, frontmatter, graph rules | `AGENTS.md` in the vault (`CLAUDE.md` is a pointer to it) |
| The model an ingest uses | `hosts.<id>.model` in `~/.obsidian-wiki/config.json`, or `install.mjs --model` (applies to the engine) |
| Which agent runs the daily ingest | `engine` in `~/.obsidian-wiki/config.json`, or `install.mjs --engine codex` |
| Which agents get a hook and skill links | `install.mjs --host auto\|claude\|codex\|both` |
| Vault location | Re-run `node install.mjs --vault ...` |
| Watchdog or stale-lock timeouts | `--stall-minutes` / `--stale-lock-minutes` on `run-ingest.mjs` |
| Schedule time | `node install.mjs --schedule HH:MM` |
| What the daily run asks the engine to do | the `buildPrompt()` function in `bin/run-ingest.mjs` |

## Porting to another platform

Add a branch to `lib/platform.mjs` for path resolution, notifier and scheduler detection, then a
backend to `lib/schedule.mjs`. Nothing else should need touching: the vault, the skills, the runner's
guards and the ledger are all platform-neutral by construction.

If you find yourself editing a third file to add a platform, that is a sign the abstraction has
leaked, and the fix is to move the platform-specific part into one of those two rather than spread it
further.

## Porting to another agent

One file knows which agent CLI it is talking to: `lib/host.mjs`. Add a descriptor with
a `label`, the executable name (`exe`), the host's home directory, skills directory,
hooks file, sessions directory, the `wiki-history-ingest` source name it maps to, the
log tag its skill writes, an `installHint` (the install command shown when the host
isn't found), a `defaultModel` (or `null` if the host runs fine without one), and a
`buildArgs()` that produces an unattended invocation. Then ship a history-ingest skill
for it, because the router will route to it by name and a missing skill means the daily
run does nothing.

Two things to get right, both learned the hard way on Codex:

**How you tell whether the run is still alive.** Claude Code's `-p` stdout is silent
until the end, so progress can only be read from transcript mtimes, and subagent
transcripts have to count. Codex has no `--session-id` to find a transcript by, so
there is nothing to scan — but `--json` makes stdout an event stream, which is the
better signal anyway: an unrelated interactive session cannot fake it. Pick whichever
signal the host actually gives you and say which in the descriptor's `watchdog` field.

**How tightly the agent is confined, and whether you can say so honestly.** Claude Code
takes a per-command allowlist. Codex has no equivalent: it confines by sandbox, so
`workspace-write` plus `--cd <vault>` is the closest thing, which permits reads the
Claude path forbids. That is a real difference in what the kit promises, so it is
written down here rather than glossed.

If you find yourself editing a second file to add an agent, the abstraction has leaked,
and the fix is to move the agent-specific part into `lib/host.mjs` rather than spread it
further.
