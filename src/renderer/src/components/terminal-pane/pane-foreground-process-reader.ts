import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'
import { getRemoteRuntimeTerminalHandle } from '@/runtime/runtime-terminal-stream'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { admitRemoteForegroundEvidence } from '../../../../shared/remote-foreground-evidence-admission'

type ForegroundReader = (
  ptyId: string,
  options?: { expectedIncarnationId?: string }
) => Promise<string | null | RuntimeTerminalProcessInspection>

export function createPaneForegroundProcessReader(deps: {
  readForegroundProcess: ForegroundReader
  confirmForegroundProcess?: ForegroundReader
  isRemotePtyId?: (ptyId: string) => boolean
  getExpectedIncarnationId?: () => string | null
}) {
  let authorityGeneration: string | null = null
  let observationEpoch = -1
  let bindingKey: string | null = null

  return async (ptyId: string, requiresConfirmation: boolean) => {
    let processName: string | null = null
    let remoteEvidenceAccepted = false
    let remoteEvidenceUnavailable = false
    const expectedIncarnationId = deps.getExpectedIncarnationId?.() ?? null
    const options = expectedIncarnationId ? { expectedIncarnationId } : undefined
    const requestStartedAtMonotonic = performance.now()
    const remote = deps.isRemotePtyId?.(ptyId) === true
    if (remote) {
      const nextBindingKey = `${ptyId}\0${expectedIncarnationId ?? ''}`
      if (bindingKey !== nextBindingKey) {
        bindingKey = nextBindingKey
        authorityGeneration = null
        observationEpoch = -1
      }
    }
    try {
      const reader = requiresConfirmation
        ? (deps.confirmForegroundProcess ?? deps.readForegroundProcess)
        : deps.readForegroundProcess
      const inspection = await (options ? reader(ptyId, options) : reader(ptyId))
      if (typeof inspection === 'string' || inspection === null) {
        processName = inspection
        remoteEvidenceUnavailable = remote
      } else if (remote) {
        const admitted = admitRemoteForegroundEvidence(inspection.foregroundProcessEvidence, {
          expectedPtyId:
            parseAppSshPtyId(ptyId)?.relayPtyId ?? getRemoteRuntimeTerminalHandle(ptyId) ?? ptyId,
          expectedIncarnationId,
          requestStartedAtMonotonic,
          receivedAtMonotonic: performance.now(),
          lastAuthorityGeneration: authorityGeneration,
          lastObservationEpoch: observationEpoch
        })
        if (admitted) {
          authorityGeneration = admitted.authorityGeneration
          observationEpoch = admitted.observationEpoch
        }
        if (admitted?.verdict === 'live') {
          processName = admitted.processName
          remoteEvidenceAccepted = true
        } else {
          remoteEvidenceUnavailable = true
        }
      } else {
        processName = inspection.foregroundProcess
      }
    } catch {
      remoteEvidenceUnavailable = remote
    }
    return {
      processName,
      remoteEvidenceAccepted,
      remoteEvidenceUnavailable,
      expectedIncarnationId,
      remote
    }
  }
}
