# Obsidian vault kit

A knowledge vault that Claude Code maintains for you. Feed it documents and it writes linked,
filed notes. Use Claude Code normally and it mines your own sessions once a day for anything
worth keeping.

Built for Windows with PowerShell. Needs Obsidian, Node.js and Claude Code.

## Quickstart

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
git clone https://github.com/mustafa4101996ahmed/obsidian-vault-kit $HOME\obsidian-vault-kit
cd $HOME\obsidian-vault-kit
.\install.ps1 -DryRun     # changes nothing, shows everything it would do
.\install.ps1
```

Open a new PowerShell window, then follow [SETUP-GUIDE.md](SETUP-GUIDE.md) from step 4.

## What you get

- **A vault** at `%USERPROFILE%\Documents\Obsidian Vault` with a taxonomy that sorts notes by shape
  rather than subject, and a `CLAUDE.md` that tells Claude how to write into it.
- **Seven skills** for ingesting documents and session history, checking graph health, and querying
  what you've accumulated.
- **A daily ingest** that runs unattended, knows when there's nothing to do, and refuses to report
  success when it changed nothing.
- **An ingest ledger** (`.manifest.json`) so the same file is never read twice by accident.

## Layout

```
install.ps1              one command, idempotent, with a dry-run mode
SETUP-GUIDE.md           the walkthrough: install to first ingest
docs/ARCHITECTURE.md     how the pieces fit, for when something breaks

vault-scaffold/          becomes your vault
  CLAUDE.md              the contract Claude follows when writing notes
  index.md hot.md log.md generated: page index, working set, run history
  mocs/vault-map.md      what belongs in which folder
  .agents/skills/        the seven skills; the vault is their source of truth
  .obsidian/             app config, graph coloured by folder

automation/
  run-ingest.ps1         the daily runner: lock, watchdog, verification
  mark-pending.ps1       Claude Stop-hook target; records ended turns
  profile-block.ps1      wiki-history, wiki-log, pending-work greeting
  claude-stop-hook.json  reference copy of the hook the installer adds
  schedule/              scheduled task registration
```

## Commands

| In PowerShell | |
|---|---|
| `wiki-history` | Ingest session history if any is pending |
| `wiki-history -Force` | Ingest regardless |
| `wiki-log` | Tail today's ingest log |

| In a Claude session, from the vault folder | |
|---|---|
| `/obsidian-wiki-ingest` | Turn a document into linked notes |
| `/wiki-history-ingest claude` | Bulk-ingest new Claude sessions |
| `/wiki-agent` | Query your session history on one topic |
| `/daily-update` | Rebuild the index, check graph health |
| `/memory-bridge` | Compare contributions by AI tool |
| `/graph-colorize` | Extend graph colours to your tags |

## Notes

The installer never overwrites. Existing files are kept, and `settings.json` and your PowerShell
profile are backed up with a timestamp before either is touched. Run it again any time.

Skills are linked with directory junctions, not symlinks, so no administrator rights and no
Developer Mode are needed.

The vault contains no notes to start with. It is a scaffold plus the machinery.
