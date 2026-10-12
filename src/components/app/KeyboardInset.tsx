'use client';

import { useEffect } from 'react';
import { keyboardInsetPx } from '@/lib/mobile-viewport';

/** Publishes `--keyboard-inset` and `data-keyboard` from the visual viewport. */
export function KeyboardInset() {
  useEffect(() => {
    const root = document.documentElement;
    let last = -1;

    const apply = () => {
      const vv = window.visualViewport;
      const inset = vv ? keyboardInsetPx(window.innerHeight, vv.height, vv.offsetTop) : 0;
      root.style.setProperty('--keyboard-inset', `${inset}px`);
      if (inset > 0) root.dataset.keyboard = 'open';
      else delete root.dataset.keyboard;
      if (inset !== last) {
        last = inset;
        window.dispatchEvent(new CustomEvent('linkup:keyboard', { detail: { inset } }));
        if (inset > 0 && window.scrollY > 0) window.scrollTo(0, 0);
      }
    };

    apply();
    window.visualViewport?.addEventListener('resize', apply);
    window.visualViewport?.addEventListener('scroll', apply);
    window.addEventListener('resize', apply);
    return () => {
      window.visualViewport?.removeEventListener('resize', apply);
      window.visualViewport?.removeEventListener('scroll', apply);
      window.removeEventListener('resize', apply);
      root.style.removeProperty('--keyboard-inset');
      delete root.dataset.keyboard;
    };
  }, []);

  return null;
}
