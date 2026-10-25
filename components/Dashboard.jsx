import React, { useState } from 'react';
import logo from '../assets/dat-logo.svg';
import ScreenReport from './ScreenReport';

export default function Dashboard({ user, onLogout, setMessage }) {
  const [opening, setOpening] = useState(false);

  const permissions = user?.permissions || {};
  const canOpenDat = permissions.openDat !== false;

  const openDat = async () => {
    if (!canOpenDat) {
      setMessage('Open DAT is disabled for your account.');
      return;
    }

    setOpening(true);
    setMessage('');
    try {
      const result = await window.api.openDat();
      // cancelled = the user closed the DAT window while it was opening
      if (!result?.success && !result?.cancelled) setMessage(result?.message || 'Could not open DAT. Please try again.');
    } catch (err) {
      setMessage(err);
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="min-h-screen relative overflow-hidden flex flex-col">
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden="true"
        style={{
          background:
            'radial-gradient(ellipse 80% 60% at 50% -10%, rgba(11,107,203,0.18), transparent 55%), radial-gradient(ellipse 50% 40% at 100% 100%, rgba(8,79,150,0.08), transparent 50%), linear-gradient(180deg, #f1f5f9 0%, #e8eef5 100%)'
        }}
      />
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden="true"
        style={{
          backgroundImage:
            'linear-gradient(rgba(10,47,87,0.14) 1px, transparent 1px), linear-gradient(90deg, rgba(10,47,87,0.14) 1px, transparent 1px)',
          backgroundSize: '40px 40px',
          maskImage: 'radial-gradient(ellipse 75% 65% at 50% 45%, black 20%, transparent 85%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 75% 65% at 50% 45%, black 20%, transparent 85%)'
        }}
      />

      <header className="relative z-10 flex items-center justify-end gap-1 px-6 py-5 flex-wrap">
        <ScreenReport />
        <button
          type="button"
          onClick={onLogout}
          className="text-sm text-slate-500 hover:text-slate-800 transition-colors px-3 py-1.5 rounded-lg hover:bg-white/60"
        >
          Log out
        </button>
      </header>

      <main className="relative z-10 flex-1 flex flex-col items-center justify-center px-6 pb-24">
        <div className="w-full max-w-2xl text-center">
          <div className="mb-12">
            <img
              src={logo}
              alt="Dat Desk"
              className="mx-auto h-14 w-auto max-w-full object-contain select-none bg-transparent"
              draggable={false}
            />
          </div>

          <div className="mx-auto max-w-sm">
          {canOpenDat ? (
            <button
              type="button"
              onClick={openDat}
              disabled={opening}
              className="group relative w-full overflow-hidden rounded-xl bg-brand-700 hover:bg-brand-600 active:bg-brand-900 text-white py-4 text-[15px] font-semibold tracking-wide shadow-lg shadow-brand-700/20 transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed hover:-translate-y-0.5 hover:shadow-xl hover:shadow-brand-700/25"
            >
              <span className="relative z-10 flex items-center justify-center gap-2">
                {opening ? (
                  <>
                    <span className="inline-block h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                    Opening…
                  </>
                ) : (
                  <>
                    Open DAT
                    <svg
                      className="h-4 w-4 opacity-80 transition-transform group-hover:translate-x-0.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path
                        d="M5 12h14M13 6l6 6-6 6"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </>
                )}
              </span>
            </button>
          ) : (
            <div className="rounded-xl border border-slate-200/80 bg-white/70 backdrop-blur px-4 py-4 text-sm text-slate-500">
              Access is disabled for this account
            </div>
          )}
          </div>
        </div>
      </main>
    </div>
  );
}
