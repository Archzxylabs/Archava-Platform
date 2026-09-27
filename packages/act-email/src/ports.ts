/** Tenant-owned, approved server-side template. Never assembled from model text. */
export interface ApprovedEmailTemplate {
  readonly tenantId: string
  readonly templateId: string
  readonly providerTemplateId: string
  readonly senderAddress: string
  readonly approved: true
}

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

export type EmailGatewayOutcome =
  | { readonly outcome: 'accepted'; readonly providerMessageId: string }
  | { readonly outcome: 'rejected'; readonly reason: string }
  | { readonly outcome: 'unknown'; readonly reason: string }

/**
 * A production gateway must durably deduplicate (tenantId, idempotencyKey).
 * Replays with the same payload return the same message id. A changed payload
 * under the same key is rejected. No process-local map satisfies this contract.
 * An ambiguous timeout is never retried automatically by the executor.
 */
export interface EmailGateway {
  send(request: EmailSendRequest): Promise<EmailGatewayOutcome>
}
