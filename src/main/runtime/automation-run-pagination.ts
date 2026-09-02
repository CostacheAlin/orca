import type { AutomationRun, AutomationRunsPage } from '../../shared/automations-types'

export function paginateAutomationRuns(
  runs: readonly AutomationRun[],
  limit?: number,
  cursor?: string
): AutomationRunsPage {
  const start = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0
  const boundedLimit = Math.min(Math.max(1, limit ?? 100), 100)
  const page = runs.slice(start, start + boundedLimit)
  return {
    runs: page,
    nextCursor: start + page.length < runs.length ? String(start + page.length) : null
  }
}
