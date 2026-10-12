import type { CSSProperties } from 'react';

/**
 * Chat wallpaper presets (Settings → Chat → "Chat wallpaper").
 *
 * The selection lives in `UserSettings.wallpaper` (persisted through
 * PATCH /api/users/me/settings — see src/app/api/users/me/settings/route.ts)
 * and is applied by overriding the `--chat-wallpaper` CSS variable on any
 * `.chat-wallpaper` surface (see src/app/globals.css). 'default' leaves the
 * theme-aware gradient from globals.css untouched, so light/dark behavior is
 * preserved for users who never pick a wallpaper.
 */
export const WALLPAPERS = ['default', 'aurora', 'plain', 'midnight', 'sunset', 'forest'] as const;
export type Wallpaper = (typeof WALLPAPERS)[number];

export function isWallpaper(value: unknown): value is Wallpaper {
  return typeof value === 'string' && (WALLPAPERS as readonly string[]).includes(value);
}

/** Background-image value per preset; null = keep the themed default. */
const WALLPAPER_IMAGES: Record<Wallpaper, string | null> = {
  default: null,
  aurora: 'linear-gradient(135deg, #6D5EF5, #22B8FF)',
  plain: 'linear-gradient(rgb(var(--c-bg)), rgb(var(--c-bg)))',
  midnight: 'linear-gradient(160deg, #0f172a, #312e81)',
  sunset: 'linear-gradient(160deg, #9f1239, #c2410c)',
  forest: 'linear-gradient(160deg, #064e3b, #14532d)'
};

/** Thumbnail backgrounds for the settings picker (keep in sync with the above). */
const WALLPAPER_PREVIEWS: Record<Wallpaper, string | undefined> = {
  default: undefined,
  aurora: 'linear-gradient(135deg, #6D5EF5, #22B8FF)',
  plain: 'rgb(var(--c-bg))',
  midnight: 'linear-gradient(160deg, #0f172a, #312e81)',
  sunset: 'linear-gradient(160deg, #9f1239, #c2410c)',
  forest: 'linear-gradient(160deg, #064e3b, #14532d)'
};

/**
 * Style for a `.chat-wallpaper` surface that should render `wallpaper`.
 * Unknown/missing values fall back to the default themed wallpaper.
 */
export function wallpaperStyle(wallpaper: string | null | undefined): CSSProperties {
  const value = isWallpaper(wallpaper) ? WALLPAPER_IMAGES[wallpaper] : null;
  if (!value) return {};
  return { '--chat-wallpaper': value } as CSSProperties;
}

/** Style for a settings-picker thumbnail of `wallpaper`. */
export function wallpaperPreviewStyle(wallpaper: string): CSSProperties {
  return isWallpaper(wallpaper) ? { background: WALLPAPER_PREVIEWS[wallpaper] } : {};
}
