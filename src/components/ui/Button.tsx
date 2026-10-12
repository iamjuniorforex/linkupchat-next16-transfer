import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: React.ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, icon, className, children, disabled, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-full font-semibold transition-all active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50',
        {
          'bg-brand-500 text-white shadow-soft hover:bg-brand-600': variant === 'primary',
          'border border-border bg-surface text-ink hover:bg-ink/[0.04] dark:hover:bg-white/[0.06]':
            variant === 'secondary',
          'text-ink hover:bg-ink/[0.06] dark:hover:bg-white/[0.08]': variant === 'ghost',
          'bg-coral-500 text-white hover:bg-coral-600': variant === 'danger',
          'border border-brand-500/40 bg-brand-500/[0.06] text-brand-600 hover:bg-brand-500/[0.12] dark:text-brand-300':
            variant === 'outline'
        },
        {
          'h-8 px-3 text-[13px]': size === 'sm',
          'h-10 px-5 text-sm': size === 'md',
          'h-12 px-7 text-[15px]': size === 'lg'
        },
        className
      )}
      {...props}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});
