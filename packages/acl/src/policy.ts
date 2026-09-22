/**
 * The server-side action policy gate.
 *
 * This is the single chokepoint every tool call passes through before it can
 * touch an external system. It is fail-closed: anything unrecognised, disabled,
 * under-capability, wrong-role, page-unavailable, or unconfirmed is denied.
 *
 * Two rules from the specifications are structural here, not conventions:
 *
 * 1. PRD §18 — "Capability tier does not override risk rules. A Transact client
 *    still requires appropriate confirmation for L4 actions." So confirmation is
 *    decided by `action.confirmation`/risk level alone, never by capability.
 * 2. PRD §16 / the Context Graph contract — page context can only *narrow* what
 *    the capability permits, never widen it. `availableOnPage === false` removes
 *    an action; a page can never add one.
 */
import type { CapabilityTierName } from '@archava/config'
import type { ActionDefinition, ActionLevel, ConfirmationMode } from './actions.js'
import { ActionRegistry } from './actions.js'
import type { RoleName } from './roles.js'

const CAPABILITY_RANK: Record<CapabilityTierName, number> = {
  assist: 0,
  act: 1,
  transact: 2,
  enterprise: 3,
}

/** True when `granted` is at least the `required` capability tier. */
export function satisfiesCapability(
  granted: CapabilityTierName,
  required: CapabilityTierName,
): boolean {
  return rankOf(granted) >= rankOf(required)
}

/**
 * The numeric weight of a tier. An unrecognised tier resolves to the weakest
 * rank, so a mistyped tier can only ever under-privilege a call, never widen it.
 */
function rankOf(tier: CapabilityTierName): number {
  return CAPABILITY_RANK[tier] ?? 0
}

/** Actions at or above this level can never run autonomously. */
export const NEVER_AUTONOMOUS_LEVEL: ActionLevel = 'L5'

export const DENIAL_REASONS = [
  'unknown_action',
  'action_disabled_for_client',
  'role_not_allowed',
  'capability_insufficient',
  'action_unavailable_on_page',
  'admin_action_requires_human',
] as const
export type DenialReason = (typeof DENIAL_REASONS)[number]

export interface ActionRequest {
  readonly actionId: string
  readonly capability: CapabilityTierName
  readonly role: RoleName
  /**
   * Page-awareness narrowing. `false` means the host page declared this action
   * unavailable; `undefined` means the page said nothing, which is not a denial.
   */
  readonly availableOnPage?: boolean
  /** The visitor confirmed a `user_confirm` action. */
  readonly confirmed?: boolean
  /** A human operator approved an L5 action. */
  readonly humanApproved?: boolean
  /** Tenant-level action allow-list, when the client config narrows further. */
  readonly enabledActionIds?: readonly string[]
}

export type PolicyResult =
  | { readonly decision: 'allow'; readonly action: ActionDefinition }
  | {
      readonly decision: 'confirmation_required'
      readonly action: ActionDefinition
      readonly mode: ConfirmationMode
      readonly prompt: string
    }
  | {
      readonly decision: 'denied'
      readonly action: ActionDefinition | null
      readonly reason: DenialReason
      readonly message: string
    }

const CONFIRMATION_PROMPTS: Record<ActionLevel, string> = {
  L0: 'This reads live data.',
  L1: 'This changes what you see on the page.',
  L2: 'This change is reversible. Shall I proceed?',
  L3: 'This sends data to an external system and cannot be undone by me. Shall I proceed?',
  L4: 'This involves a payment or an account change. Please confirm before I continue.',
  L5: 'This is an administrative change and needs a human to approve it.',
}

export class ActionPolicy {
  constructor(private readonly registry: ActionRegistry = new ActionRegistry()) {}

  get version(): string {
    return this.registry.version
  }

  /** Resolve an action id, failing closed on anything unregistered. */
  describe(actionId: string): ActionDefinition {
    return this.registry.get(actionId)
  }

  evaluate(request: ActionRequest): PolicyResult {
    const action = this.registry.tryGet(request.actionId)
    if (!action) {
      return {
        decision: 'denied',
        action: null,
        reason: 'unknown_action',
        message: `Action "${request.actionId}" is not registered. Unregistered actions are never executed.`,
      }
    }

    // A deprecated action still runs — deprecation is a migration signal, not a
    // revocation — but the caller is told which id replaces it.
    const deprecationNote =
      action.deprecatedIn === undefined
        ? ''
        : ` (deprecated in ${action.deprecatedIn}${action.replacedBy === undefined ? '' : `, use "${action.replacedBy}"`})`

    if (
      request.enabledActionIds !== undefined &&
      !request.enabledActionIds.includes(action.id)
    ) {
      return {
        decision: 'denied',
        action,
        reason: 'action_disabled_for_client',
        message: `Action "${action.id}" is not enabled for this client configuration${deprecationNote}.`,
      }
    }

    if (!action.allowedRoles.includes(request.role)) {
      return {
        decision: 'denied',
        action,
        reason: 'role_not_allowed',
        message: `Role "${request.role}" may not invoke "${action.id}"${deprecationNote}. Allowed: ${action.allowedRoles.join(', ')}.`,
      }
    }

    if (!satisfiesCapability(request.capability, action.requiresCapability)) {
      return {
        decision: 'denied',
        action,
        reason: 'capability_insufficient',
        message: `"${action.id}" needs the ${action.requiresCapability} capability; this client is ${request.capability}${deprecationNote}.`,
      }
    }

    if (action.level >= NEVER_AUTONOMOUS_LEVEL && request.humanApproved !== true) {
      return {
        decision: 'denied',
        action,
        reason: 'admin_action_requires_human',
        message: `"${action.id}" is ${action.level} and never runs autonomously. A human must approve it${deprecationNote}.`,
      }
    }

    if (request.availableOnPage === false) {
      return {
        decision: 'denied',
        action,
        reason: 'action_unavailable_on_page',
        message: `The current page does not offer "${action.id}"${deprecationNote}.`,
      }
    }

    if (action.confirmation === 'human_approval' && request.humanApproved !== true) {
      return {
        decision: 'confirmation_required',
        action,
        mode: 'human_approval',
        prompt: `"${action.id}" requires human approval: ${CONFIRMATION_PROMPTS[action.level]}`,
      }
    }

    if (action.confirmation === 'user_confirm' && request.confirmed !== true) {
      return {
        decision: 'confirmation_required',
        action,
        mode: 'user_confirm',
        prompt: `"${action.id}" needs your confirmation: ${CONFIRMATION_PROMPTS[action.level]}`,
      }
    }

    return { decision: 'allow', action }
  }

  /** Convenience predicate that never throws. */
  isAllowed(request: ActionRequest): boolean {
    return this.evaluate(request).decision === 'allow'
  }

  /**
   * The action ids that may be exposed to the model for a given context. This
   * is what bounds the provider's tool list: a capability can only ever see a
   * subset, and the page context can only shrink it.
   */
  availableActionIds(request: Omit<ActionRequest, 'actionId'>): readonly string[] {
    return this.registry
      .list()
      .filter((action) =>
        this.isAllowed({
          ...request,
          actionId: action.id,
          confirmed: true,
          humanApproved: true,
        }),
      )
      .map((action) => action.id)
  }
}
