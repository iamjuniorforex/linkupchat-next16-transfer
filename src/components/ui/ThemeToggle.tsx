'use client';

import { Moon, Sun } from 'lucide-react';
import { useTheme } from '@/context/ThemeProvider';
import { cn } from '@/lib/utils';

/** Switches between light and dark on this device. Does not change other settings. */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolved, setTheme } = useTheme();
  const toDark = resolved !== 'dark';
  return (
    <button
      type="button"
      className={cn('icon-btn', className)}
      aria-label={toDark ? 'Switch to dark theme' : 'Switch to light theme'}
      onClick={() => setTheme(toDark ? 'DARK' : 'LIGHT')}
    >
      {toDark ? <Moon className="h-4 w-4" aria-hidden /> : <Sun className="h-4 w-4" aria-hidden />}
    </button>
  );
}
