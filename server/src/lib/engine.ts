// Client for the Python engine service (engine/engine_service.py): packs .docx files and scans merged reports.

const URL_ = process.env.XMS_ENGINE_URL ?? 'http://127.0.0.1:8766'
const TOKEN = process.env.XMS_ENGINE_TOKEN ?? ''

async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
  let res: Response
  try {
    res = await fetch(URL_ + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Engine-Token': TOKEN },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })
  } catch {
    throw new Error('The engine service is not running. Start everything with ./run.sh.')
  }
  const out = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new Error(out.error ?? `engine returned ${res.status}`)
  return out
}

export const docx = async (template: string) => Buffer.from((await call<{ docx_b64: string }>('/docx', { template })).docx_b64, 'base64')

/** Lines of a merged report that hold an XMerge error marker ("Err: ..."); .docx only. */
export const scan = (file: Buffer, format: 'doc' | 'pdf') =>
  call<{ errors: string[]; note: string | null }>('/scan', { file_b64: file.toString('base64'), format })
