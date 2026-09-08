'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { AppointmentStatus } from '@/lib/db/types';
import { formatPhone } from '@/lib/core/phone';
import { Badge, Card, EmptyState, cn, inputClass } from '@/components/ui/primitives';
import { Button } from '@/components/ui/buttons';
import { useToast } from '@/components/ui/toast';
import {
  rescheduleAppointmentAction,
  setAppointmentStatusAction,
} from '@/app/actions/pipeline';

type Appointment = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  status: AppointmentStatus;
  notes: string | null;
  contactId: string;
  contactName: string;
  phone: string;
  conversationId: string | null;
};

const STATUS_TONES: Record<AppointmentStatus, 'accent' | 'positive' | 'warning' | 'danger' | 'neutral'> = {
  SCHEDULED: 'accent',
  RESCHEDULED: 'warning',
  COMPLETED: 'positive',
  CANCELLED: 'neutral',
  NO_SHOW: 'danger',
};

export function CalendarView({
  appointments,
  canWrite,
}: {
  appointments: Appointment[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [rescheduling, setRescheduling] = useState<string | null>(null);
  const [showPast, setShowPast] = useState(false);

  const now = Date.now();
  const visible = appointments.filter((a) =>
    showPast ? true : new Date(a.startsAt).getTime() >= now - 60 * 60_000,
  );

  const byDay = new Map<string, Appointment[]>();
  for (const appointment of visible) {
    const key = new Date(appointment.startsAt).toLocaleDateString('en-CA', {
      timeZone: appointment.timezone,
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });
    const list = byDay.get(key) ?? [];
    list.push(appointment);
    byDay.set(key, list);
  }

  const setStatus = (id: string, status: AppointmentStatus) =>
    startTransition(async () => {
      const result = await setAppointmentStatusAction(id, status);
      toast.push(
        result.ok ? `Marked ${status.toLowerCase().replace('_', ' ')}` : result.error,
        result.ok ? 'success' : 'error',
      );
      if (result.ok) router.refresh();
    });

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">
          {showPast ? 'All appointments' : 'Upcoming'}
        </h2>
        <button
          type="button"
          onClick={() => setShowPast((v) => !v)}
          className="text-xs text-accent-400 hover:underline"
        >
          {showPast ? 'Show upcoming only' : 'Include past'}
        </button>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          title="No appointments"
          description="Book a call from any conversation in the inbox — the AI proposes times once a prospect is interested."
        />
      ) : (
        <div className="space-y-5">
          {[...byDay.entries()].map(([day, items]) => (
            <div key={day}>
              <p className="mb-2 text-xs font-medium text-ink-400">{day}</p>
              <Card padded={false}>
                <ul className="divide-y divide-ink-800">
                  {items.map((appointment) => {
                    const start = new Date(appointment.startsAt);
                    const isPast = start.getTime() < now;

                    return (
                      <li key={appointment.id} className={cn('p-3', isPast && 'opacity-70')}>
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-medium tabular-nums text-accent-400">
                                {new Intl.DateTimeFormat('en-CA', {
                                  timeZone: appointment.timezone,
                                  hour: 'numeric',
                                  minute: '2-digit',
                                }).format(start)}
                              </span>
                              <span className="text-sm text-ink-100">{appointment.title}</span>
                              <Badge tone={STATUS_TONES[appointment.status]}>
                                {appointment.status.toLowerCase().replace('_', ' ')}
                              </Badge>
                            </div>
                            <p className="mt-0.5 text-xs text-ink-500">
                              {appointment.contactName} · {formatPhone(appointment.phone)}
                            </p>
                            {appointment.notes ? (
                              <p className="mt-1 text-xs text-ink-400">{appointment.notes}</p>
                            ) : null}
                          </div>

                          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                            {appointment.conversationId ? (
                              <Link
                                href={`/inbox/${appointment.conversationId}`}
                                className="text-xs text-accent-400 hover:underline"
                              >
                                Chat
                              </Link>
                            ) : null}

                            {canWrite && appointment.status !== 'CANCELLED' ? (
                              <>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={pending}
                                  onClick={() =>
                                    setRescheduling((current) =>
                                      current === appointment.id ? null : appointment.id,
                                    )
                                  }
                                >
                                  Reschedule
                                </Button>
                                {appointment.status !== 'COMPLETED' ? (
                                  <Button
                                    size="sm"
                                    disabled={pending}
                                    onClick={() => setStatus(appointment.id, 'COMPLETED')}
                                  >
                                    Showed
                                  </Button>
                                ) : null}
                                {appointment.status !== 'NO_SHOW' ? (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={pending}
                                    onClick={() => setStatus(appointment.id, 'NO_SHOW')}
                                  >
                                    No-show
                                  </Button>
                                ) : null}
                                <Button
                                  size="sm"
                                  variant="danger"
                                  disabled={pending}
                                  onClick={() => {
                                    if (!confirm('Cancel this appointment?')) return;
                                    setStatus(appointment.id, 'CANCELLED');
                                  }}
                                >
                                  Cancel
                                </Button>
                              </>
                            ) : null}
                          </div>
                        </div>

                        {rescheduling === appointment.id ? (
                          <form
                            className="mt-3 flex flex-wrap items-end gap-2 rounded border border-accent-600/40 bg-ink-900 p-2"
                            onSubmit={(event) => {
                              event.preventDefault();
                              const form = new FormData(event.currentTarget);
                              form.set('appointmentId', appointment.id);
                              startTransition(async () => {
                                const result = await rescheduleAppointmentAction(form);
                                toast.push(
                                  result.ok ? 'Appointment moved' : result.error,
                                  result.ok ? 'success' : 'error',
                                );
                                if (result.ok) {
                                  setRescheduling(null);
                                  router.refresh();
                                }
                              });
                            }}
                          >
                            <label className="text-xs text-ink-300">
                              New time
                              <input
                                type="datetime-local"
                                name="startsAt"
                                required
                                defaultValue={toLocalInput(start)}
                                className={cn(inputClass, 'mt-1')}
                              />
                            </label>
                            <label className="text-xs text-ink-300">
                              Minutes
                              <input
                                type="number"
                                name="durationMinutes"
                                min={5}
                                defaultValue={Math.round(
                                  (new Date(appointment.endsAt).getTime() - start.getTime()) / 60_000,
                                )}
                                className={cn(inputClass, 'mt-1 w-20')}
                              />
                            </label>
                            <Button type="submit" size="sm" variant="primary" disabled={pending}>
                              Save
                            </Button>
                          </form>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </Card>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** datetime-local needs a local-time string, not an ISO instant. */
function toLocalInput(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}
