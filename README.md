# Archava

A multi-tenant AI assistant platform where an assistant's behaviour is decided by
**data** rather than by prompt text, and where every decision it makes is auditable
against the policy that produced it.

The product requirement is `PRD.md`. The operational contract is `agent.md`.
The Decision Intelligence extension is described in [`docs/DECISION_INTELLIGENCE.md`](docs/DECISION_INTELLIGENCE.md).
This file is what the repository _actually_ does, which is a smaller thing than
either document, deliberately so. For the gap, see
[`docs/BUILD_STATUS.md`](docs/BUILD_STATUS.md) — it classifies every PRD area as
Implemented / Partially Implemented / Planned / Not Implemented and is the honest
answer to "is this production ready".

## What runs today

One vertical slice runs end to end, offline, in a browser:

```
pnpm install
pnpm dev            # http://127.0.0.1:4173 — reference tenant, chat surface
                  # /studio at http://127.0.0.1:4173/studio
```

It serves the reference tenant `client-xyz` — a hospitality template resort in
Indonesia, `commerce_booking` environment, `chat` presence, `act` capability,
region `ID`, currency `IDR`, locale `id` (`packages/reference/src/tenant.ts`). You
can talk to the assistant, it draws an `order_summary` and an `availability` card,
it highlights a room on the page, it answers from knowledge and from structured
truth, and it refuses a claim that neither source supports.

Both modes bind to `127.0.0.1:4173` — the host and port are `HOST`/`PORT` env
(`apps/web/src/server/server.ts`), and `pnpm e2e:home` defaults to the same URL
via `BASE`.

Production build and start:

```
pnpm build          # bundle the client into apps/web/dist
pnpm start          # serve the bundle
pnpm e2e:home       # 31 assertions against the served page
pnpm decision:eval  # 51-case offline Rule provider and routing evaluation
```

Optional Jev evaluation stays separate from those commands. After server-side
credential and data-term review, see [Jev eval readiness](docs/JEV_EVAL_READINESS.md)
for the explicit synthetic SHADOW command.

## The one idea

An assistant is only trustworthy if its answers are _checkable_. So the pipeline
is a sequence of boundaries, each of which holds a port, and each port is an
interface with implementations you can point at:

| Boundary                        | Port                               | In-tree implementation                                |
| ------------------------------- | ---------------------------------- | ----------------------------------------------------- |
| Conversation                    | `BrainProvider`                    | `ScriptedBrain`, `ReferenceBrain` (deterministic)     |
| Bounded judgment                | `DecisionProvider`                 | `RuleDecisionProvider`; Jev server adapter            |
| Retrieval                       | `KnowledgePort` / `KnowledgeStore` | `@archava/knowledge`, wired by `buildKnowledgeStore`  |
| Live facts                      | `StructuredTruthPort`              | `referenceTruth` (date-stated fixtures)               |
| "Does this id exist?"           | `EntityResolver`                   | `pageEntityResolver` (page-scoped)                    |
| "May I do it, and did it work?" | `ActionExecutor`                   | `pageExecutor` for UI; mocked Act booking/email ports |

The offline reference does not contact a model, a PMS, or a payment provider. The
new server-side Act executors have injected booking and email gateways and
end-to-end tests with fakes; the browser still does not book or send email. Where
a real system is absent, the browser returns a labelled non-execution rather
than a plausible-looking success.

Three rules the tests enforce, because each one is a failure mode that looks like
a pass:

1. **The absence of a resolver is a refusal, not a permission.** A check that can
   be skipped while still reporting `ok` is worse than no check.
2. **A stored price's scale comes from the currency contract, never from `Intl`.**
   `formatMoney(1_438_000, 'IDR', …)` is Rp 1.438.000 on every machine; CI and a
   laptop disagreed about this once, and the hundred-fold under-quote that
   followed is why `packages/config/src/currency.ts` declares a
   `CURRENCY_MINOR_UNIT_EXPONENTS` entry for every currency it accepts — IDR is
   0, USD is 2 — and `minorUnitExponent` throws on one it does not.
3. **An unreachable catalog is an answer of no.** A throw from the resolver fails
   the action closed, not open.

## Layout

```
packages/acl         query → intent → plan → response, and the ChatEvent vocabulary
packages/act         tenant-bound booking/email composition and dispatch
packages/act-booking authoritative booking gateway and executor port
packages/act-confirmation server-side one-time confirmation challenge
packages/act-confirmation-pg PostgreSQL challenge store and optional local verifier
packages/act-email   approved-template email gateway and executor port
packages/act-host    server-side visitor envelope, confirmation, and turn boundary
packages/act-postmark Postmark template-mail gateway with injected transport
packages/act-storage PostgreSQL attempt-store adapters and migration
packages/assistant   turn assembly: capability gate, §9 input contract, action execution
packages/adapters    BrainProvider implementations
packages/decision    bounded task catalogue, Rule provider, orchestrator
packages/chat        DOM renderers (shells, money, knowledge cards)
packages/config      pricebook / template / currency contracts, all Zod-parsed
packages/core        ChatEvent types shared by every surface
packages/knowledge   retrieval store and ranking
packages/pricing     deterministic quote engine
packages/reference   the reference tenant: fixtures, rates, knowledge, brain
packages/sdk         Archava Web SDK — page awareness graph for a host page
apps/web             the runnable server and the browser slice
tools/configurator   `pnpm configurator` — intake → config set, and `POST /api/quote`
tools/decision-eval  offline Rule eval and optional synthetic Jev SHADOW eval
tools/scripts        structure.mjs, verify.mjs (the honesty gate)
tools/e2e            home.mjs
```

## Gates

```
pnpm typecheck     # every package + the web app
pnpm lint          # eslint --max-warnings=0
pnpm format        # prettier
pnpm test          # vitest
pnpm verify        # install + structure + lint + typecheck + test + build
pnpm e2e:home      # 31 assertions against a served page
```

`pnpm verify` is the same list `pnpm test` runs, plus install, `pnpm structure`
and `pnpm build` — so "CI passed" and "`pnpm verify` passed" are one fact rather
than two. `pnpm structure` (`tools/scripts/structure.mjs`) is the gate that fails
if the runnable web app disappears, if a package boundary is violated by an
unlisted import, or if source reaches outside the workspace.

Nothing here gates the _prose_. This file and
[`docs/BUILD_STATUS.md`](docs/BUILD_STATUS.md) are maintained by hand, which is
the one place an honesty claim can go stale — so when reading either, read what
the gate output actually said rather than what the sentence claims.

## Status

Foundation complete; the commercial surface is not. Accepting a payment is the
acceptance criterion (`PRD.md` §34) and no code here does it. Read
[`docs/BUILD_STATUS.md`](docs/BUILD_STATUS.md) before quoting any of this.
