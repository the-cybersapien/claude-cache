export type CacheTtl = '5m' | '1h'

export type CacheTtlSource = 'default' | 'setting' | 'env' | 'transcript' | 'engine'

export type CacheInfo = {
  /** Start of the last main-thread model request, epoch ms; the cache TTL runs from here. */
  lastRequestAt: number | null
  /** Tokens the next request re-sends (input + cache read + cache write + output). */
  contextTokens: number
  /** The model's context window in tokens, from $.session.usage(). */
  contextWindow: number
  ttl: CacheTtl
  ttlSource: CacheTtlSource
  isTurnRunning: boolean
  isCompacting: boolean
  /** When the session last compacted, by any trigger. The next main-thread model request clears it. */
  compactedAt: number | null
  /** The lastRequestAt of the last automatic attempt: one try per idle period. */
  attemptedFor: number | null
  /** When the cache expired without a compaction. The next model request clears it. */
  wentColdAt: number | null
  cacheReadTokens: number
  cacheWriteTokens: number
  compactions: number
  tokensSaved: number
}

export type CacheNoteSource = 'you' | 'model' | 'generated'

/** A handoff note: where the work stands when the person steps away. Every compaction receives it. */
export type CacheNote = {
  text: string
  source: CacheNoteSource
  /** When the note was saved, epoch ms. */
  at: number
}

export type CachePrefs = {
  /** This session's auto-compact switch; null follows the autoCompactDefault option. */
  autoCompact: boolean | null
  /** The person is away: compact before the cache expires, on either TTL. */
  isAfk: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'claude-cache': {
      info: CacheInfo
      prefs: CachePrefs
      note: CacheNote | null
      now: number
      isHidden: boolean
    }
  }
}
