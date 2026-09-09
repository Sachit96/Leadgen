import { and, asc, eq, gte, isNotNull, lte, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import {
  campaignMemberships,
  campaignSteps,
  campaignVariants,
  campaigns,
  contacts,
  conversations,
  messages,
  organizations,
} from '@/lib/db/schema';
import { render } from '@/lib/core/template';
import { logger } from '@/lib/core/logger';
import { withinSendingWindow } from '@/lib/core/time';
import { generateOutreachMessage } from '@/lib/agents/outreach';
import { systemCtx, type Ctx } from '@/lib/auth/context';
import { recordActivity } from './activity';
import { pickVariant } from './campaigns';
import { getOrCreateConversation } from './conversations';
import { queueOutbound, sequenceIdempotencyKey } from './messages';
import { buildPersonalizationContext } from './personalization';
import { getOrgConfig } from './settings';
import { isSuppressed } from './suppression';
import type { CampaignStep } from '@/lib/db/types';

export type DueMembership = {
  membershipId: string;
  organizationId: string;
  campaignId: string;
  contactId: string;
  currentStepPosition: number;
  timezone: string;
  orgTimezone: string;
  campaignName: string;
  dailyCapacity: number;
  windowStart: string;
  windowEnd: string;
  sendingDays: number[];
  fromPhoneNumberId: string | null;
};

/** Members of an ACTIVE campaign whose next step is due. */
export async function dueMemberships(limit = 100): Promise<DueMembership[]> {
  const rows = await getDb()
    .select({
      membershipId: campaignMemberships.id,
      organizationId: campaignMemberships.organizationId,
      campaignId: campaignMemberships.campaignId,
      contactId: campaignMemberships.contactId,
      currentStepPosition: campaignMemberships.currentStepPosition,
      timezone: campaigns.timezone,
      orgTimezone: organizations.timezone,
      campaignName: campaigns.name,
      dailyCapacity: campaigns.dailyCapacity,
      windowStart: campaigns.sendingWindowStart,
      windowEnd: campaigns.sendingWindowEnd,
      sendingDays: campaigns.sendingDays,
      fromPhoneNumberId: campaigns.fromPhoneNumberId,
    })
    .from(campaignMemberships)
    .innerJoin(campaigns, eq(campaigns.id, campaignMemberships.campaignId))
    .innerJoin(organizations, eq(organizations.id, campaignMemberships.organizationId))
    .where(
      and(
        eq(campaignMemberships.status, 'ACTIVE'),
        eq(campaigns.status, 'ACTIVE'),
        isNotNull(campaignMemberships.nextStepAt),
        lte(campaignMemberships.nextStepAt, new Date()),
      ),
    )
    .orderBy(asc(campaignMemberships.nextStepAt))
    .limit(limit);

  return rows.map((r) => ({
    ...r,
    sendingDays: Array.isArray(r.sendingDays) ? (r.sendingDays as number[]) : [1, 2, 3, 4, 5],
  }));
}

export type SequenceOutcome =
  | { result: 'queued'; messageId: string; stepName: string }
  | { result: 'completed'; reason: string }
  | { result: 'stopped'; reason: string }
  | { result: 'deferred'; reason: string }
  | { result: 'paused'; reason: string };

/**
 * Advances one prospect through one sequence step.
 *
 * Conditions are evaluated against live conversation state, not against what
 * was true when the prospect was enrolled — someone who replied between steps
 * is completed, not messaged again.
 */
export async function processMembership(membership: DueMembership): Promise<SequenceOutcome> {
  const ctx = systemCtx(membership.organizationId, membership.orgTimezone);
  const db = getDb();
  const log = logger.child({
    organizationId: membership.organizationId,
    campaignId: membership.campaignId,
  });

  const contactRows = await db
    .select()
    .from(contacts)
    .where(eq(contacts.id, membership.contactId))
    .limit(1);
  const contact = contactRows[0];
  if (!contact) return stop(membership.membershipId, 'contact no longer exists');

  if (contact.status === 'DO_NOT_CONTACT' || (await isSuppressed(ctx, contact.phone))) {
    return stop(membership.membershipId, 'prospect is on the do-not-contact list');
  }

  const steps = await db
    .select()
    .from(campaignSteps)
    .where(
      and(eq(campaignSteps.campaignId, membership.campaignId), eq(campaignSteps.active, true)),
    )
    .orderBy(asc(campaignSteps.position));

  const step = steps.find((s) => s.position > membership.currentStepPosition);
  if (!step) return complete(membership.membershipId, 'sequence finished');

  // Campaign-local sending window. Outside it, wait rather than sending late.
  const timezone = contact.timezone ?? membership.timezone;
  if (
    !withinSendingWindow(
      new Date(),
      timezone,
      membership.windowStart,
      membership.windowEnd,
      membership.sendingDays,
    )
  ) {
    await db
      .update(campaignMemberships)
      .set({ nextStepAt: new Date(Date.now() + 30 * 60_000) })
      .where(eq(campaignMemberships.id, membership.membershipId));
    return { result: 'deferred', reason: 'outside the campaign sending window' };
  }

  if (await campaignAtCapacity(membership.campaignId, membership.dailyCapacity)) {
    const tomorrow = new Date();
    tomorrow.setHours(24, 0, 0, 0);
    await db
      .update(campaignMemberships)
      .set({ nextStepAt: tomorrow })
      .where(eq(campaignMemberships.id, membership.membershipId));
    return { result: 'deferred', reason: 'campaign daily capacity reached' };
  }

  const conversation = await getOrCreateConversation(ctx, contact.id, {
    campaignId: membership.campaignId,
    phoneNumberId: membership.fromPhoneNumberId,
  });

  const stopReason = await evaluateStopConditions(step, conversation.id, conversation.state);
  if (stopReason) return complete(membership.membershipId, stopReason);

  const skipReason = await evaluateConditions(step, conversation.id, conversation.state);
  if (skipReason) {
    // Conditions not met is not an error: move past this step and try the next.
    await db
      .update(campaignMemberships)
      .set({ currentStepPosition: step.position, nextStepAt: new Date() })
      .where(eq(campaignMemberships.id, membership.membershipId));
    return { result: 'deferred', reason: skipReason };
  }

  const built = await buildStepMessage(ctx, membership, step, contact.id);
  if (!built.ok) {
    await db
      .update(campaignMemberships)
      .set({ status: 'PAUSED', nextStepAt: null, stoppedReason: built.reason })
      .where(eq(campaignMemberships.id, membership.membershipId));

    await recordActivity(ctx, {
      type: 'note',
      title: 'Sequence paused for this prospect',
      body: built.reason,
      contactId: contact.id,
      conversationId: conversation.id,
      campaignId: membership.campaignId,
    });

    log.warn('sequence step could not be personalized', { result: 'paused' });
    return { result: 'paused', reason: built.reason };
  }

  const config = await getOrgConfig(ctx);
  const isFirstStep = step.position === steps[0]?.position;
  const body =
    isFirstStep && config.sending.includeOptOutFooter
      ? `${built.body} ${config.sending.optOutFooter}`.trim()
      : built.body;

  const message = await queueOutbound(ctx, {
    conversationId: conversation.id,
    body,
    author: 'SYSTEM',
    idempotencyKey: sequenceIdempotencyKey(conversation.id, step.id),
    campaignId: membership.campaignId,
    stepId: step.id,
    variantId: built.variantId,
    promptVersion: built.promptVersion,
  });

  const nextStep = steps.find((s) => s.position > step.position);
  await db
    .update(campaignMemberships)
    .set({
      currentStepPosition: step.position,
      nextStepAt: nextStep ? new Date(Date.now() + nextStep.delayHours * 60 * 60_000) : null,
      status: nextStep ? 'ACTIVE' : 'COMPLETED',
      completedAt: nextStep ? null : new Date(),
    })
    .where(eq(campaignMemberships.id, membership.membershipId));

  return { result: 'queued', messageId: message.id, stepName: step.name };
}

type BuiltMessage =
  | { ok: true; body: string; variantId: string | null; promptVersion: string | null }
  | { ok: false; reason: string };

async function buildStepMessage(
  ctx: Ctx,
  membership: DueMembership,
  step: CampaignStep,
  contactId: string,
): Promise<BuiltMessage> {
  if (step.useAi) {
    const generated = await generateOutreachMessage(ctx, contactId, {
      angle: membership.campaignName,
    });
    if (generated.result === 'failed') return { ok: false, reason: generated.error };
    return { ok: true, body: generated.message, variantId: null, promptVersion: generated.promptVersion };
  }

  const variants = await getDb()
    .select()
    .from(campaignVariants)
    .where(and(eq(campaignVariants.stepId, step.id), eq(campaignVariants.active, true)));

  // Seeded on contact + step so a prospect always lands in the same experiment
  // arm for a given step, however many times this runs.
  const variant = pickVariant(variants, `${contactId}:${step.id}`);
  if (!variant) return { ok: false, reason: `Step "${step.name}" has no active message variant` };

  const personalization = await buildPersonalizationContext(ctx, contactId);
  const rendered = render(variant.template, personalization.vars);

  if (rendered.missing.length > 0) {
    return {
      ok: false,
      reason: `Missing data for ${rendered.missing.map((v) => `{{${v}}}`).join(', ')} — research this prospect or edit the template`,
    };
  }

  return { ok: true, body: rendered.text, variantId: variant.id, promptVersion: null };
}

/**
 * Counts messages already queued or sent for this campaign today.
 *
 * Unlike the org-level cap, this one counts queued rows deliberately: the
 * sequence runner would otherwise enqueue the whole audience in one pass before
 * a single message had been sent, and the cap would never bite.
 */
async function campaignAtCapacity(campaignId: string, dailyCapacity: number): Promise<boolean> {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const rows = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        eq(messages.campaignId, campaignId),
        eq(messages.direction, 'OUTBOUND'),
        gte(messages.createdAt, midnight),
      ),
    );
  return (rows[0]?.count ?? 0) >= dailyCapacity;
}

/** Conditions that end the sequence for this prospect. */
async function evaluateStopConditions(
  step: CampaignStep,
  conversationId: string,
  state: string,
): Promise<string | null> {
  const conditions = Array.isArray(step.stopConditions) ? (step.stopConditions as string[]) : [];
  const facts = await conversationFacts(conversationId, state);

  for (const condition of conditions) {
    switch (condition) {
      case 'replied':
        if (facts.replied) return 'prospect replied';
        break;
      case 'positive':
        if (facts.positive) return 'prospect replied positively';
        break;
      case 'negative':
        if (facts.negative) return 'prospect declined';
        break;
      case 'appointment_booked':
      case 'booked':
        if (facts.booked) return 'appointment booked';
        break;
      case 'human_takeover':
        if (facts.humanTakeover) return 'a human took over';
        break;
      case 'failed_delivery':
        if (facts.allFailed) return 'messages are not being delivered';
        break;
      default:
        break;
    }
  }
  return null;
}

/** Conditions that must hold for the step to fire. */
async function evaluateConditions(
  step: CampaignStep,
  conversationId: string,
  state: string,
): Promise<string | null> {
  const conditions = Array.isArray(step.conditions) ? (step.conditions as string[]) : [];
  if (conditions.length === 0) return null;
  const facts = await conversationFacts(conversationId, state);

  for (const condition of conditions) {
    switch (condition) {
      case 'no_response':
        if (facts.replied) return 'prospect has already replied';
        break;
      case 'replied':
        if (!facts.replied) return 'prospect has not replied yet';
        break;
      case 'positive':
        if (!facts.positive) return 'no positive reply yet';
        break;
      case 'negative':
        if (!facts.negative) return 'no negative reply';
        break;
      case 'not_booked':
        if (facts.booked) return 'appointment already booked';
        break;
      default:
        break;
    }
  }
  return null;
}

type ConversationFacts = {
  replied: boolean;
  positive: boolean;
  negative: boolean;
  booked: boolean;
  humanTakeover: boolean;
  allFailed: boolean;
};

async function conversationFacts(conversationId: string, state: string): Promise<ConversationFacts> {
  const db = getDb();
  const rows = await db
    .select({
      inbound: sql<number>`count(*) filter (where ${messages.direction} = 'INBOUND')::int`,
      outbound: sql<number>`count(*) filter (where ${messages.direction} = 'OUTBOUND')::int`,
      failed: sql<number>`count(*) filter (where ${messages.status} in ('FAILED','UNDELIVERED'))::int`,
    })
    .from(messages)
    .where(eq(messages.conversationId, conversationId));

  const counts = rows[0] ?? { inbound: 0, outbound: 0, failed: 0 };
  const conversationRows = await db
    .select({ intent: conversations.intent, requiresHuman: conversations.requiresHuman })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);

  const intent = conversationRows[0]?.intent ?? 'unknown';

  return {
    replied: counts.inbound > 0,
    positive: intent === 'positive',
    negative: intent === 'negative' || state === 'NOT_INTERESTED',
    booked: state === 'BOOKED' || state === 'APPOINTMENT',
    humanTakeover: conversationRows[0]?.requiresHuman === true || state === 'HUMAN_HANDOFF',
    allFailed: counts.outbound > 0 && counts.failed >= counts.outbound,
  };
}

async function stop(membershipId: string, reason: string): Promise<SequenceOutcome> {
  await getDb()
    .update(campaignMemberships)
    .set({ status: 'STOPPED', nextStepAt: null, stoppedReason: reason })
    .where(eq(campaignMemberships.id, membershipId));
  return { result: 'stopped', reason };
}

async function complete(membershipId: string, reason: string): Promise<SequenceOutcome> {
  await getDb()
    .update(campaignMemberships)
    .set({ status: 'COMPLETED', nextStepAt: null, stoppedReason: reason, completedAt: new Date() })
    .where(eq(campaignMemberships.id, membershipId));
  return { result: 'completed', reason };
}
