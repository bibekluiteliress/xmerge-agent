// Calls to the Mastra server's /studio routes (proxied by Vite, which adds the token).

export interface FieldSource {
  kind: 'stock' | 'site'
  label: string
  fields?: number
  areas?: number
  siteOnly?: number
  flags?: 'site' | 'standard' // where sensitivity flags come from
}

export interface Gate {
  check: { ok: boolean; issues: { severity: 'block' | 'review'; line: number | null; message: string }[] }
  problems: string[]
  review: string[]
  notHeld: string[]
}

export interface RunResult {
  template: string | null
  notes: string
  calls: number
  gate: Gate | null
}

export type RunEvent =
  | { kind: 'step'; step: string; status: string }
  | { kind: 'delta'; step: string; text: string }
  | { kind: 'info'; step: string; text?: string; summary?: Record<string, unknown>; problems?: string[]; attempt?: number }
  | ({ kind: 'result' } & RunResult)
  | { kind: 'error'; message: string }

async function json<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({ error: `Server returned ${res.status}` }))
  if (!res.ok) throw new Error(data.error ?? `Server returned ${res.status}`)
  return data as T
}

export interface Login {
  site: string
  siteUrl: string
  user: { name?: string; role?: string; locale?: string }
}

export interface State {
  fields: FieldSource
  model: string
  login: Login | null
}

export const getState = () => json<State>('/studio/state')
export const login = (siteUrl: string, xplanid: string) => json<State>('/studio/login', { siteUrl, xplanid })
export const logout = () => json<State>('/studio/logout', {})
export const uploadXword = (content: string, filename: string) => json<{ fields: FieldSource }>('/studio/xword/upload', { content, filename })
/** The signed-in site's XWord list (GET xmerge/xword on the site); minutes on a big site. */
export const fetchXword = () => json<{ fields: FieldSource }>('/studio/xword/fetch', {})
export const resetXword = () => json<State>('/studio/xword/reset', {})
export interface XplanRun {
  client: string
  site: string
  filename: string
  mimetype: string
  file_b64: string
  errors: string[]
  note: string | null
}

export const findClient = (entityId: number) => json<{ name: string; site: string }>('/studio/xplan/client', { entityId })
export const runInXplan = (template: string, entityId: number, format: 'doc' | 'pdf', name: string) =>
  json<XplanRun>('/studio/xplan/run', { template, entityId, format, name })

/** Save a base64 file from the server (a report merged by XPLAN). */
export function saveFile(b64: string, mimetype: string, filename: string) {
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: mimetype }))
  const a = Object.assign(document.createElement('a'), { href: url, download: filename })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const checkTemplate = (template: string) => json<Gate>('/studio/check', { template })

/** Generate (no template) or revise (with the current template); calls onEvent for each streamed event. */
export async function run(request: string, template: string | null, onEvent: (e: RunEvent) => void, signal?: AbortSignal) {
  const res = await fetch('/studio/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request, template }),
    signal,
  })
  if (!res.ok || !res.body) throw new Error(`Server returned ${res.status}`)
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += value
    let i: number
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, i).replace(/^data: /, '')
      buf = buf.slice(i + 2)
      if (line) onEvent(JSON.parse(line) as RunEvent)
    }
  }
}

export async function download(template: string, format: 'docx' | 'txt', name: string) {
  const res = await fetch('/studio/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ template, format, name }) })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Server returned ${res.status}`)
  const url = URL.createObjectURL(await res.blob())
  const a = Object.assign(document.createElement('a'), { href: url, download: `${name || 'xmerge-template'}.${format}` })
  a.click()
  URL.revokeObjectURL(url)
}
