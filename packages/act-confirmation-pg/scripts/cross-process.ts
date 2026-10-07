/**
 * One process, spending one challenge, and saying what happened.
 *
 * The suite in `test/` races two callers against one `Map` in one process. That
 * proves the store never invents a second transition — and nothing about two
 * *separate* processes, which is what a deployment actually runs: one HTTP host
 * behind a load balancer, several workers, a retry from a different machine. Two
 * processes share nothing but the database, so the only thing that can stop both
 * of them believing they spent the same consent is PostgreSQL itself.
 *
 * This file is that second process. `verify-against-postgres.ts` spawns several
 * of them against one running cluster and asserts exactly one reports `spent`.
 * None of them can be told the answer by another: they are separate processes,
 * they start their own `psql`, and they meet only inside the `UPDATE`.
 *
 * ## What it runs
 *
 * The real `PostgresChallengeStore`, over a `SqlClient` that shells out to
 * `psql`. That is deliberate: this package depends on no database driver, and
 * adding one to prove the store works would be a strange way to prove the
 * no-driver seam is right. `psql` is a binary an operator running PostgreSQL
 * already has — it is the binary the migration is applied with.
 *
 * ## What being spawned looks like
 *
 * Everything the child needs arrives as JSON in `argv`, because an environment
 * this package does not control cannot be relied on to carry a socket path and a
 * fixture through `spawn` intact. The values are this package's own fixtures,
 * handed over by its own parent, so they are constants and not untrusted input —
 * which is what makes substituting them as literals safe (see
 * `postgres-shell.ts`).
 *
 * ## Exit codes
 *
 * `0` — a verdict came back. `spent`, `already_consumed`, `expired`, `mismatch`,
 * `not_found` and `unavailable` are all answers, and a race is supposed to
 * produce five of them and one `spent`.
 *
 * `1` — no verdict. Bad arguments, a store that threw, a verdict nobody wrote
 * down. A crash must be louder than a refusal, or the parent would read "the
 * consumer that failed to start" as "the consumer that lost the race", which is
 * the one distinction this whole exercise exists to keep.
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ConfirmationChallengeConsumption } from '@archava/act-confirmation'
import type { SqlClient, SqlRow } from '@archava/act-storage'

import { PostgresChallengeStore } from '../src/postgres-challenge-store.js'
import type { ShellTarget } from './postgres-shell.js'
import { bind, runShell } from './postgres-shell.js'

/** The verdicts the store can return. `unavailable` carries a reason, unprinted here. */
export type ConsumptionVerdict =
  | 'spent'
  | 'already_consumed'
  | 'expired'
  | 'mismatch'
  | 'not_found'
  | 'unavailable'

export const VERDICTS: readonly ConsumptionVerdict[] = [
  'spent',
  'already_consumed',
  'expired',
  'mismatch',
  'not_found',
  'unavailable',
]

/**
 * A `SqlClient` that runs one statement per `psql` call.
 *
 * There is no connection to hold: `psql` opens and closes its own, which is
 * exactly what a separate process looks like, and it is the weakest thing being
 * tested — if the store's atomicity depended on holding a connection open, this
 * client would be where it broke.
 *
 * Rows come back from `--csv` with the header, so the column names are read from
 * the server rather than assumed, and NULL is read as `null` rather than as the
 * empty string. The second one is not cosmetic: a pending challenge carries no
 * `consumed_at`, and a client that answered `''` for it would hand the store a
 * row it is required to refuse, turning a spend into `unavailable`.
 */
export class PsqlSqlClient implements SqlClient {
  readonly storeId = 'psql-sql-client'
  readonly capabilities = { transactions: false } as const

  constructor(private readonly target: ShellTarget) {}

  run(statement: { readonly sql: string; readonly params: readonly unknown[] }) {
    return runShell(this.target, bind(statement.sql, statement.params), ['--csv']).then(decodeCsv)
  }
}

/**
 * Decode `psql --csv` output into rows.
 *
 * A hand-rolled reader, because the alternative is a dependency this package
 * does not have and must not gain. The rules are the ones psql writes to, and
 * only two of them matter here:
 *
 *   * a field that opens with `"` is a string, and `""` inside it is a quote;
 *   * an unquoted empty field is NULL, a quoted `""` is the empty string.
 *
 * Anything else — a quote in the middle of an unquoted field — is refused rather
 * than guessed at. psql does not produce it, so it can only mean the reader lost
 * count, and a reader that guesses produces rows made of the wrong columns.
 */
function decodeCsv(text: string): readonly SqlRow[] {
  const rows: SqlRow[] = []
  let columns: readonly string[] | null = null
  let fields: unknown[] = []
  let value = ''
  let quoted = false
  let opened = false
  let begun = false
  let characters = 0

  const endField = (): void => {
    fields.push(begun ? value : null)
    value = ''
    opened = false
    begun = false
  }

  const endRecord = (): void => {
    // A trailing newline, not a blank record. Without this the last line would
    // arrive as a row of nulls with no columns to hang them on.
    if (characters === 0) return
    endField()
    if (columns === null) {
      columns = fields.map((name) => {
        if (typeof name !== 'string' || name.length === 0) {
          throw new Error('psql_csv_header_unreadable')
        }
        return name
      })
    } else {
      rows.push(Object.fromEntries(columns.map((name, at) => [name, fields[at]])))
    }
    fields = []
  }

  for (let at = 0; at < text.length; at += 1) {
    const character = text[at]
    characters += 1

    if (quoted) {
      if (character === '"') {
        if (text[at + 1] === '"') {
          value += '"'
          at += 1
          characters += 1
        } else {
          quoted = false
        }
      } else {
        value += character
      }
      continue
    }

    if (character === '"' && !begun) {
      quoted = true
      opened = true
      begun = true
      continue
    }
    if (character === ',') {
      endField()
      continue
    }
    if (character === '\n') {
      endRecord()
      characters = 0
      continue
    }
    // psql terminates CSV records with CRLF; a CR anywhere else would be part of
    // a quoted value, which the quoted branch above has already consumed.
    if (character === '\r' && text[at + 1] === '\n') continue
    if (character === '"') throw new Error('psql_csv_quote_outside_a_quoted_field')

    begun = true
    if (opened) throw new Error('psql_csv_text_after_a_quoted_field')
    value += character
  }
  // The final record has no newline after it when the server's output is short,
  // and psql is free to omit it.
  endRecord()

  return rows
}

/** Spend one challenge, and report the verdict as one word. */
export async function consumeOnce(
  target: ShellTarget,
  presentation: ConfirmationChallengeConsumption,
): Promise<ConsumptionVerdict> {
  const verdict = await new PostgresChallengeStore(new PsqlSqlClient(target)).consume(presentation)
  const status = VERDICTS.find((candidate) => candidate === verdict.status)
  if (status === undefined) {
    throw new Error(`an_unrecorded_verdict:${String(verdict.status)}`)
  }
  return status
}

/**
 * Was this file run, or imported?
 *
 * Imports are not hypothetical: the verifier reads `VERDICTS` from this file to
 * decode what its children answer, and when it does, `argv[1]` names the
 * *verifier's* script. So the question is not "is there an entry point" but "does
 * the entry point name this file", and a path that cannot be parsed as an entry
 * point answers no rather than throwing — a child that cannot start must exit
 * through `main`'s refusal, not through a crash in a guard.
 */
function isDirectRun(url: string, entry: string | undefined): boolean {
  if (entry === undefined) return false
  const here = fileURLToPath(url)
  const from = entry.endsWith('.ts') || entry.endsWith('.tsx') ? entry : `${entry}.ts`
  return here === resolve(from)
}

function readArgument(position: number, name: string): string {
  const value = process.argv[position]
  if (value === undefined || value.length === 0) {
    throw new Error(`missing_argument:${name}`)
  }
  return value
}

/**
 * The child's whole life, when it is the one being run.
 *
 * The verdict is written to stdout and nothing else, because the parent reads
 * one line back and a second line would be read as a second verdict.
 */
async function main(): Promise<void> {
  const target = JSON.parse(readArgument(2, 'target')) as ShellTarget
  const presentation = JSON.parse(
    readArgument(3, 'presentation'),
  ) as ConfirmationChallengeConsumption
  const verdict = await consumeOnce(target, presentation)
  process.stdout.write(`${verdict}\n`)
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    },
  )
}
