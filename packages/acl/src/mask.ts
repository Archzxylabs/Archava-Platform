/**
 * Sensitive-field masking.
 *
 * PRD §16: "Sensitive fields must be masked before model/provider exposure
 * according to policy." The rule is applied at one place — the boundary where
 * an internal value crosses into anything a provider or a model can see — so
 * that masking is a property of the boundary, not of each call site's memory.
 *
 * Design rule: lossy by default, loud when it fires. Every field that was
 * withheld is reported in `notices`, so a consumer can tell an answer was
 * redacted rather than silently wrong.
 */

/** Mask strategy for a single field. */
export const MASK_STRATEGIES = ['preserve', 'redact', 'partial', 'tokenise'] as const
export type MaskStrategy = (typeof MASK_STRATEGIES)[number]

export interface MaskRule {
  readonly field: string
  readonly strategy: MaskStrategy
  /** For `partial`: how many leading characters survive. */
  readonly prefix?: number
}

export interface MaskOptions {
  /** Field names to mask whenever they appear, at any depth. */
  readonly rules?: readonly MaskRule[]
  /** Escapes the default denylist for a name the caller has verified is safe. */
  readonly preserve?: readonly string[]
  /** Alias of `preserve`, for callers that think in terms of allow-lists. */
  readonly allow?: readonly string[]
}

/** Label substituted for a withheld value. */
export const REDACTED_LABEL = '[redacted]'

/** Fields that must never be withheld outright when a partial view suffices. */
const PARTIAL_FIELDS = new Set([
  'email',
  'customeremail',
  'phone',
  'phonenumber',
  'customerphone',
])

/** Substring-triggered denylist. A name containing one of these is sensitive. */
const SENSITIVE_FRAGMENTS = [
  'password',
  'passphrase',
  'secret',
  'token',
  'apikey',
  'authorization',
  'cookie',
  'cvv',
  'cvc',
  'cardnumber',
  'card_number',
  'taxid',
  'nationalid',
  'passport',
  'ssn',
  'otp',
  'bankaccount',
  'bank_account',
  'paymentinstrument',
  'pin',
] as const

/** Whole-name matches that get a partial mask (identifiable but usable). */
const SENSITIVE_NAMES = new Set([
  'email',
  'phone',
  'address',
  'dob',
  'dateofbirth',
  'rawform',
])

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stableHash(value: string): string {
  // FNV-1a. Not cryptographic — it only proves a value was replaced, never to
  // authenticate or identify anyone.
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function looksLikeEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value)
}

function classifyField(field: string, rules: readonly MaskRule[]): MaskStrategy | null {
  const explicit = rules.find((rule) => rule.field === field)
  if (explicit) return explicit.strategy

  const lower = field.toLowerCase()
  if (PARTIAL_FIELDS.has(lower)) return 'partial'
  if (SENSITIVE_FRAGMENTS.some((fragment) => lower.includes(fragment))) return 'redact'
  if (SENSITIVE_NAMES.has(lower)) return 'partial'
  return null
}

function prefixFor(strategy: MaskStrategy, rule: MaskRule, value: string): number {
  if (strategy !== 'partial') return 0
  if (rule.prefix !== undefined) return Math.max(1, rule.prefix)
  return looksLikeEmail(value) ? 2 : 3
}

function maskValue(value: string, rule: MaskRule, path: string, notices: string[]): string {
  const strategy = rule.strategy
  if (strategy === 'preserve') {
    return value
  }
  if (strategy === 'tokenise') {
    notices.push(`${path} tokenised to a non-reversible reference`)
    return `tok_${stableHash(value)}`
  }
  if (strategy === 'partial') {
    const prefix = prefixFor(strategy, rule, value)
    const visible = value.slice(0, prefix)
    const withheld = Math.max(0, value.length - visible.length)
    notices.push(`${path} partially masked (${withheld} character${withheld === 1 ? '' : 's'} withheld)`)
    if (withheld === 0) return `${visible}…`
    return `${visible}${'•'.repeat(Math.min(12, withheld))}`
  }
  notices.push(`${path} redacted before provider exposure`)
  return REDACTED_LABEL
}

export interface MaskedResult {
  readonly value: unknown
  /** Human-readable notes for every field that was withheld. */
  readonly notices: readonly string[]
  /** True when at least one value was withheld. */
  readonly masked: boolean
}

/**
 * Recursively mask `input`, returning a new value. The input is never mutated —
 * masking a payload must not corrupt the record the caller still holds.
 */
export function maskSensitiveFields(
  input: unknown,
  options: MaskOptions = {},
  path = '$',
): MaskedResult {
  const rules = options.rules ?? []
  const preserved = new Set([...(options.preserve ?? []), ...(options.allow ?? [])])
  const notices: string[] = []

  const walk = (value: unknown, currentPath: string): unknown => {
    if (Array.isArray(value)) {
      return value.map((item, index) => walk(item, `${currentPath}[${index}]`))
    }
    if (isPlainObject(value)) {
      const output: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(value)) {
        const childPath = `${currentPath}.${key}`
        if (preserved.has(key)) {
          output[key] = walk(child, childPath)
          continue
        }
        const strategy = classifyField(key, rules)
        if (strategy === null) {
          output[key] = walk(child, childPath)
          continue
        }
        if (isPlainObject(child) || Array.isArray(child)) {
          notices.push(`${childPath} withheld before provider exposure (structured value)`)
          output[key] = REDACTED_LABEL
          continue
        }
        if (typeof child === 'string') {
          output[key] = maskValue(child, { field: key, strategy }, childPath, notices)
          continue
        }
        if (child === null || child === undefined) {
          output[key] = child
          continue
        }
        // A boolean is a flag, not a credential: no secret in this domain is a
        // boolean, and withholding one destroys signal the model needs —
        // `integrationTokensEnabled: [redacted]` reads as a withheld secret.
        // Numbers still count, because a numeric OTP or PIN is possible.
        if (typeof child === 'boolean') {
          output[key] = child
          continue
        }
        notices.push(`${childPath} withheld before provider exposure (non-text value)`)
        output[key] = REDACTED_LABEL
      }
      return output
    }
    return value
  }

  const masked = walk(input, path)
  return {
    value: masked,
    notices,
    masked: notices.length > 0,
  }
}

/** Mask a single string value, for call sites that hold one field. */
export function maskString(value: string, field = 'value', options: MaskOptions = {}): MaskedResult {
  const preserved = new Set([...(options.preserve ?? []), ...(options.allow ?? [])])
  if (preserved.has(field)) {
    return { value, notices: [], masked: false }
  }
  const strategy = classifyField(field, options.rules ?? []) ?? 'redact'
  const notices: string[] = []
  const masked = maskValue(value, { field, strategy }, `$.${field}`, notices)
  return { value: masked, notices, masked: masked !== value }
}

/**
 * Merge an action's declared sensitive fields with the platform defaults into
 * mask rules. Action declarations from PRD §18 are the primary source; the
 * platform contributes fields that must never be exposed regardless of what an
 * action remembered to declare.
 */
export function resolveMaskRules(
  actionSensitiveFields: readonly string[] = [],
  clientSensitiveFields: readonly string[] = [],
): readonly MaskRule[] {
  const fields = [
    ...SENSITIVE_NAMES,
    ...PARTIAL_FIELDS,
    ...actionSensitiveFields,
    ...clientSensitiveFields,
  ]
  return [...new Set(fields)].map((field) => ({
    field,
    strategy: PARTIAL_FIELDS.has(field.toLowerCase()) ? ('partial' as const) : ('redact' as const),
  }))
}
