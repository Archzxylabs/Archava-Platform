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

/**
 * The corpus is bilingual, and this is why.
 *
 * Retrieval is lexical. A visitor who arrives on the page and asks "what is your
 * cancellation policy?" in English meets an Indonesian-only corpus with zero
 * token overlap, which is not a low score — it is *no* score. The turn then
 * reports `basis: 'none'`, declares a knowledge gap, and tells the visitor the
 * property published nothing about a policy that is sitting right there in the
 * store. §17's live-truth half is untouched by a second language; the half that
 * breaks without one is its other side, that published prose *does* answer
 * policy questions — in whatever language the visitor asks in.
 *
 * So each subject is published in both languages, and what follows is the
 * regression: an English question reaches the English edition, an Indonesian
 * question keeps reaching the Indonesian one, and a regression in either
 * direction is a visitor being told the tenant is silent in their language.
 */

/** Every subject the tenant publishes, as its Indonesian edition and its English one. */
const SUBJECTS: readonly {
  readonly subject: string
  readonly id: readonly [string, string]
  readonly indonesianUtterance: string
  readonly englishUtterance: string
}[] = [
  {
    subject: 'cancellation policy',
    id: ['kebijakan-pembatalan', 'cancellation-policy'],
    indonesianUtterance: 'apa kebijakan pembatalan?',
    englishUtterance: 'what is your cancellation policy?',
  },
  {
    subject: 'check-in and check-out',
    id: ['check-in-dan-check-out', 'check-in-and-check-out'],
    indonesianUtterance: 'jam berapa check in dan check out?',
    englishUtterance: 'what time can I check in?',
  },
  {
    subject: 'breakfast',
    id: ['sarapan-pagi', 'breakfast'],
    indonesianUtterance: 'jam berapa sarapan pagi disajikan?',
    englishUtterance: 'when is breakfast served?',
  },
  {
    subject: 'resort facilities',
    id: ['fasilitas-resort', 'resort-facilities'],
    indonesianUtterance: 'apa saja fasilitas resort?',
    englishUtterance: 'what facilities does the resort have?',
  },
  {
    subject: 'location and access',
    id: ['akses-lokasi', 'location-access'],
    indonesianUtterance: 'berapa jarak resort dari bandara?',
    englishUtterance: 'how far is the resort from the airport?',
  },
  {
    subject: 'children and extra beds',
    id: ['kebijakan-anak-dan-tempat-tidur-ekstra', 'children-and-extra-beds-policy'],
    indonesianUtterance: 'apa kebijakan anak dan tempat tidur ekstra?',
    englishUtterance: 'what is your children and extra beds policy?',
  },
  {
    subject: 'reservations contact',
    id: ['kontak-reservasi', 'reservation-contact'],
    indonesianUtterance: 'bagaimana menghubungi tim reservasi?',
    englishUtterance:
      'what phone number or email address should I use to reach the reservations team?',
  },
]

const publishedIds = referenceKnowledgeInputs.map((source) => source.id)
const store = buildKnowledgeStore(referenceConfig)

describe('the corpus answers in the language it was asked in', () => {
  it('publishes both languages of every subject', () => {
    // Asserted on its own so the two recall tests below can assume it: a subject
    // missing a language is a visitor who is silently told the tenant has
    // nothing to say, and that is the whole defect being guarded here.
    for (const { subject, id } of SUBJECTS) {
      expect(id, `"${subject}" is listed with one language only`).toHaveLength(2)
      for (const documentId of id) {
        expect(publishedIds, `${documentId} (${subject})`).toContain(documentId)
      }
    }
  })

  it('reaches the English edition of an English question', () => {
    for (const { subject, id, englishUtterance } of SUBJECTS) {
      const hits = store.search(englishUtterance, REFERENCE_TENANT_ID, 3)
      expect(hits.length, `${subject}: "${englishUtterance}"`).toBeGreaterThan(0)
      expect(hits[0]?.documentId, `${subject}: "${englishUtterance}"`).toBe(id[1])
    }
  })

  it('keeps reaching the Indonesian edition of an Indonesian question', () => {
    // The pre-existing behaviour. A second language must not quietly replace the
    // first one's answers, and the only way to be sure is to say both.
    for (const { subject, id, indonesianUtterance } of SUBJECTS) {
      const hits = store.search(indonesianUtterance, REFERENCE_TENANT_ID, 3)
      expect(hits.length, `${subject}: "${indonesianUtterance}"`).toBeGreaterThan(0)
      expect(hits[0]?.documentId, `${subject}: "${indonesianUtterance}"`).toBe(id[0])
    }
  })

  it('never lets a second language become a second place to name a rate', () => {
    // The no-prices rule that the Indonesian corpus was authored under applies
    // to the English editions too: a translation that names a currency amount
    // would reintroduce the exact failure §17 forbids, and only in one language.
    for (const { subject, id } of SUBJECTS) {
      for (const documentId of id) {
        const source = referenceKnowledgeInputs.find((candidate) => candidate.id === documentId)
        expect(source?.content, documentId).toBeDefined()
        expect(source?.content, `${documentId} (${subject}) names a rate`).not.toMatch(
          /(?:IDR|Rp|USD|\$|€|£)\s?[\d.,]+|[\d.,]+\s?(?:per night|per malam|a night|semalam|sehari)|\brupiah\b/i,
        )
      }
    }
  })
})
