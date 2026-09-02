import { useMemo, useRef } from 'react'
import { createCombinedDiffSectionIndexMap } from './combined-diff-section-identity'

type CombinedDiffSectionIndexCache = {
  entrySignature: string
  sectionCount: number
  map: Map<string, number>
  keys: string[]
}

/**
 * Section-key to section-index map that keeps its identity while the section keys do.
 *
 * On-demand section loads replace the sections array on every fetch, so a freshly built Map would
 * be a memo miss for every consumer — the file tree would re-render all of its rows continuously
 * while the user scrolls a large diff.
 */
export function useCombinedDiffSectionIndexMap({
  entrySignature,
  sections
}: {
  entrySignature: string
  sections: readonly { key: string }[]
}): Map<string, number> {
  const cacheRef = useRef<CombinedDiffSectionIndexCache | null>(null)
  return useMemo(() => {
    const previous = cacheRef.current
    // Section content/loading updates preserve entry order and keys. The entry signature and
    // count usually change when the navigable structure changes, but compare keys as a guard for
    // same-sized/reused signatures (and to keep this cache correct if a caller rebuilds sections).
    if (
      previous?.entrySignature === entrySignature &&
      previous.sectionCount === sections.length &&
      sections.every((section, index) => previous.keys[index] === section.key)
    ) {
      return previous.map
    }
    const map = createCombinedDiffSectionIndexMap(sections)
    cacheRef.current = {
      entrySignature,
      sectionCount: sections.length,
      map,
      keys: sections.map((section) => section.key)
    }
    return map
  }, [entrySignature, sections])
}
