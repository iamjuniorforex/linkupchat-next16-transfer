import { NextResponse } from 'next/server';
import { receiveWebhook } from '@/lib/billing';

export const dynamic = 'force-dynamic';

/** Provider webhooks. Signature is required. The body is never logged. */
export async function POST(req: Request) {
  const raw = await req.text();
  try {
    const result = await receiveWebhook(raw, req.headers);
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: { code: 'INVALID_SIGNATURE', message: 'Webhook signature was rejected.' } },
        { status: result.status }
      );
    }
    return NextResponse.json({
      ok: true,
      data: { received: true, duplicate: result.duplicate, ignored: result.ignored, simulated: result.simulated }
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: 'BAD_REQUEST', message: 'Webhook could not be processed.' } },
      { status: 400 }
    );
  }
}
