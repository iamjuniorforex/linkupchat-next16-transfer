'use client';

import { useEffect, useRef, useState } from 'react';
import { Radio, Plus, Image as ImageIcon, Type, Send, Eye, Trash2, Camera } from 'lucide-react';
import { Avatar } from '@/components/ui/Avatar';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { EmptyState } from '@/components/ui/EmptyState';
import { ChatListSkeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/context/AuthProvider';
import { useSocketEvent } from '@/context/SocketProvider';
import { EVENTS } from '@shared/events';
import { cn, formatChatListTime } from '@/lib/utils';
import { STATUS_FONTS, STATUS_TEXT_COLORS, statusFontClass } from '@/lib/status-stories';
import { StatusViewer } from '@/components/status/StatusViewer';
import type { StatusDTO } from '@/types';

const BACKGROUNDS = [
  'linear-gradient(135deg, #6D5EF5 0%, #22B8FF 100%)',
  'linear-gradient(135deg, #FF6B5E 0%, #F5A623 100%)',
  'linear-gradient(135deg, #22C77D 0%, #22B8FF 100%)',
  'linear-gradient(135deg, #8481FB 0%, #FF8A7A 100%)',
  'linear-gradient(135deg, #4B38BF 0%, #3DDC97 100%)',
  'linear-gradient(135deg, #F5A623 0%, #FF6B5E 100%)'
];

export default function StatusPage() {
  const { user } = useAuth();
  const toast = useToast();
  const [groups, setGroups] = useState<
    { user: StatusDTO['user']; statuses: StatusDTO[]; isMe: boolean }[]
  >([]);
  const [myStatuses, setMyStatuses] = useState<StatusDTO[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [text, setText] = useState('');
  const [background, setBackground] = useState(BACKGROUNDS[0]!);
  const [posting, setPosting] = useState(false);
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [viewers, setViewers] = useState<{ statusId: string; count: number; people: { id: string; displayName: string; viewedAt: string }[] } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<StatusDTO | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [fontStyle, setFontStyle] = useState<(typeof STATUS_FONTS)[number]['id']>('classic');
  const [textColor, setTextColor] = useState<(typeof STATUS_TEXT_COLORS)[number]>('#FFFFFF');
  const [audience, setAudience] = useState<'CONTACTS' | 'CONTACTS_EXCEPT' | 'ONLY_SHARE'>('CONTACTS');
  const [audienceUserIds, setAudienceUserIds] = useState<string[]>([]);
  const [contacts, setContacts] = useState<{ id: string; displayName: string }[]>([]);
  const [archive, setArchive] = useState<StatusDTO[]>([]);
  const [showArchive, setShowArchive] = useState(false);
  const [viewing, setViewing] = useState<{ user: StatusDTO['user']; statuses: StatusDTO[]; index: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  async function load() {
    try {
      // Phase 5B: the feed API returns other users' statuses; mine come from
      // /api/status/me (expired/deleted excluded server-side).
      const [feedRes, meRes] = await Promise.all([
        fetch('/api/status', { credentials: 'include' }),
        fetch('/api/status/me', { credentials: 'include' })
      ]);
      const feed = await feedRes.json();
      const mine = await meRes.json();
      if (feed.ok) setGroups(feed.data.groups);
      if (mine.ok) setMyStatuses(mine.data.statuses);
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    void load();
    void fetch('/api/contacts', { credentials: 'include' })
      .then((r) => r.json())
      .then((json) => {
        if (json.ok) {
          setContacts(
            (json.data.contacts ?? []).map((c: { user?: { id: string; displayName: string } }) => ({
              id: c.user?.id ?? '',
              displayName: c.user?.displayName ?? 'Contact'
            })).filter((c: { id: string }) => c.id)
          );
        }
      })
      .catch(() => {});
  }, []);

  // Open clients drop deleted statuses without a refresh (other devices and
  // contacts via the socket; this tab via the local event below).
  useSocketEvent(EVENTS.STATUS_DELETED, () => {
    void load();
  });

  useEffect(() => {
    const onDeleted = () => {
      void load();
    };
    window.addEventListener('linkup:status-deleted', onDeleted);
    return () => window.removeEventListener('linkup:status-deleted', onDeleted);
  });

  // The story rail's "+ Add status" opens this page's single composer
  // (it is the only composer — no second one is created).
  useEffect(() => {
    const open = () => setComposerOpen(true);
    window.addEventListener('linkup:compose-status', open);
    return () => window.removeEventListener('linkup:compose-status', open);
  }, []);

  async function deleteStatus(s: StatusDTO) {
    setDeleting(true);
    try {
      const res = await fetch(`/api/status/${s.id}`, { method: 'DELETE', credentials: 'include' });
      const json = await res.json().catch(() => ({}));
      if (!json.ok) throw new Error(json.error?.message ?? 'Could not delete status');
      toast.success('Status deleted', 'It is gone from your updates.');
      setConfirmDelete(null);
      // One local event updates this page, the rail and any open viewer.
      window.dispatchEvent(new CustomEvent('linkup:status-deleted', { detail: { statusId: s.id } }));
      void load();
    } catch (err) {
      toast.error('Could not delete status', err instanceof Error ? err.message : undefined);
    } finally {
      setDeleting(false);
    }
  }

  async function openViewers(status: StatusDTO) {
    const res = await fetch(`/api/status/${status.id}`, { credentials: 'include' });
    const json = await res.json().catch(() => ({}));
    setViewers({
      statusId: status.id,
      count: json.ok ? json.data?.status?.viewerCount ?? status.viewerCount ?? 0 : status.viewerCount ?? 0,
      people: json.ok ? json.data?.status?.viewers ?? [] : []
    });
  }

  async function archiveStatus(status: StatusDTO) {
    const res = await fetch(`/api/status/${status.id}/archive`, { method: 'POST', credentials: 'include' });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) {
      toast.error('Could not archive status', json.error?.message);
      return;
    }
    toast.success('Archived', 'It is hidden from active feeds and kept in your archive.');
    window.dispatchEvent(new CustomEvent('linkup:status-deleted', { detail: { statusId: status.id } }));
    void load();
  }

  async function postStatus() {
    if (!text.trim() && !mediaFile) return;
    setPosting(true);
    try {
      let attachmentId: string | undefined;
      let mimeType: string | undefined;
      if (mediaFile) {
        const fd = new FormData();
        fd.append('file', mediaFile);
        fd.append('purpose', 'status');
        const up = await fetch('/api/upload', { method: 'POST', body: fd });
        const upJson = await up.json();
        if (!upJson.ok) throw new Error(upJson.error?.message ?? 'Upload failed');
        attachmentId = upJson.data.id;
        mimeType = upJson.data.mimeType;
      }

      const res = await fetch('/api/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: mediaFile ? (mimeType?.startsWith('video') ? 'VIDEO' : 'IMAGE') : 'TEXT',
          content: text.trim() || undefined,
          background: mediaFile ? undefined : background,
          attachmentId,
          fontStyle: mediaFile ? undefined : fontStyle,
          textColor: mediaFile ? undefined : textColor,
          audience,
          audienceUserIds: audience === 'CONTACTS' ? undefined : audienceUserIds
        }),
        credentials: 'include'
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? 'Could not post status');

      toast.success('Status posted', 'It will disappear after 24 hours.');
      setComposerOpen(false);
      setText('');
      setMediaFile(null);
      setAudience('CONTACTS');
      setAudienceUserIds([]);
      // Let the story rail update immediately (it is the whole Status screen
      // on phones, where this page's pane is collapsed).
      window.dispatchEvent(new CustomEvent('linkup:status-posted'));
      void load();
    } catch (err) {
      toast.error('Could not post status', err instanceof Error ? err.message : undefined);
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex h-[64px] shrink-0 items-center gap-3 border-b border-border bg-surface px-5">
        <Radio className="h-5 w-5 text-brand-500" aria-hidden />
        <div>
          <h1 className="text-[15px] font-bold text-ink">Status</h1>
          <p className="text-xs text-muted">Updates disappear after 24 hours</p>
        </div>
        <button
          onClick={() => setComposerOpen(true)}
          aria-label="Add status"
          className="btn-primary ml-auto !h-9 !px-4 !text-xs"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden /> Add status
        </button>
      </header>

      <div className="flex-1 overflow-y-auto scroll-thin p-6">
        <div className="mx-auto max-w-2xl">
          {/* My status — "My status [ + Add status ]" (always available) */}
          <div className="card flex w-full items-center gap-4 p-4 transition-shadow hover:shadow-card">
            <button
              onClick={() => setComposerOpen(true)}
              aria-label="Add status"
              className="flex min-w-0 flex-1 items-center gap-4 text-left"
            >
              <div className="relative">
                <Avatar name={user?.displayName ?? '?'} src={user?.avatarUrl} size="lg" />
                <span className="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full border-2 border-surface bg-brand-500 text-white">
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                </span>
              </div>
              <div className="flex-1 text-left">
                <p className="font-semibold text-ink">My status</p>
                <p className="text-xs text-muted">Share a photo, video or text update</p>
              </div>
            </button>
            <button
              onClick={() => setComposerOpen(true)}
              aria-label="Add status"
              className="btn-primary !h-9 shrink-0 !px-4 !text-xs"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden /> Add status
            </button>
          </div>

          <div className="mb-3 mt-8 flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-[0.14em] text-faint">Recent updates</h2>
            <button
              type="button"
              className="text-xs font-semibold text-brand-500"
              onClick={() => {
                setShowArchive((open) => !open);
                void fetch('/api/status/archive', { credentials: 'include' })
                  .then((r) => r.json())
                  .then((json) => {
                    if (json.ok) setArchive(json.data.statuses ?? []);
                  })
                  .catch(() => {});
              }}
            >
              {showArchive ? 'Hide archive' : 'Archive'}
            </button>
          </div>
          {showArchive && (
            <div className="mb-4 space-y-2">
              {archive.length === 0 ? (
                <p className="text-sm text-muted">Nothing in your archive yet.</p>
              ) : (
                archive.map((s) => (
                  <p key={s.id} className="truncate text-sm text-ink">
                    {s.content ?? 'Media update'} · {formatChatListTime(s.archivedAt ?? s.expiresAt)}
                  </p>
                ))
              )}
            </div>
          )}

          {!loaded ? (
            <ChatListSkeleton />
          ) : groups.length === 0 && myStatuses.length === 0 ? (
            <EmptyState
              icon={<Radio className="h-7 w-7" />}
              title="No status updates"
              description="When your contacts share updates, they will appear here."
            />
          ) : (
            <div className="space-y-2.5">
              {groups
                .filter((g) => !g.isMe)
                .map((g) => (
                  <div key={g.user?.id} className="card cursor-pointer p-4" onClick={() => setViewing({ user: g.user, statuses: g.statuses, index: 0 })}>
                    <div className="flex items-center gap-3">
                      <div
                        className={cn(
                          'rounded-full p-[2.5px]',
                          g.statuses.some((s) => !s.viewedByMe) ? 'story-ring' : 'story-ring-viewed'
                        )}
                      >
                        <div className="rounded-full bg-surface p-[2px]">
                          <Avatar name={g.user?.displayName ?? '?'} src={g.user?.avatarUrl} size="sm" />
                        </div>
                      </div>
                      <div className="flex-1">
                        <p className="text-sm font-semibold text-ink">{g.user?.displayName}</p>
                        <p className="text-xs text-muted">
                          {formatChatListTime(g.statuses[0]!.createdAt)} · {g.statuses.length} update
                          {g.statuses.length === 1 ? '' : 's'}
                        </p>
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {g.statuses.map((s) => (
                        <div
                          key={s.id}
                          className="flex h-28 items-center justify-center overflow-hidden rounded-xl p-3 text-center"
                          style={{ background: s.background ?? '#1B1F33' }}
                        >
                          {s.type === 'TEXT' ? (
                            <p className="line-clamp-4 text-sm font-semibold text-white">{s.content}</p>
                          ) : (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={s.mediaThumb ?? s.mediaUrl ?? ''} alt="Status" className="h-full w-full object-cover" />
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}

              {/* My statuses with viewer counts + early delete */}
              {myStatuses.map((s) => (
                <div key={s.id} className="relative">
                  <button
                    onClick={() => void openViewers(s)}
                    className="card flex w-full items-center gap-3 p-4 pr-28 text-left hover:shadow-card"
                  >
                      <div
                        className="flex h-12 w-12 items-center justify-center rounded-xl"
                        style={{ background: s.background ?? '#1B1F33' }}
                      >
                        <span className="text-lg">{s.type === 'TEXT' ? '✍️' : '📷'}</span>
                      </div>
                      <div className="flex-1">
                        <p className="truncate text-sm font-semibold text-ink">
                          {s.content ?? 'Media update'}
                        </p>
                        <p className="text-xs text-muted">Posted {formatChatListTime(s.createdAt)}</p>
                      </div>
                      <span className="flex items-center gap-1 text-xs font-semibold text-brand-500">
                        <Eye className="h-3.5 w-3.5" aria-hidden /> {s.viewerCount ?? 0}
                      </span>
                  </button>
                  <button
                    type="button"
                    aria-label="Archive status"
                    onClick={() => void archiveStatus(s)}
                    className="absolute right-14 top-1/2 -translate-y-1/2 text-xs font-semibold text-muted hover:text-ink"
                  >
                    Archive
                  </button>
                  <button
                    data-testid={`delete-status-${s.id}`}
                    aria-label="Delete status"
                    onClick={() => setConfirmDelete(s)}
                    className="absolute right-3 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-muted transition-colors hover:bg-red-500/10 hover:text-red-500"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Composer */}
      <Modal
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        title="Add to your status"
        description="Share a moment — it disappears after 24 hours."
        size="sm"
      >
        <div
          className="flex min-h-[180px] flex-col items-center justify-center rounded-2xl p-5"
          style={{ background: mediaFile ? '#1B1F33' : background }}
        >
          {mediaFile ? (
            mediaFile.type.startsWith('video') ? (
              <video src={URL.createObjectURL(mediaFile)} className="max-h-48 rounded-xl" controls />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={URL.createObjectURL(mediaFile)} alt="Preview" className="max-h-48 rounded-xl object-contain" />
            )
          ) : (
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="What's on your mind?"
              aria-label="Status text"
              maxLength={500}
              className="w-full resize-none border-none bg-transparent text-center text-xl font-bold text-white placeholder:text-white/60 focus:outline-none"
              rows={4}
              autoFocus
            />
          )}
        </div>

        {mediaFile && (
          <label className="mt-4 block text-xs font-semibold text-muted">
            Caption
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={500}
              aria-label="Status caption"
              placeholder="Add a caption"
              className="input mt-1.5"
            />
          </label>
        )}

        {!mediaFile && (
          <div className="mt-4 space-y-3">
            <div>
              <p className="mb-2 text-xs font-semibold text-muted">Typography</p>
              <div className="flex flex-wrap gap-2">
                {STATUS_FONTS.map((font) => (
                  <button
                    key={font.id}
                    type="button"
                    onClick={() => setFontStyle(font.id)}
                    className={cn('rounded-full px-3 py-1 text-xs font-semibold', statusFontClass(font.id), fontStyle === font.id ? 'bg-brand-500 text-white' : 'bg-ink/[0.06] text-ink')}
                  >
                    {font.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold text-muted">Text color</p>
              <div className="flex gap-2">
                {STATUS_TEXT_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    aria-label={`Text color ${color}`}
                    onClick={() => setTextColor(color)}
                    className={cn('h-7 w-7 rounded-full border', textColor === color ? 'ring-2 ring-brand-500' : 'border-border')}
                    style={{ background: color }}
                  />
                ))}
              </div>
            </div>
            <div>
            <p className="mb-2 text-xs font-semibold text-muted">Background</p>
            <div className="flex gap-2">
              {BACKGROUNDS.map((bg) => (
                <button
                  key={bg}
                  onClick={() => setBackground(bg)}
                  aria-label="Select background"
                  className={cn(
                    'h-9 w-9 rounded-full transition-transform',
                    background === bg ? 'scale-110 ring-2 ring-brand-500 ring-offset-2' : ''
                  )}
                  style={{ background: bg }}
                />
              ))}
            </div>
            </div>
          </div>
        )}

        <label className="mt-4 block text-xs font-semibold text-muted">
          Who can see this
          <select
            aria-label="Status audience"
            value={audience}
            onChange={(e) => setAudience(e.target.value as typeof audience)}
            className="input mt-1.5"
          >
            <option value="CONTACTS">My contacts</option>
            <option value="CONTACTS_EXCEPT">My contacts except…</option>
            <option value="ONLY_SHARE">Only share with…</option>
          </select>
        </label>
        {audience !== 'CONTACTS' && (
          <div className="mt-2 max-h-32 space-y-1 overflow-y-auto rounded-xl border border-border p-2" aria-label="Audience contacts">
            {contacts.length === 0 ? (
              <p className="text-xs text-muted">Add contacts before using a custom audience.</p>
            ) : (
              contacts.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={audienceUserIds.includes(c.id)}
                    onChange={(e) =>
                      setAudienceUserIds((ids) =>
                        e.target.checked ? [...ids, c.id] : ids.filter((id) => id !== c.id)
                      )
                    }
                  />
                  {c.displayName}
                </label>
              ))
            )}
          </div>
        )}

        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            if (!f.type.startsWith('image/')) {
              toast.error('Unsupported file', 'Camera status must be a photo.');
              return;
            }
            if (f.size > 25 * 1024 * 1024) {
              toast.error('File too large', 'Status media must be 25 MB or smaller.');
              return;
            }
            setMediaFile(f);
          }}
        />
        <input
          ref={fileRef}
          type="file"
          accept="image/*,video/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            const okType = f.type.startsWith('image/') || f.type.startsWith('video/');
            if (!okType) {
              toast.error('Unsupported file', 'Status media must be a photo or video.');
              return;
            }
            if (f.size > 25 * 1024 * 1024) {
              toast.error('File too large', 'Status media must be 25 MB or smaller.');
              return;
            }
            setMediaFile(f);
          }}
        />

        <div className="mt-5 flex flex-wrap gap-2.5">
          <button type="button" onClick={() => cameraRef.current?.click()} className="btn-secondary min-h-11 flex-1">
            <Camera className="h-4 w-4" aria-hidden /> Camera
          </button>
          <button type="button" onClick={() => fileRef.current?.click()} className="btn-secondary min-h-11 flex-1">
            <ImageIcon className="h-4 w-4" aria-hidden /> {mediaFile ? 'Change media' : 'Photo/Video'}
          </button>
          {mediaFile && (
            <button onClick={() => setMediaFile(null)} className="btn-secondary">
              <Type className="h-4 w-4" aria-hidden /> Text instead
            </button>
          )}
          <button
            onClick={() => void postStatus()}
            disabled={posting || (!text.trim() && !mediaFile)}
            className="btn-primary flex-1"
          >
            <Send className="h-4 w-4" aria-hidden /> {posting ? 'Posting…' : 'Post'}
          </button>
        </div>
      </Modal>

      {viewing && (
        <StatusViewer
          user={viewing.user}
          statuses={viewing.statuses}
          index={viewing.index}
          mine={viewing.user?.id === user?.id}
          onNext={() =>
            setViewing((v) =>
              v && v.index < v.statuses.length - 1 ? { ...v, index: v.index + 1 } : null
            )
          }
          onPrev={() => setViewing((v) => (v && v.index > 0 ? { ...v, index: v.index - 1 } : v))}
          onClose={() => setViewing(null)}
        />
      )}

      {/* Viewers */}
      <Modal
        open={Boolean(viewers)}
        onClose={() => setViewers(null)}
        title={`${viewers?.count ?? 0} ${viewers?.count === 1 ? 'viewer' : 'viewers'}`}
        size="sm"
      >
        <p className="text-sm text-muted">
          Viewed by {viewers?.count ?? 0} {viewers?.count === 1 ? 'person' : 'people'} so far. Status
          views are only visible to you as the owner.
        </p>
        <ul className="mt-3 max-h-48 space-y-1 overflow-y-auto text-sm" aria-label="Status viewers">
          {(viewers?.people.length ?? 0) === 0 ? (
            <li className="text-muted">No views yet.</li>
          ) : (
            viewers?.people.map((person) => (
              <li key={person.id} className="flex justify-between gap-3">
                <span className="text-ink">{person.displayName}</span>
                <span className="text-muted">{formatChatListTime(person.viewedAt)}</span>
              </li>
            ))
          )}
        </ul>
      </Modal>

      {/* Early delete confirmation */}
      <ConfirmDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (confirmDelete) void deleteStatus(confirmDelete);
        }}
        title="Delete this status?"
        message="It will be removed from your status and your contacts' feeds right away. This cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Keep it"
        destructive
        loading={deleting}
      />
    </div>
  );
}
