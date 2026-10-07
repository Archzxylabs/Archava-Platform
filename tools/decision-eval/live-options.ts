import { REFERENCE_CORPUS } from './corpus.js'
import { EVIDENCE_SET_SIZE } from './evidence-set.js'

export interface LiveOptions {
  readonly apiKey: string
  readonly maxCases: number
  readonly paceMs: number
}

/** Live calls require both a server key and an explicit --live invocation. */
export function parseLiveOptions(args: readonly string[], apiKey: string | undefined): LiveOptions {
  if (!args.includes('--live'))
    throw new Error('Pass --live to authorize this optional external evaluation.')
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new Error('Set TYPESAFE_API_KEY in the server environment.')
  }
  let maxCases = 5
  let paceMs = 500
  const remaining = args.filter((arg) => arg !== '--live' && arg !== '--')
  for (let index = 0; index < remaining.length; index += 2) {
    const name = remaining[index]
    const value = remaining[index + 1]
    if (value === undefined || !/^\d+$/.test(value))
      throw new Error('Invalid live evaluation option.')
    const number = Number(value)
    if (name === '--max-cases') maxCases = number
    else if (name === '--pace-ms') paceMs = number
    else throw new Error('Unknown live evaluation option.')
  }
  // The same limit is passed to both harnesses. Reject an oversized run before
  // the first reference-corpus call incurs a charge.
  const maximum = Math.min(REFERENCE_CORPUS.length, EVIDENCE_SET_SIZE)
  if (!Number.isInteger(maxCases) || maxCases < 1 || maxCases > maximum) {
    throw new Error(`--max-cases must be 1..${maximum} for both evaluation sets`)
  }
  if (!Number.isInteger(paceMs) || paceMs < 250 || paceMs > 60_000) {
    throw new Error('--pace-ms must be 250..60000')
  }
  return { apiKey, maxCases, paceMs }
}
