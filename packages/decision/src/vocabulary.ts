/**
 * Cues for the deterministic provider: English, Indonesian, and the mixture.
 *
 * The reference tenant publishes Indonesian copy and takes questions in both
 * languages — and in practice a visitor writes "berapa harga untuk deluxe" in
 * one message and "can you book it" in the next. A cue set that only knows
 * English does not classify the tenant it ships with, and one that only knows
 * Indonesian fails the mixed case the corpus is full of.
 *
 * What is deliberately *not* here is Foundation's own keyword table. This
 * provider is a stand-in for a live model, not a second implementation of
 * `classifyKnowledgeNeed`: it answers with a confidence derived from how many
 * cues fired, and it is allowed to be cruder. Duplicating the structured-truth
 * keywords would make the CI baseline too good — it would agree with production
 * almost always, and the disagreement rate is the signal the eval corpus
 * measures.
 *
 * Matching is on normalized word segments, so `harga` does not fire inside
 * `hargai`, and a cue is counted once per task however often it appears.
 * Nothing here reads a tenant's schema, a store, a clock, or a network.
 */
import type { DecisionTask } from './tasks.js'

/** Cues for one candidate answer of a task. */
export interface CueSet {
  /** Words or short phrases that vote for this answer. */
  readonly toward: readonly string[]
  /** Words or short phrases that vote against it, so a mixed sentence can lean. */
  readonly away?: readonly string[]
}

/**
 * Cues per task, keyed by task id.
 *
 * `Partial` is the point: a task the catalogue gains and this table does not is
 * a task the baseline refuses rather than guesses at, and the compiler keeps
 * that branch honest by making the hole a hole rather than an empty record.
 * The catalogue test asserts the same thing at run time.
 */
export const CUES: Partial<Readonly<Record<DecisionTask, Readonly<Record<string, CueSet>>>>> = {
  intent_classification: {
    general_inquiry: {
      toward: [
        'breakfast',
        'pool',
        'wifi',
        'gym',
        'parking',
        'spa',
        'facility',
        'facilities',
        'sarapan',
        'kolam',
        'parkir',
        'fasilitas',
        'lobby',
        'room',
        'kamar',
        'suite',
        'bed',
        'kasur',
        'towel',
        'handuk',
        'location',
        'near',
        'lokasi',
        'dekat',
        'restoran',
        'restaurant',
      ],
      away: ['price', 'biaya', 'harga', 'book', 'pesan', 'cancel', 'batal', 'pay', 'bayar'],
    },
    policy_inquiry: {
      toward: [
        'policy',
        'cancellation',
        'refund',
        'check in',
        'check out',
        'rules',
        'allowed',
        'kebijakan',
        'pembatalan',
        'aturan',
        'boleh',
        'late',
        'terlambat',
        'deposit',
      ],
      away: ['price', 'biaya', 'harga', 'book', 'pesan', 'room', 'kamar'],
    },
    availability_inquiry: {
      toward: [
        'book',
        'booking',
        'reserve',
        'reservation',
        'availability',
        'available',
        'pesan',
        'pemesanan',
        'reservasi',
        'tersedia',
        'kosong',
        'kamar kosong',
        'i want',
        'saya ingin',
        'pengen',
      ],
      away: ['price', 'biaya', 'harga', 'pool', 'kolam', 'breakfast', 'sarapan'],
    },
    support_request: {
      toward: [
        'help',
        'problem',
        'issue',
        'broken',
        'wrong',
        'complaint',
        'staff',
        'human',
        'agent',
        'manager',
        'bantuan',
        'masalah',
        'rusak',
        'komplain',
        'keluhan',
        'staf',
        'manajer',
      ],
    },
    pricing_inquiry: {
      toward: [
        'price',
        'pricing',
        'cost',
        'rate',
        'fee',
        'harga',
        'biaya',
        'tarif',
        'berapa harga',
      ],
    },
    status_inquiry: {
      toward: [
        'my booking',
        'my order',
        'payment status',
        'booking status',
        'status pesanan',
        'status pembayaran',
        'pesanan saya',
        'reservasi saya',
      ],
    },
    recommendation_request: {
      toward: [
        'recommend',
        'suggest',
        'best for',
        'which room suits',
        'rekomendasi',
        'sarankan',
        'yang cocok',
        'pilihkan',
      ],
    },
    comparison_request: {
      toward: [
        'compare',
        'comparison',
        'versus',
        'difference',
        'bandingkan',
        'perbedaan',
        'lebih baik',
      ],
    },
    handoff_request: {
      toward: [
        'human',
        'person',
        'staff',
        'agent',
        'manager',
        'manusia',
        'staf',
        'manajer',
        'orang asli',
      ],
    },
    purchase_request: {
      toward: [
        'purchase',
        'buy',
        'checkout',
        'pay now',
        'beli',
        'bayar sekarang',
        'lanjut pembayaran',
      ],
    },
  },
  knowledge_routing: {
    structured_truth: {
      toward: [
        'price',
        'pricing',
        'cost',
        'fee',
        'rate',
        'charge',
        'quote',
        'biaya',
        'harga',
        'berapa',
        'how much is',
        'how much are',
        'stock',
        'available',
        'availability',
        'tersedia',
        'ketersediaan',
        'kosong',
        'sisa kamar',
        'payment',
        'paid',
        'invoice',
        'pembayaran',
        'tagihan',
        'shipping',
        'kirim',
        'pengiriman',
        'status pesanan',
        'pesanan saya',
        'my booking',
        'status pembatalan',
      ],
    },
    retrieval_knowledge: {
      toward: [
        'policy',
        'facility',
        'facilities',
        'breakfast',
        'explain',
        'tell me about',
        'included',
        'service',
        'rules',
        'hours',
        'kebijakan',
        'fasilitas',
        'sarapan',
        'jelaskan',
        'tentang',
        'apa itu',
        'aturan',
        'layanan',
      ],
    },
  },
  clarification: {
    true: {
      toward: [
        'or',
        'maybe',
        'not sure',
        'either',
        'which one',
        'both',
        'atau',
        'mungkin',
        'mana',
        'salah satu',
        'yang mana',
      ],
    },
  },
  handoff_recommendation: {
    true: {
      toward: [
        'speak to',
        'talk to',
        'real person',
        'human',
        'agent',
        'manager',
        'staff',
        'complaint',
        'complain',
        'frustrated',
        'angry',
        'unacceptable',
        'third time',
        'bicarakan',
        'ngomong',
        'orang',
        'manusia',
        'staf',
        'manajer',
        'berkali',
        'marah',
        'nggak bisa',
        'tidak bisa',
        'komplain',
        'keluhan',
      ],
    },
  },
  // No entry for `evidence_sufficiency`: the score is measured from what the
  // request carried, and a word that predicted it would be the same lie a
  // language model would tell. See `scoreCoverage` in the rule provider.
}

/**
 * A cue occupying whole word boundaries.
 *
 * The obvious alternative — `includes` — makes `pool` fire inside `swimming`
 * and `book` inside `facebook`, which for this package is a booking intent
 * invented from a facility question. The cost of the check is two comparisons.
 */
export function mentions(lowercaseUtterance: string, cue: string): boolean {
  const from = lowercaseUtterance.indexOf(cue)
  if (from === -1) return false
  const before = lowercaseUtterance[from - 1]
  const afterIndex = from + cue.length
  const after = lowercaseUtterance[afterIndex]
  const wordEdge = (character: string | undefined): boolean =>
    character === undefined || /[^a-z0-9]/.test(character)
  return wordEdge(before) && wordEdge(after)
}

/**
 * An utterance normalized: lowercased, punctuation folded to spaces.
 *
 * Normalizing once, here, means the cue table is written in the language it
 * appears in — "berapa harga", not "berapa,   harga" — and the same folding is
 * available to a phrase cue so both sides of a match agree.
 */
export function normalizeUtterance(utterance: string): string {
  return utterance
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** The normalized form of a cue, for a multi-word phrase. */
export function normalizeCue(cue: string): string {
  return cue
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}
