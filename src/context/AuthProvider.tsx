'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react';
import type { MeDTO, UserSettingsDTO } from '@/types';

/** Result of PATCH /api/users/me — includes field-level validation errors. */
export interface ProfileUpdateResult {
  ok?: boolean;
  data?: { username?: string; displayName?: string; about?: string; avatarUrl?: string | null };
  error?: {
    code?: string;
    message?: string;
    /** Zod fieldErrors shape: { displayName?: string[], username?: string[], … } */
    details?: Record<string, string[] | undefined>;
  };
}

interface AuthContextValue {
  user: MeDTO | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  updateSettings: (patch: Partial<UserSettingsDTO>) => Promise<void>;
  updateProfile: (patch: Partial<Pick<MeDTO, 'displayName' | 'about' | 'username' | 'avatarUrl' | 'coverUrl' | 'accentColor'>>) => Promise<ProfileUpdateResult>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<MeDTO | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      const json = await res.json();
      setUser(json.ok ? (json.data as MeDTO) : null);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
    setUser(null);
    window.location.href = '/login';
  }, []);

  const updateSettings = useCallback(async (patch: Partial<UserSettingsDTO>) => {
    const res = await fetch('/api/users/me/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
      credentials: 'include'
    });
    const json = await res.json();
    if (json.ok) {
      setUser((prev) => (prev ? { ...prev, settings: { ...prev.settings, ...patch } } : prev));
    }
  }, []);

  const updateProfile = useCallback(
    async (patch: Partial<Pick<MeDTO, 'displayName' | 'about' | 'username' | 'avatarUrl'>>) => {
      const res = await fetch('/api/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
        credentials: 'include'
      });
      const json = await res.json();
      if (json.ok) {
        // Merge the server-canonical values (trimmed, normalized) over the patch.
        const canonical = (json.data ?? patch) as Partial<MeDTO>;
        setUser((prev) => (prev ? { ...prev, ...canonical } : prev));
      }
      return json as ProfileUpdateResult;
    },
    []
  );

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, refresh, logout, updateSettings, updateProfile }),
    [user, loading, refresh, logout, updateSettings, updateProfile]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
