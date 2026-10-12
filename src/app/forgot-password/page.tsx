'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { AtSign, MailCheck } from 'lucide-react';
import { AuthCard } from '@/components/auth/AuthCard';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';

export default function ForgotPasswordPage() {
  const [identifier, setIdentifier] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!identifier.trim()) {
      setError('Enter your username or email.');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: identifier.trim() })
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error?.message ?? 'Something went wrong. Please try again.');
        return;
      }
      setSent(true);
    } catch {
      setError('No internet connection. Check your network and try again.');
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <AuthCard
        title="Check your inbox"
        subtitle="If an account exists for that username or email, a reset link is on its way."
        footer={
          <Link href="/login" className="font-semibold text-brand-500 hover:underline">
            Back to Log In
          </Link>
        }
      >
        <div className="flex flex-col items-center gap-4 py-4 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-mint-500/15 text-mint-500">
            <MailCheck className="h-8 w-8" aria-hidden />
          </div>
          <p className="text-sm leading-relaxed text-muted">
            The reset link is valid for one hour. In development mode the email is printed to the
            server console.
          </p>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Reset your password"
      subtitle="Enter the username or email linked to your account and we'll send you a reset link."
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
          name="identifier"
          label="Username or email"
          placeholder="alex"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          icon={<AtSign className="h-4 w-4" />}
        />
        <Button type="submit" className="w-full" size="lg" loading={loading}>
          Send Reset Link
        </Button>
      </form>
    </AuthCard>
  );
}
