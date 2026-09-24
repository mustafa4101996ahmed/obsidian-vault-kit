---
title: Wiki Log
summary: Append-only record of every ingest and maintenance run.
type: moc
lifecycle: stable
tags: [meta]
updated: REPLACE_DATE
---

# Wiki Log

Append-only. One line per run, newest at the bottom. This is the audit trail: when something in the
vault looks wrong, the answer is usually the last few lines here.

Line formats:

```
- [TIMESTAMP] CLAUDE-HISTORY sessions=N memory=N pages_created=N pages_updated=N
- [TIMESTAMP] DOC-INGEST source="<path>" pages_created=N pages_updated=N
- [TIMESTAMP] DAILY-UPDATE fresh=N stale=N missing=N index_added=N hot_refreshed=true orphans=N deadends=N
```

## Runs

<!-- ingest runs append below this line -->

## See Also

- [[index]] — the full page index
- [[hot]] — recently active pages
