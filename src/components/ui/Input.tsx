import {
  forwardRef,
  useState,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
  type SelectHTMLAttributes
} from 'react';
import { Eye, EyeOff, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string | null;
  hint?: string;
  icon?: React.ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, hint, icon, className, id, type, ...props },
  ref
) {
  const inputId = id ?? props.name;
  const [visible, setVisible] = useState(false);
  const isPassword = type === 'password';

  return (
    <div className="w-full">
      {label && (
        <label htmlFor={inputId} className="mb-1.5 block text-[13px] font-medium text-ink">
          {label}
        </label>
      )}
      <div className="relative">
        {icon && (
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint">{icon}</span>
        )}
        <input
          ref={ref}
          id={inputId}
          type={isPassword ? (visible ? 'text' : 'password') : type}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${inputId}-error` : undefined}
          className={cn(
            'input-base',
            icon && 'pl-10',
            isPassword && 'pr-11',
            error && 'border-coral-500 focus:border-coral-500 focus:ring-coral-500/25',
            className
          )}
          {...props}
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            aria-label={visible ? 'Hide password' : 'Show password'}
            className="absolute right-0.5 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full text-faint transition-colors hover:text-ink"
          >
            {visible ? <EyeOff className="h-4.5 w-4.5" /> : <Eye className="h-4.5 w-4.5" />}
          </button>
        )}
      </div>
      {error ? (
        <p id={`${inputId}-error`} role="alert" className="mt-1.5 flex items-center gap-1 text-xs text-coral-500">
          <AlertCircle className="h-3.5 w-3.5" aria-hidden /> {error}
        </p>
      ) : hint ? (
        <p className="mt-1.5 text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label?: string;
  error?: string | null;
}>(function Textarea({ label, error, className, id, ...props }, ref) {
  const inputId = id ?? props.name;
  return (
    <div className="w-full">
      {label && (
        <label htmlFor={inputId} className="mb-1.5 block text-[13px] font-medium text-ink">
          {label}
        </label>
      )}
      <textarea
        ref={ref}
        id={inputId}
        aria-invalid={Boolean(error)}
        className={cn('input-base min-h-[96px] resize-none', error && 'border-coral-500', className)}
        {...props}
      />
      {error && (
        <p role="alert" className="mt-1.5 text-xs text-coral-500">
          {error}
        </p>
      )}
    </div>
  );
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & {
  label?: string;
}>(function Select({ label, className, id, children, ...props }, ref) {
  const inputId = id ?? props.name;
  return (
    <div className="w-full">
      {label && (
        <label htmlFor={inputId} className="mb-1.5 block text-[13px] font-medium text-ink">
          {label}
        </label>
      )}
      <select ref={ref} id={inputId} className={cn('input-base appearance-none pr-8', className)} {...props}>
        {children}
      </select>
    </div>
  );
});
