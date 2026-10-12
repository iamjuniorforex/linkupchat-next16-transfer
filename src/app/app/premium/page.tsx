'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Check, Sparkles } from 'lucide-react';
import { useToast } from '@/components/ui/Toast';
import { formatMinor } from '@/lib/plans';

type Plan = {
  code: string;
  name: string;
  amountMinor: number;
  currency: string;
  interval: string | null;
};

type Invoice = {
  id: string;
  amountMinor: number;
  currency: string;
  status: string;
  description: string;
  simulated: boolean;
  createdAt: string;
};

type Subscription = {
  plan: string;
  status: string;
  entitled: boolean;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  scheduledPlan: string | null;
  simulated: boolean;
  invoices: Invoice[];
};

const COMPARE = [
  ['Messaging, calls, and status', 'Included', 'Included'],
  ['Light, dark, and system theme', 'Included', 'Included'],
  ['Premium badge', '—', 'Included'],
  ['Extra chat themes and wallpapers', '—', 'Included'],
  ['Per-conversation chat theme', '—', 'Included'],
  ['Upload limit', '25 MB', '100 MB'],
  ['Business profile and tools', '—', 'Business plan']
] as const;

export default function PremiumPage() {
  const router = useRouter();
  const toast = useToast();
  const [mode, setMode] = useState<string>('unconfigured');
  const [simulated, setSimulated] = useState(false);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [sub, setSub] = useState<Subscription | null>(null);
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);

  async function load() {
    const [plansRes, subRes] = await Promise.all([
      fetch('/api/billing/plans', { credentials: 'include' }).then((r) => r.json()),
      fetch('/api/billing/subscription', { credentials: 'include' }).then((r) => r.json())
    ]);
    if (plansRes.ok) {
      setMode(plansRes.data.mode);
      setSimulated(Boolean(plansRes.data.simulated));
      setPlans(plansRes.data.plans);
    }
    if (subRes.ok) setSub(subRes.data);
  }

  useEffect(() => {
    void load().catch(() => toast.error('Could not load billing'));
  }, [toast]);

  async function checkout(plan: string) {
    setBusy(true);
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ plan })
      });
      const json = await res.json();
      if (!json.ok) {
        toast.error(json.error?.message || 'Checkout is unavailable');
        return;
      }
      if (json.data.simulated) {
        setSessionId(json.data.sessionId);
        toast.success('Simulated checkout started. This is not a real charge.');
        return;
      }
      if (json.data.url) window.location.href = json.data.url;
    } finally {
      setBusy(false);
    }
  }

  async function completeSimulated() {
    if (!sessionId) return;
    setBusy(true);
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'complete', sessionId })
      });
      const json = await res.json();
      if (!json.ok) {
        toast.error(json.error?.message || 'Simulated checkout was not completed');
        return;
      }
      setSessionId(null);
      toast.success('Simulated subscription activated. No card was charged.');
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function act(action: string, plan?: string) {
    setBusy(true);
    try {
      const res = await fetch('/api/billing/subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action, plan })
      });
      const json = await res.json();
      if (!json.ok) {
        toast.error(json.error?.message || 'Could not update subscription');
        return;
      }
      toast.success('Subscription updated');
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg">
      <header className="flex h-[64px] shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
        <button onClick={() => router.back()} className="icon-btn" aria-label="Go back">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div>
          <h1 className="text-[15px] font-bold text-ink">LINKUPCHAT Premium</h1>
          <p className="text-xs text-muted">Plans, billing, and receipts</p>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto px-4 py-5">
        <div className="mx-auto max-w-xl space-y-5">
          {simulated && (
            <p className="rounded-2xl border border-gold-500/40 bg-gold-500/10 px-4 py-3 text-sm text-ink">
              Test mode. Checkout is simulated and does not charge a card. A return from checkout is not proof of payment.
            </p>
          )}
          {mode === 'unconfigured' && (
            <p className="rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-muted">
              Billing is not configured. No live charges can be made until a provider is set up.
            </p>
          )}
          <section className="card p-5">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-brand-500" aria-hidden />
              <h2 className="font-bold text-ink">Your plan</h2>
            </div>
            <p className="mt-2 text-sm text-ink">
              {sub?.plan ?? 'FREE'} · {sub?.status ?? 'Free'}
              {sub?.simulated ? ' · simulated' : ''}
            </p>
            {sub?.currentPeriodEnd && (
              <p className="mt-1 text-xs text-muted">
                {sub.cancelAtPeriodEnd ? 'Access until' : 'Renews'} {new Date(sub.currentPeriodEnd).toLocaleDateString()}
              </p>
            )}
            {sub?.scheduledPlan && <p className="mt-1 text-xs text-muted">Changes to {sub.scheduledPlan} at renewal.</p>}
            {sub?.entitled && (
              <div className="mt-3 flex flex-wrap gap-2">
                <button disabled={busy} className="btn-secondary" onClick={() => void act('cancel')}>
                  Cancel at period end
                </button>
                <button disabled={busy} className="btn-secondary" onClick={() => void act('downgrade', 'PREMIUM_MONTHLY')}>
                  Downgrade to monthly
                </button>
              </div>
            )}
          </section>

          <section className="card overflow-hidden">
            <table className="w-full text-left text-sm">
              <thead className="bg-ink/[0.03] text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-3 font-semibold">Free vs Premium</th>
                  <th className="px-4 py-3 font-semibold">Free</th>
                  <th className="px-4 py-3 font-semibold">Premium</th>
                </tr>
              </thead>
              <tbody>
                {COMPARE.map((row) => (
                  <tr key={row[0]} className="border-t border-border">
                    <td className="px-4 py-3 text-ink">{row[0]}</td>
                    <td className="px-4 py-3 text-muted">{row[1]}</td>
                    <td className="px-4 py-3 font-semibold text-ink">{row[2]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="grid gap-3">
            {plans.map((plan) => (
              <button
                key={plan.code}
                disabled={busy || mode === 'unconfigured'}
                onClick={() => void checkout(plan.code)}
                className="card flex items-center justify-between p-4 text-left"
              >
                <span>
                  <span className="block font-bold text-ink">{plan.name}</span>
                  <span className="text-sm text-muted">
                    {formatMinor(plan.amountMinor, plan.currency)} / {plan.interval}
                  </span>
                </span>
                <Check className="h-4 w-4 text-brand-500" aria-hidden />
              </button>
            ))}
          </section>

          {sessionId && simulated && (
            <section className="card space-y-3 p-5">
              <p className="text-sm text-ink">
                Simulated checkout is waiting. Completing it activates the plan in test mode only.
              </p>
              <button disabled={busy} className="btn-primary" onClick={() => void completeSimulated()}>
                Complete simulated checkout
              </button>
            </section>
          )}

          <section className="card p-5">
            <h2 className="font-bold text-ink">Receipts</h2>
            <ul className="mt-3 space-y-2">
              {(sub?.invoices ?? []).length === 0 && <li className="text-sm text-muted">No receipts yet.</li>}
              {(sub?.invoices ?? []).map((invoice) => (
                <li key={invoice.id} className="flex items-center justify-between text-sm">
                  <span className="text-ink">
                    {invoice.description}
                    {invoice.simulated ? ' · simulated' : ''}
                  </span>
                  <span className="text-muted">
                    {formatMinor(invoice.amountMinor, invoice.currency)} · {invoice.status}
                  </span>
                </li>
              ))}
            </ul>
            <Link href="/app/business" className="mt-4 inline-block text-sm font-semibold text-brand-500">
              Business tools
            </Link>
          </section>
        </div>
      </div>
    </div>
  );
}
