import type {
  ActionExecutionRequest,
  ActionExecutionResult,
  ActionExecutor,
} from '@archava/assistant'
import type {
  ApprovedEmailTemplate,
  EmailGateway,
  EmailGatewayOutcome,
  EmailTemplateResolver,
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
    if (!approvedTemplate(template, request.tenantId, input.templateId)) {
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
      return failure(
        EMAIL_ERROR_CODES.gatewayFailure,
        'The email provider did not confirm acceptance.',
      )
    }
    return resultFromGateway(outcome)
  }
}

function approvedTemplate(
  value: unknown,
  tenantId: string,
  templateId: string,
): value is ApprovedEmailTemplate {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const template = value as Record<string, unknown>
  return (
    template['approved'] === true &&
    template['tenantId'] === tenantId &&
    template['templateId'] === templateId &&
    nonblank(template['providerTemplateId']) &&
    emailAddress(template['senderAddress'])
  )
}

function readInput(
  request: ActionExecutionRequest,
): { templateId: string; recipient: string } | null {
  if (
    !nonblank(request.tenantId) ||
    !nonblank(request.sessionId) ||
    !nonblank(request.idempotencyKey) ||
    typeof request.inputs !== 'object' ||
    request.inputs === null ||
    Array.isArray(request.inputs)
  )
    return null
  const keys = Object.keys(request.inputs).sort()
  if (keys.length !== 2 || keys[0] !== 'templateId' || keys[1] !== 'to') return null
  const templateId = request.inputs['templateId']
  const recipient = request.inputs['to']
  if (!nonblank(templateId) || !emailAddress(recipient)) return null
  return { templateId, recipient }
}

function nonblank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function emailAddress(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 254 &&
    /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(value)
  )
}

function resultFromGateway(outcome: unknown): ActionExecutionResult {
  if (typeof outcome !== 'object' || outcome === null) {
    return failure(
      EMAIL_ERROR_CODES.incompleteAcceptance,
      'The email provider returned no valid receipt.',
    )
  }
  const answer = outcome as Partial<EmailGatewayOutcome>
  if (answer.outcome === 'rejected') {
    return failure(EMAIL_ERROR_CODES.rejected, 'The email provider rejected this message.')
  }
  if (answer.outcome === 'unknown') {
    return failure(EMAIL_ERROR_CODES.unknown, 'The email provider did not confirm acceptance.')
  }
  if (
    answer.outcome === 'accepted' &&
    typeof answer.providerMessageId === 'string' &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(answer.providerMessageId)
  ) {
    return {
      status: 'succeeded',
      output: { deliveryStatus: 'accepted', providerMessageId: answer.providerMessageId },
    }
  }
  return failure(
    EMAIL_ERROR_CODES.incompleteAcceptance,
    'The email provider returned no valid receipt.',
  )
}

function failure(errorCode: string, message: string): ActionExecutionResult {
  return { status: 'failed', errorCode, retryable: false, message }
}
