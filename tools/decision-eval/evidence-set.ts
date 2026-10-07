/**
 * The labelled evidence-sufficiency set.
 *
 * Twenty-eight synthetic cases — ten in English and nine each in Indonesian and
 * the code-switching the reference tenant's visitors actually type — with all
 * six hazards present in every language, so a per-locale number and a
 * per-hazard number mean the same thing whichever language they were measured
 * in.
 *
 * Why this is not the reference corpus: those 51 utterances carry an
 * `evidence_sufficiency` label and no evidence to judge. Sufficiency is a
 * relation between a question and what was supplied for it, so a label without
 * the supplied thing is a statement about the tenant's knowledge rather than
 * about the evidence, and scoring one would fold a tenant-level guess into a
 * metric that claims to measure a provider. This set keeps the two apart: the
 * harness that scores it never reads the reference corpus's evidence labels,
 * and the reference corpus keeps scoring zero evidence answers.
 *
 * Why a `hazard` per case rather than a bare label: `insufficient` is where the
 * money is. Four unrelated things make evidence insufficient — it does not cover
 * the question, it only looks like it does, it contradicts itself, it is about a
 * different time — and a provider failing them for different reasons needs
 * different work. The fifth is the one PRD §17 exists for: a question the
 * tenant's live system owns, where the copy is readable, on topic, and still
 * not the answer.
 *
 * What no case here does: none of them makes retrieval the authority. No
 * sufficient case asks about a price, an availability, or a booking's status.
 * The live-authority questions are labelled insufficient on purpose, and a
 * provider that calls one of them sufficient has turned copy into a live value
 * — which the metrics count as its own critical failure rather than as an
 * ordinary miss.
 *
 * Synthetic end to end: a fictional guesthouse, `pg://synthetic/*` source ids,
 * no reservations, no real names, no emails, no phone numbers. Every question
 * and every excerpt is committed, so the set scores identically in CI and on a
 * laptop, and no live run has anywhere to read from but the commit.
 */

import type { CorpusLocale } from './corpus.js'
import { isKnownLabel, type EvidenceLabel } from './tasks.js'

/** The task's answer vocabulary, re-exported so a consumer needs one import. */
export type { EvidenceLabel }

/**
 * Why the supplied evidence earns the label it earned. One per case, so a
 * metric can be read by cause rather than as a single undifferentiated miss.
 *
 * `overlap` is the one worth spelling out, because it is the failure that looks
 * least like one: the page mentions the very thing asked about and never states
 * the fact. Breakfast in the context of a halal question is the canonical pair.
 * Vocabulary overlap is not factual support, and a judge that cannot tell them
 * apart is a judge that quotes an unrelated page.
 */
export const EVIDENCE_HAZARDS = [
  'supported',
  'missing',
  'overlap',
  'conflicting',
  'stale',
  'protected_truth',
] as const

export type EvidenceHazard = (typeof EVIDENCE_HAZARDS)[number]

/** Every label `evidence_sufficiency` may return, in report order. */
export const EVIDENCE_LABELS: readonly EvidenceLabel[] = ['sufficient', 'insufficient']

/** True when `value` is a label the task may return. */
export function isEvidenceLabel(value: string): value is EvidenceLabel {
  return isKnownLabel('evidence_sufficiency', value)
}

/**
 * The transactional subjects PRD §17 puts in the hands of live systems.
 *
 * Retrieval may supply supporting copy for a question about one of these, and
 * that is all. `null` in a case means published copy is allowed to be the
 * answer, which is the only kind of case that may be labelled sufficient.
 */
export const LIVE_SUBJECTS = ['price', 'availability', 'booking_status'] as const

export type LiveSubject = (typeof LIVE_SUBJECTS)[number]

const LABEL_FOR_HAZARD: Readonly<Record<EvidenceHazard, EvidenceLabel>> = {
  supported: 'sufficient',
  missing: 'insufficient',
  overlap: 'insufficient',
  conflicting: 'insufficient',
  stale: 'insufficient',
  protected_truth: 'insufficient',
}

/** The label a hazard deserves. A case that disagrees is a case that is wrong. */
export function labelForHazard(hazard: EvidenceHazard): EvidenceLabel {
  return LABEL_FOR_HAZARD[hazard]
}

/** One bounded excerpt of published content, already projected for the port. */
export interface EvidenceExcerpt {
  readonly sourceId: string
  readonly text: string
}

/**
 * A case's evidence, as the turn's projection hands it over: a page descriptor
 * plus the bounded excerpts. `entityCount` is metadata about the page — how many
 * things it mentions — and never an answer, which is why it sits beside the
 * excerpts instead of standing in for them.
 */
export interface EvidenceCase {
  readonly id: string
  readonly locale: CorpusLocale
  /** The visitor's question, as the turn received it. */
  readonly question: string
  readonly entityCount: number
  readonly excerpts: readonly EvidenceExcerpt[]
  /** Which live subject owns this question, or null when published copy may answer. */
  readonly liveSubject: LiveSubject | null
  readonly hazard: EvidenceHazard
  readonly expected: EvidenceLabel
  /** Why this label, in a sentence a reviewer can argue with. */
  readonly why: string
}

/**
 * One published excerpt as the provider sees it: an id to cite and the text.
 *
 * A projection rather than the stored excerpt, so a case can carry provenance
 * an edit represented and never reaches a provider prompt.
 */
export interface ProjectedExcerpt {
  readonly sourceId: string
  readonly text: string
}

/** The page a provider is told it may read, before any excerpt is attached. */
export interface ProjectedPage {
  readonly kind: 'synthetic-evidence'
  readonly locale: CorpusLocale
  readonly entityCount: number
}

/**
 * The evidence payload for one case, shaped the way `decisionEvidence` in
 * `packages/assistant` shapes the live one.
 *
 * Copied deliberately rather than imported: this tool must score a provider in
 * a repository state where the assistant package may not exist, and the shape
 * is the contract, not an implementation to share.
 */
export interface ProjectedEvidence {
  readonly page: ProjectedPage
  readonly publishedEvidence: readonly ProjectedExcerpt[]
}

/** Builds the payload for one case. The case itself is never sent. */
export function evidenceRequest(evaluationCase: EvidenceCase): ProjectedEvidence {
  return {
    page: {
      kind: 'synthetic-evidence',
      locale: evaluationCase.locale,
      entityCount: evaluationCase.entityCount,
    },
    publishedEvidence: evaluationCase.excerpts.map((excerpt) => ({
      sourceId: excerpt.sourceId,
      text: excerpt.text,
    })),
  }
}

/** The longest an excerpt may run, matching the assistant's 800-character slice. */
const MAX_EXCERPT_CHARS = 800

function case_(
  id: string,
  locale: CorpusLocale,
  question: string,
  entityCount: number,
  excerpts: readonly EvidenceExcerpt[],
  liveSubject: LiveSubject | null,
  hazard: EvidenceHazard,
  why: string,
): EvidenceCase {
  return {
    id,
    locale,
    question,
    entityCount,
    excerpts,
    liveSubject,
    hazard,
    expected: LABEL_FOR_HAZARD[hazard],
    why,
  }
}

function from(sourceId: string, text: string): EvidenceExcerpt {
  return { sourceId, text }
}

const ROOMS = 'pg://synthetic/rooms'
const FACILITIES = 'pg://synthetic/facilities'
const DINING = 'pg://synthetic/dining'
const POLICIES = 'pg://synthetic/policies'
const FAQ = 'pg://synthetic/faq'

export const EVIDENCE_SET: readonly EvidenceCase[] = [
  /* ------------------------------------------------------------- English -- */

  case_(
    'en-supported-pool-hours',
    'en',
    'Is there a swimming pool, and can guests use it?',
    3,
    [
      from(
        FACILITIES,
        'The guesthouse has one swimming pool on the garden level. It is open to every guest from 07:00 to 21:00 and is included in the room rate.',
      ),
    ],
    null,
    'supported',
    'Both halves of the question are stated outright on the facilities page: the pool exists, and guests may use it. Nothing is left to infer.',
  ),
  case_(
    'en-supported-quiet-hours',
    'en',
    'What are the quiet hours?',
    2,
    [
      from(
        POLICIES,
        'Quiet hours are 22:00 to 06:00. Please keep the corridors and the garden quiet during those hours.',
      ),
    ],
    null,
    'supported',
    'The policy page answers the question in its first sentence. One page, one fact, asked and supplied.',
  ),
  case_(
    'en-supported-parking',
    'en',
    'Can I park at the guesthouse?',
    2,
    [
      from(
        FACILITIES,
        'Free parking is available in the courtyard for up to four cars. Guests who need another space are directed to the public lot across the street.',
      ),
    ],
    null,
    'supported',
    'A yes-or-no question about the property, answered by the same page that owns the property’s facilities.',
  ),
  case_(
    'en-missing-checkout-fee',
    'en',
    'What time does late checkout start, and what does it cost?',
    0,
    [],
    null,
    'missing',
    'The turn reached a judge with nothing to judge: no page, no excerpt, no entity count. A judge that answers this with a number has invented it, and the only defensible answer is to say the facts do not cover it.',
  ),
  case_(
    'en-overlap-breakfast-halal',
    'en',
    'Is your breakfast halal certified?',
    3,
    [
      from(
        DINING,
        'Breakfast is served from 06:30 to 10:00 and includes nasi goreng, fried eggs, fresh fruit, and coffee or tea.',
      ),
    ],
    null,
    'overlap',
    'The page is entirely about breakfast, and breakfast is the subject of the question, so every noun overlaps. What it never states is a certification — not the word, not the certificate, not the body that issued it. Nearby vocabulary is not factual support, and this case is the one that catches a judge treating it as such.',
  ),
  case_(
    'en-overlap-garden-villa-view',
    'en',
    'Does the garden villa have a view of Mount Merapi?',
    4,
    [
      from(
        ROOMS,
        'The garden villa is a two-bedroom unit with a private terrace, a king bed and a daybed. It sleeps four guests. Non-smoking.',
      ),
    ],
    null,
    'overlap',
    'The page describes the villa in detail and "garden" appears in the question, so a keyword judge fires. The page never mentions a view, a window, or a landmark. A description of a room is not a statement about what can be seen from it.',
  ),
  case_(
    'en-conflicting-terrace-smoking',
    'en',
    'Can I smoke on the terrace?',
    3,
    [
      from(
        POLICIES,
        'The whole property is non-smoking. Smoking is permitted only in the parking area.',
      ),
      from(ROOMS, 'The garden villa has a private terrace where guests may smoke in the evening.'),
    ],
    null,
    'conflicting',
    'Two committed pages contradict each other on the one fact asked. Coverage that cannot be reconciled is not coverage: whichever page is quoted, half of the tenant’s published knowledge disagrees with the answer.',
  ),
  case_(
    'en-stale-rooftop-season',
    'en',
    'Is breakfast served on the rooftop terrace this season?',
    2,
    [
      from(
        DINING,
        'For the 2024 dry season, breakfast is served in the rooftop terrace from 06:00 to 10:00.',
      ),
    ],
    null,
    'stale',
    'On topic, readable, and about a different season than the one asked about. "This season" against a page that names its own is a period the evidence does not cover, and a judge that ignores when a fact was true quotes a closed season as current.',
  ),
  case_(
    'en-protected-booking-status',
    'en',
    'Is my booking confirmed?',
    2,
    [
      from(
        FAQ,
        'We send a confirmation email within a few hours of every booking. The email lists your arrival date, room type, and the amount paid.',
      ),
    ],
    'booking_status',
    'protected_truth',
    'The question is about the state of one specific reservation, which the reservation system owns. The supplied page explains how confirmations work in general — readable, on topic, and still not the answer. Retrieval may support the reply; it may never be the authority for a booking’s status, and a judge that calls this sufficient has turned copy into a live value.',
  ),
  case_(
    'en-protected-price-tonight',
    'en',
    'How much is the treetop suite for tonight?',
    2,
    [
      from(
        ROOMS,
        'The treetop suite sleeps two guests and opens onto the garden. Our published rate card for this season starts at 850,000 rupiah per night for a standard room.',
      ),
    ],
    'price',
    'protected_truth',
    'The number a judge would quote is a rate card entry — real, on topic, downloadable — and it is not the price of this suite on this night. Tonight’s rate is the pricing system’s answer, and a judge that calls this sufficient has turned a published starting price into a live one.',
  ),

  /* --------------------------------------------------------- Indonesian -- */

  case_(
    'id-supported-pembatalan',
    'id',
    'Berapa lama sebelum check-in pembatalan masih gratis?',
    3,
    [
      from(
        POLICIES,
        'Pembatalan gratis berlaku hingga 3 hari sebelum tanggal check-in. Setelah itu, satu malam akan dikenakan biaya.',
      ),
    ],
    null,
    'supported',
    'The policy page states the deadline outright. A property rule the tenant wrote, answered from the page the tenant wrote.',
  ),
  case_(
    'id-supported-waktu-sarapan',
    'id',
    'Sarapan disajikan mulai jam berapa?',
    2,
    [from(DINING, 'Sarapan disajikan pukul 06.30 sampai 10.00 di ruang makan utama.')],
    null,
    'supported',
    'Asked and answered in one sentence of the dining page.',
  ),
  case_(
    'id-supported-wifi',
    'id',
    'Apakah tamu bisa memakai wifi?',
    2,
    [
      from(
        FACILITIES,
        'Wifi gratis tersedia di seluruh area tamu dan di setiap kamar. Kata sandi diberikan saat check-in.',
      ),
    ],
    null,
    'supported',
    'A yes-or-no question about the property, answered by the facilities page that owns it.',
  ),
  case_(
    'id-missing-extra-bed',
    'id',
    'Apakah ada extra bed di kamar ini, dan berapa biayanya?',
    0,
    [],
    null,
    'missing',
    'Retrieval came back with nothing at all for this turn: no page, no excerpt, no entity count. A judge that answers with a number has invented it, and the only defensible answer is that the facts do not cover it.',
  ),
  case_(
    'id-overlap-lift-lantai-atas',
    'id',
    'Apakah ada lift ke lantai atas?',
    3,
    [
      from(
        FACILITIES,
        'Lantai atas menyediakan empat kamar, sebuah ruang baca, dan balkon bersama untuk semua tamu.',
      ),
    ],
    null,
    'overlap',
    '“Lantai atas” appears verbatim on the page, so a keyword judge calls the question covered. The page describes what is upstairs and never mentions a lift — the exact shape of overlap without support.',
  ),
  case_(
    'id-overlap-kolam-air-panas',
    'id',
    'Apakah kolam renang memakai air hangat?',
    3,
    [
      from(
        FACILITIES,
        'Kolam renang di lantai taman terbuka untuk semua tamu dari pukul 07.00 sampai 21.00 dan sudah termasuk dalam harga kamar.',
      ),
    ],
    null,
    'overlap',
    'The page covers the pool at length — hours, price, location — and is silent on the one attribute asked. Being thorough about a subject is not being sufficient about a question.',
  ),
  case_(
    'id-conflicting-jam-check-in',
    'id',
    'Jam berapa check-in dibuka?',
    3,
    [
      from(POLICIES, 'Check-in mulai pukul 14.00 dan check-out sampai pukul 12.00.'),
      from(
        ROOMS,
        'Kamar sudah bisa digunakan sejak pukul 12.00. Jika kamar masih kosong, tamu boleh masuk lebih awal.',
      ),
    ],
    null,
    'conflicting',
    'Two committed pages give different check-in times. The answer is not “14.00” or “12.00” — it is that the tenant’s own knowledge disagrees with itself.',
  ),
  case_(
    'id-stale-ac-2024',
    'id',
    'Apakah semua kamar sudah pakai AC baru?',
    2,
    [from(ROOMS, 'Pada tahun 2024, seluruh kamar di lantai satu dilengkapi dengan unit AC baru.')],
    null,
    'stale',
    'The page is on topic and specific — about last year, and about one floor. It says which rooms were re-fitted and when, and the question asks about all of them now.',
  ),
  case_(
    'id-protected-status-pembayaran',
    'id',
    'Apakah pemesanan saya sudah lunas?',
    2,
    [
      from(
        FAQ,
        'Kami mengirimkan faktur setelah pembayaran diterima. Pembayaran dapat dilakukan melalui transfer bank atau kartu.',
      ),
    ],
    'booking_status',
    'protected_truth',
    'Whether one reservation is paid is the reservation system’s fact, and the supplied page describes how invoicing works in general. A judge that calls this sufficient has read a payment policy as a payment status.',
  ),

  /* --------------------------------------------------------------- Mixed -- */

  case_(
    'mixed-supported-airport-shuttle',
    'mixed',
    'Is there an airport shuttle? Bisa antar ke bandara?',
    2,
    [
      from(
        FACILITIES,
        'We arrange airport pickup for guests who request it at least one day before arrival. Shuttle berangkat dari pintu kedatangan.',
      ),
    ],
    null,
    'supported',
    'The bilingual facilities page answers a code-switched question in the language it was asked in. Nothing here needs a live system: the shuttle is a service the tenant publishes.',
  ),
  case_(
    'mixed-supported-hewan-peliharaan',
    'mixed',
    'Boleh bawa hewan peliharaan? Are pets allowed inside?',
    2,
    [
      from(
        POLICIES,
        'Pets are welcome in the garden rooms. Hewan peliharaan tidak diperbolehkan di area kolam renang dan ruang makan.',
      ),
    ],
    null,
    'supported',
    'A policy question answered by a page that states the rule twice, once per language. The negative half is part of the answer and the page carries it.',
  ),
  case_(
    'mixed-supported-front-desk-hours',
    'mixed',
    'What time does the front desk close? Front desk tutup jam berapa?',
    1,
    [
      from(
        FACILITIES,
        'Front desk kami buka 24 jam. Kalau butuh bantuan malam hari, hubungi staf di lobi.',
      ),
    ],
    null,
    'supported',
    'One page states a standing fact about the property. Published copy is the authority for this, and the copy is there.',
  ),
  case_(
    'mixed-missing-tiket-tur',
    'mixed',
    'Bisa beli tiket tur Borobudur dari sini? Berapa?',
    0,
    [],
    null,
    'missing',
    'The turn carries no excerpt at all, so there is nothing to judge — and the question also asks for a price, which no committed page could answer anyway. Both reasons point the same way: the facts do not cover it.',
  ),
  case_(
    'mixed-overlap-sarapan-halal',
    'mixed',
    'Is the breakfast halal certified? Sarapan di sini halal?',
    3,
    [
      from(
        DINING,
        'Sarapan disajikan mulai pukul 06.30 dengan pilihan nasi goreng, telur mata sapi, buah segar, dan kopi.',
      ),
    ],
    null,
    'overlap',
    'The same trap as its English twin, code-switched. The page names every dish and never mentions a certification, and a judge that reads dish lists as answers will say yes to this one.',
  ),
  case_(
    'mixed-overlap-bathtub',
    'mixed',
    'Does the room have a bathtub? Ada bathtub tidak?',
    3,
    [
      from(
        ROOMS,
        'Every room has a private bathroom with hot shower, hand towels, and complimentary toiletries.',
      ),
    ],
    null,
    'overlap',
    'The question is about a bathroom fixture and the page describes the bathroom, so the subject overlaps on every word. It says “shower”. The fixture asked about is a different fixture.',
  ),
  case_(
    'mixed-conflicting-late-checkout',
    'mixed',
    'Kalau telat check-out kena denda berapa?',
    3,
    [
      from(
        POLICIES,
        'Late checkout setelah pukul 12.00 dikenakan biaya setengah harga kamar per jam.',
      ),
      from(FAQ, 'There is no charge for checking out up to two hours late.'),
    ],
    null,
    'conflicting',
    'Two committed pages contradict each other on what a late checkout costs. The page that names a rate is the tempting one, and a rate quoted from copy is not a rate.',
  ),
  case_(
    'mixed-stale-sauna-2023',
    'mixed',
    'Apakah sauna masih tersedia?',
    4,
    [
      from(
        FACILITIES,
        'Fasilitas kami pada tahun 2023: kolam renang, wifi, parkir, dan sauna kering.',
      ),
    ],
    null,
    'stale',
    'The page dates itself. It lists a facility that existed in 2023 and answers nothing about whether it exists now, and “masih tersedia” is a question about now.',
  ),
  case_(
    'mixed-protected-kamar-tersedia',
    'mixed',
    'Is the treetop suite available tonight? Kamar itu kosong?',
    2,
    [
      from(
        ROOMS,
        'The treetop suite is one of our six rooms. It is popular on weekends and is usually booked early.',
      ),
    ],
    'availability',
    'protected_truth',
    'Availability for one specific night is the availability snapshot’s answer. A published page saying a room is “usually booked early” is a marketing sentence about a room, not a statement about tonight — and it is exactly the sentence a coverage judge will call sufficient.',
  ),
]

export const EVIDENCE_SET_SIZE = EVIDENCE_SET.length

function tallyBy<T extends string>(
  cases: readonly EvidenceCase[],
  of: (evaluationCase: EvidenceCase) => T,
): Readonly<Record<T, number>> {
  const counts = {} as Record<T, number>
  for (const evaluationCase of cases) {
    const key = of(evaluationCase)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

export const EVIDENCE_LANGUAGE_COUNTS = tallyBy(
  EVIDENCE_SET,
  (evaluationCase) => evaluationCase.locale,
)
export const EVIDENCE_LABEL_COUNTS = tallyBy(
  EVIDENCE_SET,
  (evaluationCase) => evaluationCase.expected,
)
export const EVIDENCE_HAZARD_COUNTS = tallyBy(
  EVIDENCE_SET,
  (evaluationCase) => evaluationCase.hazard,
)
export const EVIDENCE_LIVE_SUBJECT_COUNTS = tallyBy(
  EVIDENCE_SET,
  (evaluationCase) => evaluationCase.liveSubject ?? 'published',
)

/**
 * Every way this set could be wrong, as readable sentences.
 *
 * A dataset is data, and data rots silently: a case whose label contradicts its
 * own hazard, a hazard that disappears because a case was edited, a language
 * that keeps only one label and so makes its per-locale number meaningless. The
 * harness throws on a non-empty answer, so a set that stops being able to
 * measure anything fails a test rather than quietly scoring zero.
 */
export function evidenceSetProblems(cases: readonly EvidenceCase[]): readonly string[] {
  const problems: string[] = []
  if (cases.length === 0) problems.push('the evidence set is empty')

  const seen = new Set<string>()
  for (const evaluationCase of cases) {
    if (seen.has(evaluationCase.id)) problems.push(`duplicate id ${evaluationCase.id}`)
    seen.add(evaluationCase.id)
    if (evaluationCase.question.trim() === '') problems.push(`${evaluationCase.id} has no question`)
    if (evaluationCase.why.trim() === '') problems.push(`${evaluationCase.id} does not say why`)
    if (!isEvidenceLabel(evaluationCase.expected)) {
      problems.push(
        `${evaluationCase.id} expects ${String(evaluationCase.expected)}, not an evidence_sufficiency label`,
      )
    } else if (evaluationCase.expected !== labelForHazard(evaluationCase.hazard)) {
      problems.push(
        `${evaluationCase.id} is labelled ${evaluationCase.expected} but its ${evaluationCase.hazard} evidence is ${labelForHazard(evaluationCase.hazard)}`,
      )
    }
    const live = evaluationCase.liveSubject !== null
    if (live !== (evaluationCase.hazard === 'protected_truth')) {
      problems.push(`${evaluationCase.id} disagrees with itself about who owns the answer`)
    }
    if (
      live &&
      evaluationCase.liveSubject !== null &&
      !LIVE_SUBJECTS.includes(evaluationCase.liveSubject)
    ) {
      problems.push(`${evaluationCase.id} names a live subject nobody defined`)
    }
    if (live && evaluationCase.expected !== 'insufficient') {
      problems.push(`${evaluationCase.id} lets retrieval answer a live question`)
    }
    if (evaluationCase.hazard === 'overlap' && evaluationCase.excerpts.length === 0) {
      problems.push(`${evaluationCase.id} claims overlap with nothing to overlap`)
    }
    if (evaluationCase.hazard === 'protected_truth' && evaluationCase.excerpts.length === 0) {
      problems.push(`${evaluationCase.id} shows the tempting copy that is not the answer`)
    }
    if (evaluationCase.hazard === 'supported' && evaluationCase.excerpts.length === 0) {
      problems.push(`${evaluationCase.id} is sufficient with no supplied evidence`)
    }
    for (const excerpt of evaluationCase.excerpts) {
      if (excerpt.sourceId.trim() === '')
        problems.push(`${evaluationCase.id} has an unnamed excerpt`)
      if (excerpt.text.trim() === '') problems.push(`${evaluationCase.id} has an empty excerpt`)
      if (excerpt.text.length > MAX_EXCERPT_CHARS) {
        problems.push(`${evaluationCase.id} has an excerpt past ${MAX_EXCERPT_CHARS} characters`)
      }
    }
  }

  for (const locale of ['en', 'id', 'mixed'] as const) {
    const inLocale = cases.filter((evaluationCase) => evaluationCase.locale === locale)
    if (inLocale.length === 0) {
      problems.push(`no ${locale} cases`)
      continue
    }
    const labels = tallyBy(inLocale, (evaluationCase) => evaluationCase.expected)
    for (const label of EVIDENCE_LABELS) {
      if ((labels[label] ?? 0) === 0) {
        problems.push(
          `no ${label} case in ${locale}, so its per-locale ${label} number is meaningless`,
        )
      }
    }
  }

  const hazards = tallyBy(cases, (evaluationCase) => evaluationCase.hazard)
  for (const hazard of EVIDENCE_HAZARDS) {
    if ((hazards[hazard] ?? 0) === 0) problems.push(`no ${hazard} case, so nothing measures it`)
  }

  if (!cases.some((evaluationCase) => evaluationCase.excerpts.length === 0)) {
    problems.push('no case with no evidence at all, so an empty request is never exercised')
  }
  if (!cases.some((evaluationCase) => evaluationCase.excerpts.length > 1)) {
    problems.push('no case with more than one page, so a contradiction is never exercised')
  }

  const liveSubjects = new Set(cases.map((evaluationCase) => evaluationCase.liveSubject))
  for (const subject of LIVE_SUBJECTS) {
    if (!liveSubjects.has(subject)) {
      problems.push(`no case about ${subject}, a live subject PRD 17 puts beyond retrieval`)
    }
  }

  return problems
}
