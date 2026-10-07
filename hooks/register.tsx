import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheInfo, CacheNote, CacheNoteSource, CachePrefs, CacheTtl } from '../types'

const MINUTE = 60_000
const TTL_MS: Record<CacheTtl, number> = { '5m': 5 * MINUTE, '1h': 60 * MINUTE }
const TICK_MS = 15_000
/** A compaction must start this long before the cache lapses, or it would read a cold prefix. */
const WARM_MARGIN_MS = 30_000
const TOOL = 'mcp__claude-cache__afk'

const EMPTY: CacheInfo = {
  lastRequestAt: null,
  contextTokens: 0,
  contextWindow: 200_000,
  ttl: '5m',
  ttlSource: 'default',
  isTurnRunning: false,
  isCompacting: false,
  compactedAt: null,
  attemptedFor: null,
  wentColdAt: null,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  compactions: 0,
  tokensSaved: 0,
}

const infoRef = { plugin: 'claude-cache', key: 'info' } as const
const info = atom(infoRef, EMPTY)
const prefs = atom({ plugin: 'claude-cache', key: 'prefs' } as const, {
  autoCompact: null,
  isAfk: false,
} as CachePrefs)
const now = atom({ plugin: 'claude-cache', key: 'now' } as const, 0)
const isHidden = atom({ plugin: 'claude-cache', key: 'isHidden' } as const, false)
const note = atom({ plugin: 'claude-cache', key: 'note' } as const, null as CacheNote | null)

const NOTE_PROMPT =
  'claude-cache: the user is stepping away from this session. Write a handoff note of at most 120 words ' +
  'for whoever resumes it: the task and its goal, what is done, what is still running or half-done, ' +
  'the exact next steps, and any decision or constraint a summary must not lose. Plain text, no preamble.'

const BASE_INSTRUCTIONS =
  'Keep the current task, its open next steps, decisions made, and file paths touched, so work resumes without re-reading.'

type Options = {
  autoCompactDefault: boolean
  compactAfterMinutes: number
  minContextPercent: number
  ttl: 'auto' | CacheTtl
  showBand: boolean
  showStatus: boolean
}

type $ = EngineInterface

export const kTokens = (n: number) =>
  n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

export const minutesLeft = (ms: number) =>
  ms >= MINUTE ? `${Math.floor(ms / MINUTE)}m` : `${Math.max(0, Math.ceil(ms / 1000))}s`

/** When an idle session should compact, as ms after its last request; null when it should not. */
export function compactDueAfter(
  ttl: CacheTtl,
  isAfk: boolean,
  isAuto: boolean,
  compactAfterMinutes: number,
): number | null {
  const ttlMs = TTL_MS[ttl]
  if (isAfk) {
    return ttlMs - (ttl === '1h' ? 4 * MINUTE : MINUTE)
  }
  // A 5-minute cache expires at every coffee break, and compacting each time
  // would throw context away for little gain. Plain auto-compact needs the 1h cache.
  if (!isAuto || ttl !== '1h') {
    return null
  }

  return Math.min(compactAfterMinutes * MINUTE, ttlMs - 2 * MINUTE)
}

/** Reads which TTL the server actually wrote from the tail of a transcript. */
export function ttlFromTranscript(tail: string): CacheTtl | null {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? ''
    if (!line.includes('cache_creation')) continue
    try {
      const row = JSON.parse(line)
      if (row.isSidechain) continue
      const made = row.message?.usage?.cache_creation
      if ((made?.ephemeral_1h_input_tokens ?? 0) > 0) return '1h'
      if ((made?.ephemeral_5m_input_tokens ?? 0) > 0) return '5m'
    } catch {
      // a tail usually starts mid-row
    }
  }

  return null
}

export const clock = (at: number) => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Whether a request sent at `at` still finds the cache warm, with room for the request to start. */
export function isWarm(lastRequestAt: number | null, ttl: CacheTtl, at: number): boolean {
  return lastRequestAt !== null && at < lastRequestAt + TTL_MS[ttl] - WARM_MARGIN_MS
}

/** The summarizer's instructions with the handoff note folded in. */
export function withNote(n: CacheNote | null, instructions: string | undefined): string | undefined {
  if (n === null) return instructions
  const by = n.source === 'you' ? 'the user' : 'the assistant'
  const block =
    `Handoff note written by ${by} at ${clock(n.at)}, when the user stepped away. ` +
    `Carry it into the summary verbatim under a "Handoff note" heading, and treat work after that time as newer:\n${n.text}`

  return instructions ? `${instructions}\n\n${block}` : block
}

let opts: Options

/** The context's share of the model's window, 0 to 100. */
export function contextPercent(i: Pick<CacheInfo, 'contextTokens' | 'contextWindow'>): number {
  return i.contextWindow > 0 ? (100 * i.contextTokens) / i.contextWindow : 0
}

/** Whether the context is big enough for an automatic compaction to be worth its work. */
function isWorthCompacting(i: CacheInfo) {
  return contextPercent(i) >= opts.minContextPercent
}

function isAutoOn(p: CachePrefs) {
return p.autoCompact ?? opts.autoCompactDefault
}

async function ttlFromSetup($: $): Promise<Pick<CacheInfo, 'ttl' | 'ttlSource'> | null> {
  if (opts.ttl !== 'auto') return { ttl: opts.ttl, ttlSource: 'setting' }
  if (await $.env.get('FORCE_PROMPT_CACHING_5M')) return { ttl: '5m', ttlSource: 'env' }
  const named = await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL')
  if (named === '5m' || named === '1h') return { ttl: named, ttlSource: 'env' }
  const settings = (await $.settings.read()) as { promptCacheTtl?: unknown }
  if (settings.promptCacheTtl === '5m' || settings.promptCacheTtl === '1h') {
    return { ttl: settings.promptCacheTtl, ttlSource: 'setting' }
  }
  if (await $.env.get('ENABLE_PROMPT_CACHING_1H')) return { ttl: '1h', ttlSource: 'env' }

  return null
}

/** Where Claude Code keeps a session's transcript: the project root with every non-alphanumeric character a dash. */
export function transcriptPath(home: string, root: string, sessionId: string): string {
  return `${home}/.claude/projects/${root.replace(/[^a-zA-Z0-9]/g, '-')}/${sessionId}.jsonl`
}

async function detectTtl($: $, known?: string) {
  const held = await read($, info)
  if (opts.ttl !== 'auto' || held.ttlSource === 'transcript' || held.ttlSource === 'engine') return
  const home = await $.env.get('HOME')
  const path = known ?? (home ? transcriptPath(home, await $.session.root(), await $.session.id()) : null)
  if (path === null) return
  const { exitCode, stdout } = await $.process.run(['tail', '-c', '262144', path], {
    timeoutMs: 5000,
  })
  const ttl = exitCode === 0 ? ttlFromTranscript(stdout) : null
  if (ttl !== null) {
    await update($, info, i => ({ ...i, ttl, ttlSource: 'transcript' as const }))
  }
}

/** Why the session cannot compact right now, or null when it can. */
export function compactBlocker(held: CacheInfo, at: number): string | null {
  if (held.isCompacting || held.isTurnRunning) return 'claude-cache: a turn or a compaction is running.'
  if (held.compactedAt !== null) return 'claude-cache: already compacted. The next compaction waits for new conversation.'
  if (held.lastRequestAt === null) return 'claude-cache: nothing to compact before the first response.'
  // A cold compaction re-reads the whole context at full price, the cost claude-cache exists to avoid.
  if (!isWarm(held.lastRequestAt, held.ttl, at)) {
    return `claude-cache: the ${held.ttl} cache is cold. A compaction now would pay the full rewrite, so claude-cache skips it.`
  }

  return null
}

/**
 * Compacts from a command or a button. The engine refuses $.session.compact inside a hook that
 * holds the turn (command.run), so requestCompact starts the compaction on a timer after the hook returns.
 */
async function requestCompact($: $, why: string): Promise<string> {
  const blocked = compactBlocker(await read($, info), await $.clock.now())
  if (blocked !== null) return blocked
  $.clock.after(0, () => void compactNow($, why))

  return 'claude-cache: compacting while the cache is warm. A toast reports the result.'
}

/**
 * Claims the right to compact: checks the blockers and sets isCompacting in one versioned write,
 * so two callers racing (a tick and a button press) cannot both pass. Returns the state claimed, or why not.
 */
async function claimCompaction($: $): Promise<CacheInfo | string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { value = EMPTY, version } = await $.state.get(infoRef)
    const blocked = compactBlocker(value, await $.clock.now())
    if (blocked !== null) return blocked
    const { isSet } = await $.state.set(infoRef, { ...value, isCompacting: true }, { ifVersion: version })
    if (isSet) return value
  }

  return 'claude-cache: the session state kept changing; not compacting.'
}

/** Runs the compaction. Call it from a timer, never from inside a hook: see requestCompact. */
async function compactNow($: $, why: string) {
  const held = await claimCompaction($)
  if (typeof held === 'string') return held
  try {
    const done = await $.session.compact({
      instructions: withNote(await read($, note), BASE_INSTRUCTIONS),
    })
    if (done.skip !== undefined) {
      await update($, info, i => ({ ...i, isCompacting: false }))
      $.ui.toast(`claude-cache: compaction skipped: ${done.skip}`, { timeoutMs: 10_000 })
      return `claude-cache: compaction skipped: ${done.skip}`
    }
    const before = done.tokensBefore ?? held.contextTokens
    const after = done.tokensAfter ?? 0
    const at = await $.clock.now()
    await update($, info, i => ({
      ...i,
      isCompacting: false,
      compactedAt: at,
      contextTokens: after,
      compactions: i.compactions + 1,
      tokensSaved: i.tokensSaved + Math.max(0, before - after),
    }))
    const warmRead = done.usage?.cache_read_input_tokens
    const proof = warmRead === undefined ? 'while the cache was warm' : `reading ${kTokens(warmRead)} from the warm cache`
    const text = `claude-cache: ${why}; compacted ${kTokens(before)} to ${kTokens(after)} tokens, ${proof}.`
    $.ui.toast(text, { timeoutMs: 10_000 })
    $.clock.after(0, () => void tick($))

    return text
  } catch (error) {
    await update($, info, i => ({ ...i, isCompacting: false }))
    const text = `claude-cache: compaction failed: ${error instanceof Error ? error.message : String(error)}`
    $.ui.toast(text, { timeoutMs: 10_000 })
    return text
  }
}

async function tick($: $) {
  const at = await $.clock.now()
  await update($, now, () => at)
  const window = (await $.session.usage().catch(() => null))?.context.window
  if (window !== undefined && window > 0) await update($, info, x => (x.contextWindow === window ? x : { ...x, contextWindow: window }))
  const i = await read($, info)
  const p = await read($, prefs)

  if (opts.showStatus) $.ui.status(statusText(i, p, at))
  if (i.lastRequestAt === null || i.isTurnRunning || i.isCompacting || i.compactedAt !== null) return

  // Past the warm window a compaction would pay the full rewrite. The cold-return warning covers this case.
  if (!isWarm(i.lastRequestAt, i.ttl, at)) {
    const expiresAt = i.lastRequestAt + TTL_MS[i.ttl]
    if (at >= expiresAt && i.wentColdAt === null) await update($, info, x => ({ ...x, wentColdAt: expiresAt }))
    return
  }

  const due = compactDueAfter(i.ttl, p.isAfk, isAutoOn(p), opts.compactAfterMinutes)
  if (due === null || at < i.lastRequestAt + due) return
  if (!isWorthCompacting(i) || i.attemptedFor === i.lastRequestAt) return

  await update($, info, x => ({ ...x, attemptedFor: i.lastRequestAt }))
  if (p.isAfk && !isFresh(await read($, note), i)) await writeNote($).catch(() => null)
  await compactNow($, p.isAfk ? 'you are away' : 'the session sat idle')
}

function statusText(i: CacheInfo, p: CachePrefs, at: number): string | undefined {
  if (i.lastRequestAt === null) return undefined
  const mode = p.isAfk ? 'afk' : isAutoOn(p) ? 'auto' : 'manual'
  if (i.isCompacting) return 'cache: compacting'
  if (i.isTurnRunning) return `cache ${i.ttl} warm · ${mode}`
  if (i.compactedAt !== null) return `cache: compacted · ${kTokens(i.contextTokens)}`
  const left = i.lastRequestAt + TTL_MS[i.ttl] - at
  if (left <= 0) return `cache cold · ${kTokens(i.contextTokens)} to rewrite`

  return `cache ${minutesLeft(left)} left · ${kTokens(i.contextTokens)} · ${mode}`
}

/** A note is fresh when no model request came after it. */
function isFresh(n: CacheNote | null, i: CacheInfo) {
  return n !== null && (i.lastRequestAt === null || n.at >= i.lastRequestAt)
}

async function saveNote($: $, text: string, source: CacheNoteSource) {
  const saved: CacheNote = { text: text.trim(), source, at: await $.clock.now() }
  await update($, note, () => saved)
  await $.store.set(`note:${await $.session.id()}`, saved).catch(() => {})

  return saved
}

async function clearNote($: $) {
  await update($, note, () => null)
  await $.store.delete(`note:${await $.session.id()}`).catch(() => {})
}

/** Asks the session's own transcript for a handoff note. The fork reads the warm cache, which also restarts its TTL. */
async function writeNote($: $): Promise<CacheNote | null> {
  const sentAt = await $.clock.now()
  const reply = await $.model.fork({ prompt: NOTE_PROMPT })
  if (!reply.isAnswered) return null
  if (reply.usage.cache_read_input_tokens > 0) {
    await update($, info, i =>
      i.lastRequestAt !== null && i.compactedAt === null ? { ...i, lastRequestAt: sentAt } : i,
    )
  }

  return saveNote($, reply.text, 'generated')
}

async function setAfk($: $, isAfk: boolean, text?: string, source: CacheNoteSource = 'you') {
  await update($, prefs, p => ({ ...p, isAfk }))
  if (!isAfk) {
    $.clock.after(0, () => void tick($))
    return 'claude-cache: AFK off.'
  }

  let saved = text !== undefined && text.trim() !== '' ? await saveNote($, text, source) : null
  const i = await read($, info)
  // Mid-turn the transcript keeps moving, so the note waits until just before the compaction.
  if (saved === null && !i.isTurnRunning && i.lastRequestAt !== null) saved = await writeNote($)
  // A tick may compact, and the engine refuses that inside the command or tool hook that called us.
  $.clock.after(0, () => void tick($))

  const head =
    'claude-cache: AFK on. The session compacts before its prompt cache expires. Your next prompt turns AFK off.'
  if (saved !== null) return `${head}\nHandoff note, added to every compaction:\n${saved.text}`
  if (i.isTurnRunning) return `${head}\nclaude-cache writes the handoff note after this turn, just before it compacts.`

  return head
}

async function setAuto($: $, autoCompact: boolean) {
  await update($, prefs, p => ({ ...p, autoCompact }))
  // A tick may compact, and the engine refuses that inside the command or tool hook that called us.
  $.clock.after(0, () => void tick($))

  return `claude-cache: idle auto-compact ${autoCompact ? 'on' : 'off'} for this session.`
}

export const register: Register = (on, options) => {
  opts = options as unknown as Options

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const found = await ttlFromSetup($).catch(() => null)
    if (found !== null) {
      await update($, info, i =>
        i.ttlSource === 'transcript' || i.ttlSource === 'engine' ? i : { ...i, ...found },
      )
    }
    if ((await read($, note)) === null) {
      const kept = (await $.store.get(`note:${await $.session.id()}`).catch(() => undefined)) as CacheNote | undefined
      if (kept?.text) await update($, note, () => kept)
    }
    $.clock.every(TICK_MS, () => void tick($))
    await $.command.register({
      name: 'cache',
      description: 'Prompt cache status and controls: on, off, afk [note], back, note [text|clear], compact, band',
      argumentHint: '[status|on|off|afk [note]|back|note [text|clear]|compact|band]',
      immediate: true,
    }).catch(() => {})
    await $.tool.register({
      name: 'afk',
      description:
        'Tell claude-cache that the user is stepping away: going AFK, going to bed, or leaving a long or overnight job running. ' +
        'While the user is away, claude-cache compacts the conversation a few minutes before the prompt cache expires, so their next turn skips a full cache rewrite. ' +
        'Call with away=true when the user says they are leaving or will not reply for a while, and away=false when they say they are back. ' +
        'With away=true, pass a note of at most 120 words: the task, what is done, what is still running, the exact next steps, and decisions to keep. ' +
        'claude-cache adds the note to every compaction in this session.',
      inputSchema: {
        type: 'object',
        properties: {
          away: { type: 'boolean' },
          note: { type: 'string', description: 'Handoff note for whoever resumes the session.' },
        },
        required: ['away'],
      },
    }).catch(() => {})

    return started
  })

  // /compact and the engine's own auto-compact get the note too; our own $.session.compact skips this hook.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const n = await read($, note)
    const done = await next(n === null ? e : { ...e, instructions: withNote(n, e.instructions) })
    // A /compact or the engine's auto-compact counts too: no plugin compaction right behind it.
    if (e.trigger !== 'precompute' && done.skip === undefined) {
      const at = await $.clock.now()
      await update($, info, i => ({
        ...i,
        compactedAt: at,
        contextTokens: done.tokensAfter ?? i.contextTokens,
      }))
    }
    return done
  })

  on('turn.start', async ($, e, next) => {
    await update($, info, i => ({ ...i, isTurnRunning: true }))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const sentAt = await $.clock.now()
    const response = yield* next(e)
    const usage = response.usage
    if (usage !== null) {
      await update($, info, i => ({
        ...i,
        lastRequestAt: sentAt,
        contextTokens:
          usage.input_tokens +
          usage.cache_read_input_tokens +
          usage.cache_creation_input_tokens +
          usage.output_tokens,
        cacheReadTokens: i.cacheReadTokens + usage.cache_read_input_tokens,
        cacheWriteTokens: i.cacheWriteTokens + usage.cache_creation_input_tokens,
        compactedAt: null,
        wentColdAt: null,
      }))
    }

    return response
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, info, i => ({ ...i, isTurnRunning: false }))
      $.clock.after(0, () => {
        void tick($)
        void detectTtl($).catch(() => {})
      })
    }
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    const ran = await next(e)
    if (e.transcript_path) void detectTtl($, e.transcript_path).catch(() => {})
    return ran
  })

  // At a model switch the engine reports the TTL in use and what the switch costs.
  on('classic.PreModelSwitch', async ($, e, next) => {
    await update($, info, i => ({ ...i, ttl: e.cache_ttl, ttlSource: 'engine' as const }))
    if (e.prompt_cache_warm && e.context_tokens > 0) {
      $.ui.toast(
        `claude-cache: switching to ${e.to_model} drops a warm cache. Your next turn rewrites ${kTokens(e.context_tokens)} tokens (about $${e.estimated_cache_write_usd.toFixed(2)} at API prices).`,
        { timeoutMs: 10_000 },
      )
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'plugin') {
      const p = await read($, prefs)
      if (p.isAfk) {
        await update($, prefs, x => ({ ...x, isAfk: false }))
        const n = await read($, note)
        if (n !== null) {
          $.ui.toast(`claude-cache: welcome back. Your note from ${clock(n.at)}: ${n.text}`, { timeoutMs: 15_000 })
        }
      }
      const i = await read($, info)
      const at = await $.clock.now()
      const isCold =
        i.lastRequestAt !== null &&
        i.compactedAt === null &&
        at >= i.lastRequestAt + TTL_MS[i.ttl]
      if (isCold && isWorthCompacting(i) && !e.text.startsWith('/')) {
        $.ui.toast(
          `claude-cache: the ${i.ttl} cache expired ${minutesLeft(at - (i.lastRequestAt ?? at) - TTL_MS[i.ttl])} ago. This message rewrites about ${kTokens(i.contextTokens)} tokens.`,
          { timeoutMs: 8000 },
        )
      }
    }
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as { away?: unknown; note?: unknown }
    const text = typeof input.note === 'string' ? input.note : undefined
    return { result: await setAfk($, input.away === true, text, 'model') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!opts.showBand || e.props.hasSurvey || (await read($, isHidden))) return next(e)
    const i = await read($, info)
    if (i.lastRequestAt === null) return next(e)
    const p = await read($, prefs)
    const at = Math.max(await read($, now), i.lastRequestAt)
    const isAuto = isAutoOn(p)
    const left = i.lastRequestAt + TTL_MS[i.ttl] - at
    const due = compactDueAfter(i.ttl, p.isAfk, isAuto, opts.compactAfterMinutes)

    let line: string
    let color: 'green' | 'yellow' | 'red' | undefined
    if (i.isCompacting) {
      line = 'compacting while warm…'
      color = 'yellow'
    } else if (i.compactedAt !== null) {
      line = `compacted · ${kTokens(i.contextTokens)} context`
    } else if (e.props.isWorking || i.isTurnRunning) {
      line = `${i.ttl} cache refreshing · ${kTokens(i.contextTokens)}`
      color = 'green'
    } else if (left <= 0) {
      line = `cold · next message re-writes ${kTokens(i.contextTokens)}`
      color = 'red'
    } else {
      const plan =
        due === null || !isWorthCompacting(i)
          ? ''
          : ` · compacts in ${minutesLeft(i.lastRequestAt + due - at)}`
      line = `${i.ttl} warm · ${minutesLeft(left)} left · ${kTokens(i.contextTokens)}${plan}`
      color = left < 5 * MINUTE ? 'yellow' : 'green'
    }

    const n = await read($, note)
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color={color}>cache</Text>
          <Text dimColor>{line}</Text>
          <Button
            key="auto"
            hotkey="a"
            label={`Auto ${isAuto ? 'on' : 'off'}`}
            onPress={() => void setAuto($, !isAuto)}
          />
          <Button
            key="afk"
            hotkey="w"
            label={p.isAfk ? 'AFK on' : 'AFK'}
            variant={p.isAfk ? 'primary' : undefined}
            onPress={() => void setAfk($, !p.isAfk)}
          />
          <Button
            key="compact"
            hotkey="c"
            label="Compact now"
            onPress={() => void requestCompact($, 'you asked')}
          />
          <Button key="hide" role="dismiss" label="Hide" onPress={() => void update($, isHidden, () => true)} />
        </Box>
        {n !== null && (
          <Box flexDirection="row" gap={1}>
            <Text dimColor wrap="truncate-end">
              note {clock(n.at)}: {n.text.replace(/\s+/g, ' ')}
            </Text>
            <Button key="note-clear" label="Clear note" onPress={() => void clearNote($)} />
          </Box>
        )}
      </Box>
    )
  })

  // The engine labels a command's output with the plugin's name already.
  on('command.run', { command: 'cache' }, async ($, e) => {
    const answer = await cacheCommand($, e.args)
    return { text: answer.replace(/^claude-cache: /, '') }
  })
}

async function cacheCommand($: $, argText: string): Promise<string> {
  const args = argText.trim()
  const word = (args.split(/\s+/)[0] ?? '').toLowerCase()
  const rest = args.slice(word.length).trim()
  if (word === 'on' || word === 'off') return await setAuto($, word === 'on')
  if (word === 'afk' || word === 'away') return await setAfk($, true, rest)
  if (word === 'note') {
    if (rest.toLowerCase() === 'clear') {
      await clearNote($)
      return 'claude-cache: note cleared.'
    }
    if (rest !== '') {
      const saved = await saveNote($, rest, 'you')
      return `claude-cache: note saved at ${clock(saved.at)}. Every compaction in this session carries it.`
    }
    const n = await read($, note)
    return n === null ? 'claude-cache: no note yet. /cache note <text> saves one.' : `Note from ${clock(n.at)} (${n.source}):\n${n.text}`
  }
  if (word === 'back') return await setAfk($, false)
  if (word === 'compact') return await requestCompact($, 'you asked')
  if (word === 'band') {
    const hidden = await read($, isHidden)
    await update($, isHidden, () => !hidden)
    return `claude-cache: band ${hidden ? 'shown' : 'hidden'}.`
  }

  const i = await read($, info)
  const p = await read($, prefs)
  const at = await $.clock.now()
  const due = compactDueAfter(i.ttl, p.isAfk, isAutoOn(p), opts.compactAfterMinutes)
  const lines = [
    `TTL: ${i.ttl} (from ${i.ttlSource})`,
    `State: ${statusText(i, p, at) ?? 'no model request yet'}`,
    `Auto-compact this session: ${isAutoOn(p) ? 'on' : 'off'}${p.isAfk ? ' · AFK on' : ''}`,
    `Compacts after: ${due === null ? 'never (auto needs a 1h cache, or turn AFK on)' : minutesLeft(due) + ' idle'}, once context ≥ ${opts.minContextPercent}% of the window (now ${Math.round(contextPercent(i))}% of ${kTokens(i.contextWindow)})`,
    `Note: ${(await read($, note))?.text ?? 'none'}`,
    `This session: ${kTokens(i.cacheReadTokens)} read from cache, ${kTokens(i.cacheWriteTokens)} written, ${i.compactions} idle compactions saving ${kTokens(i.tokensSaved)} tokens`,
  ]
  return lines.join('\n')
}
