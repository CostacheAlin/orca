import React from 'react'
import { Gauge } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { selectActiveTerminalPaneKey } from '@/store/active-terminal-pane-key'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { computeTokensPerSecond } from '../../../../shared/agent-throughput-types'
import { formatTokens } from '../stats/usage-formatters'
import { formatGenerationDuration, formatTokensPerSecondValue } from './agent-throughput-format'

/** tok/s of the focused pane's agent; a sample only changes when an assistant message completes. */
export function AgentThroughputStatusSegment({
  iconOnly
}: {
  iconOnly: boolean
}): React.JSX.Element | null {
  const paneKey = useAppStore(selectActiveTerminalPaneKey)
  const sample = useAppStore((s) => (paneKey ? s.agentThroughputByPaneKey[paneKey] : undefined))
  const working = useAppStore(
    (s) => paneKey !== null && s.agentStatusByPaneKey[paneKey]?.state === 'working'
  )
  if (!sample) {
    return null
  }
  const readout = translate(
    'auto.components.status.bar.AgentThroughputStatusSegment.tokensPerSecond',
    '{{value}} tok/s',
    { value: formatTokensPerSecondValue(sample.tokensPerSecond) }
  )
  const turnAverage =
    sample.turnMessageCount > 0
      ? computeTokensPerSecond(sample.turnOutputTokens, sample.turnGenerationMs)
      : null
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded px-1 py-0.5 tabular-nums',
            // Why: dim while idle so the last reading isn't mistaken for live generation.
            working ? 'text-foreground' : 'text-muted-foreground'
          )}
          aria-label={translate(
            'auto.components.status.bar.AgentThroughputStatusSegment.ariaLabel',
            'Agent throughput, {{value}}',
            { value: readout }
          )}
        >
          <Gauge size={12} />
          {iconOnly ? null : <span>{readout}</span>}
        </span>
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
          {sample.model ? <div className="text-muted-foreground">{sample.model}</div> : null}
          <div className="text-muted-foreground">
            {translate(
              'auto.components.status.bar.AgentThroughputStatusSegment.updatesHint',
              'Updates when an assistant message completes'
            )}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
