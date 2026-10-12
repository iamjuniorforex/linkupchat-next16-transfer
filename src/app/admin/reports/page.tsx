'use client';

import { useEffect, useState } from 'react';
import { Flag, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { ChatListSkeleton } from '@/components/ui/Skeleton';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { cn, formatDate } from '@/lib/utils';

interface AdminReport {
  id: string;
  category: string;
  reason: string | null;
  status: string;
  createdAt: string;
  reporter: { displayName: string };
  reportedUser: { displayName: string } | null;
  messageId: string | null;
}

export default function AdminReportsPage() {
  const toast = useToast();
  const [reports, setReports] = useState<AdminReport[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState<'ALL' | 'OPEN' | 'REVIEWING' | 'RESOLVED' | 'REJECTED'>('ALL');
  const [selected, setSelected] = useState<AdminReport | null>(null);
  const [note, setNote] = useState('');

  async function load() {
    setLoaded(false);
    try {
      const res = await fetch(
        `/api/admin/reports${filter !== 'ALL' ? `?status=${filter}` : ''}`,
        { credentials: 'include' }
      );
      const json = await res.json();
      if (json.ok) setReports(json.data.reports);
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  async function resolve(reportId: string, status: 'REVIEWING' | 'RESOLVED' | 'REJECTED') {
    const res = await fetch('/api/admin/reports', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reportId, status, note: note || undefined }),
      credentials: 'include'
    });
    const json = await res.json();
    if (json.ok) {
      toast.success('Report updated', status.toLowerCase());
      setSelected(null);
      setNote('');
      void load();
    } else {
      toast.error('Failed', json.error?.message);
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-2xl font-extrabold text-ink">Moderation queue</h1>
      <p className="mt-1 text-sm text-muted">Review reports filed by users.</p>

      <div className="mt-6 flex gap-1.5 overflow-x-auto no-scrollbar">
        {(['ALL', 'OPEN', 'REVIEWING', 'RESOLVED', 'REJECTED'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              'whitespace-nowrap rounded-full px-4 py-1.5 text-xs font-semibold transition-colors',
              filter === f ? 'bg-brand-500 text-white' : 'text-muted hover:bg-ink/[0.05] dark:hover:bg-white/[0.06]'
            )}
          >
            {f}
          </button>
        ))}
      </div>

      <div className="mt-5 space-y-3">
        {!loaded ? (
          <ChatListSkeleton />
        ) : reports.length === 0 ? (
          <EmptyState
            icon={<CheckCircle2 className="h-7 w-7 text-mint-500" />}
            title="Queue is clear"
            description="No reports match this filter."
          />
        ) : (
          reports.map((r) => (
            <div key={r.id} className="card flex items-center gap-4 p-4">
              <div
                className={cn(
                  'flex h-10 w-10 items-center justify-center rounded-full',
                  r.status === 'OPEN'
                    ? 'bg-coral-500/12 text-coral-500'
                    : r.status === 'REVIEWING'
                      ? 'bg-gold-500/15 text-gold-500'
                      : 'bg-mint-500/12 text-mint-500'
                )}
              >
                <Flag className="h-5 w-5" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink">
                  {r.category} · reported by {r.reporter?.displayName ?? 'Deleted user'}
                </p>
                <p className="truncate text-xs text-muted">
                  {r.reportedUser ? `Against: ${r.reportedUser.displayName} · ` : ''}
                  {r.reason ?? 'No details provided'} · {formatDate(r.createdAt)}
                </p>
              </div>
              <span
                className={cn(
                  'rounded-full px-3 py-1 text-xs font-semibold',
                  r.status === 'OPEN'
                    ? 'bg-coral-500/12 text-coral-500'
                    : r.status === 'REVIEWING'
                      ? 'bg-gold-500/15 text-gold-500'
                      : 'bg-ink/[0.06] text-muted'
                )}
              >
                {r.status}
              </span>
              <button onClick={() => setSelected(r)} className="btn-secondary !h-8 !px-3 !text-xs">
                Review
              </button>
            </div>
          ))
        )}
      </div>

      <Modal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title="Review report"
        description={`${selected?.category} — ${selected?.reason ?? 'no details'}`}
        size="sm"
      >
        <div className="space-y-4">
          <div className="rounded-xl border border-border p-4 text-sm text-muted">
            <p>
                  <strong className="text-ink">Reporter:</strong>{' '}
                  {selected?.reporter?.displayName ?? 'Deleted user'}
            </p>
            <p>
              <strong className="text-ink">Reported user:</strong>{' '}
              {selected?.reportedUser?.displayName ?? '—'}
            </p>
            <p>
              <strong className="text-ink">Message ID:</strong> {selected?.messageId ?? '—'}
            </p>
            <p>
              <strong className="text-ink">Filed:</strong>{' '}
              {selected ? formatDate(selected.createdAt) : ''}
            </p>
          </div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Resolution note (optional)"
            aria-label="Resolution note"
            className="input-base min-h-[80px] resize-none"
          />
          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={() => selected && void resolve(selected.id, 'REVIEWING')}
              className="btn-secondary !px-2 !text-xs"
            >
              <Loader2 className="h-3.5 w-3.5" aria-hidden /> Reviewing
            </button>
            <button
              onClick={() => selected && void resolve(selected.id, 'RESOLVED')}
              className="btn-primary !px-2 !text-xs"
            >
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Resolve
            </button>
            <button
              onClick={() => selected && void resolve(selected.id, 'REJECTED')}
              className="btn-danger !px-2 !text-xs"
            >
              <XCircle className="h-3.5 w-3.5" aria-hidden /> Reject
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
