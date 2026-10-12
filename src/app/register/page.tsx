'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AtSign, KeyRound, Mail, Phone, User } from 'lucide-react';
import { AuthCard } from '@/components/auth/AuthCard';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';

type FieldErrors = Partial<Record<'displayName' | 'username' | 'email' | 'phone' | 'password', string>>;

export default function RegisterPage() {
  const router = useRouter();
  const toast = useToast();
  const [form, setForm] = useState({
    displayName: '',
    username: '',
    email: '',
    phone: '',
    password: ''
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  }

  function validate(): boolean {
    const next: FieldErrors = {};
    if (form.displayName.trim().length < 2) next.displayName = 'Display name must be at least 2 characters.';
    const username = form.username.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,24}$/.test(username)) {
      next.username = 'Use 3–24 lowercase letters, numbers or underscores.';
    }
    if (!form.email.trim() && !form.phone.trim()) {
      next.email = 'Enter an email address or phone number.';
    }
    if (form.email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) {
      next.email = 'Enter a valid email address.';
    }
    if (form.phone.trim() && !/^\+?[0-9\s-]{7,20}$/.test(form.phone.trim())) {
      next.phone = 'Enter a valid phone number.';
    }
    if (form.password.length < 8) next.password = 'Password must be at least 8 characters.';
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!validate()) return;

    setLoading(true);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: form.displayName.trim(),
          username: form.username.trim().toLowerCase(),
          email: form.email.trim() ? form.email.trim().toLowerCase() : undefined,
          phone: form.phone.trim() || undefined,
          password: form.password
        })
      });
      const json = await res.json();
      if (!json.ok) {
        if (json.error?.code === 'USERNAME_TAKEN') {
          setErrors({ username: json.error.message });
        } else if (json.error?.code === 'IDENTITY_TAKEN') {
          setErrors({ email: json.error.message });
        } else {
          setFormError(json.error?.message ?? 'Unable to create your account. Please try again.');
        }
        return;
      }
      toast.success('Account created!', 'Welcome to LINKUPCHAT.');
      router.push('/onboarding');
      router.refresh();
    } catch {
      setFormError('No internet connection. Check your network and try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthCard
      title="Create your account"
      subtitle="Join LINKUPCHAT and start chatting in less than a minute."
      footer={
        <>
          Already have an account?{' '}
          <Link href="/login" className="font-semibold text-brand-500 hover:underline">
            Log In
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {formError && (
          <div role="alert" className="rounded-xl border border-coral-500/30 bg-coral-500/[0.08] px-4 py-3 text-sm text-coral-600 dark:text-coral-400">
            {formError}
          </div>
        )}
        <Input
          name="displayName"
          label="Display name"
          placeholder="Alex Mensah"
          autoComplete="name"
          value={form.displayName}
          onChange={(e) => set('displayName', e.target.value)}
          error={errors.displayName}
          icon={<User className="h-4 w-4" />}
        />
        <Input
          name="username"
          label="Username"
          placeholder="alex"
          autoComplete="username"
          value={form.username}
          onChange={(e) => set('username', e.target.value)}
          error={errors.username}
          hint="Lowercase letters, numbers and underscores. This is how friends find you."
          icon={<AtSign className="h-4 w-4" />}
        />
        <Input
          name="email"
          type="email"
          label="Email"
          placeholder="alex@example.com"
          autoComplete="email"
          value={form.email}
          onChange={(e) => set('email', e.target.value)}
          error={errors.email}
          icon={<Mail className="h-4 w-4" />}
        />
        <Input
          name="phone"
          type="tel"
          label="Phone (optional)"
          placeholder="+233 20 000 0000"
          autoComplete="tel"
          value={form.phone}
          onChange={(e) => set('phone', e.target.value)}
          error={errors.phone}
          icon={<Phone className="h-4 w-4" />}
        />
        <Input
          name="password"
          type="password"
          label="Password"
          placeholder="At least 8 characters"
          autoComplete="new-password"
          value={form.password}
          onChange={(e) => set('password', e.target.value)}
          error={errors.password}
          icon={<KeyRound className="h-4 w-4" />}
        />
        <Button type="submit" className="w-full" size="lg" loading={loading}>
          Create Account
        </Button>
        <p className="text-center text-xs leading-relaxed text-faint">
          By continuing you agree to keep LINKUPCHAT a kind, respectful place for everyone.
        </p>
      </form>
    </AuthCard>
  );
}
