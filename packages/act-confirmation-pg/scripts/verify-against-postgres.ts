/**
 * Does PostgreSQL agree with what the statements assume?
 *
 * The recording fake is one process and one `Map`. It replays the predicate
 * semantics the statements rely on, which is enough to prove the store never
 * invents a second transition — and no more. It cannot prove:
 *
 *   * that PostgreSQL accepts the SQL at all;
 *   * that `ON CONFLICT (id) DO NOTHING` returns zero rows for a lost race
 *     rather than raising;
 *   * that a conditional `UPDATE ... RETURNING` returns one row when it
 *     transitioned one row, and zero when its predicate matched nothing;
 *   * that the primary key is enforced between two real connections;
 *   * that `bigint` round-trips as a whole number of milliseconds, and what
 *     shape it comes back in;
 *   * that a write survives the server being restarted.
 *
 * This script asks the server all of those and nothing else. It is not a test
 * and nothing in CI runs it, because it needs a PostgreSQL cluster and this repo
 * does not ship one. Run it by hand before trusting the statements:
 *
 *     pnpm --filter @archava/act-confirmation-pg verify:sql
 *
 * Every check below asserts a claim the statements depend on. A failing check
 * means the statements are wrong about PostgreSQL and the statements change,
 * not the check. The store, the port and the service are deliberately not
 * tested here at all — that suite runs with no database.
 *
 * ## What it adds to the in-process suite
 *
 * The suite's `Promise.all` races two callers against one `Map` in one process,
 * which proves the adapter never invents a second transition and nothing about
 * two processes. This script spawns real `tsx` children that share nothing but
 * the cluster, and asserts exactly one reports `spent`. Those children are also
 * the reason the statements reach PostgreSQL through `psql` rather than a
 * driver: the same statement text reaches PostgreSQL, while a deployment's
 * driver must provide its own parameter binding.
 *
 * ## What it cannot prove either
 *
 * The `psql` client declares itself transactionless and reads every column as
 * text, so a deployment's driver is still its own seam: whether it wraps the
 * transition in a transaction, and whether it hands `bigint` back as a string
 * (`pg` does, unless a type parser is installed) or a number. The store copes
 * with both, and the suite exercises both, but this script can only exercise
 * the text one.
 *
 * It creates a disposable cluster in a temporary directory, applies the real
 * migration, runs the checks, and removes the directory on the way out. It uses
 * its own socket and port, never the default ones, and needs no root and no
 * network.
 */

import { execFile, execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import type { SqlStatement } from '@archava/act-storage'

import type { ConsumptionVerdict } from './cross-process.js'
import { VERDICTS } from './cross-process.js'
import type { ShellTarget } from './postgres-shell.js'
import { bind, psqlFileArguments, runShell, runShellSync } from './postgres-shell.js'

import {
  CHALLENGE_COLUMNS,
  consumeChallengeStatement,
  issueChallengeStatement,
  lookupChallengeStatement,
} from '../src/statements.js'

const runFile = promisify(execFile)

/** This file's directory, which is where the child process and `node_modules` are found from. */
const HERE = dirname(fileURLToPath(import.meta.url))

const MIGRATION = join(HERE, '..', 'migrations', '001_confirmation_challenges.sql')

/** The disposable cluster: created by `startCluster`, removed by `stop`. */
const WORKDIR = mkdtempSync(join(tmpdir(), 'act-confirmation-verify-'))
const SOCKET = join(WORKDIR, 'socket')
const SERVER_LOG = join(WORKDIR, 'server.log')
const PORT = 55432
const USER = process.env.USER ?? process.env.LOGNAME ?? 'postgres'
const DATABASE = 'verification'
/** The one database `initdb` creates. `DATABASE` does not exist until it is made. */
const BOOTSTRAP = 'postgres'

/** Where the cluster is, as every statement below reaches it. */
const TARGET: ShellTarget = { socket: SOCKET, port: PORT, user: USER, database: DATABASE }

const INSERT = {
  id: 'challenge-1',
  tenantId: 'tenant-1',
  sessionId: 'session-1',
  actionId: 'action-1',
  tokenDigest: 'a'.repeat(64),
  bindingDigest: 'b'.repeat(64),
  issuedAt: 1_770_000_000_000,
  expiresAt: 1_770_000_300_000,
}

const NOW = 1_770_000_123_000

/** The id the constraints and durability section owns, because it truncates. */
const CONSTRAINT_ID = 'challenge-constraints'

const COLUMNS = CHALLENGE_COLUMNS.join(', ')

let passed = 0
let failed = 0

function check(name: string, assertion: () => void): void {
  try {
    assertion()
    passed += 1
    process.stdout.write(`  ok    ${name}\n`)
  } catch (error) {
    failed += 1
    process.stdout.write(`  FAIL  ${name}\n`)
    process.stdout.write(`        ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

/** Run one statement through `psql`, as the server would. */
async function run(statement: SqlStatement): Promise<string> {
  return sql(statement.sql, statement.params)
}

/**
 * One statement and its parameters, through `psql`.
 *
 * `database` defaults to the one the checks run against; the nothing-exists-yet
 * step that waits for the server has to connect to one that does not.
 *
 * The binding and the argument list are `postgres-shell.ts`'s, on purpose:
 * verifier and child processes must exercise one literal renderer. The runtime
 * store instead passes parameters to an injected client.
 */
async function sql(
  text: string,
  params: readonly unknown[] = [],
  target: ShellTarget = TARGET,
): Promise<string> {
  return (await runShell(target, bind(text, params))).trim()
}

function sqlSync(command: string): string {
  return runShellSync(TARGET, command).trim()
}

function applyMigration(): void {
  execFileSync('psql', psqlFileArguments(TARGET, MIGRATION), {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
}

/** Start the server, detached, with its own log inside the directory `stop` removes. */
function startServer(): void {
  const log = openSync(SERVER_LOG, 'w')
  spawn(
    'postgres',
    ['-D', WORKDIR, '-k', SOCKET, '-p', String(PORT), '-F', '-c', 'listen_addresses='],
    {
      stdio: ['ignore', log, log],
      detached: true,
    },
  ).unref()
}

async function startCluster(): Promise<void> {
  execFileSync('initdb', ['--no-sync', '--auth', 'trust', '--username', USER, WORKDIR], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  mkdirSync(SOCKET, { recursive: true })
  startServer()
  await waitForServer('the disposable cluster never started')
  // Created from the bootstrap database, since the one being created is not
  // connectable until it exists.
  await sql('CREATE DATABASE verification', [], { ...TARGET, database: BOOTSTRAP })
  applyMigration()
}

/** The tail of the server's own log, so a timeout reports what it did wrong. */
function serverLog(): string {
  try {
    const log = readFileSync(SERVER_LOG, 'utf8').trim()
    return log.length === 0 ? 'the server wrote nothing to its log' : log.slice(-2_000)
  } catch {
    return 'the server wrote no log'
  }
}

async function waitForServer(message: string): Promise<void> {
  const deadline = Date.now() + 60_000
  for (;;) {
    try {
      await sql('SELECT 1', [], { ...TARGET, database: BOOTSTRAP })
      return
    } catch {
      if (Date.now() > deadline) throw new Error(`${message}\n        ${serverLog()}`)
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}

function stopServer(): void {
  try {
    execFileSync('pg_ctl', ['-D', WORKDIR, '-m', 'fast', 'stop'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    })
  } catch {
    // Already stopped. What matters is removing the directory afterwards.
  }
}

function stop(): void {
  stopServer()
  rmSync(WORKDIR, { recursive: true, force: true })
}

/**
 * Where `tsx` is.
 *
 * `pnpm` hoists it to the workspace root's `node_modules/.bin`, which is not on
 * `PATH` when this script spawns something, so the child cannot be started with
 * a bare command name. It is found by walking up from this file until the binary
 * appears, which is the same place `tsx` was invoked from.
 */
const TSX = ((): string => {
  for (let at = HERE; ; at = dirname(at)) {
    const candidate = join(at, 'node_modules', '.bin', 'tsx')
    if (existsSync(candidate)) return candidate
    if (dirname(at) === at) throw new Error('tsx_not_found_on_disk')
  }
})()

/** The child that spends one challenge in a process of its own. */
const CONSUMER = join(HERE, 'cross-process.ts')

/** What one separate process answered. `crashed` means it never got an answer. */
interface RaceResult {
  readonly verdict: ConsumptionVerdict | 'crashed'
  readonly detail: string
}

/**
 * Spend one challenge from several separate processes at once.
 *
 * Nothing is serialised here on purpose: the children are started together and
 * each runs its own `psql`, so the only thing standing between them and two
 * victories is PostgreSQL. That is the difference from the suite in `test/`,
 * which interleaves two callers in one process against one `Map` and can
 * therefore only prove the adapter never invents a second transition.
 */
async function raceConsumers(count: number, id: string): Promise<readonly RaceResult[]> {
  await sql('TRUNCATE confirmation_challenges')
  await run(issueChallengeStatement({ ...INSERT, id }))

  const presentation = { ...PRESENTATION, id }
  return Promise.all(
    Array.from({ length: count }, () =>
      runFile(TSX, [CONSUMER, JSON.stringify(TARGET), JSON.stringify(presentation)], {
        encoding: 'utf8',
      }).then(
        (result): RaceResult => ({
          verdict: decodeVerdict(result.stdout),
          detail: result.stdout.trim(),
        }),
        (error: unknown): RaceResult => ({
          verdict: 'crashed',
          detail: error instanceof Error ? `${error.message} ${String(error)}` : String(error),
        }),
      ),
    ),
  )
}

/** Every racer's answer on one line, so a failure says what the others got. */
function describe(racers: readonly RaceResult[]): string {
  return JSON.stringify(racers.map((racer) => `${racer.verdict}:${racer.detail}`))
}

/**
 * The one word the child wrote.
 *
 * A verdict nobody wrote down is a crash, not a refusal: the parent has to keep
 * telling those two apart, because a consumer that failed to start is not a
 * consumer that lost the race, and the whole point of this section is to know
 * which of the two happened.
 */
function decodeVerdict(stdout: string): ConsumptionVerdict {
  const line = stdout.trim()
  const verdict = VERDICTS.find((candidate) => candidate === line)
  if (verdict === undefined) throw new Error(`an_unrecorded_verdict:${line}`)
  return verdict
}

/**
 * Two separate processes, one challenge.
 *
 * The count is deliberately two, which is the claim the brief makes: "an optional
 * disposable-cluster verifier that demonstrates two separate processes cannot
 * both consume the same challenge". The wider race below it is the same claim
 * under more contention, not a different one.
 */
async function verifyTwoProcesses(): Promise<void> {
  const racers = await raceConsumers(2, 'challenge-two-processes')
  check('two separate processes produce exactly one spend', () => {
    const spent = racers.filter((racer) => racer.verdict === 'spent')
    assert(spent.length === 1, `expected exactly one spent, got ${describe(racers)}`)
    for (const racer of racers) {
      if (racer.verdict === 'spent') continue
      assert(
        racer.verdict === 'already_consumed',
        `a loser was told ${racer.verdict}, not already_consumed`,
      )
    }
  })

  check('a lost race leaves the first stamp alone', () => {
    assert(
      sqlSync(
        `SELECT state || ':' || consumed_at FROM confirmation_challenges WHERE id = ` +
          `'challenge-two-processes'`,
      ) === `consumed:${NOW}`,
      'the losing process re-stamped the row',
    )
  })
}

/**
 * The same claim under more contention.
 *
 * Two processes prove the predicate serialises. Five make it unlikely that the
 * winner was decided by something the two-process check cannot see — a
 * connection that happened to finish before the other started, for instance.
 */
async function verifyWiderRace(): Promise<void> {
  const racers = await raceConsumers(5, 'challenge-wider-race')
  check('five separate processes produce exactly one spend', () => {
    const spent = racers.filter((racer) => racer.verdict === 'spent')
    assert(spent.length === 1, `expected exactly one spent, got ${describe(racers)}`)
    for (const racer of racers) {
      if (racer.verdict === 'spent') continue
      assert(
        racer.verdict === 'already_consumed',
        `a loser was told ${racer.verdict}, not already_consumed`,
      )
    }
  })
}

/**
 * The child processes are the seam, so they get a check of their own.
 *
 * Without one, a child that exits 1 for any reason — a missing `tsx`, a typo in
 * the target, a store that threw — would be reported as a loser, and the race
 * check above would read "five refusals and a spend" and pass. This asserts the
 * child's contract directly: the verdicts it can write down, and that it exits
 * loudly rather than writing nothing.
 */
async function verifyChildContract(): Promise<void> {
  // An id nobody issued, so the child has to classify rather than spend. This
  // also proves the child reached the cluster at all.
  const missing = await runFile(
    TSX,
    [
      CONSUMER,
      JSON.stringify(TARGET),
      JSON.stringify({ ...PRESENTATION, id: 'challenge-absent-to-the-child' }),
    ],
    { encoding: 'utf8' },
  )
  check('a separate process answers not_found for an id it never saw', () => {
    assert(
      decodeVerdict(missing.stdout) === 'not_found',
      `expected not_found, got ${JSON.stringify(missing.stdout)}`,
    )
  })

  // Spawned with no arguments, so it never gets as far as a cluster and cannot be
  // confusing "I could not start" with "I lost the race".
  const refused = failureOf(
    await runFile(TSX, [CONSUMER], { encoding: 'utf8' }).then(
      () => undefined,
      (error: unknown) => error,
    ),
  )
  check('a separate process with nothing to report exits loudly, not silently', () => {
    assert(refused.code === 1, `expected exit 1, got ${JSON.stringify(refused)}`)
    assert(
      refused.stderr.includes('missing_argument'),
      `expected the missing-argument refusal, got ${JSON.stringify(refused.stderr)}`,
    )
  })

  // Something that is not the JSON it was promised. The refusal need not be
  // worded any particular way — only that it exits non-zero and says so, which
  // is what keeps a child a lost racer rather than a crashed one.
  const unreadable = failureOf(
    await runFile(TSX, [CONSUMER, 'not-json'], { encoding: 'utf8' }).then(
      () => undefined,
      (error: unknown) => error,
    ),
  )
  check('a separate process handed something it cannot read refuses rather than guessing', () => {
    assert(unreadable.code === 1, `expected exit 1, got ${JSON.stringify(unreadable)}`)
    assert(unreadable.stderr.length > 0, 'the child said nothing on its way out')
  })
}

/** What a child that never produced a verdict left behind. */
interface ChildFailure {
  readonly code: number | undefined
  readonly stderr: string
}

function failureOf(error: unknown): ChildFailure {
  const failure = error as { code?: unknown; stderr?: unknown }
  return {
    code: typeof failure.code === 'number' ? failure.code : undefined,
    stderr: typeof failure.stderr === 'string' ? failure.stderr : '',
  }
}

async function main(): Promise<void> {
  try {
    await startCluster()
    await verify()
  } finally {
    stop()
  }
  process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
  process.exitCode = failed === 0 ? 0 : 1
}

async function verify(): Promise<void> {
  process.stdout.write('\nissue\n')
  await verifyIssue()

  process.stdout.write('\nconsume\n')
  await verifyConsume()

  process.stdout.write('\nthe row, as it comes back\n')
  await verifyRowShape()

  process.stdout.write('\ntwo separate processes\n')
  await verifyTwoProcesses()

  process.stdout.write('\na wider race\n')
  await verifyWiderRace()

  process.stdout.write('\nthe child processes\n')
  await verifyChildContract()

  process.stdout.write('\nconstraints and durability\n')
  await verifyConstraints()
}

/**
 * One statement's answer, or the server's refusal to answer it.
 *
 * `issue` is the statement whose designed-for failure mode is the server saying
 * no: `ON CONFLICT (id) DO NOTHING` makes a lost race zero rows rather than an
 * error, and that difference is all this package can promise about a colliding
 * id. So the checks below must be able to *see* a raise, which a bare `await`
 * cannot give them — it would end the script at the first clause the server
 * refused, and every check after it would go unrun.
 */
async function attempt(
  statement: SqlStatement,
): Promise<{ readonly answer: string } | { readonly raised: string }> {
  try {
    return { answer: await run(statement) }
  } catch (error) {
    return { raised: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The answer, or a throw that names the refusal the server gave instead.
 *
 * Narrowing needs somewhere to live: `assert` takes `unknown`, so two asserts in a
 * row would leave `collision.answer` unproven for the type checker even after the
 * one that established it.
 */
function answered(result: { readonly answer: string } | { readonly raised: string }): string {
  if ('raised' in result) {
    throw new Error(`the server refused the statement: ${result.raised}`)
  }
  return result.answer
}

async function verifyIssue(): Promise<void> {
  await sql('TRUNCATE confirmation_challenges')

  const inserted = await run(issueChallengeStatement(INSERT))
  check('writes one pending row inside a positive window', () => {
    assert(inserted === INSERT.id, `expected the inserted id back, got ${JSON.stringify(inserted)}`)
    assert(
      sqlSync(`SELECT count(*) FROM confirmation_challenges WHERE state = 'pending'`) === '1',
      'the inserted row is not pending',
    )
  })

  const collision = await attempt(issueChallengeStatement(INSERT))
  check('reports a colliding id as zero rows rather than an error', () => {
    assert(
      answered(collision) === '',
      `expected zero rows back, got ${JSON.stringify(answered(collision))}`,
    )
    assert(
      sqlSync(`SELECT count(*) FROM confirmation_challenges WHERE id = 'challenge-1'`) === '1',
      'the collision changed the number of rows',
    )
  })

  await sql(
    `UPDATE confirmation_challenges SET state = 'consumed', consumed_at = ${NOW} ` +
      `WHERE id = 'challenge-1'`,
  )
  await attempt(issueChallengeStatement(INSERT))
  check('rewrites nothing when the id is taken', () => {
    assert(
      sqlSync(`SELECT state FROM confirmation_challenges WHERE id = 'challenge-1'`) === 'consumed',
      'the collision overwrote the row',
    )
  })
}

const PRESENTATION = {
  id: INSERT.id,
  tenantId: INSERT.tenantId,
  sessionId: INSERT.sessionId,
  actionId: INSERT.actionId,
  tokenDigest: INSERT.tokenDigest,
  bindingDigest: INSERT.bindingDigest,
  now: NOW,
}

/** The row a matching transition is expected to return, as `psql` renders it. */
const EXPECTED_RETURNING = [
  INSERT.id,
  INSERT.tenantId,
  INSERT.sessionId,
  INSERT.actionId,
  INSERT.tokenDigest,
  INSERT.bindingDigest,
  'consumed',
  String(INSERT.issuedAt),
  String(INSERT.expiresAt),
  String(NOW),
].join('|')

async function verifyConsume(): Promise<void> {
  // A fresh pending row, because `verifyIssue` deliberately ends on a spent one.
  // Starting from there would send every check below a row that was already
  // consumed: the transition would return zero rows, and the mismatches and the
  // replay would pass for a reason that has nothing to do with the predicate.
  await sql('TRUNCATE confirmation_challenges')
  await run(issueChallengeStatement(INSERT))

  const transitioned = await attempt(consumeChallengeStatement(PRESENTATION))
  check('spends one pending row inside its window and returns the full row', () => {
    assert(
      answered(transitioned) === EXPECTED_RETURNING,
      `expected ${JSON.stringify(EXPECTED_RETURNING)}, got ${JSON.stringify(answered(transitioned))}`,
    )
    assert(
      answered(transitioned).split('|').length === CHALLENGE_COLUMNS.length,
      'the returned row has the wrong number of columns',
    )
  })

  const replay = await attempt(consumeChallengeStatement(PRESENTATION))
  check('reports a replay as zero rows and leaves the first stamp alone', () => {
    assert(answered(replay) === '', `expected zero rows, got ${JSON.stringify(answered(replay))}`)
    assert(
      sqlSync(`SELECT consumed_at FROM confirmation_challenges WHERE id = 'challenge-1'`) ===
        String(NOW),
      'the replay re-stamped the row',
    )
  })

  // Every refusal below gets a pending row of its own and asserts that row is
  // still pending afterwards. Both halves are load-bearing: a check that ran
  // against an already-spent row would see zero rows and pass whether or not the
  // predicate carried the clause at all, so it would be proving the replay.
  for (const wrong of [
    { tenantId: 'tenant-2', column: 'tenantId' },
    { sessionId: 'session-2', column: 'sessionId' },
    { actionId: 'action-2', column: 'actionId' },
    { tokenDigest: 'c'.repeat(64), column: 'tokenDigest' },
    { bindingDigest: 'd'.repeat(64), column: 'bindingDigest' },
  ]) {
    const { column, ...presented } = wrong
    const id = `challenge-${column.toLowerCase()}`
    await run(issueChallengeStatement({ ...INSERT, id }))
    const mismatched = await attempt(
      consumeChallengeStatement({ ...PRESENTATION, id, ...presented }),
    )
    check(`never spends a challenge presented with another ${column}`, () => {
      assert(
        answered(mismatched) === '',
        `expected zero rows, got ${JSON.stringify(answered(mismatched))}`,
      )
      assert(
        sqlSync(`SELECT state FROM confirmation_challenges WHERE id = '${id}'`) === 'pending',
        `the ${column} mismatch spent the row anyway`,
      )
    })
  }

  for (const instant of [INSERT.expiresAt, INSERT.expiresAt + 1]) {
    // The boundary is closed: `expires_at <= now` is expired, not spendable.
    const id = `challenge-expiry-${instant}`
    await run(issueChallengeStatement({ ...INSERT, id }))
    const expired = await attempt(consumeChallengeStatement({ ...PRESENTATION, id, now: instant }))
    check(`spends nothing at or past the expiry (now = ${instant})`, () => {
      assert(
        answered(expired) === '',
        `expected zero rows, got ${JSON.stringify(answered(expired))}`,
      )
      assert(
        sqlSync(`SELECT state FROM confirmation_challenges WHERE id = '${id}'`) === 'pending',
        'the expired presentation spent the row anyway',
      )
    })
  }

  const earlyId = 'challenge-before-issued'
  await run(issueChallengeStatement({ ...INSERT, id: earlyId }))
  const early = await attempt(
    consumeChallengeStatement({ ...PRESENTATION, id: earlyId, now: INSERT.issuedAt - 1 }),
  )
  check('spends nothing before issuance, leaving the challenge pending', () => {
    assert(answered(early) === '', `expected zero rows, got ${JSON.stringify(answered(early))}`)
    assert(
      sqlSync(`SELECT state FROM confirmation_challenges WHERE id = '${earlyId}'`) === 'pending',
      'an early presentation burned the challenge',
    )
  })

  // The boundary gets a row of its own. Every check above it has already spent or
  // refused the shared one, and against a consumed row this would pass for the
  // wrong reason: zero rows is also what a replay looks like, so it would be
  // proving the replay rather than the closed window's last spendable instant.
  const boundaryId = 'challenge-boundary'
  await run(issueChallengeStatement({ ...INSERT, id: boundaryId }))
  const boundary = await attempt(
    consumeChallengeStatement({ ...PRESENTATION, id: boundaryId, now: INSERT.expiresAt - 1 }),
  )
  check('spends a presentation one millisecond inside its window', () => {
    assert(answered(boundary) !== '', 'the last instant inside the window was refused')
  })

  const absent = await attempt(lookupChallengeStatement('challenge-absent'))
  check('reads nothing but the id, so a miss is a miss', () => {
    assert(answered(absent) === '', `expected no row, got ${JSON.stringify(answered(absent))}`)
  })
}

async function verifyRowShape(): Promise<void> {
  check('the disposable cluster listens on Unix sockets only', () => {
    assert(sqlSync('SHOW listen_addresses') === '', 'the trust-auth cluster accepted TCP listeners')
  })

  const brokenFile = join(WORKDIR, 'deliberately-broken-migration.sql')
  writeFileSync(
    brokenFile,
    'SELECT 1;\nSELECT * FROM deliberately_missing_confirmation_table;\nSELECT 2;\n',
  )
  let brokenFileFailed = false
  try {
    execFileSync('psql', psqlFileArguments(TARGET, brokenFile), {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    brokenFileFailed = true
  }
  check('a migration file SQL error exits nonzero', () => {
    assert(brokenFileFailed, 'psql continued after a SQL error in a migration file')
  })

  // Scoped to the one challenge whose instants this script knows. The table holds
  // more than one row by now, and an unqualified select would answer with a
  // column-separated stack of instants that no single challenge issued.
  const issued = await sql('SELECT issued_at FROM confirmation_challenges WHERE id = $1', [
    INSERT.id,
  ])
  process.stdout.write(`  bigint comes back as ${JSON.stringify(issued)}\n`)
  check('a bigint instant round-trips as a whole number of milliseconds', () => {
    assert(/^\d+$/.test(issued), `expected a decimal integer, got ${JSON.stringify(issued)}`)
    assert(Number(issued) === INSERT.issuedAt, `expected ${INSERT.issuedAt}, got ${issued}`)
  })

  const columns = (
    await sql(
      "SELECT string_agg(column_name, ',' ORDER BY ordinal_position) " +
        "FROM information_schema.columns WHERE table_name = 'confirmation_challenges'",
    )
  ).split(',')
  check('the migration declares exactly the columns the statements read', () => {
    assert(
      columns.join(',') === CHALLENGE_COLUMNS.join(','),
      `expected ${COLUMNS}, got ${columns.join(',')}`,
    )
  })
}

async function verifyConstraints(): Promise<void> {
  // A row of its own, spent here. The races above truncate the table, and this
  // section used to depend on whatever `issue` happened to leave behind — so it
  // passed only because of an ordering nobody had written down.
  await sql('TRUNCATE confirmation_challenges')
  await run(issueChallengeStatement({ ...INSERT, id: CONSTRAINT_ID }))
  await run(consumeChallengeStatement({ ...PRESENTATION, id: CONSTRAINT_ID }))

  let duplicateBlocked = false
  try {
    sqlSync(
      `INSERT INTO confirmation_challenges (id, tenant_id, session_id, action_id, ` +
        `token_digest, binding_digest, state, issued_at, expires_at) VALUES ` +
        `('${CONSTRAINT_ID}', 't', 's', 'a', '${'x'.repeat(64)}', '${'y'.repeat(64)}', ` +
        `'pending', 1, 2)`,
    )
  } catch {
    duplicateBlocked = true
  }
  check('the server, not the store, refuses a duplicate id', () => {
    assert(duplicateBlocked, 'a duplicate id was accepted')
  })

  stopServer()
  startServer()
  await waitForServer('the cluster did not come back')

  // Read first, check after. `check` runs its assertion synchronously, so an
  // `async` callback would be reported `ok` before it had agreed to anything and
  // its rejection would escape as an unhandled one.
  const survived = await sql(
    `SELECT state || ':' || consumed_at FROM confirmation_challenges WHERE id = '${CONSTRAINT_ID}'`,
  )
  check('a spent challenge survives the server being restarted', () => {
    assert(
      survived === `consumed:${NOW}`,
      `expected the same consumed row, got ${JSON.stringify(survived)}`,
    )
  })
}

// Last, because it runs the whole script and every declaration it reaches is
// hoisted while the fixtures it consumes are not.
await main()
