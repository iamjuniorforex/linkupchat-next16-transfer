'use client';

import { useCallback, useEffect, useMemo, useState, createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, AlertCircle, Info, X, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

type ToastKind = 'success' | 'error' | 'info' | 'warning';

interface ToastItem {
  id: string;
  kind: ToastKind;
  title: string;
  description?: string;
}

interface ToastContextValue {
  toast: (kind: ToastKind, title: string, description?: string) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
  warning: (title: string, description?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const icons: Record<ToastKind, ReactNode> = {
  success: <CheckCircle2 className="h-5 w-5 text-mint-500" />,
  error: <AlertCircle className="h-5 w-5 text-coral-500" />,
  info: <Info className="h-5 w-5 text-sky-500" />,
  warning: <AlertTriangle className="h-5 w-5 text-gold-500" />
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (kind: ToastKind, title: string, description?: string) => {
      const id = Math.random().toString(36).slice(2);
      setItems((prev) => [...prev.slice(-3), { id, kind, title, description }]);
      window.setTimeout(() => dismiss(id), kind === 'error' ? 6000 : 4000);
    },
    [dismiss]
  );

  // Hydration-safe portal: render only after mount so the first client render
  // matches the server HTML (eliminates React #418/#423 on every page).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const value = useMemo<ToastContextValue>(
    () => ({
      toast,
      success: (t, d) => toast('success', t, d),
      error: (t, d) => toast('error', t, d),
      info: (t, d) => toast('info', t, d),
      warning: (t, d) => toast('warning', t, d)
    }),
    [toast]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {mounted &&
        createPortal(
          <div
            aria-live="polite"
            aria-atomic="false"
            /* Mobile/tablet (bottom nav visible until md): lift the bar fully
               above the h-nav footprint (safe-area + 4rem) so it can never
               swallow taps on bottom-nav buttons; md: restores the classic
               desktop bottom-right placement (nav is md:hidden). */
            className="toast-dock pointer-events-none fixed bottom-[calc(env(safe-area-inset-bottom,0px)+5rem)] left-1/2 z-[200] flex w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 flex-col gap-2 sm:bottom-[calc(env(safe-area-inset-bottom,0px)+5.5rem)] sm:left-auto sm:right-6 sm:translate-x-0 md:bottom-6"
          >
            {items.map((item) => (
              <div
                key={item.id}
                role={item.kind === 'error' ? 'alert' : 'status'}
                className="pointer-events-auto flex items-start gap-3 rounded-2xl border border-border bg-surface p-3.5 shadow-pop animate-fade-up"
              >
                <span className="mt-0.5">{icons[item.kind]}</span>
                <div className="flex-1">
                  <p className="text-sm font-semibold text-ink">{item.title}</p>
                  {item.description && <p className="mt-0.5 text-xs text-muted">{item.description}</p>}
                </div>
                <button
                  onClick={() => dismiss(item.id)}
                  aria-label="Dismiss notification"
                  className="icon-btn -mr-1 -mt-1 h-7 w-7"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>,
          document.body
        )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
