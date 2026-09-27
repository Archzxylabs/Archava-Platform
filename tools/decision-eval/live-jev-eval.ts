/**
 * Explicit, server-only Jev SHADOW evaluation. Not imported by ordinary CI.
 * Example: TYPESAFE_API_KEY=... pnpm exec tsx tools/decision-eval/live-jev-eval.ts --live --max-cases 5
 */
import { JevDecisionProvider, JEV_API_KEY_ENV } from '@archava/adapters/server'
import { parseLiveOptions } from './live-options.js'
import { evaluateShadow } from './shadow.js'

try {
  const options = parseLiveOptions(process.argv.slice(2), process.env[JEV_API_KEY_ENV])
  const provider = new JevDecisionProvider({ apiKey: options.apiKey, timeoutMs: 4_000 })
  const result = await evaluateShadow(provider, {
    maxCases: options.maxCases,
    paceMs: options.paceMs,
    timeoutMs: 4_500,
  })
  process.stdout.write(
    JSON.stringify({
      mode: 'shadow',
      provider: provider.providerId,
      model: provider.model,
      casesRun: result.casesRun,
      languages: result.languages,
      providerCalls: result.providerCalls,
      tasksScored: [
        'intent_classification',
        'knowledge_routing',
        'clarification',
        'handoff_recommendation',
      ],
      evidenceSufficiency: 'unscored: no evidence payload in the 51-case corpus',
      raw: result.raw,
      effective: result.effective,
      traceCounts: result.traceCounts,
      caseTraces: result.caseTraces,
      disagreements: result.disagreements,
      fallbacks: result.fallbacks,
      transportOrSchemaFailures: result.transportOrSchemaFailures,
      refusals: result.refusals,
      shadowChangedRuntime: result.shadowChangedRuntime,
    }) + '\n',
  )
  if (
    result.transportOrSchemaFailures > 0 ||
    result.refusals > 0 ||
    result.effective.criticalFailures.length > 0
  ) {
    process.exitCode = 1
  }
} catch {
  process.stderr.write(
    'The external evaluation could not run. Check --live, TYPESAFE_API_KEY, and the numeric options.\n',
  )
  process.exitCode = 2
}
