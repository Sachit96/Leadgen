import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { contacts, conversations, messages, phoneNumbers } from '@/lib/db/schema';
import { logger } from '@/lib/core/logger';
import { nextWindowOpening, withinSendingWindow } from '@/lib/core/time';
import { env } from '@/lib/env';
import { defaultFromNumber, getSmsProvider, ProviderError } from '@/lib/providers/sms';
import { systemCtx, type Ctx } from '@/lib/auth/context';
import { recordActivity } from './activity';
import { advanceProspectStatus } from './contacts';
import { isStopped } from './conversations';
import {
  automatedSentToday,
  lastOutboundAt,
  markMessageFailed,
  markMessageSending,
  markMessageSent,
  orgSentToday,
} from './messages';
import { notify } from './notifications';
import { cancelJob, completeJob, deferJob, failJob, type ClaimedJob } from './queue';
import { getOrgConfig } from './settings';
import { isSuppressed } from './suppression';

export type SendOutcome =
  | { result: 'sent'; messageId: string; providerMessageId: string }
  | { result: 'cancelled'; reason: string }
  | { result: 'deferred'; until: Date; reason: string }
  | { result: 'retrying'; error: string }
  | { result: 'dead'; error: string };

/**
 * Executes one queued outbound message.
 *
 * Guardrails are re-evaluated here rather than only at queue time, because a
 * job can sit in the queue for hours: a prospect who replied STOP after the job
 * was created must not receive it.
 */
export async function processOutboundJob(job: ClaimedJob): Promise<SendOutcome> {
  const db = getDb();
  const log = logger.child({ jobId: job.id, messageId: job.messageId, organizationId: job.organizationId });

  const rows = await db
    .select({ message: messages, conversation: conversations, contact: contacts })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .innerJoin(contacts, eq(contacts.id, messages.contactId))
    .where(eq(messages.id, job.messageId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    await cancelJob(job.id, 'message no longer exists');
    return { result: 'cancelled', reason: 'message no longer exists' };
  }

  const { message, conversation, contact } = row;
  const ctx = systemCtx(job.organizationId);

  if (message.status !== 'QUEUED') {
    await completeJob(job.id);
    return { result: 'cancelled', reason: `message already ${message.status}` };
  }

  const automated = message.author === 'AI' || message.author === 'SYSTEM';
  const stop = await stopReason(ctx, conversation.state, contact.status, contact.phone);
  if (stop) {
    await cancelJob(job.id, stop);
    await markMessageFailed(message.id, 'SUPPRESSED', stop);
    log.info('outbound cancelled', { result: 'cancelled', errorCode: 'SUPPRESSED' });
    return { result: 'cancelled', reason: stop };
  }

  if (automated) {
    const defer = await deferReason(ctx, contact.id, contact.timezone);
    if (defer) {
      await deferJob(job.id, defer.until, defer.reason);
      log.info('outbound deferred', { result: 'deferred', reason: defer.reason });
      return { result: 'deferred', until: defer.until, reason: defer.reason };
    }
  }

  const from = await resolveFromNumber(ctx, conversation.phoneNumberId, message.fromNumber);
  const provider = getSmsProvider();
  const startedAt = Date.now();

  try {
    await markMessageSending(message.id);
    const result = await provider.sendMessage({
      to: contact.phone,
      from,
      body: message.body,
      idempotencyKey: job.idempotencyKey,
      statusCallbackUrl: statusCallbackUrl(),
    });

    await markMessageSent(message.id, {
      providerKind: provider.kind,
      providerMessageId: result.providerMessageId,
      status: result.status,
      segments: result.segments,
      costCents: result.costCents,
      fromNumber: from,
    });
    await completeJob(job.id);

    await db
      .update(conversations)
      .set({
        lastMessageAt: new Date(),
        lastOutboundAt: new Date(),
        state: conversation.state === 'NEW' ? 'OPENING' : conversation.state,
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversation.id));

    await advanceProspectStatus(ctx, contact.id, 'CONTACTED');
    await recordActivity(ctx, {
      type: 'message_sent',
      title: `Message sent via ${provider.kind}`,
      body: message.body,
      contactId: contact.id,
      conversationId: conversation.id,
      campaignId: message.campaignId,
      metadata: { messageId: message.id, providerMessageId: result.providerMessageId },
    });

    log.info('outbound sent', {
      provider: provider.kind,
      latencyMs: Date.now() - startedAt,
      result: 'sent',
    });
    return { result: 'sent', messageId: message.id, providerMessageId: result.providerMessageId };
  } catch (error) {
    const providerError = error instanceof ProviderError ? error : null;
    const detail = error instanceof Error ? error.message : String(error);
    const retryable = providerError?.retryable ?? true;
    const outcome = await failJob(job, detail, retryable);

    log.warn('outbound send failed', {
      provider: provider.kind,
      latencyMs: Date.now() - startedAt,
      errorCode: providerError?.providerCode ?? 'UNKNOWN',
      result: outcome,
    });

    if (outcome === 'dead') {
      await markMessageFailed(message.id, providerError?.providerCode ?? null, detail);
      await recordActivity(ctx, {
        type: 'message_failed',
        title: 'Message failed to send',
        body: detail,
        contactId: contact.id,
        conversationId: conversation.id,
        metadata: { messageId: message.id, code: providerError?.providerCode ?? null },
      });
      await notify(ctx, {
        type: 'provider_failure',
        title: 'A message could not be delivered',
        body: detail,
        link: `/inbox/${conversation.id}`,
      });
      return { result: 'dead', error: detail };
    }

    // Back to QUEUED so a retry picks it up in the same state it started.
    await db.update(messages).set({ status: 'QUEUED' }).where(eq(messages.id, message.id));
    return { result: 'retrying', error: detail };
  }
}

async function stopReason(
  ctx: Ctx,
  state: string,
  contactStatus: string,
  phone: string,
): Promise<string | null> {
  if (contactStatus === 'DO_NOT_CONTACT') return 'prospect is marked do-not-contact';
  if (isStopped(state as never)) return `conversation is ${state}`;
  if (await isSuppressed(ctx, phone)) return 'number is on the suppression list';
  return null;
}

async function deferReason(
  ctx: Ctx,
  contactId: string,
  contactTimezone: string | null,
): Promise<{ until: Date; reason: string } | null> {
  const config = await getOrgConfig(ctx);
  const now = new Date();
  const timezone = contactTimezone ?? ctx.timezone;

  // Quiet hours are expressed as the hours when sending is NOT allowed, so the
  // allowed window is the inverse.
  const allowed = withinSendingWindow(
    now,
    timezone,
    config.sending.quietHoursEnd,
    config.sending.quietHoursStart,
    config.sending.sendingDays,
  );
  if (!allowed) {
    return {
      until: nextWindowOpening(
        now,
        timezone,
        config.sending.quietHoursEnd,
        config.sending.quietHoursStart,
        config.sending.sendingDays,
      ),
      reason: 'outside sending window',
    };
  }

  const sentToday = await orgSentToday(ctx);
  if (sentToday >= config.sending.dailyOrgCap) {
    const tomorrow = new Date();
    tomorrow.setHours(24, 0, 0, 0);
    return { until: tomorrow, reason: 'daily organization cap reached' };
  }

  const perContact = await automatedSentToday(ctx, contactId);
  if (perContact >= config.sending.maxAutomatedPerContactPerDay) {
    const tomorrow = new Date();
    tomorrow.setHours(24, 0, 0, 0);
    return { until: tomorrow, reason: 'per-contact daily limit reached' };
  }

  const last = await lastOutboundAt(ctx, contactId);
  if (last) {
    const cooldownMs = config.sending.contactCooldownMinutes * 60_000;
    const elapsed = Date.now() - last.getTime();
    if (elapsed < cooldownMs) {
      return { until: new Date(last.getTime() + cooldownMs), reason: 'contact cooldown' };
    }
  }

  return null;
}

async function resolveFromNumber(
  ctx: Ctx,
  phoneNumberId: string | null,
  explicit: string | null,
): Promise<string> {
  if (explicit) return explicit;
  if (phoneNumberId) {
    const rows = await getDb()
      .select({ number: phoneNumbers.number })
      .from(phoneNumbers)
      .where(and(eq(phoneNumbers.id, phoneNumberId), eq(phoneNumbers.organizationId, ctx.organizationId)))
      .limit(1);
    if (rows[0]) return rows[0].number;
  }

  const fallback = await getDb()
    .select({ number: phoneNumbers.number })
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.organizationId, ctx.organizationId), eq(phoneNumbers.active, true)))
    .orderBy(sql`${phoneNumbers.createdAt} asc`)
    .limit(1);

  return fallback[0]?.number ?? defaultFromNumber() ?? '';
}

function statusCallbackUrl(): string | undefined {
  const base = env().NEXT_PUBLIC_APP_URL;
  if (!base || base.includes('localhost')) return undefined;
  return `${base.replace(/\/$/, '')}/api/webhooks/sms/status`;
}
