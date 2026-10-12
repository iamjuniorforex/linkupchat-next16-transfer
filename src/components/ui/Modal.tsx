'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Hide the close button (e.g. call screens) */
  hideClose?: boolean;
  /** Prevent closing on backdrop click (destructive confirmations) */
  persistent?: boolean;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  size = 'md',
  hideClose,
  persistent
}: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusables = () =>
      Array.from(
        node?.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        ) ?? []
      ).filter((el) => !el.hasAttribute('disabled'));
    const first = focusables()[0] ?? node;
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !persistent) {
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !node) return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const start = items[0]!;
      const end = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === start) {
        e.preventDefault();
        end.focus();
      } else if (!e.shiftKey && document.activeElement === end) {
        e.preventDefault();
        start.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      previouslyFocused?.focus?.();
    };
  }, [open, onClose, persistent]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/45 p-0 backdrop-blur-[2px] sm:items-center sm:p-6 animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !persistent) onClose();
      }}
      role="presentation"
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          'relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-3xl bg-surface shadow-pop animate-scale-in sm:rounded-3xl',
          {
            'sm:max-w-sm': size === 'sm',
            'sm:max-w-md': size === 'md',
            'sm:max-w-lg': size === 'lg',
            'sm:max-w-2xl': size === 'xl'
          }
        )}
      >
        {(title || !hideClose) && (
          <div className="flex items-start justify-between gap-4 px-6 pb-2 pt-5">
            <div>
              {title && <h2 className="text-lg font-bold text-ink">{title}</h2>}
              {description && <p className="mt-1 text-sm text-muted">{description}</p>}
            </div>
            {!hideClose && (
              <button onClick={onClose} className="icon-btn -mr-1.5 -mt-1" aria-label="Close dialog">
                <X className="h-5 w-5" />
              </button>
            )}
          </div>
        )}
        <div className="scroll-thin flex-1 overflow-y-auto px-6 pb-6">{children}</div>
      </div>
    </div>,
    document.body
  );
}

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive,
  loading
}: ConfirmDialogProps) {
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm">
      <p className="text-sm leading-relaxed text-muted">{message}</p>
      <div className="mt-6 flex gap-3">
        <button
          data-testid="confirm-dialog-cancel"
          className="btn-secondary flex-1"
          onClick={onClose}
          disabled={loading}
        >
          {cancelLabel}
        </button>
        <button
          data-testid="confirm-dialog-confirm"
          className={cn('flex-1', destructive ? 'btn-danger' : 'btn-primary')}
          onClick={() => void onConfirm()}
          disabled={loading}
        >
          {loading ? 'Please wait…' : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
