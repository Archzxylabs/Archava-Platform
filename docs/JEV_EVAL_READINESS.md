# Jev SHADOW evaluation readiness

Reviewed against official TypeSafe AI documentation on 2026-09-27. This command is an optional server-side evaluation, separate from ordinary CI. No live call has been made.

## Route and command

Archava's existing Jev adapter uses the [TypeSafe HTTP evaluation API](https://docs.typesafe.ai/api): POST /v1/systemone with bearer authentication and the jev-latest model alias. The [models page](https://docs.typesafe.ai/models) currently resolves that alias to jev-1.13.0 and says an alias can move. Four bounded questions are batched into one request per synthetic case. The adapter exposes provider-neutral Boolean, Choice, and Score results; this harness uses the same DecisionOrchestrator SHADOW path as runtime.

Run only after the owner provisions a server-side key and confirms the applicable data terms:

```bash
TYPESAFE_API_KEY=... pnpm exec tsx tools/decision-eval/live-jev-eval.ts --live --max-cases 5
```

The explicit --live flag and key are both required. --max-cases accepts 1–51 and defaults to 5. --pace-ms accepts 250–60000 and defaults to 500. A full run uses --max-cases 51 and makes at most 51 provider calls, one per case. Short runs select English, Indonesian, and mixed-language cases round robin; a five-case run is only a smoke, not a quality assessment. The key stays in a server environment or secret manager, never source, browser bundles, or shell history. The ordinary test, build, verify and E2E commands do not call this runner.

## Data and measurement

Only committed synthetic utterances, a synthetic tenant id, locale, and a minimal synthetic page descriptor are sent. The four questions cover intent classification, knowledge routing, clarification, and handoff recommendation. No form values, customer records, payment data, secrets, or retrieval excerpts are sent. The current 51-case corpus has no evidence payload, so evidence sufficiency is **unscored**. That task needs a separate labelled evidence fixture before promotion.

The output contains case counts, language counts, per-task and per-label accuracy, confusion matrices, raw candidate versus effective baseline routing, confidence-related trace outcomes, disagreements, refusal/fallback/failure counts, and protected structured-truth downgrade counts. It prints no utterances or raw response bodies. SHADOW always returns the deterministic baseline as effective. A raw Jev downgrade is visible as a severe candidate error; an effective downgrade is a harness failure. The command exits nonzero for transport/schema failure, refusal, or an effective downgrade. The Jev adapter normalizes HTTP errors into refusals, so a refused task makes the live evaluation incomplete. A partial run reports only the cases actually run.

The assistant's deterministic four-task baseline is mirrored in the harness; routing comes directly from the Foundation classifier. A future change to assistant baseline logic must update this mirror or move the baseline factory to a shared, tested API. The offline mocked tests verify shadow invariance, failure accounting and metrics wiring. They do **not** establish live Jev accuracy.

## Official limits, cost and privacy

The [API reference](https://docs.typesafe.ai/api) describes the typed question schema, response/confidence fields, and 401, 422, 429 and 529 errors. Its 429/529 guidance calls for backoff; this evaluation intentionally makes no automatic retry, reports the failure, and paces calls. The [confidence guide](https://docs.typesafe.ai/confidence) says Choice/Score confidence is derived from probability distributions; Noul returns a yes probability without its own confidence field. Archava's adapter derives a two-outcome confidence for Noul, and task policy remains separate from authorization.

The [models page](https://docs.typesafe.ai/models) currently lists $0.042 per million input tokens, free output tokens, 1,200 requests/minute, and 250,000 tokens/second for Jev 1.13. These values can change. Exact cost depends on billed input tokens and will only be known after a live run; the full 51-case upper call count is 51. No new runtime dependency was added for this runner.

The [legal page](https://docs.typesafe.ai/legal) says TypeSafe offers enterprise zero data retention and links its processing terms. Archava has **not** verified this tenant's contract, retention period, or entitlement. Do not send live tenant traffic before those are confirmed. Synthetic evaluation can proceed with a key under the owner's approved account.

## Promotion gate

Keep Jev in SHADOW until the full corpus has been measured, all three language groups reviewed, task-specific accuracy and confidence reviewed against the Rule baseline, provider failure rates understood, and no protected structured-truth downgrade can affect runtime. A task may enter ASSIST only through its existing task-specific policy. Jev confidence never grants ActionPolicy permission, confirms a user action, validates input, or executes a booking or payment. Evidence sufficiency requires labelled evidence fixtures before promotion.
