import { useState } from 'react';

/** First-run setup and login screens. Monochrome, no dependencies. */

export function SetupScreen({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (pw !== pw2) { setError('passwords do not match'); return; }
    const r = await fetch('/api/auth/setup', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    }).then((x) => x.json());
    if (r?.error) { setError(r.error); return; }
    onDone();
  };
  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <h1>Flowforge</h1>
        <p className="muted">First run — set the owner password. Everything (workflows, credentials, approvals) hides behind it from here on.</p>
        <label className="field"><span>Password (min 8 chars)</span>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></label>
        <label className="field"><span>Repeat</span>
          <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" /></label>
        {error && <div className="error">{error}</div>}
        <button className="btn primary" type="submit">Set password &amp; enter</button>
      </form>
    </div>
  );
}

export function LoginScreen({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const r = await fetch('/api/auth/login', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    if (r.status === 429) { setError('too many attempts — wait a few minutes'); return; }
    const j = await r.json();
    if (j?.error) { setError(j.error); return; }
    setPw('');
    onDone();
  };
  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <h1>Flowforge</h1>
        <p className="muted">Owner password to enter.</p>
        <label className="field"><span>Password</span>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" autoFocus /></label>
        {error && <div className="error">{error}</div>}
        <button className="btn primary" type="submit">Log in</button>
      </form>
    </div>
  );
}
