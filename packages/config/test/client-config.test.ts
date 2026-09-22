import { describe, expect, it } from 'vitest'
import {
  ClientConfigError,
  ClientConfigResolver,
  safeParseClientConfig,
  type ClientConfig,
} from '../src/index.js'

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: '1.0.0',
    tenantId: 'acme-hotels',
    environment: 'commerce_booking',
    presence: 'chat',
    capability: 'transact',
    region: 'ID',
    template: 'hospitality',
    branding: {
      businessName: 'Acme Hotels',
      theme: {
        accent: '#123456',
        surface: '#ffffff',
        ink: '#101010',
        radius: 'rounded',
        fontFamily: 'Inter',
      },
    },
    languages: [{ code: 'id', label: 'Bahasa Indonesia' }],
    primaryLanguage: 'id',
    updatedAt: '2026-04-01',
    ...overrides,
  }
}

describe('clientConfigSchema', () => {
  it('accepts a complete reference config and fills defaults', () => {
    const result = safeParseClientConfig(baseConfig())

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.support).toBe('standard')
    expect(result.data.isReferenceImplementation).toBe(false)
    expect(result.data.integrations).toEqual([])
    expect(result.data.modules).toEqual([])
    expect(result.data.entities).toEqual([])
  })

  it('rejects unknown keys instead of ignoring them', () => {
    // Every field here feeds pricing, capability and permission decisions, so a
    // silently dropped key would be a silently wrong quote.
    const result = safeParseClientConfig(baseConfig({ sneaky_field: 1 }))
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.issues.join(' ')).toMatch(/sneaky_field/i)
  })

  it('requires a kebab-case tenant slug', () => {
    for (const tenantId of ['Acme Hotels', 'acme_hotels', '-acme', 'acme-', '']) {
      expect(safeParseClientConfig(baseConfig({ tenantId })).success).toBe(false)
    }
  })

  it('requires semver schema_version and ISO updatedAt', () => {
    expect(safeParseClientConfig(baseConfig({ schema_version: '1.0' })).success).toBe(false)
    expect(safeParseClientConfig(baseConfig({ updatedAt: '01/04/2026' })).success).toBe(false)
  })

  it('requires at least one language and a non-empty primary language', () => {
    expect(safeParseClientConfig(baseConfig({ languages: [] })).success).toBe(false)
    expect(safeParseClientConfig(baseConfig({ primaryLanguage: '' })).success).toBe(false)
  })

  it('accepts only absolute or wildcard embed origins', () => {
    expect(safeParseClientConfig(baseConfig({ allowedOrigins: ['*'] })).success).toBe(true)
    expect(
      safeParseClientConfig(baseConfig({ allowedOrigins: ['https://shop.acme.test'] })).success,
    ).toBe(true)

    for (const origin of ['shop.acme.test', 'javascript:alert(1)', '/relative']) {
      expect(safeParseClientConfig(baseConfig({ allowedOrigins: [origin] })).success).toBe(false)
    }
  })

  it('defaults integration.enabled to true', () => {
    const result = safeParseClientConfig(
      baseConfig({ integrations: [{ name: 'Pipedrive', complexity: 'standard' }] }),
    )
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.integrations[0]).toMatchObject({ enabled: true, complexity: 'standard' })
  })

  it('allows only scalar attributes on an entity', () => {
    const scalars = safeParseClientConfig(
      baseConfig({
        entities: [
          { id: 'suite-1', kind: 'product', name: 'Suite', summary: 'x', attributes: { rate: 900 } },
        ],
      }),
    )
    expect(scalars.success).toBe(true)

    // Attributes feed the live-answer surface (§17); a nested object there
    // would smuggle structure the schema has no rules for.
    const nested = safeParseClientConfig(
      baseConfig({
        entities: [
          { id: 'suite-1', kind: 'product', name: 'Suite', summary: 'x', attributes: { rate: { v: 9 } } },
        ],
      }),
    )
    expect(nested.success).toBe(false)
  })

  it('validates knowledge sources as authored content, not fetched URLs', () => {
    const good = safeParseClientConfig(
      baseConfig({
        knowledgeSources: [
          {
            id: 'faq-1',
            kind: 'faq',
            title: 'FAQ',
            content: 'Check-in at 15:00.',
            updatedAt: '2026-04-01',
          },
        ],
      }),
    )
    expect(good.success).toBe(true)

    expect(
      safeParseClientConfig(
        baseConfig({
          knowledgeSources: [
            { id: 'faq-1', kind: 'faq', title: 'FAQ', content: 'x', updatedAt: 'yesterday' },
          ],
        }),
      ).success,
    ).toBe(false)
  })
})

describe('ClientConfigResolver', () => {
  const resolver = new ClientConfigResolver()

  function resolve(overrides: Record<string, unknown> = {}): ClientConfig {
    const parsed = safeParseClientConfig(baseConfig(overrides))
    if (!parsed.success) throw new Error(`fixture rejected: ${parsed.issues.join('; ')}`)
    return resolver.resolve(parsed.data)
  }

  it('throws for an unknown template and lists what does exist', () => {
    expect(() => resolve({ template: 'space_station' })).toThrow(ClientConfigError)
    expect(() => resolve({ template: 'space_station' })).toThrow(/hospitality/)
  })

  it('merges template modules as enabled defaults', () => {
    const config = resolve()
    // The hospitality vocabulary, in the order the template declares it.
    expect(resolver.enabledModules(config)).toEqual([
      'knowledge',
      'page_awareness',
      'recommendations',
      'availability',
      'booking',
      'transactional_email',
      'handoff',
      'analytics',
    ])
  })

  it('lets an explicit client toggle beat the template default', () => {
    const config = resolve({ modules: [{ name: 'analytics', enabled: false }] })
    expect(resolver.enabledModules(config)).not.toContain('analytics')
    // A disabled template module stays visible, it is not silently deleted.
    expect(config.modules.find((module) => module.name === 'analytics')).toEqual({
      name: 'analytics',
      enabled: false,
    })
  })

  it('keeps client-only modules after the template vocabulary', () => {
    const config = resolve({ modules: [{ name: 'loyalty_ledger', enabled: true }] })
    expect(resolver.enabledModules(config)).toContain('loyalty_ledger')
    expect(config.modules[config.modules.length - 1]).toEqual({
      name: 'loyalty_ledger',
      enabled: true,
    })
  })

  it('adds template common integrations as standard, never duplicating a named one', () => {
    // `Postmark` is in hospitality's `common_integrations`, so the client's
    // declaration must replace the template's assumption rather than sit
    // alongside it.
    const config = resolve({
      integrations: [{ name: 'Postmark', complexity: 'enterprise', enabled: true }],
    })

    const postmark = config.integrations.filter((integration) => integration.name === 'Postmark')
    expect(postmark).toHaveLength(1)
    // The client's declared complexity wins over the template's assumption.
    expect(postmark[0]?.complexity).toBe('enterprise')

    // The other template integrations still arrive as enabled standard defaults.
    expect(config.integrations).toContainEqual({
      name: 'Midtrans-or-Stripe',
      complexity: 'standard',
      enabled: true,
    })
    expect(config.integrations).toContainEqual({
      name: 'PMS-or-booking-engine',
      complexity: 'standard',
      enabled: true,
    })
  })

  it('places client integrations after the template-derived ones', () => {
    // Three template integrations plus the client's own.
    const config = resolve({ integrations: [{ name: 'Stripe', complexity: 'standard' }] })
    expect(config.integrations.map((integration) => integration.name)).toEqual([
      'PMS-or-booking-engine',
      'Postmark',
      'Midtrans-or-Stripe',
      'Stripe',
    ])
  })

  it('does not override an explicitly chosen environment with the template default', () => {
    // Precedence is one-directional: client > template > nothing.
    expect(resolve({ environment: 'existing_site' }).environment).toBe('existing_site')
  })

  it('only reports enabled integrations and visible entities', () => {
    const config = resolve({
      integrations: [
        { name: 'Stripe', complexity: 'standard', enabled: true },
        { name: 'Legacy ERP', complexity: 'custom', enabled: false },
      ],
      entities: [
        { id: 'suite-1', kind: 'product', name: 'Suite', summary: 'x', visible: true },
        { id: 'suite-2', kind: 'product', name: 'Hidden', summary: 'x', visible: false },
      ],
    })

    // Template integrations are merged in as enabled, so they survive; the
    // client's own disabled line is the one that must be dropped.
    expect(resolver.enabledIntegrations(config).map((integration) => integration.name)).toEqual([
      'PMS-or-booking-engine',
      'Postmark',
      'Midtrans-or-Stripe',
      'Stripe',
    ])
    expect(resolver.enabledEntities(config).map((entity) => entity.id)).toEqual(['suite-1'])

    // A client can also switch off a template integration, and that is honoured.
    const withoutPms = resolve({
      integrations: [{ name: 'PMS-or-booking-engine', complexity: 'standard', enabled: false }],
    })
    expect(
      resolver.enabledIntegrations(withoutPms).map((integration) => integration.name),
    ).not.toContain('PMS-or-booking-engine')
  })
})
