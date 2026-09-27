# Act pilot: booking and transactional email

Status: provider-neutral and tested with fakes. No external reservation or mail provider is connected. This is not the PRD §34 real Act acceptance milestone.

## Authority and path

The turn pipeline remains the only place an action is admitted:

ActionPolicy → user confirmation → input contract → tenant-scoped EntityResolver → ActionExecutor

DecisionProvider cannot grant Act, supply a verified entity, confirm an action, or report an execution. The new server-side dispatcher in packages/act routes only booking.create and email.send. The reference browser still runs its UI-only executor and remains offline.

BookingActionExecutor in packages/act-booking accepts a validated slot and customer reference and calls an injected BookingGateway. A success requires a confirmed, opaque booking reference returned by the authoritative system. Rejection, timeout, malformed reply, unavailable gateway and exception return safe failure with no automatic retry. The gateway must durably deduplicate tenant plus idempotency key; the in-test Map demonstrates the contract but is not a production store. Price and availability are never inferred from a DecisionProvider.

EmailActionExecutor in packages/act-email accepts only templateId and recipient. An injected tenant-scoped resolver must return an approved template and trusted sender from server configuration. The gateway receives that template and the idempotency key. Success means the provider durably accepted the message and returned an opaque id; it never means inbox delivery. A production gateway needs durable deduplication or an outbox. Unknown delivery outcome cannot be retried blindly.

Both executors validate their direct-call shape defensively, never echo gateway exceptions, recipient, customer notes, or provider payloads in public error messages, and return a failure for unsupported actions. Direct calls to these ports are not authorization; only the gated runTurn path may use them.

## What the tests prove

packages/act/test/workflow.test.ts exercises the real runTurn path with a fake authoritative entity resolver, booking gateway, template resolver and mail gateway. Assist capability, absent confirmation, missing or invalid resolver, invalid input and missing executor cannot produce a successful side effect. Act plus confirmation and valid entities reaches a fake gateway and records its confirmed/accepted outcome. Package tests cover malformed provider replies, tenant scoping, idempotency replay/conflict, unknown outcomes, and PII-safe output.

These are offline safety and integration tests. They do not prove a PMS reservation, durable production deduplication, email acceptance by an actual provider, recipient delivery, production tenant isolation, or a real user confirmation surface.

## Production completion path

1. Choose the target tenant's booking system and mail provider from actual tenant requirements; verify each current official API and idempotency semantics.
2. Build server-side adapters, durable idempotency/outbox storage, authoritative slot/customer/template resolution, tenant credential isolation, and provider-specific error mapping.
3. Connect a real confirmation UI and a server host that injects ActActionExecutor only for approved tenants. Keep credentials out of browser bundles.
4. Run controlled external booking and email tests, prove replay and recovery after ambiguous timeout, then update PRD §34 delivery status. Keep payment and Transact separate.
