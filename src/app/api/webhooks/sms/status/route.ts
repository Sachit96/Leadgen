import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { conversations } from '@/lib/db/schema';
import { logger } from '@/lib/core/logger';
import { errorMessage } from '@/lib/core/errors';
import { readWebhookRequest } from '@/lib/api/webhook-request';
import { getSmsProvider } from '@/lib/providers/sms';
import { systemCtx } from '@/lib/auth/context';
import { recordActivity } from '@/lib/services/activity';
import {
  applyDeliveryUpdate,
  findByProviderMessageId,
  recordProviderEvent,
} from '@/lib/services/messages';
import { suppress } from '@/lib/services/suppression';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Provider error codes that mean the number itself is bad, not the attempt. */
const INVALID_NUMBER_CODES = new Set(['21211', '21614', '21610', '30003', '30005', '30006']);

export async function POST(request: NextRequest) {
  const provider = getSmsProvider();

  try {
    const webhookRequest = await readWebhookRequest(request);
    const update = await provider.handleDeliveryUpdate(webhookRequest);

    if (!update) {
      return NextResponse.json({ error: 'Invalid signature or payload' }, { status: 403 });
    }

    const message = await findByProviderMessageId(provider.kind, update.providerMessageId);
    if (!message) {
      // Status for a message we never recorded — acknowledge and move on.
      return NextResponse.json({ ok: false, reason: 'unknown_message' });
    }

    const fresh = await recordProviderEvent(message.organizationId, {
      kind: 'status',
      dedupeKey: update.dedupeKey,
      providerKind: provider.kind,
      providerMessageId: update.providerMessageId,
      messageId: message.id,
      payload: update.raw,
    });
    if (!fresh) return NextResponse.json({ ok: true, duplicate: true });

    await applyDeliveryUpdate(update, message);
    const ctx = systemCtx(message.organizationId);

    if (update.status === 'delivered') {
      await recordActivity(ctx, {
        type: 'message_delivered',
        title: 'Message delivered',
        contactId: message.contactId,
        conversationId: message.conversationId,
        metadata: { messageId: message.id },
      });
    }

    if (update.status === 'failed' || update.status === 'undelivered') {
      await recordActivity(ctx, {
        type: 'message_failed',
        title: `Message ${update.status}`,
        body: update.errorMessage ?? null,
        contactId: message.contactId,
        conversationId: message.conversationId,
        metadata: { messageId: message.id, code: update.errorCode ?? null },
      });

      // A number the carrier says is unreachable should stop consuming sends.
      if (update.errorCode && INVALID_NUMBER_CODES.has(update.errorCode) && message.toNumber) {
        await suppress(ctx, {
          phone: message.toNumber,
          reason: 'INVALID_NUMBER',
          note: `Carrier error ${update.errorCode}: ${update.errorMessage ?? 'undeliverable'}`,
          contactId: message.contactId,
        });
      }

      await getDb()
        .update(conversations)
        .set({ updatedAt: new Date() })
        .where(eq(conversations.id, message.conversationId));
    }

    return NextResponse.json({ ok: true, status: update.status });
  } catch (error) {
    logger.error('status webhook failed', {
      provider: provider.kind,
      errorCode: errorMessage(error).slice(0, 200),
    });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
