# Architecture

What the pipeline is, and where the boundaries are. This document describes the
tree as it is; for what the tree does not yet do, see
[`BUILD_STATUS.md`](BUILD_STATUS.md).

## The shape

A turn is a sequence of boundaries. Each boundary holds a **port** — an
interface, in TypeScript, with exactly one implementation in the tree — and each
implementation is an honest in-tree stand-in that says what it is standing in
for.

```
browser (SDK)                 packages/assistant                packages/acl
─────────────                 ─────────────────                 ────────────
context graph ──────▶ mask / project ──▶ BrainProvider.plan ──▶ ActionPolicy
(ids, names, flags,              (§16 masking)        │            decide
 never form values)                                   ▼
                              KnowledgePort.retrieve ─┐
                              StructuredTruthPort ────┤ answer + components
                                                      ▼
                              validateActionInputs (§9) ──▶ EntityResolver
                                                      ▼
                              ActionExecutor.execute (§18) ──▶ side effect
                                                      ▼
                                        TurnOutcome ──▶ chat renderers
```

Every port returns a promise. That is a deliberate contract
(`packages/assistant/src/turn.ts:85-107`): a port that may return synchronously
is a port whose result can be consumed without anyone noticing it had not
arrived, and a caller that could tell the difference from the outside is a caller
that could skip an `await`.

## The ports

| Port                  | Declared                                  | In-tree implementation                                                                                                                       | What it would be in production |
| --------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `BrainProvider`       | `packages/assistant/src/turn.ts`          | `ScriptedBrain`, `ReferenceBrain` — deterministic fixtures (`packages/adapters/src/brain.ts`)                                                | a model client                 |
| `KnowledgePort`       | `turn.ts:85`                              | `@archava/knowledge` — `retrieveContext(request, store)`, wired by `buildKnowledgeStore(config)` (`packages/reference/src/knowledge.ts:224`) | a hosted index                 |
| `StructuredTruthPort` | `turn.ts:103`                             | `referenceTruth` — date-stated fixtures (`packages/reference/src/rates.ts:421`)                                                              | an inventory / pricing service |
| `EntityResolver`      | `packages/assistant/src/validation.ts:48` | `pageEntityResolver` (`apps/web/src/surface.ts:142`) — page-scoped                                                                           | a tenant catalog               |
| `ActionExecutor`      | `packages/assistant/src/execution.ts`     | `pageExecutor` (`apps/web/src/surface.ts:217`) — `ui.*` only                                                                                 | the tenant's real systems      |

Nothing in the tree contacts a model, a PMS, or a payment provider. `pageExecutor`
is the clearest example of the rule: it will highlight a room and it will not
book one. It answers `not_a_page_action` — _"This page can only draw on itself;
a browser may not perform that action."_ — for anything a browser is not entitled
to do on a tenant's behalf. Where a real system would sit, the code returns a
labelled failure rather than a plausible-looking success.

## What a turn actually does

`runTurn` (`packages/assistant/src/turn.ts:914`) takes a `TurnRequest` and
returns a `TurnOutcome`. The order matters, and each step fails closed:

1. **Mask, then project.** `projectContextGraph` (`turn.ts:221`) emits route,
   page kind, section, locale, and entity `{id, name}` — never a form value,
   because the graph carries field _names_ and not field values. A value cannot
   be projected because it was never carried. Masking strategies are
   `preserve | redact | partial | tokenise` (`packages/acl/src/mask.ts:15`).

2. **Ask the brain.** The provider returns an answer, optional generative
   components, and optional action requests. A brain that cannot support a
   claim is recorded as a `knowledgeGap`, not glossed.

3. **Answer from knowledge or structured truth.** `basis` is one of
   `structured_truth | retrieval | none` — the outcome states which, so a reader
   can tell a live value from a corpus answer from a refusal.

4. **Gate the actions** (`packages/acl/src/policy.ts`). Levels `L0`–`L5`
   (`packages/acl/src/actions.ts:18`), roles `archava_assistant | owner | admin
| editor | viewer`, capability tiers `assist | act | transact | enterprise`
   (`packages/config/src/pricing/types.ts:8`). `L5` is `NEVER_AUTONOMOUS`. The
   result is a decision plus a reason — `DENIAL_REASONS` is a closed list, so a
   refusal is never a bare boolean.

5. **Validate the inputs** `validateActionInputs` (`validation.ts:289`). A
   declarative contract per action id checks types, required fields, and that no
   `tenantId` travelled inside the payload. The registry names 24 actions
   (`packages/acl/src/actions.ts`); 12 of them carry a contract
   (`INPUT_SCHEMAS`, `validation.ts:181`). The other 12 are refused outright —
   `No input contract` — and they are not a random sample: `payment.initiate`,
   `payment.status.read`, `checkout.start`, `order.confirm` and
   `order.cancel_refund` are all in that half. A commercial action cannot run
   here because there is no contract for it, which is a stronger statement than
   "we have not wired it up yet".

6. **Resolve the entity ids.** Every contract field that names a tenant-catalog
   entity — at any depth, including `customer.customerRef` nested inside
   `booking.create` — is put to the `EntityResolver`, which is asked with the
   _turn's_ tenant.

7. **Execute** (`packages/assistant/src/execution.ts`). Only if an executor was
   supplied, and only for actions the gate allowed and §9 confirmed.

## Three fields, not one

`GatedAction` separates what a gate permitted from what an executor confirmed:

```ts
policy:     'allowed' | 'denied' | 'confirmation_required' | 'requires_human_approval'
execution:  'not_attempted' | 'succeeded' | 'failed'
output:     what the executor returned, when it ran
```

An action can be `allowed` and still `not_attempted`. The reference slice leaves
the executor out of the turn entirely, so every allowed action on the page is
`not_attempted` — which is the truth. Collapsing these into one flag is how a
booking gets reported as existing because it _would have_ been booked.

## The rules the tests enforce

These are not style preferences. Each one is a failure mode that looks like a
pass, and each has a test file that exists to stop it returning.

**The absence of a resolver is a refusal, not a permission.**
`packages/assistant/test/validation.test.ts` states the contract as a table
rather than enumerating the module, so a drifted action id fails loudly. A
validator that returns `ok` when no resolver was supplied passes every shape
test it has — the inputs are the right types, the required fields are present,
the tenant id is not in there — and an action executes with an id nobody ever
checked. `ui.highlight` / `ui.compare` are held to the same rule against the
page's own resolver, with the kind name observed rather than assumed, because a
kind typed differently from the one the resolver checks is the same hole wearing
a different hat.

**A stored price's scale comes from the currency contract, never from `Intl`.**
`packages/chat/test/money.test.ts` fixes `amountMinor: 1_438_000` and asserts the
digit count is identical in every locale `Intl` will accept, including one it
does not know (`xx-YY`) and one that renders non-Latin numerals (`ar-EG`, pinned
by `\p{Nd}` rather than `\d`). The divisor used to be read from
`Intl.NumberFormat(...).formatToParts(1)`, which made a _stored_ price depend on
the ICU dataset of the machine printing it: CI proved it — IDR gained two
fraction digits on the runner and lost them on the laptop that wrote the code,
so the same amount meant Rp 1.438.000 in one place and Rp 14.380,00 in the other.
Same input, two prices, and no single-machine gate could see it.

**An unreachable catalog is an answer of no.**
A throw from the resolver resolves to `ok: false` pointing at the id that went
unanswered, not an uncaught exception and not a yes. The refusal is _about the
id_, because that is the question that went unanswered; field `*` would suggest
the whole action was refused for a generic reason.

## The browser side

```
apps/web/src/
  server/server.ts    HOST/PORT (default 127.0.0.1:4173), three modes
  server/api.ts       POST /api/quote — the only HTTP endpoint
  slice.ts            createSlice(): wires every port for the reference tenant
  page.ts             bootstraps the SDK against the served page
  dom-bridge.ts       SDK events → context graph
  surface.ts          pageEntityResolver, pageExecutor
  main.ts / studio.ts the two entry points (chat surface, Studio)
```

The server holds no conversation state. `pnpm dev` compiles both bundles into
memory; `pnpm build` writes `apps/web/dist/{app.js,studio.js}`; `pnpm start`
serves those. Everything else — the awareness graph, the turn, the rendering —
runs in the visitor's browser against a graph the page produced.

`POST /api/quote` is the only HTTP endpoint, and it is stateless: a POST in, a
response out, nothing kept. The body is `{ intake, branding?, updatedAt?,
allowedOrigins? }`. A valid intake returns a variant set — `recommended`,
`lean` and `full` quotes, a recommendation, a budget verdict and the
`selectionReason` that produced it — and, when `branding` and `updatedAt` are
supplied, an emitted `ClientConfig` (`schema_version`, `tenantId`,
`environment`, `presence`, `capability`, `region`, `template`, …). Two
identical posts return byte-identical variant sets, which is what makes a quote
reproducible from a saved intake. It refuses in the other directions too: a
`GET` is `405` ("A quote is a submission, not a fetch."), a body that is not
JSON or not an object is `400`, and an invalid intake is `400` carrying the
per-field Zod issues — the intake schema is `.strict()` and camelCase.

The SDK (`packages/sdk`) reduces host-page events into a `ContextGraph`:
`seedContextGraph` → `reduceContextGraph` / `foldContextEvents` →
`actionableContext` → `parseContextGraph` (`packages/core/src/context-graph.ts`).
The graph is Zod-parsed on the way in, so a host page cannot hand the pipeline
an arbitrary object.

## The tools

- `tools/configurator` (`pnpm configurator`) — intake → normalised → variants /
  recommendation / budget → built client config. `pnpm configurator` is the CLI
  entry at `tools/configurator/src/cli.ts`.
- `tools/scripts/structure.mjs` (`pnpm structure`) — the honesty gate on the
  tree: the runnable web app must exist, every `@archava/*` specifier in source
  and tests must be a declared dependency, and no file may reach outside the
  workspace.
- `tools/scripts/verify.mjs` (`pnpm verify`) — install + structure + lint +
  typecheck + test + build, the same list in the same order as CI, so "CI
  passed" and "`pnpm verify` passed" are one fact rather than two. It adds no
  checks of its own.
- `tools/e2e/home.mjs` (`pnpm e2e:home`) — drives the served page in a browser
  and asserts against `BASE` (default `http://127.0.0.1:4173`).

## Package graph

```
core      ChatEvent vocabulary, ContextGraph schemas, tenant shape
config    pricebook / template / currency contracts — all Zod-parsed
pricing   deterministic quote engine (+ rounding rules)
acl       action registry, roles, capability gate, masking
knowledge retrieval store, ranking, structured-truth port shape
assistant turn assembly: mask, gate, §9 validation, execution, outcome
adapters  BrainProvider and presence/renderer adapters
chat      DOM renderers: shells, money, knowledge cards
reference the reference tenant: fixtures, rates, knowledge, brain
sdk       page awareness graph for a host page
+ apps/web, tools/configurator
```

Dependencies point inward: `reference` may depend on everything; `core` depends
on nothing but `zod`. `pnpm structure` enforces this, so a boundary violation is
a gate failure rather than a code-review opinion.
