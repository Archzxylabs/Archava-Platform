/**
 * Corpus-shape tests.
 *
 * A corpus is data, and data rots. These tests are the ones that catch the two
 * ways it rots into uselessness: a case whose expected label is not one its own
 * task can return (which would silently become an out-of-vocabulary prediction
 * the metrics then refuse to score), and a case that stops saying anything
 * because its required labels went missing.
 *
 * The six Foundation examples are asserted by string, not by id. Ids are ours;
 * the utterances are the PRD's, and a paraphrase that kept the id would pass an
 * id-based test while testing nothing the platform is built on.
 */

import { describe, expect, it } from 'vitest'

import {
  CORPUS_CORE_TASKS,
  CORPUS_LANGUAGE_COUNTS,
  CORPUS_SIZE,
  REFERENCE_CORPUS,
  corpusProblems,
} from '../corpus.js'
import { criticalCapacity } from '../critical.js'
import { DECISION_TASK_IDS, labelsOf } from '../tasks.js'

/** The utterances the PRD, the knowledge tests and this corpus must all share. */
const FOUNDATION_EXAMPLES = [
  'What can I book this week?',
  'How many rooms do you have?',
  'Berapa harga kamar treetop suite?',
  'How many nights can I stay?',
  'Is my booking confirmed?',
  'What is your cancellation policy?',
] as const

describe('reference corpus', () => {
  it('holds the committed number of cases', () => {
    expect(CORPUS_SIZE).toBe(51)
    expect(REFERENCE_CORPUS).toHaveLength(51)
  })

  it('is a stat, not a claim: language counts match the cases and sum to the whole', () => {
    const counted = CORPUS_LANGUAGE_COUNTS
    expect(counted).toEqual({ en: 22, id: 17, mixed: 12 })
    expect(counted.en + counted.id + counted.mixed).toBe(CORPUS_SIZE)
    for (const locale of ['en', 'id', 'mixed'] as const) {
      expect(counted[locale]).toBeGreaterThan(0)
    }
  })

  it('gives every locale enough cases to say something', () => {
    // A single Indonesian case would "cover" the tenant's primary language in a
    // way that no honest metric report should accept as coverage.
    expect(CORPUS_LANGUAGE_COUNTS.en).toBeGreaterThanOrEqual(10)
    expect(CORPUS_LANGUAGE_COUNTS.id).toBeGreaterThanOrEqual(10)
    expect(CORPUS_LANGUAGE_COUNTS.mixed).toBeGreaterThanOrEqual(10)
  })

  it('reports no problems: unique ids, non-empty utterances, known labels', () => {
    const problems = corpusProblems(REFERENCE_CORPUS, DECISION_TASK_IDS, labelsOf)
    expect(problems).toEqual([])
  })

  it('carries all five tasks on every case, so no case is silently half-asked', () => {
    for (const evaluationCase of REFERENCE_CORPUS) {
      for (const task of DECISION_TASK_IDS) {
        expect(evaluationCase.expected[task], `${evaluationCase.id} / ${task}`).toBeDefined()
      }
    }
  })

  it('answers every core task with a label that task allows', () => {
    for (const evaluationCase of REFERENCE_CORPUS) {
      for (const task of CORPUS_CORE_TASKS) {
        expect(labelsOf(task)).toContain(evaluationCase.expected[task])
      }
    }
  })

  it('uses unique ids, so a report cannot attribute two answers to one case', () => {
    const ids = REFERENCE_CORPUS.map((evaluationCase) => evaluationCase.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('explains every label, so a disagreement is debatable rather than asserted', () => {
    for (const evaluationCase of REFERENCE_CORPUS) {
      expect(evaluationCase.why.length, evaluationCase.id).toBeGreaterThan(0)
      expect(evaluationCase.utterance.trim().length, evaluationCase.id).toBeGreaterThan(0)
    }
  })
})

describe('foundation examples', () => {
  it('quotes all six verbatim, so the corpus measures the platform that ships', () => {
    for (const utterance of FOUNDATION_EXAMPLES) {
      const match = REFERENCE_CORPUS.filter(
        (evaluationCase) => evaluationCase.utterance === utterance,
      )
      expect(match, utterance).toHaveLength(1)
      expect(match[0]?.locale).toBeDefined()
    }
  })

  it('labels the availability example from live state, with clarification for the missing window', () => {
    const bookable = caseByUtterance('What can I book this week?')
    expect(bookable.expected.intent_classification).toBe('availability_inquiry')
    expect(bookable.expected.knowledge_routing).toBe('structured_truth')
    expect(bookable.expected.clarification).toBe('clarify')
  })

  it('labels the room-count example from live state, without asking for anything', () => {
    const roomCount = caseByUtterance('How many rooms do you have?')
    expect(roomCount.expected.intent_classification).toBe('availability_inquiry')
    expect(roomCount.expected.knowledge_routing).toBe('structured_truth')
    expect(roomCount.expected.clarification).toBe('answer')
  })

  it('labels the Indonesian price example as a pricebook question', () => {
    const harga = caseByUtterance('Berapa harga kamar treetop suite?')
    expect(harga.locale).toBe('id')
    expect(harga.expected.intent_classification).toBe('pricing_inquiry')
    expect(harga.expected.knowledge_routing).toBe('structured_truth')
  })

  it('labels the stay-length example from published policy, not live state', () => {
    const nights = caseByUtterance('How many nights can I stay?')
    expect(nights.expected.intent_classification).toBe('policy_inquiry')
    expect(nights.expected.knowledge_routing).toBe('retrieval')
  })

  it('labels the booking-confirmation example as live state the visitor owns', () => {
    const confirmed = caseByUtterance('Is my booking confirmed?')
    expect(confirmed.expected.intent_classification).toBe('status_inquiry')
    expect(confirmed.expected.knowledge_routing).toBe('structured_truth')
  })

  it('labels the cancellation-policy example as published knowledge', () => {
    const policy = caseByUtterance('What is your cancellation policy?')
    expect(policy.expected.intent_classification).toBe('policy_inquiry')
    expect(policy.expected.knowledge_routing).toBe('retrieval')
  })
})

describe('corpus coverage', () => {
  it('can expose a critical downgrade, so a zero count means something', () => {
    // Twenty-five of fifty-one cases need a live-system answer. A provider that
    // scores 100% on the rest of the corpus and routes all of these to retrieval
    // has committed twenty-five unverified answers about money and bookings.
    expect(criticalCapacity(REFERENCE_CORPUS)).toBe(25)
  })

  it('covers every intent label at least once', () => {
    const intents = new Set(
      REFERENCE_CORPUS.map((evaluationCase) => evaluationCase.expected.intent_classification),
    )
    for (const label of labelsOf('intent_classification')) {
      expect(intents, label).toContain(label)
    }
  })

  it('covers both routing labels, with the live-state half a real fraction', () => {
    const routing = REFERENCE_CORPUS.map(
      (evaluationCase) => evaluationCase.expected.knowledge_routing,
    )
    expect(new Set(routing)).toEqual(new Set(['structured_truth', 'retrieval']))
    expect(routing.filter((label) => label === 'structured_truth').length).toBe(25)
  })

  it('carries the required shape variety, not only the easy happy path', () => {
    const cases = REFERENCE_CORPUS

    expect(caseWithIntent(cases, 'recommendation_request')).toBe(true)
    expect(caseWithIntent(cases, 'comparison_request')).toBe(true)
    expect(caseWithIntent(cases, 'handoff_request')).toBe(true)

    // Explicit handoff recommendation, as opposed to a handoff request.
    expect(
      cases.some((evaluationCase) => evaluationCase.expected.handoff_recommendation === 'handoff'),
    ).toBe(true)
    // A case the tenant cannot answer from its own knowledge.
    expect(
      cases.some(
        (evaluationCase) => evaluationCase.expected.evidence_sufficiency === 'insufficient',
      ),
    ).toBe(true)
    // Price asked together with availability, which a single-label router must lose on.
    expect(
      caseWithUtterance(
        cases,
        'How much is the garden villa per night, and is it free this Friday?',
      ),
    ).toBe(true)
  })
})

function caseByUtterance(utterance: string): {
  id: string
  locale: string
  expected: Record<string, string>
} {
  const match = REFERENCE_CORPUS.find((evaluationCase) => evaluationCase.utterance === utterance)
  if (!match) throw new Error(`no case for ${utterance}`)
  return {
    id: match.id,
    locale: match.locale,
    expected: match.expected as unknown as Record<string, string>,
  }
}

function caseWithUtterance(cases: readonly { utterance: string }[], utterance: string): boolean {
  return cases.some((evaluationCase) => evaluationCase.utterance === utterance)
}

function caseWithIntent(
  cases: readonly { expected: { intent_classification: string } }[],
  intent: string,
): boolean {
  return cases.some((evaluationCase) => evaluationCase.expected.intent_classification === intent)
}
