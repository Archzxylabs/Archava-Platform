import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pricebookSchema, type Pricebook } from './schema.js'

export class PricebookError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message)
    this.name = 'PricebookError'
  }
}

const PRICEBOOK_RELATIVE_PATH = 'config/pricing.v1.json'

/**
 * Load and validate the authoritative pricebook from disk.
 *
 * The pricebook is the only source of money in this platform. If it is
 * missing, unreadable, or schema-invalid the caller MUST fail closed: no
 * quote may be produced from a partially understood pricebook.
 */
export function loadPricebook(searchFrom: string = process.cwd()): Pricebook {
  const candidates = [
    path.resolve(searchFrom, PRICEBOOK_RELATIVE_PATH),
    path.resolve(searchFrom, '../../', PRICEBOOK_RELATIVE_PATH),
    path.resolve(searchFrom, '../../../', PRICEBOOK_RELATIVE_PATH),
  ]

  const found = candidates.find((candidate) => {
    try {
      readFileSync(candidate, 'utf8')
      return true
    } catch {
      return false
    }
  })

  if (!found) {
    throw new PricebookError(
      `Pricebook not found. Looked for ${PRICEBOOK_RELATIVE_PATH} starting at ${searchFrom}. ` +
        'No quote may be produced without the pricebook.',
    )
  }

  return parsePricebook(readFileSync(found, 'utf8'), found)
}

export function parsePricebook(raw: string, source = '<inline>'): Pricebook {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    throw new PricebookError(`Pricebook at ${source} is not valid JSON.`, error)
  }

  const parsed = pricebookSchema.safeParse(json)
  if (!parsed.success) {
    throw new PricebookError(
      `Pricebook at ${source} failed validation: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    )
  }
  return parsed.data
}
