import React, { useEffect } from 'react';

/**
 * High z-index toast so it appears above modals (e.g. custom proxy panel).
 */
export default function Toast({ message, onDismiss, tone = 'neutral' }) {
  useEffect(() => {
    if (!message) return undefined;
    const timer = setTimeout(() => onDismiss?.(), 6000);
    return () => clearTimeout(timer);
  }, [message, onDismiss]);

  if (!message) return null;

  const tones = {
    neutral: 'bg-brand-900 text-white border-brand-900',
    error: 'bg-red-600 text-white border-red-700',
    success: 'bg-emerald-600 text-white border-emerald-700'
  };

  const isError =
    /banned|incorrect|failed|could not|cannot|error|disabled|unavailable|timeout/i.test(
      message
    );
  const isSuccess = /saved|cleared|filled|opened|success/i.test(message);
  const style =
    tone !== 'neutral'
      ? tones[tone]
      : isError
        ? tones.error
        : isSuccess
          ? tones.success
          : tones.neutral;

  return (
    <div
      className="fixed bottom-6 left-1/2 z-[400] w-[min(92vw,26rem)] -translate-x-1/2 pointer-events-auto"
      role="status"
      aria-live="polite"
    >
      <div
        className={`flex items-start gap-3 rounded-2xl border px-4 py-3 shadow-2xl shadow-black/25 ${style}`}
      >
        <p className="flex-1 text-sm leading-snug pt-0.5 text-left">{message}</p>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDismiss?.();
          }}
          className="shrink-0 rounded-lg bg-white/15 hover:bg-white/25 px-2.5 py-1 text-xs font-medium transition"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
