/**
 * The stylesheet, as text.
 *
 * It is generated rather than shipped as a static `.css` file because it is
 * tenant-shaped: accent, surface, ink, corner radius and typeface all come from
 * the tenant's `branding.theme`, and PRD §24 puts that stylesheet *inside* the
 * shadow root so the two isolation directions both hold.
 *
 * What the tenant supplies is a palette, never CSS. `theme` carries a hex colour
 * and a font stack — there is no `customCss` field, and there will not be one,
 * because a stylesheet string in a config file is arbitrary code running in
 * someone else's page. So every value this file writes is re-checked before it
 * is interpolated: a hex that does not match `#rrggbb` is dropped, and a font
 * stack is reduced to its family names with anything that could close a rule
 * (`;`, `{`, `}`, `<`, `>`, `\`) removed. A malformed theme degrades to the
 * default palette rather than failing the embed.
 *
 * **Dark mode is derived, not configured.** There is no `theme.mode` field,
 * because the mode a visitor sees is a mode their own system has already
 * chosen: the sheet declares `color-scheme: light dark` and re-grounds the
 * palette inside `@media (prefers-color-scheme: dark)`. The dark ground is the
 * tenant's own two colours with their places swapped — `surface` becomes ink,
 * `ink` becomes surface — so the dark palette is still the tenant's palette,
 * and this file never invents a colour it was not handed. Everything above the
 * ground (the accent, and the text that reads on it) is the tenant's in both
 * modes; only the ground flips. Which of the two committed colours is the light
 * one is read off the luminance of `surface`, so a tenant who commits a dark
 * palette gets dark as the committed mode and light as the swap.
 *
 * Every colour a rule uses is read through a `--archava-*` custom property, so
 * one rule serves both modes and the dark block is three lines instead of a
 * second copy of the sheet. The trade-off is stated rather than hidden: custom
 * properties inherit inward from the host page, so a host that deliberately
 * declares `--archava-ink` could still restyle the ground. That is a host
 * reaching into a namespaced name, not the failure this file guards against —
 * the tenant cannot put anything through the palette that is not a colour,
 * because that is settled before interpolation, and the host can already hide
 * the whole widget without touching CSS.
 */

import type { Branding } from "@archava/config";

/** The palette a tenant without a theme gets. */
const DEFAULT_THEME: Readonly<{
  readonly accent: string;
  readonly surface: string;
  readonly ink: string;
  readonly fontFamily: string;
}> = {
  accent: "#1f6f5c",
  surface: "#ffffff",
  ink: "#16211d",
  fontFamily: "system-ui, sans-serif",
};

/** PRD §24's three radii, in pixels, because CSS takes lengths. */
const RADIUS: Readonly<Record<string, string>> = {
  soft: "8px",
  rounded: "14px",
  sharp: "0px",
};

/** The radius used when a theme omits one or names one this file does not know. */
const DEFAULT_RADIUS = "8px";

/** Which colour is the page and which colour is the text, for one mode. */
interface Ground {
  readonly surface: string;
  readonly ink: string;
}

/** The tenant's palette, resolved for both of the modes the sheet can be in. */
interface Palette {
  readonly accent: string;
  readonly radius: string;
  readonly fontFamily: string;
  readonly light: Ground;
  readonly dark: Ground;
  /** The end of the tenant's ground that reads on top of `accent`. */
  readonly onAccent: string;
}

/**
 * The sheet for one tenant, in both modes.
 *
 * Returns a complete CSS document, ready to be assigned to a `<style>` inside
 * the shadow root. It re-declares everything it relies on — inherited font,
 * colour and box sizing among them — because shadow isolation means the host
 * page's rules do not reach in, and so the host's reset does not either.
 */
export function chatSheet(theme: Branding["theme"] | null): string {
  const palette = resolvePalette(theme);
  return [
    tokens(palette),
    reset(palette),
    log(),
    composer(palette.radius),
    banner(),
    truth(),
    matrix(),
    picker(palette.radius),
    order(),
    sourceCard(),
    action(palette.radius),
    inspector(),
  ].join("\n");
}

/** A `#rrggbb` colour, or `null` when the value is anything else. */
function hexColor(value: string | undefined): string | null {
  if (value === undefined || /^#[0-9a-fA-F]{6}$/.test(value) === false) {
    return null;
  }
  return value.toLowerCase();
}

/**
 * A font stack reduced to family names.
 *
 * A whitelist rather than a blacklist of separators: stripping `;` and `{` out
 * of `Inter; } body { display: none` leaves `Inter   body   display: none`,
 * and the colon that used them is still in place. What a family name is made of
 * is known exactly — letters, digits, spaces, commas, quotes and hyphens — so
 * anything else is not a family name and is dropped, and nothing that could end
 * a declaration survives.
 */
function fontStack(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const cleaned = value.replace(/[^a-zA-Z0-9\s,'"-]/g, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * The tenant's palette, plus the two grounds it can be drawn on.
 *
 * The luminance comparison is the only judgement made here, and it is made
 * about the tenant's own colours: whichever end of the committed pair is darker
 * is the one that becomes text, and the other becomes the page. A tenant who
 * commits a light pair therefore gets light as the committed mode, and a tenant
 * who commits a dark pair gets dark — neither is asked to say which.
 */
function resolvePalette(theme: Branding["theme"] | null): Palette {
  const accent = hexColor(theme?.accent) ?? DEFAULT_THEME.accent;
  const surface = hexColor(theme?.surface) ?? DEFAULT_THEME.surface;
  const ink = hexColor(theme?.ink) ?? DEFAULT_THEME.ink;
  const fontFamily = fontStack(theme?.fontFamily) ?? DEFAULT_THEME.fontFamily;
  const radius =
    theme?.radius === undefined
      ? DEFAULT_RADIUS
      : (RADIUS[theme.radius] ?? DEFAULT_RADIUS);
  const committed: Ground = { surface, ink };
  const swapped: Ground = { surface: ink, ink: surface };
  const lightFirst = relativeLuminance(surface) > relativeLuminance(ink);
  return {
    accent,
    radius,
    fontFamily,
    light: lightFirst ? committed : swapped,
    dark: lightFirst ? swapped : committed,
    onAccent: readableOn(accent, committed),
  };
}

/**
 * Which end of the ground reads on top of `accent`.
 *
 * A button drawn on a light accent is unreadable in white, so the text colour
 * is whichever committed end sits further from the accent in luminance rather
 * than a constant chosen when the default palette was dark. Both modes carry
 * the same accent, so this is decided once and declared once.
 */
function readableOn(accent: string, ground: Ground): string {
  const fromSurface = Math.abs(
    relativeLuminance(ground.surface) - relativeLuminance(accent),
  );
  const fromInk = Math.abs(
    relativeLuminance(ground.ink) - relativeLuminance(accent),
  );
  return fromInk > fromSurface ? ground.ink : ground.surface;
}

/**
 * WCAG relative luminance of a `#rrggbb` colour: 0 for black, 1 for white.
 *
 * Only ever called on a value that has already cleared {@link hexColor}, so the
 * parse cannot be handed anything but six hexadecimal digits.
 */
function relativeLuminance(color: string): number {
  const red = channelLuminance(color, 1);
  const green = channelLuminance(color, 3);
  const blue = channelLuminance(color, 5);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** One 8-bit channel of a `#rrggbb` colour, linearised as sRGB defines it. */
function channelLuminance(color: string, offset: number): number {
  const value = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/**
 * The custom properties every rule below reads through, and the dark ground.
 *
 * This is the only place a colour is written down. Re-declaring two properties
 * is what makes dark mode three lines instead of a second stylesheet.
 */
function tokens(palette: Palette): string {
  const blocks = [
    `:host {
  --archava-accent: ${palette.accent};
  --archava-surface: ${palette.light.surface};
  --archava-ink: ${palette.light.ink};
  --archava-on-accent: ${palette.onAccent};
  color-scheme: light dark;
}`,
  ];
  // A tenant whose two ends are the same colour has one ground, and a media
  // block that re-declares it verbatim is noise.
  if (palette.light.surface !== palette.dark.surface) {
    blocks.push(`@media (prefers-color-scheme: dark) {
  :host {
    --archava-surface: ${palette.dark.surface};
    --archava-ink: ${palette.dark.ink};
  }
}`);
  }
  return blocks.join("\n");
}

function reset(palette: Palette): string {
  return `:host {
  box-sizing: border-box;
  font-family: ${palette.fontFamily};
  color: var(--archava-ink);
  background: var(--archava-surface);
  display: block;
}
* {
  box-sizing: border-box;
}
p, table, figure, blockquote, ul {
  margin: 0;
  padding: 0;
}
ul {
  list-style: none;
}
button {
  font: inherit;
  color: inherit;
  cursor: pointer;
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--archava-ink) 22%, transparent);
  border-radius: ${palette.radius};
}
button:hover {
  border-color: color-mix(in srgb, var(--archava-ink) 45%, transparent);
}
button:focus-visible {
  outline: 2px solid var(--archava-ink);
  outline-offset: 2px;
}`;
}

function log(): string {
  return `.archava-log {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  max-height: 70vh;
  overflow-y: auto;
}
.archava-message {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--archava-ink) 12%, transparent);
  border-radius: inherit;
}`;
}

function composer(radius: string): string {
  return `.archava-composer {
  display: flex;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid color-mix(in srgb, var(--archava-ink) 12%, transparent);
}
.archava-composer-input {
  flex: 1;
  font: inherit;
  color: inherit;
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--archava-ink) 18%, transparent);
  border-radius: ${radius};
  padding: 8px 10px;
}
.archava-composer-input:focus-visible {
  outline: 2px solid var(--archava-accent);
  outline-offset: 1px;
}
.archava-composer-send {
  background: var(--archava-accent);
  color: var(--archava-on-accent);
  padding: 8px 14px;
}`;
}

function banner(): string {
  // The gap colour is not the tenant's: it is the one signal in the shell that
  // the answer came from nowhere, and it has to read the same to a visitor
  // whatever palette the tenant committed.
  return `.archava-banner {
  padding: 8px 10px;
  border-left: 3px solid #b4690e;
  background: color-mix(in srgb, #b4690e 10%, transparent);
}
.archava-basis {
  align-self: flex-start;
  font-size: 12px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  opacity: 0.75;
}
.archava-text {
  line-height: 1.5;
}
.archava-sources {
  font-size: 13px;
  opacity: 0.75;
}`;
}

function truth(): string {
  return `.archava-truth {
  width: 100%;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
}
.archava-truth-row th,
.archava-truth-row td {
  text-align: left;
  padding: 4px 8px 4px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--archava-ink) 8%, transparent);
}
.archava-truth-subject {
  font-weight: 600;
}
.archava-truth-path {
  font-family: ui-monospace, monospace;
  font-size: 12px;
  opacity: 0.7;
}
.archava-truth-truncated {
  font-size: 12px;
  opacity: 0.7;
  margin-top: 4px;
}`;
}

function matrix(): string {
  return `.archava-matrix {
  width: 100%;
  border-collapse: collapse;
}
.archava-matrix th,
.archava-matrix td {
  border: 1px solid color-mix(in srgb, var(--archava-ink) 14%, transparent);
  padding: 8px;
  text-align: left;
  min-width: 56px;
}
.archava-matrix-note {
  font-size: 12px;
  opacity: 0.7;
  margin-top: 4px;
}`;
}

function picker(radius: string): string {
  return `.archava-picker {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.archava-picker-subject {
  font-weight: 600;
}
.archava-picker-slots {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.archava-slot {
  color: var(--archava-accent);
  border-color: var(--archava-accent);
  padding: 6px 10px;
  border-radius: ${radius};
}`;
}

function order(): string {
  return `.archava-order {
  display: flex;
  gap: 12px;
  align-items: baseline;
  padding: 10px;
  border: 1px solid color-mix(in srgb, var(--archava-ink) 14%, transparent);
  border-radius: 8px;
}
.archava-order-id {
  font-family: ui-monospace, monospace;
  font-size: 12px;
  opacity: 0.7;
}
.archava-order-amount {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.archava-order-stage {
  margin-left: auto;
  font-size: 12px;
  opacity: 0.7;
}`;
}

function sourceCard(): string {
  return `.archava-source-card {
  border-left: 3px solid color-mix(in srgb, var(--archava-ink) 18%, transparent);
  padding-left: 10px;
}
.archava-source-title {
  font-weight: 600;
  margin-bottom: 4px;
}
.archava-source-card blockquote {
  font-style: italic;
  line-height: 1.5;
}`;
}

function action(radius: string): string {
  return `.archava-cta {
  background: var(--archava-accent);
  color: var(--archava-on-accent);
  padding: 8px 14px;
  border-radius: ${radius};
}
.archava-confirmation {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
  padding: 10px;
  border: 1px solid color-mix(in srgb, var(--archava-accent) 35%, transparent);
  border-radius: ${radius};
}
.archava-confirmation-reason {
  font-size: 12px;
  opacity: 0.75;
}
.archava-confirmation-confirm {
  background: var(--archava-accent);
  color: var(--archava-on-accent);
  padding: 8px 14px;
}
.archava-confirmation-decline {
  padding: 8px 14px;
}
.archava-result {
  font-size: 14px;
  opacity: 0.8;
}
.archava-handoff {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
  padding: 10px;
  border: 1px solid color-mix(in srgb, var(--archava-ink) 18%, transparent);
  border-radius: ${radius};
}`;
}

function inspector(): string {
  return `.archava-inspector {
  font-size: 12px;
  opacity: 0.85;
}
.archava-inspector summary {
  cursor: pointer;
}
.archava-inspector li {
  padding: 2px 0;
}
.archava-permitted {
  margin-top: 6px;
  font-family: ui-monospace, monospace;
}`;
}
