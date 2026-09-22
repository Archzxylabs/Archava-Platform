/**
 * @archava/acl
 *
 * Action registry, baseline roles, the server-side policy gate, and
 * sensitive-field masking. This package is the authority on whether an action
 * may run; nothing downstream of it may re-decide that question.
 */
export * from './actions.js'
export * from './roles.js'
export * from './policy.js'
export * from './mask.js'

import { ActionRegistry } from './actions.js'
import { ActionPolicy } from './policy.js'

/** The shared default instances. */
export const actionRegistry = new ActionRegistry()
export const actionPolicy = new ActionPolicy(actionRegistry)
