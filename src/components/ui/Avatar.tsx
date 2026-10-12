import { useState } from 'react';
import { cn, initials, avatarGradient } from '@/lib/utils';

interface AvatarProps {
  src?: string | null;
  name: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  online?: boolean;
  className?: string;
  ring?: boolean;
}

const sizeMap = {
  xs: 'h-7 w-7 text-[10px]',
  sm: 'h-9 w-9 text-xs',
  md: 'h-11 w-11 text-sm',
  lg: 'h-14 w-14 text-base',
  xl: 'h-20 w-20 text-xl',
  '2xl': 'h-28 w-28 text-3xl'
};

const dotMap = {
  xs: 'h-2 w-2 border',
  sm: 'h-2.5 w-2.5 border',
  md: 'h-3 w-3 border-2',
  lg: 'h-3.5 w-3.5 border-2',
  xl: 'h-4.5 w-4.5 border-2',
  '2xl': 'h-5 w-5 border-2'
};

export function Avatar({ src, name, size = 'md', online, className, ring }: AvatarProps) {
  const [broken, setBroken] = useState(false);
  const showImg = src && !broken;

  return (
    <div className={cn('relative inline-flex shrink-0', className)}>
      <div
        className={cn(
          'flex items-center justify-center overflow-hidden rounded-full font-semibold text-white',
          sizeMap[size],
          ring && 'ring-2 ring-surface'
        )}
        style={showImg ? undefined : { backgroundImage: avatarGradient(name || 'linkup') }}
      >
        {showImg ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={name}
            onError={() => setBroken(true)}
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <span aria-hidden>{initials(name || '?')}</span>
        )}
      </div>
      {online !== undefined && (
        <span
          aria-label={online ? 'Online' : 'Offline'}
          className={cn(
            'absolute bottom-0 right-0 rounded-full',
            dotMap[size],
            online ? 'border-surface bg-mint-500' : 'border-surface bg-faint'
          )}
        />
      )}
    </div>
  );
}
