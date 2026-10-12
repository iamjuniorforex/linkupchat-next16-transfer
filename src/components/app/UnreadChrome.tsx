'use client';

import { useEffect, useRef } from 'react';
import { useChat } from '@/context/ChatProvider';
import { useDocumentTitle } from '@/hooks/useMediaQuery';
import { formatUnreadBadge } from '@/lib/unread';

/**
 * Invisible chrome layer: mirrors the global unread count into the document
 * title ("(3) LINKUPCHAT") and onto the favicon. Renders nothing.
 */
export function UnreadChrome() {
  const { totalUnread } = useChat();
  const badge = formatUnreadBadge(totalUnread);

  useDocumentTitle(badge ? `(${badge})` : '', { join: ' ' });

  // ── Favicon badge ──
  const originalHrefRef = useRef<string | null>(null);
  const iconImgRef = useRef<HTMLImageElement | null>(null);

  // Restore the plain favicon on unmount (no timers/listeners to leak).
  useEffect(() => {
    return () => {
      const link = document.querySelector<HTMLLinkElement>("link[rel='icon'], link[rel='shortcut icon']");
      if (link && originalHrefRef.current) link.href = originalHrefRef.current;
    };
  }, []);

  useEffect(() => {
    const link =
      document.querySelector<HTMLLinkElement>("link[rel='icon'], link[rel='shortcut icon']");
    if (!link) return;
    // Capture the stock favicon once so unread = 0 always restores it.
    if (originalHrefRef.current === null) originalHrefRef.current = link.getAttribute('href') ?? link.href;

    if (totalUnread <= 0) {
      link.href = originalHrefRef.current;
      return;
    }

    let cancelled = false;
    const draw = (img: HTMLImageElement | null) => {
      if (cancelled) return;
      const size = 64;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, size, size);
      if (img) {
        try {
          ctx.drawImage(img, 0, 0, size, size);
        } catch {
          // fall through — badge still shows on the bare canvas
        }
      }
      const text = formatUnreadBadge(totalUnread) ?? '';
      const r = size * 0.3;
      const cx = size - r * 0.9;
      const cy = size - r * 0.9;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#FF6B5E';
      ctx.fill();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = '#FFFFFF';
      ctx.font = `bold ${Math.round(r * (text.length > 1 ? 0.95 : 1.15))}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, cx, cy + 1);
      link.href = canvas.toDataURL('image/png');
    };

    const cached = iconImgRef.current;
    if (cached?.complete && cached.naturalWidth > 0) {
      draw(cached);
    } else {
      const img = cached ?? new Image();
      img.width = 64;
      img.height = 64;
      img.onload = () => draw(img);
      img.onerror = () => draw(null);
      img.src = originalHrefRef.current;
      iconImgRef.current = img;
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalUnread]);

  return null;
}
