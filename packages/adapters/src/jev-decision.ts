/**
 * TypeSafe AI Jev, behind {@link DecisionProvider} — and only ever on a server.
 *
 * Jev is a *System One* model: it answers bounded questions with typed values and
 * calibrated probabilities instead of prose. That is the same shape as this port,
 * which is why it is the first provider to sit behind it — and why the mapping in
 * this file is a field rename rather than a parse. Nothing here turns a Jev answer
 * into a sentence, because a sentence would be a `BrainReply`, and would drag the
 * whole citation and action machinery behind a judgment that has neither.
 *
 * Three things about this file are deliberate and worth stating before the code:
 *
 * 1. **It is not exported from `./index.ts`.** The reference browser app imports
 *    the package root, and a root that reached this module would pull a paid API
 *    client into a bundle that ships to visitors. It is reached through the
 *    `./server` subpath in `package.json`, which a browser entry has no reason to
 *    import.
 * 2. **It reads no environment variable.** The credential is injected by whoever
 *    constructs the provider, on a server, from a secret store. A module that
 *    reads `process.env` itself cannot be tested without a process, and a module
 *    that cannot be tested without a process ends up tested by shipping it.
 * 3. **The network boundary is injected.** Every test runs against a fake, so the
 *    suite needs no key, no network, and no budget for latency.
 *
 * What this provider will not do, matching the port it implements: it never
 * writes to a store, never dispatches an action, never reads a clock, and never
 * turns "I could not answer" into a guess. A transport failure is a refusal, not
 * a default `false` — the difference being that a refusal is visible in the audit
 * trail and a default is not.
 */

import {
  DecisionError,
  decisionQuestionProblem,
  type Decision,
  type DecisionHealth,
  type DecisionProvider,
  type DecisionQuestion,
  type DecisionRefusal,
  type DecisionRequest,
  type DecisionResult,
} from './decision.js'

/**
 * The documented endpoint: `POST https://api.typesafe.ai/v1/systemone`.
 *
 * A constant rather than an option default, because it is the one string in this
 * file a credential is sent to and it should be read in the same place it is
 * reasoned about.
 */
const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

/** A vendor-neutral label, so no downstream code has to learn the vendor. */
export const JEV_PROVIDER_ID = 'typesafe-jev'

/**
 * The rolling alias Jev documents as its default.
 *
 * The API response resolves it to a concrete version. The vendor-neutral port
 * records the configured model identity so the orchestrator can verify that the
 * reply came from the provider it asked. A future metadata field can carry the
 * resolved version without weakening that identity check.
 */
export const JEV_DEFAULT_MODEL = 'jev-latest'

/**
 * The environment variable a server reads the key from.
 *
 * Exported so the readiness message names the real variable instead of a hint.
 * This module never reads it — it is documentation for the bootstrap that does.
 */
export const JEV_API_KEY_ENV = 'TYPESAFE_API_KEY'

/** Jev's documented ceiling on the options of a `choice` question. */
const MAX_CHOICE_OPTIONS = 255

/** Jev's documented floor and ceiling on the levels of a `score` question. */
const MIN_SCORE_LEVELS = 2
const MAX_SCORE_LEVELS = 10

/** How many evenly spaced anchors are used when a range is not a whole ladder. */
const ANCHOR_COUNT = MAX_SCORE_LEVELS

/**
 * The adapter's own ceiling on a single call.
 *
 * The API documents no request timeout, which means its latency is unbounded
 * from this side, and a decision that arrives after the turn it was asked in is
 * worse than one that never arrived. Ten seconds is far above the 70–500ms the
 * docs report and far below a visitor's patience. It is an option so a caller
 * can make it stricter; it cannot be made zero.
 */
const DEFAULT_TIMEOUT_MS = 10_000

/**
 * The noul threshold. Jev defines 0 as no, 1 as yes, and 0.5 as equally easy
 * either way, so the midpoint is the only threshold the number itself supports.
 * A caller that wants a different one should ask a `score` question instead.
 */
const NOUL_THRESHOLD = 0.5

/**
 * The one network boundary, injected.
 *
 * The adapter owns the timeout, so a transport that ignores the signal is still
 * bounded — the timeout is raced against the transport as well as signalled into
 * it. That is why the seam is a whole request rather than a `fetch` reference: a
 * `fetch` seam would let a mock quietly defeat the bound.
 */
export interface JevTransport {
  post(request: JevHTTPRequest): Promise<JevHTTPResponse>
}

/** The injected transport sees the bearer header; keep mocks and logs private. */
export interface JevHTTPRequest {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  readonly signal?: AbortSignal
}

/**
 * A transport's outcome, reduced to what a decision can be made from.
 *
 * Status and body, no headers: a 429's `Retry-After` would be the caller's to
 * honour, and this adapter does not retry. A judgment is asked once per turn;
 * retrying it doubles the latency of a turn that has already waited, and the
 * refusal is what tells the caller to fall back.
 */
export interface JevHTTPResponse {
  readonly status: number
  readonly body: string
}

export interface JevDecisionProviderOptions {
  /**
   * The bearer credential. Absent, null, or blank means *not ready* rather than
   * *broken*: the provider can be constructed in an ordinary CI run and will say
   * so through {@link DecisionProvider.health}.
   */
  readonly apiKey?: string | null
  /** Rolling alias or pinned version. Defaults to {@link JEV_DEFAULT_MODEL}. */
  readonly model?: string
  /** Override for a proxy. Defaults to {@link JEV_ENDPOINT}. */
  readonly endpoint?: string
  /** The adapter's ceiling. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number
  /** The network boundary. Defaults to the global `fetch`. */
  readonly transport?: JevTransport
}

/**
 * A question this provider has decided it can ask, in Jev's own shape.
 *
 * `scale` is carried rather than recomputed because the score answer comes back
 * as a level *index*, and translating that index into the question's bounds has
 * to use the same ladder the criteria were built from. Recomputing it would mean
 * an impossible branch in the interpreter — a scale that was representable when
 * it was sent and was not when it was read.
 */
interface JevSendable {
  readonly question: DecisionQuestion
  readonly scale: JevScoreScale | null
  readonly native: JevNativeQuestion
}

/** What planning a request produced: questions to send, and questions to refuse. */
interface JevQuestionPlan {
  readonly send: readonly JevSendable[]
  readonly refused: readonly DecisionRefusal[]
}

/**
 * A `score` question as Jev wants it: 2 to 10 descriptors, where the level is the
 * descriptor's own array index.
 *
 * The port asks for arbitrary numeric bounds, so the ladder is built to fit: a
 * range of whole numbers inside 2..10 becomes exactly those numbers, and anything
 * else becomes ten evenly spaced anchors. `answer` is the affine map back, so a
 * fractional level index lands inside the bounds the question was asked with.
 */
interface JevScoreScale {
  readonly levels: readonly string[]
  readonly levelCount: number
  answer(levelIndex: number): number
}

/** A question in the wire shape, built from the port's shape. */
type JevNativeQuestion =
  | { readonly type: 'noul'; readonly instructions: string }
  | {
      readonly type: 'choice'
      readonly instructions: string
      readonly criteria: Readonly<Record<string, string>>
    }
  | { readonly type: 'score'; readonly instructions: string; readonly criteria: readonly string[] }

interface JevRequestBody {
  readonly model: string
  readonly state: unknown
  readonly questions: Readonly<Record<string, JevNativeQuestion>>
}

/**
 * A failure this adapter produced on its own — a timeout, a status it will not
 * interpret, a body that is not JSON.
 *
 * Its message *is* the refusal reason, which is why the class exists: the catch
 * site in `decide` has nothing better to say, and "the transport threw" is not a
 * sentence anyone can act on.
 */
class JevTransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JevTransportError'
  }
}

const REASON = {
  timeout: 'the provider did not answer within the adapter timeout',
  unreachable: 'the request to the provider did not complete',
  unserialisable: 'the request could not be serialised as JSON',
  notJson: 'the provider returned a body that is not JSON',
  noModel: 'the provider response named no model',
  noAnswers: 'the provider response carried no answer map',
  noAnswer: 'the provider returned no answer for this question',
  duplicateId: 'the request asked this question id more than once',
  noul: 'the provider returned a noul outside the documented [0, 1] range',
  choice: 'the provider returned a choice that is not one of the offered options',
  choiceConfidence: 'the provider returned a confidence outside the documented [0, 1] range',
  score: 'the provider returned a score outside the level range of its own question',
  scoreConfidence: 'the provider returned a confidence outside the documented [0, 1] range',
} as const

/** Statuses Jev documents, and what each one means to a caller reading a refusal. */
const STATUS_REASON: Readonly<Record<number, string>> = {
  401: 'the provider rejected the credential (HTTP 401)',
  422: 'the provider rejected the request body as invalid (HTTP 422)',
  429: 'the provider rate limited the request (HTTP 429)',
  529: 'the provider was overloaded (HTTP 529)',
}

/**
 * Why a status is a refusal, or `null` when it is not.
 *
 * Checked in one place — `interpret` — rather than in the `fetch` transport, so
 * that the status is treated as a fact about the answer rather than as a detail
 * of the default transport. An injected transport that reports 429 gets the same
 * refusal the real one would produce, instead of having its body parsed for an
 * answer it was never sent.
 */
function statusReason(status: number): string | null {
  const documented = STATUS_REASON[status]
  if (documented !== undefined) return documented
  if (status >= 400) return `the provider returned HTTP ${status}`
  return null
}

export class JevDecisionProvider implements DecisionProvider {
  readonly providerId = JEV_PROVIDER_ID

  /**
   * The configured model, not the resolved one.
   *
   * This is what the provider was built with — `jev-latest`, an alias. Each
   * result reports what that alias actually resolved to, because the alias is a
   * standing instruction and the version is the fact.
   */
  readonly model: string

  private readonly apiKey: string | null
  private readonly endpoint: string
  private readonly timeoutMs: number
  private readonly transport: JevTransport

  constructor(options: JevDecisionProviderOptions = {}) {
    this.apiKey = readKey(options.apiKey)
    this.model = readModel(options.model)
    this.endpoint = readEndpoint(options.endpoint)
    this.timeoutMs = readTimeout(options.timeoutMs)
    this.transport = options.transport ?? fetchTransport()
  }

  get health(): unknown {
    if (this.apiKey === null) {
      return {
        ready: false,
        reason: `no Jev credential: set ${JEV_API_KEY_ENV} in the server environment`,
      } satisfies DecisionHealth
    }
    return { ready: true, reason: null } satisfies DecisionHealth
  }

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    // A provider with no credential is misconfigured, not merely unable to
    // answer — the distinction the port draws, and the reason this throws rather
    // than answers. The readiness flag is the advance warning; a caller that
    // ignored it gets the same sentence with nowhere to put it.
    if (this.apiKey === null) {
      throw new DecisionError(
        `JevDecisionProvider has no credential: set ${JEV_API_KEY_ENV} before calling decide()`,
      )
    }

    const plan = planQuestions(request.questions)
    if (plan.send.length === 0) {
      return this.outcome(this.model, [], plan.refused)
    }

    let text: string
    try {
      text = JSON.stringify(buildBody(request, plan.send, this.model))
    } catch {
      // A cycle or a BigInt in masked evidence. Nothing was sent, so nothing was
      // answered, and the reason names the actual problem rather than the
      // transport that was never reached.
      const refused = [...plan.refused, ...refuseAll(plan.send, REASON.unserialisable)]
      return this.outcome(this.model, [], refused)
    }

    try {
      const response = await this.call(text)
      return interpret(response, plan, this.model)
    } catch (error) {
      const reason = error instanceof JevTransportError ? error.message : REASON.unreachable
      return this.outcome(this.model, [], [...plan.refused, ...refuseAll(plan.send, reason)])
    }
  }

  /**
   * One bounded call: signalled *and* raced.
   *
   * The abort is what lets a real `fetch` release its socket, and the race is
   * what bounds a transport that ignores the signal — a mock that resolves never
   * must not be able to hold a turn open forever.
   */
  private call(text: string): Promise<JevHTTPResponse> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const bounded = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new JevTransportError(REASON.timeout))
      }, this.timeoutMs)
    })

    const sent = this.transport.post({
      url: this.endpoint,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: text,
      signal: controller.signal,
    })

    return Promise.race([sent, bounded]).finally(() => {
      if (timer !== undefined) clearTimeout(timer)
    })
  }

  private outcome(
    model: string,
    decisions: readonly Decision[],
    refused: readonly DecisionRefusal[],
  ): DecisionResult {
    return { providerId: this.providerId, model, decisions, refused }
  }
}

/** The `fetch` transport. Global, so nothing is captured at module scope. */
function fetchTransport(fetchImpl: typeof fetch = globalThis.fetch): JevTransport {
  return {
    post: async (request: JevHTTPRequest): Promise<JevHTTPResponse> => {
      let response: Response
      try {
        response = await fetchImpl(request.url, {
          method: 'POST',
          headers: request.headers,
          body: request.body,
          ...(request.signal ? { signal: request.signal } : {}),
        })
      } catch {
        // The message is discarded on purpose. An abort, a DNS failure and a TLS
        // failure all mean the same thing to a decision — nothing came back —
        // and a raw network error string is exactly where a proxy or a
        // misconfigured URL can leak a credential-shaped fragment into a log.
        throw new JevTransportError(REASON.unreachable)
      }

      // The status is carried on the response and read by the caller, not here:
      // the status is a fact about the answer, and the one place that reads
      // answers is `interpret`. A transport that checked it would be a transport
      // that could not be substituted for a test.
      const body = await response.text()
      return { status: response.status, body }
    },
  }
}

/**
 * What may be asked, and how.
 *
 * Everything refused here never reaches the network, which is the point: a
 * question Jev cannot represent is a question Jev would answer wrongly, and a
 * wrong answer is the one outcome this port exists to prevent.
 */
function planQuestions(questions: readonly DecisionQuestion[]): JevQuestionPlan {
  const repeated = repeatedIds(questions)
  const send: JevSendable[] = []
  const refused: DecisionRefusal[] = []

  for (const question of questions) {
    // Jev's `questions` is a map keyed by id, so two questions sharing an id
    // would silently become one question. Refusing every occurrence names the
    // bug instead of dropping half of it.
    if (repeated.has(question.id)) {
      refused.push({ id: question.id, reason: REASON.duplicateId })
      continue
    }
    const plan = planQuestion(question)
    if ('reason' in plan) {
      refused.push({ id: question.id, reason: plan.reason })
      continue
    }
    send.push(plan.sendable)
  }

  return { send, refused }
}

function planQuestion(question: DecisionQuestion): { sendable: JevSendable } | { reason: string } {
  const problem = decisionQuestionProblem(question)
  if (problem !== null) return { reason: problem }

  switch (question.kind) {
    case 'boolean':
      // `criteria` is omitted even though Jev documents it for a noul: its
      // interior shape is unverified, and a question this provider can verify is
      // worth more than one it cannot.
      return {
        sendable: {
          question,
          scale: null,
          native: { type: 'noul', instructions: question.prompt },
        },
      }

    case 'choice': {
      const options = question.options ?? []
      if (options.length > MAX_CHOICE_OPTIONS) {
        return { reason: `a choice question here accepts at most ${MAX_CHOICE_OPTIONS} options` }
      }
      const criteria: Record<string, string> = {}
      for (const option of options) criteria[option] = option
      return {
        sendable: {
          question,
          scale: null,
          native: { type: 'choice', instructions: question.prompt, criteria },
        },
      }
    }

    case 'score': {
      const scale = scoreScale(question.bounds)
      if (scale === null) {
        return {
          reason: `a score question here needs a range spanning ${MIN_SCORE_LEVELS} to ${MAX_SCORE_LEVELS} levels`,
        }
      }
      return {
        sendable: {
          question,
          scale,
          native: { type: 'score', instructions: question.prompt, criteria: scale.levels },
        },
      }
    }
  }
}

/**
 * The ladder for a bounded score, or `null` if the bounds cannot hold one.
 *
 * A range of whole numbers that fits in 2..10 becomes those numbers exactly, so
 * a question about a 1-to-5 rating is asked about 1-to-5 rather than about ten
 * anchors that happen to include them. Everything else becomes evenly spaced
 * anchors, and a one-point range — which the port allows — is refused: Jev has no
 * way to express a scale with one level, and widening the range to pretend
 * otherwise would answer a question nobody asked.
 */
function scoreScale(bounds: readonly [number, number] | undefined): JevScoreScale | null {
  if (bounds === undefined) return null
  const [min, max] = bounds
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null

  const span = max - min
  const wholeNumbers = Number.isInteger(min) && Number.isInteger(span)
  const exactLevels =
    wholeNumbers && span + 1 >= MIN_SCORE_LEVELS && span + 1 <= MAX_SCORE_LEVELS ? span + 1 : null

  if (exactLevels !== null) {
    const levels: string[] = []
    for (let index = 0; index < exactLevels; index += 1) levels.push(String(min + index))
    const step = span / (exactLevels - 1)
    return { levels, levelCount: exactLevels, answer: (levelIndex) => min + levelIndex * step }
  }

  const levels: string[] = []
  for (let index = 0; index < ANCHOR_COUNT; index += 1) {
    levels.push(formatAnchor(min + (span * index) / (ANCHOR_COUNT - 1)))
  }
  const step = span / (ANCHOR_COUNT - 1)
  return { levels, levelCount: ANCHOR_COUNT, answer: (levelIndex) => min + levelIndex * step }
}

/**
 * An anchor as a label, not as a number.
 *
 * The descriptor is text the model reads, so `0.30000000000000004` is a worse
 * label than `0.3`. Twelve significant digits keeps anchors distinct for any
 * range a decision would be asked about, and short enough to read.
 */
function formatAnchor(value: number): string {
  return String(Number(value.toPrecision(12)))
}

/**
 * The wire body.
 *
 * `state` is documented as an opaque `string | object | array`, so its interior
 * is this adapter's to choose; the documented part is that it carries the
 * situation the question is asked about, and the situation is the utterance plus
 * the masked facts the caller already assembled.
 *
 * What is deliberately absent is `tenantId`. The endpoint documents no use for
 * it, so sending it would be gratuitous exposure of a tenant identifier to a
 * third party in exchange for nothing. The platform's own audit trail carries the
 * tenant; the provider does not need it.
 *
 * The model is the provider's, not the request's: the port has no opinion about
 * which model serves a question, and a request that could name one would be a
 * request that could route around a provider's own configuration. The alias goes
 * out; the response version is checked, while the neutral result keeps the
 * configured identity expected by the orchestrator.
 */
function buildBody(
  request: DecisionRequest,
  send: readonly JevSendable[],
  model: string,
): JevRequestBody {
  const questions: Record<string, JevNativeQuestion> = {}
  for (const entry of send) questions[entry.question.id] = entry.native
  return {
    model,
    state: { utterance: request.utterance, locale: request.locale, evidence: request.evidence },
    questions,
  }
}

/**
 * A response, or a refusal for every question that was asked.
 *
 * The whole call refuses together when the response is not the documented shape,
 * because a response missing its answer map is a response this adapter does not
 * understand — and answering half of one from a protocol it only half read is how
 * a fabricated `false` ends up in an audit trail.
 */
function interpret(
  response: JevHTTPResponse,
  plan: JevQuestionPlan,
  configuredModel: string,
): DecisionResult {
  const status = statusReason(response.status)
  if (status !== null) return refusedAll(plan, configuredModel, status)
  const parsed = parseObject(response.body)
  if (parsed === null) return refusedAll(plan, configuredModel, REASON.notJson)

  const resolvedModel = parsed.model
  if (typeof resolvedModel !== 'string' || resolvedModel === '')
    return refusedAll(plan, configuredModel, REASON.noModel)

  const raw = parsed.answers
  const answers = raw === undefined || raw === null ? null : asRecord(raw)
  if (answers === null) return refusedAll(plan, configuredModel, REASON.noAnswers)

  const decisions: Decision[] = []
  const refused: DecisionRefusal[] = [...plan.refused]

  for (const entry of plan.send) {
    const id = entry.question.id
    const value = answers[id]
    // An id this provider never asked about is ignored rather than surfaced: it
    // is the provider adding vocabulary, not this provider losing an answer, and
    // inventing a `Decision` for it would mean an id the task registry does not
    // own.
    if (value === undefined) {
      refused.push({ id, reason: REASON.noAnswer })
      continue
    }
    const decision = readDecision(entry, value)
    if ('reason' in decision) {
      refused.push({ id, reason: decision.reason })
      continue
    }
    decisions.push(decision.decision)
  }

  return { providerId: JEV_PROVIDER_ID, model: configuredModel, decisions, refused }
}

function refusedAll(
  plan: JevQuestionPlan,
  configuredModel: string,
  reason: string,
): DecisionResult {
  return {
    providerId: JEV_PROVIDER_ID,
    model: configuredModel,
    decisions: [],
    refused: [...plan.refused, ...refuseAll(plan.send, reason)],
  }
}

/**
 * One native answer, narrowed field by field.
 *
 * Everything is checked and nothing is repaired. A choice that is not in the
 * closed answer set is not "the closest option" — it is a provider answering a
 * different question, and the refusal is the only honest thing to do with it.
 */
function readDecision(
  entry: JevSendable,
  value: unknown,
): { decision: Decision } | { reason: string } {
  const answer = asRecord(value)
  if (answer === null) return { reason: REASON.noAnswer }

  switch (entry.question.kind) {
    case 'boolean': {
      if (answer.type !== 'noul') return { reason: REASON.noul }
      const noul = number(answer.noul)
      if (noul === null || noul < 0 || noul > 1) return { reason: REASON.noul }
      return { decision: noulDecision(entry.question.id, noul) }
    }

    case 'choice': {
      if (answer.type !== 'choice') return { reason: REASON.choice }
      const chosen = answer.choice
      const confidence = number(answer.confidence)
      if (typeof chosen !== 'string' || !(entry.question.options ?? []).includes(chosen)) {
        return { reason: REASON.choice }
      }
      if (confidence === null || confidence < 0 || confidence > 1) {
        return { reason: REASON.choiceConfidence }
      }
      return { decision: { id: entry.question.id, kind: 'choice', answer: chosen, confidence } }
    }

    case 'score': {
      if (entry.scale === null) return { reason: REASON.score }
      if (answer.type !== 'score') return { reason: REASON.score }
      const score = number(answer.score)
      const confidence = number(answer.confidence)
      const highest = entry.scale.levelCount - 1
      if (score === null || score < 0 || score > highest) return { reason: REASON.score }
      if (confidence === null || confidence < 0 || confidence > 1) {
        return { reason: REASON.scoreConfidence }
      }
      return {
        decision: {
          id: entry.question.id,
          kind: 'score',
          answer: clamp(entry.scale.answer(score), entry.question.bounds ?? [0, 0]),
          confidence,
        },
      }
    }
  }
}

/**
 * A noul as a boolean decision.
 *
 * Jev returns one number — P(yes) — and no separate confidence, by design: the
 * threshold is the caller's. The port requires a confidence, so this derives one
 * from the quantity it also thresholds on, using the approximation the Jev docs
 * demonstrate for a two-outcome distribution, `(count * peak - 1) / (count - 1)`:
 * with two outcomes that is `2 * peak - 1`, which is 0 at the coin-flip Jev calls
 * ambiguous and 1 at either certainty. It is this adapter's normalisation, not a
 * value Jev reported.
 */
function noulDecision(id: string, noul: number): Decision {
  const peak = Math.max(noul, 1 - noul)
  return { id, kind: 'boolean', answer: noul >= NOUL_THRESHOLD, confidence: clamp01(2 * peak - 1) }
}

function refuseAll(send: readonly JevSendable[], reason: string): readonly DecisionRefusal[] {
  return send.map((entry) => ({ id: entry.question.id, reason }))
}

function repeatedIds(questions: readonly DecisionQuestion[]): ReadonlySet<string> {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const question of questions) {
    if (seen.has(question.id)) repeated.add(question.id)
    seen.add(question.id)
  }
  return repeated
}

function parseObject(text: string): Readonly<Record<string, unknown>> | null {
  try {
    return asRecord(JSON.parse(text))
  } catch {
    return null
  }
}

/**
 * A narrowed record.
 *
 * An array is not a record here even though it is an object, because a response
 * of `[1, 2, 3]` has no `.answers` and would otherwise reach the next check as
 * `undefined` and be refused for the wrong reason.
 */
function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/**
 * The answer held inside its own bounds.
 *
 * A belt over the map rather than a trust in it: `answer` is affine over the
 * level index, and the level index was already range-checked, so this can only
 * ever be a rounding difference. It is here so that the last thing standing
 * between a native float and a `Decision` is a guard, not an assumption.
 */
function clamp(value: number, bounds: readonly [number, number]): number {
  const [min, max] = bounds
  return Math.min(max, Math.max(min, value))
}

function readKey(apiKey: string | null | undefined): string | null {
  if (typeof apiKey !== 'string') return null
  const trimmed = apiKey.trim()
  return trimmed === '' ? null : trimmed
}

function readModel(model: string | undefined): string {
  if (model === undefined) return JEV_DEFAULT_MODEL
  // An empty alias is a request that can only ever 422, so it is caught at
  // construction rather than discovered once per turn.
  const trimmed = model.trim()
  if (trimmed === '') {
    throw new DecisionError('JevDecisionProvider needs a model name, not a blank one')
  }
  return trimmed
}

/**
 * Where the credential is going to be sent.
 *
 * The https check is not hygiene theatre: this module exists to keep a bearer
 * token out of the wrong place, and an `http://` endpoint is a destination that
 * would put it on the wire in the clear. Loopback is allowed so a local proxy or
 * a test server can stand in for the real one without the guard having to know
 * about ports.
 */
function readEndpoint(endpoint: string | undefined): string {
  if (endpoint === undefined) return JEV_ENDPOINT
  if (endpoint.trim() === '') {
    throw new DecisionError('JevDecisionProvider needs an endpoint, not a blank one')
  }

  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new DecisionError('JevDecisionProvider got an endpoint that is not a URL')
  }
  if (url.protocol !== 'https:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new DecisionError(
      `JevDecisionProvider will not send a credential to ${url.hostname} over ${url.protocol}`,
    )
  }
  return endpoint
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function readTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_TIMEOUT_MS
  // Zero and negative are both "never wait", which is not a timeout, and a
  // non-finite one is not a number.
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new DecisionError('JevDecisionProvider needs a positive timeout in milliseconds')
  }
  return timeoutMs
}
