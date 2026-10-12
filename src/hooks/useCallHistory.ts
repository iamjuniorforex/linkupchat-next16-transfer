'use client';

/**
 * Shared call-history state for the two surfaces that list it (the /app/calls
 * page and the sidebar "Recent calls"). Call history is not realtime — it is
 * fetched from GET /api/calls — so this keeps a small module-level cache with
 * subscribers and updates it immediately after a successful delete, without a
 * refetch round-trip or diverging copies between surfaces.
 */
import { useEffect, useState } from 'react';
import type { CallRecordDTO } from '@/types';

interface Cache {
  calls: CallRecordDTO[];
  loaded: boolean;
}

let cache: Cache | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function load(): Promise<void> {
  if (!inflight) {
    inflight = fetch('/api/calls', { credentials: 'include' })
      .then((r) => r.json())
      .then((j: { ok?: boolean; data?: { calls?: CallRecordDTO[] } }) => {
        cache = { calls: j.ok ? (j.data?.calls ?? []) : [], loaded: true };
        emit();
      })
      .catch(() => {
        cache = { calls: cache?.calls ?? [], loaded: true };
        emit();
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** DELETE /api/calls/:id and drop the entry from the shared cache. */
export async function deleteCallHistoryEntry(id: string): Promise<void> {
  const res = await fetch(`/api/calls/${id}`, { method: 'DELETE', credentials: 'include' });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) {
    throw new Error(json?.error?.message ?? 'Could not remove the call from your history.');
  }
  cache = cache ? { ...cache, calls: cache.calls.filter((c) => c.id !== id) } : cache;
  emit();
}

export function useCallHistory() {
  const [, setTick] = useState(0);

  useEffect(() => {
    const listener = () => setTick((t) => t + 1);
    listeners.add(listener);
    void load();
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return {
    calls: cache?.calls ?? [],
    loaded: cache?.loaded ?? false,
    deleteCall: deleteCallHistoryEntry,
    refresh: load
  };
}
