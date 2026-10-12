/**
 * One live call at a time in this tab — 1:1 or group, never both.
 * The server is still the authority across tabs and devices.
 */
export type CallLockKind = 'direct' | 'group';

let holder: CallLockKind | null = null;

export function callLockHolder(): CallLockKind | null {
  return holder;
}

export function claimCallLock(kind: CallLockKind): boolean {
  if (holder && holder !== kind) return false;
  holder = kind;
  return true;
}

export function releaseCallLock(kind: CallLockKind) {
  if (holder === kind) holder = null;
}
