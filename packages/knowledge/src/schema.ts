import { z } from 'zod'

/**
 * Knowledge schemas (PRD.md §17, §23).
 *
 * The unit of storage is a *chunk*, not a document: retrieval returns chunks,
 * provenance is recorded per chunk, and tenant scope lives on the chunk so it
 * can never be separated from the bytes it governs. A chunk without its tenant
 * is not a knowledge artefact — it is an isolation bug waiting to happen.
 */

const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase kebab-case slug')

const tenantId = slug

const nonEmptyString = z.string().min(1)

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO YYYY-MM-DD date')

const isoInstant = z.string().regex(/^\d{4}-\d{2}-\d{2}T.+$/, 'must be an ISO timestamp')

/** Mirrors `knowledgeSourceSchema.kind` from the client config. */
export const KNOWLEDGE_KINDS = [
  'faq',
  'documentation',
  'policy',
  'product',
  'service',
  'marketing',
] as const
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number]

export const knowledgeKindSchema = z.enum(KNOWLEDGE_KINDS)

/**
 * Where a chunk came from. PRD.md §17: "source provenance stored per
 * chunk/document" and "every answer should be able to preserve source
 * provenance internally for debugging/evals."
 */
export const provenanceSchema = z.object({
  sourceKind: knowledgeKindSchema,
  sourceId: slug,
  sourceTitle: nonEmptyString,
  sourceUrl: z.string().optional(),
  /** ISO date of the source's own last update, not of ingestion. */
  sourceUpdatedAt: isoDate,
  ingestedAt: isoInstant,
})
export type KnowledgeProvenance = z.infer<typeof provenanceSchema>

export const documentSchema = z.object({
  id: slug,
  tenantId,
  kind: knowledgeKindSchema,
  title: nonEmptyString,
  content: nonEmptyString,
  sourceUrl: z.string().optional(),
  updatedAt: isoDate,
})
export type KnowledgeDocument = z.infer<typeof documentSchema>

export const chunkSchema = z
  .object({
    id: slug,
    tenantId,
    documentId: slug,
    /** Zero-based position inside the document. */
    ordinal: z.number().int().min(0),
    text: nonEmptyString,
    provenance: provenanceSchema,
  })
export type KnowledgeChunk = z.infer<typeof chunkSchema>

export const retrievalQuerySchema = z.object({
  tenantId,
  query: nonEmptyString,
  limit: z.number().int().min(1).max(100).default(8),
  /** Restrict retrieval to a subset of source kinds. */
  kinds: z.array(knowledgeKindSchema).min(1).optional(),
})
export type RetrievalQuery = z.infer<typeof retrievalQuerySchema>

export const retrievedChunkSchema = chunkSchema.extend({
  /** Relevance in `[0, 1]`. `1.0` is an exact lexical match, not a guarantee. */
  score: z.number().min(0).max(1),
})
export type RetrievedChunk = z.infer<typeof retrievedChunkSchema>

export class KnowledgeSchemaError extends Error {
  constructor(
    readonly subject: string,
    readonly issues: readonly string[],
  ) {
    super(`Invalid ${subject}: ${issues.join('; ')}`)
    this.name = 'KnowledgeSchemaError'
  }
}

export function parseKnowledgeDocument(raw: unknown): KnowledgeDocument {
  const parsed = documentSchema.safeParse(raw)
  if (!parsed.success) {
    throw new KnowledgeSchemaError(
      'document',
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    )
  }
  return parsed.data
}

export function parseKnowledgeChunk(raw: unknown): KnowledgeChunk {
  const parsed = chunkSchema.safeParse(raw)
  if (!parsed.success) {
    throw new KnowledgeSchemaError(
      'chunk',
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    )
  }
  return parsed.data
}
