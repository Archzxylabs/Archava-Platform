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

  it('matches a keyword as a word, not as a substring of one', () => {
    // "coffee" contains "fee". With substring matching, a visitor asking what
    // comes with breakfast was routed to the price port and told a live system
    // holds the answer — for a menu the tenant has already published. The same
    // collision runs the other way: "included" is not a fee question.
    expect(requiresStructuredTruth('is coffee included in breakfast?')).toBe(false)
    expect(requiresStructuredTruth('how much coffee is served at breakfast?')).toBe(false)
    expect(requiresStructuredTruth('what time is breakfast served?')).toBe(false)
    // The boundary must not go so far as to stop hearing real money questions:
    // a word that *is* the keyword is still that question.
    expect(requiresStructuredTruth('what is the price of the deluxe suite?')).toBe(true)
    expect(requiresStructuredTruth('is there a fee for an extra bed?')).toBe(true)
    expect(classifyKnowledgeNeed('berapa biaya tambahan untuk kasur ekstra?').subjects).toContain(
      'price',
    )
  })

  it('reports which subjects a question touched', () => {
    expect(classifyKnowledgeNeed('berapa harga kamar deluxe?').subjects).toContain('price')
    expect(classifyKnowledgeNeed('where is my parcel?').subjects).toContain('shipping_status')
  })

  it('hears an inventory count that never says "stock"', () => {
    // The visitor's phrasing is the count, not the noun: "how many rooms do you
    // have" is a stock question, and before the keywords existed it fell through
    // to retrieval and reached the port never asking it.
    expect(classifyKnowledgeNeed('how many rooms do you have?').subjects).toContain('stock')
    expect(classifyKnowledgeNeed('are any rooms left for the 9th?').subjects).toContain('stock')
    expect(classifyKnowledgeNeed('how many properties do you list?').subjects).toContain('stock')
    expect(classifyKnowledgeNeed('berapa stok kamar deluxe?').subjects).toContain('stock')
  })

  it('hears a bookability question that asks in the verb, not the noun', () => {
    // "What can I book" is an availability question wearing the verb. The
    // keyword list named the noun ('available'), so the question fell through to
    // retrieval — where the tenant's published content says nothing about what is
    // bookable — and came back `basis: 'none'` while the availability snapshot
    // held exactly the answer.
    for (const question of [
      'what can I book this week?',
      'can I book the treetop suite?',
      'do you have any rooms free this weekend?',
    ]) {
      expect(classifyKnowledgeNeed(question).need).toBe('structured_truth')
      expect(classifyKnowledgeNeed(question).subjects).toContain('availability')
    }
  })

  it('keeps "book" about the visitor’s own reservation out of availability', () => {
    // The cost of the keywords above. A question about a booking the visitor
    // already has is a `booking_status` question, and one about how booking works
    // in general is answered from the tenant's published policy — neither is what
    // the availability snapshot answers, so neither may be routed there.
    expect(classifyKnowledgeNeed('is my booking confirmed?').subjects).toEqual(['booking_status'])
    expect(classifyKnowledgeNeed('how do I book a room?').need).toBe('retrieval_knowledge')
    expect(classifyKnowledgeNeed('what is your booking policy?').need).toBe('retrieval_knowledge')
  })

  it('keeps "how many" attached to the thing being counted', () => {
    // The reason a bare 'how many' is not a keyword: the same question shape
    // counts nights, and a stay length is answered from the tenant's policy, not
    // from a room count. Widen the keyword and the port gets asked about stock
    // it does not need to consult, while the real answer stays in retrieval.
    const nights = classifyKnowledgeNeed('how many nights can I stay?')
    expect(nights.subjects).not.toContain('stock')
    expect(nights.need).toBe('retrieval_knowledge')
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
    content:
      'Cancellations are free up to 48 hours before check-in. After that one night is charged.',
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
