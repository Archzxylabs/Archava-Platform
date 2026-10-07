import { describe, expect, it, vi, afterEach } from 'vitest'
import type { ApprovedEmailTemplate, EmailSendRequest } from '@archava/act-email'
import {
  POSTMARK_SEND_URL,
  PostmarkEmailGateway,
  type PostmarkEmailGatewayOptions,
} from '../src/gateway.js'
import type {
  PostmarkHTTPRequest,
  PostmarkHTTPResponse,
  PostmarkTransport,
} from '../src/transport.js'

/**
 * The outbound request, as the fake transport received it.
 *
 * A recorder rather than a stub: the assertions below are almost entirely about
 * *what this adapter put on the wire*, and a stub that only answered a
 * pre-shaped question would let a wrong payload through.
 */
interface Recorded {
  readonly requests: PostmarkHTTPRequest[]
}

const TOKEN = 'supersecret-token-value'
const LABEL_KEY = new Uint8Array(32).fill(7)

function recorder(replies: readonly PostmarkHTTPResponse[]): PostmarkTransport & Recorded {
  const requests: PostmarkHTTPRequest[] = []
  return {
    requests,
    post: (request: PostmarkHTTPRequest): Promise<PostmarkHTTPResponse> => {
      requests.push(request)
      const reply = replies[Math.min(requests.length, replies.length) - 1]
      if (reply === undefined) return Promise.reject(new Error('no reply scripted for this call'))
      return Promise.resolve(reply)
    },
  }
}

/**
 * The request the fake transport received at `index`, named out loud if absent.
 *
 * An index off the end is a test that no longer describes what the code does,
 * so it is an error in the test rather than a field on `undefined`.
 */
function requestAt(requests: readonly PostmarkHTTPRequest[], index = 0): PostmarkHTTPRequest {
  const seen = requests[index]
  if (seen === undefined) throw new Error(`the transport was called ${requests.length} time(s)`)
  return seen
}

/** A send request a trusted resolver could have produced. */
function request(
  overrides: Partial<ApprovedEmailTemplate> & { key?: string; recipient?: string } = {},
): EmailSendRequest {
  const template: ApprovedEmailTemplate = {
    tenantId: overrides.tenantId ?? 'tenant-a',
    templateId: 'welcome',
    providerTemplateId: overrides.providerTemplateId ?? 'provider-template-1',
    senderAddress: overrides.senderAddress ?? 'no-reply@example.com',
    approved: true,
  }
  return {
    tenantId: template.tenantId,
    recipient: overrides.recipient ?? 'receiver@example.com',
    template,
    idempotencyKey: overrides.key ?? 'raw-idempotency-key-a',
  }
}

function gateway(
  transport: PostmarkTransport,
  overrides: Partial<PostmarkEmailGatewayOptions> = {},
): PostmarkEmailGateway {
  return new PostmarkEmailGateway({
    serverToken: TOKEN,
    transport,
    attemptLabelKey: LABEL_KEY,
    ...overrides,
  })
}

/** A body the fake transport received, parsed: the one at `index`, or the only one. */
function bodyOf(recorded: Recorded, index = 0): Record<string, unknown> {
  return JSON.parse(requestAt(recorded.requests, index).body) as Record<string, unknown>
}

/** The label this package derived from the upstream raw idempotency key. */
function labelOf(recorded: Recorded, index = 0): string {
  const metadata = bodyOf(recorded, index)['Metadata']
  if (typeof metadata !== 'object' || metadata === null) throw new Error('no metadata was sent')
  return (metadata as Record<string, unknown>)['archava_attempt'] as string
}

const ok = (messageId = 'dfca9f7c-1f0e-4b2a-9c3d-0a1b2c3d4e5f'): PostmarkHTTPResponse => ({
  status: 200,
  body: JSON.stringify({
    To: 'receiver@example.com',
    SubmittedAt: '2026-09-27T00:00:00Z',
    MessageID: messageId,
    ErrorCode: 0,
    Message: 'OK',
  }),
})

afterEach(() => {
  vi.useRealTimers()
})

describe('PostmarkEmailGateway, what it puts on the wire', () => {
  it('sends exactly one request, to the documented endpoint, with the token only in the header', async () => {
    const transport = recorder([ok()])
    await gateway(transport).send(request())

    expect(transport.requests).toHaveLength(1)
    const sent = requestAt(transport.requests)
    expect(sent.url).toBe(POSTMARK_SEND_URL)
    // Header names are the lower-case spelling, so a fake and a server compare
    // one shape. The token appears nowhere else in the request.
    expect(sent.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      'x-postmark-server-token': TOKEN,
    })
    expect(sent.body).not.toContain(TOKEN)
  })

  it('sends the template the request named, and no body or subject of its own', async () => {
    const transport = recorder([ok()])
    await gateway(transport).send(request())

    const body = bodyOf(transport)
    expect(body['To']).toBe('receiver@example.com')
    expect(body['From']).toBe('no-reply@example.com')
    // TemplateModel is required by the endpoint and empty on purpose: every
    // rendered value comes from the tenant's own template.
    expect(body['TemplateModel']).toEqual({})
    expect(body['MessageStream']).toBe('outbound')
    // A body written here would be text this package has no authority over.
    expect(Object.keys(body).sort()).toEqual([
      'From',
      'MessageStream',
      'Metadata',
      'TemplateAlias',
      'TemplateModel',
      'To',
    ])
    expect(body).not.toHaveProperty('Subject')
    expect(body).not.toHaveProperty('HtmlBody')
    expect(body).not.toHaveProperty('TextBody')
  })

  it('sends the recipient as the one address the request carried, never a joined list', async () => {
    const transport = recorder([ok()])
    await gateway(transport).send(request({ recipient: 'one@example.com' }))

    expect(bodyOf(transport)['To']).toBe('one@example.com')
    expect(bodyOf(transport)['Cc']).toBeUndefined()
    expect(bodyOf(transport)['Bcc']).toBeUndefined()
  })

  it('sends a numeric provider template id as an integer TemplateId, and nothing else', async () => {
    const transport = recorder([ok()])
    await gateway(transport).send(request({ providerTemplateId: '30492' }))

    const body = bodyOf(transport)
    expect(body['TemplateId']).toBe(30492)
    expect(body).not.toHaveProperty('TemplateAlias')
  })

  it('sends a non-numeric provider template id as a TemplateAlias, and nothing else', async () => {
    const transport = recorder([ok()])
    await gateway(transport).send(request({ providerTemplateId: 'welcome-alias' }))

    const body = bodyOf(transport)
    expect(body['TemplateAlias']).toBe('welcome-alias')
    expect(body).not.toHaveProperty('TemplateId')
  })

  it('sends through the message stream it was given', async () => {
    const transport = recorder([ok()])
    await gateway(transport, { messageStream: 'broadcast' }).send(request())

    expect(bodyOf(transport)['MessageStream']).toBe('broadcast')
  })

  it('carries an abort signal, so a hung socket can be released', async () => {
    const transport = recorder([ok()])
    await gateway(transport).send(request())

    expect(requestAt(transport.requests).signal).toBeInstanceOf(AbortSignal)
  })
})

describe('PostmarkEmailGateway, the idempotency key', () => {
  it('never puts the raw key on the wire, and sends an opaque derived label instead', async () => {
    const transport = recorder([ok()])
    await gateway(transport).send(request({ key: 'raw-idempotency-key-a' }))

    const raw = 'raw-idempotency-key-a'
    const sent = requestAt(transport.requests).body
    expect(sent).not.toContain(raw)
    // A 32-byte digest in base64url: 43 characters, no padding, no '+', no '/'.
    expect(labelOf(transport)).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(labelOf(transport)).not.toContain(raw)
    // The label is this package's own search aid, not a provider promise:
    // nothing in the request asks Postmark to deduplicate on it.
    expect(sent).not.toContain('idempotency')
  })

  it('derives the same label for the same key and a different one for another key', async () => {
    const transport = recorder([ok(), ok()])
    const again = recorder([ok()])
    const port = gateway(transport)
    await port.send(request({ key: 'key-one' }))
    await port.send(request({ key: 'key-two' }))
    // A second gateway, a second process, the same key: the label is a function
    // of the key and the key material, so recovery can match the attempt.
    await gateway(again).send(request({ key: 'key-one' }))

    expect(labelOf(transport, 0)).toBe(labelOf(again))
    // Another key is another attempt, and must not be able to borrow it.
    expect(labelOf(transport, 0)).not.toBe(labelOf(transport, 1))
  })

  it('derives a different label under a different key, so a shared key cannot be reused', async () => {
    const withKey = recorder([ok()])
    const withOtherKey = recorder([ok()])
    await gateway(withKey).send(request({ key: 'key-one' }))
    await gateway(withOtherKey, { attemptLabelKey: new Uint8Array(32).fill(9) }).send(
      request({ key: 'key-one' }),
    )

    expect(labelOf(withKey)).not.toBe(labelOf(withOtherKey))
  })

  it('separates identical raw keys across tenants', async () => {
    const tenantA = recorder([ok()])
    const tenantB = recorder([ok()])
    await gateway(tenantA).send(request({ tenantId: 'tenant-a', key: 'shared-key' }))
    await gateway(tenantB).send(request({ tenantId: 'tenant-b', key: 'shared-key' }))

    expect(labelOf(tenantA)).not.toBe(labelOf(tenantB))
  })
})

describe('PostmarkEmailGateway, what a reply means', () => {
  it('reports accepted only with the message id Postmark issued', async () => {
    const transport = recorder([ok('dfca9f7c-1f0e-4b2a-9c3d-0a1b2c3d4e5f')])

    expect(await gateway(transport).send(request())).toEqual({
      outcome: 'accepted',
      providerMessageId: 'dfca9f7c-1f0e-4b2a-9c3d-0a1b2c3d4e5f',
    })
  })

  it('does not report accepted when a 200 carries no message id', async () => {
    const transport = recorder([
      { status: 200, body: JSON.stringify({ To: 'receiver@example.com', ErrorCode: 0 }) },
    ])

    expect(await gateway(transport).send(request())).toEqual({
      outcome: 'unknown',
      reason: 'mail_provider_receipt_absent',
    })
  })

  it('never accepts a success-shaped body attached to a failed HTTP response', async () => {
    for (const status of [404, 500, 503, 202]) {
      const transport = recorder([{ ...ok(), status }])

      expect(await gateway(transport).send(request())).toEqual({
        outcome: 'unknown',
        reason: 'mail_provider_reply_unrecognised',
      })
    }
  })

  it('does not report accepted when the message id is not a well-formed id', async () => {
    const transport = recorder([
      { status: 200, body: JSON.stringify({ ErrorCode: 0, MessageID: 'receiver@example.com' }) },
    ])

    expect(await gateway(transport).send(request())).toEqual({
      outcome: 'unknown',
      reason: 'mail_provider_receipt_absent',
    })
  })

  it('reads the ErrorCode, not the status: a documented refusal inside a 200 is a rejection', async () => {
    const transport = recorder([
      {
        status: 200,
        body: JSON.stringify({ ErrorCode: 403, Message: "Invalid request field(s): 'From'." }),
      },
    ])

    expect(await gateway(transport).send(request())).toEqual({
      outcome: 'rejected',
      reason: 'mail_provider_rejected_request',
    })
  })

  it('names an unknown template by the code the provider sent', async () => {
    const transport = recorder([
      { status: 422, body: JSON.stringify({ ErrorCode: 1101, Message: 'Template not found.' }) },
    ])

    expect(await gateway(transport).send(request())).toEqual({
      outcome: 'rejected',
      reason: 'mail_provider_template_unknown',
    })
  })

  it('keeps an inactive recipient apart from a malformed request', async () => {
    const transport = recorder([{ status: 422, body: JSON.stringify({ ErrorCode: 406 }) }])

    expect(await gateway(transport).send(request())).toEqual({
      outcome: 'rejected',
      reason: 'mail_provider_rejected_recipient',
    })
  })

  it('reports a rate-limited send as refused, not as unknown', async () => {
    const transport = recorder([{ status: 429, body: '' }])

    expect(await gateway(transport).send(request())).toEqual({
      outcome: 'rejected',
      reason: 'mail_provider_rate_limited',
    })
  })

  it('reads a credential refusal from the status when the body carries no code', async () => {
    const transport = recorder([{ status: 401, body: '' }])

    expect(await gateway(transport).send(request())).toEqual({
      outcome: 'rejected',
      reason: 'mail_provider_rejected_credential',
    })
  })

  it('does not interpret a status that says nothing about this message', async () => {
    for (const status of [404, 500, 503]) {
      const transport = recorder([{ status, body: '' }])

      expect(await gateway(transport).send(request())).toEqual({
        outcome: 'unknown',
        reason: 'mail_provider_reply_unrecognised',
      })
    }
  })

  it('does not interpret a documented code it cannot name, rather than guessing a refusal', async () => {
    // Code 100 is documented as "offline for maintenance": an outage, not a
    // refusal about this message.
    const transport = recorder([{ status: 503, body: JSON.stringify({ ErrorCode: 100 }) }])

    expect(await gateway(transport).send(request())).toEqual({
      outcome: 'unknown',
      reason: 'mail_provider_reply_unrecognised',
    })
  })

  it('does not call a body that is not JSON a refusal', async () => {
    const transport = recorder([{ status: 200, body: '<html>gateway error</html>' }])

    expect(await gateway(transport).send(request())).toEqual({
      outcome: 'unknown',
      reason: 'mail_provider_reply_unreadable',
    })
  })
})

describe('PostmarkEmailGateway, when the answer does not come', () => {
  it('reports unknown when the transport exceeds its bound, and calls it once', async () => {
    vi.useFakeTimers()
    const requests: PostmarkHTTPRequest[] = []
    const transport: PostmarkTransport = {
      post: (request) => {
        requests.push(request)
        // A transport that ignores its abort signal must still be bounded.
        return new Promise<PostmarkHTTPResponse>(() => undefined)
      },
    }
    const pending = gateway(transport, { timeoutMs: 1_000 }).send(request())
    await vi.advanceTimersByTimeAsync(1_000)

    expect(await pending).toEqual({ outcome: 'unknown', reason: 'mail_provider_did_not_answer' })
    expect(requests).toHaveLength(1)
  })

  it('reports unknown when the transport cannot be reached, and calls it once', async () => {
    const requests: PostmarkHTTPRequest[] = []
    const transport: PostmarkTransport = {
      post: (request) => {
        requests.push(request)
        // A native network error, carrying the URL, the proxy host and the
        // token-bearing header dump. None of it may travel onward.
        return Promise.reject(
          new Error(`fetch failed for ${POSTMARK_SEND_URL} via proxy: token=${TOKEN}`),
        )
      },
    }
    const outcome = await gateway(transport).send(request())

    expect(outcome).toEqual({ outcome: 'unknown', reason: 'mail_provider_unreachable' })
    expect(JSON.stringify(outcome)).not.toContain(TOKEN)
    expect(JSON.stringify(outcome)).not.toContain('proxy')
    expect(requests).toHaveLength(1)
  })

  it('never retries a send itself, whatever the answer was', async () => {
    const refused = recorder([
      {
        status: 200,
        body: JSON.stringify({ ErrorCode: 403, Message: 'Invalid request field(s).' }),
      },
    ])
    const silent = recorder([{ status: 500, body: '' }])
    const unexplained = recorder([{ status: 200, body: '' }])

    await gateway(refused).send(request())
    await gateway(silent).send(request())
    await gateway(unexplained).send(request())

    expect(refused.requests).toHaveLength(1)
    expect(silent.requests).toHaveLength(1)
    expect(unexplained.requests).toHaveLength(1)
  })

  it('keeps the same attempt label across repeated sends of one key', async () => {
    // The outbox owns at-most-once; a second send from here would be a second
    // message in a real mailbox. What this keeps honest is the label: the
    // attempt is still identifiable on both.
    const transport = recorder([{ status: 500, body: '' }, ok()])
    const port = gateway(transport)

    await port.send(request({ key: 'same-key' }))
    await port.send(request({ key: 'same-key' }))

    expect(transport.requests).toHaveLength(2)
    expect(labelOf(transport, 0)).toBe(labelOf(transport, 1))
  })
})

describe('PostmarkEmailGateway, what it refuses to send', () => {
  it('never asks the provider about a request it cannot vouch for', async () => {
    const transport = recorder([ok()])
    const port = gateway(transport)
    const base = request()
    // `approved` is the literal `true` in the port, so the wrong value cannot
    // be built without forcing it past the type. This is the wrong value.
    const unapproved = { ...base.template, approved: false } as unknown as ApprovedEmailTemplate
    const unusable: readonly EmailSendRequest[] = [
      request({ recipient: 'not-an-address' }),
      { ...base, tenantId: '   ' },
      { ...base, idempotencyKey: '' },
      { ...base, template: { ...base.template, providerTemplateId: '  ' } },
      { ...base, template: unapproved },
    ]

    for (const send of unusable) {
      expect(await port.send(send)).toEqual({
        outcome: 'rejected',
        reason: 'mail_request_not_sendable',
      })
    }
    expect(transport.requests).toHaveLength(0)
  })

  it('rejects a numeric template ID that Number would round into another ID', async () => {
    const transport = recorder([ok()])
    const port = gateway(transport)

    expect(await port.send(request({ providerTemplateId: '9007199254740993' }))).toEqual({
      outcome: 'rejected',
      reason: 'mail_request_not_sendable',
    })
    expect(transport.requests).toHaveLength(0)
  })

  it("sends the sender the resolver approved, because that authority is not this file's", async () => {
    // The sender is read back off the resolved template, never taken from the
    // request, and which tenants own which signatures is the resolver's and
    // Postmark's to answer — not this adapter's to second-guess. What this
    // asserts is that the address on the wire is the one the template carried.
    const transport = recorder([ok()])
    await gateway(transport).send(request({ senderAddress: 'billing@example.com' }))

    expect(bodyOf(transport)['From']).toBe('billing@example.com')
  })

  it('refuses a template that belongs to another tenant, so no sender is borrowed', async () => {
    const transport = recorder([ok()])
    const req = request()
    const borrowed = { ...req, template: { ...req.template, tenantId: 'tenant-b' } }

    expect(await gateway(transport).send(borrowed)).toEqual({
      outcome: 'rejected',
      reason: 'mail_request_not_sendable',
    })
    expect(transport.requests).toHaveLength(0)
  })

  it('refuses to be built without a server token, rather than attempting a 401', () => {
    const transport = recorder([ok()])
    const options = {
      transport,
      attemptLabelKey: LABEL_KEY,
    } as Partial<PostmarkEmailGatewayOptions>
    expect(() => gateway(transport, { serverToken: '   ' })).toThrow(TypeError)
    expect(() => new PostmarkEmailGateway(options as PostmarkEmailGatewayOptions)).toThrow(
      TypeError,
    )
  })

  it('refuses a label key too short to be a secret', () => {
    const transport = recorder([ok()])
    expect(() => gateway(transport, { attemptLabelKey: new Uint8Array(16) })).toThrow(TypeError)
    expect(() =>
      gateway(transport, { attemptLabelKey: 'not-bytes' as unknown as Uint8Array }),
    ).toThrow(TypeError)
  })

  it('refuses a timeout that could not bound anything', () => {
    const transport = recorder([ok()])
    expect(() => gateway(transport, { timeoutMs: 0 })).toThrow(TypeError)
    expect(() => gateway(transport, { timeoutMs: -1 })).toThrow(TypeError)
    expect(() => gateway(transport, { timeoutMs: Number.NaN })).toThrow(TypeError)
  })

  it('copies the label key it is handed, so a later caller cannot retune the derivation', async () => {
    const transport = recorder([ok()])
    const mutable = new Uint8Array(32).fill(3)
    await gateway(transport, { attemptLabelKey: mutable }).send(request({ key: 'key-one' }))
    mutable.fill(9)
    await gateway(transport, { attemptLabelKey: mutable }).send(request({ key: 'key-one' }))

    // Each gateway took its own copy at construction time.
    expect(labelOf(transport, 0)).not.toBe(labelOf(transport, 1))
  })
})
