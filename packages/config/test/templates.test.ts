import { describe, expect, it } from 'vitest'
import { TemplateRegistry, loadTemplates } from '../src/templates/loader.js'

const registry = new TemplateRegistry()

describe('template registry', () => {
  it('loads all eight published templates', () => {
    const names = registry.listNames()
    expect(names).toHaveLength(8)
    for (const name of [
      'generic_business',
      'hospitality',
      'restaurant',
      'clinic',
      'real_estate',
      'ecommerce',
      'professional_services',
      'education',
    ]) {
      expect(registry.has(name)).toBe(true)
    }
  })

  it('returns a template with default environment, presence and capability', () => {
    const template = registry.get('generic_business')
    expect(template.default_environment).toBe('business')
    expect(template.recommended_presence).toBe('voice')
    expect(template.recommended_capability).toBe('act')
  })

  it('throws on an unknown template instead of falling back', () => {
    expect(() => registry.get('hotel_bali_custom')).toThrowError(/Unknown template/)
  })

  it('validates the effective date format', () => {
    expect(registry.effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('exposes definitions used for documentation and the configurator', () => {
    expect(Object.keys(registry.environmentDefinitions)).toContain('commerce_booking')
    expect(Object.keys(registry.presenceDefinitions)).toContain('human')
    expect(Object.keys(registry.capabilityDefinitions)).toContain('transact')
  })

  it('is reusable without touching disk', () => {
    const catalog = loadTemplates()
    const second = new TemplateRegistry(catalog)
    expect(second.listNames()).toEqual(registry.listNames())
  })
})
