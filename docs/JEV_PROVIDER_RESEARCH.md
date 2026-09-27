# Jev provider research and verification

Reviewed against current official documentation on 2026-09-27. This is the external implementation behind the vendor-neutral `DecisionProvider`, not the product contract.

## Selected route

`JevDecisionProvider` uses TypeSafe AI's direct server-side HTTP API: `POST https://api.typesafe.ai/v1/systemone`, bearer authentication, model `jev-latest`. The endpoint accepts one `state` and a map of typed questions, so the five catalogue tasks can be batched in one call. The current [API reference](https://docs.typesafe.ai/api) documents the endpoint, the `noul`, `choice`, and `score` schemas, and the response shape. The [models page](https://docs.typesafe.ai/models) confirms that `jev-latest` is a rolling alias (currently `jev-1.13.0`). The adapter reports its configured alias through the provider-neutral contract because the orchestrator validates provider identity; it checks but does not yet expose the resolved version in trace metadata.

The direct route was chosen because the documented HTTP schema matches our bounded port and needs no new runtime dependency. Vercel AI Gateway also lists [Jev](https://vercel.com/ai-gateway/models/jev); a gateway switch would need its own request/auth mapping. Merely replacing the direct endpoint URL is **not** supported. No claim is made that an AI SDK `experimental_evaluate` signature has been verified for this implementation.

## Behavior and limits

- `TYPESAFE_API_KEY` is injected into the server adapter; the adapter never reads browser storage or an environment variable itself. Ordinary CI does not need a key.
- Choice answers must be one of the configured options; score answers are mapped from their documented level scale into the requested bounded interval. Noul is converted to a boolean at 0.5; its confidence is an adapter-derived two-outcome measure. [Confidence semantics](https://docs.typesafe.ai/confidence) are provider-specific, and Archava applies separate task floors afterward.
- One call can contain several questions. The adapter validates the response, refuses malformed or missing answers, bounds transport time, and makes no retry. The orchestrator adds its own deadline and falls back to deterministic baselines on failure, refusal, malformed output, timeout, or low confidence.
- The [API reference](https://docs.typesafe.ai/api) lists 401, 422, 429, and 529. The current [models page](https://docs.typesafe.ai/models) lists 1,200 requests/minute and 250,000 tokens/second for Jev 1.13, and $0.042 per million input tokens; limits can change. The adapter does not use these figures as runtime assumptions.
- [TypeSafe legal guidance](https://docs.typesafe.ai/legal) says customer requests/responses are not used to train Jev and zero data retention is offered for enterprise customers. The actual contract, retention period, and ZDR entitlement for this tenant remain unverified. Therefore provider requests use projected, redacted context and limited published evidence; do not enable live tenant traffic until the owner confirms the applicable data terms.

## Verification status

Mock transport tests exercise wire shape, batching, response normalization, malformed data, HTTP errors, timeout, and credential absence. The orchestrator test checks that a resolved version such as `jev-1.13.0` still satisfies provider identity configured as `jev-latest`. **No live Jev request has been made.**

Optional live smoke, after the owner provisions a key in a server environment:

```bash
TYPESAFE_API_KEY=... pnpm decision:jev-smoke
```

The command sends one synthetic English utterance (`Can you recommend a room?`) and one intent question. It sends no tenant/customer data. It runs in shadow mode, prints metadata only, and exits nonzero if no valid answer arrives. Store the key in a secret manager or local environment; never commit it or paste it into source. Cost is one request, with token cost determined by the provider's billed input tokens.

The separate offline command `pnpm decision:eval` scores the deterministic provider and effective routing across 51 English, Indonesian, and mixed-language cases. It is not a live Jev evaluation.
