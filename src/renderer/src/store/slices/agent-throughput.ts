import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { AgentThroughputSample } from '../../../../shared/agent-throughput-types'

export type AgentThroughputSlice = {
  agentThroughputByPaneKey: Record<string, AgentThroughputSample>
  setAgentThroughput: (sample: AgentThroughputSample) => void
  clearAgentThroughput: (paneKey: string) => void
  /** Startup catch-up: a pane keeps whichever of its push or snapshot sample was observed later. */
  mergeAgentThroughputSnapshot: (samples: AgentThroughputSample[]) => void
}

export const createAgentThroughputSlice: StateCreator<AppState, [], [], AgentThroughputSlice> = (
  set
) => ({
  agentThroughputByPaneKey: {},
  setAgentThroughput: (sample) =>
    set((s) => ({
      agentThroughputByPaneKey: { ...s.agentThroughputByPaneKey, [sample.paneKey]: sample }
    })),
  clearAgentThroughput: (paneKey) =>
    set((s) => {
      if (!(paneKey in s.agentThroughputByPaneKey)) {
        return {}
      }
      const next = { ...s.agentThroughputByPaneKey }
      delete next[paneKey]
      return { agentThroughputByPaneKey: next }
    }),
  mergeAgentThroughputSnapshot: (samples) =>
    set((s) => {
      const next = { ...s.agentThroughputByPaneKey }
      for (const sample of samples) {
        const current = next[sample.paneKey]
        if (!current || current.observedAt <= sample.observedAt) {
          next[sample.paneKey] = sample
        }
      }
      return { agentThroughputByPaneKey: next }
    })
})
