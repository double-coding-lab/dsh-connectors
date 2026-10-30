import { useEffect, useState } from 'react'

import { EN as en } from './en.js'

export interface LocaleSnapshot {
  active: string
  revision: number
}

export interface LocaleFace {
  getSnapshot: () => LocaleSnapshot
  subscribe: (listener: () => void) => () => void
}

let localeFace: LocaleFace | undefined

export function bindLocale(face: LocaleFace | undefined): void {
  localeFace = face
}

export function currentLocale(): string {
  return localeFace?.getSnapshot().active ?? 'zh'
}

export function useLocaleRevision(): number {
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (localeFace === undefined) return
    return localeFace.subscribe(() => setRevision(value => value + 1))
  }, [])
  return revision
}

export function tr(key: string, params?: Record<string, string | number>): string {
  const template = currentLocale().toLowerCase().startsWith('en') ? en[key] ?? key : key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name]
    return value === undefined ? whole : String(value)
  })
}

const PROGRESS_EN: Record<string, string> = {
  'Install': 'Installing',
  '安装': 'Installing',
  'Configure': 'Configuring',
  '配置': 'Configuring',
  '配置应用': 'Configuring app',
  'Authorize': 'Authorizing',
  '授权': 'Authorizing',
  'Sign in': 'Signing in',
  '登录': 'Signing in',
  'Update': 'Updating',
  '更新': 'Updating',
  'Uninstall': 'Uninstalling',
  '卸载': 'Uninstalling',
  'Connect': 'Connecting',
  '连接': 'Connecting',
}

export function progressText(label: string): string {
  const english = currentLocale().toLowerCase().startsWith('en')
  const translated = english ? tr(label) : label
  if (translated.endsWith('…')) return translated
  if (!english) return translated.endsWith('中') ? translated : `${translated}中…`
  return `${PROGRESS_EN[translated] ?? translated}…`
}
