/**
 * Phase 18 — viewport math for the on-screen keyboard.
 *
 * Mobile Safari and Android Chrome do not always shrink `100dvh` when the
 * keyboard opens. The visual viewport does. A small difference is browser
 * chrome (address bar), not a keyboard, and must not jump the composer.
 */

export const KEYBOARD_INSET_MIN_PX = 80;
export const IOS_INPUT_ZOOM_FONT_PX = 16;

export function keyboardInsetPx(
  windowInnerHeight: number,
  visualViewportHeight: number,
  visualViewportOffsetTop: number
): number {
  if (
    !Number.isFinite(windowInnerHeight) ||
    !Number.isFinite(visualViewportHeight) ||
    !Number.isFinite(visualViewportOffsetTop)
  ) {
    return 0;
  }
  const inset = windowInnerHeight - visualViewportHeight - visualViewportOffsetTop;
  if (inset < KEYBOARD_INSET_MIN_PX) return 0;
  return Math.round(inset);
}

/** iOS zooms focused fields whose computed font size is below 16px. */
export function avoidsIosInputZoom(fontSizePx: number): boolean {
  return Number.isFinite(fontSizePx) && fontSizePx >= IOS_INPUT_ZOOM_FONT_PX;
}

export interface WebAppManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

export interface WebAppManifest {
  name?: string;
  short_name?: string;
  start_url?: string;
  display?: string;
  icons?: WebAppManifestIcon[];
}

/** Installability checklist used by the Phase 18 unit test. Does not claim the OS will install. */
export function manifestIsInstallable(manifest: WebAppManifest): boolean {
  const icons = manifest.icons ?? [];
  const png = (size: string) =>
    icons.some((icon) => icon.type === 'image/png' && icon.sizes.split(/\s+/).includes(size) && icon.src.startsWith('/'));
  return Boolean(
    manifest.name &&
      manifest.short_name &&
      manifest.start_url?.startsWith('/') &&
      manifest.display === 'standalone' &&
      png('192x192') &&
      png('512x512')
  );
}
