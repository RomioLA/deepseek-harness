import { describe, expect, it } from 'vitest'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, RESPONSE_RECOVERY_CONTRACT_VERSION, type SessionEvent } from '../src/index.ts'

function setup() {
  const session = Session.create(SessionId('recovery-session-fixture'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const attempt = session.append('assistant/attempt', { turn: 1, step: 1, stream: [
    { type: 'text-chunks', index: 0, time0: 1, dt: [0], texts: ['visible original'] },
  ] })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'PI_AI_ERROR', message: 'fixture failure' } } })
  return { session, attempt }
}

function recover(session: Session, sourceAttemptSeq: ReturnType<typeof setup>['attempt']['seq'], text = 'visible original') {
  return session.append('assistant/message', {
    turn: 1, step: 1,
    message: createAssistantMessage({ content: [{ type: 'text', text }], source: {
      provider: 'fixture', model: 'fixture',
    } }),
    stream: [],
    recovery: { sourceAttemptSeq, reason: 'upstream-failure' },
  }, { surfaceOp: 'append' })
}

describe('Recovery durable Session contract', () => {
  it('advertises capability and preserves exact text on reload', () => {
    expect(RESPONSE_RECOVERY_CONTRACT_VERSION).toBe(1)
    const { session, attempt } = setup()
    recover(session, attempt.seq)
    expect(session.deriveMessages().at(-1)?.content).toEqual([{ type: 'text', text: 'visible original' }])
    const restored = Session.create(SessionId('restored-recovery'), session.snapshotEvents())
    const event = restored.snapshotEvents().find(e => e.type === 'assistant/message')
    expect(event?.type === 'assistant/message' ? event.data.recovery?.sourceAttemptSeq : undefined).toBe(attempt.seq)
    expect(restored.deriveMessages().at(-1)?.role).toBe('assistant')
  })

  it('rejects duplicate attempts and altered text without changing the durable sequence', () => {
    const { session, attempt } = setup()
    expect(() => recover(session, attempt.seq, 'unseen words')).toThrow(/must match/)
    expect(() => recover(session, attempt.seq)).not.toThrow()
    const length = session.seq
    expect(() => recover(session, attempt.seq)).toThrow(/duplicate/)
    expect(session.seq).toBe(length)
  })

  it('rejects fabricated source numbers and replays', () => {
    const { session, attempt } = setup()
    expect(() => recover(session, 0 as typeof attempt.seq)).toThrow(/source/)
    recover(session, attempt.seq)
    const corrupted = structuredClone(session.snapshotEvents()) as SessionEvent[]
    const appended = corrupted.find(e => e.type === 'assistant/message')
    if (appended?.type !== 'assistant/message') throw new Error('expected recovery event')
    appended.data.recovery = { sourceAttemptSeq: 0 as typeof attempt.seq, reason: 'upstream-failure' }
    expect(() => Session.create(SessionId('forged'), corrupted)).toThrow(/source/)
  })
})
