/**
 * Presence: how the assistant reaches the visitor.
 *
 * PRD §21 makes presence a replaceable adapter and specifies the failure
 * behaviour precisely: human mode has a preflight check — renderer support,
 * network reachability, session token/bootstrap, performance readiness — and if
 * any check fails, the session falls back Human → Voice → Chat. "Archava must
 * remain usable."
 *
 * So this module has two jobs:
 *
 * - own the *preflight* contract (what an embodiment must be able to promise
 *   before it is allowed to take over a session), and
 * - own the *selection* rule (which mode actually runs, given what passed).
 *
 * Selection is a pure function of preflight results. It does not look at the
 * clock, at random jitter, or at the model's preferences — those are exactly the
 * inputs that make a fallback nondeterministic and therefore untestable.
 */

/** Presence modes, ordered richest to plainest. Also the pricebook's tiers. */
export const PRESENCE_MODES = ['human', 'voice', 'chat'] as const
export type PresenceMode = (typeof PRESENCE_MODES)[number]

/**
 * Fallback order from PRD §21: Human → Voice → Chat.
 *
 * The order is exported data rather than an `if` chain so the guarantee is one
 * value a reader (or a test) can check, and so a mode with no installed
 * embodiment can be skipped without rewriting the chain.
 */
export const PRESENCE_FALLBACK_ORDER: readonly PresenceMode[] = ['human', 'voice', 'chat']

/** What an embodiment must be able to claim about itself before it may run. */
export const PREFLIGHT_CHECKS = [
  'renderer_support',
  'network_reachability',
  'session_bootstrap',
  'performance_readiness',
] as const
export type PreflightCheck = (typeof PREFLIGHT_CHECKS)[number]

/** One preflight outcome: a named check and whether it passed. */
export interface PreflightResult {
  readonly check: PreflightCheck
  readonly ok: boolean
  /** Required when `ok` is false; it becomes the operator-facing reason. */
  readonly detail?: string
}

/**
 * The preflight contract every embodiment satisfies.
 *
 * It is synchronous and pure over the environment the host injects. A real
 * renderer measures that environment first — can it load? does the network reach
 * the provider? did the session token issue? is the device fast enough? — and
 * hands the answers here. Keeping the measurement out of this port is what lets
 * the fallback rule be tested without a browser.
 */
export interface EmbodimentPreflight {
  /** The embodiment being checked; must match a registered provider id. */
  readonly providerId: string
  /** The mode this embodiment would serve. */
  readonly mode: PresenceMode
  /** Results for the checks in `PREFLIGHT_CHECKS`, in any order. */
  readonly results: readonly PreflightResult[]
}

export class PresenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PresenceError'
  }
}

/** Flatten a preflight into the failures that actually disqualify a mode. */
export function preflightFailures(preflight: EmbodimentPreflight): readonly PreflightResult[] {
  const failures = preflight.results.filter((result) => !result.ok)

  // A missing check is a failure, not an absence of one. "Not measured" and
  // "measured fine" are different facts, and only one of them is safe.
  const seen = new Set(preflight.results.map((result) => result.check))
  for (const check of PREFLIGHT_CHECKS) {
    if (!seen.has(check)) {
      failures.push({
        check,
        ok: false,
        detail: `preflight did not report "${check}"`,
      })
    }
  }
  return failures
}

/** True when an embodiment may take over a session. */
export function preflightPassed(preflight: EmbodimentPreflight): boolean {
  return preflightFailures(preflight).length === 0
}

export interface PresenceSelection {
  /** The mode that will run. */
  readonly mode: PresenceMode
  /** The embodiment that will render it, or null when the mode is text-only. */
  readonly providerId: string | null
  /** Why this mode was chosen; also the audit trail for a fallback. */
  readonly reason: string
  /** Modes that were considered and rejected, with their reasons. */
  readonly skipped: readonly { readonly mode: PresenceMode; readonly reason: string }[]
  /** True when the requested mode could not run and a plainer one was chosen. */
  readonly fellBack: boolean
}

/**
 * Choose the presence mode for a session.
 *
 * `requested` is the tenant's configured mode. The rule is exactly PRD §21: try
 * the requested mode first, then walk the fallback order. Chat is always
 * available — it is the mode that requires no transport and no renderer, which
 * is what makes "Archava must remain usable" true by construction rather than by
 * a provider's uptime.
 *
 * Chat is emitted without a preflight of its own, and that is deliberate: it is
 * the floor, not another provider.
 */
export function selectPresence(
  requested: PresenceMode,
  preflights: readonly EmbodimentPreflight[],
): PresenceSelection {
  const order: PresenceMode[] = [
    requested,
    ...PRESENCE_FALLBACK_ORDER.filter((mode) => mode !== requested),
  ]

  const skipped: { mode: PresenceMode; reason: string }[] = []

  for (const mode of order) {
    // Chat has no embodiment: nothing to preflight, nothing to fall back to.
    if (mode === 'chat') {
      return {
        mode,
        providerId: null,
        reason:
          skipped.length === 0
            ? 'chat requested and always available'
            : `fell back to chat; ${describeSkipped(skipped)}`,
        skipped,
        fellBack: skipped.length > 0,
      }
    }

    const candidates = preflights.filter((preflight) => preflight.mode === mode)

    if (candidates.length === 0) {
      skipped.push({ mode, reason: `no ${mode} embodiment is installed` })
      continue
    }

    for (const candidate of candidates) {
      const failures = preflightFailures(candidate)
      if (failures.length === 0) {
        return {
          mode,
          providerId: candidate.providerId,
          reason:
            skipped.length === 0
              ? `${mode} preflight passed`
              : `fell back to ${mode}; ${describeSkipped(skipped)}`,
          skipped,
          fellBack: skipped.length > 0,
        }
      }
      skipped.push({
        mode,
        reason: failures.map((failure) => failure.detail ?? failure.check).join('; '),
      })
    }
  }

  // Unreachable while `chat` is in `order`, which PRESENCE_FALLBACK_ORDER
  // guarantees. Throwing rather than returning a bogus mode keeps that a hard
  // invariant instead of an assumption.
  throw new PresenceError(`Presence selection found no runnable mode (requested "${requested}").`)
}

/**
 * Render the skip trail as one line.
 *
 * A fallback is only useful as an audit trail if it names what it bypassed, so
 * this is the same string the operator reads; a caller that wants the structure
 * takes `selection.skipped`.
 */
function describeSkipped(
  skipped: readonly { readonly mode: PresenceMode; readonly reason: string }[],
): string {
  return skipped.map((entry) => `${entry.mode} (${entry.reason})`).join(', ')
}
