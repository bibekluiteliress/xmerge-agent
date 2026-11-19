import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { catalog } from '../src/lib/catalog.js'
import { ensureSiteFlags, flagName, groupsInTemplate, setSiteSession } from '../src/lib/siteflags.js'
import { check } from '../src/lib/validator.js'
import { fromXword } from '../src/lib/xword.js'

const XWORD = [
  [
    ['first_name', 'Personal', 'First Name', [], 'string'],
    ['acme_risk_band', 'Acme', 'Risk band', [], 'choice'], // only on this site
    ['acme_notes', 'Acme', 'Private notes', [], 'string'], // only on this site, hidden there
    ['insurance_group', 'List', 'Insurance', [['coy', '', 'Insurer', [], 'string']]],
  ],
  [],
]

// What GET /resourceful/ufield/{group} returns on the fake site.
const UFIELD: Record<string, unknown[]> = {
  entity: [
    { name: 'first_name', flag: ['ff_searchable'] },
    { name: 'acme_risk_band', flag: ['ff_searchable', 'ff_secure'] },
    // acme_notes is missing: XPLAN leaves hidden fields out of the group listing
  ],
  entity_insurance_group: [{ name: 'coy', flag: [1] }], // numeric form: 1 = ff_searchable
}

let calls: string[]

beforeEach(() => {
  calls = []
  const site = fromXword(XWORD as never, catalog.stock)
  catalog.useSite(site.groups, site.choices, { kind: 'site', label: 'fake', ...site.stats })
  setSiteSession({ siteUrl: 'https://fake.example/site', xplanid: 'abc', user: {} })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push(url)
    expect((init.headers as Record<string, string>).Cookie).toBe('XPLANID=abc')
    const group = decodeURIComponent(/ufield\/([^?]+)/.exec(url)![1])
    if (group === 'entity_broken') return new Response('nope', { status: 500 })
    return new Response(JSON.stringify(UFIELD[group] ?? []), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  setSiteSession(null)
  catalog.useStock()
})

describe('site field flags (ufield)', () => {
  it('reads flag names in every form XPLAN may send', () => {
    expect([flagName('ff_hidden'), flagName('hidden'), flagName(2), flagName({ _n: 'ff_secure' }), flagName('xplan.ufield.ff_encrypted')])
      .toEqual(['hidden', 'hidden', 'hidden', 'secure', 'encrypted'])
    expect(flagName(999)).toBeNull()
  })

  it("replaces 'needs approval' guesses with the site's own flags", async () => {
    const before = check('<:=$client.acme_risk_band:>', catalog).issues.map((i) => i.severity)
    expect(before).toEqual(['review']) // XWord alone: unknown, so a person must approve

    const res = await ensureSiteFlags(['entity', 'entity_insurance_group'])
    expect(res).toEqual([
      { group: 'entity', status: 'site', updated: 2, hidden: 1 },
      { group: 'entity_insurance_group', status: 'site', updated: 1, hidden: 0 },
    ])
    const after = check('<:=$client.first_name:> <:=$client.acme_risk_band:> <:=$client.acme_notes:>', catalog)
    expect(after.issues.map((i) => [i.severity, i.message])).toEqual([
      ['block', "$client.acme_risk_band: 'acme_risk_band' is a sensitive field (searchable,secure) and is not allowed"],
      ['review', "$client.acme_notes: 'acme_notes' is flagged hidden, so a person must approve it"],
    ])
    expect(catalog.field('entity_insurance_group', 'coy')![2]).toBe('searchable')
  })

  it('asks the site once per group and keeps going when a call fails', async () => {
    catalog.groups.entity_broken = { x: ['string', 'X', 'sitecustom'] }
    await ensureSiteFlags(['entity'])
    const res = await ensureSiteFlags(['entity', 'entity_broken'])
    expect(res.map((r) => r.status)).toEqual(['cached', 'failed'])
    expect(catalog.field('entity_broken', 'x')![2]).toBe('sitecustom') // unchanged after a failure
    expect(calls.filter((u) => u.includes('ufield/entity?'))).toHaveLength(1)
  })

  it('does nothing when not signed in to a site', async () => {
    setSiteSession(null)
    expect(await ensureSiteFlags(['entity'])).toEqual([])
    expect(calls).toEqual([])
  })

  it('finds the groups a template touches', () => {
    expect(groupsInTemplate('<:for p in $client.insurance_group:><:=p.coy:><:end:> <:=$client.first_name:>')).toEqual(['entity', 'entity_insurance_group'])
  })
})
