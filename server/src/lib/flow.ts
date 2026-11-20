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
import { cachedSystem } from './bedrock.js'
import { APP_ROOT, type Catalog } from './catalog.js'

const PROMPTS = `${APP_ROOT}/prompts/`
const REFERENCE = `${PROMPTS}xmerge_language_reference.md` // copied from the XMerge AI docs (ai/dev/rag/)
export const MAX_REPAIRS = 2
const MAX_HISTORY = 8 // earlier requests of the current report sent with a new one

const BUILTINS: [string, string][] = [
  ["today's date", "<:=datetime_merge.format('%d %B %Y'):>"],
  ['client full name', '<:=$client.name:>'],
  ['partner full name', '<:=$partner.name:> (inside <:if $partner:>)'],
  ['adviser name', '<:=$user:>'],
  ['adviser email', '<:=$user.preferred_email:>'],
  ['client preferred address', "<:let addr = $client.preferred_address:> once, then <:=addr.street:>, <:=addr.suburb:> <:=addr.state:> <:=addr.postcode:>"],
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

/** Writer rules + the language reference; identical every run, so Bedrock caches it. */
export const writerInstructions = () =>
  cachedSystem(`${prompt('write_system.md')}\n<language_reference>\n${readFileSync(REFERENCE, 'utf8')}\n</language_reference>`)

/** The adviser's earlier requests for the current report, so "both" or "that section" can be resolved. */
export function historySection(history: string[] = []): string {
  const earlier = history.map((h) => h.trim()).filter(Boolean).slice(-MAX_HISTORY)
  if (!earlier.length) return ''
  return ['Earlier requests for this same report, oldest first (context only; the latest request below is what to do now):',
    ...earlier.map((h) => `- ${h.slice(0, 1000).replaceAll('\n', ' ')}`), '', ''].join('\n')
}

/** The designer's message: earlier requests (if any) + the request. */
export const designRequest = (request: string, history: string[] = []) =>
  prompt('design_user.md', { history: historySection(history), request })

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
export function buildSheet(cat: Catalog, parsed: ReturnType<typeof parseDesign>, used: string[] = []) {
  const out = ['## Built-ins (use as shown)', ...BUILTINS.map(([k, v]) => `- ${k}: ${v}`), '', '## Best matches per data point (name | label | type | policy)']
  const unmatched: string[] = []
  const blocked: string[] = [] // sensitive fields a data point asked for
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
    for (const h of hits) {
      if (!cat.field(group, h.name)) continue
      if (h.policy === 'block') {
        // Held in XPLAN, but never allowed: say so, so the writer does not call it "not held".
        if (!blocked.includes(h.name)) blocked.push(h.name)
        out.push(`    ${h.name} | ${h.def[1]} | NOT ALLOWED: a sensitive field; write [not allowed: ${h.def[1] || h.name}] instead`)
      } else out.push('    ' + row(cat, group, h.name))
    }
  }
  const keep = used.filter((name) => cat.field('entity', name) && cat.policyOf(name, cat.field('entity', name)!) !== 'block')
  if (keep.length) out.push('', '## Fields the current template already uses ($client.FIELD / $partner.FIELD)', ...keep.map((name) => row(cat, 'entity', name)))
  for (const area of parsed.areas) {
    const group = `entity_${area}`
    const names = Object.entries(cat.groups[group] ?? {})
      .filter(([name, def]) => cat.policyOf(name, def) !== 'block')
      .map(([name]) => name)
      .sort((a, b) => a.localeCompare(b))
    out.push('', `## All fields of list area ${area} (<:for x in $client.${area}:> ... x.FIELD ... <:end:>), ${names.length} fields`, 'name | label | type | policy')
    for (const name of names) out.push(row(cat, group, name))
  }
  return { sheet: out.join('\n'), unmatched, blocked }
}

/** `samples` is the knowledge-base section (samplesSection), or '' when there are none. */
export function writeRequest(cat: Catalog, design: string, samples = '') {
  const parsed = parseDesign(cat, design)
  const { sheet, unmatched, blocked } = buildSheet(cat, parsed)
  return { user: prompt('write_user.md', { design, sheet, samples }), parsed, unmatched, blocked, sheetChars: sheet.length }
}

/**
 * A follow-up chat message on an existing template: the fields and lists it already uses, matches for the
 * request and the earlier requests of this report.
 */
export function reviseRequest(cat: Catalog, template: string, instruction: string, history: string[] = [], problems: string[] = []) {
  const known = cat.areas()
  const areas = [...new Set([...template.matchAll(/<:for\s+\w+\s+in\s+\$\w+\.(\w+)/g)].map((m) => m[1]))].filter((a) => known.includes(a))
  const words = instruction.toLowerCase()
  for (const a of known) if (!areas.includes(a) && new RegExp(`\\b${a.replaceAll('_', '[ _]')}\\b`).test(words)) areas.push(a)
  const used = [...new Set([...template.matchAll(/\$(?:client|partner)\.(\w+)/g)].map((m) => m[1]))].filter((f) => !areas.includes(f))
  const parsed = { points: [{ text: instruction, scope: 'client', line: 0, kind: 'value' as const }], areas, warnings: [] }
  const { sheet } = buildSheet(cat, parsed, used)
  return { user: prompt('revise.md', { template, instruction, sheet, history: historySection(history), problems: problemsSection(problems) }), areas }
}

/** What the check found in the template before a revise, so the writer fixes it along with the change. */
export function problemsSection(problems: string[]): string {
  if (!problems.length) return ''
  return ['The check found these problems in the current template. Fix every one as part of this change:',
    ...problems.map((p) => `- ${p}`), '', ''].join('\n')
}

export const FIX_INSTRUCTION = 'Fix this template so it passes the check. Keep its layout and wording.'
const ASKS_FIX = /\b(fix|correct|repair|broken|errors?|problems?|wrong|check|clean up|tidy)\b/i

/**
 * A template pasted into a new report's message: a ``` block holding markers (the text around it is the
 * adviser's instruction), or, without one, a message with at least three markers. Then a first paragraph
 * that asks for a fix ("fix", "correct", "broken"...) is the instruction and the rest is the template, so
 * a template's own heading stays in it. A message that is only a description gives null.
 */
export function splitPasted(request: string): { template: string; instruction: string } | null {
  const fence = /```[^\n]*\n([\s\S]*?)```/.exec(request)
  if (fence && fence[1].includes('<:')) {
    const instruction = [request.slice(0, fence.index), request.slice(fence.index + fence[0].length)].map((t) => t.trim()).filter(Boolean).join('\n\n')
    return { template: fence[1].replace(/\n+$/, ''), instruction: instruction || FIX_INSTRUCTION }
  }
  if ((request.match(/<:.*?:>/g) ?? []).length < 3) return null
  const text = request.replaceAll('\r\n', '\n').trim()
  const cut = text.search(/\n\s*\n/)
  const first = cut < 0 ? '' : text.slice(0, cut)
  if (first && !first.includes('<:') && ASKS_FIX.test(first)) return { template: text.slice(cut).trim(), instruction: first.trim() }
  return { template: text, instruction: FIX_INSTRUCTION }
}

export const repairPrompt = (problems: string[]) => prompt('repair.md', { problems: problems.map((p) => `- ${p}`).join('\n') })

export const notHeld = (template: string) => [...new Set([...template.matchAll(/\[not held in XPLAN: ([^\]]+)\]/g)].map((m) => m[1]))]
export const notAllowed = (template: string) => [...new Set([...template.matchAll(/\[not allowed: ([^\]]+)\]/g)].map((m) => m[1]))]

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
