import type { BusyInterval, CalendarEvent, CalendarEventInput, CalendarProvider } from './types';

export type GoogleCalendarConfig = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  calendarId: string;
};

/**
 * Google Calendar over the REST API using a stored refresh token.
 *
 * A refresh token (rather than an interactive OAuth dance per request) is the
 * right shape here: the calendar belongs to the On Radar operator, not to each
 * prospect, and the worker needs to write events with no user present.
 */
export class GoogleCalendarProvider implements CalendarProvider {
  readonly kind = 'google' as const;
  readonly configured: boolean;
  private readonly config: GoogleCalendarConfig;
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(config: GoogleCalendarConfig) {
    this.config = config;
    this.configured = Boolean(config.clientId && config.clientSecret && config.refreshToken);
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 30_000) {
      return this.accessToken.value;
    }

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: this.config.refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });

    if (!response.ok) {
      throw new Error(`Google token refresh failed with ${response.status}`);
    }
    const payload = (await response.json()) as { access_token: string; expires_in: number };
    this.accessToken = {
      value: payload.access_token,
      expiresAt: Date.now() + payload.expires_in * 1000,
    };
    return payload.access_token;
  }

  private body(input: CalendarEventInput) {
    return {
      summary: input.title,
      description: input.description,
      location: input.location ?? undefined,
      start: { dateTime: input.startsAt.toISOString(), timeZone: input.timezone },
      end: { dateTime: input.endsAt.toISOString(), timeZone: input.timezone },
      attendees: input.attendeeEmail ? [{ email: input.attendeeEmail }] : undefined,
    };
  }

  async createEvent(input: CalendarEventInput): Promise<CalendarEvent | null> {
    if (!this.configured) return null;
    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.config.calendarId)}/events`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await this.token()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(this.body(input)),
      },
    );
    if (!response.ok) throw new Error(`Google Calendar create failed with ${response.status}`);
    const payload = (await response.json()) as { id: string; htmlLink?: string };
    return { externalEventId: payload.id, htmlLink: payload.htmlLink ?? null };
  }

  async updateEvent(externalEventId: string, input: CalendarEventInput): Promise<CalendarEvent | null> {
    if (!this.configured) return null;
    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.config.calendarId)}/events/${externalEventId}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${await this.token()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(this.body(input)),
      },
    );
    if (!response.ok) throw new Error(`Google Calendar update failed with ${response.status}`);
    const payload = (await response.json()) as { id: string; htmlLink?: string };
    return { externalEventId: payload.id, htmlLink: payload.htmlLink ?? null };
  }

  async deleteEvent(externalEventId: string): Promise<void> {
    if (!this.configured) return;
    await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.config.calendarId)}/events/${externalEventId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${await this.token()}` } },
    );
  }

  async busy(from: Date, to: Date): Promise<BusyInterval[]> {
    if (!this.configured) return [];
    const response = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        items: [{ id: this.config.calendarId }],
      }),
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as {
      calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }>;
    };
    const busy = payload.calendars?.[this.config.calendarId]?.busy ?? [];
    return busy.map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
  }
}
