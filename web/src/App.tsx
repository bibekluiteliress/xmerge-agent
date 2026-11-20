import { useCallback, useEffect, useRef, useState } from 'react'
import { type FieldSource, type Gate, type Login, type RunEvent, type State, getState, logout, run } from './api'
import { DocumentPanel, type Version } from './DocumentPanel'
import { LoginScreen } from './LoginScreen'
import { Markdown } from './Markdown'
import { XwordDialog } from './XwordDialog'

type Step = { id: string; status: 'running' | 'done' | 'failed'; detail?: string }
type Reply = { role: 'assistant'; steps: Step[]; design: string; live: string; notes: string; error?: string; done: boolean; calls?: number; gate?: Gate | null; version?: number }
type Turn = { role: 'user'; text: string } | Reply

const STEP_LABEL: Record<string, string> = {
  design: 'Designing the report',
  fields: 'Matching XPLAN fields',
  write: 'Writing the template',
  revise: 'Updating the document',
  check: 'Checking the template',
  repair: 'Fixing what the checks found',
}
const WRITING = new Set(['write', 'revise', 'repair']) // steps whose text is the template being written

const STARTERS = [
  "Client details: name, date of birth, contact details and address, with the partner's details if there is a partner.",
  "An annual review letter: greeting by preferred name, the client's goals with target dates, assets and liabilities with totals and net worth, and a partner paragraph only if there is a partner.",
]

/** The conversation and the document's versions, kept in this browser so a reload continues where it was. */
interface Session { turns: Turn[]; versions: Version[]; shown: number; template: string | null; title: string }
const SAVED = 'xms.session'

function loadSession(): Session | null {
  try {
    const s = JSON.parse(localStorage.getItem(SAVED) ?? 'null') as Session | null
    if (!s || !Array.isArray(s.turns) || !Array.isArray(s.versions)) return null
    // A run cannot survive a reload; show where it stopped.
    s.turns = s.turns.map((t) => (t.role === 'assistant' && !t.done ? { ...t, done: true, error: t.error ?? 'Interrupted by a page reload.' } : t))
    return s
  } catch {
    return null
  }
}

function saveSession(s: Session) {
  try {
    if (s.turns.length) localStorage.setItem(SAVED, JSON.stringify(s))
    else localStorage.removeItem(SAVED)
  } catch { /* private mode or full: the session just is not kept */ }
}

/** The template being streamed: what follows the last ```xmerge fence so far, up to its closing fence. */
function liveTemplate(text: string): string | null {
  const at = text.lastIndexOf('```xmerge')
  if (at < 0) return null
  const body = text.slice(text.indexOf('\n', at) + 1)
  const end = body.indexOf('```')
  return end >= 0 ? body.slice(0, end).replace(/\n$/, '') : body.replace(/\n?`{1,2}$/, '')
}
const liveNotes = (text: string) => text.split('```xmerge')[0].trim()

export function App() {
  const [fields, setFields] = useState<FieldSource | null>(null)
  const [login, setLogin] = useState<Login | null>(null)
  const [stage, setStage] = useState<'loading' | 'login' | 'app'>('loading')
  const [showXword, setShowXword] = useState(false)
  const saved = useRef(loadSession()).current
  const [turns, setTurns] = useState<Turn[]>(saved?.turns ?? [])
  const [versions, setVersions] = useState<Version[]>(saved?.versions ?? [])
  const [shown, setShown] = useState(saved?.shown ?? -1) // the version the document panel started from
  const [template, setTemplate] = useState<string | null>(saved?.template ?? null) // the working copy, with your edits
  const [title, setTitle] = useState(saved?.title ?? 'xmerge-template')
  const [gate, setGate] = useState<{ text: string; result: Gate } | null>(null)
  const [docOpen, setDocOpen] = useState(true)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [live, setLive] = useState<string | null>(null) // the template while the agent writes it
  const stop = useRef<AbortController | null>(null)
  const onGate = useCallback((text: string, result: Gate) => setGate({ text, result }), [])
  const chatEnd = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // The server keeps the sign-in, so a page reload goes straight back to the app.
    getState()
      .then((s) => { apply(s); setStage(s.login ? 'app' : 'login') })
      .catch(() => setStage('login'))
  }, [])
  useEffect(() => {
    void chatEnd.current?.scrollIntoView({ behavior: 'smooth' }) // newer browsers return a Promise; effects must not
  }, [turns])
  useEffect(() => saveSession({ turns, versions, shown, template, title }), [turns, versions, shown, template, title])

  const apply = (s: State) => {
    setFields(s.fields)
    setLogin(s.login)
  }

  const signOut = async () => {
    apply(await logout())
    newChat()
    setStage('login')
  }

  const update = (fn: (t: Reply) => void) =>
    setTurns((all) => {
      const copy = [...all]
      const last = { ...(copy[copy.length - 1] as Reply) }
      last.steps = [...last.steps]
      fn(last)
      copy[copy.length - 1] = last
      return copy
    })

  // Versions are added from the stream's callbacks, which see the state of the render that started the run,
  // so the list is also kept in a ref that is always current.
  const versionsRef = useRef<Version[]>(versions)
  const streamed = useRef('') // what the writer has sent so far in this step

  /** Add a version and show it; returns its index. */
  const addVersion = (v: Version) => {
    const all = [...versionsRef.current, v]
    versionsRef.current = all
    setVersions(all)
    setShown(all.length - 1)
    return all.length - 1
  }

  /** Open a version; unsaved edits are kept as a version first, so stepping away never loses them. */
  const openVersion = (i: number) => {
    const v = versionsRef.current[i]
    if (!v || busy) return
    if (template !== null && template !== versionsRef.current[shown]?.text) addVersion({ text: template, by: 'you' })
    setShown(i)
    setTemplate(v.text)
    setDocOpen(true)
  }

  const onEvent = (e: RunEvent) => {
    if (e.kind === 'step') {
      if (!STEP_LABEL[e.step]) return
      if (e.status === 'running' && WRITING.has(e.step)) streamed.current = ''
      update((t) => {
        // The check/repair loop reuses the step ids; each round is its own line.
        if (e.status === 'running') {
          t.steps.push({ id: e.step, status: 'running' })
          if (WRITING.has(e.step)) t.live = ''
        } else {
          const open = t.steps.findLast((s) => s.id === e.step && s.status === 'running')
          if (open) open.status = e.status === 'success' ? 'done' : 'failed'
        }
      })
    } else if (e.kind === 'delta') {
      if (e.step === 'design') update((t) => void (t.design += e.text))
      else if (WRITING.has(e.step)) {
        streamed.current += e.text
        const text = streamed.current
        update((t) => void (t.live = text))
        const doc = liveTemplate(text)
        if (doc !== null) setLive(doc)
      }
    } else if (e.kind === 'info') {
      update((t) => {
        const s = t.steps.findLast((x) => x.id === e.step)
        if (!s) return
        if (e.step === 'fields' && e.summary) {
          const sm = e.summary as { points: number; areas: string[]; source: string; flags: string; flagErrors: string[]; samples?: string[]; samplesError?: string; notAllowed?: string[] }
          s.detail = `${sm.points} data points from ${sm.source}${sm.areas.length ? `, lists: ${sm.areas.join(', ')}` : ''}` +
            (sm.flags !== 'standard' ? `; field flags ${sm.flags}` : '') + (sm.flagErrors.length ? ` (${sm.flagErrors.join('; ')})` : '') +
            (sm.samples?.length ? `; samples: ${sm.samples.join(', ')}` : '') + (sm.samplesError ? `; no samples (${sm.samplesError})` : '') +
            (sm.notAllowed?.length ? `; not allowed (sensitive): ${sm.notAllowed.join(', ')}` : '')
        } else if (e.step === 'check') {
          s.detail = e.text ?? (e.problems?.length ? `${e.problems.length} to fix` : 'passed')
        } else if (e.text) s.detail = e.text
      })
    } else if (e.kind === 'result') {
      setLive(null)
      let version: number | undefined
      if (e.template) {
        version = addVersion({ text: e.template, by: 'assistant' })
        setTemplate(e.template)
        if (e.gate) setGate({ text: e.template, result: e.gate })
        setDocOpen(true)
        const h = /^#\s+(.+)$/m.exec(e.template)?.[1]
        if (h) setTitle(h.trim().replace(/[^\w]+/g, '-').toLowerCase().slice(0, 50))
      }
      update((t) => Object.assign(t, { notes: e.notes, calls: e.calls, gate: e.gate, done: true, version }))
    } else if (e.kind === 'error') {
      update((t) => Object.assign(t, { error: e.message, done: true }))
    }
  }

  const send = async (text: string) => {
    const request = text.trim()
    if (!request || busy) return
    // Your own edits become a version first, so the change is made to what you see.
    if (template !== null && template !== versions[shown]?.text) addVersion({ text: template, by: 'you' })
    // Earlier requests as context, but not ones that failed (a refused prompt attack would be sent, and
    // blocked by the guardrail, again with every later request).
    const history = turns.flatMap((t, i) => {
      const reply = turns[i + 1]
      return t.role === 'user' && !(reply && reply.role !== 'user' && reply.error) ? [t.text] : []
    })
    setInput('')
    setBusy(true)
    setTurns((t) => [...t, { role: 'user', text: request }, { role: 'assistant', steps: [], design: '', live: '', notes: '', done: false }])
    const ctrl = new AbortController()
    stop.current = ctrl
    try {
      await run(request, template, history, onEvent, ctrl.signal)
    } catch (err) {
      const stopped = ctrl.signal.aborted
      update((t) => Object.assign(t, { error: stopped ? 'Stopped.' : (err as Error).message, done: true }))
    } finally {
      stop.current = null
      setBusy(false)
      setLive(null)
      update((t) => {
        t.done = true
        for (const s of t.steps) if (s.status === 'running') s.status = 'failed'
      })
    }
  }

  const newChat = () => {
    setTurns([])
    versionsRef.current = []
    setVersions([])
    setShown(-1)
    setTemplate(null)
    setGate(null)
    setDocOpen(true)
    setTitle('xmerge-template')
  }

  if (stage === 'loading') return null
  if (stage === 'login') return <LoginScreen onSignedIn={(s) => { apply(s); setStage('app') }} onSkip={() => setStage('app')} />

  const doc = live ?? template
  const panel = doc !== null && docOpen

  return (
    <div className={`app ${panel ? 'with-doc' : ''}`}>
      <header className="top">
        <div className="brand">XMerge Studio</div>
        <div className="top-actions">
          <span className={`chip ${fields?.kind === 'site' ? 'site' : ''}`}
            title={fields?.kind === 'site' ? `${fields.label}. Field flags: ${fields.flags === 'site' ? "the site's own" : 'standard list'}` : fields?.label}>
            {fields?.kind === 'site' ? `${fields.label} · ${fields.fields} fields` : 'Standard XPLAN fields'}
          </span>
          <button className="btn" onClick={() => setShowXword(true)}>Load XWord</button>
          {turns.length > 0 && <button className="btn ghost" onClick={newChat} disabled={busy}>New report</button>}
          {login ? (
            <span className="user" title={`${login.siteUrl}${login.user.role ? ` · ${login.user.role}` : ''}`}>
              {login.user.name ?? 'Signed in'} · {login.site}
              <button className="btn ghost small" onClick={signOut} disabled={busy}>Sign out</button>
            </span>
          ) : (
            <button className="btn ghost" onClick={() => setStage('login')}>Sign in</button>
          )}
        </div>
      </header>

      <main className="chat">
        <div className="thread">
          {turns.length === 0 && (
            <div className="empty">
              <h1>What report do you need?</h1>
              <p>Describe it in plain words. The assistant writes the template and checks it. Then keep talking to change it, or edit it yourself: every change is a new version you can go back to.</p>
              <div className="starters">
                {STARTERS.map((s) => <button key={s} className="starter" onClick={() => send(s)}>{s}</button>)}
              </div>
            </div>
          )}
          {turns.map((t, i) =>
            t.role === 'user' ? (
              <div key={i} className="msg user"><div className="bubble">{t.text}</div></div>
            ) : (
              <div key={i} className="msg assistant">
                <ul className="steps">
                  {t.steps.map((s, j) => (
                    <li key={j} className={s.status}>
                      <span className="dot" />{STEP_LABEL[s.id]}{s.detail ? <span className="detail"> · {s.detail}</span> : null}
                    </li>
                  ))}
                  {!t.done && t.steps.length === 0 && <li className="running"><span className="dot" />Starting</li>}
                </ul>
                {t.design && (
                  <details className="design" open={!t.done}>
                    <summary>Report design</summary>
                    <pre>{t.design.replace(/<\/?design>/g, '').trim()}</pre>
                  </details>
                )}
                {(t.notes || (!t.done && liveNotes(t.live))) && <div className="notes"><Markdown text={t.notes || liveNotes(t.live)} /></div>}
                {t.version !== undefined && versions[t.version] && (
                  <button className={`doc-card ${panel && shown === t.version ? 'active' : ''}`} onClick={() => openVersion(t.version!)} disabled={busy}>
                    <span className="doc-card-title">{title}</span>
                    <span className="doc-card-sub">Template · version {t.version + 1}</span>
                  </button>
                )}
                {t.done && t.gate && <Verdict gate={t.gate} />}
                {t.error && <div className="error">{t.error}</div>}
              </div>
            ),
          )}
          <div ref={chatEnd} />
        </div>
        <form className="composer" onSubmit={(e) => { e.preventDefault(); void send(input) }}>
          <textarea
            value={input}
            placeholder={template !== null ? 'Ask for a change, or ask about the document…' : 'Describe the report…'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input) } }}
            rows={2}
          />
          {busy
            ? <button type="button" className="btn" onClick={() => stop.current?.abort()}>Stop</button>
            : <button className="btn primary" disabled={!input.trim()}>Send</button>}
        </form>
      </main>

      {panel && (
        <DocumentPanel template={doc} streaming={live !== null} versions={versions} shown={shown} gate={gate?.text === doc ? gate.result : null}
          title={title} busy={busy} site={login?.site ?? null}
          onChange={setTemplate} onGate={onGate} onVersion={openVersion} onClose={() => setDocOpen(false)} />
      )}
      {doc !== null && !docOpen && (
        <button className="btn show-doc" onClick={() => setDocOpen(true)}>Show document</button>
      )}

      {showXword && <XwordDialog fields={fields} login={login} onClose={() => setShowXword(false)} onLoaded={setFields} />}
    </div>
  )
}

function Verdict({ gate }: { gate: Gate }) {
  const blocks = gate.problems.length
  return (
    <div className={`verdict ${blocks ? 'bad' : 'good'}`}>
      {blocks ? `${blocks} problem(s) still to fix — see the document panel.` : 'Checks passed. Run it in XPLAN on a test client to see the real document.'}
      {gate.review.length > 0 && ` ${gate.review.length} field(s) need approval.`}
      {gate.notHeld.length > 0 && ` Not held in XPLAN: ${gate.notHeld.join(', ')}.`}
      {(gate.notAllowed?.length ?? 0) > 0 && ` Not allowed (sensitive, left out): ${gate.notAllowed!.join(', ')}.`}
    </div>
  )
}
