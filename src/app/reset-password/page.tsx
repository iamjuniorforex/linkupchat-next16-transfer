'use client';

import { Suspense, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { KeyRound } from 'lucide-react';
import { AuthCard } from '@/components/auth/AuthCard';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';

function ResetPasswordForm() {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldError(null);
    if (password.length < 8) {
      setFieldError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setFieldError('Passwords do not match.');
      return;
    }
    if (!token) {
      setError('This reset link is invalid. Request a new one.');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password })
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error?.message ?? 'Something went wrong. Please try again.');
        return;
      }
      toast.success('Password updated', 'Log in with your new password.');
      router.push('/login');
    } catch {
      setError('No internet connection. Check your network and try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthCard
      title="Choose a new password"
      subtitle="Your new password must be at least 8 characters long."
      footer={
        <Link href="/login" className="font-semibold text-brand-500 hover:underline">
          Back to Log In
        </Link>
      }
    >
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {error && (
          <div role="alert" className="rounded-xl border border-coral-500/30 bg-coral-500/[0.08] px-4 py-3 text-sm text-coral-600 dark:text-coral-400">
            {error}
          </div>
        )}
        <Input
          name="password"
          type="password"
          label="New password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fieldError && password.length < 8 ? fieldError : null}
          icon={<KeyRound className="h-4 w-4" />}
        />
        <Input
          name="confirm"
          type="password"
          label="Confirm new password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={fieldError && password !== confirm ? 'Passwords do not match.' : null}
          icon={<KeyRound className="h-4 w-4" />}
        />
        <Button type="submit" className="w-full" size="lg" loading={loading}>
          Update Password
        </Button>
      </form>
    </AuthCard>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="min-h-[100dvh]" />}>
      <ResetPasswordForm />
    </Suspense>
  );
}
