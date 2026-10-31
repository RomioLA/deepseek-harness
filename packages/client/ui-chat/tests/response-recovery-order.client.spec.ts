import { describe, expect, it } from 'vitest'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ChatSnapshot } from '../src/client/contract/snapshot.ts'
import type { TurnTailChatData } from '../src/client/contract/chat-nodes.ts'
import { assistantDefinition } from '../src/client/conversation-nodes/assistant.ts'
import { turnProcessDefinition } from '../src/client/conversation-nodes/turn-process.ts'
import { turnTailDefinition } from '../src/client/conversation-nodes/turn-tail.ts'
import { chatViewDefinition } from '../src/client/conversation-nodes/chat-snapshot-builder.ts'

function entry(type: SessionEvent['type'], seq: number, data: object, surfaceOp?: 'append'): SessionLiveEventEntry {
  const event = { type, seq: SessionSeq(seq), time: 1000+seq, data, ...surfaceOp ? { surfaceOp } : {} } as SessionEvent
  return { type: 'event', event }
}
const before = [
  entry('turn/start',0,{ turn:1 }),
  entry('step/start',1,{ turn:1,step:1 }),
  entry('assistant/attempt',2,{ turn:1,step:1,stream:[{ type:'text-chunks',index:0,time0:1,dt:[0],texts:['original streamed text'] }] }),
  entry('step/end',3,{ turn:1,step:1 }),
  entry('turn/end',4,{ turn:1,reason:{ kind:'error',error:{ code:'MOCK',message:'synthetic error' } } }),
]
const recovery = entry('assistant/message',5,{ turn:1,step:1,stream:[],
  message:createAssistantMessage({ source:{ provider:'mock',model:'mock' },content:[{ type:'text',text:'original streamed text' }] }),
  recovery:{ sourceAttemptSeq:SessionSeq(2),reason:'upstream-failure' },
},'append')
function harness(entries: readonly SessionLiveEventEntry[]) {
  const a=new ConversationNodeAssembler(
    { entries:()=>[assistantDefinition,turnProcessDefinition,turnTailDefinition],fallbackEntry:()=>undefined },
    { entries:()=>[chatViewDefinition] },
  )
  a.replaceWindow(entries,false)
  a.activateTarget('chat')
  return { a,read:()=>{a.flush();return a.snapshot('chat') as ChatSnapshot} }
}
describe('Recovery inserted after turn/end in native conversation assembler',()=>{
  it('updates the same Assistant node, orders before Turn Tail and preserves error',()=>{
    const h=harness(before)
    const initial=h.read()
    expect(initial.nodes.values().some(x=>x.kind==='assistant-step' && x.visibility==='visible')).toBe(false)
    h.a.append(recovery)
    const updated=h.read()
    const assistant=[...updated.nodes.values()].find(x=>x.kind==='assistant-step')!
    const footer=[...updated.nodes.values()].find(x=>x.kind==='turn-tail')!
    expect(assistant.visibility).toBe('visible')
    expect(assistant.anchorSeq).toBeLessThan(footer.anchorSeq)
    expect(updated.order.indexOf(assistant.key)).toBeLessThan(updated.order.indexOf(footer.key))
    expect(updated.timeline.turns.get(1)?.steps[0]?.data.get('assistant-step')?.finalNode?.interrupted).toBe(true)
    expect((footer.data as TurnTailChatData).branchUnavailable).toBe(true)
    const reloaded=harness([...before,recovery]).read()
    expect(reloaded.order).toEqual(updated.order)
    expect(reloaded.nodes.get(assistant.key)?.data).toEqual(assistant.data)
    expect([...updated.nodes.values()].filter(x=>x.kind==='assistant-step')).toHaveLength(1)
  })
})
