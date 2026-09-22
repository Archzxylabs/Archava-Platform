import { describe, expect, it } from 'vitest'
import { TenantScopeError } from '@archava/core'
import {
  KnowledgeIsolationError,
  KnowledgeStore,
  chunkText,
  tokenise,
  DEFAULT_CHUNK_TARGET_CHARS,
} from '../src/index.js'

function doc(tenantId: string, id: string, content: string, kind = 'faq') {
  return {
    id,
    tenantId,
    kind,
    title: `${id} title`,
    content,
    sourceUrl: `https://example.test/${id}`,
    updatedAt: '2026-04-01',
  }
}

describe('chunkText', () => {
  it('is deterministic', () => {
    const text = 'Check-in opens at 15:00. Check-out closes at 11:00. Late arrivals need a call.'
    expect(chunkText(text)).toEqual(chunkText(text))
  })

  it('keeps a short document whole', () => {
    expect(chunkText('One sentence only.')).toEqual(['One sentence only.'])
  })

  it('splits a long document on sentence boundaries and keeps the order', () => {
    const content = Array.from(
      { length: 40 },
      (_, index) => `Sentence number ${index} carries detail.`,
    ).join(' ')
    const chunks = chunkText(content)
    expect(chunks.length).toBeGreaterThan(1)

    // Document order is the invariant that matters: if chunk N ever preceded
    // chunk N-1, re-ingestion would silently renumber citations. A plain string
    // comparison of chunk heads is *not* a valid check — each chunk after the
    // first starts mid-overlap — so assert on the ordinals instead.
    const indicesPerChunk = chunks.map((chunk) =>
      [...chunk.matchAll(/Sentence number (\d+)/g)].map((match) => Number(match[1])),
    )
    const lastIndexPerChunk = indicesPerChunk.map((indices) => Math.max(...indices))
    expect(lastIndexPerChunk).toEqual([...lastIndexPerChunk].sort((left, right) => left - right))
    expect(indicesPerChunk[0]).toContain(0)
    expect(indicesPerChunk[chunks.length - 1]).toContain(39)

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(DEFAULT_CHUNK_TARGET_CHARS + 120)
    }
  })

  it('returns nothing for blank content', () => {
    expect(chunkText('   \n  ')).toEqual([])
  })
})

describe('tokenise', () => {
  it('drops stopwords and punctuation', () => {
    expect(tokenise('What is the price of the Deluxe room?')).toEqual(['price', 'deluxe', 'room'])
  })
})

describe('KnowledgeStore tenant isolation', () => {
  it('never returns another tenant chunk, even on an exact id', () => {
    const store = new KnowledgeStore()
    store.ingest(doc('acme-hotels', 'checkin-policy', 'Check-in opens at 15:00 daily.'))

    expect(() => store.chunk('other-tenant', 'checkin-policy.c0')).toThrow(KnowledgeIsolationError)
    expect(() => store.chunk('other-tenant', 'checkin-policy.c0')).toThrow(/belongs to tenant/)
  })

  it('refuses to search a tenant that has no documents at all', () => {
    const store = new KnowledgeStore()
    store.ingest(doc('acme-hotels', 'checkin-policy', 'Check-in opens at 15:00 daily.'))

    expect(() => store.search('check-in', 'acme-hotelz')).toThrow(TenantScopeError)
    expect(() => store.search('check-in', 'acme-hotelz')).toThrow(/acme-hotels/)
  })

  it('refuses to search an empty store rather than reporting no results', () => {
    const store = new KnowledgeStore()
    expect(() => store.search('anything', 'acme-hotels')).toThrow(TenantScopeError)
  })

  it('leaks nothing across tenants through retrieval', () => {
    const store = new KnowledgeStore()
    store.ingest(doc('acme-hotels', 'secret-faq', 'Acme offers private transfer service.'))
    store.ingest(doc('other-hotel', 'public-faq', 'Airport shuttle every hour.'))

    const acme = store.search('private transfer service', 'acme-hotels')
    expect(acme).toHaveLength(1)
    expect(acme[0]?.tenantId).toBe('acme-hotels')
    expect(acme[0]?.text).not.toContain('shuttle')

    const other = store.search('airport shuttle every hour', 'other-hotel')
    expect(other.map((chunk) => chunk.provenance.sourceId)).toEqual(['public-faq'])
    expect(other[0]?.text).not.toContain('private transfer')
  })

  it('scopes lists and stats per tenant', () => {
    const store = new KnowledgeStore()
    store.ingest(doc('acme-hotels', 'checkin-policy', 'Check-in opens at 15:00 daily.'))
    store.ingest(doc('other-hotel', 'parking', 'Parking is complimentary overnight.'))

    expect(store.stats('acme-hotels').documents).toBe(1)
    expect(store.stats('other-hotel').documents).toBe(1)
    expect(store.listDocuments('acme-hotels').map((entry) => entry.id)).toEqual(['checkin-policy'])
    expect(store.tenants()).toEqual(['acme-hotels', 'other-hotel'])
  })

  it('re-ingesting a document replaces its chunks instead of duplicating them', () => {
    const store = new KnowledgeStore()
    store.ingest(doc('acme-hotels', 'checkin-policy', 'Check-in opens at 15:00 daily.'))
    store.ingest(doc('acme-hotels', 'checkin-policy', 'Check-in opens at 14:00 after renovation.'))

    expect(store.stats('acme-hotels').chunks).toBe(1)
    expect(store.chunksOf('acme-hotels', 'checkin-policy')[0]?.text).toContain('14:00')
    expect(store.search('check-in time', 'acme-hotels')[0]?.text).not.toContain('15:00')
  })

  it('rejects a malformed document instead of half-ingesting it', () => {
    const store = new KnowledgeStore()
    expect(() => store.ingest(doc('Acme Hotels', 'bad-tenant', 'Content.'))).toThrow(/tenantId/)
    expect(store.tenants()).toEqual([])
  })
})

describe('KnowledgeStore provenance', () => {
  it('records source provenance on every chunk', () => {
    const store = new KnowledgeStore()
    const chunks = store.ingest(doc('acme-hotels', 'checkin-policy', 'Check-in opens at 15:00 daily.'))

    expect(chunks[0]?.provenance).toMatchObject({
      sourceKind: 'faq',
      sourceId: 'checkin-policy',
      sourceTitle: 'checkin-policy title',
      sourceUrl: 'https://example.test/checkin-policy',
      sourceUpdatedAt: '2026-04-01',
    })
    expect(chunks[0]?.provenance.ingestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('returns chunks of a document in document order', () => {
    const store = new KnowledgeStore()
    const content = Array.from(
      { length: 30 },
      (_, index) => `Policy clause ${index} applies to all guests.`,
    ).join(' ')
    store.ingest(doc('acme-hotels', 'house-rules', content))

    const ordinals = store.chunksOf('acme-hotels', 'house-rules').map((chunk) => chunk.ordinal)
    expect(ordinals).toEqual([...ordinals].sort((left, right) => left - right))
  })
})

describe('KnowledgeStore filtering', () => {
  it('restricts retrieval by source kind', () => {
    const store = new KnowledgeStore()
    store.ingest(doc('acme-hotels', 'house-rules', 'Quiet hours begin at 22:00.', 'policy'))
    store.ingest(doc('acme-hotels', 'rooms-faq', 'Quiet hours end at 07:00.', 'faq'))

    const policyOnly = store.search('quiet hours', 'acme-hotels', 8, { kinds: ['policy'] })
    expect(policyOnly).toHaveLength(1)
    expect(policyOnly[0]?.provenance.sourceId).toBe('house-rules')
  })
})

describe('stemming', () => {
  // A query must match a document across ordinary inflection, or the most
  // natural question about the most natural document scores zero.
  const cases: readonly [string, string][] = [
    ['cancellation', 'cancellations'],
    ['book', 'booking'],
    ['cancelled', 'cancellations'],
    ['reservation', 'reservations'],
    ['policies', 'policy'],
    ['cancellation', 'cancelled'],
  ]

  for (const [query, documentWord] of cases) {
    it(`matches "${query}" against "${documentWord}"`, () => {
      const store = new KnowledgeStore()
      store.ingest(
        doc('acme-hotels', 'doc-a', `Our ${documentWord} terms are published in full detail.`),
      )
      expect(store.search(query, 'acme-hotels')).toHaveLength(1)
    })
  }

  it('leaves short words alone rather than destroying them', () => {
    const store = new KnowledgeStore()
    store.ingest(doc('acme-hotels', 'spa', 'The spa has a sauna and a pool.'))
    // "spa" must not be stemmed into something that stops matching.
    expect(store.search('spa', 'acme-hotels')).toHaveLength(1)
  })
})
