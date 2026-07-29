export function milliToDollars(milli: number): number {
  return Math.round(milli) / 1000
}

export function dollarsToMilli(dollars: number): number {
  return Math.round(dollars * 1000)
}

export function formatDollars(dollars: number, opts: { symbol?: string; decimals?: number } = {}): string {
  const { symbol = '$', decimals = 2 } = opts
  const sign = dollars < 0 ? '-' : ''
  const abs = Math.abs(dollars)
  const fixed = abs.toFixed(decimals)
  const [int, frac] = fixed.split('.')
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}${symbol}${grouped}${frac ? '.' + frac : ''}`
}
