import { Hono } from 'hono'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { catalog } from '../src/lib/catalog.js'
import { setSiteSession } from '../src/lib/siteflags.js'
import { transport } from '../src/lib/xplan.js'

// Sign-in, XWord from the signed-in site and "Run in XPLAN", against a fake site and a fake engine.
const SITE = 'https://fake.example/site'
const TOKEN = 'test-token'
let app: Hono
let calls: { method: string; url: string; cookie?: string }[]
let location = '/site/transient/abc123'

beforeAll(async () => {
  process.env.XMS_TOKEN = TOKEN
  const { studioRoutes } = await import('../src/mastra/routes.js')
  app = new Hono()
  for (const r of studioRoutes) {
    const route = r as unknown as { path: string; method: string; handler: never; middleware: never[] }
    app.on([route.method], [route.path], ...route.middleware, route.handler)
  }
})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

// The slow XWord GET goes through node:https in the app; here it goes through the stubbed fetch.
transport.slowGet = async (url, headers) => {
  const r = await fetch(url, { headers })
  return { status: r.status, text: await r.text() }
}

/** Load the signed-in site's XWord list; returns the status and the answer. */
async function fetchXword() {
  const res = await post('/studio/xword/fetch')
  return { status: res.status, body: await res.json() }
}

beforeEach(() => {
  calls = []
  location = '/site/transient/abc123'
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>
    calls.push({ method: init.method ?? 'GET', url, cookie: headers.Cookie })
    // the engine service
    if (url.endsWith('/docx')) return json({ docx_b64: Buffer.from('PK-template').toString('base64') })
    if (url.endsWith('/scan')) return json({ errors: ['Dear Err: Invalid field name'], note: null })
    // the site
    if (headers.Cookie !== 'XPLANID=good') return json({ error: 'auth' }, 401)
    const path = url.replace(SITE, '')
    if (path === '/resourceful/session/user') return json({ entity_name: 'test, Bibek', role_name: 'User', locale: 'AU' })
    if (path === '/resourceful/xmerge/xword') return json({ fields: [[['first_name', 'Personal', 'First Name', [], 'string']], []] })
    if (path.startsWith('/resourceful/ufield/')) return json([{ name: 'first_name', flag: ['ff_searchable'] }])
    if (path === '/resourceful/entity/client-v3/13069') return json({ fields: { entity_name: 'luffa, potato' } })
    if (path === '/resourceful/entity/client-v3/1') return json({ error: 'nf' }, 404)
    if (path === '/resourceful/xmerge/template/adhoc?_method=run') {
      const body = JSON.parse(String(init.body))
      expect(body).toMatchObject({ entityid: 13069, outputformat: 'doc', variables: {}, template: { _type: 'Binary' } })
      return json({ location })
    }
    if (path === '/transient/abc123' || url === 'https://fake.example/site/transient/abc123') return new Response(Buffer.from('PK-merged'))
    return json({ error: 'nf' }, 404)
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  setSiteSession(null)
  catalog.useStock()
})

const post = (path: string, body: unknown = {}, token = TOKEN) =>
  app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token }, body: JSON.stringify(body) })

const signIn = () => post('/studio/login', { siteUrl: SITE, xplanid: 'XPLANID=good' })

describe('sign-in and Run in XPLAN', () => {
  it('needs the studio token', async () => {
    expect((await post('/studio/login', {}, 'wrong')).status).toBe(403)
  })

  it('signs in once and keeps the session for later calls', async () => {
    const res = await signIn()
    expect(res.status).toBe(200)
    expect((await res.json()).login).toMatchObject({ site: 'fake.example', user: { name: 'test, Bibek', role: 'User' } })

    const state = await (await app.request('/studio/state', { headers: { 'X-Studio-Token': TOKEN } })).json()
    expect(state.login.site).toBe('fake.example')
    expect(JSON.stringify(state)).not.toContain('good') // the cookie never goes back to the browser

    const xw = await fetchXword()
    expect(xw.status).toBe(200)
    expect(xw.body.fields).toMatchObject({ kind: 'site', flags: 'site' })
    expect(calls.filter((c) => c.url.includes('fake.example')).every((c) => c.cookie === 'XPLANID=good')).toBe(true)
  })

  it('rejects a bad cookie and stays signed out', async () => {
    const res = await post('/studio/login', { siteUrl: SITE, xplanid: 'bad' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('401')
    expect((await fetchXword()).status).toBe(400)
  })

  it('looks up the client, merges ad hoc and reports Err lines', async () => {
    await signIn()
    expect(await (await post('/studio/xplan/client', { entityId: 13069 })).json()).toEqual({ name: 'luffa, potato', site: 'fake.example' })
    expect((await (await post('/studio/xplan/client', { entityId: 1 })).json()).error).toContain('No client with id 1')

    const res = await post('/studio/xplan/run', { template: 'Dear <:=$client.first_name:>', entityId: 13069, format: 'doc', name: 'Annual review' })
    const out = await res.json()
    expect(res.status).toBe(200)
    expect(out).toMatchObject({ client: 'luffa, potato', filename: 'Annual-review-13069.docx', errors: ['Dear Err: Invalid field name'] })
    expect(Buffer.from(out.file_b64, 'base64').toString()).toBe('PK-merged')
  })

  it('will not follow a download link to another host', async () => {
    await signIn()
    location = 'https://elsewhere.example/steal'
    const out = await (await post('/studio/xplan/run', { template: 'Hi', entityId: 13069 })).json()
    expect(out.error).toContain('another host')
    expect(calls.some((c) => c.url.includes('elsewhere'))).toBe(false)
  })

  it('refuses to merge a template with blocking problems, and without a sign-in', async () => {
    expect((await (await post('/studio/xplan/run', { template: 'Hi', entityId: 13069 })).json()).error).toContain('Sign in')
    await signIn()
    const out = await (await post('/studio/xplan/run', { template: '<:=$client.tfn:>', entityId: 13069 })).json()
    expect(out.error).toContain('blocking problems')
    expect(calls.some((c) => c.url.includes('adhoc'))).toBe(false)
  })

  it('sign-out forgets the session and the site fields', async () => {
    await signIn()
    await fetchXword()
    const state = await (await post('/studio/logout')).json()
    expect(state.login).toBeNull()
    expect(state.fields.kind).toBe('stock')
  })
})

describe('XWord fetch errors say what went wrong', () => {
  const answer = (res: Response) => {
    const real = globalThis.fetch as unknown as (u: string, i?: RequestInit) => Promise<Response>
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => (url.includes('xmerge/xword') ? res : real(url, init))))
  }

  it('an expired session answered with the login page', async () => {
    await signIn()
    answer(new Response('<!DOCTYPE html><html>login</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }))
    expect((await fetchXword()).body.error).toContain('XPLANID has probably expired')
  })

  it('a gateway timeout on a large site', async () => {
    await signIn()
    answer(new Response('', { status: 504 }))
    expect((await fetchXword()).body.error).toContain('gateway gave up (504)')
  })

  it('a slow site is not reported as unreachable', async () => {
    await signIn()
    const real = globalThis.fetch as unknown as (u: string, i?: RequestInit) => Promise<Response>
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('xmerge/xword')) throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
      return real(url, init)
    }))
    const error = (await fetchXword()).body.error
    expect(error).toContain('did not finish reading the XWord field list within 30 minutes')
    expect(error).not.toContain('VPN')
  })
})

describe('XWord fetch and sign-out', () => {
  it('a sign-out while loading discards the result', async () => {
    await signIn()
    let release!: () => void
    const real = globalThis.fetch as unknown as (u: string, i?: RequestInit) => Promise<Response>
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('xmerge/xword')) await new Promise<void>((r) => { release = r })
      return real(url, init)
    }))
    const pending = fetchXword()
    await new Promise((r) => setTimeout(r, 5))
    await post('/studio/logout')
    release()
    expect((await pending).body.error).toContain('Signed out')
    const s = await (await app.request('/studio/state', { headers: { 'X-Studio-Token': TOKEN } })).json()
    expect(s.fields.kind).toBe('stock')
  })
})
