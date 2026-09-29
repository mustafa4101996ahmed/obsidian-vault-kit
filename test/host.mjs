#!/usr/bin/env node
// The host registry, in process: descriptors, invocation arguments, detection and
// engine choice. Nothing here spawns a child or needs a throwaway HOME, which is the
// seam -- everything that does lives in test/codex.mjs.

import path from 'node:path';
import { eq, has, head, summary, truthy } from './harness.mjs';

const { HOSTS, hostById, detectHosts, resolveEngine } = await import('../lib/host.mjs');
const { buildPrompt } = await import('../lib/prompt.mjs');

head('1. The host registry');

eq('two hosts are registered', HOSTS.length, 2);
eq('Claude is first, because it is the tested path', HOSTS[0].id, 'claude');
eq('Codex is second', HOSTS[1].id, 'codex');
truthy('an unknown id resolves to null', hostById('nope') === null);
eq('hostById finds Codex', hostById('codex').label, 'Codex CLI');

const claude = hostById('claude');
const codex = hostById('codex');

has('Claude home is ~/.claude', claude.home, '.claude');
has('Codex home is ~/.codex', codex.home, '.codex');
has('Claude hooks live in settings.json', claude.hooksFile, 'settings.json');
has('Codex hooks live in hooks.json', codex.hooksFile, 'hooks.json');
has('Claude sessions live in projects/', claude.sessionsDir, 'projects');
has('Codex sessions live in sessions/', codex.sessionsDir, 'sessions');
eq('Claude watches transcripts', claude.watchdog, 'transcript');
eq('Codex watches stdout, having no session id to pin', codex.watchdog, 'stdout');
eq('Claude routes the claude history source', claude.historyArg, 'claude');
eq('Codex routes the codex history source', codex.historyArg, 'codex');
eq('Claude defaults to sonnet: it has no usable default of its own and must always get a --model', claude.defaultModel, 'sonnet');
eq("Codex has no default model: pinning one would rot and override the user's own config", codex.defaultModel, null);

head('2. Invocation arguments');

const args = { prompt: 'INGEST', model: 'sonnet', sessionId: 'abc-123', vault: '/v' };
const ca = claude.buildArgs(args);
has('Claude gets -p', ca.join(' '), '-p');
has('Claude pins the session id', ca.join(' '), '--session-id');
has('Claude keeps its tool allowlist', ca.join(' '), '--allowedTools');
has('Claude keeps acceptEdits', ca.join(' '), 'acceptEdits');
truthy('Claude receives the prompt', ca.includes('INGEST'));

// A config missing the model key (legacy, or Claude with no model configured) must
// never reach the CLI as the literal argument "--model null" -- see section 4 for
// the migration test that a missing key stays missing.
const caNoModel = claude.buildArgs({ prompt: 'P', model: null, sessionId: 's', vault: '/v' });
truthy('no bare "null" reaches the Claude CLI when no model is configured', !caNoModel.join(' ').includes('null'));
truthy('and --model is omitted entirely, not emitted with a null value', !caNoModel.includes('--model'));

const caWithModel = claude.buildArgs({ prompt: 'P', model: 'sonnet', sessionId: 's', vault: '/v' });
const modelFlagAt = caWithModel.indexOf('--model');
truthy('a configured model is still passed as --model <name>', modelFlagAt !== -1 && caWithModel[modelFlagAt + 1] === 'sonnet');

const xa = codex.buildArgs({ ...args, model: null });
eq('Codex runs exec', xa[0], 'exec');
has('Codex streams JSON so stdout is the activity signal', xa.join(' '), '--json');
has('Codex confines writes to the workspace', xa.join(' '), 'workspace-write');
has('Codex is pointed at the vault', xa.join(' '), '--cd');
has('Codex tolerates a non-git vault', xa.join(' '), '--skip-git-repo-check');
truthy('no model flag when no model is configured', !xa.includes('-m'));
truthy('the prompt is the last argument', xa[xa.length - 1] === 'INGEST');
truthy('Codex never gets a session id it has no flag for', !xa.includes('--session-id'));

const xm = codex.buildArgs({ ...args, model: 'gpt-5-codex' });
truthy('a configured model is passed with -m', xm.includes('-m') && xm.includes('gpt-5-codex'));

// Group 1: an unreadable source produces no rows while the other pass still stamps
// the manifest, so every source needs its own --add-dir, not just the engine's own.
const twoSource = claude.buildArgs({ ...args, sourceHosts: [claude, codex] });
truthy('two --add-dir flags, one per source session dir', twoSource.filter((a) => a === '--add-dir').length === 2 && twoSource.includes(claude.sessionsDir) && twoSource.includes(codex.sessionsDir));
eq('single-source args still get exactly one --add-dir', ca.filter((a) => a === '--add-dir').length, 1);
truthy('Codex never emits --add-dir: it would make session history writable', !codex.buildArgs({ ...args, sourceHosts: [claude, codex] }).includes('--add-dir'));
truthy('buildPrompt names claude before codex', /claude[\s\S]*codex/.test(buildPrompt(['claude', 'codex'])));

head('3. Detection and engine choice');

const detected = detectHosts();
eq('one row per registered host', detected.length, 2);
truthy('every row reports presence', detected.every((d) => typeof d.present === 'boolean'));

const both = [{ host: claude, present: true }, { host: codex, present: true }];
const onlyCodex = [{ host: claude, present: false }, { host: codex, present: true }];

eq('with both present the engine defaults to claude', resolveEngine(both, null).id, 'claude');
eq('with only codex present it is the engine', resolveEngine(onlyCodex, null).id, 'codex');
eq('an explicit request wins', resolveEngine(both, 'codex').id, 'codex');

let threw = null;
try { resolveEngine(onlyCodex, 'claude'); } catch (err) { threw = err.message; }
truthy('requesting an absent host throws', threw !== null);
has('and says how to install it', threw || '', 'npm install');

threw = null;
try { resolveEngine(both, 'gemini'); } catch (err) { threw = err.message; }
truthy('requesting an unknown host throws', threw !== null);

summary();
