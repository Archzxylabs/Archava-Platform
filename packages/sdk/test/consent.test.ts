import { describe, expect, it } from 'vitest'
import {
  CONSENT_DOMAINS,
  DENIED_CONSENT,
  grantConsent,
  hasConsent,
  missingConsent,
  parseConsent,
  revokeConsent,
} from '../src/index.js'

/**
 * Consent is the one part of the SDK where "mostly right" is the same as wrong.
 * A gate that defaults to yes for a domain the host never asked about is not a
 * gate, so these tests are written as refusals to let go rather than as
 * descriptions of happy behaviour.
 */
describe('parseConsent', () => {
  it('reads a missing record as a full refusal', () => {
    expect(parseConsent(undefined)).toEqual(DENIED_CONSENT)
    expect(parseConsent({})).toEqual(DENIED_CONSENT)
  })

  it('grants a domain only on an explicit true', () => {
    const state = parseConsent({ page_context: true, identity: undefined, analytics: false })

    expect(hasConsent(state, 'page_context')).toBe(true)
    expect(hasConsent(state, 'identity')).toBe(false)
    expect(hasConsent(state, 'analytics')).toBe(false)
  })

  it('ignores a domain the visitor never saw', () => {
    const state = parseConsent({ page_context: true })

    expect(CONSENT_DOMAINS.every((domain) => domain === 'page_context' || state[domain] === false)).toBe(
      true,
    )
  })
})

describe('grantConsent', () => {
  it('grants exactly the domain named and leaves the rest alone', () => {
    expect(grantConsent(DENIED_CONSENT, 'identity')).toEqual({
      page_context: false,
      identity: true,
      analytics: false,
    })
  })

  it('returns a new record rather than editing the one it was given', () => {
    const before = { ...DENIED_CONSENT }

    grantConsent(before, 'analytics')

    expect(before).toEqual(DENIED_CONSENT)
  })
})

describe('revokeConsent', () => {
  it('withdraws one domain and keeps the others granted', () => {
    const granted = grantConsent(grantConsent(DENIED_CONSENT, 'page_context'), 'identity')

    expect(revokeConsent(granted, 'identity')).toEqual({
      page_context: true,
      identity: false,
      analytics: false,
    })
  })

  it('is idempotent, so a banner that fires twice changes nothing', () => {
    const once = revokeConsent(DENIED_CONSENT, 'analytics')

    expect(revokeConsent(once, 'analytics')).toEqual(once)
  })
})

describe('missingConsent', () => {
  it('reports a partial grant rather than throwing', () => {
    const state = grantConsent(DENIED_CONSENT, 'page_context')

    // A visitor who declines identity still gets an assistant; it just never
    // learns their name. Reporting is the honest answer, refusing is not.
    expect(missingConsent(state, ['identity', 'analytics'])).toEqual(['identity', 'analytics'])
    expect(missingConsent(state, ['page_context'])).toEqual([])
  })
})
