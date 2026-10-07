# Archava delivery progress

**Baseline:** 27 September 2026, before a1–a3 Decision Intelligence results are audited.

**Target:** Archava v1 commercial readiness in `PRD.md` §34, including the platform needed to operate it.

**Current estimate after Act pilot audit:** **about 30% weighted delivery coverage. Release readiness: not met.**

**Source consolidation, 7 October 2026:** Decision Intelligence, Act host/storage/
confirmation/Postmark packages, the website and local CRM/ERP frontend, and the
portable voice/avatar template now share one source tree. The 30% figure remains
the last audited commercial score; the historical scorecard below does not yet
score the standalone template or new frontend. Source consolidation does not
establish shared Chat/Voice/Human intelligence, live Act/Transact, authentication,
CRM/ERP integration, or production deployment. The operational-readiness tasks
remain pending in `delegation/act-operational-readiness/`.

The audited Decision Intelligence line moves from 10% to **65%**: contracts, Rule provider, orchestrator, three modes, five tasks, assistant/reference integration, offline evaluation, metadata observability, and mocked Jev adapter are verified. Live Jev behavior, provider data terms, production telemetry and service hosting remain open. Its 8-point weighted contribution moves from 0.80 to 5.20, lifting the total from **24.15** to **28.55/100 ≈ 29%**. Other lines keep their baseline scores because this phase did not deliver voice, avatar, real Act/Transact workflows, tenant operations, or production deployment. This estimate is independent of the Rule provider's eval accuracy.

The next Act pilot adds tenant-scoped booking and email executor ports plus mocked
`runTurn` integration. Its estimated line coverage moves from 10% to **25%**,
adding 1.50 weighted points: **30.05/100 ≈ 30%**. No external booking or
email was performed, so the PRD §34 real Act gate remains open. The optional
Jev SHADOW eval command is ready but has not made a live request; Decision
Intelligence stays at 65%.

The later replay/outbox and evidence-evaluation hardening improves offline safety coverage but does not add a real provider, durable store, or live evaluation. The weighted estimate therefore remains about 30% until those external and operational claims can be verified.

This is a planning estimate, not a measurement of code volume, test count, developer productivity, revenue, or runtime performance. The weights express how much each line contributes to the target. A passing unit test raises a line only when it proves the relevant user or operator capability. Mocked integrations and reference fixtures are labelled as such.

## Baseline scorecard

| Delivery line                                         |   Weight | Coverage |       Weighted points | Evidence and principal gap                                                                                                                     |
| ----------------------------------------------------- | -------: | -------: | --------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Product specification and architecture                |       5% |      75% |                  3.75 | `PRD.md`, `agent.md`, `docs/ARCHITECTURE.md`; Decision Intelligence addendum and production architecture remain open.                          |
| Core context, knowledge, policy, and turn pipeline    |      12% |      50% |                  6.00 | `packages/core`, `knowledge`, `acl`, `assistant`; offline turn works, authoritative production systems do not.                                 |
| Decision Intelligence                                 |       8% |      10% |                  0.80 | Uncommitted `DecisionProvider` port and tests only; orchestration, runtime integration, Jev adapter, and eval results are pending.             |
| Chat, web SDK, and reference browser                  |       8% |      50% |                  4.00 | `packages/chat`, `sdk`, `apps/web`, `tools/e2e`; one offline tenant/reference slice, no deployed multi-tenant product.                         |
| Voice and realtime conversation                       |      10% |       0% |                  0.00 | No LiveKit/realtime voice runtime.                                                                                                             |
| Human avatar presence                                 |       8% |       0% |                  0.00 | No live avatar rendering or Human preflight/runtime fallback.                                                                                  |
| Act workflows and external integrations               |      10% |      10% |                  1.00 | Policy/validation/executor boundaries exist; no real booking, CRM write, or email workflow completes.                                          |
| Transact, payment, and receipts                       |      12% |       5% |                  0.60 | Action vocabulary and safety boundaries exist; no payment or receipt integration.                                                              |
| Tenant persistence, admin, and isolation in operation |      10% |      10% |                  1.00 | Tenant-scoped shapes and reference checks exist; no shared database, provisioning, auth, or client admin.                                      |
| Studio and commercial configurator                    |       7% |      50% |                  3.50 | Deterministic pricebook/configurator and browser Studio slice exist; persistence and full proposal workflow remain.                            |
| Observability, security, and reliability              |       6% |      25% |                  1.50 | Event shapes, masking and gates exist; no production telemetry sinks, retention controls, operational hardening, or live reliability evidence. |
| Verification and delivery operations                  |       4% |      50% |                  2.00 | CI, structure/type/lint/test/build gates and reference browser E2E exist; production deploy and integration/load/security verification remain. |
| **Total**                                             | **100%** |          | **24.15 / 100 ≈ 24%** |                                                                                                                                                |

## How to update it

`weighted points = weight × coverage / 100`; sum the points for the total. Coverage is an evidence-backed estimate, rounded to the nearest practical milestone rather than inferred from lines of code:

- **0%:** absent.
- **10–25%:** contract, scaffold, or isolated tested behavior.
- **50%:** runnable and tested end-to-end reference behavior, with mocks/fixtures clearly identified.
- **75%:** real provider or business system integrated and tested in a controlled environment.
- **100%:** the applicable PRD acceptance criteria are met, documented, and operationally verified.

The lead updates a row only after auditing source, tests, and the relevant runnable result. Record the evidence and remaining gap in the same row. Work in progress, agent reports without source audit, and live provider claims without a live test do not count as completed delivery.

The percentage does not replace release gates. In particular, the current PRD §34 criteria for real Act booking/CRM/email and Transact payment → confirmation → receipt remain unmet. Voice and Human Presence are also absent. A high aggregate percentage must not be used to claim commercial readiness while a required gate is open.

## Next review point

The next Act review needs a selected booking system, approved tenant template
catalog and mail provider, durable idempotency/outbox behavior, server-side
tenant configuration, a real user confirmation surface, and a controlled
external transaction. The next Jev review needs the optional live synthetic
evaluation and a data-term decision. Keep both claims separate from offline
tests and mocked gateways.
