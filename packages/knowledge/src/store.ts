import { assertTenant, TenantScopeError, type TenantScope } from '@archava/core'
import type { KnowledgeChunk, KnowledgeDocument, KnowledgeKind, RetrievedChunk } from './schema.js'
import { parseKnowledgeDocument } from './schema.js'
import { chunkText } from './text.js'

/**
 * The tenant-scoped knowledge store.
 *
 * PRD.md §23 is categorical: "No cross-tenant retrieval is permitted." That is
 * enforced by construction rather than by callers remembering to pass a filter:
 *
 * 1. Every chunk carries its `tenantId`, and every read opens with an explicit
 *    `tenantId`. A cross-tenant read throws — it is a bug, not an empty result,
 *    because silently returning `[]` hides the bug that caused it.
 * 2. The index is partitioned per tenant, so a query can only ever see its own
 *    partition. There is no cross-partition code path to get wrong.
 * 3. Reads refuse a tenant with no documents, so a typo'd tenant id cannot be
 *    confused with "no results".
 */
export class KnowledgeIsolationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KnowledgeIsolationError'
  }
}

interface DocumentRecord extends TenantScope {
  readonly document: KnowledgeDocument
  readonly chunkIds: readonly string[]
}

export interface KnowledgeStoreStats {
  readonly documents: number
  readonly chunks: number
}

export interface SearchOptions {
  /** Minimum relevance to return. Defaults to 0.01 — nothing in common. */
  readonly minScore?: number
  /** Restrict retrieval to a subset of source kinds. */
  readonly kinds?: readonly KnowledgeKind[]
}

export class KnowledgeStore {
  /** Per-tenant partitions. A tenant appears only once it has a document. */
  private readonly partitions = new Map<string, Map<string, KnowledgeChunk>>()
  private readonly documents = new Map<string, DocumentRecord>()

  /** Ingest a document, replacing any earlier document with the same id. */
  ingest(input: unknown): readonly KnowledgeChunk[] {
    const document = parseKnowledgeDocument(input)
    const documentKey = `${document.tenantId}/${document.id}`

    const previous = this.documents.get(documentKey)
    if (previous) {
      for (const chunkId of previous.chunkIds) {
        this.partitions.get(document.tenantId)?.delete(chunkId)
      }
    }

    const partition = this.partitions.get(document.tenantId) ?? new Map<string, KnowledgeChunk>()
    this.partitions.set(document.tenantId, partition)

    const chunks: readonly KnowledgeChunk[] = chunkText(document.content).map((text, ordinal) => ({
      id: `${document.id}.c${ordinal}`,
      tenantId: document.tenantId,
      documentId: document.id,
      ordinal,
      text,
      provenance: {
        sourceKind: document.kind,
        sourceId: document.id,
        sourceTitle: document.title,
        sourceUrl: document.sourceUrl,
        sourceUpdatedAt: document.updatedAt,
        // Provenance is stamped at ingest. A document carries only a date, so
        // the instant is the start of that day in UTC rather than a fabrication.
        ingestedAt: `${document.updatedAt}T00:00:00.000Z`,
      },
    }))

    for (const chunk of chunks) partition.set(chunk.id, chunk)
    this.documents.set(documentKey, {
      tenantId: document.tenantId,
      document,
      chunkIds: chunks.map((chunk) => chunk.id),
    })

    return chunks
  }

  /** Every chunk of one document, in document order. */
  chunksOf(tenantId: string, documentId: string): readonly KnowledgeChunk[] {
    this.assertKnownTenant(tenantId)
    const record = this.documents.get(`${tenantId}/${documentId}`)
    if (!record) return []
    const partition = this.partitions.get(tenantId)
    return record.chunkIds
      .map((chunkId) => partition?.get(chunkId))
      .filter((chunk): chunk is KnowledgeChunk => chunk !== undefined)
  }

  /**
   * Fetch one chunk. Throws on a cross-tenant id rather than returning null:
   * "not found" and "not yours" are different facts and must not collapse.
   */
  chunk(tenantId: string, chunkId: string): KnowledgeChunk {
    for (const [candidateTenant, partition] of this.partitions) {
      const chunk = partition.get(chunkId)
      if (!chunk) continue
      if (candidateTenant !== tenantId) {
        throw new KnowledgeIsolationError(
          `Tenant scope violation: chunk "${chunkId}" belongs to tenant "${candidateTenant}", not "${tenantId}".`,
        )
      }
      return chunk
    }
    throw new KnowledgeIsolationError(`Chunk "${chunkId}" does not exist in tenant "${tenantId}".`)
  }

  /** Relevance-ranked retrieval. Only ever reads the caller's partition. */
  search(
    query: string,
    tenantId: string,
    limit = 8,
    options: SearchOptions = {},
  ): readonly RetrievedChunk[] {
    this.assertKnownTenant(tenantId)
    const partition = this.partitions.get(tenantId) ?? new Map<string, KnowledgeChunk>()
    const minScore = options.minScore ?? 0.01
    const allowedKinds = options.kinds === undefined ? null : new Set<KnowledgeKind>(options.kinds)

    return [...partition.values()]
      .filter((chunk) => allowedKinds === null || allowedKinds.has(chunk.provenance.sourceKind))
      .map((chunk) => ({ ...chunk, score: scoreChunk(query, chunk.text) }))
      .filter((candidate) => candidate.score >= minScore)
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, limit)
  }

  document(tenantId: string, documentId: string): KnowledgeDocument {
    const record = assertTenant(this.documents.get(`${tenantId}/${documentId}`), tenantId)
    return record.document
  }

  listDocuments(tenantId: string): readonly KnowledgeDocument[] {
    this.assertKnownTenant(tenantId)
    return [...this.documents.values()]
      .filter((record) => record.tenantId === tenantId)
      .map((record) => record.document)
  }

  stats(tenantId: string): KnowledgeStoreStats {
    this.assertKnownTenant(tenantId)
    const partition = this.partitions.get(tenantId) ?? new Map<string, KnowledgeChunk>()
    const documents = [...this.documents.values()].filter((record) => record.tenantId === tenantId)
    return { documents: documents.length, chunks: partition.size }
  }

  tenants(): readonly string[] {
    return [...this.partitions.keys()].sort()
  }

  /**
   * A tenant with no documents is almost certainly a typo or a missing ingest,
   * and reporting it as "no results" lets that ship.
   */
  private assertKnownTenant(tenantId: string): void {
    if (this.partitions.has(tenantId)) return
    if (this.documents.size === 0) {
      throw new TenantScopeError(`Knowledge store is empty; no tenant "${tenantId}" exists.`)
    }
    throw new TenantScopeError(
      `No knowledge documents for tenant "${tenantId}". Registered tenants: ${this.tenants().join(', ')}.`,
    )
  }
}

/**
 * Lexical relevance, normalised to `[0, 1]`.
 *
 * Two things are deliberate here. (1) Matching is on stems, not raw tokens:
 * "cancellation" must match "cancellations", and without stemming the single
 * most natural query against the single most natural document scores zero.
 * (2) The score mixes term coverage with a length-normalised density, so a
 * match inside a very long chunk does not outrank a match inside a focused one.
 *
 * This is the hermetic stand-in for the pgvector/embedding path the PRD selects
 * for production: same seam, no network, deterministic under test. A production
 * store swaps in the vector scorer behind this function.
 */
function scoreChunk(query: string, chunkTextValue: string): number {
  const queryTokens = new Set(tokeniseForScoring(query))
  if (queryTokens.size === 0) return 0

  const chunkTokens = tokeniseForScoring(chunkTextValue).map(stem)
  if (chunkTokens.length === 0) return 0

  const frequencies = new Map<string, number>()
  for (const token of chunkTokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
  }

  let hits = 0
  let weighted = 0
  for (const token of queryTokens) {
    const stemmed = stem(token)
    const frequency = frequencies.get(stemmed) ?? 0
    if (frequency > 0) hits += 1
    weighted += frequency
  }

  const coverage = hits / queryTokens.size
  const density = weighted / Math.sqrt(chunkTokens.length)
  return Math.min(1, coverage * 0.75 + density * 0.25)
}

function tokeniseForScoring(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1)
}

/**
 * A minimal English suffix stripper.
 *
 * Not a full Porter implementation — the goal is only to fold the common
 * inflections that otherwise make a natural query miss a natural document
 * (plurals, -ing, -ed, -ly, and the -ation/-ate/-ivated family that bullying a
 * word like `cancellation` needs to survive).
 *
 * Two details are load-bearing:
 * - The final `e` is dropped *after* suffix stripping, so `charge`, `charging`
 *   and `charged` all reach the same stem instead of splitting three ways.
 * - A strip that would leave under three characters is refused, so `spa`,
 *   `fee` and `nation` survive as themselves rather than collapsing.
 */
export function stem(token: string): string {
  if (token.length <= 3) return token

  const rules: readonly (readonly [RegExp, string])[] = [
    [/ations$/, ''],
    [/ation$/, ''],
    [/ies$/, 'y'],
    [/sses$/, 'ss'],
    [/([^s])s$/, '$1'],
    [/edly$/, ''],
    [/ing$/, ''],
    [/ed$/, ''],
    [/ly$/, ''],
  ]

  let candidate = token
  for (const [pattern, replacement] of rules) {
    if (pattern.test(candidate)) {
      candidate = candidate.replace(pattern, replacement)
      break
    }
  }

  if (candidate.length > 4 && candidate.endsWith('e')) {
    candidate = candidate.slice(0, -1)
  }
  return candidate.length >= 3 ? candidate : token
}
