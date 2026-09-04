import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { runtimeTargetForExecutionHostId, type RuntimeClientTarget } from './runtime-client-target'

/**
 * Runtime target that owns `worktreeId`, which is not always the globally
 * focused runtime — acting on the focused one scans the wrong host and reports
 * that workspace as having no ports. Direct-SSH owners return null.
 */
export function useWorktreeRuntimeTarget(
  worktreeId: string | null | undefined
): RuntimeClientTarget | null {
  // Why: the selector must return a stable value. `runtimeTargetForExecutionHostId` allocates a
  // new object per call, and a zustand selector that returns a fresh reference on every snapshot
  // re-renders forever (React #185). Select the host id string and derive the target from it.
  const hostId = useAppStore((state) => getExecutionHostIdForWorktree(state, worktreeId))
  return useMemo(() => runtimeTargetForExecutionHostId(hostId), [hostId])
}
