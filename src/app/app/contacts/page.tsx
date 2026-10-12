'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { UserPlus, MessageCircle, UserMinus, Ban, Search, Users, RefreshCw } from 'lucide-react';
import { Avatar } from '@/components/ui/Avatar';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/Modal';
import { ChatListSkeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { useIsMobile } from '@/hooks/useMediaQuery';
import type { ContactDTO, UserDTO } from '@/types';

export default function ContactsPage() {
  const router = useRouter();
  const toast = useToast();
  const isMobile = useIsMobile();
  const [contacts, setContacts] = useState<ContactDTO[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<UserDTO[]>([]);
  const [suggestions, setSuggestions] = useState<(UserDTO & { mutualCount?: number })[]>([]);
  const [removeTarget, setRemoveTarget] = useState<ContactDTO | null>(null);

  async function load() {
    setLoaded(false);
    try {
      const res = await fetch('/api/contacts', { credentials: 'include' });
      const json = await res.json();
      if (json.ok) setContacts(json.data.contacts);
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    void load();
    void fetch('/api/users/discover', { credentials: 'include' })
      .then((r) => r.json())
      .then((json) => {
        if (json.ok) setSuggestions(json.data.users ?? []);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setFound([]);
      return;
    }
    const timer = setTimeout(() => {
      void fetch(`/api/users/search?q=${encodeURIComponent(q)}`, { credentials: 'include' })
        .then((r) => r.json())
        .then((json) => {
          if (json.ok) setFound(json.data.users ?? []);
        })
        .catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  async function startChat(username: string) {
    const res = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'DIRECT', username }),
      credentials: 'include'
    });
    const json = await res.json();
    if (json.ok) router.push(`/app/chats/${json.data.conversation.id}`);
  }

  async function removeContact(userId: string) {
    await fetch('/api/contacts', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
      credentials: 'include'
    });
    toast.success('Contact removed');
    void load();
  }

  async function blockUser(username: string) {
    await fetch(`/api/users/${username}/block`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocked: true }),
      credentials: 'include'
    });
    toast.success('User blocked', 'They can no longer message you or stay in your contacts.');
    void load();
  }

  async function addFound(userId: string) {
    const res = await fetch('/api/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
      credentials: 'include'
    });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) {
      toast.error('Could not add contact', json.error?.message);
      return;
    }
    toast.success('Added to contacts');
    void load();
  }

  const filtered = contacts.filter((c) => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return c.user.displayName.toLowerCase().includes(q) || c.user.username.includes(q);
  });

  if (isMobile && contacts.length === 0 && loaded) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-8">
        <EmptyState
          icon={<UserPlus className="h-7 w-7" />}
          title="No contacts yet"
          description="Search for people by name or username to add them."
          action={
            <button onClick={() => router.push('/app/chats')} className="btn-primary h-9 px-4 text-xs">
              <Search className="h-3.5 w-3.5" aria-hidden /> Find people
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header (desktop detail pane) */}
      <header className="flex h-[64px] shrink-0 items-center gap-3 border-b border-border bg-surface px-5">
        <Users className="h-5 w-5 text-brand-500" aria-hidden />
        <div>
          <h1 className="text-[15px] font-bold text-ink">Contacts</h1>
          <p className="text-xs text-muted">{contacts.length} people on LINKUPCHAT</p>
        </div>
        <button onClick={() => void load()} className="icon-btn ml-auto" aria-label="Refresh contacts">
          <RefreshCw className="h-4 w-4" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto scroll-thin p-3 sm:p-6">
        <div className="mx-auto max-w-2xl">
          <div className="relative mb-6">
            <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your contacts…"
              aria-label="Search contacts"
              className="input-base !rounded-full !py-3 pl-11"
            />
          </div>

          {found.length > 0 && (
            <div className="mb-6 space-y-2">
              <h2 className="text-xs font-bold uppercase tracking-[0.14em] text-faint">Find people</h2>
              {found.map((person) => (
                <div key={person.id} className="card flex items-center gap-3 p-3">
                  <Avatar name={person.displayName} src={person.avatarUrl} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink">{person.displayName}</p>
                    <p className="truncate text-xs text-muted">@{person.username}</p>
                  </div>
                  <button type="button" className="btn-secondary !h-9 !px-3 !text-xs" onClick={() => void addFound(person.id)}>
                    Add
                  </button>
                </div>
              ))}
            </div>
          )}

          {suggestions.length > 0 && !query.trim() && (
            <div className="mb-6 space-y-2">
              <h2 className="text-xs font-bold uppercase tracking-[0.14em] text-faint">People you may know</h2>
              {suggestions.map((person) => (
                <div key={person.id} className="card flex items-center gap-3 p-3">
                  <Avatar name={person.displayName} src={person.avatarUrl} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink">{person.displayName}</p>
                    <p className="truncate text-xs text-muted">
                      @{person.username}
                      {person.mutualCount ? ` · ${person.mutualCount} mutual` : ''}
                    </p>
                  </div>
                  <button type="button" className="btn-secondary !h-9 !px-3 !text-xs" onClick={() => void addFound(person.id)}>
                    Add
                  </button>
                </div>
              ))}
            </div>
          )}

          {!loaded ? (
            <ChatListSkeleton />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<UserPlus className="h-7 w-7" />}
              title={query ? 'No matches' : 'No contacts yet'}
              description={
                query
                  ? 'Try a different name or username.'
                  : 'Search for someone to start chatting.'
              }
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {filtered.map((c) => (
                <div key={c.id} className="card flex items-center gap-3.5 p-4">
                  <Avatar name={c.user.displayName} src={c.user.avatarUrl} size="lg" online={c.user.isOnline} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold text-ink">{c.user.displayName}</p>
                    <p className="truncate text-xs text-muted">@{c.user.username}</p>
                    <p className="mt-0.5 truncate text-xs text-faint">{c.user.about}</p>
                  </div>
                  <div className="flex shrink-0 flex-col gap-1.5">
                    <button
                      onClick={() => void startChat(c.user.username)}
                      className="btn-primary !h-11 !px-3 !text-xs"
                      aria-label={`Message ${c.user.displayName}`}
                    >
                      <MessageCircle className="h-3.5 w-3.5" aria-hidden /> Message
                    </button>
                    <div className="flex gap-1">
                      <button
                        onClick={() => setRemoveTarget(c)}
                        className="icon-btn h-11 w-11"
                        aria-label={`Remove ${c.user.displayName}`}
                        title="Remove contact"
                      >
                        <UserMinus className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => void blockUser(c.user.username)}
                        className="icon-btn h-11 w-11 text-coral-500"
                        aria-label={`Block ${c.user.displayName}`}
                        title="Block user"
                      >
                        <Ban className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(removeTarget)}
        onClose={() => setRemoveTarget(null)}
        onConfirm={async () => {
          if (removeTarget) await removeContact(removeTarget.user.id);
          setRemoveTarget(null);
        }}
        title="Remove contact?"
        message={`${removeTarget?.user.displayName} will be removed from your contacts. Your conversations will stay intact.`}
        confirmLabel="Remove"
        destructive
      />
    </div>
  );
}
