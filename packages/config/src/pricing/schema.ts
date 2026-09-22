import { z } from 'zod'

/**
 * Authoritative schema for `config/pricing.v1.json`.
 *
 * This file is a *validator*, never a source of prices. Any price that is not
 * representable by this schema cannot exist in the pricebook, so a parse
 * failure is a hard error — the caller must fail closed rather than guess.
 */

const currencyCode = z.enum(['USD', 'IDR'])

const moneyLineBase = z.object({
  setup: z.number().nonnegative().optional(),
  monthly: z.number().nonnegative().optional(),
})

/** A fixed-price line: exact `setup` (and possibly `monthly`). */
const fixedMoneyLineSchema = moneyLineBase.extend({
  setup: z.number().nonnegative(),
})

/** A "from" line: minimum `setup` only, never a final guaranteed price. */
const fromMoneyLineSchema = z.object({
  setup_from: z.number().nonnegative(),
  monthly: z.number().nonnegative().optional(),
})

/** A bespoke line: no number at all, must be scoped by a human. */
const customMoneyLineSchema = z.object({
  custom: z.literal(true),
})

const usageAllowanceSchema = z.object({
  unit: z.string().min(1),
  quantity: z.number().nonnegative(),
})

const overageSchema = z.object({
  unit: z.string().min(1),
  price: z.number().nonnegative(),
})

const presenceTierSchema = z.object({
  setup: z.number().nonnegative(),
  monthly: z.number().nonnegative(),
  included_usage: usageAllowanceSchema,
  overage: overageSchema,
})

const capabilityTierSchema = z.union([
  z.object({
    setup: z.number().nonnegative(),
    monthly: z.number().nonnegative(),
    included_standard_integrations: z.number().int().nonnegative(),
  }),
  customMoneyLineSchema,
])

const environmentTierSchema = z.union([
  z.object({
    setup: z.number().nonnegative(),
    monthly: z.number().nonnegative(),
    note: z.string().optional(),
  }),
  fromMoneyLineSchema,
  customMoneyLineSchema,
])

const integrationTierSchema = z.union([
  fixedMoneyLineSchema,
  fromMoneyLineSchema,
  customMoneyLineSchema,
])

const designAddonSchema = z.union([
  fixedMoneyLineSchema,
  fromMoneyLineSchema,
  customMoneyLineSchema,
])

const supportAddonSchema = z.union([
  z.object({ monthly: z.number().nonnegative() }),
  customMoneyLineSchema,
])

export const regionSchema = z.object({
  currency: currencyCode,
  label: z.string().min(1),
  presence: z.object({
    chat: presenceTierSchema,
    voice: presenceTierSchema,
    human: presenceTierSchema,
  }),
  capability: z.object({
    assist: capabilityTierSchema,
    act: capabilityTierSchema,
    transact: capabilityTierSchema,
    enterprise: capabilityTierSchema,
  }),
  environment: z.object({
    existing_site: environmentTierSchema,
    landing: environmentTierSchema,
    business: environmentTierSchema,
    commerce_booking: environmentTierSchema,
    custom_web_app: environmentTierSchema,
    enterprise_system: environmentTierSchema,
  }),
  integration: z.object({
    standard: integrationTierSchema,
    custom: integrationTierSchema,
    advanced: integrationTierSchema,
    enterprise: integrationTierSchema,
  }),
  design_addons: z.object({
    custom_visual_direction: designAddonSchema,
    advanced_motion_3d: designAddonSchema,
    premium_avatar_provider: designAddonSchema,
  }),
  support_addons: z.object({
    standard: supportAddonSchema,
    priority: supportAddonSchema,
    dedicated_sla: supportAddonSchema,
  }),
})

export const pricebookSchema = z.object({
  schema_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  effective_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'effective_date must be an ISO YYYY-MM-DD date'),
  currency_rounding: z.object({
    GLOBAL: z.number().positive(),
    ID: z.number().positive(),
  }),
  tax_policy: z.string().min(1),
  regions: z.object({
    GLOBAL: regionSchema,
    ID: regionSchema,
  }),
  discount_rules: z.object({
    two_core_components_setup_discount_pct: z.number().nonnegative().max(100),
    three_core_components_setup_discount_pct: z.number().nonnegative().max(100),
    core_components: z.array(z.enum(['presence', 'environment_paid', 'capability_paid'])).min(1),
    annual_recurring_prepay_discount_pct: z.number().nonnegative().max(100),
    discount_exclusions: z.array(z.string()),
    agent_max_discretionary_discount_pct: z.literal(0),
    human_approval_floor_pct_of_list_setup: z.number().positive().max(100),
    rule: z.string().min(1),
  }),
  usage_definitions: z.record(z.string().min(1), z.string().min(1)),
  commercial_rules: z.object({
    presence_setup_includes: z.array(z.string()).min(1),
    assist_includes: z.array(z.string()).min(1),
    act_includes: z.array(z.string()).min(1),
    transact_includes: z.array(z.string()).min(1),
    standard_integration_examples: z.array(z.string()).min(1),
    custom_integration_definition: z.string().min(1),
    advanced_integration_definition: z.string().min(1),
    third_party_fees: z.string().min(1),
    regional_pricebook_rule: z.string().min(1),
    quote_validity_days: z.number().int().positive(),
  }),
})

export type Pricebook = z.infer<typeof pricebookSchema>
export type Region = z.infer<typeof regionSchema>
export type PresenceTier = z.infer<typeof presenceTierSchema>
export type CapabilityTier = z.infer<typeof capabilityTierSchema>
export type EnvironmentTier = z.infer<typeof environmentTierSchema>
export type IntegrationTier = z.infer<typeof integrationTierSchema>
