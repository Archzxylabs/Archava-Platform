/**
 * The orchestrator: the only place a provider's answer can become effective.
 *
 * Everything upstream of this file decides *questions*; this decides *whether
 * an answer is allowed to matter*. That separation is the whole design, and it
 * exists because the failure it prevents is not a crash — it is a model's guess
 * arriving in a turn wearing the clothes of the deterministic answer, with
 * nothing in the trace to say which of the two anyone is looking at.
 *
 * So each task is judged twice, by two questions that fail separately:
 *
 * 1. **Is the answer usable at all?** Validation, at run time, on the reply as
 *    parsed JSON. A type on the TypeScript side of a wire has seen nothing.
 * 2. **Is this task *permitted* to accept it?** The task's own confidence floor
 *    and its own disagreement policy. Never a shared number, because a single
 *    threshold would be right for none of the five.
 *
 * And it answers a third question every time: *what did the caller already
 * have?* The baseline is handed in, per task, by the caller — from code or from
 * the structured source. It is never defaulted here, because a fallback this
 * package invented would be a second opinion wearing the clothes of the first,
 * and the hierarchy's entire argument is that there is only one.
 *
 * Three modes, and the difference between them is which of the above runs:
 *
 * - `off` makes no call at all. Not a call that is discarded — no call.
 * - `shadow` makes the call and reports what it would have done, then returns
 *   the baseline. It exists so a provider can be measured before it changes
 *   anything, which means a shadow trace is a measurement, not a log line.
 * - `assist` may apply an answer, for a task that was configured, that
 *   validated, that cleared its own floor, and that did not move the task in a
 *   direction its policy calls unsafe.
 *
 * Every other path — a throw, a timeout, a refusal, a malformed reply, a low
 * confidence — returns the baseline, and says so. Nothing here retries.
 */
import { DecisionError, type DecisionProvider, type DecisionRequest } from '@archava/adapters'
import {
  asDecisionTask,
  baselineProblem,
  decisionQuestionFor,
  type BaselineAnswer,
  type DecisionBaseline,
  type DecisionTask,
  type TaskAnswer,
} from './tasks.js'
import {
  agreementOf,
  asAssistMode,
  confidenceProblem,
  disagreementProblem,
  taskPolicy,
  type Agreement,
  type AssistMode,
} from './policy.js'
import { checkDecisionResponse, type ProviderIdentity, type ResponseCheck } from './validate.js'

/**
 * A turn, as the decision layer is handed it.
 *
 * The questions are deliberately not the caller's to write. The orchestrator
 * builds them from the catalogue, in the catalogue's words, for exactly the
 * tasks it was given baselines for — which means a tenant config cannot reword
 * a prompt, add an option, or hand a task the wrong kind. The port's note that
 * a request is "assembled by the caller" is still true; this *is* the caller,
 * and the provider is on the far side of it.
 */
export type DecisionTurn = Omit<DecisionRequest, 'questions'>

/** Where an effective answer came from. Never invented, always attributable. */
export type AnswerSource = 'baseline' | 'provider'

/** The answer a caller should act on, for one task. */
export interface EffectiveAnswer<T extends DecisionTask> {
  readonly task: T
  readonly answer: TaskAnswer<T>
  readonly source: AnswerSource
  /** Why this is the answer, in the words the trace carries. */
  readonly basis: string
}

export type EffectiveDecision = { [T in DecisionTask]: EffectiveAnswer<T> }[DecisionTask]

/** What a provider offered for one task, before policy looked at it. */
export interface CandidateAnswer<T extends DecisionTask> {
  readonly task: T
  readonly answer: TaskAnswer<T>
  readonly confidence: number
  readonly agreement: Agreement
}

export type CandidateDecision = { [T in DecisionTask]: CandidateAnswer<T> }[DecisionTask]

/**
 * What became of the provider's side of one task.
 *
 * `not_called` is a real outcome and not an absence: it is the record that mode
 * `off` cost nothing, which is a claim worth being able to check.
 */
export type TraceOutcome =
  | 'not_called'
  | 'answered'
  | 'refused'
  | 'failed'
  | 'timeout'
  | 'malformed'

/**
 * One line of the audit trail, per task.
 *
 * Metadata only, by construction. There is no field here that could hold an
 * utterance, a piece of evidence, a credential, or a tenant's state — not
 * because a caller is trusted to fill it in carefully, but because the shape
 * has nowhere to put them. The tenant id is absent for the same reason in the
 * other direction: a trace is emitted into a turn the caller is already
 * holding, and a log line that names a tenant is a log line that can be read
 * across tenants.
 */
export interface DecisionTrace {
  readonly task: DecisionTask
  readonly mode: AssistMode
  readonly providerId: string | null
  readonly model: string | null
  readonly outcome: TraceOutcome
  /** Why the effective answer is the effective one. Always readable. */
  readonly reason: string
  readonly confidence: number | null
  readonly candidate: CandidateDecision | null
  readonly effective: EffectiveDecision
  /** How the candidate compares with the baseline, or null if there was none. */
  readonly agreement: Agreement | null
  /**
   * Whether the provider's answer is the one in force. A provider that agreed
   * with the baseline is still applied — it is the provider that answered, and
   * `agreement` says whether that made a difference.
   */
  readonly applied: boolean
  /**
   * Whether assist *would* apply the candidate, had the mode and the config
   * permitted it. This is what makes a shadow run a measurement rather than a
   * shrug: it reports the gates the candidate cleared, without opening them.
   */
  readonly wouldApply: boolean
  readonly latencyMs: number | null
}

export interface DecisionOrchestratorOptions {
  /** The provider to consult. Omitted is legal, and only in mode `off`. */
  readonly provider?: DecisionProvider
  readonly mode: AssistMode
  /**
   * The tasks `assist` may replace a baseline for.
   *
   * Empty is not a synonym for "all": it means nothing may be replaced, which
   * is the safe reading of a config that says nothing.
   */
  readonly enabledTasks?: readonly DecisionTask[]
  /** Tenant floors can tighten, never relax, each task's built-in floor. */
  readonly minimumConfidence?: Partial<Readonly<Record<DecisionTask, number>>>
  /** Milliseconds before a provider is abandoned. Defaults to 3 seconds. */
  readonly timeoutMs?: number
  /** Milliseconds since an arbitrary origin, for latency. Injected for tests. */
  readonly now?: () => number
  readonly onTrace?: (trace: DecisionTrace) => void
}

export interface DecisionRun {
  readonly providerId: string | null
  readonly model: string | null
  readonly mode: AssistMode
  /** One per asked task, in the order the baselines were given. */
  readonly decisions: readonly EffectiveDecision[]
  readonly traces: readonly DecisionTrace[]
  readonly latencyMs: number | null
}

/** What became of the single provider call a turn is allowed to make. */
type Reply =
  | { readonly kind: 'not_called'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'timeout'; readonly reason: string }
  | { readonly kind: 'malformed'; readonly reason: string }
  | { readonly kind: 'answered'; readonly checked: CheckedResponseAlias }

/** The provider's call, settled one way or another. */
type Settled =
  | { readonly status: 'answered'; readonly response: unknown }
  | { readonly status: 'failed'; readonly reason: string }
  | { readonly status: 'timeout' }

type CheckedResponseAlias = Extract<ResponseCheck, { ok: true }>['checked']

/**
 * An answer in the erased form the boundary speaks.
 *
 * `validate.ts` hands back a task and its answer side by side, because both a
 * map key and a JSON wire speak that shape, and this orchestrator builds them
 * the same way. The correlation between the two is real, and it is enforced at
 * the boundary rather than here; the correlated type is published through one
 * seam below, so there is a witness for the stitch and it appears once.
 */
interface AnswerPair {
  readonly task: DecisionTask
  readonly answer: TaskAnswer<DecisionTask>
  readonly source: AnswerSource
  readonly basis: string
}

/**
 * A candidate in the erased form the orchestrator builds it in.
 *
 * The same situation as `AnswerPair` above, for the same reason: the published
 * correlated union cannot be reached from a value the body is holding, so the
 * body holds this and closes it at its own seam below.
 */
interface CandidatePair {
  readonly task: DecisionTask
  readonly answer: TaskAnswer<DecisionTask>
  readonly confidence: number
  readonly agreement: Agreement
}

/** One task answered, and the line that explains it. */
interface Outcome {
  readonly decision: EffectiveDecision
  readonly trace: DecisionTrace
}

const GATES_OPEN = 'every gate this task set for itself is open'
const TIMED_OUT = 'the provider did not answer in time'
const NOT_READY = 'the provider reported itself not ready'

export class DecisionOrchestrator {
  private readonly provider: DecisionProvider | null
  private readonly mode: AssistMode
  private readonly enabled: ReadonlySet<DecisionTask>
  private readonly minimumConfidence: Readonly<Partial<Record<DecisionTask, number>>>
  private readonly timeoutMs: number
  private readonly now: () => number
  private readonly onTrace: ((trace: DecisionTrace) => void) | undefined

  constructor(options: DecisionOrchestratorOptions) {
    const mode = asAssistMode(options.mode)
    if (mode === null) {
      throw new DecisionError(`"${String(options.mode)}" is not one of the three assist modes`)
    }
    const provider = options.provider
    if (mode !== 'off' && provider === undefined) {
      throw new DecisionError(`mode ${mode} needs a provider, and none was configured`)
    }
    this.mode = mode
    this.provider = provider ?? null
    this.enabled = enabledTasks(options.enabledTasks)
    this.minimumConfidence = confidenceFloors(options.minimumConfidence)
    this.timeoutMs = deadlineOf(options.timeoutMs)
    this.now = options.now ?? (() => Date.now())
    this.onTrace = options.onTrace
  }

  /**
   * Answer every task in `baselines`, applying a provider where policy allows.
   *
   * Throws for a malformed turn or a malformed baseline set, because those are
   * the caller's own bugs and a turn that cannot be asked is not a turn to
   * answer from nothing. Nothing a provider does is ever thrown: a provider's
   * failure is the provider's business, and it lands on the baseline with a
   * reason attached.
   */
  async run(turn: DecisionTurn, baselines: readonly DecisionBaseline[]): Promise<DecisionRun> {
    const problem = turnProblem(turn)
    if (problem !== null) throw new DecisionError(problem)
    const asked = baselineMap(
      this.mode === 'off'
        ? baselines
        : baselines.filter((baseline) => this.enabled.has(baseline.task)),
    )
    if (asked.size === 0) {
      return {
        providerId: this.provider?.providerId ?? null,
        model: this.provider?.model ?? null,
        mode: this.mode,
        decisions: [],
        traces: [],
        latencyMs: null,
      }
    }

    const request: DecisionRequest = {
      tenantId: turn.tenantId,
      utterance: turn.utterance,
      locale: turn.locale,
      evidence: turn.evidence,
      questions: [...asked.keys()].map((task) => decisionQuestionFor(task)),
    }

    const started = this.now()
    const reply = await this.ask(request)
    const latency = reply.kind === 'not_called' ? null : Math.max(0, this.now() - started)

    const decisions: EffectiveDecision[] = []
    const traces: DecisionTrace[] = []
    for (const [task, baseline] of asked) {
      const outcome = this.outcomeFor(task, baseline, reply, latency)
      decisions.push(outcome.decision)
      traces.push(outcome.trace)
      try {
        this.onTrace?.(outcome.trace)
      } catch {
        // Observability is never allowed to take down a visitor turn.
      }
    }

    return {
      providerId: this.provider?.providerId ?? null,
      model: this.provider?.model ?? null,
      mode: this.mode,
      decisions,
      traces,
      latencyMs: latency,
    }
  }

  /** The one provider call, and everything that can go wrong with it. */
  private async ask(request: DecisionRequest): Promise<Reply> {
    const provider = this.provider
    if (this.mode === 'off' || provider === null) {
      return { kind: 'not_called', reason: 'this mode makes no provider call' }
    }
    try {
      if (providerHealthProblem(provider) !== null) {
        return { kind: 'failed', reason: NOT_READY }
      }
    } catch {
      return { kind: 'failed', reason: NOT_READY }
    }
    const expected: ProviderIdentity = {
      providerId: provider.providerId,
      model: provider.model,
    }

    const deadline = this.timeoutMs
    let timer: ReturnType<typeof setTimeout> | undefined
    const expiry = new Promise<Settled>((resolve) => {
      timer = setTimeout(() => resolve({ status: 'timeout' }), deadline)
    })

    const settled = await Promise.race([
      Promise.resolve()
        .then(() => provider.decide(request))
        .then((response): Settled => ({ status: 'answered', response }))
        .catch((error: unknown): Settled => ({ status: 'failed', reason: describe(error) })),
      expiry,
    ])
    clearTimeout(timer)

    if (settled.status === 'timeout') return { kind: 'timeout', reason: TIMED_OUT }
    if (settled.status === 'failed') return { kind: 'failed', reason: settled.reason }
    const check = checkDecisionResponse(settled.response, request, expected)
    if (!check.ok) return { kind: 'malformed', reason: check.problem }
    return { kind: 'answered', checked: check.checked }
  }

  /**
   * Answer one task: run the gates in order, and say which one held.
   *
   * Generic over the task, and the generic is load-bearing rather than
   * stylistic: it is what keeps `answer` tied to the task it was asked about,
   * so a caller narrowing on `task` narrows on `answer` in the same breath.
   */
  private outcomeFor<T extends DecisionTask>(
    task: T,
    baseline: BaselineAnswer<T>,
    reply: Reply,
    latencyMs: number | null,
  ): Outcome {
    const providerId = this.provider?.providerId ?? null
    const model = this.provider?.model ?? null
    const shared = { task, mode: this.mode, providerId, model, latencyMs }
    /** The baseline, in the erased form everything below is built from. */
    const heldAnswer: AnswerPair = {
      task,
      answer: baseline.answer,
      source: 'baseline',
      basis: baseline.source,
    }
    const held = (
      outcome: TraceOutcome,
      reason: string,
      heldCandidate: CandidatePair | null,
    ): Outcome => ({
      decision: asEffective(heldAnswer),
      trace: {
        ...shared,
        outcome,
        reason,
        confidence: heldCandidate === null ? null : heldCandidate.confidence,
        candidate: heldCandidate === null ? null : asCandidate(heldCandidate),
        effective: asEffective(heldAnswer),
        agreement: heldCandidate === null ? null : heldCandidate.agreement,
        applied: false,
        wouldApply: false,
      },
    })

    if (reply.kind !== 'answered') return held(reply.kind, reply.reason, null)

    const checked = reply.checked.decisions.get(task)
    if (checked === undefined) {
      const refusal = reply.checked.refusals.get(task)
      return held(
        'refused',
        refusal === undefined
          ? 'the provider did not answer this task'
          : 'the provider refused this task',
        null,
      )
    }

    const candidate: CandidatePair = {
      task,
      answer: checked.answer,
      confidence: checked.confidence,
      agreement: agreementOf(task, baseline.answer, checked.answer),
    }
    const opened = this.enabled.has(task) ? this.gateReason(task, baseline, candidate) : null
    if (this.mode === 'shadow') {
      const reason =
        opened === null
          ? 'shadow mode keeps the deterministic answer'
          : `shadow mode keeps it: ${opened}`
      return {
        decision: asEffective(heldAnswer),
        trace: {
          ...shared,
          outcome: 'answered',
          reason,
          confidence: candidate.confidence,
          candidate: asCandidate(candidate),
          effective: asEffective(heldAnswer),
          agreement: candidate.agreement,
          applied: false,
          wouldApply: opened === null,
          latencyMs,
        },
      }
    }
    if (opened !== null) return held('answered', opened, candidate)

    const basis = `${providerId ?? 'a provider'} answered ${task} at ${candidate.confidence}`
    const applied: AnswerPair = {
      task,
      answer: checked.answer,
      source: 'provider',
      basis,
    }
    return {
      decision: asEffective(applied),
      trace: {
        ...shared,
        outcome: 'answered',
        reason: GATES_OPEN,
        confidence: candidate.confidence,
        candidate: asCandidate(candidate),
        effective: asEffective(applied),
        agreement: candidate.agreement,
        applied: true,
        wouldApply: true,
        latencyMs,
      },
    }
  }

  /**
   * Every gate a candidate must clear, or the first one that held it.
   *
   * Ordered so the reason names the most useful thing: a task nobody configured
   * is reported as unconfigured rather than as a floor failure, and a floor
   * failure is reported as a floor rather than as a downgrade.
   */
  private gateReason<T extends DecisionTask>(
    task: T,
    baseline: BaselineAnswer<T>,
    candidate: CandidatePair,
  ): string | null {
    if (!this.enabled.has(task)) return `${task} is not configured for assist`
    const policy = taskPolicy(task)
    const configured = this.minimumConfidence[task]
    const confidence = confidenceProblem(
      { ...policy, minimumConfidence: Math.max(policy.minimumConfidence, configured ?? 0) },
      candidate.confidence,
    )
    if (confidence !== null) return confidence
    return disagreementProblem(task, policy, baseline.answer, candidate.answer)
  }
}

/** Whether a turn is worth asking anything about. */
function turnProblem(turn: DecisionTurn): string | null {
  if (typeof turn.tenantId !== 'string' || turn.tenantId.trim() === '') {
    return 'a decision turn needs a tenant id'
  }
  if (typeof turn.locale !== 'string' || turn.locale.trim() === '') {
    return 'a decision turn needs a locale'
  }
  if (typeof turn.utterance !== 'string') return 'a decision turn needs an utterance'
  return null
}

/** The baselines as a map, refusing a set that cannot be answered from. */
function baselineMap(
  baselines: readonly DecisionBaseline[],
): ReadonlyMap<DecisionTask, BaselineAnswer<DecisionTask>> {
  const asked = new Map<DecisionTask, BaselineAnswer<DecisionTask>>()
  for (const baseline of baselines) {
    const problem = baselineProblem(baseline)
    if (problem !== null) throw new DecisionError(problem)
    if (asked.has(baseline.task)) {
      throw new DecisionError(`a turn was given two baselines for ${baseline.task}`)
    }
    asked.set(baseline.task, baseline)
  }
  return asked
}

/** The tasks assist may touch, with a config typo failing closed. */
function enabledTasks(tasks: readonly DecisionTask[] | undefined): ReadonlySet<DecisionTask> {
  const enabled = new Set<DecisionTask>()
  for (const task of tasks ?? []) {
    const known = asDecisionTask(task)
    if (known === null) throw new DecisionError(`"${String(task)}" is not a task in the catalogue`)
    enabled.add(known)
  }
  return enabled
}

/** A deadline this package will honour, or none. */
function deadlineOf(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return 3_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new DecisionError('decision timeout must be a positive finite number of milliseconds')
  }
  return timeoutMs
}

function confidenceFloors(
  floors: Partial<Readonly<Record<DecisionTask, number>>> | undefined,
): Readonly<Partial<Record<DecisionTask, number>>> {
  const checked: Partial<Record<DecisionTask, number>> = {}
  for (const [id, value] of Object.entries(floors ?? {})) {
    const task = asDecisionTask(id)
    if (task === null || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new DecisionError('invalid decision task confidence floor')
    }
    checked[task] = value
  }
  return checked
}

/** Provider error text may contain credentials or payload fragments. */
function describe(_error: unknown): string {
  return 'the decision provider failed'
}

/**
 * The one place the erased pair becomes the published correlated union.
 *
 * An answer is built from a task and the answer that task is allowed to give —
 * the provider's reply already checked it against its question id at the
 * boundary, and the baseline was checked against its own task on the way in.
 * The cast is a seam with a witness, and every other path in the orchestrator
 * works in the correlated form above so this is the only one.
 */
function asEffective(pair: AnswerPair): EffectiveDecision {
  return pair as EffectiveDecision
}

/**
 * The one place the erased candidate becomes the published correlated union.
 *
 * `asEffective`'s twin. The candidate is built from a task and an answer the
 * boundary already checked against that task, so the value fits the union it is
 * published as; the seam exists because a correlated union cannot be reached by
 * assignment from the erased form, and it appears once for the same reason.
 */
function asCandidate(pair: CandidatePair): CandidateDecision {
  return pair as CandidateDecision
}

/**
 * Whether a provider has declared itself unusable.
 *
 * The port deliberately types `health` as `unknown`: a provider is a foreign
 * object, its health check is its own, and this package's response to a health
 * object it cannot read is to carry on and let the reply be judged. Only an
 * explicit `ready: false` is read as unusable, because guessing that another
 * provider's shape means "not ok" would be declining turns for a reason the
 * provider never gave.
 */
function providerHealthProblem(provider: DecisionProvider): string | null {
  const health: unknown = provider.health
  if (typeof health !== 'object' || health === null) return null
  return (health as { ready?: unknown }).ready === false ? NOT_READY : null
}
