import type {
  FrameDecoder,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  PreparedJsonRpcPayload
} from './protocol'
import type { DispatcherClientWriter, SinkWriteSettlement } from './dispatcher-client-writer'

export type RequestContext = {
  clientId: number
  isStale: () => boolean
  signal?: AbortSignal
  sessionIdentity?: RelayClientSessionIdentity
  onResponseSettled?: (handler: (result: SinkWriteSettlement) => void) => void
}

export type RelayClientSessionIdentity = {
  principal: string
  authenticated: boolean
  allowSessionOwner: boolean
  authenticationKind: 'unproved' | 'launch-nonce' | 'endpoint-credential'
}

export type RelayClientSourceOptions = {
  pauseReads?: () => void
  resumeReads?: () => void
}

export type PtyDataPublicationAdmission = (
  clientId: number,
  params: Readonly<Record<string, unknown>>
) => boolean

export type MethodHandler = (
  params: Record<string, unknown>,
  context: RequestContext
) => Promise<unknown>

export type NotificationHandler = (params: Record<string, unknown>, context: RequestContext) => void

export type DroppedProducerNotificationLog = {
  generation: number
  loggedKeys: Set<string>
}

export type RelayClient = {
  id: number
  decoder: FrameDecoder
  writer: DispatcherClientWriter
  bulkChain: Promise<void>
  nextOutgoingSeq: number
  highestReceivedSeq: number
  // Why: the relay had no inbound-liveness signal at all, so a half-open client was never reaped
  // and kept its owner lease and paused PTYs indefinitely. Null until the first inbound frame: a
  // client that has never spoken has not yet proven it can, so it is not yet judged on silence.
  lastReceivedAt: number | null
  generation: number
  closed: boolean
  droppedNotificationLog: DroppedProducerNotificationLog | null
  sessionIdentity: RelayClientSessionIdentity
}

export type OutgoingJsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification

export type PreparedRelayFrame = Readonly<{
  payload: PreparedJsonRpcPayload
  frameBytes: number
  ptyDataAdmissionParams: Readonly<Record<string, unknown>> | null
}>

export type PendingRelayRequest = {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

// Why: the log key set is rebuilt per generation, but a producer minting synthetic method names would still
// grow it inside one generation — cap it well above the fixed relay method vocabulary.
export const DROPPED_NOTIFICATION_LOG_KEY_LIMIT = 64

export const RESPONSE_OVER_CAPACITY_MESSAGE =
  'Relay response exceeded the bounded transport capacity'

export const RELAY_TO_CLIENT_REQUEST_TIMEOUT_MS = 30_000
