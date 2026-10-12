import type { Metadata, Viewport } from 'next';
import { ThemeProvider } from '@/context/ThemeProvider';
import { ToastProvider } from '@/components/ui/Toast';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'LINKUPCHAT — Stay connected. Link up.',
    template: '%s · LINKUPCHAT'
  },
  description:
    'Simple, fast and modern messaging for the people who matter. Chat, share and link up with friends and groups — with voice calls, video calls and status updates.',
  applicationName: 'LINKUPCHAT',
  keywords: ['messaging', 'chat', 'LINKUPCHAT', 'voice calls', 'video calls', 'groups'],
  openGraph: {
    title: 'LINKUPCHAT — Stay connected. Link up.',
    description: 'Simple, fast and modern messaging for the people who matter.',
    type: 'website'
  },
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'LINKUPCHAT',
    statusBarStyle: 'default'
  },
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }]
  }
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F6F7FB' },
    { media: '(prefers-color-scheme: dark)', color: '#0C0E1A' }
  ],
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover'
};

const themeBoot = `(function(){try{var t=localStorage.getItem('linkup-theme');var dark=t==='DARK'||(t!=='LIGHT'&&window.matchMedia('(prefers-color-scheme: dark)').matches);var root=document.documentElement;root.classList.toggle('dark',dark);root.style.colorScheme=dark?'dark':'light';}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-[100dvh] font-sans">
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <ThemeProvider>
          <ToastProvider>{children}</ToastProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
