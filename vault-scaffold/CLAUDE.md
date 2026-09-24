# Claude Instructions — Obsidian Vault

This file is the contract between you and this vault. Read it before writing anything here.

## On Session Start

Read [[index]] first — it is the central map of this vault. Also check [[hot]] for recently active
pages and [[log]] for ingestion history.

On a brand-new vault all three are near-empty. That is expected: they are generated, not authored.
They fill up as ingests run.

## Vault Structure

```
/
  CLAUDE.md                        ← this file
  index.md                         ← start here; full page index
  hot.md                           ← recently active pages
  log.md                           ← ingestion log
  skills/                          ← reusable how-to knowledge (general, cross-project)
  concepts/                        ← abstract ideas, patterns, gotchas
  entities/                        ← tools, libraries, products
  projects/                        ← active time-bound project work
  areas/                           ← ongoing responsibilities (no end date)
  synthesis/                       ← cross-cutting insights
  mocs/                            ← Map of Content navigation hubs (links only, no content)
  archive/                         ← retired work, superseded knowledge
  _raw/                            ← unprocessed source captures; excluded from Obsidian search
  .agents/skills/                  ← skill definitions (source of truth)
  .manifest.json                   ← ingest ledger; what has been read and when
```

`.claude/skills/` in your home directory holds junctions pointing back at `.agents/skills/` here.
The vault is the source of truth; edit a skill here, not there.

### Choosing a zone

The zone is decided by the shape of the knowledge, not the topic:

| If the page answers… | Zone |
|---|---|
| "how do I do X" | `skills/` |
| "why does X behave that way" | `concepts/` |
| "what is X" (a tool, library, product, company) | `entities/` |
| "what is happening on X" (has an end date) | `projects/` |
| "what is happening on X" (has no end date) | `areas/` |
| "what do these several things have in common" | `synthesis/` |
| "where do I find things about X" | `mocs/` |

When a page fits two zones, prefer the more durable one. Projects end; concepts and skills outlive
them. A lesson learned on one project belongs in `skills/` or `concepts/`, with the project page
linking to it — not buried inside the project.

## Claude Code Skills

Invoke with the `Skill` tool.

| Skill | Purpose |
|---|---|
| `claude-history-ingest` | Mine Claude Code session history and memory files into wiki pages |
| `obsidian-wiki-ingest` | Ingest documents (PDFs, notes, exports) into the vault |
| `wiki-agent` | Query, and targeted-ingest from, an agent's history on one topic |
| `wiki-history-ingest` | Router: bulk-ingest new sessions from a named agent's history |
| `daily-update` | Daily maintenance: freshness check, index rebuild, `hot.md`, graph health |
| `memory-bridge` | Browse and compare knowledge by which AI tool produced it |
| `graph-colorize` | Tag-driven colour groups for the Obsidian graph view |

## Knowledge Pages

This section is a generated index of what the vault actually holds, grouped by zone, one line per
page with its summary. It starts empty.

**Do not write it by hand.** `daily-update` regenerates it from the frontmatter `summary` field of
every page. If a page is missing from it, the page is missing a `summary`, or `daily-update` has not
run since it was added.

<!-- BEGIN GENERATED INDEX -->
<!-- daily-update writes here. Nothing above or below this marker pair is touched. -->
<!-- END GENERATED INDEX -->

## Working in This Vault

- Never delete pages — set `lifecycle: archived` in frontmatter instead
- When adding pages, update [[index]] and run `daily-update` if appropriate
- Standard frontmatter fields: `title`, `summary`, `type`, `lifecycle`, `tags`, `related`, `updated`
- Cross-link using Obsidian wikilink syntax: `[[page-name]]`
- One topic per file. If a section deserves its own link, it deserves its own file.

---

## Frontmatter Standard

Every knowledge page uses:

```yaml
---
title: Page Title
summary: One-sentence description (used in index + MOC pages)
type: skill | concept | project-hub | project-sub | deliverable | synthesis | area | moc | entity
lifecycle: active | stable | archived
tags: [tag1, tag2]
related:
  - "[[path/to/related]]"
updated: YYYY-MM-DD
---
```

`summary` is load-bearing: it is what appears in `index.md` and on MOC pages. A page without one is
invisible to navigation even though the file exists.

**Do not use:** `base_confidence`, `provenance`, `lifecycle_changed`, `source` — these are pipeline
artifacts; `log.md` is the right place for them.

**Permitted exception:** `sources:` (plural) is allowed on ingest/archive pages to hold a list of
`claude://` session IDs or similar provenance links — it is a distinct field from the banned
singular `source`.

---

## File Length Guidelines

| Type | Target lines | Rule |
|---|---|---|
| Skill / concept | 100–250 | One topic per file. If a section warrants its own link, give it its own file. |
| Project hub | 100–200 | Links out; holds no detail itself |
| Project sub-page | 150–350 | One aspect of a project |
| MOC page | 30–100 | Navigation only — links + one-liners |
| Synthesis | 150–400 | Cross-cutting insights |
| Deliverable | Uncapped | Archive, not navigated |
| Changelog | Split at ~300 | Archive past entries when file exceeds 300 lines |

---

## Archiving Policy

- Set `lifecycle: archived` in frontmatter
- Move file to `archive/<original-path>/`
- Update inbound wikilinks to point to the archive path
- Never delete pages — always archive

Archiving is reversible and keeps the graph intact. Deleting breaks every inbound link silently.

---

## Graph Health Rules

Every knowledge page must satisfy these three connection rules. Run the connectivity check in
`daily-update` to verify.

These are the rules that decide whether this vault becomes a knowledge graph or a folder of
disconnected files. A page nothing links to is a page you will never find again.

### Rule 1 — No orphans
Every page must have at least one inbound wikilink from another wiki page (excluding `index.md`,
`hot.md`, `log.md`, `CLAUDE.md`). The responsibility falls on whoever creates a page to wire it in
from its parent hub or relevant MOC.

### Rule 2 — No dead-ends
Every page must have at least one outbound `[[wikilink]]` to another wiki page. Minimum: a
`## See Also` section at the bottom. Deliverables (uncapped files in `projects/*/deliverables/`) are
exempt if they link back to their hub via the `> Part of:` callout.

### Rule 3 — MOC backlink
Every skill, concept, synthesis, and area page should link to its relevant MOC in `## See Also`.
This is the primary mechanism that keeps MOC pages connected to their spokes.

### Checklist when adding a new page
1. Add a `> **Part of:** [[hub-page|Hub Name]]` callout below the H1 (sub-pages only)
2. Add `## See Also` at the bottom — include the relevant MOC and at least one peer page
3. Link to the new page from its parent hub (project hub's sub-page list, or MOC)
4. Update `index.md`

---

## Ingest Ground Rules

These bind every ingest skill. Breaking one corrupts the vault quietly rather than loudly.

1. **`.manifest.json` is the only record of what has been read.** Every file processed gets a row,
   including files that produced no page — with a `note` saying why. A file with no row is read
   again on every future run, forever.
2. **Upsert manifest rows by `source_path`. Never blind-append.** Two rows for one path means the
   file reports fresh or stale depending on read order.
3. **Never write into `archive/`** during an ingest. Reference archived pages when linking; do not
   add to them.
4. **Never write knowledge into `mocs/`.** MOC pages hold links and one-line descriptions only.
5. **Never write into `_raw/`** except to deposit an unprocessed capture. It is excluded from
   Obsidian search by design.
6. **One writer at a time.** Two ingests running together will both write `.manifest.json` and one
   set of updates will be lost. The lock file in `.obsidian-wiki/` enforces this for scheduled runs;
   respect it for manual ones.
