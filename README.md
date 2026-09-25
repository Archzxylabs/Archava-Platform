# Archava

A multi-tenant AI assistant platform where an assistant's behaviour is decided by
**data** rather than by prompt text, and where every decision it makes is auditable
against the policy that produced it.

The product requirement is `PRD.md`. The operational contract is `agent.md`.
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
```

## The one idea

An assistant is only trustworthy if its answers are _checkable_. So the pipeline
is a sequence of boundaries, each of which holds a port, and each port is an
interface with a single implementation you can point at:

| Boundary                        | Port                               | In-tree implementation                               |
| ------------------------------- | ---------------------------------- | ---------------------------------------------------- |
| Conversation                    | `BrainProvider`                    | `ScriptedBrain`, `ReferenceBrain` (deterministic)    |
| Retrieval                       | `KnowledgePort` / `KnowledgeStore` | `@archava/knowledge`, wired by `buildKnowledgeStore` |
| Live facts                      | `StructuredTruthPort`              | `referenceTruth` (date-stated fixtures)              |
| "Does this id exist?"           | `EntityResolver`                   | `pageEntityResolver` (page-scoped)                   |
| "May I do it, and did it work?" | `ActionExecutor`                   | `pageExecutor` (`ui.*` only)                         |

Nothing in the tree contacts a model, a PMS, or a payment provider. Every port is
real, and every implementation is an honest in-tree stand-in that says so. Where a
real system would sit, the code returns a labelled failure rather than a
plausible-looking success — see `pageExecutor`, which will highlight a room and
will not book one.

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
packages/assistant   turn assembly: capability gate, §9 input contract, action execution
packages/adapters    BrainProvider implementations
packages/chat        DOM renderers (shells, money, knowledge cards)
packages/config      pricebook / template / currency contracts, all Zod-parsed
packages/core        ChatEvent types shared by every surface
packages/knowledge   retrieval store and ranking
packages/pricing     deterministic quote engine
packages/reference   the reference tenant: fixtures, rates, knowledge, brain
packages/sdk         Archava Web SDK — page awareness graph for a host page
apps/web             the runnable server and the browser slice
tools/configurator   `pnpm configurator` — intake → config set, and `POST /api/quote`
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
