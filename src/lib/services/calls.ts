import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { callAttempts, callQueueItems, callQueues, companies, contacts } from '@/lib/db/schema';
import { invalid, notFound } from '@/lib/core/errors';
import { assertCan } from '@/lib/auth/rbac';
import { getCallProvider } from '@/lib/providers/call';
import type { Ctx } from '@/lib/auth/context';
import type { CallAttempt, CallOutcome } from '@/lib/db/types';
import { recordActivity } from './activity';
import { advanceProspectStatus } from './contacts';
import { createTask } from './tasks';
import { moveDealForContact } from './pipeline';
import { notify } from './notifications';
import { isSuppressed, suppress } from './suppression';

/**
 * Calling.
 *
 * The central rule: with device telephony the app knows the operator pressed
 * the number and nothing else. `INITIATED` is therefore the only outcome the
 * system writes on its own; every other outcome is a human decision, recorded
 * with `connectionReported` false unless a provider genuinely told us.
 */
export type InitiateResult = {
  attemptId: string;
  /** URI for the client to open. Null when a provider dialled server-side. */
  uri: string | null;
  reportsConnection: boolean;
};

export async function initiateCall(
  ctx: Ctx,
  input: { contactId: string; queueId?: string | null; queueItemId?: string | null },
): Promise<InitiateResult> {
  assertCan(ctx.role, 'message:send');
  const db = getDb();

  const rows = await db
    .select({ contact: contacts, company: companies })
    .from(contacts)
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .where(and(eq(contacts.id, input.contactId), eq(contacts.organizationId, ctx.organizationId)))
    .limit(1);

  const row = rows[0];
  if (!row) throw notFound('Prospect');
  const { contact } = row;

  // The same gates as SMS. A number marked wrong is never dialled again.
  if (contact.phoneInvalid) throw invalid('That number was marked as wrong and will not be dialled');
  if (contact.status === 'DO_NOT_CONTACT') throw invalid('This prospect is on the do-not-contact list');
  if (await isSuppressed(ctx, contact.phone)) {
    throw invalid('That number is on the do-not-contact list');
  }

  const provider = getCallProvider();
  const initiation = await provider.initiateCall({ to: contact.phone, contactId: contact.id });
  if (initiation.action === 'open_uri' && !initiation.uri) {
    throw invalid(`"${contact.phone}" cannot be dialled`);
  }

  const [attempt] = await db
    .insert(callAttempts)
    .values({
      organizationId: ctx.organizationId,
      contactId: contact.id,
      companyId: contact.companyId,
      queueId: input.queueId ?? null,
      queueItemId: input.queueItemId ?? null,
      userId: ctx.user?.userId ?? null,
      phoneNumber: contact.phone,
      provider: provider.kind,
      // The only thing that is actually true at this moment.
      outcome: 'INITIATED',
      connectionReported: false,
      externalCallId: initiation.externalCallId,
    })
    .returning();

  await db
    .update(contacts)
    .set({
      callAttemptCount: sql`${contacts.callAttemptCount} + 1`,
      lastCallAt: new Date(),
      lastCallOutcome: 'INITIATED',
      callReadiness: 'CALLED',
      updatedAt: new Date(),
    })
    .where(eq(contacts.id, contact.id));

  await recordActivity(ctx, {
    type: 'call_initiated',
    title: `Call started to ${contact.phone}`,
    contactId: contact.id,
    metadata: {
      attemptId: attempt!.id,
      provider: provider.kind,
      queueId: input.queueId ?? null,
      // Recorded explicitly so nothing downstream has to infer it.
      connectionObservable: initiation.reportsConnection,
    },
  });

  return {
    attemptId: attempt!.id,
    uri: initiation.uri,
    reportsConnection: initiation.reportsConnection,
  };
}

export type DispositionInput = {
  attemptId?: string | null;
  contactId: string;
  outcome: CallOutcome;
  note?: string | null;
  notInterestedReason?: string | null;
  /** For CALLBACK. */
  callbackAt?: Date | null;
  queueItemId?: string | null;
  /** For BOOKED, when the operator already has a time. */
  appointmentAt?: Date | null;
};

export type DispositionResult = {
  attemptId: string;
  outcome: CallOutcome;
  /** Whether the queue moved on. */
  advanced: boolean;
};

/**
 * Records what the human says happened, and does everything that follows in one
 * step: the activity, the prospect state, the pipeline, the follow-up task and
 * the queue.
 *
 * One click, not five screens.
 */
export async function recordDisposition(ctx: Ctx, input: DispositionInput): Promise<DispositionResult> {
  assertCan(ctx.role, 'message:send');
  const db = getDb();

  const contactRows = await db
    .select({ contact: contacts, company: companies })
    .from(contacts)
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .where(and(eq(contacts.id, input.contactId), eq(contacts.organizationId, ctx.organizationId)))
    .limit(1);

  const row = contactRows[0];
  if (!row) throw notFound('Prospect');
  const { contact, company } = row;
  const personName = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim();
  const name = company?.name ?? (personName || contact.phone);

  // Attach to the open attempt, or create one for a call placed outside a queue.
  let attemptId = input.attemptId ?? null;
  if (!attemptId) {
    const [created] = await db
      .insert(callAttempts)
      .values({
        organizationId: ctx.organizationId,
        contactId: contact.id,
        companyId: contact.companyId,
        userId: ctx.user?.userId ?? null,
        phoneNumber: contact.phone,
        provider: getCallProvider().kind,
        outcome: 'INITIATED',
      })
      .returning();
    attemptId = created!.id;
  }

  await db
    .update(callAttempts)
    .set({
      outcome: input.outcome,
      note: input.note ?? null,
      notInterestedReason: input.notInterestedReason ?? null,
      dispositionedAt: new Date(),
      endedAt: new Date(),
      // A human marking "connected" is a report, not an observation. Only a
      // provider that emits call progress may set this true.
      connectionReported: false,
    })
    .where(and(eq(callAttempts.id, attemptId), eq(callAttempts.organizationId, ctx.organizationId)));

  const patch: Record<string, unknown> = {
    lastCallOutcome: input.outcome,
    lastCallAt: new Date(),
    updatedAt: new Date(),
  };

  switch (input.outcome) {
    case 'BOOKED': {
      patch.callReadiness = 'COMPLETED';
      patch.nextCallbackAt = null;
      await advanceProspectStatus(ctx, contact.id, 'APPOINTMENT');
      await moveDealForContact(ctx, contact.id, 'APPOINTMENT', {});
      await notify(ctx, {
        type: 'appointment_booked',
        title: `${name} booked on a call`,
        body: input.note ?? null,
        link: `/prospects/${contact.id}`,
      });
      break;
    }

    case 'CALLBACK': {
      if (!input.callbackAt) throw invalid('Pick a date and time for the callback');
      patch.callReadiness = 'CALLBACK';
      patch.nextCallbackAt = input.callbackAt;
      patch.nextActionAt = input.callbackAt;
      patch.nextAction = 'Callback';

      await createTask(ctx, {
        title: `Call back ${name}`,
        kind: 'call',
        notes: input.note ?? null,
        contactId: contact.id,
        dueAt: input.callbackAt,
        priority: 1,
      });
      await recordActivity(ctx, {
        type: 'callback_scheduled',
        title: `Callback scheduled for ${input.callbackAt.toLocaleString('en-CA')}`,
        contactId: contact.id,
        metadata: { attemptId, callbackAt: input.callbackAt.toISOString() },
      });
      break;
    }

    case 'NO_ANSWER':
    case 'VOICEMAIL':
    case 'BUSY': {
      patch.noAnswerCount = sql`${contacts.noAnswerCount} + 1`;
      // Back to READY so it can be picked up by a later queue, rather than
      // silently dropping out of the funnel.
      patch.callReadiness = 'READY';
      break;
    }

    case 'NOT_INTERESTED':
    case 'CONNECTED_NO_INTEREST': {
      patch.callReadiness = 'COMPLETED';
      patch.nextActionAt = null;
      patch.nextAction = null;
      await advanceProspectStatus(ctx, contact.id, 'LOST');
      break;
    }

    case 'WRONG_NUMBER':
    case 'BAD_NUMBER': {
      // The number is bad, but the business is not. The company record stays;
      // only this number is retired.
      patch.phoneInvalid = true;
      patch.phoneValidated = false;
      patch.phoneConfidence = 0;
      patch.callReadiness = 'COMPLETED';

      await suppress(ctx, {
        phone: contact.phone,
        reason: 'INVALID_NUMBER',
        note: `Marked wrong number on a call${input.note ? `: ${input.note}` : ''}`,
        contactId: contact.id,
      });
      break;
    }

    case 'QUALIFIED': {
      patch.callReadiness = 'COMPLETED';
      await advanceProspectStatus(ctx, contact.id, 'QUALIFIED');
      await moveDealForContact(ctx, contact.id, 'QUALIFIED', {});
      break;
    }

    default:
      patch.callReadiness = 'READY';
      break;
  }

  // The patch never touches `status`: that is owned by advanceProspectStatus and
  // by suppression, so applying it here cannot undo the DO_NOT_CONTACT that a
  // wrong number just set.
  await db
    .update(contacts)
    .set(patch)
    .where(and(eq(contacts.id, contact.id), eq(contacts.organizationId, ctx.organizationId)));

  await recordActivity(ctx, {
    type: 'call_outcome',
    title: `Call outcome: ${input.outcome.toLowerCase().replace(/_/g, ' ')}`,
    body: input.note ?? null,
    contactId: contact.id,
    metadata: {
      attemptId,
      outcome: input.outcome,
      reason: input.notInterestedReason ?? null,
      // Explicit, so analytics never mistakes a human's word for telemetry.
      connectionReported: false,
    },
  });

  let advanced = false;
  if (input.queueItemId) {
    const updated = await db
      .update(callQueueItems)
      .set({ status: 'COMPLETED', outcome: input.outcome, completedAt: new Date() })
      .where(
        and(
          eq(callQueueItems.id, input.queueItemId),
          eq(callQueueItems.organizationId, ctx.organizationId),
        ),
      )
      .returning({ queueId: callQueueItems.queueId });

    if (updated[0]) {
      advanced = true;
      await db
        .update(callQueues)
        .set({ completedCount: sql`${callQueues.completedCount} + 1`, updatedAt: new Date() })
        .where(eq(callQueues.id, updated[0].queueId));
    }
  }

  return { attemptId, outcome: input.outcome, advanced };
}

export async function addCallNote(ctx: Ctx, attemptId: string, note: string): Promise<void> {
  assertCan(ctx.role, 'conversation:write');
  const db = getDb();

  const rows = await db
    .update(callAttempts)
    .set({ note })
    .where(and(eq(callAttempts.id, attemptId), eq(callAttempts.organizationId, ctx.organizationId)))
    .returning({ contactId: callAttempts.contactId });

  if (rows[0]) {
    await recordActivity(ctx, {
      type: 'call_note',
      title: 'Call note added',
      body: note,
      contactId: rows[0].contactId,
      metadata: { attemptId },
    });
  }
}

export async function listCallHistory(ctx: Ctx, contactId: string, limit = 50): Promise<CallAttempt[]> {
  return getDb()
    .select()
    .from(callAttempts)
    .where(
      and(eq(callAttempts.organizationId, ctx.organizationId), eq(callAttempts.contactId, contactId)),
    )
    .orderBy(desc(callAttempts.startedAt))
    .limit(limit);
}

/**
 * Call metrics.
 *
 * `connectRateObservable` is false whenever any call in the window came from a
 * provider that cannot report connection, so the UI can say "operator-reported"
 * instead of publishing a number the system never measured.
 */
export async function callMetrics(ctx: Ctx, since: Date) {
  const rows = await getDb()
    .select({
      attempted: sql<number>`count(*)::int`,
      booked: sql<number>`count(*) filter (where ${callAttempts.outcome} = 'BOOKED')::int`,
      noAnswer: sql<number>`count(*) filter (where ${callAttempts.outcome} in ('NO_ANSWER','VOICEMAIL','BUSY'))::int`,
      callback: sql<number>`count(*) filter (where ${callAttempts.outcome} = 'CALLBACK')::int`,
      notInterested: sql<number>`count(*) filter (where ${callAttempts.outcome} in ('NOT_INTERESTED','CONNECTED_NO_INTEREST'))::int`,
      wrongNumber: sql<number>`count(*) filter (where ${callAttempts.outcome} in ('WRONG_NUMBER','BAD_NUMBER'))::int`,
      qualified: sql<number>`count(*) filter (where ${callAttempts.outcome} = 'QUALIFIED')::int`,
      /** Only calls a provider actually reported as connected. */
      reportedConnected: sql<number>`count(*) filter (where ${callAttempts.connectionReported} = true)::int`,
      dispositioned: sql<number>`count(*) filter (where ${callAttempts.outcome} <> 'INITIATED')::int`,
    })
    .from(callAttempts)
    .where(and(eq(callAttempts.organizationId, ctx.organizationId), gte(callAttempts.startedAt, since)));

  const m = rows[0] ?? {
    attempted: 0, booked: 0, noAnswer: 0, callback: 0, notInterested: 0,
    wrongNumber: 0, qualified: 0, reportedConnected: 0, dispositioned: 0,
  };

  const rate = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

  return {
    ...m,
    bookedRate: rate(m.booked, m.attempted),
    bookingsPer100Calls: m.attempted > 0 ? Math.round((m.booked / m.attempted) * 100) : 0,
    /**
     * Which outcomes a person marked as reaching someone. Not a measured
     * connect rate — device telephony emits no such telemetry.
     */
    operatorReportedContactRate: rate(
      m.booked + m.callback + m.notInterested + m.qualified,
      m.dispositioned,
    ),
    connectRateObservable: m.attempted > 0 && m.reportedConnected > 0,
  };
}
