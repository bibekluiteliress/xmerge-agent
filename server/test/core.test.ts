import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { catalog } from '../src/lib/catalog.js'
import { buildSheet, extractTemplate, looksLikeDesign, parseDesign } from '../src/lib/flow.js'
import { check } from '../src/lib/validator.js'
import { fromXword, xwordFields } from '../src/lib/xword.js'

const TEMPLATES = fileURLToPath(new URL('../../../../docs/markdown/xmerge/ai/demo/templates/src/', import.meta.url))
const tpl = (name: string) => readFileSync(TEMPLATES + name, 'utf8')

// Same shapes xpt.xword.util.getEntityData produces.
const XWORD = {
  fields: [
    [
      ['first_name', 'Personal', 'First Name', [], 'string'],
      ['acme_risk_band', 'Acme', 'Risk band', [['L', 'Low'], ['H', 'High']], 'choice'],
      ['insurance_group', 'List', 'Insurance', [
        ['coy', '', 'Insurer', [], 'string'],
        ['frequency', '', 'Premium Frequency', [['12', 'Monthly'], ['1', 'Annually']], 'choice'],
      ]],
    ],
    [['first_name', '', 'First Name', [], 'string']],
  ],
}

afterEach(() => catalog.useStock())

describe('validator (same verdicts as the Python Studio)', () => {
  it('passes the client summary except the deliberate unknown symbol', () => {
    const r = check(tpl('client_summary.txt'), catalog)
    expect(r.issues.filter((i) => i.severity === 'block').map((i) => i.message)).toEqual(['symbol $no_such_symbol is not available to AI templates'])
  })

  it('blocks invented fields', () => {
    const msgs = check(tpl('deliberate_error.txt'), catalog).issues.map((i) => i.message).join('\n')
    expect(msgs).toContain('$client.favourite_colour: unknown field or list')
    expect(msgs).toContain("'colour' does not exist in entity_asset")
  })

  it('blocks forbidden constructs', () => {
    const r = check(tpl('forbidden.txt'), catalog)
    expect(r.ok).toBe(false)
    expect(r.issues.map((i) => i.message)).toEqual(expect.arrayContaining(["'__' is forbidden in expressions", "'open(' is forbidden in expressions"]))
  })

  it('catches unclosed blocks and disallowed markers', () => {
    const r = check('<:for p in $client.insurance_group:>\n<:=p.coy:>\n<:merge x:>', catalog)
    expect(r.issues.map((i) => i.message)).toEqual(expect.arrayContaining(['marker <:merge ...:> is not allowed', '1 if/for block(s) never closed with <:end:>']))
  })
})

describe('XWord field list', () => {
  it('reads the xmerge/xword JSON and keeps choice codes', () => {
    const site = fromXword(xwordFields(JSON.stringify(XWORD)), catalog.stock)
    expect(site.stats).toEqual({ fields: 4, areas: 1, siteOnly: 1 })
    expect(site.groups.entity.acme_risk_band[2]).toBe('sitecustom')
    expect(site.choices.get('entity_insurance_group.frequency')).toEqual([['12', 'Monthly'], ['1', 'Annually']])
  })

  it('reads a downloaded <xword-data-xml> file', () => {
    const v = (x: string) => `<value value="${x}"></value>`
    const list = (items: string[]) => `<list>${items.join('')}</list>`
    const field = (n: string, l: string, t: string) => list([v(n), v(''), v(l), list([]), v(t)])
    const xml = `<?xml version="1.0"?><xword-data-xml><version value="3"></version><base-path>${list([
      list([list([field('first_name', 'First Name', 'string'), list([v('insurance_group'), v('List'), v('Insurance'), list([field('coy', 'Insurer', 'string')])])]), list([])]),
      list([]),
    ])}</base-path></xword-data-xml>`
    const site = fromXword(xwordFields(xml), catalog.stock)
    expect(Object.keys(site.groups.entity_insurance_group)).toEqual(['coy'])
    expect(site.groups.entity.first_name[1]).toBe('First Name')
  })

  it('switches the validator to the site fields', () => {
    const site = fromXword(XWORD.fields as never, catalog.stock)
    catalog.useSite(site.groups, site.choices, { kind: 'site', label: 'test', ...site.stats })
    const r = check('<:=$client.acme_risk_band:> <:=$client.dob:>', catalog)
    expect(r.issues.map((i) => [i.severity, i.message])).toEqual([
      ['block', '$client.dob: unknown field or list'],
      ['review', "$client.acme_risk_band: 'acme_risk_band' is flagged sitecustom, so a person must approve it"],
    ])
  })
})

describe('design and field sheet', () => {
  const design = [
    '# Your insurance',
    'Prepared for {{client full name}} on {{today\'s date}}',
    '[[for each insurance_group: one policy]]',
    '| {{insurer name}} | {{premium frequency}} |',
    '[[end]]',
    'Total: {{total of benefit premium over insurance_group}}',
    '[[if partner]]{{partner: first name}}[[end]]',
  ].join('\n')

  it('finds data points, their scope and the list areas', () => {
    const p = parseDesign(catalog, design)
    expect(p.areas).toEqual(['insurance_group'])
    expect(p.warnings).toEqual([])
    expect(p.points.map((x) => [x.text, x.scope, x.kind])).toEqual(expect.arrayContaining([
      ['premium frequency', 'insurance_group', 'value'],
      ['benefit premium', 'insurance_group', 'total'],
      ['first name', 'partner', 'value'],
    ]))
  })

  it('puts the whole list area in the sheet', () => {
    const { sheet } = buildSheet(catalog, parseDesign(catalog, design))
    expect(sheet).toContain('## All fields of list area insurance_group')
    expect(sheet).toMatch(/^coy \| /m)
  })

  it('recognises designs and template fences', () => {
    expect(looksLikeDesign('Hi {{client first name}}')).toBe(true)
    expect(looksLikeDesign('a report about insurance')).toBe(false)
    expect(extractTemplate('notes\n```xmerge\nA\n```\n```xmerge\nB\n```')).toBe('B')
  })
})
