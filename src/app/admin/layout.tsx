'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  ShieldCheck,
  Users,
  Flag,
  BarChart3,
  ArrowLeft,
  BadgeCheck
} from 'lucide-react';
import { AuthProvider, useAuth } from '@/context/AuthProvider';
import { Logo } from '@/components/ui/Logo';
import { Avatar } from '@/components/ui/Avatar';
import { PageLoader } from '@/components/ui/Skeleton';
import { cn } from '@/lib/utils';

function AdminGuard({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && (!user || (user.role !== 'ADMIN' && user.role !== 'MODERATOR'))) {
      router.replace('/app/chats');
    }
  }, [loading, user, router]);

  if (loading) return <PageLoader label="Checking access…" />;
  if (!user || (user.role !== 'ADMIN' && user.role !== 'MODERATOR')) return null;
  return <>{children}</>;
}

function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user } = useAuth();

  const nav = [
    { href: '/admin', label: 'Overview', icon: BarChart3 },
    { href: '/admin/users', label: 'Users', icon: Users },
    { href: '/admin/reports', label: 'Reports', icon: Flag },
    { href: '/admin/business', label: 'Business', icon: BadgeCheck }
  ];

  return (
    <div className="flex min-h-[100dvh] flex-col bg-bg">
      <header className="flex h-16 items-center gap-4 border-b border-border bg-surface px-5">
        <Link href="/app/chats" className="icon-btn" aria-label="Back to app">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <Logo size="sm" />
        <span className="flex items-center gap-1.5 rounded-full bg-coral-500/12 px-3 py-1 text-xs font-bold text-coral-500">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> ADMIN
        </span>
        <nav className="ml-6 hidden gap-1 md:flex" aria-label="Admin">
          {nav.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={cn(
                'flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-semibold transition-colors',
                pathname === n.href
                  ? 'bg-brand-500 text-white'
                  : 'text-muted hover:bg-ink/[0.05] dark:hover:bg-white/[0.06]'
              )}
            >
              <n.icon className="h-4 w-4" aria-hidden />
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Avatar name={user?.displayName ?? '?'} src={user?.avatarUrl} size="sm" />
          <span className="hidden text-sm font-semibold text-ink sm:block">{user?.displayName}</span>
        </div>
      </header>
      <main id="main" className="flex-1 p-6">{children}</main>
    </div>
  );
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <AdminGuard>
        <AdminShell>{children}</AdminShell>
      </AdminGuard>
    </AuthProvider>
  );
}
