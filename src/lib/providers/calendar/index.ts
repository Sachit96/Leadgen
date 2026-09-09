import { env } from '@/lib/env';
import { GoogleCalendarProvider } from './google';
import type { BusyInterval, CalendarEvent, CalendarEventInput, CalendarProvider } from './types';

export * from './types';
export { GoogleCalendarProvider } from './google';

/**
 * Appointments are stored in our own database regardless of provider, so
 * booking works fully with no external calendar connected. The Google provider
 * mirrors events outward when it is configured.
 */
export class InternalCalendarProvider implements CalendarProvider {
  readonly kind = 'internal' as const;
  readonly configured = true;

  async createEvent(_input: CalendarEventInput): Promise<CalendarEvent | null> {
    return null;
  }
  async updateEvent(_id: string, _input: CalendarEventInput): Promise<CalendarEvent | null> {
    return null;
  }
  async deleteEvent(_id: string): Promise<void> {}
  async busy(_from: Date, _to: Date): Promise<BusyInterval[]> {
    return [];
  }
}

declare global {
  var __onRadarCalendarProvider: CalendarProvider | undefined;
}

export function getCalendarProvider(): CalendarProvider {
  if (globalThis.__onRadarCalendarProvider) return globalThis.__onRadarCalendarProvider;

  const e = env();
  let provider: CalendarProvider = new InternalCalendarProvider();

  if (e.CALENDAR_PROVIDER === 'google') {
    const google = new GoogleCalendarProvider({
      clientId: e.GOOGLE_CLIENT_ID ?? '',
      clientSecret: e.GOOGLE_CLIENT_SECRET ?? '',
      refreshToken: e.GOOGLE_REFRESH_TOKEN ?? '',
      calendarId: e.GOOGLE_CALENDAR_ID,
    });
    if (google.configured) provider = google;
  }

  globalThis.__onRadarCalendarProvider = provider;
  return provider;
}

export function setCalendarProvider(provider: CalendarProvider | undefined): void {
  globalThis.__onRadarCalendarProvider = provider;
}
