/**
 * Timezone-aware helpers built on Intl, so campaign sending windows follow the
 * prospect's local clock rather than the server's.
 */
export type LocalParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday. */
  weekday: number;
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function localParts(date: Date, timeZone: string): LocalParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  });

  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) parts[part.type] = part.value;

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: Math.max(0, WEEKDAYS.indexOf(parts.weekday ?? 'Sun')),
  };
}

export function parseClock(value: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return { hour: 9, minute: 0 };
  return { hour: Math.min(23, Number(match[1])), minute: Math.min(59, Number(match[2])) };
}

function minutesOf(hour: number, minute: number): number {
  return hour * 60 + minute;
}

/**
 * True when `date` falls inside [start, end) on an allowed weekday, in the
 * given timezone. Windows that wrap past midnight are supported.
 */
export function withinSendingWindow(
  date: Date,
  timeZone: string,
  start: string,
  end: string,
  days: number[],
): boolean {
  const local = localParts(date, timeZone);
  if (days.length > 0 && !days.includes(local.weekday)) return false;

  const now = minutesOf(local.hour, local.minute);
  const from = minutesOf(parseClock(start).hour, parseClock(start).minute);
  const to = minutesOf(parseClock(end).hour, parseClock(end).minute);

  if (from === to) return true;
  if (from < to) return now >= from && now < to;
  return now >= from || now < to;
}

/**
 * The next instant at or after `from` that falls inside the window. Used to
 * defer a job rather than dropping it.
 */
export function nextWindowOpening(
  from: Date,
  timeZone: string,
  start: string,
  end: string,
  days: number[],
): Date {
  const step = 15 * 60_000;
  let cursor = new Date(Math.ceil(from.getTime() / step) * step);
  // Walk forward in 15-minute steps for up to 10 days.
  for (let i = 0; i < 4 * 24 * 10; i += 1) {
    if (withinSendingWindow(cursor, timeZone, start, end, days)) return cursor;
    cursor = new Date(cursor.getTime() + step);
  }
  return new Date(from.getTime() + 24 * 60 * 60_000);
}

export function startOfDayUtc(offsetDays = 0): Date {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + offsetDays);
  return date;
}

export function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60_000);
}

export function formatRelative(date: Date | null | undefined, now = new Date()): string {
  if (!date) return '—';
  const diff = now.getTime() - new Date(date).getTime();
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (abs < minute) return 'just now';
  if (abs < hour) return rel(Math.round(diff / minute), 'm');
  if (abs < day) return rel(Math.round(diff / hour), 'h');
  if (abs < 7 * day) return rel(Math.round(diff / day), 'd');
  return new Date(date).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
}

function rel(value: number, unit: string): string {
  return value >= 0 ? `${value}${unit} ago` : `in ${Math.abs(value)}${unit}`;
}
