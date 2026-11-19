import { useState } from 'react'
import { type XplanRun, findClient, runInXplan, saveFile } from './api'

interface Props {
  template: string
  title: string
  site: string // the signed-in site
  onClose: () => void
}

/** Merge the current template for one client on an XPLAN site. Ad hoc: nothing is saved on the site. */
export function RunDialog({ template, title, site, onClose }: Props) {
  const [clientId, setClientId] = useState(() => localGet('xms.clientId'))
  const [format, setFormat] = useState<'doc' | 'pdf'>('doc')
  const [client, setClient] = useState<string | null>(null)
  const [busy, setBusy] = useState<'find' | 'run' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [result, setResult] = useState<XplanRun | null>(null)

  const id = Number(clientId)
  const ready = Number.isInteger(id) && id > 0

  const act = async (kind: 'find' | 'run') => {
    setBusy(kind)
    setMessage(null)
    try {
      localSet('xms.clientId', clientId)
      if (kind === 'find') {
        setClient((await findClient(id)).name)
      } else {
        const res = await runInXplan(template, id, format, title)
        setClient(res.client)
        setResult(res)
        saveFile(res.file_b64, res.mimetype, res.filename)
      }
    } catch (err) {
      setMessage((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" role="dialog" aria-label="Run in XPLAN" onClick={(e) => e.stopPropagation()}>
        <h2>Run in XPLAN</h2>
        <p className="muted">
          Merges this template for one client on {site} and downloads the result. It runs as an ad hoc
          template: nothing is saved on the site.
        </p>

        <div className="row">
          <input className="field" inputMode="numeric" placeholder="Client id, e.g. 13069" value={clientId}
            onChange={(e) => { setClientId(e.target.value.trim()); setClient(null); setResult(null) }} />
          <select className="field narrow" value={format} onChange={(e) => setFormat(e.target.value as 'doc' | 'pdf')}>
            <option value="doc">Word</option>
            <option value="pdf">PDF</option>
          </select>
          <button className="btn" disabled={!ready || busy !== null} onClick={() => act('find')}>{busy === 'find' ? 'Finding…' : 'Find'}</button>
        </div>
        {client && <div className="msgline">Client: <strong>{client}</strong></div>}

        {result && (
          <div className={`msgline ${result.errors.length ? 'bad' : 'good'}`}>
            {result.errors.length
              ? `Merged, but ${result.errors.length} line(s) have Err markers:`
              : result.note ?? 'Merged with no Err markers. The file has been downloaded.'}
            {result.errors.length > 0 && <ul className="findings">{result.errors.map((e, k) => <li key={k} className="bad">{e}</li>)}</ul>}
            <button className="btn ghost small" onClick={() => saveFile(result.file_b64, result.mimetype, result.filename)}>Download again</button>
          </div>
        )}
        {message && <div className="msgline bad">{message}</div>}

        <div className="dialog-actions">
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose}>Close</button>
          <button className="btn primary" disabled={!ready || busy !== null} onClick={() => act('run')}>
            {busy === 'run' ? 'Merging…' : client ? `Merge for ${client}` : 'Merge'}
          </button>
        </div>
      </div>
    </div>
  )
}

function localGet(k: string) {
  try { return localStorage.getItem(k) ?? '' } catch { return '' }
}
function localSet(k: string, v: string) {
  try { localStorage.setItem(k, v) } catch { /* private mode */ }
}
