/**
 * Generation throughput of one pane's agent, measured per completed assistant
 * message from the provider transcript. Claude Code writes token usage and a
 * timestamp per message; no provider surface exposes intra-message counts, so a
 * sample only changes when a message completes.
 */
export type AgentThroughputSample = {
  paneKey: string
  /** Provider-owned assistant message id the sample was measured on. */
  messageId: string
  model: string | null
  outputTokens: number
  /** Wall-clock ms from the transcript record preceding the message to its last row. */
  generationMs: number
  tokensPerSecond: number
  /** Epoch ms of the message's last transcript row. */
  completedAt: number
  /** Output tokens, generation ms, and message count accumulated since the turn's prompt. */
  turnOutputTokens: number
  turnGenerationMs: number
  turnMessageCount: number
  /** Epoch ms when the hook server observed the sample; orders pushes against snapshots. */
  observedAt: number
}

export type AgentThroughputClearIpcPayload = { paneKey: string }

export function computeTokensPerSecond(outputTokens: number, generationMs: number): number {
  if (!(outputTokens > 0) || !(generationMs > 0)) {
    return 0
  }
  return (outputTokens * 1000) / generationMs
}
