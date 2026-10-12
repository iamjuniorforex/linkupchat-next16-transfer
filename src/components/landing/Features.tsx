import Link from 'next/link';
import {
  MessageSquare,
  Users,
  PhoneCall,
  Radio,
  ShieldCheck,
  MonitorSmartphone,
  ArrowRight
} from 'lucide-react';

const features = [
  {
    icon: MessageSquare,
    title: 'Messaging that feels instant',
    text: 'Real-time chats with replies, reactions, edits, forwards and rich media — images, video, voice notes, documents, GIFs and stickers.',
    color: 'text-brand-500',
    bg: 'bg-brand-500/[0.1]'
  },
  {
    icon: Users,
    title: 'Groups that stay organised',
    text: 'Create group chats with admins, permissions, member management and notifications that respect your attention.',
    color: 'text-sky-500',
    bg: 'bg-sky-500/[0.1]'
  },
  {
    icon: PhoneCall,
    title: 'Voice & video calls',
    text: 'One-to-one voice and video calls with mute and camera controls. Call quality depends on your network.',
    color: 'text-coral-500',
    bg: 'bg-coral-500/[0.1]'
  },
  {
    icon: Radio,
    title: 'Status updates',
    text: 'Share moments that disappear after 24 hours. Text, photos and videos — seen only by the people you choose.',
    color: 'text-mint-500',
    bg: 'bg-mint-500/[0.1]'
  },
  {
    icon: ShieldCheck,
    title: 'Privacy in your hands',
    text: 'Granular controls for last seen, profile photo, about, status and read receipts. Block and report in a tap.',
    color: 'text-gold-500',
    bg: 'bg-gold-500/[0.1]'
  },
  {
    icon: MonitorSmartphone,
    title: 'Beautiful on every screen',
    text: 'Designed mobile-first and scaled up for tablets, laptops and ultrawide displays — with light and dark themes.',
    color: 'text-brand-500',
    bg: 'bg-brand-500/[0.1]'
  }
];

export function Features() {
  return (
    <section id="features" className="relative py-24">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-bold uppercase tracking-[0.18em] text-brand-500">Everything you need</p>
          <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-ink sm:text-4xl">
            One app for every conversation
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-muted">
            LINKUPCHAT brings messaging, groups, calls and stories together in an interface that stays
            out of your way.
          </p>
        </div>

        <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <article
              key={f.title}
              className="card group p-6 transition-shadow duration-200 motion-safe:hover:-translate-y-1 hover:shadow-card"
            >
              <div className={`flex h-12 w-12 items-center justify-center rounded-2xl ${f.bg} ${f.color}`}>
                <f.icon className="h-6 w-6" aria-hidden />
              </div>
              <h3 className="mt-5 text-lg font-bold text-ink">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{f.text}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Experience() {
  return (
    <section id="experience" className="relative py-24">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-border to-transparent" />
      <div className="mx-auto grid max-w-6xl items-center gap-14 px-6 lg:grid-cols-2">
        <div>
          <p className="text-sm font-bold uppercase tracking-[0.18em] text-brand-500">Cross-device</p>
          <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-ink sm:text-4xl">
            A polished experience on phones, tablets and desktops
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-muted">
            Start a conversation on your phone and pick it up on your laptop. LINKUPCHAT adapts to
            every screen size with the same fast, focused interface.
          </p>
          <ul className="mt-8 space-y-4">
            {[
              ['Mobile-first design', 'Bottom navigation, gesture-friendly targets and safe-area support.'],
              ['Desktop layout', 'Search, conversation list, and the open chat on a wider screen.'],
              ['Light and dark themes', 'Choose light, dark, or match your device. The choice stays on this device.'],
              ['Keyboard and motion', 'Labeled controls, visible focus, and shorter motion when you ask for it.']
            ].map(([title, text]) => (
              <li key={title} className="flex gap-3.5">
                <span className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-500/15 text-brand-500">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                    <path d="M2 6.2 4.8 9 10 3.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <div>
                  <p className="font-semibold text-ink">{title}</p>
                  <p className="mt-0.5 text-sm text-muted">{text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-4">
              <div className="card p-5">
                <div className="flex -space-x-2.5">
                  {['A', 'S', 'D', 'E'].map((l, i) => (
                    <div key={i} className="h-9 w-9 rounded-full border-2 border-surface bg-brand-gradient text-center text-xs font-bold leading-9 text-white">
                      {l}
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-sm font-semibold text-ink">Weekend crew</p>
                <p className="text-xs text-muted">4 members · 2 online</p>
              </div>
              <div className="card p-5">
                <p className="text-xs font-semibold text-mint-500">Messaging</p>
                <p className="mt-2 text-lg font-extrabold text-ink">Chats, calls, status</p>
                <p className="text-xs text-muted">The features already in the app</p>
              </div>
            </div>
            <div className="mt-8 space-y-4">
              <div className="card overflow-hidden">
                <div className="bg-brand-gradient px-5 py-6">
                  <p className="text-sm font-semibold text-white/90">Status</p>
                  <p className="mt-1 text-lg font-bold text-white">“Chat. Share. Link up.”</p>
                  <p className="mt-2 text-xs text-white/75">Expires in 24 hours</p>
                </div>
              </div>
              <div className="card p-5">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-coral-500/15 text-coral-500">
                    <PhoneCall className="h-5 w-5" aria-hidden />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-ink">Incoming call</p>
                    <p className="text-xs text-muted">Emma · Video</p>
                  </div>
                </div>
                <div className="mt-4 flex gap-2">
                  <div className="h-9 flex-1 rounded-full bg-mint-500/15 text-center text-xs font-semibold leading-9 text-mint-600">Accept</div>
                  <div className="h-9 flex-1 rounded-full bg-coral-500/15 text-center text-xs font-semibold leading-9 text-coral-600">Decline</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function PrivacySection() {
  return (
    <section id="privacy" className="relative py-24">
      <div className="mx-auto max-w-6xl px-6">
        <div className="card overflow-hidden">
          <div className="grid lg:grid-cols-2">
            <div className="p-10 lg:p-14">
              <p className="text-sm font-bold uppercase tracking-[0.18em] text-brand-500">Privacy</p>
              <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-ink">
                Your conversations, your controls
              </h2>
              <p className="mt-4 text-lg leading-relaxed text-muted">
                Decide who sees your profile photo, last seen, online status, about and stories. Read
                receipts can be turned off any time. Block or report anyone in seconds.
              </p>
              <Link
                href="/register"
                className="btn-primary mt-8 inline-flex h-11 px-6 text-sm"
              >
                Create your account
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
            </div>
            <div className="relative min-h-[320px] bg-brand-gradient p-10 lg:p-14">
              <div className="absolute inset-0 opacity-20" aria-hidden>
                <div className="absolute right-10 top-10 h-40 w-40 rounded-full border border-white/40" />
                <div className="absolute bottom-10 left-10 h-56 w-56 rounded-full border border-white/30" />
              </div>
              <div className="relative space-y-4">
                {[
                  ['Last seen', 'My contacts'],
                  ['Profile photo', 'Everyone'],
                  ['About', 'Nobody'],
                  ['Status updates', 'My contacts'],
                  ['Read receipts', 'On']
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="flex items-center justify-between rounded-2xl bg-white/15 px-5 py-3.5 backdrop-blur-sm"
                  >
                    <span className="text-sm font-medium text-white">{label}</span>
                    <span className="rounded-full bg-white/20 px-3 py-1 text-xs font-semibold text-white">{value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function CTABanner() {
  return (
    <section className="relative py-24">
      <div className="mx-auto max-w-5xl px-6">
        <div className="relative overflow-hidden rounded-[2rem] bg-brand-gradient px-8 py-16 text-center shadow-glow sm:px-16">
          <div aria-hidden className="pointer-events-none absolute inset-0">
            <div className="absolute -left-16 -top-16 h-64 w-64 rounded-full bg-white/10 blur-2xl" />
            <div className="absolute -bottom-20 -right-10 h-72 w-72 rounded-full bg-white/10 blur-2xl" />
          </div>
          <h2 className="relative text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
            Ready to link up?
          </h2>
          <p className="relative mx-auto mt-4 max-w-xl text-lg text-white/85">
            Join LINKUPCHAT today and bring your conversations, groups and calls together in one place.
          </p>
          <div className="relative mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/register"
              className="inline-flex h-12 w-full items-center justify-center rounded-full bg-white px-8 text-[15px] font-semibold text-brand-600 shadow-soft transition-transform motion-safe:hover:scale-[1.02] active:scale-100 sm:w-auto"
            >
              Create a free account
            </Link>
            <Link
              href="/login"
              className="inline-flex h-12 w-full items-center justify-center rounded-full border border-white/40 px-8 text-[15px] font-semibold text-white transition-colors hover:bg-white/10 sm:w-auto"
            >
              Log In
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-border py-12">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-6 px-6 sm:flex-row">
        <p className="text-sm text-muted">
          © {new Date().getFullYear()} LINKUPCHAT. Crafted for conversations that matter.
        </p>
        <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-muted" aria-label="Footer">
          <Link href="/register" className="transition-colors hover:text-ink">Get Started</Link>
          <Link href="/login" className="transition-colors hover:text-ink">Log In</Link>
          <a href="#features" className="transition-colors hover:text-ink">Features</a>
          <a href="#privacy" className="transition-colors hover:text-ink">Privacy</a>
        </nav>
      </div>
    </footer>
  );
}
