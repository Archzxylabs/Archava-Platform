import { describe, expect, it } from 'vitest'
import { TenantScopeError } from '@archava/core'
import { classifyKnowledgeNeed } from '@archava/knowledge'
import {
  REFERENCE_TENANT_ID,
  buildKnowledgeStore,
  referenceConfig,
  referenceKnowledgeInputs,
  referenceKnowledgeSources,
  toKnowledgeDocuments,
} from '../src/index.js'

/**
 * The corpus's most important property is a negative one.
 *
 * PRD §17: "Do not answer these from stale vector retrieval when a live system
 * exists." The cheapest way to honour that is to keep prices, stock and
 * availability out of the published prose in the first place, so a document that
 * states a rate does not exist to be quoted as one. The test below runs the
 * *real* triage over the *real* corpus — if a future edit reintroduces "harga",
 * this fails rather than the demo quietly answering a price from retrieval.
 */
describe('reference knowledge corpus', () => {
  it('publishes every source the tenant maintains', () => {
    expect(referenceKnowledgeSources).toHaveLength(referenceKnowledgeInputs.length)
    for (const source of referenceKnowledgeSources) {
      // Scope is a property of the config these were spliced into; a source
      // carries no tenant id of its own.
      expect(referenceConfig.knowledgeSources).toContainEqual(source)
      expect(source.content.length).toBeGreaterThan(0)
      expect(source.kind).toMatch(/^(faq|documentation|policy|product|service|marketing)$/)
      // A stale-dated source would make the demo look unmaintained.
      expect(source.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('says why it applies a cancellation charge without naming a currency amount', () => {
    const cancellation = referenceKnowledgeInputs.find(
      (source) => source.id === 'kebijakan-pembatalan',
    )
    // The policy exists and is specific about *when*, without stating *how much*.
    expect(cancellation?.content).toContain('7 hari')
    expect(cancellation?.content).toContain('potongan satu malam')
  })

  it('never routes a published sentence to the structured-truth port', () => {
    for (const source of referenceKnowledgeSources) {
      const classification = classifyKnowledgeNeed(`${source.title} ${source.content}`)
      expect(
        classification.need,
        `"${source.id}" mentions ${classification.matched.join(', ') || 'a possessive'}`,
      ).toBe('retrieval_knowledge')
    }
  })

  it('builds a store scoped to exactly the parsed config', () => {
    const store = buildKnowledgeStore(referenceConfig)
    expect(store.tenants()).toEqual([REFERENCE_TENANT_ID])
    expect(store.stats(REFERENCE_TENANT_ID).documents).toBe(referenceKnowledgeSources.length)
    // Chunked, so every source is searchable, not merely listed.
    expect(store.stats(REFERENCE_TENANT_ID).chunks).toBeGreaterThanOrEqual(
      referenceKnowledgeSources.length,
    )
  })

  it('retrieves the document a visitor asks about', () => {
    const store = buildKnowledgeStore(referenceConfig)
    for (const source of referenceKnowledgeSources) {
      const hits = store.search(source.title, REFERENCE_TENANT_ID, 3)
      expect(hits.map((hit) => hit.documentId)).toContain(source.id)
    }
  })

  it("answers from the tenant's own documents and never from another tenant's", () => {
    const store = buildKnowledgeStore(referenceConfig)
    const hits = store.search('sarapan', REFERENCE_TENANT_ID, 3)
    expect(hits[0]?.documentId).toBe('sarapan-pagi')
    // §23: an unknown scope is a thrown error, not an empty result that hides
    // the bug that produced it.
    expect(() => store.search('sarapan', 'client-someone-else')).toThrow(TenantScopeError)
  })

  it('takes the tenant id from the caller rather than assuming one', () => {
    // A document ingested under the wrong tenant is an isolation bug, not a
    // misfiled row, so the projection refuses to invent the id itself.
    const documents = toKnowledgeDocuments(referenceKnowledgeInputs, REFERENCE_TENANT_ID)
    expect(documents).toHaveLength(referenceKnowledgeInputs.length)
    for (const document of documents) {
      expect(document.tenantId).toBe(REFERENCE_TENANT_ID)
    }
    expect(toKnowledgeDocuments([], REFERENCE_TENANT_ID)).toEqual([])
  })
})
