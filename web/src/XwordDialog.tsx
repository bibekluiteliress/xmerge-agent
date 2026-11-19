import { useEffect, useState } from 'react'
import { type FieldSource, type Login, fetchXword, resetXword, uploadXword } from './api'

interface Props {
  fields: FieldSource | null
  login: Login | null
  onClose: () => void
  onLoaded: (f: FieldSource) => void
}

/** Load a site's XWord field list: from the signed-in site, or from a downloaded file. */
export function XwordDialog({ fields, login, onClose, onLoaded }: Props) {
  const [busy, setBusy] = useState<'site' | 'other' | null>(null)
  const [since, setSince] = useState(0)
  const [now, setNow] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  // A clock while the site builds the list: it can take minutes on a large site.
  useEffect(() => {
    if (busy !== 'site') return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [busy])

  const act = async (kind: 'site' | 'other', fn: () => Promise<{ fields: FieldSource }>) => {
    setBusy(kind)
    setSince(Date.now())
    setNow(Date.now())
    setMessage(null)
    setFailed(false)
    try {
      const res = await fn()
      onLoaded(res.fields)
      setMessage(res.fields.kind === 'site' ? `Loaded ${res.fields.fields ?? ''} fields.` : 'Using the standard XPLAN fields.')
      setTimeout(onClose, 900)
    } catch (err) {
      setFailed(true)
      setMessage((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const onFile = (file: File | undefined) => file && act('other', async () => uploadXword(await file.text(), file.name))

  return (
    <div className="overlay" onClick={busy ? undefined : onClose}>
      <div className="dialog" role="dialog" aria-label="Load XWord fields" onClick={(e) => e.stopPropagation()}>
        <h2>Load XWord fields</h2>
        <p className="muted">Use a site's own field list (including its custom fields) instead of the standard XPLAN fields.</p>

        {login ? (
          <>
            <button className="btn primary wide" disabled={!!busy} onClick={() => act('site', fetchXword)}>
              {busy === 'site' ? `Loading from ${login.site}… ${clock(now - since)}` : `Fetch from ${login.site}`}
            </button>
            {busy === 'site' && <p className="hint">XPLAN builds this list on request; on a large site it can take several minutes.</p>}
          </>
        ) : (
          <p className="hint">Sign in to a site to fetch its fields directly.</p>
        )}

        <div className="or">or</div>
        <label className="drop">
          <input type="file" accept=".xml,.json,.txt" hidden disabled={!!busy} onChange={(e) => onFile(e.target.files?.[0])} />
          <strong>Choose an XWord file</strong>
          <span className="muted">The file the XWord plugin downloads, or a saved xmerge/xword response</span>
        </label>

        {message && <div className={`msgline ${failed ? 'bad' : ''}`}>{message}</div>}
        <div className="dialog-actions">
          {fields?.kind === 'site' && <button className="btn ghost" disabled={!!busy} onClick={() => act('other', resetXword)}>Use standard fields</button>}
          <span className="spacer" />
          <button className="btn ghost" disabled={!!busy} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
