'use client';

import { useEffect, useState } from 'react';
import { Users, MessageSquare, Activity, Flag, UserX, Ban } from 'lucide-react';

interface Stats {
  totalUsers: number;
  totalMessages: number;
  totalConversations: number;
  activeSessions24h: number;
  openReports: number;
  suspended: number;
  banned: number;
}

export default function AdminOverview() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    fetch('/api/admin/stats', { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => j.ok && setStats(j.data))
      .catch(() => {});
  }, []);

  const cards = stats
    ? [
        { label: 'Total users', value: stats.totalUsers, icon: Users, color: 'text-brand-500 bg-brand-500/10' },
        { label: 'Messages', value: stats.totalMessages, icon: MessageSquare, color: 'text-mint-500 bg-mint-500/10' },
        { label: 'Conversations', value: stats.totalConversations, icon: Activity, color: 'text-sky-500 bg-sky-500/10' },
        { label: 'Active (24h)', value: stats.activeSessions24h, icon: Activity, color: 'text-gold-500 bg-gold-500/10' },
        { label: 'Open reports', value: stats.openReports, icon: Flag, color: 'text-coral-500 bg-coral-500/10' },
        { label: 'Suspended', value: stats.suspended, icon: UserX, color: 'text-coral-500 bg-coral-500/10' },
        { label: 'Banned', value: stats.banned, icon: Ban, color: 'text-coral-500 bg-coral-500/10' }
      ]
    : [];

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-2xl font-extrabold text-ink">Platform overview</h1>
      <p className="mt-1 text-sm text-muted">Live statistics for LINKUPCHAT.</p>

      <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="card p-5">
            <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${c.color}`}>
              <c.icon className="h-5 w-5" aria-hidden />
            </div>
            <p className="mt-3 text-2xl font-extrabold tabular-nums text-ink">
              {c.value.toLocaleString()}
            </p>
            <p className="text-xs font-medium text-muted">{c.label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
