import type { AgentHookSource } from '../../shared/agent-hook-relay'
import { readLastClaudeMessageThroughput } from '../../shared/agent-hook-listener/claude-transcript-throughput'
import { readLastCodexMessageThroughput } from '../../shared/agent-hook-listener/codex-transcript-throughput'
import { readLastGeminiMessageThroughput } from '../../shared/agent-hook-listener/gemini-chat-throughput'
import { parseHookBodyPayloadRecord } from '../../shared/agent-hook-listener/grok-result-discovery'
import { readFirstString } from '../../shared/agent-hook-listener/interactive-tool'
import {
  computeTokensPerSecond,
  type AgentMessageThroughput,
  type AgentThroughputSample
} from '../../shared/agent-throughput-types'
import { readLastOpenCodeMessageThroughput } from '../opencode/opencode-message-throughput'

export type ThroughputHookAction = 'reset' | 'new-turn' | 'measure' | 'measure-streaming' | 'ignore'

export type AgentThroughputSourceProfile = {
  classify: (hookEventName: string, payload: Record<string, unknown>) => ThroughputHookAction
  read: (
    payload: Record<string, unknown>
  ) => AgentMessageThroughput | undefined | Promise<AgentMessageThroughput | undefined>
  /** Floor between `measure-streaming` reads; those events fire while a message is still streaming. */
  streamingReadIntervalMs?: number
}

// Why: each fires once a message is complete; the post-tool events double as a retry for a
// transcript row that was still unflushed when the pre-tool event arrived.
const CLAUDE_STYLE_COMPLETE_EVENTS: ReadonlySet<string> = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Stop',
  'StopFailure',
  'SubagentStop',
  'PostCompact'
])
const GEMINI_COMPLETE_EVENTS: ReadonlySet<string> = new Set([
  'BeforeTool',
  'AfterTool',
  'AfterAgent'
])
const OPENCODE_COMPLETE_EVENTS: ReadonlySet<string> = new Set([
  'SessionIdle',
  'PermissionRequest',
  'AskUserQuestion'
])
const OPENCODE_STREAMING_READ_INTERVAL_MS = 1_500

function classifyClaudeStyleHook(hookEventName: string): ThroughputHookAction {
  if (hookEventName === 'SessionStart') {
    return 'reset'
  }
  if (hookEventName === 'UserPromptSubmit') {
    return 'new-turn'
  }
  return CLAUDE_STYLE_COMPLETE_EVENTS.has(hookEventName) ? 'measure' : 'ignore'
}

function readTranscriptPath(payload: Record<string, unknown>): string | null {
  return readFirstString(payload, ['transcript_path', 'transcriptPath']) ?? null
}

function readWithTranscript(
  read: (transcriptPath: string) => AgentMessageThroughput | undefined
): AgentThroughputSourceProfile['read'] {
  return (payload) => {
    const transcriptPath = readTranscriptPath(payload)
    return transcriptPath ? read(transcriptPath) : undefined
  }
}

const OPENCODE_PROFILE: AgentThroughputSourceProfile = {
  classify: (hookEventName, payload) => {
    if (hookEventName === 'SessionStart') {
      return 'reset'
    }
    if (hookEventName === 'MessagePart') {
      return payload.role === 'user'
        ? 'new-turn'
        : payload.role === 'assistant'
          ? 'measure-streaming'
          : 'ignore'
    }
    return OPENCODE_COMPLETE_EVENTS.has(hookEventName) ? 'measure' : 'ignore'
  },
  read: (payload) => {
    const sessionId = readFirstString(payload, ['sessionID', 'sessionId', 'session_id'])
    return sessionId ? readLastOpenCodeMessageThroughput(sessionId) : undefined
  },
  streamingReadIntervalMs: OPENCODE_STREAMING_READ_INTERVAL_MS
}

/** Sources with a per-message token record Orca can reach; the rest expose no token counts. */
export const AGENT_THROUGHPUT_SOURCE_PROFILES: Partial<
  Record<AgentHookSource, AgentThroughputSourceProfile>
> = {
  claude: {
    classify: classifyClaudeStyleHook,
    read: readWithTranscript(readLastClaudeMessageThroughput)
  },
  codex: {
    classify: classifyClaudeStyleHook,
    read: readWithTranscript(readLastCodexMessageThroughput)
  },
  gemini: {
    classify: (hookEventName) => {
      if (hookEventName === 'SessionStart') {
        return 'reset'
      }
      if (hookEventName === 'BeforeAgent') {
        return 'new-turn'
      }
      return GEMINI_COMPLETE_EVENTS.has(hookEventName) ? 'measure' : 'ignore'
    },
    read: readWithTranscript(readLastGeminiMessageThroughput)
  },
  opencode: OPENCODE_PROFILE,
  'mimo-code': OPENCODE_PROFILE
}

type PaneThroughputState = {
  lastMessageId: string | null
  turnOutputTokens: number
  turnGenerationMs: number
  turnMessageCount: number
  sample: AgentThroughputSample | null
  /** Clock of the last record read; null until the first one so a young clock is not throttled. */
  lastReadAt: number | null
  readSequence: number
}

export type AgentThroughputListener = (sample: AgentThroughputSample) => void
export type AgentThroughputClearListener = (paneKey: string) => void

type AgentThroughputTrackerDependencies = {
  now?: () => number
  profiles?: Partial<Record<AgentHookSource, AgentThroughputSourceProfile>>
}

function createPaneState(): PaneThroughputState {
  return {
    lastMessageId: null,
    turnOutputTokens: 0,
    turnGenerationMs: 0,
    turnMessageCount: 0,
    sample: null,
    lastReadAt: null,
    readSequence: 0
  }
}

/**
 * Per-pane generation throughput derived from each agent's own session record on the local hook
 * path. Remote panes (relay/SSH ingest) produce no samples: their records live on the execution host.
 */
export class AgentThroughputTracker {
  private readonly panes = new Map<string, PaneThroughputState>()
  private listener: AgentThroughputListener | null = null
  private clearListener: AgentThroughputClearListener | null = null
  private readonly now: () => number
  private readonly profiles: Partial<Record<AgentHookSource, AgentThroughputSourceProfile>>

  constructor(dependencies: AgentThroughputTrackerDependencies = {}) {
    this.now = dependencies.now ?? Date.now
    this.profiles = dependencies.profiles ?? AGENT_THROUGHPUT_SOURCE_PROFILES
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

  async observeHook(args: {
    source: AgentHookSource
    paneKey: string
    hookEventName: string | undefined
    body: unknown
  }): Promise<void> {
    const { source, paneKey, hookEventName } = args
    const profile = this.profiles[source]
    if (!profile || !hookEventName) {
      return
    }
    const payload = parseHookBodyPayloadRecord(args.body) ?? {}
    const action = profile.classify(hookEventName, payload)
    if (action === 'reset') {
      this.clear(paneKey)
      return
    }
    if (action === 'new-turn') {
      this.startTurn(paneKey)
      return
    }
    // Why: with nothing listening (headless serve, window closed) skip the record read entirely.
    if (action === 'ignore' || !this.listener) {
      return
    }
    const pane = this.panes.get(paneKey) ?? createPaneState()
    this.panes.set(paneKey, pane)
    const now = this.now()
    if (
      action === 'measure-streaming' &&
      profile.streamingReadIntervalMs !== undefined &&
      pane.lastReadAt !== null &&
      now - pane.lastReadAt < profile.streamingReadIntervalMs
    ) {
      return
    }
    pane.lastReadAt = now
    const readSequence = ++pane.readSequence
    let message: AgentMessageThroughput | undefined
    try {
      message = await profile.read(payload)
    } catch (err) {
      console.error('[agent-hooks] throughput read failed', err)
      return
    }
    // Why: a slower read must not overwrite a newer one, and a cleared pane must stay cleared.
    if (!message || this.panes.get(paneKey) !== pane || pane.readSequence !== readSequence) {
      return
    }
    if (pane.lastMessageId === message.messageId) {
      return
    }
    pane.lastMessageId = message.messageId
    pane.turnOutputTokens += message.outputTokens
    pane.turnGenerationMs += message.generationMs
    pane.turnMessageCount += 1
    pane.sample = {
      paneKey,
      agentType: source,
      messageId: message.messageId,
      model: message.model ?? readFirstString(payload, ['model']) ?? null,
      outputTokens: message.outputTokens,
      generationMs: message.generationMs,
      tokensPerSecond: computeTokensPerSecond(message.outputTokens, message.generationMs),
      completedAt: message.completedAt,
      turnOutputTokens: pane.turnOutputTokens,
      turnGenerationMs: pane.turnGenerationMs,
      turnMessageCount: pane.turnMessageCount,
      observedAt: this.now()
    }
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
