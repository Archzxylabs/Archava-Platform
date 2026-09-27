import { describe, expect, it } from 'vitest'
import { safeParseClientConfig, type ClientConfig } from '../src/index.js'

/**
 * Decision Intelligence is additive configuration for a bounded advisory seam.
 * These tests exist to keep it that way: a tenant that says nothing about it
 * keeps Foundation V1.1 exactly, and a tenant that does say something has every
 * mode, provider and task threshold checked loudly instead of being silently
 * defaulted, because a wrong threshold would let an advisory judgement decide
 * something it must not decide.
 */

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

/** The reference implementation's tenant, key for key. */
function referenceConfig(): Record<string, unknown> {
  return {
    schema_version: '1.0.0',
    tenantId: 'client-xyz',
    environment: 'commerce_booking',
    presence: 'chat',
    capability: 'act',
    region: 'ID',
    template: 'hospitality',
    branding: {
      businessName: 'Client XYZ',
      tagline: 'Stay somewhere worth writing home about.',
      theme: {
        accent: '#1f6f5c',
        surface: '#fbf9f4',
        ink: '#1b1b1b',
        radius: 'rounded',
        fontFamily: 'Fraunces, serif',
      },
      logo: '/logo.svg',
    },
    languages: [{ code: 'id', label: 'Bahasa Indonesia', fallback: 'en' }],
    primaryLanguage: 'id',
    updatedAt: '2026-09-22',
    isReferenceImplementation: true,
    support: 'priority',
    designAddons: [],
    allowedOrigins: [],
    integrations: [],
    modules: [],
    entities: [],
    knowledgeSources: [],
  }
}

/**
 * What `tryEmitClientConfig` builds, key for key. Copied rather than imported so
 * this package never depends on the configurator: the shape it emits carries no
 * `decision` key at all, which is exactly the Foundation default, and that is
 * the claim under test.
 */
function configuratorConfig(): Record<string, unknown> {
  return {
    schema_version: '1.0.0',
    tenantId: 'emitted-tenant',
    environment: 'landing',
    presence: 'chat',
    capability: 'assist',
    region: 'GLOBAL',
    template: 'hospitality',
    branding: {
      businessName: 'Emitted Tenant',
      theme: {
        accent: '#334455',
        surface: '#ffffff',
        ink: '#111111',
        radius: 'soft',
        fontFamily: 'Inter',
      },
    },
    languages: [{ code: 'en', label: 'English' }],
    primaryLanguage: 'en',
    integrations: [],
    support: 'standard',
    designAddons: [],
    modules: [],
    entities: [],
    knowledgeSources: [],
    allowedOrigins: [],
    updatedAt: '2026-04-01',
    isReferenceImplementation: false,
  }
}

function parsed(overrides: Record<string, unknown>): ClientConfig {
  const result = safeParseClientConfig(baseConfig(overrides))
  expect(result.success).toBe(true)
  if (!result.success) throw new Error(`expected a valid config: ${result.issues.join('; ')}`)
  return result.data
}

describe('Decision Intelligence in clientConfigSchema', () => {
  it('is absent from an existing config, leaving Foundation V1.1 behaviour', () => {
    const result = safeParseClientConfig(baseConfig())

    expect(result.success).toBe(true)
    if (!result.success) return
    // Not merely defaulted: the key is not there, so a config written before the
    // Decision Layer existed parses to the same object it always did.
    expect('decision' in result.data).toBe(false)
    expect(result.data.decision).toBeUndefined()
  })

  it('leaves the reference implementation config unchanged', () => {
    const result = safeParseClientConfig(referenceConfig())

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.decision).toBeUndefined()
    expect(result.data.tenantId).toBe('client-xyz')
    expect(result.data.capability).toBe('act')
    expect(result.data.presence).toBe('chat')
    expect(result.data.isReferenceImplementation).toBe(true)
    expect(result.data.support).toBe('priority')
  })

  it('leaves a configurator-emitted config unchanged', () => {
    const result = safeParseClientConfig(configuratorConfig())

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.decision).toBeUndefined()
    expect(result.data.isReferenceImplementation).toBe(false)
    expect('decision' in result.data).toBe(false)
  })

  it('accepts an explicit off without a provider', () => {
    expect(parsed({ decision: { mode: 'off' } }).decision).toEqual({ mode: 'off', tasks: {} })
  })

  it('accepts shadow and assist with a provider', () => {
    const decision = {
      mode: 'assist',
      provider: 'deterministic-rule',
      tasks: {
        intent_classification: { enabled: true, minConfidence: 0.75 },
        knowledge_routing: { enabled: true, minConfidence: 0.9 },
        clarification: { enabled: false, minConfidence: 0.5 },
        handoff_recommendation: { enabled: true, minConfidence: 0.8 },
        evidence_sufficiency: { enabled: false, minConfidence: 0.6 },
      },
    }

    expect(parsed({ decision }).decision).toEqual(decision)
    expect(
      parsed({ decision: { mode: 'shadow', provider: 'deterministic-rule' } }).decision,
    ).toEqual({ mode: 'shadow', provider: 'deterministic-rule', tasks: {} })
  })

  it('keeps per-task policies independent of each other', () => {
    const config = parsed({
      decision: {
        mode: 'assist',
        provider: 'deterministic-rule',
        tasks: { knowledge_routing: { enabled: true, minConfidence: 0.95 } },
      },
    })

    // There is no global threshold to inherit from, and no other task is
    // switched on by having been left out.
    expect(config.decision?.tasks.knowledge_routing).toEqual({ enabled: true, minConfidence: 0.95 })
    expect(config.decision?.tasks.intent_classification).toBeUndefined()
  })

  it('rejects an unknown mode with the field named in the issue', () => {
    const result = safeParseClientConfig(baseConfig({ decision: { mode: 'auto' } }))

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.issues).toEqual([
      'decision.mode: Invalid option: expected one of "off"|"shadow"|"assist"',
    ])
  })

  it('requires a provider once the layer is allowed to act', () => {
    for (const mode of ['shadow', 'assist']) {
      const result = safeParseClientConfig(baseConfig({ decision: { mode } }))

      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.issues.join(' ')).toContain('a provider is required unless mode is "off"')
    }
  })

  it('rejects a provider that is not a kebab-case slug', () => {
    for (const provider of ['', 'Jev', 'jev 2', 'jev_2', 'Jev-Provider']) {
      const result = safeParseClientConfig(baseConfig({ decision: { mode: 'shadow', provider } }))

      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.issues.join(' ')).toMatch(/decision\.provider/)
    }
  })

  it('rejects an unknown task id instead of ignoring it', () => {
    const result = safeParseClientConfig(
      baseConfig({
        decision: {
          mode: 'assist',
          provider: 'deterministic-rule',
          tasks: { tone_classification: { enabled: true, minConfidence: 0.5 } },
        },
      }),
    )

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.issues.join(' ')).toMatch(/tone_classification/)
  })

  it('rejects a confidence threshold outside [0, 1] or not a number', () => {
    for (const minConfidence of [-0.1, 1.01, 2, '0.9', true]) {
      const result = safeParseClientConfig(
        baseConfig({
          decision: {
            mode: 'assist',
            provider: 'deterministic-rule',
            tasks: { clarification: { enabled: true, minConfidence } },
          },
        }),
      )

      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.issues.join(' ')).toMatch(/decision\.tasks\.clarification\.minConfidence/)
    }
  })

  it('requires an explicit enabled and minConfidence for a declared task', () => {
    for (const task of [{ enabled: true }, { minConfidence: 0.5 }]) {
      const result = safeParseClientConfig(
        baseConfig({
          decision: {
            mode: 'assist',
            provider: 'deterministic-rule',
            tasks: { clarification: task },
          },
        }),
      )

      expect(result.success).toBe(false)
    }
  })

  it('rejects unknown keys inside the decision block', () => {
    const result = safeParseClientConfig(
      baseConfig({ decision: { mode: 'off', pricing: { monthly: 100 } } }),
    )

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.issues.join(' ')).toMatch(/pricing/)
  })

  it('does not touch pricing, presence or capability', () => {
    const control = parsed({})
    const withDecision = parsed({ decision: { mode: 'off' } })

    // The field is additive: everything the quote and the permission model read
    // is untouched by the Decision Layer's presence or absence.
    for (const key of [
      'presence',
      'capability',
      'environment',
      'region',
      'support',
      'template',
      'integrations',
      'modules',
      'entities',
      'knowledgeSources',
      'designAddons',
      'allowedOrigins',
    ] as const) {
      expect(withDecision[key]).toEqual(control[key])
    }
    // And the decision block is not a place a price may be smuggled in.
    expect(Object.keys(withDecision.decision ?? {})).toEqual(['mode', 'tasks'])
  })
})
