'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AtSign, KeyRound } from 'lucide-react';
import { AuthCard } from '@/components/auth/AuthCard';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';

export default function LoginPage() {
  const router = useRouter();
  const toast = useToast();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ identifier?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function validate() {
    const next: typeof errors = {};
    if (!identifier.trim()) next.identifier = 'Enter your username, email or phone.';
    if (!password) next.password = 'Enter your password.';
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!validate()) return;

    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: identifier.trim(), password })
      });
      const json = await res.json();
      if (!json.ok) {
        setFormError(json.error?.message ?? 'Unable to log in. Please try again.');
        return;
      }
      toast.success('Welcome back!', 'You are now signed in.');
      router.push('/app/chats');
      router.refresh();
    } catch {
      setFormError('No internet connection. Check your network and try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthCard
      title="Welcome back"
      subtitle="Log in to pick up your conversations right where you left off."
      footer={
        <>
          New to LINKUPCHAT?{' '}
          <Link href="/register" className="font-semibold text-brand-500 hover:underline">
            Create an account
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
          name="identifier"
          label="Username, email or phone"
          placeholder="alex"
          autoComplete="username"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          error={errors.identifier}
          icon={<AtSign className="h-4 w-4" />}
        />
        <Input
          name="password"
          type="password"
          label="Password"
          placeholder="••••••••"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
          icon={<KeyRound className="h-4 w-4" />}
        />
        <div className="flex items-center justify-between">
          <Link href="/forgot-password" className="text-sm font-medium text-brand-500 hover:underline">
            Forgot password?
          </Link>
        </div>
        <Button type="submit" className="w-full" size="lg" loading={loading}>
          Log In
        </Button>
      </form>
    </AuthCard>
  );
}
