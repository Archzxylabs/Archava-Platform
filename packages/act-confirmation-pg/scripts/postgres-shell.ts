/**
 * The `psql` command line, in one place.
 *
 * This package depends on no database driver — `@archava/act-storage` names the
 * reason: the deployment brings its own, and the choice of driver is a
 * deployment decision this package has no business making. So nothing here adds
 * one. The disposable cluster is reached through the `psql` binary instead,
 * which is the same binary the migration itself is applied with, and which an
 * operator running PostgreSQL already has. It is a child process, not a
 * dependency, and it exists only in `scripts/`, never in `src/`.
 *
 * One module, because the verifier's literal substitution is security-relevant
 * and a second copy of it would be a second place to get it wrong: the checks in
 * `verify-against-postgres.ts`, and the separate processes
 * `cross-process.ts` spawns, all reach the server through this file. Production
 * runs the same statement text through an injected parameterized `SqlClient`;
 * this verifier's `psql` literal rendering is its own transport seam.
 *
 * ## Why values become literals here
 *
 * `psql` has no binding of its own, so a parameter is substituted as a literal.
 * That is safe here and only here: every value this package hands over is a
 * constant written in this package (a fixture, or an identity the parent passed
 * its child), never text a caller typed. A `$n` always names its own parameter,
 * so the order the placeholders appear in the statement text is irrelevant —
 * which is exactly what the store relies on when it binds one instant twice.
 */

import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

const runFile = promisify(execFile)

/** Where the cluster is, and as whom to connect. */
export interface ShellTarget {
  readonly socket: string
  readonly port: number
  readonly user: string
  readonly database: string
}

/**
 * The argument list for one `psql` invocation.
 *
 * `output` is the rendering the caller wants back. The checks read unaligned
 * text because they compare it as a string; the separate processes read `--csv`
 * because they need the column names and NULLs back, not a rendering.
 */
export function psqlArguments(
  target: ShellTarget,
  text: string,
  output: readonly string[] = ['--tuples-only', '--no-align'],
): string[] {
  return [
    '--no-psqlrc',
    '--set=ON_ERROR_STOP=on',
    '--quiet',
    ...output,
    '--host',
    target.socket,
    '--port',
    String(target.port),
    '--username',
    target.user,
    '--dbname',
    target.database,
    '--command',
    text,
  ]
}

/**
 * The argument list for applying a file of SQL instead of one statement.
 *
 * The migration is applied this way, by `psql --file`, and it needs the same
 * connection details as everything else here — so they are built by the same
 * function, and a cluster that moves port does not leave the migration behind.
 */
export function psqlFileArguments(target: ShellTarget, file: string): string[] {
  return psqlArguments(target, '', ['--quiet', '--file', file])
}

/** One statement, and its parameters, as the server would see them. */
export async function runShell(
  target: ShellTarget,
  text: string,
  output: readonly string[] = ['--tuples-only', '--no-align'],
): Promise<string> {
  const { stdout } = await runFile('psql', psqlArguments(target, text, output), {
    encoding: 'utf8',
  })
  return stdout
}

/** The same, synchronously, for the checks that assert inline. */
export function runShellSync(
  target: ShellTarget,
  text: string,
  output: readonly string[] = ['--tuples-only', '--no-align'],
): string {
  return execFileSync('psql', psqlArguments(target, text, output), { encoding: 'utf8' })
}

/** Substitute `$n` with the n-th parameter. */
export function bind(text: string, params: readonly unknown[]): string {
  return text.replace(/\$(\d+)/g, (_match, position: string) => {
    const value = params[Number(position) - 1]
    if (value === undefined) throw new Error(`unbound placeholder $${position}`)
    return literal(value)
  })
}

/** A parameter, as a literal. A non-integer number is refused, not rounded. */
export function literal(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`not a millisecond instant: ${value}`)
    return String(value)
  }
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`
  throw new Error(`unsupported literal type: ${typeof value}`)
}
