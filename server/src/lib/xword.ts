// A site's XWord field list -> catalog groups.
//
// XWord is XPLAN's Word plugin for template authors. Its field list comes from
// GET /resourceful/xmerge/xword (src/py/xpt/resourceful/api/xmerge/xword.py, built by
// xpt.xword.util.getEntityData), or from a downloaded XWord file: XML <xword-data-xml> whose
// <base-path> holds the same nested lists as <list>/<value value="..."> elements. Either way
// "fields" is [client_fields, adviser_fields], and each entry is
//   [area, "List", group_title, [field, ...]]               a list area (entity_<area>)
//   [name, category, label, [[code, text], ...], type]       a field
// XWord sends no sensitivity flags: stock flags are kept where the stock catalog knows the field,
// and fields only this site has get "sitecustom" (policy: review).
import { XMLParser } from 'fast-xml-parser'
import type { FieldDef, Groups } from './catalog.js'

type Nested = string | Nested[]

const TYPES: Record<string, string> = {
  string: 'string', numeric: 'float', date: 'date', time: 'time', currency: 'currency',
  choice: 'choice', boolean: 'bool', multi: 'multi', multicurrency: 'multicurrency', incomparable: 'attachment',
}

/** The "fields" value from either an xmerge/xword JSON response or a downloaded XWord XML file. */
export function xwordFields(content: string): Nested[] {
  const text = content.trim()
  if (text.startsWith('{')) {
    const fields = JSON.parse(text).fields
    if (!Array.isArray(fields)) throw new Error('This JSON has no "fields" list; expected the xmerge/xword response.')
    return fields
  }
  if (!text.includes('<xword-data-xml')) throw new Error('Not an XWord file: expected JSON from xmerge/xword or an <xword-data-xml> file.')
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', preserveOrder: true }).parse(text)
  const root = find(doc, 'xword-data-xml')
  const base = root && find(root, 'base-path')
  const list = base && find(base, 'list')
  if (!list) throw new Error('The XWord file has no <base-path> list.')
  const data = toNested(list) as Nested[] // [fields, uda, portfolio_reports, ...]
  return data[0] as Nested[]
}

type XNode = Record<string, unknown> & { ':@'?: Record<string, string> }

function find(nodes: unknown, name: string): XNode[] | undefined {
  for (const n of nodes as XNode[]) if (name in n) return n[name] as XNode[]
  return undefined
}

function toNested(children: XNode[]): Nested {
  const out: Nested[] = []
  for (const n of children) {
    if ('list' in n) out.push(toNested(n.list as XNode[]))
    else if ('value' in n) out.push(n[':@']?.value ?? '')
  }
  return out
}

export function fromXword(fields: Nested[], stock: Groups) {
  const [client = [], adviser = []] = fields as Nested[][]
  const choices = new Map<string, [string, string][]>()
  const field = (e: Nested[], group: string): [string, FieldDef] => {
    const [name, category, label, opts, xtype] = e as [string, string, string, Nested[], string]
    const known = stock[group]?.[name]
    if (Array.isArray(opts) && opts.length) choices.set(`${group}.${name}`, (opts as string[][]).map(([c, t]) => [String(c), String(t)]))
    const cat = String(category ?? '').trim()
    const title = String(label ?? '').trim() // XPLAN splits "Category | Title" and keeps the spaces
    return [name, [TYPES[xtype] ?? (xtype || '?'), cat ? `${cat}: ${title}` : title, known ? known[2] : 'sitecustom']]
  }
  const build = (entries: Nested[]) => {
    const groups: Groups = { entity: {} }
    for (const e of entries as Nested[][]) {
      if (e.length === 4 && e[1] === 'List' && Array.isArray(e[3])) {
        const group = `entity_${e[0]}`
        groups[group] ??= {}
        for (const sub of e[3] as Nested[][]) if (sub.length >= 5) { const [n, d] = field(sub, group); groups[group][n] = d }
      } else if (e.length >= 5) {
        const [n, d] = field(e, 'entity')
        groups.entity[n] = d
      }
    }
    return groups
  }
  const groups = build(client)
  const all = Object.values(groups).flatMap((g) => Object.values(g))
  return {
    groups,
    adviser: build(adviser),
    choices,
    stats: { fields: all.length, areas: Object.keys(groups).length - 1, siteOnly: all.filter((d) => d[2] === 'sitecustom').length },
  }
}
