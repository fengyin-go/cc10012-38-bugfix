import { MODULE_BY_KEY, isAbnormalStatus, isPendingStatus } from './modules'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'data-explore-studio:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 迁移：旧版本可能留下与状态机对不上的 pending/abnormal 标记（残留），
// 读取时按合法状态机校正并写回，保证运行状态记录数据集只有一份、口径稳定。
function normalizeRows(key: string, rows: EntryRow[]): EntryRow[] {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    return rows
  }
  return rows.map((row) => {
    const status = String(row.status)
    if (!meta.statuses.includes(status)) {
      return row
    }
    const pending = isPendingStatus(meta, status)
    const abnormal = Boolean(row.abnormal) || isAbnormalStatus(meta, status)
    if (row.pending === pending && Boolean(row.abnormal) === abnormal) {
      return row
    }
    return { ...row, pending, abnormal }
  })
}

function normalizeAll(data: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const next: Record<string, EntryRow[]> = {}
  for (const [key, rows] of Object.entries(data)) {
    next[key] = normalizeRows(key, rows)
  }
  return next
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  let merged: Record<string, EntryRow[]>
  if (typeof window === 'undefined' || !window.localStorage) {
    merged = fallback
  } else {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      merged = fallback
    } else {
      try {
        merged = { ...fallback, ...(JSON.parse(raw) as Record<string, EntryRow[]>) }
      } catch {
        merged = fallback
      }
    }
  }
  const normalized = normalizeAll(merged)
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
  }
  return normalized
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
