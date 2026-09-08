'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { cn } from './primitives';

type Toast = { id: number; message: string; tone: 'success' | 'error' | 'info' };

const ToastContext = createContext<{ push: (message: string, tone?: Toast['tone']) => void }>({
  push: () => {},
});

export function useToast() {
  return useContext(ToastContext);
}

/** Minimal transient feedback; server actions report their outcome through it. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, tone }]);
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 5000);
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="status"
            className={cn(
              'pointer-events-auto max-w-sm rounded-md border px-3 py-2 text-sm shadow-lg',
              toast.tone === 'success' && 'border-positive-500/40 bg-ink-800 text-positive-400',
              toast.tone === 'error' && 'border-danger-500/40 bg-ink-800 text-danger-400',
              toast.tone === 'info' && 'border-ink-600 bg-ink-800 text-ink-200',
            )}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
