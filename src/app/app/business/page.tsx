'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { useToast } from '@/components/ui/Toast';

type Profile = {
  name: string;
  category: string;
  description: string | null;
  website: string | null;
  email: string | null;
  phone: string | null;
  greeting: string | null;
  awayMessage: string | null;
  awayEnabled: boolean;
  verificationStatus: string;
  verificationNote: string | null;
};

type Reply = { id: string; title: string; body: string };

const CATEGORIES = ['RETAIL', 'FOOD', 'SERVICES', 'HEALTH', 'EDUCATION', 'OTHER'];

export default function BusinessPage() {
  const router = useRouter();
  const toast = useToast();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [replies, setReplies] = useState<Reply[]>([]);
  const [form, setForm] = useState({
    name: '',
    category: 'OTHER',
    description: '',
    website: '',
    email: '',
    phone: '',
    greeting: '',
    awayMessage: '',
    awayEnabled: false
  });
  const [replyTitle, setReplyTitle] = useState('');
  const [replyBody, setReplyBody] = useState('');
  const [locked, setLocked] = useState(false);

  async function load() {
    const [profileRes, replyRes] = await Promise.all([
      fetch('/api/business/profile', { credentials: 'include' }).then((r) => r.json()),
      fetch('/api/business/quick-replies', { credentials: 'include' }).then((r) => r.json())
    ]);
    if (profileRes.ok && profileRes.data.profile) {
      const next = profileRes.data.profile as Profile;
      setProfile(next);
      setForm({
        name: next.name,
        category: next.category,
        description: next.description ?? '',
        website: next.website ?? '',
        email: next.email ?? '',
        phone: next.phone ?? '',
        greeting: next.greeting ?? '',
        awayMessage: next.awayMessage ?? '',
        awayEnabled: next.awayEnabled
      });
    }
    if (replyRes.ok) setReplies(replyRes.data.replies);
  }

  useEffect(() => {
    void load().catch(() => toast.error('Could not load business tools'));
  }, [toast]);

  async function save() {
    const res = await fetch('/api/business/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(form)
    });
    const json = await res.json();
    if (res.status === 403) {
      setLocked(true);
      toast.error('LINKUPCHAT Business is required');
      return;
    }
    if (!json.ok) {
      toast.error(json.error?.message || 'Could not save profile');
      return;
    }
    setProfile(json.data.profile);
    toast.success('Business profile saved');
  }

  async function requestReview() {
    const res = await fetch('/api/business/verification', { method: 'POST', credentials: 'include' });
    const json = await res.json();
    if (!json.ok) {
      toast.error(json.error?.message || 'Could not request verification');
      return;
    }
    toast.success('Verification requested');
    await load();
  }

  async function addReply() {
    const res = await fetch('/api/business/quick-replies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ title: replyTitle, body: replyBody })
    });
    const json = await res.json();
    if (!json.ok) {
      toast.error(json.error?.message || 'Could not add quick reply');
      return;
    }
    setReplyTitle('');
    setReplyBody('');
    await load();
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg">
      <header className="flex h-[64px] shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
        <button onClick={() => router.back()} className="icon-btn" aria-label="Go back">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div>
          <h1 className="text-[15px] font-bold text-ink">LINKUPCHAT Business</h1>
          <p className="text-xs text-muted">Profile, verification, greeting, and quick replies</p>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto px-4 py-5">
        <div className="mx-auto max-w-xl space-y-5">
          {locked && (
            <p className="rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-muted">
              Business tools need an active Business plan.{' '}
              <Link href="/app/premium" className="font-semibold text-brand-500">
                View plans
              </Link>
            </p>
          )}
          <section className="card space-y-3 p-5">
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-ink">Business profile</h2>
              <span className="text-xs font-semibold uppercase text-muted">
                {profile?.verificationStatus ?? 'UNVERIFIED'}
              </span>
            </div>
            {profile?.verificationNote && <p className="text-sm text-muted">{profile.verificationNote}</p>}
            <label className="block text-sm">
              <span className="font-semibold text-ink">Name</span>
              <input className="input-base mt-1" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label className="block text-sm">
              <span className="font-semibold text-ink">Category</span>
              <select
className="input-base mt-1"
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
              >
                {CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="font-semibold text-ink">Description</span>
              <textarea
                className="input-base mt-1 min-h-[5rem]"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </label>
            <label className="block text-sm">
              <span className="font-semibold text-ink">Website</span>
              <input className="input-base mt-1" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
            </label>
            <label className="block text-sm">
              <span className="font-semibold text-ink">Greeting</span>
              <textarea
                className="input-base mt-1 min-h-[4rem]"
                value={form.greeting}
                onChange={(e) => setForm({ ...form, greeting: e.target.value })}
              />
            </label>
            <label className="block text-sm">
              <span className="font-semibold text-ink">Away message</span>
              <textarea
                className="input-base mt-1 min-h-[4rem]"
                value={form.awayMessage}
                onChange={(e) => setForm({ ...form, awayMessage: e.target.value })}
              />
            </label>
            <label className="flex items-center gap-2 text-sm font-semibold text-ink">
              <input
                type="checkbox"
                checked={form.awayEnabled}
                onChange={(e) => setForm({ ...form, awayEnabled: e.target.checked })}
              />
              Send away message
            </label>
            <div className="flex flex-wrap gap-2">
              <button className="btn-primary" onClick={() => void save()}>
                Save profile
              </button>
              <button className="btn-secondary" onClick={() => void requestReview()}>
                Request verification
              </button>
            </div>
            <p className="text-xs text-muted">Verification is reviewed by a moderator. You cannot approve your own business.</p>
          </section>

          <section className="card space-y-3 p-5">
            <h2 className="font-bold text-ink">Quick replies</h2>
            <ul className="space-y-2">
              {replies.map((reply) => (
                <li key={reply.id} className="rounded-xl border border-border px-3 py-2 text-sm">
                  <p className="font-semibold text-ink">{reply.title}</p>
                  <p className="text-muted">{reply.body}</p>
                </li>
              ))}
            </ul>
            <input className="input-base" placeholder="Title" value={replyTitle} onChange={(e) => setReplyTitle(e.target.value)} />
            <textarea className="input-base min-h-[4rem]" placeholder="Reply" value={replyBody} onChange={(e) => setReplyBody(e.target.value)} />
            <button className="btn-secondary" onClick={() => void addReply()}>
              Add quick reply
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}
