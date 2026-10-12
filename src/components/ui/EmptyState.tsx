import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}

export function EmptyState({ icon, title, description, action, className, compact }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'mx-auto flex max-w-xs flex-col items-center justify-center text-center',
        compact ? 'gap-2 py-8' : 'gap-3 py-14',
        className
      )}
    >
      <div
        aria-hidden
        className={cn(
          'flex items-center justify-center rounded-3xl bg-brand-500/[0.08] text-brand-500',
          compact ? 'h-12 w-12' : 'h-16 w-16'
        )}
      >
        {icon}
      </div>
      <h3 className={cn('font-semibold text-ink', compact ? 'text-sm' : 'text-base')}>{title}</h3>
      {description && <p className="text-sm leading-relaxed text-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
