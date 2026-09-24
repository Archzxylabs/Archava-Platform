/**
 * The studio: intake in, priced variants out.
 *
 * This is the second integration PRD §24 describes, and the difference from the
 * page is where the work happens. A page runs the turn pipeline in the visitor's
 * browser; the studio runs nothing but a `fetch`. Pricing reads a pricebook off
 * disk, and the pricebook is the one thing in this platform that stays on the
 * server — the numbers are produced there and displayed here, never recomputed
 * here.
 *
 * That is also why this bundle imports nothing from the platform. The
 * configurator's barrel reaches `@archava/pricing`, which reaches the pricebook
 * loader, and a bundle that contains `node:fs` is a bundle that cannot run in a
 * browser. So the studio holds no validator of its own: it posts what the
 * operator wrote, and the route answers either with numbers or with the exact
 * fields that were wrong. A second validator on the client would be a second
 * place to disagree with the one that matters.
 *
 * What it deliberately does not do: it does not decide the variant. §14.1's
 * three variants come back with a selection and the reason for it, and the
 * studio shows all three at their own prices. A configurator that pre-selected
 * one in the UI would hide the comparison that justifies the price.
 */

/** What the route answers, as far as the studio reads it. */
interface StudioResponse {
  readonly set?: {
    readonly variants: readonly {
      readonly variant: string
      /**
       * The two numbers a quote actually has. Not `total`: a `Quote` prices a
       * one-time build (`oneTimeTotal`) and a recurring run (`monthlyBase`)
       * separately, and a client deciding between three variants needs to see
       * that split rather than a sum of unlike things.
       */
      readonly quote: {
        readonly oneTimeTotal: number | null
        readonly monthlyBase: number
        readonly currency: string
      }
      readonly budget: { readonly verdict: string } | null
    }[]
    readonly selected: string
    readonly selectionReason: string
  }
  readonly config?: { readonly tenantId: string } | null
  /** What the route answered instead when it refused the intake (§24). */
  readonly error?: StudioError
}

interface StudioError {
  readonly message: string
  readonly issues?: readonly string[]
}

/**
 * The element the studio needs, or a refusal naming what is missing.
 *
 * Every one of these throws rather than yielding a maybe, because the studio is
 * a single form: a page that has not got its form is a page misconfigured, not
 * a page to degrade. `getElementById` answers `HTMLElement` for any id, so the
 * tag is stated at the call site and checked here.
 */
function required<T extends HTMLElement>(id: string, absence: string): T {
  const found = document.getElementById(id)
  if (found === null) throw new Error(`missing #${id}; ${absence}`)
  return found as T
}

const form = required<HTMLFormElement>('studio-intake', 'the studio has no form to submit')
const intake = required<HTMLTextAreaElement>(
  'studio-intake-json',
  'the studio has no intake to send',
)
const brandName = required<HTMLInputElement>(
  'studio-brand-name',
  'the studio has no brand field to prefill',
)
const output = required<HTMLElement>('studio-result', 'the studio has nowhere to show a quote')

form.addEventListener('submit', (event: Event) => {
  event.preventDefault()
  void submit()
})

/** Send what the operator wrote, and put the answer where it can be read. */
async function submit(): Promise<void> {
  let body: unknown
  try {
    body = JSON.parse(intake.value) as unknown
  } catch (error) {
    render([
      error instanceof Error
        ? `The intake is not valid JSON: ${error.message}`
        : 'The intake is not valid JSON.',
    ])
    return
  }

  show('Pricing…')
  try {
    const response = await fetch('/api/quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        intake: body,
        branding: branding(),
        updatedAt: new Date().toISOString().slice(0, 10),
      }),
    })
    const payload = (await response.json()) as StudioResponse
    if (!response.ok) {
      render(errorLines(payload.error))
      return
    }
    renderResult(payload)
  } catch (error) {
    render([error instanceof Error ? error.message : String(error)])
  }
}

/**
 * Branding from the form, or a name the reference palette is happy with.
 *
 * `emitClientConfig` refuses to guess a business name, so the studio asks for
 * one. A studio that invented a palette would be making a design decision on a
 * client's behalf, which is not the configurator's job — §14 is scope and price.
 */
/**
 * The reference palette, stated once.
 *
 * `emitClientConfig` refuses to guess a brand (see `client-config.ts` boundary
 * 1), so the studio asks for a business name and supplies the reference tenant's
 * palette for it. The values are the reference tenant's own — `packages/reference`
 * declares them, and repeating them here is a duplication with a reason: the
 * studio must not import `@archava/configurator`, whose barrel reaches the
 * pricebook loader and the filesystem, and a browser bundle with `node:fs` in it
 * is a bundle that does not run. Sending four hex codes is cheaper than that.
 *
 * It is a palette and nothing else. `brandingSchema` takes no arbitrary CSS, so
 * the studio cannot style a client's page even by accident — §14 is scope and
 * price, and a design decision made on a client's behalf is neither.
 */
const REFERENCE_THEME = {
  accent: '#1f6f5c',
  surface: '#f7f5f0',
  ink: '#16201d',
  radius: 'rounded',
  fontFamily: 'Inter',
} as const

/**
 * Branding from the form.
 *
 * A studio that invented a palette would be making a design decision on a
 * client's behalf, which is not the configurator's job — §14 is scope and price.
 * So the name is the operator's (or the intake's own, see `readClientName`), and
 * the colours are the reference ones, named as such rather than presented as a
 * choice.
 */
function branding(): unknown {
  const stated = brandName.value.trim()
  const written = readClientName()
  return {
    businessName: stated === '' ? written : stated,
    tagline: 'Archava Studio',
    theme: REFERENCE_THEME,
  }
}

/** The name already in the intake, so an operator who typed it once types it once. */
function readClientName(): string {
  try {
    const parsed: unknown = JSON.parse(intake.value)
    if (typeof parsed === 'object' && parsed !== null && 'clientName' in parsed) {
      const name = (parsed as { readonly clientName?: unknown }).clientName
      if (typeof name === 'string') return name
    }
  } catch {
    // A malformed intake has nothing to fall back to; the route will say so.
  }
  return 'Archava Studio Tenant'
}

function renderResult(payload: StudioResponse): void {
  const set = payload.set
  if (set === undefined) {
    render(['The server answered without a config set.'])
    return
  }
  const lines: string[] = [`Selected: ${set.selected}`, set.selectionReason, '']
  for (const entry of set.variants) {
    const verdict = entry.budget?.verdict ?? 'no stated budget'
    lines.push(
      `${entry.variant} — ${oneTime(entry.quote)} + ${formatMoney(entry.quote.monthlyBase)} ` +
        `${entry.quote.currency}/month (${verdict})`,
    )
  }
  const config = payload.config ?? null
  if (config !== null) {
    lines.push('', `Client config emitted for tenant ${config.tenantId}.`)
  }
  render(lines)
}

/**
 * The one-time cost, or an honest refusal to name one.
 *
 * `oneTimeTotal` is null when any line is priced `setup_from` — a lower bound,
 * never a final number. A studio that printed `0` for those would be quoting a
 * price nobody offered, which is the one mistake this platform will not make.
 */
function oneTime(quote: { readonly oneTimeTotal: number | null }): string {
  return quote.oneTimeTotal === null ? 'custom-quote' : formatMoney(quote.oneTimeTotal)
}

function formatMoney(amount: number): string {
  return amount.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

function errorLines(error: StudioError | undefined): readonly string[] {
  if (error === undefined) return ['The server did not explain what went wrong.']
  return [error.message, ...(error.issues ?? [])]
}

function show(text: string): void {
  output.textContent = text
}

function render(lines: readonly string[]): void {
  output.replaceChildren()
  const list = document.createElement('ul')
  for (const line of lines) {
    const item = document.createElement('li')
    item.textContent = line
    list.append(item)
  }
  output.append(list)
}
