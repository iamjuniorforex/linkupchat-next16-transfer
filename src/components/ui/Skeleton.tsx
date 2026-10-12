import { cn } from '@/lib/utils';
import { Loader2 } from 'lucide-react';

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('skeleton rounded-lg', className)} />;
}

export function ChatListSkeleton() {
  return (
    <div className="space-y-1 p-3" aria-busy="true" aria-label="Loading conversations">
      {Array.from({ length: 7 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-2xl p-3">
          <Skeleton className="h-12 w-12 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3 w-48" />
          </div>
          <Skeleton className="h-3 w-10" />
        </div>
      ))}
    </div>
  );
}

export function MessageListSkeleton() {
  return (
    <div className="flex flex-1 flex-col justify-end gap-3 p-6" aria-busy="true" aria-label="Loading messages">
      {[true, false, true, true, false, true].map((isMine, i) => (
        <div key={i} className={cn('flex', isMine ? 'justify-end' : 'justify-start')}>
          <Skeleton className={cn('h-12 rounded-2xl', isMine ? 'w-52' : 'w-64')} />
        </div>
      ))}
    </div>
  );
}

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span role="status" aria-label={label ?? 'Loading'} className={cn('inline-flex items-center gap-2', className)}>
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      {label && <span className="text-sm text-muted">{label}</span>}
    </span>
  );
}

export function PageLoader({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex h-full min-h-[50vh] w-full items-center justify-center">
      <Spinner label={label} />
    </div>
  );
}
