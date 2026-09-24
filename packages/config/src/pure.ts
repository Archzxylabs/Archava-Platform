/**
 * The half of `@archava/config` a browser can run.
 *
 * The root barrel (`./index.js`) also exports `loadPricebook`, `loadTemplates`
 * and `ClientConfigResolver`, and all three reach the filesystem — the resolver
 * has a `TemplateRegistry` that reads the catalog by default. A bundle for the
 * browser cannot carry `node:fs` at all — the bundler fails rather than shimming
 * it — so importing the barrel into a client is how a page turns into a build
 * error.
 *
 * This entry point is the same schemas and vocabulary without those three.
 * Everything a browser actually touches is here: parse a config, validate a
 * pricebook that arrived over the wire, read the tier vocabularies, classify a
 * price line. Everything that needs a disk does not belong in a tab, and its
 * absence is the point rather than an omission: a client that could read files
 * would be a client that could read someone else's.
 *
 * It is a separate entry rather than a flag on the barrel because a runtime flag
 * cannot help here — the import graph is resolved before any code runs, so by
 * the time a flag could say "no filesystem", `node:fs` is already being bundled.
 *
 * What is *not* here, and why: nothing that mutates, and nothing that resolves a
 * template. Both loaders are pure readers, so dropping them costs a browser
 * nothing it had; and template resolution needs a resolved catalog on disk, which
 * is the server's job to have already done before it answers a client.
 */

export {
  clientConfigSchema,
  safeParseClientConfig,
  parseClientConfig,
  type ClientConfig,
  type Integration,
  type ModuleToggle,
  type Entity,
  type KnowledgeSource,
  type Language,
  type Branding,
  type Presence,
  type Capability,
  type Environment,
  type Region,
} from './client/schema.js'

export {
  pricebookSchema,
  type Pricebook,
  type Region as PricebookRegion,
} from './pricing/schema.js'

export { templatesSchema, type Template, type TemplateCatalog } from './templates/schema.js'

export {
  REGIONS,
  PRESENCE_TIERS,
  CAPABILITY_TIERS,
  ENVIRONMENTS,
  INTEGRATION_COMPLEXITIES,
  DESIGN_ADDONS,
  SUPPORT_TIERS,
  type RegionCode,
  type PresenceTierName,
  type CapabilityTierName,
  type EnvironmentName,
  type IntegrationComplexity,
  type DesignAddonName,
  type SupportTierName,
  type PaidCoreComponent,
  classifyLine,
  type PriceLine,
} from './pricing/types.js'
