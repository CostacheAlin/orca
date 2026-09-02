/** Number part of a tok/s readout: whole numbers from 10 up, one decimal below, "k" from 1000. */
export function formatTokensPerSecondValue(tokensPerSecond: number): string {
  if (!(tokensPerSecond > 0)) {
    return '0'
  }
  if (tokensPerSecond >= 1000) {
    return `${(tokensPerSecond / 1000).toFixed(1)}k`
  }
  if (tokensPerSecond >= 10) {
    return String(Math.round(tokensPerSecond))
  }
  return tokensPerSecond.toFixed(1)
}

/** Generation time as "4.2s" under a minute, else "2m 05s". */
export function formatGenerationDuration(generationMs: number): string {
  const totalSeconds = Math.max(0, generationMs) / 1000
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`
  }
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.round(totalSeconds - minutes * 60)
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}
