/**
 * The offline evaluation corpus.
 *
 * Fifty-one utterances a reference hospitality tenant plausibly receives, each
 * carrying the answer every Decision Layer task should give for it. No network,
 * no timestamps, no tenant data — a committed file, so a provider can be scored
 * the same way in CI as on a laptop, and a change in a provider's behaviour
 * shows up as a diff in a number rather than as an anecdote.
 *
 * Two rules the cases follow, because a corpus that breaks either one is worse
 * than no corpus at all:
 *
 * 1. The six Foundation examples are quoted exactly as the PRD and the
 *    knowledge tests spell them. They are the turn the platform is actually
 *    built on; paraphrasing them would test the paraphrase.
 * 2. `why` records the reason for each label, and where the deterministic
 *    lexical baseline in `packages/knowledge` under- or over-shoots, it says so
 *    plainly. A case the baseline cannot pass is still worth carrying — that is
 *    the case that measures something — but pretending it cannot happen would
 *    make the numbers worthless.
 *
 * Bilingual coverage is not decoration. The reference tenant's primary language
 * is Indonesian, so an English-only corpus would score a provider on the half of
 * the traffic it never sees, and the Indonesian possessive (`pemesanan saya`) is
 * precisely where an English-keyword classifier goes quiet.
 */

import type {
  ClarificationLabel,
  DecisionTaskId,
  EvidenceLabel,
  HandoffLabel,
  IntentLabel,
  KnowledgeRoutingLabel,
} from './tasks.js'

/** Which language the utterance is written in. Mixed means Indonesian-English code-switching, the way visitors actually type it. */
export type CorpusLocale = 'en' | 'id' | 'mixed'

export interface ExpectedLabels {
  readonly intent_classification: IntentLabel
  readonly knowledge_routing: KnowledgeRoutingLabel
  readonly clarification?: ClarificationLabel
  readonly handoff_recommendation?: HandoffLabel
  readonly evidence_sufficiency?: EvidenceLabel
}

export interface EvaluationCase {
  readonly id: string
  readonly locale: CorpusLocale
  readonly utterance: string
  readonly expected: ExpectedLabels
  /** Why these labels. The audit trail that makes a disagreement debatable. */
  readonly why: string
}

/** The utterance corpus has no supplied evidence, so its evidence labels are not scored. */
export function utteranceOnlyCases(cases: readonly EvaluationCase[]): EvaluationCase[] {
  return cases.map((item) => {
    const expected = { ...item.expected }
    delete expected.evidence_sufficiency
    return { ...item, expected }
  })
}

function entry(
  id: string,
  locale: CorpusLocale,
  utterance: string,
  expected: ExpectedLabels,
  why: string,
): EvaluationCase {
  return { id, locale, utterance, expected, why }
}

export const REFERENCE_CORPUS: readonly EvaluationCase[] = [
  /* ------------------------------------------------------------- English -- */

  entry(
    'en-book-this-week',
    'en',
    'What can I book this week?',
    {
      intent_classification: 'availability_inquiry',
      knowledge_routing: 'structured_truth',
      clarification: 'clarify',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'Foundation example, quoted verbatim. "what can i book" is an availability keyword: the answer lives in the availability snapshot, not in published copy. The stay window is missing, so the turn must confirm it.',
  ),
  entry(
    'en-how-many-rooms',
    'en',
    'How many rooms do you have?',
    {
      intent_classification: 'availability_inquiry',
      knowledge_routing: 'structured_truth',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'Foundation example. An inventory count phrased without the word "stock": "how many rooms" is the keyword that keeps the count and the thing counted together.',
  ),
  entry(
    'en-nights-stay',
    'en',
    'How many nights can I stay?',
    {
      intent_classification: 'policy_inquiry',
      knowledge_routing: 'retrieval',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'Foundation example. Answered from the published stay policy: a bare "how many" names no live-data thing, and the minimum-stay rule is content the tenant writes.',
  ),
  entry(
    'en-booking-confirmed',
    'en',
    'Is my booking confirmed?',
    {
      intent_classification: 'status_inquiry',
      knowledge_routing: 'structured_truth',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'Foundation example. "is my booking" plus a possessive: the reservation system owns this outright, and retrieval has no business sourcing it.',
  ),
  entry(
    'en-cancellation-policy',
    'en',
    'What is your cancellation policy?',
    {
      intent_classification: 'policy_inquiry',
      knowledge_routing: 'retrieval',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'Foundation example. Published policy, no live system consulted.',
  ),
  entry(
    'en-price-treetop',
    'en',
    'What is the price of the treetop suite for two nights?',
    {
      intent_classification: 'pricing_inquiry',
      knowledge_routing: 'structured_truth',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'A rate is price: the live pricebook owns it, and a quoted figure must be derived at the moment it is said.',
  ),
  entry(
    'en-rooms-available-tonight',
    'en',
    'Do you have any rooms available tonight?',
    {
      intent_classification: 'availability_inquiry',
      knowledge_routing: 'structured_truth',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'Availability asked with the noun. The calendar answers this; a brochure cannot.',
  ),
  entry(
    'en-where-my-order',
    'en',
    'Where is my order?',
    {
      intent_classification: 'status_inquiry',
      knowledge_routing: 'structured_truth',
      clarification: 'clarify',
      handoff_recommendation: 'handoff',
      evidence_sufficiency: 'insufficient',
    },
    'A possessive question about live state. This tenant publishes no order-tracking knowledge and the turn cannot see an order, so it must ask which order and route to a human rather than improvise.',
  ),
  entry(
    'en-talk-to-person',
    'en',
    'Can I speak to a real person, please?',
    {
      intent_classification: 'handoff_request',
      knowledge_routing: 'retrieval',
      clarification: 'answer',
      handoff_recommendation: 'handoff',
      evidence_sufficiency: 'sufficient',
    },
    'Explicit handoff. The request is the whole message, so the routing answer only concerns which knowledge may support the handoff itself.',
  ),
  entry(
    'en-recommendation-quiet',
    'en',
    'Which room would you recommend for two people who want quiet?',
    {
      intent_classification: 'recommendation_request',
      knowledge_routing: 'retrieval',
      clarification: 'clarify',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'Recommendation. Room descriptions are published knowledge; what "quiet" means to these two is not, so the turn asks before it advises.',
  ),
  entry(
    'en-ambiguous-reference',
    'en',
    'Can you book that one for me?',
    {
      intent_classification: 'purchase_request',
      knowledge_routing: 'retrieval',
      clarification: 'clarify',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'insufficient',
    },
    'Ambiguous reference: "that one" has no antecedent in the conversation the corpus can see. Asking which room is the only correct move, and guessing would be inventing a fact.',
  ),
  entry(
    'en-comparison-suites',
    'en',
    'What is the difference between the treetop suite and the canopy cabin?',
    {
      intent_classification: 'comparison_request',
      knowledge_routing: 'retrieval',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'Comparison of two published products. The answer is a side-by-side reading of copy the tenant already ships, not a live lookup — though the price half of the question, were it asked, would not be.',
  ),
  entry(
    'en-price-and-availability',
    'en',
    'How much is the garden villa per night, and is it free this Friday?',
    {
      intent_classification: 'pricing_inquiry',
      knowledge_routing: 'structured_truth',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'Price plus availability in one sentence: the hard case for a single-label router, because the second clause concerns live state and a retrieval-quoted price would be stale by the time the visitor read it.',
  ),
  entry(
    'en-unsupported-shuttle',
    'en',
    'Your website says the shuttle leaves at 5am — is that still right?',
    {
      intent_classification: 'policy_inquiry',
      knowledge_routing: 'retrieval',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'insufficient',
    },
    'Unsupported factual claim. The visitor attributes a specific published fact the tenant never wrote; agreeing to it would be confirming an invention, so the answer must say the tenant cannot verify it.',
  ),
  entry(
    'en-unsupported-helipad',
    'en',
    'I was told there is a helipad on the roof. Can you confirm?',
    {
      intent_classification: 'general_inquiry',
      knowledge_routing: 'retrieval',
      clarification: 'clarify',
      handoff_recommendation: 'handoff',
      evidence_sufficiency: 'insufficient',
    },
    'Unsupported factual claim with a live-safety edge. Neither confirming nor flatly denying is safe: the turn must not invent a facility, and it must not brush off a guest who needed one either, so it hands off and asks.',
  ),
  entry(
    'en-refund-through',
    'en',
    'Did my refund come through?',
    {
      intent_classification: 'support_request',
      knowledge_routing: 'structured_truth',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'Refund state is payment status — the payment system knows, and the possessive alone puts it in live territory.',
  ),
  entry(
    'en-late-checkin',
    'en',
    'Can I check in at 2am?',
    {
      intent_classification: 'policy_inquiry',
      knowledge_routing: 'retrieval',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'A written front-desk rule. Published content answers it.',
  ),
  entry(
    'en-purchase-over-chat',
    'en',
    'Could you book a room for me right now?',
    {
      intent_classification: 'purchase_request',
      knowledge_routing: 'structured_truth',
      clarification: 'answer',
      handoff_recommendation: 'handoff',
      evidence_sufficiency: 'sufficient',
    },
    'Purchase intent, and the availability system decides whether it is possible at all — so the routing answer is structured truth even though the tenant cannot complete the transaction itself.',
  ),
  entry(
    'en-greeting',
    'en',
    'Hello, how are you?',
    {
      intent_classification: 'general_inquiry',
      knowledge_routing: 'retrieval',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'Ordinary greeting. A provider that routes this to a live system, or that cannot let a greeting pass, is not ready.',
  ),
  entry(
    'en-breakfast-time',
    'en',
    'What time is breakfast served?',
    {
      intent_classification: 'policy_inquiry',
      knowledge_routing: 'retrieval',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'Published schedule. Mostly here because the lexical baseline must read "how much coffee" as menu and not as price — see the word-boundary note in the knowledge package.',
  ),
  entry(
    'en-parking',
    'en',
    'Do you have parking, and how much is it per night?',
    {
      intent_classification: 'pricing_inquiry',
      knowledge_routing: 'structured_truth',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'Availability plus price in one sentence. The price clause owns the routing answer: a fee is derived, not published.',
  ),
  entry(
    'en-cancel-my-booking',
    'en',
    'I need to cancel my booking for next week.',
    {
      intent_classification: 'support_request',
      knowledge_routing: 'structured_truth',
      clarification: 'clarify',
      handoff_recommendation: 'handoff',
      evidence_sufficiency: 'sufficient',
    },
    'A destructive action on live state. The reservation system identifies the booking; the tenant cannot act on it, so the turn confirms the booking and hands off rather than promising a cancellation it cannot perform.',
  ),

  /* --------------------------------------------------------- Indonesian -- */

  entry(
    'id-berapa-harga-treetop',
    'id',
    'Berapa harga kamar treetop suite?',
    {
      intent_classification: 'pricing_inquiry',
      knowledge_routing: 'structured_truth',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'Foundation example, quoted verbatim. "harga" is a price keyword, so the pricebook owns the answer — not the room description.',
  ),
  entry(
    'id-jumlah-kamar',
    'id',
    'Ada berapa kamar yang tersedia?',
    {
      intent_classification: 'availability_inquiry',
      knowledge_routing: 'structured_truth',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    '"tersedia" is an availability keyword. Inventory count in Indonesian, answered from live state.',
  ),
  entry(
    'id-minimal-menginap',
    'id',
    'Berapa malam minimal saya harus menginap?',
    {
      intent_classification: 'policy_inquiry',
      knowledge_routing: 'retrieval',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'Indonesian mirror of "how many nights can I stay?": the minimum-stay rule is published policy, and the possessive here concerns no live record, so retrieval answers it.',
  ),
  entry(
    'id-kebijakan-pembatalan',
    'id',
    'Bagaimana kebijakan pembatalan pemesanan?',
    {
      intent_classification: 'policy_inquiry',
      knowledge_routing: 'retrieval',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'Indonesian mirror of the cancellation-policy example. Published policy.',
  ),
  entry(
    'id-booking-status',
    'id',
    'Apakah pemesanan saya sudah dikonfirmasi?',
    {
      intent_classification: 'status_inquiry',
      knowledge_routing: 'structured_truth',
      clarification: 'clarify',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'Reservation confirmation is live state, so the ground truth is structured truth. This case exposed a missing Indonesian booking-status keyword; the deterministic classifier now protects it.',
  ),
  entry(
    'id-harga-malam-ini',
    'id',
    'Berapa harga kamar untuk malam ini?',
    {
      intent_classification: 'pricing_inquiry',
      knowledge_routing: 'structured_truth',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'Price for a specific night: derived at request time by the pricebook.',
  ),
  entry(
    'id-kamar-tersedia-selasa',
    'id',
    'Apakah masih ada kamar tersedia hari Selasa?',
    {
      intent_classification: 'availability_inquiry',
      knowledge_routing: 'structured_truth',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'Availability with a day anchor. The calendar answers it.',
  ),
  entry(
    'id-corporate-booking',
    'id',
    'Saya ingin bicara dengan bagian pemesanan korporat.',
    {
      intent_classification: 'handoff_request',
      knowledge_routing: 'retrieval',
      clarification: 'answer',
      handoff_recommendation: 'handoff',
      evidence_sufficiency: 'sufficient',
    },
    'Explicit handoff, phrased in Indonesian as a wish to reach a department rather than "a human".',
  ),
  entry(
    'id-rekomendasi-keluarga',
    'id',
    'Kamar mana yang cocok untuk keluarga dengan anak kecil?',
    {
      intent_classification: 'recommendation_request',
      knowledge_routing: 'retrieval',
      clarification: 'clarify',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'Recommendation. The turn needs the ages and the budget before it advises, and room copy is published knowledge either way.',
  ),
  entry(
    'id-ambigu',
    'id',
    'Bisa pesankan yang itu?',
    {
      intent_classification: 'purchase_request',
      knowledge_routing: 'retrieval',
      clarification: 'clarify',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'insufficient',
    },
    'Ambiguous reference in Indonesian. "yang itu" has no antecedent; asking is correct, guessing invents a room.',
  ),
  entry(
    'id-perbandingan',
    'id',
    'Apa bedanya kamar treetop suite dan canopy cabin?',
    {
      intent_classification: 'comparison_request',
      knowledge_routing: 'retrieval',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'Comparison, Indonesian phrasing. Two published products read side by side.',
  ),
  entry(
    'id-klaim-shuttle',
    'id',
    'Di website tertulis ada antar-jemput bandara. Masih berlaku?',
    {
      intent_classification: 'policy_inquiry',
      knowledge_routing: 'retrieval',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'insufficient',
    },
    'Unsupported factual claim in Indonesian. The turn must not adopt a service the tenant never published.',
  ),
  entry(
    'id-refund-masuk',
    'id',
    'Apakah dana pengembalian saya sudah masuk?',
    {
      intent_classification: 'support_request',
      knowledge_routing: 'structured_truth',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'Refund arrival is payment status, and the payment system owns it. This case exposed a missing Indonesian personal-refund keyword; the deterministic classifier now protects it.',
  ),
  entry(
    'id-cek-in-larut',
    'id',
    'Bisa check-in pukul dua malam?',
    {
      intent_classification: 'policy_inquiry',
      knowledge_routing: 'retrieval',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'Indonesian with an English loanword, the way a front-desk question is actually typed. Front-desk policy, published.',
  ),
  entry(
    'id-waktu-sarapan',
    'id',
    'Sarapan disajikan jam berapa?',
    {
      intent_classification: 'policy_inquiry',
      knowledge_routing: 'retrieval',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'Indonesian mirror of the breakfast-time case. Published schedule.',
  ),
  entry(
    'id-parkir-biaya',
    'id',
    'Apakah ada parkir dan berapa biaya parkir per malam?',
    {
      intent_classification: 'pricing_inquiry',
      knowledge_routing: 'structured_truth',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'Availability plus price. "biaya" is a price keyword; a fee is derived, not published.',
  ),
  entry(
    'id-sapaan',
    'id',
    'Halo, apa kabar?',
    {
      intent_classification: 'general_inquiry',
      knowledge_routing: 'retrieval',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'Ordinary Indonesian greeting. A provider that treats a greeting as a booking request is not ready.',
  ),

  /* --------------------------------------- Mixed Indonesian-English -- */

  entry(
    'mix-harga-tonight',
    'mixed',
    'Berapa price-nya untuk kamar deluxe malam ini?',
    {
      intent_classification: 'pricing_inquiry',
      knowledge_routing: 'structured_truth',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'Code-switching with an English price noun. The question is a price question in either language, and the pricebook answers it.',
  ),
  entry(
    'mix-available-weekend',
    'mixed',
    'Ada available room untuk weekend ini?',
    {
      intent_classification: 'availability_inquiry',
      knowledge_routing: 'structured_truth',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'Code-switching with an English availability adjective. Live state.',
  ),
  entry(
    'mix-book-available',
    'mixed',
    'Saya mau book yang available minggu ini?',
    {
      intent_classification: 'purchase_request',
      knowledge_routing: 'structured_truth',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'Purchase intent whose feasibility the availability system decides, phrased in the mixed language a visitor actually types.',
  ),
  entry(
    'mix-cancel-booking',
    'mixed',
    'My booking, mau di-cancel — bisa dicek dulu?',
    {
      intent_classification: 'support_request',
      knowledge_routing: 'structured_truth',
      clarification: 'clarify',
      handoff_recommendation: 'handoff',
      evidence_sufficiency: 'sufficient',
    },
    "Destructive action on the visitor's own reservation, asked in two languages at once. The reservation system identifies it; the tenant cannot perform the cancellation.",
  ),
  entry(
    'mix-perbandingan-worth-it',
    'mixed',
    'Which one lebih worth it, treetop atau canopy?',
    {
      intent_classification: 'comparison_request',
      knowledge_routing: 'retrieval',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'Comparison with a value judgement riding on it, in mixed language. Published room copy supplies the comparison.',
  ),
  entry(
    'mix-human-agent',
    'mixed',
    'Bisa transfer ke human agent, please?',
    {
      intent_classification: 'handoff_request',
      knowledge_routing: 'retrieval',
      clarification: 'answer',
      handoff_recommendation: 'handoff',
      evidence_sufficiency: 'sufficient',
    },
    'Explicit handoff, code-switched. The vocabulary a provider must recognise is two languages deep.',
  ),
  entry(
    'mix-klaim-shuttle',
    'mixed',
    'Katanya ada airport shuttle gratis, itu benar?',
    {
      intent_classification: 'policy_inquiry',
      knowledge_routing: 'retrieval',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'insufficient',
    },
    'Unsupported factual claim, code-switched. Free shuttle service the tenant never published.',
  ),
  entry(
    'mix-booking-confirmed',
    'mixed',
    'Booking saya sudah confirmed belum?',
    {
      intent_classification: 'status_inquiry',
      knowledge_routing: 'structured_truth',
      clarification: 'clarify',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'Reservation confirmation asked with an Indonesian possessive and an English participle. Live state owns it, and the turn must identify which booking.',
  ),
  entry(
    'mix-harga-dan-available',
    'mixed',
    'How much for the deluxe room and is it still available on Friday?',
    {
      intent_classification: 'pricing_inquiry',
      knowledge_routing: 'structured_truth',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'Price plus availability, phrased the way a bilingual visitor merges them. Both halves concern live state.',
  ),
  entry(
    'mix-ambigu',
    'mixed',
    'Pesankan yang tadi itu ya.',
    {
      intent_classification: 'purchase_request',
      knowledge_routing: 'retrieval',
      clarification: 'clarify',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'insufficient',
    },
    'Ambiguous reference, imperative form, Indonesian. No antecedent; asking beats guessing.',
  ),
  entry(
    'mix-kamar-available',
    'mixed',
    'Do you have kamar available for tonight?',
    {
      intent_classification: 'availability_inquiry',
      knowledge_routing: 'structured_truth',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'Indonesian noun inside an English sentence. The availability system answers it in whichever language the frame is in.',
  ),
  entry(
    'mix-cancellation-hujan',
    'mixed',
    'Cancellation policy-nya gimana kalau hujan deras?',
    {
      intent_classification: 'policy_inquiry',
      knowledge_routing: 'retrieval',
      clarification: 'answer',
      handoff_recommendation: 'self_serve',
      evidence_sufficiency: 'sufficient',
    },
    'Policy question, code-switched, with a reason attached. Published policy — unless the tenant has written a weather clause, in which case the answer is the clause, not an invented one.',
  ),
]

function tallyBy(
  cases: readonly EvaluationCase[],
  key: (c: EvaluationCase) => CorpusLocale,
): Record<CorpusLocale, number> {
  const counts: Record<CorpusLocale, number> = { en: 0, id: 0, mixed: 0 }
  for (const c of cases) counts[key(c)] += 1
  return counts
}

/** How many cases each language contributes. Kept computed so the counts in the report cannot drift from the corpus. */
export const CORPUS_LANGUAGE_COUNTS: Readonly<Record<CorpusLocale, number>> = tallyBy(
  REFERENCE_CORPUS,
  (c) => c.locale,
)

export const CORPUS_SIZE: number = REFERENCE_CORPUS.length

/** The tasks every case is expected to answer. The other three are optional per case, so a case only speaks to the decision it is actually about. */
export const CORPUS_CORE_TASKS = ['intent_classification', 'knowledge_routing'] as const

/**
 * Why a corpus is unusable, in reading order. Empty means the corpus is unique,
 * non-empty, and every label sits inside its task's vocabulary.
 *
 * `corpus.test.ts` runs this over `REFERENCE_CORPUS`, so a hand-added case
 * cannot quietly invent a task or a label the metrics would then have to
 * interpret as an out-of-vocabulary prediction.
 */
export function corpusProblems(
  cases: readonly EvaluationCase[],
  knownTasks: readonly DecisionTaskId[],
  knownLabels: (task: DecisionTaskId) => readonly string[],
): string[] {
  const problems: string[] = []
  const seen = new Set<string>()

  for (const evaluationCase of cases) {
    if (seen.has(evaluationCase.id)) problems.push(`duplicate case id: ${evaluationCase.id}`)
    seen.add(evaluationCase.id)

    if (evaluationCase.utterance.trim() === '')
      problems.push(`${evaluationCase.id}: empty utterance`)

    for (const [task, label] of Object.entries(evaluationCase.expected) as [
      DecisionTaskId,
      string,
    ][]) {
      if (!knownTasks.includes(task)) {
        problems.push(`${evaluationCase.id}: unknown task '${task}'`)
        continue
      }
      if (!knownLabels(task).includes(label)) {
        problems.push(`${evaluationCase.id}: unknown label '${label}' for ${task}`)
      }
    }

    for (const required of CORPUS_CORE_TASKS) {
      if (evaluationCase.expected[required] === undefined) {
        problems.push(`${evaluationCase.id}: missing expected ${required}`)
      }
    }
  }

  return problems
}
