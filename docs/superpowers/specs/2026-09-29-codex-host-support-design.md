# Design: Codex CLI as a second agent host

Date: 2026-09-29
Status: approved, not yet implemented

## Goal

Let the kit install and run under OpenAI Codex CLI as well as Claude Code, on one
codebase, detected automatically. A person with only Codex installed gets a working
vault, a working Stop hook and a working daily ingest of their Codex history. A person
with both gets one schedule that ingests both histories.

A person with only Claude Code sees one visible change and no behavioural one: their vault
contract moves from `CLAUDE.md` to `AGENTS.md`, with a pointer left behind. Everything the
Claude path does — its tool allowlist, its transcript watchdog, its schedule — is
untouched.

## Non-goals

- Shipping the `copilot`, `hermes` and `openclaw` history-ingest skills. The router in
  `wiki-history-ingest` already names them and the repo already ships none of them; that
  gap predates this work and stays out of scope.
- A `hosts/` plugin directory. Two hosts do not justify a loader. If a third lands, the
  registry in `lib/host.mjs` is what grows into one.
- Changing the Claude Code path's behaviour. Its watchdog, its tool allowlist and its
  transcript scan stay exactly as they are.

## Facts established about Codex CLI

Verified against the `openai/codex` source, not inferred:

| Capability | Where |
|---|---|
| Skills are native, same `SKILL.md` frontmatter (`name` ≤ 64 chars, `description`) | `codex-rs/skills/src/parser.rs` |
| Skill roots include `~/.codex/skills/`, `~/.agents/skills/`, repo `.agents/skills/` | `codex-rs/ext/skills/src/host_roots.rs` |
| `Stop` is one of 12 hook events | `codex-rs/protocol/src/protocol.rs` |
| `hooks.json` in the config folder, same JSON shape as Claude's `hooks` key | `codex-rs/config/src/hooks_tests.rs`, `codex-rs/hooks/src/engine/discovery.rs` |
| Per-hook trust state (`enabled`, `trusted_hash`) lives in `config.toml` | `codex-rs/config/src/hook_config.rs` |
| `codex exec` defaults approval policy to `Never` — unattended needs no dangerous flag | `codex-rs/exec/src/lib.rs` |
| `--model`/`-m` and `--sandbox`/`-s` are shared flags; `--ask-for-approval` is root-only | `codex-rs/utils/cli/src/shared_options.rs` |
| `--json` streams JSONL events to stdout | `codex-rs/exec/src/cli.rs` |
| Sessions are JSONL rollouts under `<codex_home>/sessions/YYYY/MM/DD/` | `codex-rs/core/src/thread_manager.rs` |
| `codex exec` has no `--session-id` equivalent | absence in `codex-rs/exec/src/cli.rs` |

That last absence is load-bearing: it is why the watchdog becomes per-host.

## Architecture: one file knows the agents

Today two files know the operating system (`lib/platform.mjs`, `lib/schedule.mjs`) and
five files know that the agent is Claude Code. After this change, two files know the OS
and one file knows the agents.

`lib/host.mjs` holds a descriptor per host, structured like the four scheduler backends
in `lib/schedule.mjs`: N implementations behind one interface.

```js
{
  id: 'claude' | 'codex',
  label: 'Claude Code' | 'Codex CLI',
  exe: 'claude' | 'codex',                 // resolved with which()
  home,                                    // ~/.claude | ~/.codex
  skillsDir,                               // <home>/skills
  hooks: { file, read, write },            // settings.json | hooks.json
  sessionsDir,                             // ~/.claude/projects | ~/.codex/sessions
  historyArg: 'claude' | 'codex',          // wiki-history-ingest router argument
  detect(),                                // exe on PATH || home exists
  buildArgs({ prompt, model, sessionId, vault }),
  watchdog: { kind: 'transcript', matches } | { kind: 'stdout' },
  installNotes,                            // host-specific caveats to print
}
```

The four `CLAUDE_*` constants move out of `lib/platform.mjs` into the descriptors.
`lib/platform.mjs` keeps OS knowledge only.

### Hooks

Codex's standalone `hooks.json` uses the same JSON shape as Claude's `settings.json`
`hooks` key:

```json
{ "hooks": { "Stop": [ { "matcher": "", "hooks": [
  { "type": "command", "command": "\"<node>\" \"<wiki>/bin/mark-pending.mjs\"", "timeout": 5 }
] } ] } }
```

So `lib/hooks.mjs` keeps its merge logic verbatim — back up first, preserve every
existing key and hook, never add a duplicate — and gains only two things: the file path
comes from the host, and the root wrapper differs (`settings.hooks` for Claude, the whole
file for Codex). The `mark-pending.mjs` fingerprint dedupe is unchanged, so both hosts'
hooks mark the same `.pending_ingest` flag. That is what makes one schedule correct for a
dual-host machine.

### Skills

No conversion. Codex parses the same frontmatter and discovers `~/.codex/skills/`.
`linkSkills(vault, hosts)` loops over the detected hosts, making one symlink (junction on
Windows) set per host, all pointing back into the vault's single `.agents/skills/`. The
vault stays the source of truth for every host on the machine.

### Sandboxing, and how it differs

Claude gets a per-command allowlist (`--allowedTools` with `Bash(node:*)` and friends)
plus `--disallowedTools Edit(~/.claude/**)`. Codex has no per-command equivalent; it
confines by sandbox. The Codex invocation is therefore:

```
codex exec --json --sandbox workspace-write
  -c sandbox_workspace_write.writable_roots='["<vault>"]'
  -c sandbox_workspace_write.network_access=false
  [-m <model>] "<prompt>"
```

Writes are confined to the vault, which achieves structurally what
`--disallowedTools Edit(~/.claude/**)` achieves by enumeration. Reads are broader than the
Claude path allows, and the ingest needs to read `~/.codex/sessions` anyway. This is
coarser than the Claude path. It gets stated in `ARCHITECTURE.md` rather than passed over.

## Config, migrating on read

The repo is public, so existing installs must not break without a re-run.

```json
{
  "vaultPath": "…",
  "engine": "codex",
  "hosts": { "codex": { "exe": "/usr/local/bin/codex" } },
  "platform": "darwin",
  "installed": "…"
}
```

`readConfig()` migrates in memory: seeing the old flat `claudeExe`/`model` keys and no
`hosts`, it synthesises `hosts: { claude: { exe: claudeExe, model } }` and
`engine: 'claude'`. A user who never re-runs the installer keeps working. The next
`install.mjs` writes the new shape.

### Two new installer flags

`--host <spec>` chooses which hosts to wire up: `auto` (the default — every detected
host), `claude`, `codex`, or `both`. Naming a host that is not installed is an error with
the install instruction for it, not a silent skip, because a hook wired to a missing CLI
looks installed and never fires.

`--engine <id>` chooses which CLI runs the headless ingest. It must be one of the hosts
being wired up.

**`engine`** in the config is which CLI runs the headless ingest. It defaults to the only detected host,
and to `claude` when both are present, because that is the tested path. `--engine <id>`
overrides. The engine is independent of what gets ingested.

**No hardcoded Codex model.** `model` stays `sonnet` for Claude and stays *absent* for
Codex, so the runner omits `-m` and Codex's own configured default applies. A pinned
`gpt-5.x` string would rot and would override whatever the user's account has.
`install.mjs --model <name>` still overrides, applying to the engine host.

## Per-file changes

| File | Change |
|---|---|
| `lib/host.mjs` | new — two descriptors, `detectHosts()`, `resolveEngine()` |
| `lib/platform.mjs` | four `CLAUDE_*` constants move out |
| `lib/hooks.mjs` | takes a host; handles the `hooks.json` root wrapper |
| `lib/vault.mjs` | `linkSkills(vault, hosts)`; result rows gain `host` |
| `bin/run-ingest.mjs` | engine selection, per-host args, per-host watchdog, multi-source prompt, host-named failures |
| `install.mjs` | `--host`, `--engine`, per-host detect / link / hook / uninstall, contract migration |
| `lib/schedule.mjs`, `lib/shell.mjs`, `lib/notify.mjs` | untouched — one schedule, one alias set, one notifier |
| `bin/mark-pending.mjs` | untouched — both hosts mark the same flag |

## Runner changes

**Prompt.** Today it hardcodes `with the argument claude`. It becomes one pass per
detected host in a fixed order (`claude`, then `codex`), because the router takes a single
argument. The manifest-stamp guard is unaffected: it asks only whether `.manifest.json`
got newer, so one pass doing real work still proves the run ingested something.

**Watchdog.** Claude keeps the transcript-mtime scan — its `-p` stdout is silent until the
end, and subagent transcripts count as activity. Codex uses `--json` and treats any stdout
event as the activity signal. Both feed the same 20-minute stall timer and the same
`fail()`. The Codex signal is strictly better than a transcript scan would be: it needs no
session id, and it cannot be fooled by an unrelated interactive session writing a rollout
file at the same moment.

**Windows `.cmd` routing** generalises for free — the existing branch keys off the exe
filename, and npm's global `codex` is the same kind of shim.

**Failure text** goes from `claude exited N` to `${host.label} exited N`.

## Vault contract: AGENTS.md becomes the authority

Claude Code reads `CLAUDE.md`; Codex reads `AGENTS.md`. `AGENTS.md` becomes the real
contract — it is the cross-agent convention that the `.agents/skills/` layout already
commits to — and `CLAUDE.md` stays as a one-line pointer to it. One file to edit, no
drift, and no symlink, which matters because a git-tracked symlink breaks on a Windows
checkout without symlink support.

Migration is the delicate part. `ARCHITECTURE.md` actively tells people to edit
`CLAUDE.md`, so existing copies are modified, and `copyIfAbsent` would skip the vault and
leave Codex with no contract at all. So the installer:

1. `CLAUDE.md` exists, `AGENTS.md` does not → back up, **move** `CLAUDE.md` to
   `AGENTS.md` (their edits survive and become the authority), write the pointer.
2. Both exist → leave both alone, warn, say which one the kit treats as the contract.
3. Neither exists → copy both from the scaffold as usual.

## Shipping codex-history-ingest

The router's `codex` route currently points at a skill the repo does not ship, so a Codex
daily run would route to nothing. `vault-scaffold/.agents/skills/codex-history-ingest/`
gets `SKILL.md` plus `references/codex-data-format.md`, adapted the way the repo's
`claude-history-ingest` was: personal paths removed, Windows spellings added, the
`llm-wiki/SKILL.md` config-resolution dependency inlined.

Sessions live under a plain `YYYY/MM/DD/` hierarchy, so this skill needs none of the
lossy-path-slug defence the Claude one carries.

## Testing

The suite already runs the real installer against a throwaway `HOME` and stubs `claude` by
pointing `cfg.claudeExe` at a script it writes. The Codex path needs no new machinery:
point `cfg.hosts.codex.exe` at a `codex` stub. New assertions, ordered by what they catch:

1. Legacy flat config (`claudeExe` + `model`, no `hosts`) still runs — the regression that
   would hit every existing user.
2. `~/.codex/hooks.json` gets the right shape, pre-existing content preserved, backed up
   first; a second install adds no duplicate.
3. Dual-host install creates both hook sets and both skill-link sets from one
   `.agents/skills/` source.
4. `--uninstall` removes this kit's Codex hook and leaves an unrelated hook in
   `hooks.json` intact.
5. The Codex watchdog fails a run whose stub goes silent, and the manifest-stamp guard
   still fails a stub that exits zero having written nothing.
6. Contract migration: a vault with an edited `CLAUDE.md` ends up with those edits in
   `AGENTS.md` and a pointer in `CLAUDE.md`.

## Docs

- `ARCHITECTURE.md`: a host row in the five-layer diagram; a *Porting to another agent*
  section beside the platform one; the sandbox-coarseness note; two new failure-mode rows
  — *Codex hook present but untrusted* (how you notice: the vault quietly stops growing)
  and *engine ingests only its own history* if the prompt loses a source.
- `SETUP-GUIDE.md`: a Codex install path and its troubleshooting rows.
- `README.md`: one requirements line naming which agent is needed. This is the file a new
  user reads first; it says that and nothing more.

## Open risk, to settle before building

Codex records per-hook trust in `config.toml` (`enabled`, `trusted_hash`). Writing
`~/.codex/hooks.json` may therefore leave the hook present but **untrusted**, and an
untrusted Stop hook that never fires means the pending flag is never written and the
vault silently stops growing — the worst failure class this kit has, the one the
manifest-stamp guard exists to prevent elsewhere.

The docs do not settle whether a `command` hook from `hooks.json` needs a one-time
interactive approval. The first implementation task is therefore a spike on a machine with
Codex installed: write the hook, run a turn, confirm the flag appears. If approval is
needed, `install.mjs` prints it as a required next step rather than reporting success —
the same rule that makes the runner write the headline to the log before calling
`notify()`.

`codex` is not installed on the development machine, so that spike needs either a Codex
install or the brother's machine.

## Decisions and why

| Decision | Alternative rejected | Why |
|---|---|---|
| Host registry in one file | `if (host === 'codex')` at five call sites | `ARCHITECTURE.md`: "if you find yourself editing a third file to add a platform, the abstraction has leaked" |
| Auto-detect, support both | one host per machine | a shared vault across two agents is the interesting case, and the lock already serialises writers |
| One schedule, all histories | one schedule per host | the pending-line arithmetic is the subtlest guard in the kit; duplicating it invites the lost-turn bug back |
| Migrate config on read | require a re-install | the repo is public; a silent break is not acceptable |
| No pinned Codex model | default to a `gpt-5.x` string | it would rot, and override the user's own configured default |
| Move `CLAUDE.md` to `AGENTS.md` | copy both, or symlink | copies drift; git symlinks break on Windows checkouts |
| Ship `codex-history-ingest` | leave the router dangling | without it the Codex daily run routes to a skill that does not exist |
