// HTTP API for the React app (web/). Everything is under /studio and needs the per-run token.
import { registerApiRoute } from '@mastra/core/server'
import type { Context } from 'hono'
import { catalog } from '../lib/catalog.js'
import { buildDocx, errLines } from '../lib/docx.js'
import { splitPasted } from '../lib/flow.js'
import { gate } from '../lib/gate.js'
import { clearFlagCache, setSiteSession, siteSession } from '../lib/siteflags.js'
import { fromXword, xwordFields } from '../lib/xword.js'
import { XplanError, clientName, host, runAdhoc, sessionUser, xwordJson } from '../lib/xplan.js'

const TOKEN = process.env.XMS_TOKEN ?? ''

async function guard(c: Context, next: () => Promise<void>) {
  if (!TOKEN || c.req.header('X-Studio-Token') !== TOKEN) return c.json({ error: 'forbidden' }, 403)
  await next()
}

const fail = (c: Context, err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  const expected = err instanceof XplanError || /XWord|JSON|xword-data/.test(message)
  if (!expected) console.error(err)
  return c.json({ error: message }, expected ? 400 : 500)
}

const state = () => {
  const login = siteSession()
  return {
    fields: { ...catalog.source, flags: catalog.source.kind === 'site' && login ? 'site' : 'standard' },
    model: process.env.XMS_MODEL ?? 'au.anthropic.claude-opus-5-5',
    login: login ? { site: host(login.siteUrl), siteUrl: login.siteUrl, user: login.user } : null,
  }
}

/** The signed-in site, for anything that calls XPLAN. */
function signedIn() {
  const login = siteSession()
  if (!login) throw new XplanError('Sign in to an XPLAN site first.')
  return login
}

function clientId(raw: unknown) {
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) throw new XplanError("Enter the client id (the number in the client's XPLAN address).")
  return id
}

function loadFields(fields: unknown[], label: string) {
  const site = fromXword(fields as never, catalog.stock)
  if (!site.stats.fields) throw new XplanError('The XWord field list is empty.')
  catalog.useSite(site.groups, site.choices, { kind: 'site', label, ...site.stats })
  clearFlagCache()
  return catalog.source
}

/** Server-sent events: one JSON object per event. `onCancel` runs when the browser stops reading (Stop). */
function sse(run: (send: (event: unknown) => void) => Promise<void>, onCancel?: () => void) {
  const enc = new TextEncoder()
  let open = true
  const body = new ReadableStream({
    async start(ctrl) {
      const send = (e: unknown) => open && ctrl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`))
      try {
        await run(send)
      } catch (err) {
        send({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      } finally {
        if (open) ctrl.close()
        open = false
      }
    },
    cancel() {
      open = false
      onCancel?.()
    },
  })
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } })
}

export const studioRoutes = [
  registerApiRoute('/studio/state', { method: 'GET', middleware: [guard], handler: async (c) => c.json(state()) }),

  // Sign in with the browser's XPLANID: session/user says whose session it is. Kept in memory only.
  registerApiRoute('/studio/login', {
    method: 'POST',
    middleware: [guard],
    handler: async (c) => {
      try {
        const { siteUrl, xplanid } = await c.req.json<{ siteUrl: string; xplanid: string }>()
        if (!siteUrl || !xplanid) throw new XplanError('Enter the site URL and the XPLANID cookie.')
        const user = await sessionUser(siteUrl, xplanid)
        if (catalog.source.kind === 'site') catalog.useStock() // fields of another site must not carry over
        setSiteSession({ siteUrl, xplanid, user: { name: user.entity_name, role: user.role_name, locale: user.locale } })
        return c.json(state())
      } catch (err) {
        return fail(c, err)
      }
    },
  }),

  registerApiRoute('/studio/logout', {
    method: 'POST',
    middleware: [guard],
    handler: async (c) => {
      setSiteSession(null)
      catalog.useStock()
      return c.json(state())
    },
  }),

  // A downloaded XWord file (XML) or a saved xmerge/xword JSON response.
  registerApiRoute('/studio/xword/upload', {
    method: 'POST',
    middleware: [guard],
    handler: async (c) => {
      try {
        const { content, filename } = await c.req.json<{ content: string; filename?: string }>()
        const source = loadFields(xwordFields(content), `XWord file ${filename ?? ''}`.trim())
        console.info(`xword upload: ${source.fields} fields, ${source.areas} lists from ${content.length} chars`)
        return c.json({ fields: state().fields })
      } catch (err) {
        return fail(c, err)
      }
    },
  }),

  // From the signed-in site: GET {site}/resourceful/xmerge/xword. XPLAN builds the list on request, which
  // takes minutes on a big site (about 3 on primeau), so the server timeout in index.ts allows for it.
  registerApiRoute('/studio/xword/fetch', {
    method: 'POST',
    middleware: [guard],
    handler: async (c) => {
      try {
        const login = signedIn()
        const site = host(login.siteUrl)
        const started = Date.now()
        const xw = await xwordJson(login.siteUrl, login.xplanid).catch((err: Error) => {
          console.warn(`xword fetch: ${site} failed after ${Date.now() - started} ms: ${err.message}`)
          throw err
        })
        if (!Array.isArray(xw?.fields)) throw new XplanError('The xmerge/xword answer has no "fields" list.')
        if (siteSession() !== login) throw new XplanError('Signed out while the field list was loading.')
        const source = loadFields(xw.fields, `XWord fields of ${site}`)
        console.info(`xword fetch: ${site} ${source.fields} fields, ${source.areas} lists in ${Date.now() - started} ms`)
        return c.json({ fields: state().fields })
      } catch (err) {
        return fail(c, err)
      }
    },
  }),

  registerApiRoute('/studio/xword/reset', {
    method: 'POST',
    middleware: [guard],
    handler: async (c) => {
      catalog.useStock()
      clearFlagCache()
      return c.json(state())
    },
  }),

  // Generate (guided report) or revise (follow-up on the current template), streamed as SSE.
  registerApiRoute('/studio/run', {
    method: 'POST',
    middleware: [guard],
    handler: async (c) => {
      const body = await c.req.json<{ request: string; template?: string; history?: unknown }>()
      const { request } = body
      // A new report whose message holds a template (pasted with "fix this") is a revise of that template.
      const pasted = body.template?.trim() ? null : splitPasted(request ?? '')
      const template = pasted?.template ?? body.template
      const instruction = pasted?.instruction ?? request
      // Earlier requests of the current report only; "New report" in the app sends none.
      const history = Array.isArray(body.history) ? body.history.filter((h): h is string => typeof h === 'string') : []
      const mastra = c.get('mastra')
      const wf = template?.trim() ? mastra.getWorkflow('reviseWorkflow') : mastra.getWorkflow('reportWorkflow')
      const inputData = template?.trim() ? { template, instruction, history } : { request, history }
      const run = await wf.createRun()
      return sse(async (send) => {
        const stream = run.stream({ inputData: inputData as never })
        for await (const chunk of stream.fullStream as AsyncIterable<{ type: string; payload?: Record<string, unknown> }>) {
          const p = chunk.payload ?? {}
          if (chunk.type === 'workflow-step-start') send({ kind: 'step', step: p.id, status: 'running' })
          else if (chunk.type === 'workflow-step-result') send({ kind: 'step', step: p.id, status: p.status })
          else if (chunk.type === 'workflow-step-output') send((p.output ?? p) as object)
        }
        const result = await stream.result
        if (result.status === 'success') send({ kind: 'result', ...(result.result as object) })
        else send({ kind: 'error', message: result.status === 'failed' ? (result.error?.message ?? 'The workflow failed.') : `The workflow ended: ${result.status}` })
      }, () => void run.cancel().catch(() => {})) // Stop in the app: no more model calls for this run
    },
  }),

  // The editor calls this after the adviser edits: the validator.
  registerApiRoute('/studio/check', {
    method: 'POST',
    middleware: [guard],
    handler: async (c) => {
      try {
        const { template } = await c.req.json<{ template: string }>()
        return c.json(await gate(template))
      } catch (err) {
        return fail(c, err)
      }
    },
  }),

  // Who a client id is, before merging for them.
  registerApiRoute('/studio/xplan/client', {
    method: 'POST',
    middleware: [guard],
    handler: async (c) => {
      try {
        const { siteUrl, xplanid } = signedIn()
        const id = clientId((await c.req.json<{ entityId: number }>()).entityId)
        return c.json({ name: await clientName(siteUrl, xplanid, id), site: host(siteUrl) })
      } catch (err) {
        return fail(c, err)
      }
    },
  }),

  // Merge the current template for one client on the site (ad hoc run: no template or note is saved).
  registerApiRoute('/studio/xplan/run', {
    method: 'POST',
    middleware: [guard],
    handler: async (c) => {
      try {
        const body = await c.req.json<{ entityId: number; template: string; format?: 'doc' | 'pdf'; name?: string }>()
        const { siteUrl, xplanid } = signedIn()
        const id = clientId(body.entityId)
        const format = body.format === 'pdf' ? 'pdf' : 'doc'
        const checked = await gate(body.template ?? '')
        if (!checked.check.ok) throw new XplanError('Fix the blocking problems before running the template in XPLAN.')
        const client = await clientName(siteUrl, xplanid, id)
        const merged = await runAdhoc(siteUrl, xplanid, buildDocx(body.template), id, format)
        const scan = errLines(merged, format)
        const isPdf = merged.subarray(0, 4).toString('latin1') === '%PDF'
        const base = (body.name ?? 'xmerge-report').replace(/[^\w.-]+/g, '-').slice(0, 50) || 'xmerge-report'
        console.info(`xplan run: ${host(siteUrl)} client ${id}, ${merged.length} bytes, ${scan.errors.length} Err line(s)`)
        return c.json({
          client,
          site: host(siteUrl),
          filename: `${base}-${id}.${isPdf ? 'pdf' : 'docx'}`,
          mimetype: isPdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          file_b64: merged.toString('base64'),
          errors: scan.errors,
          note: scan.note,
        })
      } catch (err) {
        return fail(c, err)
      }
    },
  }),

  registerApiRoute('/studio/download', {
    method: 'POST',
    middleware: [guard],
    handler: async (c) => {
      try {
        const { template, format, name } = await c.req.json<{ template: string; format: 'txt' | 'docx'; name?: string }>()
        const base = (name ?? 'xmerge-template').replace(/[^\w.-]+/g, '-').slice(0, 60) || 'xmerge-template'
        if (format === 'docx') {
          return new Response(new Uint8Array(buildDocx(template)), {
            headers: {
              'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'Content-Disposition': `attachment; filename="${base}.docx"`,
            },
          })
        }
        return new Response(template, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${base}.txt"` } })
      } catch (err) {
        return fail(c, err)
      }
    },
  }),
]
