import {
  readLastClaudeMessageThroughput,
  type ClaudeMessageThroughput
} from '../../shared/agent-hook-listener/claude-transcript-throughput'
import { parseAgentHookJson } from '../../shared/agent-hook-listener/request-body'
import {
  computeTokensPerSecond,
  type AgentThroughputSample
} from '../../shared/agent-throughput-types'

// Why: each fires once an assistant message is complete; the post-tool events double as a retry for
// a transcript row that was still unflushed when PreToolUse arrived.
const CLAUDE_MESSAGE_COMPLETE_EVENTS: ReadonlySet<string> = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Stop',
  'StopFailure',
  'SubagentStop',
  'PostCompact'
])

type PaneThroughputState = {
  lastMessageId: string | null
  turnOutputTokens: number
  turnGenerationMs: number
  turnMessageCount: number
  sample: AgentThroughputSample | null
}

export type AgentThroughputListener = (sample: AgentThroughputSample) => void
export type AgentThroughputClearListener = (paneKey: string) => void

type AgentThroughputTrackerDependencies = {
  now?: () => number
  readTranscript?: (transcriptPath: string) => ClaudeMessageThroughput | undefined
}

/** `transcript_path` from a Claude hook envelope; the payload arrives as JSON text or an object. */
export function readClaudeHookTranscriptPath(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return null
  }
  const rawPayload = (body as Record<string, unknown>).payload
  let payload: unknown = rawPayload
  if (typeof rawPayload === 'string') {
    try {
      payload = parseAgentHookJson(rawPayload)
    } catch {
      return null
    }
  }
  if (typeof payload !== 'object' || payload === null) {
    return null
  }
  const transcriptPath = (payload as Record<string, unknown>).transcript_path
  return typeof transcriptPath === 'string' && transcriptPath.length > 0 ? transcriptPath : null
}

function createPaneState(): PaneThroughputState {
  return {
    lastMessageId: null,
    turnOutputTokens: 0,
    turnGenerationMs: 0,
    turnMessageCount: 0,
    sample: null
  }
}

/**
 * Per-pane generation throughput derived from Claude Code transcripts on the local hook path.
 * Remote panes (relay/SSH ingest) produce no samples: their transcripts live on the execution host.
 */
export class AgentThroughputTracker {
  private readonly panes = new Map<string, PaneThroughputState>()
  private listener: AgentThroughputListener | null = null
  private clearListener: AgentThroughputClearListener | null = null
  private readonly now: () => number
  private readonly readTranscript: (transcriptPath: string) => ClaudeMessageThroughput | undefined

  constructor(dependencies: AgentThroughputTrackerDependencies = {}) {
    this.now = dependencies.now ?? Date.now
    this.readTranscript = dependencies.readTranscript ?? readLastClaudeMessageThroughput
  }

  setListener(listener: AgentThroughputListener | null): void {
    this.listener = listener
  }

  setClearListener(listener: AgentThroughputClearListener | null): void {
    this.clearListener = listener
  }

  getSnapshot(): AgentThroughputSample[] {
    const samples: AgentThroughputSample[] = []
    for (const pane of this.panes.values()) {
      if (pane.sample) {
        samples.push(pane.sample)
      }
    }
    return samples
  }

  observeClaudeHook(args: {
    paneKey: string
    hookEventName: string | undefined
    body: unknown
  }): void {
    const { paneKey, hookEventName } = args
    if (!hookEventName) {
      return
    }
    if (hookEventName === 'SessionStart') {
      this.clear(paneKey)
      return
    }
    if (hookEventName === 'UserPromptSubmit') {
      this.startTurn(paneKey)
      return
    }
    // Why: with nothing listening (headless serve, window closed) skip the transcript read entirely.
    if (!this.listener || !CLAUDE_MESSAGE_COMPLETE_EVENTS.has(hookEventName)) {
      return
    }
    const transcriptPath = readClaudeHookTranscriptPath(args.body)
    if (!transcriptPath) {
      return
    }
    const message = this.readTranscript(transcriptPath)
    if (!message) {
      return
    }
    const pane = this.panes.get(paneKey) ?? createPaneState()
    if (pane.lastMessageId === message.messageId) {
      return
    }
    pane.lastMessageId = message.messageId
    pane.turnOutputTokens += message.outputTokens
    pane.turnGenerationMs += message.generationMs
    pane.turnMessageCount += 1
    pane.sample = {
      paneKey,
      messageId: message.messageId,
      model: message.model,
      outputTokens: message.outputTokens,
      generationMs: message.generationMs,
      tokensPerSecond: computeTokensPerSecond(message.outputTokens, message.generationMs),
      completedAt: message.completedAt,
      turnOutputTokens: pane.turnOutputTokens,
      turnGenerationMs: pane.turnGenerationMs,
      turnMessageCount: pane.turnMessageCount,
      observedAt: this.now()
    }
    this.panes.set(paneKey, pane)
    this.emit(pane.sample)
  }

  clear(paneKey: string): void {
    if (this.panes.delete(paneKey)) {
      this.clearListener?.(paneKey)
    }
  }

  clearAll(): void {
    for (const paneKey of Array.from(this.panes.keys())) {
      this.clear(paneKey)
    }
  }

  private startTurn(paneKey: string): void {
    const pane = this.panes.get(paneKey)
    if (!pane) {
      return
    }
    pane.turnOutputTokens = 0
    pane.turnGenerationMs = 0
    pane.turnMessageCount = 0
    if (pane.sample) {
      // Why: keep the last reading visible across the turn boundary, but drop the previous turn's totals now.
      pane.sample = {
        ...pane.sample,
        turnOutputTokens: 0,
        turnGenerationMs: 0,
        turnMessageCount: 0,
        observedAt: this.now()
      }
      this.emit(pane.sample)
    }
  }

  private emit(sample: AgentThroughputSample): void {
    try {
      this.listener?.(sample)
    } catch (err) {
      console.error('[agent-hooks] throughput listener threw', err)
    }
  }
}

export const agentThroughputTracker = new AgentThroughputTracker()
