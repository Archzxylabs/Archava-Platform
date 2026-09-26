# Build status

An honest classification of every area of `PRD.md` against this tree. The four
labels mean:

| Label                     | Means                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Implemented**           | works today, in this tree, offline, and a gate would fail if it stopped working                                             |
| **Partially Implemented** | the mechanism exists and is exercised, but only through an in-tree stand-in, or only for one tenant, or only on one surface |
| **Planned**               | named in the PRD's intended baseline, and _absent_ from the tree — no code, no dependency, no configuration                 |
| **Not Implemented**       | neither present nor scheduled; stopping at this boundary is a deliberate position                                           |

Where a claim below rests on evidence, the evidence is a file path. Where it
rests on the absence of something, that absence was verified rather than
assumed: no `package.json` in the workspace declares an external service SDK —
not one of the thirteen files. The only _runtime_ dependencies in the whole
workspace are `@archava/*` and `zod`; every other dependency in every manifest
(eslint, prettier, typescript, typescript-eslint, vitest, tsx, esbuild,
@vitest/coverage-v8, eslint-plugin-react-hooks, @eslint/js) is a
devDependency. See _External baselines_ below.

## The short version

One vertical slice runs end to end in a browser, offline, for one reference
tenant. The pipeline's decisions are real and fully visible: retrieval,
structured truth, the capability gate, §9 input validation, entity resolution,
and execution each happen in code with a test beside them. The **commercial
surface does not exist**. There is no payment integration, no PMS integration,
and no real executor for any action that changes a tenant's data.

The PRD's acceptance criterion is `PRD.md` §34: _Act_ can complete one
booking/CRM/email workflow; _Transact_ can complete one full payment →
confirmation → receipt workflow. This tree completes neither. It reaches
`payment.initiate` and stops, for two independent reasons that are worth
stating plainly:

1. `payment.initiate` has no registered input contract, so §9 refuses it —
   `No input contract` — before anything else is consulted.
2. There is no `ActionExecutor` in the tree that could perform it. `pageExecutor`
   (`apps/web/src/surface.ts:217`) is a `ui.*` executor and answers
   `not_a_page_action` for anything else.

That is the whole answer to "is this production ready": the pipeline is, and the
product is not.

## Implemented

| Area                                                                        | Evidence                                                                                                                |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Action registry with levels, confirmation modes, L5 never-autonomous        | `packages/acl/src/actions.ts` — 24 baseline actions, `ACTION_LEVELS` at :18, `NEVER_AUTONOMOUS_LEVEL` in `policy.ts:46` |
| Role model with baseline role definitions                                   | `packages/acl/src/roles.ts` — `ROLE_NAMES` at :44                                                                       |
| Capability gate with closed denial-reason vocabulary                        | `packages/acl/src/policy.ts` — `DENIAL_REASONS` at :48, `PolicyResult` at :90                                           |
| Field masking with four strategies                                          | `packages/acl/src/mask.ts` — `MASK_STRATEGIES` at :15                                                                   |
| Turn assembly: mask → plan → answer → gate → validate → execute             | `packages/assistant/src/turn.ts` — `runTurn` at :914                                                                    |
| Context-graph projection that cannot leak a form value                      | `turn.ts:221` `projectContextGraph` — the graph carries field _names_, not field values                                 |
| Declarative §9 input contracts                                              | `packages/assistant/src/validation.ts` — `INPUT_SCHEMAS` at :181, 12 of 24 actions                                      |
| Entity resolution with fail-closed semantics                                | `validation.ts:48` `EntityResolver`; tests in `packages/assistant/test/validation.test.ts`                              |
| Three-field action outcome (`policy` / `execution` / `output`)              | `packages/assistant/src/execution.ts`                                                                                   |
| Zod-parsed context graph and event reducer                                  | `packages/core/src/context-graph.ts`                                                                                    |
| Retrieval store with ranking                                                | `packages/knowledge/src/{store,retrieval}.ts`                                                                           |
| Deterministic quote engine with rounding rules                              | `packages/pricing/src/{engine,rounding}.ts`                                                                             |
| Currency contract with explicit minor-unit exponents                        | `packages/config/src/currency.ts`; `packages/chat/src/money.ts`                                                         |
| Chat DOM renderers including money                                          | `packages/chat/src/{dom,view,money,styles}.ts`                                                                          |
| SDK that builds a page awareness graph                                      | `packages/sdk/src/{page,session,consent}.ts`                                                                            |
| Reference tenant with fixtures, rates, knowledge, brain                     | `packages/reference/src/{tenant,rates,knowledge,brain}.ts`                                                              |
| Runnable web app: chat surface and Studio route                             | `apps/web/src/server/server.ts` — both serve 200; `/` and `/studio` checked                                             |
| One stateless HTTP endpoint                                                 | `POST /api/quote` (`apps/web/src/server/api.ts`)                                                                        |
| Configurator: intake → normalised → variants/recommendation/budget → config | `tools/configurator/src/*.ts`, `pnpm configurator`                                                                      |
| Structural honesty gate                                                     | `tools/scripts/structure.mjs` — app exists, `@archava/*` imports are declared, no filesystem escapes                    |
| Full gate chain, same order as CI                                           | `tools/scripts/verify.mjs`                                                                                              |
| Browser E2E against the served page                                         | `tools/e2e/home.mjs` — 31 assertions, passing                                                                           |
| GitHub Actions CI                                                           | `.github/workflows/ci.yml`                                                                                              |

## Partially Implemented

The mechanism is real and tested; what is behind it is a stand-in.

| Area                                     | What exists                                                                                                                      | What is missing                                                                                                                     |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Conversation (`BrainProvider`)           | `ScriptedBrain` and `ReferenceBrain` — deterministic, keyword-matched, with an explicit fallback sentence                        | a model client. Nothing in the tree calls one                                                                                       |
| Retrieval (`KnowledgePort`)              | `buildKnowledgeStore` (`packages/reference/src/knowledge.ts:224`) + `retrieveContext`                                            | a hosted index, embeddings, incremental ingest. The store is in memory and built at request time                                    |
| Live facts (`StructuredTruthPort`)       | `referenceTruth` (`packages/reference/src/rates.ts:421`) — date-stated fixtures                                                  | a PMS or inventory service. Prices and availability are fixtures, not live                                                          |
| "Does this id exist?" (`EntityResolver`) | `pageEntityResolver` (`apps/web/src/surface.ts:142`) — answers from the rendered page, kind `pageEntity`                         | a tenant catalog. The resolver can only confirm what the page is already showing                                                    |
| Execution (`ActionExecutor`)             | `pageExecutor` (`apps/web/src/surface.ts:217`) — `ui.highlight`, `ui.compare`                                                    | every other executor. A booking, an email, a payment, a CRM write: none exist, and the stand-in labels them rather than faking them |
| Confirmation and human approval          | `confirmedActionIds`, `declinedActionIds`, `humanApprovedActionIds`, `handoffRequested` on `TurnRequest`; gate reasons emit them | an operator console. In the reference slice these are supplied by the caller, so no real person ever approves anything              |
| Multi-tenancy                            | `assertTenant` at the seam (`apps/web/src/slice.ts:160`); tenant id never travels inside a payload                               | provisioning, per-tenant configuration at runtime, database-level isolation. One tenant ships                                       |
| Analytics                                | `AnalyticsEvent`s on every `TurnOutcome` (`packages/assistant/src/analytics.ts`)                                                 | anywhere to send them. No PostHog, OTel, Phoenix or Sentry                                                                          |
| SDK integration                          | graph building, consent, session                                                                                                 | a real host page shipped by a tenant. The reference page is the only consumer                                                       |
| Configurator                             | a config set and a quote                                                                                                         | persistence and tenant provisioning. "Built" means the file exists                                                                  |
| Handoff to a human                       | `HandoffContext` and `packages/assistant/src/handoff.ts`                                                                         | a channel to a human. The request is modelled; nothing is delivered                                                                 |
| Auth and authorisation                   | roles and tiers as data                                                                                                          | authentication of any kind. No login exists in the tree                                                                             |

## Planned

Everything in this section is named in the PRD's intended technical baseline
(`PRD.md` §22) and is **absent from the tree**: no code, no dependency, no
configuration, no feature flag. This section exists because a missing
integration that nobody has written down keeps getting assumed to exist.

The PRD itself sets the ground rule for how to talk about these
(`PRD.md` §68): _the client does not buy "Spatius integration", "LiveKit
integration", "Gemini integration", or a bundle of APIs. Provider names are
implementation details unless the client asks for technical/procurement
disclosure._ So none of the rows below is a commitment, and none of them is
done.

**AI and model providers**

- A real `BrainProvider` backed by a Gemini Live-class model, behind the adapter
  the PRD names (`PRD.md` §22, :1054)
- Embeddings from an embedding-class provider for retrieval (:965)
- A realtime transport: LiveKit, with client-side rendering and a LiveKit Agents
  integration (:1053, :1104)
- Human rendering: a Spatius-class avatar provider behind a provider adapter
  (:1055, :1443) — the PRD is explicit that the provider must not be hardcoded
  outside the adapter
- Voice, avatar and realtime session orchestration

**Data and infrastructure**

- Neon PostgreSQL, pgvector, Drizzle — the persistence layer does not exist at
  all; there is no database client in the tree
- Upstash Redis, Cloudflare R2
- Payload CMS
- Nx, Next.js, Tailwind + shadcn, Storybook (the web app is a hand-written
  esbuild bundle and two HTML pages)
- Infisical for secrets

**Workflows, messaging and commerce**

- Trigger.dev for durable background workflows
- Email delivery (Postmark or equivalent)
- Payment providers: Midtrans, Xendit, Stripe
- Booking and commerce systems: Cal.com, Shopify, WooCommerce, Medusa
- CRM and ERP: a CRM, ERPNext

**Observability and security tooling**

- PostHog, OpenTelemetry, Arize Phoenix, Sentry
- Playwright, k6, Semgrep, Trivy, OWASP ZAP

## Not Implemented

Deliberately absent, and worth naming so nobody reads a silence as a TODO.

| Area                                                | Position                                                                                                                                                                                            |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accepting a payment                                 | The §34 acceptance criterion. No code in this tree does it, and nothing in the tree is on a path toward it beyond the gate and the contract slot where it would plug in                             |
| Refunds and cancellations that move money           | `order.cancel_refund` is in the action registry with no input contract, so §9 refuses it                                                                                                            |
| Autonomous high-risk actions                        | `PRD.md` §5 lists this as an explicit non-goal: no autonomous high-risk payments or refunds without an explicit authorization policy. `L5` (`NEVER_AUTONOMOUS_LEVEL`) is the code form of that rule |
| Cross-tenant data access                            | Enforced by construction — the tenant comes from the turn, never from a payload — but only because there is no shared store yet                                                                     |
| Offline business workflows decoupled from a session | Not started                                                                                                                                                                                         |

## What "Implemented" is worth here

Two things this tree does that a scaffold does not, both of which a gate
enforces:

1. **Ports return promises by contract**, not by accident
   (`packages/assistant/src/turn.ts:85-107`). A caller that could treat a result
   as an already-present value is a caller that could skip an `await` and quote a
   cached price as live.

2. **Missing machinery refuses rather than permits.** A missing entity resolver
   is a refusal. A missing input contract is a refusal. A throwing resolver is a
   refusal. A missing executor leaves the action `not_attempted`. In each case
   the code returns a labelled failure with a reason, because a check that can be
   skipped while still reporting `ok` is worse than no check at all.

The other direction matters too: a stored price's scale comes from the currency
contract, never from `Intl` — `formatMoney(1_438_000, 'IDR', …)` is Rp 1.438.000
on every machine. That rule exists because CI and a laptop disagreed about it
once, and the hundred-fold under-quote that followed is why
`packages/config` declares a minor-unit exponent for every currency.

## How to verify this document

```
pnpm typecheck     # every package + the web app
pnpm lint          # eslint --max-warnings=0
pnpm test          # vitest
pnpm verify        # install + structure + lint + typecheck + test + build
pnpm build && pnpm start
pnpm e2e:home      # 31 assertions against the served page
```

Nothing mechanically gates the prose in this file. `pnpm structure` gates the
tree — the runnable app must exist, imports must be declared, nothing may
escape the workspace — but the classifications above are maintained by hand. If
a row here stops matching the tree, the row is wrong, and the fix is to correct
the row.
