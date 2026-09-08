import { and, asc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { appointments, contacts, conversations, organizations } from '@/lib/db/schema';
import { invalid, notFound } from '@/lib/core/errors';
import { localParts, parseClock } from '@/lib/core/time';
import { logger } from '@/lib/core/logger';
import { assertCan } from '@/lib/auth/rbac';
import { getCalendarProvider } from '@/lib/providers/calendar';
import { systemCtx, type Ctx } from '@/lib/auth/context';
import { recordActivity } from './activity';
import { advanceProspectStatus } from './contacts';
import { setConversationState } from './conversations';
import { notify } from './notifications';
import { queueOutbound } from './messages';
import { moveDealForContact } from './pipeline';
import type { Appointment, AppointmentStatus } from '@/lib/db/types';

export type AvailabilitySlot = { startsAt: Date; endsAt: Date; label: string };

/**
 * Proposes bookable slots.
 *
 * Free/busy comes from the calendar provider when one is connected, and always
 * from our own appointments table, so double-booking is impossible even in
 * internal-calendar mode.
 */
export async function availability(
  ctx: Ctx,
  options: {
    from?: Date;
    days?: number;
    durationMinutes?: number;
    workdayStart?: string;
    workdayEnd?: string;
    timezone?: string;
    limit?: number;
  } = {},
): Promise<AvailabilitySlot[]> {
  const from = options.from ?? new Date();
  const days = options.days ?? 5;
  const duration = options.durationMinutes ?? 15;
  const timezone = options.timezone ?? ctx.timezone;
  const start = parseClock(options.workdayStart ?? '09:00');
  const end = parseClock(options.workdayEnd ?? '17:00');
  const to = new Date(from.getTime() + days * 24 * 60 * 60_000);

  const existing = await getDb()
    .select({ startsAt: appointments.startsAt, endsAt: appointments.endsAt })
    .from(appointments)
    .where(
      and(
        eq(appointments.organizationId, ctx.organizationId),
        gte(appointments.startsAt, from),
        lte(appointments.startsAt, to),
        sql`${appointments.status} in ('SCHEDULED','RESCHEDULED')`,
      ),
    );

  const external = await getCalendarProvider()
    .busy(from, to)
    .catch(() => []);

  const busy = [
    ...existing.map((a) => ({ start: a.startsAt, end: a.endsAt })),
    ...external,
  ];

  const slots: AvailabilitySlot[] = [];
  const step = 30 * 60_000;
  // Round up to the next half hour, and never propose a slot inside the next
  // 30 minutes — a prospect cannot realistically make that.
  let cursor = new Date(Math.ceil((from.getTime() + step) / step) * step);

  while (cursor < to && slots.length < (options.limit ?? 12)) {
    const local = localParts(cursor, timezone);
    const minutes = local.hour * 60 + local.minute;
    const withinDay =
      minutes >= start.hour * 60 + start.minute && minutes + duration <= end.hour * 60 + end.minute;
    const weekday = local.weekday >= 1 && local.weekday <= 5;
    const slotEnd = new Date(cursor.getTime() + duration * 60_000);
    const free = !busy.some((b) => cursor < b.end && slotEnd > b.start);

    if (withinDay && weekday && free) {
      slots.push({
        startsAt: new Date(cursor),
        endsAt: slotEnd,
        label: formatSlot(cursor, timezone),
      });
    }
    cursor = new Date(cursor.getTime() + step);
  }

  return slots;
}

export function formatSlot(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

export type BookAppointmentInput = {
  contactId: string;
  conversationId?: string | null;
  startsAt: Date;
  durationMinutes?: number;
  title?: string;
  notes?: string | null;
  assignedUserId?: string | null;
  timezone?: string;
  /** Sends an SMS confirmation to the prospect. */
  confirmBySms?: boolean;
};

export async function bookAppointment(
  ctx: Ctx,
  input: BookAppointmentInput,
): Promise<Appointment> {
  assertCan(ctx.role, 'appointment:write');
  if (input.startsAt.getTime() < Date.now() - 60_000) {
    throw invalid('Appointment start time is in the past');
  }

  const db = getDb();
  const contactRows = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, input.contactId), eq(contacts.organizationId, ctx.organizationId)))
    .limit(1);
  const contact = contactRows[0];
  if (!contact) throw notFound('Prospect');

  const duration = input.durationMinutes ?? 15;
  const endsAt = new Date(input.startsAt.getTime() + duration * 60_000);
  const timezone = input.timezone ?? contact.timezone ?? ctx.timezone;

  const clash = await db
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        eq(appointments.organizationId, ctx.organizationId),
        sql`${appointments.status} in ('SCHEDULED','RESCHEDULED')`,
        sql`${appointments.startsAt} < ${endsAt} and ${appointments.endsAt} > ${input.startsAt}`,
      ),
    )
    .limit(1);
  if (clash.length > 0) throw invalid('That time is already booked');

  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.phone;
  const title = input.title ?? `Call with ${name}`;

  let externalEventId: string | null = null;
  let calendarProvider: string | null = null;
  try {
    const event = await getCalendarProvider().createEvent({
      title,
      description: input.notes ?? undefined,
      startsAt: input.startsAt,
      endsAt,
      timezone,
      attendeeEmail: contact.email,
    });
    if (event) {
      externalEventId = event.externalEventId;
      calendarProvider = getCalendarProvider().kind;
    }
  } catch (error) {
    // A calendar outage must not lose the booking; the appointment is ours.
    logger.warn('calendar event creation failed', {
      organizationId: ctx.organizationId,
      errorCode: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
    });
  }

  const [appointment] = await db
    .insert(appointments)
    .values({
      organizationId: ctx.organizationId,
      contactId: contact.id,
      conversationId: input.conversationId ?? null,
      assignedUserId: input.assignedUserId ?? ctx.user?.userId ?? null,
      title,
      startsAt: input.startsAt,
      endsAt,
      timezone,
      notes: input.notes ?? null,
      calendarProvider,
      externalEventId,
    })
    .returning();

  await recordActivity(ctx, {
    type: 'appointment_created',
    title: `Appointment booked for ${formatSlot(input.startsAt, timezone)}`,
    contactId: contact.id,
    conversationId: input.conversationId ?? null,
    metadata: { appointmentId: appointment!.id, startsAt: input.startsAt.toISOString() },
  });

  await advanceProspectStatus(ctx, contact.id, 'APPOINTMENT');
  await moveDealForContact(ctx, contact.id, 'APPOINTMENT', { appointmentId: appointment!.id });

  if (input.conversationId) {
    await setConversationState(ctx, input.conversationId, 'BOOKED', { reason: 'appointment booked' });
    await db
      .update(conversations)
      .set({ nextFollowUpAt: null })
      .where(eq(conversations.id, input.conversationId));
  }

  await notify(ctx, {
    type: 'appointment_booked',
    title: `Appointment booked with ${name}`,
    body: formatSlot(input.startsAt, timezone),
    link: `/calendar`,
  });

  if (input.confirmBySms && input.conversationId) {
    await queueOutbound(ctx, {
      conversationId: input.conversationId,
      body: `Booked — ${formatSlot(input.startsAt, timezone)}. Talk then.`,
      author: 'HUMAN',
      idempotencyKey: `appt-confirm:${appointment!.id}`,
    }).catch(() => undefined);
  }

  return appointment!;
}

export async function rescheduleAppointment(
  ctx: Ctx,
  appointmentId: string,
  startsAt: Date,
  durationMinutes?: number,
): Promise<Appointment> {
  assertCan(ctx.role, 'appointment:write');
  const existing = await getAppointment(ctx, appointmentId);
  const duration =
    durationMinutes ?? Math.round((existing.endsAt.getTime() - existing.startsAt.getTime()) / 60_000);
  const endsAt = new Date(startsAt.getTime() + duration * 60_000);

  if (existing.externalEventId) {
    await getCalendarProvider()
      .updateEvent(existing.externalEventId, {
        title: existing.title,
        startsAt,
        endsAt,
        timezone: existing.timezone,
      })
      .catch(() => null);
  }

  const [row] = await getDb()
    .update(appointments)
    .set({ startsAt, endsAt, status: 'RESCHEDULED', reminderSentAt: null, updatedAt: new Date() })
    .where(eq(appointments.id, appointmentId))
    .returning();

  await recordActivity(ctx, {
    type: 'appointment_rescheduled',
    title: `Appointment moved to ${formatSlot(startsAt, existing.timezone)}`,
    contactId: existing.contactId,
    conversationId: existing.conversationId,
    metadata: { appointmentId },
  });

  return row!;
}

export async function setAppointmentStatus(
  ctx: Ctx,
  appointmentId: string,
  status: AppointmentStatus,
): Promise<void> {
  assertCan(ctx.role, 'appointment:write');
  const existing = await getAppointment(ctx, appointmentId);

  await getDb()
    .update(appointments)
    .set({
      status,
      completedAt: status === 'COMPLETED' ? new Date() : existing.completedAt,
      cancelledAt: status === 'CANCELLED' ? new Date() : existing.cancelledAt,
      updatedAt: new Date(),
    })
    .where(eq(appointments.id, appointmentId));

  if (status === 'CANCELLED' && existing.externalEventId) {
    await getCalendarProvider().deleteEvent(existing.externalEventId).catch(() => undefined);
  }

  if (status === 'COMPLETED') {
    await moveDealForContact(ctx, existing.contactId, 'SHOWED', {});
  }

  await recordActivity(ctx, {
    type: status === 'CANCELLED' ? 'appointment_cancelled' : 'appointment_completed',
    title: `Appointment ${status.toLowerCase()}`,
    contactId: existing.contactId,
    conversationId: existing.conversationId,
    metadata: { appointmentId },
  });
}

export async function getAppointment(ctx: Ctx, id: string): Promise<Appointment> {
  const rows = await getDb()
    .select()
    .from(appointments)
    .where(and(eq(appointments.id, id), eq(appointments.organizationId, ctx.organizationId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound('Appointment');
  return row;
}

export async function listAppointments(
  ctx: Ctx,
  options: { from?: Date; to?: Date; limit?: number } = {},
) {
  const from = options.from ?? new Date(Date.now() - 24 * 60 * 60_000);
  const to = options.to ?? new Date(Date.now() + 30 * 24 * 60 * 60_000);

  return getDb()
    .select({ appointment: appointments, contact: contacts })
    .from(appointments)
    .innerJoin(contacts, eq(contacts.id, appointments.contactId))
    .where(
      and(
        eq(appointments.organizationId, ctx.organizationId),
        gte(appointments.startsAt, from),
        lte(appointments.startsAt, to),
      ),
    )
    .orderBy(asc(appointments.startsAt))
    .limit(options.limit ?? 200);
}

const REMINDER_LEAD_MINUTES = 60;

/**
 * Sends a one-hour reminder for upcoming appointments. Run by the worker;
 * `reminderSentAt` makes it idempotent across ticks.
 */
export async function sendDueAppointmentReminders(): Promise<number> {
  const db = getDb();
  const now = new Date();
  const horizon = new Date(now.getTime() + REMINDER_LEAD_MINUTES * 60_000);

  const due = await db
    .select({
      appointment: appointments,
      contact: contacts,
      orgTimezone: organizations.timezone,
    })
    .from(appointments)
    .innerJoin(contacts, eq(contacts.id, appointments.contactId))
    .innerJoin(organizations, eq(organizations.id, appointments.organizationId))
    .where(
      and(
        isNull(appointments.reminderSentAt),
        gte(appointments.startsAt, now),
        lte(appointments.startsAt, horizon),
        sql`${appointments.status} in ('SCHEDULED','RESCHEDULED')`,
      ),
    )
    .limit(50);

  let sent = 0;
  for (const row of due) {
    const ctx = systemCtx(row.appointment.organizationId, row.orgTimezone);
    await db
      .update(appointments)
      .set({ reminderSentAt: new Date() })
      .where(eq(appointments.id, row.appointment.id));

    await notify(ctx, {
      type: 'appointment_upcoming',
      title: `Call in under an hour: ${row.appointment.title}`,
      body: formatSlot(row.appointment.startsAt, row.appointment.timezone),
      link: '/calendar',
    });

    if (row.appointment.conversationId) {
      await queueOutbound(ctx, {
        conversationId: row.appointment.conversationId,
        body: `Quick reminder about our call at ${formatSlot(row.appointment.startsAt, row.appointment.timezone)}.`,
        author: 'SYSTEM',
        idempotencyKey: `appt-reminder:${row.appointment.id}`,
      }).catch(() => undefined);
    }
    sent += 1;
  }

  return sent;
}
