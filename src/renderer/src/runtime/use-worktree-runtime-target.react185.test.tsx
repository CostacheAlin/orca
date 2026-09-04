/** @vitest-environment happy-dom */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from './runtime-client-target'
import { useWorktreeRuntimeTarget } from './use-worktree-runtime-target'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const initialState = useAppStore.getInitialState()
let root: Root
const rendered: (RuntimeClientTarget | null)[] = []

function Probe(): React.JSX.Element {
  const target = useWorktreeRuntimeTarget(null)
  rendered.push(target)
  return <span>{target?.kind ?? 'none'}</span>
}

beforeEach(() => {
  useAppStore.setState(initialState, true)
  rendered.length = 0
})

afterEach(() => {
  act(() => root?.unmount())
  useAppStore.setState(initialState, true)
  document.body.replaceChildren()
})

describe('useWorktreeRuntimeTarget', () => {
  it('returns one stable target per host across unrelated store updates', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    // Why: the derived target is a fresh object per call. A selector that returns it directly
    // re-renders forever (React #185) and takes every ports surface, status bar included, down.
    act(() => root.render(<Probe />))
    expect(container.textContent).toBe('local')
    const first = rendered.at(-1)
    expect(first).toEqual({ kind: 'local' })

    act(() => useAppStore.setState({ statusBarVisible: false }))
    act(() => useAppStore.setState({ statusBarVisible: true }))

    expect(rendered.at(-1)).toBe(first)
    expect(rendered.length).toBeLessThanOrEqual(3)
  })
})
