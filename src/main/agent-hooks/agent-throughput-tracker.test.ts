import { describe, expect, it, vi } from 'vitest'
import type { ClaudeMessageThroughput } from '../../shared/agent-hook-listener/claude-transcript-throughput'
import { AgentThroughputTracker, readClaudeHookTranscriptPath } from './agent-throughput-tracker'

const PANE = 'tab-1:0f7c1b2e-3d4a-4c5b-8e6f-7a8b9c0d1e2f'

function hookBody(hookEventName: string, transcriptPath = 'C:/transcripts/session.jsonl'): unknown {
  return {
    paneKey: PANE,
    payload: JSON.stringify({ hook_event_name: hookEventName, transcript_path: transcriptPath })
  }
}

function message(overrides: Partial<ClaudeMessageThroughput> = {}): ClaudeMessageThroughput {
  return {
    messageId: 'msg_1',
    model: 'claude-fable-5-1',
    outputTokens: 500,
    generationMs: 10_000,
    completedAt: 1_000,
    ...overrides
  }
}

function observe(tracker: AgentThroughputTracker, hookEventName: string): void {
  tracker.observeClaudeHook({ paneKey: PANE, hookEventName, body: hookBody(hookEventName) })
}

describe('AgentThroughputTracker', () => {
  it('emits one sample per new message and dedupes repeated reads of the same message', () => {
    const readTranscript = vi.fn().mockReturnValue(message())
    const tracker = new AgentThroughputTracker({ now: () => 42, readTranscript })
    const listener = vi.fn()
    tracker.setListener(listener)

    observe(tracker, 'PreToolUse')
    observe(tracker, 'PostToolUse')

    expect(readTranscript).toHaveBeenCalledTimes(2)
    expect(readTranscript).toHaveBeenCalledWith('C:/transcripts/session.jsonl')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0]).toEqual({
      paneKey: PANE,
      messageId: 'msg_1',
      model: 'claude-fable-5-1',
      outputTokens: 500,
      generationMs: 10_000,
      tokensPerSecond: 50,
      completedAt: 1_000,
      turnOutputTokens: 500,
      turnGenerationMs: 10_000,
      turnMessageCount: 1,
      observedAt: 42
    })
    expect(tracker.getSnapshot()).toHaveLength(1)
  })

  it('accumulates the turn across messages and resets it on the next prompt', () => {
    const readTranscript = vi
      .fn()
      .mockReturnValueOnce(message())
      .mockReturnValueOnce(message({ messageId: 'msg_2', outputTokens: 200, generationMs: 5_000 }))
    const tracker = new AgentThroughputTracker({ now: () => 7, readTranscript })
    const listener = vi.fn()
    tracker.setListener(listener)

    observe(tracker, 'PreToolUse')
    observe(tracker, 'Stop')
    expect(listener.mock.calls[1][0]).toMatchObject({
      messageId: 'msg_2',
      tokensPerSecond: 40,
      turnOutputTokens: 700,
      turnGenerationMs: 15_000,
      turnMessageCount: 2
    })

    observe(tracker, 'UserPromptSubmit')
    expect(readTranscript).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenCalledTimes(3)
    // Why: the last reading stays visible across the turn boundary; only the totals restart.
    expect(listener.mock.calls[2][0]).toMatchObject({
      messageId: 'msg_2',
      tokensPerSecond: 40,
      turnOutputTokens: 0,
      turnGenerationMs: 0,
      turnMessageCount: 0
    })
  })

  it('skips the transcript read without a listener or for non-completion events', () => {
    const readTranscript = vi.fn().mockReturnValue(message())
    const tracker = new AgentThroughputTracker({ readTranscript })

    observe(tracker, 'Stop')
    tracker.setListener(vi.fn())
    observe(tracker, 'SubagentStart')
    observe(tracker, 'Notification')
    tracker.observeClaudeHook({ paneKey: PANE, hookEventName: undefined, body: hookBody('Stop') })
    tracker.observeClaudeHook({ paneKey: PANE, hookEventName: 'Stop', body: { paneKey: PANE } })

    expect(readTranscript).not.toHaveBeenCalled()
    expect(tracker.getSnapshot()).toEqual([])
  })

  it('clears a pane on SessionStart and on explicit clear', () => {
    const tracker = new AgentThroughputTracker({ readTranscript: () => message() })
    const clearListener = vi.fn()
    tracker.setListener(vi.fn())
    tracker.setClearListener(clearListener)

    observe(tracker, 'Stop')
    observe(tracker, 'SessionStart')
    expect(clearListener).toHaveBeenCalledWith(PANE)
    expect(tracker.getSnapshot()).toEqual([])

    tracker.clear(PANE)
    expect(clearListener).toHaveBeenCalledTimes(1)

    observe(tracker, 'Stop')
    tracker.clearAll()
    expect(clearListener).toHaveBeenCalledTimes(2)
  })

  it('survives a throwing listener', () => {
    const tracker = new AgentThroughputTracker({ readTranscript: () => message() })
    tracker.setListener(() => {
      throw new Error('boom')
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => observe(tracker, 'Stop')).not.toThrow()
      expect(tracker.getSnapshot()).toHaveLength(1)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('reads transcript_path from string and object payloads', () => {
    expect(readClaudeHookTranscriptPath(hookBody('Stop', '/tmp/t.jsonl'))).toBe('/tmp/t.jsonl')
    expect(
      readClaudeHookTranscriptPath({ paneKey: PANE, payload: { transcript_path: '/tmp/o.jsonl' } })
    ).toBe('/tmp/o.jsonl')
    expect(readClaudeHookTranscriptPath({ paneKey: PANE, payload: '{not json' })).toBe(null)
    expect(readClaudeHookTranscriptPath({ paneKey: PANE, payload: { transcript_path: '' } })).toBe(
      null
    )
    expect(readClaudeHookTranscriptPath('nope')).toBe(null)
  })
})
