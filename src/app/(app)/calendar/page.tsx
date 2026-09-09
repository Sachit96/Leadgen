import { requireCtx } from '@/lib/auth/context';
import { availability, listAppointments } from '@/lib/services/appointments';
import { integrationStatus } from '@/lib/env';
import { Card, PageHeader, SectionTitle, Stat } from '@/components/ui/primitives';
import { buttonClass } from '@/components/ui/button-styles';
import { CalendarView } from './calendar-view';

export const dynamic = 'force-dynamic';

export default async function CalendarPage() {
  const ctx = await requireCtx('appointment:write');

  const renderedAt = new Date();
  const from = new Date(renderedAt);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from.getTime() + 21 * 24 * 60 * 60_000);

  const [appointments, slots] = await Promise.all([
    listAppointments(ctx, { from: new Date(from.getTime() - 30 * 24 * 60 * 60_000), to }),
    availability(ctx, { days: 7, limit: 20 }),
  ]);

  const integrations = integrationStatus();
  const upcoming = appointments.filter((a) => a.appointment.startsAt >= new Date());
  const completed = appointments.filter((a) => a.appointment.status === 'COMPLETED');
  const noShows = appointments.filter((a) => a.appointment.status === 'NO_SHOW');
  const past = appointments.filter((a) => a.appointment.startsAt < new Date());
  const showRate = past.length > 0 ? Math.round((completed.length / past.length) * 100) : 0;

  return (
    <div className="p-6">
      <PageHeader
        title="Calendar"
        subtitle={
          integrations.calendar.effective === 'google'
            ? 'Synced with Google Calendar.'
            : 'Appointments are stored in On Radar. Connect Google Calendar in Settings to mirror them outward.'
        }
        actions={
          <a href="/api/export?kind=appointments" className={buttonClass('secondary')}>
            Export CSV
          </a>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Upcoming" value={upcoming.length} tone={upcoming.length > 0 ? 'hot' : 'neutral'} />
        <Stat label="Completed" value={completed.length} tone="positive" />
        <Stat label="No-shows" value={noShows.length} tone={noShows.length > 0 ? 'warning' : 'neutral'} />
        <Stat label="Show rate" value={`${showRate}%`} sublabel="of past appointments" />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <CalendarView
            appointments={appointments.map(({ appointment, contact }) => ({
              id: appointment.id,
              title: appointment.title,
              startsAt: appointment.startsAt.toISOString(),
              endsAt: appointment.endsAt.toISOString(),
              timezone: appointment.timezone,
              status: appointment.status,
              notes: appointment.notes,
              contactId: contact.id,
              contactName:
                [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.phone,
              phone: contact.phone,
              conversationId: appointment.conversationId,
            }))}
            canWrite={ctx.role !== 'VIEWER'}
            now={renderedAt.getTime()}
          />
        </div>

        <div>
          <SectionTitle>Next available slots</SectionTitle>
          <Card padded={false}>
            <ul className="divide-y divide-ink-800">
              {slots.length === 0 ? (
                <li className="px-4 py-3 text-sm text-ink-500">
                  No free slots in the next 7 days.
                </li>
              ) : (
                slots.map((slot) => (
                  <li key={slot.startsAt.toISOString()} className="px-4 py-2 text-sm text-ink-300">
                    {slot.label}
                  </li>
                ))
              )}
            </ul>
            <p className="border-t border-ink-800 px-4 py-2 text-[11px] text-ink-500">
              Slots exclude anything already booked here and, when connected, anything busy on the
              linked Google Calendar.
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}
