'use server';

import { requireCtx } from '@/lib/auth/context';
import { createDeal, deleteDeal, moveDeal, updateDeal } from '@/lib/services/pipeline';
import {
  bookAppointment,
  rescheduleAppointment,
  setAppointmentStatus,
} from '@/lib/services/appointments';
import { invalid } from '@/lib/core/errors';
import type { AppointmentStatus, PipelineStage } from '@/lib/db/types';
import { action, bool, moneyToCents, num, optionalStr, str } from './helpers';

export async function moveDealAction(dealId: string, stage: PipelineStage, lostReason?: string) {
  return action('pipeline.move', async () => {
    const ctx = await requireCtx('pipeline:write');
    await moveDeal(ctx, dealId, stage, { lostReason });
  }, ['/pipeline', '/', '/analytics']);
}

export async function createDealAction(form: FormData) {
  return action('pipeline.create', async () => {
    const ctx = await requireCtx('pipeline:write');
    const deal = await createDeal(ctx, {
      contactId: str(form, 'contactId'),
      conversationId: optionalStr(form, 'conversationId'),
      title: optionalStr(form, 'title') ?? undefined,
      valueCents: moneyToCents(str(form, 'value')),
      recurringValueCents: moneyToCents(str(form, 'recurringValue')),
    });
    return { id: deal.id };
  }, ['/pipeline', '/inbox']);
}

export async function updateDealAction(form: FormData) {
  return action('pipeline.update', async () => {
    const ctx = await requireCtx('pipeline:write');
    await updateDeal(ctx, str(form, 'dealId'), {
      title: str(form, 'title'),
      valueCents: moneyToCents(str(form, 'value')),
      recurringValueCents: moneyToCents(str(form, 'recurringValue')),
    });
  }, ['/pipeline', '/analytics']);
}

export async function deleteDealAction(dealId: string) {
  return action('pipeline.delete', async () => {
    const ctx = await requireCtx('pipeline:write');
    await deleteDeal(ctx, dealId);
  }, ['/pipeline']);
}

export async function bookAppointmentAction(form: FormData) {
  return action('appointment.book', async () => {
    const ctx = await requireCtx('appointment:write');
    const startsAt = new Date(str(form, 'startsAt'));
    if (Number.isNaN(startsAt.getTime())) throw invalid('Pick a valid date and time');

    const appointment = await bookAppointment(ctx, {
      contactId: str(form, 'contactId'),
      conversationId: optionalStr(form, 'conversationId'),
      startsAt,
      durationMinutes: num(form, 'durationMinutes', 15),
      title: optionalStr(form, 'title') ?? undefined,
      notes: optionalStr(form, 'notes'),
      confirmBySms: bool(form, 'confirmBySms'),
    });
    return { id: appointment.id };
  }, ['/calendar', '/inbox', '/pipeline', '/']);
}

export async function rescheduleAppointmentAction(form: FormData) {
  return action('appointment.reschedule', async () => {
    const ctx = await requireCtx('appointment:write');
    const startsAt = new Date(str(form, 'startsAt'));
    if (Number.isNaN(startsAt.getTime())) throw invalid('Pick a valid date and time');
    await rescheduleAppointment(ctx, str(form, 'appointmentId'), startsAt, num(form, 'durationMinutes', 15));
  }, ['/calendar', '/']);
}

export async function setAppointmentStatusAction(id: string, status: AppointmentStatus) {
  return action('appointment.setStatus', async () => {
    const ctx = await requireCtx('appointment:write');
    await setAppointmentStatus(ctx, id, status);
  }, ['/calendar', '/pipeline', '/']);
}
