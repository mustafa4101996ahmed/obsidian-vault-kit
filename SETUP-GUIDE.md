# Setting up your knowledge vault

This gets you an Obsidian vault that Claude Code reads, writes and keeps organised for you, plus the
automation that feeds it. Works on macOS, Linux and Windows. Budget about 30 minutes, most of it
downloads.

The end state: you drop a document into a folder, tell Claude to ingest it, and it comes out as
linked notes filed in the right place. Every Claude Code session you run afterwards gets mined once a
day for anything worth keeping, without you asking.

Commands below are shown for each platform. Pick your row and ignore the rest.

---

## 1. What you need first

**Obsidian** from [obsidian.md](https://obsidian.md). Install it, then close it again. You'll point
it at the vault later.

**Node.js**, the LTS build from [nodejs.org](https://nodejs.org), or your package manager. Node 18 or
newer. Check:

```bash
node --version
```

**Claude Code**, and sign in once so the automation isn't stopped later by a login prompt:

```bash
npm install -g @anthropic-ai/claude-code
claude          # follow the browser login, then type /exit
```

**Git** is optional but recommended, so the vault has a history you can roll back. If you install it,
set your identity once, otherwise the installer can stage but not commit:

```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

### Windows only

Windows blocks local scripts by default. The kit is JavaScript, not PowerShell, so it doesn't need
the execution policy changed. But the shell block the installer adds to your PowerShell profile does:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

Answer `Y`. This applies to your account only and still blocks unsigned scripts from the internet.
Skip it if you don't want `wiki-history` as a shell command; everything else works regardless.

---

## 2. Install the kit

Clone it, then look before you leap. The dry run changes nothing and prints every file it would
touch.

```bash
git clone https://github.com/mustafa4101996ahmed/obsidian-vault-kit ~/obsidian-vault-kit
cd ~/obsidian-vault-kit
node install.mjs --dry-run
```

Read the output. If it looks sane:

```bash
node install.mjs
```

On Windows, swap `~` for `$HOME` in PowerShell; the rest is identical.

You'll get a list of what changed, what was already in place, and any warnings. Deal with the
warnings before moving on. Leave the schedule off for now — you'll turn it on in step 7, once you've
watched an ingest work by hand.

Options worth knowing:

```bash
node install.mjs --vault "/some/other/path"   # put the vault elsewhere
node install.mjs --schedule 19:00             # also turn on the daily ingest
node install.mjs --model opus                 # change the model ingests use
node install.mjs --no-git                     # skip git init
node install.mjs --uninstall                  # remove everything except your notes
```

### What it just did

| Where | What |
|---|---|
| `~/Documents/Obsidian Vault` | The vault: folders, `CLAUDE.md`, empty index, empty ingest ledger |
| `~/.obsidian-wiki/` | The runner, its config, its logs |
| `~/.claude/skills/` | Seven links pointing at the skills inside the vault |
| `~/.claude/settings.json` | One `Stop` hook, so Claude records when a session ends |
| Your shell startup file | `wiki-history`, `wiki-log`, and a greeting showing pending work |

Nothing was overwritten. `settings.json` and your shell startup file were both copied to a
timestamped `.bak-` file before being touched.

**Open a new terminal.** The shell block only loads in a fresh one.

---

## 3. Open the vault in Obsidian

Start Obsidian, choose **Open folder as vault**, and pick the folder the installer named:

| | Path |
|---|---|
| macOS, Linux | `~/Documents/Obsidian Vault` |
| Windows | `C:\Users\<you>\Documents\Obsidian Vault` |

Trust the vault when asked. Then **Settings → Community plugins → Browse** and install these two:

- **Nexus AI Chat Importer** — turns ChatGPT and Claude chat exports into notes. This is how you get
  old conversations in.
- **InfraNodus Graph View** — graph analysis that finds the gaps between clusters of notes. Optional;
  skip it if you'd rather not sign up for anything.

The **Minimal** theme is set in the config but not bundled. Install it under **Settings → Appearance →
Themes → Manage**, or ignore it and use the default.

Open the graph view from the left ribbon. It's nearly empty. That's the point.

---

## 4. How the folders work

`mocs/vault-map.md` inside Obsidian has the full version. The short one:

The folders sort notes by **shape**, not subject. Two notes about the same tool go to different
folders depending on what they answer.

| Folder | Answers |
|---|---|
| `skills/` | "how do I do this" |
| `concepts/` | "why does this behave this way" |
| `entities/` | "what is this thing" |
| `projects/` | "what's happening on this" (it ends) |
| `areas/` | "what's happening on this" (it doesn't end) |
| `synthesis/` | "what do these several things have in common" |
| `mocs/` | "where do I find things about this" |
| `archive/` | "what did I used to think" |
| `_raw/` | source files you haven't distilled yet |

One rule matters more than the rest: **if a note would still be true after the project ended, it
doesn't belong in the project folder.** Put it in `skills/` or `concepts/` and link to it from the
project. Lessons buried in a project folder are lost the day you archive it.

Two connection rules keep the vault navigable, and the tooling checks both:

- Every note needs one link **in**. A note nothing points at is one you'll never find again.
- Every note needs one link **out**. Minimum: a `## See Also` section at the bottom.

You don't police this yourself. The ingest skills apply it and `daily-update` reports what slipped.

---

## 5. Your first document ingest

Worth doing today, because it's the bit that shows you what the vault is for.

Pick a real document: a PDF, a Word file, meeting notes, a long article you saved. Copy it into the
vault's `_raw` folder.

```bash
# macOS, Linux
cp ~/Downloads/whatever.pdf ~/Documents/Obsidian\ Vault/_raw/

# Windows PowerShell
Copy-Item "$HOME\Downloads\whatever.pdf" "$HOME\Documents\Obsidian Vault\_raw\"
```

Start Claude from inside the vault. Running it from the vault folder matters: that's how it picks up
`CLAUDE.md` and the vault's rules.

```bash
cd ~/Documents/Obsidian\ Vault      # Windows: cd "$HOME\Documents\Obsidian Vault"
claude
```

Then ask for the ingest:

```
/obsidian-wiki-ingest

Ingest _raw/whatever.pdf. Work out which zone each piece of knowledge belongs in,
write the pages with proper frontmatter, and wire them into the graph.
```

Watch what it does. It reads the document, decides what's a skill and what's a concept, writes the
notes, adds the `related` links, and records the file in `.manifest.json` so it never re-ingests it
by accident.

Switch to Obsidian and open the graph view. Connected nodes where there were none.

### Then ask it a question

The vault earns its keep when you stop reading notes and start querying them. Same session:

```
What did that document say about <something specific>? Check the vault, not the original.
```

---

## 6. Your first history ingest

The other half mines your own Claude Code sessions. Every time a turn ends, a hook records it. The
ingest reads those transcripts plus the memory files Claude keeps per project, and writes up whatever
is worth keeping.

You need some history first, so use Claude Code normally for a few days. Then:

```bash
wiki-history --force        # Windows PowerShell: wiki-history -Force
```

It runs unattended and takes a while. Watch it in another terminal:

```bash
wiki-log
```

When it finishes you get a notification and a new line in the vault's `log.md`.

`--force` runs it whether or not anything is pending. Without the flag it exits immediately when
there's nothing new, which is what the daily schedule relies on.

### Checking it actually worked

An ingest that reports success while doing nothing is the failure that hides longest, so the runner
checks for it: if `.manifest.json` didn't change, the run is a failure no matter what it printed. You
can check the same three things.

```bash
wiki-log                                                    # a run block for today
ls -l ~/Documents/Obsidian\ Vault/.manifest.json            # mtime moved
wc -l < ~/.obsidian-wiki/.pending_sessions                  # smaller than before
```

---

## 7. Turn on the daily run

Once a manual run has worked:

```bash
cd ~/obsidian-vault-kit
node install.mjs --schedule 19:00
```

The installer picks the right mechanism for your system and tells you which:

| Platform | Mechanism | Catches up after sleep |
|---|---|---|
| macOS | launchd user agent | yes |
| Linux | systemd user timer, `Persistent=true` | yes |
| Linux without systemd | cron entry | no |
| Windows | Task Scheduler | yes |

It runs as you, needs no administrator rights, and does nothing on days when nothing is pending.

```bash
# check it
launchctl list | grep obsidian-wiki                    # macOS
systemctl --user list-timers obsidian-wiki-ingest      # Linux
crontab -l | grep obsidian-wiki                        # Linux fallback
schtasks /Query /TN ObsidianWikiDailyIngest            # Windows

# remove it
node install.mjs --uninstall
```

Also worth running weekly by hand, from inside the vault:

```
/daily-update
```

That rebuilds the index, refreshes `hot.md`, and tells you which notes broke the two connection
rules.

---

## 8. The seven skills

Run these from inside the vault folder, in a Claude session.

| Command | What it does |
|---|---|
| `/obsidian-wiki-ingest` | Turn a document into linked notes |
| `/claude-history-ingest` | Mine your Claude Code sessions and memory files |
| `/wiki-history-ingest claude` | The same, in bulk, for everything new since last time |
| `/wiki-agent` | Ask a question of your session history, then ingest just the answer |
| `/daily-update` | Rebuild the index, refresh `hot.md`, check graph health |
| `/memory-bridge` | Compare what different AI tools contributed |
| `/graph-colorize` | Extend the graph colours to your own tags |

The skill files live in `.agents/skills/` inside the vault; `~/.claude/skills/` holds links pointing
at them. Edit the copy in the vault, so your changes are version-controlled with your notes.

---

## 9. When it breaks

| Symptom | Cause | Fix |
|---|---|---|
| `wiki-history: command not found` | Shell block not loaded | Open a new terminal |
| `No config at ~/.obsidian-wiki/config.json` | Installer hasn't run | `node install.mjs` |
| "running scripts is disabled" (Windows) | ExecutionPolicy | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| Log says "nothing pending" | No sessions since the last ingest | Expected. Use `--force` |
| Log says "another run holds the lock" | A run is in progress | Wait. A lock over 3 hours old is cleared automatically |
| "another vault writer holds ..." | Something else is writing the vault | Expected. Work stays queued for the next run |
| "finished without updating .manifest.json" | The run did nothing | Read the log above that line. Don't re-run blind |
| "the run stalled and was stopped" | Claude hung for 20 minutes | Usually transient. Re-run with `--force` |
| Claude can't see the skills | Links missing or shadowed | Re-run `node install.mjs`, read the skill warnings |
| No notifications | No notifier installed | macOS works out of the box. Linux: install `libnotify`. Windows: `Install-Module BurntToast -Scope CurrentUser` |
| Obsidian shows no notes | Wrong folder opened | Re-open, picking the folder containing `CLAUDE.md` |
| Schedule never fires | No scheduler found | The installer says so. Run `wiki-history` by hand, or install systemd/cron |

Everything a run did is in `~/.obsidian-wiki/logs/<date>.log`. Read it before changing anything. Two
state files sit alongside: `.pending_ingest` (a flag saying work is waiting) and `.pending_sessions`
(one line per turn still to be ingested).

---

## 10. Making it yours

**`CLAUDE.md` in the vault** is the contract Claude follows. Different zones, different frontmatter,
stricter rules — change them there and every skill follows.

**The model.** Ingests default to Sonnet, the right trade for bulk work. Change `model` in
`~/.obsidian-wiki/config.json`, or re-run the installer with `--model`.

**Graph colours.** Notes are coloured by folder out of the box, so the graph reads from day one with
no tagging. Once you have tags you care about, `/graph-colorize` adds groups for them.

**MOC pages.** Add one when a cluster of notes has grown enough to need a hub, not before. A hub with
two links is worse than no hub.

**Commit the vault.** If you installed git, commit after every big ingest. It's the only undo you
have when a run writes something you didn't want.

```bash
cd ~/Documents/Obsidian\ Vault
git add -A && git commit -m "Ingest: <what you fed it>"
```

---

## One-page summary

```bash
# install
git clone https://github.com/mustafa4101996ahmed/obsidian-vault-kit ~/obsidian-vault-kit
cd ~/obsidian-vault-kit
node install.mjs --dry-run      # look first
node install.mjs                # then install
# open a NEW terminal

# open the vault in Obsidian, install the two community plugins

# first ingest
cp ~/Downloads/doc.pdf ~/Documents/Obsidian\ Vault/_raw/
cd ~/Documents/Obsidian\ Vault && claude
#   /obsidian-wiki-ingest  ->  "Ingest _raw/doc.pdf"

# history ingest, then schedule it
wiki-history --force
wiki-log
cd ~/obsidian-vault-kit && node install.mjs --schedule 19:00
```

How it all fits together, for when you need to fix it: `docs/ARCHITECTURE.md`.
