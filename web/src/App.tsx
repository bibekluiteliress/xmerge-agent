import { useEffect, useRef, useState } from 'react'
import { type FieldSource, type Gate, type Login, type RunEvent, type State, getState, logout, run } from './api'
import { DocumentPanel } from './DocumentPanel'
import { LoginScreen } from './LoginScreen'
import { Markdown } from './Markdown'
import { XwordDialog } from './XwordDialog'

type Step = { id: string; status: 'running' | 'done' | 'failed'; detail?: string }
type Turn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; steps: Step[]; design: string; notes: string; error?: string; done: boolean; calls?: number; gate?: Gate | null }

const STEP_LABEL: Record<string, string> = {
  design: 'Designing the report',
  fields: 'Matching XPLAN fields',
  write: 'Writing the template',
  revise: 'Updating the document',
  check: 'Checking the template',
  repair: 'Fixing what the checks found',
}

const STARTERS = [
  'A clear report for the client about their upcoming insurance payments: each policy, what is due, when, and how it is paid.',
  "An annual review letter: greeting by preferred name, the client's goals with target dates, assets and liabilities with totals and net worth, and a partner paragraph only if there is a partner.",
]

export function App() {
  const [fields, setFields] = useState<FieldSource | null>(null)
  const [login, setLogin] = useState<Login | null>(null)
  const [stage, setStage] = useState<'loading' | 'login' | 'app'>('loading')
  const [showXword, setShowXword] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [template, setTemplate] = useState<string | null>(null)
  const [gate, setGate] = useState<Gate | null>(null)
  const [title, setTitle] = useState('xmerge-template')
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

  const apply = (s: State) => {
    setFields(s.fields)
    setLogin(s.login)
  }

  const signOut = async () => {
    apply(await logout())
    newChat()
    setStage('login')
  }

  const update = (fn: (t: Extract<Turn, { role: 'assistant' }>) => void) =>
    setTurns((all) => {
      const copy = [...all]
      const last = { ...(copy[copy.length - 1] as Extract<Turn, { role: 'assistant' }>) }
      last.steps = [...last.steps]
      fn(last)
      copy[copy.length - 1] = last
      return copy
    })

  const onEvent = (e: RunEvent) => {
    if (e.kind === 'step') {
      if (!STEP_LABEL[e.step]) return
      update((t) => {
        // The check/repair loop reuses the step id; show each round as its own line.
        const open = t.steps.findLast((s) => s.id === e.step && s.status === 'running')
        if (e.status === 'running') {
          if (!open) t.steps.push({ id: e.step, status: 'running' })
        } else if (open) open.status = e.status === 'success' ? 'done' : 'failed'
      })
    } else if (e.kind === 'delta') {
      if (e.step === 'design') update((t) => void (t.design += e.text))
      else if (e.step === 'repair') update((t) => {
        if (!t.steps.some((s) => s.id === 'repair' && s.status === 'running')) t.steps.push({ id: 'repair', status: 'running' })
      })
    } else if (e.kind === 'info') {
      update((t) => {
        const s = t.steps.findLast((x) => x.id === e.step)
        if (!s) return
        if (e.step === 'fields' && e.summary) {
          const sm = e.summary as { points: number; areas: string[]; source: string; flags: string; flagErrors: string[] }
          s.detail = `${sm.points} data points from ${sm.source}${sm.areas.length ? `, lists: ${sm.areas.join(', ')}` : ''}` +
            (sm.flags !== 'standard' ? `; field flags ${sm.flags}` : '') + (sm.flagErrors.length ? ` (${sm.flagErrors.join('; ')})` : '')
        } else if (e.step === 'check') {
          s.detail = e.problems?.length ? `${e.problems.length} to fix` : 'passed'
          for (const r of t.steps) if (r.id === 'repair' && r.status === 'running') r.status = 'done'
        } else if (e.text) s.detail = e.text
      })
    } else if (e.kind === 'result') {
      update((t) => Object.assign(t, { notes: e.notes, calls: e.calls, gate: e.gate, done: true }))
      if (e.template) {
        setTemplate(e.template)
        setGate(e.gate)
        const h = /^#\s+(.+)$/m.exec(e.template)?.[1]
        if (h) setTitle(h.trim().replace(/[^\w]+/g, '-').toLowerCase().slice(0, 50))
      }
    } else if (e.kind === 'error') {
      update((t) => Object.assign(t, { error: e.message, done: true }))
    }
  }

  const send = async (text: string) => {
    const request = text.trim()
    if (!request || busy) return
    setInput('')
    setBusy(true)
    setTurns((t) => [...t, { role: 'user', text: request }, { role: 'assistant', steps: [], design: '', notes: '', done: false }])
    try {
      await run(request, template, onEvent)
    } catch (err) {
      update((t) => Object.assign(t, { error: (err as Error).message, done: true }))
    } finally {
      setBusy(false)
      update((t) => {
        t.done = true
        for (const s of t.steps) if (s.status === 'running') s.status = 'failed'
      })
    }
  }

  const newChat = () => {
    setTurns([])
    setTemplate(null)
    setGate(null)
  }

  if (stage === 'loading') return null
  if (stage === 'login') return <LoginScreen onSignedIn={(s) => { apply(s); setStage('app') }} onSkip={() => setStage('app')} />

  return (
    <div className={`app ${template !== null ? 'with-doc' : ''}`}>
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
              <p>Describe it in plain words. The assistant designs the document, fills in the XPLAN fields and checks it. You can then edit it, run it in XPLAN for a client and download it.</p>
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
                {t.notes && <div className="notes"><Markdown text={t.notes} /></div>}
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
            placeholder={template !== null ? 'Ask for a change to the document…' : 'Describe the report…'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input) } }}
            rows={2}
          />
          <button className="btn primary" disabled={busy || !input.trim()}>{busy ? 'Working…' : 'Send'}</button>
        </form>
      </main>

      {template !== null && (
        <DocumentPanel template={template} gate={gate} title={title} busy={busy} site={login?.site ?? null}
          onChange={setTemplate} onGate={setGate} onClose={() => setTemplate(null)} />
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
    </div>
  )
}
