import {
  enqueueAgentProcessInspection,
  type InspectionPriority
} from './agent-process-inspection-queue'
import type { RecognizedAgentProcess } from '../../../../shared/agent-process-recognition'
import { recognizeAgentProcess } from '../../../../shared/agent-process-recognition'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'
import type { ProcessMonitorOptions } from './agent-completion-process-types'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { getRemoteRuntimeTerminalHandle } from '@/runtime/runtime-terminal-stream'
import { admitRemoteForegroundEvidence } from '../../../../shared/remote-foreground-evidence-admission'
import { createAgentCompletionPollScheduler } from './agent-completion-poll-scheduler'

export function createAgentCompletionProcessMonitor({
  options,
  state,
  identityScope,
  pendingTitle,
  establishAgentEvidence,
  clearAgentRunEvidence,
  hasPendingHookDone,
  hasPendingCodexAttention,
  dispatchCompletion
}: ProcessMonitorOptions) {
  let remoteAuthorityGeneration: string | null = null,
    remoteObservationEpoch = -1
  let remoteBindingKey: string | null = null
  const remoteKnownAuthorityGenerations = new Set<string>()

  const expectedRemotePtyId = (ptyId: string): string =>
    parseAppSshPtyId(ptyId)?.relayPtyId ?? getRemoteRuntimeTerminalHandle(ptyId) ?? ptyId

  function bindRemoteInspectionGeneration(ptyId: string, incarnationId: string | null): void {
    if (options.isRemotePtyId?.(ptyId) !== true) {
      return
    }
    const bindingKey = `${ptyId}\0${incarnationId ?? ''}`
    if (remoteBindingKey === bindingKey) {
      return
    }
    remoteBindingKey = bindingKey
    remoteAuthorityGeneration = null
    remoteObservationEpoch = -1
    remoteKnownAuthorityGenerations.clear()
    // Invalidate reads queued for a prior same-id incarnation.
    state.inspectionGeneration += 1
  }
  const { clearPollTimer, scheduleNextPoll, shouldRunCadenceInspection } =
    createAgentCompletionPollScheduler({ options, state, pendingTitle, requestInspection })

  function handleRecognizedProcess(process: RecognizedAgentProcess): void {
    state.pendingProcessExitAgent = null
    const replayIdentity = identityScope.getLast()
    if (
      !state.lastForegroundAgent &&
      state.processSession > 0 &&
      !identityScope.hasUnconsumedStampedTail() &&
      replayIdentity?.source === 'hook' &&
      replayIdentity.agentIdentity === process.agent
    ) {
      identityScope.deleteLast()
    }
    if (state.lastForegroundAgent?.agent !== process.agent) {
      if (state.lastForegroundAgent && state.hasAgentRunEvidence) {
        if (
          options.shouldSuppressProcessReplacementCompletion?.(
            state.lastForegroundAgent,
            process
          ) !== true
        ) {
          dispatchCompletion('process-exit', state.lastForegroundAgent.processName, {
            completionIdentity: {
              source: 'process-exit',
              identity: `${state.lastForegroundAgent.agent}:${state.lastForegroundAgent.processName}`,
              agentIdentity: state.lastForegroundAgent.agent
            }
          })
        }
      }
      state.processSession += 1
    }
    state.lastForegroundAgent = process
    establishAgentEvidence()
  }

  function handleInspectionResult(
    result: RuntimeTerminalProcessInspection,
    requestStartedAtMonotonic: number
  ): boolean {
    const remote = options.isRemotePtyId?.(options.getPtyId() ?? '') === true
    if (remote) {
      const evidence = result.foregroundProcessEvidence
      // Remote identity is host-authoritative. Bare compatibility names,
      // transport failures, and unverifiable observations never mutate
      // routing state or synthesize process exit.
      const expectedIncarnationId = options.getExpectedIncarnationId?.() ?? null
      const ptyId = options.getPtyId()
      const bindingKey = `${ptyId ?? ''}\0${expectedIncarnationId ?? ''}`
      if (remoteBindingKey !== bindingKey) {
        remoteBindingKey = bindingKey
        remoteAuthorityGeneration = null
        remoteObservationEpoch = -1
        remoteKnownAuthorityGenerations.clear()
      }
      const admitted = admitRemoteForegroundEvidence(evidence, {
        expectedPtyId: ptyId ? expectedRemotePtyId(ptyId) : '',
        expectedIncarnationId,
        requestStartedAtMonotonic,
        receivedAtMonotonic: performance.now(),
        lastAuthorityGeneration: remoteAuthorityGeneration,
        lastObservationEpoch: remoteObservationEpoch,
        knownAuthorityGenerations: remoteKnownAuthorityGenerations
      })
      if (!admitted) {
        state.pendingProcessExitAgent = null
        state.consecutiveInspectionErrors += 1
        return false
      }
      remoteAuthorityGeneration = admitted.authorityGeneration
      remoteObservationEpoch = admitted.observationEpoch
      remoteKnownAuthorityGenerations.add(admitted.authorityGeneration)
      if (admitted.verdict === 'exited') {
        const exited = state.lastForegroundAgent
        if (exited && state.hasAgentRunEvidence) {
          if (options.shouldSuppressConfirmedProcessExitCompletion?.(exited) !== true) {
            dispatchCompletion('process-exit', exited.processName, {
              terminalIdleConfirmed: true,
              completionIdentity: {
                source: 'process-exit',
                identity: `${exited.agent}:${exited.processName}`,
                agentIdentity: exited.agent
              }
            })
          }
        }
        state.lastForegroundAgent = null
        clearAgentRunEvidence()
        return false
      }
      if (admitted.verdict !== 'live') {
        state.pendingProcessExitAgent = null
        return false
      }
      state.consecutiveInspectionErrors = 0
      // A host-stamped shell/unknown foreground is still not process-exit
      // evidence. Remote completion may recognize only the fenced process
      // name; the compatibility `foregroundProcess` string is display-only.
      if (admitted.processName === null) {
        state.pendingProcessExitAgent = null
        return false
      }
      const recognizedRemote = recognizeAgentProcess(admitted.processName)
      if (!recognizedRemote) {
        state.pendingProcessExitAgent = null
        return false
      }
      handleRecognizedProcess(recognizedRemote)
      return true
    }
    if (result.unavailable === true) {
      state.pendingProcessExitAgent = null
      state.consecutiveInspectionErrors += 1
      scheduleNextPoll()
      return false
    }
    state.consecutiveInspectionErrors = 0
    const recognized = recognizeAgentProcess(result.foregroundProcess)
    if (recognized) {
      handleRecognizedProcess(recognized)
      return true
    }
    if (hasPendingHookDone() || hasPendingCodexAttention()) {
      scheduleNextPoll()
      return false
    }
    if (state.lastForegroundAgent && state.hasAgentRunEvidence) {
      if (result.hasChildProcesses) {
        state.pendingProcessExitAgent = null
        scheduleNextPoll()
        return false
      }
      const pending = state.pendingProcessExitAgent
      if (
        !pending ||
        pending.agent !== state.lastForegroundAgent.agent ||
        pending.processName !== state.lastForegroundAgent.processName
      ) {
        state.pendingProcessExitAgent = state.lastForegroundAgent
        scheduleNextPoll()
        return false
      }
      const exited = state.lastForegroundAgent
      state.pendingProcessExitAgent = null
      if (options.shouldSuppressConfirmedProcessExitCompletion?.(exited) !== true) {
        const replayIdentityBeforeExit = identityScope.getLast()
        const committed = dispatchCompletion('process-exit', exited.processName, {
          terminalIdleConfirmed: true,
          completionIdentity: {
            source: 'process-exit',
            identity: `${exited.agent}:${exited.processName}`,
            agentIdentity: exited.agent
          }
        })
        if (
          !committed &&
          !identityScope.hasUnconsumedStampedTail() &&
          replayIdentityBeforeExit?.source === 'hook' &&
          replayIdentityBeforeExit.agentIdentity === exited.agent
        ) {
          identityScope.deleteLast()
        }
      }
      state.lastForegroundAgent = null
      clearAgentRunEvidence()
    } else {
      state.lastForegroundAgent = null
      clearAgentRunEvidence()
    }
    return false
  }

  function requestInspection(priority: InspectionPriority): void {
    if (state.disposed || state.inspectionInFlight || !options.isLive()) {
      return
    }
    if (priority === 'cadence' && !shouldRunCadenceInspection()) {
      return
    }
    const ptyId = options.getPtyId()
    if (!ptyId) {
      return
    }
    const expectedIncarnationIdAtRequest = options.getExpectedIncarnationId?.() ?? null
    bindRemoteInspectionGeneration(ptyId, expectedIncarnationIdAtRequest)
    state.inspectionInFlight = true
    const generationAtRequest = state.inspectionGeneration
    const requestStartedAtMonotonic = performance.now()
    const pendingTitleIdAtRequest = priority === 'pending-title' ? pendingTitle.get()?.id : null
    enqueueAgentProcessInspection({
      priority,
      canRun: () => !state.disposed,
      run: async () => {
        let inspectedRecognizedAgent = false
        let inspectionSucceeded = false
        try {
          const result = await (expectedIncarnationIdAtRequest
            ? options.inspectProcess(options.getSettings(), ptyId, {
                expectedIncarnationId: expectedIncarnationIdAtRequest
              })
            : options.inspectProcess(options.getSettings(), ptyId))
          if (
            !state.disposed &&
            generationAtRequest === state.inspectionGeneration &&
            (options.getExpectedIncarnationId?.() ?? null) === expectedIncarnationIdAtRequest
          ) {
            const currentPendingTitle = pendingTitle.get()
            const appliesToCurrentPendingTitle =
              !currentPendingTitle ||
              (priority === 'pending-title' && currentPendingTitle.id === pendingTitleIdAtRequest)
            if (appliesToCurrentPendingTitle) {
              inspectedRecognizedAgent = handleInspectionResult(result, requestStartedAtMonotonic)
            }
            inspectionSucceeded = true
          }
        } catch {
          state.pendingProcessExitAgent = null
          state.consecutiveInspectionErrors += 1
        } finally {
          state.inspectionInFlight = false
          if (generationAtRequest !== state.inspectionGeneration) {
            if (pendingTitle.get()) {
              requestInspection('pending-title')
            } else {
              scheduleNextPoll()
            }
          } else {
            const currentPendingTitle = pendingTitle.get()
            if (currentPendingTitle) {
              if (
                priority === 'pending-title' &&
                currentPendingTitle.id === pendingTitleIdAtRequest
              ) {
                pendingTitle.finishInspection(
                  currentPendingTitle.id,
                  inspectionSucceeded,
                  inspectedRecognizedAgent
                )
              } else {
                requestInspection('pending-title')
              }
            }
            scheduleNextPoll()
          }
        }
      }
    })
  }

  return {
    requestInspection,
    scheduleNextPoll,
    clearPollTimer,
    start: () => {
      state.pollTrackingStarted = true
      scheduleNextPoll()
    },
    recordActivity: () => {
      state.lastPaneActivityAt = Date.now()
      if (state.pollTimer === null || state.pollTimerTier === 'no-evidence') {
        scheduleNextPoll()
      }
    },
    incrementGeneration: () => {
      state.inspectionGeneration += 1
    }
  }
}
