# Privacy policy

cachekeeper is a Claude Code plugin. It runs on your machine, inside Claude Code, and has no server of its own. It collects nothing about you, sends no telemetry, and makes no network requests.

## What it reads

- The last 256 KB of the current session's transcript, which Claude Code keeps in `~/.claude/projects/`. cachekeeper reads it with `tail` to learn whether your prompt cache lasts 5 minutes or 1 hour. It reads no other file.
- Your Claude Code `promptCacheTtl` setting and the environment variables `CLAUDE_CODE_PROMPT_CACHE_TTL`, `ENABLE_PROMPT_CACHING_1H`, `FORCE_PROMPT_CACHING_5M` and `HOME`.

## What it stores

Handoff notes you write, or that your session writes when you go AFK, plus two flags that stop a message from repeating. They stay in Claude Code's plugin storage on your machine. Uninstall the plugin to remove them.

## What leaves your machine

cachekeeper sends nothing anywhere itself. Two of its features go through Claude Code on your own account, the same way your own messages do:

- When you go AFK without a note, cachekeeper asks your session's model to write one.
- When it compacts a session, Claude Code's own compaction summarizes the conversation.

Anthropic handles those requests under the terms of your Claude account, as it handles any turn of your session.

## Contact

Questions about this policy: aditya@cybersapien.xyz.

Last updated 24 October 2026.
