---
title: Vault Map
summary: What each folder in this vault is for, and how to decide where a new page goes.
type: moc
lifecycle: stable
tags: [meta]
updated: 2026-09-25
---

# Vault Map

> **Part of:** [[index|Wiki Index]]

The folders are not categories of *subject* — they are categories of *shape*. Two pages about the
same tool can live in different zones depending on what they answer. Getting this right is what
stops the vault turning into a folder of files you never open again.

## The zones

| Folder | Answers | Lifespan | Example |
|---|---|---|---|
| `skills/` | "how do I do X" | Outlives projects | `skills/debugging-flaky-tests.md` |
| `concepts/` | "why does X behave that way" | Permanent | `concepts/eventual-consistency.md` |
| `entities/` | "what is X" | Permanent | `entities/postgres.md` |
| `projects/` | "what is happening on X" (ends) | Time-bound | `projects/side-app/` |
| `areas/` | "what is happening on X" (never ends) | Ongoing | `areas/personal-finance.md` |
| `synthesis/` | "what do these things have in common" | Permanent | `synthesis/why-my-estimates-slip.md` |
| `mocs/` | "where do I find things about X" | Permanent | this page |
| `archive/` | "what did I used to think" | Frozen | `archive/projects/old-app/` |
| `_raw/` | unprocessed source material | Transient | a PDF you have not distilled yet |

## Deciding where a page goes

Ask the two questions in order:

1. **Does it end?** If the thing has a finish line, it is a project. If it is a standing
   responsibility with no finish line, it is an area.
2. **Would it still be true if the project vanished?** If yes, it is not project knowledge — it is a
   skill or a concept, and it belongs in the global zone with the project page linking to it.

The second question is the one people get wrong. A hard-won lesson written inside
`projects/some-app/` is lost the day that project is archived. Written in `skills/`, it keeps paying
out.

## Two rules that keep the graph alive

Every page needs **one link in** and **one link out**. The graph view makes violations obvious:
orphans float unconnected at the edge.

- A page nothing links to is a page you will never find again.
- A page that links nowhere is a dead end that traps you.

`daily-update` checks both and reports the offenders. Full rules in `CLAUDE.md` under Graph Health
Rules.

## Colours in the graph view

The graph is coloured by folder, so the shape of your knowledge is visible at a glance — blue
projects, purple concepts, green skills, gold hubs. Zero tagging required. Configured in
`.obsidian/graph.json`; `graph-colorize` can extend it to tag-based groups later.

## See Also

- [[index]] — the full page index
- [[log]] — ingestion history
