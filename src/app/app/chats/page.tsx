'use client';

import { MessageCircle, MessageSquarePlus, MonitorSmartphone, Zap } from 'lucide-react';
import { LogoMark } from '@/components/ui/Logo';
import { useAuth } from '@/context/AuthProvider';
import { useIsMobile } from '@/hooks/useMediaQuery';
import { wallpaperStyle } from '@/lib/wallpapers';

export default function ChatsEmptyPage() {
  const { user } = useAuth();
  const isMobile = useIsMobile();

  if (isMobile) {
    // Mobile: the chat list lives in the sidebar (full-width)
    return null;
  }

  return (
    <div
      className="chat-wallpaper flex h-full flex-col items-center justify-center px-8 text-center"
      style={wallpaperStyle(user?.settings?.wallpaper)}
    >
      <LogoMark size={72} />
      <h1 className="mt-7 text-2xl font-extrabold tracking-tight text-ink">
        Welcome to <span className="text-gradient">LINKUPCHAT</span>
      </h1>
      <p className="mt-3 max-w-sm text-[15px] leading-relaxed text-muted">
        Select a conversation from the sidebar, or start a new chat to link up with your people.
      </p>

      <div className="mt-10 grid w-full max-w-md grid-cols-3 gap-4">
        {[
          { icon: Zap, label: 'Real-time messaging', color: 'text-brand-500 bg-brand-500/10' },
          { icon: MessageCircle, label: 'Groups & media', color: 'text-mint-500 bg-mint-500/10' },
          { icon: MonitorSmartphone, label: 'Works everywhere', color: 'text-coral-500 bg-coral-500/10' }
        ].map((f) => (
          <div key={f.label} className="card flex flex-col items-center gap-2.5 p-4">
            <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${f.color}`}>
              <f.icon className="h-5 w-5" aria-hidden />
            </span>
            <span className="text-xs font-semibold leading-tight text-muted">{f.label}</span>
          </div>
        ))}
      </div>

      <div className="mt-10 flex items-center gap-2 text-xs text-faint">
        <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden />
        Use New chat in the sidebar to start a conversation.
      </div>
    </div>
  );
}
