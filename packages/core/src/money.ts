export function milliToDollars(milli: number): number {
  return Math.round(milli) / 1000
}

export function dollarsToMilli(dollars: number): number {
  return Math.round(dollars * 1000)
}

/**
 * fix/currency-symbol IMPORTANT 6: mirrors YNAB's `CurrencyFormat` (api.d.ts CurrencyFormat /
 * PlanSettings) field-for-field, so a value resolved from `GET /plans/{plan_id}/settings` can be
 * passed to formatDollars directly. Every field is optional and defaults to USD/en-US formatting —
 * `formatDollars(x, { symbol: '$' })` (the pre-existing call shape) is byte-identical to before this
 * type existed. `symbol` is kept as a top-level, always-present-in-practice field (never defaulted by
 * the resolver — see domain.ts's #resolveCurrency) rather than reusing `currency_symbol` verbatim, so
 * this type is meaningful as a *formatting* input independent of where it came from.
 */
export interface CurrencyFormatOpts {
  symbol?: string
  decimals?: number
  /** true = "$1,500.00" (prefix); false = "1 500,00 kr" (suffix, space-separated). Default true. */
  symbolFirst?: boolean
  decimalSeparator?: string
  groupSeparator?: string
  /** false = the amount renders with no symbol at all, regardless of `symbol`. Default true. */
  displaySymbol?: boolean
}

export function formatDollars(dollars: number, opts: CurrencyFormatOpts = {}): string {
  // No live path reaches NaN today (latent per the truthful-output review) — but silently emitting
  // "$NaN" would look like a plausible, quotable dollar figure to a model instead of the malformed
  // input it actually is. Fail loud instead of producing text that reads as truthful.
  if (Number.isNaN(dollars)) throw new Error('formatDollars: dollars must not be NaN')
  const { symbol = '$', decimals = 2, symbolFirst = true, decimalSeparator = '.', groupSeparator = ',', displaySymbol = true } = opts
  const abs = Math.abs(dollars)
  const fixed = abs.toFixed(decimals)
  // A sub-cent negative (e.g. -0.001) rounds to "0.00" at the display precision — showing "-$0.00"
  // would assert a negative amount that isn't there once rounded. Drop the sign once rounding has
  // erased every significant digit.
  const isZero = /^0(\.0*)?$/.test(fixed)
  const sign = dollars < 0 && !isZero ? '-' : ''
  const [int, frac] = fixed.split('.')
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, groupSeparator)
  const number = frac ? `${grouped}${decimalSeparator}${frac}` : grouped
  const sym = displaySymbol ? symbol : ''
  // symbolFirst mirrors YNAB's own convention: prefix currencies have no separating space ("$1,500.00"),
  // suffix currencies do ("1 500,00 kr") — matches every real symbol_first:false example in YNAB's docs.
  return symbolFirst ? `${sign}${sym}${number}` : `${sign}${number}${sym ? ' ' + sym : ''}`
}
