# claude-cache

claude-cache is a Claude Code plugin of function hooks (a "mod"). It compacts an idle session while the prompt cache is still warm, runs an AFK mode with a handoff note, and shows the cache TTL in the status line and in a band above the prompt, in the terminal and the desktop Code tab.

## Layout

| Path | Contents |
| --- | --- |
| `.claude-plugin/plugin.json` | manifest and `userConfig` fields (the `/config` rows) |
| `.claude-plugin/marketplace.json` | the one-plugin marketplace that `/plugin install` reads |
| `hooks/hooks.json` | names the hooks module |
| `hooks/register.tsx` | the plugin: helpers at the top, `register()` with every hook at the bottom |
| `types/index.d.ts` | the `$.state` contract, every value under `PluginState['claude-cache']` |
| `tests/claude-cache.test.ts` | the `claude plugin test` suite |
| `scripts/check_validate.py` | CI gate over `claude plugin validate --json` |
| `.github/workflows/ci.yml` | CI |
| `.claude-plugin/types/` | API declarations Claude Code writes at each load; gitignored, never edit |

## Commands

```
claude plugin test .                # the suite, on a mocked clock, store and env
claude -p --plugin-dir . "/cache"   # headless smoke check; writes .claude-plugin/types/
npx -p typescript@5 tsc -p .        # type-check, after one load
claude --plugin-dir .               # a real session
```

The test harness cannot fake compaction, TTL detection or the band. Check those in tmux:

```
tmux new-session -d -s cc -x 180 -y 50 "claude --plugin-dir . --model haiku"
tmux send-keys -t cc "Reply with just the word hello." Enter   # wait ~20 s
tmux send-keys -t cc "/cache" Enter                            # expect: TTL 1h (from transcript)
tmux send-keys -t cc "/cache afk" Enter                        # expect: a generated note
tmux send-keys -t cc "/cache compact" Enter                    # expect: a compacted toast, band "compacted"
tmux capture-pane -t cc -p; tmux kill-session -t cc
```

To watch idle auto-compact fire, pass `--settings '{"pluginConfigs":{"claude-cache@inline":{"options":{"compactAfterMinutes":5,"minContextPercent":5}}}}'` and wait six minutes.

## CI

`.github/workflows/ci.yml` runs on GitHub-hosted runners, free for this public repo. It tests against Claude Code `2.1.292`, which must pass, and `latest`, which may fail and warns you when the plugin API moves. Each job:

1. validates, with `scripts/check_validate.py` accepting the reserved-name error and the root-CLAUDE.md warning and nothing else;
2. loads the plugin once with `claude -p --plugin-dir . "/cache"`, so Claude Code writes `.claude-plugin/types/`;
3. type-checks;
4. runs `claude plugin test .`.

No step calls the model, so CI needs no API key. After you verify a new Claude Code build, bump the pinned version in the matrix.

## Design rules

- **Compact on a warm cache only.** A compaction re-reads the whole context: at the cache-read rate when warm, at the full rewrite price when cold. `isWarm()` requires the request to start at least `WARM_MARGIN_MS` (30 s) before expiry. The timer path (`tick`) and the manual path (`compactNow`, through `compactBlocker`) both check it. Any new compaction path must check it too.
- **The TTL runs from the start of the last main-thread request.** `turn.step` records `lastRequestAt` before `next(e)` and ignores subagent steps (`e.agentId`), because a subagent's prefix lives in a different cache entry. A `$.model.fork` that reads from the cache restarts the TTL, and `writeNote` records that.
- **No two compactions back to back.** Two guards enforce it:
  - `compactedAt` blocks the next compaction until a main-thread model request clears it. The `session.compact` hook sets it for the user's `/compact` and Claude Code's auto-compact as well. The plugin has no time-based cooldown: new conversation earns the next compaction, so an idle session compacts once.
  - `claimCompaction` sets `isCompacting` with a versioned `$.state.set` (`ifVersion`), so two callers racing cannot both pass the checks. The harness runs timers one at a time and cannot exercise that race; keep the versioned write.
- **One automatic attempt per idle period.** `attemptedFor` holds the `lastRequestAt` of the last attempt. Without it, a failing compaction retries at every 15-second tick.
- **Automatic compaction needs a context worth compacting.** The idle and AFK paths require `contextPercent >= minContextPercent`, 30% of the window from `$.session.usage()` by default. `/cache compact` skips the floor, because the person asked.
- **Plain auto-compact needs the 1-hour cache.** On a 5-minute cache it would compact at every short pause. AFK mode works on both (`compactDueAfter`).
- **Per-session switches live in `$.state`.** `userConfig.autoCompactDefault` seeds new sessions and nothing more. `$.state` survives a hot reload; module variables reset.
- **The handoff note reaches every compaction.** `compactNow` passes `withNote` itself, because the engine skips a plugin's own `session.compact` hook for that plugin's call. `/compact` and Claude Code's auto-compact get the note through the hook. `$.store` keeps the note under `note:<sessionId>`, so a resumed session finds it.
- **Fail open.** Hooks on `prompt.submit`, `classic.*` and `session.compact` call `next(e)` on every path. A broken claude-cache must not block a prompt or a compaction.

## Mod API constraints (Claude Code 2.1.292)

- A function that receives `$` must be a top-level function declaration. `claude plugin validate` refuses `$` passed into closures.
- `$.state` keys must be string literals declared in `types/index.d.ts`. Write state with `update($, atom, fn)`; the engine refuses `$.state.set` while a `ui.render` hook draws.
- `$.env.get` takes literal names, and validate lists them.
- `$.fs.read` rejects files over 4 MiB, so `detectTtl` reads the transcript tail with `$.process.run(['tail', '-c', ...])`.
- `$.session.compact` rejects while a turn runs and resolves `{ skip }` when a hook vetoes it.
- The engine refuses `$.session.compact` inside a hook that holds the turn, such as `command.run`: "it would compact under the turn this hook is holding". Commands and buttons call `requestCompact`, which checks `compactBlocker` and runs `compactNow` on `$.clock.after(0)`. Handlers that can trigger a tick defer it the same way. The harness skips this check, so test compaction paths live.
- `classic.Stop` never reached the plugin in testing. `detectTtl` runs after each main turn and reads `~/.claude/projects/<project root, non-alphanumerics as dashes>/<sessionId>.jsonl` (`transcriptPath`).
- `classic.PreModelSwitch` carries the engine's `cache_ttl`, `prompt_cache_warm` and `estimated_cache_write_usd`, the most reliable TTL source.
- In tests, bottom hooks for op events (`command.register`, `tool.register`, `settings.read`, `session.id`, `session.usage`, `model.fork`, `ui.status`, `ui.toast`) return `{ value }`. A `session.compact` bottom returns at least one message. A test can hook each event once, so `world()` takes parameters in place of a second registration.
- `.claude-plugin/types/claude-code/index.d.ts` holds the full API. Grep it for the event or noun you need.

## Naming

The owner chose the id `claude-cache`. `claude plugin validate` reports names starting with `claude-` as reserved, yet `claude plugin install claude-cache@claude-cache` from this repo's marketplace succeeded on 7 October 2026, as do `--plugin-dir` and `CLAUDE_CODE_PLUGIN_DIRS`.

## Keepalive pings

claude-cache sends none. On Pro and Max plans each ping spends quota, and Anthropic's consumer terms restrict automated traffic. If you add pings later, make them opt-in and limit them to API-key users.

## Conventions

- Write prose (README, toasts, command output) in plain, active English, with no em dashes and no filler.
- Commits carry no Claude attribution trailers.
- Every behaviour change gets a test in `tests/claude-cache.test.ts`, on the mocked clock.
