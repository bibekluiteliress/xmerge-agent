import { Fragment, useEffect, useRef, useState } from 'react'
import { type Gate, checkTemplate, download } from './api'
import { RunDialog } from './RunDialog'

interface Props {
  template: string
  gate: Gate | null
  title: string
  busy: boolean
  site: string | null // the signed-in site, if any
  onChange: (t: string) => void
  onGate: (g: Gate | null) => void
  onClose: () => void
}

/** The generated document: edit inline, see the checks, download it or run it in XPLAN. */
export function DocumentPanel({ template, gate, title, busy, site, onChange, onGate, onClose }: Props) {
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const edited = useRef(false)

  // Re-check after the adviser stops typing (the validator).
  useEffect(() => {
    if (!edited.current) return
    const id = setTimeout(async () => {
      setChecking(true)
      try {
        onGate(await checkTemplate(template))
        setError(null)
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setChecking(false)
      }
    }, 700)
    return () => clearTimeout(id)
  }, [template, onGate])

  const save = async (format: 'docx' | 'txt') => {
    try {
      await download(template, format, title)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const blocks = gate?.check.issues.filter((i) => i.severity === 'block') ?? []

  return (
    <aside className="doc">
      <div className="doc-head">
        <div className="doc-title">Template</div>
        <div className="doc-actions">
          <button className="btn primary" onClick={() => setRunning(true)} disabled={!site || busy || checking || blocks.length > 0}
            title={!site ? 'Sign in to a site first' : blocks.length ? 'Fix the problems first' : `Merge this template for one client on ${site}`}>Run in XPLAN</button>
          <button className="btn" onClick={() => save('docx')} disabled={blocks.length > 0} title={blocks.length ? 'Fix the problems first' : 'Word document for XPLAN'}>Download .docx</button>
          <button className="btn ghost" onClick={() => save('txt')}>.txt</button>
          <button className="btn ghost icon" onClick={onClose} aria-label="Close document">✕</button>
        </div>
      </div>

      <div className="doc-body">
        <Editor value={template} readOnly={busy} onChange={(v) => { edited.current = true; onChange(v) }} />
      </div>

      <div className={`status ${blocks.length ? 'bad' : gate ? 'good' : ''}`}>
        {checking ? 'Checking…' : !gate ? 'Not checked yet' : blocks.length ? `${blocks.length} problem(s) to fix` : 'Checks passed'}
        {gate && gate.review.length > 0 && <span> · {gate.review.length} need approval</span>}
        {gate && gate.notHeld.length > 0 && <span> · {gate.notHeld.length} not held in XPLAN</span>}
        {error && <span className="err"> · {error}</span>}
      </div>
      {gate && (blocks.length > 0 || gate.review.length > 0 || gate.notHeld.length > 0) && (
        <ul className="findings">
          {blocks.map((i, k) => <li key={`b${k}`} className="bad">{i.line ? `Line ${i.line}: ` : ''}{i.message}</li>)}
          {gate.review.map((m, k) => <li key={`r${k}`} className="warn">Needs approval: {m}</li>)}
          {gate.notHeld.map((m, k) => <li key={`n${k}`} className="warn">Not held in XPLAN: {m} (the text shows in the report until you remove it)</li>)}
        </ul>
      )}
      {running && site && <RunDialog template={template} title={title} site={site} onClose={() => setRunning(false)} />}
    </aside>
  )
}

/** Plain textarea with XMerge markers highlighted underneath (same font metrics, scroll kept in sync). */
function Editor({ value, readOnly, onChange }: { value: string; readOnly: boolean; onChange: (v: string) => void }) {
  const back = useRef<HTMLPreElement>(null)
  const parts = value.split(/(<:.*?:>)/g)
  return (
    <div className="editor">
      <pre ref={back} className="editor-back" aria-hidden="true">
        {parts.map((p, i) => (p.startsWith('<:') ? <span key={i} className={/^<:\s*(if|for|else|end|let)\b/.test(p) ? 'mk ctl' : 'mk'}>{p}</span> : <Fragment key={i}>{p}</Fragment>))}
        {'\n'}
      </pre>
      <textarea
        className="editor-front"
        value={value}
        readOnly={readOnly}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onScroll={(e) => { if (back.current) { back.current.scrollTop = e.currentTarget.scrollTop; back.current.scrollLeft = e.currentTarget.scrollLeft } }}
      />
    </div>
  )
}
