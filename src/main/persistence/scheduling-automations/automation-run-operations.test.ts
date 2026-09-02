import { describe, expect, it } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { listAutomationRunsPage } from './automation-run-operations'

describe('listAutomationRunsPage', () => {
  it('returns a bounded, newest-first page and an opaque continuation cursor', () => {
    const state = {
      automationRuns: [
        { id: 'old', automationId: 'a1', createdAt: 1 },
        { id: 'new', automationId: 'a1', createdAt: 3 },
        { id: 'middle', automationId: 'a1', createdAt: 2 }
      ]
    } as PersistedState

    const first = listAutomationRunsPage(state, 'a1', 2)
    expect(first.runs.map((run) => run.id)).toEqual(['new', 'middle'])
    expect(first.nextCursor).toBe('2')

    expect(listAutomationRunsPage(state, 'a1', 2, first.nextCursor ?? undefined)).toEqual(
      expect.objectContaining({
        runs: [expect.objectContaining({ id: 'old' })],
        nextCursor: null
      })
    )
  })
})
