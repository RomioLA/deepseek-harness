import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as recoveryPlugin from '../../../../../../src/index.js'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const errorText = (text: string) => [
  ...textResponse(text).slice(0, -1),
  { type: 'finish' as const, reason: { kind: 'error' as const, failure: {
    message: 'synthetic failure', code: 'CONTENT_FILTER',
  } } },
]
let count = 0
async function harness(script: ConstructorParameters<typeof MockAdapter>[0]) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('recovery-' + (++count)), { provider: 'mock', model: 'mock' })
  return { ctx, adapter, agent }
}
function send(agent: Awaited<ReturnType<typeof harness>>['agent'], text = 'go') {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}
describe('real Agent Loop Recovery integration', () => {
  it('restores terminal failure and adds text to actual next model request', async () => {
    const { ctx, adapter, agent } = await harness([errorText('retained visible text'), textResponse('done')])
    await ctx.plugin(recoveryPlugin)
    let settled = 0
    ctx.on('agent/failed-turn-settled', () => { settled++ })
    send(agent)
    await agent.whenIdle()
    const events = agent.session.snapshotEvents()
    expect(settled).toBe(1)
    expect(events.filter(e => e.type === 'assistant/attempt')).toHaveLength(1)
    expect(events.find(e => e.type === 'turn/end')?.data.reason.kind).toBe('error')
    expect(events.filter(e => e.type === 'assistant/message')).toHaveLength(1)
    send(agent, 'another turn')
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('retained visible text')
  })
  it('does not restore a failure draft if silent retry succeeds', async () => {
    const { ctx, agent } = await harness([errorText('draft'), textResponse('success')])
    await ctx.plugin(recoveryPlugin)
    let retries = 0
    ctx.on('agent/request-error', async () => {
      if (retries++ === 0) return { kind: 'retry' as const }
    })
    send(agent)
    await agent.whenIdle()
    expect(agent.session.snapshotEvents().filter(e => e.type === 'assistant/attempt')).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(e => e.type === 'assistant/message')).toHaveLength(1)
    expect(JSON.stringify(agent.session.deriveMessages())).not.toContain('draft')
  })
  it('selects longest visible attempt after two terminal failed tries', async () => {
    const { ctx, agent } = await harness([errorText('short'), errorText('meaningful longer output')])
    await ctx.plugin(recoveryPlugin)
    let retries = 0
    ctx.on('agent/request-error', async () => {
      if (retries++ === 0) return { kind: 'retry' as const }
    })
    send(agent)
    await agent.whenIdle()
    const messages = agent.session.snapshotEvents().filter(e => e.type === 'assistant/message')
    expect(messages).toHaveLength(1)
    expect(JSON.stringify(messages)).toContain('meaningful longer output')
    expect(agent.session.snapshotEvents().filter(e => e.type === 'assistant/attempt')).toHaveLength(2)
  })
  it('contains a throwing Hook without changing the original terminal error', async () => {
    const { ctx, agent } = await harness([errorText('one')])
    ctx.on('agent/failed-turn-settled', () => { throw new Error('synthetic hook exception') })
    send(agent)
    await agent.whenIdle()
    expect(agent.session.snapshotEvents().find(e => e.type === 'turn/end')?.data.reason.kind).toBe('error')
  })
  it('waits for a slow Hook before assembling the next model request', async () => {
    const { ctx, adapter, agent } = await harness([errorText('delayed visible output'), textResponse('done')])
    await ctx.plugin(recoveryPlugin)
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    ctx.on('agent/failed-turn-settled', async () => { entered(); await gate })
    send(agent)
    await started
    send(agent, 'follow up')
    expect(adapter.requests).toHaveLength(1)
    release()
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('delayed visible output')
  })
})
