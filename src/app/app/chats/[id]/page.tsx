'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Users, Shield, BellOff, LogOut, UserMinus, UserPlus, Crown, MessageCircle, X, Camera, Save } from 'lucide-react';
import { ConversationView } from '@/components/chat/ConversationView';
import { useChat } from '@/context/ChatProvider';
import { useCall } from '@/context/CallProvider';
import { useGroupCall } from '@/context/GroupCallProvider';
import { useAuth } from '@/context/AuthProvider';
import { useSocket } from '@/context/SocketProvider';
import { Avatar } from '@/components/ui/Avatar';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { PageLoader } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { cn, formatRelativeLastSeen } from '@/lib/utils';
import type { ConversationDTO } from '@/types';

export default function ConversationPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { presence } = useSocket();
  const { startCall } = useCall();
  const { startGroupCall } = useGroupCall();
  const toast = useToast();
  const {
    conversations,
    conversationsLoaded,
    setActive,
    patchConversation,
    refreshConversations
  } = useChat();

  const [infoOpen, setInfoOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [memberQuery, setMemberQuery] = useState('');
  const [searchResults, setSearchResults] = useState<
    { id: string; username: string; displayName: string; avatarUrl: string | null }[]
  >([]);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [groupPicker, setGroupPicker] = useState<'VOICE' | 'VIDEO' | null>(null);
  const [pickedIds, setPickedIds] = useState<string[]>([]);
  const photoInputRef = useRef<HTMLInputElement>(null);

  const conversation = conversations.find((c) => c.id === params.id) ?? null;

  // Seed the group-info form whenever the panel opens.
  useEffect(() => {
    if (infoOpen && conversation) {
      setEditTitle(conversation.title ?? '');
      setEditDescription(conversation.description ?? '');
    }
  }, [infoOpen, conversation?.title, conversation?.description]);

  useEffect(() => {
    if (params.id) setActive(params.id);
  }, [params.id, setActive]);

  if (!conversationsLoaded) return <PageLoader label="Opening conversation…" />;

  if (!conversation) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
        <p className="text-lg font-semibold text-ink">Conversation not found</p>
        <p className="text-sm text-muted">
          It may have been removed, or you may not have access anymore.
        </p>
        <button onClick={() => router.push('/app/chats')} className="btn-primary">
          Back to chats
        </button>
      </div>
    );
  }

  const peerOnline = conversation.peer
    ? presence[conversation.peer.id]?.online ?? conversation.peer.isOnline
    : false;

  async function toggleRole(userId: string, role: 'MEMBER' | 'ADMIN') {
    const res = await fetch(`/api/conversations/${conversation!.id}/members`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, role }),
      credentials: 'include'
    });
    const json = await res.json().catch(() => null);
    if (!json?.ok) {
      toast.error('Could not change role', json?.error?.message ?? 'Try again.');
      return;
    }
    await refreshConversations();
  }

  async function removeMember(userId: string) {
    const res = await fetch(`/api/conversations/${conversation!.id}/members`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
      credentials: 'include'
    });
    const json = await res.json().catch(() => null);
    if (!json?.ok) {
      toast.error('Could not remove member', json?.error?.message ?? 'Try again.');
      return;
    }
    await refreshConversations();
  }

  async function addMember(userId: string) {
    const res = await fetch(`/api/conversations/${conversation!.id}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userIds: [userId] }),
      credentials: 'include'
    });
    const json = await res.json();
    if (json.ok) {
      toast.success('Member added');
      await refreshConversations();
    } else {
      toast.error('Could not add member', json.error?.message);
    }
  }

  async function searchPeople(q: string) {
    setMemberQuery(q);
    if (q.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    const res = await fetch(`/api/users/search?q=${encodeURIComponent(q)}`, { credentials: 'include' });
    const json = await res.json();
    if (json.ok) setSearchResults(json.data.users);
  }

  async function leaveGroup() {
    const res = await fetch(`/api/conversations/${conversation!.id}/members`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: user!.id }),
      credentials: 'include'
    });
    const json = await res.json().catch(() => null);
    if (!json?.ok) {
      // e.g. LAST_ADMIN — surface the server's guidance instead of pretending.
      toast.error('Could not leave group', json?.error?.message ?? 'Try again.');
      return;
    }
    toast.success('You left the group');
    router.push('/app/chats');
    void refreshConversations();
  }

  const canEditInfo =
    conversation.type === 'GROUP' &&
    (conversation.myRole === 'ADMIN' || !conversation.onlyAdminsEditInfo);
  const canAddMembers =
    conversation.type === 'GROUP' &&
    (conversation.myRole === 'ADMIN' || !conversation.onlyAdminsAddMembers);
  const adminCount = (conversation.members ?? []).filter((m) => m.role === 'ADMIN').length;
  const isLastAdmin = conversation.type === 'GROUP' && conversation.myRole === 'ADMIN' && adminCount <= 1;

  async function saveGroupInfo() {
    const res = await fetch(`/api/conversations/${conversation!.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: editTitle.trim() || undefined,
        description: editDescription.trim()
      }),
      credentials: 'include'
    });
    const json = await res.json().catch(() => null);
    if (!json?.ok) {
      toast.error('Could not save group info', json?.error?.message ?? 'Try again.');
      return;
    }
    patchConversation(conversation!.id, {
      title: editTitle.trim(),
      description: editDescription.trim()
    });
    toast.success('Group updated');
  }

  async function changeGroupPhoto(file: File) {
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('purpose', 'group');
      const up = await fetch('/api/upload', { method: 'POST', body: fd, credentials: 'include' });
      const upJson = await up.json();
      if (!upJson.ok) throw new Error(upJson.error?.message ?? 'Upload failed');
      const res = await fetch(`/api/conversations/${conversation!.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatarUrl: upJson.data.url }),
        credentials: 'include'
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? 'Could not update photo');
      patchConversation(conversation!.id, { avatarUrl: upJson.data.url });
      toast.success('Group photo updated');
    } catch (err) {
      toast.error('Could not update photo', err instanceof Error ? err.message : 'Try again.');
    }
  }

  return (
    <>
      <ConversationView
        conversation={conversation}
        onBack={() => router.push('/app/chats')}
        onOpenInfo={() => setInfoOpen(true)}
        onStartCall={
          conversation.type === 'DIRECT' && conversation.peer
            ? (type) =>
                startCall(
                  {
                    id: conversation.peer!.id,
                    username: conversation.peer!.username,
                    displayName: conversation.peer!.displayName,
                    avatarUrl: conversation.peer!.avatarUrl
                  },
                  type
                )
            : conversation.type === 'GROUP'
              ? (type) => {
                  const others = (conversation.members ?? []).filter((m) => m.userId !== user?.id);
                  if (others.length > 3) {
                    setPickedIds([]);
                    setGroupPicker(type);
                    return;
                  }
                  startGroupCall({ conversationId: conversation.id, type });
                }
              : undefined
        }
      />

      {/* ── Chat info panel ── */}
      <Modal
        open={infoOpen}
        onClose={() => setInfoOpen(false)}
        title={conversation.type === 'GROUP' ? 'Group info' : 'Contact info'}
        size="sm"
      >
        <div className="flex flex-col items-center text-center">
          <button
            type="button"
            onClick={() => (canEditInfo ? photoInputRef.current?.click() : undefined)}
            className={cn('relative rounded-full', canEditInfo && 'cursor-pointer')}
            aria-label={canEditInfo ? 'Change group photo' : 'Group photo'}
            title={canEditInfo ? 'Change group photo' : undefined}
          >
            <Avatar
              name={conversation.type === 'GROUP' ? conversation.title ?? 'Group' : conversation.peer?.displayName ?? '?'}
              src={conversation.type === 'GROUP' ? conversation.avatarUrl : conversation.peer?.avatarUrl}
              size="xl"
              online={conversation.type === 'DIRECT' ? peerOnline : undefined}
            />
            {canEditInfo && (
              <span className="absolute -bottom-1 -right-1 flex h-7 w-7 items-center justify-center rounded-full border border-border bg-surface shadow-pop">
                <Camera className="h-3.5 w-3.5 text-brand-500" aria-hidden />
              </span>
            )}
          </button>
          <input
            ref={photoInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void changeGroupPhoto(f);
              e.target.value = '';
            }}
          />
          <h3 className="mt-3 text-lg font-bold text-ink">
            {conversation.type === 'GROUP' ? conversation.title : conversation.peer?.displayName}
          </h3>
          <p className="text-sm text-muted">
            {conversation.type === 'GROUP'
              ? `${conversation.memberCount} members`
              : `@${conversation.peer?.username}`}
          </p>
          {conversation.type === 'GROUP' && conversation.createdAt && (
            <p className="mt-1 text-xs text-faint">
              Created {new Date(conversation.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
            </p>
          )}
          {conversation.type === 'DIRECT' && (
            <p className="mt-1 text-xs text-faint">
              {peerOnline
                ? 'Online now'
                : conversation.peer?.lastSeenAt
                  ? `last seen ${formatRelativeLastSeen(conversation.peer.lastSeenAt)}`
                  : ''}
            </p>
          )}
          {conversation.description && (
            <p className="mt-3 rounded-xl bg-ink/[0.04] px-4 py-2.5 text-sm text-muted dark:bg-white/[0.05]">
              {conversation.description}
            </p>
          )}
        </div>

        {/* Privacy note */}
        <div className="mt-5 flex items-start gap-2.5 rounded-xl border border-brand-500/20 bg-brand-500/[0.05] px-3.5 py-3">
          <Shield className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" aria-hidden />
          <p className="text-xs leading-relaxed text-muted">
            Messages in this chat are protected by secure transport and access controls. Only
            members of this conversation can see them.
          </p>
        </div>

        {/* Group management */}
        {conversation.type === 'GROUP' && (
          <div className="mt-5">
            {/* Group info editing (D2: members may edit only when onlyAdminsEditInfo is off) */}
            {canEditInfo && (
              <div className="mb-4">
                <p className="mb-2 text-xs font-bold uppercase tracking-wider text-faint">Group info</p>
                <input
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  placeholder="Group name"
                  aria-label="Group name"
                  maxLength={60}
                  className="input-base !py-2 text-sm"
                />
                <textarea
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  placeholder="Group description (optional)"
                  aria-label="Group description"
                  maxLength={300}
                  rows={2}
                  className="input-base mt-2 !py-2 text-sm"
                />
                <button
                  onClick={() => void saveGroupInfo()}
                  disabled={!editTitle.trim() || (editTitle.trim() === conversation.title && editDescription.trim() === (conversation.description ?? ''))}
                  className="btn-secondary mt-2 flex w-full items-center justify-center gap-2 !py-2 text-sm disabled:opacity-50"
                >
                  <Save className="h-4 w-4" aria-hidden /> Save changes
                </button>
              </div>
            )}

            {canAddMembers && (
              <div className="mb-4">
                <p className="mb-2 text-xs font-bold uppercase tracking-wider text-faint">Add members</p>
                <input
                  value={memberQuery}
                  onChange={(e) => void searchPeople(e.target.value)}
                  placeholder="Search people to add…"
                  aria-label="Search people to add"
                  className="input-base !py-2 text-sm"
                />
                {searchResults.length > 0 && (
                  <div className="mt-2 max-h-40 space-y-1 overflow-y-auto scroll-thin">
                    {searchResults
                      .filter((r) => !conversation.members?.some((m) => m.userId === r.id))
                      .map((r) => (
                        <button
                          key={r.id}
                          onClick={() => void addMember(r.id)}
                          className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left hover:bg-ink/[0.05] dark:hover:bg-white/[0.06]"
                        >
                          <Avatar name={r.displayName} src={r.avatarUrl} size="xs" />
                          <span className="flex-1 truncate text-sm font-medium text-ink">{r.displayName}</span>
                          <UserPlus className="h-4 w-4 text-brand-500" aria-hidden />
                        </button>
                      ))}
                  </div>
                )}
              </div>
            )}

            <p className="mb-2 text-xs font-bold uppercase tracking-wider text-faint">
              Members · {conversation.memberCount}
            </p>
            <div className="max-h-56 space-y-0.5 overflow-y-auto scroll-thin">
              {conversation.members?.map((m) => (
                <div key={m.userId} className="flex items-center gap-2.5 rounded-xl px-2 py-2">
                  <Avatar name={m.user.displayName} src={m.user.avatarUrl} size="sm" online={m.user.isOnline} />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 truncate text-sm font-semibold text-ink">
                      {m.user.displayName}
                      {m.role === 'ADMIN' && (
                        <span className="flex items-center gap-0.5 rounded-full bg-gold-500/15 px-1.5 py-0.5 text-[10px] font-bold text-gold-500">
                          <Crown className="h-2.5 w-2.5" aria-hidden /> ADMIN
                        </span>
                      )}
                    </p>
                    <p className="truncate text-xs text-muted">@{m.user.username}</p>
                  </div>
                  {m.canManageMembers && (
                    <div className="flex gap-1">
                      <button
                        onClick={() =>
                          void toggleRole(m.userId, m.role === 'ADMIN' ? 'MEMBER' : 'ADMIN')
                        }
                        className="icon-btn h-7 w-7"
                        aria-label={m.role === 'ADMIN' ? 'Remove admin' : 'Make admin'}
                        title={m.role === 'ADMIN' ? 'Remove admin' : 'Make admin'}
                      >
                        <Crown className={cn('h-3.5 w-3.5', m.role === 'ADMIN' ? 'text-gold-500' : '')} />
                      </button>
                      <button
                        onClick={() => void removeMember(m.userId)}
                        className="icon-btn h-7 w-7 text-coral-500"
                        aria-label="Remove member"
                        title="Remove member"
                      >
                        <UserMinus className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Group permissions */}
            {conversation.myRole === 'ADMIN' && (
              <div className="mt-4">
                <p className="mb-2 text-xs font-bold uppercase tracking-wider text-faint">Permissions</p>
                {(
                  [
                    ['onlyAdminsMessage', 'Only admins can send messages'],
                    ['onlyAdminsEditInfo', 'Only admins can edit group info'],
                    ['onlyAdminsAddMembers', 'Only admins can add members']
                  ] as const
                ).map(([key, label]) => (
                  <label
                    key={key}
                    className="flex cursor-pointer items-center gap-2.5 rounded-xl px-2 py-2 text-sm text-ink hover:bg-ink/[0.04]"
                  >
                    <input
                      type="checkbox"
                      checked={Boolean(conversation[key])}
                      onChange={async (e) => {
                        patchConversation(conversation.id, { [key]: e.target.checked });
                        await fetch(`/api/conversations/${conversation.id}`, {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ [key]: e.target.checked }),
                          credentials: 'include'
                        });
                      }}
                      className="h-4 w-4 rounded accent-[#6D5EF5]"
                    />
                    {label}
                  </label>
                ))}
              </div>
            )}

            <button
              onClick={() => setLeaveOpen(true)}
              disabled={isLastAdmin}
              title={isLastAdmin ? 'Promote another admin before leaving the group' : undefined}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl border border-coral-500/30 px-4 py-2.5 text-sm font-semibold text-coral-500 transition-colors hover:bg-coral-500/[0.08] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
            >
              <LogOut className="h-4 w-4" aria-hidden /> Leave group
            </button>
            {isLastAdmin && (
              <p className="mt-2 text-center text-xs text-faint">
                Promote another admin before leaving the group.
              </p>
            )}
          </div>
        )}

        {conversation.type === 'DIRECT' && conversation.peer && (
          <div className="mt-5 space-y-2">
            <button
              onClick={() => router.push(`/app/u/${conversation.peer!.username}`)}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm font-semibold text-ink transition-colors hover:bg-ink/[0.04]"
            >
              <MessageCircle className="h-4 w-4" aria-hidden /> View profile
            </button>
          </div>
        )}
      </Modal>

      <Modal
        open={groupPicker !== null}
        onClose={() => setGroupPicker(null)}
        title="Choose people"
        description="Group calls connect directly and are limited to 4 people, including you. Larger groups need a media server, which is not configured."
        size="sm"
      >
        <div className="max-h-72 space-y-2 overflow-y-auto">
          {(conversation?.members ?? [])
            .filter((m) => m.userId !== user?.id)
            .map((m) => {
              const on = pickedIds.includes(m.userId);
              return (
                <label key={m.userId} className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-ink/[0.04]">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() =>
                      setPickedIds((prev) => {
                        if (on) return prev.filter((id) => id !== m.userId);
                        if (prev.length >= 3) return prev;
                        return [...prev, m.userId];
                      })
                    }
                  />
                  <Avatar name={m.user.displayName} src={m.user.avatarUrl} size="sm" />
                  <span className="min-w-0 truncate text-sm font-medium text-ink">{m.user.displayName}</span>
                </label>
              );
            })}
        </div>
        <button
          type="button"
          className="btn-primary mt-4 h-10 w-full text-sm"
          disabled={pickedIds.length === 0 || !groupPicker}
          onClick={() => {
            if (!groupPicker || !conversation) return;
            startGroupCall({ conversationId: conversation.id, type: groupPicker, inviteeIds: pickedIds });
            setGroupPicker(null);
          }}
        >
          Start {groupPicker === 'VIDEO' ? 'video' : 'voice'} call ({pickedIds.length}/3)
        </button>
      </Modal>

      <ConfirmDialog
        open={leaveOpen}
        onClose={() => setLeaveOpen(false)}
        onConfirm={async () => {
          await leaveGroup();
          setLeaveOpen(false);
        }}
        title="Leave group?"
        message="You will stop receiving messages from this group. You can be added back at any time."
        confirmLabel="Leave"
        destructive
      />
    </>
  );
}
