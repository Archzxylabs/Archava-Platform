import type {
  CapabilityTierName,
  DesignAddonName,
  EnvironmentName,
  PresenceTierName,
  RegionCode,
  SupportTierName,
} from '@archava/config'

/**
 * A complete, fully-specified quote request. Every field is required so the
 * engine can never silently fall back to a default tier or price.
 */
export interface QuoteRequest {
  readonly region: RegionCode
  readonly presence: PresenceTierName
  readonly capability: CapabilityTierName
  readonly environment: EnvironmentName
  readonly standardIntegrations: number
  readonly customIntegrations: number
  readonly advancedIntegrations: number
  readonly enterpriseIntegrations: number
  readonly designAddons: readonly DesignAddonName[]
  readonly support: SupportTierName
  /** Optional forecast of metered usage for the selected presence tier. */
  readonly usageForecast?: number
  /** Whether the client wants the annual-prepay recurring option shown. */
  readonly annualPrepay: boolean
}

export interface QuoteRequestInit {
  readonly region: RegionCode
  readonly presence: PresenceTierName
  readonly capability: CapabilityTierName
  readonly environment: EnvironmentName
  readonly standardIntegrations?: number
  readonly customIntegrations?: number
  readonly advancedIntegrations?: number
  readonly enterpriseIntegrations?: number
  readonly designAddons?: readonly DesignAddonName[]
  readonly support?: SupportTierName
  readonly usageForecast?: number
  readonly annualPrepay?: boolean
}

/** Integrations that are never covered by the capability allowance. */
export interface ChargeableIntegrations {
  readonly chargeableStandard: number
  readonly custom: number
  readonly advanced: number
  readonly enterprise: number
}
