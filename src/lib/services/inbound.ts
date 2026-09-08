import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import {
  campaignMemberships,
  contacts,
  conversations,
  messages,
  organizations,
  phoneNumbers,
} from '@/lib/db/schema';
import { classifyInbound, detectHandoffSignal, isOptOut } from '@/lib/core/intent';
import { normalizePhone } from '@/lib/core/phone';
import { logger } from '@/lib/core/logger';
import { systemCtx, type Ctx } from '@/lib/auth/context';
import type { InboundMessage } from '@/lib/providers/sms';
import { recordActivity } from './activity';
import { advanceProspectStatus } from './contacts';
import { getOrCreateConversation, triggerHandoff } from './conversations';
import { recordProviderEvent } from './messages';
import { notify } from './notifications';
import { cancelJobsForConversation } from './queue';
import { getOrgConfig } from './settings';
import { suppress } from './suppression';

export type InboundOutcome = {
  handled: boolean;
  duplicate: boolean;
  conversationId?: string;
  messageId?: string;
  intent?: string;
  optOut?: boolean;
  aiQueued?: boolean;
};

/**
 * Resolves which organization owns an inbound message from the number it was
 * sent to. Never trust an organization id supplied in a webhook body.
 */
export async function resolveOrganizationForNumber(to: string): Promise<string | null> {
  const normalized = normalizePhone(to).e164 ?? to;

  const owned = await getDb()
    .select({ organizationId: phoneNumbers.organizationId })
    .from(phoneNumbers)
    .where(eq(phoneNumbers.number, normalized))
    .limit(1);
  if (owned[0]) return owned[0].organizationId;

  // Single-tenant deployments (the initial On Radar case) have exactly one org
  // and often no phone_numbers row yet; routing to it is unambiguous.
  const orgs = await getDb().select({ id: organizations.id }).from(organizations).limit(2);
  if (orgs.length === 1) return orgs[0]!.id;

  return null;
}

/**
 * Processes one inbound SMS end to end: dedupe, contact resolution, message
 * write, deterministic classification, stop-condition handling, and scheduling
 * the AI to respond.
 *
 * Opt-out is handled here, before any AI involvement, so a STOP always
 * registers even if the model provider is down.
 */
export async function handleInboundMessage(
  organizationId: string,
  inbound: InboundMessage,
  providerKind: 'twilio' | 'telnyx' | 'mock',
): Promise<InboundOutcome> {
  const db = getDb();
  const log = logger.child({ organizationId, provider: providerKind });

  const fresh = await recordProviderEvent(organizationId, {
    kind: 'inbound',
    dedupeKey: inbound.dedupeKey,
    providerKind,
    providerMessageId: inbound.providerMessageId,
    payload: inbound.raw,
  });
  if (!fresh) {
    log.info('inbound duplicate ignored', { result: 'duplicate' });
    return { handled: true, duplicate: true };
  }

  const orgRows = await db
    .select({ timezone: organizations.timezone })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  const ctx = systemCtx(organizationId, orgRows[0]?.timezone ?? 'America/Toronto');

  const normalized = normalizePhone(inbound.from);
  const phone = normalized.e164 ?? inbound.from;

  const contact = await findOrCreateInboundContact(ctx, phone, inbound.from);
  const conversation = await getOrCreateConversation(ctx, contact.id);

  const classification = classifyInbound(inbound.body);

  const [message] = await db
    .insert(messages)
    .values({
      organizationId,
      conversationId: conversation.id,
      contactId: contact.id,
      direction: 'INBOUND',
      author: 'PROSPECT',
      status: 'RECEIVED',
      body: inbound.body,
      fromNumber: phone,
      toNumber: inbound.to,
      campaignId: conversation.campaignId,
      providerKind,
      providerMessageId: inbound.providerMessageId,
    })
    .returning();

  await db
    .update(conversations)
    .set({
      lastMessageAt: inbound.receivedAt,
      lastInboundAt: inbound.receivedAt,
      unreadCount: sql`${conversations.unreadCount} + 1`,
      intent: classification.intent,
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, conversation.id));

  await recordActivity(ctx, {
    type: 'inbound_received',
    title: 'Inbound reply received',
    body: inbound.body,
    contactId: contact.id,
    conversationId: conversation.id,
    campaignId: conversation.campaignId,
    metadata: { intent: classification.intent, messageId: message!.id },
  });

  await advanceProspectStatus(ctx, contact.id, 'REPLIED');

  // A reply always halts the sequence — no prospect gets step 3 after they
  // have answered step 2.
  const cancelled = await cancelJobsForConversation(conversation.id, 'prospect replied');

  // Opt-out is handled before the generic "replied" stop so the membership ends
  // as STOPPED with the suppression reason, not as a completed sequence.
  if (isOptOut(inbound.body)) {
    await suppress(ctx, {
      phone,
      reason: 'OPT_OUT',
      note: `Replied "${inbound.body.slice(0, 100)}"`,
      contactId: contact.id,
    });
    log.info('inbound opt-out processed', { result: 'opt_out', conversationId: conversation.id });
    return {
      handled: true,
      duplicate: false,
      conversationId: conversation.id,
      messageId: message!.id,
      intent: 'opt_out',
      optOut: true,
    };
  }

  await stopSequenceMemberships(ctx, contact.id, 'replied');

  if (classification.intent === 'wrong_number') {
    await suppress(ctx, {
      phone,
      reason: 'INVALID_NUMBER',
      note: 'Prospect reported a wrong number',
      contactId: contact.id,
    });
    return {
      handled: true,
      duplicate: false,
      conversationId: conversation.id,
      messageId: message!.id,
      intent: 'wrong_number',
    };
  }

  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || phone;
  if (classification.intent === 'positive') {
    await db
      .update(conversations)
      .set({ leadTemperature: 'warm' })
      .where(eq(conversations.id, conversation.id));
    await notify(ctx, {
      type: 'positive_reply',
      title: `${name} replied positively`,
      body: inbound.body.slice(0, 160),
      link: `/inbox/${conversation.id}`,
    });
  }

  const handoffSignal = detectHandoffSignal(inbound.body);
  if (handoffSignal) {
    await triggerHandoff(ctx, conversation.id, handoffSignal);
    return {
      handled: true,
      duplicate: false,
      conversationId: conversation.id,
      messageId: message!.id,
      intent: classification.intent,
    };
  }

  // Hand the conversation to the AI by marking it due. The worker picks it up;
  // the webhook stays fast and never blocks on a model call.
  const config = await getOrgConfig(ctx);
  const aiQueued = config.ai.enabled && config.ai.autoReply && conversation.aiEnabled;
  if (aiQueued) {
    await db
      .update(conversations)
      .set({ nextFollowUpAt: new Date() })
      .where(eq(conversations.id, conversation.id));
  }

  log.info('inbound processed', {
    conversationId: conversation.id,
    result: classification.intent,
    cancelledJobs: cancelled,
  });

  return {
    handled: true,
    duplicate: false,
    conversationId: conversation.id,
    messageId: message!.id,
    intent: classification.intent,
    aiQueued,
  };
}

async function findOrCreateInboundContact(ctx: Ctx, phone: string, raw: string) {
  const db = getDb();
  const existing = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.organizationId, ctx.organizationId), eq(contacts.phone, phone)))
    .limit(1);
  if (existing[0]) return existing[0];

  // An inbound from an unknown number is still a lead; capture it rather than
  // dropping the message.
  const [created] = await db
    .insert(contacts)
    .values({
      organizationId: ctx.organizationId,
      phone,
      phoneRaw: raw,
      status: 'REPLIED',
      source: 'inbound_sms',
      lastActivityAt: new Date(),
    })
    .onConflictDoNothing()
    .returning();

  if (created) {
    await recordActivity(ctx, {
      type: 'prospect_created',
      title: 'Prospect created from an inbound message',
      contactId: created.id,
      metadata: { phone },
    });
    return created;
  }

  const [row] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.organizationId, ctx.organizationId), eq(contacts.phone, phone)))
    .limit(1);
  return row!;
}

async function stopSequenceMemberships(ctx: Ctx, contactId: string, reason: string): Promise<void> {
  await getDb()
    .update(campaignMemberships)
    .set({ status: 'COMPLETED', nextStepAt: null, stoppedReason: reason, completedAt: new Date() })
    .where(
      and(
        eq(campaignMemberships.organizationId, ctx.organizationId),
        eq(campaignMemberships.contactId, contactId),
        sql`${campaignMemberships.status} in ('PENDING','ACTIVE')`,
      ),
    );
}
