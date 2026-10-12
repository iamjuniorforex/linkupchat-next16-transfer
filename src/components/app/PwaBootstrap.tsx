'use client';

import { useEffect } from 'react';

/**
 * Registers the existing service worker so the app can be installed.
 * Does not request notification permission — Phase 17 push still owns that.
 */
export function PwaBootstrap() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  }, []);
  return null;
}
