'use client';

import { useEffect, useState } from 'react';
import { Search, ShieldCheck, Ban, UserX, RotateCcw, Crown } from 'lucide-react';
import { Avatar } from '@/components/ui/Avatar';
import { EmptyState } from '@/components/ui/EmptyState';
import { ChatListSkeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { useDebouncedValue } from '@/hooks/useMediaQuery';
import { cn, formatDate } from '@/lib/utils';

interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: string;
  status: string;
  createdAt: string;
  lastSeenAt: string | null;
  messageCount: number;
}

export default function AdminUsersPage() {
  const toast = useToast();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState('');
  const debounced = useDebouncedValue(query, 350);

  async function load(q: string) {
    setLoaded(false);
    try {
      const res = await fetch(`/api/admin/users?q=${encodeURIComponent(q)}`, {
        credentials: 'include'
      });
      const json = await res.json();
      if (json.ok) setUsers(json.data.users);
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    void load(debounced);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  async function act(userId: string, action: string, role?: string) {
    const res = await fetch('/api/admin/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, action, role }),
      credentials: 'include'
    });
    const json = await res.json();
    if (json.ok) {
      toast.success('User updated', `Action: ${action.toLowerCase()}`);
      void load(debounced);
    } else {
      toast.error('Action failed', json.error?.message);
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-2xl font-extrabold text-ink">User moderation</h1>
      <p className="mt-1 text-sm text-muted">Search, suspend or ban accounts.</p>

      <div className="relative mt-6 max-w-md">
        <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, username or email…"
          aria-label="Search users"
          className="input-base !rounded-full !py-2.5 pl-11"
        />
      </div>

      <div className="mt-6">
        {!loaded ? (
          <ChatListSkeleton />
        ) : users.length === 0 ? (
          <EmptyState icon={<Search className="h-7 w-7" />} title="No users found" description="Try a different search." />
        ) : (
          <div className="card overflow-hidden">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wider text-faint">
                  <th className="px-5 py-3">User</th>
                  <th className="px-5 py-3">Role</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">Messages</th>
                  <th className="px-5 py-3">Joined</th>
                  <th className="px-5 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-b border-border last:border-0">
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-3">
                        <Avatar name={u.displayName} src={null} size="sm" />
                        <div>
                          <p className="font-semibold text-ink">{u.displayName}</p>
                          <p className="text-xs text-muted">
                            @{u.username} {u.email ? `· ${u.email}` : ''}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      <span
                        className={cn(
                          'rounded-full px-2.5 py-1 text-xs font-semibold',
                          u.role === 'ADMIN'
                            ? 'bg-coral-500/12 text-coral-500'
                            : u.role === 'MODERATOR'
                              ? 'bg-gold-500/15 text-gold-500'
                              : 'bg-ink/[0.06] text-muted'
                        )}
                      >
                        {u.role}
                      </span>
                    </td>
                    <td className="px-5 py-3.5">
                      <span
                        className={cn(
                          'rounded-full px-2.5 py-1 text-xs font-semibold',
                          u.status === 'ACTIVE'
                            ? 'bg-mint-500/12 text-mint-600'
                            : u.status === 'BANNED'
                              ? 'bg-coral-500/12 text-coral-500'
                              : 'bg-gold-500/15 text-gold-500'
                        )}
                      >
                        {u.status}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 tabular-nums text-muted">{u.messageCount}</td>
                    <td className="px-5 py-3.5 text-muted">{formatDate(u.createdAt)}</td>
                    <td className="px-5 py-3.5">
                      <div className="flex justify-end gap-1.5">
                        {u.status === 'ACTIVE' ? (
                          <>
                            <button
                              onClick={() => void act(u.id, 'SUSPEND')}
                              className="icon-btn h-8 w-8 text-gold-500"
                              aria-label={`Suspend ${u.displayName}`}
                              title="Suspend"
                            >
                              <UserX className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => void act(u.id, 'BAN')}
                              className="icon-btn h-8 w-8 text-coral-500"
                              aria-label={`Ban ${u.displayName}`}
                              title="Ban"
                            >
                              <Ban className="h-4 w-4" />
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => void act(u.id, 'ACTIVATE')}
                            className="icon-btn h-8 w-8 text-mint-500"
                            aria-label={`Reactivate ${u.displayName}`}
                            title="Reactivate"
                          >
                            <RotateCcw className="h-4 w-4" />
                          </button>
                        )}
                        <button
                          onClick={() => void act(u.id, 'SET_ROLE', u.role === 'ADMIN' ? 'USER' : 'ADMIN')}
                          className="icon-btn h-8 w-8"
                          aria-label="Toggle admin role"
                          title={u.role === 'ADMIN' ? 'Remove admin' : 'Make admin'}
                        >
                          <Crown className={cn('h-4 w-4', u.role === 'ADMIN' ? 'text-gold-500' : '')} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
