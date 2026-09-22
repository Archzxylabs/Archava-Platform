import { z } from 'zod'

export const tenantIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'tenantId must be a lowercase kebab-case slug')

export interface TenantScope {
  readonly tenantId: string
}

export class TenantScopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TenantScopeError'
  }
}

/**
 * Assert that a value carries the required tenant.
 *
 * Cross-tenant access is a bug, not a recoverable error (PRD.md §15): any read
 * or write that crosses a tenant boundary throws rather than returning empty
 * or partial data.
 */
export function assertTenant<T extends TenantScope>(value: T | null | undefined, expectedTenantId: string): T {
  if (!value) {
    throw new TenantScopeError(`Missing tenant-scoped value; expected tenant "${expectedTenantId}".`)
  }
  if (value.tenantId !== expectedTenantId) {
    throw new TenantScopeError(
      `Tenant scope violation: encountered tenant "${value.tenantId}" while operating in tenant "${expectedTenantId}".`,
    )
  }
  return value
}

/** Brand a record as belonging to a tenant. */
export function scoped<T extends object>(
  tenantId: string,
  value: T,
): T & TenantScope {
  const parsed = tenantIdSchema.parse(tenantId)
  return { ...value, tenantId: parsed }
}
