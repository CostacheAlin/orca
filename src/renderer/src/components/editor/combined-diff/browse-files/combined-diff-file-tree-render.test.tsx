// @vitest-environment happy-dom

import React, { act, useCallback, useMemo, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SOURCE_CONTROL_VIRTUALIZE_MIN_ROWS } from '@/components/right-sidebar/source-control/listing/virtual-file-list'
import type { GitBranchChangeEntry } from '../../../../../../shared/git-diff-compare-types'
import type { CombinedDiffFileTreeRow as CombinedDiffFileTreeRowComponent } from './combined-diff-file-tree-row'

const rowRenders = vi.hoisted(() => ({ count: 0 }))
const mountedRows = vi.hoisted(() => ({ count: 0 }))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ combinedDiffFileTreeWidth: 420, setCombinedDiffFileTreeWidth: () => {} })
}))

vi.mock('./combined-diff-file-tree-row', async (importOriginal) => {
  const actual = (await importOriginal()) as {
    CombinedDiffFileTreeRow: typeof CombinedDiffFileTreeRowComponent
  }
  const react = await import('react')
  const Row = actual.CombinedDiffFileTreeRow
  // Why: memo with React's default shallow compare, so this counts exactly the render commits
  // the real memo'd row would have performed.
  const CountingRow = react.memo((props: React.ComponentProps<typeof Row>) => {
    rowRenders.count += 1
    react.useEffect(() => {
      mountedRows.count += 1
      return () => {
        mountedRows.count -= 1
      }
    }, [])
    return react.createElement(Row, props)
  })
  return { ...actual, CombinedDiffFileTreeRow: CountingRow }
})

const { CombinedDiffFileTree } = await import('./combined-diff-file-tree')
const { createCombinedDiffSectionIndexMap } =
  await import('../resolve-changes/combined-diff-section-identity')
const { useCombinedDiffSectionIndexMap } =
  await import('../resolve-changes/use-combined-diff-section-index-map')
const { getCombinedDiffBranchEntriesInTreeOrder } = await import('./combined-diff-file-tree-filter')

const VIEWPORT_HEIGHT_PX = 600
const TREE_ROW_HEIGHT_PX = 24
const EMPTY_VIEWED_KEYS: ReadonlySet<string> = new Set()

class NoopResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  rowRenders.count = 0
  mountedRows.count = 0
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains('overflow-auto') ? VIEWPORT_HEIGHT_PX : TREE_ROW_HEIGHT_PX
    }
  )
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const height = this.classList.contains('overflow-auto')
      ? VIEWPORT_HEIGHT_PX
      : TREE_ROW_HEIGHT_PX
    return {
      top: 0,
      bottom: height,
      height,
      left: 0,
      right: 240,
      width: 240,
      x: 0,
      y: 0,
      toJSON: () => ({})
    } as DOMRect
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

type TestSection = { key: string; loading: boolean }

/** `fileCount` files spread over `directoryCount` directories, in the viewer's own tree order. */
function buildEntries(fileCount: number, directoryCount: number): GitBranchChangeEntry[] {
  const raw: GitBranchChangeEntry[] = Array.from({ length: fileCount }, (_, index) => ({
    path: `src/dir${String(index % directoryCount).padStart(2, '0')}/file-${String(index).padStart(4, '0')}.ts`,
    status: 'modified'
  }))
  return getCombinedDiffBranchEntriesInTreeOrder('commit', raw)
}

function buildSections(entries: readonly GitBranchChangeEntry[]): TestSection[] {
  return entries.map((entry) => ({ key: `combined-commit:${entry.path}`, loading: true }))
}

let loadSectionAt: (index: number) => void = () => {}

/**
 * Mirrors how both PR viewers feed the tree: an on-demand section load replaces the sections
 * array, and the navigate callback closes over the section index map.
 */
function TreeHarness({
  entries,
  initialSections,
  stableSectionIndexMap
}: {
  entries: readonly GitBranchChangeEntry[]
  initialSections: TestSection[]
  stableSectionIndexMap: boolean
}): ReactElement {
  const [sections, setSections] = useState(initialSections)
  loadSectionAt = (index) => {
    setSections((prev) =>
      prev.map((section, sectionIndex) =>
        sectionIndex === index ? { ...section, loading: false } : section
      )
    )
  }
  const rebuiltMap = useMemo(() => createCombinedDiffSectionIndexMap(sections), [sections])
  const cachedMap = useCombinedDiffSectionIndexMap({ entrySignature: 'pr-1', sections })
  const sectionIndexByKey = stableSectionIndexMap ? cachedMap : rebuiltMap
  const onNavigate = useCallback(() => {
    void sectionIndexByKey
  }, [sectionIndexByKey])

  return (
    <CombinedDiffFileTree
      mode="commit"
      worktreePath="/repo"
      entries={entries}
      sectionIndexByKey={sectionIndexByKey}
      activeSectionKey={null}
      viewedSectionKeys={EMPTY_VIEWED_KEYS}
      collapsed={false}
      onCollapsedChange={() => {}}
      onNavigate={onNavigate}
    />
  )
}

function mountedRowCount(): number {
  return mountedRows.count
}

function renderHarness(
  entries: readonly GitBranchChangeEntry[],
  sections: TestSection[],
  stableSectionIndexMap: boolean
): void {
  act(() => {
    root.render(
      <TreeHarness
        entries={entries}
        initialSections={sections}
        stableSectionIndexMap={stableSectionIndexMap}
      />
    )
  })
}

/** One section load per commit, the way lazy loads land while the user scrolls. */
function runScrollPass(loadCount: number): number {
  rowRenders.count = 0
  for (let index = 0; index < loadCount; index += 1) {
    act(() => loadSectionAt(index))
  }
  return rowRenders.count
}

describe('combined diff file tree re-renders on section loads', () => {
  const SMALL_FILE_COUNT = 30
  const SCROLL_PASS_LOADS = 10

  it('re-renders every row per section load when the section index map is rebuilt', () => {
    const entries = buildEntries(SMALL_FILE_COUNT, 3)
    renderHarness(entries, buildSections(entries), false)
    const rowCount = mountedRowCount()
    expect(rowCount).toBeGreaterThan(SMALL_FILE_COUNT)

    expect(runScrollPass(SCROLL_PASS_LOADS)).toBe(rowCount * SCROLL_PASS_LOADS)
  })

  it('re-renders no rows per section load when the section index map keeps its identity', () => {
    const entries = buildEntries(SMALL_FILE_COUNT, 3)
    renderHarness(entries, buildSections(entries), true)
    expect(mountedRowCount()).toBeGreaterThan(SMALL_FILE_COUNT)

    expect(runScrollPass(SCROLL_PASS_LOADS)).toBe(0)
  })
})

describe('combined diff file tree row windowing', () => {
  it('mounts every row below the virtualize threshold', () => {
    const fileCount = SOURCE_CONTROL_VIRTUALIZE_MIN_ROWS - 10
    const directoryCount = 4
    const entries = buildEntries(fileCount, directoryCount)
    renderHarness(entries, buildSections(entries), true)

    // `src` plus one directory row per leaf directory, plus one row per file.
    const totalRows = 1 + directoryCount + fileCount
    expect(totalRows).toBeLessThan(SOURCE_CONTROL_VIRTUALIZE_MIN_ROWS)
    expect(mountedRowCount()).toBe(totalRows)
    expect(host.querySelector('[data-testid="source-control-virtual-list"]')).toBeNull()
    // Natural flow: no absolutely positioned wrappers, exactly the pre-virtualization markup.
    expect(host.querySelectorAll('[data-index]').length).toBe(0)
  })

  it('mounts only a window of rows for a large review', () => {
    const fileCount = 900
    const directoryCount = 30
    const entries = buildEntries(fileCount, directoryCount)
    renderHarness(entries, buildSections(entries), true)

    const totalRows = 1 + directoryCount + fileCount
    expect(host.querySelector('[data-testid="source-control-virtual-list"]')).not.toBeNull()
    expect(mountedRowCount()).toBeGreaterThan(0)
    // A 600px viewport plus overscan: bounded by the window, not by the review size.
    expect(mountedRowCount()).toBeLessThan(totalRows / 10)
  })
})
