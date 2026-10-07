/**
 * Structural refusal, before anything is wired.
 *
 * A composition factory that trusts its own argument types is a factory that
 * believes whatever the caller handed it. In a server process the caller is a
 * request handler, a config loader or a test — three things that have each, at
 * some point, handed a placeholder where a port was meant to go. So every port
 * is checked structurally and the composition refuses rather than deferring the
 * failure to a runtime type error inside a boundary.
 *
 * None of this is authorization. Refusing to construct an executor says nothing
 * about whether an action may run; it only says this deployment is not wired in
 * a way that could tell the truth about one.
 */

import type {
  BookingAttemptStore,
  BookingGateway,
  BookingReconciliationPort,
} from '@archava/act-booking'
import type {
  ApprovedEmailTemplate,
  EmailAttemptStore,
  EmailDeliveryStatusPort,
  EmailGateway,
  EmailTemplateResolver,
} from '@archava/act-email'

/** Why a refusal to construct happened. Machine-readable, never a stack. */
export const ACT_COMPOSITION_FAULTS = {
  tenantMissing: 'act_composition_tenant_missing',
  // Booking ports
  bookingNotAnObject: 'act_composition_booking_not_an_object',
  bookingGatewayIdMissing: 'act_composition_booking_gateway_identity_missing',
  bookingGatewayHealthUnusable: 'act_composition_booking_gateway_health_unusable',
  bookingGatewayNotCallable: 'act_composition_booking_gateway_unusable',
  bookingStoreIdMissing: 'act_composition_booking_store_identity_missing',
  bookingStoreNotUsable: 'act_composition_booking_store_unusable',
  reconcilerIdMissing: 'act_composition_reconciler_identity_missing',
  reconcilerNotCallable: 'act_composition_reconciler_unusable',
  // Email ports
  emailNotAnObject: 'act_composition_email_not_an_object',
  emailGatewayNotCallable: 'act_composition_email_gateway_unusable',
  emailStoreIdMissing: 'act_composition_email_store_identity_missing',
  emailStoreNotUsable: 'act_composition_email_store_unusable',
  statusPortIdMissing: 'act_composition_status_port_identity_missing',
  statusPortNotCallable: 'act_composition_status_port_unusable',
  templateResolverNotCallable: 'act_composition_template_resolver_unusable',
  // Keys
  keyNotBytes: 'act_composition_fingerprint_key_not_bytes',
  keyTooShort: 'act_composition_fingerprint_key_too_short',
} as const

export type ActCompositionFault =
  (typeof ACT_COMPOSITION_FAULTS)[keyof typeof ACT_COMPOSITION_FAULTS]

/** The refusal itself. Carries no port, no payload and no provider text. */
export class ActCompositionRefusal extends Error {
  readonly reason: ActCompositionFault

  constructor(reason: ActCompositionFault, message: string) {
    super(message)
    this.name = 'ActCompositionRefusal'
    this.reason = reason
  }
}

/**
 * Stop construction with a named reason.
 *
 * The reason is available to the caller so a deployment can log which seam
 * broke; the message is what a surface may show, and it says only that the
 * configuration was incomplete — never which tenant, which provider or which
 * port implementation was involved.
 */
export function refuse(reason: ActCompositionFault, message: string): never {
  throw new ActCompositionRefusal(reason, message)
}

/** A plain object, and not a function, an array or a primitive. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function callable(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function'
}

function nonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Accept an object that has already been structurally checked as a port.
 *
 * The checks above establish that the methods and identifiers the port's
 * contract names are present; nothing in TypeScript can re-derive that from a
 * `Record`, so the assertion is unavoidable here. It lives in one documented
 * helper rather than being scattered through each guard, so that there is
 * exactly one place in this package where a checked shape is claimed to be a
 * port, and every one of those claims is immediately preceded by its checks.
 */
function asPort<T>(value: Record<string, unknown>): T {
  return value as unknown as T
}

/** The tenant this composition is bound to, or a refusal. */
export function readTenantId(tenantId: unknown): string {
  if (!nonBlankString(tenantId)) {
    refuse(ACT_COMPOSITION_FAULTS.tenantMissing, 'A tenant id is required to compose Act.')
  }
  // Trimmed so that a config file's trailing newline does not silently create a
  // second tenant scope, and so that every downstream port sees one spelling.
  return tenantId.trim()
}

/** Server-only key bytes; length is checked here, secure generation is the deployment's job. */
export function readFingerprintKey(key: unknown, minBytes: number): Uint8Array {
  if (!(key instanceof Uint8Array)) {
    refuse(
      ACT_COMPOSITION_FAULTS.keyNotBytes,
      'A fingerprint key must be bytes held only on the server.',
    )
  }
  if (key.byteLength < minBytes) {
    refuse(
      ACT_COMPOSITION_FAULTS.keyTooShort,
      'A fingerprint key must contain at least 32 bytes of server-only key material.',
    )
  }
  // Copied, so a caller that rotates the array it passed cannot rotate the key
  // under records this composition already wrote.
  return Uint8Array.from(key)
}

/** The reservation system this tenant's reservations go to. */
export function readBookingGateway(value: unknown): BookingGateway {
  if (!isPlainObject(value)) {
    refuse(ACT_COMPOSITION_FAULTS.bookingNotAnObject, 'The booking configuration is incomplete.')
  }
  if (!nonBlankString(value['gatewayId'])) {
    refuse(
      ACT_COMPOSITION_FAULTS.bookingGatewayIdMissing,
      'The booking configuration is incomplete.',
    )
  }
  let ready: unknown
  let reason: unknown
  try {
    const health = value['health']
    if (isPlainObject(health)) {
      ready = health['ready']
      reason = health['reason']
    }
  } catch {
    refuse(
      ACT_COMPOSITION_FAULTS.bookingGatewayHealthUnusable,
      'The booking configuration is incomplete.',
    )
  }
  if (typeof ready !== 'boolean' || typeof reason !== 'string') {
    refuse(
      ACT_COMPOSITION_FAULTS.bookingGatewayHealthUnusable,
      'The booking configuration is incomplete.',
    )
  }
  if (!callable(value['reserve'])) {
    refuse(
      ACT_COMPOSITION_FAULTS.bookingGatewayNotCallable,
      'The booking configuration is incomplete.',
    )
  }
  return asPort<BookingGateway>(value)
}

/** Where an attempt is remembered, and asked to be claimed atomically. */
export function readBookingAttemptStore(value: unknown): BookingAttemptStore {
  if (!isPlainObject(value)) {
    refuse(ACT_COMPOSITION_FAULTS.bookingNotAnObject, 'The booking configuration is incomplete.')
  }
  if (!nonBlankString(value['storeId'])) {
    refuse(ACT_COMPOSITION_FAULTS.bookingStoreIdMissing, 'The booking configuration is incomplete.')
  }
  if (!callable(value['claim']) || !callable(value['settle'])) {
    refuse(ACT_COMPOSITION_FAULTS.bookingStoreNotUsable, 'The booking configuration is incomplete.')
  }
  return asPort<BookingAttemptStore>(value)
}

/** The read-only way to ask a system what became of an attempt. */
export function readBookingReconciler(value: unknown): BookingReconciliationPort {
  if (!isPlainObject(value)) {
    refuse(ACT_COMPOSITION_FAULTS.bookingNotAnObject, 'The booking configuration is incomplete.')
  }
  if (!nonBlankString(value['reconcilerId'])) {
    refuse(ACT_COMPOSITION_FAULTS.reconcilerIdMissing, 'The booking configuration is incomplete.')
  }
  if (!callable(value['reconcile'])) {
    refuse(ACT_COMPOSITION_FAULTS.reconcilerNotCallable, 'The booking configuration is incomplete.')
  }
  return asPort<BookingReconciliationPort>(value)
}

/** Where a message is remembered before it is sent. */
export function readEmailAttemptStore(value: unknown): EmailAttemptStore {
  if (!isPlainObject(value)) {
    refuse(ACT_COMPOSITION_FAULTS.emailNotAnObject, 'The email configuration is incomplete.')
  }
  if (!nonBlankString(value['storeId'])) {
    refuse(ACT_COMPOSITION_FAULTS.emailStoreIdMissing, 'The email configuration is incomplete.')
  }
  if (!callable(value['claim']) || !callable(value['settle'])) {
    refuse(ACT_COMPOSITION_FAULTS.emailStoreNotUsable, 'The email configuration is incomplete.')
  }
  return asPort<EmailAttemptStore>(value)
}

/** The transport a tenant actually approved. */
export function readEmailGateway(value: unknown): EmailGateway {
  if (!isPlainObject(value)) {
    refuse(ACT_COMPOSITION_FAULTS.emailNotAnObject, 'The email configuration is incomplete.')
  }
  if (!callable(value['send'])) {
    refuse(ACT_COMPOSITION_FAULTS.emailGatewayNotCallable, 'The email configuration is incomplete.')
  }
  return asPort<EmailGateway>(value)
}

/** The read-only way to ask a provider what became of a message. */
export function readEmailStatusPort(value: unknown): EmailDeliveryStatusPort {
  if (!isPlainObject(value)) {
    refuse(ACT_COMPOSITION_FAULTS.emailNotAnObject, 'The email configuration is incomplete.')
  }
  if (!nonBlankString(value['statusPortId'])) {
    refuse(ACT_COMPOSITION_FAULTS.statusPortIdMissing, 'The email configuration is incomplete.')
  }
  if (!callable(value['status'])) {
    refuse(ACT_COMPOSITION_FAULTS.statusPortNotCallable, 'The email configuration is incomplete.')
  }
  return asPort<EmailDeliveryStatusPort>(value)
}

/** Server-side templates. The only place a sender may come from. */
export function readEmailTemplateResolver(value: unknown): EmailTemplateResolver {
  if (!isPlainObject(value)) {
    refuse(
      ACT_COMPOSITION_FAULTS.templateResolverNotCallable,
      'The email configuration is incomplete.',
    )
  }
  if (!callable(value['resolve'])) {
    refuse(
      ACT_COMPOSITION_FAULTS.templateResolverNotCallable,
      'The email configuration is incomplete.',
    )
  }
  return asPort<EmailTemplateResolver>(value)
}

/** A template this tenant owns, whose approved flag is real. */
export function isOwnedTemplate(
  template: unknown,
  tenantId: string,
): template is ApprovedEmailTemplate {
  if (!isPlainObject(template)) return false
  const candidate = template as Partial<ApprovedEmailTemplate>
  return (
    candidate.tenantId === tenantId &&
    nonBlankString(candidate.templateId) &&
    nonBlankString(candidate.providerTemplateId) &&
    nonBlankString(candidate.senderAddress) &&
    candidate.approved === true
  )
}
