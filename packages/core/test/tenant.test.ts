import { describe, expect, it } from 'vitest'
import { assertTenant, scoped, TenantScopeError, tenantIdSchema } from '../src/index.js'

describe('tenantIdSchema', () => {
  it('accepts a kebab-case slug', () => {
    expect(tenantIdSchema.parse('acme-hotels')).toBe('acme-hotels')
    expect(tenantIdSchema.parse('t1')).toBe('t1')
    expect(tenantIdSchema.parse('a-b-c-7')).toBe('a-b-c-7')
  })

  it('rejects ids that would let a boundary blur', () => {
    for (const id of [
      'Acme Hotels',
      'acme_hotels',
      'acme.hotels',
      '-acme',
      'acme-',
      'acme--hotels',
      '',
    ]) {
      expect(() => tenantIdSchema.parse(id)).toThrow()
    }
  })
})

describe('assertTenant', () => {
  it('returns the value once it is confirmed to belong to the tenant', () => {
    const record = { tenantId: 'acme-hotels', id: 'checkin-policy' }
    expect(assertTenant(record, 'acme-hotels')).toBe(record)
  })

  it('throws on a cross-tenant read rather than returning the value', () => {
    expect(() => assertTenant({ tenantId: 'other-hotel', id: 'x' }, 'acme-hotels')).toThrow(
      TenantScopeError,
    )
    expect(() => assertTenant({ tenantId: 'other-hotel', id: 'x' }, 'acme-hotels')).toThrow(
      /scope violation/,
    )
  })

  it('distinguishes "missing" from "not yours" in the message', () => {
    // A missing record and a foreign record are different facts; collapsing them
    // into one message would send a reader hunting for the wrong bug.
    expect(() => assertTenant(null, 'acme-hotels')).toThrow(/Missing tenant-scoped value/)
    expect(() => assertTenant(undefined, 'acme-hotels')).toThrow(/Missing tenant-scoped value/)
    expect(() => assertTenant({ tenantId: 'other-hotel' }, 'acme-hotels')).toThrow(
      /while operating in tenant "acme-hotels"/,
    )
  })

  it('names both tenants in a violation so the log is readable', () => {
    const attempt = () => assertTenant({ tenantId: 'other-hotel' }, 'acme-hotels')
    expect(attempt).toThrow(/other-hotel/)
    expect(attempt).toThrow(/acme-hotels/)
  })
})

describe('scoped', () => {
  it('stamps a tenant onto a plain record without mutating it', () => {
    const base = { id: 'checkin-policy', title: 'Check-in' }
    const result = scoped('acme-hotels', base)

    expect(result).toEqual({ ...base, tenantId: 'acme-hotels' })
    expect(base).not.toHaveProperty('tenantId')
  })

  it('refuses an unslugged tenant id rather than stamping it', () => {
    expect(() => scoped('Acme Hotels', { id: 'x' })).toThrow()
    expect(() => scoped('', { id: 'x' })).toThrow()
  })
})
