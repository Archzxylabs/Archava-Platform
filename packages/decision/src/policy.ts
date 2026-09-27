/**
 * Task policy: the rules that decide whether a provider's answer may replace
 * the deterministic one.
 *
 * Two questions live here, and they are asked separately because they fail
 * separately. A provider can be confident and still not be permitted, and it
 * can be permitted and still not confident enough. Collapsing them into one
 * number is how a "confidence" becomes a permission.
 *
 * There is deliberately no global threshold. A single number deciding every
 * task would be right for none of them: the cost of a wrong routing answer — a
 * stale price read from a chunk — is not the cost of a wrong handoff flag,
 * which is that a human reads one extra turn. Each task states its own floor
 * and its own reason, so the reason is reviewable and the floor can be moved
 * for a stated one.
 */
import { DECISION_TASK_DEFINITIONS, type DecisionTask, type TaskAnswer } from './tasks.js'

/**
 * The three modes.
 *
 * `off` makes no provider call at all: it is the absence of the feature, and it
 * must not be able to cost a network round trip. `shadow` calls the provider
 * and returns the baseline as effective — it exists so a provider can be
 * measured against Foundation before it is allowed to change anything.
 * `assist` may apply a provider's answer, under the rules below.
 */
export const ASSIST_MODES = ['off', 'shadow', 'assist'] as const
export type AssistMode = (typeof ASSIST_MODES)[number]

/**
 * What a disagreement means for one task.
 *
 * - `allow`: the candidate may replace the baseline in either direction. Only
 *   for an answer that is advisory and never on a critical path.
 * - `escalate`: the candidate may replace the baseline only when it is an
 *   escalation — equal or higher on the task's ladder. The safe direction for
 *   this task is one-way.
 * - `refuse`: the candidate may never replace the baseline, so the task can be
 *   evaluated and traced while still being held at Foundation behaviour.
 */
export type DisagreementPolicy = 'allow' | 'escalate' | 'refuse'

export interface TaskPolicy {
  /** The confidence the task itself requires, in [0, 1]. */
  readonly minimumConfidence: number
  readonly disagreement: DisagreementPolicy
  /** Why this task has this policy, in the terms §17 or §3 would use. */
  readonly why: string
}

export const TASK_POLICIES: Readonly<Record<DecisionTask, TaskPolicy>> = {
  intent_classification: {
    minimumConfidence: 0.7,
    disagreement: 'allow',
    why:
      'This answer shapes the posture of a reply and nothing else, so a disagreement is ' +
      'worth an audit line rather than a refusal. It cannot open an action: the permitted ' +
      'set comes from ActionPolicy, and a posture that asked for one would still be refused ' +
      'by it. The floor is high because a posture applied to the wrong turn is a turn that ' +
      'reads as unserious.',
  },
  knowledge_routing: {
    minimumConfidence: 0.75,
    disagreement: 'escalate',
    why:
      'The one task where the direction of a disagreement is a correctness question. §17: a ' +
      'live-value turn is answered from the live system or not at all, so a provider that ' +
      'would route a structured-truth turn to retrieval is asking the assistant to quote a ' +
      'stale price under a citation. The other direction is allowed and useful — an ' +
      'ambiguous utterance may be escalated to an identified structured-truth subject, ' +
      'which is strictly safer than guessing from published copy. The floor is the highest ' +
      'of the five because a source change outranks a wording change.',
  },
  clarification: {
    minimumConfidence: 0.6,
    disagreement: 'escalate',
    why:
      'The safe direction is the one that costs a round trip. A provider may raise the flag ' +
      '— if it is not certain this should be asked, Foundation did not ask — but it may not ' +
      'lower one Foundation raised, because suppressing the clarifying question is exactly ' +
      'how a guess gets delivered as an answer. The floor is low: an unnecessary question ' +
      'costs one turn, and a wrong answer costs the trust.',
  },
  handoff_recommendation: {
    minimumConfidence: 0.55,
    disagreement: 'escalate',
    why:
      'The flag tells a human that a turn happened; that is the whole of its power. Raising ' +
      'it is cheap — a human reads a line and moves on — and lowering it is the failure that ' +
      'cannot be undone, because nobody learns the turn was dropped. The floor is the lowest ' +
      'of the five because the cost is asymmetric, not because detection is easy.',
  },
  evidence_sufficiency: {
    minimumConfidence: 0.6,
    disagreement: 'allow',
    why:
      'A coverage estimate is advisory in both directions, and the safe direction is the ' +
      'lower one: a provider lowering the score makes the caller more cautious, which is the ' +
      'direction Foundation would rather be wrong in. Allowing the raise needs a boundary ' +
      'elsewhere, and it has one — the score is a fact about the supplied projected facts, ' +
      'never about the world, and §17’s source rules run independently of it. Nothing grants ' +
      'a permission or confirms an action on the strength of this number.',
  },
}

/** The policy for one task. */
export function taskPolicy(task: DecisionTask): TaskPolicy {
  return TASK_POLICIES[task]
}

/** Whether a declared policy is usable at all. Asserted by the policy tests. */
export function taskPolicyProblem(task: DecisionTask): string | null {
  const policy = TASK_POLICIES[task]
  const confidence = policy.minimumConfidence
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return `policy for ${task} needs a confidence floor inside [0, 1]`
  }
  if (policy.why.trim() === '') return `policy for ${task} needs a reason`
  return null
}

/** Whether `mode` is one of the three. */
export function isAssistMode(mode: unknown): mode is AssistMode {
  return typeof mode === 'string' && (ASSIST_MODES as readonly string[]).includes(mode)
}

/** Narrows an unknown mode, or null. */
export function asAssistMode(mode: unknown): AssistMode | null {
  return isAssistMode(mode) ? mode : null
}

/** Confidence alone: does it clear the floor this task set for itself? */
export function confidenceProblem(policy: TaskPolicy, confidence: number): string | null {
  if (!Number.isFinite(confidence))
    return 'a provider answered with a confidence that is not a number'
  if (confidence < 0 || confidence > 1)
    return 'a provider answered with a confidence outside [0, 1]'
  return confidence >= policy.minimumConfidence ? null : 'below the floor this task set for itself'
}

/**
 * Where an answer sits on the ladder escalation is measured against.
 *
 * Total, and free of casts and coercion: anything that is not an answer this
 * task may return ranks below every real answer, because a malformed value
 * cannot read as an escalation. Validation already ran by the time this is
 * asked — the rank exists so a trace can state the honest relationship between
 * two answers even when one of them is nonsense.
 *
 * The ranking is a property of the declared answer set — the order `options`
 * was written in — and not of the provider, so no provider can redefine what
 * "escalating" means.
 */
export function answerRank(task: DecisionTask, answer: unknown): number {
  const definition = DECISION_TASK_DEFINITIONS[task]
  if (definition.kind === 'boolean') {
    return typeof answer === 'boolean' ? (answer ? 1 : 0) : -1
  }
  if (definition.kind === 'score') {
    return typeof answer === 'number' && Number.isFinite(answer) ? answer : -1
  }
  return definition.options.indexOf(typeof answer === 'string' ? answer : '')
}

export type Agreement = 'equal' | 'escalated' | 'downgraded'

/**
 * How a candidate compares with the baseline, on the task's own ladder.
 *
 * Equality is by value, so a choice answer that names the same option is an
 * agreement regardless of confidence, and a boolean that repeats the baseline
 * is an agreement too.
 */
export function agreementOf(
  task: DecisionTask,
  baseline: TaskAnswer<DecisionTask>,
  candidate: unknown,
): Agreement {
  const from = answerRank(task, baseline)
  const to = answerRank(task, candidate)
  if (to === from) return 'equal'
  return to > from ? 'escalated' : 'downgraded'
}

/**
 * Disagreement alone: does this task's policy permit the move?
 *
 * Asked only after validation, so a candidate here is already a value the task
 * may return. `refuse` answers the same way for every candidate, which is the
 * point of having it.
 */
export function disagreementProblem(
  task: DecisionTask,
  policy: TaskPolicy,
  baseline: TaskAnswer<DecisionTask>,
  candidate: unknown,
): string | null {
  if (policy.disagreement === 'refuse') return `${task} holds its deterministic answer`
  if (policy.disagreement === 'allow') return null
  if (agreementOf(task, baseline, candidate) === 'downgraded') {
    return `${task} does not descend: a provider may not lower what Foundation answered`
  }
  return null
}
