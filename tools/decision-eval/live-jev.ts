/** Explicit, one-call external smoke. Never imported by ordinary CI. */
import { JevDecisionProvider, JEV_API_KEY_ENV } from '@archava/adapters/server'
import { DecisionOrchestrator } from '@archava/decision'

const apiKey = process.env[JEV_API_KEY_ENV]
if (!apiKey) {
  process.stderr.write(
    `Set ${JEV_API_KEY_ENV} in the server environment before this optional live smoke.\n`,
  )
  process.exitCode = 2
} else {
  const provider = new JevDecisionProvider({ apiKey, timeoutMs: 3_000 })
  const orchestrator = new DecisionOrchestrator({
    mode: 'shadow',
    provider,
    enabledTasks: ['intent_classification'],
    timeoutMs: 3_500,
  })
  const run = await orchestrator.run(
    {
      tenantId: 'synthetic-smoke',
      utterance: 'Can you recommend a room?',
      locale: 'en',
      evidence: {},
    },
    [{ task: 'intent_classification', answer: 'general_inquiry', source: 'synthetic_baseline' }],
  )
  const trace = run.traces[0]
  process.stdout.write(
    JSON.stringify({
      provider: run.providerId,
      model: run.model,
      outcome: trace?.outcome,
      candidate: trace?.candidate?.answer ?? null,
      confidence: trace?.confidence ?? null,
      runtimeChanged: false,
    }) + '\n',
  )
  if (trace?.outcome !== 'answered') process.exitCode = 1
}
