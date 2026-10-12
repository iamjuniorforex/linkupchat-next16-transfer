'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, MessageCircle, Ban, Flag, UserCheck, UserPlus, ShieldCheck, Clock, Calendar } from 'lucide-react';
import { Avatar } from '@/components/ui/Avatar';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { PageLoader } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/context/AuthProvider';
import { cn, formatDate, formatRelativeLastSeen } from '@/lib/utils';
import type { UserDTO } from '@/types';

type ProfileDTO = UserDTO & { blockedByMe?: boolean; blockedMe?: boolean };

export default function ProfilePage() {
  const params = useParams<{ username: string }>();
  const router = useRouter();
  const toast = useToast();
  const { user: me } = useAuth();
  const [profile, setProfile] = useState<ProfileDTO | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportCategory, setReportCategory] = useState('SPAM');
  const [loadingAction, setLoadingAction] = useState(false);

  useEffect(() => {
    fetch(`/api/users/${params.username}`, { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) setProfile(j.data);
        else setNotFound(true);
      })
      .catch(() => setNotFound(true));
  }, [params.username]);

  if (notFound) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
        <p className="text-lg font-semibold text-ink">User not found</p>
        <p className="text-sm text-muted">This profile may not exist or is no longer available.</p>
        <button onClick={() => router.push('/app/chats')} className="btn-primary">
          Back to chats
        </button>
      </div>
    );
  }

  if (!profile) return <PageLoader label="Loading profile…" />;

  const isSelf = profile.id === me?.id;

  async function startChat() {
    const res = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'DIRECT', username: profile!.username }),
      credentials: 'include'
    });
    const json = await res.json();
    if (json.ok) router.push(`/app/chats/${json.data.conversation.id}`);
  }

  async function toggleBlock(blocked: boolean) {
    setLoadingAction(true);
    try {
      await fetch(`/api/users/${profile!.username}/block`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocked }),
        credentials: 'include'
      });
      setProfile({ ...profile!, blockedByMe: blocked });
      toast.success(blocked ? 'User blocked' : 'User unblocked');
    } finally {
      setLoadingAction(false);
    }
  }

  async function toggleContact(add: boolean) {
    setLoadingAction(true);
    try {
      await fetch('/api/contacts', {
        method: add ? 'POST' : 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: profile!.id }),
        credentials: 'include'
      });
      setProfile({ ...profile!, isContact: add });
      toast.success(add ? 'Added to contacts' : 'Removed from contacts');
    } finally {
      setLoadingAction(false);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <header className="flex h-[64px] shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
        <button onClick={() => router.back()} className="icon-btn" aria-label="Go back">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="text-[15px] font-bold text-ink">Profile</h1>
      </header>

      <div className="flex-1 overflow-y-auto scroll-thin">
        {/* Hero */}
        <div
          className="relative overflow-hidden bg-brand-gradient px-6 pb-14 pt-12"
          style={
            profile.coverUrl
              ? { backgroundImage: `url(${profile.coverUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }
              : profile.accentColor
                ? { background: profile.accentColor }
                : undefined
          }
        >
          <div aria-hidden className="pointer-events-none absolute inset-0 opacity-25">
            <div className="absolute -right-10 -top-10 h-52 w-52 rounded-full border-2 border-white/50" />
            <div className="absolute -bottom-16 -left-8 h-64 w-64 rounded-full border-2 border-white/40" />
          </div>
          <div className="relative flex flex-col items-center text-center">
            <Avatar name={profile.displayName} src={profile.avatarUrl} size="2xl" className="ring-4 ring-white/30" />
            <h2 className="mt-4 text-2xl font-extrabold text-white">{profile.displayName}</h2>
            <p className="mt-1 text-sm font-medium text-white/85">@{profile.username}</p>
            {profile.badge && (
              <span className="mt-2 inline-flex items-center gap-1 rounded-full bg-white/20 px-3 py-1 text-xs font-bold text-white">
                {profile.badge === 'business' ? 'Business' : 'Premium'}
                {profile.businessVerified ? ' · Verified' : ''}
              </span>
            )}
            <div className="mt-3 flex items-center gap-2">
              {profile.isOnline ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white/20 px-3 py-1 text-xs font-semibold text-white">
                  <span className="h-1.5 w-1.5 rounded-full bg-mint-400" aria-hidden /> Online
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-medium text-white/85">
                  <Clock className="h-3 w-3" aria-hidden />
                  {profile.lastSeenAt
                    ? `Last seen ${formatRelativeLastSeen(profile.lastSeenAt)}`
                    : 'Offline'}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="mx-auto -mt-6 max-w-md space-y-4 px-4 pb-8 sm:px-5">
          <div className="card space-y-3.5 p-5">
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-faint">About</p>
              <p className="sr-only">Bio</p>
              <p className="mt-1.5 text-sm leading-relaxed text-ink">
                {profile.about || 'No bio yet.'}
              </p>
              {profile.businessName && (
                <p className="mt-2 text-sm font-semibold text-ink">{profile.businessName}</p>
              )}
              {profile.businessWebsite && (
                <a
                  href={profile.businessWebsite}
                  className="mt-1 block truncate text-sm font-semibold text-brand-500"
                  rel="noreferrer"
                  target="_blank"
                >
                  {profile.businessWebsite.replace(/^https?:\/\//, '')}
                </a>
              )}
            </div>
            <div className="flex items-center gap-2 border-t border-border pt-3.5">
              <Calendar className="h-4 w-4 text-faint" aria-hidden />
              <p className="text-sm text-muted">Joined {formatDate(profile.createdAt)}</p>
            </div>
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-mint-500" aria-hidden />
              <p className="text-sm text-muted">
                Privacy settings are applied — some details may be hidden by this user.
              </p>
            </div>
          </div>

          {/* Actions */}
          <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2">
            {isSelf ? (
              <button onClick={() => router.push('/app/settings')} className="btn-primary col-span-2">
                Edit my profile
              </button>
            ) : (
              <>
                <button
                  onClick={() => void startChat()}
                  disabled={profile.blockedByMe || profile.blockedMe}
                  className="btn-primary"
                >
                  <MessageCircle className="h-4 w-4" aria-hidden /> Message
                </button>
                <button
                  onClick={() => void toggleContact(!profile.isContact)}
                  disabled={loadingAction}
                  className="btn-secondary"
                >
                  {profile.isContact ? (
                    <>
                      <UserCheck className="h-4 w-4 text-mint-500" aria-hidden /> In contacts
                    </>
                  ) : (
                    <>
                      <UserPlus className="h-4 w-4" aria-hidden /> Add contact
                    </>
                  )}
                </button>
              </>
            )}
          </div>

          {!isSelf && (
            <div className="space-y-2.5">
              {profile.blockedByMe ? (
                <button
                  onClick={() => void toggleBlock(false)}
                  className="flex w-full items-center justify-center gap-2 rounded-xl border border-mint-500/30 px-4 py-2.5 text-sm font-semibold text-mint-600 transition-colors hover:bg-mint-500/[0.08]"
                >
                  <Ban className="h-4 w-4" aria-hidden /> Unblock user
                </button>
              ) : (
                <button
                  onClick={() => void toggleBlock(true)}
                  className="flex w-full items-center justify-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm font-semibold text-muted transition-colors hover:bg-ink/[0.04] hover:text-ink"
                >
                  <Ban className="h-4 w-4" aria-hidden /> Block user
                </button>
              )}
              <button
                onClick={() => setReportOpen(true)}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-coral-500/25 px-4 py-2.5 text-sm font-semibold text-coral-500 transition-colors hover:bg-coral-500/[0.08]"
              >
                <Flag className="h-4 w-4" aria-hidden /> Report user
              </button>
            </div>
          )}

          {profile.blockedMe && (
            <div className="rounded-xl border border-gold-500/30 bg-gold-500/[0.08] px-4 py-3 text-xs leading-relaxed text-gold-500">
              This user has blocked you. You cannot send them messages.
            </div>
          )}
        </div>
      </div>

      {/* Report modal */}
      <Modal
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        title="Report user"
        description="Reports are confidential and reviewed by our moderation team."
        size="sm"
      >
        <div className="space-y-2">
          {['SPAM', 'HARASSMENT', 'IMPERSONATION', 'SCAM', 'INAPPROPRIATE', 'OTHER'].map((cat) => (
            <button
              key={cat}
              onClick={() => setReportCategory(cat)}
              className={cn(
                'w-full rounded-xl border px-4 py-2.5 text-left text-sm font-medium capitalize transition-colors',
                reportCategory === cat
                  ? 'border-brand-500 bg-brand-500/[0.08] text-brand-600'
                  : 'border-border text-ink hover:bg-ink/[0.04]'
              )}
            >
              {cat.toLowerCase().replace('_', ' ')}
            </button>
          ))}
          <button
            className="btn-danger mt-3 w-full"
            onClick={async () => {
              await fetch('/api/reports', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ category: reportCategory, reportedUserId: profile.id }),
                credentials: 'include'
              });
              toast.success('Report submitted', 'Our moderation team will review it.');
              setReportOpen(false);
            }}
          >
            <Flag className="h-4 w-4" aria-hidden /> Submit Report
          </button>
        </div>
      </Modal>
    </div>
  );
}
