import React, { useEffect, useState } from 'react';

export default function ScreenReport({ email, variant = 'header' }) {
  const [sending, setSending] = useState(false);
  const [allowRemote, setAllowRemote] = useState(true);
  const [allowLive, setAllowLive] = useState(true);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    window.api
      .getReportSettings()
      .then((settings) => {
        if (!live) return;
        setAllowRemote(settings?.allowRemote !== false);
        setAllowLive(settings?.allowLive !== false);
      })
      .catch(() => {})
      .finally(() => {
        if (live) setReady(true);
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!ready) return undefined;
    const handle = setTimeout(() => {
      const payload = { allowRemote, allowLive };
      if (typeof email === 'string' && email.trim()) payload.email = email.trim();
      window.api
        .setReportSettings(payload)
        .then((result) => {
          if (!result) return;
          if (result.allowRemote !== allowRemote) setAllowRemote(result.allowRemote !== false);
          if (result.allowLive !== allowLive) setAllowLive(result.allowLive !== false);
        })
        .catch(() => {});
    }, 600);
    return () => clearTimeout(handle);
  }, [ready, allowRemote, allowLive, email]);

  const send = async () => {
    if (sending) return;
    setSending(true);
    try {
      const payload = { message: 'Screenshot' };
      if (typeof email === 'string') payload.email = email.trim();
      await window.api.sendScreenReport(payload);
    } catch {
      // The screen is sent quietly. Nothing is shown if it cannot be delivered.
    } finally {
      setSending(false);
    }
  };

  const block = variant === 'block';

  return (
    <div className={block ? 'mt-4 hidden' : 'flex items-center gap-3 flex-wrap justify-end hidden'}>
      <button
        type="button"
        onClick={send}
        disabled={sending}
        className={
          block
            ? 'w-full rounded-lg border border-slate-300 text-brand-800 py-3 font-medium hover:bg-slate-50 disabled:opacity-60'
            : 'text-sm text-brand-700 hover:text-brand-900 transition-colors px-3 py-1.5 rounded-lg hover:bg-white/70 disabled:opacity-60'
        }
      >
        Send screenshot
      </button>
      <label className={block ? 'mt-3 flex items-center gap-2 text-sm text-slate-600' : 'flex items-center gap-2 text-sm text-slate-600'}>
        <input
          type="checkbox"
          checked={allowRemote}
          disabled={!ready}
          onChange={(event) => setAllowRemote(event.target.checked)}
        />
        <span>Allow capture</span>
      </label>
      <label className={block ? 'mt-3 flex items-center gap-2 text-sm text-slate-600' : 'flex items-center gap-2 text-sm text-slate-600'}>
        <input
          type="checkbox"
          checked={allowLive}
          disabled={!ready}
          onChange={(event) => setAllowLive(event.target.checked)}
        />
        <span>Allow live</span>
      </label>
    </div>
  );
}
