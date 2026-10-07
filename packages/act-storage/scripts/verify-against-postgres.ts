#!/usr/bin/env node
/**
 * The database half of this package's claims, checked against real PostgreSQL.
 *
 * ## Why this is not a test file
 *
 * `test/` proves this package's behaviour against a recording fake. The fake can
 * prove which SQL ran, with which parameters, in which order. It cannot prove
 * what a server does with that SQL: that a unique index really arbitrates an
 * `ON CONFLICT`, that a conditional `UPDATE` re-reads the row after another
 * transaction moves it, that the primary key is not deferrable, that the CHECK
 * refuses a reference in a state that may not carry one.
 *
 * Those are properties of PostgreSQL, not of this package. An operator who
 * chooses to run this verifies them against a real server.
 *
 * It is deliberately not `*.test.ts` and not under `test/`, so vitest's include
 * patterns cannot pick it up. Ordinary `pnpm test` never runs it:
 *
 *     pnpm --filter @archava/act-storage verify:sql
 *
 * ## What it guarantees about its own environment
 *
 *   * **No network.** It builds its own cluster with `listen_addresses=''`, so
 *     the only way in is a Unix socket inside a fresh `mkdtemp` directory. There
 *     is no TCP listener; nothing outside this machine can reach it.
 *   * **No credentials.** `initdb --auth=trust` on a throwaway cluster destroyed
 *     when the script exits. No password, DSN or secret is read, written, or
 *     accepted as input, and nothing here can be pointed at a shared server.
 *   * **No repo state.** Everything written lands under the OS temporary
 *     directory and is removed in a `finally`. A killed run leaves a cluster
 *     directory in the temp directory, deletable by hand; nothing else.
 *
 * ## Exit codes
 *
 *   0  every check passed, or PostgreSQL tooling is not on PATH (reported SKIP)
 *   1  a check failed, or the cluster could not be built
 *
 * SKIP is exit 0 on purpose: a reviewer on a machine without PostgreSQL should
 * read a sentence saying which claims went unverified, not a red build.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** What a spawned process left behind. */
interface Run {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

/** A session name and the script it runs, as one unit. */
interface Session {
  readonly name: string
  readonly file: string
}

const MIGRATION = path.join(import.meta.dirname, '..', 'migrations', '001_act_attempts.sql')
const COLUMNS = 'tenant_id, action_kind, idempotency_key, fingerprint, state, provider_id'
const RESET = 'TRUNCATE act_attempts;'

/**
 * A single assertion.
 *
 * The body is a plpgsql block that either says nothing or raises. `moved` is the
 * scratch variable every data-modifying statement in a body fills in via
 * `GET DIAGNOSTICS`, and it means the same thing a driver's `rowCount` means: the
 * number of rows the statement actually returned to the client. That is exactly
 * what the adapter in `src/` branches on, so the number being tested is the
 * number that matters and not an estimate derived from a second read.
 *
 * The RAISE re-wraps any failure so the label travels with it, instead of the
 * server naming only a line number.
 */
function check(label: string, body: string): string {
  return `DO $check$\nDECLARE\n  moved integer;\nBEGIN\n${body}\nEXCEPTION WHEN OTHERS THEN\n  RAISE EXCEPTION 'CHECK FAILED [%]: %', '${label}', SQLERRM;\nEND $check$;`
}

/**
 * The assertions one session can make: schema shape, claim, replay, scoping,
 * settlement and the NULL that is not a string. Run in a transaction that is
 * rolled back, so a failure leaves nothing half-done.
 */
const INVARIANTS = [
  check(
    'pk-must-not-be-deferrable',
    `
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'act_attempts'::regclass AND contype = 'p'
       AND (condeferrable OR condeferred)
  ) THEN
    RAISE EXCEPTION 'the identity primary key is deferrable; a duplicate could be committed';
  END IF;`,
  ),

  check(
    'unique-index-arbiters-on-conflict',
    `
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE tablename = 'act_attempts'
       AND indexdef LIKE '%CREATE UNIQUE INDEX%(tenant_id, action_kind, idempotency_key)%'
  ) THEN
    RAISE EXCEPTION 'no unique index on the identity; ON CONFLICT would raise instead of returning zero rows';
  END IF;`,
  ),

  check(
    'claim-fresh-returns-one-row',
    `
  INSERT INTO act_attempts (tenant_id, action_kind, idempotency_key, fingerprint, state)
  VALUES ('t1', 'booking', 'k1', 'fp-1', 'in_flight')
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS moved = ROW_COUNT;
  IF moved <> 1 THEN
    RAISE EXCEPTION 'a fresh claim returned % rows, expected exactly one', moved;
  END IF;`,
  ),

  check(
    'claim-stamps-itself-and-never-settles',
    `
  IF EXISTS (SELECT 1 FROM act_attempts WHERE claimed_at IS NULL
             OR (state = 'in_flight' AND settled_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'claimed_at is missing, or a fresh claim also wrote settled_at';
  END IF;`,
  ),

  check(
    'claim-replay-returns-zero-rows-and-keeps-the-row',
    `
  INSERT INTO act_attempts (tenant_id, action_kind, idempotency_key, fingerprint, state)
  VALUES ('t1', 'booking', 'k1', 'fp-1', 'in_flight')
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS moved = ROW_COUNT;
  IF moved <> 0 THEN
    RAISE EXCEPTION 'a replayed claim returned % rows, expected zero', moved;
  END IF;
  IF (SELECT count(*) FROM act_attempts) <> 1 THEN
    RAISE EXCEPTION 'the replay grew the table to % rows', (SELECT count(*) FROM act_attempts);
  END IF;
  IF (SELECT fingerprint FROM act_attempts) <> 'fp-1'
     OR (SELECT claimed_at FROM act_attempts) IS NULL THEN
    RAISE EXCEPTION 'the replay overwrote the winning row';
  END IF;`,
  ),

  check(
    'tenant-scoping',
    `
  INSERT INTO act_attempts (tenant_id, action_kind, idempotency_key, fingerprint, state)
  VALUES ('t2', 'booking', 'k1', 'fp-1', 'in_flight')
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS moved = ROW_COUNT;
  IF moved <> 1 THEN
    RAISE EXCEPTION 'the same key under another tenant returned % rows, expected an independent claim', moved;
  END IF;`,
  ),

  check(
    'action-kind-scoping',
    `
  INSERT INTO act_attempts (tenant_id, action_kind, idempotency_key, fingerprint, state)
  VALUES ('t1', 'email', 'k1', 'fp-1', 'prepared')
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS moved = ROW_COUNT;
  IF moved <> 1 THEN
    RAISE EXCEPTION 'the same key under another action kind returned % rows, expected an independent claim', moved;
  END IF;`,
  ),

  check(
    'lookup-reads-the-identity-and-its-state',
    `
  PERFORM tenant_id, action_kind, idempotency_key, state, fingerprint
   FROM act_attempts
  WHERE tenant_id = 't1' AND action_kind = 'booking' AND idempotency_key = 'k1'
    AND state = 'in_flight' AND fingerprint = 'fp-1';
  GET DIAGNOSTICS moved = ROW_COUNT;
  IF moved <> 1 THEN
    RAISE EXCEPTION 'the lookup found % rows for the attempt it asked about', moved;
  END IF;`,
  ),

  check(
    'lookup-that-matches-nothing-is-empty-not-an-error',
    `
  PERFORM tenant_id, action_kind, idempotency_key, state, fingerprint
   FROM act_attempts
  WHERE tenant_id = 't1' AND action_kind = 'booking' AND idempotency_key = 'never-used';
  GET DIAGNOSTICS moved = ROW_COUNT;
  IF moved <> 0 THEN
    RAISE EXCEPTION 'a never-used key already had % rows', moved;
  END IF;`,
  ),

  check(
    'settle-writes-the-reference-once',
    `
  UPDATE act_attempts
  SET state = 'confirmed', provider_id = 'BK-1', settled_at = now()
  WHERE tenant_id = 't1' AND action_kind = 'booking' AND idempotency_key = 'k1'
    AND state = 'in_flight';
  GET DIAGNOSTICS moved = ROW_COUNT;
  IF moved <> 1 THEN
    RAISE EXCEPTION 'a matching compare-and-swap moved % rows, expected one', moved;
  END IF;
  IF (SELECT count(*) FROM act_attempts
       WHERE state = 'confirmed' AND provider_id = 'BK-1' AND settled_at IS NOT NULL) <> 1 THEN
    RAISE EXCEPTION 'the settlement did not write a confirmed row carrying its reference and stamp';
  END IF;`,
  ),

  check(
    'a-stale-settle-moves-nothing-and-keeps-the-winner',
    `
  UPDATE act_attempts
  SET state = 'rejected', settled_at = now()
  WHERE tenant_id = 't1' AND action_kind = 'booking' AND idempotency_key = 'k1'
    AND state = 'in_flight';
  GET DIAGNOSTICS moved = ROW_COUNT;
  IF moved <> 0 THEN
    RAISE EXCEPTION 'a stale compare-and-swap moved % rows, expected zero', moved;
  END IF;
  IF (SELECT count(*) FROM act_attempts
       WHERE state = 'confirmed' AND provider_id = 'BK-1') <> 1 THEN
    RAISE EXCEPTION 'the stale write overwrote the confirmed winner';
  END IF;`,
  ),

  check(
    'null-is-not-the-string-null',
    `
  UPDATE act_attempts
  SET state = 'rejected', provider_id = NULL, settled_at = now()
  WHERE tenant_id = 't1' AND action_kind = 'booking' AND idempotency_key = 'k1';
  GET DIAGNOSTICS moved = ROW_COUNT;
  IF moved <> 1 THEN
    RAISE EXCEPTION 'the settlement-without-a-reference moved % rows', moved;
  END IF;
  PERFORM 1 FROM act_attempts
   WHERE tenant_id = 't1' AND action_kind = 'booking' AND idempotency_key = 'k1'
     AND provider_id IS NULL;
  GET DIAGNOSTICS moved = ROW_COUNT;
  IF moved <> 1 THEN
    RAISE EXCEPTION 'the settlement-without-a-reference did not store NULL';
  END IF;`,
  ),

  check(
    'a-reference-in-a-state-that-may-not-carry-one-is-refused',
    `
  BEGIN
    INSERT INTO act_attempts (tenant_id, action_kind, idempotency_key, fingerprint, state, provider_id)
    VALUES ('t9', 'booking', 'k9', 'fp-9', 'in_flight', 'BK-9');
    RAISE EXCEPTION 'the database accepted a reference on an in_flight row';
  EXCEPTION WHEN check_violation THEN
    NULL; -- the refusal this check exists to confirm
  END;`,
  ),

  check(
    'a-confirmed-row-with-no-reference-is-refused',
    `
  BEGIN
    INSERT INTO act_attempts (tenant_id, action_kind, idempotency_key, fingerprint, state, provider_id)
    VALUES ('t9', 'booking', 'k8', 'fp-8', 'confirmed', NULL);
    RAISE EXCEPTION 'the database accepted a confirmed row without a reference';
  EXCEPTION WHEN check_violation THEN
    NULL; -- the refusal this check exists to confirm
  END;`,
  ),
]

/** A session that claims a fresh key, optionally holding it while another arrives. */
function racingClaim(holds: boolean): string {
  return `BEGIN;\nSELECT pg_advisory_xact_lock(9, 1);\nWITH ins AS (\n  INSERT INTO act_attempts (tenant_id, action_kind, idempotency_key, fingerprint, state)\n  VALUES ('t1', 'booking', 'race-1', 'fp-race', 'in_flight')\n  ON CONFLICT DO NOTHING\n  RETURNING 1\n)\nSELECT 'reserve', (SELECT count(*) FROM ins);\n${holds ? 'SELECT pg_sleep(4);\n' : ''}COMMIT;\n`
}

/** A session that settles the same row, optionally holding it while another arrives. */
function racingSettle(state: string, reference: string | null, holds: boolean): string {
  const value = reference === null ? 'NULL' : `'${reference}'`
  return `BEGIN;\nWITH upd AS (\n  UPDATE act_attempts\n     SET state = '${state}', provider_id = ${value}, settled_at = now()\n   WHERE tenant_id = 't1' AND action_kind = 'booking' AND idempotency_key = 'race-1'\n     AND state = 'in_flight'\n  RETURNING 1\n)\nSELECT 'settle', (SELECT count(*) FROM upd);\n${holds ? 'SELECT pg_sleep(4);\n' : ''}COMMIT;\n`
}

/** A session that reads a still-open attempt, waits, and only then tries to move it. */
const READ_THEN_WRITE = `BEGIN;\nSELECT ${COLUMNS} FROM act_attempts\n WHERE tenant_id = 't1' AND action_kind = 'booking' AND idempotency_key = 'slow-1';\nSELECT pg_sleep(3);\nWITH upd AS (\n  UPDATE act_attempts\n     SET state = 'rejected', settled_at = now()\n   WHERE tenant_id = 't1' AND action_kind = 'booking' AND idempotency_key = 'slow-1'\n     AND state = 'in_flight'\n  RETURNING 1\n)\nSELECT 'settle', (SELECT count(*) FROM upd);\nCOMMIT;\n`

/** The settlement that lands between the reader's SELECT and its UPDATE. */
const BETWEEN_READ_AND_WRITE = `SELECT pg_sleep(1);\nUPDATE act_attempts\n   SET state = 'confirmed', provider_id = 'BK-W', settled_at = now()\n WHERE tenant_id = 't1' AND action_kind = 'booking' AND idempotency_key = 'slow-1'\n   AND state = 'in_flight'\nRETURNING 'confirmed' AS what_this_session_settled;\n`

function run(executable: string, args: readonly string[]): Run {
  const done = spawnSync(executable, args, { encoding: 'utf8' })
  return {
    status: done.status ?? -1,
    stdout: done.stdout ?? '',
    stderr: done.stderr ?? '',
  }
}

/**
 * The number a statement reported for a marker, or null if it never reported.
 *
 * `-A` makes psql separate columns with `|`, so the line looks like
 * `reserve|1`. Asserting on `reserve` alone would match either side of the
 * separator, so the parse takes the field *after* the marker.
 */
function reported(output: string, marker: string): number | null {
  const line = output
    .split('\n')
    .find((candidate: string): boolean => candidate.trim().startsWith(marker))
  if (line === undefined) return null
  const value = Number.parseInt(
    line
      .trim()
      .slice(marker.length)
      .replace(/^[^0-9-]+/, ''),
    10,
  )
  return Number.isInteger(value) ? value : null
}
/**
 * Write one line to stdout.
 *
 * The repo's `no-console` rule allows only `warn` and `error`, and this script
 * is an operator-facing report rather than something warning about a fault — its
 * output is the result. So it writes a line directly, with its newline attached,
 * instead of either flouting the rule or being pinned to a rule aimed at
 * application code it does not resemble.
 */
function line(text: string): void {
  process.stdout.write(`${text}\n`)
}

function report(name: string, passed: boolean, detail?: string): boolean {
  line(
    `${passed ? 'PASS' : 'FAIL'}  ${name}${passed || detail === undefined ? '' : `\n      ${detail}`}`,
  )
  return passed
}

function main(): number {
  const absent = ['psql', 'initdb', 'pg_ctl', 'postgres'].find(
    (tool) => run(tool, ['--version']).status !== 0,
  )
  if (absent !== undefined) {
    line(`SKIP  \`${absent}\` is not on PATH. Only the offline contract tests ran, so`)
    line('      server-side uniqueness, scheduling and constraint enforcement are')
    line('      unverified on this machine. See the Result section for how to check them.')
    return 0
  }

  const scratch = mkdtempSync(path.join(tmpdir(), 'act-storage-pg-'))
  const socketDir = path.join(scratch, 'sock')
  const dataDir = path.join(scratch, 'data')
  mkdirSync(socketDir)
  const port = 20000 + Math.floor(Math.random() * 25000)
  const logFile = path.join(scratch, 'server.log')
  const write = (name: string, body: string): string => {
    const file = path.join(scratch, name)
    writeFileSync(file, body)
    return file
  }
  // No -q: the command tags are the evidence that the statements really ran,
  // and the script reports them rather than only its own opinion.
  const psql = (...args: string[]): Run =>
    run('psql', [
      '-X',
      '-v',
      'ON_ERROR_STOP=1',
      '-h',
      socketDir,
      '-p',
      String(port),
      '-U',
      'postgres',
      '-d',
      'postgres',
      ...args,
    ])

  let passed = true
  try {
    const built = run('initdb', [dataDir, '-U', 'postgres', '--auth=trust', '--no-sync'])
    if (built.status !== 0) {
      line('FAIL  could not build a throwaway cluster\n' + built.stderr)
      return 1
    }
    const started = run('pg_ctl', [
      '-D',
      dataDir,
      '-w',
      '-t',
      '60',
      '-l',
      logFile,
      '-o',
      `-k ${socketDir} -p ${port} -c listen_addresses='' -c fsync=off -c synchronous_commit=off`,
      'start',
    ])
    if (started.status !== 0) {
      line('FAIL  the throwaway cluster would not start\n' + started.stdout + started.stderr)
      return 1
    }
    line(`A throwaway PostgreSQL cluster is listening on socket ${socketDir} port ${port}.`)
    line('TCP is disabled, so nothing off this machine can reach it. It is destroyed on exit.\n')

    const migrated = psql('-f', MIGRATION)
    passed &&= report(
      'the migration applies cleanly to a real server',
      migrated.status === 0 &&
        /CREATE TABLE/.test(migrated.stdout) &&
        /CREATE INDEX/.test(migrated.stdout),
      migrated.stdout + migrated.stderr,
    )

    psql('-c', RESET)
    const invariants = psql(
      '-f',
      write('invariants.sql', `\\pset pager off\nBEGIN;\n${INVARIANTS.join('\n')}\nROLLBACK;\n`),
    )
    passed &&= report(
      `${INVARIANTS.length} invariants hold against a real server`,
      invariants.status === 0,
      invariants.stdout + invariants.stderr,
    )

    // ---- two real processes, one row --------------------------------------
    // The fake in test/ can interleave two promises in one process; it cannot
    // make two backends contend for one unique index entry, which is what
    // actually serialises a claim in production.
    /**
     * Run two sessions against each other and return what each one reported.
     *
     * The two outputs come back under the names they were started with, so a
     * caller cannot attribute a result to the session that did not produce it —
     * the failure mode of reading a positional array by eye.
     */
    const race = (first: Session, second: Session): { readonly a: string; readonly b: string } => {
      const command =
        [first, second]
          .map(
            (session, index) =>
              `psql -X -A -t -v ON_ERROR_STOP=1 -h "${socketDir}" -p ${port} -U postgres -d postgres -f "${session.file}" > "${session.file}.out${index}" 2>&1 & `,
          )
          .join('') + 'wait'
      run('bash', ['-c', command])
      // Read back by index, not by name: two sessions that raced each other are
      // distinguished only by their position, and a name-based read is one typo
      // away from handing both of them the same file's contents.
      const a = readFileSync(`${first.file}.out0`, 'utf8')
      const b = readFileSync(`${second.file}.out1`, 'utf8')
      return { a, b }
    }

    psql('-c', RESET)
    const claim = race(
      { name: 'claim.a', file: write('claim-a.sql', racingClaim(true)) },
      { name: 'claim.b', file: write('claim-b.sql', racingClaim(false)) },
    )
    const claimCounts = [claim.a, claim.b].map((output) => reported(output, 'reserve'))
    passed &&= report(
      'two processes racing one claim: exactly one wins, neither errors',
      claimCounts.filter((rows) => rows === 1).length === 1 &&
        claimCounts.filter((rows) => rows === 0).length === 1 &&
        !/ERROR/.test(claim.a) &&
        !/ERROR/.test(claim.b),
      `the competitors reported ${JSON.stringify(claimCounts)} rows`,
    )

    psql('-c', RESET)
    psql(
      '-c',
      "INSERT INTO act_attempts (tenant_id, action_kind, idempotency_key, fingerprint, state) VALUES ('t1', 'booking', 'race-1', 'fp-race', 'in_flight');",
    )
    const settle = race(
      { name: 'settle.a', file: write('settle-a.sql', racingSettle('confirmed', 'BK-A', true)) },
      { name: 'settle.b', file: write('settle-b.sql', racingSettle('rejected', null, false)) },
    )
    const settleCounts = [settle.a, settle.b].map((output) => reported(output, 'settle'))
    const finalSettle = psql(
      '-Atc',
      "SELECT state || '/' || coalesce(provider_id, 'NULL') FROM act_attempts WHERE idempotency_key = 'race-1';",
    )
    // Either backend may win the race. The final row must match the backend
    // whose conditional UPDATE returned one row, whichever ran first.
    const expectedSettle =
      settleCounts[0] === 1 ? 'confirmed/BK-A' : settleCounts[1] === 1 ? 'rejected/NULL' : null
    passed &&= report(
      'two processes racing one settlement: exactly one moves the row',
      settleCounts.filter((rows) => rows === 1).length === 1 &&
        settleCounts.filter((rows) => rows === 0).length === 1 &&
        finalSettle.stdout.trim() === expectedSettle &&
        !/ERROR/.test(settle.a) &&
        !/ERROR/.test(settle.b),
      `the competitors reported ${JSON.stringify(settleCounts)} rows, the row ended ${finalSettle.stdout.trim()}`,
    )

    // ---- the read-then-write hazard ---------------------------------------
    // The dangerous ordering: one session reads a row as `in_flight`, another
    // settles it, and only then does the first write. The write must re-check
    // the state against the row as it now stands, not against what that earlier
    // read saw. `UPDATE ... WHERE state = 'in_flight'` does exactly that.
    psql('-c', RESET)
    psql(
      '-c',
      "INSERT INTO act_attempts (tenant_id, action_kind, idempotency_key, fingerprint, state) VALUES ('t1', 'booking', 'slow-1', 'fp-slow', 'in_flight');",
    )
    const slow = race(
      { name: 'slow.reader', file: write('slow-reader.sql', READ_THEN_WRITE) },
      { name: 'slow.writer', file: write('slow-writer.sql', BETWEEN_READ_AND_WRITE) },
    )
    const reader = slow.a
    const writer = slow.b
    const finalSlow = psql(
      '-Atc',
      "SELECT state || '/' || coalesce(provider_id, 'NULL') FROM act_attempts WHERE idempotency_key = 'slow-1';",
    )
    passed &&= report(
      'a stale read-then-write moves nothing and keeps the winner',
      reported(reader, 'settle') === 0 &&
        /confirmed/.test(writer) &&
        finalSlow.stdout.trim() === 'confirmed/BK-W' &&
        !/ERROR/.test(reader) &&
        !/ERROR/.test(writer),
      `the stale writer moved ${JSON.stringify(reported(reader, 'settle'))} rows, the row ended ${finalSlow.stdout.trim()}`,
    )
  } finally {
    run('pg_ctl', ['-D', dataDir, '-m', 'immediate', 'stop'])
    rmSync(scratch, { recursive: true, force: true })
    line('\nThe throwaway cluster was stopped and removed.')
  }

  line(passed ? '\nEvery check this script can make, passed.' : '\nAt least one check FAILED.')
  return passed ? 0 : 1
}

process.exitCode = main()
