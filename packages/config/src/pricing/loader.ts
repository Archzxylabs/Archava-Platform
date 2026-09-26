import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pricebookSchema, type Pricebook } from './schema.js'

export class PricebookError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = 'PricebookError'
  }
}

const PRICEBOOK_RELATIVE_PATH = 'config/pricing.v1.json'

/** Whether this exact path is a file that can be opened for reading. */
function isReadableFile(candidate: string): boolean {
  try {
    readFileSync(candidate, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * Load and validate the authoritative pricebook from disk.
 *
 * The pricebook is the only source of money in this platform. If it is
 * missing, unreadable, or schema-invalid the caller MUST fail closed: no
 * quote may be produced from a partially understood pricebook.
 *
 * The search walks all the way up to the filesystem root rather than a fixed
 * number of levels, because the number of levels is a fact about where the
 * caller happens to sit — `apps/web/src/server` is four hops from the root that
 * holds the pricebook. A list of three candidates is not "any starting point";
 * it is three starting points, and the fourth caller gets a 500.
 */
export function loadPricebook(searchFrom: string = process.cwd()): Pricebook {
  let directory = path.resolve(searchFrom)
  const walkFrom = directory
  for (;;) {
    const candidate = path.join(directory, PRICEBOOK_RELATIVE_PATH)
    if (isReadableFile(candidate)) {
      return parsePricebook(readFileSync(candidate, 'utf8'), candidate)
    }
    const parent = path.dirname(directory)
    // `dirname` of `/` is itself, so identity is the ceiling.
    if (parent === directory) break
    directory = parent
  }

  throw new PricebookError(
    `Pricebook not found. Looked for ${PRICEBOOK_RELATIVE_PATH} starting at ${walkFrom}, ` +
      'walking up to the filesystem root. No quote may be produced without the pricebook.',
  )
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
