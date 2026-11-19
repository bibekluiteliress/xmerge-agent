import { useState } from 'react'
import { type State, login } from './api'

interface Props {
  onSignedIn: (s: State) => void
  onSkip: () => void
}

/** Sign in to an XPLAN site with the browser's XPLANID, once; XWord and Run in XPLAN then use it. */
export function LoginScreen({ onSignedIn, onSkip }: Props) {
  const [siteUrl, setSiteUrl] = useState(() => localGet('xms.siteUrl'))
  const [xplanid, setXplanid] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setMessage(null)
    try {
      localSet('xms.siteUrl', siteUrl)
      onSignedIn(await login(siteUrl, xplanid))
    } catch (err) {
      setMessage((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={(e) => { e.preventDefault(); void submit() }}>
        <div className="brand">XMerge Studio</div>
        <h1>Sign in to XPLAN</h1>
        <p className="muted">Use your browser session on the site. The studio then loads that site's fields and can merge reports there.</p>
        <label className="label" htmlFor="site">Site URL</label>
        <input id="site" className="field" placeholder="https://site.xplan.iress.online" value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} />
        <label className="label" htmlFor="xplanid">XPLANID cookie</label>
        <input id="xplanid" className="field" type="password" autoComplete="off" value={xplanid} onChange={(e) => setXplanid(e.target.value)} />
        <p className="hint">
          Log in to XPLAN in the browser, then copy it from DevTools › Application › Cookies › XPLANID. It is kept in
          this app's memory only, never saved, and dropped on sign-out or a restart.
        </p>
        {message && <div className="msgline bad">{message}</div>}
        <button className="btn primary wide" disabled={busy || !siteUrl || !xplanid}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <button type="button" className="btn ghost wide" onClick={onSkip}>Continue without a site</button>
      </form>
    </div>
  )
}

function localGet(k: string) {
  try { return localStorage.getItem(k) ?? '' } catch { return '' }
}
function localSet(k: string, v: string) {
  try { localStorage.setItem(k, v) } catch { /* private mode */ }
}
