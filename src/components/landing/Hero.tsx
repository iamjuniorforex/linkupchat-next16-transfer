'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Menu, MessageCircle, Phone, Video, Shield, Zap, Sparkles, X } from 'lucide-react';
import { Logo } from '@/components/ui/Logo';
import { ThemeToggle } from '@/components/ui/ThemeToggle';

const NAV = [
  { href: '#features', label: 'Features' },
  { href: '#privacy', label: 'Privacy' },
  { href: '#experience', label: 'Experience' }
];

export function LandingNavbar() {
  const [open, setOpen] = useState(false);
  return (
    <header className="fixed inset-x-0 top-0 z-50 px-3 pt-3">
      <div className="glass mx-auto flex h-14 max-w-6xl items-center justify-between gap-2 rounded-full px-3 sm:px-5">
        <Link href="/" aria-label="LINKUPCHAT home" className="min-w-0">
          <Logo size="sm" className="max-[379px]:hidden" />
          <Logo size="sm" variant="icon" className="min-[380px]:hidden" />
        </Link>
        <nav className="hidden items-center gap-7 text-sm font-medium text-muted md:flex" aria-label="Main">
          {NAV.map((item) => (
            <a key={item.href} href={item.href} className="rounded-full px-1 py-1 transition-colors hover:text-ink">
              {item.label}
            </a>
          ))}
        </nav>
        <div className="flex shrink-0 items-center gap-1.5">
          <ThemeToggle />
          <button
            type="button"
            className="icon-btn md:hidden"
            aria-expanded={open}
            aria-controls="landing-menu"
            aria-label={open ? 'Close menu' : 'Open menu'}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <X className="h-4 w-4" aria-hidden /> : <Menu className="h-4 w-4" aria-hidden />}
          </button>
          <Link href="/login" className="btn-secondary h-9 px-3 text-[13px] sm:px-4">
            Log in
          </Link>
          <Link href="/register" className="btn-primary hidden h-9 px-4 text-[13px] min-[380px]:inline-flex">
            Get Started
          </Link>
        </div>
      </div>
      {open && (
        <nav
          id="landing-menu"
          aria-label="Mobile"
          className="glass mx-auto mt-2 flex max-w-6xl flex-col gap-1 rounded-2xl p-2 md:hidden"
        >
          {NAV.map((item) => (
            <a
              key={item.href}
              href={item.href}
              onClick={() => setOpen(false)}
              className="rounded-xl px-3 py-3 text-sm font-semibold text-ink hover:bg-ink/[0.05] dark:hover:bg-white/[0.06]"
            >
              {item.label}
            </a>
          ))}
          <Link href="/register" className="btn-primary mx-1 mb-1 mt-1 h-11" onClick={() => setOpen(false)}>
            Get Started
          </Link>
        </nav>
      )}
    </header>
  );
}

function FloatingBadge({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div
      className={`glass absolute hidden items-center gap-2 rounded-2xl px-3.5 py-2.5 text-xs font-semibold text-ink shadow-card lg:flex ${className ?? ''}`}
    >
      {children}
    </div>
  );
}

export function Hero() {
  return (
    <section className="relative overflow-hidden pb-20 pt-32 sm:pt-36">
      {/* decorative gradient orbs */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -top-24 left-1/2 h-[560px] w-[900px] -translate-x-1/2 rounded-full opacity-[0.16] blur-3xl bg-brand-gradient" />
        <div className="absolute right-[-10%] top-40 h-80 w-80 rounded-full bg-sky-500/20 blur-3xl" />
        <div className="absolute left-[-8%] top-64 h-72 w-72 rounded-full bg-coral-500/15 blur-3xl" />
      </div>

      <div className="relative mx-auto grid max-w-6xl items-center gap-16 px-6 lg:grid-cols-2">
        <div className="animate-fade-up text-center lg:text-left">
          <span className="inline-flex items-center gap-2 rounded-full border border-brand-500/25 bg-brand-500/[0.07] px-3.5 py-1.5 text-xs font-semibold text-brand-600 dark:text-brand-300">
            <Sparkles className="h-3.5 w-3.5" aria-hidden />
            Meet LINKUPCHAT
          </span>
          <h1 className="mt-6 text-4xl font-extrabold leading-[1.06] tracking-tight text-ink sm:text-5xl lg:text-[3.65rem]">
            Stay connected.
            <br />
            <span className="text-gradient">Link up.</span>
          </h1>
          <p className="mx-auto mt-5 max-w-md text-lg leading-relaxed text-muted lg:mx-0">
            Simple, fast and modern messaging for the people who matter — chats, groups, calls and
            status updates in one beautifully crafted app.
          </p>
          <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row lg:justify-start">
            <Link
              href="/register"
              className="btn-primary h-12 w-full px-8 text-[15px] shadow-glow sm:w-auto"
            >
              Get Started
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
            <Link href="/login" className="btn-secondary h-12 w-full px-8 text-[15px] sm:w-auto">
              Log In
            </Link>
          </div>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-x-7 gap-y-3 text-xs font-medium text-muted lg:justify-start">
            <span className="inline-flex items-center gap-1.5">
              <Zap className="h-4 w-4 text-brand-500" aria-hidden /> Real-time messaging
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Shield className="h-4 w-4 text-mint-500" aria-hidden /> Privacy first
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Video className="h-4 w-4 text-coral-500" aria-hidden /> Voice &amp; video calls
            </span>
          </div>
        </div>

        {/* Chat showcase mockup */}
        <div className="relative mx-auto w-full max-w-[340px] animate-fade-up sm:max-w-sm lg:max-w-none">
          <div className="relative rounded-[2rem] border border-white/50 bg-surface p-3 shadow-pop dark:border-white/10">
            <div className="chat-wallpaper overflow-hidden rounded-[1.45rem]">
              <div className="flex items-center gap-3 border-b border-border/60 bg-surface/85 px-4 py-3.5 backdrop-blur">
                <div className="h-9 w-9 rounded-full bg-brand-gradient" aria-hidden />
                <div>
                  <p className="text-sm font-bold text-ink">Sophia</p>
                  <p className="flex items-center gap-1 text-[11px] text-mint-500">
                    <span className="h-1.5 w-1.5 rounded-full bg-mint-500" aria-hidden /> Online
                  </p>
                </div>
                <div className="ml-auto flex gap-1 text-muted">
                  <Phone className="h-4 w-4" aria-hidden />
                  <Video className="h-4 w-4" aria-hidden />
                </div>
              </div>
              <div className="flex flex-col gap-2.5 p-4">
                <div className="max-w-[78%] rounded-2xl rounded-tl-md border border-border/60 bg-surface px-3.5 py-2.5 text-[13px] text-ink shadow-soft">
                  Hey! Are we still on for tonight?
                </div>
                <div className="max-w-[78%] self-end rounded-2xl rounded-tr-md bg-bubble-out px-3.5 py-2.5 text-[13px] text-white">
                  Absolutely! Can&apos;t wait 🎉
                </div>
                <div className="max-w-[78%] rounded-2xl rounded-tl-md border border-border/60 bg-surface px-3.5 py-2.5 text-[13px] text-ink shadow-soft">
                  Bringing the whole crew — it&apos;s going to be fun
                </div>
                <div className="max-w-[78%] self-end rounded-2xl rounded-tr-md bg-bubble-out px-3.5 py-2.5 text-[13px] text-white">
                  Link up at 8? 🚀
                  <div className="mt-1 flex justify-end gap-0.5 text-[10px] text-white/80">
                    <svg width="14" height="10" viewBox="0 0 16 11" fill="none" aria-hidden>
                      <path d="M1 5.8 4.2 9 10 2.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                      <path d="M6 5.8 9.2 9 15 2.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </div>
                </div>
                <div className="flex items-center gap-2 self-end rounded-full bg-brand-500/[0.12] px-3 py-1.5">
                  <span className="flex gap-1" aria-hidden>
                    <span className="h-1.5 w-1.5 animate-typing-dot rounded-full bg-brand-500" />
                    <span className="h-1.5 w-1.5 animate-typing-dot rounded-full bg-brand-500 [animation-delay:0.15s]" />
                    <span className="h-1.5 w-1.5 animate-typing-dot rounded-full bg-brand-500 [animation-delay:0.3s]" />
                  </span>
                  <span className="text-[11px] font-medium text-brand-600 dark:text-brand-300">Sophia is typing…</span>
                </div>
              </div>
              <div className="flex items-center gap-2 border-t border-border/60 bg-surface/85 px-4 py-3">
                <div className="flex-1 rounded-full border border-border bg-bg px-4 py-2 text-xs text-faint">
                  Message…
                </div>
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-500 text-white">
                  <MessageCircle className="h-4 w-4" aria-hidden />
                </div>
              </div>
            </div>
          </div>

          <FloatingBadge className="left-[-64px] top-16 motion-safe:animate-float">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-mint-500/15 text-mint-500">
              <Shield className="h-3.5 w-3.5" aria-hidden />
            </span>
            Private by design
          </FloatingBadge>
          <FloatingBadge className="right-[-70px] bottom-24 motion-safe:animate-float [animation-delay:1.2s]">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-500/15 text-brand-500">
              <Zap className="h-3.5 w-3.5" aria-hidden />
            </span>
            Live updates
          </FloatingBadge>
        </div>
      </div>
    </section>
  );
}
