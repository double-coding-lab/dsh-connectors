export const BUILTIN_CATEGORIES = ['开发工具', '项目管理', '数据库', '知识检索', '办公协作', '安全运维', '数据分析', '其他'] as const

export const MAX_CATEGORY_LENGTH = 16
export const MAX_EXAMPLES = 6
const RESERVED_CATEGORIES = ['全部', '自定义']
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/

export function cleanCategory(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

export function categoryKey(value: string): string {
  return cleanCategory(value).toLocaleLowerCase()
}

export function canonicalBuiltinCategory(value: string): string | undefined {
  const key = categoryKey(value)
  return BUILTIN_CATEGORIES.find(category => categoryKey(category) === key)
}

export function validateCategory(value: string): string | undefined {
  const cleaned = cleanCategory(value)
  if (cleaned === '') return '类别不能为空'
  if (Array.from(cleaned).length > MAX_CATEGORY_LENGTH) return `类别最多 ${MAX_CATEGORY_LENGTH} 个字`
  if (CONTROL_CHARS.test(cleaned)) return '类别不能包含控制字符'
  if (RESERVED_CATEGORIES.some(item => categoryKey(item) === categoryKey(cleaned))) {
    return `「${cleaned}」是保留名称，请换一个类别`
  }
  return undefined
}

export function resolveCategory(value: string | undefined, fallback = '其他'): string {
  const cleaned = cleanCategory(value ?? '')
  if (cleaned === '') return fallback
  return canonicalBuiltinCategory(cleaned) ?? cleaned
}

export function parseExampleLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '')
    .slice(0, MAX_EXAMPLES)
}

export function canonicalizeCardCategories<T extends { category: string }>(cards: T[]): T[] {
  const builtinKeys = new Map(BUILTIN_CATEGORIES.map(category => [categoryKey(category), category]))
  const labels = new Map<string, string>()
  for (const card of cards) {
    const cleaned = cleanCategory(card.category) || '其他'
    const key = categoryKey(cleaned)
    if (!labels.has(key)) labels.set(key, builtinKeys.get(key) ?? cleaned)
  }
  return cards.map(card => {
    const cleaned = cleanCategory(card.category) || '其他'
    return {
      ...card,
      category: labels.get(categoryKey(cleaned)) ?? cleaned,
    }
  })
}
