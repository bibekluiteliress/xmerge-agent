// Field catalog: the stock XPLAN catalog, or a site's own fields loaded from XWord.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export type FieldDef = [type: string, label: string, flags: string]
export type Groups = Record<string, Record<string, FieldDef>>
export type Policy = 'ok' | 'review' | 'block'

export interface CatalogSource {
  kind: 'stock' | 'site'
  label: string
  fields?: number
  areas?: number
  siteOnly?: number
}

interface PolicyRules {
  block_types: string[]
  block_flags: string[]
  review_flags: string[]
  block_names: string[]
}

interface StockFile {
  catalog: Groups
  policy: PolicyRules
}

// The built server runs from server/.mastra/output, so files are found from the app root (run.sh sets XMS_ROOT).
export const APP_ROOT = process.env.XMS_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url))
const STOCK_PATH = `${APP_ROOT}/server/data/catalog.json`
const STOP = new Set(['of', 'the', 'a', 'an', 'and', 'for', 'to', 'in', 'client', 's'])

export class Catalog {
  groups: Groups
  choices = new Map<string, [string, string][]>() // "group.field" -> [code, text]
  source: CatalogSource = { kind: 'stock', label: 'stock catalog' }
  readonly stock: Groups
  readonly rules: PolicyRules

  constructor(file: StockFile) {
    this.groups = this.stock = file.catalog
    this.rules = file.policy
  }

  static loadStock(): Catalog {
    return new Catalog(JSON.parse(readFileSync(STOCK_PATH, 'utf8')) as StockFile)
  }

  field(group: string, name: string): FieldDef | undefined {
    return this.groups[group]?.[name]
  }

  areas(): string[] {
    return Object.keys(this.groups)
      .filter((g) => g !== 'entity')
      .map((g) => g.slice('entity_'.length))
      .sort()
  }

  policyOf(name: string, def: FieldDef): Policy {
    const [type, , flagText] = def
    const flags = new Set(flagText.split(',').filter(Boolean))
    const r = this.rules
    if (r.block_types.includes(type) || r.block_names.includes(name) || r.block_flags.some((f) => flags.has(f))) return 'block'
    // sitecustom: a field only this site has, so there are no stock flags to trust.
    if (r.review_flags.some((f) => flags.has(f)) || flags.has('sitecustom')) return 'review'
    return 'ok'
  }


  /** Keyword search over field names and labels; `area` narrows to "entity" or one list area. */
  search(query: string, area?: string, limit = 25) {
    const phrase = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join(' ')
    const words = phrase.split(' ').filter((w) => w && !STOP.has(w))
    const hits: [number, string, string, FieldDef][] = []
    for (const [group, fields] of Object.entries(this.groups)) {
      if (area && group !== area && group !== `entity_${area}`) continue
      for (const [name, def] of Object.entries(fields)) {
        const label = def[1].toLowerCase()
        const hay = `${name} ${label}`
        let score = words.reduce((s, w) => s + (hay.includes(w) ? (name.includes(w) ? 2 : 1) : 0), 0)
        if (score && phrase && (phrase === label || phrase === name.replaceAll('_', ' '))) score += 6
        if (score && group === 'entity') score += 3 // a field on the person beats the same label inside a list
        if (score) hits.push([score, group, name, def])
      }
    }
    hits.sort((a, b) => b[0] - a[0] || Number(a[1] !== 'entity') - Number(b[1] !== 'entity') || a[2].localeCompare(b[2]))
    return hits.slice(0, limit).map(([, group, name, def]) => ({ group, name, def, policy: this.policyOf(name, def) }))
  }

  useSite(groups: Groups, choices: Map<string, [string, string][]>, source: CatalogSource) {
    this.groups = groups
    this.choices = choices
    this.source = source
  }

  useStock() {
    this.groups = this.stock
    this.choices = new Map()
    this.source = { kind: 'stock', label: 'stock catalog' }
  }
}

/** One catalog for the whole local app; swapped to a site's fields when XWord is loaded. */
export const catalog = Catalog.loadStock()
