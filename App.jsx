import React, { useCallback, useEffect, useState } from 'react';
import Login from './components/Login';
import Dashboard from './components/Dashboard';
import ProxySettings from './components/ProxySettings';
import ServerSettings from './components/ServerSettings';
import Toast from './components/Toast';
import UpdateRequired from './components/UpdateRequired';
import { friendlyMessage } from './utils/friendlyMessage';

function TerminalStatus() {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    let live = true;
    window.api
      ?.getTerminalStatus?.()
      .then((next) => {
        if (live) setStatus(next?.active ? next : null);
      })
      .catch(() => {});
    const off = window.api?.onTerminalStatus?.((next) => {
      setStatus(next?.active ? next : null);
    });
    return () => {
      live = false;
      if (typeof off === 'function') off();
    };
  }, []);

  if (!status) return null;
  const detail = [status.shell, status.host].filter(Boolean).join(' on ');
  return (
    <div>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [updateMsg, setUpdateMsg] = useState(null);
  /** Saved login kept, but the server could not be reached to confirm it. */
  const [unreachable, setUnreachable] = useState('');
  /** This version is refused by the server until the app updates: { message, latestVersion }. */
  const [outdated, setOutdated] = useState(null);

  const showMessage = useCallback((raw) => {
    if (raw === '' || raw == null) {
      setMessage('');
      return;
    }
    setMessage(friendlyMessage(raw));
  }, []);

  const dismissMessage = useCallback(() => {
    setMessage('');
  }, []);

  const forceLogout = useCallback(
    async (toastMessage) => {
      try {
        await window.api.logout();
      } catch {
        // ignore
      }
      setUser(null);
      if (toastMessage) showMessage(toastMessage);
    },
    [showMessage]
  );

  const loadCurrentUser = useCallback(async () => {
    try {
      const current = await window.api.getCurrentUser();
      if (current?.__unreachable) {
        setUnreachable(current.message || 'Cannot reach the Dat Desk server right now.');
        return;
      }
      setUnreachable('');
      if (current?.__outdated) {
        setOutdated({ message: current.message, latestVersion: current.latestVersion });
        return;
      }
      setOutdated(null);
      setUser(current?.__sessionReplaced ? null : current);
    } catch {
      setUnreachable('Cannot reach the Dat Desk server right now.');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    loadCurrentUser().finally(() => {
      if (!cancelled) setLoading(false);
    });

    const offSession = window.electron?.ipcRenderer?.on?.(
      'check-session',
      (_e, nextUser) => {
        setUser(nextUser);
      }
    );

    const offToast = window.electron?.ipcRenderer?.on?.('app-toast', (_e, payload) => {
      if (payload?.message) showMessage(payload.message);
    });

    const offReplaced = window.electron?.ipcRenderer?.on?.(
      'session-replaced',
      (_e, payload) => {
        forceLogout(
          payload?.message ||
            'You were signed out because your account signed in on another device.'
        );
      }
    );

    const offOutdated = window.electron?.ipcRenderer?.on?.('app-outdated', (_e, payload) => {
      setOutdated({ message: payload?.message, latestVersion: payload?.latestVersion });
    });

    const offUpdate = window.api?.onUpdateMsg?.((data) => {
      setUpdateMsg(data);
    });

    window.api?.getUpdateMsg?.().then((data) => {
      if (data) setUpdateMsg(data);
    }).catch(() => {});

    // Listeners are attached: collect messages sent while this window was closed
    // (the dashboard is closed while DAT is open) or still loading.
    window.electron?.ipcRenderer?.invoke?.('dashboard:ready')
      .then((pending) => {
        for (const { channel, payload } of pending || []) {
          if (channel === 'app-toast' && payload?.message) showMessage(payload.message);
          if (channel === 'app-outdated') setOutdated({ message: payload?.message, latestVersion: payload?.latestVersion });
          if (channel === 'session-replaced') {
            forceLogout(
              payload?.message ||
                'You were signed out because your account signed in on another device.'
            );
          }
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (typeof offSession === 'function') offSession();
      if (typeof offToast === 'function') offToast();
      if (typeof offReplaced === 'function') offReplaced();
      if (typeof offUpdate === 'function') offUpdate();
      if (typeof offOutdated === 'function') offOutdated();
    };
  }, [showMessage, forceLogout, loadCurrentUser]);

  // Refused as out of date: check again every minute (the update may have been skipped/failed).
  useEffect(() => {
    if (!outdated) return undefined;
    const id = setInterval(loadCurrentUser, 60 * 1000);
    return () => clearInterval(id);
  }, [outdated, loadCurrentUser]);

  // Server unreachable at startup: keep retrying quietly until it answers.
  useEffect(() => {
    if (!unreachable || user) return undefined;
    const id = setInterval(loadCurrentUser, 10 * 1000);
    return () => clearInterval(id);
  }, [unreachable, user, loadCurrentUser]);

  useEffect(() => {
    if (!user) return undefined;
    let stopped = false;

    const tick = async () => {
      try {
        const current = await window.api.getCurrentUser();
        if (stopped || current?.__unreachable) return; // server blip: stay signed in
        if (current?.__sessionReplaced) {
          setUser(null);
          return;
        }
        if (!current) setUser(null);
      } catch {
        // ignore
      }
    };

    const id = setInterval(tick, 10 * 60 * 1000); // 10 minutes — not every few seconds
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [user]);

  const logout = async () => {
    await window.api.logout();
    setUnreachable('');
    setUser(null);
  };

  const retryNow = async () => {
    setLoading(true);
    await loadCurrentUser();
    setLoading(false);
  };

  const updating =
    updateMsg &&
    ['available', 'downloading', 'downloaded'].includes(updateMsg.status);

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col">
        <TerminalStatus />
        <div className="flex-1 flex items-center justify-center text-slate-600">Loading…</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen relative">
      <TerminalStatus />
      {outdated && !updating ? (
        <UpdateRequired
          latestVersion={outdated.latestVersion}
          message={outdated.message}
          updateMsg={updateMsg}
          onRetry={loadCurrentUser}
        />
      ) : user ? (
        <Dashboard user={user} onLogout={logout} setMessage={showMessage} />
      ) : unreachable ? (
        <div className="min-h-screen flex items-center justify-center p-6">
          <div className="w-full max-w-sm rounded-2xl bg-white shadow-lg border border-slate-200 p-6 text-center">
            <h2 className="text-lg font-semibold text-brand-900">Reconnecting…</h2>
            <p className="text-sm text-slate-500 mt-2">{unreachable}</p>
            <p className="text-xs text-slate-400 mt-1">You are still signed in. Retrying every 10 seconds.</p>
            <button
              type="button"
              onClick={retryNow}
              className="mt-5 w-full rounded-xl bg-brand-700 hover:bg-brand-600 text-white py-2.5 text-sm font-semibold"
            >
              Retry now
            </button>
            <button
              type="button"
              onClick={logout}
              className="mt-2 w-full text-sm text-slate-500 hover:text-slate-800 py-2"
            >
              Sign in with another account
            </button>
          </div>
        </div>
      ) : (
        <Login onLoggedIn={setUser} setMessage={showMessage} />
      )}
      {user ? <ProxySettings loginUser={user} snackMessage={showMessage} /> : null}
      <ServerSettings snackMessage={showMessage} />
      <Toast message={message} onDismiss={dismissMessage} />

      {updating ? (
        <div className="fixed inset-0 z-[500] flex items-center justify-center bg-brand-900/55 backdrop-blur-sm p-6">
          <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl border border-slate-200 p-6 text-center">
            <div className="mx-auto mb-4 h-10 w-10 rounded-full border-2 border-brand-500/30 border-t-brand-600 animate-spin" />
            <h2 className="text-lg font-semibold text-brand-900">Updating Dat Desk</h2>
            <p className="text-sm text-slate-500 mt-2">{updateMsg.message}</p>
            {typeof updateMsg.percent === 'number' ? (
              <div className="mt-4 h-2 rounded-full bg-slate-100 overflow-hidden">
                <div
                  className="h-full bg-brand-600 transition-all"
                  style={{ width: `${Math.min(100, updateMsg.percent)}%` }}
                />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
