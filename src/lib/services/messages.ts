import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gte, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { contacts, conversations, messageEvents, messages } from '@/lib/db/schema';
import { AppError, invalid, notFound } from '@/lib/core/errors';
import { segmentInfo } from '@/lib/core/template';
import { assertCan } from '@/lib/auth/rbac';
import { recordActivity } from './activity';
import { enqueue } from './queue';
import { isSuppressed } from './suppression';
import { isStopped } from './conversations';
import type { Ctx } from '@/lib/auth/context';
import type { Message, MessageAuthor, MessageStatus } from '@/lib/db/types';
import type { DeliveryUpdate, NormalizedStatus, ProviderKind } from '@/lib/providers/sms';

export type QueueOutboundInput = {
  conversationId: string;
  body: string;
  author: MessageAuthor;
  /** Stable key. The same key never produces two sends. */
  idempotencyKey: string;
  campaignId?: string | null;
  stepId?: string | null;
  variantId?: string | null;
  promptVersion?: string | null;
  fromNumber?: string | null;
  runAt?: Date;
};

/**
 * The only way an outbound SMS enters the system.
 *
 * Writes the message row and its queue job, then returns. Nothing is sent on
 * the request path — the worker does that.
 */
export async function queueOutbound(ctx: Ctx, input: QueueOutboundInput): Promise<Message> {
  const body = input.body.trim();
  if (!body) throw invalid('Message body cannot be empty');
  if (/\{\{.*?\}\}/.test(body)) {
    throw invalid('Message still contains unresolved variables and will not be queued');
  }

  const db = getDb();
  const rows = await db
    .select({ conversation: conversations, contact: contacts })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(
      and(
        eq(conversations.id, input.conversationId),
        eq(conversations.organizationId, ctx.organizationId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) throw notFound('Conversation');
  const { conversation, contact } = row;

  if (contact.status === 'DO_NOT_CONTACT' || isStopped(conversation.state)) {
    throw new AppError('SUPPRESSED', 'This conversation is closed to further outreach');
  }
  if (await isSuppressed(ctx, contact.phone)) {
    throw new AppError('SUPPRESSED', 'That number is on the do-not-contact list');
  }

  const info = segmentInfo(body);

  const [message] = await db
    .insert(messages)
    .values({
      organizationId: ctx.organizationId,
      conversationId: conversation.id,
      contactId: contact.id,
      direction: 'OUTBOUND',
      author: input.author,
      status: 'QUEUED',
      body,
      fromNumber: input.fromNumber ?? null,
      toNumber: contact.phone,
      campaignId: input.campaignId ?? conversation.campaignId ?? null,
      stepId: input.stepId ?? null,
      variantId: input.variantId ?? null,
      promptVersion: input.promptVersion ?? null,
      sentByUserId: input.author === 'HUMAN' ? ctx.userId : null,
      segments: info.segments,
    })
    .returning();

  const jobId = await enqueue(ctx, {
    messageId: message!.id,
    conversationId: conversation.id,
    idempotencyKey: input.idempotencyKey,
    runAt: input.runAt,
  });

  if (!jobId) {
    // The key was already queued — drop the duplicate row we just wrote rather
    // than leaving an orphan QUEUED message the operator would have to explain.
    await db.delete(messages).where(eq(messages.id, message!.id));
    const existing = await db
      .select()
      .from(messages)
      .where(
        and(eq(messages.conversationId, conversation.id), eq(messages.body, body)),
      )
      .orderBy(desc(messages.createdAt))
      .limit(1);
    if (existing[0]) return existing[0];
    throw new AppError('CONFLICT', 'This message was already queued');
  }

  await recordActivity(ctx, {
    type: 'message_queued',
    title: `Message queued (${input.author.toLowerCase()})`,
    body,
    contactId: contact.id,
    conversationId: conversation.id,
    campaignId: input.campaignId ?? conversation.campaignId ?? null,
    metadata: { messageId: message!.id, segments: info.segments, variantId: input.variantId ?? null },
  });

  return message!;
}

/** Deterministic idempotency key so a retried caller cannot double-send. */
export function sequenceIdempotencyKey(
  conversationId: string,
  stepId: string,
  attemptSalt = '',
): string {
  return `seq:${conversationId}:${stepId}${attemptSalt ? `:${attemptSalt}` : ''}`;
}

export function aiReplyIdempotencyKey(conversationId: string, inboundMessageId: string): string {
  return `ai:${conversationId}:${inboundMessageId}`;
}

export function manualIdempotencyKey(conversationId: string, body: string, userId: string): string {
  const digest = createHash('sha256').update(`${body}|${userId}`).digest('hex').slice(0, 16);
  // Manual sends are bucketed per minute: a double-click is deduped, a
  // deliberate repeat a minute later is not.
  return `manual:${conversationId}:${digest}:${Math.floor(Date.now() / 60_000)}`;
}

export async function markMessageSending(messageId: string): Promise<void> {
  await getDb().update(messages).set({ status: 'SENDING' }).where(eq(messages.id, messageId));
}

export async function markMessageSent(
  messageId: string,
  data: {
    providerKind: ProviderKind;
    providerMessageId: string;
    status: NormalizedStatus;
    segments?: number;
    costCents?: number;
    fromNumber?: string;
  },
): Promise<void> {
  await getDb()
    .update(messages)
    .set({
      status: mapProviderStatus(data.status),
      providerKind: data.providerKind,
      providerMessageId: data.providerMessageId,
      segments: data.segments,
      costCents: data.costCents,
      fromNumber: data.fromNumber,
      sentAt: new Date(),
    })
    .where(eq(messages.id, messageId));
}

export async function markMessageFailed(
  messageId: string,
  errorCode: string | null,
  errorMessage: string,
): Promise<void> {
  await getDb()
    .update(messages)
    .set({ status: 'FAILED', errorCode, errorMessage: errorMessage.slice(0, 500), failedAt: new Date() })
    .where(eq(messages.id, messageId));
}

export function mapProviderStatus(status: NormalizedStatus): MessageStatus {
  switch (status) {
    case 'queued':
      return 'QUEUED';
    case 'sending':
      return 'SENDING';
    case 'sent':
      return 'SENT';
    case 'delivered':
      return 'DELIVERED';
    case 'undelivered':
      return 'UNDELIVERED';
    case 'failed':
      return 'FAILED';
    case 'received':
      return 'RECEIVED';
    default:
      return 'SENT';
  }
}

export async function listMessages(ctx: Ctx, conversationId: string, limit = 200) {
  return getDb()
    .select()
    .from(messages)
    .where(
      and(eq(messages.organizationId, ctx.organizationId), eq(messages.conversationId, conversationId)),
    )
    .orderBy(asc(messages.createdAt))
    .limit(limit);
}

export async function getMessage(ctx: Ctx, id: string): Promise<Message> {
  const rows = await getDb()
    .select()
    .from(messages)
    .where(and(eq(messages.id, id), eq(messages.organizationId, ctx.organizationId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound('Message');
  return row;
}

/**
 * Records a provider webhook event. Returns false when the event was already
 * processed, which is how webhook retries stay harmless.
 */
export async function recordProviderEvent(
  organizationId: string,
  event: {
    kind: string;
    dedupeKey: string;
    providerKind: ProviderKind;
    providerMessageId: string;
    messageId?: string | null;
    payload: unknown;
  },
): Promise<boolean> {
  const rows = await getDb()
    .insert(messageEvents)
    .values({
      organizationId,
      messageId: event.messageId ?? null,
      kind: event.kind,
      providerKind: event.providerKind,
      providerMessageId: event.providerMessageId,
      dedupeKey: event.dedupeKey,
      payload: event.payload as Record<string, unknown>,
    })
    .onConflictDoNothing({ target: messageEvents.dedupeKey })
    .returning({ id: messageEvents.id });
  return rows.length > 0;
}

export async function findByProviderMessageId(
  providerKind: ProviderKind,
  providerMessageId: string,
): Promise<Message | null> {
  const rows = await getDb()
    .select()
    .from(messages)
    .where(
      and(eq(messages.providerKind, providerKind), eq(messages.providerMessageId, providerMessageId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Applies a delivery webhook to the message row. Never regresses a status. */
export async function applyDeliveryUpdate(update: DeliveryUpdate, message: Message): Promise<void> {
  const next = mapProviderStatus(update.status);
  if (STATUS_RANK[next] < STATUS_RANK[message.status]) return;

  await getDb()
    .update(messages)
    .set({
      status: next,
      errorCode: update.errorCode ?? message.errorCode,
      errorMessage: update.errorMessage ?? message.errorMessage,
      deliveredAt: next === 'DELIVERED' ? update.occurredAt : message.deliveredAt,
      failedAt: next === 'FAILED' || next === 'UNDELIVERED' ? update.occurredAt : message.failedAt,
    })
    .where(eq(messages.id, message.id));
}

const STATUS_RANK: Record<MessageStatus, number> = {
  DRAFT: 0,
  QUEUED: 1,
  SENDING: 2,
  SENT: 3,
  RECEIVED: 3,
  DELIVERED: 4,
  UNDELIVERED: 4,
  FAILED: 4,
};

/** Automated messages sent to one contact since midnight — cooldown input. */
export async function automatedSentToday(ctx: Ctx, contactId: string): Promise<number> {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const rows = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        eq(messages.organizationId, ctx.organizationId),
        eq(messages.contactId, contactId),
        eq(messages.direction, 'OUTBOUND'),
        sql`${messages.author} in ('AI','SYSTEM')`,
        gte(messages.createdAt, midnight),
      ),
    );
  return rows[0]?.count ?? 0;
}

export async function orgSentToday(ctx: Ctx): Promise<number> {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const rows = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        eq(messages.organizationId, ctx.organizationId),
        eq(messages.direction, 'OUTBOUND'),
        sql`${messages.status} <> 'DRAFT'`,
        gte(messages.createdAt, midnight),
      ),
    );
  return rows[0]?.count ?? 0;
}

export async function lastOutboundAt(ctx: Ctx, contactId: string): Promise<Date | null> {
  const rows = await getDb()
    .select({ sentAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.organizationId, ctx.organizationId),
        eq(messages.contactId, contactId),
        eq(messages.direction, 'OUTBOUND'),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return rows[0]?.sentAt ?? null;
}

/** True when the exact body was already sent to this contact. */
export async function alreadySent(ctx: Ctx, contactId: string, body: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.organizationId, ctx.organizationId),
        eq(messages.contactId, contactId),
        eq(messages.direction, 'OUTBOUND'),
        eq(messages.body, body),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
