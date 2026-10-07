/**
 * @archava/act — the server-side Act dispatch and composition seam.
 *
 * Two things live here, deliberately separated:
 *
 * `ActActionExecutor` dispatches one action id to the one executor that owns it.
 * It decides nothing about whether the action may run: capability, role, user
 * confirmation, entity resolution and input validation all happen in the
 * assistant turn pipeline before a request reaches this port, and a direct call
 * to it is not an authorization decision.
 *
 * `composeTenantActExecutor` is where a deployment states which tenant's
 * gateways, stores and keys this executor may use. It requires the booking
 * replay and email outbox wrappers, binds the executor to its tenant, and
 * refuses an incomplete configuration instead of half-honouring it.
 */
export { ActActionExecutor } from './dispatcher.js'
export {
  ACT_COMPOSITION_FAULTS,
  ActCompositionRefusal,
  type ActCompositionFault,
} from './guards.js'
export {
  composeTenantActExecutor,
  type TenantActConfiguration,
  type TenantActExecutor,
} from './composition.js'
