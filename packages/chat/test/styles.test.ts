import { describe, expect, it } from 'vitest'
import { chatSheet } from '../src/index.js'

/**
 * The stylesheet, as a boundary.
 *
 * PRD §24 puts this text inside a shadow root on someone else's page, so the
 * property under test is not whether it looks good but whether a tenant can put
 * anything through it that is not a colour. `theme` carries a palette; a palette
 * does not get to end a rule, open a new one, or close the `<style>` element it
 * is interpolated into. A malformed value degrades to the default palette rather
 * than breaking the embed.
 */

function theme(overrides: Record<string, unknown> = {}): Parameters<typeof chatSheet>[0] {
  return {
    accent: '#1f6f5c',
    surface: '#ffffff',
    ink: '#16211d',
    radius: 'rounded',
    fontFamily: 'Inter',
    ...overrides,
  }
}

describe('chatSheet', () => {
  it('is a full stylesheet, not a fragment', () => {
    const sheet = chatSheet(null)
    expect(sheet).toContain(':host')
    expect(sheet).toContain('.archava-log')
    expect(sheet).toContain('.archava-confirmation')
    // Re-declared, because shadow isolation keeps the host's reset out as surely
    // as it keeps the host's rules out.
    expect(sheet).toContain('box-sizing: border-box')
  })

  it('falls back to the default palette when a tenant has no theme', () => {
    const sheet = chatSheet(null)
    expect(sheet).toContain('#1f6f5c')
    expect(sheet).toContain('#ffffff')
    expect(sheet).toContain('#16211d')
  })

  it('writes a tenant’s palette into the sheet', () => {
    const sheet = chatSheet(theme({ accent: '#ff0000', surface: '#000000', ink: '#fefefe' }))
    expect(sheet).toContain('#ff0000')
    expect(sheet).toContain('#000000')
    expect(sheet).toContain('#fefefe')
    expect(sheet).not.toContain('#1f6f5c')
  })

  it('translates a radius token rather than accepting a length', () => {
    expect(chatSheet(theme({ radius: 'sharp' }))).toContain('border-radius: 0px')
    expect(chatSheet(theme({ radius: 'soft' }))).toContain('border-radius: 8px')
    expect(chatSheet(theme({ radius: 'rounded' }))).toContain('border-radius: 14px')
  })
})

describe('a colour that is not a hex', () => {
  it('is dropped, so no tenant text reaches the stylesheet', () => {
    // `red` is not a `#rrggbb` colour, and a value that is not one could be
    // anything at all — so the default accent stands instead.
    const sheet = chatSheet(theme({ accent: 'red' }))
    expect(sheet).toContain('#1f6f5c')
    expect(sheet).not.toContain('red')
  })

  it('cannot close the style element it is interpolated into', () => {
    const hostile = '#ffffff; } html { display: none'
    const sheet = chatSheet(theme({ accent: hostile, surface: hostile, ink: hostile }))
    expect(sheet).not.toContain('display: none')
    expect(sheet).not.toContain('} html {')
    expect(chatSheet(theme()).match(/<\/style/gi)).toBeNull()
  })
})

describe('a font that is not a stack', () => {
  it('keeps the family names and strips anything that could open a rule', () => {
    const sheet = chatSheet(theme({ fontFamily: 'Inter; } body { display: none' }))
    expect(sheet).toContain('Inter')
    expect(sheet).not.toContain('display: none')
    expect(sheet).not.toContain('} body {')
  })

  it('keeps a real multi-family stack intact', () => {
    const sheet = chatSheet(theme({ fontFamily: 'Inter, "Helvetica Neue", sans-serif' }))
    expect(sheet).toContain('font-family: Inter, "Helvetica Neue", sans-serif')
  })

  it('falls back when the tenant named no family at all', () => {
    const sheet = chatSheet(theme({ fontFamily: '   ' }))
    expect(sheet).toContain('system-ui, sans-serif')
  })
})

/** Every colour the sheet declares before it hands over to dark mode. */
function lightDeclarations(sheet: string): string[] {
  const before = sheet.slice(0, sheet.indexOf('@media'))
  return before.match(/--archava-[a-z-]+: #[0-9a-f]{6}/g) ?? []
}

/**
 * Everything the dark mode block re-declares.
 *
 * Matched rather than sliced: the region is the `:host` rule inside the media
 * query, the only place in the sheet that changes its mind about a colour.
 */
function darkDeclarations(sheet: string): string[] {
  const block = sheet.match(/@media \(prefers-color-scheme: dark\) \{\s*:host \{([^}]*)\}/)?.[1]
  return block?.match(/--archava-[a-z-]+: #[0-9a-f]{6}/g) ?? []
}

/**
 * Dark mode, as the sheet's own problem.
 *
 * There is no `theme.mode` field to configure: a visitor's mode is their
 * system's, so the sheet declares that it supports both and re-declares the two
 * things that change. What it must never do is invent a colour to do it with —
 * the dark ground is the tenant's own palette with its places swapped.
 */
describe('a palette in both modes', () => {
  it("asks the visitor's system rather than the tenant for the mode", () => {
    const sheet = chatSheet(null)
    expect(sheet).toContain('color-scheme: light dark')
    expect(sheet).toContain('@media (prefers-color-scheme: dark)')
  })

  it("re-grounds a light palette by swapping the tenant's two colours", () => {
    const sheet = chatSheet(null)
    expect(lightDeclarations(sheet)).toEqual([
      '--archava-accent: #1f6f5c',
      '--archava-surface: #ffffff',
      '--archava-ink: #16211d',
      '--archava-on-accent: #ffffff',
    ])
    // The accent sits above the ground, so it is declared once and is not
    // re-declared here — which is why dark mode is two lines rather than a
    // second stylesheet.
    expect(darkDeclarations(sheet)).toEqual([
      '--archava-surface: #16211d',
      '--archava-ink: #ffffff',
    ])
  })

  it('invents nothing: dark mode re-declares two colours it was given', () => {
    const sheet = chatSheet(theme({ surface: '#f0f0f0', ink: '#101010' }))
    expect(darkDeclarations(sheet)).toEqual([
      '--archava-surface: #101010',
      '--archava-ink: #f0f0f0',
    ])
  })

  it('reads a tenant who committed a dark palette as dark-first', () => {
    // The committed ground stays the dark one and light mode is the swap: a
    // tenant is never told it committed the wrong mode.
    const sheet = chatSheet(theme({ surface: '#000000', ink: '#fefefe' }))
    expect(lightDeclarations(sheet)).toContain('--archava-surface: #fefefe')
    expect(darkDeclarations(sheet)).toEqual([
      '--archava-surface: #000000',
      '--archava-ink: #fefefe',
    ])
  })

  it('reads every colour through a property, so one rule serves both modes', () => {
    const sheet = chatSheet(null)
    expect(sheet).toContain('color: var(--archava-ink)')
    expect(sheet).toContain('background: var(--archava-accent)')
    // Borders used to be mixed against a hard-coded ink, which left a tenant
    // with a light ink drawing invisible lines.
    expect(sheet).toContain('color-mix(in srgb, var(--archava-ink) 12%, transparent)')
    expect(sheet).not.toContain('#16211d 12%')
  })

  it("picks the text on an accent from the tenant's ground, not a constant", () => {
    // A send button drawn on a light accent is unreadable in white.
    expect(chatSheet(null)).toContain('--archava-on-accent: #ffffff')
    expect(chatSheet(theme({ accent: '#ffff00', surface: '#000000', ink: '#ffffff' }))).toContain(
      '--archava-on-accent: #000000',
    )
  })

  it('cannot be broken out of through a derived value either', () => {
    const hostile = '#ffffff; } html { display: none'
    const sheet = chatSheet(theme({ surface: hostile, ink: hostile }))
    expect(sheet).not.toContain('display: none')
    expect(sheet).not.toContain('} html {')
    expect(sheet.match(/<\/style/gi)).toBeNull()
  })

  it('writes one balanced media query, not a second stylesheet', () => {
    // The media block is hand-built string CSS. A nesting slip inside it would
    // make the browser discard the rest of the sheet, and a discarded sheet
    // still looks like a passing test — so the shape is asserted directly.
    const sheet = chatSheet(null)
    expect(sheet.match(/@media \(prefers-color-scheme: dark\)/g)).toHaveLength(1)
    expect(sheet).toContain('@media (prefers-color-scheme: dark) {\n  :host {')
    expect(trailingBraces(sheet)).toBe(0)
    // The query declares the ground and closes on its own two braces, so it
    // cannot swallow the rest of the sheet.
    const [block = ''] = sheet
      .slice(sheet.indexOf('@media (prefers-color-scheme: dark)'))
      .split('}')
    expect(block).toContain('--archava-surface')
    expect(block.match(/[{}]/g)).toHaveLength(2)
  })
})

/**
 * `{` minus `}` across the whole sheet.
 *
 * A browser drops everything from the first unbalanced brace onward, so a sheet
 * that does not come to zero is a sheet with a silently missing half — which no
 * `toContain` on a class name would ever notice.
 */
function trailingBraces(sheet: string): number {
  let depth = 0
  for (const character of sheet) {
    if (character === '{') {
      depth += 1
    }
    if (character === '}') {
      depth -= 1
    }
  }
  return depth
}
