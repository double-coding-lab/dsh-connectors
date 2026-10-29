export function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] => (value
    .replace(/^v/i, '')
    .split(/[-+]/)[0]
    ?.split('.') ?? [])
    .map(part => Number.parseInt(part, 10) || 0)
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}
