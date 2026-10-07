import type {
  ActionExecutionRequest,
  ActionExecutionResult,
  ActionExecutor,
} from '@archava/assistant'
import {
  EMAIL_IDEMPOTENCY_CONFLICT,
  isApprovedEmailTemplate,
  isEmailAddress,
  isNonblank,
  isProviderMessageId,
  type EmailGateway,
  type EmailGatewayOutcome,
  type EmailTemplateResolver,
} from './ports.js'

export const EMAIL_ACTION = 'email.send'

export const EMAIL_ERROR_CODES = {
  unsupportedAction: 'email_action_not_dispatched',
  malformedInput: 'email_input_malformed',
  templateUnavailable: 'email_template_unavailable',
  templateFailure: 'email_template_lookup_failed',
  gatewayFailure: 'email_gateway_failed',
  rejected: 'email_rejected',
  unknown: 'email_outcome_unknown',
  incompleteAcceptance: 'email_acceptance_incomplete',
  idempotencyConflict: 'email_idempotency_key_conflict',
} as const

export interface EmailActionExecutorOptions {
  readonly templates: EmailTemplateResolver
  readonly gateway: EmailGateway
}

/**
 * The ActionPolicy, user confirmation, entity resolver and input validator run
 * before this port in runTurn. This executor does not grant permission. Its
 * success means only that a trusted gateway durably accepted a message, never
 * that the recipient received or read it.
 *
 * The gateway may be a raw transport or an
 * {@link import('./outbox.js').EmailOutboxBoundary} wrapped around one; the
 * executor cannot tell them apart, which is the point. It treats every
 * `accepted` as a receipt and every `rejected` as a refusal, including the
 * boundary's idempotency-key conflict, which it reports as a conflict rather
 * than as anything a provider said.
 */
export class EmailActionExecutor implements ActionExecutor {
  readonly executorId = 'email.send@1'
  private readonly templates: EmailTemplateResolver
  private readonly gateway: EmailGateway

  constructor(options: EmailActionExecutorOptions) {
    this.templates = options.templates
    this.gateway = options.gateway
  }

  async execute(request: ActionExecutionRequest): Promise<ActionExecutionResult> {
    if (request.action !== EMAIL_ACTION) {
      return failure(
        EMAIL_ERROR_CODES.unsupportedAction,
        'This executor cannot run the requested action.',
      )
    }
    const input = readInput(request)
    if (input === null) {
      return failure(EMAIL_ERROR_CODES.malformedInput, 'The email request is invalid.')
    }

    let template: unknown
    try {
      template = await this.templates.resolve(request.tenantId, input.templateId)
    } catch {
      return failure(EMAIL_ERROR_CODES.templateFailure, 'The email template could not be checked.')
    }
    if (!isApprovedEmailTemplate(template, request.tenantId, input.templateId)) {
      return failure(
        EMAIL_ERROR_CODES.templateUnavailable,
        'An approved email template is unavailable.',
      )
    }

    let outcome: unknown
    try {
      outcome = await this.gateway.send({
        tenantId: request.tenantId,
        recipient: input.recipient,
        template,
        idempotencyKey: request.idempotencyKey,
      })
    } catch {
      // A transport that throws may have taken the message. Nothing may be said
      // about it here beyond "not confirmed", and nothing may be sent again.
      return failure(
        EMAIL_ERROR_CODES.gatewayFailure,
        'The email provider did not confirm acceptance.',
      )
    }
    return resultFromGateway(outcome)
  }
}

function readInput(
  request: ActionExecutionRequest,
): { templateId: string; recipient: string } | null {
  if (
    !isNonblank(request.tenantId) ||
    !isNonblank(request.sessionId) ||
    !isNonblank(request.idempotencyKey) ||
    typeof request.inputs !== 'object' ||
    request.inputs === null ||
    Array.isArray(request.inputs)
  )
    return null
  const keys = Object.keys(request.inputs).sort()
  if (keys.length !== 2 || keys[0] !== 'templateId' || keys[1] !== 'to') return null
  const templateId = request.inputs['templateId']
  const recipient = request.inputs['to']
  if (!isNonblank(templateId) || !isEmailAddress(recipient)) return null
  return { templateId, recipient }
}

/** A gateway result this executor can say something true about, and nothing more. */
function readGatewayOutcome(outcome: unknown): EmailGatewayOutcome | null {
  if (typeof outcome !== 'object' || outcome === null) return null
  const answer = outcome as Partial<EmailGatewayOutcome>
  if (answer.outcome === 'rejected') {
    return { outcome: 'rejected', reason: knownReason(answer.reason) }
  }
  if (answer.outcome === 'unknown') {
    return { outcome: 'unknown', reason: knownReason(answer.reason) }
  }
  if (answer.outcome === 'accepted' && isProviderMessageId(answer.providerMessageId)) {
    return { outcome: 'accepted', providerMessageId: answer.providerMessageId }
  }
  return null
}

/** Known reasons only: unknown text is dropped rather than relayed. */
function knownReason(value: unknown): string {
  return isNonblank(value) ? value : 'not_stated'
}

function resultFromGateway(outcome: unknown): ActionExecutionResult {
  const answer = readGatewayOutcome(outcome)
  if (answer === null) {
    return failure(
      EMAIL_ERROR_CODES.incompleteAcceptance,
      'The email provider returned no valid receipt.',
    )
  }
  if (answer.outcome === 'rejected') {
    // The boundary says a key was replayed with a changed payload. That is not a
    // provider refusing anything, and reporting it as one would send an operator
    // looking for a problem in the wrong place.
    if (answer.reason === EMAIL_IDEMPOTENCY_CONFLICT) {
      return failure(
        EMAIL_ERROR_CODES.idempotencyConflict,
        'This email request reuses a key that was already used.',
      )
    }
    return failure(EMAIL_ERROR_CODES.rejected, 'The email provider rejected this message.')
  }
  if (answer.outcome === 'unknown') {
    return failure(EMAIL_ERROR_CODES.unknown, 'The email provider did not confirm acceptance.')
  }
  // The opaque id the provider issued, and nothing else: no recipient, no
  // template, no delivery claim. "accepted" is a provider's word, not a read.
  return {
    status: 'succeeded',
    output: { deliveryStatus: 'accepted', providerMessageId: answer.providerMessageId },
  }
}

function failure(errorCode: string, message: string): ActionExecutionResult {
  return { status: 'failed', errorCode, retryable: false, message }
}
