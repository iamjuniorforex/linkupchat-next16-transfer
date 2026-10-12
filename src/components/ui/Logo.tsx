import { useId } from 'react';
import { cn } from '@/lib/utils';

interface LogoProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  variant?: 'full' | 'icon' | 'wordmark';
  className?: string;
  /** Disable gradient text (e.g. on gradient backgrounds) */
  monochrome?: boolean;
}

const iconSizes = { sm: 28, md: 36, lg: 48, xl: 72 };

/**
 * LINKUPCHAT original identity: two interlocking chat bubbles forming
 * an abstract link/"L" inside a soft gradient squircle.
 */
export function LogoMark({ size = 'md', className }: { size?: keyof typeof iconSizes | number; className?: string }) {
  const px = typeof size === 'number' ? size : iconSizes[size];
  const uid = useId().replace(/:/g, '');
  const brand = `lg-brand-${uid}`;
  const spark = `lg-spark-${uid}`;
  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 64 64"
      fill="none"
      className={cn('shrink-0', className)}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={brand} x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
          <stop stopColor="#7357FF" />
          <stop offset="0.55" stopColor="#5B48E0" />
          <stop offset="1" stopColor="#22B8FF" />
        </linearGradient>
        <linearGradient id={spark} x1="18" y1="16" x2="46" y2="50" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFFFFF" />
          <stop offset="1" stopColor="#E8E9FF" />
        </linearGradient>
      </defs>
      {/* squircle — keep 2px clear inside the 64 viewBox */}
      <rect x="2" y="2" width="60" height="60" rx="18" fill={`url(#${brand})`} />
      {/* back bubble */}
      <path
        d="M20 18.5h18c3.6 0 6.5 2.9 6.5 6.5v8c0 3.6-2.9 6.5-6.5 6.5h-6.8l-5.4 4.4a1.6 1.6 0 0 1-2.6-1.26V39.5h-3.2c-3.6 0-6.5-2.9-6.5-6.5v-8c0-3.6 2.9-6.5 6.5-6.5Z"
        fill={`url(#${spark})`}
        opacity="0.95"
      />
      {/* front bubble with tail — the "link up" overlap */}
      <path
        d="M44 27h-4.2v9.6c0 3.2-2.6 5.8-5.8 5.8H25.6l-5.1 4.1c-1 .8-2.5.05-2.5-1.26V43h-1.5c-3.6 0-6.5-2.9-6.5-6.5v-7.2c0-3.6 2.9-6.5 6.5-6.5h2.2V27h-2.2c-3.6 0-6.5-2.9-6.5-6.5v-3C12.5 13.9 15.4 11 19 11h25c3.6 0 6.5 2.9 6.5 6.5V27H44Z"
        fill="#0C0E1A"
        opacity="0.18"
      />
      <path
        d="M43 31.5h-1.2V38c0 2.65-2.15 4.8-4.8 4.8h-7.02l-3.72 2.96c-1.03.82-2.54.09-2.54-1.24V43.8h-1.7c-2.65 0-4.8-2.15-4.8-4.8v-5.35c0-2.65 2.15-4.8 4.8-4.8h.2V31.5h-.2c-2.65 0-4.8-2.15-4.8-4.8v-3.05c0-2.65 2.15-4.8 4.8-4.8h17.1c2.65 0 4.8 2.15 4.8 4.8V31.5H43Z"
        fill="white"
      />
      {/* chat dots */}
      <circle cx="24" cy="24.4" r="2.1" fill="#5B48E0" />
      <circle cx="31" cy="24.4" r="2.1" fill="#5B48E0" />
      <circle cx="38" cy="24.4" r="2.1" fill="#22B8FF" />
    </svg>
  );
}

export function Logo({ size = 'md', variant = 'full', className, monochrome }: LogoProps) {
  const textSizes = { sm: 'text-base', md: 'text-xl', lg: 'text-2xl', xl: 'text-4xl' };
  const label = 'LINKUPCHAT';

  return (
    <div
      className={cn('inline-flex items-center gap-2.5 select-none', className)}
      aria-label={variant === 'icon' ? label : undefined}
    >
      {variant !== 'wordmark' && <LogoMark size={size} />}
      {variant !== 'icon' && (
        <span
          className={cn(
            'whitespace-nowrap font-display font-extrabold tracking-tight leading-none',
            textSizes[size],
            !monochrome && 'text-gradient'
          )}
          style={monochrome ? { color: 'currentColor' } : undefined}
        >
          LINKUP<span className={monochrome ? '' : 'opacity-90'}>CHAT</span>
        </span>
      )}
    </div>
  );
}
