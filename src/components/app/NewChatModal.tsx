'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, Users, MessageCircle, UserPlus, Check, Camera } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Avatar } from '@/components/ui/Avatar';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { useDebouncedValue } from '@/hooks/useMediaQuery';
import type { UserDTO } from '@/types';

interface NewChatModalProps {
  open: boolean;
  onClose: () => void;
  mode?: 'chat' | 'group';
}

export function NewChatModal({ open, onClose, mode = 'chat' }: NewChatModalProps) {
  const router = useRouter();
  const toast = useToast();
  const [tab, setTab] = useState<'direct' | 'group'>(mode === 'group' ? 'group' : 'direct');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UserDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<UserDTO[]>([]);
  const [groupName, setGroupName] = useState('');
  const [groupPhoto, setGroupPhoto] = useState<File | null>(null);
  const [creating, setCreating] = useState(false);
  const photoRef = useRef<HTMLInputElement>(null);

  const debounced = useDebouncedValue(query, 300);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setSelected([]);
      setGroupName('');
      setGroupPhoto(null);
      return;
    }
    if (debounced.trim().length < 2) {
      setResults([]);
      return;
    }
    setLoading(true);
    fetch(`/api/users/search?q=${encodeURIComponent(debounced)}`, { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) setResults(j.data.users);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [debounced, open]);

  async function startDirect(user: UserDTO) {
    setCreating(true);
    try {
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'DIRECT', username: user.username }),
        credentials: 'include'
      });
      const json = await res.json();
      if (!json.ok) {
        toast.error('Could not start chat', json.error?.message);
        return;
      }
      onClose();
      router.push(`/app/chats/${json.data.conversation.id}`);
    } finally {
      setCreating(false);
    }
  }

  async function createGroup() {
    if (!groupName.trim() || selected.length === 0) return;
    setCreating(true);
    try {
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'GROUP',
          title: groupName.trim(),
          memberIds: selected.map((u) => u.id)
        }),
        credentials: 'include'
      });
      const json = await res.json();
      if (!json.ok) {
        toast.error('Could not create group', json.error?.message);
        return;
      }
      const conversationId = json.data.conversation.id as string;

      // D3: group photo via the existing upload pipeline (purpose=group →
      // GROUP_AVATAR) then PATCH the conversation avatar.
      if (groupPhoto) {
        try {
          const fd = new FormData();
          fd.append('file', groupPhoto);
          fd.append('purpose', 'group');
          const up = await fetch('/api/upload', { method: 'POST', body: fd, credentials: 'include' });
          const upJson = await up.json();
          if (upJson.ok) {
            await fetch(`/api/conversations/${conversationId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ avatarUrl: upJson.data.url }),
              credentials: 'include'
            });
          }
        } catch {
          // photo is optional — the group is created either way
        }
      }

      toast.success('Group created!', `${groupName} is ready.`);
      onClose();
      router.push(`/app/chats/${conversationId}`);
    } finally {
      setCreating(false);
    }
  }

  function toggleSelect(user: UserDTO) {
    setSelected((prev) =>
      prev.find((u) => u.id === user.id)
        ? prev.filter((u) => u.id !== user.id)
        : [...prev, user]
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={tab === 'direct' ? 'New chat' : 'New group'}
      description={
        tab === 'direct'
          ? 'Find someone by name, @username or email.'
          : 'Select members and name your group.'
      }
      size="md"
    >
      <div className="mb-4 flex gap-1 rounded-full bg-ink/[0.05] p-1 dark:bg-white/[0.06]">
        {(['direct', 'group'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={
              'flex-1 rounded-full px-4 py-1.5 text-sm font-semibold transition-colors ' +
              (tab === t ? 'bg-surface text-ink shadow-soft' : 'text-muted hover:text-ink')
            }
          >
            {t === 'direct' ? 'Direct message' : 'Create group'}
          </button>
        ))}
      </div>

      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by name, @username or email…"
        icon={<Search className="h-4 w-4" />}
        aria-label="Search people"
      />

      {tab === 'group' && selected.length > 0 && (
        <div className="mt-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => photoRef.current?.click()}
              className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-dashed border-border-strong text-muted transition-colors hover:border-brand-500 hover:text-brand-500"
              aria-label="Add group photo"
              title="Add group photo (optional)"
            >
              {groupPhoto ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={URL.createObjectURL(groupPhoto)} alt="Group" className="h-full w-full object-cover" />
              ) : (
                <Camera className="h-5 w-5" aria-hidden />
              )}
            </button>
            <input
              ref={photoRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) setGroupPhoto(f);
                e.target.value = '';
              }}
            />
            <div className="min-w-0 flex-1">
              <Input
                label="Group name"
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder="Weekend Crew 🎉"
                maxLength={60}
              />
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {selected.map((u) => (
              <button
                key={u.id}
                onClick={() => toggleSelect(u)}
                className="flex items-center gap-1.5 rounded-full bg-brand-500/[0.1] px-3 py-1.5 text-xs font-semibold text-brand-600 dark:text-brand-300"
              >
                {u.displayName} ✕
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4 max-h-72 space-y-0.5 overflow-y-auto scroll-thin">
        {results.length === 0 ? (
          <EmptyState
            compact
            icon={<Search className="h-6 w-6" />}
            title={query ? (loading ? 'Searching…' : 'No users found') : 'Find people'}
            description={
              query
                ? 'Try a different name or username.'
                : 'Search for someone to start a conversation.'
            }
          />
        ) : (
          results.map((u) => {
            const isSelected = selected.some((s) => s.id === u.id);
            return (
              <button
                key={u.id}
                onClick={() => (tab === 'direct' ? void startDirect(u) : toggleSelect(u))}
                disabled={creating}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-ink/[0.05] dark:hover:bg-white/[0.06]"
              >
                <Avatar name={u.displayName} src={u.avatarUrl} size="sm" online={u.isOnline} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-ink">{u.displayName}</p>
                  <p className="truncate text-xs text-muted">@{u.username}</p>
                </div>
                {tab === 'direct' ? (
                  <MessageCircle className="h-4 w-4 text-brand-500" aria-hidden />
                ) : (
                  <span
                    className={
                      'flex h-5 w-5 items-center justify-center rounded-full border-2 ' +
                      (isSelected ? 'border-brand-500 bg-brand-500 text-white' : 'border-border-strong')
                    }
                  >
                    {isSelected && <Check className="h-3 w-3" aria-hidden />}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>

      {tab === 'group' && (
        <Button
          className="mt-4 w-full"
          size="lg"
          disabled={selected.length === 0 || !groupName.trim()}
          loading={creating}
          onClick={() => void createGroup()}
        >
          <Users className="h-4 w-4" aria-hidden />
          Create Group ({selected.length + 1} members)
        </Button>
      )}
    </Modal>
  );
}
