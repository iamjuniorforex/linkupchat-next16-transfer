'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { AuthProvider, useAuth } from '@/context/AuthProvider';
import { SocketProvider } from '@/context/SocketProvider';
import { ChatProvider } from '@/context/ChatProvider';
import { NotificationProvider } from '@/context/NotificationProvider';
import { Sidebar } from '@/components/app/Sidebar';
import { BottomNav } from '@/components/app/BottomNav';
import { UnreadChrome } from '@/components/app/UnreadChrome';
import { Logo } from '@/components/ui/Logo';
import { CallProvider } from '@/context/CallProvider';
import { GroupCallProvider } from '@/context/GroupCallProvider';
import { PushBootstrap } from '@/components/settings/PushBootstrap';
import { KeyboardInset } from '@/components/app/KeyboardInset';
import { ConnectionBanner } from '@/components/app/ConnectionBanner';
import { PwaBootstrap } from '@/components/app/PwaBootstrap';

function AppShell({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && !user) {
      router.replace('/login');
    }
  }, [loading, user, router]);

  if (loading) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center">
        <Logo size="lg" />
      </div>
    );
  }

  if (!user) return null;

  // On mobile, an open conversation takes the full screen. The same is true
  // for Settings: the sidebar has no list content for it (just a placeholder),
  // and the sidebar's full-width flex box would otherwise collapse the main
  // pane to 0px, making the Settings screen unreachable on phones. Profile
  // pages (/app/u/username) render in the main pane for the same reason —
  // without hiding the sidebar on mobile, "View profile" lands on an
  // invisible 0px pane and the user just sees the chat list again.
  const inConversation = pathname.startsWith('/app/chats/') && pathname.split('/').length > 3;
  const inSettings = pathname.startsWith('/app/settings');
  const inProfile = pathname.startsWith('/app/u/');
  const inPlans = pathname.startsWith('/app/premium') || pathname.startsWith('/app/business');
  const hideSidebarMobile = inConversation || inSettings || inProfile || inPlans;
  const hideBottomNav = inConversation;

  return (
    <SocketProvider>
      <NotificationProvider>
        <ChatProvider>
          <CallProvider>
            <GroupCallProvider>
            <UnreadChrome />
            <PushBootstrap />
            <PwaBootstrap />
            <KeyboardInset />
            <div className="app-shell flex flex-col overflow-hidden bg-bg">
              <ConnectionBanner />
              <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
                <Sidebar hideOnMobile={hideSidebarMobile} />
                <main id="main" className="app-main relative h-full min-w-0 flex-1 overflow-hidden pb-16 md:pb-0">
                  {children}
                </main>
                <BottomNav hidden={hideBottomNav} />
              </div>
            </div>
            </GroupCallProvider>
          </CallProvider>
        </ChatProvider>
      </NotificationProvider>
    </SocketProvider>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <AppShell>{children}</AppShell>
    </AuthProvider>
  );
}
