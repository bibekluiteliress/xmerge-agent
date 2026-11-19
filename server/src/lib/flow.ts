// Guided report flow: prompt templates, design parsing and the field sheet (no model calls here).
//
//   1 design   (agent)  request -> report design with {{data points}} and [[for each AREA]] sections
//   2 fields   (code)   design  -> field sheet: whole field lists of the areas used + best matches
//   3 write    (agent)  design + field sheet + language reference -> template
//   4 gate     (code)   validator
//   5 repair   (agent)  only when the gate finds blocking issues
//
// Prompts live in prompts/*.md so every run follows the same instructions; <<name>> marks a slot.
import { readFileSync } from 'node:fs'
import { APP_ROOT, type Catalog } from './catalog.js'

const PROMPTS = `${APP_ROOT}/prompts/`
const REFERENCE = `${APP_ROOT}/../../docs/markdown/xmerge/ai/dev/rag/xmerge_language_reference.md`
export const MAX_REPAIRS = 2

const BUILTINS: [string, string][] = [
  ["today's date", "<:=datetime_merge.format('%d %B %Y'):>"],
  ['client full name', '<:=$client.name:>'],
  ['partner full name', '<:=$partner.name:> (inside <:if $partner:>)'],
  ['adviser name', '<:=$user:>'],
  ['adviser email', '<:=$user.preferred_email:>'],
  ['money from a number', '<:=currency(value, has_symbol=True):>'],
  ['yes/no from a flag', '<:=to_yesno(x.field.value):>'],
]
const BUILTIN_WORDS = ['today', 'date of this report', 'report date', 'full name', 'adviser', 'advisor']

export function prompt(name: string, slots: Record<string, string> = {}): string {
  let text = readFileSync(PROMPTS + name, 'utf8')
  for (const [k, v] of Object.entries(slots)) text = text.replaceAll(`<<${k}>>`, v)
  return text
}

export const designerInstructions = (cat: Catalog) => prompt('design.md', { areas: cat.areas().join(', ') })

/** Writer rules + the language reference; identical every run, so the model can cache it. */
export const writerInstructions = () =>
  `${prompt('write_system.md')}\n<language_reference>\n${readFileSync(REFERENCE, 'utf8')}\n</language_reference>`

export function extractDesign(reply: string): string {
  return (/<design>\s*([\s\S]*?)\s*<\/design>/.exec(reply)?.[1] ?? reply).trim()
}

export function extractTemplate(reply: string): string | null {
  const all = [...reply.matchAll(/```xmerge\s*\n([\s\S]*?)```/g)]
  return all.length ? all[all.length - 1][1].replace(/\n+$/, '') : null
}

export const stripTemplate = (reply: string) => reply.replace(/```xmerge\s*\n[\s\S]*?```/g, '').trim()

/** True when the text already uses the design notation, so step 1 can be skipped. */
export const looksLikeDesign = (text: string) => /\{\{.+?\}\}|\[\[\s*for each/i.test(text)

export interface DataPoint {
  text: string
  scope: string // "client" | "partner" | list area
  line: number
  kind: 'value' | 'condition' | 'total'
}

export function parseDesign(cat: Catalog, design: string) {
  const known = cat.areas()
  const points: DataPoint[] = []
  const areas: string[] = []
  const warnings: string[] = []
  const stack: ['for' | 'if', string | null][] = []
  const scope = (s: typeof stack) => {
    for (let i = s.length - 1; i >= 0; i--) {
      const [kind, val] = s[i]
      if (kind === 'for' && val) return val
      if (kind === 'if' && val === 'partner') return 'partner'
    }
    return 'client'
  }
  const addArea = (a: string) => !areas.includes(a) && areas.push(a)

  design.split('\n').forEach((line, i) => {
    const n = i + 1
    for (const m of line.matchAll(/\[\[\s*for each\s+([A-Za-z0-9_]+)\s*(?::\s*(.*?))?\]\]/gi)) {
      let area: string | null = m[1].toLowerCase()
      if (!known.includes(area)) {
        const close = closest(area, known)
        warnings.push(`line ${n}: list area '${area}' does not exist${close ? `; using '${close}'` : ''}`)
        area = close
      }
      stack.push(['for', area])
      if (area) addArea(area)
    }
    for (const m of line.matchAll(/\[\[\s*if\s+(.*?)\]\]/gi)) {
      const cond = m[1].trim()
      const isPartner = cond.toLowerCase() === 'partner'
      if (!isPartner) points.push({ text: cond, scope: scope(stack), line: n, kind: 'condition' })
      stack.push(['if', isPartner ? 'partner' : null])
    }
    for (const m of line.matchAll(/\{\{(.*?)\}\}/g)) {
      let text = m[1].trim()
      let sc = scope(stack)
      if (text.toLowerCase().startsWith('partner:')) [text, sc] = [text.slice(8).trim(), 'partner']
      const tm = /^total of (.+?) over ([A-Za-z0-9_]+)$/i.exec(text)
      if (tm && known.includes(tm[2].toLowerCase())) {
        points.push({ text: tm[1], scope: tm[2].toLowerCase(), line: n, kind: 'total' })
        addArea(tm[2].toLowerCase())
        continue
      }
      points.push({ text, scope: sc, line: n, kind: 'value' })
    }
    for (const _ of line.matchAll(/\[\[\s*end\s*\]\]/gi)) {
      if (stack.length) stack.pop()
      else warnings.push(`line ${n}: [[end]] without an open [[for each]] or [[if]]`)
    }
  })
  if (stack.length) warnings.push(`${stack.length} [[for each]]/[[if]] block(s) are never closed with [[end]]`)
  return { points, areas, warnings }
}

function row(cat: Catalog, group: string, name: string) {
  const def = cat.field(group, name)!
  let r = `${name} | ${def[1]} | ${def[0]} | ${cat.policyOf(name, def)}`
  const opts = cat.choices.get(`${group}.${name}`)
  if (opts && opts.length <= 12) r += ' | codes: ' + opts.map(([c, t]) => `${c}=${t}`).join('; ') // compare codes, print labels
  return r
}

/** The field sheet the writer gets instead of a search tool. */
export function buildSheet(cat: Catalog, parsed: ReturnType<typeof parseDesign>) {
  const out = ['## Built-ins (use as shown)', ...BUILTINS.map(([k, v]) => `- ${k}: ${v}`), '', '## Best matches per data point (name | label | type | policy)']
  const unmatched: string[] = []
  for (const p of parsed.points) {
    const person = p.scope === 'client' || p.scope === 'partner'
    if (person && BUILTIN_WORDS.some((w) => p.text.toLowerCase().includes(w))) continue
    const group = person ? 'entity' : `entity_${p.scope}`
    const hits = cat.search(p.text, person ? 'entity' : p.scope, 6)
    const where = p.scope === 'client' ? '$client.FIELD' : p.scope === 'partner' ? '$partner.FIELD' : `item of $client.${p.scope}`
    const label = p.kind === 'total' ? 'total of ' : p.kind === 'condition' ? 'show only if ' : ''
    out.push(`- {{${label}${p.text}}} (design line ${p.line}, ${where}):`)
    if (!hits.length) {
      unmatched.push(p.text)
      out.push('    no close match; check the full list below, or mark it [not held in XPLAN: ...]')
    }
    for (const h of hits) if (cat.field(group, h.name)) out.push('    ' + row(cat, group, h.name))
  }
  for (const area of parsed.areas) {
    const group = `entity_${area}`
    const names = Object.entries(cat.groups[group] ?? {})
      .filter(([name, def]) => cat.policyOf(name, def) !== 'block')
      .map(([name]) => name)
      .sort((a, b) => a.localeCompare(b))
    out.push('', `## All fields of list area ${area} (<:for x in $client.${area}:> ... x.FIELD ... <:end:>), ${names.length} fields`, 'name | label | type | policy')
    for (const name of names) out.push(row(cat, group, name))
  }
  return { sheet: out.join('\n'), unmatched }
}

export function writeRequest(cat: Catalog, design: string) {
  const parsed = parseDesign(cat, design)
  const { sheet, unmatched } = buildSheet(cat, parsed)
  return { user: prompt('write_user.md', { design, sheet }), parsed, unmatched, sheetChars: sheet.length }
}

/** A follow-up chat message on an existing template: the lists it uses plus matches for the request. */
export function reviseRequest(cat: Catalog, template: string, instruction: string) {
  const known = cat.areas()
  const areas = [...new Set([...template.matchAll(/<:for\s+\w+\s+in\s+\$\w+\.(\w+)/g)].map((m) => m[1]))].filter((a) => known.includes(a))
  const words = instruction.toLowerCase()
  for (const a of known) if (!areas.includes(a) && new RegExp(`\\b${a.replaceAll('_', '[ _]')}\\b`).test(words)) areas.push(a)
  const parsed = { points: [{ text: instruction, scope: 'client', line: 0, kind: 'value' as const }], areas, warnings: [] }
  const { sheet } = buildSheet(cat, parsed)
  return { user: prompt('revise.md', { template, instruction, sheet }), areas }
}

export const repairPrompt =(problems: string[]) => prompt('repair.md', { problems: problems.map((p) => `- ${p}`).join('\n') })

export const notHeld = (template: string) => [...new Set([...template.matchAll(/\[not held in XPLAN: ([^\]]+)\]/g)].map((m) => m[1]))]

function closest(word: string, options: string[]): string | null {
  // Like difflib.get_close_matches(n=1, cutoff=0.6): best ratio of matching characters.
  let best: string | null = null
  let score = 0.6
  for (const o of options) {
    const r = ratio(word, o)
    if (r >= score) [best, score] = [o, r]
  }
  return best
}

function ratio(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
  return (2 * dp[a.length][b.length]) / (a.length + b.length)
}
