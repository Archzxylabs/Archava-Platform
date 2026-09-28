# Act pilot: booking and transactional email

Status: provider-neutral and tested with fakes. No external reservation or mail provider is connected. This is not the PRD §34 real Act acceptance milestone.

## Authority and path

The turn pipeline remains the only place an action is admitted:

ActionPolicy → user confirmation → input contract → tenant-scoped EntityResolver → ActionExecutor

DecisionProvider cannot grant Act, supply a verified entity, confirm an action, or report an execution. The new server-side dispatcher in packages/act routes only booking.create and email.send. The reference browser still runs its UI-only executor and remains offline.

BookingActionExecutor in packages/act-booking accepts a validated slot and customer reference and calls an injected BookingGateway. A success requires a confirmed, opaque booking reference returned by the authoritative system. Rejection, timeout, malformed reply, unavailable gateway and exception return safe failure with no automatic retry. The gateway must durably deduplicate tenant plus idempotency key; the in-test Map demonstrates the contract but is not a production store. Price and availability are never inferred from a DecisionProvider.

EmailActionExecutor in packages/act-email accepts only templateId and recipient. An injected tenant-scoped resolver must return an approved template and trusted sender from server configuration. The gateway receives that template and the idempotency key. Success means the provider durably accepted the message and returned an opaque id; it never means inbox delivery. A production gateway needs durable deduplication or an outbox. Unknown delivery outcome cannot be retried blindly.

Both executors validate their direct-call shape defensively, never echo gateway exceptions, recipient, customer notes, or provider payloads in public error messages, and return a failure for unsupported actions. Direct calls to these ports are not authorization; only the gated runTurn path may use them.

## Replay and recovery hardening

`BookingReplayBoundary` and `EmailOutboxBoundary` are optional server-side wrappers around the corresponding gateway ports. Each claims a tenant-scoped idempotency key before its first write, records the outcome through an injected attempt store, and handles replays without sending a second write. Unknown outcomes remain unknown until a read-only authoritative reconciliation returns a verified booking reference or email acceptance receipt. The booking and email fingerprints are keyed digests; the attempt records do not store customer notes or recipient addresses. A deployment must provide a stable secret, atomic durable claim and settlement operations, and tenant-credentialed reconciliation ports. The in-memory stores in tests demonstrate the interface only.

`composeTenantActExecutor` now constructs both wrappers before installing the booking and email executors, requires every gateway, store, read-only status port and server key, and refuses another tenant's request before any port call. The raw dispatcher remains available to existing reference tests. No production server host calls this factory yet, so durable replay behavior remains a deployment requirement. Email `accepted` remains distinct from delivered.

`@archava/act-storage` supplies PostgreSQL-backed implementations of both attempt-store ports, an explicit migration, and an injected SQL-client seam. The migration gives each `(tenant, action kind, idempotency key)` one atomic claim and uses conditional updates for settlement. The adapter keeps the public idempotency key at the port boundary while storing a keyed digest in SQL; that digest key must be server-only and stable for the full replay lifetime. Its optional `verify:sql` command checks the migration and concurrent operations against a disposable local PostgreSQL cluster. It does not connect a production database or provider.

The upstream `buildIdempotencyKey` includes canonicalized inputs. The attempt-store adapter protects that key at rest, but provider adapters and observability sinks must likewise transform it to an opaque keyed value before sending or logging it. A key rotation without an old-key lookup or migration would make old attempts invisible and void replay protection.

`@archava/act-confirmation` supplies an opaque, short-lived challenge bound to tenant, session, action and validated input digest. Its store port must atomically consume a challenge once. It is not yet wired into the turn host: `runTurn` still accepts `confirmedActionIds` from its caller, and the reference browser confirmation card is only a UI demonstration. A production host must ignore browser-supplied confirmation flags, verify the challenge on the server, and derive the flag only from a matching verified receipt. It must also preserve the same turn identity and `occurredAt` across retries so the idempotency key does not change.

## What the tests prove

packages/act/test/workflow.test.ts exercises the real runTurn path with a fake authoritative entity resolver, booking gateway, template resolver and mail gateway. Assist capability, absent confirmation, missing or invalid resolver, invalid input and missing executor cannot produce a successful side effect. Act plus confirmation and valid entities reaches a fake gateway and records its confirmed/accepted outcome. Package tests cover malformed provider replies, tenant scoping, idempotency replay/conflict, unknown outcomes, and PII-safe output.

These are offline safety and integration tests. The optional local PostgreSQL verifier checks database behavior, but does not prove a production deployment. No test here proves a PMS reservation, email acceptance by an actual provider, recipient delivery, production tenant isolation, or a real user confirmation surface.

## Production completion path

1. Choose the target tenant's booking system and mail provider from actual tenant requirements; verify each current official API and idempotency semantics.
2. Connect the attempt stores to the selected production database with a stable key and retention policy; build provider adapters, authoritative slot/customer/template resolution, tenant credential isolation, and provider-specific error mapping.
3. Build a server host that issues and atomically consumes confirmation challenges, derives trusted turn confirmation, and injects the composed executor only for approved tenants. Keep credentials out of browser bundles.
4. Run controlled external booking and email tests, prove replay and recovery after ambiguous timeout, then update PRD §34 delivery status. Keep payment and Transact separate.
