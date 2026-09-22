/**
 * Consent, as a gate the SDK actually consults.
 *
 * PRD §24 lists "respect consent/privacy settings" among the SDK's
 * responsibilities. A gate that is merely described is not respected, so this
 * module is the only thing that gets to decide, and every collection path must
 * ask it first.
 *
 * Two decisions worth stating:
 *
 * - **Fail closed.** An absent domain is a refusal, not a default-yes. The host
 *   grants what it collected consent for; anything else is withheld. The cost is
 *   that a host which grants nothing gets no page context — which is the correct
 *   outcome for a visitor who said no.
 * - **Domains, not one switch.** "Do you consent to cookies" is the question that
 *   taught visitors not to trust the switch. `identity` (may the assistant know
 *   who you are, §26) and `analytics` (may a warehouse see this session, §27) are
 *   separate from `page_context`, because they are separately harmful.
 */

/** The things a visitor can independently decline. */
export const CONSENT_DOMAINS = ['page_context', 'identity', 'analytics'] as const
export type ConsentDomain = (typeof CONSENT_DOMAINS)[number]

/** What the visitor has agreed to, by domain. */
export type ConsentState = Readonly<Record<ConsentDomain, boolean>>

/** Nothing has been granted yet. */
export const DENIED_CONSENT: ConsentState = {
  page_context: false,
  identity: false,
  analytics: false,
}

/** Start from the host's record, defaulting anything it omitted to refused. */
export function parseConsent(raw: Partial<Record<ConsentDomain, boolean>> | undefined): ConsentState {
  const source = raw ?? {}
  return {
    page_context: source.page_context === true,
    identity: source.identity === true,
    analytics: source.analytics === true,
  }
}

/** One domain granted, the rest left exactly as they were. */
export function grantConsent(state: ConsentState, domain: ConsentDomain): ConsentState {
  return { ...state, [domain]: true }
}

/** One domain withdrawn. Withdrawal takes effect on the next turn, not retroactively. */
export function revokeConsent(state: ConsentState, domain: ConsentDomain): ConsentState {
  return { ...state, [domain]: false }
}

/**
 * The domains the SDK still needs but does not have.
 *
 * Reported rather than thrown because a partial grant is a normal steady state:
 * a visitor who declines `identity` still gets an assistant, it just never
 * learns their name.
 */
export function missingConsent(
  state: ConsentState,
  required: readonly ConsentDomain[],
): readonly ConsentDomain[] {
  return required.filter((domain) => state[domain] !== true)
}

/** True only for an explicit `true`; `undefined` and any other value both read as refusal. */
export function hasConsent(state: ConsentState, domain: ConsentDomain): boolean {
  return state[domain] === true
}
