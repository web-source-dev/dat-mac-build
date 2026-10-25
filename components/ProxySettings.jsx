import { useEffect, useRef, useState } from 'react';

const emptyForm = {
  enabled: false,
  host: '',
  port: '',
  username: '',
  password: ''
};

function parseProxyPaste(value) {
  const parts = String(value || '').trim().split(':');
  if (parts.length < 2) return null;
  const host = parts[0];
  const port = parts[1];
  if (!host || !port || Number.isNaN(Number(port))) return null;
  return {
    host,
    port,
    username: parts[2] || '',
    password: parts.slice(3).join(':') || ''
  };
}

const fieldClass =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 disabled:opacity-50';

/**
 * Hidden staff-only custom proxy panel.
 * Open/close via Ctrl+Shift+P. Password required each time.
 */
export default function ProxySettings({ loginUser, snackMessage }) {
  const [phase, setPhase] = useState('closed');
  const [accessPassword, setAccessPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [hasPassword, setHasPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pasteValue, setPasteValue] = useState('');
  const passwordInputRef = useRef(null);

  const lockAndClose = () => {
    setPhase('closed');
    setAccessPassword('');
    setAuthError('');
    setVerifying(false);
    setPasteValue('');
  };

  useEffect(() => {
    if (!window.api?.onToggleProxyPanel) return undefined;
    return window.api.onToggleProxyPanel(() => {
      setPhase((current) => {
        if (current === 'closed') {
          setAccessPassword('');
          setAuthError('');
          return 'auth';
        }
        setAccessPassword('');
        setAuthError('');
        setVerifying(false);
        setPasteValue('');
        return 'closed';
      });
    });
  }, []);

  useEffect(() => {
    if (phase === 'auth' && passwordInputRef.current) {
      passwordInputRef.current.focus();
    }
  }, [phase]);

  const loadProxy = async () => {
    setLoading(true);
    try {
      const result = await window.api.getUserProxy();
      if (result?.success && result.proxy) {
        const p = result.proxy;
        setForm({
          enabled: Boolean(p.enabled),
          host: p.host || '',
          port: p.port === 0 || p.port === '0' ? '' : p.port ?? '',
          username: p.username || '',
          password: p.password || ''
        });
        setHasPassword(Boolean(p.hasPassword || p.password));
      } else if (loginUser?.customProxy) {
        const cp = loginUser.customProxy;
        setForm({
          enabled: Boolean(cp.enabled),
          host: cp.host || '',
          port: cp.port || '',
          username: cp.username || '',
          password: cp.password || ''
        });
        setHasPassword(Boolean(cp.password));
      }
    } catch (error) {
      console.error('[ProxySettings] load failed:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (phase === 'open') loadProxy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, loginUser?._id]);

  const handleUnlock = async (e) => {
    e?.preventDefault?.();
    if (!accessPassword.trim()) {
      setAuthError('Password required');
      return;
    }
    setVerifying(true);
    setAuthError('');
    try {
      const result = await window.api.verifyProxyPanelPassword(accessPassword);
      if (!result?.success) {
        setAuthError(result?.message || 'Incorrect password');
        setAccessPassword('');
        return;
      }
      setAccessPassword('');
      setPhase('open');
    } catch (error) {
      setAuthError(error.message || 'Unable to verify password');
    } finally {
      setVerifying(false);
    }
  };

  const updateField = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleApplyPaste = () => {
    const parsed = parseProxyPaste(pasteValue);
    if (!parsed) {
      snackMessage('Paste format: host:port:username:password');
      return;
    }
    setForm({
      enabled: true,
      host: parsed.host,
      port: parsed.port,
      username: parsed.username,
      password: parsed.password
    });
    setHasPassword(Boolean(parsed.password));
    setPasteValue('');
    snackMessage('Proxy fields filled from paste');
  };

  const handleSave = async () => {
    const host = String(form.host || '').trim();
    const port = parseInt(form.port, 10);

    if (form.enabled && (!host || !Number.isFinite(port) || port <= 0)) {
      snackMessage('Enter a valid host and port to enable your proxy');
      return;
    }

    setSaving(true);
    try {
      const result = await window.api.setUserProxy({
        enabled: Boolean(form.enabled),
        host,
        port: Number.isFinite(port) ? port : 0,
        username: String(form.username || '').trim(),
        password: form.password
      });
      if (!result?.success) {
        snackMessage(result?.message || 'Failed to save proxy');
        return;
      }
      setHasPassword(Boolean(result.proxy?.hasPassword || result.proxy?.password || form.password));
      snackMessage(
        result.proxy?.usingCustom || result.proxy?.enabled
          ? 'Custom proxy saved — re-open DAT to apply'
          : 'Custom proxy disabled — re-open DAT to use assigned proxy'
      );
    } catch (error) {
      snackMessage(error.message || 'Failed to save proxy');
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setSaving(true);
    try {
      const result = await window.api.clearUserProxy();
      if (!result?.success) {
        snackMessage(result?.message || 'Failed to clear proxy');
        return;
      }
      setForm(emptyForm);
      setHasPassword(false);
      setPasteValue('');
      snackMessage('Custom proxy cleared — re-open DAT to apply');
    } catch (error) {
      snackMessage(error.message || 'Failed to clear proxy');
    } finally {
      setSaving(false);
    }
  };

  if (phase === 'closed') return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={lockAndClose} />
      <div className="relative w-full max-w-lg rounded-2xl border border-slate-200 bg-white shadow-2xl p-5 space-y-4 text-left">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              {phase === 'auth' ? 'Access Required' : 'Custom Proxy'}
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              {phase === 'auth'
                ? 'Enter the staff password to continue'
                : 'Per-user override — saved to this account only'}
            </p>
          </div>
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
              <label className="block text-xs font-medium text-slate-500">Password</label>
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
                placeholder="Enter access password"
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
        ) : loading ? (
          <p className="text-sm text-slate-500 text-center py-6">Loading proxy settings…</p>
        ) : (
          <>
            <label className="flex items-center gap-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => updateField('enabled', e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              <span className="text-sm text-slate-800">Use custom proxy for DAT</span>
            </label>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-500">Paste full proxy (optional)</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={pasteValue}
                  onChange={(e) => setPasteValue(e.target.value)}
                  placeholder="host:port:username:password"
                  className={fieldClass}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  onClick={handleApplyPaste}
                  className="px-4 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-sm whitespace-nowrap"
                >
                  Apply
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5 col-span-2 sm:col-span-1">
                <label className="block text-xs font-medium text-slate-500">Host</label>
                <input
                  type="text"
                  value={form.host}
                  onChange={(e) => updateField('host', e.target.value)}
                  placeholder="1.2.3.4"
                  className={fieldClass}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="space-y-1.5 col-span-2 sm:col-span-1">
                <label className="block text-xs font-medium text-slate-500">Port</label>
                <input
                  type="number"
                  value={form.port}
                  onChange={(e) => updateField('port', e.target.value)}
                  placeholder="8080"
                  className={fieldClass}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5 col-span-2 sm:col-span-1">
                <label className="block text-xs font-medium text-slate-500">Username</label>
                <input
                  type="text"
                  value={form.username}
                  onChange={(e) => updateField('username', e.target.value)}
                  placeholder="optional"
                  className={fieldClass}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="space-y-1.5 col-span-2 sm:col-span-1">
                <label className="block text-xs font-medium text-slate-500">
                  Password{hasPassword && !form.password ? ' (saved)' : ''}
                </label>
                <input
                  type="password"
                  value={form.password}
                  onChange={(e) => updateField('password', e.target.value)}
                  placeholder={hasPassword ? 'Leave blank to keep current' : 'optional'}
                  className={fieldClass}
                  autoComplete="new-password"
                />
              </div>
            </div>

            <p className="text-xs text-slate-500 leading-relaxed">
              Re-open DAT after changing. Closing this panel locks it again.
            </p>

            <div className="flex flex-col sm:flex-row gap-2">
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="flex-1 py-2.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save Proxy'}
              </button>
              <button
                type="button"
                onClick={handleClear}
                disabled={saving}
                className="py-2.5 px-4 rounded-lg border border-slate-200 text-sm text-slate-600 hover:bg-red-50 hover:border-red-200 hover:text-red-700 disabled:opacity-50"
              >
                Clear
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
