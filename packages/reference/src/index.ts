/**
 * The reference dataset, in one import.
 *
 * A caller wants a tenant, not four modules. Anything that needs the demo's
 * shared fixture — the vertical slice, the configurator's default output, a
 * test asserting the arc end to end — takes it from here, so there is exactly
 * one place the dataset is defined and exactly one way to reach it.
 *
 * Every value re-exported below is the product of a real parser: the config
 * came out of `parseClientConfig`, the units out of `entitySchema`, the
 * knowledge out of `knowledgeSourceSchema`. Nothing here is a hand-written
 * stand-in for those shapes, which is what keeps a schema change from
 * silently invalidating the demo.
 */

export * from './tenant.js'
export * from './units.js'
export * from './rates.js'
export * from './knowledge.js'
