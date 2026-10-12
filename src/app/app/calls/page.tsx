'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  PhoneCall,
  PhoneOutgoing,
  PhoneIncoming,
  PhoneMissed,
  Video,
  Phone,
  Trash2
} from 'lucide-react';
import { Avatar } from '@/components/ui/Avatar';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/Modal';
import { ChatListSkeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { useCall } from '@/context/CallProvider';
import { useCallHistory } from '@/hooks/useCallHistory';
import { cn, formatChatListTime, formatDuration } from '@/lib/utils';
import type { CallRecordDTO } from '@/types';

export default function CallsPage() {
  const router = useRouter();
  const { startCall } = useCall();
  const toast = useToast();
  const { calls, loaded, deleteCall } = useCallHistory();
  const [pendingDelete, setPendingDelete] = useState<CallRecordDTO | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteCall(pendingDelete.id);
      toast.success('Call removed from your history');
      setPendingDelete(null);
    } catch (err) {
      toast.error('Could not remove call', (err as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex h-[64px] shrink-0 items-center gap-3 border-b border-border bg-surface px-5">
        <PhoneCall className="h-5 w-5 text-brand-500" aria-hidden />
        <div>
          <h1 className="text-[15px] font-bold text-ink">Calls</h1>
          <p className="text-xs text-muted">Voice and video call history</p>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto scroll-thin p-3 sm:p-6">
        <div className="mx-auto max-w-2xl">
          {!loaded ? (
            <ChatListSkeleton />
          ) : calls.length === 0 ? (
            <EmptyState
              icon={<PhoneCall className="h-7 w-7" />}
              title="No calls yet"
              description="Start a voice or video call from any conversation — tap the phone icons in the chat header."
              action={
                <button onClick={() => router.push('/app/chats')} className="btn-primary h-9 px-4 text-xs">
                  Go to chats
                </button>
              }
            />
          ) : (
            <div className="space-y-2.5">
              {calls.map((c) => {
                const missed = c.status === 'MISSED' || c.status === 'DECLINED';
                const Icon =
                  c.direction === 'OUTGOING' ? PhoneOutgoing : missed ? PhoneMissed : PhoneIncoming;
                return (
                  <div key={c.id} className="card flex items-center gap-3 p-3 sm:gap-4 sm:p-4">
                    <Avatar name={c.peer.displayName} src={c.peer.avatarUrl} size="md" />
                    <div className="min-w-0 flex-1">
                      <p className={cn('truncate font-semibold', missed ? 'text-coral-500' : 'text-ink')}>
                        {c.peer.displayName}
                        {c.isGroup ? <span className="ml-2 text-xs font-medium text-muted">Group</span> : null}
                      </p>
                      <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                        <Icon
                          className={cn('h-3.5 w-3.5', missed ? 'text-coral-500' : 'text-mint-500')}
                          aria-hidden
                        />
                        {c.status === 'MISSED'
                          ? 'Missed'
                          : c.status === 'DECLINED'
                            ? 'Declined'
                            : c.status === 'RINGING'
                              ? 'Ringing'
                              : 'Completed'}{' '}
                        · {formatChatListTime(c.startedAt)}
                        {c.durationSec > 0 && ` · ${formatDuration(c.durationSec)}`}
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        if (c.isGroup && c.conversationId) {
                          router.push(`/app/chats/${c.conversationId}`);
                          return;
                        }
                        startCall(
                          {
                            id: c.peer.id,
                            username: c.peer.username,
                            displayName: c.peer.displayName,
                            avatarUrl: c.peer.avatarUrl
                          },
                          c.type
                        );
                      }}
                      className={cn(
                        'flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors',
                        c.type === 'VIDEO'
                          ? 'bg-brand-500/10 text-brand-500 hover:bg-brand-500/20'
                          : 'bg-mint-500/10 text-mint-500 hover:bg-mint-500/20'
                      )}
                      aria-label={c.isGroup ? `Open ${c.peer.displayName}` : `Call ${c.peer.displayName}`}
                    >
                      {c.type === 'VIDEO' ? <Video className="h-4.5 w-4.5" /> : <Phone className="h-4.5 w-4.5" />}
                    </button>
                    <button
                      onClick={() => setPendingDelete(c)}
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-faint transition-colors hover:bg-coral-500/10 hover:text-coral-500"
                      aria-label={`Remove ${c.peer.displayName} call from history`}
                      title="Remove from your history"
                    >
                      <Trash2 className="h-4.5 w-4.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => {
          if (!deleting) setPendingDelete(null);
        }}
        onConfirm={confirmDelete}
        title="Remove from your call history?"
        message={
          pendingDelete
            ? `This removes the ${pendingDelete.type === 'VIDEO' ? 'video' : 'voice'} call with ${pendingDelete.peer.displayName} from your history only — other people on the call will still see it in theirs.`
            : ''
        }
        confirmLabel="Remove"
        cancelLabel="Cancel"
        destructive
        loading={deleting}
      />
    </div>
  );
}
