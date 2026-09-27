import { describe, expect, it } from 'vitest'
import type { ActionExecutionRequest } from '@archava/assistant'
import {
  EMAIL_ERROR_CODES,
  EmailActionExecutor,
  type ApprovedEmailTemplate,
  type EmailGateway,
  type EmailGatewayOutcome,
  type EmailSendRequest,
  type EmailTemplateResolver,
} from '../src/index.js'

const TENANT = 'hotel-a'
const TEMPLATE: ApprovedEmailTemplate = {
  tenantId: TENANT,
  templateId: 'booking-receipt',
  providerTemplateId: 'trusted-provider-template',
  senderAddress: 'receipts@example.com',
  approved: true,
}

function request(overrides: Partial<ActionExecutionRequest> = {}): ActionExecutionRequest {
  return {
    tenantId: TENANT,
    sessionId: 'session-1',
    action: 'email.send',
    inputs: { templateId: TEMPLATE.templateId, to: 'guest@example.com' },
    idempotencyKey: 'attempt-1',
    ...overrides,
  }
}

function fixture(
  options: {
    template?: ApprovedEmailTemplate | null
    outcome?: EmailGatewayOutcome | null
    lookupThrows?: boolean
    sendThrows?: boolean
  } = {},
) {
  const sends: EmailSendRequest[] = []
  const templates: EmailTemplateResolver = {
    resolve(): Promise<ApprovedEmailTemplate | null> {
      if (options.lookupThrows) throw new Error('secret customer data')
      return Promise.resolve(options.template === undefined ? TEMPLATE : options.template)
    },
  }
  const gateway: EmailGateway = {
    send(call): Promise<EmailGatewayOutcome> {
      sends.push(call)
      if (options.sendThrows) throw new Error('guest@example.com secret transport payload')
      return Promise.resolve(
        (options.outcome === undefined
          ? { outcome: 'accepted', providerMessageId: 'opaque-1' }
          : options.outcome) as EmailGatewayOutcome,
      )
    },
  }
  return { executor: new EmailActionExecutor({ templates, gateway }), sends }
}

describe('email.send executor', () => {
  it('accepts only an authoritative provider receipt and never claims delivery', async () => {
    const subject = fixture()
    const result = await subject.executor.execute(request())
    expect(result).toEqual({
      status: 'succeeded',
      output: { deliveryStatus: 'accepted', providerMessageId: 'opaque-1' },
    })
    expect(subject.sends).toEqual([
      {
        tenantId: TENANT,
        recipient: 'guest@example.com',
        template: TEMPLATE,
        idempotencyKey: 'attempt-1',
      },
    ])
    expect(JSON.stringify(result)).not.toContain('guest@example.com')
    expect(JSON.stringify(result)).not.toContain('trusted-provider-template')
    expect(JSON.stringify(result)).not.toContain('delivered')
  })

  it.each([
    { outcome: { outcome: 'rejected', reason: 'secret' }, code: EMAIL_ERROR_CODES.rejected },
    { outcome: { outcome: 'unknown', reason: 'secret' }, code: EMAIL_ERROR_CODES.unknown },
    {
      outcome: { outcome: 'accepted', providerMessageId: '' },
      code: EMAIL_ERROR_CODES.incompleteAcceptance,
    },
    {
      outcome: { outcome: 'accepted', providerMessageId: 'guest@example.com' },
      code: EMAIL_ERROR_CODES.incompleteAcceptance,
    },
    { outcome: null, code: EMAIL_ERROR_CODES.incompleteAcceptance },
  ] as const)('fails safely on $code', async ({ outcome, code }) => {
    const result = await fixture({ outcome: outcome as EmailGatewayOutcome }).executor.execute(
      request(),
    )
    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.errorCode).toBe(code)
      expect(result.retryable).toBe(false)
      expect(result.message).not.toContain('secret')
    }
  })

  it('rejects unsupported action before any gateway call', async () => {
    const subject = fixture()
    const result = await subject.executor.execute(request({ action: 'booking.create' }))
    expect(result).toMatchObject({
      status: 'failed',
      errorCode: EMAIL_ERROR_CODES.unsupportedAction,
    })
    expect(subject.sends).toHaveLength(0)
  })

  it.each([
    { to: 'bad-address' },
    { templateId: '' },
    { templateId: TEMPLATE.templateId, to: 'guest@example.com', body: 'model text' },
  ])('rejects malformed or extra model input', async (inputs) => {
    const subject = fixture()
    expect(await subject.executor.execute(request({ inputs }))).toMatchObject({
      status: 'failed',
      errorCode: EMAIL_ERROR_CODES.malformedInput,
    })
    expect(subject.sends).toHaveLength(0)
  })

  it('rejects missing, unapproved, and cross-tenant templates', async () => {
    for (const template of [
      null,
      42,
      { ...TEMPLATE, approved: false },
      { ...TEMPLATE, tenantId: 'hotel-b' },
      { ...TEMPLATE, templateId: 'other' },
    ]) {
      const subject = fixture({ template: template as ApprovedEmailTemplate | null })
      expect(await subject.executor.execute(request())).toMatchObject({
        status: 'failed',
        errorCode: EMAIL_ERROR_CODES.templateUnavailable,
      })
      expect(subject.sends).toHaveLength(0)
    }
  })

  it('drops lookup and transport errors that may contain PII', async () => {
    for (const options of [{ lookupThrows: true }, { sendThrows: true }]) {
      const result = await fixture(options).executor.execute(request())
      expect(result.status).toBe('failed')
      expect(JSON.stringify(result)).not.toContain('guest@example.com')
      expect(JSON.stringify(result)).not.toContain('secret')
    }
  })

  it('forwards a replay key and tenant unchanged', async () => {
    const subject = fixture()
    await subject.executor.execute(request())
    await subject.executor.execute(request())
    expect(subject.sends).toHaveLength(2)
    expect(subject.sends.every((call) => call.idempotencyKey === 'attempt-1')).toBe(true)
    expect(subject.sends.every((call) => call.tenantId === TENANT)).toBe(true)
  })

  it('a tenant-scoped durable gateway can deduplicate a replay and refuse key conflict', async () => {
    const ledger = new Map<string, { payload: string; id: string }>()
    let writes = 0
    const gateway: EmailGateway = {
      send(call) {
        const key = JSON.stringify([call.tenantId, call.idempotencyKey])
        const payload = JSON.stringify([call.recipient, call.template.providerTemplateId])
        const prior = ledger.get(key)
        if (prior !== undefined) {
          return Promise.resolve(
            prior.payload === payload
              ? { outcome: 'accepted', providerMessageId: prior.id }
              : { outcome: 'rejected', reason: 'idempotency_conflict' },
          )
        }
        writes += 1
        const id = `opaque-${writes}`
        ledger.set(key, { payload, id })
        return Promise.resolve({ outcome: 'accepted', providerMessageId: id } as const)
      },
    }
    const templates: EmailTemplateResolver = { resolve: () => Promise.resolve(TEMPLATE) }
    const executor = new EmailActionExecutor({ templates, gateway })
    const first = await executor.execute(request())
    const replay = await executor.execute(request())
    const conflict = await executor.execute(
      request({ inputs: { templateId: TEMPLATE.templateId, to: 'other@example.com' } }),
    )
    expect(first).toEqual(replay)
    expect(conflict).toMatchObject({ status: 'failed', errorCode: EMAIL_ERROR_CODES.rejected })
    expect(writes).toBe(1)
  })
})
