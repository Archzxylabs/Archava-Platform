const CURRENCY_ROUNDING = {
  GLOBAL: 50,
  ID: 100_000,
} as const

/**
 * Round to the regional currency increment. Rounding happens EXACTLY ONCE,
 * on the final one-time total (agent.md §12 Step E) — never on line items.
 *
 * Positive currency amounts only. `Math.round` implements round-half-up,
 * which is the behaviour the reference quotes rely on (e.g. GLOBAL $8,825 →
 * nearest $50 → $8,850).
 */
export function roundCurrency(region: 'GLOBAL' | 'ID', amount: number): number {
  const increment = CURRENCY_ROUNDING[region]
  if (!Number.isFinite(amount)) return amount
  return Math.round(amount / increment) * increment
}
