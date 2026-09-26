/**
 * `Archava.init` — the host-facing door.
 *
 * PRD §24 shows the shape the host writes:
 *
 * ```html
 * <script src="https://cdn.archava.example/sdk.js"></script>
 * <script>Archava.init({ clientId: "client_xyz" })</script>
 * ```
 *
 * One line, and the site is page-aware. Everything the host would otherwise have
 * to remember — consent first, event log, masking, no server keys — is inside
 * `createSession`, which this file only reaches through.
 *
 * Three things this file deliberately does *not* do:
 *
 * - **It holds no key.** `clientId` scopes a corpus; it authorises nothing. The
 *   secret that talks to a provider stays on the server (§24).
 * - **It does not decide consent.** `grant`/`revoke` are the host's verbs; the
 *   gate inside the session is what enforces them.
 * - **It has no clock of its own.** `now` arrives from the host, so a turn
 *   replayed later carries the times it actually happened.
 */

import type { ClientConfig } from '@archava/config'
import type { ContextEvent, ContextGraph } from '@archava/core'
import type { ConsentDomain, ConsentState } from './consent.js'
import { grantConsent, parseConsent, revokeConsent } from './consent.js'
import { DEFAULT_SELECTORS, readDom, type ScoutDocument, type ScoutSelectors } from './dom.js'
import { SdkConfigError } from './errors.js'
import { createSession, type SdkSession } from './session.js'

/**
 * What a host hands `init`.
 *
 * `clientId` is the tenant this page belongs to. It is a scope, not a secret —
 * the name matches §24's snippet, and the note is here because the first
 * question every integrator asks is whether pasting it into HTML leaks
 * something. It does not: every read it scopes is still authorised server-side.
 */
export interface ArchavaInit {
  /** The tenant this page belongs to. Not secret — it scopes, it does not authorise. */
  readonly clientId: string
  /** The resolved client config, when the host has one. */
  readonly config?: ClientConfig
  /** The route to start on. Defaults to `/`. */
  readonly route?: string
  /** The visitor's recorded consent, by domain. Absent means refused. */
  readonly consent?: Partial<Record<ConsentDomain, boolean>>
  /** Extra field names the tenant considers sensitive, beyond the defaults. */
  readonly sensitiveFields?: readonly string[]
  /** The DOM to read. Defaults to the host's own `document`. */
  readonly document?: ScoutDocument | null
  /** Selectors for the scout. Defaults to `DEFAULT_SELECTORS`. */
  readonly selectors?: ScoutSelectors
  /** A timestamp for `occurredAt`. Defaults to the host clock, in ISO form. */
  readonly now?: () => string
  /** Where analytics go. Called only when `analytics` consent is in force (§27). */
  readonly onAnalytics?: (event: ArchavaAnalyticsEvent) => void
  /** Told whenever the consent state changes, so a host can re-render its banner. */
  readonly onConsentChange?: (state: ConsentState) => void
}

/** One analytics record. Carries graph shape, never a form value (§16, §27). */
export interface ArchavaAnalyticsEvent {
  readonly name: string
  readonly clientId: string
  readonly route: string
  readonly graph: ContextGraph
  readonly at: string
}

/** The handle a host keeps. Everything it is allowed to do is here. */
export interface Archava {
  /** The tenant this instance is scoped to. */
  readonly clientId: string
  /** The session underneath, for hosts that want it directly. */
  readonly session: SdkSession
  /** The graph as it stands, with sensitive field names masked (§16). */
  graph(): ContextGraph
  /** Read the DOM and apply whatever changed. Returns the events that described a change. */
  observe(): readonly ContextEvent[]
  /** The events that produced the graph, in the order they were applied. */
  history(): readonly ContextEvent[]
  /** The consent currently in force. */
  consent(): ConsentState
  /** Grant one domain. */
  grant(domain: ConsentDomain): ConsentState
  /** Withdraw one domain. Prospective only; the log keeps what it lawfully held. */
  revoke(domain: ConsentDomain): ConsentState
  /** Names withheld from a provider, and the §16 notices that say so. */
  notices(): readonly string[]
  /** Stop observing. Idempotent. */
  destroy(): void
  /** True once `destroy` has been called. */
  destroyed(): boolean
}

/** A host's `document`, read without assuming `window` exists. */
function hostDocument(explicit: ScoutDocument | null | undefined): ScoutDocument | null {
  if (explicit !== undefined) return explicit
  const scope = globalThis as { document?: ScoutDocument }
  return scope.document ?? null
}

/** The host clock, or the process clock if the host supplied none. */
function hostClock(supplied: (() => string) | undefined): () => string {
  if (supplied !== undefined) return supplied
  return () => new Date().toISOString()
}

/**
 * Start page awareness.
 *
 * Throws `SdkConfigError` for a blank `clientId`, because the two degradations
 * available are collect-nothing (useless) and collect-unscoped (unsafe).
 */
export function init(options: ArchavaInit): Archava {
  const clientId = typeof options.clientId === 'string' ? options.clientId.trim() : ''
  if (clientId.length === 0) {
    throw new SdkConfigError(
      'Archava.init requires a clientId; a page with no client has no scope.',
    )
  }

  const session = createSession({
    tenantId: clientId,
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.route === undefined ? {} : { route: options.route }),
    ...(options.consent === undefined ? {} : { consent: options.consent }),
    ...(options.sensitiveFields === undefined ? {} : { sensitiveFields: options.sensitiveFields }),
  })
  const now = hostClock(options.now)
  const selectors = options.selectors ?? DEFAULT_SELECTORS
  const document = hostDocument(options.document)
  const onAnalytics = options.onAnalytics
  const onConsentChange = options.onConsentChange

  return {
    clientId,

    session,

    graph(): ContextGraph {
      return session.graph()
    },

    observe(): readonly ContextEvent[] {
      const read = readDom(document, now(), selectors)
      return session.readPage(read)
    },

    history(): readonly ContextEvent[] {
      return session.history()
    },

    consent(): ConsentState {
      return session.consent()
    },

    grant(domain: ConsentDomain): ConsentState {
      // Routed through the session rather than assembled here, so there is
      // exactly one place a consent decision is recorded.
      session.grant(domain)
      const next = grantConsent(session.consent(), domain)
      onConsentChange?.(next)
      return next
    },

    revoke(domain: ConsentDomain): ConsentState {
      session.revoke(domain)
      onConsentChange?.(session.consent())
      return session.consent()
    },

    notices(): readonly string[] {
      return session.notices()
    },

    destroy(): void {
      emit(onAnalytics, session, clientId, now, 'destroy')
      session.destroy()
    },

    destroyed(): boolean {
      return session.destroyed()
    },
  }
}

/**
 * One analytics record, gated on the `analytics` domain.
 *
 * The gate is here rather than in the host's callback because "only call me when
 * they said yes" is the promise the host is relying on; a sink that has to
 * remember it is a sink that will one day forget (§27).
 */
function emit(
  sink: ((event: ArchavaAnalyticsEvent) => void) | undefined,
  session: SdkSession,
  clientId: string,
  now: () => string,
  name: string,
): void {
  if (sink === undefined) return
  if (session.consent().analytics !== true) return
  sink({ name, clientId, route: session.graph().page.route, graph: session.graph(), at: now() })
}

/**
 * Attach the SDK to a global, the way the §24 snippet expects.
 *
 * A no-op when called twice, so a host that re-includes the script does not
 * clobber the instance already observing.
 */
export function install(
  target: { Archava?: { init: typeof init } } | null | undefined,
  namespace: { init: typeof init } = { init },
): void {
  if (target === null || target === undefined) return
  if (target.Archava === undefined) {
    target.Archava = namespace
  }
}

/** Consent for a host that has collected nothing yet — everything refused. */
export function emptyConsent(): ConsentState {
  return parseConsent(undefined)
}

/** Consent after one domain is withdrawn, for hosts that render a banner. */
export function withoutConsent(state: ConsentState, domain: ConsentDomain): ConsentState {
  return revokeConsent(state, domain)
}
