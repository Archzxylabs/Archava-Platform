/**
 * The SDK's public surface.
 *
 * A barrel is where a package decides what it is willing to be held to. Four
 * groups leave here:
 *
 * - **`init`** — the host's door (§24). Everything a host needs is on the
 *   handle it returns.
 * - **The page translator** — `PageShape` in, `ContextEvent`s out. Pure, so a
 *   host application that knows its own state can call it without a DOM.
 * - **The scout** — the one module allowed to read a DOM, behind a structural
 *   interface so it runs under SSR, in a worker, or in a test.
 * - **Consent and errors** — the vocabulary a host console reports in.
 *
 * What does *not* leave here: `reduceContextGraph`'s internals (that is
 * `@archava/core`), and anything resembling a provider credential (§24).
 */

export { init, install, emptyConsent, withoutConsent } from './host.js'
export type { Archava, ArchavaInit, ArchavaAnalyticsEvent } from './host.js'

export {
  CONSENT_DOMAINS,
  DENIED_CONSENT,
  grantConsent,
  hasConsent,
  missingConsent,
  parseConsent,
  revokeConsent,
  type ConsentDomain,
  type ConsentState,
} from './consent.js'

export { SdkConfigError, SdkConsentError, SdkEnvironmentError, SdkError } from './errors.js'

export {
  isValueBearing,
  maskedFieldNames,
  readPage,
  reconcilePage,
  VALUE_BEARING_FIELD_NAMES,
  type PageAction,
  type PageEntity,
  type PageError,
  type PageForm,
  type PageShape,
} from './page.js'

export {
  DEFAULT_SELECTORS,
  readDom,
  type ScoutDocument,
  type ScoutNamedNodeMap,
  type ScoutNode,
  type ScoutNodeList,
  type ScoutRead,
  type ScoutSelectors,
} from './dom.js'

export { createSession, type SdkInit, type SdkSession } from './session.js'
