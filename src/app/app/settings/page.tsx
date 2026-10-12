'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Settings as SettingsIcon,
  User,
  Shield,
  Bell,
  Palette,
  MessageSquare,
  KeyRound,
  MonitorSmartphone,
  LogOut,
  Camera,
  Sun,
  Moon,
  Laptop,
  Check,
  Smartphone,
  Sparkles
} from 'lucide-react';
import { Avatar } from '@/components/ui/Avatar';
import { Input, Textarea } from '@/components/ui/Input';
import { Switch, RadioCards } from '@/components/ui/Switch';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { PushNotificationsCard } from '@/components/settings/PushNotificationsCard';
import { useAuth } from '@/context/AuthProvider';
import { useTheme } from '@/context/ThemeProvider';
import { cn, formatDate } from '@/lib/utils';
import { WALLPAPERS, wallpaperPreviewStyle } from '@/lib/wallpapers';
import { PROFILE_ACCENTS } from '@/lib/profile-privacy';
import type { PrivacyLevel, UserSettingsDTO } from '@/types';

type Tab = 'account' | 'plans' | 'privacy' | 'notifications' | 'appearance' | 'chat' | 'security';

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: 'account', label: 'Account', icon: User },
  { id: 'plans', label: 'Plans', icon: Sparkles },
  { id: 'privacy', label: 'Privacy', icon: Shield },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'security', label: 'Security', icon: KeyRound }
];

const privacyOptions: { value: PrivacyLevel; label: string; description?: string }[] = [
  { value: 'EVERYONE', label: 'Everyone', description: 'Any LINKUPCHAT user can see this.' },
  { value: 'CONTACTS', label: 'My contacts', description: 'Only people in your contacts list.' },
  { value: 'NOBODY', label: 'Nobody', description: 'Hidden from everyone.' }
];

export default function SettingsPage() {
  const { user, updateSettings, updateProfile, logout, refresh } = useAuth();
  const { theme, setTheme, resolved } = useTheme();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('account');

  // Profile form
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [about, setAbout] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{
    displayName?: string;
    username?: string;
    about?: string;
  }>({});

  // Password form
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);

  // Email verification (code entry + resend)
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [verifyCode, setVerifyCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verifiedNow, setVerifiedNow] = useState(false);

  // Account data & deletion (Danger zone)
  const [exporting, setExporting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deletePassword, setDeletePassword] = useState('');
  const [deleting, setDeleting] = useState(false);

  // Sessions
  const [sessions, setSessions] = useState<
    { id: string; userAgent: string | null; ip: string | null; lastUsedAt: string; current: boolean }[]
  >([]);

  const settings: UserSettingsDTO | null = user?.settings ?? null;
  // Flips to Verified the instant the code is accepted (before the me-refresh).
  const emailVerified = Boolean(user?.emailVerified || verifiedNow);

  useEffect(() => {
    if (user) {
      setDisplayName(user.displayName);
      setUsername(user.username);
      setAbout(user.about);
    }
  }, [user]);

  useEffect(() => {
    if (tab === 'security') {
      fetch('/api/auth/sessions', { credentials: 'include' })
        .then((r) => r.json())
        .then((j) => {
          if (j.ok) setSessions(j.data.sessions);
        })
        .catch(() => {});
    }
  }, [tab]);

  if (!user || !settings) return null;

  async function saveProfile() {
    // Client-side checks first (same rules the server enforces), then the
    // server stays authoritative: its field errors replace these on response.
    const errs: typeof fieldErrors = {};
    const name = displayName.trim();
    const uname = username.trim().toLowerCase();
    const bio = about.trim();
    if (name.length < 2) errs.displayName = 'Display name must be at least 2 characters.';
    else if (name.length > 50) errs.displayName = 'Display name must be 50 characters or fewer.';
    if (user && uname !== user.username) {
      if (!/^[a-z0-9_]{3,24}$/.test(uname)) {
        errs.username = 'Use 3–24 lowercase letters, numbers or underscores.';
      }
    }
    if (bio.length > 140) errs.about = 'About must be 140 characters or fewer.';
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      return;
    }
    setFieldErrors({});
    setSavingProfile(true);
    try {
      const json = await updateProfile({ displayName: name, about: bio, username: uname });
      if (json.ok === false) {
        const serverErrors = json.error?.details ?? {};
        setFieldErrors({
          displayName: serverErrors.displayName?.[0],
          username:
            json.error?.code === 'USERNAME_TAKEN'
              ? 'That username is already taken.'
              : serverErrors.username?.[0],
          about: serverErrors.about?.[0]
        });
        if (!serverErrors.displayName && !serverErrors.username && !serverErrors.about) {
          toast.error('Could not save', json.error?.message);
        }
      } else {
        toast.success('Profile updated');
      }
    } finally {
      setSavingProfile(false);
    }
  }

  async function changePassword() {
    if (currentPassword.length < 1 || newPassword.length < 8) {
      toast.error('Check your passwords', 'New password must be at least 8 characters.');
      return;
    }
    setChangingPassword(true);
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
        credentials: 'include'
      });
      const json = await res.json();
      if (!json.ok) {
        toast.error('Could not change password', json.error?.message);
        return;
      }
      toast.success('Password changed', 'Other sessions have been signed out.');
      setCurrentPassword('');
      setNewPassword('');
    } finally {
      setChangingPassword(false);
    }
  }

  async function submitVerifyCode() {
    const code = verifyCode.trim();
    if (!code || verifying) return;
    setVerifying(true);
    setVerifyError(null);
    try {
      const res = await fetch('/api/auth/verify-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
        credentials: 'include'
      });
      const json = await res.json();
      if (!json.ok) {
        const message: string =
          json.error?.message ?? 'That code is invalid or has expired. Request a new one.';
        setVerifyError(message);
        toast.error('Verification failed', message);
        return;
      }
      setVerifiedNow(true);
      setVerifyOpen(false);
      setVerifyCode('');
      toast.success('Email verified', 'Your email address is now verified.');
      void refresh();
    } catch {
      const message = 'Something went wrong. Please try again.';
      setVerifyError(message);
      toast.error('Verification failed', message);
    } finally {
      setVerifying(false);
    }
  }

  async function resendVerificationCode() {
    if (resending || emailVerified) return;
    setResending(true);
    setVerifyError(null);
    try {
      const res = await fetch('/api/auth/verify-email/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        credentials: 'include'
      });
      const json = await res.json();
      if (!json.ok) {
        if (json.error?.code === 'ALREADY_VERIFIED') {
          setVerifiedNow(true);
          setVerifyOpen(false);
          toast.success('Email verified', 'Your email address is already verified.');
          void refresh();
          return;
        }
        toast.error(
          'Could not send code',
          json.error?.message ?? 'Something went wrong. Please try again.'
        );
        return;
      }
      setVerifyCode('');
      setVerifyOpen(true);
      toast.success('Code sent', 'A new verification code is on its way. It expires in 15 minutes.');
    } catch {
      toast.error('Could not send code', 'Something went wrong. Please try again.');
    } finally {
      setResending(false);
    }
  }

  async function exportMyData() {
    if (exporting) return;
    setExporting(true);
    try {
      const res = await fetch('/api/account/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        credentials: 'include'
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        toast.error('Export failed', json?.error?.message ?? 'Something went wrong. Please try again.');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `linkupchat-export-${user?.username ?? 'account'}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success('Export ready', 'Your data archive has been downloaded.');
    } catch {
      toast.error('Export failed', 'Something went wrong. Please try again.');
    } finally {
      setExporting(false);
    }
  }

  async function deleteMyAccount() {
    if (deleting || deleteConfirm.trim() !== 'DELETE MY ACCOUNT' || !deletePassword) return;
    setDeleting(true);
    try {
      const res = await fetch('/api/account/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmation: deleteConfirm.trim(),
          currentPassword: deletePassword
        }),
        credentials: 'include'
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        setDeletePassword('');
        toast.error(
          'Could not delete account',
          json?.error?.message ?? 'Something went wrong. Please try again.'
        );
        return;
      }
      // Account is gone — clear the local session and drop into a clean
      // logged-out state.
      await logout();
      window.location.href = '/login';
    } catch {
      toast.error('Could not delete account', 'Something went wrong. Please try again.');
    } finally {
      setDeleting(false);
    }
  }

  function patch<K extends keyof UserSettingsDTO>(key: K, value: UserSettingsDTO[K]) {
    void updateSettings({ [key]: value } as Partial<UserSettingsDTO>);
    toast.success('Setting saved');
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex h-[64px] shrink-0 items-center gap-3 border-b border-border bg-surface px-5">
        <SettingsIcon className="h-5 w-5 text-brand-500" aria-hidden />
        <div>
          <h1 className="text-[15px] font-bold text-ink">Settings</h1>
          <p className="text-xs text-muted">Account, privacy, appearance, and plans</p>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* Tab nav */}
        <nav
          className="scroll-thin flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-surface p-2 md:w-56 md:flex-col md:border-b-0 md:border-r md:p-3"
          aria-label="Settings sections"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              data-testid={`settings-tab-${t.id}`}
              aria-current={tab === t.id ? 'page' : undefined}
              className={cn(
                'flex min-h-11 items-center gap-2.5 whitespace-nowrap rounded-xl px-3.5 py-2.5 text-sm font-semibold transition-colors',
                tab === t.id
                  ? 'bg-brand-500/[0.12] text-brand-600 dark:text-brand-300'
                  : 'text-muted hover:bg-ink/[0.05] dark:hover:bg-white/[0.06]'
              )}
            >
              <t.icon className="h-4 w-4" aria-hidden />
              {t.label}
            </button>
          ))}
        </nav>

        {/* Content */}
        <div className="flex-1 overflow-y-auto scroll-thin p-4 pb-8 sm:p-6">
          <div className="mx-auto max-w-xl space-y-6">
            {/* ── ACCOUNT ── */}
            {tab === 'account' && (
              <>
                <section className="card space-y-2 p-6">
                  <h2 className="text-lg font-bold text-ink">Plans</h2>
                  <p className="text-sm text-muted">Premium and Business live in their own section so account settings stay about you.</p>
                  <button type="button" className="text-sm font-semibold text-brand-500" onClick={() => setTab('plans')}>
                    Open Plans
                  </button>
                </section>
                <section className="card p-6">
                  <h2 className="text-lg font-bold text-ink">Profile</h2>
                  <div className="mt-5 flex items-center gap-5">
                    <div className="relative">
                      <Avatar name={user.displayName} src={user.avatarUrl} size="xl" />
                      <label
                        className={`absolute -bottom-1 -right-1 flex h-8 w-8 items-center justify-center rounded-full bg-brand-500 text-white shadow-soft ${
                          uploadingAvatar ? 'cursor-wait opacity-70' : 'cursor-pointer'
                        }`}
                        aria-label={uploadingAvatar ? 'Uploading photo' : 'Change profile photo'}
                      >
                        <Camera className="h-3.5 w-3.5" aria-hidden />
                        {uploadingAvatar && (
                          <span
                            className="absolute inset-0 flex items-center justify-center rounded-full bg-brand-500"
                            role="status"
                            aria-label="Uploading photo"
                          >
                            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                          </span>
                        )}
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          data-testid="profile-avatar-input"
                          disabled={uploadingAvatar}
                          onChange={async (e) => {
                            const f = e.target.files?.[0];
                            if (!f) return;
                            setUploadingAvatar(true);
                            try {
                              const fd = new FormData();
                              fd.append('file', f);
                              fd.append('purpose', 'avatar');
                              const res = await fetch('/api/upload', { method: 'POST', body: fd });
                              const json = await res.json();
                              if (json.ok) {
                                const saved = await updateProfile({ avatarUrl: json.data.url });
                                if (saved.ok === false) {
                                  // Upload succeeded but the profile did not change —
                                  // the profile is intact; surface the failure.
                                  toast.error('Could not update photo', saved.error?.message);
                                } else {
                                  toast.success('Photo updated');
                                }
                              } else {
                                toast.error('Upload failed', json.error?.message);
                              }
                            } catch {
                              toast.error('Upload failed', 'Something went wrong. Please try again.');
                            } finally {
                              setUploadingAvatar(false);
                              e.target.value = '';
                            }
                          }}
                        />
                      </label>
                    </div>
                    <div>
                      <p className="font-semibold text-ink">{user.displayName}</p>
                      <p className="text-sm text-muted">@{user.username}</p>
                      <p className="mt-1 text-xs text-faint">Joined {formatDate(user.createdAt)}</p>
                    </div>
                  </div>

                  <div className="mt-6 space-y-4">
                    <Input
                      label="Display name"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      maxLength={50}
                      error={fieldErrors.displayName ?? null}
                      data-testid="profile-display-name"
                    />
                    <Input
                      label="Username"
                      value={username}
                      onChange={(e) => setUsername(e.target.value.toLowerCase())}
                      maxLength={24}
                      hint="3–24 lowercase letters, numbers or underscores. The first change is free, then once every 14 days."
                      error={fieldErrors.username ?? null}
                      data-testid="profile-username"
                    />
                    <Textarea
                      label="About"
                      value={about}
                      onChange={(e) => setAbout(e.target.value)}
                      maxLength={140}
                      error={fieldErrors.about ?? null}
                      className="!min-h-[72px]"
                      data-testid="profile-about"
                    />
                    <p className="text-xs text-faint" data-testid="profile-about-count">
                      {about.length}/140 characters
                    </p>
                    <div>
                      <p className="mb-2 text-xs font-semibold text-muted">Accent</p>
                      <div className="flex gap-2">
                        {PROFILE_ACCENTS.map((color) => (
                          <button
                            key={color}
                            type="button"
                            aria-label={`Accent ${color}`}
                            className="h-7 w-7 rounded-full border border-border"
                            style={{ background: color }}
                            onClick={() => void updateProfile({ accentColor: color })}
                          />
                        ))}
                      </div>
                    </div>
                    <label className="btn-secondary !h-9 w-fit cursor-pointer !px-3 !text-xs">
                      Change cover
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        data-testid="profile-cover-input"
                        onChange={async (e) => {
                          const f = e.target.files?.[0];
                          e.target.value = '';
                          if (!f) return;
                          const fd = new FormData();
                          fd.append('file', f);
                          fd.append('purpose', 'cover');
                          const res = await fetch('/api/upload', { method: 'POST', body: fd });
                          const json = await res.json().catch(() => ({}));
                          if (!json.ok) {
                            toast.error('Could not update cover', json.error?.message);
                            return;
                          }
                          const saved = await updateProfile({ coverUrl: json.data.url });
                          if (saved.ok === false) toast.error('Could not update cover', saved.error?.message);
                          else toast.success('Cover updated');
                        }}
                      />
                    </label>
                    <div className="flex flex-wrap items-center gap-3">
                      <Button onClick={() => void saveProfile()} loading={savingProfile} data-testid="profile-save">
                        <Check className="h-4 w-4" aria-hidden /> Save profile
                      </Button>
                      {displayName !== user.displayName || username !== user.username || about !== user.about ? (
                        <p className="text-xs font-semibold text-gold-500">Unsaved profile changes</p>
                      ) : (
                        <p className="text-xs text-muted">Profile changes save when you press Save profile.</p>
                      )}
                    </div>
                  </div>
                </section>

                <section className="card p-6">
                  <h2 className="text-lg font-bold text-ink">Email &amp; phone</h2>
                  <div className="mt-4 space-y-3">
                    <div className="flex items-center justify-between rounded-xl border border-border px-4 py-3">
                      <div>
                        <p className="text-sm font-medium text-ink">Email</p>
                        <p className="text-xs text-muted">{user.email ?? 'Not set'}</p>
                      </div>
                      <span
                        data-testid="email-verify-badge"
                        className={cn(
                          'rounded-full px-2.5 py-1 text-xs font-semibold',
                          emailVerified ? 'bg-mint-500/12 text-mint-600' : 'bg-gold-500/15 text-gold-500'
                        )}
                      >
                        {emailVerified ? 'Verified' : 'Unverified'}
                      </span>
                    </div>
                    {user.email && !emailVerified && (
                      <div className="space-y-3 rounded-xl border border-border p-4">
                        <p className="text-xs text-muted">
                          {verifyOpen
                            ? 'Enter the 6-digit code we emailed you. Codes expire 15 minutes after they are sent.'
                            : 'Verify your email so we can always reach you about your account.'}
                        </p>
                        {verifyOpen && (
                          <>
                            <Input
                              label="Verification code"
                              value={verifyCode}
                              onChange={(e) => {
                                setVerifyCode(e.target.value);
                                if (verifyError) setVerifyError(null);
                              }}
                              inputMode="numeric"
                              autoComplete="one-time-code"
                              maxLength={12}
                              placeholder="123456"
                              error={verifyError}
                              disabled={verifying}
                            />
                            <div className="flex flex-wrap items-center gap-2">
                              <Button
                                data-testid="verify-email-submit"
                                onClick={() => void submitVerifyCode()}
                                loading={verifying}
                                disabled={verifying || !verifyCode.trim()}
                              >
                                Verify
                              </Button>
                              <Button
                                data-testid="verify-email-resend"
                                variant="secondary"
                                onClick={() => void resendVerificationCode()}
                                loading={resending}
                                disabled={resending || verifying}
                              >
                                Resend code
                              </Button>
                            </div>
                          </>
                        )}
                        {!verifyOpen && (
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              data-testid="verify-email-open"
                              variant="outline"
                              onClick={() => setVerifyOpen(true)}
                            >
                              Enter code
                            </Button>
                            <Button
                              data-testid="verify-email-resend"
                              variant="secondary"
                              onClick={() => void resendVerificationCode()}
                              loading={resending}
                              disabled={resending}
                            >
                              Resend code
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                    <div className="flex items-center justify-between rounded-xl border border-border px-4 py-3">
                      <div>
                        <p className="text-sm font-medium text-ink">Phone</p>
                        <p className="text-xs text-muted">{user.phone ?? 'Not set'}</p>
                      </div>
                    </div>
                  </div>
                </section>

                <section className="card p-6">
                  <h2 className="text-lg font-bold text-ink">Change password</h2>
                  <div className="mt-4 space-y-4">
                    <Input
                      type="password"
                      label="Current password"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      autoComplete="current-password"
                    />
                    <Input
                      type="password"
                      label="New password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      autoComplete="new-password"
                      hint="At least 8 characters."
                    />
                    <Button onClick={() => void changePassword()} loading={changingPassword}>
                      Update password
                    </Button>
                  </div>
                </section>

                <section className="card p-6">
                  <h2 className="text-lg font-bold text-ink">Danger zone</h2>
                  <p className="mt-1 text-sm text-muted">
                    Download a copy of everything on your account, or delete your account
                    permanently.
                  </p>
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <Button
                      data-testid="account-export"
                      variant="secondary"
                      onClick={() => void exportMyData()}
                      loading={exporting}
                      disabled={exporting || deleting}
                    >
                      Export my data
                    </Button>
                    <Button
                      data-testid="account-delete-open"
                      variant="danger"
                      onClick={() => setDeleteOpen((v) => !v)}
                      disabled={deleting}
                    >
                      Delete account
                    </Button>
                  </div>
                  {deleteOpen && (
                    <div className="mt-4 space-y-3 rounded-xl border border-coral-500/30 p-4">
                      <p className="text-xs leading-relaxed text-muted">
                        This permanently deletes your account and your data. Messages you sent
                        stay for other people, without your name. This cannot be undone. Confirm
                        with the exact phrase and your current password.
                      </p>
                      <Input
                        label='Type "DELETE MY ACCOUNT" to confirm'
                        value={deleteConfirm}
                        onChange={(e) => setDeleteConfirm(e.target.value)}
                        placeholder="DELETE MY ACCOUNT"
                        disabled={deleting}
                        data-testid="account-delete-confirm-input"
                      />
                      <Input
                        type="password"
                        label="Current password"
                        value={deletePassword}
                        onChange={(e) => setDeletePassword(e.target.value)}
                        autoComplete="current-password"
                        disabled={deleting}
                        data-testid="account-delete-password"
                      />
                      <Button
                        data-testid="account-delete-confirm"
                        variant="danger"
                        onClick={() => void deleteMyAccount()}
                        loading={deleting}
                        disabled={
                          deleting ||
                          deleteConfirm.trim() !== 'DELETE MY ACCOUNT' ||
                          !deletePassword
                        }
                      >
                        Permanently delete my account
                      </Button>
                    </div>
                  )}
                </section>
              </>
            )}

            {tab === 'plans' && (
              <section className="card space-y-4 p-6">
                <div>
                  <h2 className="text-lg font-bold text-ink">Plans</h2>
                  <p className="mt-1 text-sm text-muted">
                    Free includes messaging, calls, status, and light or dark theme. Premium and Business add the extras listed on their screens. A plan only applies after the server confirms it.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link href="/app/premium" className="btn-primary">
                    LINKUPCHAT Premium
                  </Link>
                  <Link href="/app/business" className="btn-secondary">
                    LINKUPCHAT Business
                  </Link>
                </div>
              </section>
            )}

            {/* ── PRIVACY ── */}
            {tab === 'privacy' && (
              <section className="card space-y-6 p-6">
                <div>
                  <h2 className="text-lg font-bold text-ink">Privacy</h2>
                  <p className="mt-1 text-sm text-muted">
                    Control who can see your information on LINKUPCHAT.
                  </p>
                </div>

                {(
                  [
                    ['privacyLastSeen', 'Last seen', 'Who can see when you were last online.'],
                    ['privacyOnline', 'Online status', 'Who can see when you are online.'],
                    ['privacyProfilePhoto', 'Profile photo', 'Who can see your profile photo.'],
                    ['privacyAbout', 'About', 'Who can see your bio/about.'],
                    ['privacyStatus', 'Status updates', 'Who can see your status stories.'],
                    ['privacyPhoneSearch', 'Phone number', 'Who can find you by your full phone number. Partial numbers never match.'],
                    ['privacyAddMe', 'Contact requests', 'Who can add you to their contacts.'],
                    ['privacyMessage', 'New messages', 'Who can start a new chat with you. Existing chats stay open.'],
                    ['privacyDiscover', 'Suggestions', 'Who can see you in People you may know.']
                  ] as const
                ).map(([key, label, description]) => (
                  <div key={key}>
                    <p className="mb-2 text-sm font-semibold text-ink">{label}</p>
                    <p className="mb-2.5 text-xs text-muted">{description}</p>
                    <RadioCards
                      value={settings[key] as PrivacyLevel}
                      onChange={(v) => patch(key, v)}
                      options={privacyOptions}
                    />
                  </div>
                ))}

                <div className="rounded-xl border border-border p-4">
                  <Switch
                    checked={settings.privacyReadReceipts}
                    onChange={(v) => patch('privacyReadReceipts', v)}
                    label="Read receipts"
                    description="When off, you also cannot see other people's read receipts."
                  />
                </div>
              </section>
            )}

            {/* ── NOTIFICATIONS ── */}
            {tab === 'notifications' && (
              <section className="card space-y-5 p-6">
                <div>
                  <h2 className="text-lg font-bold text-ink">Notifications</h2>
                  <p className="mt-1 text-sm text-muted">Choose what you want to be notified about.</p>
                </div>
                <Switch
                  checked={settings.notifEnabled !== false}
                  onChange={(v) => patch('notifEnabled', v)}
                  label="All notifications"
                  description="Master switch. When off, LINKUPCHAT does not create or push notifications."
                />
                <Switch
                  checked={settings.notifMessages}
                  onChange={(v) => patch('notifMessages', v)}
                  label="Direct messages"
                  description="Notifications for new one-to-one messages."
                />
                <Switch
                  checked={settings.notifGroups}
                  onChange={(v) => patch('notifGroups', v)}
                  label="Group messages"
                  description="Notifications for group conversations."
                />
                <Switch
                  checked={settings.notifCalls}
                  onChange={(v) => patch('notifCalls', v)}
                  label="Calls"
                  description="Notifications for incoming voice and video calls."
                />
                <Switch
                  checked={settings.notifStatus !== false}
                  onChange={(v) => patch('notifStatus', v)}
                  label="Status updates"
                  description="Notifications when someone you follow posts, reacts, or replies to a status."
                />
                <Switch
                  checked={settings.notifSounds}
                  onChange={(v) => patch('notifSounds', v)}
                  label="Sounds"
                  description="Play a sound for new notifications."
                />
                <Switch
                  checked={settings.notifPreview}
                  onChange={(v) => patch('notifPreview', v)}
                  label="Message previews"
                  description="Show message content inside notifications."
                />
                <PushNotificationsCard />
              </section>
            )}

            {/* ── APPEARANCE ── */}
            {tab === 'appearance' && (
              <section className="card space-y-6 p-6">
                <div>
                  <h2 className="text-lg font-bold text-ink">Appearance</h2>
                  <p className="mt-1 text-sm text-muted">
                    Light, dark, and system are saved on this device. Switching theme does not change chats or other settings.
                  </p>
                </div>
                <div>
                  <p className="mb-3 text-sm font-semibold text-ink">Theme</p>
                  <RadioCards
                    value={theme}
                    onChange={(v) => {
                      setTheme(v);
                      toast.success('Theme updated');
                    }}
                    options={[
                      { value: 'LIGHT', label: 'Light', description: 'Bright and clean.' },
                      { value: 'DARK', label: 'Dark', description: 'Easy on the eyes at night.' },
                      { value: 'SYSTEM', label: 'System', description: 'Match your device setting.' }
                    ]}
                  />
                  <div className="mt-4 flex items-center gap-3 rounded-xl border border-border px-4 py-3">
                    {resolved === 'dark' ? (
                      <Moon className="h-4 w-4 text-brand-500" aria-hidden />
                    ) : (
                      <Sun className="h-4 w-4 text-gold-500" aria-hidden />
                    )}
                    <p className="text-sm text-muted">
                      Currently using the <strong className="text-ink">{resolved}</strong> theme.
                    </p>
                  </div>
                </div>
              </section>
            )}

            {/* ── CHAT ── */}
            {tab === 'chat' && (
              <section className="card space-y-5 p-6">
                <div>
                  <h2 className="text-lg font-bold text-ink">Chat</h2>
                  <p className="mt-1 text-sm text-muted">Tune how conversations behave.</p>
                </div>
                <Switch
                  checked={settings.enterToSend}
                  onChange={(v) => patch('enterToSend', v)}
                  label="Enter to send"
                  description="Press Enter to send messages on desktop. Shift + Enter adds a new line."
                />
                <Switch
                  checked={settings.mediaAutoDownload}
                  onChange={(v) => patch('mediaAutoDownload', v)}
                  label="Media auto-download"
                  description="Automatically download photos on trusted networks."
                />
                <div>
                  <p className="mb-2 text-sm font-semibold text-ink">Chat wallpaper</p>
                  <p className="mb-2 text-xs text-muted">Midnight, sunset, and forest need an active Premium or Business plan.</p>
                  <div className="grid grid-cols-3 gap-2.5">
                    {WALLPAPERS.map((w) => (
                      <button
                        key={w}
                        onClick={() => {
                          void (async () => {
                            const res = await fetch('/api/users/me/settings', {
                              method: 'PATCH',
                              headers: { 'Content-Type': 'application/json' },
                              credentials: 'include',
                              body: JSON.stringify({ wallpaper: w })
                            });
                            const j = await res.json().catch(() => ({}));
                            if (j.ok) {
                              await refresh();
                              toast.success('Wallpaper updated');
                            } else {
                              toast.error(j.error?.message || 'Could not update wallpaper');
                            }
                          })();
                        }}
                        data-testid={`wallpaper-${w}`}
                        className={cn(
                          'h-20 rounded-2xl border-2 text-xs font-semibold capitalize transition-all',
                          settings.wallpaper === w
                            ? 'border-brand-500 shadow-glow'
                            : 'border-border hover:border-border-strong'
                        )}
                        style={wallpaperPreviewStyle(w)}
                      >
                        <span className={w === 'aurora' || w === 'midnight' || w === 'sunset' || w === 'forest' ? 'text-white' : 'text-muted'}>
                          {w}
                          {(w === 'midnight' || w === 'sunset' || w === 'forest') && (
                            <span className="mt-1 block text-[10px] font-bold uppercase tracking-wide">Premium</span>
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </section>
            )}

            {/* ── SECURITY ── */}
            {tab === 'security' && (
              <>
                <section className="card p-6">
                  <h2 className="text-lg font-bold text-ink">Active sessions</h2>
                  <p className="mt-1 text-sm text-muted">
                    Manage the devices where your account is logged in.
                  </p>
                  <div className="mt-4 space-y-2.5">
                    {sessions.map((s) => (
                      <div
                        key={s.id}
                        className="flex items-center gap-3 rounded-xl border border-border px-4 py-3"
                      >
                        <Smartphone className="h-4.5 w-4.5 text-muted" aria-hidden />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-ink">
                            {s.userAgent?.split(') ')[0]?.slice(0, 60) ?? 'Unknown device'}
                            {s.current && (
                              <span className="ml-2 rounded-full bg-brand-500/12 px-2 py-0.5 text-[10px] font-bold text-brand-500">
                                THIS DEVICE
                              </span>
                            )}
                          </p>
                          <p className="text-xs text-muted">
                            {s.ip ?? 'Unknown IP'} · Last used {formatDate(s.lastUsedAt)}
                          </p>
                        </div>
                        {!s.current && (
                          <button
                            onClick={async () => {
                              await fetch('/api/auth/sessions', {
                                method: 'DELETE',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ sessionId: s.id }),
                                credentials: 'include'
                              });
                              setSessions((prev) => prev.filter((x) => x.id !== s.id));
                              toast.success('Session signed out');
                            }}
                            className="text-xs font-semibold text-coral-500 hover:underline"
                          >
                            Sign out
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  <Button
                    variant="secondary"
                    className="mt-4"
                    onClick={async () => {
                      await fetch('/api/auth/sessions', {
                        method: 'DELETE',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ allOthers: true }),
                        credentials: 'include'
                      });
                      toast.success('Other sessions signed out');
                      void fetch('/api/auth/sessions', { credentials: 'include' })
                        .then((r) => r.json())
                        .then((j) => j.ok && setSessions(j.data.sessions));
                    }}
                  >
                    Sign out of all other sessions
                  </Button>
                </section>

                <section className="card p-6">
                  <h2 className="text-lg font-bold text-ink">Two-factor authentication</h2>
                  <p className="mt-1 text-sm leading-relaxed text-muted">
                    Two-factor authentication (2FA) adds an extra verification step at login. The
                    architecture supports TOTP-based 2FA — enable it when an authenticator
                    integration is connected.
                  </p>
                  <div className="mt-4 flex items-center gap-2 rounded-xl border border-border px-4 py-3">
                    <Shield className="h-4 w-4 text-gold-500" aria-hidden />
                    <p className="text-sm text-muted">
                      Status: <strong className="text-ink">Not enabled</strong>
                    </p>
                  </div>
                </section>

                <section className="card p-6">
                  <h2 className="text-lg font-bold text-ink">Login history</h2>
                  <p className="mt-1 text-sm text-muted">Recent sign-ins are recorded for your security.</p>
                  <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-mint-500/25 bg-mint-500/[0.06] px-4 py-3">
                    <MonitorSmartphone className="mt-0.5 h-4 w-4 text-mint-500" aria-hidden />
                    <p className="text-xs leading-relaxed text-muted">
                      You are signed in on {sessions.length} active session
                      {sessions.length === 1 ? '' : 's'}.
                    </p>
                  </div>
                </section>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
