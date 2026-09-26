#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadPricebook, parsePricebook, PricebookError, type Pricebook } from '@archava/config'
import { PricingEngine } from '@archava/pricing'
import {
  buildConfigSet,
  emitClientConfig,
  ClientConfigEmitError,
  parseIntake,
  IntakeError,
  type ClientConfigDraft,
  type ConfigSet,
} from './index.js'

/**
 * The configurator CLI (PRD §14).
 *
 * It exists so a scope can be produced without a browser: the studio route runs
 * the same core, but an operator who wants to know what a set of onboarding
 * answers prices at should not have to start a dev server to find out.
 * Everything this file knows about pricing is in `buildConfigSet`; what is left
 * here is argument handling, JSON in, JSON out.
 *
 * Three rules it holds to:
 *
 * 1. **No silent pricebook search.** `--pricebook` is explicit because
 *    `loadPricebook()` walks up from the working directory, and a CLI run from
 *    the wrong folder would otherwise price against a pricebook nobody chose.
 *    Without the flag it uses that search, and the document says which version
 *    it priced against.
 * 2. **A refusal is a non-zero exit with every reason.** Intake that fails
 *    validation prints all of its issues, not the first — an operator fixing an
 *    intake fixes all of it in one pass instead of one field per round-trip.
 * 3. **Out means stdout, diagnostics mean stderr.** So `> out.json` captures a
 *    document and never a progress line.
 */

/**
 * Palette values a CLI flag may set. Anything richer is the studio's job.
 *
 * Every field is optional because a flag the operator did not type is a value
 * the configurator has not been given — which is different from a default, and
 * the difference decides whether the client config may be emitted at all.
 */
interface BrandingFlags {
  readonly businessName?: string
  readonly tagline?: string
  readonly accent?: string
  readonly surface?: string
  readonly ink?: string
}

/** The same fields while the flags are still being collected. */
type BrandingFlagsBuilder = { -readonly [K in keyof BrandingFlags]: BrandingFlags[K] }

interface CliArgs {
  readonly intakePath: string
  readonly pricebookPath: string | null
  readonly outPath: string | null
  readonly updatedAt: string | null
  readonly branding: BrandingFlags | null
  readonly help: boolean
}

const VALUE_FLAGS = new Set([
  '--pricebook',
  '--out',
  '--updated-at',
  '--business-name',
  '--tagline',
  '--accent',
  '--surface',
  '--ink',
])

export function parseArgs(argv: readonly string[]): CliArgs {
  let intakePath = ''
  let pricebookPath: string | null = null
  let outPath: string | null = null
  let updatedAt: string | null = null
  let help = false
  const branding: BrandingFlagsBuilder = {}

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? ''
    if (arg === '--help' || arg === '-h') {
      help = true
      continue
    }
    if (!arg.startsWith('--')) {
      if (intakePath === '') intakePath = arg
      else throw new Error(`Unexpected argument: ${arg}`)
      continue
    }
    if (!VALUE_FLAGS.has(arg)) throw new Error(`Unknown option: ${arg}`)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value.`)
    i += 1
    if (arg === '--business-name') branding.businessName = value
    else if (arg === '--tagline') branding.tagline = value
    else if (arg === '--accent') branding.accent = value
    else if (arg === '--surface') branding.surface = value
    else if (arg === '--ink') branding.ink = value
    else if (arg === '--pricebook') pricebookPath = value
    else if (arg === '--out') outPath = value
    else updatedAt = value
  }

  return {
    intakePath,
    pricebookPath,
    outPath,
    updatedAt,
    branding: Object.keys(branding).length > 0 ? branding : null,
    help,
  }
}

/** The document an operator reads and, with `--out`, the document they keep. */
interface CliOutput {
  readonly intakePath: string
  readonly pricebook: { readonly schemaVersion: string; readonly path: string | null }
  readonly selected: string
  readonly selectionReason: string
  readonly variants: readonly {
    readonly variant: string
    readonly request: unknown
    readonly quote: unknown
    readonly budget: unknown
    readonly scope: unknown
  }[]
  readonly clientConfig: unknown
}

export function main(argv: readonly string[], cwd: string = process.cwd()): number {
  let args: CliArgs
  try {
    args = parseArgs(argv)
  } catch (error) {
    return fail(2, messageOf(error))
  }

  if (args.help) {
    printUsage()
    return 0
  }
  if (args.intakePath === '') {
    printUsage()
    return fail(2, 'No intake file given.')
  }

  let intake: ReturnType<typeof parseIntake>
  try {
    intake = readIntake(args.intakePath, cwd)
  } catch (error) {
    if (error instanceof IntakeError) {
      return fail(2, `The intake is not valid.\n${error.issues.map((i) => `  ${i}`).join('\n')}`)
    }
    return fail(2, messageOf(error))
  }

  let pricebook: LoadedPricebook
  try {
    pricebook = loadPricebookFor(args.pricebookPath, cwd)
  } catch (error) {
    return fail(1, pricebookMessage(error))
  }
  const engine = new PricingEngine(pricebook.value)

  let set: ConfigSet
  try {
    set = buildConfigSet(intake, engine)
  } catch (error) {
    return fail(1, messageOf(error))
  }

  let clientConfig: unknown = null
  const selected = selectedVariant(set)
  if (args.branding) {
    let draft: ClientConfigDraft
    try {
      draft = clientConfigDraft(args)
    } catch (error) {
      return fail(2, messageOf(error))
    }
    try {
      clientConfig = emitClientConfig(selected.scope, draft)
    } catch (error) {
      if (error instanceof ClientConfigEmitError) {
        return fail(1, `Generated config refused:\n${error.issues.map((i) => `  ${i}`).join('\n')}`)
      }
      return fail(1, messageOf(error))
    }
  }

  const output: CliOutput = {
    intakePath: args.intakePath,
    pricebook: { schemaVersion: engine.schemaVersion, path: pricebook.path },
    selected: set.selected,
    selectionReason: set.selectionReason,
    variants: set.variants.map((entry) => ({
      variant: entry.variant,
      request: entry.request,
      quote: entry.quote,
      budget: entry.budget,
      scope: entry.scope,
    })),
    clientConfig,
  }

  const json = `${JSON.stringify(output, null, 2)}\n`
  if (args.outPath) {
    try {
      writeFileSync(resolve(cwd, args.outPath), json, 'utf8')
    } catch (error) {
      return fail(1, `Could not write ${args.outPath}: ${messageOf(error)}`)
    }
  } else {
    process.stdout.write(json)
  }

  report(set, selected.budget, clientConfig !== null, args)
  return 0
}

/**
 * Branding flags and the config stamp arrive together or not at all: a config
 * with a palette and no date, or a date and no palette, is half a tenant.
 */
function clientConfigDraft(args: CliArgs): ClientConfigDraft {
  const flags = args.branding
  if (!flags) throw new Error('Branding flags were not given.')
  if (!args.updatedAt) {
    throw new Error('Branding flags need --updated-at; the configurator never invents a date.')
  }
  const businessName = flags.businessName
  if (!businessName) {
    throw new Error('A client config needs --business-name.')
  }
  return {
    branding: {
      businessName,
      ...(flags.tagline ? { tagline: flags.tagline } : {}),
      theme: {
        accent: flags.accent ?? '#1F2933',
        surface: flags.surface ?? '#FFFFFF',
        ink: flags.ink ?? '#1F2933',
        radius: 'rounded',
        fontFamily: 'system-ui, sans-serif',
      },
    },
    updatedAt: args.updatedAt,
  }
}

/** Progress and warnings, so stdout stays a document nothing has to filter. */
function report(set: ConfigSet, budget: unknown, emitted: boolean, args: CliArgs): void {
  const lines: string[] = [`Selected: ${set.selected}`, set.selectionReason]
  const verdict = budget as { verdict?: string; basis?: string; reason?: string } | null
  if (verdict?.verdict) {
    lines.push(
      `Budget: ${verdict.verdict} (${verdict.basis ?? 'unknown basis'}) — ${verdict.reason ?? ''}`,
    )
  }
  if (set.scope.overrides.length > 0) {
    lines.push('The scope differs from what the client asked for:')
    for (const override of set.scope.overrides) {
      lines.push(
        `  ${override.field}: ${override.asked} → ${override.recommended} — ${override.reason}`,
      )
    }
  }
  if (args.outPath) {
    // Named on its own line rather than inside an else, because the document is
    // the deliverable and the config is optional. With `--out` and no branding,
    // stdout is empty by design, so this line is the only thing that tells you
    // where the document went.
    lines.push(`Wrote ${args.outPath}`)
  }
  if (!emitted) {
    lines.push(
      'No client config emitted: branding flags (--business-name and friends) plus --updated-at were not given.',
    )
  }
  process.stderr.write(`${lines.join('\n')}\n`)
}

/**
 * A pricebook refusal is an exit code plus its reason. `PricebookError` carries
 * a `detail` for the case where a file exists but is not a valid pricebook —
 * without it the operator learns "invalid pricebook" and has to guess which of
 * the validations rejected it, one run at a time.
 */
function pricebookMessage(error: unknown): string {
  if (error instanceof PricebookError) {
    const detail =
      error.detail === undefined
        ? ''
        : `\n${typeof error.detail === 'string' ? error.detail : JSON.stringify(error.detail, null, 2)}`
    return `${error.message}${detail}`
  }
  return messageOf(error)
}

function selectedVariant(set: ConfigSet) {
  const found = set.variants.find((entry) => entry.variant === set.selected)
  if (!found) throw new Error(`the config set has no ${set.selected} variant`)
  return found
}

/** The pricebook in force, and where it came from — the path a caller named, or null when found by search. */
interface LoadedPricebook {
  readonly value: Pricebook
  readonly path: string | null
}

/**
 * `--pricebook` wins; without it the loader's own search decides. The `path` is
 * null in that case on purpose: a found path is a directory walk's artefact,
 * and repeating it in the document would imply the caller chose it.
 */
function loadPricebookFor(pricebookPath: string | null, cwd: string): LoadedPricebook {
  if (!pricebookPath) return { value: loadPricebook(cwd), path: null }
  const path = resolve(cwd, pricebookPath)
  if (!existsSync(path)) throw new Error(`Pricebook file not found: ${path}`)
  return { value: parsePricebook(readPricebookText(path), path), path: pricebookPath }
}

function readIntake(intakePath: string, cwd: string): ReturnType<typeof parseIntake> {
  const path = resolve(cwd, intakePath)
  if (!existsSync(path)) throw new Error(`Intake file not found: ${path}`)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`Could not read ${path}: ${messageOf(error)}`)
  }
  return parseIntake(parseJson(raw, path))
}

function readPricebookText(path: string): string {
  if (!existsSync(path)) throw new Error(`Pricebook file not found: ${path}`)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`Could not read ${path}: ${messageOf(error)}`)
  }
  parseJson(raw, path)
  return raw
}

/**
 * The two inputs parse differently on purpose. `parseIntake` takes a value a
 * schema can read, while `parsePricebook` takes text and parses it itself so it
 * can report the offending document — so the intake is parsed here and the
 * pricebook is only checked for well-formedness before being handed on whole.
 */
function parseJson(raw: string, path: string): unknown {
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${messageOf(error)}`)
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Print the diagnostic and the exit code, so a caller never splits the two. */
function fail(code: number, message: string): number {
  process.stderr.write(`${message}\n`)
  return code
}

function printUsage(): void {
  process.stdout.write(
    [
      'Usage: configurator <intake.json> [options]',
      '',
      'Options:',
      '  --pricebook <path>   Pricebook to price against (default: search from cwd)',
      '  --out <path>         Write the document here instead of stdout',
      '  --business-name <s>  Business name for the emitted client config',
      '  --tagline <s>        Optional tagline',
      '  --accent <hex>       Accent colour for the emitted client config',
      '  --surface <hex>      Surface colour for the emitted client config',
      '  --ink <hex>          Ink colour for the emitted client config',
      '  --updated-at <date>  YYYY-MM-DD stamp for the emitted client config',
      '  -h, --help           This text',
      '',
    ].join('\n'),
  )
}

/**
 * The entrypoint, kept apart from `main` so a test can drive it with arguments
 * and a cwd without spawning a process.
 *
 * `import.meta.main` is the guard that makes this file both a runnable script
 * and an importable module: it is false when something imports the file, which
 * is precisely when the side effect must not happen. The exit code is set
 * rather than thrown so a document already written to stdout is never cut off
 * by a process that exits before the stream drains.
 */
if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2))
}
