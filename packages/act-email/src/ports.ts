/**
 * The ports this package speaks through.
 *
 * Everything that carries authority lives behind one of these: the template and
 * sender come from a tenant resolver that reads server configuration, and the
 * message goes out through a transport the deployment injected. None of it is
 * decided by text a model produced, and none of it is decided here either — this
 * file only says what the ports are.
 */

/** Tenant-owned, approved server-side template. Never assembled from model text. */
export interface ApprovedEmailTemplate {
  readonly tenantId: string
  readonly templateId: string
  readonly providerTemplateId: string
  readonly senderAddress: string
  readonly approved: true
}

/**
 * The machine reason a boundary returns when a tenant-scoped key arrives
 * carrying a different recipient or template.
 *
 * It is a constant and not a literal because the executor has to recognise it
 * and say something different about it than about a provider's own refusal: the
 * provider was never asked, so "the provider declined" would be false. It is
 * exported from here, the shared vocabulary, so neither side owns the string.
 */
export const EMAIL_IDEMPOTENCY_CONFLICT = 'email_idempotency_key_conflict'

/** A production resolver must load approved templates from trusted tenant configuration. */
export interface EmailTemplateResolver {
  resolve(tenantId: string, templateId: string): Promise<ApprovedEmailTemplate | null>
}

export interface EmailSendRequest {
  readonly tenantId: string
  readonly recipient: string
  readonly template: ApprovedEmailTemplate
  readonly idempotencyKey: string
}

/** The only acceptance this package will ever report: the provider took it. */
export interface AcceptedEmail {
  readonly outcome: 'accepted'
  /** Opaque to this package. Never parsed, never reconstructed, only compared. */
  readonly providerMessageId: string
}

export interface RejectedEmail {
  readonly outcome: 'rejected'
  /** Flattened to a machine reason before anyone outside sees it. */
  readonly reason: string
}

export interface UnknownEmail {
  readonly outcome: 'unknown'
  readonly reason: string
}

export type EmailGatewayOutcome = AcceptedEmail | RejectedEmail | UnknownEmail

/** A provider message id, opaque but well-formed: never a message, never an address. */
const OPAQUE_ID = /^[A-Za-z0-9._:-]{1,128}$/

/** Good enough for a recipient address; authority over it stays with the resolver. */
const EMAIL_SHAPE = /^[^\s@,;:<>()[\]\\"]+@[^\s@,;:<>()[\]\\"]+\.[^\s@,;:<>()[\]\\"]+$/

/**
 * Whether a value is a non-blank string. Blank is not a value: a tenant id of
 * `'   '` is not a tenant, and accepting one is how a request ends up scoped to
 * nothing.
 */
export function isNonblank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Whether a value is an address this package is willing to put in a request. */
export function isEmailAddress(value: unknown): value is string {
  return typeof value === 'string' && EMAIL_SHAPE.test(value) && value.length <= 254
}

/**
 * Whether a value is an opaque provider message id. An id that echoes a
 * recipient, or is empty, is not a receipt — and reporting it as one would put
 * an address into a public success payload.
 */
export function isProviderMessageId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value) && value.length <= 128
}

/**
 * The structural half of template trust: this object describes something a
 * tenant approved, and somebody typed `approved: true` in server configuration
 * to say so. It says nothing about *which* tenant or *which* template — see
 * {@link isApprovedEmailTemplate} for that.
 *
 * The sender is checked here rather than at the call site because a template
 * carrying a forged sender is how a message goes out from an address the tenant
 * never approved. A sender is never taken from the request, only read back off
 * the resolved template.
 */
export function isTrustedTemplateShape(value: unknown): value is ApprovedEmailTemplate {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const template = value as Record<string, unknown>
  return (
    template['approved'] === true &&
    isNonblank(template['tenantId']) &&
    isNonblank(template['templateId']) &&
    isNonblank(template['providerTemplateId']) &&
    isEmailAddress(template['senderAddress'])
  )
}

/**
 * Whether a resolved template is the approved one belonging to this tenant.
 *
 * Both halves are required. A template that is structurally trusted but belongs
 * to another tenant is the cross-tenant case this closes: it is not "the template
 * for this tenant", it is a different tenant's template.
 */
export function isApprovedEmailTemplate(
  value: unknown,
  tenantId: string,
  templateId: string,
): value is ApprovedEmailTemplate {
  return (
    isTrustedTemplateShape(value) && value.tenantId === tenantId && value.templateId === templateId
  )
}

/**
 * Whether a reply from a transport is an acceptance this package may report.
 *
 * `accepted` with no usable message id is not an acceptance: it is a reply that
 * did not say, and the caller is told nobody knows rather than told a message
 * went out. Same for a reason that is not a machine reason.
 */
export function isAcceptedEmail(value: unknown): value is AcceptedEmail {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return candidate['outcome'] === 'accepted' && isProviderMessageId(candidate['providerMessageId'])
}

/**
 * A production gateway must durably deduplicate (tenantId, idempotencyKey).
 * Replays with the same payload return the same message id. A changed payload
 * under the same key is rejected. No process-local map satisfies this contract.
 * An ambiguous timeout is never retried automatically by the executor.
 */
export interface EmailGateway {
  send(request: EmailSendRequest): Promise<EmailGatewayOutcome>
}
