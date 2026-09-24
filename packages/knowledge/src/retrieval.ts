import type { KnowledgeKind, RetrievalQuery, RetrievedChunk } from './schema.js'
import { retrievalQuerySchema } from './schema.js'
import { classifyKnowledgeNeed, type KnowledgeNeed } from './structured-truth.js'
import type { KnowledgeStore } from './store.js'

/**
 * Retrieval orchestration.
 *
 * This is where two rules from the PRD meet for one query:
 *
 * - §17 — the structured-truth / retrieval split, decided *before* retrieval;
 * - §23 — tenant scope, non-negotiable on every read.
 *
 * On masking (§16) — the part a reader will reasonably wonder about here: this
 * module does NOT mask chunk text, and that is deliberate rather than an
 * oversight. Chunks are tenant-authored, deliberately published content; a FAQ
 * that says "email reservations@acme.test" has to survive retrieval verbatim or
 * the assistant cannot tell anyone how to contact the business. The masker in
 * `@archava/acl` works on *field names*, which a chunk does not have — applying
 * it to the text would be a no-op pretending to be a control.
 *
 * What §16 actually protects is customer and session data, and that is masked
 * at the boundary where it enters the turn — the same seam as everywhere else
 * (see `maskSensitiveFields`). The split is: retrieval supplies *tenant
 * business* content; the turn context supplies *customer* context, and only the
 * latter carries PII. Merging the two would both weaken the real control and
 * corrupt the published content.
 */

/** A chunk prepared for a provider: content plus provenance, nothing else. */
export interface KnowledgeContextChunk {
  readonly sourceId: string
  readonly sourceTitle: string
  readonly sourceKind: KnowledgeKind
  readonly text: string
}

export interface RetrievalContextRequest {
  readonly question: string
  readonly tenantId: string
  readonly limit?: number
  readonly kinds?: readonly KnowledgeKind[]
}

export interface RetrievalPlan {
  readonly need: KnowledgeNeed
  readonly subjects: readonly string[]
  readonly query: string
}

export interface RetrievalOutcome {
  readonly plan: RetrievalPlan
  /** Chunks to ground the answer in — tenant-scoped, provenance intact. */
  readonly context: readonly KnowledgeContextChunk[]
  /**
   * True when the answer must come from a live system. Retrieval still returns
   * supporting copy, but the caller must not quote it as the answer.
   */
  readonly deferToStructuredTruth: boolean
}

/**
 * Normalise and validate a retrieval query.
 *
 * Parsing here rather than at each call site matters for §23: an unparsed
 * request is how an empty or malformed tenantId reaches the store.
 */
export function parseRetrievalQuery(request: RetrievalContextRequest): RetrievalQuery {
  const parsed = retrievalQuerySchema.safeParse({
    tenantId: request.tenantId,
    query: request.question,
    ...(request.limit === undefined ? {} : { limit: request.limit }),
    ...(request.kinds === undefined ? {} : { kinds: request.kinds }),
  })
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new KnowledgeRetrievalError(`Invalid retrieval query: ${detail}`)
  }
  return parsed.data
}

/** Decide what a question needs before touching the store. */
export function planRetrieval(request: RetrievalContextRequest): RetrievalPlan {
  const query = parseRetrievalQuery(request)
  const classification = classifyKnowledgeNeed(query.query)
  return {
    need: classification.need,
    subjects: classification.subjects,
    query: query.query,
  }
}

/** Shape stored chunks into provider-facing context. Content is not rewritten. */
export function toContextChunks(
  chunks: readonly RetrievedChunk[],
): readonly KnowledgeContextChunk[] {
  return chunks.map((chunk) => ({
    sourceId: chunk.provenance.sourceId,
    sourceTitle: chunk.provenance.sourceTitle,
    sourceKind: chunk.provenance.sourceKind,
    text: chunk.text,
  }))
}

/**
 * Retrieve context for a question. The store enforces tenant scope; this layer
 * decides what the answer needs and prepares what crosses the boundary.
 */
export function retrieveContext(
  request: RetrievalContextRequest,
  store: KnowledgeStore,
): RetrievalOutcome {
  const plan = planRetrieval(request)
  const parsed = parseRetrievalQuery(request)

  const hits = store.search(parsed.query, parsed.tenantId, parsed.limit, {
    ...(parsed.kinds === undefined ? {} : { kinds: parsed.kinds }),
  })

  return {
    plan,
    context: toContextChunks(hits),
    deferToStructuredTruth: plan.need === 'structured_truth',
  }
}

export class KnowledgeRetrievalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KnowledgeRetrievalError'
  }
}
