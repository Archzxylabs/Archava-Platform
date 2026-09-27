/** Exit gates for the explicit live evaluation, independent of network code. */
import type { CriticalFailure } from './critical.js'
import type { UnsupportedSufficient } from './evidence-metrics.js'

export interface ReferenceGates {
  readonly transportOrSchemaFailures: number
  readonly refusals: number
  readonly raw: { readonly criticalFailures: readonly CriticalFailure[] }
  readonly effective: { readonly criticalFailures: readonly CriticalFailure[] }
}

export interface EvidenceGates {
  readonly transportOrSchemaFailures: number
  readonly refusals: number
  readonly malformed: number
  readonly raw: { readonly unsupportedSufficient: readonly UnsupportedSufficient[] }
}

/**
 * A zero exit means no provider/format failure and no protected truth miss.
 * Ordinary evidence classification errors remain in the report for review;
 * they are not silently promoted into a deployment acceptance threshold.
 */
export function liveGateFailures(
  reference: ReferenceGates,
  evidence: EvidenceGates,
): readonly string[] {
  const failures: string[] = []
  if (reference.transportOrSchemaFailures > 0) failures.push('reference transport/schema failure')
  if (reference.refusals > 0) failures.push('reference refusal')
  if (reference.raw.criticalFailures.length > 0)
    failures.push('provider downgraded structured truth to retrieval')
  if (reference.effective.criticalFailures.length > 0)
    failures.push('effective routing violated structured truth')
  if (evidence.transportOrSchemaFailures > 0) failures.push('evidence transport/schema failure')
  if (evidence.refusals > 0) failures.push('evidence refusal')
  if (evidence.malformed > 0) failures.push('malformed evidence response')
  if (evidence.raw.unsupportedSufficient.some((item) => item.liveSubject !== null))
    failures.push('published evidence marked sufficient for protected live truth')
  return failures
}
