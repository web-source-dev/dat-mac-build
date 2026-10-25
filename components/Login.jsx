import React, { useRef, useState } from 'react';
import logo from '../assets/dat-logo.svg';
import ScreenReport from './ScreenReport';

export default function Login({ onLoggedIn, setMessage }) {
  const [email, setEmail] = useState(localStorage.getItem('email') || '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const credentials = useRef(null);

  const attempt = async () => {
    const creds = credentials.current;
    if (!creds) return null;
    return window.api.login(creds);
  };

  const finish = (result) => {
    credentials.current = null;
    setPassword('');
    onLoggedIn(result);
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      localStorage.setItem('email', email);
      credentials.current = { email, password };
      const result = await attempt();
      if (!result) return;
      if (result.outdated) {
        credentials.current = null;
        window.api?.checkUpdate?.();
        setMessage(result.message || 'Please update the app.');
        return;
      }
      if (!result || result.success === false) {
        credentials.current = null;
        setMessage(
          result?.isBanned || /banned/i.test(result?.message || '')
            ? 'Your account has been banned. Please contact an administrator.'
            : result?.message || 'Login failed'
        );
        return;
      }
      if (result?.isBanned) {
        setMessage('Your account has been banned. Please contact an administrator.');
        return;
      }
      finish(result);
    } catch (err) {
      setMessage(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-white/90 backdrop-blur border border-slate-200 shadow-xl rounded-2xl p-8">
      <form onSubmit={submit}>
        <div className="mb-8 text-center">
          <img
            src={logo}
            alt="Dat Desk"
            className="mx-auto h-10 w-auto object-contain mb-5 select-none"
            draggable={false}
          />
          <h1 className="text-2xl font-semibold text-brand-900">Sign in</h1>
          <p className="text-slate-500 mt-2 text-sm">Sign in to open DAT.</p>
        </div>

        <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full mb-4 rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:ring-2 focus:ring-brand-500"
          placeholder="you@example.com"
        />

        <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
        <input
          type="password"
          required
          minLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full mb-6 rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:ring-2 focus:ring-brand-500"
          placeholder="••••••••"
        />

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-brand-700 hover:bg-brand-900 text-white py-3 font-medium disabled:opacity-60"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <ScreenReport variant="block" email={email} setMessage={setMessage} />
      </div>
    </div>
  );
}
