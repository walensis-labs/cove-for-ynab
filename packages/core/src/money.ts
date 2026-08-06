export function milliToDollars(milli: number): number {
  return Math.round(milli) / 1000
}

export function dollarsToMilli(dollars: number): number {
  return Math.round(dollars * 1000)
}

export function formatDollars(dollars: number, opts: { symbol?: string; decimals?: number } = {}): string {
  // No live path reaches NaN today (latent per the truthful-output review) — but silently emitting
  // "$NaN" would look like a plausible, quotable dollar figure to a model instead of the malformed
  // input it actually is. Fail loud instead of producing text that reads as truthful.
  if (Number.isNaN(dollars)) throw new Error('formatDollars: dollars must not be NaN')
  const { symbol = '$', decimals = 2 } = opts
  const abs = Math.abs(dollars)
  const fixed = abs.toFixed(decimals)
  // A sub-cent negative (e.g. -0.001) rounds to "0.00" at the display precision — showing "-$0.00"
  // would assert a negative amount that isn't there once rounded. Drop the sign once rounding has
  // erased every significant digit.
  const isZero = /^0(\.0*)?$/.test(fixed)
  const sign = dollars < 0 && !isZero ? '-' : ''
  const [int, frac] = fixed.split('.')
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}${symbol}${grouped}${frac ? '.' + frac : ''}`
}
