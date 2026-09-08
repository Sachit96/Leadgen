/** Calendar boundary: booking works with or without an external calendar. */
export type CalendarEventInput = {
  title: string;
  description?: string;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  attendeeEmail?: string | null;
  location?: string | null;
};

export type CalendarEvent = {
  externalEventId: string;
  htmlLink?: string | null;
};

export type BusyInterval = { start: Date; end: Date };

export interface CalendarProvider {
  readonly kind: 'google' | 'internal';
  readonly configured: boolean;
  createEvent(input: CalendarEventInput): Promise<CalendarEvent | null>;
  updateEvent(externalEventId: string, input: CalendarEventInput): Promise<CalendarEvent | null>;
  deleteEvent(externalEventId: string): Promise<void>;
  /** Intervals that are already taken, used to filter proposed slots. */
  busy(from: Date, to: Date): Promise<BusyInterval[]>;
}
