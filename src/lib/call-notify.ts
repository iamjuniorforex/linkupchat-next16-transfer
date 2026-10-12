/**
 * Incoming-call push. Sent only when the recipient has no live socket — the
 * open app already shows the call screen. Never logs names, SDP, or credentials.
 */
import { db } from './db';
import { buildIncomingCallNotification, notificationAllowed } from './notifications';
import { dispatchPush } from './push';

export async function pushIncomingCall(args: {
  userId: string;
  callId: string;
  callerName: string;
  callKind: 'VOICE' | 'VIDEO';
  groupTitle?: string | null;
}): Promise<void> {
  const settings = await db.user.findUnique({
    where: { id: args.userId },
    select: { settings: { select: { notifEnabled: true, notifCalls: true } } }
  });
  if (settings?.settings && !notificationAllowed({ channel: 'CALL', settings: settings.settings })) return;
  const { title, body } = buildIncomingCallNotification({
    callerName: args.callerName,
    callKind: args.callKind,
    groupTitle: args.groupTitle
  });
  await dispatchPush({
    userId: args.userId,
    kind: 'CALL',
    title,
    body,
    data: { url: '/app/calls' },
    tag: `call:${args.callId}`
  });
}
