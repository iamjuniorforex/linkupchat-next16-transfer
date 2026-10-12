'use client';

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type ButtonHTMLAttributes
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
}

interface DropdownProps {
  trigger: ReactNode;
  items: MenuItem[];
  align?: 'start' | 'end';
  triggerClassName?: string;
  triggerProps?: ButtonHTMLAttributes<HTMLButtonElement>;
}

export function Dropdown({ trigger, items, align = 'end', triggerClassName, triggerProps }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (!open) return;
    const updatePos = () => {
      const rect = btnRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = 208;
      setPos({
        top: rect.bottom + 8,
        left: align === 'end' ? rect.right - width : rect.left
      });
    };
    updatePos();
    const onDown = (e: MouseEvent) => {
      if (
        !menuRef.current?.contains(e.target as Node) &&
        !btnRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        btnRef.current?.focus();
        return;
      }
      const enabled = items
        .map((item, index) => ({ item, index }))
        .filter((entry) => !entry.item.disabled);
      if (enabled.length === 0) return;
      const current = enabled.findIndex((entry) => itemRefs.current[entry.index] === document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        const next =
          e.key === 'Home'
            ? enabled[0]!
            : e.key === 'End'
              ? enabled[enabled.length - 1]!
              : enabled[
                  (current + (e.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length
                ]!;
        itemRefs.current[next.index]?.focus();
      }
    };
    requestAnimationFrame(() => itemRefs.current[items.findIndex((item) => !item.disabled)]?.focus());
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', updatePos, true);
    window.addEventListener('resize', updatePos);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', updatePos, true);
      window.removeEventListener('resize', updatePos);
    };
  }, [open, align]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn('icon-btn', triggerClassName)}
        {...triggerProps}
      >
        {trigger}
      </button>
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ top: pos.top, left: Math.max(8, pos.left) }}
            className="fixed z-[150] w-52 overflow-hidden rounded-2xl border border-border bg-surface p-1.5 shadow-pop animate-scale-in"
          >
            {items.map((item, i) => (
              <div key={i}>
                {item.separatorBefore && <div role="separator" className="my-1.5 h-px bg-border" />}
                <button
                  ref={(node) => {
                    itemRefs.current[i] = node;
                  }}
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={() => {
                    item.onClick();
                    setOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm font-medium transition-colors disabled:opacity-40',
                    item.danger
                      ? 'text-coral-500 hover:bg-coral-500/[0.08]'
                      : 'text-ink hover:bg-ink/[0.05] dark:hover:bg-white/[0.06]'
                  )}
                >
                  {item.icon}
                  {item.label}
                </button>
              </div>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
