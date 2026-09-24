import { describe, expect, it } from 'vitest'
import {
  REFERENCE_CURRENCY,
  REFERENCE_LOCALE,
  REFERENCE_TENANT_ID,
  findUnit,
  referenceConfig,
  referenceConfigInput,
  referenceKnowledgeSources,
  referenceUnits,
} from '../src/index.js'

/**
 * The reference tenant is the fixture every slice and every test of the arc
 * shares, so the shape asserted here is the shape the demo depends on. The
 * first test is the load-bearing one: the dataset must still be *accepted* by
 * the real parser, which is what keeps a schema change from quietly breaking
 * the demo at the moment someone opens it.
 */
describe('reference tenant', () => {
  it('is accepted by the real config parser, not a hand-typed stand-in', () => {
    expect(() => referenceConfig).not.toThrow()
    expect(referenceConfig.tenantId).toBe(REFERENCE_TENANT_ID)
    expect(referenceConfig.schema_version).toBe('1.0.0')
  })

  it('identifies itself as a reference implementation', () => {
    // A config that looks like a real hotel must never be mistaken for one.
    expect(referenceConfig.isReferenceImplementation).toBe(true)
    expect(referenceConfigInput.isReferenceImplementation).toBe(true)
  })

  it('declares the booking arc the showcase has to walk', () => {
    expect(referenceConfig.environment).toBe('commerce_booking')
    expect(referenceConfig.presence).toBe('chat')
    expect(referenceConfig.capability).toBe('act')
    expect(referenceConfig.region).toBe('ID')
    expect(referenceConfig.template).toBe('hospitality')
    expect(referenceConfig.support).toBe('priority')
  })

  it('speaks and prices the way its owner does', () => {
    expect(referenceConfig.primaryLanguage).toBe(REFERENCE_LOCALE)
    expect(referenceConfig.languages).toEqual([{ code: 'id', label: 'Bahasa Indonesia' }])
    expect(REFERENCE_CURRENCY).toBe('IDR')
    expect(referenceConfig.branding.businessName).toBe('Rumah Aman Resort')
  })

  it('ships the modules the arc needs', () => {
    const enabled = referenceConfig.modules
      .filter((module) => module.enabled)
      .map((module) => module.name)
      .sort()
    expect(enabled).toEqual([
      'availability',
      'booking',
      'knowledge',
      'page_awareness',
      'recommendations',
    ])
  })

  it('sells the units its entity schema parsed', () => {
    expect(referenceUnits.map((unit) => unit.id)).toEqual([
      'garden-twin',
      'deluxe-valley',
      'treetop-suite',
      'valley-pool-villa',
    ])
    // A stay is the thing a visitor occupies, which is a resource. Tenancy lives
    // on the config, not on each entity, so scope is asserted on the config.
    for (const unit of referenceUnits) {
      expect(unit.kind).toBe('resource')
      expect(unit.visible).toBe(true)
      expect(unit.summary.length).toBeGreaterThan(0)
    }
  })

  it('publishes the knowledge sources the corpus was authored as', () => {
    // Every subject the corpus covers, in both languages. The Indonesian edition
    // is the original seven; the English siblings exist because retrieval is
    // lexical, and a one-language corpus scores *nothing* against the other
    // language rather than scoring low. `packages/reference/test/knowledge.test.ts`
    // carries the recall regression that keeps both sets answering.
    expect(referenceKnowledgeSources.map((source) => source.id)).toEqual([
      'check-in-dan-check-out',
      'sarapan-pagi',
      'kebijakan-pembatalan',
      'fasilitas-resort',
      'akses-lokasi',
      'kebijakan-anak-dan-tempat-tidur-ekstra',
      'kontak-reservasi',
      'check-in-and-check-out',
      'breakfast',
      'cancellation-policy',
      'resort-facilities',
      'location-access',
      'children-and-extra-beds-policy',
      'reservation-contact',
    ])
  })

  it('looks a unit up by id, and says so when the tenant does not own it', () => {
    expect(findUnit('treetop-suite')?.name).toBeTruthy()
    expect(findUnit('nope')).toBeUndefined()
    // An unknown unit is absent, not defaulted to the first one.
    expect(findUnit('')).toBeUndefined()
  })
})
