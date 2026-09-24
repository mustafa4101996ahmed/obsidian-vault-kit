# Obsidian vault kit

A knowledge vault that Claude Code maintains for you. Feed it documents and it writes linked, filed
notes. Use Claude Code normally and it mines your own sessions once a day for anything worth keeping.

Runs on macOS, Linux and Windows. Needs Obsidian, Node 18+, and Claude Code.

## Quickstart

```bash
git clone https://github.com/mustafa4101996ahmed/obsidian-vault-kit ~/obsidian-vault-kit
cd ~/obsidian-vault-kit
node install.mjs --dry-run     # changes nothing, shows everything it would do
node install.mjs
```

Open a new terminal, then follow [SETUP-GUIDE.md](SETUP-GUIDE.md) from step 3.

## What you get

- **A vault** with a taxonomy that sorts notes by shape rather than subject, and a `CLAUDE.md` that
  tells Claude how to write into it.
- **Seven skills** for ingesting documents and session history, checking graph health, and querying
  what you've accumulated.
- **A daily ingest** that runs unattended, knows when there's nothing to do, and refuses to report
  success when it changed nothing.
- **An ingest ledger** (`.manifest.json`) so the same file is never read twice by accident.

One implementation, three platforms. Only `lib/platform.mjs` and `lib/schedule.mjs` know which OS
they're on.

## Layout

```
install.mjs              one command, idempotent, --dry-run and --uninstall
SETUP-GUIDE.md           the walkthrough: install to first ingest
docs/ARCHITECTURE.md     how the pieces fit, for when something breaks

lib/
  platform.mjs           paths, OS detection, capability probes
  vault.mjs              scaffold copy, manifest stamping, skill links
  hooks.mjs              settings.json merge
  shell.mjs              shell startup block
  schedule.mjs           launchd | systemd | cron | Task Scheduler
  notify.mjs             osascript | notify-send | toast | silent
bin/
  run-ingest.mjs         the daily runner: lock, watchdog, verification
  mark-pending.mjs       Stop-hook target; records ended turns

vault-scaffold/          becomes your vault
  CLAUDE.md              the contract Claude follows when writing notes
  index.md hot.md log.md generated: page index, working set, run history
  mocs/vault-map.md      what belongs in which folder
  .agents/skills/        the seven skills; the vault is their source of truth
  .obsidian/             app config, graph coloured by folder
```

## Commands

| In your shell | |
|---|---|
| `wiki-history` | Ingest session history if any is pending |
| `wiki-history --force` | Ingest regardless |
| `wiki-log` | Tail today's ingest log |

| In a Claude session, from the vault folder | |
|---|---|
| `/obsidian-wiki-ingest` | Turn a document into linked notes |
| `/wiki-history-ingest claude` | Bulk-ingest new Claude sessions |
| `/wiki-agent` | Query your session history on one topic |
| `/daily-update` | Rebuild the index, check graph health |
| `/memory-bridge` | Compare contributions by AI tool |
| `/graph-colorize` | Extend graph colours to your tags |

## Platform support

| | Scheduler | Notifications | Skill links | Verified |
|---|---|---|---|---|
| macOS | launchd | `osascript` | symlink | fully executed |
| Linux | systemd user timer, cron fallback | `notify-send` | symlink | logic shared with macOS; scheduler unexecuted |
| Windows | Task Scheduler | BurntToast or balloon | junction | unexecuted |

Windows junctions need no administrator rights and no Developer Mode, unlike symlinks.

## Notes

The installer never overwrites. Existing files are kept, and `settings.json` and your shell startup
file are backed up with a timestamp before either is touched. Run it again any time.

`node install.mjs --uninstall` removes the hook, shell block, schedule and skill links. It never
touches your notes.

The vault ships with no notes. It is a scaffold plus the machinery.
