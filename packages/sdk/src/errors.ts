/**
 * The SDK's failure modes, named so a host console can point at one.
 *
 * PRD §24 is explicit that the SDK never exposes a server API key, and that
 * consent/privacy settings are respected. Neither of those can be *partially*
 * done: a key that leaks into one request leaks the tenant, and a consent
 * decision that is ignored for one event is not a decision. So both conditions
 * are thrown rather than warned about.
 */
export class SdkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SdkError'
  }
}

/** Something the host handed `init` cannot produce a safe SDK. */
export class SdkConfigError extends SdkError {
  constructor(message: string) {
    super(message)
    this.name = 'SdkConfigError'
  }
}

/** An operation that requires consent was attempted without it. */
export class SdkConsentError extends SdkError {
  constructor(message: string) {
    super(message)
    this.name = 'SdkConsentError'
  }
}

/** The host's DOM does not offer the shape the SDK reads. */
export class SdkEnvironmentError extends SdkError {
  constructor(message: string) {
    super(message)
    this.name = 'SdkEnvironmentError'
  }
}
