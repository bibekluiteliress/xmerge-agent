// Calls to an XPLAN site with a browser session cookie (XPLANID). All are reads, except the ad hoc
// merge, which renders a document for one client and saves nothing on the site.
// docs/restful/tutorials/authentication.rst allows cookie sessions for testing; interactive sessions
// pass the Resourceful resource check (xpt/resourceful/handlers.py _check_resources).
import http from 'node:http'
import https from 'node:https'

export class XplanError extends Error {}

export interface SessionUser {
  entity_name?: string
  role_name?: string
  locale?: string
  user_id?: string
}

function base(siteUrl: string) {
  const url = siteUrl.trim().replace(/\/+$/, '').replace(/\/resourceful$/, '')
  if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url)) throw new XplanError('Use an https:// site URL.')
  return url
}

const cookieValue = (xplanid: string) => xplanid.trim().replace(/^XPLANID=/, '').split(';')[0]

const headersFor = (root: string, xplanid: string) => ({
  Accept: 'application/json',
  Cookie: `XPLANID=${cookieValue(xplanid)}`,
  Referer: `${root}/resourceful`,
})

async function call(siteUrl: string, xplanid: string, method: 'GET' | 'POST', pathOrUrl: string, what: string, timeoutMs: number, body?: unknown) {
  const root = base(siteUrl)
  const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${root}/resourceful/${pathOrUrl}`
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: { ...headersFor(root, xplanid), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw new XplanError(networkError(err as Error, what, timeoutMs))
  }
  if (res.status === 401) throw new XplanError(`The XPLANID cookie was rejected or has expired (401) while ${what}. Log in to XPLAN in the browser and copy a fresh one.`)
  if (res.status === 403) throw new XplanError(`Access denied (403) while ${what}.`)
  return res
}

/** Say what actually went wrong: a slow answer is not the same as an unreachable site. */
function networkError(err: Error, what: string, timeoutMs: number) {
  const code = (err.cause as { code?: string } | undefined)?.code ?? ''
  if (err.name === 'TimeoutError' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT')
    return `XPLAN did not finish ${what} within ${Math.round(timeoutMs / 60_000)} minutes. Large sites can take longer; load a downloaded XWord file instead.`
  if (['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT'].includes(code))
    return `Could not reach the site (${code}) while ${what}. Staging is usually reachable only on the internal network or VPN.`
  return `The request failed while ${what}: ${code || err.name}${err.cause instanceof Error ? ` (${err.cause.message})` : ''}.`
}

async function get<T>(siteUrl: string, xplanid: string, path: string, what: string, timeoutMs: number): Promise<T> {
  const res = await call(siteUrl, xplanid, 'GET', path, `reading ${what}`, timeoutMs)
  return parse<T>(res.status, await res.text(), what)
}

function parse<T>(status: number, text: string, what: string): T {
  if (status === 401) throw new XplanError(`The XPLANID cookie was rejected or has expired (401) while reading ${what}. Log in to XPLAN in the browser and copy a fresh one.`)
  if (status === 403) throw new XplanError(`Access denied (403) while reading ${what}.`)
  if (status === 502 || status === 504)
    throw new XplanError(`XPLAN's gateway gave up (${status}) while the site was still reading ${what}. Large sites can take minutes; load a downloaded XWord file instead.`)
  if (status < 200 || status >= 300) throw new XplanError(`The site returned ${status} while reading ${what}: ${text.replace(/\s+/g, ' ').slice(0, 200)}`)
  try {
    return JSON.parse(text) as T
  } catch {
    // An expired session is often answered with the login page (HTML, status 200) rather than a 401.
    throw new XplanError(/^\s*</.test(text)
      ? `The site answered with a web page instead of data while reading ${what}; the XPLANID has probably expired. Sign out and sign in with a fresh one.`
      : `The site's answer for ${what} was not valid JSON.`)
  }
}

/** GET session/user: whose session the cookie is. */
export const sessionUser = (siteUrl: string, xplanid: string) => get<SessionUser>(siteUrl, xplanid, 'session/user', 'session/user', 60_000)

/**
 * A GET that may take many minutes. fetch() gives up when a server sends no headers for 5 minutes, so
 * this uses node:https, bounded only by our own overall limit. Replaceable in tests.
 */
export const transport = {
  slowGet(url: string, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const req = (url.startsWith('https:') ? https : http).get(url, { headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }) })
        res.on('error', (err) => { clearTimeout(timer); reject(err) })
      })
      const timer = setTimeout(() => req.destroy(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), timeoutMs)
      req.on('error', (err) => { clearTimeout(timer); reject(err) })
    })
  },
}

const XWORD_TIMEOUT = 30 * 60_000 // XPLAN's own XWord loader allows 30 minutes (xpt/xword/util.py MAX_TIME)

/** GET xmerge/xword: the site's field list as the XWord plugin sees it. XPLAN builds it on request: minutes on big sites. */
export async function xwordJson(siteUrl: string, xplanid: string) {
  const root = base(siteUrl)
  const what = 'the XWord field list'
  let res: { status: number; text: string }
  try {
    res = await transport.slowGet(`${root}/resourceful/xmerge/xword`, headersFor(root, xplanid), XWORD_TIMEOUT)
  } catch (err) {
    const e = err as Error & { code?: string }
    throw new XplanError(networkError(e.code ? Object.assign(new Error(e.message), { name: e.name, cause: e }) : e, `reading ${what}`, XWORD_TIMEOUT))
  }
  return parse<{ fields: unknown[] }>(res.status, res.text, what)
}

export interface UfieldDef {
  name?: string
  flag?: unknown[]
}

/** GET ufield/{group}: the site's field definitions with flags. Hidden fields are left out by XPLAN. */
export const ufieldGroup = (siteUrl: string, xplanid: string, group: string) =>
  get<UfieldDef[]>(siteUrl, xplanid, `ufield/${encodeURIComponent(group)}?include_choices=false`, `the ${group} field flags`, 120_000)

export const host = (siteUrl: string) => new URL(base(siteUrl)).host

/** GET entity/client-v3/{id}: the client's display name, so the adviser can confirm who the merge is for. */
export async function clientName(siteUrl: string, xplanid: string, entityId: number) {
  const res = await call(siteUrl, xplanid, 'GET', `entity/client-v3/${entityId}`, `looking up client ${entityId}`, 60_000)
  if (res.status === 404) throw new XplanError(`No client with id ${entityId} on this site (404).`)
  if (!res.ok) throw new XplanError(`The site returned ${res.status} while looking up client ${entityId}.`)
  const data = (await res.json()) as { fields?: Record<string, string> } & Record<string, string>
  const f = data.fields ?? data
  return f.entity_name || [f.first_name, f.last_name].filter(Boolean).join(' ') || `client ${entityId}`
}

const RENDER_TIMEOUT = 300_000

/**
 * POST xmerge/template/adhoc?_method=run: merge a .docx template for one client and return the file.
 * Ad hoc runs are not stored as templates and add no document note (xpt/resourceful/api/xmerge/adhoc.py).
 */
export async function runAdhoc(siteUrl: string, xplanid: string, docx: Buffer, entityId: number, format: 'doc' | 'pdf'): Promise<Buffer> {
  const body = { template: { _type: 'Binary', _val: docx.toString('base64') }, entityid: entityId, outputformat: format, variables: {} }
  let res = await call(siteUrl, xplanid, 'POST', 'xmerge/template/adhoc?_method=run', 'merging the report', RENDER_TIMEOUT, body)
  if (res.status === 404) res = await call(siteUrl, xplanid, 'POST', 'xmerge/template/adhoc-v2?_method=run', 'merging the report', RENDER_TIMEOUT, body)
  if (!res.ok) throw new XplanError(`The merge failed on the site (${res.status}): ${(await res.text()).replace(/\s+/g, ' ').slice(0, 300)}`)
  const out = (await res.json()) as { _type?: string; _val?: string; location?: string }
  if (out._type === 'Binary' && out._val) return Buffer.from(out._val, 'base64')
  if (out.location) return download(siteUrl, xplanid, out.location)
  throw new XplanError('The site answered the merge with something unexpected.')
}

/** The v2 API returns a temporary download location; only follow it on the same site. */
async function download(siteUrl: string, xplanid: string, location: string) {
  const root = base(siteUrl)
  const url = new URL(location, `${root}/`)
  if (url.origin !== new URL(root).origin) throw new XplanError('The site returned a download link on another host; not followed.')
  const res = await call(siteUrl, xplanid, 'GET', url.href, 'downloading the merged report', RENDER_TIMEOUT)
  if (!res.ok) throw new XplanError(`Downloading the merged report failed (${res.status}).`)
  return Buffer.from(await res.arrayBuffer())
}
