'use client';

import { cn } from '@/lib/utils';

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  description?: string;
  disabled?: boolean;
  id?: string;
}

export function Switch({ checked, onChange, label, description, disabled, id }: SwitchProps) {
  return (
    <div className="flex items-center justify-between gap-4">
      {(label || description) && (
        <div className="flex-1">
          {label && (
            <label htmlFor={id} className="block text-sm font-medium text-ink">
              {label}
            </label>
          )}
          {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
        </div>
      )}
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50',
          checked ? 'bg-brand-500' : 'bg-border-strong'
        )}
      >
        <span
          aria-hidden
          className={cn(
            'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform',
            checked ? 'translate-x-[22px]' : 'translate-x-0.5'
          )}
        />
      </button>
    </div>
  );
}

export function RadioCards<T extends string>({
  value,
  onChange,
  options
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; description?: string }[];
}) {
  return (
    <div role="radiogroup" className="grid gap-2">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            'flex items-start gap-3 rounded-2xl border p-3.5 text-left transition-colors',
            value === opt.value
              ? 'border-brand-500 bg-brand-500/[0.07]'
              : 'border-border hover:border-border-strong hover:bg-ink/[0.03] dark:hover:bg-white/[0.03]'
          )}
        >
          <span
            aria-hidden
            className={cn(
              'mt-0.5 flex h-4.5 w-4.5 items-center justify-center rounded-full border-2',
              value === opt.value ? 'border-brand-500' : 'border-border-strong'
            )}
          >
            {value === opt.value && <span className="h-2 w-2 rounded-full bg-brand-500" />}
          </span>
          <span>
            <span className="block text-sm font-medium text-ink">{opt.label}</span>
            {opt.description && <span className="mt-0.5 block text-xs text-muted">{opt.description}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}
