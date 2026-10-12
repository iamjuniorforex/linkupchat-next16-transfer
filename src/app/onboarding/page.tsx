'use client';

import { useEffect, useState, type FormEvent, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Camera, UserPlus, MessageSquare, Sparkles, ArrowRight, SkipForward } from 'lucide-react';
import { Logo, LogoMark } from '@/components/ui/Logo';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { AuthProvider, useAuth } from '@/context/AuthProvider';

const steps = ['welcome', 'profile', 'photo', 'contacts'] as const;
type Step = (typeof steps)[number];

function OnboardingFlow() {
  const router = useRouter();
  const toast = useToast();
  const { user, loading: authLoading, refresh, updateProfile } = useAuth();
  const [step, setStep] = useState<'intro' | Step>('intro');
  const [introPage, setIntroPage] = useState(0);
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [about, setAbout] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!authLoading && !user) router.replace('/login');
  }, [authLoading, user, router]);

  useEffect(() => {
    if (user) {
      setDisplayName(user.displayName);
      setUsername(user.username);
      setAbout(user.about);
    }
  }, [user]);

  if (authLoading || !user) {
    return <div className="flex min-h-[100dvh] items-center justify-center"><Logo size="lg" /></div>;
  }

  const intros = [
    { icon: LogoMark, title: 'Welcome to LINKUPCHAT', text: 'A fresh, fast home for your conversations.' },
    { icon: Sparkles, title: 'Connect with your people.', text: 'Friends, family and teams — all in one place.' },
    { icon: MessageSquare, title: 'Chat. Share. Link up.', text: 'Messages, media, calls and status updates.' }
  ];

  async function saveProfile(e?: FormEvent) {
    e?.preventDefault();
    setError(null);
    if (displayName.trim().length < 2) {
      setError('Display name must be at least 2 characters.');
      return;
    }
    if (!/^[a-z0-9_]{3,24}$/.test(username.trim().toLowerCase())) {
      setError('Username must be 3–24 lowercase letters, numbers or underscores.');
      return;
    }
    setSaving(true);
    try {
      const json = await updateProfile({
        displayName: displayName.trim(),
        username: username.trim().toLowerCase(),
        about: about.trim() || undefined
      });
      if (json && json.ok === false) {
        setError(json.error?.message ?? 'Could not save your profile.');
        return;
      }
      await refresh();
      setStep('photo');
    } catch {
      setError('No internet connection. Check your network and try again.');
    } finally {
      setSaving(false);
    }
  }

  async function uploadAvatar(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('purpose', 'avatar');
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const json = await res.json();
      if (!json.ok) {
        toast.error('Upload failed', json.error?.message ?? 'Please try another photo.');
        return;
      }
      await updateProfile({ avatarUrl: json.data.url });
      await refresh();
      toast.success('Looking good!', 'Profile photo updated.');
      setStep('contacts');
    } catch {
      toast.error('Upload failed', 'No internet connection.');
    } finally {
      setUploading(false);
    }
  }

  // ── Intro carousel ──
  if (step === 'intro') {
    const current = intros[introPage]!;
    return (
      <main className="relative flex min-h-[100dvh] flex-col items-center justify-center overflow-hidden px-6">
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute -top-24 left-1/2 h-[520px] w-[820px] -translate-x-1/2 rounded-full opacity-[0.15] blur-3xl bg-brand-gradient" />
        </div>
        <div className="relative flex w-full max-w-sm flex-col items-center text-center animate-fade-up">
          <Logo size="xl" />
          <div className="mt-12 flex h-20 w-20 items-center justify-center rounded-[1.75rem] bg-brand-500/[0.08] text-brand-500">
            <current.icon size={40} />
          </div>
          <h1 className="mt-8 text-2xl font-extrabold tracking-tight text-ink">{current.title}</h1>
          <p className="mt-3 text-base leading-relaxed text-muted">{current.text}</p>

          <div className="mt-8 flex gap-2" role="tablist" aria-label="Onboarding progress">
            {intros.map((_, i) => (
              <button
                key={i}
                role="tab"
                aria-selected={i === introPage}
                aria-label={`Screen ${i + 1}`}
                onClick={() => setIntroPage(i)}
                className={`h-2 rounded-full transition-all ${i === introPage ? 'w-8 bg-brand-500' : 'w-2 bg-border-strong'}`}
              />
            ))}
          </div>

          <div className="mt-10 w-full space-y-3">
            {introPage < intros.length - 1 ? (
              <Button size="lg" className="w-full" onClick={() => setIntroPage((p) => p + 1)}>
                Continue
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Button>
            ) : (
              <Button size="lg" className="w-full" onClick={() => setStep('profile')}>
                Set up my profile
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Button>
            )}
            <button
              onClick={() => router.push('/app/chats')}
              className="inline-flex w-full items-center justify-center gap-1.5 text-sm font-medium text-muted hover:text-ink"
            >
              Skip for now <SkipForward className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="relative flex min-h-[100dvh] flex-col items-center justify-center px-6 py-10">
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -top-24 left-1/2 h-[520px] w-[820px] -translate-x-1/2 rounded-full opacity-[0.13] blur-3xl bg-brand-gradient" />
      </div>
      <div className="relative w-full max-w-md animate-fade-up">
        <div className="mb-8 flex justify-center"><Logo size="md" /></div>

        <div className="flex items-center gap-2" aria-label="Setup progress">
          {steps.map((s, i) => {
            const activeIndex = steps.indexOf(step);
            return (
              <div key={s} className="flex-1">
                <div className={`h-1.5 rounded-full ${i <= activeIndex ? 'bg-brand-500' : 'bg-border'}`} />
                <p className={`mt-2 text-center text-[11px] font-medium ${i === activeIndex ? 'text-brand-500' : 'text-faint'}`}>
                  {s === 'welcome' ? 'Welcome' : s === 'profile' ? 'Profile' : s === 'photo' ? 'Photo' : 'Contacts'}
                </p>
              </div>
            );
          })}
        </div>

        <div className="card mt-6 p-7">
          {step === 'profile' && (
            <form onSubmit={saveProfile} className="space-y-4">
              <h1 className="text-xl font-extrabold text-ink">Tell us about you</h1>
              <p className="text-sm text-muted">This is what friends will see on LINKUPCHAT.</p>
              {error && (
                <div role="alert" className="rounded-xl border border-coral-500/30 bg-coral-500/[0.08] px-4 py-3 text-sm text-coral-600 dark:text-coral-400">
                  {error}
                </div>
              )}
              <Input label="Display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              <Input label="Username" value={username} onChange={(e) => setUsername(e.target.value)} hint="3–24 lowercase letters, numbers or underscores" />
              <Input label="About (optional)" value={about} onChange={(e) => setAbout(e.target.value)} placeholder="Hey there! I am using LINKUPCHAT." />
              <Button type="submit" size="lg" className="w-full" loading={saving}>
                Continue
              </Button>
            </form>
          )}

          {step === 'photo' && (
            <div className="space-y-5 text-center">
              <h1 className="text-xl font-extrabold text-ink">Add a profile photo</h1>
              <p className="text-sm text-muted">Help friends recognise you — you can change it any time.</p>
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="mx-auto flex h-28 w-28 items-center justify-center rounded-full border-2 border-dashed border-brand-500/40 bg-brand-500/[0.06] text-brand-500 transition-colors hover:bg-brand-500/[0.12] disabled:opacity-50"
                aria-label="Upload profile photo"
              >
                {uploading ? (
                  <span className="animate-pulse-soft text-sm font-medium">Uploading…</span>
                ) : (
                  <Camera className="h-9 w-9" aria-hidden />
                )}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadAvatar(f);
                  e.target.value = '';
                }}
              />
              <div className="space-y-2.5">
                <Button size="lg" className="w-full" onClick={() => fileRef.current?.click()} loading={uploading}>
                  <Camera className="h-4 w-4" aria-hidden /> Choose Photo
                </Button>
                <button onClick={() => setStep('contacts')} className="text-sm font-medium text-muted hover:text-ink">
                  Skip for now
                </button>
              </div>
            </div>
          )}

          {step === 'contacts' && (
            <div className="space-y-5 text-center">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-brand-500/[0.08] text-brand-500">
                <UserPlus className="h-8 w-8" aria-hidden />
              </div>
              <h1 className="text-xl font-extrabold text-ink">Find your people</h1>
              <p className="text-sm leading-relaxed text-muted">
                Search by username or name, then start a conversation. LINKUPCHAT does not ask for
                your phone contacts.
              </p>
              <div className="space-y-2.5">
                <Button size="lg" className="w-full" onClick={() => router.push('/app/contacts')}>
                  <UserPlus className="h-4 w-4" aria-hidden /> Find Contacts
                </Button>
                <Button size="lg" variant="secondary" className="w-full" onClick={() => router.push('/app/chats')}>
                  <Check className="h-4 w-4" aria-hidden /> Go to Chats
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

export default function OnboardingPage() {
  return (
    <AuthProvider>
      <OnboardingFlow />
    </AuthProvider>
  );
}
