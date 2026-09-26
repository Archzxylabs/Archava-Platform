/**
 * Deterministic text helpers.
 *
 * Chunking and tokenising are deliberately not "clever": the same document
 * must always produce the same chunks in the same order, or re-ingestion
 * silently rewrites ids and breaks provenance links held elsewhere.
 */

/** Words too common to discriminate anything. */
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'how',
  'i',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'was',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with',
  'you',
  'your',
])

export const DEFAULT_CHUNK_TARGET_CHARS = 600
export const DEFAULT_CHUNK_OVERLAP_CHARS = 80

/** Case-folded alphanumeric tokens, stopwords and 1-char noise removed. */
export function tokenise(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
}

/**
 * Split prose into chunks on sentence boundaries, carrying a bounded tail of
 * the previous chunk forward so a sentence spanning a boundary is still
 * retrievable from either side.
 */
export function chunkText(
  text: string,
  targetChars: number = DEFAULT_CHUNK_TARGET_CHARS,
  overlapChars: number = DEFAULT_CHUNK_OVERLAP_CHARS,
): readonly string[] {
  const normalised = text.replace(/\s+/g, ' ').trim()
  if (normalised.length === 0) return []
  if (normalised.length <= targetChars) return [normalised]

  const sentences = splitSentences(normalised)
  const chunks: string[] = []
  let current = ''

  for (const sentence of sentences) {
    if (current.length > 0 && current.length + sentence.length + 1 > targetChars) {
      chunks.push(current)
      current = tailOf(current, overlapChars)
    }
    current = current.length === 0 ? sentence : `${current} ${sentence}`
  }
  if (current.length > 0) chunks.push(current)

  return chunks
}

/** Split on sentence-final punctuation, keeping the punctuation. */
function splitSentences(text: string): readonly string[] {
  const parts = text.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g)
  return (parts ?? [text]).map((part) => part.trim()).filter((part) => part.length > 0)
}

/** The last whole words that fit within `limit` characters. */
function tailOf(text: string, limit: number): string {
  if (limit <= 0) return ''
  const words = text.split(' ')
  let tail = ''
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const candidate = words[index] ?? ''
    if (tail.length + candidate.length + 1 > limit) break
    tail = tail.length === 0 ? candidate : `${candidate} ${tail}`
  }
  return tail
}
