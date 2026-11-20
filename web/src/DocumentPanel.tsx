import { Fragment, useEffect, useRef, useState } from 'react'
import { type Gate, checkTemplate, download } from './api'
import { RunDialog } from './RunDialog'

/** One saved state of the document: written by the agent, or your edits as they were when you sent a message. */
export interface Version {
  text: string
  by: 'assistant' | 'you'
}

interface Props {
  template: string // what the panel shows: the working copy, or the template while it is being written
  streaming: boolean
  versions: Version[]
  shown: number // the version the working copy started from
  gate: Gate | null // the checks for exactly this text, if known
  title: string
  busy: boolean
  site: string | null // the signed-in site, if any
  onChange: (t: string) => void
  onGate: (text: string, g: Gate) => void
  onVersion: (i: number) => void
  onClose: () => void
}

/** The document, like an artifact: edit it inline, step through its versions, download it or run it in XPLAN. */
export function DocumentPanel({ template, streaming, versions, shown, gate, title, busy, site, onChange, onGate, onVersion, onClose }: Props) {
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  // Check any text the checks have not seen yet (your edits, an older version), once typing stops.
  useEffect(() => {
    if (gate || streaming) return
    const id = setTimeout(async () => {
      setChecking(true)
      try {
        onGate(template, await checkTemplate(template))
        setError(null)
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setChecking(false)
      }
    }, 700)
    return () => clearTimeout(id)
  }, [template, gate, streaming, onGate])

  const save = async (format: 'docx' | 'txt') => {
    try {
      await download(template, format, title)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const blocks = gate?.check.issues.filter((i) => i.severity === 'block') ?? []
  const edited = !streaming && shown >= 0 && template !== versions[shown]?.text
  const locked = busy || streaming || !gate || blocks.length > 0

  return (
    <aside className="doc">
      <div className="doc-head">
        <div className="doc-title">
          {title}
          {versions.length > 0 && (
            <span className="versions">
              <button className="btn ghost icon small" onClick={() => onVersion(shown - 1)} disabled={busy || shown <= 0} aria-label="Previous version">‹</button>
              {streaming ? 'Writing…' : `Version ${shown + 1} of ${versions.length}${versions[shown]?.by === 'you' ? ' · your edits' : ''}`}
              <button className="btn ghost icon small" onClick={() => onVersion(shown + 1)} disabled={busy || shown >= versions.length - 1} aria-label="Next version">›</button>
            </span>
          )}
          {edited && <span className="edited" title="Your next message changes this text; it is saved as a version when you send it">edited</span>}
        </div>
        <div className="doc-actions">
          <button className="btn primary" onClick={() => setRunning(true)} disabled={!site || locked || checking}
            title={!site ? 'Sign in to a site first' : blocks.length ? 'Fix the problems first' : `Merge this template for one client on ${site}`}>Run in XPLAN</button>
          <button className="btn" onClick={() => save('docx')} disabled={locked} title={blocks.length ? 'Fix the problems first' : 'Word document for XPLAN'}>Download .docx</button>
          <button className="btn ghost" onClick={() => save('txt')} disabled={streaming}>.txt</button>
          <button className="btn ghost icon" onClick={onClose} aria-label="Close document">✕</button>
        </div>
      </div>

      <div className="doc-body">
        <Editor value={template} readOnly={busy || streaming} onChange={onChange} />
      </div>

      <div className={`status ${blocks.length ? 'bad' : gate ? 'good' : ''}`}>
        {streaming ? 'The assistant is writing…' : checking ? 'Checking…' : !gate ? 'Not checked yet' : blocks.length ? `${blocks.length} problem(s) to fix` : 'Checks passed'}
        {gate && gate.review.length > 0 && <span> · {gate.review.length} need approval</span>}
        {gate && gate.notHeld.length > 0 && <span> · {gate.notHeld.length} not held in XPLAN</span>}
        {gate && (gate.notAllowed?.length ?? 0) > 0 && <span> · {gate.notAllowed!.length} not allowed</span>}
        {error && <span className="err"> · {error}</span>}
      </div>
      {gate && !streaming && (blocks.length > 0 || gate.review.length > 0 || gate.notHeld.length > 0 || (gate.notAllowed?.length ?? 0) > 0) && (
        <ul className="findings">
          {blocks.map((i, k) => <li key={`b${k}`} className="bad">{i.line ? `Line ${i.line}: ` : ''}{i.message}</li>)}
          {gate.review.map((m, k) => <li key={`r${k}`} className="warn">Needs approval: {m}</li>)}
          {gate.notHeld.map((m, k) => <li key={`n${k}`} className="warn">Not held in XPLAN: {m} (the text shows in the report until you remove it)</li>)}
          {(gate.notAllowed ?? []).map((m, k) => <li key={`x${k}`} className="warn">Not allowed: {m} is a sensitive field, so AI templates never show it (the text shows in the report until you remove it)</li>)}
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
