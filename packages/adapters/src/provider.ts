/**
 * Provider ports and the registry that resolves them.
 *
 * PRD §21: presence is a replaceable adapter. The three seams a production
 * deployment needs are *transport* (how bytes reach the visitor), *brain* (which
 * model reasons over them), and *embodiment* (how the assistant is rendered).
 *
 * Two rules shape this file:
 *
 * 1. **Vendor names must not escape the adapter.** "Spatius must not be
 *    hardcoded outside the provider adapter." So this module knows `ProviderKind`
 *    — a vendor-neutral label — and nothing about which SDK implements it. A
 *    concrete adapter is registered by its own kind, and a caller that wants an
 *    embodiment never learns what is behind it.
 * 2. **Fail closed.** A missing provider is not a degraded mode, it is an error:
 *    the alternative is a chat interface that silently renders nothing.
 */

/** The kinds of external dependency Archava replaces. */
export const PROVIDER_KINDS = ['transport', 'brain', 'embodiment'] as const
export type ProviderKind = (typeof PROVIDER_KINDS)[number]

/** A provider as the platform sees it: an identity plus a description. */
export interface ProviderDescriptor {
  readonly kind: ProviderKind
  /**
   * Vendor-neutral identifier, e.g. `human-renderer`. Deliberately not a vendor
   * or product name: renaming a vendor is a data change inside one adapter, not
   * a change at every call site.
   */
  readonly providerId: string
  readonly label: string
  /** URI for the implementation, when it is a hosted service. Never a secret. */
  readonly endpoint: string | null
}

/** Health of one provider, as reported by the adapter itself. */
export interface ProviderHealth {
  readonly providerId: string
  readonly ready: boolean
  /** Present when `ready` is false; the reason a fallback would be chosen. */
  readonly reason: string | null
}

export class ProviderRegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderRegistryError'
  }
}

/**
 * In-memory registry of the providers a tenant has installed.
 *
 * Deliberately not a plugin system: there is no dynamic loading, no
 * authentication of provider code, and no filesystem scan. A provider is a value
 * the host constructs and hands in, which is the only shape that keeps "what
 * runs in this session" answerable from code.
 */
export class ProviderRegistry {
  private readonly providers = new Map<ProviderKind, ProviderDescriptor>()

  constructor(providers: readonly ProviderDescriptor[] = []) {
    for (const provider of providers) {
      this.register(provider)
    }
  }

  /** List the installed providers, in registration order. */
  list(): readonly ProviderDescriptor[] {
    return [...this.providers.values()]
  }

  register(provider: ProviderDescriptor): this {
    // One provider per kind is the whole point of "replaceable": two embodiments
    // is not redundancy, it is ambiguity about which one renders.
    if (this.providers.has(provider.kind)) {
      throw new ProviderRegistryError(
        `A ${provider.kind} provider is already registered (${this.providers.get(provider.kind)?.providerId}). ` +
          `Only one may be installed per kind; replace it instead of adding a second.`,
      )
    }
    validateDescriptor(provider)
    this.providers.set(provider.kind, provider)
    return this
  }

  has(kind: ProviderKind): boolean {
    return this.providers.has(kind)
  }

  /**
   * Resolve a provider, or throw. Fail-closed by design: PRD §21's "Archava must
   * remain usable" is served by falling back to a mode we *can* run, never by
   * carrying on with a null dependency.
   */
  require(kind: ProviderKind): ProviderDescriptor {
    const provider = this.providers.get(kind)
    if (!provider) {
      throw new ProviderRegistryError(`No ${kind} provider is registered for this tenant.`)
    }
    return provider
  }

  tryGet(kind: ProviderKind): ProviderDescriptor | null {
    return this.providers.get(kind) ?? null
  }
}

function validateDescriptor(provider: ProviderDescriptor): void {
  if (!PROVIDER_KINDS.includes(provider.kind)) {
    throw new ProviderRegistryError(`Unknown provider kind "${provider.kind}".`)
  }
  if (provider.providerId.length === 0 || provider.label.length === 0) {
    throw new ProviderRegistryError(
      `A ${provider.kind} provider needs a non-empty providerId and label.`,
    )
  }
}
