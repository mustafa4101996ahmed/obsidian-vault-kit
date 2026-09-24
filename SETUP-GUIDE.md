# Setting up your knowledge vault

This gets you a working Obsidian vault that Claude Code can read, write and keep organised for you,
plus the automation that feeds it. Budget about 30 minutes. Most of that is downloads.

The end state: you drop a document into a folder, tell Claude to ingest it, and it comes out as
linked notes filed in the right place. Every Claude Code session you run afterwards gets mined for
anything worth keeping, once a day, without you asking.

---

## 1. What you need first

Three installs. Do them in this order.

**Obsidian.** Download from [obsidian.md](https://obsidian.md). Install it, then close it again.
You'll point it at the vault later.

**Node.js.** Download the LTS build from [nodejs.org](https://nodejs.org). The installer handles
everything. Check it worked by opening PowerShell and running:

```powershell
node --version
```

**Claude Code.** In PowerShell:

```powershell
npm install -g @anthropic-ai/claude-code
claude --version
```

Then sign in once, so the automation isn't stopped by a login prompt later:

```powershell
claude
```

Follow the browser login, then type `/exit`.

**Git** is optional but recommended, so your vault has a history you can roll back. Get it from
[git-scm.com](https://git-scm.com). If you install it, set your name once:

```powershell
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

---

## 2. Let PowerShell run scripts

Windows blocks local scripts by default. Allow them for your account only:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

Answer `Y`. This applies to you, not the whole machine, and it still blocks unsigned scripts
downloaded from the internet.

---

## 3. Install the kit

Clone it and look before you leap. The dry run changes nothing and prints every file it would touch:

```powershell
git clone <REPO-URL> $HOME\obsidian-vault-kit
cd $HOME\obsidian-vault-kit
.\install.ps1 -DryRun
```

Read the output. If it looks sane, run it for real:

```powershell
.\install.ps1
```

You'll see a list of what changed, what was already in place, and any warnings. Deal with the
warnings before moving on. Leave the daily schedule off for now; you'll turn it on in step 8, once
you've seen an ingest work by hand.

Want the vault somewhere else? `.\install.ps1 -VaultPath "D:\Vault"`.

### What it just did

| Where | What |
|---|---|
| `%USERPROFILE%\Documents\Obsidian Vault` | The vault: folders, `CLAUDE.md`, an empty index, an empty ingest ledger |
| `%USERPROFILE%\.obsidian-wiki\` | The ingest runner, its config, its logs |
| `%USERPROFILE%\.claude\skills\` | Seven junctions pointing at the skills inside the vault |
| `%USERPROFILE%\.claude\settings.json` | One `Stop` hook, so Claude records when a session ends |
| Your PowerShell profile | `wiki-history`, `wiki-log`, and a greeting showing pending work |

Nothing was overwritten. `settings.json` and your profile were backed up first, with the timestamp in
the filename.

**Close PowerShell and open a new window.** The profile block only loads in a fresh shell.

---

## 4. Open the vault in Obsidian

Start Obsidian, choose **Open folder as vault**, and pick:

```
C:\Users\<you>\Documents\Obsidian Vault
```

Trust the vault when it asks. Then install the two plugins: **Settings → Community plugins →
Browse**, search for and install each, then enable it.

- **Nexus AI Chat Importer.** Turns ChatGPT and Claude chat exports into notes. This is how you get
  old conversations in.
- **InfraNodus Graph View.** Graph analysis that finds the gaps between clusters of your notes.
  Optional; skip it if you'd rather not sign up for anything.

The **Minimal** theme is set in the config but not bundled. Install it under **Settings → Appearance
→ Themes → Manage**, or ignore it and use the default.

Open the graph view (the icon in the left ribbon). It's nearly empty. That's the point: you're about
to fill it.

---

## 5. How the folders work

Read `mocs/vault-map.md` inside Obsidian for the full version. The short version:

The folders sort notes by **shape**, not by subject. Two notes about the same tool go to different
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

- Every note needs at least one link **in**. A note nothing points at is one you'll never find again.
- Every note needs at least one link **out**. Minimum: a `## See Also` section at the bottom.

You don't have to police this yourself. The ingest skills apply it, and `daily-update` reports
anything that slipped through.

---

## 6. Your first document ingest

This is the part worth doing today, because it's the bit that shows you what the vault is for.

Pick a real document. A PDF, a Word file, a pile of meeting notes, a long article you saved. Copy it
into the vault's `_raw` folder:

```powershell
Copy-Item "$HOME\Downloads\whatever.pdf" "$HOME\Documents\Obsidian Vault\_raw\"
```

Then start Claude from inside the vault. Running it from the vault folder matters: that's how it
picks up `CLAUDE.md` and the vault's rules.

```powershell
cd "$HOME\Documents\Obsidian Vault"
claude
```

Now ask for the ingest:

```
/obsidian-wiki-ingest

Ingest _raw/whatever.pdf. Work out which zone each piece of knowledge belongs in,
write the pages with proper frontmatter, and wire them into the graph.
```

Watch what it does. It will read the document, decide what's a skill and what's a concept, write the
notes, add the `related` links, and record the file in `.manifest.json` so it never re-ingests it by
accident.

Switch to Obsidian and open the graph view. You now have connected nodes where there were none.

### Then ask it a question

The vault earns its keep when you stop reading notes and start querying them. In the same session:

```
What did that document say about <something specific>? Check the vault, not the original.
```

---

## 7. Your first history ingest

The other half mines your own Claude Code sessions. Every time you finish a turn, a hook records it.
The ingest reads those transcripts and the memory files Claude keeps per project, then writes up
anything worth keeping.

You need some history first. Use Claude Code normally for a few days. Then:

```powershell
wiki-history -Force
```

It runs unattended and takes a while, so leave it. Watch what it's doing in another window:

```powershell
wiki-log
```

When it finishes you'll get a notification and a new line in the vault's `log.md`.

`-Force` runs it whether or not anything is pending. Without the flag it exits straight away when
there's nothing new, which is what the daily schedule relies on.

### Checking it actually worked

An ingest that reports success while doing nothing is the failure that hides longest, so the runner
checks for it: if `.manifest.json` didn't change, the run is treated as failed no matter what it
printed. You can check the same three things yourself.

```powershell
wiki-log                                                        # a run block for today
(Get-Item "$HOME\Documents\Obsidian Vault\.manifest.json").LastWriteTime   # moved
(Get-Content "$HOME\.obsidian-wiki\.pending_sessions").Count    # smaller than before
```

---

## 8. Turn on the daily run

Once a manual run has worked, schedule it:

```powershell
cd $HOME\obsidian-vault-kit
.\install.ps1 -EnableSchedule -ScheduleTime 19:00
```

It runs daily at the time you pick, catches up if the machine was asleep, and does nothing when
there's nothing pending. It only runs while you're logged in, so no admin rights are needed.

```powershell
Get-ScheduledTask -TaskName ObsidianWikiDailyIngest | Get-ScheduledTaskInfo   # last and next run
Start-ScheduledTask -TaskName ObsidianWikiDailyIngest                         # run it now
.\install.ps1 -EnableSchedule:$false                                          # (leaves it as-is)
& "$HOME\.obsidian-wiki\Register-IngestTask.ps1" -Unregister                  # remove it
```

Worth also running weekly, by hand, from inside the vault:

```
/daily-update
```

That one rebuilds the index, refreshes `hot.md`, and tells you which notes have broken the two
connection rules.

---

## 9. The seven skills

Run these from inside the vault folder, in a Claude session.

| Command | What it does |
|---|---|
| `/obsidian-wiki-ingest` | Turn a document into linked notes |
| `/claude-history-ingest` | Mine your Claude Code sessions and memory files |
| `/wiki-history-ingest claude` | The same, in bulk, for everything new since last time |
| `/wiki-agent` | Ask a question of your session history, then ingest just the answer |
| `/daily-update` | Rebuild the index, refresh `hot.md`, check graph health |
| `/memory-bridge` | Compare what different AI tools contributed to the vault |
| `/graph-colorize` | Extend the graph colours to your own tags |

The skill files live in `.agents\skills\` inside the vault, and `%USERPROFILE%\.claude\skills\` holds
junctions pointing at them. Edit the copy in the vault. That way your changes are version-controlled
along with your notes.

---

## 10. When it breaks

| Symptom | Cause | Fix |
|---|---|---|
| `wiki-history` not recognised | Profile block not loaded | Open a new PowerShell window |
| "running scripts is disabled" | ExecutionPolicy | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| "No config at ...\config.json" | Installer hasn't run | Run `.\install.ps1` |
| Log says "nothing pending" | No sessions since the last ingest | Expected. Use `-Force` to override |
| Log says "another run holds the lock" | A run is in progress | Wait. A lock over 3 hours old is cleared automatically |
| "finished without updating .manifest.json" | The run did nothing | Read the log above that line. Don't re-run blind |
| "the run stalled and was stopped" | Claude hung for 20 minutes | Usually transient. Re-run with `-Force` |
| Claude can't see the skills | Junctions missing or shadowed | Re-run `.\install.ps1`, read the skill warnings |
| No notifications | No notifier installed | Optional: `Install-Module BurntToast -Scope CurrentUser` |
| Obsidian shows no notes | Wrong folder opened | Re-open, picking the folder that contains `CLAUDE.md` |

Everything a run did is in `%USERPROFILE%\.obsidian-wiki\logs\<date>.log`. Read it before changing
anything. Two useful state files sit next to it: `.pending_ingest` (a flag saying work is waiting)
and `.pending_sessions` (one line per session turn still to be ingested).

---

## 11. Making it yours

The kit is a starting point, not a finished system. The things worth changing early:

**`CLAUDE.md` in the vault.** This is the contract Claude follows. If you want different zones,
different frontmatter, or stricter rules, change them here and every skill follows.

**The model.** Ingests default to Sonnet, which is the right trade for bulk work. To change it, edit
`model` in `%USERPROFILE%\.obsidian-wiki\config.json`.

**Graph colours.** Notes are coloured by folder out of the box, so the graph is readable from day
one with no tagging. Once you have tags you care about, `/graph-colorize` will add groups for them.

**MOC pages.** Add one when a cluster of notes has grown enough to need a hub, not before. A hub with
two links on it is worse than no hub.

**Commit the vault.** If you installed git, commit after every big ingest. It's the only undo you
have when a run writes something you didn't want.

```powershell
cd "$HOME\Documents\Obsidian Vault"
git add -A
git commit -m "Ingest: <what you fed it>"
```

---

## One-page summary

```powershell
# install
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
git clone <REPO-URL> $HOME\obsidian-vault-kit
cd $HOME\obsidian-vault-kit
.\install.ps1 -DryRun        # look first
.\install.ps1                # then install
# open a NEW PowerShell window

# open the vault in Obsidian, install the two plugins

# first ingest
Copy-Item "$HOME\Downloads\doc.pdf" "$HOME\Documents\Obsidian Vault\_raw\"
cd "$HOME\Documents\Obsidian Vault"
claude
#   /obsidian-wiki-ingest  ->  "Ingest _raw/doc.pdf"

# history ingest, then schedule it
wiki-history -Force
wiki-log
cd $HOME\obsidian-vault-kit; .\install.ps1 -EnableSchedule
```

How it all fits together, for when you need to fix it: `docs/ARCHITECTURE.md`.
