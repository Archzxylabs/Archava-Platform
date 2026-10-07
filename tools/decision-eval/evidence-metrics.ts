/**
 * Metrics for the evidence-sufficiency set.
 *
 * Scored separately from `metrics.ts` because that module's report is a table of
 * tasks by accuracy, and this task needs two more axes to say anything honest:
 * a number per language, and a number per cause.
 *
 * The language axis is not decoration. A provider can be adequate in English and
 * useless in Indonesian without any overall average noticing, and a set where
 * the mixed cases are only the easy sufficient ones would report a mixed-locale
 * accuracy that measures nothing. Every language in the set carries every label
 * and every hazard — `evidence-set.ts` refuses to load otherwise.
 *
 * The hazard axis replaces the single word `insufficient` with the four kinds of
 * insufficient plus the live-authority kind, so "18 of 27 wrong" reads instead
 * as "it collapses on overlap and on every live-authority question", which is
 * the sentence that tells somebody what to fix.
 *
 * The one number that is not a metric is `unsupportedSufficient`. It counts the
 * cases where the evidence does not support an answer and the provider said the
 * evidence was enough, and it is broken out by hazard because the same count
 * means three different things: a vote for copy over a live system, a page that
 * overlaps without stating, or a page that contradicts another page. A provider
 * that answers live-authority questions from published copy is not inaccurate in
 * an interesting way — it is unsafe, and this is where the report says so.
 */

import type { CorpusLocale } from './corpus.js'
import {
  EVIDENCE_HAZARDS,
  EVIDENCE_LABELS,
  type EvidenceCase,
  type EvidenceHazard,
  type EvidenceLabel,
  type LiveSubject,
  isEvidenceLabel,
} from './evidence-set.js'

/** What one provider said for one case: the label, and the score behind it. */
export interface EvidencePrediction {
  readonly label: string
  /** The score the provider returned, or null when it returned none. */
  readonly score: number | null
}

export type EvidencePredictions = Readonly<Record<string, EvidencePrediction>>

/** A prediction outside the task's vocabulary, kept out of the accuracy count. */
export interface InvalidEvidenceAnswer {
  readonly caseId: string
  readonly predicted: string
  readonly score: number | null
}

/**
 * A case called sufficient that is not — one row per occurrence.
 *
 * `hazard` says which kind of not-sufficient it was, and `liveSubject` is set
 * exactly when the tenant's live system owns the answer, which is the case that
 * must never be answered from copy.
 */
export interface UnsupportedSufficient {
  readonly caseId: string
  readonly hazard: EvidenceHazard
  readonly liveSubject: LiveSubject | null
  readonly score: number
}

export interface EvidenceLabelReport {
  readonly label: EvidenceLabel
  readonly accuracy: number
  readonly scored: number
  readonly correct: number
  readonly incorrect: number
  readonly unanswered: number
  /** How many times each label was predicted for cases expecting this one. */
  readonly confusion: Readonly<Record<EvidenceLabel, number>>
}

export interface EvidenceLocaleReport {
  readonly locale: CorpusLocale
  readonly total: number
  readonly accuracy: number
  readonly scored: number
  readonly correct: number
  readonly incorrect: number
  readonly unanswered: number
  readonly labels: Readonly<Record<EvidenceLabel, EvidenceLabelReport>>
}

export interface EvidenceHazardReport {
  readonly hazard: EvidenceHazard
  readonly total: number
  readonly accuracy: number
  readonly scored: number
  readonly correct: number
  readonly incorrect: number
  readonly unanswered: number
}

export interface EvidenceReport {
  readonly total: number
  readonly accuracy: number
  readonly scored: number
  readonly correct: number
  readonly incorrect: number
  readonly unanswered: number
  readonly labels: Readonly<Record<EvidenceLabel, EvidenceLabelReport>>
  readonly locales: Readonly<Record<CorpusLocale, EvidenceLocaleReport>>
  readonly hazards: Readonly<Record<EvidenceHazard, EvidenceHazardReport>>
  readonly invalidAnswers: readonly InvalidEvidenceAnswer[]
  /** Every case called sufficient that the evidence does not support. */
  readonly unsupportedSufficient: readonly UnsupportedSufficient[]
  readonly unsupportedSufficientCount: number
  /** How many cases could have exposed one — what a zero is worth. */
  readonly protectedTruthAtRisk: number
}

const LOCALES: readonly CorpusLocale[] = ['en', 'id', 'mixed']

function accuracyOf(correct: number, scored: number, unanswered: number): number {
  return scored + unanswered === 0 ? 0 : correct / (scored + unanswered)
}

function labelReport(label: EvidenceLabel): EvidenceLabelReport {
  const confusion = {} as Record<EvidenceLabel, number>
  for (const candidate of EVIDENCE_LABELS) confusion[candidate] = 0
  return { label, accuracy: 0, scored: 0, correct: 0, incorrect: 0, unanswered: 0, confusion }
}

function localeReport(locale: CorpusLocale): EvidenceLocaleReport {
  const labels = {} as Record<EvidenceLabel, EvidenceLabelReport>
  for (const label of EVIDENCE_LABELS) labels[label] = labelReport(label)
  return {
    locale,
    total: 0,
    accuracy: 0,
    scored: 0,
    correct: 0,
    incorrect: 0,
    unanswered: 0,
    labels,
  }
}

function withHit(report: EvidenceLabelReport, hit: boolean): EvidenceLabelReport {
  return {
    ...report,
    scored: report.scored + 1,
    correct: report.correct + (hit ? 1 : 0),
    incorrect: report.incorrect + (hit ? 0 : 1),
  }
}

function withMiss(report: EvidenceLabelReport): EvidenceLabelReport {
  return { ...report, unanswered: report.unanswered + 1 }
}

function withConfusion(report: EvidenceLabelReport, predicted: EvidenceLabel): EvidenceLabelReport {
  return {
    ...report,
    confusion: {
      ...report.confusion,
      [predicted]: (report.confusion[predicted] ?? 0) + 1,
    },
  }
}

/**
 * Score predictions against the labelled evidence set.
 *
 * An answer outside the two labels is listed and counted as unanswered. It
 * never earns a point or disappears from the accuracy denominator.
 */
export function scoreEvidencePredictions(
  cases: readonly EvidenceCase[],
  predictions: EvidencePredictions,
): EvidenceReport {
  const labels = {} as Record<EvidenceLabel, EvidenceLabelReport>
  for (const label of EVIDENCE_LABELS) labels[label] = labelReport(label)
  const locales: Record<CorpusLocale, EvidenceLocaleReport> = {
    en: localeReport('en'),
    id: localeReport('id'),
    mixed: localeReport('mixed'),
  }
  const hazards = {} as Record<EvidenceHazard, EvidenceHazardReport>
  for (const hazard of EVIDENCE_HAZARDS) {
    hazards[hazard] = {
      hazard,
      total: 0,
      accuracy: 0,
      scored: 0,
      correct: 0,
      incorrect: 0,
      unanswered: 0,
    }
  }

  const invalidAnswers: InvalidEvidenceAnswer[] = []
  const unsupportedSufficient: UnsupportedSufficient[] = []
  let total = 0
  let scored = 0
  let correct = 0
  let incorrect = 0
  let unanswered = 0
  let protectedTruthAtRisk = 0

  for (const evaluationCase of cases) {
    total += 1
    if (evaluationCase.liveSubject !== null) protectedTruthAtRisk += 1
    const prediction = predictions[evaluationCase.id]
    const expected = evaluationCase.expected
    const locale = locales[evaluationCase.locale]
    const hazard = hazards[evaluationCase.hazard]

    if (prediction === undefined) {
      unanswered += 1
      labels[expected] = withMiss(labels[expected])
      locales[evaluationCase.locale] = {
        ...locale,
        total: locale.total + 1,
        unanswered: locale.unanswered + 1,
        labels: { ...locale.labels, [expected]: withMiss(locale.labels[expected]) },
      }
      hazards[evaluationCase.hazard] = {
        ...hazard,
        total: hazard.total + 1,
        unanswered: hazard.unanswered + 1,
      }
      continue
    }

    if (!isEvidenceLabel(prediction.label)) {
      invalidAnswers.push({
        caseId: evaluationCase.id,
        predicted: prediction.label,
        score: prediction.score,
      })
      unanswered += 1
      labels[expected] = withMiss(labels[expected])
      locales[evaluationCase.locale] = {
        ...locale,
        total: locale.total + 1,
        unanswered: locale.unanswered + 1,
        labels: { ...locale.labels, [expected]: withMiss(locale.labels[expected]) },
      }
      hazards[evaluationCase.hazard] = {
        ...hazard,
        total: hazard.total + 1,
        unanswered: hazard.unanswered + 1,
      }
      continue
    }

    const hit = prediction.label === expected
    scored += 1
    if (hit) correct += 1
    else incorrect += 1

    labels[expected] = withConfusion(withHit(labels[expected], hit), prediction.label)
    locales[evaluationCase.locale] = {
      ...locale,
      total: locale.total + 1,
      scored: locale.scored + 1,
      correct: locale.correct + (hit ? 1 : 0),
      incorrect: locale.incorrect + (hit ? 0 : 1),
      labels: {
        ...locale.labels,
        [expected]: withConfusion(withHit(locale.labels[expected], hit), prediction.label),
      },
    }
    hazards[evaluationCase.hazard] = {
      ...hazard,
      total: hazard.total + 1,
      scored: hazard.scored + 1,
      correct: hazard.correct + (hit ? 1 : 0),
      incorrect: hazard.incorrect + (hit ? 0 : 1),
    }

    if (!hit && prediction.label === 'sufficient') {
      unsupportedSufficient.push({
        caseId: evaluationCase.id,
        hazard: evaluationCase.hazard,
        liveSubject: evaluationCase.liveSubject,
        score: prediction.score ?? Number.NaN,
      })
    }
  }

  for (const label of EVIDENCE_LABELS) {
    const entry = labels[label]
    labels[label] = {
      ...entry,
      accuracy: accuracyOf(entry.correct, entry.scored, entry.unanswered),
    }
  }
  for (const locale of LOCALES) {
    const entry = locales[locale]
    const nextLabels = {} as Record<EvidenceLabel, EvidenceLabelReport>
    for (const label of EVIDENCE_LABELS) {
      const labelEntry = entry.labels[label]
      nextLabels[label] = {
        ...labelEntry,
        accuracy: accuracyOf(labelEntry.correct, labelEntry.scored, labelEntry.unanswered),
      }
    }
    locales[locale] = {
      ...entry,
      accuracy: accuracyOf(entry.correct, entry.scored, entry.unanswered),
      labels: nextLabels,
    }
  }
  for (const hazard of EVIDENCE_HAZARDS) {
    const entry = hazards[hazard]
    hazards[hazard] = {
      ...entry,
      accuracy: accuracyOf(entry.correct, entry.scored, entry.unanswered),
    }
  }

  return {
    total,
    accuracy: accuracyOf(correct, scored, unanswered),
    scored,
    correct,
    incorrect,
    unanswered,
    labels,
    locales,
    hazards,
    invalidAnswers,
    unsupportedSufficient,
    unsupportedSufficientCount: unsupportedSufficient.length,
    protectedTruthAtRisk,
  }
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function tally(correct: number, scored: number, incorrect: number, unanswered: number): string {
  return `${correct}/${scored} correct, ${incorrect} wrong, ${unanswered} unanswered (${percent(
    accuracyOf(correct, scored, unanswered),
  )})`
}

/** A human-readable report, narrow enough to read in a CI log. */
export function formatEvidenceReport(report: EvidenceReport): string {
  const lines: string[] = []
  lines.push(`evidence sufficiency over ${report.total} labelled cases`)
  lines.push(`  ${tally(report.correct, report.scored, report.incorrect, report.unanswered)}`)

  lines.push('by label:')
  for (const label of EVIDENCE_LABELS) {
    const entry = report.labels[label]
    lines.push(
      `  ${label}: ${tally(entry.correct, entry.scored, entry.incorrect, entry.unanswered)}`,
    )
  }

  lines.push('by locale:')
  for (const locale of LOCALES) {
    const entry = report.locales[locale]
    if (entry.total === 0) {
      lines.push(`  ${locale}: no cases`)
      continue
    }
    const parts = EVIDENCE_LABELS.map((label) => {
      const labelEntry = entry.labels[label]
      return `${label} ${labelEntry.correct}/${labelEntry.scored}`
    })
    lines.push(`  ${locale}: ${percent(entry.accuracy)} (${parts.join(', ')})`)
  }

  lines.push('by hazard:')
  for (const hazard of EVIDENCE_HAZARDS) {
    const entry = report.hazards[hazard]
    if (entry.total === 0) {
      lines.push(`  ${hazard}: no cases`)
      continue
    }
    lines.push(
      `  ${hazard}: ${entry.correct}/${entry.scored} (${percent(entry.accuracy)}, ${entry.total} cases)`,
    )
  }

  lines.push(
    `unsupported facts treated as sufficient: ${report.unsupportedSufficientCount}` +
      ` (${report.protectedTruthAtRisk} live-authority cases at risk)`,
  )
  for (const entry of report.unsupportedSufficient) {
    const owner = entry.liveSubject === null ? 'published copy' : `live ${entry.liveSubject}`
    lines.push(`  ${entry.caseId}: ${owner}, ${entry.hazard}, scored ${entry.score}`)
  }

  if (report.invalidAnswers.length > 0) {
    lines.push(`out-of-vocabulary answers: ${report.invalidAnswers.length}`)
    for (const invalid of report.invalidAnswers) {
      lines.push(`  ${invalid.caseId}: ${invalid.predicted}`)
    }
  }

  return lines.join('\n')
}
