/** Offline, reproducible score for the actual RuleDecisionProvider. */
import { classifyKnowledgeNeed } from '@archava/knowledge'
import { RuleDecisionProvider, type DecisionTask } from '@archava/decision'
import { REFERENCE_CORPUS, evaluate, formatReport, type Predictions } from './index.js'

const provider = new RuleDecisionProvider()

function label(task: DecisionTask, answer: unknown): string | undefined {
  if (task === 'knowledge_routing')
    return answer === 'retrieval_knowledge' ? 'retrieval' : String(answer)
  if (task === 'clarification') return answer === true ? 'clarify' : 'answer'
  if (task === 'handoff_recommendation') return answer === true ? 'handoff' : 'self_serve'
  if (task === 'evidence_sufficiency')
    return typeof answer === 'number' ? (answer >= 0.5 ? 'sufficient' : 'insufficient') : undefined
  return typeof answer === 'string' ? answer : undefined
}

const raw: Record<string, Predictions> = {}
const effective: Record<string, Predictions> = {}
for (const item of REFERENCE_CORPUS) {
  const predictions: Record<string, string> = {}
  for (const task of [
    'intent_classification',
    'knowledge_routing',
    'clarification',
    'handoff_recommendation',
    'evidence_sufficiency',
  ] as const) {
    const report = provider.reportTask(task, item.utterance)
    if (report.kind === 'answered') {
      const predicted = label(task, report.answer)
      if (predicted !== undefined) predictions[task] = predicted
    }
  }
  raw[item.id] = predictions
  const deterministic = classifyKnowledgeNeed(item.utterance).need
  effective[item.id] = {
    ...predictions,
    // This corpus carries no trusted live-system subject candidates. The
    // runtime cannot use a provider escalation without those host hints.
    knowledge_routing: deterministic === 'structured_truth' ? 'structured_truth' : 'retrieval',
  }
}

process.stdout.write('Rule provider, raw judgments\n')
process.stdout.write(`${formatReport(evaluate(raw))}\n\n`)
process.stdout.write('Effective routing after deterministic protection\n')
process.stdout.write(`${formatReport(evaluate(effective))}\n`)

if (evaluate(effective).criticalFailures.length > 0) process.exitCode = 1
