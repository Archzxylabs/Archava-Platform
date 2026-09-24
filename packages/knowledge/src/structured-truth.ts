/**
 * Structured truth vs retrieval knowledge (PRD.md §17).
 *
 * The rule the PRD states as an absolute: "Do not answer these from stale
 * vector retrieval when a live system exists."
 *
 * So the split is not a preference the model may weigh. It is a classification
 * made *before* retrieval: a question about price, stock, availability,
 * booking status, an order, a payment, a shipment or an account must be
 * answered from a live authoritative source, and retrieval may only supply
 * supporting copy — never the answer itself.
 */

export const STRUCTURED_TRUTH_SUBJECTS = [
  'price',
  'stock',
  'availability',
  'booking_status',
  'customer_or_order',
  'payment_status',
  'shipping_status',
  'account_state',
] as const
export type StructuredTruthSubject = (typeof STRUCTURED_TRUTH_SUBJECTS)[number]

export type KnowledgeNeed = 'structured_truth' | 'retrieval_knowledge'

export interface KnowledgeClassification {
  readonly need: KnowledgeNeed
  /** Present when the question touches structured truth. */
  readonly subjects: readonly StructuredTruthSubject[]
  /** Which signals fired, for the audit trail. */
  readonly matched: readonly string[]
}

/**
 * Keyword triage. Deliberately lexical and deliberately generous: a false
 * positive only means the answer comes from the live system, which is safer
 * than the reverse.
 */
const SUBJECT_KEYWORDS: Readonly<Record<StructuredTruthSubject, readonly string[]>> = {
  price: [
    'price',
    'pricing',
    'cost',
    'costs',
    'fee',
    'fees',
    'rate',
    'rates',
    'charge',
    'charges',
    'discount',
    'quote',
    'how much',
    'biaya',
    'harga',
  ],
  // Inventory counts phrased without saying the word "stock". "How many rooms do
  // you have" is a stock question in every tenant's voice, and without these it
  // fell through to retrieval and came back `basis: 'none'` while the port sat
  // holding the answer. Note what is deliberately absent: a bare 'how many',
  // which would also swallow "how many nights is the stay" — an availability
  // question answered from a stock table. Each keyword names the thing being
  // counted, so the count and the thing stay together.
  stock: [
    'stock',
    'inventory',
    'in stock',
    'out of stock',
    'available units',
    'stok',
    'how many rooms',
    'how many units',
    'how many properties',
    'how many villas',
    'rooms available',
    'units available',
    'rooms left',
    'units left',
  ],
  // Availability asked for with the word for the act, not the noun. "What can I
  // book" is a stay question wearing the verb, and without it the question fell
  // through to retrieval — where the tenant's published content says nothing
  // about what is bookable — so the port was never asked and the answer came
  // back `basis: 'none'` while the availability snapshot held it. `book` on its
  // own is deliberately not here: that is either a `booking_status` question
  // about the visitor's own reservation or a page action, and neither is what
  // this subject answers.
  availability: [
    'availability',
    'available',
    'vacancy',
    'vacant',
    'open slot',
    'slots',
    'tersedia',
    'what can i book',
    'can i book',
    'can you book',
    'bookable',
    'rooms free',
    'any rooms left',
  ],
  booking_status: [
    'booking status',
    'reservation status',
    'my booking',
    'is my booking',
    'confirmed booking',
    'booking confirmation',
  ],
  customer_or_order: [
    'my order',
    'order status',
    'order id',
    'track my order',
    'customer data',
    'my profile',
    'my history',
  ],
  payment_status: [
    'payment status',
    'payment confirmation',
    'did my payment',
    'invoice status',
    'my invoice',
    'payment failed',
    'refund status',
  ],
  shipping_status: [
    'shipping status',
    'delivery status',
    'track my shipment',
    'where is my parcel',
    'shipped',
    'courier',
  ],
  account_state: [
    'account state',
    'my subscription',
    'my plan',
    'usage this month',
    'quota',
    'my contract',
    'dunning',
  ],
}

/** Anything that looks like a question about this tenant's own live data. */
const POSSESSIVE_PATTERN = /\b(my|our)\b/i

/** Classify what a visitor question needs before any retrieval happens. */
export function classifyKnowledgeNeed(query: string): KnowledgeClassification {
  const haystack = ` ${query
    .toLowerCase()
    .replace(/[^a-z0-9'’]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `
  const matched: StructuredTruthSubject[] = []

  for (const subject of STRUCTURED_TRUTH_SUBJECTS) {
    const keywords = SUBJECT_KEYWORDS[subject] ?? []
    if (keywords.some((keyword) => haystack.includes(keyword))) {
      matched.push(subject)
    }
  }

  if (matched.length > 0) {
    return { need: 'structured_truth', subjects: matched, matched: matched }
  }

  // A possessive question ("where is my order?") is about live data even when
  // the noun is not on the keyword list.
  if (POSSESSIVE_PATTERN.test(query)) {
    return { need: 'structured_truth', subjects: ['customer_or_order'], matched: ['possessive'] }
  }

  return { need: 'retrieval_knowledge', subjects: [], matched: [] }
}

/** True when the answer must come from a live system, never from retrieval. */
export function requiresStructuredTruth(query: string): boolean {
  return classifyKnowledgeNeed(query).need === 'structured_truth'
}

export type AnswerBasis = 'structured_truth' | 'retrieval'

export interface AttributedAnswer<T> {
  readonly value: T
  /** How the answer was sourced, for evals and debugging (§17). */
  readonly basis: AnswerBasis
  /** Chunk ids the answer was grounded in, for the same reason. */
  readonly citations: readonly string[]
}

/**
 * Build the record that travels with an answer. Keeping provenance on the
 * answer — not only on the chunks — is what makes "which source produced this
 * line?" answerable after the fact.
 */
export function attribute<T>(
  value: T,
  basis: AnswerBasis,
  citations: readonly string[] = [],
): AttributedAnswer<T> {
  return { value, basis, citations: [...citations] }
}
