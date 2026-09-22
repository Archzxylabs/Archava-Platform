import { describe, expect, it } from 'vitest'
import { KnowledgeStore } from '../src/store.js'
import {
  attribute,
  classifyKnowledgeNeed,
  requiresStructuredTruth,
  retrieveContext,
} from '../src/index.js'

describe('structured truth vs retrieval', () => {
  it('routes live-value questions away from retrieval', () => {
    for (const question of [
      'How much is the deluxe suite?',
      'Do you have rooms in stock on Friday?',
      'Is the pool available on Sunday?',
      'Where is my order?',
      'Did my payment go through?',
      'What is my subscription plan?',
    ]) {
      expect(requiresStructuredTruth(question)).toBe(true)
    }
  })

  it('treats policy and FAQ questions as retrieval knowledge', () => {
    for (const question of [
      'What is your cancellation policy?',
      'How do I get to the hotel from the airport?',
      'Tell me about the spa treatments you offer.',
    ]) {
      expect(requiresStructuredTruth(question)).toBe(false)
      expect(classifyKnowledgeNeed(question).need).toBe('retrieval_knowledge')
    }
  })

  it('reports which subjects a question touched', () => {
    expect(classifyKnowledgeNeed('berapa harga kamar deluxe?').subjects).toContain('price')
    expect(classifyKnowledgeNeed('where is my parcel?').subjects).toContain('shipping_status')
  })

  it('falls back to the live path for possessive questions whose noun is unlisted', () => {
    const classification = classifyKnowledgeNeed('can you look at my loyalty tier?')
    expect(classification.need).toBe('structured_truth')
    expect(classification.matched).toContain('possessive')
  })
})

describe('retrieveContext', () => {
  const store = new KnowledgeStore()
  store.ingest({
    id: 'cancellation-policy',
    tenantId: 'acme-hotels',
    kind: 'policy',
    title: 'Cancellation policy',
    content: 'Cancellations are free up to 48 hours before check-in. After that one night is charged.',
    updatedAt: '2026-03-01',
  })

  it('grounds a retrieval answer in the tenant document with provenance', () => {
    const outcome = retrieveContext(
      { question: 'What is the cancellation policy?', tenantId: 'acme-hotels' },
      store,
    )

    expect(outcome.deferToStructuredTruth).toBe(false)
    expect(outcome.context.length).toBeGreaterThan(0)
    expect(outcome.context[0]?.sourceId).toBe('cancellation-policy')
    expect(outcome.context[0]?.sourceKind).toBe('policy')
  })

  it('flags a price question so the live system stays authoritative', () => {
    const outcome = retrieveContext(
      { question: 'How much is a room?', tenantId: 'acme-hotels' },
      store,
    )
    expect(outcome.deferToStructuredTruth).toBe(true)
    expect(outcome.plan.need).toBe('structured_truth')
  })

  it('will not read another tenant partition', () => {
    expect(() =>
      retrieveContext({ question: 'cancellation policy', tenantId: 'other-hotel' }, store),
    ).toThrow(/No knowledge documents for tenant/)
  })

  it('keeps tenant-authored contact details verbatim, because they are published content', () => {
    const contactStore = new KnowledgeStore()
    contactStore.ingest({
      id: 'contact-faq',
      tenantId: 'acme-hotels',
      kind: 'faq',
      title: 'Contact us',
      content: 'Email reservations at reservations@acme.test or call the front desk for help.',
      updatedAt: '2026-03-02',
    })

    const outcome = retrieveContext(
      { question: 'how do I contact reservations by email', tenantId: 'acme-hotels' },
      contactStore,
    )

    // A business's own published contact address is not customer PII: masking
    // it would leave the assistant unable to answer. Customer data is masked at
    // the turn-context seam instead (see retrieval.ts).
    expect(outcome.context[0]?.text).toContain('reservations@acme.test')
    expect(outcome.context[0]?.sourceId).toBe('contact-faq')
  })

  it('passes retrieval through the store, which enforces tenant scope', () => {
    const hits = store.search('cancellation', 'acme-hotels')
    expect(hits[0]?.provenance.sourceId).toBe('cancellation-policy')
  })
})

describe('attribute', () => {
  it('keeps the basis and citations attached to the answer', () => {
    const answer = attribute('Two suites are free.', 'structured_truth', ['stock.check'])
    expect(answer.basis).toBe('structured_truth')
    expect(answer.citations).toEqual(['stock.check'])
  })
})
