import { describe, expect, it } from 'vitest'
import {
  REDACTED_LABEL,
  maskSensitiveFields,
  maskString,
  resolveMaskRules,
  roleCan,
  ADMIN_RESOURCES,
} from '../src/index.js'

describe('maskSensitiveFields', () => {
  it('never mutates its input', () => {
    const input = { email: 'ada@example.com', note: 'plain' }
    const snapshot = structuredClone(input)
    maskSensitiveFields(input)
    expect(input).toEqual(snapshot)
  })

  it('masks sensitive fields by name, at any depth', () => {
    const result = maskSensitiveFields({
      customerEmail: 'ada@example.com',
      customerPhone: '+6281234567890',
      nested: { email: 'grace@example.com', phone: '0215551234' },
      list: [{ email: 'alan@example.com' }],
      note: 'this text stays',
    })
    expect(result.masked).toBe(true)

    const masked = result.value as Record<string, unknown>
    expect(masked.customerEmail).toBe('ad••••••••••••')
    expect(masked.customerPhone).toBe('+62•••••••••••')
    expect(masked.note).toBe('this text stays')
    expect((masked.nested as Record<string, unknown>).email).not.toContain('grace@example.com')
    expect((masked.list as Record<string, unknown>[])[0]?.email).not.toContain('alan@example.com')
    expect(result.notices.length).toBeGreaterThanOrEqual(5)
  })

  it('keeps a leading fragment so the value stays identifiable', () => {
    const masked = maskSensitiveFields({ email: 'grace@example.com' }).value as Record<
      string,
      unknown
    >
    expect(masked.email).toBe('gr••••••••••••')
  })

  it('fully redacts credential-shaped fields', () => {
    const masked = maskSensitiveFields({
      cardNumber: '4242424242424242',
      cvv: '123',
      otp: '987654',
      accessToken: 'sk-live-abcdef0123456789',
      password: 'hunter2',
    }).value as Record<string, unknown>

    expect(masked.cardNumber).toBe(REDACTED_LABEL)
    expect(masked.cvv).toBe(REDACTED_LABEL)
    expect(masked.otp).toBe(REDACTED_LABEL)
    expect(masked.accessToken).toBe(REDACTED_LABEL)
    expect(masked.password).toBe(REDACTED_LABEL)
  })

  it('withholds structured values instead of trying to stringify secrets', () => {
    const masked = maskSensitiveFields({
      paymentInstrument: { pan: '4242424242424242', cvv: '123' },
      rawForm: { cardNumber: '4242424242424242' },
    }).value as Record<string, unknown>

    expect(masked.paymentInstrument).toBe(REDACTED_LABEL)
    expect(masked.rawForm).toBe(REDACTED_LABEL)
  })

  it('treats a payload with no sensitive fields as unmasked', () => {
    const result = maskSensitiveFields({ page: '/rooms', key: 'deluxe', count: 3 })
    expect(result.masked).toBe(false)
    expect(result.notices).toEqual([])
    expect(result.value).toEqual({ page: '/rooms', key: 'deluxe', count: 3 })
  })

  it('does not confuse a feature flag with a credential', () => {
    // `integrationTokensEnabled` is a flag, not a token.
    const masked = maskSensitiveFields({ integrationTokensEnabled: true }).value as Record<
      string,
      unknown
    >
    expect(masked.integrationTokensEnabled).toBe(true)
  })

  it('honours an explicit preserve list for a reviewed field', () => {
    const masked = maskSensitiveFields(
      { email: 'ada@example.com', note: 'x' },
      { preserve: ['email'] },
    ).value as Record<string, unknown>
    expect(masked.email).toBe('ada@example.com')
  })

  it('honours an explicit rule over the default classification', () => {
    const masked = maskSensitiveFields(
      { phone: '+6281234567890' },
      { rules: [{ field: 'phone', strategy: 'preserve' }] },
    )
    expect((masked.value as Record<string, unknown>).phone).toBe('+6281234567890')
    expect(masked.masked).toBe(false)
  })

  it('tokenises when asked', () => {
    const masked = maskSensitiveFields(
      { email: 'grace@example.com' },
      { rules: [{ field: 'email', strategy: 'tokenise' }] },
    ).value as Record<string, unknown>
    expect(masked.email).toMatch(/^tok_[0-9a-f]{8}$/)
  })

  it('leaves null and undefined alone', () => {
    const masked = maskSensitiveFields({ email: null, phone: undefined }).value as Record<
      string,
      unknown
    >
    expect(masked.email).toBeNull()
    expect(masked.phone).toBeUndefined()
  })

  it('explains every field it withheld', () => {
    const result = maskSensitiveFields({ email: 'a@b.co', cvv: '111' })
    expect(result.notices.some((note) => note.includes('$.email'))).toBe(true)
    expect(result.notices.some((note) => note.includes('$.cvv'))).toBe(true)
    for (const note of result.notices) expect(note.length).toBeGreaterThan(0)
  })
})

describe('maskString', () => {
  it('masks by field name', () => {
    expect(maskString('grace@example.com', 'email').value).toBe('gr••••••••••••')
  })

  it('redacts when the field is unknown', () => {
    expect(maskString('opaque-value', 'unknownField').value).toBe(REDACTED_LABEL)
  })
})

describe('resolveMaskRules', () => {
  it('merges action-declared and client-declared sensitive fields', () => {
    const rules = resolveMaskRules(['customerPhone'], ['loyaltyId'])
    const fields = rules.map((rule) => rule.field)
    expect(fields).toContain('email')
    expect(fields).toContain('customerPhone')
    expect(fields).toContain('loyaltyId')
    expect(new Set(fields).size).toBe(fields.length)
  })
})

describe('baseline roles', () => {
  it('gives the assistant no admin resource access at all', () => {
    for (const resource of ADMIN_RESOURCES) {
      expect(roleCan('archava_assistant', resource, 'read')).toBe(false)
      expect(roleCan('archava_assistant', resource, 'write')).toBe(false)
      expect(roleCan('archava_assistant', resource, 'configure')).toBe(false)
    }
  })

  it('keeps write narrower than read for viewer and editor', () => {
    for (const role of ['viewer', 'editor'] as const) {
      expect(roleCan(role, 'analytics', 'read')).toBe(true)
      expect(roleCan(role, 'analytics', 'write')).toBe(false)
    }
    expect(roleCan('editor', 'knowledge', 'write')).toBe(true)
    expect(roleCan('editor', 'settings', 'read')).toBe(false)
  })

  it('keeps members and settings for the owner only', () => {
    for (const role of ['admin', 'editor', 'viewer'] as const) {
      expect(roleCan(role, 'members', 'write')).toBe(false)
      expect(roleCan(role, 'settings', 'write')).toBe(false)
    }
    expect(roleCan('owner', 'members', 'write')).toBe(true)
    expect(roleCan('owner', 'settings', 'configure')).toBe(true)
  })
})
