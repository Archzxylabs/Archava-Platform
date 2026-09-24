/**
 * The reference tenant's retrieval knowledge — PRD §17's other half.
 *
 * `rates.ts` answers the questions that must come from a live system. This file
 * is the counterpart: the published prose a resort would actually maintain, for
 * the questions that are genuinely a matter of policy and operations. A
 * visitor asking what time breakfast opens is not asking a PMS anything.
 *
 * Two things this file is careful about:
 *
 * - **It carries no prices, no stock, and no availability.** Not "from
 *   850,000 per night", not "two villas left". §17 says do not answer those
 *   from stale vector retrieval when a live system exists, and the cheapest way
 *   to honour that is to keep them out of the corpus in the first place. A
 *   document that states a rate is a document that will be quoted as one, and
 *   the demo would then show retrieval answering a price — exactly the failure
 *   the split exists to prevent. So the prose here says "potongan satu malam"
 *   rather than naming a currency amount, and rates stay in `rates.ts` where a
 *   port answers them.
 * - **The literals are the only source.** They are authored as config input
 *   (`KnowledgeSource`), spliced into the tenant config, and projected to
 *   `KnowledgeDocument` by `toKnowledgeDocuments` — so a knowledge source exists
 *   exactly once in the codebase and the store never holds a second copy of the
 *   wording that could drift from the config.
 *
 * Every document is published in both of the tenant's languages. The visitor
 * who arrives on this page is not necessarily the person who reads
 * `primaryLanguage`: the demo is opened in English at least as often as it is in
 * Indonesian, and retrieval here is lexical, so a one-language corpus does not
 * score low — it scores *nothing*. A visitor asking what the cancellation policy
 * is in English would then be told the property published nothing, which is
 * false, and the turn would report a knowledge gap about a question the tenant
 * answers on its own website. The siblings carry the same wording in their own
 * language; they are separate documents rather than two languages side by side
 * in one, because the store stamps provenance per document and a citation should
 * name the language that was actually retrieved.
 *
 * This is the one place the corpus is deliberately non-minimal, and it is the
 * minimum that keeps the demo honest rather than a bilingual feature: seven
 * subjects, two languages, no third.
 */

import type { ClientConfig, KnowledgeSource } from '@archava/config'
import { KnowledgeStore, type KnowledgeDocument } from '@archava/knowledge'

/**
 * The documents the tenant publishes, as config input.
 *
 * Validated by the same `knowledgeSourceSchema` the client config uses — a
 * typo'd id or an unknown kind fails at import time, not at retrieval time.
 */
export const referenceKnowledgeInputs = [
  {
    id: 'check-in-dan-check-out',
    kind: 'faq',
    title: 'Check-in dan check-out',
    content:
      'Check-in dibuka mulai pukul 14.00 dan check-out paling lambat pukul 12.00 siang. ' +
      'Kedatangan lebih awal dapat menunggu di lobby sambil menikmati teh selamat datang. ' +
      'Kunci kamar diserahkan di meja resepsi setelah formulir tamu diisi.',
    updatedAt: '2026-09-18',
  },
  {
    id: 'sarapan-pagi',
    kind: 'faq',
    title: 'Sarapan pagi',
    content:
      'Sarapan pagi disajikan dari pukul 06.30 sampai 10.00 di Restoran Pagi. ' +
      'Menunya buffet dengan nasi tradisional, sayur, buah lokal, roti, kopi, dan teh. ' +
      'Sarapan tidak otomatis menyertai setiap tipe kamar; staf akan mengonfirmasi saat kedatangan.',
    updatedAt: '2026-09-18',
  },
  {
    id: 'kebijakan-pembatalan',
    kind: 'policy',
    title: 'Kebijakan pembatalan',
    content:
      'Pembatalan gratis dilakukan paling lambat 7 hari sebelum tanggal kedatangan. ' +
      'Pembatalan di dalam rentang 7 hari tersebut dikenakan potongan satu malam dari total menginap. ' +
      'Perubahan tanggal kedatangan mengikuti aturan yang sama seperti pembatalan.',
    updatedAt: '2026-09-18',
  },
  {
    id: 'fasilitas-resort',
    kind: 'service',
    title: 'Fasilitas resort',
    content:
      'Fasilitas resort meliputi kolam renang utama yang menghadap lembah, spa, pavilion yoga, ' +
      'dan jalur trek ringan melewati kebun rempah. Sepeda untuk tamu bisa dipakai sendiri di area lobby. ' +
      'Handuk kolam renang bisa diambil di gubuk di samping kolam.',
    updatedAt: '2026-09-18',
  },
  {
    id: 'akses-lokasi',
    kind: 'documentation',
    title: 'Akses ke lokasi',
    content:
      'Lokasi resort berjarak sekitar 40 menit dari bandara utama dan 15 menit dari pusat kota. ' +
      'Layanan antar-jemput bandara dapat diatur melalui tim reservasi sebelum kedatangan. ' +
      'Petunjuk arah lengkap dikirim bersama email konfirmasi.',
    updatedAt: '2026-09-18',
  },
  {
    id: 'kebijakan-anak-dan-tempat-tidur-ekstra',
    kind: 'policy',
    title: 'Kebijakan anak dan tempat tidur ekstra',
    content:
      'Anak di bawah 5 tahun menginap bersama orang tua tanpa menempati tempat tidur tambahan. ' +
      'Tempat tidur ekstra untuk anak di atas 5 tahun dapat diatur di meja resepsi saat kedatangan. ' +
      'Setiap kamar mencatat jumlah tamu yang dapat ditampung pada halaman deskripsi kamar.',
    updatedAt: '2026-09-18',
  },
  {
    id: 'kontak-reservasi',
    kind: 'service',
    title: 'Kontak reservasi',
    content:
      'Tim reservasi dapat dihubungi setiap hari dari pukul 08.00 sampai 20.00 waktu setempat ' +
      'melalui telepon 0274-555-0100 atau email reservasi@rumahaman.test. ' +
      'Permintaan khusus seperti lantai tertentu atau kedatangan larut malam dapat dicatat di reservasi.',
    updatedAt: '2026-09-18',
  },
  {
    id: 'check-in-and-check-out',
    kind: 'faq',
    title: 'Check-in and check-out',
    content:
      'Check-in opens at 2pm and check-out is until 12 noon. ' +
      'Guests arriving early can wait in the lobby with a welcome tea. ' +
      'Room keys are handed over at the front desk once the guest form is completed.',
    updatedAt: '2026-09-18',
  },
  {
    id: 'breakfast',
    kind: 'faq',
    title: 'Breakfast',
    content:
      'Breakfast is served from 6.30am to 10am at the Morning Restaurant. ' +
      'The menu is a buffet with traditional rice, vegetables, local fruit, bread, coffee, and tea. ' +
      'Breakfast is not automatically included with every room type; staff will confirm on arrival.',
    updatedAt: '2026-09-18',
  },
  {
    id: 'cancellation-policy',
    kind: 'policy',
    title: 'Cancellation policy',
    content:
      'Cancellation is free up to 7 days before the arrival date. ' +
      'Cancelling inside those 7 days incurs a deduction of one night from the stay. ' +
      'Changing the arrival date follows the same rules as a cancellation.',
    updatedAt: '2026-09-18',
  },
  {
    id: 'resort-facilities',
    kind: 'service',
    title: 'Resort facilities',
    content:
      'Resort facilities include the main swimming pool facing the valley, the spa, the yoga pavilion, ' +
      'and a light trekking path through the spice garden. Guests can use the bicycles by themselves ' +
      'around the lobby area. Pool towels can be collected from the hut beside the pool.',
    updatedAt: '2026-09-18',
  },
  {
    id: 'location-access',
    kind: 'documentation',
    title: 'Location and access',
    content:
      'The resort is about 40 minutes from the main airport and 15 minutes from the city centre. ' +
      'Airport pickup can be arranged through the reservations team before arrival. ' +
      'Full directions are sent together with the confirmation email.',
    updatedAt: '2026-09-18',
  },
  {
    id: 'children-and-extra-beds-policy',
    kind: 'policy',
    title: 'Children and extra beds policy',
    content:
      'Children under 5 stay with their parents without occupying an extra bed. ' +
      'An extra bed for a child over 5 can be arranged at the front desk on arrival. ' +
      'Each room records the number of guests it can hold on the room description page.',
    updatedAt: '2026-09-18',
  },
  {
    id: 'reservation-contact',
    kind: 'service',
    title: 'Reservation contact',
    content:
      'The reservations team can be reached every day from 8am to 8pm local time ' +
      'by phone on +62 274 555 010 or by email at reservations@rumahaman.test. ' +
      'Special requests such as a particular floor or a late-night arrival can be noted on the reservation.',
    updatedAt: '2026-09-18',
  },
] as const satisfies readonly KnowledgeSource[]

/**
 * Project config knowledge sources into store documents.
 *
 * The tenant id comes from the config rather than from the caller, because a
 * document ingested under the wrong tenant is a §23 isolation bug, not a
 * misfiled row. Everything else is copied verbatim — the store chunks and
 * stamps provenance itself.
 */
export function toKnowledgeDocuments(
  sources: readonly KnowledgeSource[],
  tenantId: string,
): readonly KnowledgeDocument[] {
  return sources.map((source) => ({
    id: source.id,
    tenantId,
    kind: source.kind,
    title: source.title,
    content: source.content,
    updatedAt: source.updatedAt,
  }))
}

/**
 * A knowledge store holding exactly this tenant's documents.
 *
 * Built from the parsed config rather than from the literals, so a config that
 * failed to parse never reaches retrieval, and a source added to the config is
 * ingested without a second edit here.
 */
export function buildKnowledgeStore(config: ClientConfig): KnowledgeStore {
  const store = new KnowledgeStore()
  for (const document of toKnowledgeDocuments(config.knowledgeSources, config.tenantId)) {
    store.ingest(document)
  }
  return store
}
