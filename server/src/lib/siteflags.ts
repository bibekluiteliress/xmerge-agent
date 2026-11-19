// Sensitivity flags from the site itself (GET /resourceful/ufield/{group}), so a site loaded from XWord
// does not depend on the stock catalog for which fields are hidden, secure, encrypted and so on.
// Fetched lazily, only for the groups a report uses, and cached until the field source changes.
import { catalog } from './catalog.js'
import { ufieldGroup } from './xplan.js'

// idl/ufield.idl enum FieldFlag, in order, for sites that serialise flags as numbers.
const FLAG_ORDER = [
  'required', 'searchable', 'hidden', 'immutable', 'dateonly', 'no_day', 'no_year', 'no_year_renew', 'intoption',
  'unsigned', 'floatoption', 'restricted', 'internal', 'custom', 'obsolete', 'readonly', 'noblank', 'category',
  'noremoverow', 'noeditrow', 'secure', 'conditional', 'daterange', 'templatable', 'viewonly', 'allow_duplicate_options',
  'no_duplicates', 'encrypted', 'scenario_wizard_field_uses_client', 'xportable', 'emailable', 'api_listable',
  'ui_readonly_client', 'case_insensitive', 'normalize_whitespace', 'smallint', 'lock_publish_overwrite',
  'show_dsn_in_list', 'xmlisable', 'allow_opt_in_history', 'ui_always_show_for_partner',
]

export interface SiteSession {
  siteUrl: string
  xplanid: string
  user: { name?: string; role?: string; locale?: string }
}

// The adviser's sign-in (site URL + XPLANID), held in this process's memory only.
let session: SiteSession | null = null
const done = new Map<string, 'site' | 'failed'>()

/** Set on sign-in, cleared on sign-out. */
export function setSiteSession(s: SiteSession | null) {
  session = s
  done.clear()
}

/** Forget fetched flags, e.g. after a new field list is loaded. */
export const clearFlagCache = () => done.clear()

export const hasSiteSession = () => session !== null

export const siteSession = () => session

/** One flag value as XPLAN may serialise it: "ff_hidden", "hidden", 2, or an omniORB-style {_n: "ff_hidden"}. */
export function flagName(raw: unknown): string | null {
  if (typeof raw === 'number') return FLAG_ORDER[raw] ?? null
  if (typeof raw === 'string') return raw.replace(/^.*\./, '').replace(/^ff_/, '') || null
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    return flagName(o._n ?? o.name ?? o._v ?? o.value)
  }
  return null
}

export interface FlagResult {
  group: string
  status: 'site' | 'failed' | 'cached' | 'skipped'
  updated?: number
  hidden?: number
  message?: string
}

/** Make sure the given groups carry the site's own flags. Never throws: a failure keeps the stock flags. */
export async function ensureSiteFlags(groups: string[]): Promise<FlagResult[]> {
  if (!session || catalog.source.kind !== 'site') return []
  const out: FlagResult[] = []
  for (const group of [...new Set(groups)]) {
    const fields = catalog.groups[group]
    if (!fields) continue
    if (done.has(group)) {
      out.push({ group, status: 'cached' })
      continue
    }
    try {
      const defs = await ufieldGroup(session.siteUrl, session.xplanid, group)
      const flags = new Map<string, string[]>()
      let unknown = 0
      for (const d of defs) {
        if (!d.name) continue
        const names = (Array.isArray(d.flag) ? d.flag : []).map(flagName)
        unknown += names.filter((n) => n === null).length
        flags.set(d.name, names.filter((n): n is string => n !== null))
      }
      let hidden = 0
      for (const [name, def] of Object.entries(fields)) {
        const site = flags.get(name)
        // The group listing leaves out hidden fields, so a field XWord has but ufield lacks is treated as hidden.
        if (site) def[2] = site.join(',')
        else {
          def[2] = 'hidden'
          hidden++
        }
      }
      if (unknown) console.warn(`ufield/${group}: ${unknown} flag value(s) in an unrecognised format were ignored`)
      done.set(group, 'site')
      out.push({ group, status: 'site', updated: Object.keys(fields).length - hidden, hidden })
    } catch (err) {
      done.set(group, 'failed')
      out.push({ group, status: 'failed', message: (err as Error).message })
    }
  }
  return out
}

/** The groups a template touches: the client's own fields plus every list it loops over or sums. */
export function groupsInTemplate(template: string): string[] {
  const lists = [...template.matchAll(/\$\w+\.(\w+)/g)].map((m) => `entity_${m[1]}`).filter((g) => catalog.groups[g])
  return ['entity', ...lists]
}
