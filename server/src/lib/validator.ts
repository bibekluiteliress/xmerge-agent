// Deterministic validator: marker rules, symbols, real field names and the sensitive-field policy.
import type { Catalog, Policy } from './catalog.js'

export interface Issue {
  severity: 'block' | 'review'
  line: number | null
  message: string
}

export interface FieldUse {
  root: string
  group: string
  field: string
  label: string
  type: string
  policy: Policy
}

export interface CheckResult {
  ok: boolean
  issues: Issue[]
  fields: FieldUse[]
  markers: number
  lines: number
}

// Markers the AI flow may emit. The engine dispatches any word after "<:" to handleCode_<word>.
const ALLOWED_TAGS = new Set(['if', 'else', 'end', 'for', 'let'])
const FORBIDDEN = ['__', 'format_map', 'htmlit', 'valueOf', 'globals', 'vars(', 'getattr', 'eval', 'exec', 'open(', 'import']
const COMPUTED = new Set(['name', 'preferred_address', 'client_adviser', 'partner'])
const ROOTS = new Set(['client', 'partner', 'user'])
const MARKER = /<:(.*?):>/g

/** Rules that must hold whatever the fields (ported from demo/staging_render.check_template). */
export function markerProblems(lines: string[]): Issue[] {
  const out: Issue[] = []
  let depth = 0
  lines.forEach((line, i) => {
    const n = i + 1
    for (const m of line.matchAll(MARKER)) {
      const body = m[1].trim()
      if (body.startsWith('==')) {
        out.push({ severity: 'block', line: n, message: 'merge marker <:== is not allowed' })
        continue
      }
      let expr: string
      if (body.startsWith('=')) {
        expr = body.slice(1)
      } else {
        const word = (/^(\w+)/.exec(body)?.[1] ?? '').toLowerCase()
        if (!ALLOWED_TAGS.has(word)) {
          out.push({ severity: 'block', line: n, message: `marker <:${word || body.slice(0, 10)} ...:> is not allowed` })
          continue
        }
        if (word === 'if' || word === 'for') depth++
        else if (word === 'end' && --depth < 0) {
          out.push({ severity: 'block', line: n, message: '<:end:> without a matching if/for' })
          depth = 0
        }
        expr = body.slice(word.length)
      }
      for (const bad of FORBIDDEN) {
        if (expr.includes(bad)) out.push({ severity: 'block', line: n, message: `'${bad}' is forbidden in expressions` })
      }
    }
    if (line.includes('<:') !== line.includes(':>')) out.push({ severity: 'block', line: n, message: 'unbalanced <: or :>' })
  })
  if (depth) out.push({ severity: 'block', line: null, message: `${depth} if/for block(s) never closed with <:end:>` })
  return out
}

export function check(text: string, cat: Catalog): CheckResult {
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  const issues = markerProblems(lines)
  const fields: FieldUse[] = []
  const seen = new Set<string>()
  const loopVars = new Map<string, string>()

  const use = (n: number, root: string, group: string, name: string, how: string) => {
    const def = cat.field(group, name)
    if (!def) {
      issues.push({ severity: 'block', line: n, message: `${how}: field '${name}' does not exist in ${group}` })
      return
    }
    const policy = cat.policyOf(name, def)
    if (policy === 'block') issues.push({ severity: 'block', line: n, message: `${how}: '${name}' is a sensitive field (${def[2] || def[0]}) and is not allowed` })
    else if (policy === 'review') issues.push({ severity: 'review', line: n, message: `${how}: '${name}' is flagged ${def[2]}, so a person must approve it` })
    const key = `${root}|${group}|${name}`
    if (!seen.has(key)) {
      seen.add(key)
      fields.push({ root, group, field: name, label: def[1], type: def[0], policy })
    }
  }

  lines.forEach((line, i) => {
    const n = i + 1
    for (const m of line.matchAll(MARKER)) {
      const body = m[1].trim()
      const fm = /for\s+(\w+)\s+in\s+\$(\w+)\.(\w+)/.exec(body)
      if (fm && cat.groups[`entity_${fm[3]}`]) loopVars.set(fm[1], `entity_${fm[3]}`)
      const lm = /let\s+(\w+)\s*=\s*\$\w+\.preferred_address\b/.exec(body)
      if (lm) loopVars.set(lm[1], 'entity_address')
      for (const rm of body.matchAll(/\$(\w+)(?:\.(\w+))?(?:\.(\w+)\(\s*'([^']*)')?/g)) {
        const [, root, attr, meth, arg] = rm
        if (!ROOTS.has(root)) {
          issues.push({ severity: 'block', line: n, message: `symbol $${root} is not available to AI templates` })
          continue
        }
        if (!attr || COMPUTED.has(attr)) continue
        if (cat.groups.entity[attr]) use(n, root, 'entity', attr, `$${root}.${attr}`)
        else if (cat.groups[`entity_${attr}`]) {
          if (meth === 'sum' && arg) use(n, root, `entity_${attr}`, arg, `$${root}.${attr}.sum`)
          else if ((meth === 'filter' || meth === 'sort') && arg) {
            for (const part of arg.split(',')) {
              const f = /^\s*-?(\w+)/.exec(part)
              if (f) use(n, root, `entity_${attr}`, f[1], `${meth} on ${attr}`)
            }
          }
        } else issues.push({ severity: 'block', line: n, message: `$${root}.${attr}: unknown field or list` })
      }
      for (const [v, group] of loopVars) {
        const re = new RegExp(`(?<![\\w$.])${v}\\.(\\w+)(?!\\s*\\()`, 'g')
        for (const vm of body.matchAll(re)) use(n, 'item', group, vm[1], `${v}.${vm[1]}`)
      }
    }
  })
  const order = { block: 0, review: 1 }
  issues.sort((a, b) => order[a.severity] - order[b.severity] || (a.line ?? 0) - (b.line ?? 0))
  return {
    ok: !issues.some((x) => x.severity === 'block'),
    issues,
    fields,
    markers: lines.reduce((s, l) => s + [...l.matchAll(MARKER)].length, 0),
    lines: lines.length,
  }
}
