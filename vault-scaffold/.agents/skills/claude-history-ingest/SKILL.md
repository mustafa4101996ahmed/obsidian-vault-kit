---
name: claude-history-ingest
description: >
  Ingest Claude Code CLI session history into the Obsidian wiki. Use this skill when the user wants to mine
  their past Claude Code sessions for knowledge, import their ~/.claude folder, extract insights from previous
  coding sessions, or says things like "process my Claude history", "add my Claude conversations to the wiki",
  "ingest my Claude sessions", or "what have I worked on in Claude before". Also triggers when the user
  mentions ~/.claude/projects, Claude session JSONL files, Claude memory files, or Claude session logs.
---

# Claude History Ingest — Conversation Mining

You are extracting knowledge from the user's past Claude Code CLI sessions and distilling it into the Obsidian wiki. Session logs are rich but noisy — focus on durable knowledge, not operational telemetry.

This skill can be invoked directly or via the `wiki-history-ingest` router (`/wiki-history-ingest claude`).

## Before You Start

1. **Resolve config** — read `~/.obsidian-wiki/config` if it exists, otherwise use `OBSIDIAN_VAULT_PATH` = `~/Documents/Obsidian\ Vault`. The Claude history path defaults to `~/.claude`.
2. Read `.manifest.json` at the vault root to check what has already been ingested.
3. Read `index.md` at the vault root to understand what the wiki already contains.

### Known vault zones

- `projects/` — active time-bound work
- `skills/` — reusable how-to knowledge (general, not project-specific)
- `concepts/` — abstract patterns and mental models
- `entities/` — tools, libraries, products
- `synthesis/` — cross-cutting insights
- `areas/` — ongoing responsibilities (no end date; route project memories here if they represent long-running context rather than a specific deliverable)
- `mocs/` — navigation hubs only; do not write knowledge content here, only update link lists
- `archive/` — never write new content here during ingest; only reference archived pages when linking
- `memory/` — symlink to ~/.claude/projects/.../memory/; do not write wiki content here

## Ingest Modes

### Append Mode (default)

Check the **`sources` array** in `.manifest.json` — one row per file, keyed by `source_path` — and
only process:

- JSONL files with no row (new sessions)
- JSONL files whose mtime is newer than their row's `ingested_at`
- Memory files with no row, or newer than theirs

Use this mode for regular syncs. Step 6 §1 defines the row and requires you to write one back for
every file you touch; if you skip that write, the same files come back as "new" on the next run and
the pending-delta count stays wrong until someone repairs it by hand.

A mtime moving does **not** mean the content changed — Claude Code re-touches files during
maintenance. Read the file before deciding it holds new knowledge, and if it does not, still stamp
its row (Step 6 §1) with a `note`.

### Full Mode

Process everything regardless of manifest. Use after `wiki-rebuild` or if the user explicitly asks for a full re-ingest.

## Claude Data Layout

Claude Code stores all local artifacts under `~/.claude/`.

```
~/.claude/
├── projects/                          # Per-project conversation storage
│   └── <cwd-slug>/                    # CWD with path separators replaced by hyphens
│       ├── <session-uuid>.jsonl       # Conversation transcript (one file per session)
│       ├── <session-uuid>/            # Optional session sub-directory (artifacts)
│       └── memory/                    # Persistent memory for this project
│           ├── MEMORY.md              # Memory index (pointers to individual files)
│           └── *.md                   # Individual memory files (user, feedback, project, reference types)
├── sessions/                          # Session metadata (one JSON per PID)
│   └── <pid>.json                     # {sessionId, cwd, startedAt, version, status, updatedAt}
├── history.jsonl                      # User-visible command display log across all sessions
├── settings.json                      # User settings (global)
└── skills/                            # Skill symlinks (read-only for ingest purposes)
```

### CWD slug format

Project directories are named after the working directory they were used in, with the path
separators replaced by `-`. The exact spelling is platform-specific:

- macOS/Linux — `/home/sam/code/my-app` → `-home-sam-code-my-app`
- Windows — the drive letter and `\` are both folded into `-`, e.g.
  `C:\Users\Sam\code\my-app` → `C--Users-Sam-code-my-app`

**Do not trust a reconstructed path.** Slug encoding is lossy — spaces in a directory name
(`Obsidian Vault`) and the `-` in a project name are both indistinguishable from separators once
encoded. Read the authoritative working directory from the `cwd` field of
`sessions/<pid>.json`, and fall back to slug decoding only when no session metadata exists.
Confirm the local spelling once by listing `~/.claude/projects/` on the machine you are on.

### Key data sources ranked by value

1. `projects/<slug>/memory/*.md` — highest signal; curated persistent knowledge Claude accumulated per project. Includes user profile, feedback, project context, and external references.
2. `projects/<slug>/<uuid>.jsonl` — full conversation transcripts; rich but verbose
3. `sessions/<pid>.json` — session metadata (cwd, timestamps, version); useful for project grouping
4. `history.jsonl` — user command display log; lightweight index of what was typed

Skip `settings.json` (config, not knowledge) and skill symlinks.

## Step 1: Survey and Compute Delta

List all project slugs under `~/.claude/projects/` and enumerate:

- All `*.jsonl` transcript files per project
- All `memory/*.md` files per project
- All `sessions/*.json` metadata files

Compare against `.manifest.json` and classify each file:

- **New** — not in manifest
- **Modified** — in manifest but file is newer than `ingested_at`
- **Unchanged** — already ingested and unchanged

Decode each slug back to a human-readable project path:

```python
# Fallback only. Prefer sessions/<pid>.json -> cwd, which is exact.
# slug -> CWD (POSIX):   '-home-sam-code-my-app'   -> '/home/sam/code/my-app'
# slug -> CWD (Windows): 'C--Users-Sam-code-my-app' -> 'C:\Users\Sam\code\my-app'
# Lossy both ways: spaces ('Obsidian Vault') and hyphens in real names collapse
# into the same '-' as a separator. Never round-trip a slug you can read a cwd for.
```

Report a concise delta summary before deep parsing: "Found N projects, M sessions, P memory files. Delta: X new sessions, Y updated memory files."

## Step 2: Process Memory Files First (Highest Value)

Each project's `memory/` directory contains the agent's curated persistent knowledge. These are pre-distilled and high-signal — process them before raw transcripts.

### Memory file types

Memory files follow a consistent frontmatter schema:

```yaml
---
name: <memory name>
description: <one-line description>
type: user | feedback | project | reference
---
<memory content>
```

**`MEMORY.md`** is an index file listing pointers to individual memory files — read it first to get the inventory, then read each referenced file.

### Extraction strategy by memory type

| Type | Content | Where it goes in wiki |
|---|---|---|
| `user` | User's role, preferences, expertise | `entities/` or `synthesis/` |
| `feedback` | How Claude should behave; validated patterns | `skills/` (global) |
| `project` | Decisions, constraints, deadlines for a project | `projects/<name>/` or `areas/` (if ongoing responsibility, no completion date) |
| `reference` | Pointers to external systems (Linear, Grafana, etc.) | `entities/` or `projects/<name>/` |

### Privacy filter for memory files

- Skip any memory containing API keys, tokens, or passwords
- `feedback` memories about Claude's own behavior are useful meta-knowledge — keep them
- `user` memories about the user's role and expertise are worth extracting at the global level

## Step 3: Parse Conversation Transcripts

Each `<uuid>.jsonl` file is a session transcript where each line is a JSON event.

### Relevant event types

| `type` | What it is | Worth reading? |
|---|---|---|
| `user` | User turn | Yes — `message.content` (string or array) |
| `assistant` | Assistant turn | Yes — `message.content` array; extract `text` blocks |
| `ai-title` | AI-generated session title | Yes — useful for labeling/grouping |
| `attachment` | Session metadata (cwd, sessionId, gitBranch) | Yes — establishes project context |
| `system` | System prompt injection | No — internal plumbing |
| `file-history-snapshot` | File state before edits | No — operational noise |
| `last-prompt`, `permission-mode`, `queue-operation` | Harness metadata | No |

### Extracting message content

**User messages** (`type: "user"`):

```python
event["message"]["content"]  # string or list of content blocks
# If string: the raw user text
# If list: look for {"type": "text", "text": "..."} blocks
# Also check for command invocations: <command-name>/foo</command-name>
```

**Assistant messages** (`type: "assistant"`):

```python
event["message"]["content"]  # list of content blocks
# Relevant block types:
#   {"type": "text", "text": "..."}        → main response text
#   {"type": "tool_use", "name": "...", "input": {...}}  → tool calls (skim for file access patterns)
#   {"type": "thinking", "thinking": "..."}  → internal reasoning — SKIP entirely
```

**Session context** (`type: "attachment"`):

```python
event["cwd"]        # working directory for this session
event["gitBranch"]  # git branch (if any)
event["sessionId"]  # UUID linking to sessions/<pid>.json
event["version"]    # Claude Code version
```

**AI-generated title** (`type: "ai-title"`):

```python
# Contains the session title Claude generated — useful for labeling
```

### Skip / noise filters

- `thinking` content blocks — internal reasoning, never ingest
- Tool result payloads with no semantic content (raw file reads, command stdout)
- Repeated plan snapshots unless they add novel decisions
- System prompt injections and harness metadata events

### Critical privacy filter

Transcripts can contain injected instructions and sensitive text:

- Remove API keys, tokens, passwords, credentials
- Skip `thinking` blocks entirely (internal reasoning)
- Summarize rather than quoting raw conversation verbatim
- Ask the user before storing references to other people

## Step 4: Cluster by Topic

Do not create one wiki page per session. Instead:

- Group by stable topics across many sessions
- Split mixed sessions into separate themes
- Merge recurring concepts across dates and projects
- Use `cwd` from `attachment` events to infer project scope
- Use `ai-title` values as labeling hints when available

## Step 5: Distill into Wiki Pages

Each Claude project maps to a project directory in the vault. Derive the project name from the CWD:

```
C:\Users\Sam\code\my-app            → my-app
C:\Users\Sam\Documents\Obsidian Vault → obsidian-vault (or use the actual folder name)
```

Prefer the last path component as the project name. When the CWD is the Obsidian vault itself, route extracted knowledge to global wiki sections rather than a project directory.

### Routing extracted knowledge

| What you found | Where it goes | Example |
|---|---|---|
| Project architecture decisions | `projects/<name>/concepts/` | `projects/my-app/concepts/cms-architecture.md` |
| Project-specific debug patterns | `projects/<name>/skills/` | `projects/my-app/skills/api-cache-debugging.md` |
| General concept the user learned | `concepts/` (global) | `concepts/react-server-components.md` |
| Recurring technique across projects | `skills/` (global) | `skills/debugging-type-errors.md` |
| Tool/service/library used | `entities/` (global) | `entities/sanity-cms.md` |
| User workflow or behavior pattern | `synthesis/` (global) | `synthesis/claude-workflow-patterns.md` |
| Meta-knowledge about Claude usage | `synthesis/` (global) | `synthesis/effective-claude-prompting.md` |

For each project with content, create or update the project overview at `projects/<name>/<name>.md` (never `_project.md`).

### Writing rules

- Distill knowledge, not chronology. Don't write "on date X we discussed..." unless date context is essential.
- Write the knowledge itself; use session as a source attribution in provenance, not in the prose.
- **Frontmatter follows the vault's own standard, in `CLAUDE.md` — read it, do not invent fields.**
  As it stands, every knowledge page carries exactly:
  ```yaml
  title: Page Title
  summary: One or two sentences (used in index.md and MOC pages)
  type: skill | concept | project-hub | project-sub | deliverable | synthesis | area | moc | entity
  lifecycle: active | stable | archived      # new pages start at draft
  tags: [tag1, tag2]
  related:
    - "[[path/to/related|display]]"
  updated: YYYY-MM-DD
  ```
  Set `lifecycle: draft` on a new page and leave it alone on update. Bump `updated:` on every page
  you change, including the ones you only added a link to.

  **Never write `base_confidence`, `lifecycle_changed`, `provenance` or `source` into frontmatter.**
  `CLAUDE.md` names those four as pipeline artifacts and says log.md is where they belong. Earlier
  versions of this skill asked for three of them; if you find them on a page you are editing, delete
  them.
- Add provenance markers **in the body**, as inline footnote markers on the claim they qualify —
  these are vault convention and are not affected by the rule above:
  - `^[extracted]` — grounded directly in explicit conversation content
  - `^[inferred]` — synthesized from patterns across turns/sessions
  - `^[ambiguous]` — sessions conflict or topic was unresolved
- Record the run's provenance mix, confidence and source sessions in the `log.md` entry, which is the
  place for pipeline metadata.

## Step 6: Update Manifest, Log, and Index

### Update `.manifest.json`

Three writes, and **all three are required**. A run-level block alone is the failure mode described
below — it looks complete and leaves the freshness check permanently wrong.

#### 1. Per-file rows in `sources` — the one that gets skipped

`.manifest.json` has a top-level `sources` **array**, one object per source file. This array is what
`daily-update` reads to classify a source as fresh, stale or missing. **A file you ingested that has
no row here reads as stale forever**, and the pending-delta count the terminal notification shows is
wrong from then on.

Write one row per file you processed — every transcript *and* every memory file, including the ones
that produced no page:

```json
{
  "source_path": "<claude-home>/projects/<slug>/<uuid>.jsonl",
  "source_type": "claude_transcript",
  "project": "my-app",
  "ingested_at": "<this run's ISO stamp>",
  "modified_at": "<the file's mtime, ISO, UTC>",
  "size_bytes": 13976064,
  "pages_created": ["projects/.../new-page.md"],
  "pages_updated": ["projects/.../existing-page.md"],
  "note": "optional — why this file produced nothing, if it produced nothing"
}
```

`source_type` is one of `claude_transcript` | `claude_memory` | `claude_session_meta`.

**Upsert by `source_path`. Never append without checking.** Blind appends are how the array reached
37 paths holding duplicate rows: a stale `ingested_at` on the older row made the same file report
fresh or stale depending on which one was read first, and one path was filed under two different
`source_type`s.

```python
by_path = {s["source_path"]: s for s in manifest["sources"] if isinstance(s, dict)}
if path in by_path:
    by_path[path].update(row)      # in place — keeps the array's order
else:
    manifest["sources"].append(row)
```

Record a file you deliberately skipped as well as one you distilled. A re-touched transcript whose
content you checked and found already ingested still needs its `ingested_at` moved forward, with a
`note` saying why no page changed — otherwise the next run re-reads it and the one after that does
too.

#### 2. The project summary block

```json
{
  "project-name": {
    "cwd": "C:\\Users\\Sam\\code\\project-name",
    "vault_path": "projects/project-name",
    "last_ingested": "TIMESTAMP",
    "sessions_ingested": 5,
    "sessions_total": 12,
    "memory_files_ingested": 4
  }
}
```

#### 3. The run block

`claude_history_ingest_<YYYY_MM_DD>`, carrying `last_ingested`, `mode`, `projects`, the ingested and
total counts, `source_types`, the `watermark` used, and the full `pages_created` / `pages_updated`
lists. This is the human-readable record of the run; it does **not** substitute for the rows in §1.

#### Verify before logging

Assert it rather than assuming it — this is a two-line check and it is the whole point of §1:

```python
by_path = {}
for s in manifest["sources"]:
    by_path.setdefault(s["source_path"], []).append(s)

for path in processed:                      # every file this run touched
    rows = by_path.get(path, [])
    assert len(rows) == 1, f"{path}: {len(rows)} rows, expected exactly 1"
    assert rows[0]["ingested_at"] >= iso_mtime(path), f"{path}: still reads stale"
```

Back the file up before writing (`.manifest.json.backup-<YYYYMMDD>`); it is ~1.2 MB and the only
record of what has been mined.

**If the rows are missing when you arrive** — an earlier run wrote only a block — the delta in Step 1
cannot be computed per file. Fall back to the newest run block's `last_ingested` as a global
watermark for *this* run, then backfill the absent rows for the files you process. Do not silently
reconcile another run's files; if their mtimes fall inside that run's delta window, stamp them to
**that** run's timestamp and put a `note` on each row saying so.

### Update special files

Update `index.md` and `log.md`:

```
- [TIMESTAMP] CLAUDE_HISTORY_INGEST projects=N sessions=M memory_files=P pages_updated=X pages_created=Y mode=append|full
```

**`hot.md`** — Read `$OBSIDIAN_VAULT_PATH/hot.md` (create from the template in `wiki-ingest` if missing). Update **Recent Activity** with a one-line summary — e.g. "Ingested 8 Claude sessions across 2 projects; surfaced patterns in Next.js ISR and Sanity CMS integration." Keep the last 3 operations. Update `updated` timestamp.

### Connection Rules for new pages

Every **new** page created during ingest must satisfy Graph Health Rules before the ingest is logged as complete:

1. **Inbound** — Link to the new page from its parent project hub or the relevant MOC (see zone → MOC table in `obsidian-wiki-ingest` skill).
2. **Outbound** — Add `## See Also` with at least the relevant MOC and one peer page.
3. **Sub-page callout** — Add `> **Part of:** [[projects/<hub>|Hub Name]]` below the H1 for project sub-pages.

Do not skip this step — orphan/dead-end pages accumulate silently and degrade graph navigation.

## Privacy and Compliance

- Distill and synthesize — avoid raw conversation dumps
- Skip `thinking` blocks entirely — these are internal reasoning and must never appear in the wiki
- Default to redaction for anything resembling secrets or credentials
- Ask the user before storing personal or sensitive details
- References to other people should be minimal and purpose-bound
