import { describe, expect, it } from 'vitest'
import type { EmailDeliveryStatusLookup } from '@archava/act-email'
import { POSTMARK_STATUS_PORT_ID, PostmarkStatusPort } from '../src/status.js'

const lookup: EmailDeliveryStatusLookup = {
  tenantId: 'tenant-a',
  idempotencyKey: 'raw-idempotency-key-a',
  fingerprint: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
}

describe('PostmarkStatusPort', () => {
  it('answers unknown, and says why, for a question it cannot answer', async () => {
    const port = new PostmarkStatusPort()

    expect(await port.status(lookup)).toEqual({
      outcome: 'unknown',
      reason: 'status_not_available',
    })
  })

  it('never answers anything else, for any tenant or attempt', async () => {
    const port = new PostmarkStatusPort()
    const attempts = [lookup, { ...lookup, tenantId: 'tenant-b' }, { ...lookup, fingerprint: '' }]

    for (const attempted of attempts) {
      expect(await port.status(attempted)).toEqual({
        outcome: 'unknown',
        reason: 'status_not_available',
      })
    }
    // A status port that answered "not sent" here would be how a duplicate gets
    // created: the outbox would read a verdict where there is none.
    expect((await port.status(lookup)).outcome).not.toBe('rejected')
  })

  it('identifies itself for the audit trail, with no credential in the id', async () => {
    const port = new PostmarkStatusPort()
    await port.status(lookup)

    expect(port.statusPortId).toBe(POSTMARK_STATUS_PORT_ID)
    expect(port.statusPortId).toBe('postmark:status@1')
  })

  it('says which deployment it reports on, when a deployment is named', () => {
    const port = new PostmarkStatusPort({ deployment: 'eu-west' })

    expect(port.statusPortId).toBe('postmark:status@1(eu-west)')
  })

  it('keeps nothing the lookup carried, because there is nowhere to keep it', async () => {
    // Credential-free by construction: a port that cannot reach the provider has
    // nothing to authenticate, so there is nothing here for a look to send on.
    const port = new PostmarkStatusPort()
    await port.status(lookup)

    expect(Object.keys(port)).toEqual(['statusPortId'])
    expect(JSON.stringify(port)).not.toContain(lookup.idempotencyKey)
  })
})
