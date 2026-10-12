import type { CSSProperties } from 'react';
import { isChatTheme, type ChatThemeKey } from './plans';

const IMAGES: Record<Exclude<ChatThemeKey, 'default'>, string> = {
  midnight: 'linear-gradient(160deg, #0f172a, #312e81)',
  sunset: 'linear-gradient(160deg, #9f1239, #c2410c)',
  forest: 'linear-gradient(160deg, #064e3b, #14532d)'
};

export function chatThemeStyle(theme: string | null | undefined): CSSProperties {
  if (!isChatTheme(theme) || theme === 'default') return {};
  return { '--chat-wallpaper': IMAGES[theme] } as CSSProperties;
}
