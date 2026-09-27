# Jev SHADOW evaluation readiness

Reviewed against official TypeSafe AI documentation on 2026-09-27. This command is an optional server-side evaluation, separate from ordinary CI. No live call has been made.

## Route and command

Archava's existing Jev adapter uses the [TypeSafe HTTP evaluation API](https://docs.typesafe.ai/api): POST /v1/systemone with bearer authentication and the jev-latest model alias. The [models page](https://docs.typesafe.ai/models) currently resolves that alias to jev-1.13.0 and says an alias can move. Four bounded questions are batched into one request per synthetic case. The adapter exposes provider-neutral Boolean, Choice, and Score results; this harness uses the same DecisionOrchestrator SHADOW path as runtime.

Run only after the owner provisions a server-side key and confirms the applicable data terms:

```bash
TYPESAFE_API_KEY=... pnpm exec tsx tools/decision-eval/live-jev-eval.ts --live --max-cases 5
```

The explicit --live flag and key are both required. --max-cases accepts 1–28 and defaults to 5 because the same cap applies to both evaluation sets. --pace-ms accepts 250–60000 and defaults to 500. A full run uses --max-cases 28 and makes at most 56 provider calls: 28 utterance cases and 28 separate evidence cases, one batched request per case. The remaining 23 utterance cases can still be scored by the offline 51-case harness; the combined live command currently caps both sets equally. Short runs select English, Indonesian, and mixed-language cases round robin; a five-case run makes at most 10 calls and is only a smoke, not a quality assessment. The key stays in a server environment or secret manager, never source, browser bundles, or shell history. The ordinary test, build, verify and E2E commands do not call this runner.

## Data and measurement

Only committed synthetic utterances, synthetic evidence excerpts, a synthetic tenant id, locale, and a minimal synthetic page descriptor are sent. The 51-case utterance corpus scores intent classification, knowledge routing, clarification, and handoff recommendation; it still has no evidence payload and does not score evidence sufficiency. A separate 28-case labelled evidence set (10 English, 9 Indonesian, 9 mixed) scores evidence sufficiency over supported, missing, overlapping, conflicting, stale, and protected-truth examples. No live tenant form values, customer records, payment data, or secrets are sent.

The output contains separate case and provider-call counts for both sets, language counts, accuracy, per-label and per-locale results, raw candidate versus effective baseline, confidence-related trace outcomes, disagreements, refusal/fallback/failure counts, and critical errors. It prints no utterances or raw response bodies. SHADOW always returns the deterministic baseline as effective. A raw structured-truth downgrade, an effective downgrade, a malformed evidence result, or published evidence marked sufficient for a protected live fact fails the live command; other evidence mistakes remain reported for review. Transport/schema failures and refusals also fail the command. A partial run reports only the cases actually run.

The assistant's deterministic baselines are mirrored in the harnesses; routing comes directly from the Foundation classifier. A future change to assistant baseline logic must update these mirrors or move the baseline factory to a shared, tested API. The offline mocked tests verify shadow invariance, failure accounting and metrics wiring. They do **not** establish live Jev accuracy.

## Official limits, cost and privacy

The [API reference](https://docs.typesafe.ai/api) describes the typed question schema, response/confidence fields, and 401, 422, 429 and 529 errors. Its 429/529 guidance calls for backoff; this evaluation intentionally makes no automatic retry, reports the failure, and paces calls. The [confidence guide](https://docs.typesafe.ai/confidence) says Choice/Score confidence is derived from probability distributions; Noul returns a yes probability without its own confidence field. Archava's adapter derives a two-outcome confidence for Noul, and task policy remains separate from authorization.

The [models page](https://docs.typesafe.ai/models) listed $0.042 per million input tokens, free output tokens, 1,200 requests/minute, and 250,000 tokens/second for Jev 1.13 when last reviewed. These values can change and must be checked before a live run. Exact cost depends on billed input tokens and will only be known after a live run; the current combined full-run upper call count is 56. No new runtime dependency was added for this runner.

The [legal page](https://docs.typesafe.ai/legal) says TypeSafe offers enterprise zero data retention and links its processing terms. Archava has **not** verified this tenant's contract, retention period, or entitlement. Do not send live tenant traffic before those are confirmed. Synthetic evaluation can proceed with a key under the owner's approved account.

## Promotion gate

Keep Jev in SHADOW until representative full runs have been measured, all three language groups reviewed, task-specific accuracy and confidence reviewed against the Rule baseline, provider failure rates understood, and no protected structured-truth downgrade can affect runtime. The 28-case evidence set is an initial fixture, not a promotion threshold by itself. A task may enter ASSIST only through its existing task-specific policy. Jev confidence never grants ActionPolicy permission, confirms a user action, validates input, or executes a booking or payment.
