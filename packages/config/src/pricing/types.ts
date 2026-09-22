/** The two pricebooks are independent and must never be FX-converted. */
export const REGIONS = ['GLOBAL', 'ID'] as const
export type RegionCode = (typeof REGIONS)[number]

export const PRESENCE_TIERS = ['chat', 'voice', 'human'] as const
export type PresenceTierName = (typeof PRESENCE_TIERS)[number]

export const CAPABILITY_TIERS = ['assist', 'act', 'transact', 'enterprise'] as const
export type CapabilityTierName = (typeof CAPABILITY_TIERS)[number]

export const ENVIRONMENTS = [
  'existing_site',
  'landing',
  'business',
  'commerce_booking',
  'custom_web_app',
  'enterprise_system',
] as const
export type EnvironmentName = (typeof ENVIRONMENTS)[number]

export const INTEGRATION_COMPLEXITIES = ['standard', 'custom', 'advanced', 'enterprise'] as const
export type IntegrationComplexity = (typeof INTEGRATION_COMPLEXITIES)[number]

export const DESIGN_ADDONS = ['custom_visual_direction', 'advanced_motion_3d', 'premium_avatar_provider'] as const
export type DesignAddonName = (typeof DESIGN_ADDONS)[number]

export const SUPPORT_TIERS = ['standard', 'priority', 'dedicated_sla'] as const
export type SupportTierName = (typeof SUPPORT_TIERS)[number]

/**
 * Which core components actually carry a fixed (non-zero) price and therefore
 * count toward the bundle discount. `presence` always counts.
 */
export type PaidCoreComponent = 'presence' | 'environment_paid' | 'capability_paid'

export interface PriceLine {
  readonly kind: 'fixed' | 'from' | 'custom'
  readonly setup?: number
  readonly monthly?: number
}

/** Resolve a pricebook line into the engine's internal representation. */
export function classifyLine(line: unknown): PriceLine {
  if (line === null || typeof line !== 'object') {
    return { kind: 'custom' }
  }
  const record = line as Record<string, unknown>
  if (record.custom === true) return { kind: 'custom' }
  if (typeof record.setup_from === 'number') {
    return {
      kind: 'from',
      setup: record.setup_from,
      monthly: typeof record.monthly === 'number' ? record.monthly : undefined,
    }
  }
  if (typeof record.setup === 'number') {
    return {
      kind: 'fixed',
      setup: record.setup,
      monthly: typeof record.monthly === 'number' ? record.monthly : undefined,
    }
  }
  if (typeof record.monthly === 'number') {
    return { kind: 'fixed', setup: 0, monthly: record.monthly }
  }
  return { kind: 'custom' }
}
