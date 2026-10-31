import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { deriveTurnTokenUsage } from '../src/turn-usage.ts'

function event(type: string, seq: number, data: object): SessionEvent {
  return { type, seq, time: seq, data } as unknown as SessionEvent
}
function sequence(silentRetry = false, recovered = false): SessionEvent[] {
  const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
  const attempt = (seq: number) => event('assistant/attempt', seq, {
    turn: 1, step: 1, stream: [{ type: 'chunk', time: seq, chunk: { type: 'usage', usage } }],
  })
  const result = [
    event('turn/start', 0, { turn: 1 }),
    event('step/start', 1, { turn: 1, step: 1 }),
    attempt(2),
    ...silentRetry ? [attempt(3)] : [],
    event('step/end', 4, { turn: 1, step: 1 }),
    event('turn/end', 5, { turn: 1, reason: { kind: 'error' } }),
  ]
  if (recovered) result.push(event('assistant/message', 6, {
    turn: 1, step: 1,
    recovery: { sourceAttemptSeq: 2, reason: 'upstream-failure' },
    message: { role: 'assistant', source: { provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text: 'fixture' }] },
    stream: [],
  }))
  return result
}

describe('Recovered assistant transcript is not a provider attempt', () => {
  it('leaves single-attempt usage unchanged', () => {
    expect(deriveTurnTokenUsage(sequence(false, false))?.totalTokens).toBe(15)
    expect(deriveTurnTokenUsage(sequence(false, true))?.totalTokens).toBe(15)
  })
  it('does not disguise a pre-existing silent retry lifecycle conflict', () => {
    expect(deriveTurnTokenUsage(sequence(true, false))).toBeUndefined()
    expect(deriveTurnTokenUsage(sequence(true, true))).toBeUndefined()
  })
})
