import {
  MODULE_BY_KEY,
  actionSource,
  isAbnormalStatus,
  isPendingStatus,
  terminalStatuses,
} from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'
import { useSessionStore } from '@/stores/session'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚', '终止', '断开', '废弃', '失效']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

function receiptTime(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

function currentOperator(): string {
  try {
    return useSessionStore().operator || '值班管理员'
  } catch {
    return '值班管理员'
  }
}

function traceText(row: EntryRow, field: string): string {
  const value = row[field]
  if (typeof value !== 'string' || value.trim() === '' || value === '—') {
    return ''
  }
  return value
}

// 状态链只追加、不分叉：每一次生效的推进都把目标态、动作、回执时间与触发者补进同一条链。
function appendChain(row: EntryRow, target: string, action: string, time: string, operator: string): string {
  const base = traceText(row, '状态链') || String(row.status)
  return `${base}→${target}（${action}@${time}·${operator}）`
}

// 终态之后到达的旧动作/旧回执：只补终态证据，不再改变状态；
// 同一回执重复到达只留一份，不产生并行状态链。
function appendLateReceipt(row: EntryRow, action: string, time: string, operator: string): EntryRow {
  const existing = traceText(row, '迟到回执')
  if (existing.includes(`${action}@`)) {
    return row
  }
  const note = `${action}@${time}·${operator}·未生效`
  return { ...row, 迟到回执: existing ? `${existing}；${note}` : note }
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/** 当前状态下允许执行的动作：页面据此禁用点不动的按钮，与服务层校验同一份口径。 */
export function legalActions(key: string, status: string): string[] {
  const meta = moduleMeta(key)
  if (terminalStatuses(meta).includes(status)) {
    return []
  }
  return meta.actions.filter((action) => actionSource(meta, action) === status)
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const row = rows[index]
  const current = String(row.status)
  // 幂等：重复提交同一目标态只保留一份运行状态记录，不再写入。
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，重复提交不再写入` }
  }
  // 终态：迟到回执（含人工终止后到达的成功回执）只留证据，状态与异常统计不再变化。
  if (terminalStatuses(meta).includes(current)) {
    const stamped = appendLateReceipt(row, action, receiptTime(), currentOperator())
    if (stamped !== row) {
      const next = [...rows]
      next[index] = stamped
      saveRows(key, next)
    }
    return { ok: false, message: `${meta.entity}已处于终态「${current}」，「${action}」按迟到回执留痕，状态不再变化` }
  }
  // 合法状态机：动作只能从登记的来源态推进，草稿不能跳到完成或失败，运行中也不能回退。
  const source = actionSource(meta, action)
  if (source !== current) {
    return { ok: false, message: `${meta.entity}当前状态「${current}」不能执行「${action}」，该动作只能从「${source}」发起` }
  }
  const time = receiptTime()
  const operator = currentOperator()
  const updated: EntryRow = {
    ...row,
    status: target,
    pending: isPendingStatus(meta, target),
    abnormal:
      Boolean(row.abnormal) ||
      isAbnormalStatus(meta, target) ||
      NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
    状态链: appendChain(row, target, action, time, operator),
    回执时间: time,
    触发者: operator,
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/** 模块统计卡：与列表读同一份运行状态记录数据集，指标名含状态名就数该状态，含「总数」就数总量。 */
export function moduleStats(key: string): { label: string; value: number }[] {
  const meta = moduleMeta(key)
  const rows = listRows(key)
  return meta.metrics.map((label) => {
    const status = meta.statuses.find((item) => label.includes(item))
    const value = status
      ? rows.filter((row) => String(row.status) === status).length
      : rows.length
    return { label, value }
  })
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      // 待处理与异常量直接按状态口径重算，与业务列表读同一条状态链，不再各算各的。
      pending: entries.filter((row) => isPendingStatus(meta, String(row.status))).length,
      abnormal: entries.filter(
        (row) => Boolean(row.abnormal) || isAbnormalStatus(meta, String(row.status)),
      ).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
