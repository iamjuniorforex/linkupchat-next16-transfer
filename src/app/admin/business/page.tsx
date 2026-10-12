'use client';

import { useEffect, useState } from 'react';
import { useToast } from '@/components/ui/Toast';

type RequestRow = {
  userId: string;
  username: string;
  displayName: string;
  name: string;
  category: string;
  website: string | null;
  verificationStatus: string;
};

export default function AdminBusinessPage() {
  const toast = useToast();
  const [rows, setRows] = useState<RequestRow[]>([]);

  async function load() {
    const res = await fetch('/api/admin/business', { credentials: 'include' });
    const json = await res.json();
    if (json.ok) setRows(json.data.requests);
  }

  useEffect(() => {
    void load().catch(() => toast.error('Could not load verification requests'));
  }, [toast]);

  async function decide(userId: string, decision: 'APPROVED' | 'REJECTED') {
    const res = await fetch('/api/admin/business', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ userId, decision })
    });
    const json = await res.json();
    if (!json.ok) {
      toast.error(json.error?.message || 'Could not save the decision');
      return;
    }
    toast.success(decision === 'APPROVED' ? 'Business approved' : 'Business rejected');
    await load();
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 className="text-2xl font-extrabold text-ink">Business verification</h1>
        <p className="mt-1 text-sm text-muted">Pending requests only. Moderators cannot review their own business.</p>
      </div>
      {rows.length === 0 && <p className="card p-5 text-sm text-muted">No pending requests.</p>}
      {rows.map((row) => (
        <article key={row.userId} className="card flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <p className="font-bold text-ink">{row.name}</p>
            <p className="text-sm text-muted">
              @{row.username} · {row.category}
              {row.website ? ` · ${row.website}` : ''}
            </p>
          </div>
          <div className="flex gap-2">
            <button className="btn-primary" onClick={() => void decide(row.userId, 'APPROVED')}>
              Approve
            </button>
            <button className="btn-secondary" onClick={() => void decide(row.userId, 'REJECTED')}>
              Reject
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}
