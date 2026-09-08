/** Application error taxonomy. Every thrown error carries an actionable code. */
export type AppErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PROVIDER_ERROR'
  | 'AI_ERROR'
  | 'SUPPRESSED'
  | 'INTERNAL';

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: AppErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}

const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 422,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  PROVIDER_ERROR: 502,
  AI_ERROR: 502,
  SUPPRESSED: 409,
  INTERNAL: 500,
};

export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);
export const forbidden = (why = 'You do not have permission to do that') =>
  new AppError('FORBIDDEN', why);
export const invalid = (why: string, details?: unknown) => new AppError('VALIDATION', why, details);
export const conflict = (why: string) => new AppError('CONFLICT', why);

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Result shape returned by every server action. Never throws across the wire. */
export type ActionResult<T> = { ok: true; data: T } | { ok: false; code: AppErrorCode; error: string };

export function actionOk<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

export type ActionFailure = { ok: false; code: AppErrorCode; error: string };

export function actionFail(e: unknown): ActionFailure {
  if (isAppError(e)) return { ok: false, code: e.code, error: e.message };
  return { ok: false, code: 'INTERNAL', error: errorMessage(e) };
}
