import { env } from '@/lib/env';

type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys whose values are never written to logs, at any depth. */
const REDACTED = new Set([
  'password',
  'passwordhash',
  'token',
  'tokenhash',
  'authtoken',
  'apikey',
  'api_key',
  'secret',
  'authorization',
  'sessionsecret',
  'accesstoken',
  'refreshtoken',
  'body', // message contents stay out of logs by default
]);

export type LogContext = {
  requestId?: string;
  organizationId?: string;
  userId?: string;
  jobId?: string;
  messageId?: string;
  conversationId?: string;
  provider?: string;
  latencyMs?: number;
  result?: string;
  errorCode?: string;
  [key: string]: unknown;
};

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACTED.has(k.toLowerCase()) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

function emit(level: Level, message: string, context: LogContext = {}): void {
  let threshold: Level = 'info';
  try {
    threshold = env().LOG_LEVEL;
  } catch {
    // Environment not yet validated (e.g. during a build) — fall back to info.
  }
  if (ORDER[level] < ORDER[threshold]) return;

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...(redact(context) as Record<string, unknown>),
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, context?: LogContext) => emit('debug', message, context),
  info: (message: string, context?: LogContext) => emit('info', message, context),
  warn: (message: string, context?: LogContext) => emit('warn', message, context),
  error: (message: string, context?: LogContext) => emit('error', message, context),
  /** Returns a logger that merges `base` into every call. */
  child(base: LogContext) {
    return {
      debug: (m: string, c?: LogContext) => emit('debug', m, { ...base, ...c }),
      info: (m: string, c?: LogContext) => emit('info', m, { ...base, ...c }),
      warn: (m: string, c?: LogContext) => emit('warn', m, { ...base, ...c }),
      error: (m: string, c?: LogContext) => emit('error', m, { ...base, ...c }),
    };
  },
};
