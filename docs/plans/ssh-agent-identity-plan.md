# SSH and remote agent identity plan

Status: design only. This document is the implementation plan; no source code, command
launch, or wire change is made by this task.

## Outcome and invariants

Remote process identity will come only from the execution host that owns the PTY. The
existing relay `pty.inspectProcess` RPC will return a host-stamped, fenced observation;
terminal bytes (including OSC 133/777) remain turn-boundary input and never assert an agent
name. A name that cannot be tied to the current host, PTY incarnation, shell, tty, and
foreground group is `unverifiable`, not a guess.

The probe-cost invariant is explicit: there is no periodic remote identity poll. A remote
probe is issued only by a qualifying pane event (spawn/attach/reattach/reconnect, command
boundary, visible/reveal/focus sampling, or an explicit completion confirmation), and
concurrent panes share one host process-table capture. A steady-state idle host with no
launch or agent evidence and no command, output, title, visibility, or reconnect event
therefore performs zero remote probes. The remote completion cadence, its recent-activity
timer, and any active-agent interval must all be disabled; an event may use a finite,
bounded retry ladder, but never a `setInterval` or an endlessly re-armed timer.

The title remains the absolute last fallback for display. It is not routing or completion
authority. No user command is wrapped, shimmed, or given extra flags, and no agent launch
option is required.

## What exists today

* `src/renderer/src/components/terminal-pane/pty-connection/pane-agent-identity.ts`
  unconditionally returns `false` from `session.isForegroundTrackingAllowed` for both
  direct SSH IDs and `remote:` paired-runtime IDs (`isRemoteExecutionHostPtyId`). That is
  the gate to remove.
* A direct SSH provider already sends `pty.inspectProcess` from
  `src/main/providers/ssh-pty-provider.ts`; the relay handler in
  `src/relay/pty-handler.ts` already reads the remote foreground process and child
  processes. The old response is only `{ foregroundProcess, hasChildProcesses }`.
* Paired runtimes already expose `terminal.inspectProcess` through
  `src/main/runtime/rpc/methods/terminal/terminal-query-methods.ts` and
  `OrcaRuntime.inspectTerminalProcess`, which delegates to the host PTY controller.
  `src/renderer/src/runtime/runtime-terminal-inspection.ts` is the common renderer route,
  but its result currently has no evidence contract.
* The relay already has a batched POSIX process-table resolver and publishes an optional
  `foregroundProcessEvidence` in process listings. Extend that authority to the inspect
  RPC rather than creating a second process scanner. Existing `ManagedPty.incarnationId`
  and the relay `ptyIdMintEpoch` are useful identity fences, but neither is by itself a
  process-name proof.
* `src/shared/foreground-process-evidence.ts` currently has only `live` and
  `unverifiable`, with authority generation, observation epoch, and capture age. Its
  contract must be strengthened before the renderer trusts it.

Private reference review found the same safe shape across comparable remote terminal
systems: a host-resident authority publishes a versioned/capability-aware process/session
protocol and clients expose an explicit degraded state. None makes terminal byte parsing
the authority. This is a sanity check on the design, not a dependency or a public
reference.

## 1. Renderer gate and call path

Change only the remote branch of `isForegroundTrackingAllowed`:

1. Keep the existing native macOS/Linux path and the Windows ConPTY eligibility checks.
2. For an SSH or paired-runtime PTY, remove the unconditional `return false` and replace it
   with an evidence-aware `return true` (the tracker is now permitted to issue the host
   inspection). There is no local process-table fallback and no title-based capability
   guess: an old host is detected by the absent evidence field and is treated as
   `unverifiable`. Do not turn the old string-only `getForegroundProcess` into authority.
3. Wire `createPaneForegroundAgentTracker` to
   `inspectRuntimeTerminalProcess` (or an equivalent evidence-aware adapter) for both
   `readForegroundProcess` and its confirming read. A direct SSH ID must select its SSH
   provider; a `remote:` ID must select the owning runtime environment, never the local
   desktop process table.
   The attach result's optional `incarnationId` is captured in the session and passed to
   every remote inspect request; a response is discarded if its `ptyId` or incarnation
   does not match that binding, including a response that completes after a same-id
   replacement.
4. Teach the tracker to consume the structured result. It may recognize an agent name only
   from `evidence.verdict === 'live'` after all fences pass. `unverifiable` clears neither
   a still-valid previous identity nor a shell state, and never invokes the
   `onConfirmedShellForeground` callback. A host `live` observation with a fenced shell
   foreground may clear a known identity only in the existing command-finish confirmation
   path; `exited` is the only verdict that retires the PTY process itself, and only for the
   current incarnation.
5. Preserve the existing OSC command-start/finish state machine for turn detection. An
   OSC `D` can still schedule a confirmation read when a pane is known to contain an agent,
   but it cannot itself claim shell or agent identity on a remote pane.

The adapter should keep the old `foregroundProcess` and `hasChildProcesses` members for
older callers, but new routing/completion code must require the evidence member for remote
identity. A missing member is `unverifiable` (not a legacy live answer). In particular,
change `createAgentCompletionProcessMonitor` so its inspection handler receives the
structured result and has an explicit remote branch: remote recognition uses only
`evidence.verdict === 'live'` and that record's process name; an absent evidence field,
`unverifiable`, or a bare compatibility name cannot establish run evidence, dispatch
process-exit completion, or clear a known agent. A host `exited` record is handled only
after the same incarnation validation; local panes retain their existing string path.

## 2. Host-stamped evidence contract

Define one shared, runtime-validated **host-wire** response type used by direct SSH and
paired-runtime inspect RPCs. The response remains backward-compatible by adding an
optional `foregroundProcessEvidence` field to the existing JSON result. A transport timeout,
socket loss, or old host does not manufacture this record; the renderer represents those
cases as a client-only `unverifiable` state with no host metadata. Keep this inspect-RPC
type separate from the existing list-row `ForegroundProcessEvidence` validator: list rows
continue to use their shipped two-verdict (`live`/`unverifiable`) shape, while the enriched
inspect type below is the only place that can carry `exited`, fences, and a PTY incarnation.

```ts
type HostObservation = {
  authorityGeneration: string       // host boot + relay/runtime generation
  observationEpoch: number          // strictly increasing on that authority
  capturedAgeMs: number             // host age when serialized
  ptyId: string                    // host-owned PTY key, echoed from the request
  ptyIncarnationId: string          // ManagedPty incarnation
}
type RemoteForegroundEvidence =
  | ({ verdict: 'live'; processName: string | null; fence: PosixFence | WindowsFence } & HostObservation)
  | ({ verdict: 'unverifiable'; reason: string } & HostObservation)
  | ({ verdict: 'exited'; reason: string } & HostObservation)
type PosixFence = {
  platform: 'posix'
  shellPid: number
  shellStartTime: string
  tty: string
  foregroundPgid: number
  process?: { pid: number; startTime: string }
}
type WindowsFence = {
  platform: 'windows'
  // Creation-time/session fields are reserved for a measured adapter; SSH relay
  // currently cannot populate this fence and therefore never returns live.
  rootProcessId: number
  rootCreationTime: string
  sessionId: string
  process?: { pid: number; creationTime: string }
}
```

The exact start-time encoding may be numeric ticks or an opaque decimal string per host;
the client treats it as opaque and only compares host-stamped values. The process object is
omitted when no agent is recognized. Do not put a bare name in a new field and call it
evidence: a process name without the fences below is not safe. `RemoteForegroundEvidence`
is validated independently from `isForegroundProcessEvidence`; the latter remains unchanged
for legacy `pty.listProcesses` rows until a separately negotiated list schema exists.

### Required host fences

The relay/paired host must produce `live` only after a complete, single-host observation
passes every applicable fence:

* **Authority and PTY generation.** Stamp a host boot identifier plus the relay/runtime
  generation in `authorityGeneration`; increment `observationEpoch` monotonically. Include
  `ptyIncarnationId` and reject a response whose generation or incarnation differs from
  the currently attached pane. A relay restart, host reboot, or reattach to a replacement
  PTY invalidates old evidence.
* **Anchor PID reuse.** Resolve the managed PTY's shell/root PID and compare its host-native
  start/creation time (`/proc/<pid>/stat` ticks on Linux; a stable process-start record
  such as `proc_pidinfo`/`ps`-backed host time on macOS; creation time from the Windows
  process table). If the PID is absent or the start time changes, return
  `unverifiable`.
* **Controlling terminal.** Capture the shell's tty/console identity and require every
  candidate to belong to that same terminal. Linux/macOS use the tty device. Stock
  node-pty in the SSH relay does not expose a reliable Windows job/console association, so
  SSH-to-Windows is always `unverifiable` until a separately measured relay adapter can
  provide a stable association.
* **Foreground group.** On POSIX, read `pgid` and terminal foreground `tpgid` (the same
  relationship represented by `stat`'s `+`) and correlate all rows in the foreground group
  on the anchor tty. On SSH-to-Windows there is no measured foreground primitive in the
  relay; return `unverifiable`, not a fallback name. A future adapter must add and test a
  Windows-specific creation-time/session fence before enabling `live`.
* **Candidate PID reuse.** When a recognized process is selected, include and validate its
  own PID start/creation time from the same complete capture. Never infer identity from a
  command name after a PID has disappeared and been reused.
* **Multiplexer boundary.** Reject `tmux`, `screen`, or an equivalent session boundary in
  the foreground group or in a descendant that crosses to another tty/session. A future
  session-aware anchor may opt in explicitly; this plan does not guess through a
  multiplexer.
* **Ambiguity and completeness.** Require a complete process-table capture. If two
  recognized agent names occur in one foreground group, or parsing/capture is partial,
  return `unverifiable` with a stable reason such as
  `ambiguous_foreground_group`/`process_table_unreadable`.

These are the SSH equivalents of the WSL resolver's distro/boot fence, shell PID
start-time fence, tty and foreground-group correlation, multiplexer rejection, and
ambiguous-group rejection. A Linux or macOS host that cannot supply one of these fields
degrades to `unverifiable`; it does not use node-pty's un-fenced display name. A Windows
host uses its native process creation-time and ConPTY/job membership equivalents and
degrades in the same way.

### REQUIRED: document the Windows-over-SSH limit in code

The SSH-to-Windows `unverifiable` result must carry an explicit comment at the place that
returns it, so the next reader does not mistake it for an oversight and "fix" it by
falling back to an unfenced name. State the mechanism, not just the outcome:

```ts
// Why SSH-to-Windows is always unverifiable: POSIX has a real foreground primitive
// (the controlling terminal's foreground process group, tpgid/pgid), so the host can
// read which process is in front. Windows has no equivalent. Local Windows approximates
// it by reading the native process table and walking descendants of the PTY root pid
// (windows-foreground-process-rows.ts), but the relay has neither piece: it does not
// import windows-process-table, its getForegroundProcessName is POSIX-shaped
// (/proc, pgrep, lsof), and relay hosts run stock node-pty, so no ConPTY job/console
// association is available. Returning a descendant name without a creation-time and
// session fence would be a guess. Lifting this requires teaching the relay the Windows
// process table plus a measured creation-time/session fence - a separate change.
```

The same note belongs on the `WindowsFence` type, whose fields are declared but
unpopulated, so the type does not read as an unfinished implementation.

### Verdict rules and client validation

* `live` means the host observed the current incarnation and all fences passed; `processName`
  may still be `null` when a fenced foreground is a shell or another unrecognized command.
* `unverifiable` covers missing/unsupported metadata, incomplete capture, authority/epoch
  mismatch, multiplexer boundaries, and ambiguity in a host record. Transport loss, timeout,
  and an old host are **client-only** `unverifiable` states with no host observation; they
  must not be serialized as synthetic host records. Neither form may clear a known agent or
  be rendered as an exit.
* `exited` requires positive host evidence: a host-delivered exit/tombstone tied to the
  exact `authorityGeneration`, PTY id, and `ptyIncarnationId`, or a complete host capture
  that proves the incarnation's anchor is gone according to the host's retirement record.
  A missing map entry, client-side set removal, socket close, or `terminal_gone` with no
  matching host tombstone is `unverifiable`.

The renderer stores the last accepted authority generation/epoch/incarnation per pane,
rejects decreasing epochs and evidence older than `REMOTE_FOREGROUND_EVIDENCE_MAX_AGE_MS =
2_000`, and treats a generation change as requiring a fresh event-triggered sample. Age is
measured conservatively: the client records a monotonic request-start timestamp and rejects
when `capturedAgeMs + (receiveMonotonic - requestStartMonotonic)` exceeds the limit (a host
may additionally return an issued-at/deadline timestamp for diagnostics). This catches a
fresh-at-host response delayed in an SSH queue; it does not depend on synchronized wall
clocks. It never synthesizes `exited` from a rejected or absent observation. Keep the exact
vocabulary `live` / `unverifiable` / `exited` throughout RPCs, stores, telemetry, and tests.

## 3. Relay and paired-runtime plumbing

1. Extend the shared `PtyProcessInspection`/evidence decoder and the relay's
   `inspectProcess` result. Reuse the existing batched process-table capture and its
   single-flight/500 ms per-host TTL cache; do not fork a `ps`/process query per field or
   per pane. The host should capture once, resolve all requested PTYs, then stamp each
   response with the same observation epoch.
2. Carry the managed PTY's incarnation and relay/runtime authority generation through
   `SshPtyProvider.inspectProcess` and `OrcaRuntime.inspectTerminalProcess`. Add an optional
   `incarnationId` to the existing spawn/attach/reattach result and store it as the pane's
   current binding; a new client must not accept remote `live` evidence when that binding is
   absent. Send the binding back as an optional `expectedIncarnationId` in inspect requests
   (direct SSH and `terminal.inspectProcess`), and have the host reject a mismatch as
   `unverifiable`. On rebind, clear the old binding and increment the renderer inspection
   generation before permitting another sample. These optional fields are ignored safely by
   legacy hosts, which consequently yield no accepted remote identity.
3. Keep `foregroundProcess` and `hasChildProcesses` in the response for old consumers;
   they are compatibility fields, not remote identity authority. Existing completion
   code that still receives a string must be routed through the evidence-aware adapter
   before it can affect a remote pane.
4. Add a bounded host retirement/tombstone record so `exited` has a positive source. Before
   deleting a managed PTY (including reaping an `onExit`-missed shell), retain a record keyed
   by `{ authorityGeneration, ptyId, ptyIncarnationId }` with the host exit sequence/code and
   a monotonic expiry. `pty.exit` notifications may carry this optional record; an inspect
   request that includes `expectedIncarnationId` may replay the matching tombstone after a
   disconnect, while an absent/mismatched/stale record returns the client-only
   `unverifiable` state. Bound retention to the evidence TTL plus the reconnect grace window,
   purge on authority-generation restart, and never infer `exited` from a missing map entry
   or socket close. Paired-runtime restart uses the same rule; a new authority cannot replay
   the old host's tombstone.
5. Separate inventory liveness from foreground identity. Add the optional boolean
   `includeForegroundProcessEvidence` to the host-owned `pty.listProcesses`/runtime
   inventory request. Automatic mobile/session-list refreshes
   send `false`; the relay then returns PTY ids, incarnation, cwd, title cache, and
   `agentSessionOwners` using its existing owner/liveness bookkeeping but skips the process
   table, `getForegroundProcessName`, and per-PTY child probes. Desktop callers that omit the
   field retain the old list shape. Advertise support for this projection in the existing
   capability handshake; a new client suppresses automatic remote list refresh against a
   host that does not advertise it (an explicit user refresh may use the legacy path), so an
   old host cannot turn a background mobile poll into process spawns.
6. Do not add a terminal-stream opcode. OSC 133/777 bytes remain on the existing stream
   and are interpreted only as turn boundaries. If a future transport needs a genuinely
   new frame, negotiate it in the subscribe capability handshake first; this design does
   not need one.

### Mixed-version behavior

The optional JSON field follows `docs/reference/remote-wire-compatibility.md`:

* **Old client + new host:** inspect-RPC consumers cast the optional field away and keep
  their current title/turn behavior, but **list-row admission is not an ignore path**:
  `PtyProcessListAdmission` rejects an evidence object that violates its old validator and
  `pty:listSessions` can fail the whole listing. Therefore list rows must stay within the
  shipped two-verdict (`live`/`unverifiable`) schema and its required fields; add only
  unknown optional keys that the old validator accepts. Never publish the new `exited`
  verdict or a changed required shape in list rows until that surface is capability-gated.
  Continue sending the old fields and stream frames, and do not change the meaning of
  `foregroundProcess` in a way that makes old clients regress.
* **New client + old host:** the old response has no evidence field. The new client marks
  the remote inspection `unverifiable`, leaves title as last display fallback, and makes
  no remote routing/completion claim from the bare name. It must not treat field absence as
  `null`/shell or as `exited`. An old host also ignores the optional inventory projection
  request, so the new client treats missing capability as legacy and suppresses automatic
  remote/mobile list refreshes (only an explicit user refresh may invoke that old path).
* **New client + new host:** consume evidence only after validating schema, generation,
  epoch, age, and incarnation; unsupported host platforms or failed fences remain
  `unverifiable`.

Add cross-version tests in both directions using the existing terminal RPC wire harness,
including host-published list data (Rule 3: changing content is a wire change even when
the codec is unchanged). Explicitly run every new-host list row through the old
`PtyProcessListAdmission` and assert admission succeeds; keep enriched `exited`/new-shape
records confined to inspect RPCs or a negotiated surface. If a capability is added to
advertise evidence support, an old client must be treated as not supporting it and the new
client must retain the safe fallback; do not make evidence mandatory until the capability
floor is universal.

## 4. Probe scheduling and cost proof

Remote completion monitors currently have a no-evidence cadence and a recent-activity
hot window. Set both `shouldPollProcessCadence` and
`shouldPollNoEvidenceProcessCadence` to false for remote authorities, and prevent the
hot-window branch from rearming remote cadence. A remote hook/launch expectation with no
accepted `live` observation uses only a finite settle/retry ladder, then disarms; it must
not re-arm an idle-tier poll forever. A pane with accepted live-agent evidence also uses
event-triggered confirmation (command finish, reconnect, visibility, or an explicit
completion action), never a periodic process-exit poll; host exit notifications/tombstone
replay are the exit signal.

Trigger one-shot inspections from:

* PTY spawn, attach, reattach, or reconnect when the pane is visible or has a launch/hook
  expectation;
* OSC command start/finish events (finish schedules confirmation only when an agent
  identity is pending or known);
* visible/reveal/focus sampling and explicit completion/pending-title confirmation;
* a launch-agent or hook event that establishes an expectation, followed by a bounded
  settle/retry ladder.

Coalesce simultaneous events by pane and host, cancel stale generations on rebind, and
share one process-table capture across all qualifying panes. Output/title bytes can
update turn state, but they never create a remote probe by themselves and never open a
remote hot-window loop. The bounded retry ladder is attached to one event token and is
cancelled on success, rebind, disposal, or expiry.

Cost tests must instrument the host process-table command and the RPC client:

* an idle host with many remote panes, no launch/agent evidence, and no qualifying events
  produces exactly zero RPCs and zero process-table spawns over a long simulated interval;
* one event burst produces at most one in-flight host capture and one resolution per PTY,
  with no per-pane `ps` fan-out;
* transport failure backs off without turning into an exit and does not spin;
* a remote hook/launch event that never obtains accepted `live` evidence terminates its
  bounded ladder and produces no subsequent cadence probes;
* repeated command/output events for an active known agent remain one-shot and coalesced;
  there is no active-agent cadence timer, and all pending retries stop after disposal.

The mobile/list path is tested separately: a three-second mobile poll sends the no-evidence
inventory projection, which produces zero process-table spawns on a new host. A legacy host
without that capability is not polled automatically by the new client. This addresses the
failed high-cost poll design directly: a host with no qualifying pane events remains at
zero identity probes and zero inventory process-table spawns.

## 5. Treatment of PR #17737

Do not merge the conflicting, stale branch wholesale. Rebase or extract only
the minimal OSC 133/777 boundary handling that is still needed for turn detection, resolve
conflicts against current pane lifecycle code, and explicitly remove any agent identity
claim from marker payloads. The branch also contains a relay identity producer and
capability-push changes; do not pull those into the extraction. A remote `printf` or pass-through transcript containing
marker-shaped bytes must be covered by a regression test and must leave remote identity
unchanged. Do not make a nonce the authority: it can prove only that code in the pane read
the environment, not that the bytes represent the intended process.

## 6. Test and validation plan

### Unit and contract tests

* Evidence schema accepts valid `live`, `unverifiable`, and `exited` records and rejects
  missing/invalid authority, epochs, ages, incarnation, anchors, or process start times.
* Relay resolver tests cover Linux and macOS tty/pgid/tpgid correlation, PID reuse,
  missing shell, stale boot/generation, unreadable captures, multiplexer boundaries, and
  two-agent ambiguity. SSH-to-Windows tests assert the current honesty contract (always
  `unverifiable`, no job/console claim); a future measured adapter gets separate
  creation-time/session tests.
* Renderer tracker tests cover direct SSH and paired-runtime IDs, old string-only results,
  stale/reordered observations, transport loss, host-positive exit, command boundaries,
  rebind cancellation, and title-only fallback. Include a same-PTY-id replacement with an
  in-flight inspection and assert the pane's attach-bound `incarnationId` rejects the old
  result. A remote bare process name must never set routing identity.
* Completion monitor tests prove both remote cadence switches are disabled, the structured
  evidence gate blocks bare compatibility names, event probes are coalesced, and
  `unverifiable` never dispatches process-exit completion. Tombstone tests cover notification
  loss, reconnect replay, expiry, generation restart, and mismatched incarnation.
* Cross-version RPC tests exercise old client/new host, new client/old host, and both new;
  assert inspect responses degrade safely and that old list admission accepts every row
  the new host publishes. Exercise the inventory projection capability: new host + mobile
  request skips process capture, while a new client suppresses automatic refresh against
  an old host that ignores the projection field.
* OSC regression tests feed forged marker bytes and verify they can affect turn detection
  only, never agent identity.

### Real-host validation

Use a disposable Linux VM or container reachable over a real network address with a
separate SSH daemon and user; do not use `ssh localhost`. From an Orca-managed folder
workspace (not requiring a git worktree):

1. Spawn/attach a shell through direct SSH and verify a fenced `live` shell result.
2. Start a recognized agent normally (no wrapper, shim, or special flag), then verify its
   name is reported only while its foreground group, tty, PID start time, and PTY
   incarnation match. Also hand-start the agent by typing its ordinary command into the
   shell; launch metadata is not required when host evidence is sound.
3. Emit marker-shaped text with `printf`, pass it through another process, and confirm no
   identity claim changes.
4. Drop the client/SSH connection while the agent continues on the host. During the drop,
   observations are `unverifiable`; after reconnect/reattach a fresh host observation is
   required. Only a host-confirmed exit/tombstone produces `exited`.
5. Restart the relay/runtime or replace the PTY and verify the authority generation and
   incarnation fences reject pre-restart evidence.

Run equivalent host-adapter fixtures on macOS. For a Windows SSH target, verify the
always-`unverifiable` honesty behavior and the absence of job/console false positives;
do not claim `live` until a measured relay adapter lands. Pair a remote Orca runtime and
repeat the same flow through `terminal.inspectProcess`, including runtime restart and
reattach. Exercise folder workspaces in every host flow. Run the repository's
cross-version terminal wire suite and the focused relay/renderer tests before review.

## 7. Platform and behavior matrix

| Scenario | Authority and expected behavior |
| --- | --- |
| SSH to Linux | Relay process table with boot/start-time, tty, pgid/tpgid, complete-group, multiplexer, and ambiguity fences; `live` only on a full match. |
| SSH to macOS | Same contract using macOS process start/tty/foreground-group primitives; unsupported or ambiguous fields yield `unverifiable`. |
| SSH to Windows | Current relay has no measured job/console foreground association: always `unverifiable` (honesty test only) until a separately measured adapter supplies creation-time/session fences. |
| Paired remote Orca host | Runtime host is authority; renderer calls the environment RPC, validates generation/epoch/incarnation, and never scans the desktop. |
| Paired remote Orca host on Windows | The runtime uses a measured native process/session adapter when available; otherwise it follows the same `unverifiable`-only fallback as SSH-to-Windows and never claims from a bare name. |
| Reattach/reconnect or relay/runtime restart | Old observations are stale; reconnect fetches a new host-stamped observation. Link loss alone is `unverifiable`, never `exited`. |
| Host did not launch the agent (hand-started) | A process inside the managed PTY can be `live` when all host fences pass; launch metadata is not required. A process outside the managed PTY or behind an unknown multiplexer is `unverifiable`; title is display-only fallback. |
| Agent/Orca hooks outside Orca | No relay authority exists, so hooks/markers outside Orca cannot claim identity. Inside Orca they may signal turn boundaries, but only the host inspect RPC can claim the agent. |

## Implementation sequence and review gate

1. Land the shared evidence schema/validator and host resolver tests first, including
   platform-specific conservative fallbacks.
2. Extend relay, SSH provider, paired-runtime controller, and renderer inspection plumbing;
   then change the remote tracking gate and completion scheduler together so no old
   no-evidence poll remains enabled.
3. Add mixed-version, forged-marker, lifecycle, cost, and real-host integration tests.
4. Re-run typecheck, focused tests, cross-version wire tests, and the real throwaway-host
   matrix. Stop at this reviewed plan; implementation requires a separate approval.
