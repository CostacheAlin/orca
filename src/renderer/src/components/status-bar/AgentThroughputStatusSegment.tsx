import React from 'react'
import { Gauge } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { selectActiveTerminalPaneKey } from '@/store/active-terminal-pane-key'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { computeTokensPerSecond } from '../../../../shared/agent-throughput-types'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../shared/tui-agent-display-names'
import { formatTokens } from '../stats/usage-formatters'
import { formatGenerationDuration, formatTokensPerSecondValue } from './agent-throughput-format'
import {
  resolveAgentThroughputPlaceholderReason,
  type AgentThroughputPlaceholderReason
} from './agent-throughput-placeholder'

function getAgentDisplayName(agentType: string): string {
  return (TUI_AGENT_DISPLAY_NAMES as Record<string, string | undefined>)[agentType] ?? agentType
}

function readoutLabel(value: string): string {
  return translate(
    'auto.components.status.bar.AgentThroughputStatusSegment.tokensPerSecond',
    '{{value}} tok/s',
    { value }
  )
}

function placeholderHint(reason: AgentThroughputPlaceholderReason, agentType?: string): string {
  if (reason === 'no-pane') {
    return translate(
      'auto.components.status.bar.AgentThroughputStatusSegment.noPane',
      'Focus a terminal pane running an agent.'
    )
  }
  if (reason === 'unmeasured-agent') {
    return translate(
      'auto.components.status.bar.AgentThroughputStatusSegment.unmeasuredAgent',
      'Not available for {{agent}}: it records no token counts per message.',
      { agent: getAgentDisplayName(agentType ?? '') }
    )
  }
  return translate(
    'auto.components.status.bar.AgentThroughputStatusSegment.waiting',
    'Waiting for the focused agent to complete a message.'
  )
}

function Readout({
  iconOnly,
  value,
  emphasized
}: {
  iconOnly: boolean
  value: string
  emphasized: boolean
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1 py-0.5 tabular-nums',
        // Why: dim while idle so the last reading isn't mistaken for live generation.
        emphasized ? 'text-foreground' : 'text-muted-foreground'
      )}
      aria-label={translate(
        'auto.components.status.bar.AgentThroughputStatusSegment.ariaLabel',
        'Agent throughput, {{value}}',
        { value }
      )}
    >
      <Gauge size={12} />
      {iconOnly ? null : <span>{value}</span>}
    </span>
  )
}

/** tok/s of the focused pane's agent; a sample only changes when a model call completes. */
export function AgentThroughputStatusSegment({
  iconOnly
}: {
  iconOnly: boolean
}): React.JSX.Element {
  const paneKey = useAppStore(selectActiveTerminalPaneKey)
  const sample = useAppStore((s) => (paneKey ? s.agentThroughputByPaneKey[paneKey] : undefined))
  const paneAgent = useAppStore((s) => (paneKey ? s.agentStatusByPaneKey[paneKey] : undefined))
  const working = paneAgent?.state === 'working'
  const measuredFor = translate(
    'auto.components.status.bar.AgentThroughputStatusSegment.measuredFor',
    'Measured per completed message for Claude Code, Codex, Gemini CLI and OpenCode; estimated for Grok.'
  )
  if (!sample) {
    // Why: an enabled item must always render, or "nothing" is indistinguishable from "off".
    const reason = resolveAgentThroughputPlaceholderReason({
      paneKey,
      agentType: paneAgent?.agentType
    })
    return (
      <Tooltip delayDuration={150}>
        <TooltipTrigger asChild>
          <Readout iconOnly={iconOnly} value={readoutLabel('n/a')} emphasized={false} />
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          <div className="space-y-0.5">
            <div>{placeholderHint(reason, paneAgent?.agentType)}</div>
            <div className="text-muted-foreground">{measuredFor}</div>
          </div>
        </TooltipContent>
      </Tooltip>
    )
  }
  // Why: a leading "~" keeps an estimate from reading as a measured figure at a glance.
  const readout = readoutLabel(
    `${sample.estimated ? '~' : ''}${formatTokensPerSecondValue(sample.tokensPerSecond)}`
  )
  const turnAverage =
    sample.turnMessageCount > 0
      ? computeTokensPerSecond(sample.turnOutputTokens, sample.turnGenerationMs)
      : null
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <Readout iconOnly={iconOnly} value={readout} emphasized={working} />
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        <div className="space-y-0.5">
          <div>
            {translate(
              'auto.components.status.bar.AgentThroughputStatusSegment.lastMessage',
              'Last message: {{tokens}} tokens in {{duration}}',
              {
                tokens: formatTokens(sample.outputTokens),
                duration: formatGenerationDuration(sample.generationMs)
              }
            )}
          </div>
          {turnAverage !== null ? (
            <div>
              {translate(
                'auto.components.status.bar.AgentThroughputStatusSegment.turnAverage',
                'This turn: {{value}} tok/s across {{count}} message(s)',
                {
                  value: formatTokensPerSecondValue(turnAverage),
                  count: sample.turnMessageCount
                }
              )}
            </div>
          ) : null}
          <div className="text-muted-foreground">
            {[getAgentDisplayName(sample.agentType), sample.model].filter(Boolean).join(' · ')}
          </div>
          {sample.estimated ? (
            <div className="text-muted-foreground">
              {translate(
                'auto.components.status.bar.AgentThroughputStatusSegment.estimated',
                'Estimated from text length: this agent records no token counts, so hidden reasoning is approximated.'
              )}
            </div>
          ) : null}
          <div className="text-muted-foreground">{measuredFor}</div>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
