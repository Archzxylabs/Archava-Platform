/**
 * @archava/knowledge
 *
 * Tenant-scoped retrieval knowledge (PRD.md §17) with the structured-truth
 * split enforced ahead of retrieval, and masking applied before provider
 * exposure (§16).
 *
 * The store is the authority on scope: a cross-tenant read throws rather than
 * returning empty, because an empty result hides the bug that produced it.
 */
export * from './schema.js'
export * from './text.js'
export * from './structured-truth.js'
export * from './store.js'
export * from './retrieval.js'
