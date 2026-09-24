---
name: obsidian-wiki-ingest
description: >
  Automates ingestion of documents into the Obsidian wiki (obsidian-wiki) using the wiki-ingest pipeline. Handles deduplication via manifest, frontmatter, and cross-links; triggers on user request within the obsidian-wiki project context.
---

# Obsidian Wiki Ingest — Automation Skill

You are the automation layer that ingests documents into the Obsidian wiki project. This skill orchestrates the ingestion workflow, ensuring deduplication, proper frontmatter, and cross-linking with existing pages.

## Trigger
- User says: "ingest to wiki", "add to wiki", or any phrasing that targets the obsidian-wiki repository.
- Context: the working directory is the Obsidian vault itself (the folder holding `CLAUDE.md`,
  `index.md` and `.manifest.json`). If it is not, stop and say so rather than writing pages into
  an unrelated repository.

## Responsibilities
- Validate target vault path from the environment and manifest state.
- Decide between Append, Full, or Raw ingest modes based on user input or changes in the source.
- Invoke the wiki-ingest workflow to process new/modified sources.
- Update manifest and log files with ingest metadata.
- Create or update project overview pages and cross-links as needed.

## Inputs
- Source documents (Markdown, PDFs, text, images) from OBSIDIAN_SOURCES_DIR or _raw/
- Vault path from OBSIDIAN_VAULT_PATH
- Optional: ingest mode (append|full|raw)

## Outputs
- Updated wiki pages with distilled knowledge
- Updated .manifest.json and log entries
- Optional: new/updated project overview pages

## Zone Registry

Place new pages in the most specific matching zone:

| Zone | Purpose |
|---|---|
| `projects/` | Active time-bound work (project hubs, sub-pages, deliverables) |
| `skills/` | Reusable how-to knowledge — general, not project-specific |
| `concepts/` | Abstract patterns and mental models |
| `entities/` | Tools, libraries, products, external services |
| `synthesis/` | Cross-cutting insights spanning multiple projects or concepts |
| `areas/` | Ongoing responsibilities with no end date; long-running context |
| `mocs/` | Navigation hubs only — do not write knowledge content here, only update link lists |
| `archive/` | Retired pages — **never write new content here during ingest** |
| `memory/` | Symlink to agent memory — do not write wiki content here |

## Frontmatter Template

Use this lean frontmatter for every new page:

```yaml
---
title: {{title}}
summary: {{one-sentence summary}}
type: {{skill|concept|project-hub|project-sub|deliverable|synthesis|area|moc|entity}}
lifecycle: active
tags: [{{tags}}]
related:
  - "[[path/to/related]]"
updated: {{YYYY-MM-DD}}
---
```

## Probing and Safety
- Do not ingest secrets or sensitive data.
- Respect existing page structure and avoid duplicating content.
- Mark inferred/ambiguous knowledge with provenance notes.

**Do not write to `archive/`.** If a page being updated has `lifecycle: archived`, skip it and log a warning rather than modifying it.

## Connection Rules (enforce on every new page)

Every page created by this skill must satisfy the vault's Graph Health Rules before the ingest is considered complete:

**Checklist per new page:**
1. **Inbound link** — Link to the new page from its parent hub (project hub's sub-page list or relevant MOC). If no natural parent exists, add it to the most relevant MOC.
2. **Outbound link** — Add a `## See Also` section at the bottom with at least one link to another wiki page. Include the relevant MOC as the first entry.
3. **MOC backlink** — For skill, concept, synthesis, and area pages: include `[[mocs/<relevant-moc>]]` in `## See Also`.
4. **Sub-page callout** — For pages nested inside a project: add `> **Part of:** [[projects/<hub>|Hub Name]]` directly below the H1.

**Quick zone → MOC mapping:**
This table is vault-specific and starts empty. Add a row the first time a cluster of pages wants
a hub, not before — a MOC with two links on it is worse than no MOC. Two kinds of row earn their
place:

| Page zone | Relevant MOC | Kind |
|---|---|---|
| `skills/<topic>-*`, `concepts/<topic>-*`, `synthesis/<topic>-*` | `mocs/<topic>` | by subject |
| `projects/<name>/*`, `areas/<name>-*` | `mocs/<name>` | by project |

A subject MOC gathers a theme that recurs across projects. A project MOC gathers one body of work.
When a page could belong to either, file it under the subject — projects end, subjects accumulate.

Keep the rows you add here in step with the files actually in `mocs/`; a mapping that names a MOC
which does not exist produces dead links on every page the rule touches.

## Example Workflow (high level)
1) Determine ingest mode and target paths
2) Run wiki-ingest with the chosen mode
3) Apply Connection Rules checklist to every new page created
4) Update manifest/log and refresh wiki index
5) Return a brief summary of changes including connection status
