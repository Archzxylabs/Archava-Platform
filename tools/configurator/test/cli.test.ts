import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { main, parseArgs } from '../src/cli.js'

/**
 * The CLI, driven in-process.
 *
 * `main` is exported for exactly this, so these tests assert the contract an
 * operator relies on — stdout is a document, stderr is diagnostics, a refusal
 * is a non-zero exit with every reason — without paying for a subprocess per
 * case. What they do *not* re-test is the pricing underneath: that is
 * `variants.test.ts` and `budget.test.ts`'s job, and quoting it again here
 * would only pin the same numbers in a second place.
 */

const configuratorDir = fileURLToPath(new URL('..', import.meta.url))
const intakePath = 'examples/klinik.nusantara.intake.json'
const pricebookPath = '../../config/pricing.v1.json'

/** Every stream write a run produces, kept so a test can assert on either. */
interface Captured {
  stdout: string
  stderr: string
}

let captured: Captured
const original = {
  stdout: process.stdout.write.bind(process.stdout),
  stderr: process.stderr.write.bind(process.stderr),
}

beforeEach(() => {
  captured = { stdout: '', stderr: '' }
  process.stdout.write = append(captured, 'stdout')
  process.stderr.write = append(captured, 'stderr')
})

afterEach(() => {
  process.stdout.write = original.stdout
  process.stderr.write = original.stderr
})

/** A writer that records into `sink` and reports the write as handled. */
function append(sink: Captured, key: keyof Captured): typeof process.stdout.write {
  return (chunk: string) => {
    sink[key] += chunk
    return true
  }
}

/** Run the CLI and return the exit code and what it wrote. */
function run(args: readonly string[]): { code: number; captured: Captured } {
  const code = main(args, configuratorDir)
  return { code, captured }
}

describe('parseArgs', () => {
  it('takes the first positional as the intake and names an explicit pricebook', () => {
    const args = parseArgs(['a.json', '--pricebook', 'pb.json'])
    expect(args.intakePath).toBe('a.json')
    expect(args.pricebookPath).toBe('pb.json')
    expect(args.branding).toBeNull()
    expect(args.help).toBe(false)
  })

  it('refuses an option it does not know, rather than ignoring it', () => {
    expect(() => parseArgs(['a.json', '--premium'])).toThrow(/Unknown option/)
  })

  it('refuses a value flag with no value, and a second intake', () => {
    expect(() => parseArgs(['a.json', '--out'])).toThrow(/needs a value/)
    expect(() => parseArgs(['a.json', 'b.json'])).toThrow(/Unexpected argument/)
  })

  it('collects branding flags only when one was given', () => {
    expect(parseArgs(['a.json']).branding).toBeNull()
    const branding = parseArgs([
      'a.json',
      '--business-name',
      'Acme',
      '--tagline',
      'Hello',
      '--accent',
      '#000000',
      '--updated-at',
      '2026-09-22',
    ]).branding
    // Only the flags actually typed. A flag left out is a value the
    // configurator has not been given, which is not the same as a default.
    expect(branding).toEqual({ businessName: 'Acme', tagline: 'Hello', accent: '#000000' })
  })
})

describe('main', () => {
  it('writes the document to stdout and the report to stderr', () => {
    const { code, captured } = run([intakePath, '--pricebook', pricebookPath])
    expect(code).toBe(0)

    // stdout parses as one JSON document and nothing else, so `> out.json`
    // captures a document and never a progress line.
    const doc = JSON.parse(captured.stdout) as Record<string, never>
    expect(doc).toHaveProperty('selected')
    expect(captured.stderr).toContain('Selected: ')
    expect(captured.stderr).toContain('Budget: ')
  })

  it('writes the document to a file when told, and says so on stderr', () => {
    const dir = mkdtempSync(join(tmpdir(), 'configurator-'))
    const outPath = join(dir, 'out.json')
    const { code, captured } = run([intakePath, '--pricebook', pricebookPath, '--out', outPath])
    expect(code).toBe(0)

    const written = JSON.parse(readFileSync(outPath, 'utf8')) as Record<string, never>
    expect(captured.stdout).toBe('')
    expect(captured.stderr).toContain(`Wrote ${outPath}`)
    expect(written).toHaveProperty('selected')
  })

  it('refuses an intake file that is not there, with the path it looked for', () => {
    const { code, captured } = run(['nope.json', '--pricebook', pricebookPath])
    expect(code).toBe(2)
    expect(captured.stderr).toContain('nope.json')
    expect(captured.stdout).toBe('')
  })

  it('refuses an invalid intake with every issue, not the first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'configurator-'))
    const path = join(dir, 'bad.json')
    writeFileSync(
      path,
      JSON.stringify({
        clientId: 'Not Kebab',
        targetLaunchDate: '02/11/2026',
        budget: { amount: -1, currency: 'GBP' },
      }),
      'utf8',
    )
    const { code, captured } = run([path, '--pricebook', pricebookPath])
    expect(code).toBe(2)
    expect(captured.stderr).toContain('clientId')
    expect(captured.stderr).toContain('targetLaunchDate')
    expect(captured.stderr).toContain('budget')
    expect(captured.stdout).toBe('')
  })

  it('refuses a pricebook that does not exist rather than silently searching', () => {
    const { code, captured } = run([intakePath, '--pricebook', 'nope.json'])
    expect(code).toBe(1)
    expect(captured.stderr).toContain('nope.json')
  })

  it('emits no client config unless branding arrived with a date', () => {
    const { code, captured } = run([
      intakePath,
      '--pricebook',
      pricebookPath,
      '--business-name',
      'Klinik Nusantara',
    ])
    // Branding without --updated-at is half a tenant, and the configurator
    // refuses to invent a date. The quote is never produced either: a run
    // that cannot finish is not a run worth half of.
    expect(code).toBe(2)
    expect(captured.stderr).toContain('--updated-at')

    const ok = run([intakePath, '--pricebook', pricebookPath])
    expect(ok.code).toBe(0)
    expect(JSON.parse(ok.captured.stdout)).toHaveProperty('clientConfig', null)
    expect(ok.captured.stderr).toContain('No client config emitted')
  })

  it('emits a client config the schema accepts when branding and a date both arrive', () => {
    const { code, captured } = run([
      intakePath,
      '--pricebook',
      pricebookPath,
      '--business-name',
      'Klinik Nusantara',
      '--accent',
      '#0B6E4F',
      '--updated-at',
      '2026-09-22',
    ])
    expect(code).toBe(0)

    const doc = JSON.parse(captured.stdout) as { clientConfig: { updatedAt: string } }
    expect(doc.clientConfig.updatedAt).toBe('2026-09-22')
  })

  it('reports every scope override it applied', () => {
    const { code, captured } = run([intakePath, '--pricebook', pricebookPath])
    expect(code).toBe(0)
    expect(captured.stderr).toContain('environment: business → commerce_booking')
  })

  it('prints usage and exits 2 when given nothing to work with', () => {
    const { code, captured } = run([])
    expect(code).toBe(2)
    expect(captured.stdout).toContain('Usage:')
  })
})
