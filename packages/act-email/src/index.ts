/**
 * @archava/act-email — the email.send executor and its outbox.
 *
 * One narrow thing: send a transactional message through a provider a tenant
 * actually approved, and refuse to report one that was not confirmed. The
 * decision about whether the action may run is not made here (§18 made it), and
 * neither is the check that the recipient and the template are what they claim
 * to be (§9 and the server-side resolver did that). This is the last boundary,
 * where a template id and an address become a message or the turn says it does
 * not know.
 */

export {
  EMAIL_ACTION,
  EMAIL_ERROR_CODES,
  EmailActionExecutor,
  type EmailActionExecutorOptions,
} from './executor.js'

export {
  EMAIL_IDEMPOTENCY_CONFLICT,
  isAcceptedEmail,
  isApprovedEmailTemplate,
  isEmailAddress,
  isNonblank,
  isProviderMessageId,
  isTrustedTemplateShape,
  type AcceptedEmail,
  type ApprovedEmailTemplate,
  type EmailGateway,
  type EmailGatewayOutcome,
  type EmailSendRequest,
  type EmailTemplateResolver,
  type RejectedEmail,
  type UnknownEmail,
} from './ports.js'

export {
  EmailOutboxBoundary,
  type EmailAttemptClaim,
  type EmailAttemptOwnership,
  type EmailAttemptRecord,
  type EmailAttemptSettlement,
  type EmailAttemptState,
  type EmailAttemptStore,
  type EmailDeliveryStatusLookup,
  type EmailDeliveryStatusPort,
  type EmailOutboxBoundaryOptions,
} from './outbox.js'
