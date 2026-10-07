import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { compactDueAfter, contextPercent, isWarm, transcriptPath, ttlFromTranscript, withNote } from '../hooks/register'

const MINUTE = 60_000

const usage = (tokens: number) => ({
  input_tokens: 10,
  output_tokens: 500,
  cache_read_input_tokens: tokens,
  cache_creation_input_tokens: 2000,
  model: 'claude-opus-5-5',
})

/** The engine beneath the plugin: a session, one model step per turn, and a compaction that counts its calls. */
function world(on: On, compactions: string[], isBroken = false, window = 200_000) {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__claude-cache__${e.name}` } }))
  on('settings.read', () => ({ value: {} }) as never)
  mock.env(on, {})
  on('session.usage', () => ({ value: { startedAt: 0, context: { window }, rateLimits: [] } }) as never)
  on('session.id', () => ({ value: 'session-1' }) as never)
  on('model.fork', () =>
    ({
      value: {
        isAnswered: true,
        text: 'Migrating the users table; step 3 of 5 is next.',
        usage: usage(180_000),
      },
    }) as never,
  )
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => ({ text: e.text }) as never)
  on('session.compact', ($, e) => {
    compactions.push(e.instructions ?? '')
    if (isBroken) throw new Error('summarizer down')
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensBefore: 180_000, tokensAfter: 12_000 }
  })
  on('turn.step', async function* ($, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'done',
      toolUses: [],
      stopReason: 'end_turn',
      usage: usage(180_000),
    } as never
  })
}

const run = (args: string) => ({
  command: 'cache',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 100 },
}) as never

async function runTurn($: Parameters<Parameters<typeof test>[1] & ((...a: never[]) => unknown)>[0] | any) {
  await $.turn.start({ text: 'go', turnId: 't1' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 })) {
    // drain
  }
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
}

test('compactDueAfter: auto needs the 1h cache, AFK works on both', () => {
  expect(compactDueAfter('1h', false, true, 55)).toBe(55 * MINUTE)
  expect(compactDueAfter('1h', false, true, 59)).toBe(58 * MINUTE)
  expect(compactDueAfter('5m', false, true, 55)).toBe(null)
  expect(compactDueAfter('1h', false, false, 55)).toBe(null)
  expect(compactDueAfter('1h', true, false, 55)).toBe(56 * MINUTE)
  expect(compactDueAfter('5m', true, false, 55)).toBe(4 * MINUTE)
})

test('ttlFromTranscript reads the newest main-thread cache write', () => {
  const row = (ttl: '5m' | '1h', isSidechain = false) =>
    JSON.stringify({
      isSidechain,
      message: {
        usage: {
          cache_creation: {
            ephemeral_5m_input_tokens: ttl === '5m' ? 900 : 0,
            ephemeral_1h_input_tokens: ttl === '1h' ? 900 : 0,
          },
        },
      },
    })
  expect(ttlFromTranscript(['{"cut', row('5m'), row('1h'), row('5m', true)].join('\n'))).toBe('1h')
  expect(ttlFromTranscript('{"type":"user"}')).toBe(null)
})

test('an idle 1h session compacts once, at 55 minutes', { options: { ttl: '1h' } }, async ($, on) => {
  const compactions: string[] = []
  world(on, compactions)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await runTurn($)

  await clock.advance(54 * MINUTE)
  expect(compactions.length).toBe(0)
  await clock.advance(2 * MINUTE)
  expect(compactions.length).toBe(1)
  await clock.advance(30 * MINUTE)
  expect(compactions.length).toBe(1)
})

test('/cache off stops this session compacting', { options: { ttl: '1h' } }, async ($, on) => {
  const compactions: string[] = []
  world(on, compactions)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const off = await $.command.run({
    command: 'cache',
    args: 'off',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  } as never)
  expect(off.text).toContain('off for this session')
  await runTurn($)
  await clock.advance(70 * MINUTE)
  expect(compactions.length).toBe(0)
})

test('AFK on a 5m cache compacts before it lapses', { options: { ttl: '5m' } }, async ($, on) => {
  const compactions: string[] = []
  world(on, compactions)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const said = await $.tool.call({ tool: 'mcp__claude-cache__afk', away: true } as never)
  expect(JSON.stringify(said)).toContain('AFK on')
  await runTurn($)
  await clock.advance(3 * MINUTE)
  expect(compactions.length).toBe(0)
  await clock.advance(MINUTE + 20_000)
  expect(compactions.length).toBe(1)
})

test('a small session is left alone', { options: { ttl: '1h', minContextPercent: 95 } }, async ($, on) => {
  const compactions: string[] = []
  world(on, compactions)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await runTurn($)
  await clock.advance(58 * MINUTE)
  expect(compactions.length).toBe(0)
})

test('the band draws on terminal and desktop and its Auto button flips the session', { options: { ttl: '1h' } }, async ($, on) => {
  const compactions: string[] = []
  world(on, compactions)
  mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await runTurn($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'claude-cache',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 },
    } as never)
    expect(await ui.find({ type: 'Text', text: /1h warm/ })).toBeDefined()
    const before = (await ui.find({ key: 'auto' }))?.text
    await ui.press({ key: 'auto' })
    const after = (await ui.find({ key: 'auto' }))?.text
    expect(before).not.toBe(after)
    await ui.unmount()
  }
})

test('a failed compaction is tried once per idle period, not every tick', { options: { ttl: '1h' } }, async ($, on) => {
  const calls: string[] = []
  world(on, calls, true)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await runTurn($)
  await clock.advance(59 * MINUTE)
  expect(calls.length).toBe(1)
})

test('withNote folds the note into the instructions and stamps its time', () => {
  const n = { text: 'Ship the parser.', source: 'you' as const, at: 0 }
  expect(withNote(null, 'keep paths')).toBe('keep paths')
  expect(withNote(n, 'keep paths')).toContain('keep paths\n\nHandoff note written by the user')
  expect(withNote(n, undefined)).toContain('Ship the parser.')
})

test('/cache afk <text> saves the note and the AFK compaction carries it', { options: { ttl: '1h' } }, async ($, on) => {
  const compactions: string[] = []
  world(on, compactions)
  mock.store(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await runTurn($)
  const said = await $.command.run(run('afk finish the migration, then run the e2e suite'))
  expect(said.text).toContain('finish the migration')
  await clock.advance(57 * MINUTE)
  expect(compactions.length).toBe(1)
  expect(compactions[0]).toContain('finish the migration, then run the e2e suite')
})

test('/cache afk with no text has the model write the note from the warm cache', { options: { ttl: '1h' } }, async ($, on) => {
  const compactions: string[] = []
  world(on, compactions)
  mock.store(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await runTurn($)
  const said = await $.command.run(run('afk'))
  expect(said.text).toContain('step 3 of 5')
  await clock.advance(57 * MINUTE)
  expect(compactions[0]).toContain('step 3 of 5')
})

test('a manual /compact carries the note too', async ($, on) => {
  const compactions: string[] = []
  world(on, compactions)
  mock.store(on)
  mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run(run('note keep the retry budget at 3'))
  await $.session.compact({ trigger: 'manual', instructions: 'focus on tests', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never)
  expect(compactions[0]).toContain('focus on tests')
  expect(compactions[0]).toContain('keep the retry budget at 3')
  await $.command.run(run('note clear'))
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never)
  expect(compactions[1]).toBe('')
})

test('isWarm leaves 30 seconds for the request to start', () => {
  expect(isWarm(null, '1h', 0)).toBe(false)
  expect(isWarm(0, '1h', 59 * MINUTE)).toBe(true)
  expect(isWarm(0, '1h', 60 * MINUTE - 30_000)).toBe(false)
  expect(isWarm(0, '5m', 4 * MINUTE + 29_000)).toBe(true)
})

test('a session whose timer missed the warm window never compacts cold', { options: { ttl: '1h' } }, async ($, on) => {
  const compactions: string[] = []
  world(on, compactions)
  mock.store(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run(run('off'))
  await runTurn($)
  await clock.advance(61 * MINUTE)
  // auto comes back on after the cache lapsed: the next tick must not compact cold
  await $.command.run(run('on'))
  await clock.advance(MINUTE)
  expect(compactions.length).toBe(0)
  const said = await $.command.run(run('compact'))
  expect(said.text).toContain('cold')
  expect(compactions.length).toBe(0)
})

test('/cache compact answers at once and compacts after the command hook returns', { options: { ttl: '1h' } }, async ($, on) => {
  const compactions: string[] = []
  world(on, compactions)
  mock.store(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await runTurn($)
  await clock.advance(MINUTE)
  const said = await $.command.run(run('compact'))
  expect(said.text).toContain('compacting while the cache is warm')
  expect(compactions.length).toBe(0)
  await clock.settle()
  expect(compactions.length).toBe(1)
  const again = await $.command.run(run('compact'))
  expect(again.text).toContain('already compacted')
})

test('transcriptPath matches where Claude Code writes transcripts', () => {
  expect(transcriptPath('/Users/a', '/Users/a/work/opensource/claude-cache', 'abc')).toBe(
    '/Users/a/.claude/projects/-Users-a-work-opensource-claude-cache/abc.jsonl',
  )
})

test('two compaction requests in a row produce one compaction', { options: { ttl: '1h' } }, async ($, on) => {
  const compactions: string[] = []
  world(on, compactions)
  mock.store(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await runTurn($)
  await clock.advance(MINUTE)
  await $.command.run(run('compact'))
  await $.command.run(run('compact'))
  await clock.settle()
  expect(compactions.length).toBe(1)
})

test('after any compaction the next one waits for new conversation, not for a clock', { options: { ttl: '1h', compactAfterMinutes: 5 } }, async ($, on) => {
  const compactions: string[] = []
  world(on, compactions)
  mock.store(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await runTurn($)
  // the person runs /compact themselves
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never)
  expect(compactions.length).toBe(1)
  expect((await $.command.run(run('compact'))).text).toContain('already compacted')
  // nothing happens for two hours: no second compaction
  await clock.advance(120 * MINUTE)
  expect(compactions.length).toBe(1)
  // the agent works again: one turn is enough to make a compaction worth it, with no waiting period
  await runTurn($)
  expect((await $.command.run(run('compact'))).text).toContain('compacting while the cache is warm')
  await clock.settle()
  expect(compactions.length).toBe(2)
})

test('the idle timer compacts once and then stays quiet through the rest of the window', { options: { ttl: '1h', compactAfterMinutes: 5 } }, async ($, on) => {
  const compactions: string[] = []
  world(on, compactions)
  mock.store(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await runTurn($)
  await clock.advance(6 * MINUTE)
  expect(compactions.length).toBe(1)
  await clock.advance(120 * MINUTE)
  expect(compactions.length).toBe(1)
})

test('contextPercent is the context over the window', () => {
  expect(contextPercent({ contextTokens: 60_000, contextWindow: 200_000 })).toBe(30)
  expect(contextPercent({ contextTokens: 1, contextWindow: 0 })).toBe(0)
})

test('auto-compact waits for 30% of the window', { options: { ttl: '1h', compactAfterMinutes: 5 } }, async ($, on) => {
  const compactions: string[] = []
  // a 1M window: the 182k session is 18%, under the default 30%
  world(on, compactions, false, 1_000_000)
  mock.store(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await runTurn($)
  await clock.advance(10 * MINUTE)
  expect(compactions.length).toBe(0)
  // an explicit /cache compact is the person's call and ignores the floor
  expect((await $.command.run(run('compact'))).text).toContain('compacting while the cache is warm')
})
