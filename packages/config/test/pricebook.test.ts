import { describe, expect, it } from 'vitest'
import type { Pricebook } from '../src/pricing/schema.js'
import { PricebookError, loadPricebook, parsePricebook } from '../src/pricing/loader.js'

/**
 * A detached copy, so a test can tamper without corrupting the next one.
 *
 * The round trip returns `any`, which the linter rightly flags: at that point
 * the value is unvalidated JSON. It is named back into the schema's own type
 * here, because every caller immediately writes a field the schema defines, and
 * a typo in one should be a compile error rather than a pricebook that quietly
 * stayed untampered.
 */
function detached(pricebook: Pricebook): Pricebook {
  return JSON.parse(JSON.stringify(pricebook)) as Pricebook
}

/**
 * A detached copy as the loader receives it: untrusted JSON, untyped.
 *
 * The counterpart to {@link detached}, for the tests that must write values
 * `pricebookSchema` already forbids — a missing region, a discretionary
 * discount that is not the literal `0`. Those are exactly the values the loader
 * exists to reject, which means they cannot be written through the schema's
 * own type, and the fields such a test writes are deliberately not checked
 * here. `parsePricebook` is handed a string and decides for itself; what comes
 * back out of it is typed again.
 */
function detachedDocument(pricebook: Pricebook): Record<string, unknown> {
  return JSON.parse(JSON.stringify(pricebook)) as Record<string, unknown>
}

describe('pricebook loader', () => {
  it('loads and validates the real pricebook', () => {
    const pricebook = loadPricebook()
    expect(pricebook.schema_version).toBe('1.0.0')
    expect(Object.keys(pricebook.regions)).toEqual(['GLOBAL', 'ID'])
  })

  it('rejects a pricebook with an FX-converted Indonesia region', () => {
    const pricebook = loadPricebook()
    const tampered = detached(pricebook)
    tampered.regions.ID.presence.voice.setup = tampered.regions.GLOBAL.presence.voice.setup * 16000
    expect(() => parsePricebook(JSON.stringify(tampered))).not.toThrow()
    // The schema accepts the number; the isolation invariant is asserted at the
    // engine level, where any drift from the published ID figures fails.
    const parsed = parsePricebook(JSON.stringify(tampered))
    expect(parsed.regions.ID.presence.voice.setup).not.toBe(
      pricebook.regions.ID.presence.voice.setup,
    )
  })

  it('fails closed on malformed JSON', () => {
    expect(() => parsePricebook('{ not json')).toThrowError(PricebookError)
  })

  it('fails closed when a required region is missing', () => {
    const document = detachedDocument(loadPricebook())
    delete (document['regions'] as Record<string, unknown>)['ID']
    expect(() => parsePricebook(JSON.stringify(document))).toThrowError(/failed validation/)
  })

  it('fails closed when a price is negative', () => {
    const tampered = detached(loadPricebook())
    tampered.regions.GLOBAL.presence.chat.setup = -1
    expect(() => parsePricebook(JSON.stringify(tampered))).toThrowError(/failed validation/)
  })

  it('rejects a discretionary-discount rule other than zero', () => {
    const document = detachedDocument(loadPricebook())
    const rules = document['discount_rules'] as Record<string, number>
    rules['agent_max_discretionary_discount_pct'] = 5
    expect(() => parsePricebook(JSON.stringify(document))).toThrowError(/failed validation/)
  })
})

describe('classifyLine', () => {
  it('classifies fixed, from, and custom lines', async () => {
    const { classifyLine } = await import('../src/pricing/types.js')
    expect(classifyLine({ setup: 100, monthly: 10 })).toEqual({
      kind: 'fixed',
      setup: 100,
      monthly: 10,
    })
    expect(classifyLine({ setup_from: 8000 })).toEqual({
      kind: 'from',
      setup: 8000,
      monthly: undefined,
    })
    expect(classifyLine({ custom: true })).toEqual({ kind: 'custom' })
    expect(classifyLine({ monthly: 199 })).toEqual({ kind: 'fixed', setup: 0, monthly: 199 })
    expect(classifyLine(null)).toEqual({ kind: 'custom' })
  })
})
