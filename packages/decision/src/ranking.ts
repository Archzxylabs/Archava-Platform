/**
 * Bounded ranked-option primitive for future, explicitly configured tasks.
 * Candidates come from trusted product code; provider scores can only reorder
 * this closed list. No runtime task in the first catalogue invokes it.
 */
export interface ScoredOption {
  readonly id: string
  readonly score: number
  readonly confidence: number
}

export function rankScoredOptions(
  validCandidateIds: readonly string[],
  proposed: readonly ScoredOption[],
): readonly ScoredOption[] | null {
  const valid = new Set(validCandidateIds)
  if (valid.size !== validCandidateIds.length || valid.size === 0 || proposed.length !== valid.size)
    return null
  const seen = new Set<string>()
  for (const item of proposed) {
    if (
      !valid.has(item.id) ||
      seen.has(item.id) ||
      !Number.isFinite(item.score) ||
      item.score < 0 ||
      item.score > 1 ||
      !Number.isFinite(item.confidence) ||
      item.confidence < 0 ||
      item.confidence > 1
    )
      return null
    seen.add(item.id)
  }
  const index = new Map(validCandidateIds.map((id, place) => [id, place]))
  return [...proposed].sort(
    (a, b) => b.score - a.score || (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0),
  )
}
