/**
 * The Decision Layer's task ids and answer vocabularies, for the offline
 * evaluation corpus and its metrics.
 *
 * This file deliberately duplicates the vocabulary that lives in the tenant
 * configuration schema (`packages/config/src/client/schema.ts`) and in the task
 * catalogue package. It imports neither, because the point of this tool is that
 * it can score a provider that does not exist yet, in a repository state where
 * that provider's package may not exist at all. If the three spellings ever
 * drift, `corpus.test.ts` fails on the first case it cannot interpret.
 *
 * Nothing here reaches the network. Every label below is a closed set, and an
 * answer outside its task's set is not a novel insight — it is a bug in the
 * provider, and the harness reports it as such rather than scoring it as a
 * near-miss.
 */

export const DECISION_TASK_IDS = [
  'intent_classification',
  'knowledge_routing',
  'clarification',
  'handoff_recommendation',
  'evidence_sufficiency',
] as const

export type DecisionTaskId = (typeof DECISION_TASK_IDS)[number]

/**
 * What the visitor is asking, as a bounded set of intents.
 *
 * These are the shapes the reference tenant actually receives, so a provider
 * measured on this corpus is measured on work it would really be asked to do.
 * They are not a taxonomy of human language: `general_inquiry` is where
 * everything ordinary goes, and the specific intents exist because each one
 * changes what the turn should do next.
 */
const INTENT_LABELS = [
  'availability_inquiry',
  'pricing_inquiry',
  'policy_inquiry',
  'status_inquiry',
  'support_request',
  'recommendation_request',
  'comparison_request',
  'handoff_request',
  'purchase_request',
  'general_inquiry',
] as const

/**
 * Which knowledge may answer (PRD §17).
 *
 * Two labels, not a preference: a structured-truth question is one the tenant's
 * live system owns, and retrieval may only supply supporting copy — never the
 * answer. The ordering matters to the critical-failure rule in `critical.ts`.
 */
const KNOWLEDGE_ROUTING_LABELS = ['structured_truth', 'retrieval'] as const

/** Whether the turn should ask something back before answering. */
const CLARIFICATION_LABELS = ['clarify', 'answer'] as const

/** Whether a human should take this over. */
const HANDOFF_LABELS = ['handoff', 'self_serve'] as const

/** Whether the tenant's own knowledge can answer this at all. */
const EVIDENCE_LABELS = ['sufficient', 'insufficient'] as const

export const TASK_LABELS: Readonly<Record<DecisionTaskId, readonly string[]>> = {
  intent_classification: INTENT_LABELS,
  knowledge_routing: KNOWLEDGE_ROUTING_LABELS,
  clarification: CLARIFICATION_LABELS,
  handoff_recommendation: HANDOFF_LABELS,
  evidence_sufficiency: EVIDENCE_LABELS,
}

export type IntentLabel = (typeof INTENT_LABELS)[number]
export type KnowledgeRoutingLabel = (typeof KNOWLEDGE_ROUTING_LABELS)[number]
export type ClarificationLabel = (typeof CLARIFICATION_LABELS)[number]
export type HandoffLabel = (typeof HANDOFF_LABELS)[number]
export type EvidenceLabel = (typeof EVIDENCE_LABELS)[number]

/** Every label a task may return, in the order the report prints them. */
export function labelsOf(task: DecisionTaskId): readonly string[] {
  return TASK_LABELS[task]
}

/** True when `label` is one `task` is allowed to return. */
export function isKnownLabel(task: DecisionTaskId, label: string): boolean {
  return labelsOf(task).includes(label)
}
