import { describe, expect, it } from 'vitest'
import {
  PROVIDER_KINDS,
  ProviderRegistry,
  ProviderRegistryError,
  type ProviderDescriptor,
} from '../src/index.js'

function descriptor(overrides: Partial<ProviderDescriptor> = {}): ProviderDescriptor {
  return {
    kind: 'transport',
    providerId: 'transport-default',
    label: 'Default transport',
    endpoint: null,
    ...overrides,
  }
}

describe('ProviderRegistry', () => {
  it('resolves a provider it was given', () => {
    const registry = new ProviderRegistry([descriptor()])

    expect(registry.has('transport')).toBe(true)
    expect(registry.require('transport').providerId).toBe('transport-default')
    expect(registry.list()).toHaveLength(1)
  })

  it('refuses a second provider of the same kind', () => {
    const registry = new ProviderRegistry([descriptor()])

    // Two embodiments is not redundancy, it is ambiguity about which one renders.
    expect(() =>
      registry.register(descriptor({ kind: 'embodiment', providerId: 'a' })),
    ).not.toThrow()
    expect(() =>
      registry.register(descriptor({ kind: 'embodiment', providerId: 'b' })),
    ).toThrow(ProviderRegistryError)
  })

  it('fails closed when a kind was never installed', () => {
    const registry = new ProviderRegistry()

    // PRD §21: "Archava must remain usable" is served by falling back to a mode
    // we can run, never by carrying on with a null dependency.
    expect(() => registry.require('brain')).toThrow(ProviderRegistryError)
    expect(registry.tryGet('brain')).toBeNull()
  })

  it('requires a non-empty providerId and label', () => {
    expect(() => new ProviderRegistry([descriptor({ providerId: '' })])).toThrow(
      ProviderRegistryError,
    )
    expect(() => new ProviderRegistry([descriptor({ label: '' })])).toThrow(ProviderRegistryError)
  })

  it('rejects a kind it does not know', () => {
    expect(() =>
      new ProviderRegistry([descriptor({ kind: 'teleport' as ProviderDescriptor['kind'] })]),
    ).toThrow(ProviderRegistryError)
  })

  it('keeps registration order in list()', () => {
    const registry = new ProviderRegistry([
      descriptor({ kind: 'transport' }),
      descriptor({ kind: 'brain', providerId: 'brain-default' }),
      descriptor({ kind: 'embodiment', providerId: 'renderer-default' }),
    ])

    expect(registry.list().map((provider) => provider.kind)).toEqual([
      'transport',
      'brain',
      'embodiment',
    ])
  })

  it('knows the vendor-neutral kinds and nothing else', () => {
    expect(PROVIDER_KINDS).toEqual(['transport', 'brain', 'embodiment'])
  })
})
