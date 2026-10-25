import React, { useState } from 'react';

/** The backend refuses this app version until it updates. The updater is already fetching it. */
export default function UpdateRequired({ latestVersion, message, updateMsg, onRetry }) {
  const [checking, setChecking] = useState(false);
  const progress = typeof updateMsg?.percent === 'number' ? updateMsg.percent : null;

  const checkNow = async () => {
    setChecking(true);
    try {
      await window.api?.checkUpdate?.();
      if (onRetry) await onRetry();
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl bg-white shadow-lg border border-slate-200 p-6 text-center">
        <h2 className="text-lg font-semibold text-brand-900">Update required</h2>
        <p className="text-sm text-slate-600 mt-2">
          {message || 'This version of the app is out of date.'}
        </p>
        {latestVersion ? <p className="text-xs text-slate-500 mt-1">Latest version: {latestVersion}</p> : null}
        {updateMsg?.message ? <p className="text-sm text-slate-700 mt-4">{updateMsg.message}</p> : null}
        {progress != null ? (
          <div className="mt-3 h-2 rounded-full bg-slate-100 overflow-hidden">
            <div className="h-full bg-brand-600 transition-all" style={{ width: `${Math.min(100, progress)}%` }} />
          </div>
        ) : null}
        <button
          type="button"
          onClick={checkNow}
          disabled={checking}
          className="mt-5 w-full rounded-xl bg-brand-700 hover:bg-brand-600 text-white py-2.5 text-sm font-semibold disabled:opacity-60"
        >
          {checking ? 'Checking…' : 'Check for update'}
        </button>
      </div>
    </div>
  );
}
