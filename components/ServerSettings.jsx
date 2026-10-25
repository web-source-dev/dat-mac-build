import { useEffect, useRef, useState } from 'react';

const fieldClass =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 disabled:opacity-50';

function EyeIcon({ open }) {
  if (open) {
    return (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88"
        />
      </svg>
    );
  }
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"
      />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

/**
 * Hidden staff-only custom server panel (Ctrl+Shift+S).
 * URL persists across launches; switch turns it on/off without deleting.
 * Input never shows the saved URL.
 */
export default function ServerSettings({ snackMessage }) {
  const [phase, setPhase] = useState('closed');
  const [accessPassword, setAccessPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [serverInput, setServerInput] = useState('');
  const [showUrl, setShowUrl] = useState(false);
  const [hasSaved, setHasSaved] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const passwordInputRef = useRef(null);
  const urlInputRef = useRef(null);

  const lockAndClose = () => {
    setPhase('closed');
    setAccessPassword('');
    setAuthError('');
    setVerifying(false);
    setServerInput('');
    setShowUrl(false);
  };

  useEffect(() => {
    if (!window.api?.onToggleServerPanel) return undefined;
    return window.api.onToggleServerPanel(() => {
      setPhase((current) => {
        if (current === 'closed') {
          setAccessPassword('');
          setAuthError('');
          setServerInput('');
          setShowUrl(false);
          return 'auth';
        }
        setAccessPassword('');
        setAuthError('');
        setVerifying(false);
        setServerInput('');
        setShowUrl(false);
        return 'closed';
      });
    });
  }, []);

  useEffect(() => {
    if (phase === 'auth' && passwordInputRef.current) {
      passwordInputRef.current.focus();
    }
    if (phase === 'open' && urlInputRef.current) {
      urlInputRef.current.focus();
    }
  }, [phase]);

  useEffect(() => {
    if (phase !== 'open') return undefined;
    let cancelled = false;
    (async () => {
      try {
        const status = await window.api.getCustomServerStatus();
        if (!cancelled) {
          setHasSaved(Boolean(status?.hasSaved));
          setEnabled(Boolean(status?.enabled));
        }
      } catch {
        if (!cancelled) {
          setHasSaved(false);
          setEnabled(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase]);

  const handleUnlock = async (e) => {
    e?.preventDefault?.();
    if (!accessPassword.trim()) {
      setAuthError('Password required');
      return;
    }
    setVerifying(true);
    setAuthError('');
    try {
      const result = await window.api.verifyServerPanelPassword(accessPassword);
      if (!result?.success) {
        setAuthError(result?.message || 'Incorrect password');
        setAccessPassword('');
        return;
      }
      setAccessPassword('');
      setServerInput('');
      setShowUrl(false);
      setPhase('open');
    } catch (error) {
      setAuthError(error.message || 'Unable to verify password');
    } finally {
      setVerifying(false);
    }
  };

  const handleToggle = async (next) => {
    setSaving(true);
    try {
      if (next && !hasSaved) {
        const value = String(serverInput || '').trim();
        if (!value) {
          snackMessage('Enter a server URL first');
          return;
        }
        const result = await window.api.setCustomServer(value);
        if (!result?.success) {
          snackMessage(result?.message || 'Failed to save server');
          return;
        }
        setHasSaved(true);
        setEnabled(true);
        setServerInput('');
        setShowUrl(false);
        snackMessage('Custom server on');
        return;
      }

      const result = await window.api.setCustomServerEnabled(next);
      if (!result?.success) {
        snackMessage(result?.message || 'Failed to update');
        return;
      }
      setEnabled(Boolean(result.enabled));
      setHasSaved(Boolean(result.hasSaved));
      snackMessage(result.enabled ? 'Custom server on' : 'Custom server off');
    } catch (error) {
      snackMessage(error.message || 'Failed to update');
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    const value = String(serverInput || '').trim();
    if (!value) {
      snackMessage('Enter a server URL to apply');
      return;
    }
    setSaving(true);
    try {
      const result = await window.api.setCustomServer(value);
      if (!result?.success) {
        snackMessage(result?.message || 'Failed to save server');
        return;
      }
      setHasSaved(true);
      setEnabled(true);
      setServerInput('');
      setShowUrl(false);
      snackMessage('Custom server saved');
    } catch (error) {
      snackMessage(error.message || 'Failed to save server');
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setSaving(true);
    try {
      const result = await window.api.clearCustomServer();
      if (!result?.success) {
        snackMessage(result?.message || 'Failed to clear server');
        return;
      }
      setHasSaved(false);
      setEnabled(false);
      setServerInput('');
      setShowUrl(false);
      snackMessage('Custom server removed');
    } catch (error) {
      snackMessage(error.message || 'Failed to clear server');
    } finally {
      setSaving(false);
    }
  };

  if (phase === 'closed') return null;

  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={lockAndClose} />
      <div className="relative w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-2xl p-5 space-y-4 text-left">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold text-slate-900">
            {phase === 'auth' ? 'Access Required' : 'Custom Server'}
          </h2>
          <button
            type="button"
            onClick={lockAndClose}
            className="rounded-lg p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100"
            aria-label="Close"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {phase === 'auth' ? (
          <form onSubmit={handleUnlock} className="space-y-4">
            <div className="space-y-1.5">
              <input
                ref={passwordInputRef}
                type="password"
                value={accessPassword}
                onChange={(e) => {
                  setAccessPassword(e.target.value);
                  if (authError) setAuthError('');
                }}
                className={fieldClass}
                autoComplete="off"
                placeholder="Password"
              />
              {authError ? <p className="text-xs text-red-600 font-medium">{authError}</p> : null}
            </div>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={verifying}
                className="flex-1 py-2.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold disabled:opacity-50"
              >
                {verifying ? 'Verifying…' : 'Unlock'}
              </button>
              <button
                type="button"
                onClick={lockAndClose}
                className="py-2.5 px-4 rounded-lg border border-slate-200 text-sm text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
              <span className="text-sm font-medium text-slate-800">Use</span>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                disabled={saving}
                onClick={() => handleToggle(!enabled)}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
                  enabled ? 'bg-brand-600' : 'bg-slate-300'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${
                    enabled ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            <div className="relative">
              <input
                ref={urlInputRef}
                type={showUrl ? 'text' : 'password'}
                value={serverInput}
                onChange={(e) => setServerInput(e.target.value)}
                className={`${fieldClass} pr-11`}
                autoComplete="off"
                spellCheck={false}
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShowUrl((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100"
                aria-label={showUrl ? 'Hide server URL' : 'Show server URL'}
                title={showUrl ? 'Hide' : 'Show'}
              >
                <EyeIcon open={showUrl} />
              </button>
            </div>

            <div className="flex flex-col sm:flex-row gap-2">
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="flex-1 py-2.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              {hasSaved ? (
                <button
                  type="button"
                  onClick={handleClear}
                  disabled={saving}
                  className="py-2.5 px-4 rounded-lg border border-slate-200 text-sm text-slate-600 hover:bg-red-50 hover:border-red-200 hover:text-red-700 disabled:opacity-50"
                >
                  Clear
                </button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
