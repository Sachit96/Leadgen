import { NextResponse, type NextRequest } from 'next/server';
import { logger } from '@/lib/core/logger';
import { errorMessage } from '@/lib/core/errors';
import { readWebhookRequest } from '@/lib/api/webhook-request';
import { getSmsProvider } from '@/lib/providers/sms';
import { handleInboundMessage, resolveOrganizationForNumber } from '@/lib/services/inbound';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Inbound SMS.
 *
 * Returns 200 for anything successfully processed *or* already processed, so a
 * provider retry never produces a duplicate message. Signature failures return
 * 403 and are never processed.
 */
export async function POST(request: NextRequest) {
  const provider = getSmsProvider();

  try {
    const webhookRequest = await readWebhookRequest(request);
    const inbound = await provider.handleInbound(webhookRequest);

    if (!inbound) {
      logger.warn('inbound webhook rejected', { provider: provider.kind, result: 'unverified' });
      return NextResponse.json({ error: 'Invalid signature or payload' }, { status: 403 });
    }

    const organizationId = await resolveOrganizationForNumber(inbound.to);
    if (!organizationId) {
      logger.warn('inbound webhook for unknown number', { provider: provider.kind });
      // 200 so the provider stops retrying a message we can never route.
      return NextResponse.json({ ok: false, reason: 'unrouted' });
    }

    const outcome = await handleInboundMessage(organizationId, inbound, provider.kind);
    return NextResponse.json({ ok: true, duplicate: outcome.duplicate, intent: outcome.intent });
  } catch (error) {
    logger.error('inbound webhook failed', {
      provider: provider.kind,
      errorCode: errorMessage(error).slice(0, 200),
    });
    // 500 asks the provider to retry; the dedupe key keeps that safe.
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
