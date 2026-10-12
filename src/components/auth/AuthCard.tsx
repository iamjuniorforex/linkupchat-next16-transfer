'use client';

import Link from 'next/link';
import { Logo } from '@/components/ui/Logo';
import { ThemeToggle } from '@/components/ui/ThemeToggle';

export function AuthCard({
  title,
  subtitle,
  children,
  footer
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <main className="relative flex min-h-[100dvh] items-center justify-center overflow-hidden px-4 py-10">
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -top-32 left-1/2 h-[520px] w-[820px] -translate-x-1/2 rounded-full opacity-[0.14] blur-3xl bg-brand-gradient" />
        <div className="absolute bottom-[-10%] right-[-10%] h-80 w-80 rounded-full bg-sky-500/15 blur-3xl" />
        <div className="absolute bottom-[-6%] left-[-8%] h-72 w-72 rounded-full bg-coral-500/12 blur-3xl" />
      </div>

      <div className="relative w-full max-w-[420px] animate-fade-up">
        <div className="absolute -top-1 right-0">
          <ThemeToggle />
        </div>
        <Link href="/" className="mb-8 flex justify-center" aria-label="LINKUPCHAT home">
          <Logo size="lg" />
        </Link>
        <div className="card p-7 sm:p-9">
          <h1 className="text-2xl font-extrabold tracking-tight text-ink">{title}</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">{subtitle}</p>
          <div className="mt-7">{children}</div>
        </div>
        {footer && <div className="mt-6 text-center text-sm text-muted">{footer}</div>}
      </div>
    </main>
  );
}
