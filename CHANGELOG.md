# Changelog

## 0.1.0 (2026-10-07)

First release.

- Idle auto-compact, switched per session. With a 1-hour prompt cache, an idle session compacts after 55 minutes while the cache is warm.
- Warm cache only. A compaction starts at least 30 seconds before the cache expires; when you miss that window you get a warning in its place.
- One compaction per stretch of work. After any compaction (claude-cache's, your `/compact`, or Claude Code's auto-compact), the next one waits for new conversation.
- A context floor. Automatic compaction waits until the context fills 30% of the model's window (`minContextPercent`).
- AFK mode through `/cache afk [note]` or the model's `afk` tool. It compacts 4 minutes before a 1-hour cache expires and 1 minute before a 5-minute one.
- A handoff note, from you or from the model reading the warm cache. claude-cache adds it to every compaction in the session and shows it when you return.
- TTL detection from the transcript's `ephemeral_1h` and `ephemeral_5m` counts, with environment and settings fallbacks.
- A status-line countdown and a band above the prompt, in the terminal and the desktop Code tab, with Auto, AFK, Compact now and Clear note.
- Warnings when you return to an expired cache and when a model switch would drop a warm one.
